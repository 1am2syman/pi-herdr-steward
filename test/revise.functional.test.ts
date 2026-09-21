import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRunJournalAdapter } from "../src/adapters.ts";
import { selectTaskAdmission } from "../src/coordination.ts";
import { registerStewardExtension, type StewardCommandContext, type StewardCommandHandler, type StewardRegistrationSurface } from "../src/extension.ts";
import { buildInitialRunJournal, specificationHash, validateRunJournal, type BuilderAttemptRecord, type FinalVerificationExecution, type IntegrationCheckoutObservation, type ReviewWorktreeSnapshot, type ReviewerAttemptRecord, type RunDraft, type RunJournal, type TaskIntegration, type TaskRecord } from "../src/run.ts";
import type { ProjectModelPlans, RecoveryDefaults } from "../src/config.ts";
import type { ReviewSubject } from "../src/review.ts";
import type { ManagedAgentInspection, ManagedAgentIdentity, StewardDependencies, StewardUiAdapter } from "../src/steward.ts";

const roots: string[] = [];
const baseRevision = "0123456789abcdef0123456789abcdef01234567";
const taskOneHead = "1".repeat(40);
const taskTwoHead = "2".repeat(40);
const models: ProjectModelPlans = {
	builder: { primary: { model: "builder/primary", thinkingLevel: "high" }, fallbacks: [{ model: "builder/fallback", thinkingLevel: "medium" }] },
	reviewer: { primary: { model: "reviewer/primary", thinkingLevel: "high" }, fallbacks: [{ model: "reviewer/fallback", thinkingLevel: "medium" }] },
};
const settings: RecoveryDefaults = {
	passiveInspectionIntervalSeconds: 301,
	secondInspectionAndNudgeIntervalSeconds: 302,
	nudgeGracePeriodSeconds: 121,
	externalCommandWarningThresholdSeconds: 1_801,
	maximumActiveTasks: 2,
	transientRetryLimit: 1,
	reworkCycleLimit: 4,
};

