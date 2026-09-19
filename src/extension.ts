import type {
	AgentSettledEvent,
	AgentStartEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
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

import { createProductionAdapters, type StewardHostRequest } from "./adapters.ts";
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
type StewardSessionContext = Pick<
	ExtensionContext,
	"mode" | "hasUI" | "cwd" | "modelRegistry" | "model" | "thinkingLevel" | "scopedModels" | "sessionManager"
> & {
	ui: StewardUiSurface;
};
export type StewardCommandHandler = (args: string, ctx: StewardCommandContext) => Promise<void>;
type StewardSessionHandler = ExtensionHandler<SessionStartEvent>;
type StewardLifecycleHandler<E, R = undefined> = ExtensionHandler<E, R>;
type SessionBeforeCompactResult = { cancel?: boolean; compaction?: unknown };
type SessionCompactFailedEvent = {
	type: "session_compact_failed";
	reason: "manual" | "threshold" | "overflow";
	errorMessage?: string;
	aborted: boolean;
	willRetry: boolean;
	fromExtension: boolean;
};

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
}

function sameRuntime(runtime: StewardRuntime | undefined, ctx: StewardCommandContext | StewardSessionContext): boolean {
	return Boolean(runtime && runtime.repositoryRoot === ctx.cwd && runtime.controllerSessionId === ctx.sessionManager.getSessionId());
}

function makeRuntime(
	ctx: StewardCommandContext | StewardSessionContext,
	adapterFactory: StewardAdapterFactory,
	exec: ExtensionAPI["exec"] | undefined,
): StewardRuntime {
	const controllerSessionId = ctx.sessionManager.getSessionId();
	const steward = createSteward(adapterFactory(requestFromContext(ctx, exec)));
	const monitor = createStewardSessionMonitor({ repositoryRoot: ctx.cwd, controllerSessionId, steward });
	return { repositoryRoot: ctx.cwd, controllerSessionId, steward, monitor, monitorStarted: false };
}

/** Register Steward's TUI-only session footer and status/configuration commands. */
export function registerStewardExtension(
	pi: StewardRegistrationSurface,
	adapterFactory: StewardAdapterFactory = defaultAdapterFactory,
	exec?: ExtensionAPI["exec"],
): void {
	let runtime: StewardRuntime | undefined;

	function eventRuntime(ctx: StewardSessionContext): StewardRuntime | undefined {
		return ctx.mode === "tui" && sameRuntime(runtime, ctx) ? runtime : undefined;
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (runtime) await runtime.monitor.stop();
		runtime = makeRuntime(ctx, adapterFactory, exec);
		runtime.monitor.start();
		runtime.monitorStarted = true;
	});
	pi.on("agent_start", (_event, ctx) => eventRuntime(ctx)?.monitor.markAgentBusy());
	pi.on("turn_start", (_event, ctx) => eventRuntime(ctx)?.monitor.markAgentBusy());
	pi.on("turn_end", (_event, ctx) => eventRuntime(ctx)?.monitor.wake("turn"));
	pi.on("agent_settled", (_event, ctx) => eventRuntime(ctx)?.monitor.markAgentSettled());
	pi.on("session_before_compact", (_event, ctx) => eventRuntime(ctx)?.monitor.markCompactionStarted());
	pi.on("session_compact", (_event, ctx) => eventRuntime(ctx)?.monitor.markCompactionEnded());
	pi.on("session_compact_failed", (_event, ctx) => eventRuntime(ctx)?.monitor.markCompactionEnded());
	pi.on("ui_prompt_start", (_event, ctx) => eventRuntime(ctx)?.monitor.markUiPromptStarted());
	pi.on("ui_prompt_end", (_event, ctx) => eventRuntime(ctx)?.monitor.markUiPromptEnded());
	pi.on("session_shutdown", async (_event, ctx) => {
		const current = eventRuntime(ctx);
		if (!current) return;
		await current.monitor.stop();
		if (runtime === current) runtime = undefined;
	});

	pi.registerCommand("steward", {
		description: "Inspect, configure, start, or resume Steward Runs.",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (command === "start" && ctx.mode !== "tui") throw new Error("Steward start requires interactive TUI mode.");
			if (command === "config" && ctx.mode !== "tui") throw new Error("Steward configuration requires interactive TUI mode.");
			if (command === "resume" && ctx.mode !== "tui") throw new Error("Steward resume requires interactive TUI mode.");
			if (ctx.mode !== "tui") return;
			if (!new Set(["status", "config", "start", "resume"]).has(command)) {
				ctx.ui.notify("Usage: /steward status | /steward config | /steward start | /steward resume", "info");
				return;
			}
			if (!sameRuntime(runtime, ctx) || !runtime?.monitorStarted) {
				if (runtime) await runtime.monitor.stop();
				runtime = makeRuntime(ctx, adapterFactory, exec);
			}
			const current = runtime;
			if (!current) return;
			await current.monitor.runExclusive(async () => {
				if (command === "status") {
					await current.steward.status(ctx.cwd, "command", current.controllerSessionId);
					return;
				}
				if (command === "config") {
					await current.steward.configure(ctx.cwd, proposalFromContext(ctx));
					return;
				}
				if (command === "start") {
					await current.steward.start(ctx.cwd, current.controllerSessionId);
					return;
				}
				if (command === "resume") {
					await current.steward.resume(ctx.cwd, current.controllerSessionId);
					return;
				}
			});
		},
	});
}

/** Pi's package entrypoint. */
export default function stewardExtension(pi: ExtensionAPI): void {
	registerStewardExtension(pi, undefined, pi.exec);
}
