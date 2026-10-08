import { removeFixture } from "./remove-fixture.ts";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { afterEach, it } from "vitest";

import { createRunJournalAdapter } from "../src/adapters.ts";
import { createSteward } from "../src/steward.ts";
import { registerStewardExtension, type StewardCommandContext, type StewardCommandHandler, type StewardRegistrationSurface } from "../src/extension.ts";
import { serializeBuilderAttemptReport, type BuilderAttemptReport } from "../src/attempt-report.ts";
import { buildReviewerAssignment, deserializeReviewerAssignment, reviewerAssignmentSha256, serializeReviewerAssignment, serializeReviewerAttemptReport, type ReviewerAttemptReport } from "../src/review.ts";
import { advanceRunJournal, builderAssignmentSha256, specificationHash, type ReviewerAttemptRecord, type RunDraft, type RunJournal, type TaskContract } from "../src/run.ts";
import type { ModelChoice, ProjectModelPlans, RecoveryDefaults } from "../src/config.ts";
import type { StewardDependencies, StewardUiAdapter, StatusView } from "../src/steward.ts";

const roots: string[] = [];
const baseRevision = "0123456789abcdef0123456789abcdef01234567";
const headRevision = "2222222222222222222222222222222222222222";
const commits = ["1111111111111111111111111111111111111111", headRevision];
const fingerprint = "sha256:" + "a".repeat(64);
const recovery: RecoveryDefaults = { passiveInspectionIntervalSeconds: 301, secondInspectionAndNudgeIntervalSeconds: 302, nudgeGracePeriodSeconds: 121, externalCommandWarningThresholdSeconds: 1801, maximumActiveTasks: 1, transientRetryLimit: 1, reworkCycleLimit: 4 };

afterEach(async () => { for (const root of roots.splice(0)) await removeFixture(root); });

function digest(bytes: Buffer): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

type ReviewHooks = {
	onPane?: (journal: RunJournal, input: { sourcePaneId: string; worktreePath: string; agentName: string; workspaceId: string }) => Promise<void>;
	onStart?: (journal: RunJournal, input: { name: string; paneId: string; model: ModelChoice }) => Promise<void>;
	onPrompt?: (journal: RunJournal, input: { name: string; assignmentPrompt: string; assignmentBytes: string }) => Promise<void>;
	onBuilderPrompt?: (journal: RunJournal, input: { name: string; assignmentPrompt: string }) => Promise<void>;
};

type Snapshot = { head: string; dirtyStateFingerprint: string; dirtyPaths: string[]; operationMarkers: string[] };
type EffectCounts = { builderPrompts: number; reviewerPanes: number; reviewerStarts: number; reviewerPrompts: number };

