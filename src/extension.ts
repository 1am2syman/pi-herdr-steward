import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionHandler,
  ExtensionUIContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import { createProductionAdapters } from "./adapters.ts";
import { createSteward, type StewardDependencies, type StatusTarget } from "./steward.ts";

export type StewardUiSurface = Pick<ExtensionUIContext, "notify" | "setStatus">;
export type StewardCommandContext = Pick<ExtensionCommandContext, "mode" | "cwd"> & {
  ui: StewardUiSurface;
};
type StewardSessionContext = Pick<ExtensionContext, "mode" | "cwd"> & {
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
export type StewardAdapterFactory = (ui: StewardUiSurface) => StewardDependencies;

const defaultAdapterFactory: StewardAdapterFactory = (ui) => createProductionAdapters(ui);

function runStatus(
  ctx: StewardCommandContext | StewardSessionContext,
  target: StatusTarget,
  adapterFactory: StewardAdapterFactory,
): void {
  createSteward(adapterFactory(ctx.ui)).status(ctx.cwd, target);
}

/** Register Steward's TUI-only session footer and status command. */
export function registerStewardExtension(
  pi: StewardRegistrationSurface,
  adapterFactory: StewardAdapterFactory = defaultAdapterFactory,
): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    runStatus(ctx, "footer", adapterFactory);
  });

  pi.registerCommand("steward", {
    description: "Inspect the active Steward Run.",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return;
      if (args.trim() !== "status") {
        ctx.ui.notify("Usage: /steward status", "info");
        return;
      }
      runStatus(ctx, "command", adapterFactory);
    },
  });
}

/** Pi's package entrypoint. */
export default function stewardExtension(pi: ExtensionAPI): void {
  registerStewardExtension(pi);
}
