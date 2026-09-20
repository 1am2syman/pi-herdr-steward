import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { afterEach, it, vi } from "vitest";

import { createConfigStore } from "../src/config-store.ts";
import { createRunJournalAdapter } from "../src/adapters.ts";
import { resolveRunJournalPaths } from "../src/run-journal-store.ts";
import { registerStewardExtension, type StewardCommandContext, type StewardCommandHandler, type StewardRegistrationSurface } from "../src/extension.ts";
import { serializeBuilderAttemptReport, type BuilderAttemptReport } from "../src/attempt-report.ts";
import { deserializeReviewerAssignment, serializeReviewerAttemptReport, type ReviewerAttemptReport } from "../src/review.ts";
import { advanceRunJournal, buildBuilderAssignment, buildInitialRunJournal, builderAssignmentSha256, type AttemptRecord, type BuilderDispatchRecord, type RunDraft, type RunJournal } from "../src/run.ts";
import type { ProjectModelPlans, RecoveryDefaults } from "../src/config.ts";
import type { ManagedAgentInspection, SilenceProcessObservation, StewardDependencies, StewardHerdrAdapter, StewardUiAdapter } from "../src/steward.ts";
import { parseTaskFactRequest, resolveTaskFactAnswer } from "../src/reconciliation.ts";

vi.setConfig({ testTimeout: 60_000 });

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

type ResumeEffects = {
	prompts: number;
	reportRequests: number;
	answers: number;
	worktreeProgress: number;
	worktreeCreates?: number;
	builderStarts?: number;
	reviewerPanes?: number;
	reviewerStarts?: number;
	reviewerPrompts?: number;
	assignmentCreates?: number;
	gitInspections?: number;
	processCalls?: number;
};

type SetupOptions = {
	reviewRequired?: boolean;
	reviewFailure?: "pane";
	processObservation?: SilenceProcessObservation;
};

function bump(effects: ResumeEffects, key: "worktreeCreates" | "builderStarts" | "reviewerPanes" | "reviewerStarts" | "reviewerPrompts" | "assignmentCreates" | "gitInspections" | "processCalls"): void {
	effects[key] = (effects[key] ?? 0) + 1;
}

