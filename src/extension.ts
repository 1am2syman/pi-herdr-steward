import type {
	AgentSettledEvent,
	CompactionResult,
	AgentStartEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionEvent,
	ExtensionHandler,
	ExtensionUIContext,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	TurnEndEvent,
	TurnStartEvent,
	UIPromptEndEvent,
	UIPromptStartEvent,
} from "@earendil-works/pi-coding-agent";

import { compactWithStewardContinuity, createProductionAdapters, type StewardHostRequest } from "./adapters.ts";
import { createStewardSessionMonitor, type StewardSessionMonitor } from "./monitor.ts";
import {
	createSteward,
	type ControllerSessionProposal,
	type Steward,
	type StewardDependencies,
} from "./steward.ts";

export type StewardUiSurface = Pick<ExtensionUIContext, "select" | "confirm" | "input" | "notify" | "setStatus">;
export type StewardCommandContext = Pick<
	ExtensionCommandContext,
	"mode" | "hasUI" | "cwd" | "modelRegistry" | "model" | "thinkingLevel" | "scopedModels" | "sessionManager"
> & {
	ui: StewardUiSurface;
};
export type StewardSessionContext = Pick<
	ExtensionContext,
	"mode" | "hasUI" | "cwd" | "modelRegistry" | "model" | "thinkingLevel" | "scopedModels" | "sessionManager"
> & {
	ui: StewardUiSurface;
};
export type StewardCommandHandler = (args: string, ctx: StewardCommandContext) => Promise<void>;
type StewardSessionHandler = ExtensionHandler<SessionStartEvent>;
type StewardLifecycleHandler<E, R = undefined> = ExtensionHandler<E, R>;
// Pi 0.84.4 exposes this result through ExtensionAPI but omits the named type
// from the package root; this is its exact public shape.
type SessionBeforeCompactResult = { cancel?: boolean; compaction?: CompactionResult };
// Pi 0.84.4 emits this event, but does not re-export its type from the package root.
type SessionCompactFailedEvent = Extract<ExtensionEvent, { type: "session_compact_failed" }>;

export type StewardCompactionHost = (event: SessionBeforeCompactEvent, ctx: StewardSessionContext, continuity: string) => Promise<CompactionResult>;

export interface StewardCommandOptions {
	description?: string;
	handler: StewardCommandHandler;
}

/** The small Pi registration surface used by this extension and its functional test. */
export interface StewardRegistrationSurface {
	registerCommand(name: "steward", options: StewardCommandOptions): void;
	on(event: "session_start", handler: StewardSessionHandler): void;
	on(event: "session_before_compact", handler: StewardLifecycleHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>): void;
	on(event: "session_compact", handler: StewardLifecycleHandler<SessionCompactEvent>): void;
	on(event: "session_compact_failed", handler: StewardLifecycleHandler<SessionCompactFailedEvent>): void;
	on(event: "session_shutdown", handler: StewardLifecycleHandler<SessionShutdownEvent>): void;
	on(event: "agent_start", handler: StewardLifecycleHandler<AgentStartEvent>): void;
	on(event: "agent_settled", handler: StewardLifecycleHandler<AgentSettledEvent>): void;
	on(event: "ui_prompt_start", handler: StewardLifecycleHandler<UIPromptStartEvent>): void;
	on(event: "ui_prompt_end", handler: StewardLifecycleHandler<UIPromptEndEvent>): void;
	on(event: "turn_start", handler: StewardLifecycleHandler<TurnStartEvent>): void;
	on(event: "turn_end", handler: StewardLifecycleHandler<TurnEndEvent>): void;
}

/** A test seam for replacing request-scoped adapters while keeping the seven slots fixed. */
export type StewardAdapterFactory = (request: StewardHostRequest) => StewardDependencies;

const defaultAdapterFactory: StewardAdapterFactory = (request) => createProductionAdapters(request);

function requestFromContext(ctx: StewardCommandContext | StewardSessionContext, exec?: ExtensionAPI["exec"]): StewardHostRequest {
	return {
		ui: ctx.ui as StewardUiSurface,
		modelRegistry: ctx.modelRegistry,
		scopedModels: ctx.scopedModels,
		...(exec ? { exec } : {}),
	};
}

function proposalFromContext(ctx: StewardCommandContext): ControllerSessionProposal | undefined {
	if (!ctx.model) return undefined;
	return {
		reference: `${ctx.model.provider}/${ctx.model.id}`,
		...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
	};
}

