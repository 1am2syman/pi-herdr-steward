import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createRunJournalAdapter } from "../src/adapters.ts";
import { BUILTIN_RECOVERY_DEFAULTS, type ProjectModelPlans } from "../src/config.ts";
import { registerStewardExtension, type StewardCommandContext, type StewardCommandHandler } from "../src/extension.ts";
import { buildStewardIntakePrompt } from "../src/intake.ts";
import { buildInitialRunJournal, type RunDraft } from "../src/run.ts";
import { createSteward, type StewardDependencies } from "../src/steward.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const models: ProjectModelPlans = {
 builder: { primary: { model: "builder/model", thinkingLevel: "high" }, fallbacks: [] },
 reviewer: { primary: { model: "reviewer/model", thinkingLevel: "high" }, fallbacks: [] },
};
const proposal: RunDraft = {
 declaredOutcome: "Resolve issues #3 and #8 sequentially",
 tasks: [3, 8].map((number) => ({ requiredOutcome: "Resolve issue #" + number, allowedScope: ["src/issue-" + number + ".ts"], expectedArtifacts: [{ kind: "git-commit" }], verification: { kind: "command", command: "npm test" }, reviewRequired: true })),
 modelPlan: models, finalVerification: { kind: "command", command: "npm test" },
};
async function fixture(confirm = false) {
 const root = await mkdtemp(join(tmpdir(), "steward-intake-")); roots.push(root);
 let manualDrafts = 0; let confirmations = 0; let confirmedMarkdown = "";
 const deps: StewardDependencies = {
  runJournal: createRunJournalAdapter(),
  herdr: { async checkAvailability() { return { kind: "available", status: "running", running: true, compatible: true, endpointCompatible: true }; } },
  git: { async inspectIntegrationBase() { return { kind: "ready", branch: "main", revision: "a".repeat(40) }; } },
  process: {}, model: { listModelChoices: () => [], async validateModelPlans() { return []; } },
  clock: { now: () => new Date("2026-09-17T18:00:00.000Z"), randomUUID: () => "01234567-89ab-cdef-0123-456789abcdef" },
  ui: { presentStatus() {}, async editConfiguration() { return { kind: "cancelled" }; }, presentConfigurationResult() {},
   async draftRun() { manualDrafts++; return { kind: "cancelled" }; },
   async confirmRun(summary) { confirmations++; confirmedMarkdown = summary.markdown; return confirm; }, presentStartResult() {},
   async draftRunRevision() { manualDrafts++; return { kind: "cancelled" }; },
   async confirmRunRevision(summary) { confirmations++; confirmedMarkdown = summary.markdown; return confirm; },
  },
 };
 const ctx: StewardCommandContext = { mode: "tui", hasUI: true, cwd: root, modelRegistry: {} as StewardCommandContext["modelRegistry"], model: undefined, thinkingLevel: undefined, scopedModels: [], sessionManager: { getSessionId: () => "intake-controller" } as StewardCommandContext["sessionManager"], ui: { async select() { return undefined; }, async input() { return undefined; }, async confirm() { return false; }, notify() {}, setStatus() {} } };
 return { root, deps, ctx, observations: () => ({ manualDrafts, confirmations, confirmedMarkdown }) };
}

it("hands arbitrary multiline requests to the active agent without constructing adapters", async () => {
 const { ctx } = await fixture(); let handler: StewardCommandHandler | undefined; const messages: string[] = [];
 registerStewardExtension({ on() {}, registerCommand(_name, options) { handler = options.handler; }, registerTool() {}, sendUserMessage(content) { messages.push(String(content)); } }, () => { throw new Error("must not construct adapters during handoff"); });
 await handler!("start tackle the urgent bugs first\nthen investigate the flaky checks", ctx);
 expect(messages).toHaveLength(1); expect(messages[0]).toContain("tackle the urgent bugs first\nthen investigate the flaky checks");
 expect(messages[0]).toContain("steward_context"); expect(messages[0]).toContain("untrusted");
 await expect(handler!("start any goal", { ...ctx, mode: "print", hasUI: false })).rejects.toThrow("interactive TUI");
});

