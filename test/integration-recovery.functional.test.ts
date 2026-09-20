import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { createGitAdapter, createRunJournalAdapter } from "../src/adapters.ts";
import { serializeBuilderAttemptReport, type BuilderAttemptReport } from "../src/attempt-report.ts";
import { registerStewardExtension, type StewardCommandContext, type StewardCommandHandler, type StewardRegistrationSurface } from "../src/extension.ts";
import { advanceRunJournal, builderAssignmentSha256, deserializeRunJournal, serializeRunJournal, type RunDraft, type RunJournal } from "../src/run.ts";
import { deserializeReviewerAssignment, reviewerAssignmentSha256, serializeReviewerAttemptReport, type ReviewerAttemptReport } from "../src/review.ts";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import type { ModelChoice, ProjectModelPlans, RecoveryDefaults } from "../src/config.ts";
import type { IntegrationCheckoutInput, IntegrationMutationInput, StewardDependencies, StewardUiAdapter, StatusView } from "../src/steward.ts";
import { resolveRunJournalPaths } from "../src/run-journal-store.ts";

const execFile = promisify(execFileCallback);
const roots: string[] = [];

const recovery: RecoveryDefaults = {
	passiveInspectionIntervalSeconds: 301,
	secondInspectionAndNudgeIntervalSeconds: 302,
	nudgeGracePeriodSeconds: 121,
	externalCommandWarningThresholdSeconds: 1_801,
	maximumActiveTasks: 1,
	transientRetryLimit: 1,
	reworkCycleLimit: 1,
};
const modelPlan: ProjectModelPlans = {
	builder: { primary: { model: "builder/model", thinkingLevel: "high" }, fallbacks: [] },
	reviewer: { primary: { model: "reviewer/model", thinkingLevel: "high" }, fallbacks: [] },
};

type GitHarness = {
	root: string;
	builderPath: string;
	builderPaths: string[];
	calls: string[][];
	deps: StewardDependencies;
};

type HarnessOptions = {
	taskCount?: number;
	maximumActiveTasks?: number;
	reworkCycleLimit?: number;
	passiveInspectionIntervalSeconds?: number;
};

async function git(cwd: string, args: string[]): Promise<string> {
	try {
		const result = await execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
		return String(result.stdout).trim();
	} catch (error: unknown) {
		const value = error as { stdout?: string; stderr?: string };
		throw new Error(`${value.stderr ?? "git failed"}\n${value.stdout ?? ""}`);
	}
}

function commandRunner(calls: string[][]) {
	return async (command: string, args: string[], options?: { cwd?: string; timeout?: number; signal?: AbortSignal }): Promise<ExecResult> => {
		calls.push([command, ...args]);
		try {
			const result = await execFile(command, args, { cwd: options?.cwd, encoding: "utf8", timeout: options?.timeout, maxBuffer: 16 * 1024 * 1024, signal: options?.signal });
			return { stdout: String(result.stdout), stderr: String(result.stderr), code: 0, killed: false } as ExecResult;
		} catch (error: unknown) {
			const value = error as { stdout?: string; stderr?: string; code?: number; killed?: boolean; signal?: string };
			return { stdout: value.stdout ?? "", stderr: value.stderr ?? "", code: typeof value.code === "number" ? value.code : 1, killed: value.killed === true || value.signal === "SIGTERM" } as ExecResult;
		}
	};
}

function draft(taskCount = 1, settings: RecoveryDefaults = recovery): RunDraft {
	return {
		declaredOutcome: "Complete one approved change",
		tasks: Array.from({ length: taskCount }, (_, index) => ({ requiredOutcome: "Implement the change", allowedScope: [taskCount === 1 ? "src" : `src/task-${String(index + 1).padStart(2, "0")}`], expectedArtifacts: [{ kind: "git-commit" as const }], verification: { kind: "command" as const, command: "true" }, reviewRequired: true })),
		modelPlan,
		effectiveSettings: settings,
		finalVerification: { kind: "command", command: "true" },
	};
}

function context(root: string, sessionId = "controller-session"): StewardCommandContext {
	return {
		mode: "tui",
		hasUI: true,
		cwd: root,
		modelRegistry: {} as StewardCommandContext["modelRegistry"],
		model: undefined,
		thinkingLevel: undefined,
		scopedModels: [],
		sessionManager: { getSessionId: () => sessionId } as StewardCommandContext["sessionManager"],
		ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined, notify() {}, setStatus() {} },
	};
}

function registered(dependencies: StewardDependencies): () => StewardCommandHandler {
	let handler: StewardCommandHandler | undefined;
	const surface: StewardRegistrationSurface = {
		on() {},
		registerCommand(_name, options) { handler = options.handler; },
	};
	registerStewardExtension(surface, () => dependencies);
	return () => {
		if (!handler) throw new Error("Steward command was not registered");
		return handler;
	};
}

async function invoke(harness: GitHarness, command: string, sessionId = "controller-session"): Promise<StatusView> {
	let view: StatusView | undefined;
	harness.deps.ui = { ...harness.deps.ui, presentStatus(value) { view = value; } };
	await registered(harness.deps)()(command, context(harness.root, sessionId));
	if (!view) throw new Error("registered status did not present a view");
	return view;
}