function draft(builderPrimaryModel = "builder/builder", reworkCycleLimit = recovery.reworkCycleLimit): RunDraft {
	const modelPlan: ProjectModelPlans = {
		builder: { primary: { model: builderPrimaryModel, thinkingLevel: "high" }, fallbacks: [] },
		reviewer: { primary: { model: "builder/reviewer", thinkingLevel: "high" }, fallbacks: [{ model: "other/unavailable", thinkingLevel: "medium" }, { model: "other/reviewer", thinkingLevel: "medium" }] },
	};
	return { declaredOutcome: "Build and independently review", tasks: [{ requiredOutcome: "Implement the change", allowedScope: ["src"], expectedArtifacts: [{ kind: "git-commit" }, { kind: "file", path: "src/change.ts" }], verification: { kind: "command", command: "npm test" }, reviewRequired: true }], modelPlan, effectiveSettings: { ...recovery, reworkCycleLimit }, finalVerification: { kind: "command", command: "npm test" } };
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

async function resumeOnce(root: string, dependencies: StewardDependencies, sessionId = "controller-session"): Promise<void> {
	const registered = capture();
	registerStewardExtension(registered.surface, () => dependencies);
	await registered.handler()("resume", context(root, sessionId));
}

function makeDependencies(root: string, options: { snapshots?: Snapshot[]; snapshotState?: { value: Snapshot }; confirmSameFamily?: boolean; sameFamilyOnly?: boolean; noReviewerModels?: boolean; inspectionCalls?: string[]; confirmationCalls?: number[]; builderPrimaryModel?: string; builderActualModel?: ModelChoice; reworkCycleLimit?: number; reviewFailure?: "pane" | "agent" | "prompt"; builderPreflight?: (expectedRevision: string) => { kind: "unavailable"; message: string } | { kind: "ready"; head: string; clean: true }; failReworkAssignment?: boolean; failReworkBuilderPrompt?: "throw" | "malformed"; failRepairPrompt?: "throw" | "malformed"; failJournalReplace?: "rework-reservation" | "rework-prompt-intent" | "repair-intent"; effectCounts?: EffectCounts; reviewHooks?: ReviewHooks } = {}): StewardDependencies {
	const productionRunJournal = createRunJournalAdapter();
	let builderActualModelStarted = false;
	const runJournal: StewardDependencies["runJournal"] = {
		...productionRunJournal,
		async replaceActive(repositoryRoot, journal) {
			const latest = journal.run.tasks[0]?.attempts.at(-1);
			const shouldFail = options.failJournalReplace === "rework-reservation" && latest?.role === "builder" && latest.dispatch.phase === "assignment-intended"
				|| options.failJournalReplace === "rework-prompt-intent" && journal.run.tasks[0]?.attempts.length === 3 && latest?.role === "builder" && latest.dispatch.phase === "prompt-intended"
				|| options.failJournalReplace === "repair-intent" && latest?.role === "reviewer" && latest.reportRepair?.phase === "request-intended";
			if (shouldFail) throw new Error("injected journal replacement failure");
			if (builderActualModelStarted && options.builderActualModel) {
				const builder = journal.run.tasks[0]?.attempts[0];
				if (builder?.role === "builder") builder.actualModel = { ...options.builderActualModel };
			}
			return productionRunJournal.replaceActive(repositoryRoot, journal);
		},
		async createAssignment(repositoryRoot, document) {
			if (options.failReworkAssignment && document.assignment.role === "builder" && document.assignment.attemptId !== "attempt-01") return { kind: "storage-error", paths: productionRunJournal.resolveAssignmentPaths(repositoryRoot, document.assignment.runId, document.assignment.taskId, document.assignment.attemptId), diagnostics: [] };
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
		async draftRun() { return { kind: "drafted" as const, draft: draft(options.builderPrimaryModel, options.reworkCycleLimit ?? recovery.reworkCycleLimit) }; },
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
			async promptBuilder(input) { const active = await runJournal.loadActive(root); if (active.kind !== "loaded") throw new Error("missing journal before Builder prompt"); if (options.effectCounts) options.effectCounts.builderPrompts += 1; await options.reviewHooks?.onBuilderPrompt?.(active.journal, input); if (active.journal.run.tasks[0]?.attempts.length > 1 && options.failReworkBuilderPrompt === "throw") throw new Error("ambiguous Builder prompt acknowledgment"); if (active.journal.run.tasks[0]?.attempts.length > 1 && options.failReworkBuilderPrompt === "malformed") return { kind: "failed", stage: "agent-prompt", code: "ambiguous-ack", message: "ambiguous Builder prompt acknowledgment" }; return { kind: "prompted", name: input.name, workspaceId: "workspace-1", tabId: "tab-1", paneId: "builder-pane", terminalId: "builder-terminal" }; },
			async createReviewerPane(input) {
				const active = await runJournal.loadActive(root);
				if (active.kind !== "loaded") throw new Error("missing Journal before Reviewer pane split");
				if (options.effectCounts) options.effectCounts.reviewerPanes += 1;
				await options.reviewHooks?.onPane?.(active.journal, input);
				if (options.reviewFailure === "pane") return { kind: "failed", stage: "pane-split", code: "pane-split-failed", message: "Reviewer pane split failed" };
				return { kind: "created", workspaceId: input.workspaceId, tabId: "tab-2", paneId: "reviewer-pane", terminalId: "reviewer-terminal", sourcePaneId: input.sourcePaneId, worktreePath: input.worktreePath };
			},
			async startReviewer(input) {
				const active = await runJournal.loadActive(root);
				if (active.kind !== "loaded") throw new Error("missing Journal before Reviewer start");
				if (options.effectCounts) options.effectCounts.reviewerStarts += 1;
				await options.reviewHooks?.onStart?.(active.journal, input);
				if (options.reviewFailure === "agent") return { kind: "failed", stage: "agent-start", code: "provider-start-failed", message: "Reviewer provider failed to start" };
				return { kind: "started", name: input.name, agentKind: "pi", workspaceId: "workspace-1", tabId: "tab-2", paneId: "reviewer-pane", terminalId: "reviewer-terminal" };
			},
			async promptReviewer(input) {
				const active = await runJournal.loadActive(root);
				if (active.kind !== "loaded") throw new Error("missing Journal before Reviewer prompt");
				const reviewer = [...active.journal.run.tasks[0]!.attempts].reverse().find((attempt): attempt is ReviewerAttemptRecord => attempt.role === "reviewer");
				if (!reviewer) throw new Error("missing Reviewer before prompt");
				const assignmentBytes = await readFile(reviewer.assignmentPath, "utf8");
				if (options.effectCounts) options.effectCounts.reviewerPrompts += 1;
				await options.reviewHooks?.onPrompt?.(active.journal, { ...input, assignmentBytes });
				if (input.assignmentPrompt.startsWith("Steward Reviewer report repair") && options.failRepairPrompt === "throw") throw new Error("ambiguous Reviewer repair acknowledgment");
				if (input.assignmentPrompt.startsWith("Steward Reviewer report repair") && options.failRepairPrompt === "malformed") return { kind: "failed", stage: "agent-prompt", code: "ambiguous-ack", message: "ambiguous Reviewer repair acknowledgment" };
				if (options.reviewFailure === "prompt") return { kind: "failed", stage: "agent-prompt", code: "prompt-failed", message: "Reviewer prompt failed" };
				return { kind: "prompted", name: input.name, workspaceId: "workspace-1", tabId: "tab-2", paneId: "reviewer-pane", terminalId: "reviewer-terminal" };
			},
		},
		git: {
			async inspectIntegrationBase() { return { kind: "ready", branch: "main", revision: baseRevision }; },
			async branchExists() { return false; },
			async inspectBuilderWorktree(_path, expectedRevision) { return options.builderPreflight?.(expectedRevision) ?? { kind: "ready", head: expectedRevision, clean: true }; },
			async inspectProducedCodeArtifact(input) { return { kind: "inspected", base: baseRevision, head: input.producedHead, commits: [commits[0]!, input.producedHead], changedPaths: [{ status: "M", paths: ["src/change.ts"] }], clean: true }; },
			async inspectReviewWorktree() { const value = options.snapshotState?.value ?? snapshots[Math.min(snapshotIndex++, snapshots.length - 1)]!; return { ...value, dirtyPaths: [...value.dirtyPaths], operationMarkers: [...value.operationMarkers] }; },
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

async function writeBuilderReport(root: string, journal: RunJournal, producedRevision = headRevision): Promise<void> {
	const task = journal.run.tasks[0]!;
	const attempt = [...task.attempts].reverse().find((candidate) => candidate.role === "builder");
	if (!attempt || attempt.role !== "builder") throw new Error("Builder missing");
	const assignment = JSON.parse(await readFile(attempt.assignmentPath, "utf8")) as { assignment: { actualModel: BuilderAttemptReport["actualModel"]; specificationHash: string; worktree: { path: string } } };
	const artifact = Buffer.from(`${attempt.id}: approved\n`);
	const sourcePath = join(builderPathFor(root), "src", "change.ts");
	const evidencePath = join(attempt.evidenceDirectory, "artifact.snapshot");
	const logPath = join(attempt.evidenceDirectory, "check.log");
	await writeFile(sourcePath, artifact);
	await writeFile(evidencePath, artifact);
	const log = Buffer.from("pass\n");
	await writeFile(logPath, log);
	const report: BuilderAttemptReport = { schemaVersion: 1, identity: { runId: journal.run.id, taskId: task.contract.id, attemptId: attempt.id, role: "builder", specificationHash: assignment.assignment.specificationHash, assignmentSha256: builderAssignmentSha256(await readFile(attempt.assignmentPath, "utf8")) }, status: "completed", summary: `Builder ${attempt.id} completed.`, blockers: [], producedArtifacts: [{ kind: "git-commit", baseRevision, headRevision: producedRevision, commits: [commits[0]!, producedRevision] }, { kind: "file", path: "src/change.ts", evidencePath, size: artifact.length, sha256: digest(artifact) }], actualModel: assignment.assignment.actualModel, checks: [{ kind: "command", command: "npm test", exitCode: 0, summary: "pass", logId: "check-1" }], logReferences: [{ id: "check-1", path: logPath, size: log.length, sha256: digest(log) }], producedRevision };
	await writeFile(attempt.reportPath, serializeBuilderAttemptReport(report));
}

function builderPathFor(root: string): string { return join(root, "builder-worktree"); }

async function writeReviewerReport(journal: RunJournal, verdict: ReviewerAttemptReport["verdict"] = "approved", logReferences: ReviewerAttemptReport["logReferences"] = []): Promise<void> {
	const task = journal.run.tasks[0]!;
	const reviewer = [...task.attempts].reverse().find((attempt) => attempt.role === "reviewer");
	if (!reviewer || reviewer.role !== "reviewer") throw new Error(`Reviewer missing (${task.phase}; ${task.attempts.map((attempt) => `${attempt.id}:${attempt.role}:${attempt.state}`).join(",")})`);
	const assignment = deserializeReviewerAssignment(await readFile(reviewer.assignmentPath, "utf8"));
	if (!assignment.value) throw new Error("Reviewer assignment invalid");
	await writeFile(reviewer.reportPath, serializeReviewerAttemptReport({ schemaVersion: 1, identity: { runId: journal.run.id, taskId: task.contract.id, attemptId: reviewer.id, role: "reviewer", specificationHash: reviewer.specificationHash, assignmentSha256: digest(Buffer.from(await readFile(reviewer.assignmentPath, "utf8"))) }, status: "completed", summary: "Review completed.", blockers: [], actualModel: reviewer.actualModel, reviewedSubject: assignment.value.assignment.subject, verdict, findings: verdict === "changes-required" ? [{ id: "finding-1", severity: "major", summary: "The changed behavior needs correction.", detail: "Correct the changed behavior before relying on the result." }] : [], checks: logReferences.map((log) => ({ kind: "command" as const, command: "npm test", exitCode: 0, summary: "pass", logId: log.id })), logReferences }));
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
	match(finalizedView?.markdown ?? "", /Approval: valid/);
	const finalized = await dependencies.runJournal.loadActive(root);
	if (finalized.kind !== "loaded") throw new Error("missing finalized journal");
	const reviewer = finalized.journal.run.tasks[0]!.attempts.find((attempt) => attempt.role === "reviewer");
	if (!reviewer || reviewer.role !== "reviewer") throw new Error("Reviewer missing after finalization");
	equal(finalized.journal.run.tasks[0]!.phase, "approved");
	equal(finalized.journal.run.tasks[0]!.approval?.phase, "valid");
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

it.sequential("ticket-10 sends changes-required rework to the same reconciled-active Builder without resending the original prompt", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-review-reconciled-rework-"));
	roots.push(root);
	const effects: EffectCounts = { builderPrompts: 0, reviewerPanes: 0, reviewerStarts: 0, reviewerPrompts: 0 };
	const dependencies = makeDependencies(root, { effectCounts: effects });
	const started = await startRun(root, dependencies);
	await writeBuilderReport(root, started);
	await invoke(root, dependencies, "status");
	const reviewerDispatch = await dependencies.runJournal.loadActive(root);
	if (reviewerDispatch.kind !== "loaded") throw new Error("missing Reviewer dispatch");
	const reconciled = advanceRunJournal(reviewerDispatch.journal, new Date("2026-09-18T00:00:01.000Z"), (next) => {
		const builder = next.run.tasks[0]?.attempts[0];
		if (!builder || builder.role !== "builder" || builder.dispatch.phase !== "prompted") throw new Error("missing prompted original Builder");
		const dispatch = builder.dispatch;
		builder.dispatch = { phase: "reconciled-active", branch: dispatch.branch, agentName: dispatch.agentName, worktreePath: dispatch.worktreePath, workspaceId: dispatch.workspaceId, paneId: dispatch.paneId, terminalId: dispatch.terminalId, assignmentSha256: dispatch.assignmentSha256, reconciledAt: "2026-09-18T00:00:01.000Z", basis: "matching-live-agent" };
		builder.activatedAt = "2026-09-18T00:00:01.000Z";
	});
	const replaced = await dependencies.runJournal.replaceActive(root, reconciled);
	if (replaced.kind !== "replaced") throw new Error("failed to persist reconciled Builder");
	await writeReviewerReport(reconciled, "changes-required");
	const view = await invoke(root, dependencies, "status");
	match(view?.markdown ?? "", /Rework cycle 1 reserved and prompted/);
	const after = await dependencies.runJournal.loadActive(root);
	if (after.kind !== "loaded") throw new Error("missing rework journal");
	const task = after.journal.run.tasks[0]!;
	const original = task.attempts[0]!;
	const rework = task.attempts[2]!;
	if (original.role !== "builder" || rework.role !== "builder") throw new Error("Builder attempts missing after rework");
	if (!("workspaceId" in original.dispatch) || !("paneId" in original.dispatch) || !("workspaceId" in rework.dispatch) || !("paneId" in rework.dispatch)) throw new Error("Builder dispatch identity missing after rework");
	equal(task.phase, "reworking");
	equal(task.attention, "none");
	equal(task.reworkCycles, 1);
	equal(rework.state, "active");
	equal(rework.dispatch.phase, "prompted");
	equal(rework.dispatch.agentName, original.dispatch.agentName);
	equal(rework.dispatch.workspaceId, original.dispatch.workspaceId);
	equal(rework.dispatch.paneId, original.dispatch.paneId);
	equal(effects.builderPrompts, 2);
	const assignment = JSON.parse(await readFile(rework.assignmentPath, "utf8")) as { assignment: { rework?: { priorBuilderAttemptId: string; priorReviewerAttemptId: string } } };
	equal(assignment.assignment.rework?.priorBuilderAttemptId, "attempt-01");
	equal(assignment.assignment.rework?.priorReviewerAttemptId, "attempt-02");
}, 60_000);

it.sequential("ticket-10 validates a prepared Builder report by promoting first, then finalizing evidence", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-review-prepared-builder-report-"));
	roots.push(root);
	const effects: EffectCounts = { builderPrompts: 0, reviewerPanes: 0, reviewerStarts: 0, reviewerPrompts: 0 };
	const dependencies = makeDependencies(root, { effectCounts: effects });
	const started = await startRun(root, dependencies);
	const prepared = advanceRunJournal(started, new Date("2026-09-18T00:00:01.000Z"), (next) => {
		const builder = next.run.tasks[0]?.attempts[0];
		if (!builder || builder.role !== "builder" || builder.dispatch.phase !== "prompted") throw new Error("missing prompted Builder");
		const dispatch = builder.dispatch;
		builder.state = "prepared";
		delete builder.activatedAt;
		builder.dispatch = { phase: "prompt-intended", branch: dispatch.branch, agentName: dispatch.agentName, worktreePath: dispatch.worktreePath, workspaceId: dispatch.workspaceId, paneId: dispatch.paneId, terminalId: dispatch.terminalId, assignmentSha256: dispatch.assignmentSha256 };
	});
	const preparedWrite = await dependencies.runJournal.replaceActive(root, prepared);
	if (preparedWrite.kind !== "replaced") throw new Error("prepared Builder Journal was not persisted");
	await writeBuilderReport(root, prepared);
	let liveInspections = 0;
	dependencies.herdr.inspectManagedAgent = async () => { liveInspections += 1; return { kind: "missing", diagnostic: "live Builder is gone" }; };
	const transitions: Array<{ state: string; dispatch: string; evidence: string | undefined }> = [];
	const replaceActive = dependencies.runJournal.replaceActive.bind(dependencies.runJournal);
	dependencies.runJournal.replaceActive = async (repositoryRoot, candidate) => {
		const attempt = candidate.run.tasks[0]?.attempts[0];
		if (attempt) transitions.push({ state: attempt.state, dispatch: attempt.dispatch.phase, evidence: attempt.evidence?.phase });
		return replaceActive(repositoryRoot, candidate);
	};
	await resumeOnce(root, dependencies);
	const after = await dependencies.runJournal.loadActive(root);
	if (after.kind !== "loaded") throw new Error("missing Builder report Journal");
	const task = after.journal.run.tasks[0]!;
	const builder = task.attempts[0]!;
	equal(task.attempts.length, 1);
	if (builder.role !== "builder") throw new Error("Builder missing after report");
	equal(builder.state, "reported");
	equal(builder.dispatch.phase, "reconciled-active");
	equal(builder.dispatch.basis, "valid-report");
	equal(builder.evidence?.phase, "finalized");
	equal(liveInspections, 0);
	const promotionIndex = transitions.findIndex((entry) => entry.state === "active" && entry.dispatch === "reconciled-active" && entry.evidence === undefined);
	const finalizationIndex = transitions.findIndex((entry) => entry.state === "active" && entry.dispatch === "reconciled-active" && entry.evidence === "finalization-intended");
	ok(promotionIndex >= 0);
	ok(finalizationIndex > promotionIndex);
	ok(!transitions.some((entry) => entry.state === "prepared" && entry.evidence === "finalization-intended"));
	equal(effects.builderPrompts, 1);
	await invoke(root, dependencies, "status");
	const later = await dependencies.runJournal.loadActive(root);
	if (later.kind !== "loaded") throw new Error("missing later Builder continuation Journal");
	equal(later.journal.run.tasks[0]?.attempts.filter((attempt) => attempt.role === "builder").length, 1);
}, 60_000);

it.sequential("ticket-10 validates a prepared Reviewer report by promoting first, then finalizing evidence", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-review-prepared-reviewer-report-"));
	roots.push(root);
	const effects: EffectCounts = { builderPrompts: 0, reviewerPanes: 0, reviewerStarts: 0, reviewerPrompts: 0 };
	const dependencies = makeDependencies(root, { effectCounts: effects });
	const started = await startRun(root, dependencies);
	await writeBuilderReport(root, started);
	await invoke(root, dependencies, "status");
	const reviewerDispatch = await dependencies.runJournal.loadActive(root);
	if (reviewerDispatch.kind !== "loaded") throw new Error("missing Reviewer dispatch");
	await writeReviewerReport(reviewerDispatch.journal, "approved");
	const prepared = advanceRunJournal(reviewerDispatch.journal, new Date("2026-09-18T00:00:01.000Z"), (next) => {
		const reviewer = next.run.tasks[0]?.attempts.at(-1);
		if (!reviewer || reviewer.role !== "reviewer" || reviewer.dispatch.phase !== "prompted") throw new Error("missing prompted Reviewer");
		const dispatch = reviewer.dispatch;
		reviewer.state = "prepared";
		delete reviewer.activatedAt;
		reviewer.dispatch = { phase: "prompt-intended", agentName: dispatch.agentName, worktreePath: dispatch.worktreePath, workspaceId: dispatch.workspaceId, paneId: dispatch.paneId, terminalId: dispatch.terminalId, assignmentSha256: dispatch.assignmentSha256 } as unknown as ReviewerAttemptRecord["dispatch"];
	});
	const preparedWrite = await dependencies.runJournal.replaceActive(root, prepared);
	if (preparedWrite.kind !== "replaced") throw new Error("prepared Reviewer Journal was not persisted");
	let liveInspections = 0;
	dependencies.herdr.inspectManagedAgent = async () => { liveInspections += 1; return { kind: "missing", diagnostic: "live Reviewer is gone" }; };
	const transitions: Array<{ state: string; dispatch: string; evidence: string | undefined }> = [];
	const replaceActive = dependencies.runJournal.replaceActive.bind(dependencies.runJournal);
	dependencies.runJournal.replaceActive = async (repositoryRoot, candidate) => {
		const reviewer = candidate.run.tasks[0]?.attempts.at(-1);
		if (reviewer?.role === "reviewer") transitions.push({ state: reviewer.state, dispatch: reviewer.dispatch.phase, evidence: reviewer.evidence?.phase });
		return replaceActive(repositoryRoot, candidate);
	};
	await resumeOnce(root, dependencies);
	const after = await dependencies.runJournal.loadActive(root);
	if (after.kind !== "loaded") throw new Error("missing Reviewer report Journal");
	const task = after.journal.run.tasks[0]!;
	const reviewer = task.attempts.at(-1)!;
	equal(task.attempts.length, 2);
	if (reviewer.role !== "reviewer") throw new Error("Reviewer missing after report");
	equal(reviewer.state, "reported");
	equal(reviewer.dispatch.phase, "reconciled-active");
	equal(reviewer.dispatch.basis, "valid-report");
	equal(reviewer.evidence?.phase, "finalized");
	equal(liveInspections, 0);
	const promotionIndex = transitions.findIndex((entry) => entry.state === "active" && entry.dispatch === "reconciled-active" && entry.evidence === undefined);
	const finalizationIndex = transitions.findIndex((entry) => entry.state === "active" && entry.dispatch === "reconciled-active" && entry.evidence === "finalization-intended");
	ok(promotionIndex >= 0);
	ok(finalizationIndex > promotionIndex);
	ok(!transitions.some((entry) => entry.state === "prepared" && entry.evidence === "finalization-intended"));
	equal(effects.reviewerPrompts, 1);
	await invoke(root, dependencies, "status");
	const later = await dependencies.runJournal.loadActive(root);
	if (later.kind !== "loaded") throw new Error("missing later Reviewer continuation Journal");
	equal(later.journal.run.tasks[0]?.attempts.filter((attempt) => attempt.role === "reviewer").length, 1);
}, 60_000);

it.sequential.each([
	{ verdict: "approved" as const, hasFinding: false },
	{ verdict: "changes-required" as const, hasFinding: true },
	])("registered status finalizes $verdict and applies the ticket-07 transition", async ({ verdict, hasFinding }) => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-review-changes-required-"));
	roots.push(root);
	const dependencies = makeDependencies(root, verdict === "changes-required" ? {
			reviewHooks: {
			async onBuilderPrompt(journal, input) {
				const task = journal.run.tasks[0]!;
				if (task.attempts.length === 1) return;
				const original = task.attempts[0]!;
				const rework = task.attempts.at(-1)!;
				if (original.role !== "builder" || rework.role !== "builder") throw new Error("Builder identity missing during rework prompt");
				if (original.dispatch.phase !== "prompted" || rework.dispatch.phase !== "prompt-intended") throw new Error("Builder dispatch phase missing during rework prompt");
				if (!("paneId" in original.dispatch) || !("paneId" in rework.dispatch)) throw new Error("Builder pane identity missing during rework prompt");
				equal(task.phase, "reworking");
				equal(task.reworkCycles, 1);
				equal(rework.state, "prepared");
				equal(rework.dispatch.phase, "prompt-intended");
				equal(rework.dispatch.agentName, original.dispatch.agentName);
				equal(rework.dispatch.paneId, original.dispatch.paneId);
				const assignment = JSON.parse(await readFile(rework.assignmentPath, "utf8")) as { assignment: { rework?: { cycle: number; priorBuilderAttemptId: string; priorReviewerAttemptId: string; reviewerEvidence: { manifestPath: string; manifestSha256: string }; findings: unknown[] } } };
				if (!assignment.assignment.rework) throw new Error("Rework facts missing from Assignment");
				equal(assignment.assignment.rework.cycle, 1);
				equal(assignment.assignment.rework.priorBuilderAttemptId, "attempt-01");
				equal(assignment.assignment.rework.priorReviewerAttemptId, "attempt-02");
				equal(assignment.assignment.rework.findings.length, 1);
				equal(input.name, original.dispatch.agentName);
			},
		},
	} : undefined);
	const journal = await startRun(root, dependencies);
	await writeBuilderReport(root, journal);
	await invoke(root, dependencies, "status");
	const dispatched = await dependencies.runJournal.loadActive(root);
	if (dispatched.kind !== "loaded") throw new Error("missing dispatched journal");
	await writeReviewerReport(dispatched.journal, verdict);
	const view = await invoke(root, dependencies, "status");
	const finalized = await dependencies.runJournal.loadActive(root);
	if (finalized.kind !== "loaded") throw new Error("missing finalized journal");
	const task = finalized.journal.run.tasks[0]!;
	const reviewer = task.attempts.find((attempt): attempt is ReviewerAttemptRecord => attempt.role === "reviewer");
	if (!reviewer || reviewer.role !== "reviewer") throw new Error("Reviewer missing after changes-required finalization");
	match(view?.markdown ?? "", verdict === "approved" ? /Approval: valid/ : /Rework cycle 1 reserved and prompted/);
	equal(task.phase, verdict === "approved" ? "approved" : "reworking");
	equal(task.attention, "none");
	equal(reviewer.state, "reported");
	equal(reviewer.evidence?.phase, "finalized");
	if (!reviewer.evidence || reviewer.evidence.phase !== "finalized") throw new Error("Reviewer evidence was not finalized");
	equal(reviewer.evidence.verdict, verdict);
	const manifest = JSON.parse(await readFile(reviewer.evidence.manifestPath, "utf8")) as { verdict: string; findings: unknown[] };
	equal(manifest.verdict, verdict);
	equal(manifest.findings.length > 0, hasFinding);
	if (verdict === "approved") equal(task.approval?.phase, "valid");
	else {
		equal(task.reworkCycles, 1);
		equal(task.attempts.length, 3);
		equal(task.attempts[2]?.role, "builder");
		equal(task.attempts[2]?.state, "active");
		equal(task.approval, undefined);
	}
}, 60_000);

it.sequential("registered status invalidates a finalized Reviewer verdict after a later worktree change and remains idempotent", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-review-late-violation-"));
	roots.push(root);
	const changed = { head: headRevision, dirtyStateFingerprint: "sha256:" + "c".repeat(64), dirtyPaths: ["src/late-change.ts"], operationMarkers: [] };
	const baseline = { head: headRevision, dirtyStateFingerprint: fingerprint, dirtyPaths: [], operationMarkers: [] };
	const dependencies = makeDependencies(root, { snapshots: [baseline, baseline, baseline, baseline, changed] });
	const journal = await startRun(root, dependencies);
	await writeBuilderReport(root, journal);
	await invoke(root, dependencies, "status");
	const dispatched = await dependencies.runJournal.loadActive(root);
	if (dispatched.kind !== "loaded") throw new Error("missing dispatched journal");
	await writeReviewerReport(dispatched.journal, "approved");
	await invoke(root, dependencies, "status");
	const accepted = await dependencies.runJournal.loadActive(root);
	if (accepted.kind !== "loaded") throw new Error("missing accepted journal");
	equal(accepted.journal.run.tasks[0]!.phase, "approved");
	const acceptedReviewer = accepted.journal.run.tasks[0]!.attempts.find((attempt): attempt is ReviewerAttemptRecord => attempt.role === "reviewer");
	if (!acceptedReviewer || acceptedReviewer.role !== "reviewer" || !acceptedReviewer.evidence || acceptedReviewer.evidence.phase !== "finalized") throw new Error("Reviewer was not finalized");
	const evidenceBefore = JSON.parse(JSON.stringify(acceptedReviewer.evidence)) as typeof acceptedReviewer.evidence;
	const manifestPath = acceptedReviewer.evidence.manifestPath;
	const finalizedDirectory = dirname(manifestPath);
	const finalizedReportPath = join(finalizedDirectory, "report.md");
	const manifestBytes = await readFile(manifestPath);
	const finalizedReportBytes = await readFile(finalizedReportPath);
	const lateView = await invoke(root, dependencies, "status");
	match(lateView?.markdown ?? "", /Approval:? invalidated|no verdict was accepted|no verdict is eligible/);
	const violated = await dependencies.runJournal.loadActive(root);
	if (violated.kind !== "loaded") throw new Error("missing violated journal");
	const task = violated.journal.run.tasks[0]!;
	const reviewer = task.attempts.find((attempt): attempt is ReviewerAttemptRecord => attempt.role === "reviewer");
	if (!reviewer || reviewer.role !== "reviewer") throw new Error("Reviewer missing after late violation");
	equal(task.phase, "reviewing");
	equal(task.attention, "needs-user");
	equal(task.approval?.phase, "invalidated");
	equal(task.approval?.reason, "dirty-state-changed");
	equal(reviewer.state, "reported");
	equal(reviewer.integrity?.kind, "preserved");
	deepStrictEqual(reviewer.evidence, evidenceBefore);
	equal(reviewer.evidence?.manifestPath, manifestPath);
	equal(dirname(reviewer.evidence?.manifestPath ?? ""), finalizedDirectory);
	deepStrictEqual(await readFile(manifestPath), manifestBytes);
	deepStrictEqual(await readFile(finalizedReportPath), finalizedReportBytes);
	const revision = violated.journal.journalRevision;
	const repeatedView = await invoke(root, dependencies, "status");
	match(repeatedView?.markdown ?? "", /Approval:? invalidated|no verdict was accepted|no verdict is eligible/);
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
	equal(paused.journal.run.tasks[0]!.attentionReason, "review-approval-required");
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

it.sequential("ticket-07 repairs one missing Reviewer report on the same Reviewer and then approves", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-review-repair-"));
	roots.push(root);
	let repairPrompts = 0;
	const dependencies = makeDependencies(root, { reviewHooks: { async onPrompt(_journal, input) { if (input.assignmentPrompt.startsWith("Steward Reviewer report repair")) repairPrompts += 1; } } });
	const journal = await startRun(root, dependencies);
	await writeBuilderReport(root, journal);
	await invoke(root, dependencies, "status");
	const dispatched = await dependencies.runJournal.loadActive(root);
	if (dispatched.kind !== "loaded") throw new Error("missing dispatched journal");
	await invoke(root, dependencies, "status");
	const requested = await dependencies.runJournal.loadActive(root);
	if (requested.kind !== "loaded") throw new Error("missing repair-requested journal");
	const requestedReviewer = requested.journal.run.tasks[0]!.attempts.at(-1);
	if (!requestedReviewer || requestedReviewer.role !== "reviewer") throw new Error("missing requested Reviewer");
	equal(requestedReviewer.reportRepair?.phase, "requested");
	equal(repairPrompts, 1);
	await writeReviewerReport(requested.journal, "approved");
	const repairedView = await invoke(root, dependencies, "status");
	match(repairedView?.markdown ?? "", /Approval: valid/);
	const repaired = await dependencies.runJournal.loadActive(root);
	if (repaired.kind !== "loaded") throw new Error("missing repaired journal");
	const task = repaired.journal.run.tasks[0]!;
	equal(task.phase, "approved");
	equal(task.attempts.length, 2);
	const reviewer = task.attempts[1]!;
	if (reviewer.role !== "reviewer") throw new Error("reviewer sequence changed during repair");
	equal(reviewer.reportRepair?.phase, "requested");
	equal(repairPrompts, 1);
}, 60_000);

it.sequential("ticket-07 blocks a second repairable Reviewer failure idempotently", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-review-repair-blocked-"));
	roots.push(root);
	let repairPrompts = 0;
	const dependencies = makeDependencies(root, { reviewHooks: { async onPrompt(_journal, input) { if (input.assignmentPrompt.startsWith("Steward Reviewer report repair")) repairPrompts += 1; } } });
	const journal = await startRun(root, dependencies);
	await writeBuilderReport(root, journal);
	await invoke(root, dependencies, "status");
	await invoke(root, dependencies, "status");
	const requested = await dependencies.runJournal.loadActive(root);
	if (requested.kind !== "loaded") throw new Error("missing requested journal");
	const requestedRevision = requested.journal.journalRevision;
	const blockedView = await invoke(root, dependencies, "status");
	match(blockedView?.markdown ?? "", /second .* failure|no further prompt/i);
	const blocked = await dependencies.runJournal.loadActive(root);
	if (blocked.kind !== "loaded") throw new Error("missing blocked journal");
	const task = blocked.journal.run.tasks[0]!;
	equal(task.phase, "reviewing");
	equal(task.attention, "blocked");
	const reviewer = task.attempts.at(-1);
	if (!reviewer || reviewer.role !== "reviewer") throw new Error("missing blocked Reviewer");
	equal(reviewer.reportRepair?.phase, "blocked");
	equal(repairPrompts, 1);
	const revision = blocked.journal.journalRevision;
	await invoke(root, dependencies, "status");
	const repeated = await dependencies.runJournal.loadActive(root);
	if (repeated.kind !== "loaded") throw new Error("missing repeated blocked journal");
	equal(repeated.journal.journalRevision, revision);
	equal(repeated.journal.journalRevision > requestedRevision, true);
	equal(repairPrompts, 1);
}, 60_000);

