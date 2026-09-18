import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { afterEach, it } from "vitest";

import { createRunJournalAdapter } from "../src/adapters.ts";
import { createSteward } from "../src/steward.ts";
import { registerStewardExtension, type StewardCommandContext, type StewardCommandHandler, type StewardRegistrationSurface } from "../src/extension.ts";
import { serializeBuilderAttemptReport, type BuilderAttemptReport } from "../src/attempt-report.ts";
import { buildReviewerAssignment, deserializeReviewerAssignment, serializeReviewerAttemptReport } from "../src/review.ts";
import { builderAssignmentSha256, specificationHash, type ReviewerAttemptRecord, type RunDraft, type RunJournal, type TaskContract } from "../src/run.ts";
import type { ProjectModelPlans, RecoveryDefaults } from "../src/config.ts";
import type { StewardDependencies, StewardUiAdapter, StatusView } from "../src/steward.ts";

const roots: string[] = [];
const baseRevision = "0123456789abcdef0123456789abcdef01234567";
const headRevision = "2222222222222222222222222222222222222222";
const commits = ["1111111111111111111111111111111111111111", headRevision];
const fingerprint = "sha256:" + "a".repeat(64);
const recovery: RecoveryDefaults = { passiveInspectionIntervalSeconds: 301, secondInspectionAndNudgeIntervalSeconds: 302, nudgeGracePeriodSeconds: 121, externalCommandWarningThresholdSeconds: 1801, maximumActiveTasks: 1, transientRetryLimit: 1, reworkCycleLimit: 4 };

afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function digest(bytes: Buffer): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

function draft(): RunDraft {
	const modelPlan: ProjectModelPlans = {
		builder: { primary: { model: "builder/builder", thinkingLevel: "high" }, fallbacks: [] },
		reviewer: { primary: { model: "builder/reviewer", thinkingLevel: "high" }, fallbacks: [{ model: "other/unavailable", thinkingLevel: "medium" }, { model: "other/reviewer", thinkingLevel: "medium" }] },
	};
	return { declaredOutcome: "Build and independently review", tasks: [{ requiredOutcome: "Implement the change", allowedScope: ["src"], expectedArtifacts: [{ kind: "git-commit" }, { kind: "file", path: "src/change.ts" }], verification: { kind: "command", command: "npm test" }, reviewRequired: true }], modelPlan, effectiveSettings: recovery, finalVerification: { kind: "command", command: "npm test" } };
}

function context(root: string, sessionId = "controller-session"): StewardCommandContext {
	return { mode: "tui", hasUI: true, cwd: root, modelRegistry: {} as StewardCommandContext["modelRegistry"], model: undefined, thinkingLevel: undefined, scopedModels: [], sessionManager: { getSessionId: () => sessionId } as StewardCommandContext["sessionManager"], ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined, notify() {}, setStatus() {} } };
}

function capture(): { surface: StewardRegistrationSurface; handler(): StewardCommandHandler } {
	let command: StewardCommandHandler | undefined;
	return { surface: { on() {}, registerCommand(_name, options) { command = options.handler; } }, handler() { if (!command) throw new Error("missing steward command"); return command; } };
}

async function invoke(root: string, dependencies: StewardDependencies, command: string, sessionId = "controller-session"): Promise<StatusView | undefined> {
	let view: StatusView | undefined;
	dependencies.ui = { ...dependencies.ui, presentStatus(value) { view = value; } };
	const registered = capture();
	registerStewardExtension(registered.surface, () => dependencies);
	await registered.handler()(command, context(root, sessionId));
	return view;
}

