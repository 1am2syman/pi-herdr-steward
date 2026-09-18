import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { afterEach, it } from "vitest";

import { createRunJournalAdapter } from "../src/adapters.ts";
import { createSteward } from "../src/steward.ts";
import { registerStewardExtension, type StewardCommandContext, type StewardCommandHandler, type StewardRegistrationSurface } from "../src/extension.ts";
import { serializeBuilderAttemptReport, type BuilderAttemptReport } from "../src/attempt-report.ts";
import { buildReviewerAssignment, deserializeReviewerAssignment, reviewerAssignmentSha256, serializeReviewerAssignment, serializeReviewerAttemptReport, type ReviewerAttemptReport } from "../src/review.ts";
import { builderAssignmentSha256, specificationHash, type ReviewerAttemptRecord, type RunDraft, type RunJournal, type TaskContract } from "../src/run.ts";
import type { ModelChoice, ProjectModelPlans, RecoveryDefaults } from "../src/config.ts";
import type { StewardDependencies, StewardUiAdapter, StatusView } from "../src/steward.ts";

const roots: string[] = [];
const baseRevision = "0123456789abcdef0123456789abcdef01234567";
const headRevision = "2222222222222222222222222222222222222222";
const commits = ["1111111111111111111111111111111111111111", headRevision];
const fingerprint = "sha256:" + "a".repeat(64);
const recovery: RecoveryDefaults = { passiveInspectionIntervalSeconds: 301, secondInspectionAndNudgeIntervalSeconds: 302, nudgeGracePeriodSeconds: 121, externalCommandWarningThresholdSeconds: 1801, maximumActiveTasks: 1, transientRetryLimit: 1, reworkCycleLimit: 4 };

afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function digest(bytes: Buffer): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

type ReviewHooks = {
	onPane?: (journal: RunJournal, input: { sourcePaneId: string; worktreePath: string; agentName: string; workspaceId: string }) => Promise<void>;
	onStart?: (journal: RunJournal, input: { name: string; paneId: string; model: ModelChoice }) => Promise<void>;
	onPrompt?: (journal: RunJournal, input: { name: string; assignmentPrompt: string; assignmentBytes: string }) => Promise<void>;
};

