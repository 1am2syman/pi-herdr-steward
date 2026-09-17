import { existsSync } from "node:fs";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { afterEach, it } from "vitest";

import { createPiUiAdapter, createRunJournalAdapter } from "../src/adapters.ts";
import {
  registerStewardExtension,
  type StewardCommandHandler,
  type StewardCommandContext,
  type StewardRegistrationSurface,
} from "../src/extension.ts";
import type {
  OpaqueAdapter,
  StatusTarget,
  StatusView,
  StewardDependencies,
} from "../src/steward.ts";

interface Notification {
  message: string;
  type: "info" | "warning" | "error";
}

interface StatusUpdate {
  key: string;
  text: string | undefined;
}

interface TreeSnapshotEntry {
  path: string;
  kind: "directory" | "file" | "symlink" | "other";
  mode: number;
  contents?: string;
  linkTarget?: string;
}

type OpaqueSlot = "herdr" | "git" | "process" | "model" | "clock";
type OpaqueSlotCalls = Record<OpaqueSlot, number>;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function snapshotTree(root: string): Promise<TreeSnapshotEntry[]> {
  const entries: TreeSnapshotEntry[] = [];

  async function visit(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const absolutePath = join(directory, child.name);
      const relativePath = relative(root, absolutePath);
      const stats = await lstat(absolutePath);
      const entry: TreeSnapshotEntry = {
        path: relativePath,
        kind: stats.isDirectory()
          ? "directory"
          : stats.isFile()
            ? "file"
            : stats.isSymbolicLink()
              ? "symlink"
              : "other",
        mode: stats.mode & 0o7777,
      };
      if (stats.isFile()) {
        entry.contents = (await readFile(absolutePath)).toString("base64");
      }
      if (stats.isSymbolicLink()) {
        entry.linkTarget = await readlink(absolutePath);
      }
      entries.push(entry);
      if (stats.isDirectory()) {
        await visit(absolutePath);
      }
    }
  }

  await visit(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function makeRepository(withControllerLedger: boolean): Promise<string> {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-herdr-steward-status-"));
  temporaryDirectories.push(repositoryRoot);
  if (!withControllerLedger) return repositoryRoot;

  const ledgerRoot = join(repositoryRoot, ".herdr", "orchestration");
  await mkdir(join(ledgerRoot, "states"), { recursive: true });
  await mkdir(join(ledgerRoot, "signals"), { recursive: true });
  await writeFile(
    join(ledgerRoot, "manifest.json"),
    JSON.stringify({ schema_version: 1, project: "controller", run: "example" }) + "\n",
  );
  await writeFile(
    join(ledgerRoot, "states", "01-worker.json"),
    JSON.stringify({ schema_version: 1, unit: "01", role: "worker", status: "done" }) + "\n",
  );
  await writeFile(join(ledgerRoot, "events.log"), '{"action":"fixture"}\n');
  await writeFile(join(ledgerRoot, "signals", "01-worker-done"), "");
  await writeFile(join(ledgerRoot, ".ledger.lock"), "controller fixture lock\n");
  await writeFile(join(ledgerRoot, "LEDGER.md"), "# controller fixture\n");
  await symlink("manifest.json", join(ledgerRoot, "manifest-link.json"));
  return repositoryRoot;
}

function createOpaqueAdapter(slot: OpaqueSlot, calls: OpaqueSlotCalls): OpaqueAdapter {
  return new Proxy(
    {},
    {
      get(_target, property) {
        calls[slot] += 1;
        throw new Error(`unexpected ${slot} adapter access: ${String(property)}`);
      },
    },
  );
}

interface RegistrationCapture {
  name: string | undefined;
  handler: StewardCommandHandler | undefined;
}

function createRegistrationSurface(capture: RegistrationCapture): StewardRegistrationSurface {
  return {
    on() {},
    registerCommand(name, options) {
      capture.name = name;
      capture.handler = options.handler;
    },
  };
}

it("registered /steward status reports an empty Run and performs no writes", async () => {
  for (const withControllerLedger of [false, true]) {
    const repositoryRoot = await makeRepository(withControllerLedger);
    const before = await snapshotTree(repositoryRoot);
    const notifications: Notification[] = [];
    const statusUpdates: StatusUpdate[] = [];
    const presentations: Array<{ statusView: StatusView; target: StatusTarget }> = [];
    const adapterCalls = {
      herdr: 0,
      git: 0,
      process: 0,
      model: 0,
      clock: 0,
    };
    const commandRegistration: RegistrationCapture = { name: undefined, handler: undefined };
    const registrationSurface = createRegistrationSurface(commandRegistration);
    const productionUiAdapter = createPiUiAdapter({
      notify(message, type = "info") {
        notifications.push({ message, type });
      },
      setStatus(key, text) {
        statusUpdates.push({ key, text });
      },
    });
    const dependencies: StewardDependencies = {
      runJournal: createRunJournalAdapter(),
      herdr: createOpaqueAdapter("herdr", adapterCalls),
      git: createOpaqueAdapter("git", adapterCalls),
      process: createOpaqueAdapter("process", adapterCalls),
      model: {
        listModelChoices() {
          return [];
        },
        async validateModelPlans() {
          return [];
        },
      },
      clock: createOpaqueAdapter("clock", adapterCalls),
      ui: {
        presentStatus(statusView, target) {
          presentations.push({ statusView, target });
          productionUiAdapter.presentStatus(statusView, target);
        },
        async editConfiguration() {
          return { kind: "cancelled" as const };
        },
        presentConfigurationResult() {},
      },
    };
    const adapterFactory = (): StewardDependencies => dependencies;

    registerStewardExtension(registrationSurface, adapterFactory);
    equal(commandRegistration.name, "steward");
    ok(commandRegistration.handler, "the registered steward command handler should be captured");
    await commandRegistration.handler("status", {
      mode: "tui",
      hasUI: true,
      cwd: repositoryRoot,
      modelRegistry: {} as StewardCommandContext["modelRegistry"],
      model: undefined,
      thinkingLevel: undefined,
      scopedModels: [],
      ui: {
        select: async () => undefined,
        confirm: async () => false,
        input: async () => undefined,
        notify() {},
        setStatus() {},
      },
    });

    const after = await snapshotTree(repositoryRoot);
    deepStrictEqual(after, before);
    equal(existsSync(join(repositoryRoot, ".pi", "steward")), false);
    equal(existsSync(join(repositoryRoot, ".pi", "steward", "active-run.json")), false);
    deepStrictEqual(presentations, [
      {
        statusView: {
          kind: "empty",
          markdown: "No active Steward Run exists in this repository.",
          footer: { run: "none", attentionCount: 0, text: "steward: no active Run" },
        },
        target: "command",
      },
    ]);
    deepStrictEqual(notifications, [
      { message: "No active Steward Run exists in this repository.", type: "info" },
    ]);
    deepStrictEqual(statusUpdates, [
      { key: "pi-herdr-steward", text: "steward: no active Run" },
    ]);
    deepStrictEqual(adapterCalls, {
      herdr: 0,
      git: 0,
      process: 0,
      model: 0,
      clock: 0,
    });
  }
});