function makeDependencies(root: string, options: { snapshots?: Array<{ head: string; dirtyStateFingerprint: string; dirtyPaths: string[]; operationMarkers: string[] }>; confirmSameFamily?: boolean; sameFamilyOnly?: boolean; noReviewerModels?: boolean; inspectionCalls?: string[]; confirmationCalls?: number[] } = {}): StewardDependencies {
	const runJournal = createRunJournalAdapter();
	let uuid = 0;
	let snapshotIndex = 0;
	const builderPath = join(root, "builder-worktree");
	const snapshots = options.snapshots ?? [{ head: headRevision, dirtyStateFingerprint: fingerprint, dirtyPaths: [], operationMarkers: [] }];
	const ui: StewardUiAdapter = {
		presentStatus() {},
		async editConfiguration() { return { kind: "cancelled" }; },
		presentConfigurationResult() {},
		async draftRun() { return { kind: "drafted" as const, draft: draft() }; },
		async confirmRun() { return true; },
		async confirmSameFamilyReview() { if (options.confirmationCalls) options.confirmationCalls[0] = (options.confirmationCalls[0] ?? 0) + 1; return options.confirmSameFamily ?? false; },
		presentStartResult() {},
	};
	return {
		runJournal,
		herdr: {
			async checkAvailability() { return { kind: "available", status: "running", running: true, compatible: true, endpointCompatible: true }; },
			async createBuilderWorktree(input) { return { kind: "created", branch: input.branch, path: builderPath, workspaceId: "workspace-1", tabId: "tab-1", paneId: "builder-pane", terminalId: "builder-terminal" }; },
			async startBuilder() { const active = await runJournal.loadActive(root); if (active.kind !== "loaded") throw new Error("missing journal"); const attempt = active.journal.run.tasks[0]!.attempts[0]!; return { kind: "started", name: attempt.role === "builder" ? attempt.dispatch.agentName : "builder", agentKind: "pi", workspaceId: "workspace-1", tabId: "tab-1", paneId: "builder-pane", terminalId: "builder-terminal" }; },
			async promptBuilder(input) { return { kind: "prompted", name: input.name, workspaceId: "workspace-1", tabId: "tab-1", paneId: "builder-pane", terminalId: "builder-terminal" }; },
			async createReviewerPane(input) { return { kind: "created", workspaceId: input.workspaceId, tabId: "tab-2", paneId: "reviewer-pane", terminalId: "reviewer-terminal", sourcePaneId: input.sourcePaneId, worktreePath: input.worktreePath }; },
			async startReviewer(input) { return { kind: "started", name: input.name, agentKind: "pi", workspaceId: "workspace-1", tabId: "tab-2", paneId: "reviewer-pane", terminalId: "reviewer-terminal" }; },
			async promptReviewer(input) { return { kind: "prompted", name: input.name, workspaceId: "workspace-1", tabId: "tab-2", paneId: "reviewer-pane", terminalId: "reviewer-terminal" }; },
		},
		git: {
			async inspectIntegrationBase() { return { kind: "ready", branch: "main", revision: baseRevision }; },
			async branchExists() { return false; },
			async inspectBuilderWorktree(_path, expectedRevision) { return { kind: "ready", head: expectedRevision, clean: true }; },
			async inspectProducedCodeArtifact() { return { kind: "inspected", base: baseRevision, head: headRevision, commits, changedPaths: [{ status: "M", paths: ["src/change.ts"] }], clean: true }; },
			async inspectReviewWorktree() { const value = snapshots[Math.min(snapshotIndex++, snapshots.length - 1)]!; return { ...value, dirtyPaths: [...value.dirtyPaths], operationMarkers: [...value.operationMarkers] }; },
		},
		process: {},
		model: {
			listModelChoices: () => [],
			async validateModelPlans() { return []; },
			async inspectModelChoice(choice, _role, index) { options.inspectionCalls?.push(choice.model); return (options.noReviewerModels === true || choice.model === "other/unavailable" || (options.sameFamilyOnly === true && choice.model.startsWith("other/"))) ? { choice, available: false, diagnostics: [{ code: "unavailable-model", role: "reviewer", index, reference: choice.model, message: "not available" }] } : { choice, available: true, diagnostics: [] }; },
		},
		clock: { now: () => new Date("2026-09-18T00:00:00.000Z"), randomUUID: () => `01234567-89ab-cdef-0123-456789abcde${++uuid}` },
		ui,
	};
}

async function startRun(root: string, dependencies: StewardDependencies): Promise<RunJournal> {
	await mkdir(join(root, "builder-worktree", "src"), { recursive: true });
	await invoke(root, dependencies, "start");
	const loaded = await dependencies.runJournal.loadActive(root);
	if (loaded.kind !== "loaded") throw new Error("Run did not start");
	return loaded.journal;
}

