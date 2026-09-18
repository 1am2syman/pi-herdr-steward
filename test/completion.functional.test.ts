import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRunJournalAdapter } from "../src/adapters.ts";
import { registerStewardExtension, type StewardCommandContext, type StewardCommandHandler, type StewardRegistrationSurface } from "../src/extension.ts";
import { builderAssignmentSha256, deserializeRunJournal, evaluateCompletionGate, type RunDraft, type RunJournal } from "../src/run.ts";
import { resolveRunJournalPaths } from "../src/run-journal-store.ts";
import { serializeBuilderAttemptReport, type BuilderAttemptReport } from "../src/attempt-report.ts";
import { deserializeReviewerAssignment, serializeReviewerAttemptReport, type ReviewerAttemptReport } from "../src/review.ts";
import type { ModelChoice, ProjectModelPlans, RecoveryDefaults } from "../src/config.ts";
import { createSteward } from "../src/steward.ts";
import type { GitCommandOutcome, HerdrStopResult, IntegrationCheckoutInput, IntegrationCheckoutResult, StewardDependencies, StewardUiAdapter, StatusView, VerificationProcessOutcome } from "../src/steward.ts";

const roots: string[] = [];
const baseRevision = "0123456789abcdef0123456789abcdef01234567";
const commits = ["1111111111111111111111111111111111111111", "2222222222222222222222222222222222222222"];
const headRevision = commits[1]!;
const fingerprint = `sha256:${"a".repeat(64)}`;
const recovery: RecoveryDefaults = { passiveInspectionIntervalSeconds: 301, secondInspectionAndNudgeIntervalSeconds: 302, nudgeGracePeriodSeconds: 121, externalCommandWarningThresholdSeconds: 1801, maximumActiveTasks: 1, transientRetryLimit: 1, reworkCycleLimit: 4 };
const modelPlan: ProjectModelPlans = { builder: { primary: { model: "builder/model", thinkingLevel: "high" }, fallbacks: [] }, reviewer: { primary: { model: "reviewer/model", thinkingLevel: "high" }, fallbacks: [] } };

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function sha(bytes: Buffer): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

function draft(): RunDraft {
	return { declaredOutcome: "Complete one approved change", tasks: [{ requiredOutcome: "Implement the change", allowedScope: ["src"], expectedArtifacts: [{ kind: "git-commit" }, { kind: "file", path: "src/change.ts" }], verification: { kind: "command", command: "npm test" }, reviewRequired: true }], modelPlan, effectiveSettings: recovery, finalVerification: { kind: "command", command: "npm test" } };
}

function criteriaDraft(): RunDraft {
	const value = draft();
	const criteria = { kind: "criteria" as const, criteria: "The approved change is complete.", deterministicCommandWaiver: "reviewer-confirmed" };
	return { ...value, tasks: value.tasks.map((task) => ({ ...task, verification: criteria })), finalVerification: criteria };
}

function context(root: string): StewardCommandContext {
	return { mode: "tui", hasUI: true, cwd: root, modelRegistry: {} as StewardCommandContext["modelRegistry"], model: undefined, thinkingLevel: undefined, scopedModels: [], sessionManager: { getSessionId: () => "controller-session" } as StewardCommandContext["sessionManager"], ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined, notify() {}, setStatus() {} } };
}

function registered(dependencies: StewardDependencies): () => StewardCommandHandler {
	let handler: StewardCommandHandler | undefined;
	const surface: StewardRegistrationSurface = { on() {}, registerCommand(_name, options) { handler = options.handler; } };
	registerStewardExtension(surface, () => dependencies);
	return () => { if (!handler) throw new Error("Steward command was not registered"); return handler; };
}

async function invoke(root: string, dependencies: StewardDependencies, command: string): Promise<StatusView> {
	let view: StatusView | undefined;
	dependencies.ui = { ...dependencies.ui, presentStatus(value) { view = value; } };
	await registered(dependencies)()(command, context(root));
	if (!view) throw new Error("registered status did not present a view");
	return view;
}

interface FakeCompletionOptions {
	draft?: RunDraft;
	inspectIntegrationCheckout?: (input: IntegrationCheckoutInput, normal: IntegrationCheckoutResult) => IntegrationCheckoutResult;
	integrateApprovedRange?: (input: Parameters<NonNullable<StewardDependencies["git"]["integrateApprovedRange"]>>[0]) => GitCommandOutcome;
	runApprovedVerification?: (input: { cwd: string; command: string }) => VerificationProcessOutcome;
	stopAgentGracefully?: (input: { repositoryRoot: string; name: string; workspaceId: string; paneId: string; terminalId: string }) => HerdrStopResult;
}

