import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { afterEach, it } from "vitest";

import { createConfigStore } from "../src/config-store.ts";
import { createRunJournalAdapter } from "../src/adapters.ts";
import { registerStewardExtension, type StewardCommandContext, type StewardCommandHandler, type StewardRegistrationSurface } from "../src/extension.ts";
import { buildInitialRunJournal, type RunDraft, type RunJournal } from "../src/run.ts";
import type { ProjectModelPlans, RecoveryDefaults } from "../src/config.ts";
import type { ManagedAgentInspection, StewardDependencies, StewardHerdrAdapter, StewardUiAdapter } from "../src/steward.ts";

const roots: string[] = [];
const baseRevision = "0123456789abcdef0123456789abcdef01234567";
const headRevision = "1111111111111111111111111111111111111111";
const modelPlans: ProjectModelPlans = {
	builder: { primary: { model: "builder/primary", thinkingLevel: "high" }, fallbacks: [] },
	reviewer: { primary: { model: "reviewer/primary", thinkingLevel: "high" }, fallbacks: [] },
};
const settings: RecoveryDefaults = {
	passiveInspectionIntervalSeconds: 1,
	secondInspectionAndNudgeIntervalSeconds: 2,
	nudgeGracePeriodSeconds: 1,
	externalCommandWarningThresholdSeconds: 3,
	maximumActiveTasks: 1,
	transientRetryLimit: 1,
	reworkCycleLimit: 2,
};

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function draft(): RunDraft {
	return {
		declaredOutcome: "Ship the reconciled change",
		tasks: [{
			requiredOutcome: "Implement the approved change",
			allowedScope: ["src"],
			expectedArtifacts: [{ kind: "git-commit" }],
			verification: { kind: "command", command: "npm test" },
			reviewRequired: false,
		}],
		modelPlan: modelPlans,
		effectiveSettings: settings,
		finalVerification: { kind: "command", command: "npm test" },
	};
}

function context(root: string, mode: StewardCommandContext["mode"] = "tui"): StewardCommandContext {
	return {
		mode,
		hasUI: mode === "tui",
		cwd: root,
		modelRegistry: {} as StewardCommandContext["modelRegistry"],
		model: undefined,
		thinkingLevel: undefined,
		scopedModels: [],
		sessionManager: { getSessionId: () => "controller-10" } as StewardCommandContext["sessionManager"],
		ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined, notify() {}, setStatus() {} },
	};
}

function makeDependencies(root: string, lifecycle: () => ManagedAgentInspection, effects: { prompts: number; reportRequests: number; answers: number; worktreeProgress: number }): StewardDependencies {
	const runJournal = createRunJournalAdapter();
	const builderPath = join(root, "builder-worktree");
	const identity = { name: "steward-b-01234567-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" };
	const ui: StewardUiAdapter = {
		presentStatus() {},
		async editConfiguration() { return { kind: "cancelled" }; },
		presentConfigurationResult() {},
		async draftRun() { return { kind: "drafted" as const, draft: draft() }; },
		async confirmRun() { return true; },
		presentStartResult() {},
		presentResumeResult() {},
	};
	const herdr: StewardHerdrAdapter = {
		async checkAvailability() { return { kind: "available", status: "running", running: true, compatible: true, endpointCompatible: true }; },
		async createBuilderWorktree(input) { await mkdir(builderPath, { recursive: true }); return { kind: "created", branch: input.branch, path: builderPath, workspaceId: identity.workspaceId, tabId: "tab-1", paneId: identity.paneId, terminalId: identity.terminalId }; },
		async startBuilder(input) { return { kind: "started", name: input.name, agentKind: "pi", workspaceId: identity.workspaceId, tabId: "tab-1", paneId: identity.paneId, terminalId: identity.terminalId }; },
		async promptBuilder(input) { effects.prompts += 1; return { kind: "prompted", name: input.name, workspaceId: identity.workspaceId, tabId: "tab-1", paneId: identity.paneId, terminalId: identity.terminalId }; },
		async inspectManagedAgent() { return lifecycle(); },
		async readBlockedTaskFactRequest() { return { kind: "unstructured", diagnostic: "no canonical question in this fixture" }; },
		async requestAttemptReport() { effects.reportRequests += 1; return { kind: "prompted", name: identity.name, workspaceId: identity.workspaceId, tabId: "tab-1", paneId: identity.paneId, terminalId: identity.terminalId }; },
		async answerBlockedTaskFact() { effects.answers += 1; return { kind: "acknowledged", identity }; },
	};
	const git = {
		async inspectIntegrationBase() { return { kind: "ready" as const, branch: "main", revision: baseRevision }; },
		async branchExists() { return false; },
		async inspectBuilderWorktree(_path: string, expectedRevision: string) { return { kind: "ready" as const, head: expectedRevision, clean: true as const }; },
		async inspectManagedWorktreeProgress() { effects.worktreeProgress += 1; return { kind: "observed" as const, head: headRevision, worktree: { kind: "observed" as const, byteCount: 0, sha256: "sha256:" + "0".repeat(64) }, git: { head: headRevision, digest: { kind: "observed" as const, byteCount: 0, sha256: "sha256:" + "0".repeat(64) } } }; },
	};
	return {
		runJournal,
		herdr,
		git,
		process: {},
		model: { listModelChoices: () => [], async validateModelPlans() { return []; } },
		clock: { now: () => new Date("2026-09-18T00:00:00.000Z"), randomUUID: () => "01234567-89ab-cdef-0123-456789abcdef" },
		ui,
	};
}

