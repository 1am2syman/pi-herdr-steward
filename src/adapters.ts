import { lstatSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import type {
  ActiveRunProbe,
  OpaqueAdapter,
  RunJournalAdapter,
  StatusTarget,
  StatusView,
  StewardDependencies,
  StewardUiAdapter,
} from "./steward.ts";

const STEWARD_DIRECTORY_NAME = "steward";
const ACTIVE_RUN_FILE_NAME = "active-run.json";
const STATUS_KEY = "pi-herdr-steward";

type PiStatusUi = Pick<ExtensionUIContext, "notify" | "setStatus">;

function activeRunPath(repositoryRoot: string): string {
  return join(repositoryRoot, CONFIG_DIR_NAME, STEWARD_DIRECTORY_NAME, ACTIVE_RUN_FILE_NAME);
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Probe only the Steward-owned active journal path, without creating its parents. */
export function createRunJournalAdapter(): RunJournalAdapter {
  function probeActive(repositoryRoot: string): ActiveRunProbe {
    try {
      lstatSync(activeRunPath(repositoryRoot));
      return "present";
    } catch (error: unknown) {
      if (isMissingPath(error)) {
        return "missing";
      }
      return "present";
    }
  }

  return { probeActive };
}

/** Present status through Pi's informational notification and built-in footer status slot. */
export function createPiUiAdapter(ui: PiStatusUi): StewardUiAdapter {
  function presentStatus(statusView: StatusView, target: StatusTarget): void {
    if (target === "command") {
      ui.notify(statusView.markdown, "info");
    }
    ui.setStatus(STATUS_KEY, statusView.footer.text);
  }

  return { presentStatus };
}

/** Assemble production adapters for one request without growing the orchestration seam. */
export function createProductionAdapters(ui: PiStatusUi): StewardDependencies {
  const emptyHerdr: OpaqueAdapter = {};
  const emptyGit: OpaqueAdapter = {};
  const emptyProcess: OpaqueAdapter = {};
  const emptyModel: OpaqueAdapter = {};
  const emptyClock: OpaqueAdapter = {};

  return {
    runJournal: createRunJournalAdapter(),
    herdr: emptyHerdr,
    git: emptyGit,
    process: emptyProcess,
    model: emptyModel,
    clock: emptyClock,
    ui: createPiUiAdapter(ui),
  };
}