function draft(builderPrimaryModel = "builder/builder"): RunDraft {
	const modelPlan: ProjectModelPlans = {
		builder: { primary: { model: builderPrimaryModel, thinkingLevel: "high" }, fallbacks: [] },
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

function makeDependencies(root: string, options: { snapshots?: Array<{ head: string; dirtyStateFingerprint: string; dirtyPaths: string[]; operationMarkers: string[] }>; confirmSameFamily?: boolean; sameFamilyOnly?: boolean; noReviewerModels?: boolean; inspectionCalls?: string[]; confirmationCalls?: number[]; builderPrimaryModel?: string; builderActualModel?: ModelChoice; reviewFailure?: "pane" | "agent" | "prompt"; reviewHooks?: ReviewHooks } = {}): StewardDependencies {
	const productionRunJournal = createRunJournalAdapter();
	let builderActualModelStarted = false;
	const runJournal: StewardDependencies["runJournal"] = {
		...productionRunJournal,
		async replaceActive(repositoryRoot, journal) {
			if (builderActualModelStarted && options.builderActualModel) {
				const builder = journal.run.tasks[0]?.attempts[0];
				if (builder?.role === "builder") builder.actualModel = { ...options.builderActualModel };
			}
			return productionRunJournal.replaceActive(repositoryRoot, journal);
		},
		async createAssignment(repositoryRoot, document) {
			if (builderActualModelStarted && options.builderActualModel && document.assignment.role === "builder") {
				return productionRunJournal.createAssignment(repositoryRoot, { ...document, assignment: { ...document.assignment, actualModel: { ...options.builderActualModel } } });
			}
			return productionRunJournal.createAssignment(repositoryRoot, document);
		},
	};
	let uuid = 0;
	let snapshotIndex = 0;
	const builderPath = join(root, "builder-worktree");
	const snapshots = options.snapshots ?? [{ head: headRevision, dirtyStateFingerprint: fingerprint, dirtyPaths: [], operationMarkers: [] }];
	const ui: StewardUiAdapter = {
		presentStatus() {},
		async editConfiguration() { return { kind: "cancelled" }; },
		presentConfigurationResult() {},
		async draftRun() { return { kind: "drafted" as const, draft: draft(options.builderPrimaryModel) }; },
		async confirmRun() { return true; },
		async confirmSameFamilyReview() { if (options.confirmationCalls) options.confirmationCalls[0] = (options.confirmationCalls[0] ?? 0) + 1; return options.confirmSameFamily ?? false; },
		presentStartResult() {},
	};
	return {
		runJournal,
		herdr: {
			async checkAvailability() { return { kind: "available", status: "running", running: true, compatible: true, endpointCompatible: true }; },
			async createBuilderWorktree(input) { return { kind: "created", branch: input.branch, path: builderPath, workspaceId: "workspace-1", tabId: "tab-1", paneId: "builder-pane", terminalId: "builder-terminal" }; },
			async startBuilder() { const active = await runJournal.loadActive(root); if (active.kind !== "loaded") throw new Error("missing journal"); const attempt = active.journal.run.tasks[0]!.attempts[0]!; builderActualModelStarted = Boolean(options.builderActualModel); return { kind: "started", name: attempt.role === "builder" ? attempt.dispatch.agentName : "builder", agentKind: "pi", workspaceId: "workspace-1", tabId: "tab-1", paneId: "builder-pane", terminalId: "builder-terminal" }; },
			async promptBuilder(input) { return { kind: "prompted", name: input.name, workspaceId: "workspace-1", tabId: "tab-1", paneId: "builder-pane", terminalId: "builder-terminal" }; },
			async createReviewerPane(input) {
				const active = await runJournal.loadActive(root);
				if (active.kind !== "loaded") throw new Error("missing Journal before Reviewer pane split");
				await options.reviewHooks?.onPane?.(active.journal, input);
				if (options.reviewFailure === "pane") return { kind: "failed", stage: "pane-split", code: "pane-split-failed", message: "Reviewer pane split failed" };
				return { kind: "created", workspaceId: input.workspaceId, tabId: "tab-2", paneId: "reviewer-pane", terminalId: "reviewer-terminal", sourcePaneId: input.sourcePaneId, worktreePath: input.worktreePath };
			},
			async startReviewer(input) {
				const active = await runJournal.loadActive(root);
				if (active.kind !== "loaded") throw new Error("missing Journal before Reviewer start");
				await options.reviewHooks?.onStart?.(active.journal, input);
				if (options.reviewFailure === "agent") return { kind: "failed", stage: "agent-start", code: "provider-start-failed", message: "Reviewer provider failed to start" };
				return { kind: "started", name: input.name, agentKind: "pi", workspaceId: "workspace-1", tabId: "tab-2", paneId: "reviewer-pane", terminalId: "reviewer-terminal" };
			},
			async promptReviewer(input) {
				const active = await runJournal.loadActive(root);
				if (active.kind !== "loaded") throw new Error("missing Journal before Reviewer prompt");
				const reviewer = active.journal.run.tasks[0]!.attempts.find((attempt): attempt is ReviewerAttemptRecord => attempt.role === "reviewer");
				if (!reviewer) throw new Error("missing Reviewer before prompt");
				const assignmentBytes = await readFile(reviewer.assignmentPath, "utf8");
				await options.reviewHooks?.onPrompt?.(active.journal, { ...input, assignmentBytes });
				if (options.reviewFailure === "prompt") return { kind: "failed", stage: "agent-prompt", code: "prompt-failed", message: "Reviewer prompt failed" };
				return { kind: "prompted", name: input.name, workspaceId: "workspace-1", tabId: "tab-2", paneId: "reviewer-pane", terminalId: "reviewer-terminal" };
			},
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

async function writeReviewerReport(journal: RunJournal, verdict: ReviewerAttemptReport["verdict"] = "approved"): Promise<void> {
	const task = journal.run.tasks[0]!;
	const reviewer = task.attempts.find((attempt) => attempt.role === "reviewer");
	if (!reviewer || reviewer.role !== "reviewer") throw new Error("Reviewer missing");
	const assignment = deserializeReviewerAssignment(await readFile(reviewer.assignmentPath, "utf8"));
	if (!assignment.value) throw new Error("Reviewer assignment invalid");
	await writeFile(reviewer.reportPath, serializeReviewerAttemptReport({ schemaVersion: 1, identity: { runId: journal.run.id, taskId: task.contract.id, attemptId: reviewer.id, role: "reviewer", specificationHash: reviewer.specificationHash, assignmentSha256: digest(Buffer.from(await readFile(reviewer.assignmentPath, "utf8"))) }, status: "completed", summary: "Review completed.", blockers: [], actualModel: reviewer.actualModel, reviewedSubject: assignment.value.assignment.subject, verdict, findings: verdict === "changes-required" ? [{ id: "finding-1", severity: "major", summary: "The changed behavior needs correction.", detail: "Correct the changed behavior before relying on the result." }] : [], checks: [], logReferences: [] }));
}

function assertReviewerFacts(journal: RunJournal): ReviewerAttemptRecord {
	const task = journal.run.tasks[0]!;
	const reviewer = task.attempts.find((attempt): attempt is ReviewerAttemptRecord => attempt.role === "reviewer");
	if (!reviewer) throw new Error("Reviewer missing at effect hook");
	equal(reviewer.id, "attempt-02");
	equal(reviewer.subject.kind, "git");
	if (reviewer.subject.kind !== "git") throw new Error("Git subject missing at effect hook");
	deepStrictEqual([reviewer.subject.baseRevision, reviewer.subject.headRevision, reviewer.subject.commits], [baseRevision, headRevision, commits]);
	deepStrictEqual(reviewer.worktree.baseline, { head: headRevision, dirtyStateFingerprint: fingerprint, dirtyPaths: [], operationMarkers: [] });
	deepStrictEqual(reviewer.independence, { kind: "different-provider-family", builderProvider: "builder", reviewerProvider: "other" });
	ok(reviewer.assignmentPath.endsWith("/assignment.json"));
	ok(reviewer.reportPath.endsWith("/report.md"));
	ok(reviewer.evidenceDirectory.endsWith("/evidence"));
	return reviewer;
}

function throwOnNonDispatchReads(dependencies: StewardDependencies, calls: string[]): void {
	dependencies.process = new Proxy({}, { get(_target, property) { calls.push(`process.${String(property)}`); throw new Error("process lifecycle must not be consulted"); } });
	const reviewerDispatchProperties = new Set(["createReviewerPane", "startReviewer", "promptReviewer"]);
	dependencies.herdr = new Proxy(dependencies.herdr, {
		get(target, property, receiver) {
			if (typeof property === "string" && !reviewerDispatchProperties.has(property)) {
				calls.push(`herdr.${property}`);
				throw new Error("Herdr lifecycle must not be consulted");
			}
			return Reflect.get(target, property, receiver);
		},
	}) as StewardDependencies["herdr"];
}

it.sequential("registered status selects the first available independent Reviewer and finalizes an explicit report", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-review-"));
	roots.push(root);
	const inspections: string[] = [];
	let promptText = "";
	const dependencies = makeDependencies(root, {
		builderPrimaryModel: "planned/builder",
		builderActualModel: { model: "builder/fallback", thinkingLevel: "medium" },
		inspectionCalls: inspections,
		reviewHooks: {
			async onPane(journal, input) {
				const task = journal.run.tasks[0]!;
				const reviewer = assertReviewerFacts(journal);
				equal(task.phase, "reviewing");
				equal(reviewer.state, "prepared");
				equal(reviewer.dispatch.phase, "pane-intended");
				equal(reviewer.dispatch.sourcePaneId, input.sourcePaneId);
				equal(reviewer.dispatch.worktreePath, input.worktreePath);
			},
			async onStart(journal, input) {
				const reviewer = assertReviewerFacts(journal);
				equal(reviewer.state, "prepared");
				equal(reviewer.dispatch.phase, "agent-intended");
				equal(reviewer.dispatch.workspaceId, "workspace-1");
				equal(reviewer.dispatch.paneId, input.paneId);
				equal(reviewer.actualModel.model, "other/reviewer");
			},
			async onPrompt(journal, input) {
				const reviewer = assertReviewerFacts(journal);
				equal(reviewer.state, "prepared");
				equal(reviewer.dispatch.phase, "prompt-intended");
				if (reviewer.dispatch.phase !== "prompt-intended") throw new Error("Reviewer prompt intent missing");
				const decoded = deserializeReviewerAssignment(input.assignmentBytes);
				if (!decoded.value) throw new Error("Reviewer Assignment did not decode at prompt hook");
				equal(serializeReviewerAssignment(decoded.value), input.assignmentBytes);
				equal(reviewer.dispatch.assignmentSha256, reviewerAssignmentSha256(input.assignmentBytes));
				equal(decoded.value.assignment.attemptId, "attempt-02");
				equal(decoded.value.assignment.subject.kind, "git");
				if (decoded.value.assignment.subject.kind !== "git") throw new Error("Assignment Git subject missing");
				deepStrictEqual([decoded.value.assignment.subject.baseRevision, decoded.value.assignment.subject.headRevision, decoded.value.assignment.subject.commits], [baseRevision, headRevision, commits]);
				deepStrictEqual(decoded.value.assignment.worktree.baseline, reviewer.worktree.baseline);
				promptText = input.assignmentPrompt;
			},
		},
	});
	const journal = await startRun(root, dependencies);
	equal(journal.run.modelPlan.builder.primary.model, "planned/builder");
	equal(journal.run.tasks[0]!.attempts[0]!.role, "builder");
	equal(journal.run.tasks[0]!.attempts[0]!.actualModel.model, "builder/fallback");
	await writeBuilderReport(root, journal);
	const dispatchedView = await invoke(root, dependencies, "status");
	match(dispatchedView?.markdown ?? "", /Reviewer Attempt attempt-02: active/);
	const afterDispatch = await dependencies.runJournal.loadActive(root);
	if (afterDispatch.kind !== "loaded") throw new Error("missing dispatched journal");
	const dispatchedReviewer = afterDispatch.journal.run.tasks[0]!.attempts.find((attempt) => attempt.role === "reviewer");
	if (!dispatchedReviewer || dispatchedReviewer.role !== "reviewer") throw new Error("Reviewer was not dispatched");
	deepStrictEqual(inspections, ["builder/reviewer", "other/unavailable", "other/reviewer"]);
	equal(dispatchedReviewer.actualModel.model, "other/reviewer");
	equal(dispatchedReviewer.dispatch.phase, "prompted");
	deepStrictEqual(dispatchedReviewer.independence, { kind: "different-provider-family", builderProvider: "builder", reviewerProvider: "other" });
	match(await readFile(dispatchedReviewer.assignmentPath, "utf8"), /"builderManifestSha256"/);
	match(promptText, /Treat the worktree as read-only: do not edit, commit, reset, stash, clean, revert, or delete files\./);
	match(promptText, new RegExp(`Write the Reviewer Attempt Report to ${dispatchedReviewer.reportPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
	match(promptText, /verdict approved or changes-required only/);
	match(promptText, /lifecycle state is not a verdict/);
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

it.sequential.each([
	{ label: "dirty fingerprint", changed: { head: headRevision, dirtyStateFingerprint: "sha256:" + "b".repeat(64), dirtyPaths: ["src/change.ts"], operationMarkers: [] } },
	{ label: "changed HEAD", changed: { head: "3333333333333333333333333333333333333333", dirtyStateFingerprint: fingerprint, dirtyPaths: [], operationMarkers: [] } },
])("registered status preserves a $label read-only violation and never accepts the report", async ({ changed }) => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-review-violation-"));
	roots.push(root);
	const baseline = { head: headRevision, dirtyStateFingerprint: fingerprint, dirtyPaths: [], operationMarkers: [] };
	const dependencies = makeDependencies(root, { snapshots: [baseline, changed] });
	const journal = await startRun(root, dependencies);
	await writeBuilderReport(root, journal);
	await invoke(root, dependencies, "status");
	const dispatched = await dependencies.runJournal.loadActive(root);
	if (dispatched.kind !== "loaded") throw new Error("missing dispatched journal");
	const dispatchedReviewer = dispatched.journal.run.tasks[0]!.attempts.find((attempt): attempt is ReviewerAttemptRecord => attempt.role === "reviewer");
	if (!dispatchedReviewer) throw new Error("Reviewer missing before violation");
	await writeReviewerReport(dispatched.journal);
	const acceptedReportBytes = await readFile(dispatchedReviewer.reportPath, "utf8");
	const sourcePath = join(builderPathFor(root), "src", "change.ts");
	const sourceBytes = await readFile(sourcePath, "utf8");
	const view = await invoke(root, dependencies, "status");
	match(view?.markdown ?? "", /read-only violation/);
	const violated = await dependencies.runJournal.loadActive(root);
	if (violated.kind !== "loaded") throw new Error("missing violated journal");
	const reviewer = violated.journal.run.tasks[0]!.attempts.find((attempt) => attempt.role === "reviewer");
	if (!reviewer || reviewer.role !== "reviewer") throw new Error("Reviewer missing");
	const task = violated.journal.run.tasks[0]!;
	equal(task.phase, "reviewing");
	equal(violated.journal.run.tasks[0]!.attention, "needs-user");
	equal(reviewer.state, "active");
	equal(reviewer.dispatch.phase, "prompted");
	equal(reviewer.integrity?.kind, "violated");
	deepStrictEqual(reviewer.integrity?.before, baseline);
	deepStrictEqual(reviewer.integrity?.after, changed);
	equal(reviewer.evidence, undefined);
	equal(await readFile(dispatchedReviewer.reportPath, "utf8"), acceptedReportBytes);
	equal(await readFile(sourcePath, "utf8"), sourceBytes);
}, 60_000);

it.sequential.each([
	{ verdict: "approved" as const, hasFinding: false },
	{ verdict: "changes-required" as const, hasFinding: true },
])("registered status finalizes $verdict while Task stays reviewing", async ({ verdict, hasFinding }) => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-review-changes-required-"));
	roots.push(root);
	const dependencies = makeDependencies(root);
	const journal = await startRun(root, dependencies);
	await writeBuilderReport(root, journal);
	await invoke(root, dependencies, "status");
	const dispatched = await dependencies.runJournal.loadActive(root);
	if (dispatched.kind !== "loaded") throw new Error("missing dispatched journal");
	await writeReviewerReport(dispatched.journal, verdict);
	const view = await invoke(root, dependencies, "status");
	match(view?.markdown ?? "", /Reviewer evidence finalized/);
	const finalized = await dependencies.runJournal.loadActive(root);
	if (finalized.kind !== "loaded") throw new Error("missing finalized journal");
	const task = finalized.journal.run.tasks[0]!;
	const reviewer = task.attempts.find((attempt): attempt is ReviewerAttemptRecord => attempt.role === "reviewer");
	if (!reviewer || reviewer.role !== "reviewer") throw new Error("Reviewer missing after changes-required finalization");
	equal(task.phase, "reviewing");
	equal(task.attention, "none");
	equal(reviewer.state, "reported");
	equal(reviewer.evidence?.phase, "finalized");
	if (!reviewer.evidence || reviewer.evidence.phase !== "finalized") throw new Error("Reviewer evidence was not finalized");
	equal(reviewer.evidence.verdict, verdict);
	const manifest = JSON.parse(await readFile(reviewer.evidence.manifestPath, "utf8")) as { verdict: string; findings: unknown[] };
	equal(manifest.verdict, verdict);
	equal(manifest.findings.length > 0, hasFinding);
}, 60_000);

it.sequential("registered status invalidates a finalized Reviewer verdict after a later worktree change and remains idempotent", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-review-late-violation-"));
	roots.push(root);
	const changed = { head: headRevision, dirtyStateFingerprint: "sha256:" + "c".repeat(64), dirtyPaths: ["src/late-change.ts"], operationMarkers: [] };
	const baseline = { head: headRevision, dirtyStateFingerprint: fingerprint, dirtyPaths: [], operationMarkers: [] };
	const dependencies = makeDependencies(root, { snapshots: [baseline, baseline, baseline, changed] });
	const journal = await startRun(root, dependencies);
	await writeBuilderReport(root, journal);
	await invoke(root, dependencies, "status");
	const dispatched = await dependencies.runJournal.loadActive(root);
	if (dispatched.kind !== "loaded") throw new Error("missing dispatched journal");
	await writeReviewerReport(dispatched.journal, "approved");
	await invoke(root, dependencies, "status");
	const accepted = await dependencies.runJournal.loadActive(root);
	if (accepted.kind !== "loaded") throw new Error("missing accepted journal");
	const acceptedReviewer = accepted.journal.run.tasks[0]!.attempts.find((attempt): attempt is ReviewerAttemptRecord => attempt.role === "reviewer");
	if (!acceptedReviewer || acceptedReviewer.role !== "reviewer" || !acceptedReviewer.evidence || acceptedReviewer.evidence.phase !== "finalized") throw new Error("Reviewer was not finalized");
	const evidenceBefore = JSON.parse(JSON.stringify(acceptedReviewer.evidence)) as typeof acceptedReviewer.evidence;
	const manifestPath = acceptedReviewer.evidence.manifestPath;
	const finalizedDirectory = dirname(manifestPath);
	const finalizedReportPath = join(finalizedDirectory, "report.md");
	const manifestBytes = await readFile(manifestPath);
	const finalizedReportBytes = await readFile(finalizedReportPath);
	const lateView = await invoke(root, dependencies, "status");
	match(lateView?.markdown ?? "", /no verdict was accepted|no verdict is eligible/);
	const violated = await dependencies.runJournal.loadActive(root);
	if (violated.kind !== "loaded") throw new Error("missing violated journal");
	const task = violated.journal.run.tasks[0]!;
	const reviewer = task.attempts.find((attempt): attempt is ReviewerAttemptRecord => attempt.role === "reviewer");
	if (!reviewer || reviewer.role !== "reviewer") throw new Error("Reviewer missing after late violation");
	equal(task.phase, "reviewing");
	equal(task.attention, "needs-user");
	equal(reviewer.state, "reported");
	equal(reviewer.integrity?.kind, "violated");
	deepStrictEqual(reviewer.evidence, evidenceBefore);
	equal(reviewer.evidence?.manifestPath, manifestPath);
	equal(dirname(reviewer.evidence?.manifestPath ?? ""), finalizedDirectory);
	deepStrictEqual(await readFile(manifestPath), manifestBytes);
	deepStrictEqual(await readFile(finalizedReportPath), finalizedReportBytes);
	const revision = violated.journal.journalRevision;
	const repeatedView = await invoke(root, dependencies, "status");
	match(repeatedView?.markdown ?? "", /no verdict was accepted|no verdict is eligible/);
	const repeated = await dependencies.runJournal.loadActive(root);
	if (repeated.kind !== "loaded") throw new Error("missing repeated violated journal");
	equal(repeated.journal.journalRevision, revision);
	const repeatedReviewer = repeated.journal.run.tasks[0]!.attempts.find((attempt): attempt is ReviewerAttemptRecord => attempt.role === "reviewer");
	if (!repeatedReviewer || repeatedReviewer.role !== "reviewer") throw new Error("Reviewer missing after repeated status");
	deepStrictEqual(repeatedReviewer.evidence, evidenceBefore);
}, 60_000);

it.sequential("registered status retains the last durable Reviewer phase for every non-verdict failure", async () => {
	type FailureCase = { name: string; failure?: "pane" | "agent" | "prompt"; phase: "pane-intended" | "agent-intended" | "prompt-intended" | "prompted"; state: "prepared" | "active"; report: "missing" | "malformed" | "none" };
	const lifecycleStates = ["process exit", "silence", "idle", "done", "blocked", "unknown", "disappearance"];
	const cases: FailureCase[] = [
		{ name: "pane split failure", failure: "pane", phase: "pane-intended", state: "prepared", report: "none" },
		{ name: "agent-start provider failure", failure: "agent", phase: "agent-intended", state: "prepared", report: "none" },
		{ name: "prompt failure", failure: "prompt", phase: "prompt-intended", state: "prepared", report: "none" },
		...lifecycleStates.map((state) => ({ name: `missing report after active Attempt (${state})`, phase: "prompted" as const, state: "active" as const, report: "missing" as const })),
		{ name: "malformed report", phase: "prompted", state: "active", report: "malformed" },
	];
	for (const testCase of cases) {
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-review-failure-"));
		roots.push(root);
		const dependencies = makeDependencies(root, { reviewFailure: testCase.failure });
		const journal = await startRun(root, dependencies);
		await writeBuilderReport(root, journal);
		const forbiddenReads: string[] = [];
		throwOnNonDispatchReads(dependencies, forbiddenReads);
		let view = await invoke(root, dependencies, "status");
		if (testCase.report === "missing" || testCase.report === "malformed") {
			const dispatched = await dependencies.runJournal.loadActive(root);
			if (dispatched.kind !== "loaded") throw new Error(`${testCase.name}: missing dispatched Journal`);
			if (testCase.report === "malformed") {
				const reviewer = dispatched.journal.run.tasks[0]!.attempts.find((attempt): attempt is ReviewerAttemptRecord => attempt.role === "reviewer");
				if (!reviewer) throw new Error(`${testCase.name}: missing Reviewer`);
				await writeFile(reviewer.reportPath, "---\n{\"malformed\":true}\n---\n");
			}
			view = await invoke(root, dependencies, "status");
			if (testCase.report === "missing") match(view?.markdown ?? "", /Herdr lifecycle is not a verdict/);
		}
		const loaded = await dependencies.runJournal.loadActive(root);
		if (loaded.kind !== "loaded") throw new Error(`${testCase.name}: missing final Journal`);
		const task = loaded.journal.run.tasks[0]!;
		const reviewer = task.attempts.find((attempt): attempt is ReviewerAttemptRecord => attempt.role === "reviewer");
		if (!reviewer) throw new Error(`${testCase.name}: Reviewer Attempt was not durable`);
		equal(task.phase, "reviewing");
		equal(reviewer.dispatch.phase, testCase.phase);
		equal(reviewer.state, testCase.state);
		equal(reviewer.evidence, undefined);
		ok(!((view?.markdown ?? "").includes("Reviewer verdict recorded")));
		equal(forbiddenReads.length, 0, `${testCase.name} consulted process or non-dispatch Herdr lifecycle`);
	}
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
}, 60_000);