it.sequential("ticket-07 exhausts a frozen zero rework limit without reserving Attempt 03", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-review-rework-exhausted-"));
	roots.push(root);
	const dependencies = makeDependencies(root, { reworkCycleLimit: 0 });
	const journal = await startRun(root, dependencies);
	await writeBuilderReport(root, journal);
	await invoke(root, dependencies, "status");
	const dispatched = await dependencies.runJournal.loadActive(root);
	if (dispatched.kind !== "loaded") throw new Error("missing dispatched journal");
	await writeReviewerReport(dispatched.journal, "changes-required");
	const view = await invoke(root, dependencies, "status");
	match(view?.markdown ?? "", /frozen rework limit 0 is exhausted/);
	const exhausted = await dependencies.runJournal.loadActive(root);
	if (exhausted.kind !== "loaded") throw new Error("missing exhausted journal");
	const task = exhausted.journal.run.tasks[0]!;
	equal(task.phase, "reviewing");
	equal(task.attention, "needs-user");
	equal(task.reworkCycles, 0);
	equal(task.attempts.length, 2);
	equal(task.attempts[1]?.role, "reviewer");
}, 60_000);

it.sequential("ticket-07 routes a finalized rework Artifact to a fresh Review and Approval", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-review-rework-flow-"));
	roots.push(root);
	const artifactA = headRevision;
	const artifactB = "3333333333333333333333333333333333333333";
	const snapshotState = { value: { head: artifactA, dirtyStateFingerprint: fingerprint, dirtyPaths: [], operationMarkers: [] } };
	const effects: EffectCounts = { builderPrompts: 0, reviewerPanes: 0, reviewerStarts: 0, reviewerPrompts: 0 };
	const dependencies = makeDependencies(root, { snapshotState, effectCounts: effects, reworkCycleLimit: 5 });
	const started = await startRun(root, dependencies);
	await writeBuilderReport(root, started, artifactA);
	await invoke(root, dependencies, "status");
	const reviewA = await dependencies.runJournal.loadActive(root);
	if (reviewA.kind !== "loaded") throw new Error("missing Review A journal");
	const reviewerA = reviewA.journal.run.tasks[0]!.attempts.at(-1)!;
	if (reviewerA.role !== "reviewer") throw new Error("Review A missing");
	await writeReviewerReport(reviewA.journal, "changes-required");
	await invoke(root, dependencies, "status");
	const reworking = await dependencies.runJournal.loadActive(root);
	if (reworking.kind !== "loaded") throw new Error("missing rework journal");
	const taskA = reworking.journal.run.tasks[0]!;
	equal(taskA.attempts.length, 3);
	const builderA = taskA.attempts[0]!;
	const reviewAManifest = taskA.attempts[1]!;
	if (builderA.role !== "builder" || reviewAManifest.role !== "reviewer" || !reviewAManifest.evidence || reviewAManifest.evidence.phase !== "finalized") throw new Error("Review A evidence missing");
	const builderAReportBytes = await readFile(builderA.reportPath);
	const reviewAReportBytes = await readFile(reviewAManifest.reportPath);
	const reviewAManifestBytes = await readFile(reviewAManifest.evidence.manifestPath);
	await writeBuilderReport(root, reworking.journal, artifactB);
	snapshotState.value = { head: artifactB, dirtyStateFingerprint: fingerprint, dirtyPaths: [], operationMarkers: [] };
	const freshReviewView = await invoke(root, dependencies, "status");
	match(freshReviewView?.markdown ?? "", /Reviewer Attempt attempt-04: active/);
	const freshReview = await dependencies.runJournal.loadActive(root);
	if (freshReview.kind !== "loaded") throw new Error("missing fresh Review B journal");
	const taskB = freshReview.journal.run.tasks[0]!;
	equal(taskB.attempts.length, 4);
	const reviewerB = taskB.attempts[3]!;
	if (reviewerB.role !== "reviewer") throw new Error("Review B missing");
	equal(reviewerB.id, "attempt-04");
	if (reviewerB.subject.kind !== "git") throw new Error("Review B subject is not Git");
	equal(reviewerB.subject.headRevision, artifactB);
	const builderB = taskB.attempts[2];
	if (builderA.dispatch.phase !== "prompted" || builderB?.role !== "builder" || builderB.dispatch.phase !== "prompted" || reviewerA.dispatch.phase !== "prompted" || reviewerB.dispatch.phase !== "prompted") throw new Error("dispatch identity missing");
	equal(builderA.dispatch.agentName, builderB.dispatch.agentName);
	equal(builderA.dispatch.paneId, builderB.dispatch.paneId);
	ok(reviewerB.assignmentPath !== reviewerA.assignmentPath);
	ok(reviewerB.reportPath !== reviewerA.reportPath);
	equal(effects.builderPrompts, 2);
	equal(effects.reviewerPanes, 2);
	equal(effects.reviewerStarts, 2);
	equal(effects.reviewerPrompts, 2);
	await writeReviewerReport(freshReview.journal, "approved");
	const approvedView = await invoke(root, dependencies, "status");
	match(approvedView?.markdown ?? "", /Approval: valid/);
	const approved = await dependencies.runJournal.loadActive(root);
	if (approved.kind !== "loaded") throw new Error("missing Approval B journal");
	const finalTask = approved.journal.run.tasks[0]!;
	equal(finalTask.phase, "approved");
	equal(finalTask.approval?.builderAttemptId, "attempt-03");
	equal(finalTask.approval?.reviewerAttemptId, "attempt-04");
	if (!finalTask.approval || finalTask.approval.subject.kind !== "git") throw new Error("Approval B subject is not Git");
	equal(finalTask.approval.subject.headRevision, artifactB);
	deepStrictEqual(await readFile(builderA.reportPath), builderAReportBytes);
	deepStrictEqual(await readFile(reviewAManifest.reportPath), reviewAReportBytes);
	deepStrictEqual(await readFile(reviewAManifest.evidence.manifestPath), reviewAManifestBytes);
}, 60_000);