function digest(value: string): string {
	return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function timestamp(second: number): string {
	return `2026-09-19T00:00:${String(second).padStart(2, "0")}.000Z`;
}

function runDraft(): RunDraft {
	return {
		declaredOutcome: "Complete two coordinated changes",
		tasks: [
			{ requiredOutcome: "Complete Task 1", allowedScope: ["src/task-one"], expectedArtifacts: [{ kind: "git-commit" }], verification: { kind: "command", command: "true" }, reviewRequired: true },
			{ requiredOutcome: "Complete Task 2", allowedScope: ["src/task-two"], expectedArtifacts: [{ kind: "git-commit" }], verification: { kind: "command", command: "true" }, reviewRequired: true },
		],
		modelPlan: models,
		effectiveSettings: settings,
		finalVerification: { kind: "command", command: "npm test" },
	};
}

function paths(root: string, taskId: string, attemptId: string): { assignmentPath: string; reportPath: string; evidenceDirectory: string; manifestPath: string; worktreePath: string } {
	const directory = join(root, ".pi", "steward", "runs", "revision-fixture", "tasks", taskId, attemptId);
	return {
		assignmentPath: join(directory, "assignment.json"),
		reportPath: join(directory, "report.md"),
		evidenceDirectory: join(directory, "evidence"),
		manifestPath: join(directory, "evidence", "manifest.json"),
		worktreePath: join(root, "worktrees", taskId),
	};
}

function snapshot(head: string, label: string): ReviewWorktreeSnapshot {
	return { head, dirtyStateFingerprint: digest(`${label}-snapshot`), dirtyPaths: [], operationMarkers: [] };
}

function subject(base: string, head: string, builderManifestSha256: string): Extract<ReviewSubject, { kind: "git" }> {
	return { kind: "git", baseRevision: base, headRevision: head, commits: [head], builderManifestSha256 };
}

function builderAttempt(task: TaskRecord, root: string, head: string, label: string, preparedAt: number): BuilderAttemptRecord {
	const attemptPaths = paths(root, task.contract.id, "attempt-01");
	const branch = `steward/revision-fixture/${task.contract.id}/attempt-01`;
	const agentName = `steward-b-${task.contract.id === "task-01" ? "aaaa1111" : "bbbb2222"}-01-01`;
	const builderManifestSha256 = digest(`${label}-builder-manifest`);
	return {
		id: "attempt-01",
		role: "builder",
		state: "reported",
		preparedAt: timestamp(preparedAt),
		activatedAt: timestamp(preparedAt + 1),
		actualModel: { ...models.builder.primary },
		specificationHash: task.specificationHash,
		baseRevision,
		assignmentPath: attemptPaths.assignmentPath,
		reportPath: attemptPaths.reportPath,
		evidenceDirectory: attemptPaths.evidenceDirectory,
		dispatch: { phase: "prompted", branch, agentName, worktreePath: attemptPaths.worktreePath, workspaceId: `${label}-builder-workspace`, paneId: `${label}-builder-pane`, terminalId: `${label}-builder-terminal`, assignmentSha256: digest(`${label}-builder-assignment`), promptedAt: timestamp(preparedAt + 1) },
		evidence: { phase: "finalized", finalizedAt: timestamp(preparedAt + 2), status: "completed", reportSha256: digest(`${label}-builder-report`), manifestPath: attemptPaths.manifestPath, manifestSha256: builderManifestSha256, producedRevision: head },
	};
}

function reviewerAttempt(task: TaskRecord, root: string, builder: BuilderAttemptRecord, label: string, state: "active" | "reported", preparedAt: number): ReviewerAttemptRecord {
	if (builder.evidence?.phase !== "finalized") throw new Error("fixture Builder evidence is not finalized");
	const attemptPaths = paths(root, task.contract.id, "attempt-02");
	const reviewed = subject(baseRevision, builder.evidence.producedRevision ?? taskTwoHead, builder.evidence.manifestSha256);
	const worktreeSnapshot = snapshot(reviewed.headRevision, label);
	const record: ReviewerAttemptRecord = {
		id: "attempt-02",
		role: "reviewer",
		state,
		preparedAt: timestamp(preparedAt),
		activatedAt: timestamp(preparedAt + 1),
		actualModel: { ...models.reviewer.primary },
		specificationHash: task.specificationHash,
		assignmentPath: attemptPaths.assignmentPath,
		reportPath: attemptPaths.reportPath,
		evidenceDirectory: attemptPaths.evidenceDirectory,
		subject: reviewed,
		independence: { kind: "different-provider-family", builderProvider: "builder", reviewerProvider: "reviewer" },
		worktree: { path: attemptPaths.worktreePath, baseline: worktreeSnapshot },
		dispatch: { phase: "prompted", agentName: `steward-r-${task.contract.id === "task-01" ? "aaaa1111" : "bbbb2222"}-01-01`, worktreePath: attemptPaths.worktreePath, workspaceId: `${label}-reviewer-workspace`, paneId: `${label}-reviewer-pane`, terminalId: `${label}-reviewer-terminal`, assignmentSha256: digest(`${label}-reviewer-assignment`), promptedAt: timestamp(preparedAt + 1) } as ReviewerAttemptRecord["dispatch"],
	};
	if (state === "reported") {
		record.integrity = { kind: "preserved", after: worktreeSnapshot };
		record.evidence = { phase: "finalized", finalizedAt: timestamp(preparedAt + 2), verdict: "approved", reportSha256: digest(`${label}-reviewer-report`), manifestPath: attemptPaths.manifestPath, manifestSha256: digest(`${label}-reviewer-manifest`), subject: reviewed };
	}
	return record;
}

function approval(builder: BuilderAttemptRecord, reviewer: ReviewerAttemptRecord): NonNullable<TaskRecord["approval"]> {
	if (reviewer.evidence?.phase !== "finalized") throw new Error("fixture Reviewer evidence is not finalized");
	return { phase: "valid", approvedAt: timestamp(30), builderAttemptId: builder.id, reviewerAttemptId: reviewer.id, subject: reviewer.subject, reviewerManifestPath: reviewer.evidence.manifestPath, reviewerManifestSha256: reviewer.evidence.manifestSha256, worktreeSnapshot: reviewer.integrity?.kind === "preserved" ? reviewer.integrity.after : reviewer.worktree.baseline, verdict: "approved" };
}

function integration(builder: BuilderAttemptRecord, reviewer: ReviewerAttemptRecord, targetRevision: string, observedHead: string, phase: "integrated" = "integrated"): TaskIntegration {
	if (reviewer.evidence?.phase !== "finalized" || reviewer.integrity?.kind !== "preserved" || builder.evidence?.phase !== "finalized") throw new Error("fixture integration evidence is incomplete");
	const reviewed = reviewer.subject;
	return { phase, targetBranch: "main", targetRevision, approvedBaseRevision: reviewed.kind === "git" ? reviewed.baseRevision : baseRevision, approvedHeadRevision: reviewed.kind === "git" ? reviewed.headRevision : observedHead, approvedCommits: reviewed.kind === "git" ? [...reviewed.commits] : [observedHead], builderAttemptId: builder.id, reviewerAttemptId: reviewer.id, builderManifestSha256: builder.evidence.manifestSha256, reviewerManifestSha256: reviewer.evidence.manifestSha256, action: targetRevision === (reviewed.kind === "git" ? reviewed.baseRevision : baseRevision) ? { kind: "fast-forward", argv: ["merge", "--ff-only", "--no-edit", reviewed.kind === "git" ? reviewed.headRevision : observedHead] } : { kind: "merge-commit", argv: ["merge", "--no-ff", "--no-edit", reviewed.kind === "git" ? reviewed.headRevision : observedHead] }, intendedAt: timestamp(31), integratedAt: timestamp(32), observedHead };
}

type TerminalVerification = { phase: "failed"; id: "verification-01"; command: string; cwd: string; logPath: string; resultPath: string; intendedAt: string; startedAt: string; completedAt: string; exitCode: number; killed: false; logSha256: string; resultSha256: string; checkout: IntegrationCheckoutObservation };

function terminalVerification(root: string, runId: string, head: string): TerminalVerification {
	const directory = join(root, ".pi", "steward", "runs", runId, "completion", "final-verification", "verification-01");
	return { phase: "failed", id: "verification-01", command: "npm test", cwd: root, logPath: join(directory, "output.log"), resultPath: join(directory, "result.json"), intendedAt: timestamp(40), startedAt: timestamp(41), completedAt: timestamp(42), exitCode: 1, killed: false, logSha256: digest("terminal-verification-log"), resultSha256: digest("terminal-verification-result"), checkout: { branch: "main", head, dirtyPaths: [], operationMarkers: [], rangeExact: true } };
}

async function materializeAttempt(attempt: BuilderAttemptRecord | ReviewerAttemptRecord): Promise<string[]> {
	const files = [attempt.assignmentPath, attempt.reportPath];
	await mkdir(attempt.evidenceDirectory, { recursive: true });
	await writeFile(attempt.assignmentPath, `assignment:${attempt.id}\n`);
	await writeFile(attempt.reportPath, `report:${attempt.id}\n`);
	if (attempt.evidence?.phase === "finalized") {
		await writeFile(attempt.evidence.manifestPath, `manifest:${attempt.id}\n`);
		files.push(attempt.evidence.manifestPath);
	}
	return files;
}

async function fixture(root: string, terminal = false): Promise<{ journal: RunJournal; files: string[] }> {
	const initial = buildInitialRunJournal({ identity: { runId: "run-20260919T000000000Z-revise", createdAt: timestamp(0), leaseId: "lease-revise-fixture" }, controllerSessionId: "revise-controller", draft: runDraft(), modelPlan: models, effectiveSettings: settings, integrationBase: { kind: "git", branch: "main", revision: baseRevision } });
	const taskOneBase = initial.run.tasks[0]!;
	const taskTwoBase = initial.run.tasks[1]!;
	const taskOneBuilder = builderAttempt(taskOneBase, root, taskOneHead, "task-one", 10);
	const taskOneReviewer = reviewerAttempt(taskOneBase, root, taskOneBuilder, "task-one", "reported", 13);
	const taskOne: TaskRecord = { ...taskOneBase, phase: "completed", attempts: [taskOneBuilder, taskOneReviewer], reworkCycles: 0, approval: approval(taskOneBuilder, taskOneReviewer), integration: integration(taskOneBuilder, taskOneReviewer, baseRevision, taskOneHead) };
	const taskTwoBuilder = builderAttempt(taskTwoBase, root, taskTwoHead, "task-two", 1);
	const taskTwoReviewer = reviewerAttempt(taskTwoBase, root, taskTwoBuilder, "task-two", terminal ? "reported" : "active", 4);
	const taskTwo: TaskRecord = terminal
		? { ...taskTwoBase, phase: "completed", attempts: [taskTwoBuilder, taskTwoReviewer], reworkCycles: 0, approval: approval(taskTwoBuilder, taskTwoReviewer), integration: integration(taskTwoBuilder, taskTwoReviewer, taskOneHead, taskTwoHead) }
		: { ...taskTwoBase, phase: "reviewing", attempts: [taskTwoBuilder, taskTwoReviewer], reworkCycles: 0 };
	const run = { ...initial.run, tasks: [taskOne, taskTwo], ...(terminal ? { finalVerificationExecution: terminalVerification(root, initial.run.id, taskTwoHead) } : {}) };
	const validated = validateRunJournal({ ...initial, run });
	if (!validated.value || validated.diagnostics.length > 0) throw new Error(`invalid revision fixture: ${validated.diagnostics.map((item) => item.message).join("; ")}`);
	const files = [...await materializeAttempt(taskOneBuilder), ...await materializeAttempt(taskOneReviewer), ...await materializeAttempt(taskTwoBuilder), ...await materializeAttempt(taskTwoReviewer)];
	if (terminal) {
		const execution = validated.value.run.finalVerificationExecution;
		if (!execution || !("logPath" in execution) || !("resultPath" in execution) || execution.phase !== "failed") throw new Error("terminal fixture execution missing");
		await mkdir(dirname(execution.logPath), { recursive: true });
		await writeFile(execution.logPath, "verification log\n");
		await writeFile(execution.resultPath, "verification result\n");
		files.push(execution.logPath, execution.resultPath);
	}
	return { journal: validated.value, files };
}

function makePromptIntendedReviewer(task: TaskRecord): ManagedAgentIdentity {
	const attempt = task.attempts.at(-1);
	if (!attempt || attempt.role !== "reviewer" || attempt.dispatch.phase !== "prompted") throw new Error("prompt-intended Reviewer fixture is incomplete");
	const dispatch = attempt.dispatch;
	const identity = { name: dispatch.agentName, workspaceId: dispatch.workspaceId, paneId: dispatch.paneId, terminalId: dispatch.terminalId };
	attempt.state = "prepared";
	delete attempt.activatedAt;
	attempt.dispatch = { phase: "prompt-intended", agentName: dispatch.agentName, worktreePath: dispatch.worktreePath, workspaceId: dispatch.workspaceId, paneId: dispatch.paneId, terminalId: dispatch.terminalId, assignmentSha256: dispatch.assignmentSha256 } as ReviewerAttemptRecord["dispatch"];
	return identity;
}

function intendedRevisionStopJournal(baseJournal: RunJournal): { journal: RunJournal; identity: ManagedAgentIdentity } {
	const journal = structuredClone(baseJournal);
	const task = journal.run.tasks[1]!;
	const attempt = task.attempts.at(-1);
	if (!attempt || attempt.role !== "reviewer" || attempt.dispatch.phase !== "prompted") throw new Error("intended revision-stop fixture is incomplete");
	const dispatch = attempt.dispatch;
	const identity = { name: dispatch.agentName, workspaceId: dispatch.workspaceId, paneId: dispatch.paneId, terminalId: dispatch.terminalId };
	const beforeContract = structuredClone(task.contract);
	const beforeSpecificationVersion = task.specificationVersion;
	const beforeSpecificationHash = task.specificationHash;
	const afterContract = { ...beforeContract, requiredOutcome: "Resume-boundary revised Task 2" };
	const afterSpecificationVersion = beforeSpecificationVersion + 1;
	const afterSpecificationHash = specificationHash(afterContract);
	const confirmedAt = timestamp(50);
	attempt.state = "cancelled";
	delete attempt.activatedAt;
	attempt.dispatch = { phase: "prompt-intended", agentName: dispatch.agentName, worktreePath: dispatch.worktreePath, workspaceId: dispatch.workspaceId, paneId: dispatch.paneId, terminalId: dispatch.terminalId, assignmentSha256: dispatch.assignmentSha256 } as ReviewerAttemptRecord["dispatch"];
	attempt.revisionCancellation = {
		reason: "task-specification-revised",
		cancelledAt: confirmedAt,
		previousState: "prepared",
		oldSpecificationVersion: beforeSpecificationVersion,
		oldSpecificationHash: beforeSpecificationHash,
		replacementSpecificationVersion: afterSpecificationVersion,
		replacementSpecificationHash: afterSpecificationHash,
		owningRunRevision: 2,
		stop: { phase: "intended", intendedAt: confirmedAt, agent: identity },
	};
	task.contract = afterContract;
	task.specificationVersion = afterSpecificationVersion;
	task.specificationHash = afterSpecificationHash;
	task.phase = "pending";
	task.reworkCycles = 0;
	task.attention = "none";
	delete task.attentionReason;
	delete task.attentionDiagnostic;
	journal.journalRevision = baseJournal.journalRevision + 1;
	journal.run.updatedAt = timestamp(51);
	journal.run.revisions = [{
		revision: 2,
		confirmedAt,
		controllerSessionId: journal.run.controllerSessionId,
		basisJournalRevision: baseJournal.journalRevision,
		taskDeltas: [{
			taskId: task.contract.id,
			before: { specificationVersion: beforeSpecificationVersion, specificationHash: beforeSpecificationHash, contract: beforeContract },
			after: { specificationVersion: afterSpecificationVersion, specificationHash: afterSpecificationHash, contract: afterContract },
			priorReworkCycles: 0,
			cancelledAttemptIds: [attempt.id],
			invalidatedReviewerAttempts: [],
		}],
	}];
	const validated = validateRunJournal(journal);
	if (!validated.value || validated.diagnostics.length > 0) throw new Error(`invalid intended revision-stop fixture: ${validated.diagnostics.map((item) => item.message).join("; ")}`);
	return { journal: validated.value, identity };
}

function context(root: string, session = "revise-controller"): StewardCommandContext {
	return { mode: "tui", hasUI: true, cwd: root, modelRegistry: {} as StewardCommandContext["modelRegistry"], model: undefined, thinkingLevel: undefined, scopedModels: [], sessionManager: { getSessionId: () => session } as StewardCommandContext["sessionManager"], ui: { select: async () => undefined, input: async () => undefined, confirm: async () => false, notify() {}, setStatus() {} } };
}

function register(dependencies: StewardDependencies): { command: StewardCommandHandler; event(name: "turn_start" | "turn_end"): (event: unknown, context: StewardCommandContext) => void } {
	let command: StewardCommandHandler | undefined;
	const events = new Map<string, (event: unknown, context: StewardCommandContext) => void>();
	const surface: StewardRegistrationSurface = {
		on(name, handler) { events.set(name, handler as (event: unknown, context: StewardCommandContext) => void); },
		registerCommand(_name, options) { command = options.handler; },
	};
	registerStewardExtension(surface, () => dependencies);
	return { command: (() => { if (!command) throw new Error("Steward command was not registered"); return command; })(), event(name) { const handler = events.get(name); if (!handler) throw new Error(`missing ${name} event`); return handler; } };
}

function changedDraft(journal: RunJournal): import("../src/run.ts").RunRevisionDraft {
	return {
		tasks: journal.run.tasks.map((task) => ({ id: task.contract.id, contract: { ...task.contract, allowedScope: [...task.contract.allowedScope], expectedArtifacts: task.contract.expectedArtifacts.map((artifact) => ({ ...artifact })), verification: { ...task.contract.verification } } })),
		modelPlan: { ...journal.run.modelPlan, builder: { ...journal.run.modelPlan.builder, fallbacks: [{ model: "builder/future-v2", thinkingLevel: "low" }] }, reviewer: { ...journal.run.modelPlan.reviewer, fallbacks: journal.run.modelPlan.reviewer.fallbacks.map((choice) => ({ ...choice })) } },
	};
}

async function dependenciesFor(root: string, ui: StewardUiAdapter, options: { onStop?: StewardDependencies["herdr"]["stopAgentGracefully"]; onInspect?: (identity: ManagedAgentIdentity) => Promise<ManagedAgentInspection>; onReplace?: (count: number) => void; onModelValidation?: () => void } = {}): Promise<StewardDependencies> {
	const store = createRunJournalAdapter();
	let replacements = 0;
	const runJournal: StewardDependencies["runJournal"] = {
		...store,
		async replaceActive(repositoryRoot, journal) { replacements += 1; options.onReplace?.(replacements); return store.replaceActive(repositoryRoot, journal); },
	};
	return {
		runJournal,
		herdr: { async checkAvailability() { return { kind: "available", status: "running", running: true, compatible: true, endpointCompatible: true }; }, ...(options.onStop ? { stopAgentGracefully: options.onStop } : {}), ...(options.onInspect ? { inspectManagedAgent: options.onInspect } : {}) },
		git: { async inspectIntegrationBase() { return { kind: "ready", branch: "main", revision: baseRevision }; } },
		process: {},
		model: { listModelChoices: () => [], async validateModelPlans() { options.onModelValidation?.(); return []; } },
		clock: { now: () => new Date("2026-09-20T00:00:00.000Z"), randomUUID: () => "00000000-0000-0000-0000-000000000017" },
		ui,
	};
}

afterEach(async () => { for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true }); });