it("preserves manual start and refuses unavailable agent APIs", async () => {
 const f = await fixture(); let handler: StewardCommandHandler | undefined;
 registerStewardExtension({ on() {}, registerCommand(_name, options) { handler = options.handler; } }, () => f.deps);
 await handler!("start", f.ctx); expect(f.observations().manualDrafts).toBe(1);
 await expect(handler!("start anything", f.ctx)).rejects.toThrow("agent messaging and tool APIs");
});

it("resolves omitted defaults, confirms the complete ordered proposal, and cancellation writes no Run", async () => {
 const f = await fixture(); await f.deps.runJournal.saveModelPlans(f.root, models);
 const { modelPlan: _modelPlan, ...withoutModels } = proposal;
 const result = await createSteward(f.deps).start(f.root, "intake-controller", withoutModels);
 expect(result.kind).toBe("cancelled"); expect(f.observations().manualDrafts).toBe(0);
 expect(f.observations().confirmations).toBe(1); expect(f.observations().confirmedMarkdown).toMatch(/issue #3[\s\S]*issue #8/);
 expect(existsSync(join(f.root, ".pi/steward/active-run.json"))).toBe(false);
});

it("rejects malformed proposals and missing model defaults before confirmation", async () => {
 for (const bad of [null, {}, { ...proposal, tasks: [] }, { ...proposal, tasks: [{ ...proposal.tasks[0], allowedScope: ["../escape"] }] }, { ...proposal, modelPlan: undefined }]) {
  const f = await fixture(); const result = await createSteward(f.deps).start(f.root, "intake-controller", bad);
  expect(result.kind).toBe("refused"); expect(f.observations().confirmations).toBe(0); expect(f.observations().manualDrafts).toBe(0);
  expect(existsSync(join(f.root, ".pi/steward/active-run.json"))).toBe(false);
 }
});

it("persists confirmed agent proposals with inherited defaults through the existing start path", async () => {
 const f = await fixture(true); const result = await createSteward(f.deps).start(f.root, "intake-controller", proposal);
 expect(result.kind).toBe("started-dispatch-pending");
 const active = await f.deps.runJournal.loadActive(f.root); expect(active.kind).toBe("loaded");
 if (active.kind !== "loaded") throw new Error("missing Run");
 expect(active.journal.run.tasks.map((task) => task.contract.requiredOutcome)).toEqual(proposal.tasks.map((task) => task.requiredOutcome));
 expect(active.journal.run.effectiveSettings.maximumActiveTasks).toBe(1);
});

it("registers sequential callable tools, enforces TUI mode, and supports cancel then another proposal", async () => {
 const f = await fixture(); const tools = new Map<string, { executionMode: ToolDefinition["executionMode"]; execute(id: string, params: unknown, signal: AbortSignal, update: undefined, ctx: ExtensionContext): Promise<{ details: unknown }> }>();
 registerStewardExtension({ on() {}, registerCommand() {}, registerTool(tool) { tools.set(tool.name, { executionMode: tool.executionMode, execute: (id, params, signal, update, ctx) => tool.execute(id, params as Parameters<typeof tool.execute>[1], signal, update, ctx) }); } }, () => f.deps);
 expect([...tools.keys()]).toEqual(["steward_context", "steward_github_issues", "steward_start", "steward_revise", "steward_control"]);
 expect([...tools.values()].every((tool) => tool.executionMode === "sequential")).toBe(true);
 const ctx = f.ctx as ExtensionContext; const signal = new AbortController().signal;
 const start = tools.get("steward_start")!;
 await expect(start.execute("1", proposal, signal, undefined, { ...ctx, mode: "rpc", hasUI: true })).rejects.toThrow("interactive TUI");
 expect((await start.execute("2", proposal, signal, undefined, ctx)).details).toEqual({ kind: "cancelled" });
 const control = tools.get("steward_control")!;
 await expect(control.execute("3", { action: "status", takeover: true }, signal, undefined, ctx)).rejects.toThrow("takeover only");
 await control.execute("4", { action: "cancel" }, signal, undefined, ctx);
 expect((await start.execute("5", proposal, signal, undefined, ctx)).details).toEqual({ kind: "cancelled" });
 const aborted = new AbortController(); aborted.abort();
 await expect(start.execute("6", proposal, aborted.signal, undefined, ctx)).rejects.toThrow("aborted");
});

it("agent revisions use existing validation and confirmation without manual field entry", async () => {
 const f = await fixture(); const journal = buildInitialRunJournal({ identity: { runId: "run-20260917T180000000Z-01234567", createdAt: "2026-09-17T18:00:00.000Z" }, controllerSessionId: "intake-controller", draft: proposal, modelPlan: models, effectiveSettings: { ...BUILTIN_RECOVERY_DEFAULTS }, integrationBase: { kind: "git", branch: "main", revision: "a".repeat(40) } });
 await f.deps.runJournal.createActive(f.root, journal);
 const revision = { tasks: journal.run.tasks.map((task, i) => ({ id: task.contract.id, contract: { ...task.contract, requiredOutcome: i === 0 ? "Resolve issue #3 with added regression coverage" : task.contract.requiredOutcome } })), modelPlan: models };
 const result = await createSteward(f.deps).revise(f.root, "intake-controller", revision);
 expect(result.kind).toBe("cancelled"); expect(f.observations().manualDrafts).toBe(0); expect(f.observations().confirmations).toBe(1);
 expect((await createSteward(f.deps).revise(f.root, "intake-controller", { ...revision, tasks: [] })).kind).toBe("refused");
 const active = await f.deps.runJournal.loadActive(f.root);
 expect(active.kind === "loaded" && active.journal.journalRevision).toBe(1);
});

it("built-in GitHub tool uses the host runner without creating a Run or adapters", async () => {
 const f = await fixture(); let execute: ((params: unknown, ctx: ExtensionContext) => Promise<{ details: unknown; content: unknown }>) | undefined; let calls = 0;
 const signal = new AbortController().signal;
 registerStewardExtension({ on() {}, registerCommand() {}, registerTool(tool) { if (tool.name === "steward_github_issues") execute = (params, ctx) => tool.execute("gh", params as Parameters<typeof tool.execute>[1], signal, undefined, ctx); } }, () => { throw new Error("discovery must not construct adapters"); }, async (command, args, options) => {
  calls++; expect(command).toBe("gh"); expect(args).toContain("GET"); expect(options?.cwd).toBe(f.root);
  return { code: 0, killed: false, stdout: "[[]]", stderr: "" };
 });
 if (!execute) throw new Error("GitHub tool missing");
 const result = await execute({ repository: "acme/project" }, f.ctx as ExtensionContext);
 expect(result.details).toMatchObject({ repository: "acme/project", issues: [] });
 expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("untrusted data") })]));
 expect(calls).toBe(1); expect(f.observations().confirmations).toBe(0);
 expect(existsSync(join(f.root, ".pi/steward/active-run.json"))).toBe(false);
 await expect(execute({}, { ...f.ctx, mode: "rpc" } as ExtensionContext)).rejects.toThrow("interactive TUI");
 expect(calls).toBe(1);
});

it("intake explains unsupported policies and snapshot semantics", () => {
 const prompt = buildStewardIntakePrompt("do anything");
 expect(prompt).toContain("steward_github_issues"); expect(prompt).toContain("local Markdown"); expect(prompt).toContain("all pages"); expect(prompt).toContain("Freeze a snapshot"); expect(prompt).toContain("Unsupported capabilities"); expect(prompt).toContain("Never retry after cancellation");
});