async function load(harness: GitHarness): Promise<RunJournal> {
	const result = await harness.deps.runJournal.loadActive(harness.root);
	if (result.kind !== "loaded") throw new Error(`active journal unavailable: ${result.kind}`);
	return result.journal;
}

async function makeHarness(options: HarnessOptions = {}): Promise<GitHarness> {
	const taskCount = options.taskCount ?? 1;
	const settings: RecoveryDefaults = { ...recovery, ...(options.maximumActiveTasks === undefined ? {} : { maximumActiveTasks: options.maximumActiveTasks }), ...(options.reworkCycleLimit === undefined ? {} : { reworkCycleLimit: options.reworkCycleLimit }), ...(options.passiveInspectionIntervalSeconds === undefined ? {} : { passiveInspectionIntervalSeconds: options.passiveInspectionIntervalSeconds }) };
	const root = await mkdtemp(join(tmpdir(), "steward-t15-recovery-repo-"));
	const builderPaths = await Promise.all(Array.from({ length: taskCount }, () => mkdtemp(join(tmpdir(), "steward-t15-recovery-builder-"))));
	const builderPath = builderPaths[0]!;
	roots.push(root, ...builderPaths);
	await git(root, ["init", "-b", "main"]);
	await git(root, ["config", "user.email", "test@example.invalid"]);
	await git(root, ["config", "user.name", "Steward Ticket 15"]);
	await mkdir(join(root, "src"));
	await writeFile(join(root, "src", "base.txt"), "base\n");
	await git(root, ["add", "src/base.txt"]);
	await git(root, ["commit", "-m", "base"]);
	const calls: string[][] = [];
	const runJournal = createRunJournalAdapter();
	const gitAdapter = createGitAdapter(commandRunner(calls));
	let uuid = 0;
	const ui: StewardUiAdapter = {
		presentStatus() {},
		async editConfiguration() { return { kind: "cancelled" }; },
		async draftRun() { return { kind: "drafted" as const, draft: draft(taskCount, settings) }; },
		async confirmRun() { return true; },
		presentConfigurationResult() {},
		presentStartResult() {},
	};
	const deps: StewardDependencies = {
		runJournal,
		herdr: {
			async checkAvailability() { return { kind: "available", status: "running", running: true, compatible: true, endpointCompatible: true }; },
			async createBuilderWorktree(input) {
				const taskNumber = Number(input.branch.match(/task-(\d+)/)?.[1] ?? "1");
				const path = builderPaths[taskNumber - 1] ?? builderPath;
				await git(root, ["worktree", "add", "-b", input.branch, path, input.baseRevision]);
				return { kind: "created", branch: input.branch, path, workspaceId: `workspace-${taskNumber}`, tabId: `tab-${taskNumber}`, paneId: `builder-pane-${taskNumber}`, terminalId: `builder-terminal-${taskNumber}` };
			},
			async startBuilder(input) { const taskNumber = Number(input.paneId.match(/builder-pane-(\d+)/)?.[1] ?? "1"); return { kind: "started", name: input.name, agentKind: "pi", workspaceId: `workspace-${taskNumber}`, tabId: `tab-${taskNumber}`, paneId: `builder-pane-${taskNumber}`, terminalId: `builder-terminal-${taskNumber}` }; },
			async promptBuilder(input) { const taskNumber = Number(input.name.match(/-(\d{2})-\d{2}$/)?.[1] ?? "1"); return { kind: "prompted", name: input.name, workspaceId: `workspace-${taskNumber}`, tabId: `tab-${taskNumber}`, paneId: `builder-pane-${taskNumber}`, terminalId: `builder-terminal-${taskNumber}` }; },
			async createReviewerPane(input) { const taskNumber = Number(input.sourcePaneId.match(/builder-pane-(\d+)/)?.[1] ?? "1"); return { kind: "created", workspaceId: input.workspaceId, tabId: `reviewer-tab-${taskNumber}`, paneId: `reviewer-pane-${taskNumber}`, terminalId: `reviewer-terminal-${taskNumber}`, sourcePaneId: input.sourcePaneId, worktreePath: input.worktreePath }; },
			async startReviewer(input) { const taskNumber = Number(input.paneId.match(/reviewer-pane-(\d+)/)?.[1] ?? "1"); return { kind: "started", name: input.name, agentKind: "pi", workspaceId: `workspace-${taskNumber}`, tabId: `reviewer-tab-${taskNumber}`, paneId: `reviewer-pane-${taskNumber}`, terminalId: `reviewer-terminal-${taskNumber}` }; },
			async promptReviewer(input) { const taskNumber = Number(input.name.match(/-(\d{2})-\d{2}$/)?.[1] ?? "1"); return { kind: "prompted", name: input.name, workspaceId: `workspace-${taskNumber}`, tabId: `reviewer-tab-${taskNumber}`, paneId: `reviewer-pane-${taskNumber}`, terminalId: `reviewer-terminal-${taskNumber}` }; },
		},
		git: gitAdapter,
		process: {},
		model: {
			listModelChoices: () => [],
			async validateModelPlans() { return []; },
			async inspectModelChoice(choice: ModelChoice) { return { choice, available: true, diagnostics: [] }; },
		},
		clock: { now: () => new Date("2026-09-20T00:00:00.000Z"), randomUUID: () => `01234567-89ab-cdef-0123-456789abc${String(++uuid).padStart(3, "0")}` },
		ui,
	};
	return { root, builderPath, builderPaths, calls, deps };
}