function dependencies(root: string, effects: { merges: number; processes: number; stops: string[]; notifications: number; state: "base" | "integrated" }, options: FakeCompletionOptions = {}): StewardDependencies {
	const runJournal = createRunJournalAdapter();
	const builderPath = join(root, "builder-worktree");
	let uuid = 0;
	const ui: StewardUiAdapter = {
		presentStatus() {},
		async editConfiguration() { return { kind: "cancelled" }; },
		presentConfigurationResult() {},
		async draftRun() { return { kind: "drafted" as const, draft: options.draft ?? draft() }; },
		async confirmRun() { return true; },
		presentStartResult() {},
		notifyCompletion() { effects.notifications += 1; },
	};
	const checkout = (): IntegrationCheckoutResult => ({ kind: "inspected", observation: { branch: "main", head: effects.state === "base" ? baseRevision : headRevision, dirtyPaths: [], operationMarkers: [], rangeExact: true }, resolvedBaseRevision: baseRevision, resolvedHeadRevision: headRevision, commits: [...commits] });
		return {
			runJournal,
			herdr: {
			async checkAvailability() { return { kind: "available", status: "running", running: true, compatible: true, endpointCompatible: true }; },
			async createBuilderWorktree(input) { return { kind: "created", branch: input.branch, path: builderPath, workspaceId: "workspace-1", tabId: "tab-1", paneId: "builder-pane", terminalId: "builder-terminal" }; },
			async startBuilder(input) { return { kind: "started", name: input.name, agentKind: "pi", workspaceId: "workspace-1", tabId: "tab-1", paneId: "builder-pane", terminalId: "builder-terminal" }; },
			async promptBuilder(input) { return { kind: "prompted", name: input.name, workspaceId: "workspace-1", tabId: "tab-1", paneId: "builder-pane", terminalId: "builder-terminal" }; },
			async createReviewerPane(input) { return { kind: "created", workspaceId: input.workspaceId, tabId: "tab-2", paneId: "reviewer-pane", terminalId: "reviewer-terminal", sourcePaneId: input.sourcePaneId, worktreePath: input.worktreePath }; },
			async startReviewer(input) { return { kind: "started", name: input.name, agentKind: "pi", workspaceId: "workspace-1", tabId: "tab-2", paneId: "reviewer-pane", terminalId: "reviewer-terminal" }; },
			async promptReviewer(input) { return { kind: "prompted", name: input.name, workspaceId: "workspace-1", tabId: "tab-2", paneId: "reviewer-pane", terminalId: "reviewer-terminal" }; },
			async stopAgentGracefully(input) { effects.stops.push(input.name); return options.stopAgentGracefully ? options.stopAgentGracefully(input) : { kind: "acknowledged", name: input.name, workspaceId: input.workspaceId, tabId: "tab-1", paneId: input.paneId, terminalId: input.terminalId }; },
		},
		git: {
			async inspectIntegrationBase() { return { kind: "ready", branch: "main", revision: baseRevision }; },
			async branchExists() { return false; },
			async inspectBuilderWorktree(_path, expectedRevision) { return { kind: "ready", head: expectedRevision, clean: true }; },
			async inspectProducedCodeArtifact(input) { return { kind: "inspected", base: baseRevision, head: input.producedHead, commits: [...commits], changedPaths: [{ status: "M", paths: ["src/change.ts"] }], clean: true }; },
			async inspectReviewWorktree() { return { head: headRevision, dirtyStateFingerprint: fingerprint, dirtyPaths: [], operationMarkers: [] }; },
			async inspectIntegrationCheckout(input) { const normal = checkout(); return options.inspectIntegrationCheckout?.(input, normal) ?? normal; },
			async integrateApprovedRange(input) { effects.merges += 1; effects.state = "integrated"; return options.integrateApprovedRange?.(input) ?? { kind: "completed", code: 0, stdout: "fast-forward\n", stderr: "", killed: false }; },
		},
		process: { async runApprovedVerification(input) { effects.processes += 1; expect(input).toEqual({ cwd: root, command: "npm test" }); return options.runApprovedVerification?.(input) ?? { kind: "completed", code: 0, stdout: "all good\n", stderr: "", killed: false }; } },
		model: { listModelChoices: () => [], async validateModelPlans() { return []; }, async inspectModelChoice(choice) { return { choice, available: true, diagnostics: [] }; } },
		clock: { now: () => new Date("2026-09-18T00:00:00.000Z"), randomUUID: () => `01234567-89ab-cdef-0123-456789abcde${++uuid}` },
		ui,
	};
}

async function start(root: string, deps: StewardDependencies): Promise<RunJournal> {
	await mkdir(join(builderPath(root), "src"), { recursive: true });
	await registered(deps)()("start", context(root));
	const result = await deps.runJournal.loadActive(root);
	if (result.kind !== "loaded") throw new Error("Run was not created");
	return result.journal;
}

function builderPath(root: string): string { return join(root, "builder-worktree"); }

async function writeBuilder(root: string, journal: RunJournal): Promise<void> {
	const task = journal.run.tasks[0]!;
	const attempt = task.attempts[0]!;
	if (attempt.role !== "builder") throw new Error("Builder missing");
	const assignment = JSON.parse(await readFile(attempt.assignmentPath, "utf8")) as { assignment: { actualModel: BuilderAttemptReport["actualModel"]; specificationHash: string; worktree: { path: string } } };
	const artifact = Buffer.from("approved\n");
	const evidencePath = join(attempt.evidenceDirectory, "artifact.snapshot");
	const logPath = join(attempt.evidenceDirectory, "check.log");
	await writeFile(join(builderPath(root), "src", "change.ts"), artifact);
	await writeFile(evidencePath, artifact);
	await writeFile(logPath, "pass\n");
	const checks: BuilderAttemptReport["checks"] = task.contract.verification.kind === "criteria"
		? [{ kind: "criteria", criteria: task.contract.verification.criteria, result: "met", summary: "met", logId: "check-1" }]
		: [{ kind: "command", command: "npm test", exitCode: 0, summary: "pass", logId: "check-1" }];
	const report: BuilderAttemptReport = { schemaVersion: 1, identity: { runId: journal.run.id, taskId: task.contract.id, attemptId: attempt.id, role: "builder", specificationHash: assignment.assignment.specificationHash, assignmentSha256: builderAssignmentSha256(await readFile(attempt.assignmentPath, "utf8")) }, status: "completed", summary: "Builder completed.", blockers: [], producedArtifacts: [{ kind: "git-commit", baseRevision, headRevision, commits }, { kind: "file", path: "src/change.ts", evidencePath, size: artifact.length, sha256: sha(artifact) }], actualModel: assignment.assignment.actualModel, checks, logReferences: [{ id: "check-1", path: logPath, size: 5, sha256: sha(Buffer.from("pass\n")) }], producedRevision: headRevision };
	await writeFile(attempt.reportPath, serializeBuilderAttemptReport(report));
}