it.sequential("ticket-07 durably pauses a rework preflight failure without reserving or prompting", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-review-rework-preflight-"));
	roots.push(root);
	const effects: EffectCounts = { builderPrompts: 0, reviewerPanes: 0, reviewerStarts: 0, reviewerPrompts: 0 };
	let preflightFailed = false;
	const dependencies = makeDependencies(root, { effectCounts: effects, builderPreflight: (expectedRevision) => preflightFailed ? { kind: "unavailable", message: "Builder worktree moved" } : { kind: "ready", head: expectedRevision, clean: true } });
	const started = await startRun(root, dependencies);
	await writeBuilderReport(root, started);
	await invoke(root, dependencies, "status");
	const review = await dependencies.runJournal.loadActive(root);
	if (review.kind !== "loaded") throw new Error("missing Review journal");
	await writeReviewerReport(review.journal, "changes-required");
	preflightFailed = true;
	await invoke(root, dependencies, "status");
	const before = await dependencies.runJournal.loadActive(root);
	if (before.kind !== "loaded") throw new Error("missing finalized Review journal");
	const beforeTask = before.journal.run.tasks[0]!;
	const reviewer = beforeTask.attempts[1]!;
	if (reviewer.role !== "reviewer" || !reviewer.evidence || reviewer.evidence.phase !== "finalized") throw new Error("protected Review A missing");
	const manifestBytes = await readFile(reviewer.evidence.manifestPath);
	const pausedView = await invoke(root, dependencies, "status");
	match(pausedView?.markdown ?? "", /Builder worktree moved|needs-user/);
	const paused = await dependencies.runJournal.loadActive(root);
	if (paused.kind !== "loaded") throw new Error("missing paused journal");
	const task = paused.journal.run.tasks[0]!;
	equal(task.phase, "reviewing");
	equal(task.attention, "needs-user");
	equal(task.attentionReason, "rework-preflight");
	ok(Boolean(task.attentionDiagnostic));
	equal(task.attempts.length, 2);
	deepStrictEqual(await readFile(reviewer.evidence.manifestPath), manifestBytes);
	equal(effects.builderPrompts, 1);
	const revision = paused.journal.journalRevision;
	await invoke(root, dependencies, "status");
	const repeated = await dependencies.runJournal.loadActive(root);
	if (repeated.kind !== "loaded") throw new Error("missing repeated pause journal");
	equal(repeated.journal.journalRevision, revision);
	equal(effects.builderPrompts, 1);
}, 60_000);