async function startAndLoad(harness: GitHarness): Promise<RunJournal> {
	await registered(harness.deps)()("start", context(harness.root));
	return load(harness);
}

async function writeBuilderReport(harness: GitHarness, journal: RunJournal, taskIndex = 0, attemptId = "attempt-01"): Promise<void> {
	const task = journal.run.tasks[taskIndex]!;
	const attempt = task.attempts.find((candidate) => candidate.id === attemptId);
	if (!attempt || attempt.role !== "builder") throw new Error(`Builder ${attemptId} missing`);
	const assignmentText = await readFile(attempt.assignmentPath, "utf8");
	const assignment = JSON.parse(assignmentText) as { assignment: { actualModel: BuilderAttemptReport["actualModel"]; specificationHash: string } };
	if (attemptId === "attempt-01") {
		const builderPath = harness.builderPaths[taskIndex] ?? harness.builderPath;
		const changedPath = taskIndex === 0 && journal.run.tasks.length === 1 ? join("src", "base.txt") : join("src", `task-${String(taskIndex + 1).padStart(2, "0")}`, "change.txt");
		await mkdir(join(builderPath, changedPath.substring(0, changedPath.lastIndexOf("/"))), { recursive: true });
		await writeFile(join(builderPath, changedPath), `approved task ${taskIndex + 1}\n`);
		await git(builderPath, ["add", changedPath]);
		await git(builderPath, ["commit", "-m", `approved change ${taskIndex + 1}`]);
	}
	const builderPath = harness.builderPaths[taskIndex] ?? harness.builderPath;
	const baseRevision = attempt.baseRevision;
	const headRevision = await git(builderPath, ["rev-parse", "HEAD"]);
	const commits = (await git(builderPath, ["rev-list", "--reverse", `${baseRevision}..${headRevision}`])).split("\n").filter(Boolean);
	const logPath = join(attempt.evidenceDirectory, "check.log");
	await writeFile(logPath, "pass\n");
	const report: BuilderAttemptReport = {
		schemaVersion: 1,
		identity: { runId: journal.run.id, taskId: task.contract.id, attemptId: attempt.id, role: "builder", specificationHash: assignment.assignment.specificationHash, assignmentSha256: builderAssignmentSha256(assignmentText) },
		status: "completed",
		summary: "Builder completed.",
		blockers: [],
		producedArtifacts: [{ kind: "git-commit", baseRevision, headRevision, commits }],
		actualModel: assignment.assignment.actualModel,
		checks: [{ kind: "command", command: "true", exitCode: 0, summary: "pass", logId: "check-1" }],
		logReferences: [{ id: "check-1", path: logPath, size: 5, sha256: `sha256:${createHash("sha256").update("pass\n").digest("hex")}` }],
		producedRevision: headRevision,
	};
	await writeFile(attempt.reportPath, serializeBuilderAttemptReport(report));
}

async function writeIntegrationReworkBuilderReport(harness: GitHarness, journal: RunJournal, taskIndex = 0): Promise<void> {
	const task = journal.run.tasks[taskIndex]!;
	const attempt = task.attempts.at(-1);
	if (!attempt || attempt.role !== "builder" || !("integrationRecovery" in attempt.dispatch)) throw new Error("Integration-rework Builder missing");
	const assignmentText = await readFile(attempt.assignmentPath, "utf8");
	const assignment = JSON.parse(assignmentText) as { assignment: { actualModel: BuilderAttemptReport["actualModel"]; specificationHash: string } };
	const builderPath = harness.builderPaths[taskIndex] ?? harness.builderPath;
	const changedPath = join("src", "base.txt");
	await writeFile(join(builderPath, changedPath), "resolved integration target\n");
	await git(builderPath, ["add", changedPath]);
	const tree = await git(builderPath, ["write-tree"]);
	const head = await git(builderPath, ["commit-tree", tree, "-p", attempt.baseRevision, "-m", "resolve integration target"]);
	await git(builderPath, ["update-ref", `refs/heads/${attempt.dispatch.branch}`, head]);
	const headRevision = await git(builderPath, ["rev-parse", "HEAD"]);
	const commits = (await git(builderPath, ["rev-list", "--reverse", `${attempt.baseRevision}..${headRevision}`])).split("\n").filter(Boolean);
	const logPath = join(attempt.evidenceDirectory, "check.log");
	await writeFile(logPath, "pass\n");
	const report: BuilderAttemptReport = {
		schemaVersion: 1,
		identity: { runId: journal.run.id, taskId: task.contract.id, attemptId: attempt.id, role: "builder", specificationHash: assignment.assignment.specificationHash, assignmentSha256: builderAssignmentSha256(assignmentText) },
		status: "completed",
		summary: "Integration-rework Builder completed.",
		blockers: [],
		producedArtifacts: [{ kind: "git-commit", baseRevision: attempt.baseRevision, headRevision, commits }],
		actualModel: assignment.assignment.actualModel,
		checks: [{ kind: "command", command: "true", exitCode: 0, summary: "pass", logId: "check-1" }],
		logReferences: [{ id: "check-1", path: logPath, size: 5, sha256: `sha256:${createHash("sha256").update("pass\n").digest("hex")}` }],
		producedRevision: headRevision,
	};
	await writeFile(attempt.reportPath, serializeBuilderAttemptReport(report));
}