async function writeReviewer(journal: RunJournal): Promise<void> {
	const task = journal.run.tasks[0]!;
	const attempt = task.attempts[1]!;
	if (attempt.role !== "reviewer") throw new Error("Reviewer missing");
	const assignment = deserializeReviewerAssignment(await readFile(attempt.assignmentPath, "utf8"));
	if (!assignment.value) throw new Error("Reviewer assignment is invalid");
	const report: ReviewerAttemptReport = { schemaVersion: 1, identity: { runId: journal.run.id, taskId: task.contract.id, attemptId: attempt.id, role: "reviewer", specificationHash: attempt.specificationHash, assignmentSha256: sha(Buffer.from(await readFile(attempt.assignmentPath, "utf8"))) }, status: "completed", summary: "Approved.", blockers: [], actualModel: attempt.actualModel, reviewedSubject: assignment.value.assignment.subject, verdict: "approved", findings: [], checks: [], logReferences: [] };
	await writeFile(attempt.reportPath, serializeReviewerAttemptReport(report));
}

async function prepareReviewer(root: string, deps: StewardDependencies): Promise<{ started: RunJournal; reviewerDispatch: RunJournal }> {
	const started = await start(root, deps);
	await writeBuilder(root, started);
	await invoke(root, deps, "status");
	const reviewerDispatch = await deps.runJournal.loadActive(root);
	if (reviewerDispatch.kind !== "loaded") throw new Error("Reviewer dispatch did not persist");
	await writeReviewer(reviewerDispatch.journal);
	return { started, reviewerDispatch: reviewerDispatch.journal };
}

async function reachApproved(root: string, deps: StewardDependencies): Promise<RunJournal> {
	await prepareReviewer(root, deps);
	const inspect = deps.git.inspectIntegrationCheckout;
	deps.git.inspectIntegrationCheckout = undefined;
	await invoke(root, deps, "status");
	deps.git.inspectIntegrationCheckout = inspect;
	const approved = await deps.runJournal.loadActive(root);
	if (approved.kind !== "loaded") throw new Error("Approved state did not persist");
	if (approved.journal.run.tasks[0]?.phase !== "approved") throw new Error(`Expected approved state, got ${approved.journal.run.tasks[0]?.phase}`);
	return approved.journal;
}

async function reachIntegrated(root: string, deps: StewardDependencies): Promise<RunJournal> {
	await reachApproved(root, deps);
	const process = deps.process;
	deps.process = {} as typeof deps.process;
	await invoke(root, deps, "status");
	deps.process = process;
	const integrated = await deps.runJournal.loadActive(root);
	if (integrated.kind !== "loaded") throw new Error("Integrated state did not persist");
	if (integrated.journal.run.tasks[0]?.integration?.phase !== "integrated") throw new Error(`Expected integrated state, got ${integrated.journal.run.tasks[0]?.integration?.phase}`);
	return integrated.journal;
}