it.sequential("ticket-07 completes the real five-cycle rework budget without Attempt 13", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-review-rework-exhaustion-"));
	roots.push(root);
	const snapshotState = { value: { head: headRevision, dirtyStateFingerprint: fingerprint, dirtyPaths: [], operationMarkers: [] } };
	const effects: EffectCounts = { builderPrompts: 0, reviewerPanes: 0, reviewerStarts: 0, reviewerPrompts: 0 };
	const dependencies = makeDependencies(root, { snapshotState, effectCounts: effects, reworkCycleLimit: 5 });
	const started = await startRun(root, dependencies);
	await writeBuilderReport(root, started, headRevision);
	await invoke(root, dependencies, "status");
	let journalResult = await dependencies.runJournal.loadActive(root);
	if (journalResult.kind !== "loaded") throw new Error("missing initial Review journal");
	const preservedManifestHashes = new Set<string>();
	const preservedReportBytes = new Set<string>();
	for (let cycle = 0; cycle <= 5; cycle += 1) {
		const currentTask = journalResult.journal.run.tasks[0]!;
		const currentReviewer = currentTask.attempts.at(-1);
		if (!currentReviewer || currentReviewer.role !== "reviewer") throw new Error(`missing Reviewer before cycle ${cycle}`);
		await writeReviewerReport(journalResult.journal, "changes-required");
		const nextHead = cycle === 5 ? headRevision : `${String(cycle + 3)}${String(cycle + 3)}`.repeat(20).slice(0, 40);
		await invoke(root, dependencies, "status");
		journalResult = await dependencies.runJournal.loadActive(root);
		if (journalResult.kind !== "loaded") throw new Error(`missing journal after cycle ${cycle}`);
		const afterTask = journalResult.journal.run.tasks[0]!;
		for (const attempt of afterTask.attempts) {
			if (attempt.role === "builder" && attempt.evidence?.phase === "finalized") {
				preservedManifestHashes.add(attempt.evidence.manifestSha256);
				preservedReportBytes.add((await readFile(join(dirname(attempt.evidence.manifestPath), "report.md"))).toString("utf8"));
			}
			if (attempt.role === "reviewer" && attempt.evidence?.phase === "finalized") {
				preservedManifestHashes.add(attempt.evidence.manifestSha256);
				preservedReportBytes.add((await readFile(join(dirname(attempt.evidence.manifestPath), "report.md"))).toString("utf8"));
			}
		}
		if (cycle < 5) {
			const builder = afterTask.attempts.at(-1);
			if (!builder || builder.role !== "builder" || afterTask.phase !== "reworking") throw new Error(`cycle ${cycle + 1} was not reserved`);
			await writeBuilderReport(root, journalResult.journal, nextHead);
			snapshotState.value = { head: nextHead, dirtyStateFingerprint: fingerprint, dirtyPaths: [], operationMarkers: [] };
			await invoke(root, dependencies, "status");
			journalResult = await dependencies.runJournal.loadActive(root);
			if (journalResult.kind !== "loaded") throw new Error(`missing fresh Review for cycle ${cycle + 1}`);
			const freshReviewer = journalResult.journal.run.tasks[0]!.attempts.at(-1);
			if (!freshReviewer || freshReviewer.role !== "reviewer" || freshReviewer.id !== `attempt-${String(4 + cycle * 2).padStart(2, "0")}`) throw new Error(`fresh Reviewer missing for cycle ${cycle + 1}`);
		}
	}
	const exhausted = journalResult.journal.run.tasks[0]!;
	equal(exhausted.reworkCycles, 5);
	equal(exhausted.attempts.length, 12);
	equal(exhausted.phase, "reviewing");
	equal(exhausted.attention, "needs-user");
	equal(exhausted.attentionReason, "rework-exhausted");
	equal(exhausted.attempts.at(-1)?.id, "attempt-12");
	equal(exhausted.attempts.some((attempt) => attempt.id === "attempt-13"), false);
	equal(preservedManifestHashes.size, 12);
	equal(preservedReportBytes.size, 12);
	equal(effects.builderPrompts, 6);
	equal(effects.reviewerPanes, 6);
	equal(effects.reviewerStarts, 6);
	equal(effects.reviewerPrompts, 6);
	const revision = journalResult.journal.journalRevision;
	await invoke(root, dependencies, "status");
	const repeated = await dependencies.runJournal.loadActive(root);
	if (repeated.kind !== "loaded") throw new Error("missing repeated exhaustion journal");
	equal(repeated.journal.journalRevision, revision);
	equal(effects.builderPrompts, 6);
	equal(effects.reviewerPrompts, 6);
}, 120_000);

