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

export type StewardUiSurface = Pick<ExtensionUIContext, "select" | "confirm" | "input" | "notify" | "setStatus"> & Partial<Pick<ExtensionUIContext, "custom">>;
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

export interface StewardAutocompleteItem {
	value: string;
	label: string;
	description?: string;
}

export interface StewardCommandOptions {
	description?: string;
	getArgumentCompletions?: (argumentPrefix: string) => StewardAutocompleteItem[] | null | Promise<StewardAutocompleteItem[] | null>;
	handler: StewardCommandHandler;
}

export const STEWARD_SUBCOMMANDS = [
	{ name: "status", description: "Show Steward Run status." },
	{ name: "config", description: "Configure recovery defaults and controller models." },
	{ name: "start", description: "Draft and start a Steward Run." },
	{ name: "revise", description: "Revise the active Run contract or Model Plan." },
	{ name: "resume", description: "Resume or take over an interrupted Run.", flags: [{ value: "--takeover", description: "Reconcile and claim a Run owned by another Controller Session." }] },
	{ name: "doctor", description: "Diagnose configuration, journal, Herdr, and selected models.", flags: [{ value: "--probe", description: "Make one small sequential live request to each unique selected model." }] },
	{ name: "cancel", description: "Cancel the active Run while preserving evidence." },
	{ name: "cleanup", description: "Clean up Steward-owned resources after a terminal Run." },
] as const;

type StewardSubcommandName = typeof STEWARD_SUBCOMMANDS[number]["name"];
type ParsedStewardCommand =
	| { name: Exclude<StewardSubcommandName, "resume" | "doctor"> }
	| { name: "resume"; takeover: boolean }
	| { name: "doctor"; probe: boolean };

export function getStewardArgumentCompletions(argumentPrefix: string): StewardAutocompleteItem[] | null {
	const normalized = argumentPrefix.trimStart();
	const [name, ...rest] = normalized.split(/\s+/);
	if (normalized.includes(" ") && (name === "resume" || name === "doctor")) {
		const command = STEWARD_SUBCOMMANDS.find((item) => item.name === name);
		if (!command || !("flags" in command)) return null;
		const flagPrefix = rest.join(" ");
		const completions: StewardAutocompleteItem[] = [];
		for (const flag of command.flags) {
			if (flag.value.startsWith(flagPrefix)) {
				completions.push({ value: `${name} ${flag.value}`, label: flag.value, description: flag.description });
			}
		}
		return completions;
	}
	const prefix = normalized.toLowerCase();
	return STEWARD_SUBCOMMANDS
		.filter((item) => item.name.startsWith(prefix))
		.map((item) => ({ value: item.name, label: item.name, description: item.description }));
}

function parseStewardCommand(value: string): ParsedStewardCommand | undefined {
	const tokens = value.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return undefined;
	const name = tokens[0] as StewardSubcommandName;
	if (!STEWARD_SUBCOMMANDS.some((item) => item.name === name)) return undefined;
	if (name === "resume") {
		if (tokens.length === 1) return { name, takeover: false };
		if (tokens.length === 2 && tokens[1] === "--takeover") return { name, takeover: true };
		return undefined;
	}
	if (name === "doctor") {
		if (tokens.length === 1) return { name, probe: false };
		if (tokens.length === 2 && tokens[1] === "--probe") return { name, probe: true };
		return undefined;
	}
	return tokens.length === 1 ? { name: name as Exclude<StewardSubcommandName, "resume" | "doctor"> } : undefined;
}

function interactiveTuiError(command: StewardSubcommandName): string {
	if (command === "config") return "Steward configuration requires interactive TUI mode.";
	return `Steward ${command} requires interactive TUI mode.`;
}

async function selectStewardCommand(ctx: StewardCommandContext): Promise<string | undefined> {
	const choices = STEWARD_SUBCOMMANDS.map((item) => `${item.name} — ${item.description}`);
	const selected = await ctx.ui.select("Steward command", choices);
	return STEWARD_SUBCOMMANDS.find((item) => selected === `${item.name} — ${item.description}`)?.name;
}

const STEWARD_USAGE = "Usage: /steward status | config | start | revise | resume [--takeover] | doctor [--probe] | cancel | cleanup";

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
		description: "Inspect, configure, diagnose, start, revise, resume, cancel, or clean up Steward Runs.",
		getArgumentCompletions: getStewardArgumentCompletions,
		handler: async (args, ctx) => {
			let commandText = args.trim();
			if (commandText.length === 0 && ctx.mode === "tui") commandText = await selectStewardCommand(ctx) ?? "";
			const command = parseStewardCommand(commandText);
			if (!command) {
				if (ctx.mode === "tui") ctx.ui.notify(STEWARD_USAGE, "info");
				return;
			}
			if (ctx.mode !== "tui") {
				if (command.name === "status") return;
				throw new Error(interactiveTuiError(command.name));
			}
			if (!runtimeBoundToSessionLifecycle || !sameRuntime(runtime, ctx)) {
				if (runtime) await runtime.monitor.stop();
				runtime = makeRuntime(ctx, adapterFactory, exec, compactionHost);
				runtimeBoundToSessionLifecycle = false;
			}
			const current = runtime;
			if (!current) return;
			const commandSteward = current.steward;
			let keepMonitorDormant = false;
			await current.monitor.runExclusive(async () => {
				const controllerSessionId = ctx.sessionManager.getSessionId();
				if (command.name === "status") {
					await commandSteward.status(ctx.cwd, "command", controllerSessionId);
					return;
				}
				if (command.name === "config") {
					await commandSteward.configure(ctx.cwd, proposalFromContext(ctx));
					return;
				}
				if (command.name === "start") {
					await commandSteward.start(ctx.cwd, controllerSessionId);
					return;
				}
				if (command.name === "revise") {
					await commandSteward.revise(ctx.cwd, controllerSessionId);
					return;
				}
				if (command.name === "resume") {
					const result = await commandSteward.resume(ctx.cwd, controllerSessionId, command.takeover);
					keepMonitorDormant = result.kind === "migration-applied";
					return;
				}
				if (command.name === "doctor") {
					await commandSteward.doctor(ctx.cwd, command.probe);
					return;
				}
				if (command.name === "cancel") {
					await commandSteward.cancel(ctx.cwd, controllerSessionId);
					return;
				}
				if (command.name === "cleanup") {
					await commandSteward.cleanup(ctx.cwd, controllerSessionId);
					return;
				}
			});
			if (command.name === "cleanup" || command.name === "cancel") {
				await current.monitor.stop();
				current.monitorStarted = false;
				runtimeBoundToSessionLifecycle = false;
			}
			if (command.name !== "cleanup" && command.name !== "cancel" && !keepMonitorDormant && !current.monitorStarted && runtimeBoundToSessionLifecycle) {
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