describe("ticket-08 registered completion flow", () => {
	it("takes one confirmed Run through integration, verification, stop, archive, and one notification", async () => {
		const root = await mkdtemp(join(tmpdir(), "steward-t08-flow-"));
		roots.push(root);
		const effects: { merges: number; processes: number; stops: string[]; notifications: number; state: "base" | "integrated" } = { merges: 0, processes: 0, stops: [], notifications: 0, state: "base" };
		const deps = dependencies(root, effects);
		const journal = await start(root, deps);
		await writeBuilder(root, journal);
		await invoke(root, deps, "status");
		const afterReviewDispatch = await deps.runJournal.loadActive(root);
		expect(afterReviewDispatch.kind).toBe("loaded");
		if (afterReviewDispatch.kind !== "loaded") return;
		await writeReviewer(afterReviewDispatch.journal);
		const finalView = await invoke(root, deps, "status");
		expect(finalView).toMatchObject({ kind: "present", completed: true });
		expect(effects.merges).toBe(1);
		expect(effects.processes).toBe(1);
		expect(effects.stops).toHaveLength(2);
		expect(new Set(effects.stops).size).toBe(2);
		expect(effects.notifications).toBe(1);
		expect((await deps.runJournal.probeActive(root))).toBe("missing");
		const state = await deps.runJournal.loadActive(root);
		expect(state.kind).toBe("missing");
		expect(await readFile(afterReviewDispatch.journal.run.tasks[0]!.attempts[0]!.reportPath, "utf8")).toContain("Builder completed.");
		expect(await readFile(afterReviewDispatch.journal.run.tasks[0]!.attempts[1]!.reportPath, "utf8")).toContain("Approved.");
		const archiveRoot = join(root, ".pi", "steward", "archives");
		const archives = await readdir(archiveRoot);
		expect(archives).toHaveLength(1);
		const archivedRun = JSON.parse(await readFile(join(archiveRoot, archives[0]!, "run.json"), "utf8")) as { run: { status: string; completion?: { phase: string }; tasks: Array<{ attempts: Array<{ role: string }> }> } };
		expect(archivedRun.run.status).toBe("completed");
		expect(archivedRun.run.completion?.phase).toBe("archived");
		expect(archivedRun.run.tasks[0]?.attempts.map((attempt) => attempt.role)).toEqual(["builder", "reviewer"]);
		expect(await readFile(join(archiveRoot, archives[0]!, "reports", "task-01", "attempt-01-builder.md"), "utf8")).toContain("Builder completed.");
		expect(await readFile(join(archiveRoot, archives[0]!, "reports", "task-01", "attempt-02-reviewer.md"), "utf8")).toContain("Approved.");
		const archiveRunPath = join(archiveRoot, archives[0]!, "run.json");
		const completedBytes = await readFile(archiveRunPath, "utf8");
		const activePath = join(root, ".pi", "steward", "active-run.json");
		const archivedDecode = deserializeRunJournal(completedBytes, archiveRunPath);
		expect(archivedDecode.value?.run.status).toBe("completed");
		if (!archivedDecode.value) throw new Error("Archived Run did not decode");
		const gateCandidate = structuredClone(archivedDecode.value) as RunJournal;
		gateCandidate.run.status = "completing";
		gateCandidate.run.tasks[0]!.phase = "integrating";
		delete gateCandidate.run.completion;
		const gateCheckout = archivedDecode.value.run.completion && "gate" in archivedDecode.value.run.completion ? archivedDecode.value.run.completion.gate.checkout : undefined;
		if (!gateCheckout) throw new Error("Archived Completion Gate facts are missing");
		expect(evaluateCompletionGate(gateCandidate, gateCheckout).passed).toBe(true);
		const gateMutations: Array<[string, (candidate: RunJournal) => void]> = [
			["task count", (candidate) => { candidate.run.tasks = []; }],
			["Builder evidence", (candidate) => { const builder = candidate.run.tasks[0]!.attempts.find((attempt) => attempt.role === "builder"); if (builder?.role === "builder") builder.evidence = { phase: "rejected", checkedAt: "2026-09-18T00:00:00.025Z", codes: ["report-invalid"], summary: "corrupt" }; }],
			["Reviewer evidence", (candidate) => { const reviewer = candidate.run.tasks[0]!.attempts.find((attempt) => attempt.role === "reviewer")!; if (reviewer.role === "reviewer" && reviewer.evidence?.phase === "finalized") reviewer.evidence = { ...reviewer.evidence, verdict: "changes-required" }; }],
			["Approval", (candidate) => { if (candidate.run.tasks[0]!.approval?.phase === "valid") candidate.run.tasks[0]!.approval = { ...candidate.run.tasks[0]!.approval, phase: "invalidated", invalidatedAt: "2026-09-18T00:00:00.025Z", reason: "approval-invalid", diagnostic: "corrupt" }; }],
			["integration", (candidate) => { if (candidate.run.tasks[0]!.integration?.phase === "integrated") candidate.run.tasks[0]!.integration = { ...candidate.run.tasks[0]!.integration, phase: "failed", observedAt: "2026-09-18T00:00:00.025Z", exitCode: 1, diagnostic: "corrupt" }; }],
			["verification", (candidate) => { if (candidate.run.finalVerificationExecution?.phase === "passed") candidate.run.finalVerificationExecution = { ...candidate.run.finalVerificationExecution, phase: "failed", exitCode: 1 }; }],
			["attention", (candidate) => { candidate.run.tasks[0]!.attention = "needs-user"; }],
		];
		const effectSnapshot = { merges: effects.merges, processes: effects.processes, stops: [...effects.stops], notifications: effects.notifications };
		for (const [label, mutate] of gateMutations) {
			const candidate = structuredClone(gateCandidate) as RunJournal;
			mutate(candidate);
			expect(evaluateCompletionGate(candidate, gateCheckout).passed, label).toBe(false);
		}
		const dirtyCheckout = { ...gateCheckout, dirtyPaths: ["dirty.txt"] };
		expect(evaluateCompletionGate(gateCandidate, dirtyCheckout).passed).toBe(false);
		expect({ merges: effects.merges, processes: effects.processes, stops: effects.stops, notifications: effects.notifications }).toEqual(effectSnapshot);
		for (const [label, mutate] of [
			["altered verification command", (value: Record<string, any>) => { value.run.finalVerificationExecution.command = "npm test -- altered"; }],
			["second verification id", (value: Record<string, any>) => { value.run.finalVerificationExecution.id = "verification-02"; }],
			["verification before integration", (value: Record<string, any>) => { delete value.run.tasks[0].integration; }],
		] as const) {
			const candidate = JSON.parse(completedBytes) as Record<string, any>;
			mutate(candidate);
			expect(deserializeRunJournal(`${JSON.stringify(candidate)}\n`, archiveRunPath).value, label).toBeUndefined();
		}
		await writeFile(activePath, completedBytes);
		const activeDecode = deserializeRunJournal(completedBytes, activePath);
		expect(activeDecode.value).toBeUndefined();
		expect(activeDecode.diagnostics.map((diagnostic) => diagnostic.message).join(" ")).toMatch(/completed.*active-run/i);
		const loadedCompleted = await deps.runJournal.loadActive(root);
		expect(loadedCompleted.kind).toBe("invalid");
		const beforeInvalidReplace = await readFile(activePath);
		const parsedCompleted = JSON.parse(completedBytes) as RunJournal;
		const replacedCompleted = await deps.runJournal.replaceActive(root, parsedCompleted);
		expect(["invalid-current", "invalid-candidate", "storage-error"]).toContain(replacedCompleted.kind);
		expect(await readFile(activePath)).toEqual(beforeInvalidReplace);
		await rm(activePath, { force: true });
		const createdCompleted = await deps.runJournal.createActive(root, parsedCompleted);
		expect(createdCompleted.kind).toBe("storage-error");
	}, 60_000);

	it("retains active completion state and skips notification on an archive conflict", async () => {
		const root = await mkdtemp(join(tmpdir(), "steward-t08-archive-conflict-"));
		roots.push(root);
		const effects: { merges: number; processes: number; stops: string[]; notifications: number; state: "base" | "integrated" } = { merges: 0, processes: 0, stops: [], notifications: 0, state: "base" };
		const deps = dependencies(root, effects);
		const started = await start(root, deps);
		await writeBuilder(root, started);
		await invoke(root, deps, "status");
		const afterReviewDispatch = await deps.runJournal.loadActive(root);
		if (afterReviewDispatch.kind !== "loaded") throw new Error("Reviewer dispatch did not persist");
		await writeReviewer(afterReviewDispatch.journal);
		const archive = deps.runJournal.resolveCompletionPaths!(root, started.run.id).archiveDirectory;
		await mkdir(archive, { recursive: true });
		await writeFile(join(archive, "unexpected"), "preserve this conflict\n");
		const view = await invoke(root, deps, "status");
		expect(view).not.toMatchObject({ completed: true });
		expect(effects.notifications).toBe(0);
		expect(await readFile(join(archive, "unexpected"), "utf8")).toBe("preserve this conflict\n");
		const active = await deps.runJournal.loadActive(root);
		expect(active.kind).toBe("loaded");
		if (active.kind === "loaded") expect(active.journal.run.tasks[0]?.attentionReason).toBe("archive-failed");
	}, 60_000);

	it("freshly revalidates a persisted integrated state before launching verification", async () => {
		const root = await mkdtemp(join(tmpdir(), "steward-t08-reentry-"));
		roots.push(root);
		const effects: { merges: number; processes: number; stops: string[]; notifications: number; state: "base" | "integrated" } = { merges: 0, processes: 0, stops: [], notifications: 0, state: "base" };
		const deps = dependencies(root, effects);
		const started = await start(root, deps);
		await writeBuilder(root, started);
		await invoke(root, deps, "status");
		const afterReviewDispatch = await deps.runJournal.loadActive(root);
		if (afterReviewDispatch.kind !== "loaded") throw new Error("Reviewer dispatch did not persist");
		await writeReviewer(afterReviewDispatch.journal);
		const processAdapter = deps.process;
		deps.process = {} as typeof deps.process;
		await invoke(root, deps, "status");
		const integrated = await deps.runJournal.loadActive(root);
		expect(integrated.kind).toBe("loaded");
		if (integrated.kind !== "loaded") return;
		expect(integrated.journal.run.tasks[0]?.integration?.phase).toBe("integrated");
		expect(integrated.journal.run.finalVerificationExecution).toBeUndefined();
		const inspect = deps.git.inspectIntegrationCheckout!;
		deps.git.inspectIntegrationCheckout = async (input) => {
			const result = await inspect(input);
			return result.kind === "inspected" ? { ...result, observation: { ...result.observation, dirtyPaths: ["generated-after-integration.txt"] } } : result;
		};
		deps.process = processAdapter;
		const reentered = await invoke(root, deps, "status");
		expect(reentered).not.toMatchObject({ completed: true });
		expect(effects.processes).toBe(0);
		expect(effects.stops).toHaveLength(0);
		expect(effects.notifications).toBe(0);
		const afterReentry = await deps.runJournal.loadActive(root);
		expect(afterReentry.kind).toBe("loaded");
		if (afterReentry.kind === "loaded") {
			expect(afterReentry.journal.run.tasks[0]?.attention).toBe("needs-user");
			expect(afterReentry.journal.run.tasks[0]?.attentionReason).toBe("integration-preflight");
			expect(afterReentry.journal.run.finalVerificationExecution).toBeUndefined();
			expect(afterReentry.journal.run.status).toBe("active");
		}
	}, 120_000);

	it.each(["builder", "reviewer"] as const)("rejects a mutated protected %s manifest before integration", async (role) => {
		const root = await mkdtemp(join(tmpdir(), `steward-t08-${role}-mutation-`));
		roots.push(root);
		const effects = { merges: 0, processes: 0, stops: [] as string[], notifications: 0, state: "base" as const };
		const deps = dependencies(root, effects);
		const approved = await reachApproved(root, deps);
		const attempt = approved.run.tasks[0]!.attempts.find((candidate) => candidate.role === role)!;
		if (attempt.evidence?.phase !== "finalized") throw new Error(`${role} evidence was not finalized`);
		const originalManifest = await readFile(attempt.evidence.manifestPath);
		await writeFile(attempt.evidence.manifestPath, Buffer.concat([originalManifest, Buffer.from("tampered\n")]));
		await invoke(root, deps, "status");
		const after = await deps.runJournal.loadActive(root);
		expect(effects.merges).toBe(0);
		expect(effects.processes).toBe(0);
		expect(effects.stops).toHaveLength(0);
		expect(effects.notifications).toBe(0);
		expect(after.kind).toBe("loaded");
		if (after.kind === "loaded") {
			expect(after.journal.run.tasks[0]?.integration).toBeUndefined();
			expect(after.journal.run.tasks[0]?.attention).toBe("needs-user");
			expect(after.journal.run.tasks[0]?.phase).toBe(role === "reviewer" ? "reviewing" : "approved");
		}
	}, 60_000);

	it.each([
		["Review head", (snapshot: { head: string; dirtyStateFingerprint: string; dirtyPaths: string[]; operationMarkers: string[] }) => ({ ...snapshot, head: "3333333333333333333333333333333333333333" })],
		["Review dirty state", (snapshot: { head: string; dirtyStateFingerprint: string; dirtyPaths: string[]; operationMarkers: string[] }) => ({ ...snapshot, dirtyPaths: ["approval-changed.txt"] })],
	] as const)("invalidates a current Approval after %s mutation before integration", async (_label, mutate) => {
		const root = await mkdtemp(join(tmpdir(), "steward-t08-approval-mutation-"));
		roots.push(root);
		const effects = { merges: 0, processes: 0, stops: [] as string[], notifications: 0, state: "base" as const };
		const deps = dependencies(root, effects);
		const approved = await reachApproved(root, deps);
		const inspect = deps.git.inspectReviewWorktree!;
		deps.git.inspectReviewWorktree = async (path) => {
			const result = await inspect(path);
			return "kind" in result ? result : mutate(result);
		};
		await invoke(root, deps, "status");
		const after = await deps.runJournal.loadActive(root);
		expect(effects.merges).toBe(0);
		expect(effects.processes).toBe(0);
		expect(effects.stops).toHaveLength(0);
		expect(effects.notifications).toBe(0);
		expect(after.kind).toBe("loaded");
		if (after.kind === "loaded") {
			expect(after.journal.run.tasks[0]?.approval?.phase).toBe("invalidated");
			expect(after.journal.run.tasks[0]?.integration).toBeUndefined();
			expect(after.journal.run.tasks[0]?.attention).toBe("needs-user");
		}
		expect(approved.run.tasks[0]?.approval?.phase).toBe("valid");
	}, 60_000);

	it.each([
		["wrong branch", (normal: IntegrationCheckoutResult) => normal.kind === "inspected" ? { ...normal, observation: { ...normal.observation, branch: "release" } } : normal],
		["advanced target head", (normal: IntegrationCheckoutResult) => normal.kind === "inspected" ? { ...normal, observation: { ...normal.observation, head: "3333333333333333333333333333333333333333" } } : normal],
		["tracked dirt", (normal: IntegrationCheckoutResult) => normal.kind === "inspected" ? { ...normal, observation: { ...normal.observation, dirtyPaths: ["tracked.txt"] } } : normal],
		["staged dirt", (normal: IntegrationCheckoutResult) => normal.kind === "inspected" ? { ...normal, observation: { ...normal.observation, dirtyPaths: ["staged.txt"] } } : normal],
		["untracked dirt", (normal: IntegrationCheckoutResult) => normal.kind === "inspected" ? { ...normal, observation: { ...normal.observation, dirtyPaths: ["untracked.txt"] } } : normal],
		["operation marker", (normal: IntegrationCheckoutResult) => normal.kind === "inspected" ? { ...normal, observation: { ...normal.observation, operationMarkers: ["MERGE_HEAD"] } } : normal],
		["unresolved revision", () => ({ kind: "unavailable" as const, message: "revision cannot be resolved" })],
		["non-ancestor", (normal: IntegrationCheckoutResult) => normal.kind === "inspected" ? { ...normal, observation: { ...normal.observation, rangeExact: false } } : normal],
		["ordered range mismatch", (normal: IntegrationCheckoutResult) => normal.kind === "inspected" ? { ...normal, commits: [...normal.commits].reverse(), observation: { ...normal.observation, rangeExact: false } } : normal],
	] as const)("rejects %s target preflight without mutation", async (_label, mutate) => {
		const root = await mkdtemp(join(tmpdir(), "steward-t08-preflight-"));
		roots.push(root);
		const effects = { merges: 0, processes: 0, stops: [] as string[], notifications: 0, state: "base" as const };
		const deps = dependencies(root, effects);
		await reachApproved(root, deps);
		const inspect = deps.git.inspectIntegrationCheckout!;
		deps.git.inspectIntegrationCheckout = async (input) => mutate(await inspect(input)) as IntegrationCheckoutResult;
		await invoke(root, deps, "status");
		const after = await deps.runJournal.loadActive(root);
		expect(effects.merges).toBe(0);
		expect(effects.processes).toBe(0);
		expect(effects.stops).toHaveLength(0);
		expect(effects.notifications).toBe(0);
		expect(after.kind).toBe("loaded");
		if (after.kind === "loaded") {
			expect(after.journal.run.tasks[0]?.integration).toBeUndefined();
			expect(after.journal.run.tasks[0]?.attentionReason).toBe("integration-preflight");
			expect(after.journal.run.status).toBe("active");
		}
	}, 60_000);

	const verificationCases: Array<{ label: string; process: "nonzero" | "killed" | "throw" | "pass"; post: "clean" | "dirty" | "wrong-head" | "marker"; storageConflict?: boolean; execution: "failed" | "ambiguous"; reason: string }> = [
		{ label: "nonzero process", process: "nonzero", post: "clean", execution: "failed", reason: "final-verification-failed" },
		{ label: "killed process", process: "killed", post: "clean", execution: "ambiguous", reason: "final-verification-ambiguous" },
		{ label: "thrown process", process: "throw", post: "clean", execution: "ambiguous", reason: "final-verification-ambiguous" },
		{ label: "verification storage conflict", process: "pass", post: "clean", storageConflict: true, execution: "ambiguous", reason: "final-verification-ambiguous" },
		{ label: "exit zero dirtied checkout", process: "pass", post: "dirty", execution: "ambiguous", reason: "verification-dirtied-checkout" },
		{ label: "exit zero wrong head", process: "pass", post: "wrong-head", execution: "ambiguous", reason: "verification-dirtied-checkout" },
		{ label: "exit zero operation marker", process: "pass", post: "marker", execution: "ambiguous", reason: "verification-dirtied-checkout" },
	];

	it.each(verificationCases)("classifies $label durably and never reruns verification", async (scenario) => {
		const root = await mkdtemp(join(tmpdir(), "steward-t08-verification-"));
		roots.push(root);
		const effects = { merges: 0, processes: 0, stops: [] as string[], notifications: 0, state: "base" as const };
		const deps = dependencies(root, effects);
		const integrated = await reachIntegrated(root, deps);
		let inspections = 0;
		const inspect = deps.git.inspectIntegrationCheckout!;
		deps.git.inspectIntegrationCheckout = async (input) => {
			const normal = await inspect(input);
			inspections += 1;
			if (inspections === 1 || scenario.post === "clean") return normal;
			if (normal.kind !== "inspected") return normal;
			if (scenario.post === "dirty") return { ...normal, observation: { ...normal.observation, dirtyPaths: ["verification-output.txt"] } };
			if (scenario.post === "wrong-head") return { ...normal, observation: { ...normal.observation, head: "3333333333333333333333333333333333333333" } };
			return { ...normal, observation: { ...normal.observation, operationMarkers: ["MERGE_HEAD"] } };
		};
		deps.process = {
			async runApprovedVerification(input) {
				effects.processes += 1;
				expect(input).toEqual({ cwd: root, command: "npm test" });
				if (scenario.process === "throw") throw new Error("verification runner threw");
				if (scenario.process === "killed") return { kind: "completed", code: 143, stdout: "", stderr: "killed", killed: true };
				if (scenario.process === "nonzero") return { kind: "completed", code: 7, stdout: "", stderr: "failed", killed: false };
				return { kind: "completed", code: 0, stdout: "pass", stderr: "", killed: false };
			},
		};
		if (scenario.storageConflict) {
			const paths = deps.runJournal.resolveCompletionPaths!(root, integrated.run.id);
			deps.runJournal.finalizeVerificationResult = async () => ({ kind: "conflict", paths, message: "verification result already contains different bytes" });
		}
		await invoke(root, deps, "status");
		const after = await deps.runJournal.loadActive(root);
		expect(effects.merges).toBe(1);
		expect(effects.processes).toBe(1);
		expect(effects.stops).toHaveLength(0);
		expect(effects.notifications).toBe(0);
		expect(after.kind).toBe("loaded");
		if (after.kind !== "loaded") return;
		expect(after.journal.run.tasks[0]?.attentionReason).toBe(scenario.reason);
		expect(after.journal.run.finalVerificationExecution?.phase).toBe(scenario.execution);
		await invoke(root, deps, "status");
		expect(effects.processes).toBe(1);
	}, 60_000);

	it("rejects criteria-only final verification before any process launch", async () => {
		const root = await mkdtemp(join(tmpdir(), "steward-t08-criteria-"));
		roots.push(root);
		const effects = { merges: 0, processes: 0, stops: [] as string[], notifications: 0, state: "base" as const };
		const deps = dependencies(root, effects, { draft: criteriaDraft() });
		await reachApproved(root, deps);
		await invoke(root, deps, "status");
		const after = await deps.runJournal.loadActive(root);
		expect(effects.merges).toBe(0);
		expect(effects.processes).toBe(0);
		expect(effects.stops).toHaveLength(0);
		expect(effects.notifications).toBe(0);
		expect(after.kind).toBe("loaded");
		if (after.kind === "loaded") {
			expect(after.journal.run.tasks[0]?.attentionReason).toBe("final-verification-unexecutable");
			expect(after.journal.run.finalVerificationExecution).toBeUndefined();
		}
	}, 60_000);

	it.each([
		["altered command", (execution: Record<string, unknown>) => { execution.command = "npm test -- altered"; }],
		["second verification id", (execution: Record<string, unknown>) => { execution.id = "verification-02"; }],
	] as const)("rejects a persisted %s before launching verification", async (_label, mutate) => {
		const root = await mkdtemp(join(tmpdir(), "steward-t08-verification-invalid-"));
		roots.push(root);
		const effects = { merges: 0, processes: 0, stops: [] as string[], notifications: 0, state: "base" as const };
		const deps = dependencies(root, effects);
		const integrated = await reachIntegrated(root, deps);
		const paths = deps.runJournal.resolveCompletionPaths!(root, integrated.run.id);
		const activePaths = resolveRunJournalPaths(root);
		const raw = JSON.parse(await readFile(activePaths.activePath, "utf8")) as Record<string, unknown>;
		const execution: Record<string, unknown> = { phase: "intended", id: "verification-01", command: "npm test", cwd: root, logPath: paths.verificationLogPath, resultPath: paths.verificationResultPath, intendedAt: "2026-09-18T00:00:00.020Z" };
		mutate(execution);
		raw.run = { ...(raw.run as Record<string, unknown>), finalVerificationExecution: execution };
		const invalidBytes = Buffer.from(`${JSON.stringify(raw)}\n`);
		expect(deserializeRunJournal(invalidBytes.toString("utf8"), activePaths.activePath).value).toBeUndefined();
		await writeFile(activePaths.activePath, invalidBytes);
		await invoke(root, deps, "status");
		expect(effects.merges).toBe(1);
		expect(effects.processes).toBe(0);
		expect(effects.stops).toHaveLength(0);
		expect(effects.notifications).toBe(0);
		expect(await readFile(activePaths.activePath)).toEqual(invalidBytes);
	}, 60_000);

	it.each([
		["wrong identity", { kind: "acknowledged", name: "wrong-agent", workspaceId: "workspace-1", tabId: "tab-1", paneId: "builder-pane", terminalId: "builder-terminal" }],
		["malformed acknowledgement", { kind: "acknowledged", name: "steward-b-01234567-01-01", workspaceId: "workspace-1", tabId: "tab-1", paneId: "builder-pane" }],
		["failing acknowledgement", { kind: "failed", message: "agent refused /quit" }],
	] as const)("halts completion on a %s and never resends", async (_label, response) => {
		const root = await mkdtemp(join(tmpdir(), "steward-t08-stop-failure-"));
		roots.push(root);
		const effects = { merges: 0, processes: 0, stops: [] as string[], notifications: 0, state: "base" as const };
		const deps = dependencies(root, effects);
		await prepareReviewer(root, deps);
		const firstResource = "steward-b-01234567-01-01";
		deps.herdr.stopAgentGracefully = async (input) => { effects.stops.push(input.name); return response as unknown as HerdrStopResult; };
		await invoke(root, deps, "status");
		expect(effects.stops).toEqual([firstResource]);
		const afterFirst = await deps.runJournal.loadActive(root);
		expect(afterFirst.kind).toBe("loaded");
		if (afterFirst.kind === "loaded") {
			expect(afterFirst.journal.run.completion?.phase).toBe("stops-incomplete");
		}
		await invoke(root, deps, "status");
		const after = await deps.runJournal.loadActive(root);
		expect(effects.merges).toBe(1);
		expect(effects.processes).toBe(1);
		expect(effects.stops).toEqual([firstResource]);
		expect(effects.notifications).toBe(0);
		expect(after.kind).toBe("loaded");
		if (after.kind === "loaded") {
			expect(after.journal.run.status).toBe("completing");
			expect(after.journal.run.completion?.phase).toBe("stops-incomplete");
			expect(after.journal.run.tasks[0]?.attentionReason).toBe("agent-stop-failed");
		}
	}, 60_000);

	it("persists integration intent before Git and never merges twice after any acknowledgement", async () => {
		const root = await mkdtemp(join(tmpdir(), "steward-t08-intent-failure-"));
		roots.push(root);
		const effects = { merges: 0, processes: 0, stops: [] as string[], notifications: 0, state: "base" as const };
		const deps = dependencies(root, effects);
		await reachApproved(root, deps);
		const replace = deps.runJournal.replaceActive.bind(deps.runJournal);
		let rejected = true;
		deps.runJournal.replaceActive = async (repositoryRoot, candidate) => {
			if (rejected && candidate.run.tasks[0]?.integration?.phase === "intended") {
				rejected = false;
				throw new Error("injected intent replacement failure");
			}
			return replace(repositoryRoot, candidate);
		};
		await invoke(root, deps, "status");
		const after = await deps.runJournal.loadActive(root);
		expect(effects.merges).toBe(0);
		expect(after.kind).toBe("loaded");
		if (after.kind === "loaded") {
			expect(after.journal.run.tasks[0]?.phase).toBe("approved");
			expect(after.journal.run.tasks[0]?.integration).toBeUndefined();
		}
	}, 60_000);

	it.each([
		["thrown acknowledgement", "thrown", "ambiguous"],
		["nonzero acknowledgement", "nonzero", "failed"],
		["malformed acknowledgement", "malformed", "ambiguous"],
	] as const)("classifies %s from the post-state without retry", async (_label, acknowledgement, expectedPhase) => {
		const root = await mkdtemp(join(tmpdir(), "steward-t08-merge-classification-"));
		roots.push(root);
		const effects = { merges: 0, processes: 0, stops: [] as string[], notifications: 0, state: "base" as const };
		const deps = dependencies(root, effects);
		await reachApproved(root, deps);
		let inspections = 0;
		const inspect = deps.git.inspectIntegrationCheckout!;
		deps.git.inspectIntegrationCheckout = async (input) => {
			const normal = await inspect(input);
			inspections += 1;
			if (inspections === 1) return normal;
			if (normal.kind !== "inspected") return normal;
			if (expectedPhase === "failed") return { ...normal, observation: { ...normal.observation, head: baseRevision } };
			return { ...normal, observation: { ...normal.observation, head: "3333333333333333333333333333333333333333", dirtyPaths: ["partial.txt"] } };
		};
		deps.git.integrateApprovedRange = async () => {
			effects.merges += 1;
			if (acknowledgement === "thrown") throw new Error("merge acknowledgement threw");
			return acknowledgement === "nonzero"
				? { kind: "completed", code: 1, stdout: "", stderr: "merge failed", killed: false }
				: { kind: "completed", code: 0, stdout: "malformed", stderr: "", killed: false };
		};
		deps.process = {} as typeof deps.process;
		await invoke(root, deps, "status");
		await invoke(root, deps, "status");
		const after = await deps.runJournal.loadActive(root);
		expect(effects.merges).toBe(1);
		expect(effects.processes).toBe(0);
		expect(effects.stops).toHaveLength(0);
		expect(effects.notifications).toBe(0);
		expect(after.kind).toBe("loaded");
		if (after.kind === "loaded") {
			expect(after.journal.run.tasks[0]?.integration?.phase).toBe(expectedPhase);
			expect(after.journal.run.tasks[0]?.attentionReason).toBe(expectedPhase === "failed" ? "integration-failed" : "integration-ambiguous");
		}
	}, 60_000);
});