it.sequential.each(["missing", "malformed", "evidence-incomplete"] as const)("ticket-07 blocks one repairable %s failure after exactly one same-Reviewer prompt", async (failure) => {
	const root = await mkdtemp(join(tmpdir(), `pi-herdr-steward-review-repair-${failure}-`));
	roots.push(root);
	let repairPrompts = 0;
	const dependencies = makeDependencies(root, { reviewHooks: { async onPrompt(_journal, input) { if (input.assignmentPrompt.startsWith("Steward Reviewer report repair")) repairPrompts += 1; } } });
	const started = await startRun(root, dependencies);
	await writeBuilderReport(root, started);
	await invoke(root, dependencies, "status");
	const dispatched = await dependencies.runJournal.loadActive(root);
	if (dispatched.kind !== "loaded") throw new Error(`missing dispatched journal for ${failure}`);
	const reviewer = dispatched.journal.run.tasks[0]!.attempts.at(-1);
	if (!reviewer || reviewer.role !== "reviewer") throw new Error(`missing Reviewer for ${failure}`);
	if (failure === "malformed") await writeFile(reviewer.reportPath, "---\n{\"malformed\":true}\n---\n");
	if (failure === "evidence-incomplete") await writeReviewerReport(dispatched.journal, "approved", [{ id: "review-log", path: join(root, "missing-review.log"), size: 5, sha256: digest(Buffer.from("gone\n")) }]);
	await invoke(root, dependencies, "status");
	const requested = await dependencies.runJournal.loadActive(root);
	if (requested.kind !== "loaded") throw new Error(`missing requested repair journal for ${failure}`);
	const requestedTask = requested.journal.run.tasks[0]!;
	const requestedReviewer = requestedTask.attempts.at(-1);
	if (!requestedReviewer || requestedReviewer.role !== "reviewer") throw new Error(`missing requested Reviewer for ${failure}`);
	equal(requestedReviewer.reportRepair?.phase, "requested");
	equal(repairPrompts, 1);
	const requestedRevision = requested.journal.journalRevision;
	await invoke(root, dependencies, "status");
	const blocked = await dependencies.runJournal.loadActive(root);
	if (blocked.kind !== "loaded") throw new Error(`missing blocked repair journal for ${failure}`);
	const blockedTask = blocked.journal.run.tasks[0]!;
	equal(blockedTask.phase, "reviewing");
	equal(blockedTask.attention, "blocked");
	equal(blockedTask.attempts.length, 2);
	const blockedReviewer = blockedTask.attempts.at(-1);
	if (blockedReviewer?.role !== "reviewer") throw new Error(`missing blocked Reviewer for ${failure}`);
	equal(blockedReviewer.reportRepair?.phase, "blocked");
	equal(repairPrompts, 1);
	const blockedRevision = blocked.journal.journalRevision;
	await invoke(root, dependencies, "status");
	const repeated = await dependencies.runJournal.loadActive(root);
	if (repeated.kind !== "loaded") throw new Error(`missing repeated blocked repair journal for ${failure}`);
	equal(repeated.journal.journalRevision, blockedRevision);
	equal(blockedRevision > requestedRevision, true);
	equal(repairPrompts, 1);
}, 60_000);