async function setup(lifecycle: () => ManagedAgentInspection, effects = { prompts: 0, reportRequests: 0, answers: 0, worktreeProgress: 0 }): Promise<{ root: string; command: StewardCommandHandler; deps: StewardDependencies; journal: RunJournal; names: string[]; effects: typeof effects }> {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-resume-"));
	roots.push(root);
	const config = createConfigStore();
	await config.saveRecoveryDefaults(settings);
	await config.saveModelPlans(root, modelPlans);
	const deps = makeDependencies(root, lifecycle, effects);
	let command: StewardCommandHandler | undefined;
	const names: string[] = [];
	registerStewardExtension({
		on() {},
		registerCommand(name, options) { names.push(name); command = options.handler; },
	}, () => deps);
	if (!command) throw new Error("missing registered command");
	await command("start", context(root));
	const loaded = await deps.runJournal.loadActive(root);
	if (loaded.kind !== "loaded") throw new Error("start did not persist an active Journal");
	return { root, command, deps, journal: loaded.journal, names, effects };
}

it.sequential("registered resume reconciles an exact working agent in the same Attempt", async () => {
	const effects = { prompts: 0, reportRequests: 0, answers: 0, worktreeProgress: 0 };
	const fixture = await setup(() => ({ kind: "observed", identity: { name: "steward-b-01234567-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" }, lifecycle: "working", stateChangeSequence: 7 }), effects);
	equal(fixture.names.length, 1);
	equal(fixture.names[0], "steward");
	equal(effects.prompts, 1);
	await fixture.command("resume", context(fixture.root));
	const loaded = await fixture.deps.runJournal.loadActive(fixture.root);
	if (loaded.kind !== "loaded") throw new Error("missing reconciled Journal");
	const attempt = loaded.journal.run.tasks[0]?.attempts[0];
	if (!attempt) throw new Error("missing Builder Attempt");
	equal(attempt.id, fixture.journal.run.tasks[0]?.attempts[0]?.id);
	equal(attempt.state, "active");
	equal(attempt.dispatch.phase, "prompted");
	equal(attempt.recovery?.live.kind, "working");
	equal(effects.prompts, 1);
});