async function writeBuilderReport(root: string, journal: RunJournal): Promise<void> {
	const task = journal.run.tasks[0]!;
	const attempt = task.attempts[0]!;
	if (attempt.role !== "builder") throw new Error("Builder missing");
	const assignment = JSON.parse(await readFile(attempt.assignmentPath, "utf8")) as { assignment: { actualModel: BuilderAttemptReport["actualModel"]; specificationHash: string; worktree: { path: string } } };
	const artifact = Buffer.from("approved\n");
	const sourcePath = join(builderPathFor(root), "src", "change.ts");
	const evidencePath = join(attempt.evidenceDirectory, "artifact.snapshot");
	const logPath = join(attempt.evidenceDirectory, "check.log");
	await writeFile(sourcePath, artifact);
	await writeFile(evidencePath, artifact);
	const log = Buffer.from("pass\n");
	await writeFile(logPath, log);
	const report: BuilderAttemptReport = { schemaVersion: 1, identity: { runId: journal.run.id, taskId: task.contract.id, attemptId: attempt.id, role: "builder", specificationHash: assignment.assignment.specificationHash, assignmentSha256: builderAssignmentSha256(await readFile(attempt.assignmentPath, "utf8")) }, status: "completed", summary: "Builder completed.", blockers: [], producedArtifacts: [{ kind: "git-commit", baseRevision, headRevision, commits }, { kind: "file", path: "src/change.ts", evidencePath, size: artifact.length, sha256: digest(artifact) }], actualModel: assignment.assignment.actualModel, checks: [{ kind: "command", command: "npm test", exitCode: 0, summary: "pass", logId: "check-1" }], logReferences: [{ id: "check-1", path: logPath, size: log.length, sha256: digest(log) }], producedRevision: headRevision };
	await writeFile(attempt.reportPath, serializeBuilderAttemptReport(report));
}

function builderPathFor(root: string): string { return join(root, "builder-worktree"); }

async function writeReviewerReport(journal: RunJournal): Promise<void> {
	const task = journal.run.tasks[0]!;
	const reviewer = task.attempts.find((attempt) => attempt.role === "reviewer");
	if (!reviewer || reviewer.role !== "reviewer") throw new Error("Reviewer missing");
	const assignment = deserializeReviewerAssignment(await readFile(reviewer.assignmentPath, "utf8"));
	if (!assignment.value) throw new Error("Reviewer assignment invalid");
	await writeFile(reviewer.reportPath, serializeReviewerAttemptReport({ schemaVersion: 1, identity: { runId: journal.run.id, taskId: task.contract.id, attemptId: reviewer.id, role: "reviewer", specificationHash: reviewer.specificationHash, assignmentSha256: digest(Buffer.from(await readFile(reviewer.assignmentPath, "utf8"))) }, status: "completed", summary: "Review completed.", blockers: [], actualModel: reviewer.actualModel, reviewedSubject: assignment.value.assignment.subject, verdict: "approved", findings: [], checks: [], logReferences: [] }));
}

it.sequential("registered status selects the first available independent Reviewer and finalizes an explicit report", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-review-"));
	roots.push(root);
	const dependencies = makeDependencies(root);
	const journal = await startRun(root, dependencies);
	await writeBuilderReport(root, journal);
	const dispatchedView = await invoke(root, dependencies, "status");
	match(dispatchedView?.markdown ?? "", /Reviewer Attempt attempt-02: active/);
	const afterDispatch = await dependencies.runJournal.loadActive(root);
	if (afterDispatch.kind !== "loaded") throw new Error("missing dispatched journal");
	const dispatchedReviewer = afterDispatch.journal.run.tasks[0]!.attempts.find((attempt) => attempt.role === "reviewer");
	if (!dispatchedReviewer || dispatchedReviewer.role !== "reviewer") throw new Error("Reviewer was not dispatched");
	equal(dispatchedReviewer.actualModel.model, "other/reviewer");
	equal(dispatchedReviewer.dispatch.phase, "prompted");
	match(await readFile(dispatchedReviewer.assignmentPath, "utf8"), /"builderManifestSha256"/);
	await writeReviewerReport(afterDispatch.journal);
	const finalizedView = await invoke(root, dependencies, "status");
	match(finalizedView?.markdown ?? "", /Reviewer verdict recorded: approved/);
	const finalized = await dependencies.runJournal.loadActive(root);
	if (finalized.kind !== "loaded") throw new Error("missing finalized journal");
	const reviewer = finalized.journal.run.tasks[0]!.attempts.find((attempt) => attempt.role === "reviewer");
	if (!reviewer || reviewer.role !== "reviewer") throw new Error("Reviewer missing after finalization");
	equal(finalized.journal.run.tasks[0]!.phase, "reviewing");
	equal(reviewer.state, "reported");
	equal(reviewer.evidence?.phase, "finalized");
}, 60_000);