describe("ticket-08 read-only status authority", () => {
	it.each(["approved", "integrating", "completing"] as const)("does not mutate %s journals from footer or foreign-session status", async (state) => {
		const root = await mkdtemp(join(tmpdir(), `steward-t08-readonly-${state}-`));
		roots.push(root);
		const effects = { merges: 0, processes: 0, stops: [] as string[], notifications: 0, state: "base" as const };
		const deps = dependencies(root, effects);
		if (state === "approved") {
			await reachApproved(root, deps);
		} else if (state === "integrating") {
			await reachApproved(root, deps);
			deps.git.integrateApprovedRange = async () => { effects.merges += 1; effects.state = "base"; return { kind: "completed", code: 1, stdout: "", stderr: "unchanged", killed: false }; };
			deps.process = {} as typeof deps.process;
			await invoke(root, deps, "status");
		} else {
			await prepareReviewer(root, deps);
			deps.herdr.stopAgentGracefully = async () => ({ kind: "failed", message: "stop rejected" });
			await invoke(root, deps, "status");
		}
		const paths = resolveRunJournalPaths(root);
		const before = await readFile(paths.activePath);
		const effectBefore = { merges: effects.merges, processes: effects.processes, stops: [...effects.stops], notifications: effects.notifications };
		let inspections = 0;
		const inspect = deps.git.inspectIntegrationCheckout;
		deps.git.inspectIntegrationCheckout = async (input) => { inspections += 1; return inspect ? inspect(input) : { kind: "unavailable", message: "not used" }; };
		const steward = createSteward(deps);
		await steward.status(root, "footer");
		await steward.status(root, "command", "foreign-controller-session");
		expect(await readFile(paths.activePath)).toEqual(before);
		expect({ merges: effects.merges, processes: effects.processes, stops: effects.stops, notifications: effects.notifications }).toEqual(effectBefore);
		expect(inspections).toBe(0);
	}, 60_000);
});