async function writeReviewerReport(harness: GitHarness, journal: RunJournal, taskIndex = 0): Promise<void> {
	const task = journal.run.tasks[taskIndex]!;
	const attempt = task.attempts.at(-1);
	if (!attempt || attempt.role !== "reviewer") throw new Error("Reviewer missing");
	const assignmentText = await readFile(attempt.assignmentPath, "utf8");
	const assignment = deserializeReviewerAssignment(assignmentText);
	if (!assignment.value) throw new Error("Reviewer assignment is invalid");
	const report: ReviewerAttemptReport = {
		schemaVersion: 1,
		identity: { runId: journal.run.id, taskId: task.contract.id, attemptId: attempt.id, role: "reviewer", specificationHash: attempt.specificationHash, assignmentSha256: reviewerAssignmentSha256(assignmentText) },
		status: "completed",
		summary: "Approved.",
		blockers: [],
		actualModel: attempt.actualModel,
		reviewedSubject: assignment.value.assignment.subject,
		verdict: "approved",
		findings: [],
		checks: [],
		logReferences: [],
	};
	await writeFile(attempt.reportPath, serializeReviewerAttemptReport(report));
}

async function reachApproved(harness: GitHarness): Promise<RunJournal> {
	const started = await startAndLoad(harness);
	await writeBuilderReport(harness, started);
	await invoke(harness, "status");
	const reviewerDispatch = await load(harness);
	await writeReviewerReport(harness, reviewerDispatch);
	const inspect = harness.deps.git.inspectIntegrationCheckout;
	harness.deps.git.inspectIntegrationCheckout = undefined;
	await invoke(harness, "status");
	harness.deps.git.inspectIntegrationCheckout = inspect;
	const approved = await load(harness);
	expect(approved.run.tasks[0]?.phase).toBe("approved");
	return approved;
}

async function invokeResume(harness: GitHarness, sessionId = "controller-session"): Promise<void> {
	const inspectManagedAgent = harness.deps.herdr.inspectManagedAgent;
	const readManagedTerminal = harness.deps.herdr.readManagedTerminal;
	const inspectAttemptProcesses = harness.deps.process.inspectAttemptProcesses;
	harness.deps.herdr.inspectManagedAgent = async (identity) => ({ kind: "observed", identity, lifecycle: "working", stateChangeSequence: 1 });
	harness.deps.herdr.readManagedTerminal = async () => ({ kind: "observed", byteCount: 0, sha256: `sha256:${"1".repeat(64)}` });
	harness.deps.process.inspectAttemptProcesses = async (input) => ({ kind: "none", paneId: input.identity.paneId, shellPid: 1, foregroundProcessGroupId: 1, processCount: 0, digest: `sha256:${"2".repeat(64)}` });
	try { await registered(harness.deps)()("resume", context(harness.root, sessionId)); }
	finally {
		harness.deps.herdr.inspectManagedAgent = inspectManagedAgent;
		harness.deps.herdr.readManagedTerminal = readManagedTerminal;
		harness.deps.process.inspectAttemptProcesses = inspectAttemptProcesses;
	}
}

function jsonCalls(harness: GitHarness): string[][] {
	return harness.calls;
}

function forbiddenGitCall(call: string[]): boolean {
	return call[0] === "git" && ["push", "fetch", "pull", "rebase", "reset", "revert", "checkout", "restore", "clean"].includes(call[1] ?? "")
		|| (call[0] === "git" && call[1] === "merge" && call[2] === "--abort");
}

afterEach(async () => {
	for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true });
});