it.sequential("registered status preserves a read-only violation and never accepts the report", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-review-violation-"));
	roots.push(root);
	const dependencies = makeDependencies(root, { snapshots: [{ head: headRevision, dirtyStateFingerprint: fingerprint, dirtyPaths: [], operationMarkers: [] }, { head: headRevision, dirtyStateFingerprint: "sha256:" + "b".repeat(64), dirtyPaths: ["src/change.ts"], operationMarkers: [] }] });
	const journal = await startRun(root, dependencies);
	await writeBuilderReport(root, journal);
	await invoke(root, dependencies, "status");
	const dispatched = await dependencies.runJournal.loadActive(root);
	if (dispatched.kind !== "loaded") throw new Error("missing dispatched journal");
	await writeReviewerReport(dispatched.journal);
	const view = await invoke(root, dependencies, "status");
	match(view?.markdown ?? "", /read-only violation/);
	const violated = await dependencies.runJournal.loadActive(root);
	if (violated.kind !== "loaded") throw new Error("missing violated journal");
	const reviewer = violated.journal.run.tasks[0]!.attempts.find((attempt) => attempt.role === "reviewer");
	if (!reviewer || reviewer.role !== "reviewer") throw new Error("Reviewer missing");
	equal(violated.journal.run.tasks[0]!.attention, "needs-user");
	equal(reviewer.integrity?.kind, "violated");
	equal(reviewer.evidence, undefined);
}, 60_000);

it.sequential("same-family Review pauses durably until exact Controller confirmation", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-review-same-family-"));
	roots.push(root);
	const dependencies = makeDependencies(root, { sameFamilyOnly: true, confirmSameFamily: false });
	const journal = await startRun(root, dependencies);
	await writeBuilderReport(root, journal);
	const pausedView = await invoke(root, dependencies, "status");
	match(pausedView?.markdown ?? "", /Same-provider Reviewer/);
	const paused = await dependencies.runJournal.loadActive(root);
	if (paused.kind !== "loaded") throw new Error("missing paused journal");
	equal(paused.journal.run.tasks[0]!.phase, "reviewing");
	equal(paused.journal.run.tasks[0]!.attention, "needs-user");
	equal(paused.journal.run.tasks[0]!.attempts.length, 1);
	dependencies.ui = { ...dependencies.ui, async confirmSameFamilyReview() { return true; } };
	const resumedView = await invoke(root, dependencies, "status");
	match(resumedView?.markdown ?? "", /Reviewer Attempt attempt-02: active/);
	const resumed = await dependencies.runJournal.loadActive(root);
	if (resumed.kind !== "loaded") throw new Error("missing resumed journal");
	equal(resumed.journal.run.tasks[0]!.attention, "none");
	const reviewer = resumed.journal.run.tasks[0]!.attempts.find((attempt) => attempt.role === "reviewer");
	if (!reviewer || reviewer.role !== "reviewer") throw new Error("same-family Reviewer missing");
	deepStrictEqual(reviewer.independence, { kind: "same-provider-family-approved", provider: "builder", approvedAt: "2026-09-18T00:00:00.000Z", controllerSessionId: "controller-session" });
}, 60_000);