it.sequential("ticket-07 persists a rework assignment reservation before an injected assignment failure", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-review-rework-assignment-failure-"));
	roots.push(root);
	const effects: EffectCounts = { builderPrompts: 0, reviewerPanes: 0, reviewerStarts: 0, reviewerPrompts: 0 };
	const dependencies = makeDependencies(root, { effectCounts: effects, failReworkAssignment: true });
	const started = await startRun(root, dependencies);
	await writeBuilderReport(root, started);
	await invoke(root, dependencies, "status");
	const dispatched = await dependencies.runJournal.loadActive(root);
	if (dispatched.kind !== "loaded") throw new Error("missing initial Review journal");
	await writeReviewerReport(dispatched.journal, "changes-required");
	const view = await invoke(root, dependencies, "status");
	match(view?.markdown ?? "", /reserved Attempt|without a prompt|storage failed/i);
	const reserved = await dependencies.runJournal.loadActive(root);
	if (reserved.kind !== "loaded") throw new Error("missing reserved rework journal");
	const task = reserved.journal.run.tasks[0]!;
	equal(task.phase, "reworking");
	equal(task.reworkCycles, 1);
	equal(task.attempts.length, 3);
	const rework = task.attempts[2]!;
	if (rework.role !== "builder") throw new Error("reserved rework Builder missing");
	equal(rework.state, "prepared");
	equal(rework.dispatch.phase, "assignment-intended");
	equal(effects.builderPrompts, 1);
	const revision = reserved.journal.journalRevision;
	await invoke(root, dependencies, "status");
	const repeated = await dependencies.runJournal.loadActive(root);
	if (repeated.kind !== "loaded") throw new Error("missing repeated assignment-failure journal");
	equal(repeated.journal.journalRevision, revision);
	equal(effects.builderPrompts, 1);
}, 60_000);