describe("ticket-15 registered integration recovery", () => {
	it("recognizes an already-applied real fast-forward only from a persisted intent", async () => {
		const harness = await makeHarness();
		const approved = await reachApproved(harness);
		const task = approved.run.tasks[0]!;
		const evidence = task.approval!;
		const builder = task.attempts.find((attempt) => attempt.id === evidence.builderAttemptId)!;
		const reviewer = task.attempts.find((attempt) => attempt.id === evidence.reviewerAttemptId)!;
		const base = approved.run.integrationBase.kind === "git" ? approved.run.integrationBase.revision : "";
		const head = evidence.subject.kind === "git" ? evidence.subject.headRevision : "";
		const commits = evidence.subject.kind === "git" ? evidence.subject.commits : [];
		const targetInput: IntegrationCheckoutInput = { repositoryRoot: harness.root, targetBranch: "main", targetRevision: base, approvedBaseRevision: base, approvedHeadRevision: head, approvedCommits: [...commits] };
		const inspected = await harness.deps.git.inspectIntegrationCheckout!(targetInput);
		expect(inspected.kind).toBe("inspected");
		if (inspected.kind !== "inspected") return;
		const intended = advanceRunJournal(approved, new Date("2026-09-20T00:00:00.001Z"), (next) => {
			next.run.tasks[0]!.phase = "integrating";
			next.run.tasks[0]!.integration = {
			phase: "intended", targetBranch: "main", targetRevision: base, approvedBaseRevision: evidence.subject.kind === "git" ? evidence.subject.baseRevision : "", approvedHeadRevision: head, approvedCommits: [...commits], builderAttemptId: builder.id, reviewerAttemptId: reviewer.id, builderManifestSha256: builder.evidence?.phase === "finalized" ? builder.evidence.manifestSha256 : "", reviewerManifestSha256: reviewer.evidence?.phase === "finalized" ? reviewer.evidence.manifestSha256 : "", action: { kind: "fast-forward", argv: ["merge", "--ff-only", "--no-edit", head] }, intendedAt: "2026-09-20T00:00:00.001Z",
			};
		});
		const stored = await harness.deps.runJournal.replaceActive(harness.root, intended);
		if (stored.kind !== "replaced") throw new Error(`intended replacement failed: ${JSON.stringify(stored)}`);
		await harness.deps.git.integrateApprovedRange!(targetInputWithAction(targetInput, "fast-forward", head));
		const mergesBefore = jsonCalls(harness).filter((call) => call[1] === "merge").length;
		await invoke(harness, "status");
		const integrated = await load(harness);
		expect(integrated.run.tasks[0]?.integration?.phase).toBe("integrated");
		expect(integrated.run.tasks[0]?.integration && "observedHead" in integrated.run.tasks[0]!.integration ? integrated.run.tasks[0]!.integration.observedHead : undefined).toBe(head);
		expect(jsonCalls(harness).filter((call) => call[1] === "merge").length).toBe(mergesBefore);
		const oldAttempts = approved.run.tasks[0]!.attempts;
		const finalAttempts = integrated.run.tasks[0]!.attempts;
		expect(finalAttempts).toEqual(oldAttempts);
		const repeat = await invoke(harness, "status");
		expect(repeat.kind).toBe("present");
		expect(jsonCalls(harness).filter((call) => call[1] === "merge").length).toBe(mergesBefore);
	});

	it("recognizes an already-applied real no-ff merge from the registered queue without reapplying it", async () => {
		const harness = await makeHarness({ taskCount: 2, maximumActiveTasks: 2, passiveInspectionIntervalSeconds: 1_000_000 });
		await startAndLoad(harness);
		let current = await load(harness);
		for (let pass = 0; pass < 6 && current.run.tasks[1]?.phase !== "building"; pass += 1) {
			await invokeResume(harness);
			current = await load(harness);
		}
		expect(current.run.tasks[0]?.phase).toBe("building");
		expect(current.run.tasks[1]?.phase).toBe("building");
		await writeBuilderReport(harness, current, 0);
		await writeBuilderReport(harness, current, 1);
		const inspect = harness.deps.git.inspectIntegrationCheckout;
		harness.deps.git.inspectIntegrationCheckout = undefined;
		for (let pass = 0; pass < 6; pass += 1) {
			current = await load(harness);
			for (let taskIndex = 0; taskIndex < current.run.tasks.length; taskIndex += 1) {
				if (current.run.tasks[taskIndex]?.attempts.at(-1)?.role === "reviewer") await writeReviewerReport(harness, current, taskIndex);
			}
			if (current.run.tasks.every((task) => task.attempts.at(-1)?.role === "reviewer")) break;
			await invoke(harness, "status");
		}
		current = await load(harness);
		expect(current.run.tasks.every((task) => task.attempts.at(-1)?.role === "reviewer")).toBe(true);
		for (let pass = 0; pass < 6; pass += 1) {
			current = await load(harness);
			if (current.run.tasks.every((task) => task.phase === "approved")) break;
			await invoke(harness, "status");
		}
		const approved = await load(harness);
		harness.deps.git.inspectIntegrationCheckout = inspect;
		expect(approved.run.tasks.every((task) => task.phase === "approved")).toBe(true);
		const peerBefore = structuredClone(approved.run.tasks[1]);

		await invoke(harness, "status");
		const afterFirst = await load(harness);
		const firstIntegration = afterFirst.run.tasks[0]?.integration;
		expect(firstIntegration?.phase).toBe("integrated");
		expect(afterFirst.run.tasks[1]).toEqual(peerBefore);
		const targetRevision = firstIntegration && firstIntegration.phase === "integrated" ? firstIntegration.observedHead : "";
		const subject = afterFirst.run.tasks[1]?.approval?.subject;
		expect(subject?.kind).toBe("git");
		if (!subject || subject.kind !== "git") return;
		const secondBuilder = afterFirst.run.tasks[1]!.attempts.find((attempt) => attempt.id === afterFirst.run.tasks[1]!.approval?.builderAttemptId);
		const secondReviewer = afterFirst.run.tasks[1]!.attempts.find((attempt) => attempt.id === afterFirst.run.tasks[1]!.approval?.reviewerAttemptId);
		expect(secondBuilder?.role).toBe("builder");
		expect(secondReviewer?.role).toBe("reviewer");
		if (!secondBuilder || secondBuilder.role !== "builder" || !secondReviewer || secondReviewer.role !== "reviewer") return;
		const intended = advanceRunJournal(afterFirst, new Date("2026-09-20T00:00:00.031Z"), (next) => {
			const task = next.run.tasks[1]!;
			task.phase = "integrating";
			task.attention = "none";
			delete task.attentionReason;
			delete task.attentionDiagnostic;
			task.integration = {
				phase: "intended",
				targetBranch: "main",
				targetRevision,
				approvedBaseRevision: subject.baseRevision,
				approvedHeadRevision: subject.headRevision,
				approvedCommits: [...subject.commits],
				builderAttemptId: secondBuilder.id,
				reviewerAttemptId: secondReviewer.id,
				builderManifestSha256: secondBuilder.evidence?.phase === "finalized" ? secondBuilder.evidence.manifestSha256 : "",
				reviewerManifestSha256: secondReviewer.evidence?.phase === "finalized" ? secondReviewer.evidence.manifestSha256 : "",
				action: { kind: "merge-commit", argv: ["merge", "--no-ff", "--no-edit", subject.headRevision] },
				intendedAt: "2026-09-20T00:00:00.031Z",
			};
		});
		const stored = await harness.deps.runJournal.replaceActive(harness.root, intended);
		if (stored.kind !== "replaced") throw new Error(`second integration intent replacement failed: ${JSON.stringify(stored)}`);
		const targetInput: IntegrationCheckoutInput = { repositoryRoot: harness.root, targetBranch: "main", targetRevision, approvedBaseRevision: subject.baseRevision, approvedHeadRevision: subject.headRevision, approvedCommits: [...subject.commits] };
		const before = await harness.deps.git.inspectIntegrationCheckout!(targetInput);
		expect(before.kind).toBe("inspected");
		if (before.kind !== "inspected") return;
		expect(before.target?.relation).toBe("recorded");
		expect(before.application?.kind).toBe("absent");
		const effect = await harness.deps.git.integrateApprovedRange!(targetInputWithAction(targetInput, "merge-commit", subject.headRevision));
		expect(effect.kind).toBe("completed");
		const mergeHead = await git(harness.root, ["rev-parse", "HEAD"]);
		expect(await git(harness.root, ["rev-list", "--parents", "-n", "1", mergeHead])).toBe(`${mergeHead} ${targetRevision} ${subject.headRevision}`);
		const mergesBefore = jsonCalls(harness).filter((call) => call[1] === "merge").length;
		await invoke(harness, "status");
		const integrated = await load(harness);
		const secondIntegration = integrated.run.tasks[1]?.integration;
		expect(secondIntegration?.phase).toBe("integrated");
		if (secondIntegration?.phase === "integrated") expect(secondIntegration.observedHead).toBe(mergeHead);
		expect(secondIntegration?.action.kind).toBe("merge-commit");
		expect(jsonCalls(harness).filter((call) => call[1] === "merge").length).toBe(mergesBefore);
	});

	it("reserves one retry before the fixed real merge and never repeats after CAS/effect ambiguity", async () => {
		const harness = await makeHarness();
		const approved = await reachApproved(harness);
		const originalReplace = harness.deps.runJournal.replaceActive.bind(harness.deps.runJournal);
		let rejectRetry = true;
		harness.deps.runJournal.replaceActive = async (root, candidate) => {
			if (rejectRetry && candidate.run.tasks[0]?.integration?.phase === "retry-intended") {
				rejectRetry = false;
				return { kind: "storage-error", paths: resolveRunJournalPaths(root), diagnostics: [] };
			}
			return originalReplace(root, candidate);
		};
		await invoke(harness, "status");
		expect(jsonCalls(harness).filter((call) => call[1] === "merge")).toHaveLength(0);
		const afterCasLoss = await load(harness);
		expect(afterCasLoss.run.tasks[0]?.integration?.phase).toBe("intended");

		const retryHarness = await makeHarness();
		const retryApproved = await reachApproved(retryHarness);
		const replace = retryHarness.deps.runJournal.replaceActive.bind(retryHarness.deps.runJournal);
		let rejectIntegrated = true;
		retryHarness.deps.runJournal.replaceActive = async (root, candidate) => {
			if (rejectIntegrated && candidate.run.tasks[0]?.integration?.phase === "integrated") {
				rejectIntegrated = false;
				const paths = resolveRunJournalPaths(root);
				return { kind: "storage-error", paths, diagnostics: [] };
			}
			return replace(root, candidate);
		};
		await invoke(retryHarness, "status");
		expect(jsonCalls(retryHarness).filter((call) => call[1] === "merge")).toHaveLength(1);
		const ambiguous = await load(retryHarness);
		expect(ambiguous.run.tasks[0]?.integration?.phase).toBe("retry-intended");
		await invoke(retryHarness, "status");
		expect(jsonCalls(retryHarness).filter((call) => call[1] === "merge")).toHaveLength(1);
		await invoke(retryHarness, "status");
		expect((await load(retryHarness)).run.tasks[0]?.integration?.phase).toBe("integrated");
		expect(retryApproved.run.tasks[0]?.attempts).toEqual((await load(retryHarness)).run.tasks[0]?.attempts);
	});

	it("preserves a real conflict and operation markers, and keeps foreign status read-only", async () => {
		const harness = await makeHarness();
		const approved = await reachApproved(harness);
		const base = approved.run.integrationBase.kind === "git" ? approved.run.integrationBase.revision : "";
		await writeFile(join(harness.root, "src", "base.txt"), "target\n");
		await git(harness.root, ["add", "src/base.txt"]);
		await git(harness.root, ["commit", "-m", "target conflict"]);
		const target = await git(harness.root, ["rev-parse", "HEAD"]);
		const builderHead = approved.run.tasks[0]!.approval?.subject.kind === "git" ? approved.run.tasks[0]!.approval.subject.headRevision : "";
		await git(harness.root, ["merge", "--no-commit", builderHead]).catch(() => undefined);
		const beforeStatus = await git(harness.root, ["status", "--porcelain=v1", "-z"]);
		const beforeHead = await git(harness.root, ["rev-parse", "HEAD"]);
		const callsBeforeForeign = harness.calls.length;
		await invoke(harness, "status", "foreign-session");
		expect(harness.calls.length).toBe(callsBeforeForeign);
		await invoke(harness, "status");
		const after = await load(harness);
		expect(after.run.tasks[0]?.attention).toBe("needs-user");
		expect(after.run.tasks[0]?.integration?.phase).toBe("ambiguous");
		expect(after.run.tasks[0]?.integration && "observed" in after.run.tasks[0]!.integration ? after.run.tasks[0]!.integration.observed.operationMarkers : []).toContain("MERGE_HEAD");
		expect(await git(harness.root, ["rev-parse", "HEAD"])).toBe(beforeHead);
		expect(await git(harness.root, ["status", "--porcelain=v1", "-z"])).toBe(beforeStatus);
		expect(target).not.toBe(base);
		expect(jsonCalls(harness).some(forbiddenGitCall)).toBe(false);
	});

	it("stops on clean target movement and takes one same-Builder integration-rework cycle for a real merge-tree conflict", async () => {
		const harness = await makeHarness();
		const approved = await reachApproved(harness);
		const targetBase = approved.run.integrationBase.kind === "git" ? approved.run.integrationBase.revision : "";
		await writeFile(join(harness.root, "target-only.txt"), "advanced\n");
		await git(harness.root, ["add", "target-only.txt"]);
		await git(harness.root, ["commit", "-m", "target advance"]);
		const advanced = await git(harness.root, ["rev-parse", "HEAD"]);
		await invoke(harness, "status");
		const moved = await load(harness);
		expect(moved.run.tasks[0]?.attention).toBe("needs-user");
		expect(moved.run.tasks[0]?.integration?.phase).toBe("ambiguous");
		expect(jsonCalls(harness).filter((call) => call[1] === "merge")).toHaveLength(0);

		const conflictHarness = await makeHarness();
		const conflictApproved = await reachApproved(conflictHarness);
		const conflictBase = conflictApproved.run.integrationBase.kind === "git" ? conflictApproved.run.integrationBase.revision : "";
		const sourceHead = conflictApproved.run.tasks[0]!.approval?.subject.kind === "git" ? conflictApproved.run.tasks[0]!.approval.subject.headRevision : "";
		const oldAttempts = structuredClone(conflictApproved.run.tasks[0]!.attempts);
		const oldAttemptBytes = oldAttempts.map((attempt) => JSON.stringify(attempt));
		await writeFile(join(conflictHarness.root, "src", "base.txt"), "target side\n");
		await git(conflictHarness.root, ["add", "src/base.txt"]);
		await git(conflictHarness.root, ["commit", "-m", "conflicting target advance"]);
		const conflictAdvanced = await git(conflictHarness.root, ["rev-parse", "HEAD"]);
		await invoke(conflictHarness, "status");
		const reworked = await load(conflictHarness);
		const task = reworked.run.tasks[0]!;
		expect(task.phase).toBe("reworking");
		expect(task.attention).toBe("none");
		expect(task.reworkCycles).toBe(1);
		expect(task.approval?.phase).toBe("invalidated");
		expect(task.approval && "reason" in task.approval ? task.approval.reason : undefined).toBe("target-advanced");
		expect(task.integration).toBeUndefined();
		expect(task.integrationRecoveries).toHaveLength(1);
		expect(task.attempts.at(-1)?.role).toBe("builder");
		const replacement = task.attempts.at(-1);
		expect(replacement?.role).toBe("builder");
		if (replacement?.role === "builder") {
			expect(replacement.baseRevision).toBe(conflictAdvanced);
			expect("integrationRecovery" in replacement.dispatch).toBe(true);
		}
		expect(jsonCalls(conflictHarness).filter((call) => call[1] === "merge")).toHaveLength(0);
		expect(jsonCalls(conflictHarness).some(forbiddenGitCall)).toBe(false);
		expect(conflictBase).not.toBe(conflictAdvanced);
		expect(targetBase).not.toBe(advanced);
		expect(sourceHead).not.toBe(conflictAdvanced);

		await writeIntegrationReworkBuilderReport(conflictHarness, reworked);
		await invoke(conflictHarness, "status");
		let freshReview = await load(conflictHarness);
		expect(freshReview.run.tasks[0]?.attempts.at(-1)?.role).toBe("reviewer");
		await writeReviewerReport(conflictHarness, freshReview);
		const inspect = conflictHarness.deps.git.inspectIntegrationCheckout;
		conflictHarness.deps.git.inspectIntegrationCheckout = undefined;
		await invoke(conflictHarness, "status");
		conflictHarness.deps.git.inspectIntegrationCheckout = inspect;
		freshReview = await load(conflictHarness);
		const freshTask = freshReview.run.tasks[0]!;
		expect(freshTask.phase).toBe("approved");
		expect(freshTask.approval?.phase).toBe("valid");
		expect(freshTask.approval?.builderAttemptId).toBe("attempt-03");
		expect(freshTask.approval?.reviewerAttemptId).toBe("attempt-04");
		expect(freshTask.attempts).toHaveLength(oldAttempts.length + 2);
		expect(freshTask.attempts.slice(0, oldAttempts.length)).toEqual(oldAttempts);
		expect(freshTask.attempts.slice(0, oldAttempts.length).map((attempt) => JSON.stringify(attempt))).toEqual(oldAttemptBytes);
		expect(freshTask.integrationRecoveries).toEqual(reworked.run.tasks[0]?.integrationRecoveries);
		if (freshTask.approval?.phase !== "valid" || freshTask.approval.subject.kind !== "git") return;
		expect(freshTask.approval.subject.baseRevision).toBe(conflictAdvanced);
		await invoke(conflictHarness, "status");
		const integrated = await load(conflictHarness);
		expect(integrated.run.tasks[0]?.integration?.phase).toBe("integrated");
		if (integrated.run.tasks[0]?.integration?.phase === "integrated") {
			expect(integrated.run.tasks[0].integration.targetRevision).toBe(conflictAdvanced);
			expect(integrated.run.tasks[0].integration.approvedBaseRevision).toBe(conflictAdvanced);
			expect(integrated.run.tasks[0].integration.builderAttemptId).toBe("attempt-03");
			expect(integrated.run.tasks[0].integration.reviewerAttemptId).toBe("attempt-04");
			expect(integrated.run.tasks[0].integration.observedHead).toBe(freshTask.approval.subject.headRevision);
		}
		expect(await git(conflictHarness.root, ["rev-parse", "HEAD"])).toBe(freshTask.approval.subject.headRevision);
		expect(jsonCalls(conflictHarness).filter((call) => call[1] === "merge").at(-1)).toEqual(["git", "merge", "--ff-only", "--no-edit", freshTask.approval.subject.headRevision]);
		expect(jsonCalls(conflictHarness).some(forbiddenGitCall)).toBe(false);
	});

	it("freezes the integration-rework limit and retains the advanced conflict for user attention", async () => {
		const harness = await makeHarness({ reworkCycleLimit: 0 });
		const approved = await reachApproved(harness);
		await writeFile(join(harness.root, "src", "base.txt"), "target side\n");
		await git(harness.root, ["add", "src/base.txt"]);
		await git(harness.root, ["commit", "-m", "target advance at frozen limit"]);
		await invoke(harness, "status");
		const stopped = await load(harness);
		const task = stopped.run.tasks[0]!;
		expect(task.phase).toBe("integrating");
		expect(task.attention).toBe("needs-user");
		expect(task.attentionReason).toBe("integration-ambiguous");
		expect(task.reworkCycles).toBe(0);
		expect(task.attempts).toHaveLength(2);
		expect(task.integration?.phase).toBe("ambiguous");
		expect(task.integration && "difference" in task.integration ? task.integration.difference?.commits.length : 0).toBeGreaterThan(0);
		expect(jsonCalls(harness).filter((call) => call[1] === "merge")).toHaveLength(0);
		expect(jsonCalls(harness).some(forbiddenGitCall)).toBe(false);
	});

	it("keeps schema-v1 bytes strict, preserves peers, and rejects forbidden recovery argv", async () => {
		const harness = await makeHarness();
		const approved = await reachApproved(harness);
		const paths = resolveRunJournalPaths(harness.root);
		const oldBytes = await readFile(paths.activePath, "utf8");
		const decoded = deserializeRunJournal(oldBytes, paths.activePath);
		expect(decoded.value).toBeDefined();
		if (decoded.value) expect(serializeRunJournal(decoded.value)).toBe(oldBytes);
		const raw = JSON.parse(oldBytes) as { run: { tasks: Array<Record<string, unknown>> } };
		raw.run.tasks[0]!.unexpected = true;
		expect(deserializeRunJournal(`${JSON.stringify(raw)}\n`, paths.activePath).value).toBeUndefined();
		const peerSnapshot = structuredClone(approved.run.tasks[0]);
		expect(peerSnapshot).toEqual(approved.run.tasks[0]);
		expect(jsonCalls(harness).some(forbiddenGitCall)).toBe(false);
	});
});

function targetInputWithAction(input: IntegrationCheckoutInput, kind: "fast-forward" | "merge-commit", head: string): IntegrationMutationInput {
	if (kind === "fast-forward") return { ...input, action: { kind, argv: ["merge", "--ff-only", "--no-edit", head] } };
	return { ...input, action: { kind, argv: ["merge", "--no-ff", "--no-edit", head] } };
}