function draft(reviewRequired = false): RunDraft {
	return {
		declaredOutcome: "Ship the reconciled change",
		tasks: [{
			requiredOutcome: "Implement the approved change",
			allowedScope: ["src"],
			expectedArtifacts: [{ kind: "git-commit" }],
			verification: { kind: "command", command: "npm test" },
			reviewRequired,
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

function makeDependencies(root: string, lifecycle: () => ManagedAgentInspection, effects: ResumeEffects, options: SetupOptions = {}): StewardDependencies {
	const runJournal = createRunJournalAdapter();
	const createAssignment = runJournal.createAssignment.bind(runJournal);
	runJournal.createAssignment = async (repositoryRoot, document) => {
		bump(effects, "assignmentCreates");
		return createAssignment(repositoryRoot, document);
	};
	const builderPath = join(root, "builder-worktree");
	const identity = { name: "steward-b-01234567-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" };
	const reviewerPane = { workspaceId: "workspace-1", tabId: "tab-2", paneId: "pane-2", terminalId: "terminal-2" };
	const reviewFingerprint = "sha256:" + "a".repeat(64);
	const ui: StewardUiAdapter = {
		presentStatus() {},
		async editConfiguration() { return { kind: "cancelled" }; },
		presentConfigurationResult() {},
		async draftRun() { return { kind: "drafted" as const, draft: draft(options.reviewRequired === true) }; },
		async confirmRun() { return true; },
		presentStartResult() {},
		presentResumeResult() {},
	};
	const herdr: StewardHerdrAdapter = {
		async checkAvailability() { return { kind: "available", status: "running", running: true, compatible: true, endpointCompatible: true }; },
		async createBuilderWorktree(input) { bump(effects, "worktreeCreates"); await mkdir(builderPath, { recursive: true }); return { kind: "created", branch: input.branch, path: builderPath, workspaceId: identity.workspaceId, tabId: "tab-1", paneId: identity.paneId, terminalId: identity.terminalId }; },
		async startBuilder(input) { bump(effects, "builderStarts"); return { kind: "started", name: input.name, agentKind: "pi", workspaceId: identity.workspaceId, tabId: "tab-1", paneId: identity.paneId, terminalId: identity.terminalId }; },
		async promptBuilder(input) { effects.prompts += 1; return { kind: "prompted", name: input.name, workspaceId: identity.workspaceId, tabId: "tab-1", paneId: identity.paneId, terminalId: identity.terminalId }; },
		async createReviewerPane(input) {
			bump(effects, "reviewerPanes");
			if (options.reviewFailure === "pane") return { kind: "failed", stage: "pane-split", code: "pane-split-failed", message: "Reviewer pane split failed" };
			return { kind: "created", ...reviewerPane, sourcePaneId: input.sourcePaneId, worktreePath: input.worktreePath };
		},
		async startReviewer(input) { bump(effects, "reviewerStarts"); return { kind: "started", name: input.name, agentKind: "pi", ...reviewerPane }; },
		async promptReviewer(input) { bump(effects, "reviewerPrompts"); return { kind: "prompted", name: input.name, ...reviewerPane }; },
		async inspectManagedAgent() { return lifecycle(); },
		async readBlockedTaskFactRequest() { return { kind: "unstructured", diagnostic: "no canonical question in this fixture" }; },
		async requestAttemptReport() { effects.reportRequests += 1; return { kind: "prompted", name: identity.name, workspaceId: identity.workspaceId, tabId: "tab-1", paneId: identity.paneId, terminalId: identity.terminalId }; },
		async answerBlockedTaskFact() { effects.answers += 1; return { kind: "acknowledged", identity }; },
	};
	const git = {
		async inspectIntegrationBase() { bump(effects, "gitInspections"); return { kind: "ready" as const, branch: "main", revision: baseRevision }; },
		async branchExists() { bump(effects, "gitInspections"); return false; },
		async inspectBuilderWorktree(_path: string, expectedRevision: string) { bump(effects, "gitInspections"); return { kind: "ready" as const, head: expectedRevision, clean: true as const }; },
		async inspectProducedCodeArtifact(input: { worktreePath: string; approvedBase: string; producedHead: string }) { bump(effects, "gitInspections"); return { kind: "inspected" as const, base: input.approvedBase, head: input.producedHead, commits: [continuationCommit, input.producedHead], changedPaths: [{ status: "M", paths: ["src/change.ts"] }], clean: true as const }; },
		async inspectReviewWorktree() { bump(effects, "gitInspections"); return { head: headRevision, dirtyStateFingerprint: reviewFingerprint, dirtyPaths: [], operationMarkers: [] }; },
		async inspectManagedWorktreeProgress() { effects.worktreeProgress += 1; return { kind: "observed" as const, head: headRevision, worktree: { kind: "observed" as const, byteCount: 0, sha256: "sha256:" + "0".repeat(64) }, git: { head: headRevision, digest: { kind: "observed" as const, byteCount: 0, sha256: "sha256:" + "0".repeat(64) } } }; },
	};
	return {
		runJournal,
		herdr,
		git,
		process: options.processObservation ? { inspectAttemptProcesses: async () => options.processObservation! } : {},
		model: { listModelChoices: () => [], async validateModelPlans() { return []; }, async inspectModelChoice(choice) { return { choice, available: true, diagnostics: [] }; } },
		clock: { now: () => new Date("2026-09-18T00:00:00.000Z"), randomUUID: () => "01234567-89ab-cdef-0123-456789abcdef" },
		ui,
	};
}

async function setup(lifecycle: () => ManagedAgentInspection, effects: ResumeEffects = { prompts: 0, reportRequests: 0, answers: 0, worktreeProgress: 0 }, options: SetupOptions = {}): Promise<{ root: string; command: StewardCommandHandler; deps: StewardDependencies; journal: RunJournal; names: string[]; effects: ResumeEffects; setNow(iso: string): void }> {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-resume-"));
	roots.push(root);
	const config = createConfigStore();
	await config.saveRecoveryDefaults(settings);
	await config.saveModelPlans(root, modelPlans);
	const deps = makeDependencies(root, lifecycle, effects, options);
	let nowMs = Date.parse("2026-09-18T00:00:00.000Z");
	deps.clock = { ...deps.clock, now: () => new Date(nowMs) };
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
	return { root, command, deps, journal: loaded.journal, names, effects, setNow(iso) { nowMs = Date.parse(iso); } };
}

const continuationCommit = "2222222222222222222222222222222222222222";

function digest(bytes: Buffer | string): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}


function dispatchIdentity(attempt: AttemptRecord): { name: string; workspaceId: string; paneId: string; terminalId: string } {
	if (!("workspaceId" in attempt.dispatch) || typeof attempt.dispatch.workspaceId !== "string" || !("paneId" in attempt.dispatch) || typeof attempt.dispatch.paneId !== "string" || !("terminalId" in attempt.dispatch) || typeof attempt.dispatch.terminalId !== "string") throw new Error("Attempt does not have a complete resource identity");
	return { name: attempt.dispatch.agentName, workspaceId: attempt.dispatch.workspaceId, paneId: attempt.dispatch.paneId, terminalId: attempt.dispatch.terminalId };
}

function rewindPreparedBuilder(journal: RunJournal, dispatch: BuilderDispatchRecord): RunJournal {
	return advanceRunJournal(journal, new Date("2026-09-18T00:00:01.000Z"), (next) => {
		const attempt = next.run.tasks[0]?.attempts[0];
		if (!attempt || attempt.role !== "builder") throw new Error("Builder Attempt missing while rewinding fixture");
		attempt.state = "prepared";
		delete attempt.activatedAt;
		delete attempt.evidence;
		delete attempt.recovery;
		attempt.dispatch = dispatch;
	});
}

async function writeResumeBuilderReport(root: string, journal: RunJournal): Promise<void> {
	const task = journal.run.tasks[0];
	const attempt = task?.attempts.at(-1);
	if (!task || !attempt || attempt.role !== "builder") throw new Error("Builder Attempt missing for report fixture");
	const assignmentBytes = await readFile(attempt.assignmentPath, "utf8");
	const assignment = JSON.parse(assignmentBytes) as { assignment: { actualModel: BuilderAttemptReport["actualModel"]; specificationHash: string } };
	const log = Buffer.from("pass\n");
	const logPath = join(attempt.evidenceDirectory, "resume-check.log");
	await writeFile(logPath, log);
	const report: BuilderAttemptReport = {
		schemaVersion: 1,
		identity: { runId: journal.run.id, taskId: task.contract.id, attemptId: attempt.id, role: "builder", specificationHash: assignment.assignment.specificationHash, assignmentSha256: builderAssignmentSha256(assignmentBytes) },
		status: "completed",
		summary: `Builder ${attempt.id} completed.`,
		blockers: [],
		producedArtifacts: [{ kind: "git-commit", baseRevision, headRevision, commits: [continuationCommit, headRevision] }],
		actualModel: assignment.assignment.actualModel,
		checks: [{ kind: "command", command: "npm test", exitCode: 0, summary: "pass", logId: "resume-check" }],
		logReferences: [{ id: "resume-check", path: logPath, size: log.byteLength, sha256: digest(log) }],
		producedRevision: headRevision,
	};
	await writeFile(attempt.reportPath, serializeBuilderAttemptReport(report));
}

async function writeResumeReviewerReport(journal: RunJournal, verdict: ReviewerAttemptReport["verdict"]): Promise<void> {
	const task = journal.run.tasks[0];
	const attempt = task?.attempts.at(-1);
	if (!task || !attempt || attempt.role !== "reviewer") throw new Error("Reviewer Attempt missing for report fixture");
	const assignmentBytes = await readFile(attempt.assignmentPath, "utf8");
	const assignment = deserializeReviewerAssignment(assignmentBytes);
	if (!assignment.value) throw new Error("Reviewer Assignment fixture did not decode");
	const report: ReviewerAttemptReport = {
		schemaVersion: 1,
		identity: { runId: journal.run.id, taskId: task.contract.id, attemptId: attempt.id, role: "reviewer", specificationHash: attempt.specificationHash, assignmentSha256: digest(assignmentBytes) },
		status: "completed",
		summary: "Reviewer completed.",
		blockers: [],
		actualModel: attempt.actualModel,
		reviewedSubject: assignment.value.assignment.subject,
		verdict,
		findings: verdict === "changes-required" ? [{ id: "finding-1", severity: "major", summary: "The change needs correction.", detail: "Correct the changed behavior before relying on the result." }] : [],
		checks: [],
		logReferences: [],
	};
	await writeFile(attempt.reportPath, serializeReviewerAttemptReport(report));
}

async function loadResumeJournal(fixture: { deps: StewardDependencies; root: string }): Promise<RunJournal> {
	const loaded = await fixture.deps.runJournal.loadActive(fixture.root);
	if (loaded.kind !== "loaded") throw new Error("active Journal is not loaded");
	return loaded.journal;
}

it.sequential.each(["valid-report", "blocked", "settled", "unclear", "missing"] as const)("registered resume ordering keeps %s reconciliation ahead of silence actions", async (scenario) => {
	const effects: ResumeEffects = { prompts: 0, reportRequests: 0, answers: 0, worktreeProgress: 0 };
	const lifecycle = (): ManagedAgentInspection => {
		const exact = { name: "steward-b-01234567-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" };
		if (scenario === "blocked") return { kind: "observed", identity: exact, lifecycle: "blocked", stateChangeSequence: 9 };
		if (scenario === "settled") return { kind: "observed", identity: exact, lifecycle: "idle", stateChangeSequence: 10 };
		if (scenario === "unclear") return { kind: "unclear", diagnostic: "lifecycle unclear" };
		if (scenario === "missing") return { kind: "missing", diagnostic: "agent missing" };
		return { kind: "observed", identity: exact, lifecycle: "working", stateChangeSequence: 11 };
	};
	const processObservation: SilenceProcessObservation = { kind: "none", paneId: "pane-1", shellPid: 101, foregroundProcessGroupId: 101, processCount: 1, digest: "sha256:" + "0".repeat(64) };
	const fixture = await setup(lifecycle, effects, { processObservation });
	if (scenario === "valid-report") await writeResumeBuilderReport(fixture.root, fixture.journal);
	fixture.setNow("2026-09-18T00:01:00.000Z");
	await fixture.command("resume", context(fixture.root));
	const journal = await loadResumeJournal(fixture);
	const task = journal.run.tasks[0]!;
	if (scenario === "valid-report") {
		equal(task.attempts[0]?.state, "reported");
		equal(task.attempts[0]?.evidence?.phase, "finalized");
		equal(effects.reportRequests, 0);
	} else if (scenario === "settled") {
		equal(task.attempts[0]?.state, "awaiting-report");
		equal(task.attempts[0]?.recovery?.reportRequest?.phase, "requested");
		equal(effects.reportRequests, 1);
	} else if (scenario === "blocked") {
		equal(task.attentionReason, "reconciliation-blocked-question");
		equal(effects.reportRequests, 0);
	} else if (scenario === "unclear") {
		equal(task.attentionReason, "reconciliation-live-unclear");
	} else {
		equal(task.attentionReason, "reconciliation-agent-missing");
		ok(effects.worktreeProgress > 0);
	}
	ok(task.attention !== "suspected-stall", "ticket-10 reconciliation must preempt silence attention");
	equal(effects.prompts, 1, "no silence or duplicate lifecycle prompt was sent");
}, 60_000);

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

it.sequential.each(["throw", "killed", "malformed", "wrong-identity"] as const)("registered report-request %s is durable and never retried", async (scenario) => {
	const effects = { prompts: 0, reportRequests: 0, answers: 0, worktreeProgress: 0 };
	const fixture = await setup(() => ({ kind: "observed", identity: { name: "steward-b-01234567-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" }, lifecycle: "idle", stateChangeSequence: 14 }), effects);
	fixture.deps.herdr.requestAttemptReport = async () => {
		effects.reportRequests += 1;
		if (scenario === "throw") throw new Error("request runner threw");
		if (scenario === "killed") return { kind: "failed", stage: "agent-prompt", code: "killed", message: "request killed" };
		if (scenario === "malformed") return { kind: "failed", stage: "agent-prompt", code: "malformed-response", message: "malformed" };
		return { kind: "prompted", name: "wrong-agent", workspaceId: "workspace-1", tabId: "tab-1", paneId: "pane-1", terminalId: "terminal-1" };
	};
	await fixture.command("resume", context(fixture.root));
	let loaded = await fixture.deps.runJournal.loadActive(fixture.root);
	if (loaded.kind !== "loaded") throw new Error("missing report-request failure Journal");
	equal(loaded.journal.run.tasks[0]?.attentionReason, "reconciliation-report-missing");
	equal(loaded.journal.run.tasks[0]?.attempts[0]?.recovery?.reportRequest?.phase, "ambiguous");
	equal(effects.reportRequests, 1);
	await fixture.command("resume", context(fixture.root));
	loaded = await fixture.deps.runJournal.loadActive(fixture.root);
	if (loaded.kind !== "loaded") throw new Error("missing repeated report-request Journal");
	equal(loaded.journal.run.tasks[0]?.attempts[0]?.recovery?.reportRequest?.phase, "blocked");
	equal(effects.reportRequests, 1);
});

it.sequential("registered report-request CAS ambiguity preserves intent and prevents a duplicate request", async () => {
	const effects = { prompts: 0, reportRequests: 0, answers: 0, worktreeProgress: 0 };
	const fixture = await setup(() => ({ kind: "observed", identity: { name: "steward-b-01234567-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" }, lifecycle: "idle", stateChangeSequence: 15 }), effects);
	const replaceActive = fixture.deps.runJournal.replaceActive.bind(fixture.deps.runJournal);
	fixture.deps.runJournal.replaceActive = async (repositoryRoot, candidate) => candidate.run.tasks[0]?.attempts[0]?.recovery?.reportRequest?.phase === "requested"
		? { kind: "active-missing", paths: resolveRunJournalPaths(repositoryRoot) }
		: replaceActive(repositoryRoot, candidate);
	await fixture.command("resume", context(fixture.root));
	let loaded = await fixture.deps.runJournal.loadActive(fixture.root);
	if (loaded.kind !== "loaded") throw new Error("missing report-request intent Journal");
	equal(loaded.journal.run.tasks[0]?.attempts[0]?.recovery?.reportRequest?.phase, "intended");
	equal(effects.reportRequests, 1);
	await fixture.command("resume", context(fixture.root));
	loaded = await fixture.deps.runJournal.loadActive(fixture.root);
	if (loaded.kind !== "loaded") throw new Error("missing CAS ambiguity Journal");
	equal(loaded.journal.run.tasks[0]?.attempts[0]?.recovery?.reportRequest?.phase, "blocked");
	equal(effects.reportRequests, 1);
});

it.sequential("registered resume answers one canonical blocked Task fact exactly once and acknowledges the same identity", async () => {
	const effects = { prompts: 0, reportRequests: 0, answers: 0, worktreeProgress: 0 };
	const fixture = await setup(() => ({ kind: "observed", identity: { name: "steward-b-01234567-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" }, lifecycle: "blocked", stateChangeSequence: 11 }), effects);
	const parsed = parseTaskFactRequest('STEWARD_TASK_FACT_REQUEST {"schemaVersion":1,"field":"reportPath"}', "builder");
	if (parsed.kind !== "fact-request") throw new Error("canonical Task-fact fixture did not parse");
	fixture.deps.herdr.readBlockedTaskFactRequest = async () => parsed;
	fixture.deps.herdr.answerBlockedTaskFact = async (input) => {
		effects.answers += 1;
		const beforeAck = await fixture.deps.runJournal.loadActive(fixture.root);
		if (beforeAck.kind !== "loaded") throw new Error("missing intended blocked answer Journal");
		const attempt = beforeAck.journal.run.tasks[0]?.attempts[0];
		if (!attempt) throw new Error("missing blocked Builder Attempt");
		if (!("workspaceId" in attempt.dispatch) || !("paneId" in attempt.dispatch) || !("terminalId" in attempt.dispatch)) throw new Error("blocked Builder identity is not complete");
		equal(attempt.recovery?.blockedAnswer?.phase, "intended");
		const expected = resolveTaskFactAnswer("reportPath", attempt.reportPath);
		if (expected.kind !== "answer") throw new Error("reportPath should be answerable");
		equal(input.answer, expected.answer.answer);
		equal(input.identity.name, attempt.dispatch.agentName);
		equal(input.identity.workspaceId, attempt.dispatch.workspaceId);
		equal(input.identity.paneId, attempt.dispatch.paneId);
		equal(input.identity.terminalId, attempt.dispatch.terminalId);
		return { kind: "acknowledged", identity: { ...input.identity } };
	};
	await fixture.command("resume", context(fixture.root));
	let loaded = await fixture.deps.runJournal.loadActive(fixture.root);
	if (loaded.kind !== "loaded") throw new Error("missing acknowledged blocked Journal");
	let task = loaded.journal.run.tasks[0]!;
	let attempt = task.attempts[0]!;
	equal(task.attention, "none");
	equal(attempt.recovery?.live.kind, "blocked");
	equal(attempt.recovery?.blockedAnswer?.phase, "acknowledged");
	equal(effects.answers, 1);
	await fixture.command("resume", context(fixture.root));
	loaded = await fixture.deps.runJournal.loadActive(fixture.root);
	if (loaded.kind !== "loaded") throw new Error("missing repeated blocked Journal");
	task = loaded.journal.run.tasks[0]!;
	attempt = task.attempts[0]!;
	equal(attempt.recovery?.blockedAnswer?.phase, "acknowledged");
	equal(effects.answers, 1);
	equal(effects.reportRequests, 0);
});

it.sequential.each([
	["credentials", { kind: "unstructured", diagnostic: "credentials requested" }],
	["scope change", { kind: "unstructured", diagnostic: "scope change requested" }],
	["model choice", { kind: "unstructured", diagnostic: "model choice requested" }],
	["remote instruction", { kind: "unstructured", diagnostic: "remote instruction requested" }],
	["destructive Git", { kind: "unstructured", diagnostic: "destructive Git requested" }],
	["approval", { kind: "unstructured", diagnostic: "approval requested" }],
	["free prose", { kind: "unstructured", diagnostic: "free prose is not canonical" }],
	["multiple", parseTaskFactRequest('STEWARD_TASK_FACT_REQUEST {"schemaVersion":1,"field":"reportPath"}\nSTEWARD_TASK_FACT_REQUEST {"schemaVersion":1,"field":"reportPath"}', "builder")],
	["unsupported", parseTaskFactRequest('STEWARD_TASK_FACT_REQUEST {"schemaVersion":1,"field":"credentials"}', "builder")],
	] as const)("registered blocked unsafe Task-fact %s requests require attention without input or report request", async (_label, request) => {
	const effects = { prompts: 0, reportRequests: 0, answers: 0, worktreeProgress: 0 };
	const fixture = await setup(() => ({ kind: "observed", identity: { name: "steward-b-01234567-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" }, lifecycle: "blocked", stateChangeSequence: 12 }), effects);
	fixture.deps.herdr.readBlockedTaskFactRequest = async () => request;
	await fixture.command("resume", context(fixture.root));
	const loaded = await fixture.deps.runJournal.loadActive(fixture.root);
	if (loaded.kind !== "loaded") throw new Error("missing unsafe-question Journal");
	const task = loaded.journal.run.tasks[0]!;
	equal(task.attention, "blocked");
	equal(task.attentionReason, "reconciliation-blocked-question");
	equal(task.attempts[0]?.recovery?.blockedAnswer, undefined);
	equal(effects.answers, 0);
	equal(effects.reportRequests, 0);
	await fixture.command("resume", context(fixture.root));
	equal(effects.answers, 0);
	equal(effects.reportRequests, 0);
});

it.sequential("registered blocked changed-Assignment question is preserved as attention without input", async () => {
	const effects = { prompts: 0, reportRequests: 0, answers: 0, worktreeProgress: 0 };
	const fixture = await setup(() => ({ kind: "observed", identity: { name: "steward-b-01234567-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" }, lifecycle: "blocked", stateChangeSequence: 13 }), effects);
	const parsed = parseTaskFactRequest('STEWARD_TASK_FACT_REQUEST {"schemaVersion":1,"field":"reportPath"}', "builder");
	if (parsed.kind !== "fact-request") throw new Error("canonical Task-fact fixture did not parse");
	fixture.deps.herdr.readBlockedTaskFactRequest = async () => parsed;
	const inspectAssignment = fixture.deps.runJournal.inspectAttemptAssignment;
	if (!inspectAssignment) throw new Error("Assignment inspection adapter missing");
	fixture.deps.runJournal.inspectAttemptAssignment = async (input) => {
		const observed = await inspectAssignment(input);
		return observed.kind === "loaded" ? { ...observed, sha256: "sha256:" + "f".repeat(64) } : observed;
	};
	await fixture.command("resume", context(fixture.root));
	const loaded = await fixture.deps.runJournal.loadActive(fixture.root);
	if (loaded.kind !== "loaded") throw new Error("missing changed-Assignment Journal");
	equal(loaded.journal.run.tasks[0]?.attentionReason, "reconciliation-blocked-question");
	equal(loaded.journal.run.tasks[0]?.attempts[0]?.recovery?.blockedAnswer, undefined);
	equal(effects.answers, 0);
	equal(effects.reportRequests, 0);
});

it.sequential.each(["throw", "wrong-identity", "failed", "ambiguous"] as const)("registered blocked Task-fact acknowledgement %s is ambiguous without a resend", async (scenario) => {
	const effects = { prompts: 0, reportRequests: 0, answers: 0, worktreeProgress: 0 };
	const fixture = await setup(() => ({ kind: "observed", identity: { name: "steward-b-01234567-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" }, lifecycle: "blocked", stateChangeSequence: 16 }), effects);
	const parsed = parseTaskFactRequest('STEWARD_TASK_FACT_REQUEST {"schemaVersion":1,"field":"reportPath"}', "builder");
	if (parsed.kind !== "fact-request") throw new Error("canonical Task-fact fixture did not parse");
	fixture.deps.herdr.readBlockedTaskFactRequest = async () => parsed;
	fixture.deps.herdr.answerBlockedTaskFact = async (input) => {
		effects.answers += 1;
		if (scenario === "throw") throw new Error("send-keys threw");
		if (scenario === "failed") return { kind: "failed", message: "send-keys failed" };
		if (scenario === "ambiguous") return { kind: "ambiguous", message: "send-keys killed" };
		return { kind: "acknowledged", identity: { ...input.identity, paneId: "other-pane" } };
	};
	await fixture.command("resume", context(fixture.root));
	let loaded = await fixture.deps.runJournal.loadActive(fixture.root);
	if (loaded.kind !== "loaded") throw new Error("missing blocked answer Journal");
	equal(loaded.journal.run.tasks[0]?.attentionReason, "reconciliation-blocked-question");
	equal(loaded.journal.run.tasks[0]?.attempts[0]?.recovery?.blockedAnswer?.phase, "ambiguous");
	equal(effects.answers, 1);
	await fixture.command("resume", context(fixture.root));
	loaded = await fixture.deps.runJournal.loadActive(fixture.root);
	if (loaded.kind !== "loaded") throw new Error("missing repeated blocked answer Journal");
	equal(loaded.journal.run.tasks[0]?.attempts[0]?.recovery?.blockedAnswer?.phase, "ambiguous");
	equal(effects.answers, 1);
});

it.sequential("registered blocked Task-fact acknowledgement CAS ambiguity preserves intended input and never resends", async () => {
	const effects = { prompts: 0, reportRequests: 0, answers: 0, worktreeProgress: 0 };
	const fixture = await setup(() => ({ kind: "observed", identity: { name: "steward-b-01234567-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" }, lifecycle: "blocked", stateChangeSequence: 17 }), effects);
	const parsed = parseTaskFactRequest('STEWARD_TASK_FACT_REQUEST {"schemaVersion":1,"field":"reportPath"}', "builder");
	if (parsed.kind !== "fact-request") throw new Error("canonical Task-fact fixture did not parse");
	fixture.deps.herdr.readBlockedTaskFactRequest = async () => parsed;
	fixture.deps.herdr.answerBlockedTaskFact = async (input) => { effects.answers += 1; return { kind: "acknowledged", identity: { ...input.identity } }; };
	const replaceActive = fixture.deps.runJournal.replaceActive.bind(fixture.deps.runJournal);
	let injected = true;
	fixture.deps.runJournal.replaceActive = async (repositoryRoot, candidate) => injected && candidate.run.tasks[0]?.attempts[0]?.recovery?.blockedAnswer?.phase === "acknowledged"
		? (injected = false, { kind: "active-missing", paths: resolveRunJournalPaths(repositoryRoot) })
		: replaceActive(repositoryRoot, candidate);
	await fixture.command("resume", context(fixture.root));
	let loaded = await fixture.deps.runJournal.loadActive(fixture.root);
	if (loaded.kind !== "loaded") throw new Error("missing blocked answer intent Journal");
	equal(loaded.journal.run.tasks[0]?.attempts[0]?.recovery?.blockedAnswer?.phase, "intended");
	equal(effects.answers, 1);
	await fixture.command("resume", context(fixture.root));
	loaded = await fixture.deps.runJournal.loadActive(fixture.root);
	if (loaded.kind !== "loaded") throw new Error("missing blocked answer CAS Journal");
	equal(loaded.journal.run.tasks[0]?.attempts[0]?.recovery?.blockedAnswer?.phase, "ambiguous");
	equal(effects.answers, 1);
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
	await command("resume --takeover unexpected", tui);
	equal(factoryCalls, 0);
	ok(notifications.some((message) => message.includes("Usage: /steward")));
});

it.sequential("the pure policy keeps report, live, settled, unclear, and missing order", async () => {
	const { decideReconciliation } = await import("../src/reconciliation.ts");
	deepStrictEqual(decideReconciliation({ report: "valid", live: { kind: "missing" } }), { kind: "report" });
	deepStrictEqual(decideReconciliation({ report: "invalid", live: { kind: "working", lifecycle: "working" } }), { kind: "working-or-blocked", lifecycle: "working" });
	deepStrictEqual(decideReconciliation({ report: "invalid", live: { kind: "blocked", lifecycle: "blocked" } }), { kind: "working-or-blocked", lifecycle: "blocked" });
	deepStrictEqual(decideReconciliation({ report: "missing", live: { kind: "settled", lifecycle: "idle" } }), { kind: "settled", lifecycle: "idle" });
	deepStrictEqual(decideReconciliation({ report: "unclear", live: { kind: "unclear" } }), { kind: "unclear" });
	deepStrictEqual(decideReconciliation({ report: "missing", live: { kind: "missing" } }), { kind: "missing" });
	});

it.sequential.each(["worktree-intended", "agent-intended"] as const)("ticket-10 case-10 registered prepared Builder %s continues the same identity", async (phase) => {
	const effects: ResumeEffects = { prompts: 0, reportRequests: 0, answers: 0, worktreeProgress: 0, worktreeCreates: 0, builderStarts: 0, assignmentCreates: 0, gitInspections: 0 };
	const fixture = await setup(() => ({ kind: "observed", identity: { name: "steward-b-01234567-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" }, lifecycle: "working", stateChangeSequence: 41 }), effects);
	const started = fixture.journal.run.tasks[0]?.attempts[0];
	if (!started || started.role !== "builder" || started.dispatch.phase !== "prompted") throw new Error("started Builder fixture is missing its proven dispatch");
	const originalIdentity = dispatchIdentity(started);
	const originalAssignmentPath = started.assignmentPath;
	const originalAssignment = await readFile(originalAssignmentPath);
	const before = { worktreeCreates: effects.worktreeCreates ?? 0, builderStarts: effects.builderStarts ?? 0, prompts: effects.prompts, assignments: effects.assignmentCreates ?? 0 };
	const preparedDispatch = phase === "worktree-intended"
		? { phase: "worktree-intended" as const, branch: started.dispatch.branch, agentName: started.dispatch.agentName }
		: { phase: "agent-intended" as const, branch: started.dispatch.branch, agentName: started.dispatch.agentName, worktreePath: started.dispatch.worktreePath, workspaceId: started.dispatch.workspaceId, paneId: started.dispatch.paneId, terminalId: started.dispatch.terminalId };
	if (phase === "worktree-intended") await rm(join(fixture.root, "builder-worktree"), { recursive: true, force: true });
	const prepared = rewindPreparedBuilder(fixture.journal, preparedDispatch);
	if ((await fixture.deps.runJournal.replaceActive(fixture.root, prepared)).kind !== "replaced") throw new Error("prepared Builder rewind was not persisted");

	await fixture.command("resume", context(fixture.root));
	let journal = await loadResumeJournal(fixture);
	let attempt = journal.run.tasks[0]?.attempts[0];
	if (!attempt || attempt.role !== "builder") throw new Error("continued Builder Attempt is missing");
	equal(attempt.id, started.id);
	equal(attempt.assignmentPath, originalAssignmentPath);
	deepStrictEqual(dispatchIdentity(attempt), originalIdentity);
	equal(journal.run.tasks[0]?.attempts.length, 1);
	if (phase === "worktree-intended") {
		equal(attempt.state, "prepared");
		equal(attempt.dispatch.phase, "agent-intended");
		equal(effects.worktreeCreates! - before.worktreeCreates, 1, "prepared worktree must be created exactly once");
		equal(effects.builderStarts! - before.builderStarts, 0);
	} else {
		equal(attempt.dispatch.phase, "prompt-intended");
		equal(effects.worktreeCreates! - before.worktreeCreates, 0);
		equal(effects.builderStarts! - before.builderStarts, 0, "an exact live agent must not be started again");
		equal(effects.assignmentCreates! - before.assignments, 1, "agent continuation must perform one create-or-existing-match Assignment reuse");
	}
	equal(effects.prompts - before.prompts, 0, "the original Assignment prompt must never be resent");

	await fixture.command("resume", context(fixture.root));
	journal = await loadResumeJournal(fixture);
	attempt = journal.run.tasks[0]?.attempts[0];
	if (!attempt || attempt.role !== "builder") throw new Error("Builder Attempt disappeared on second continuation pass");
	equal(attempt.id, started.id);
	equal(journal.run.tasks[0]?.attempts.length, 1);
	deepStrictEqual(dispatchIdentity(attempt), originalIdentity);
	if (phase === "worktree-intended") {
		equal(attempt.dispatch.phase, "prompt-intended");
		equal(effects.worktreeCreates! - before.worktreeCreates, 1, "worktree continuation must not recreate the worktree");
		equal(effects.assignmentCreates! - before.assignments, 1, "worktree continuation must reuse one Assignment");
	} else {
		equal(attempt.dispatch.phase, "reconciled-active");
		equal(attempt.dispatch.basis, "matching-live-agent");
		equal(attempt.state, "active");
	}
	equal(effects.prompts - before.prompts, 0);
	equal(effects.reportRequests, 0);
	equal(Buffer.compare(await readFile(originalAssignmentPath), originalAssignment), 0, "Assignment bytes must not be clobbered");

	if (phase === "worktree-intended") {
		await fixture.command("resume", context(fixture.root));
		journal = await loadResumeJournal(fixture);
		attempt = journal.run.tasks[0]?.attempts[0];
		if (!attempt || attempt.role !== "builder") throw new Error("Builder Attempt disappeared on identity reconciliation pass");
		equal(attempt.dispatch.phase, "reconciled-active");
		equal(attempt.dispatch.basis, "matching-live-agent");
		equal(attempt.state, "active");
		equal(effects.worktreeCreates! - before.worktreeCreates, 1);
		equal(effects.assignmentCreates! - before.assignments, 1);
		equal(effects.prompts - before.prompts, 0);
	}
}, 60_000);

it.sequential("ticket-10 case-10 keeps a name collision inside the same prepared Builder Attempt", async () => {
	const effects: ResumeEffects = { prompts: 0, reportRequests: 0, answers: 0, worktreeProgress: 0, worktreeCreates: 0, builderStarts: 0, assignmentCreates: 0 };
	const fixture = await setup(() => ({ kind: "observed", identity: { name: "steward-b-01234567-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" }, lifecycle: "working", stateChangeSequence: 42 }), effects);
	const started = fixture.journal.run.tasks[0]?.attempts[0];
	if (!started || started.role !== "builder" || started.dispatch.phase !== "prompted") throw new Error("started Builder fixture is missing");
	const originalName = started.dispatch.agentName;
	const prepared = rewindPreparedBuilder(fixture.journal, { phase: "agent-intended", branch: started.dispatch.branch, agentName: originalName, worktreePath: started.dispatch.worktreePath, workspaceId: started.dispatch.workspaceId, paneId: started.dispatch.paneId, terminalId: started.dispatch.terminalId });
	if ((await fixture.deps.runJournal.replaceActive(fixture.root, prepared)).kind !== "replaced") throw new Error("collision fixture rewind was not persisted");
	// An interrupted agent-intended phase has not written its Assignment yet;
	// removing only this temporary fixture file lets the continuation create the
	// same deterministic Assignment after the within-Attempt rename.
	await rm(started.assignmentPath, { force: true });
	let starts = 0;
	let renamed = "";
	fixture.deps.herdr.inspectManagedAgent = async () => starts < 2
		? { kind: "missing", diagnostic: "exact recorded Builder is absent during continuation" }
		: { kind: "observed", identity: { name: renamed, workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" }, lifecycle: "working", stateChangeSequence: 43 };
	fixture.deps.herdr.startBuilder = async (input) => {
		starts += 1;
		bump(effects, "builderStarts");
		if (starts === 1) return { kind: "name-collision", code: "agent_name_taken", message: "recorded name is already taken" };
		renamed = input.name;
		return { kind: "started", name: input.name, agentKind: "pi", workspaceId: "workspace-1", tabId: "tab-1", paneId: "pane-1", terminalId: "terminal-1" };
	};
	const before = { prompts: effects.prompts, assignments: effects.assignmentCreates ?? 0, starts: effects.builderStarts ?? 0 };

	await fixture.command("resume", context(fixture.root));
	let journal = await loadResumeJournal(fixture);
	let attempt = journal.run.tasks[0]?.attempts[0];
	if (!attempt || attempt.role !== "builder") throw new Error("collision Builder Attempt disappeared");
	equal(attempt.id, started.id);
	equal(attempt.dispatch.phase, "agent-intended");
	ok(attempt.dispatch.agentName !== originalName, "collision must rename only the existing Attempt");
	equal(journal.run.tasks[0]?.attempts.length, 1);
	equal(starts, 1);
	equal(effects.prompts - before.prompts, 0);

	await fixture.command("resume", context(fixture.root));
	journal = await loadResumeJournal(fixture);
	attempt = journal.run.tasks[0]?.attempts[0];
	if (!attempt || attempt.role !== "builder") throw new Error("collision Builder Attempt disappeared after restart");
	equal(attempt.id, started.id);
	equal(attempt.dispatch.phase, "agent-intended");
	equal(attempt.dispatch.agentName, renamed);
	equal(starts, 2);
	equal(effects.prompts - before.prompts, 0);

	await fixture.command("resume", context(fixture.root));
	journal = await loadResumeJournal(fixture);
	attempt = journal.run.tasks[0]?.attempts[0];
	if (!attempt || attempt.role !== "builder") throw new Error("collision Builder Attempt disappeared after identity match");
	equal(attempt.id, started.id);
	equal(attempt.dispatch.phase, "prompt-intended");
	deepStrictEqual(dispatchIdentity(attempt), { name: renamed, workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" });
	equal(journal.run.tasks[0]?.attempts.length, 1);
	equal(effects.assignmentCreates! - before.assignments, 1);
	equal(effects.builderStarts! - before.starts, 2);
	equal(effects.prompts - before.prompts, 0);
}, 60_000);

it.sequential.each(["ambiguous-resource", "existing-resource"] as const)("ticket-10 case-10 registered Reviewer pane-intended %s preserves and stops without adoption", async (resourceCase) => {
	const effects: ResumeEffects = { prompts: 0, reportRequests: 0, answers: 0, worktreeProgress: 0, worktreeCreates: 0, builderStarts: 0, reviewerPanes: 0, reviewerStarts: 0, reviewerPrompts: 0, assignmentCreates: 0, gitInspections: 0 };
	const fixture = await setup(() => ({ kind: "unclear", diagnostic: "Reviewer pane identity is not available before the split" }), effects, { reviewRequired: true, reviewFailure: "pane" });
	await writeResumeBuilderReport(fixture.root, fixture.journal);
	await fixture.command("status", context(fixture.root));
	await fixture.command("status", context(fixture.root));
	let journal = await loadResumeJournal(fixture);
	const reviewer = journal.run.tasks[0]?.attempts.at(-1);
	if (!reviewer || reviewer.role !== "reviewer" || reviewer.dispatch.phase !== "pane-intended") throw new Error("real Reviewer pane-intended fixture is missing");
	const beforeDispatch = { ...reviewer.dispatch };
	const before = { panes: effects.reviewerPanes ?? 0, starts: effects.reviewerStarts ?? 0, prompts: effects.reviewerPrompts ?? 0, attempts: journal.run.tasks[0]?.attempts.length ?? 0 };
	fixture.deps.herdr.createReviewerPane = async (input) => {
		bump(effects, "reviewerPanes");
		if (resourceCase === "ambiguous-resource") return { kind: "failed", stage: "pane-split", code: "ambiguous-resource", message: "an existing pane resource is ambiguous" };
		return { kind: "created", workspaceId: input.workspaceId, tabId: "tab-2", paneId: "pane-2-replacement", terminalId: "terminal-2", sourcePaneId: input.sourcePaneId, worktreePath: input.worktreePath };
	};

	await fixture.command("resume", context(fixture.root));
	journal = await loadResumeJournal(fixture);
	const preserved = journal.run.tasks[0]?.attempts.at(-1);
	if (!preserved || preserved.role !== "reviewer") throw new Error("Reviewer Attempt disappeared during pane preservation");
	deepStrictEqual(preserved.dispatch, beforeDispatch, "pane-intended identity must be preserved byte-for-byte");
	equal(preserved.id, reviewer.id);
	equal(journal.run.tasks[0]?.attempts.length, before.attempts);
	equal(effects.reviewerPanes, before.panes, "ambiguous/existing pane resources must not trigger a second split or adoption");
	equal(effects.reviewerStarts, before.starts, "Reviewer must not be started from pane-intended state");
	equal(effects.reviewerPrompts, before.prompts, "Reviewer must not be prompted from pane-intended state");
}, 60_000);

it.sequential("ticket-10 case-10 registered rework assignment-intended reuses the same Assignment and Builder resources", async () => {
	const effects: ResumeEffects = { prompts: 0, reportRequests: 0, answers: 0, worktreeProgress: 0, worktreeCreates: 0, builderStarts: 0, reviewerPanes: 0, reviewerStarts: 0, reviewerPrompts: 0, assignmentCreates: 0, gitInspections: 0 };
	const fixture = await setup(() => ({ kind: "observed", identity: { name: "steward-b-01234567-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" }, lifecycle: "working", stateChangeSequence: 51 }), effects, { reviewRequired: true });
	const originalBuilder = fixture.journal.run.tasks[0]?.attempts[0];
	if (!originalBuilder || originalBuilder.role !== "builder" || originalBuilder.dispatch.phase !== "prompted") throw new Error("original Builder is missing before rework");
	const originalBuilderResource = { branch: originalBuilder.dispatch.branch, agentName: originalBuilder.dispatch.agentName, worktreePath: originalBuilder.dispatch.worktreePath, workspaceId: originalBuilder.dispatch.workspaceId, paneId: originalBuilder.dispatch.paneId, terminalId: originalBuilder.dispatch.terminalId };
	await writeResumeBuilderReport(fixture.root, fixture.journal);
	await fixture.command("status", context(fixture.root));
	let journal = await loadResumeJournal(fixture);
	await fixture.command("status", context(fixture.root));
	journal = await loadResumeJournal(fixture);
	if (journal.run.tasks[0]?.attempts.at(-1)?.role !== "reviewer") throw new Error("Reviewer was not dispatched before rework");
	await writeResumeReviewerReport(journal, "changes-required");
	await fixture.command("status", context(fixture.root));
	journal = await loadResumeJournal(fixture);
	const finalizedReviewer = journal.run.tasks[0]?.attempts.at(-1);
	if (!finalizedReviewer || finalizedReviewer.role !== "reviewer" || finalizedReviewer.state !== "reported") throw new Error("changes-required Reviewer was not finalized");

	const originalCreateAssignment = fixture.deps.runJournal.createAssignment.bind(fixture.deps.runJournal);
	let permitReworkAssignment = false;
	let continuationAssignmentCalls = 0;
	fixture.deps.runJournal.createAssignment = async (repositoryRoot, document) => {
		if (document.assignment.role === "builder" && document.assignment.attemptId !== "attempt-01") {
			if (!permitReworkAssignment) return { kind: "storage-error", paths: fixture.deps.runJournal.resolveAssignmentPaths(repositoryRoot, document.assignment.runId, document.assignment.taskId, document.assignment.attemptId), diagnostics: [] };
			continuationAssignmentCalls += 1;
		}
		return originalCreateAssignment(repositoryRoot, document);
	};
	await fixture.command("status", context(fixture.root));
	journal = await loadResumeJournal(fixture);
	const reserved = journal.run.tasks[0]?.attempts.at(-1);
	if (!reserved || reserved.role !== "builder" || reserved.dispatch.phase !== "assignment-intended") throw new Error("rework Assignment-intended fixture was not retained");
	equal(reserved.id, "attempt-03");
	const reservedDispatch = reserved.dispatch;
	const seededAssignment = buildBuilderAssignment({ run: journal.run, task: journal.run.tasks[0]!, attempt: reserved, worktreePath: reservedDispatch.worktreePath, branch: reservedDispatch.branch, workspaceId: reservedDispatch.workspaceId, paneId: reservedDispatch.paneId, terminalId: reservedDispatch.terminalId, agentName: reservedDispatch.agentName });
	const seeded = await originalCreateAssignment(fixture.root, seededAssignment);
	equal(seeded.kind, "created");
	const assignmentBefore = await readFile(reserved.assignmentPath);
	const before = { prompts: effects.prompts, builderStarts: effects.builderStarts ?? 0, panes: effects.reviewerPanes ?? 0, reviewerStarts: effects.reviewerStarts ?? 0, reviewerPrompts: effects.reviewerPrompts ?? 0, attempts: journal.run.tasks[0]?.attempts.length ?? 0 };
	permitReworkAssignment = true;

	await fixture.command("resume", context(fixture.root));
	journal = await loadResumeJournal(fixture);
	const continued = journal.run.tasks[0]?.attempts.at(-1);
	if (!continued || continued.role !== "builder") throw new Error("rework Builder disappeared during Assignment continuation");
	if (continued.dispatch.phase !== "prompt-intended") throw new Error("rework Assignment continuation did not persist prompt intent");
	equal(continued.id, reserved.id);
	equal(journal.run.tasks[0]?.attempts.length, before.attempts, "rework continuation must not create a second Attempt");
	deepStrictEqual({ branch: continued.dispatch.branch, agentName: continued.dispatch.agentName, worktreePath: continued.dispatch.worktreePath, workspaceId: continued.dispatch.workspaceId, paneId: continued.dispatch.paneId, terminalId: continued.dispatch.terminalId }, originalBuilderResource);
	equal(continued.assignmentPath, reserved.assignmentPath);
	equal(continued.dispatch.assignmentSha256, builderAssignmentSha256((await readFile(continued.assignmentPath)).toString("utf8")));
	equal(Buffer.compare(await readFile(continued.assignmentPath), assignmentBefore), 0, "existing rework Assignment bytes must not be clobbered");
	equal(continuationAssignmentCalls, 1, "rework continuation must perform one existing-match Assignment operation");
	equal(effects.prompts, before.prompts, "the original Builder Assignment prompt must not be resent");
	equal(effects.builderStarts, before.builderStarts);
	equal(effects.reviewerPanes, before.panes);
	equal(effects.reviewerStarts, before.reviewerStarts);
	equal(effects.reviewerPrompts, before.reviewerPrompts);
}, 60_000);

it.sequential("ticket-10 case-3 registered prepared prompt-intended working agent promotes in place with zero dispatch effects", async () => {
	const effects: ResumeEffects = { prompts: 0, reportRequests: 0, answers: 0, worktreeProgress: 0, worktreeCreates: 0, builderStarts: 0, reviewerPanes: 0, reviewerStarts: 0, reviewerPrompts: 0, assignmentCreates: 0, gitInspections: 0, processCalls: 0 };
	const liveIdentity = { name: "steward-b-01234567-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" };
	const fixture = await setup(() => ({ kind: "observed", identity: { ...liveIdentity }, lifecycle: "working", stateChangeSequence: 61 }), effects);
	const started = fixture.journal.run.tasks[0]?.attempts[0];
	if (!started || started.role !== "builder" || started.dispatch.phase !== "prompted") throw new Error("started Builder fixture is missing");
	const identity = dispatchIdentity(started);
	const assignmentBytes = await readFile(started.assignmentPath);
	const before = { prompts: effects.prompts, reportRequests: effects.reportRequests, worktreeProgress: effects.worktreeProgress, worktreeCreates: effects.worktreeCreates ?? 0, builderStarts: effects.builderStarts ?? 0, panes: effects.reviewerPanes ?? 0, reviewerStarts: effects.reviewerStarts ?? 0, reviewerPrompts: effects.reviewerPrompts ?? 0, assignments: effects.assignmentCreates ?? 0, git: effects.gitInspections ?? 0, process: effects.processCalls ?? 0 };
	const inspectedIdentities: Array<{ name: string; workspaceId: string; paneId: string; terminalId: string }> = [];
	const inspectManagedAgent = fixture.deps.herdr.inspectManagedAgent!;
	fixture.deps.herdr.inspectManagedAgent = async (observedIdentity) => { inspectedIdentities.push({ ...observedIdentity }); return inspectManagedAgent(observedIdentity); };
	fixture.deps.process = new Proxy({}, { get(_target, property) { bump(effects, "processCalls"); return undefined; } });
	const prepared = rewindPreparedBuilder(fixture.journal, { phase: "prompt-intended", branch: started.dispatch.branch, agentName: started.dispatch.agentName, worktreePath: started.dispatch.worktreePath, workspaceId: started.dispatch.workspaceId, paneId: started.dispatch.paneId, terminalId: started.dispatch.terminalId, assignmentSha256: started.dispatch.assignmentSha256 });
	if ((await fixture.deps.runJournal.replaceActive(fixture.root, prepared)).kind !== "replaced") throw new Error("prepared prompt-intended rewind was not persisted");

	await fixture.command("resume", context(fixture.root));
	let journal = await loadResumeJournal(fixture);
	let promoted = journal.run.tasks[0]?.attempts[0];
	if (!promoted || promoted.role !== "builder") throw new Error("promoted Builder disappeared");
	equal(promoted.id, started.id);
	equal(promoted.state, "active");
	equal(promoted.dispatch.phase, "reconciled-active");
	equal(promoted.dispatch.basis, "matching-live-agent");
	deepStrictEqual(dispatchIdentity(promoted), identity);
	equal(promoted.dispatch.assignmentSha256, started.dispatch.assignmentSha256);
	equal(promoted.assignmentPath, started.assignmentPath);
	equal(journal.run.tasks[0]?.attempts.length, 1);

	await fixture.command("status", context(fixture.root));
	journal = await loadResumeJournal(fixture);
	promoted = journal.run.tasks[0]?.attempts[0];
	if (!promoted || promoted.role !== "builder") throw new Error("Builder disappeared after registered status continuation");
	equal(promoted.dispatch.phase, "reconciled-active");
	equal(promoted.state, "active");
	deepStrictEqual(dispatchIdentity(promoted), identity);
	equal(journal.run.tasks[0]?.attempts.length, 1);
	deepStrictEqual(inspectedIdentities[0], identity);
	equal(effects.prompts, before.prompts, "original Builder prompt must not be resent");
	equal(effects.reportRequests, before.reportRequests, "no report request is allowed for a working agent");
	equal(effects.worktreeProgress, before.worktreeProgress);
	equal(effects.worktreeCreates, before.worktreeCreates);
	equal(effects.builderStarts, before.builderStarts);
	equal(effects.reviewerPanes, before.panes);
	equal(effects.reviewerStarts, before.reviewerStarts);
	equal(effects.reviewerPrompts, before.reviewerPrompts);
	equal(effects.assignmentCreates, before.assignments);
	equal(effects.gitInspections, before.git);
	equal(effects.processCalls, before.process);
	equal(Buffer.compare(await readFile(started.assignmentPath), assignmentBytes), 0);
}, 60_000);