interface StewardRuntime {
	repositoryRoot: string;
	controllerSessionId: string;
	steward: Steward;
	monitor: StewardSessionMonitor;
	monitorStarted: boolean;
	compactionHost: StewardCompactionHost;
	compactionFailureKey?: string;
}

function sameRuntime(runtime: StewardRuntime | undefined, ctx: StewardCommandContext | StewardSessionContext): boolean {
	return Boolean(runtime && runtime.repositoryRoot === ctx.cwd && runtime.controllerSessionId === ctx.sessionManager.getSessionId());
}

function makeRuntime(
	ctx: StewardCommandContext | StewardSessionContext,
	adapterFactory: StewardAdapterFactory,
	exec: ExtensionAPI["exec"] | undefined,
	compactionHost: StewardCompactionHost,
): StewardRuntime {
	const controllerSessionId = ctx.sessionManager.getSessionId();
	const steward = createSteward(adapterFactory(requestFromContext(ctx, exec)));
	const monitor = createStewardSessionMonitor({ repositoryRoot: ctx.cwd, controllerSessionId, steward });
	return { repositoryRoot: ctx.cwd, controllerSessionId, steward, monitor, monitorStarted: false, compactionHost };
}

/** Register Steward's TUI-only session footer and status/configuration commands. */
export function registerStewardExtension(
	pi: StewardRegistrationSurface,
	adapterFactory: StewardAdapterFactory = defaultAdapterFactory,
	exec?: ExtensionAPI["exec"],
	compactionHost: StewardCompactionHost = (event, ctx, continuity) => compactWithStewardContinuity(event, ctx, continuity),
): void {
	let runtime: StewardRuntime | undefined;
	let runtimeBoundToSessionLifecycle = false;

	function eventRuntime(ctx: StewardSessionContext): StewardRuntime | undefined {
		return ctx.mode === "tui" && sameRuntime(runtime, ctx) ? runtime : undefined;
	}

	function notifyWarning(ctx: StewardSessionContext, message: string): void {
		try { ctx.ui.notify(message, "warning"); } catch { /* UI delivery is diagnostic-only. */ }
	}

	async function recordCompactionDiagnostic(current: StewardRuntime, ctx: StewardSessionContext, details: Parameters<Steward["recordCompactionFailure"]>[2]): Promise<void> {
		try {
			const recorded = await current.steward.recordCompactionFailure(ctx.cwd, current.controllerSessionId, details);
			notifyWarning(ctx, recorded.message);
		} catch {
			notifyWarning(ctx, "Compaction continuity failed; diagnostic logging was unavailable. Task state remains authoritative and unchanged.");
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (runtime) await runtime.monitor.stop();
		runtime = makeRuntime(ctx, adapterFactory, exec, compactionHost);
		runtimeBoundToSessionLifecycle = true;
		const restored = await runtime.steward.restoreControllerSession(ctx.cwd, runtime.controllerSessionId);
		if (restored.kind === "restored") {
			runtime.monitor.start();
			runtime.monitorStarted = true;
		} else {
			ctx.ui.setStatus("pi-herdr-steward", restored.message);
		}
	});
	pi.on("agent_start", (_event, ctx) => eventRuntime(ctx)?.monitor.markAgentBusy());
	pi.on("turn_start", (_event, ctx) => eventRuntime(ctx)?.monitor.markAgentBusy());
	pi.on("turn_end", (_event, ctx) => eventRuntime(ctx)?.monitor.wake("turn"));
	pi.on("agent_settled", (_event, ctx) => eventRuntime(ctx)?.monitor.markAgentSettled());
	pi.on("session_before_compact", async (event, ctx) => {
		const current = eventRuntime(ctx);
		if (!current) return;
		current.monitor.markCompactionStarted();
		// Older functional fixtures use a deliberately minimal event. Pi 0.84.4
		// always supplies preparation and signal, so the real path remains strict.
		if (!event.preparation || !event.signal) return;
		return current.monitor.runExclusive(async () => {
			let continuity: Awaited<ReturnType<Steward["prepareCompactionContinuity"]>>;
			try { continuity = await current.steward.prepareCompactionContinuity(ctx.cwd, current.controllerSessionId); }
			catch { return undefined; }
			if (continuity.kind !== "prepared") return undefined;
			try {
				return { compaction: await current.compactionHost(event, ctx, continuity.block) };
			} catch (error: unknown) {
				const details = {
					reason: event.reason,
					errorMessage: error instanceof Error ? error.message : "Steward compaction callback failed.",
					aborted: event.signal.aborted,
					willRetry: event.willRetry,
					fromExtension: true,
				} as const;
				current.compactionFailureKey = "callback-failed";
				await recordCompactionDiagnostic(current, ctx, details);
				return undefined;
			}
		});
	});
	pi.on("session_compact", (_event, ctx) => {
		const current = eventRuntime(ctx);
		if (!current) return;
		current.monitor.markCompactionSucceeded();
		current.compactionFailureKey = undefined;
	});
	pi.on("session_compact_failed", async (event, ctx) => {
		const current = eventRuntime(ctx);
		if (!current) return;
		current.monitor.markCompactionFailed();
		const details = {
			reason: event.reason,
			errorMessage: event.errorMessage,
			aborted: event.aborted,
			willRetry: event.willRetry,
			fromExtension: event.fromExtension,
		} as const;
		const key = JSON.stringify(details);
		if (current.compactionFailureKey !== "callback-failed" && current.compactionFailureKey !== key) {
			await recordCompactionDiagnostic(current, ctx, details);
		}
		current.compactionFailureKey = undefined;
	});
	pi.on("ui_prompt_start", (_event, ctx) => eventRuntime(ctx)?.monitor.markUiPromptStarted());
	pi.on("ui_prompt_end", (_event, ctx) => eventRuntime(ctx)?.monitor.markUiPromptEnded());
	pi.on("session_shutdown", async (_event, ctx) => {
		const current = eventRuntime(ctx);
		if (!current) return;
		await current.monitor.stop();
		if (runtime === current) {
			runtime = undefined;
			runtimeBoundToSessionLifecycle = false;
		}
	});

	pi.registerCommand("steward", {
		description: "Inspect, configure, start, revise, or resume Steward Runs.",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (command === "start" && ctx.mode !== "tui") throw new Error("Steward start requires interactive TUI mode.");
			if (command === "config" && ctx.mode !== "tui") throw new Error("Steward configuration requires interactive TUI mode.");
			if (command === "revise" && ctx.mode !== "tui") throw new Error("Steward revise requires interactive TUI mode.");
			if ((command === "resume" || command === "resume --takeover") && ctx.mode !== "tui") throw new Error("Steward resume requires interactive TUI mode.");
			if (ctx.mode !== "tui") return;
			if (!new Set(["status", "config", "start", "revise", "resume", "resume --takeover"]).has(command)) {
				ctx.ui.notify("Usage: /steward status | /steward config | /steward start | /steward revise | /steward resume [--takeover]", "info");
				return;
			}
			if (!runtimeBoundToSessionLifecycle || !sameRuntime(runtime, ctx)) {
				if (runtime) await runtime.monitor.stop();
				runtime = makeRuntime(ctx, adapterFactory, exec, compactionHost);
				runtimeBoundToSessionLifecycle = false;
			}
			const current = runtime;
			if (!current) return;
			const commandSteward = current.steward;
			await current.monitor.runExclusive(async () => {
				const controllerSessionId = ctx.sessionManager.getSessionId();
				if (command === "status") {
					await commandSteward.status(ctx.cwd, "command", controllerSessionId);
					return;
				}
				if (command === "config") {
					await commandSteward.configure(ctx.cwd, proposalFromContext(ctx));
					return;
				}
				if (command === "start") {
					await commandSteward.start(ctx.cwd, controllerSessionId);
					return;
				}
				if (command === "revise") {
					await commandSteward.revise(ctx.cwd, controllerSessionId);
					return;
				}
				if (command === "resume" || command === "resume --takeover") {
					await commandSteward.resume(ctx.cwd, controllerSessionId, command === "resume --takeover");
					return;
				}
			});
			if (!current.monitorStarted && runtimeBoundToSessionLifecycle) {
				const restored = await current.steward.restoreControllerSession(ctx.cwd, ctx.sessionManager.getSessionId());
				if (restored.kind === "restored") {
					current.monitor.start();
					current.monitorStarted = true;
				}
			}
		},
	});
}

/** Pi's package entrypoint. */
export default function stewardExtension(pi: ExtensionAPI): void {
	registerStewardExtension(pi, undefined, pi.exec);
}