it.sequential("settled resume requests one report and then blocks without a resend", async () => {
	const effects = { prompts: 0, reportRequests: 0, answers: 0, worktreeProgress: 0 };
	const fixture = await setup(() => ({ kind: "observed", identity: { name: "steward-b-01234567-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" }, lifecycle: "idle", stateChangeSequence: 8 }), effects);
	await fixture.command("resume", context(fixture.root));
	let loaded = await fixture.deps.runJournal.loadActive(fixture.root);
	if (loaded.kind !== "loaded") throw new Error("missing awaiting-report Journal");
	let attempt = loaded.journal.run.tasks[0]?.attempts[0];
	if (!attempt) throw new Error("missing Attempt");
	equal(attempt.state, "awaiting-report");
	equal(attempt.recovery?.reportRequest?.phase, "requested");
	equal(effects.reportRequests, 1);
	await fixture.command("resume", context(fixture.root));
	loaded = await fixture.deps.runJournal.loadActive(fixture.root);
	if (loaded.kind !== "loaded") throw new Error("missing blocked Journal");
	attempt = loaded.journal.run.tasks[0]?.attempts[0];
	if (!attempt) throw new Error("missing Attempt after block");
	equal(attempt.state, "awaiting-report");
	equal(attempt.recovery?.reportRequest?.phase, "blocked");
	equal(loaded.journal.run.tasks[0]?.attentionReason, "reconciliation-report-missing");
	equal(effects.reportRequests, 1);
});

it.sequential("unclear and exact missing outcomes never replace the Attempt", async () => {
	for (const kind of ["unclear", "missing"] as const) {
		const effects = { prompts: 0, reportRequests: 0, answers: 0, worktreeProgress: 0 };
		const fixture = await setup(() => kind === "missing"
			? { kind: "missing", diagnostic: "recorded agent is gone" }
			: { kind: "unclear", diagnostic: "server unavailable" }, effects);
		await fixture.command("resume", context(fixture.root));
		const loaded = await fixture.deps.runJournal.loadActive(fixture.root);
		if (loaded.kind !== "loaded") throw new Error("missing recovery Journal");
		const task = loaded.journal.run.tasks[0]!;
		const attempt = task.attempts[0]!;
		equal(attempt.id, fixture.journal.run.tasks[0]?.attempts[0]?.id);
		equal(task.attention, "recovering");
		equal(task.attentionReason, kind === "missing" ? "reconciliation-agent-missing" : "reconciliation-live-unclear");
		equal(attempt.recovery?.live.kind, kind);
		if (kind === "missing") {
			ok(attempt.recovery?.preservation);
			equal(effects.worktreeProgress, 1);
		}
		equal(effects.prompts, 1);
	}
});

it.sequential("non-TUI resume refuses before adapter creation and extra args are usage-only", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-resume-authority-"));
	roots.push(root);
	let factoryCalls = 0;
	let command: StewardCommandHandler | undefined;
	const notifications: string[] = [];
	registerStewardExtension({
		on() {},
		registerCommand(_name, options) { command = options.handler; },
	}, () => { factoryCalls += 1; throw new Error("adapter factory must not run"); });
	if (!command) throw new Error("missing registered command");
	const nonTui = context(root, "rpc");
	nonTui.ui.notify = (message) => notifications.push(message);
	await (async () => {
		try { await command!("resume", nonTui); throw new Error("resume should require TUI"); }
		catch (error: unknown) { ok(error instanceof Error && error.message === "Steward resume requires interactive TUI mode."); }
	})();
	equal(factoryCalls, 0);
	const tui = context(root);
	tui.ui.notify = (message) => notifications.push(message);
	await command("resume --takeover", tui);
	equal(factoryCalls, 0);
	ok(notifications.some((message) => message.includes("Usage: /steward")));
});

it.sequential("the pure policy keeps report, live, settled, unclear, and missing order", async () => {
	const { decideReconciliation } = await import("../src/reconciliation.ts");
	deepStrictEqual(decideReconciliation({ report: "valid", live: { kind: "missing" } }), { kind: "report" });
	deepStrictEqual(decideReconciliation({ report: "invalid", live: { kind: "working", lifecycle: "working" } }), { kind: "working-or-blocked", lifecycle: "working" });
	deepStrictEqual(decideReconciliation({ report: "missing", live: { kind: "settled", lifecycle: "idle" } }), { kind: "settled", lifecycle: "idle" });
	deepStrictEqual(decideReconciliation({ report: "unclear", live: { kind: "unclear" } }), { kind: "unclear" });
	deepStrictEqual(decideReconciliation({ report: "missing", live: { kind: "missing" } }), { kind: "missing" });
	});
