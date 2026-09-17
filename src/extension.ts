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
	"mode" | "hasUI" | "cwd" | "modelRegistry" | "model" | "thinkingLevel" | "scopedModels"
> & {
	ui: StewardUiSurface;
};
type StewardSessionContext = Pick<
	ExtensionContext,
	"mode" | "hasUI" | "cwd" | "modelRegistry" | "model" | "thinkingLevel" | "scopedModels"
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

function requestFromContext(ctx: StewardCommandContext | StewardSessionContext): StewardHostRequest {
	return {
		ui: ctx.ui as StewardUiSurface,
		modelRegistry: ctx.modelRegistry,
		scopedModels: ctx.scopedModels,
	};
}

function proposalFromContext(ctx: StewardCommandContext): ControllerSessionProposal | undefined {
	if (!ctx.model) return undefined;
	return {
		reference: `${ctx.model.provider}/${ctx.model.id}`,
		...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
	};
}

function runStatus(
	ctx: StewardCommandContext | StewardSessionContext,
	target: StatusTarget,
	adapterFactory: StewardAdapterFactory,
): void {
	createSteward(adapterFactory(requestFromContext(ctx))).status(ctx.cwd, target);
}

/** Register Steward's TUI-only session footer and status/configuration commands. */
export function registerStewardExtension(
	pi: StewardRegistrationSurface,
	adapterFactory: StewardAdapterFactory = defaultAdapterFactory,
): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		runStatus(ctx, "footer", adapterFactory);
	});

	pi.registerCommand("steward", {
		description: "Inspect or configure Steward defaults.",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (command === "config" && ctx.mode !== "tui") {
				throw new Error("Steward configuration requires interactive TUI mode.");
			}
			if (ctx.mode !== "tui") return;
			if (command === "status") {
				runStatus(ctx, "command", adapterFactory);
				return;
			}
			if (command === "config") {
				await createSteward(adapterFactory(requestFromContext(ctx))).configure(ctx.cwd, proposalFromContext(ctx));
				return;
			}
			ctx.ui.notify("Usage: /steward status | /steward config", "info");
		},
	});
}

/** Pi's package entrypoint. */
export default function stewardExtension(pi: ExtensionAPI): void {
	registerStewardExtension(pi);
}