describe("ticket-17 registered active-Run revision", () => {
	it("records the exact identity of a prompt-intended Attempt before graceful stop", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-revise-prompt-intended-"));
		roots.push(root);
		const fixtureValue = await fixture(root);
		const identity = makePromptIntendedReviewer(fixtureValue.journal.run.tasks[1]!);
		const store = createRunJournalAdapter();
		expect((await store.createActive(root, fixtureValue.journal)).kind).toBe("created");
		let stopInput: { repositoryRoot: string; name: string; workspaceId: string; paneId: string; terminalId: string } | undefined;
		const ui: StewardUiAdapter = {
			presentStatus() {},
			presentStartResult() {},
			presentConfigurationResult() {},
			async editConfiguration() { return { kind: "cancelled" }; },
			async draftRun() { return { kind: "cancelled" }; },
			async confirmRun() { return false; },
			async draftRunRevision() {
				const draft = changedDraft(fixtureValue.journal);
				draft.tasks[1]!.contract.requiredOutcome = "Prompt-intended revised Task 2";
				return { kind: "drafted", draft };
			},
			async confirmRunRevision() { return true; },
			presentRevisionResult() {},
		};
		const dependencies = await dependenciesFor(root, ui, {
			onStop: async (input) => {
				stopInput = input;
				return { kind: "acknowledged", name: input.name, workspaceId: input.workspaceId, paneId: input.paneId, terminalId: input.terminalId, tabId: "prompt-intended-tab" };
			},
		});
		await register(dependencies).command("revise", context(root));
		expect(stopInput).toEqual({ repositoryRoot: root, ...identity });
		const loaded = await store.loadActive(root);
		expect(loaded.kind).toBe("loaded");
		if (loaded.kind !== "loaded") return;
		const cancelled = loaded.journal.run.tasks[1]!.attempts.find((attempt) => attempt.id === "attempt-02");
		expect(cancelled?.state).toBe("cancelled");
		expect(cancelled?.revisionCancellation?.stop).toMatchObject({ phase: "acknowledged", agent: identity });
	});

	it.each(["missing", "live", "unclear"] as const)("registered resume reconciles an intended revision stop when the exact Agent is %s", async (scenario) => {
		const root = await mkdtemp(join(tmpdir(), `pi-herdr-revise-stop-${scenario}-`));
		roots.push(root);
		const fixtureValue = await fixture(root);
		const store = createRunJournalAdapter();
		expect((await store.createActive(root, fixtureValue.journal)).kind).toBe("created");
		const intended = intendedRevisionStopJournal(fixtureValue.journal);
		expect((await store.replaceActive(root, intended.journal)).kind).toBe("replaced");
		let inspectedIdentity: ManagedAgentIdentity | undefined;
		let stopCalls = 0;
		const ui: StewardUiAdapter = {
			presentStatus() {},
			presentStartResult() {},
			presentConfigurationResult() {},
			async editConfiguration() { return { kind: "cancelled" }; },
			async draftRun() { return { kind: "cancelled" }; },
			async confirmRun() { return false; },
			presentResumeResult() {},
		};
		const dependencies = await dependenciesFor(root, ui, {
			onInspect: async (identity) => {
				inspectedIdentity = identity;
				if (scenario === "missing") return { kind: "missing", diagnostic: "exact revision-stop Agent is absent" };
				if (scenario === "unclear") return { kind: "unclear", diagnostic: "exact revision-stop Agent is unclear" };
				return { kind: "observed", identity, lifecycle: "working", stateChangeSequence: 7 };
			},
			onStop: async (input) => {
				stopCalls += 1;
				return { kind: "acknowledged", name: input.name, workspaceId: input.workspaceId, paneId: input.paneId, terminalId: input.terminalId, tabId: "resume-stop-tab" };
			},
		});
		await register(dependencies).command("resume", context(root));
		expect(inspectedIdentity).toEqual(intended.identity);
		expect(stopCalls).toBe(scenario === "live" ? 1 : 0);
		const loaded = await store.loadActive(root);
		expect(loaded.kind).toBe("loaded");
		if (loaded.kind !== "loaded") return;
		const task = loaded.journal.run.tasks[1]!;
		const cancellation = task.attempts.find((attempt) => attempt.id === "attempt-02")?.revisionCancellation;
		if (scenario === "unclear") {
			expect(cancellation?.stop).toMatchObject({ phase: "ambiguous", agent: intended.identity });
			expect(task.attention).toBe("needs-user");
			expect(task.attentionReason).toBe("revision-stop-ambiguous");
		} else {
			expect(cancellation?.stop).toMatchObject({ phase: "acknowledged", agent: intended.identity });
			expect(task.attention).toBe("none");
		}
	});

	it("revises only Task 2 through the real handler, stops after the CAS, and preserves Task 1 and evidence", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-revise-"));
		roots.push(root);
		const fixtureValue = await fixture(root);
		const store = createRunJournalAdapter();
		expect((await store.createActive(root, fixtureValue.journal)).kind).toBe("created");
		const initialLoad = await store.loadActive(root);
		if (initialLoad.kind !== "loaded") throw new Error("revision fixture was not stored");
		const pathsValue = initialLoad.paths;
		const beforeBytes = await readFile(pathsValue.activePath);
		const beforeTaskOne = structuredClone(fixtureValue.journal.run.tasks[0]);
		const beforeFiles = new Map<string, { bytes: Buffer; mode: number }>();
		for (const file of fixtureValue.files) beforeFiles.set(file, { bytes: await readFile(file), mode: (await lstat(file)).mode });
		const calls = { draft: 0, confirm: 0, modelValidation: 0, replace: 0, stop: 0 };
		let summary = "";
		let revisedTaskTwoHash = "";
		let stopObserved: RunJournal | undefined;
		const ui: StewardUiAdapter = {
			presentStatus() {},
			presentStartResult() {},
			presentConfigurationResult() {},
			async editConfiguration() { return { kind: "cancelled" }; },
			async draftRun() { return { kind: "cancelled" }; },
			async confirmRun() { return false; },
			async draftRunRevision(input) {
				calls.draft += 1;
				expect(await readFile(pathsValue.activePath)).toEqual(beforeBytes);
				const draft = changedDraft(fixtureValue.journal);
				draft.tasks[1]!.contract.requiredOutcome = "Revised Task 2";
				draft.tasks[1]!.contract.allowedScope = ["src/task-two-revised"];
				revisedTaskTwoHash = specificationHash(draft.tasks[1]!.contract);
				expect(input.runId).toBe(fixtureValue.journal.run.id);
				return { kind: "drafted", draft };
			},
			async confirmRunRevision(value) {
				calls.confirm += 1;
				summary = value.markdown;
				expect(await readFile(pathsValue.activePath)).toEqual(beforeBytes);
				expect(summary).toContain("task-02: specification 1 -> 2");
				expect(summary).toContain(`hash: ${fixtureValue.journal.run.tasks[1]!.specificationHash} -> ${revisedTaskTwoHash}`);
				expect(summary).toContain("requiredOutcome: Complete Task 2 -> Revised Task 2");
				expect(summary).toContain("allowedScope: src/task-two -> src/task-two-revised");
				expect(summary).toContain("Review invalidations: attempt-02 cancelled");
				expect(summary).not.toContain("task-01 invalidation");
				expect(summary).toContain("task-01 preserved exactly");
				expect(summary).toContain("Builder Model Plan");
				expect(summary).toContain("builder/future-v2");
				return true;
			},
			presentRevisionResult() {},
		};
		const dependencies = await dependenciesFor(root, ui, {
			onReplace: (count) => { calls.replace = count; },
			onModelValidation: () => { calls.modelValidation += 1; },
			onStop: async (input) => {
				calls.stop += 1;
				expect(calls.replace).toBe(1);
				const loaded = await store.loadActive(root);
				expect(loaded.kind).toBe("loaded");
				if (loaded.kind !== "loaded") throw new Error("revision Journal disappeared before stop");
				stopObserved = loaded.journal;
				const changedTask = loaded.journal.run.tasks[1]!;
				const cancelled = changedTask.attempts.find((attempt) => attempt.id === "attempt-02");
				expect(loaded.journal.run.revisions?.[0]?.revision).toBe(2);
				expect(changedTask.specificationVersion).toBe(2);
				expect(cancelled?.state).toBe("cancelled");
				expect(cancelled?.revisionCancellation?.stop.phase).toBe("intended");
				return { kind: "acknowledged", name: input.name, workspaceId: input.workspaceId, paneId: input.paneId, terminalId: input.terminalId, tabId: "stopped-tab" };
			},
		});
		const registered = register(dependencies);
		await registered.command("revise", context(root));
		expect(calls).toMatchObject({ draft: 1, confirm: 1, modelValidation: 1, replace: 2, stop: 1 });
		expect(stopObserved).toBeDefined();
		const loaded = await store.loadActive(root);
		expect(loaded.kind).toBe("loaded");
		if (loaded.kind !== "loaded") return;
		const taskOne = loaded.journal.run.tasks[0]!;
		const taskTwo = loaded.journal.run.tasks[1]!;
		expect(taskOne).toEqual(beforeTaskOne);
		expect(taskTwo.phase).toBe("pending");
		expect(taskTwo.specificationVersion).toBe(2);
		expect(taskTwo.specificationHash).toBe(specificationHash(taskTwo.contract));
		expect(taskTwo.contract.requiredOutcome).toBe("Revised Task 2");
		expect(taskTwo.contract.allowedScope).toEqual(["src/task-two-revised"]);
		expect(taskTwo.reworkCycles).toBe(0);
		expect(taskTwo.attempts[0]?.state).toBe("reported");
		expect(taskTwo.attempts[0]?.evidence).toEqual(fixtureValue.journal.run.tasks[1]!.attempts[0]!.evidence);
		expect(taskTwo.attempts[1]?.state).toBe("cancelled");
		expect(taskTwo.attempts[1]?.revisionCancellation?.stop.phase).toBe("acknowledged");
		expect(loaded.journal.run.modelPlan.builder.fallbacks[0]?.model).toBe("builder/future-v2");
		expect(loaded.journal.run.modelPlan.reviewer).toEqual(fixtureValue.journal.run.modelPlan.reviewer);
		expect(taskTwo.attempts[1]?.actualModel).toEqual(fixtureValue.journal.run.tasks[1]!.attempts[1]?.actualModel);
		expect(loaded.journal.run.revisions).toHaveLength(1);
		expect(loaded.journal.run.revisions?.[0]?.taskDeltas).toHaveLength(1);
		expect(loaded.journal.run.revisions?.[0]?.taskDeltas[0]?.taskId).toBe("task-02");
		expect(loaded.journal.run.revisions?.[0]?.taskDeltas[0]?.before.specificationVersion).toBe(1);
		expect(loaded.journal.run.revisions?.[0]?.taskDeltas[0]?.after.specificationVersion).toBe(2);
		expect(loaded.journal.run.revisions?.[0]?.taskDeltas[0]?.cancelledAttemptIds).toEqual(["attempt-02"]);
		for (const [file, before] of beforeFiles) {
			expect(await readFile(file)).toEqual(before.bytes);
			expect((await lstat(file)).mode).toBe(before.mode);
		}
		const activity = await readFile(join(pathsValue.activityRoot, fixtureValue.journal.run.id, "activity.log"), "utf8");
		expect(activity.match(/run-revised/g)).toHaveLength(1);
	});

	it("moves terminal invalidation facts while keeping the prior integrated head as the next admission base", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-revise-terminal-"));
		roots.push(root);
		const fixtureValue = await fixture(root, true);
		const store = createRunJournalAdapter();
		expect((await store.createActive(root, fixtureValue.journal)).kind).toBe("created");
		const ui: StewardUiAdapter = {
			presentStatus() {}, presentStartResult() {}, presentConfigurationResult() {}, async editConfiguration() { return { kind: "cancelled" }; }, async draftRun() { return { kind: "cancelled" }; }, async confirmRun() { return false; }, presentRevisionResult() {},
			async draftRunRevision() {
				const draft = changedDraft(fixtureValue.journal);
				draft.tasks[1]!.contract.requiredOutcome = "Terminally revised Task 2";
				return { kind: "drafted", draft };
			},
			async confirmRunRevision() { return true; },
		};
		const dependencies = await dependenciesFor(root, ui);
		await register(dependencies).command("revise", context(root));
		const loaded = await store.loadActive(root);
		expect(loaded.kind).toBe("loaded");
		if (loaded.kind !== "loaded") return;
		const taskOne = loaded.journal.run.tasks[0]!;
		const taskTwo = loaded.journal.run.tasks[1]!;
		expect(taskOne.phase).toBe("completed");
		expect(taskTwo.phase).toBe("pending");
		expect(taskTwo.approval?.phase).toBe("invalidated");
		if (taskTwo.approval?.phase !== "invalidated") throw new Error("Task 2 Approval was not invalidated");
		expect(taskTwo.approval.reason).toBe("task-specification-revised");
		expect(taskTwo.integration).toBeUndefined();
		expect(loaded.journal.run.finalVerificationExecution).toBeUndefined();
		const delta = loaded.journal.run.revisions?.[0]?.taskDeltas[0];
		expect(delta?.priorIntegration?.phase).toBe("integrated");
		if (delta?.priorIntegration?.phase !== "integrated") throw new Error("Task 2 integration history was not retained");
		expect(delta.priorIntegration.observedHead).toBe(taskTwoHead);
		expect(loaded.journal.run.revisions?.[0]?.invalidatedFinalVerification?.execution.phase).toBe("failed");
		const admission = selectTaskAdmission(loaded.journal.run);
		expect(admission).toMatchObject({ kind: "admit", taskId: "task-02", baseRevision: taskTwoHead });
	});

	it("records a Model Plan-only revision without cancelling or rewriting active Task facts", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-revise-model-only-"));
		roots.push(root);
		const fixtureValue = await fixture(root);
		const store = createRunJournalAdapter();
		expect((await store.createActive(root, fixtureValue.journal)).kind).toBe("created");
		const beforeTasks = structuredClone(fixtureValue.journal.run.tasks);
		let result: import("../src/steward.ts").RevisionResult | undefined;
		const ui: StewardUiAdapter = {
			presentStatus() {}, presentStartResult() {}, presentConfigurationResult() {}, async editConfiguration() { return { kind: "cancelled" }; }, async draftRun() { return { kind: "cancelled" }; }, async confirmRun() { return false; },
			presentRevisionResult(value) { result = value; },
			async draftRunRevision() { return { kind: "drafted", draft: changedDraft(fixtureValue.journal) }; },
			async confirmRunRevision() { return true; },
		};
		const calls = { replace: 0, stop: 0 };
		const dependencies = await dependenciesFor(root, ui, { onReplace: (count) => { calls.replace = count; }, onStop: async () => { calls.stop += 1; throw new Error("Model-only revision must not stop an active Attempt."); } });
		await register(dependencies).command("revise", context(root));
		expect(result?.kind).toBe("revised");
		expect(calls).toEqual({ replace: 1, stop: 0 });
		const loaded = await store.loadActive(root);
		expect(loaded.kind).toBe("loaded");
		if (loaded.kind !== "loaded") return;
		expect(loaded.journal.run.tasks).toEqual(beforeTasks);
		expect(loaded.journal.run.revisions?.[0]?.taskDeltas).toEqual([]);
		expect(loaded.journal.run.revisions?.[0]?.modelPlanDelta?.after.builder.fallbacks[0]?.model).toBe("builder/future-v2");
		expect(loaded.journal.run.tasks[1]?.attempts[1]?.actualModel).toEqual(beforeTasks[1]?.attempts[1]?.actualModel);
	});

	it("loses a post-confirmation Journal race without a revision, activity, stop, or partial invalidation", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-revise-race-"));
		roots.push(root);
		const fixtureValue = await fixture(root);
		const store = createRunJournalAdapter();
		expect((await store.createActive(root, fixtureValue.journal)).kind).toBe("created");
		const calls = { replace: 0, stop: 0 };
		let result: import("../src/steward.ts").RevisionResult | undefined;
		const ui: StewardUiAdapter = {
			presentStatus() {}, presentStartResult() {}, presentConfigurationResult() {}, async editConfiguration() { return { kind: "cancelled" }; }, async draftRun() { return { kind: "cancelled" }; }, async confirmRun() { return false; },
			presentRevisionResult(value) { result = value; },
			async draftRunRevision() { const draft = changedDraft(fixtureValue.journal); draft.tasks[1]!.contract.requiredOutcome = "Raced revision"; return { kind: "drafted", draft }; },
			async confirmRunRevision() {
				const loaded = await store.loadActive(root);
				if (loaded.kind !== "loaded") throw new Error("Race fixture lost its active Journal");
				const raced = structuredClone(loaded.journal);
				raced.journalRevision += 1;
				raced.run.updatedAt = timestamp(1);
				expect((await store.replaceActive(root, raced)).kind).toBe("replaced");
				return true;
			},
		};
		const dependencies = await dependenciesFor(root, ui, { onReplace: (count) => { calls.replace = count; }, onStop: async () => { calls.stop += 1; throw new Error("A raced revision must not stop an Agent."); } });
		await register(dependencies).command("revise", context(root));
		expect(result?.kind).toBe("stale");
		expect(calls).toEqual({ replace: 0, stop: 0 });
		const loaded = await store.loadActive(root);
		expect(loaded.kind).toBe("loaded");
		if (loaded.kind !== "loaded") return;
		expect(loaded.journal.journalRevision).toBe(2);
		expect(loaded.journal.run.revisions).toBeUndefined();
		expect(loaded.journal.run.tasks[1]?.contract.requiredOutcome).toBe("Complete Task 2");
	});

	it("records ambiguous revision stops and blocks the next resume pass", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-revise-ambiguous-"));
		roots.push(root);
		const fixtureValue = await fixture(root);
		const store = createRunJournalAdapter();
		expect((await store.createActive(root, fixtureValue.journal)).kind).toBe("created");
		let result: import("../src/steward.ts").RevisionResult | undefined;
		let stopCalls = 0;
		const ui: StewardUiAdapter = {
			presentStatus() {}, presentStartResult() {}, presentConfigurationResult() {}, async editConfiguration() { return { kind: "cancelled" }; }, async draftRun() { return { kind: "cancelled" }; }, async confirmRun() { return false; },
			presentRevisionResult(value) { result = value; },
			async draftRunRevision() { const draft = changedDraft(fixtureValue.journal); draft.tasks[1]!.contract.requiredOutcome = "Ambiguous stop"; return { kind: "drafted", draft }; },
			async confirmRunRevision() { return true; },
		};
		const dependencies = await dependenciesFor(root, ui, { onStop: async () => { stopCalls += 1; return { kind: "ambiguous", message: "stop acknowledgement was unclear" }; } });
		const registered = register(dependencies);
		await registered.command("revise", context(root));
		expect(result?.kind).toBe("ambiguous");
		await registered.command("resume", context(root));
		expect(stopCalls).toBe(1);
		const loaded = await store.loadActive(root);
		expect(loaded.kind).toBe("loaded");
		if (loaded.kind !== "loaded") return;
		const task = loaded.journal.run.tasks[1]!;
		expect(task.phase).toBe("pending");
		expect(task.attention).toBe("needs-user");
		expect(task.attentionReason).toBe("revision-stop-ambiguous");
		expect(task.attempts[1]?.revisionCancellation?.stop.phase).toBe("ambiguous");
	});

	it("keeps foreign, confirmation-cancelled, no-op, raced, invalid, and ordinary-conversation paths read-only", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-revise-authority-"));
		roots.push(root);
		const fixtureValue = await fixture(root);
		const store = createRunJournalAdapter();
		expect((await store.createActive(root, fixtureValue.journal)).kind).toBe("created");
		const initialLoad = await store.loadActive(root);
		if (initialLoad.kind !== "loaded") throw new Error("authority fixture was not stored");
		const activePath = initialLoad.paths.activePath;
		const before = await readFile(activePath);
		const calls = { draft: 0, confirm: 0, replace: 0, stop: 0 };
		const ui: StewardUiAdapter = {
			presentStatus() {}, presentStartResult() {}, presentConfigurationResult() {}, async editConfiguration() { return { kind: "cancelled" }; }, async draftRun() { return { kind: "cancelled" }; }, async confirmRun() { return false; }, presentRevisionResult() {},
			async draftRunRevision() { calls.draft += 1; const draft = changedDraft(fixtureValue.journal); draft.tasks[1]!.contract.requiredOutcome = "Confirmation-cancelled"; return { kind: "drafted", draft }; },
			async confirmRunRevision() { calls.confirm += 1; return false; },
		};
		const dependencies = await dependenciesFor(root, ui, { onReplace: (count) => { calls.replace = count; }, onStop: async (input) => { calls.stop += 1; return { kind: "acknowledged", name: input.name, workspaceId: input.workspaceId, paneId: input.paneId, terminalId: input.terminalId, tabId: "tab" }; } });
		const registered = register(dependencies);
		await registered.command("revise", context(root, "foreign-controller"));
		expect(calls).toEqual({ draft: 0, confirm: 0, replace: 0, stop: 0 });
		expect(await readFile(activePath)).toEqual(before);
		await registered.command("revise", context(root));
		expect(calls).toMatchObject({ draft: 1, confirm: 1, replace: 0, stop: 0 });
		expect(await readFile(activePath)).toEqual(before);

		const noOpUi: StewardUiAdapter = { ...ui, async draftRunRevision() { calls.draft += 1; return { kind: "drafted", draft: { tasks: fixtureValue.journal.run.tasks.map((task) => ({ id: task.contract.id, contract: structuredClone(task.contract) })), modelPlan: structuredClone(fixtureValue.journal.run.modelPlan) } }; } };
		const noOpRegistered = register(await dependenciesFor(root, noOpUi));
		await noOpRegistered.command("revise", context(root));
		expect(await readFile(activePath)).toEqual(before);
		await registered.command("status nonsense", context(root));
		await registered.event("turn_start")({}, context(root));
		await registered.event("turn_end")({}, context(root));
		expect(await readFile(activePath)).toEqual(before);
	});
});