it.sequential("no available Reviewer pauses idempotently and foreign/footer status stays read-only", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-review-authority-"));
	roots.push(root);
	const inspections: string[] = [];
	const confirmations: number[] = [0];
	const dependencies = makeDependencies(root, { noReviewerModels: true, inspectionCalls: inspections, confirmationCalls: confirmations });
	const journal = await startRun(root, dependencies);
	await writeBuilderReport(root, journal);
	const before = await dependencies.runJournal.loadActive(root);
	if (before.kind !== "loaded") throw new Error("missing journal");
	const footer = await createSteward(dependencies).status(root, "footer");
	const afterFooter = await dependencies.runJournal.loadActive(root);
	if (afterFooter.kind !== "loaded") throw new Error("missing footer journal");
	equal(afterFooter.journal.journalRevision, before.journal.journalRevision);
	equal(inspections.length, 0);
	equal(confirmations[0], 0);
	void footer;
	const foreign = await createSteward(dependencies).status(root, "command", "foreign-session");
	const afterForeign = await dependencies.runJournal.loadActive(root);
	if (afterForeign.kind !== "loaded") throw new Error("missing foreign journal");
	equal(afterForeign.journal.journalRevision, before.journal.journalRevision);
	const paused = await invoke(root, dependencies, "status", "controller-session");
	match(paused?.markdown ?? "", /No available Reviewer Model Choice/);
	const pausedJournal = await dependencies.runJournal.loadActive(root);
	if (pausedJournal.kind !== "loaded") throw new Error("missing paused journal");
	equal(pausedJournal.journal.run.tasks[0]!.phase, "reviewing");
	equal(pausedJournal.journal.run.tasks[0]!.attention, "needs-user");
	equal(pausedJournal.journal.run.tasks[0]!.attempts.length, 1);
	const revision = pausedJournal.journal.journalRevision;
	await invoke(root, dependencies, "status", "controller-session");
	const retry = await dependencies.runJournal.loadActive(root);
	if (retry.kind !== "loaded") throw new Error("missing retry journal");
	equal(retry.journal.journalRevision, revision);
}, 60_000);

it.sequential("production Assignment storage preserves an ordered non-Git Review subject", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-review-non-git-"));
	roots.push(root);
	const runJournal = createRunJournalAdapter();
	const task: TaskContract = { id: "task-01", requiredOutcome: "Review retained evidence", allowedScope: ["reports"], expectedArtifacts: [{ kind: "evidence", description: "retained evidence" }], verification: { kind: "criteria", criteria: "Evidence is retained" }, reviewRequired: true };
	const paths = runJournal.resolveAssignmentPaths(root, "run-non-git", task.id, "attempt-02");
	const subject = { kind: "non-git" as const, artifacts: [{ kind: "evidence" as const, identity: "evidence:first", size: 7, sha256: "sha256:" + "1".repeat(64), finalizedPath: join(paths.attemptDirectory, "finalized", "artifacts", "0000") }, { kind: "file" as const, identity: "file:reports/result.md", size: 9, sha256: "sha256:" + "2".repeat(64), finalizedPath: join(paths.attemptDirectory, "finalized", "artifacts", "0001") }], builderManifestSha256: "sha256:" + "3".repeat(64) };
	const attempt: ReviewerAttemptRecord = { id: "attempt-02", role: "reviewer", state: "prepared", preparedAt: "2026-09-18T00:00:00.000Z", actualModel: { model: "other/reviewer", thinkingLevel: "medium" }, specificationHash: specificationHash(task), assignmentPath: paths.assignmentPath, reportPath: paths.reportPath, evidenceDirectory: paths.evidenceDirectory, subject, independence: { kind: "different-provider-family", builderProvider: "builder", reviewerProvider: "other" }, worktree: { path: root, baseline: { head: baseRevision, dirtyStateFingerprint: fingerprint, dirtyPaths: [], operationMarkers: [] } }, dispatch: { phase: "agent-intended", agentName: "steward-r-abcdef12-01-02", worktreePath: root, workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" } as ReviewerAttemptRecord["dispatch"] };
	const assignment = buildReviewerAssignment({ runId: "run-non-git", task, attempt, manifestPath: join(root, "finalized", "manifest.json"), manifestSha256: subject.builderManifestSha256, workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1", agentName: "steward-r-abcdef12-01-02" });
	const created = await runJournal.createAssignment(root, assignment);
	equal(created.kind, "created");
	const bytes = await readFile(paths.assignmentPath, "utf8");
	const decoded = deserializeReviewerAssignment(bytes);
	if (!decoded.value) throw new Error("non-Git Reviewer Assignment did not decode");
	deepStrictEqual(decoded.value.assignment.subject, subject);
	const existing = await runJournal.createAssignment(root, assignment);
	equal(existing.kind, "existing-match");
});