it.sequential.each(["malformed", "throw"] as const)("ticket-07 retains rework prompt-%s intent without duplicate Builder prompt", async (ack) => {
	const root = await mkdtemp(join(tmpdir(), `pi-herdr-steward-review-rework-prompt-${ack}-`));
	roots.push(root);
	const effects: EffectCounts = { builderPrompts: 0, reviewerPanes: 0, reviewerStarts: 0, reviewerPrompts: 0 };
	const dependencies = makeDependencies(root, { effectCounts: effects, failReworkBuilderPrompt: ack });
	const started = await startRun(root, dependencies);
	await writeBuilderReport(root, started);
	await invoke(root, dependencies, "status");
	const dispatched = await dependencies.runJournal.loadActive(root);
	if (dispatched.kind !== "loaded") throw new Error("missing initial Review journal");
	await writeReviewerReport(dispatched.journal, "changes-required");
	await invoke(root, dependencies, "status");
	const retained = await dependencies.runJournal.loadActive(root);
	if (retained.kind !== "loaded") throw new Error("missing retained prompt-intent journal");
	const task = retained.journal.run.tasks[0]!;
	const rework = task.attempts.at(-1);
	if (rework?.role !== "builder") throw new Error("missing rework Builder");
	equal(task.phase, "reworking");
	equal(rework.state, "prepared");
	equal(rework.dispatch.phase, "prompt-intended");
	equal(effects.builderPrompts, 2);
	const revision = retained.journal.journalRevision;
	await invoke(root, dependencies, "status");
	const repeated = await dependencies.runJournal.loadActive(root);
	if (repeated.kind !== "loaded") throw new Error("missing repeated prompt-intent journal");
	equal(repeated.journal.journalRevision, revision);
	equal(effects.builderPrompts, 2);
}, 60_000);

it.sequential.each(["malformed", "throw"] as const)("ticket-07 retains repair request-%s intent without duplicate repair prompt", async (ack) => {
	const root = await mkdtemp(join(tmpdir(), `pi-herdr-steward-review-repair-${ack}-`));
	roots.push(root);
	const effects: EffectCounts = { builderPrompts: 0, reviewerPanes: 0, reviewerStarts: 0, reviewerPrompts: 0 };
	const dependencies = makeDependencies(root, { effectCounts: effects, failRepairPrompt: ack });
	const started = await startRun(root, dependencies);
	await writeBuilderReport(root, started);
	await invoke(root, dependencies, "status");
	const dispatched = await dependencies.runJournal.loadActive(root);
	if (dispatched.kind !== "loaded") throw new Error("missing initial Review journal");
	await invoke(root, dependencies, "status");
	const retained = await dependencies.runJournal.loadActive(root);
	if (retained.kind !== "loaded") throw new Error("missing retained repair-intent journal");
	const reviewer = retained.journal.run.tasks[0]!.attempts.at(-1);
	if (!reviewer || reviewer.role !== "reviewer") throw new Error("missing Reviewer repair intent");
	equal(reviewer.reportRepair?.phase, "request-intended");
	equal(effects.reviewerPrompts, 2);
	const revision = retained.journal.journalRevision;
	await invoke(root, dependencies, "status");
	const repeated = await dependencies.runJournal.loadActive(root);
	if (repeated.kind !== "loaded") throw new Error("missing repeated repair-intent journal");
	equal(repeated.journal.journalRevision, revision);
	equal(effects.reviewerPrompts, 2);
}, 60_000);

it.sequential.each(["rework-reservation", "rework-prompt-intent", "repair-intent"] as const)("ticket-07 performs no effect after injected %s journal CAS failure", async (failure) => {
	const root = await mkdtemp(join(tmpdir(), `pi-herdr-steward-review-cas-${failure}-`));
	roots.push(root);
	const effects: EffectCounts = { builderPrompts: 0, reviewerPanes: 0, reviewerStarts: 0, reviewerPrompts: 0 };
	const dependencies = makeDependencies(root, { effectCounts: effects, failJournalReplace: failure });
	const started = await startRun(root, dependencies);
	await writeBuilderReport(root, started);
	await invoke(root, dependencies, "status");
	const dispatched = await dependencies.runJournal.loadActive(root);
	if (dispatched.kind !== "loaded") throw new Error(`missing initial Review journal for ${failure}`);
	const beforeRevision = dispatched.journal.journalRevision;
	if (failure === "repair-intent") {
		await invoke(root, dependencies, "status");
		const retained = await dependencies.runJournal.loadActive(root);
		if (retained.kind !== "loaded") throw new Error("missing repair CAS journal");
		equal(retained.journal.journalRevision, beforeRevision);
		const reviewer = retained.journal.run.tasks[0]!.attempts.at(-1);
		if (reviewer?.role !== "reviewer") throw new Error("missing Reviewer after repair CAS failure");
		equal(reviewer.reportRepair, undefined);
		equal(effects.reviewerPrompts, 1);
		return;
	}
	await writeReviewerReport(dispatched.journal, "changes-required");
	await invoke(root, dependencies, "status");
	const retained = await dependencies.runJournal.loadActive(root);
	if (retained.kind !== "loaded") throw new Error(`missing rework CAS journal for ${failure}`);
	const task = retained.journal.run.tasks[0]!;
	if (failure === "rework-reservation") {
		equal(task.attempts.length, 2);
		equal(task.reworkCycles, 0);
		equal(effects.builderPrompts, 1);
	} else {
		equal(task.attempts.length, 3);
		const rework = task.attempts.at(-1);
		if (rework?.role !== "builder") throw new Error("missing rework Builder after prompt CAS failure");
		equal(rework.dispatch.phase, "assignment-intended");
		equal(effects.builderPrompts, 1);
	}
	const revision = retained.journal.journalRevision;
	await invoke(root, dependencies, "status");
	const repeated = await dependencies.runJournal.loadActive(root);
	if (repeated.kind !== "loaded") throw new Error(`missing repeated rework CAS journal for ${failure}`);
	equal(repeated.journal.journalRevision, revision);
	equal(effects.builderPrompts, 1);
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
