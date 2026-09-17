import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionHandler,
	ExtensionUIContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import { createProductionAdapters, type StewardHostRequest } from "./adapters.ts";
import {
	createSteward,
	type ControllerSessionProposal,
	type StewardDependencies,
	type StatusTarget,
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

export interface StewardCommandOptions {
	description?: string;
	handler: StewardCommandHandler;
}

/** The small Pi registration surface used by this extension and its functional test. */
export interface StewardRegistrationSurface {
	registerCommand(name: "steward", options: StewardCommandOptions): void;
	on(event: "session_start", handler: StewardSessionHandler): void;
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

async function runStatus(
	ctx: StewardCommandContext | StewardSessionContext,
	target: StatusTarget,
	adapterFactory: StewardAdapterFactory,
	exec?: ExtensionAPI["exec"],
): Promise<void> {
	await createSteward(adapterFactory(requestFromContext(ctx, exec))).status(ctx.cwd, target);
}

/** Register Steward's TUI-only session footer and status/configuration commands. */
export function registerStewardExtension(
	pi: StewardRegistrationSurface,
	adapterFactory: StewardAdapterFactory = defaultAdapterFactory,
	exec?: ExtensionAPI["exec"],
): void {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		await runStatus(ctx, "footer", adapterFactory, exec);
	});

	pi.registerCommand("steward", {
		description: "Inspect, configure, or start Steward Runs.",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (command === "start" && ctx.mode !== "tui") throw new Error("Steward start requires interactive TUI mode.");
			if (command === "config" && ctx.mode !== "tui") throw new Error("Steward configuration requires interactive TUI mode.");
			if (ctx.mode !== "tui") return;
			if (command === "status") {
				await runStatus(ctx, "command", adapterFactory, exec);
				return;
			}
			if (command === "config") {
				await createSteward(adapterFactory(requestFromContext(ctx, exec))).configure(ctx.cwd, proposalFromContext(ctx));
				return;
			}
			if (command === "start") {
				await createSteward(adapterFactory(requestFromContext(ctx, exec))).start(ctx.cwd, ctx.sessionManager.getSessionId());
				return;
			}
			ctx.ui.notify("Usage: /steward status | /steward config | /steward start", "info");
		},
	});
}

/** Pi's package entrypoint. */
export default function stewardExtension(pi: ExtensionAPI): void {
	registerStewardExtension(pi, undefined, pi.exec);
}
