import { removeFixture } from "./remove-fixture.ts";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createConfigStore } from "../src/config-store.ts";
import { createRunJournalAdapter } from "../src/adapters.ts";
import { registerStewardExtension, type StewardCommandContext, type StewardCommandHandler, type StewardRegistrationSurface } from "../src/extension.ts";
import { countActiveTasks, selectIntegrationQueueHead } from "../src/coordination.ts";
import { advanceRunJournal, builderAssignmentSha256 } from "../src/run.ts";
import { serializeBuilderAttemptReport, type BuilderAttemptReport } from "../src/attempt-report.ts";
import { deserializeReviewerAssignment, reviewerAssignmentSha256, serializeReviewerAttemptReport, type ReviewerAttemptReport } from "../src/review.ts";
import type { ProjectModelPlans, RecoveryDefaults } from "../src/config.ts";
import type { AttemptRecord, RunDraft, RunJournal, SilenceInspectionSnapshot, SilencePhase, TaskRecord } from "../src/run.ts";
import type { GitCommandOutcome, IntegrationCheckoutInput, IntegrationCheckoutResult, ManagedAgentInspection, MonitorWaitResult, StewardDependencies, StewardUiAdapter, VerificationProcessOutcome } from "../src/steward.ts";

const roots: string[] = [];
const baseRevision = "0123456789abcdef0123456789abcdef01234567";
const models: ProjectModelPlans = {
	builder: { primary: { model: "builder/primary", thinkingLevel: "high" }, fallbacks: [] },
	reviewer: { primary: { model: "reviewer/primary", thinkingLevel: "high" }, fallbacks: [] },
};

function recovery(maximumActiveTasks: number): RecoveryDefaults {
	return { passiveInspectionIntervalSeconds: 301, secondInspectionAndNudgeIntervalSeconds: 302, nudgeGracePeriodSeconds: 121, externalCommandWarningThresholdSeconds: 1_801, maximumActiveTasks, transientRetryLimit: 1, reworkCycleLimit: 4 };
}

function draft(maximumActiveTasks: number): RunDraft {
	return {
		declaredOutcome: "Coordinate three changes",
		tasks: [
			{ requiredOutcome: "Change A", allowedScope: ["src/a"], expectedArtifacts: [{ kind: "git-commit" }], verification: { kind: "command", command: "true" }, reviewRequired: true },
			{ requiredOutcome: "Change B", allowedScope: ["src/b"], expectedArtifacts: [{ kind: "git-commit" }], verification: { kind: "command", command: "true" }, reviewRequired: true },
			{ requiredOutcome: "Nested change", allowedScope: ["src/a/nested"], expectedArtifacts: [{ kind: "git-commit" }], verification: { kind: "command", command: "true" }, reviewRequired: true },
		],
		modelPlan: models,
		effectiveSettings: recovery(maximumActiveTasks),
		finalVerification: { kind: "command", command: "true" },
	};
}

function queueTask(id: string, phase: TaskRecord["phase"], extra: Partial<TaskRecord> = {}): TaskRecord {
	return {
		specificationVersion: 1,
		specificationHash: `sha256:${"a".repeat(64)}`,
		contract: { id, requiredOutcome: id, allowedScope: [`src/${id.slice(-2)}`], expectedArtifacts: [{ kind: "git-commit" }], verification: { kind: "command", command: "true" }, reviewRequired: true },
		phase,
		attention: "none",
		attempts: [],
		reworkCycles: 0,
		...extra,
	} as TaskRecord;
}

function context(root: string): StewardCommandContext {
	return { mode: "tui", hasUI: true, cwd: root, modelRegistry: {} as StewardCommandContext["modelRegistry"], model: undefined, thinkingLevel: undefined, scopedModels: [], sessionManager: { getSessionId: () => "coordination-controller" } as StewardCommandContext["sessionManager"], ui: { select: async () => undefined, input: async () => undefined, confirm: async () => false, notify() {}, setStatus() {} } };
}

function register(dependencies: StewardDependencies): () => StewardCommandHandler {
	let handler: StewardCommandHandler | undefined;
	const surface: StewardRegistrationSurface = { on() {}, registerCommand(_name, options) { handler = options.handler; } };
	registerStewardExtension(surface, () => dependencies);
	return () => {
		if (!handler) throw new Error("Steward command was not registered");
		return handler;
	};
}

async function makeDependencies(root: string, maximumActiveTasks: number, observedStatus: { markdown?: string }): Promise<StewardDependencies> {
	const runJournal = createRunJournalAdapter();
	let sequence = 0;
	const herdr: StewardDependencies["herdr"] = {
		async checkAvailability() { return { kind: "available", status: "running", running: true, compatible: true, endpointCompatible: true }; },
		async createBuilderWorktree() {
			const active = await runJournal.loadActive(root);
			if (active.kind !== "loaded") throw new Error("Run was not durable before worktree creation");
			const task = active.journal.run.tasks.find((candidate) => candidate.phase === "building" && candidate.attempts[0]?.state === "prepared");
			if (!task) throw new Error("prepared Task missing");
			const n = task.contract.id.slice(-2);
			return { kind: "created", branch: task.attempts[0]!.dispatch.branch, path: join(root, `worktree-${n}`), workspaceId: `workspace-${n}`, tabId: `tab-${n}`, paneId: `pane-${n}`, terminalId: `terminal-${n}` };
		},
		async startBuilder(input) { const active = await runJournal.loadActive(root); if (active.kind !== "loaded") throw new Error("Run missing before start"); const attempt = active.journal.run.tasks.flatMap((task) => task.attempts).find((candidate) => candidate.role === "builder" && candidate.dispatch.phase === "agent-intended" && candidate.dispatch.agentName === input.name); if (!attempt || attempt.role !== "builder" || attempt.dispatch.phase !== "agent-intended") throw new Error("Builder identity missing"); return { kind: "started", name: input.name, agentKind: "pi", workspaceId: attempt.dispatch.workspaceId, tabId: "tab", paneId: attempt.dispatch.paneId, terminalId: attempt.dispatch.terminalId }; },
		async promptBuilder(input) { const active = await runJournal.loadActive(root); if (active.kind !== "loaded") throw new Error("Run missing before prompt"); const attempt = active.journal.run.tasks.flatMap((task) => task.attempts).find((candidate) => candidate.role === "builder" && candidate.dispatch.phase === "prompt-intended" && candidate.dispatch.agentName === input.name); if (!attempt || attempt.role !== "builder" || attempt.dispatch.phase !== "prompt-intended") throw new Error("Builder identity missing"); return { kind: "prompted", name: input.name, workspaceId: attempt.dispatch.workspaceId, tabId: "tab", paneId: attempt.dispatch.paneId, terminalId: attempt.dispatch.terminalId }; },
		async inspectManagedAgent(identity) { return { kind: "observed", identity, lifecycle: "working", stateChangeSequence: 1 }; },
		async readManagedTerminal() { return { kind: "observed", byteCount: 0, sha256: `sha256:${"1".repeat(64)}` }; },
	};
	const ui: StewardUiAdapter = {
		presentStatus(value) { if (value.kind === "present") observedStatus.markdown = value.markdown; },
		async draftRun() { return { kind: "drafted", draft: draft(maximumActiveTasks) }; },
		async confirmRun() { return true; },
		presentStartResult() {},
		presentResumeResult() {},
		presentConfigurationResult() {},
		async editConfiguration() { return { kind: "cancelled" }; },
	};
	return {
		runJournal,
		herdr,
		git: { async inspectIntegrationBase() { return { kind: "ready", branch: "main", revision: baseRevision }; }, async branchExists() { return false; }, async inspectBuilderWorktree(_path, expectedRevision) { return { kind: "ready", head: expectedRevision, clean: true }; }, async inspectManagedWorktreeProgress() { return { kind: "observed", head: baseRevision, worktree: { kind: "observed", byteCount: 0, sha256: `sha256:${"2".repeat(64)}` }, git: { head: baseRevision, digest: { kind: "observed", byteCount: 0, sha256: `sha256:${"3".repeat(64)}` } } }; } },
		process: { async inspectAttemptProcesses() { return { kind: "none", paneId: "pane", shellPid: 1, foregroundProcessGroupId: 1, processCount: 0, digest: `sha256:${"4".repeat(64)}` }; } },
		model: { listModelChoices: () => [], async validateModelPlans() { return []; } },
		clock: { now: () => new Date("2026-09-19T00:00:00.000Z"), randomUUID: () => `00000000-0000-0000-0000-${String(++sequence).padStart(12, "0")}` },
		ui,
	};
}

function sha256(value: string | Buffer): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

type MultiEffects = {
	currentHead: string;
	integrations: Array<{ taskId: string; kind: "fast-forward" | "merge-commit"; targetRevision: string; observedHead: string }>;
	verifications: number;
	stops: string[];
	now?: Date;
	nudges?: number;
	interrupts?: number;
	resumes?: number;
	recoveryPanes?: number;
	replacementStarts?: number;
	replacementPrompts?: number;
};

type CompletionHarnessOptions = {
	integration?: "failed" | "ambiguous" | "preflight";
	modelPlan?: ProjectModelPlans;
	transientRetryLimit?: number;
	builderTransientFailures?: number;
	reviewerTransientFailures?: number;
	inspectManagedAgent?: (identity: Parameters<NonNullable<StewardDependencies["herdr"]["inspectManagedAgent"]>>[0]) => Promise<ManagedAgentInspection>;
	waitForManagedAgent?: (identity: Parameters<NonNullable<StewardDependencies["herdr"]["waitForManagedAgent"]>>[0], timeoutMs: number, signal: AbortSignal) => Promise<MonitorWaitResult>;
};

function multiDraft(maximumActiveTasks: number, modelPlan = models, transientRetryLimit = 1): RunDraft {
	return {
		declaredOutcome: "Complete the ordered coordinated changes",
		tasks: [
			{ requiredOutcome: "Change A", allowedScope: ["src/a"], expectedArtifacts: [{ kind: "git-commit" }], verification: { kind: "command", command: "true" }, reviewRequired: true },
			{ requiredOutcome: "Change B", allowedScope: ["src/b"], expectedArtifacts: [{ kind: "git-commit" }], verification: { kind: "command", command: "true" }, reviewRequired: true },
			{ requiredOutcome: "Nested change", allowedScope: ["src/a/nested"], expectedArtifacts: [{ kind: "git-commit" }], verification: { kind: "command", command: "true" }, reviewRequired: true },
		],
		modelPlan,
		effectiveSettings: { ...recovery(maximumActiveTasks), transientRetryLimit },
		finalVerification: { kind: "command", command: "true" },
	};
}

function multiContext(root: string, session = "coordination-controller"): StewardCommandContext {
	return { ...context(root), sessionManager: { getSessionId: () => session } as StewardCommandContext["sessionManager"] };
}

async function makeCompletionDependencies(root: string, maximumActiveTasks: number, effects: MultiEffects, observed: { markdown?: string; condition?: string }, options: CompletionHarnessOptions = {}): Promise<StewardDependencies> {
	const runJournal = createRunJournalAdapter();
	let sequence = 0;
	let builderTransientFailures = options.builderTransientFailures ?? 0;
	let reviewerTransientFailures = options.reviewerTransientFailures ?? 0;
	const taskHead: Record<string, string> = { "task-01": "1111111111111111111111111111111111111111", "task-02": "2222222222222222222222222222222222222222", "task-03": "3333333333333333333333333333333333333333" };
	const taskScope: Record<string, string> = { "task-01": "src/a", "task-02": "src/b", "task-03": "src/a/nested" };
	const taskWorktree = (taskId: string): string => join(root, `worktree-${taskId}`);
	const taskForWorktree = (path: string): string => Object.keys(taskHead).find((taskId) => taskWorktree(taskId) === path) ?? "task-01";
	const identityFor = (taskId: string, role: "builder" | "reviewer") => ({
		workspaceId: `workspace-${taskId}`,
		paneId: `${role}-pane-${taskId}`,
		terminalId: `${role}-terminal-${taskId}`,
		tabId: `${role}-tab-${taskId}`,
	});
	const herdr: StewardDependencies["herdr"] = {
		async checkAvailability() { return { kind: "available", status: "running", running: true, compatible: true, endpointCompatible: true }; },
		async createBuilderWorktree() {
			const active = await runJournal.loadActive(root);
			if (active.kind !== "loaded") throw new Error("Run missing before worktree creation");
			const selected = active.journal.run.tasks.find((task) => task.phase === "building" && task.attempts[0]?.state === "prepared");
			if (!selected) throw new Error("Prepared Builder Task missing");
			const ids = identityFor(selected.contract.id, "builder");
			await mkdir(taskWorktree(selected.contract.id), { recursive: true });
			return { kind: "created", branch: selected.attempts[0]!.dispatch.branch, path: taskWorktree(selected.contract.id), ...ids };
		},
		async startBuilder(input) {
			const active = await runJournal.loadActive(root);
			if (active.kind !== "loaded") throw new Error("Run missing before Builder start");
			const attempt = active.journal.run.tasks.flatMap((task) => task.attempts).find((candidate) => candidate.role === "builder" && candidate.dispatch.phase === "agent-intended" && candidate.dispatch.agentName === input.name);
			if (!attempt || attempt.role !== "builder" || attempt.dispatch.phase !== "agent-intended") throw new Error("Builder identity missing");
			const ids = identityFor(active.journal.run.tasks.find((task) => task.attempts.some((candidate) => candidate.role === "builder" && candidate.dispatch.agentName === input.name))!.contract.id, "builder");
			const result = { kind: "started" as const, name: input.name, agentKind: "pi" as const, workspaceId: ids.workspaceId, tabId: ids.tabId, paneId: ids.paneId, terminalId: ids.terminalId };
			return result;
		},
		async promptBuilder(input) {
			const active = await runJournal.loadActive(root);
			if (active.kind !== "loaded") throw new Error("Run missing before Builder prompt");
			const task = active.journal.run.tasks.find((candidate) => candidate.attempts.some((attempt) => attempt.role === "builder" && attempt.dispatch.phase === "prompt-intended" && attempt.dispatch.agentName === input.name));
			if (!task) throw new Error("Builder identity missing");
			const ids = identityFor(task.contract.id, "builder");
			return { kind: "prompted", name: input.name, workspaceId: ids.workspaceId, tabId: ids.tabId, paneId: ids.paneId, terminalId: ids.terminalId };
		},
		async createReviewerPane(input) {
			const taskId = taskForWorktree(input.worktreePath);
			const ids = identityFor(taskId, "reviewer");
			return { kind: "created", workspaceId: input.workspaceId, tabId: ids.tabId, paneId: ids.paneId, terminalId: ids.terminalId, sourcePaneId: input.sourcePaneId, worktreePath: input.worktreePath };
		},
		async startReviewer(input) {
			const active = await runJournal.loadActive(root);
			if (active.kind !== "loaded") throw new Error("Run missing before Reviewer start");
			const task = active.journal.run.tasks.find((candidate) => candidate.attempts.some((attempt) => attempt.role === "reviewer" && attempt.dispatch.phase === "agent-intended" && attempt.dispatch.agentName === input.name));
			if (!task) throw new Error("Reviewer identity missing");
			const ids = identityFor(task.contract.id, "reviewer");
			return { kind: "started", name: input.name, agentKind: "pi", workspaceId: ids.workspaceId, tabId: ids.tabId, paneId: ids.paneId, terminalId: ids.terminalId };
		},
		async promptReviewer(input) {
			const active = await runJournal.loadActive(root);
			if (active.kind !== "loaded") throw new Error("Run missing before Reviewer prompt");
			const task = active.journal.run.tasks.find((candidate) => candidate.attempts.some((attempt) => attempt.role === "reviewer" && attempt.dispatch.phase === "prompt-intended" && attempt.dispatch.agentName === input.name));
			if (!task) throw new Error("Reviewer identity missing");
			if (task.contract.id === "task-01" && reviewerTransientFailures > 0) {
				reviewerTransientFailures -= 1;
				return { kind: "failed", stage: "agent-prompt", code: "provider-network-interruption", message: "scripted reviewer transient failure" };
			}
			const ids = identityFor(task.contract.id, "reviewer");
			return { kind: "prompted", name: input.name, workspaceId: ids.workspaceId, tabId: ids.tabId, paneId: ids.paneId, terminalId: ids.terminalId };
		},
		async inspectManagedAgent(identity) { return options.inspectManagedAgent ? options.inspectManagedAgent(identity) : { kind: "observed", identity, lifecycle: "working", stateChangeSequence: 1 }; },
		async waitForManagedAgent(identity, timeoutMs, signal) { return options.waitForManagedAgent ? options.waitForManagedAgent(identity, timeoutMs, signal) : { kind: "timeout" }; },
		async readManagedTerminal() { return { kind: "observed", byteCount: 0, sha256: `sha256:${"1".repeat(64)}` }; },
		async stopAgentGracefully(input) { effects.stops.push(input.name); return { kind: "acknowledged", name: input.name, workspaceId: input.workspaceId, tabId: "stopped-tab", paneId: input.paneId, terminalId: input.terminalId }; },
		async nudgeAgent(input) { effects.nudges = (effects.nudges ?? 0) + 1; return { kind: "prompted", name: input.identity.name, workspaceId: input.identity.workspaceId, tabId: "nudge-tab", paneId: input.identity.paneId, terminalId: input.identity.terminalId }; },
		async interruptAgent(input) { effects.interrupts = (effects.interrupts ?? 0) + 1; return { kind: "acknowledged", identity: { ...input.identity } }; },
		async resumeAgent(input) { effects.resumes = (effects.resumes ?? 0) + 1; return { kind: "prompted", name: input.identity.name, workspaceId: input.identity.workspaceId, tabId: "resume-tab", paneId: input.identity.paneId, terminalId: input.identity.terminalId }; },
		async createRecoveryPane(input) { effects.recoveryPanes = (effects.recoveryPanes ?? 0) + 1; return { kind: "created", workspaceId: input.workspaceId, tabId: "replacement-tab", paneId: `${input.sourcePaneId}-replacement`, terminalId: `${input.sourcePaneId}-replacement-terminal`, sourcePaneId: input.sourcePaneId, worktreePath: input.worktreePath }; },
		async startReplacementAgent(input) {
			effects.replacementStarts = (effects.replacementStarts ?? 0) + 1;
			const active = await runJournal.loadActive(root);
			if (active.kind !== "loaded") throw new Error("Run missing before replacement start");
			const attempt = active.journal.run.tasks.flatMap((task) => task.attempts).find((candidate) => (candidate.role === "builder" || candidate.role === "reviewer") && candidate.dispatch.phase === "agent-intended" && candidate.dispatch.agentName === input.name && candidate.dispatch.paneId === input.paneId);
			if (!attempt || (attempt.dispatch.phase !== "agent-intended")) throw new Error("Replacement identity missing");
			return { kind: "started", name: input.name, agentKind: "pi", workspaceId: attempt.dispatch.workspaceId, tabId: "replacement-start-tab", paneId: input.paneId, terminalId: attempt.dispatch.terminalId };
		},
		async promptReplacementAgent(input) {
			effects.replacementPrompts = (effects.replacementPrompts ?? 0) + 1;
			const active = await runJournal.loadActive(root);
			if (active.kind !== "loaded") throw new Error("Run missing before replacement prompt");
			const task = active.journal.run.tasks.find((candidate) => candidate.attempts.some((attempt) => attempt.dispatch.phase === "prompt-intended" && attempt.dispatch.agentName === input.identity.name));
			if (task?.contract.id === "task-01" && task.attempts.at(-1)?.role === "builder" && builderTransientFailures > 0) {
				builderTransientFailures -= 1;
				return { kind: "failed", stage: "agent-prompt", code: "provider-network-interruption", message: "scripted replacement Builder transient failure" };
			}
			if (task?.contract.id === "task-01" && task.attempts.at(-1)?.role === "reviewer" && reviewerTransientFailures > 0) {
				reviewerTransientFailures -= 1;
				return { kind: "failed", stage: "agent-prompt", code: "provider-network-interruption", message: "scripted replacement Reviewer transient failure" };
			}
			return { kind: "prompted", name: input.identity.name, workspaceId: input.identity.workspaceId, tabId: "replacement-prompt-tab", paneId: input.identity.paneId, terminalId: input.identity.terminalId };
		},
	};
	const ui: StewardUiAdapter = {
		presentStatus(value) { if (value.kind === "present") observed.markdown = value.markdown; },
		presentMonitorCondition(value) { observed.condition = value.condition; },
		async draftRun() { return { kind: "drafted", draft: multiDraft(maximumActiveTasks, options.modelPlan ?? models, options.transientRetryLimit ?? 1) }; },
		async confirmRun() { return true; },
		presentStartResult() {},
		presentResumeResult() {},
		presentConfigurationResult() {},
		async editConfiguration() { return { kind: "cancelled" }; },
		notifyCompletion() {},
	};
	const git: StewardDependencies["git"] = {
		async inspectIntegrationBase() { return { kind: "ready", branch: "main", revision: baseRevision }; },
		async branchExists() { return false; },
		async inspectBuilderWorktree(_path, expectedRevision) { return { kind: "ready", head: expectedRevision, clean: true }; },
		async inspectProducedCodeArtifact(input) {
			const taskId = taskForWorktree(input.worktreePath);
			return { kind: "inspected", base: input.approvedBase, head: input.producedHead, commits: [input.producedHead], changedPaths: [{ status: "M", paths: [taskScope[taskId]!] }], clean: true };
		},
		async inspectReviewWorktree(path) {
			const taskId = taskForWorktree(path);
			return { head: taskHead[taskId]!, dirtyStateFingerprint: `sha256:${taskId.slice(-1).repeat(64)}`, dirtyPaths: [], operationMarkers: [] };
		},
		async inspectIntegrationCheckout(input: IntegrationCheckoutInput): Promise<IntegrationCheckoutResult> {
			if (options.integration === "preflight") return { kind: "inspected", observation: { branch: "foreign", head: effects.currentHead, dirtyPaths: [], operationMarkers: [], rangeExact: false }, resolvedBaseRevision: input.approvedBaseRevision, resolvedHeadRevision: input.approvedHeadRevision, commits: [...input.approvedCommits] };
			return { kind: "inspected", observation: { branch: "main", head: effects.currentHead, dirtyPaths: [], operationMarkers: [], rangeExact: true }, resolvedBaseRevision: input.approvedBaseRevision, resolvedHeadRevision: input.approvedHeadRevision, commits: [...input.approvedCommits] };
		},
		async integrateApprovedRange(input): Promise<GitCommandOutcome> {
			const taskId = Object.keys(taskHead).find((id) => taskHead[id] === input.approvedHeadRevision) ?? "unknown";
			if (options.integration === "preflight") throw new Error("preflight should prevent the local Git effect");
			const observedHead = options.integration === "ambiguous" ? "9999999999999999999999999999999999999999" : input.action.kind === "fast-forward" ? input.approvedHeadRevision : effects.integrations.length === 1 ? "4444444444444444444444444444444444444444" : "5555555555555555555555555555555555555555";
			effects.integrations.push({ taskId, kind: input.action.kind, targetRevision: input.targetRevision, observedHead });
			if (options.integration !== "failed") effects.currentHead = observedHead;
			return options.integration === "failed" ? { kind: "completed", code: 1, stdout: "", stderr: "scripted merge failure", killed: false } : { kind: "completed", code: 0, stdout: "merged\n", stderr: "", killed: false };
		},
		async inspectManagedWorktreeProgress(path) {
			const taskId = taskForWorktree(path);
			return { kind: "observed", head: taskHead[taskId]!, worktree: { kind: "observed", byteCount: 0, sha256: `sha256:${"2".repeat(64)}` }, git: { head: taskHead[taskId]!, digest: { kind: "observed", byteCount: 0, sha256: `sha256:${"3".repeat(64)}` } } };
		},
	};
	const process: StewardDependencies["process"] = {
		async inspectAttemptProcesses(input) { return { kind: "none", paneId: input.identity.paneId, shellPid: 1, foregroundProcessGroupId: 1, processCount: 0, digest: `sha256:${"4".repeat(64)}` }; },
		async runApprovedVerification(_input): Promise<VerificationProcessOutcome> { effects.verifications += 1; return { kind: "completed", code: 0, stdout: "verified\n", stderr: "", killed: false }; },
	};
	return { runJournal, herdr, git, process, model: { listModelChoices: () => [], async validateModelPlans() { return []; }, async inspectModelChoice(choice) { return { choice, available: true, diagnostics: [] }; } }, clock: { now: () => new Date(effects.now ?? "2026-09-19T00:00:00.000Z"), randomUUID: () => `00000000-0000-0000-0000-${String(++sequence).padStart(12, "0")}` }, ui };
}

async function writeMultiBuilderReport(root: string, journal: RunJournal, taskId: string, head: string): Promise<void> {
	const task = journal.run.tasks.find((candidate) => candidate.contract.id === taskId);
	if (!task || task.attempts[0]?.role !== "builder") throw new Error(`Builder ${taskId} missing`);
	const attempt = task.attempts[0];
	const assignmentBytes = await readFile(attempt.assignmentPath);
	const logPath = join(attempt.evidenceDirectory, "check.log");
	await mkdir(attempt.evidenceDirectory, { recursive: true });
	await writeFile(logPath, "pass\n");
	const logBytes = await readFile(logPath);
	const report: BuilderAttemptReport = { schemaVersion: 1, identity: { runId: journal.run.id, taskId, attemptId: attempt.id, role: "builder", specificationHash: task.specificationHash, assignmentSha256: builderAssignmentSha256(assignmentBytes.toString("utf8")) }, status: "completed", summary: `${taskId} completed.`, blockers: [], producedArtifacts: [{ kind: "git-commit", baseRevision: attempt.baseRevision, headRevision: head, commits: [head] }], actualModel: attempt.actualModel, checks: [{ kind: "command", command: "true", exitCode: 0, summary: "pass", logId: "check-1" }], logReferences: [{ id: "check-1", path: logPath, size: logBytes.length, sha256: sha256(logBytes) }], producedRevision: head };
	await writeFile(attempt.reportPath, serializeBuilderAttemptReport(report));
}

async function writeMultiReviewerReport(journal: RunJournal, taskId: string): Promise<void> {
	const task = journal.run.tasks.find((candidate) => candidate.contract.id === taskId);
	const attempt = task?.attempts.at(-1);
	if (!task || !attempt || attempt.role !== "reviewer") throw new Error(`Reviewer ${taskId} missing`);
	const assignment = deserializeReviewerAssignment(await readFile(attempt.assignmentPath, "utf8"));
	if (!assignment.value) throw new Error(`Reviewer Assignment ${taskId} is invalid`);
	const report: ReviewerAttemptReport = { schemaVersion: 1, identity: { runId: journal.run.id, taskId, attemptId: attempt.id, role: "reviewer", specificationHash: attempt.specificationHash, assignmentSha256: reviewerAssignmentSha256(await readFile(attempt.assignmentPath, "utf8")) }, status: "completed", summary: `${taskId} approved.`, blockers: [], actualModel: attempt.actualModel, reviewedSubject: assignment.value.assignment.subject, verdict: "approved", findings: [], checks: [], logReferences: [] };
	await writeFile(attempt.reportPath, serializeReviewerAttemptReport(report));
}

async function resumeUntil(root: string, command: StewardCommandHandler, predicate: (journal: RunJournal) => boolean, limit = 30, session = "coordination-controller"): Promise<RunJournal> {
	for (let index = 0; index < limit; index += 1) {
		await command("resume", multiContext(root, session));
		const journal = await createRunJournalAdapter().loadActive(root);
		if (journal.kind === "loaded" && predicate(journal.journal)) return journal.journal;
	}
	throw new Error("registered Controller did not reach the expected multi-Task state");
}

function registerWithEvents(dependencies: StewardDependencies): { command: StewardCommandHandler; event(name: string): (event: unknown, context: StewardCommandContext) => Promise<unknown> } {
	let command: StewardCommandHandler | undefined;
	const events = new Map<string, (event: unknown, context: StewardCommandContext) => Promise<unknown>>();
	const surface: StewardRegistrationSurface = {
		on(name, handler) { events.set(name, handler as (event: unknown, context: StewardCommandContext) => Promise<unknown>); },
		registerCommand(_name, options) { command = options.handler; },
	};
	registerStewardExtension(surface, () => dependencies);
	return {
		command: (() => { if (!command) throw new Error("Steward command was not registered"); return command; })(),
		event(name) { const handler = events.get(name); if (!handler) throw new Error(`Steward event ${name} was not registered`); return handler; },
	};
}

async function prepareApprovedPair(root: string, dependencies: StewardDependencies, command: StewardCommandHandler): Promise<RunJournal> {
	await command("start", multiContext(root));
	let journal = await resumeUntil(root, command, (candidate) => candidate.run.tasks[1]?.phase === "building");
	await writeMultiBuilderReport(root, journal, "task-02", "2222222222222222222222222222222222222222");
	journal = await resumeUntil(root, command, (candidate) => candidate.run.tasks[1]?.attempts.at(-1)?.role === "reviewer");
	await writeMultiReviewerReport(journal, "task-02");
	journal = await resumeUntil(root, command, (candidate) => candidate.run.tasks[1]?.phase === "approved");
	await writeMultiBuilderReport(root, journal, "task-01", "1111111111111111111111111111111111111111");
	journal = await resumeUntil(root, command, (candidate) => candidate.run.tasks[0]?.attempts.at(-1)?.role === "reviewer");
	await writeMultiReviewerReport(journal, "task-01");
	return resumeUntil(root, command, (candidate) => candidate.run.tasks[0]?.phase === "approved");
}

async function waitUntilLoaded(root: string, predicate: (journal: RunJournal) => boolean, limit = 4_000): Promise<RunJournal> {
	for (let index = 0; index < limit; index += 1) {
		const loaded = await createRunJournalAdapter().loadActive(root);
		if (loaded.kind === "loaded" && predicate(loaded.journal)) return loaded.journal;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("registered multi-Task monitor did not reach the expected durable state");
}

function suspectedSilence(attempt: AttemptRecord, stamp: string): SilencePhase {
	if (attempt.role !== "builder" || (attempt.dispatch.phase !== "prompted" && attempt.dispatch.phase !== "reconciled-active")) throw new Error("multi-Task silence fixture requires a prompted Builder");
	const identity = { name: attempt.dispatch.agentName, workspaceId: attempt.dispatch.workspaceId, paneId: attempt.dispatch.paneId, terminalId: attempt.dispatch.terminalId };
	const hash = `sha256:${"a".repeat(64)}`;
	return {
		phase: "suspected",
		lastProgressAt: stamp,
		phaseAt: stamp,
		inspection: {
			attemptId: attempt.id,
			role: "builder",
			agent: identity,
			lifecycle: "working",
			stateChangeSequence: 1,
			terminal: { kind: "observed", byteCount: 0, sha256: hash },
			worktree: { kind: "observed", byteCount: 0, sha256: hash },
			git: { head: baseRevision, digest: hash },
			assignment: { path: attempt.assignmentPath, size: 1, sha256: hash },
			report: { kind: "missing" },
			evidence: { directory: attempt.evidenceDirectory, count: 0, byteCount: 0, sha256: hash, entries: [] },
			process: { kind: "none", paneId: identity.paneId, shellPid: 1, foregroundProcessGroupId: 1, processCount: 1, digest: hash },
		},
	};
}

async function exactSilenceSnapshot(root: string, dependencies: StewardDependencies, attempt: AttemptRecord): Promise<SilenceInspectionSnapshot> {
	if (attempt.role !== "builder" || (attempt.dispatch.phase !== "prompted" && attempt.dispatch.phase !== "reconciled-active")) throw new Error("multi-Task silence snapshot requires a prompted Builder");
	const identity = { name: attempt.dispatch.agentName, workspaceId: attempt.dispatch.workspaceId, paneId: attempt.dispatch.paneId, terminalId: attempt.dispatch.terminalId };
	const agent = await dependencies.herdr.inspectManagedAgent!(identity);
	const terminal = await dependencies.herdr.readManagedTerminal!(identity);
	const progress = await dependencies.git.inspectManagedWorktreeProgress!(attempt.dispatch.worktreePath);
	const preserved = await dependencies.runJournal.inspectAttemptPreservation!({ repositoryRoot: root, attempt });
	const process = await dependencies.process.inspectAttemptProcesses!({ repositoryRoot: root, identity });
	if (agent.kind !== "observed" || progress.kind !== "observed" || preserved.kind !== "inspected" || "kind" in preserved.assignment || process.kind !== "none" || progress.git.digest.kind !== "observed") throw new Error("multi-Task silence snapshot could not be observed exactly");
	return { attemptId: attempt.id, role: attempt.role, agent: identity, lifecycle: agent.lifecycle, stateChangeSequence: agent.stateChangeSequence, terminal, worktree: progress.worktree, git: { head: progress.git.head, digest: progress.git.digest.sha256 }, assignment: preserved.assignment, report: preserved.report, evidence: preserved.evidence, process };
}

afterEach(async () => { for (const root of roots.splice(0).reverse()) await removeFixture(root); });

describe("registered multi-Task coordination", () => {
	it("admits disjoint Tasks under the frozen cap, keeps the containing Task pending, and renders compact per-Task status", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-coordination-"));
		roots.push(root);
		const config = createConfigStore();
		await config.saveRecoveryDefaults(recovery(2));
		await config.saveModelPlans(root, models);
		const observed: { markdown?: string } = {};
		const dependencies = await makeDependencies(root, 2, observed);
		const command = register(dependencies)();
		await command("start", context(root));
		let loaded = await dependencies.runJournal.loadActive(root);
		expect(loaded.kind).toBe("loaded");
		if (loaded.kind !== "loaded") return;
		expect(loaded.journal.run.tasks.map((task) => task.phase)).toEqual(["building", "pending", "pending"]);
		for (let attempt = 0; attempt < 4; attempt += 1) {
			loaded = await dependencies.runJournal.loadActive(root);
			if (loaded.kind === "loaded" && loaded.journal.run.tasks[1]?.phase === "building") break;
			const result = await command("resume", context(root));
			const snapshot = await dependencies.runJournal.loadActive(root);
		}
		loaded = await dependencies.runJournal.loadActive(root);
		if (loaded.kind !== "loaded") return;
		expect(loaded.journal.run.tasks.map((task) => task.phase)).toEqual(["building", "building", "pending"]);
		const [first, second, third] = loaded.journal.run.tasks;
		expect(new Set([first!.attempts[0]!.dispatch.branch, second!.attempts[0]!.dispatch.branch]).size).toBe(2);
		expect(new Set([first!.attempts[0]!.assignmentPath, second!.attempts[0]!.assignmentPath]).size).toBe(2);
		expect(third!.attempts).toHaveLength(0);
		await command("status", context(root));
		expect(observed.markdown).toMatch(/Task 1 task-01: building/);
		expect(observed.markdown).toMatch(/Task 2 task-02: building/);
		expect(observed.markdown).toMatch(/Task 3 task-03: pending/);
		expect(observed.markdown).toMatch(/Active 2\/2/);
		expect(observed.markdown).toMatch(/Next integration task-01/);
	});

	it("rejects foreign bases and cross-Task resource adoption before replacing the active Journal", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-coordination-identity-"));
		roots.push(root);
		const config = createConfigStore();
		await config.saveRecoveryDefaults(recovery(2));
		await config.saveModelPlans(root, models);
		const dependencies = await makeDependencies(root, 2, {});
		const command = register(dependencies)();
		await command("start", context(root));
		for (let attempt = 0; attempt < 4; attempt += 1) {
			const loaded = await dependencies.runJournal.loadActive(root);
			if (loaded.kind === "loaded" && loaded.journal.run.tasks[1]?.phase === "building") break;
			await command("resume", context(root));
		}
		const loaded = await dependencies.runJournal.loadActive(root);
		expect(loaded.kind).toBe("loaded");
		if (loaded.kind !== "loaded") return;
		const before = await readFile(join(root, ".pi", "steward", "active-run.json"));
		const adopted = structuredClone(loaded.journal);
		adopted.journalRevision += 1;
		adopted.run.updatedAt = "2026-09-19T00:00:01.000Z";
		const firstAttempt = adopted.run.tasks[0]?.attempts[0];
		const secondAttempt = adopted.run.tasks[1]?.attempts[0];
		if (!firstAttempt || !secondAttempt) return;
		secondAttempt.assignmentPath = firstAttempt.assignmentPath;
		const adoptedResult = await dependencies.runJournal.replaceActive(root, adopted);
		expect(adoptedResult.kind).toBe("invalid-candidate");
		const foreign = structuredClone(loaded.journal);
		foreign.journalRevision += 1;
		foreign.run.updatedAt = "2026-09-19T00:00:02.000Z";
		const foreignAttempt = foreign.run.tasks[1]?.attempts[0];
		if (!foreignAttempt || foreignAttempt.role !== "builder") return;
		foreignAttempt.baseRevision = "ffffffffffffffffffffffffffffffffffffffff";
		const foreignResult = await dependencies.runJournal.replaceActive(root, foreign);
		expect(foreignResult.kind).toBe("invalid-candidate");
		expect(await readFile(join(root, ".pi", "steward", "active-run.json"))).toEqual(before);
	});

	it("enforces a registered cap of one without admitting the next Task", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-coordination-cap-"));
		roots.push(root);
		const config = createConfigStore();
		await config.saveRecoveryDefaults(recovery(1));
		await config.saveModelPlans(root, models);
		const dependencies = await makeDependencies(root, 1, {});
		const command = register(dependencies)();
		await command("start", context(root));
		for (let attempt = 0; attempt < 3; attempt += 1) await command("resume", context(root));
		const loaded = await dependencies.runJournal.loadActive(root);
		expect(loaded.kind).toBe("loaded");
		if (loaded.kind !== "loaded") return;
		expect(loaded.journal.run.tasks.map((task) => task.phase)).toEqual(["building", "pending", "pending"]);
		expect(loaded.journal.run.tasks.filter((task) => ["building", "reviewing", "reworking"].includes(task.phase))).toHaveLength(1);
	});

	it("integrates the approved order and opens the Completion Gate only after the complete prefix", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-coordination-completion-"));
		roots.push(root);
		const config = createConfigStore();
		await config.saveRecoveryDefaults(recovery(2));
		await config.saveModelPlans(root, models);
		const effects: MultiEffects = { currentHead: baseRevision, integrations: [], verifications: 0, stops: [] };
		const observed: { markdown?: string } = {};
		const dependencies = await makeCompletionDependencies(root, 2, effects, observed);
		const command = register(dependencies)();
		await command("start", multiContext(root));
		let journal = await resumeUntil(root, command, (candidate) => candidate.run.tasks[1]?.phase === "building");
		const first = journal.run.tasks[0]!;
		const second = journal.run.tasks[1]!;
		expect(first.attempts[0]?.role === "builder" ? first.attempts[0].baseRevision : undefined).toBe(baseRevision);
		expect(second.attempts[0]?.role === "builder" ? second.attempts[0].baseRevision : undefined).toBe(baseRevision);
		await writeMultiBuilderReport(root, journal, "task-02", "2222222222222222222222222222222222222222");
		journal = await resumeUntil(root, command, (candidate) => candidate.run.tasks[1]?.attempts.at(-1)?.role === "reviewer");
		await writeMultiReviewerReport(journal, "task-02");
		journal = await resumeUntil(root, command, (candidate) => candidate.run.tasks[1]?.phase === "approved");
		expect(effects.integrations).toHaveLength(0);
		expect(effects.verifications).toBe(0);
		await writeMultiBuilderReport(root, journal, "task-01", "1111111111111111111111111111111111111111");
		journal = await resumeUntil(root, command, (candidate) => candidate.run.tasks[0]?.attempts.at(-1)?.role === "reviewer");
		await writeMultiReviewerReport(journal, "task-01");
		journal = await resumeUntil(root, command, (candidate) => candidate.run.tasks[0]?.phase === "approved");
		expect(effects.integrations).toHaveLength(0);
		journal = await resumeUntil(root, command, (candidate) => effects.integrations.length === 1);
		expect(effects.integrations[0]).toMatchObject({ taskId: "task-01", kind: "fast-forward", targetRevision: baseRevision, observedHead: "1111111111111111111111111111111111111111" });
		journal = await resumeUntil(root, command, (candidate) => effects.integrations.length === 2);
		expect(effects.integrations[1]).toMatchObject({ taskId: "task-02", kind: "merge-commit", targetRevision: "1111111111111111111111111111111111111111" });
		journal = await resumeUntil(root, command, (candidate) => candidate.run.tasks[2]?.phase === "building");
		const thirdAttempt = journal.run.tasks[2]!.attempts[0];
		expect(thirdAttempt?.role === "builder" ? thirdAttempt.baseRevision : undefined).toBe("4444444444444444444444444444444444444444");
		await writeMultiBuilderReport(root, journal, "task-03", "3333333333333333333333333333333333333333");
		journal = await resumeUntil(root, command, (candidate) => candidate.run.tasks[2]?.attempts.at(-1)?.role === "reviewer");
		await writeMultiReviewerReport(journal, "task-03");
		journal = await resumeUntil(root, command, (candidate) => candidate.run.tasks[2]?.phase === "approved");
		expect(effects.verifications).toBe(0);
		await resumeUntil(root, command, () => effects.integrations.length === 3);
		expect(effects.integrations.map((item) => item.taskId)).toEqual(["task-01", "task-02", "task-03"]);
		expect(effects.verifications).toBe(0);
		journal = await resumeUntil(root, command, (candidate) => candidate.run.finalVerificationExecution?.phase === "passed");
		expect(effects.verifications).toBe(1);
		expect(journal.run.completion).toBeUndefined();
		journal = await resumeUntil(root, command, (candidate) => candidate.run.completion?.phase === "gate-passed");
		expect(journal.run.completion?.phase).toBe("gate-passed");
		expect(journal.run.completion?.gate).toMatchObject({ kind: "multi-task", tasks: expect.arrayContaining([expect.objectContaining({ taskId: "task-01" }), expect.objectContaining({ taskId: "task-02" }), expect.objectContaining({ taskId: "task-03" })]) });
	});

	it("hands a registered multi-Task Run to one new owner without changing slots or integration order", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-coordination-takeover-"));
		roots.push(root);
		const config = createConfigStore();
		await config.saveRecoveryDefaults(recovery(2));
		await config.saveModelPlans(root, models);
		const effects: MultiEffects = { currentHead: baseRevision, integrations: [], verifications: 0, stops: [] };
		const takeover: { kind?: string } = {};
		const dependencies = await makeCompletionDependencies(root, 2, effects, {});
		const ownerCommand = register(dependencies)();
		const approved = await prepareApprovedPair(root, dependencies, ownerCommand);
		const before = await dependencies.runJournal.loadActive(root);
		expect(before.kind).toBe("loaded");
		if (before.kind !== "loaded") return;
		const order = before.journal.run.tasks.map((task) => task.contract.id);
		const slots = before.journal.run.tasks.map((task) => ({ id: task.contract.id, attempts: task.attempts.map((attempt) => attempt.assignmentPath) }));
		expect(before.journal.run.effectiveSettings.maximumActiveTasks).toBe(2);
		expect(countActiveTasks(before.journal.run)).toBeLessThanOrEqual(2);
		const beforeTaskThree = structuredClone(before.journal.run.tasks[2]);
		dependencies.ui = { ...dependencies.ui, presentResumeResult(value) { takeover.kind = value.kind; } };
		const replacementCommand = register(dependencies)();
		await replacementCommand("resume --takeover", multiContext(root, "controller-b"));
		const taken = await dependencies.runJournal.loadActive(root);
		expect(taken.kind).toBe("loaded");
		if (taken.kind !== "loaded") return;
		expect(takeover.kind).toBe("taken-over");
		expect(taken.journal.run.controllerSessionId).toBe("controller-b");
		expect(taken.journal.run.controllerLease?.takeover?.basisJournalRevision).toBe(before.journal.journalRevision);
		expect(taken.journal.run.tasks.map((task) => task.contract.id)).toEqual(order);
		expect(taken.journal.run.tasks.map((task) => ({ id: task.contract.id, attempts: task.attempts.map((attempt) => attempt.assignmentPath) }))).toEqual(slots);
		expect(taken.journal.run.tasks[2]).toEqual(beforeTaskThree);
		expect(countActiveTasks(taken.journal.run)).toBeLessThanOrEqual(2);

		let journal = await resumeUntil(root, replacementCommand, (candidate) => effects.integrations.length === 1, 30, "controller-b");
		expect(effects.integrations.map((item) => item.taskId)).toEqual(["task-01"]);
		expect(journal.run.tasks[2]).toEqual(beforeTaskThree);
		journal = await resumeUntil(root, replacementCommand, (candidate) => effects.integrations.length === 2, 30, "controller-b");
		expect(effects.integrations.map((item) => item.taskId)).toEqual(["task-01", "task-02"]);
		expect(journal.run.tasks.map((task) => task.contract.id)).toEqual(order);
		expect(countActiveTasks(journal.run)).toBeLessThanOrEqual(2);
		journal = await resumeUntil(root, replacementCommand, (candidate) => candidate.run.tasks[2]?.phase === "building", 30, "controller-b");
		expect(journal.run.tasks[0]?.contract.id).toBe("task-01");
		expect(journal.run.tasks[1]?.contract.id).toBe("task-02");
		expect(journal.run.tasks[2]?.phase).toBe("building");
		expect(countActiveTasks(journal.run)).toBeLessThanOrEqual(2);
		expect(effects.integrations.map((item) => item.taskId)).toEqual(["task-01", "task-02"]);
	});

	it("keeps approved completion order as the integration queue even when a later Task is ready", () => {
		const later = queueTask("task-02", "approved", { approval: { phase: "valid", subject: { kind: "git", baseRevision, headRevision: "2222222222222222222222222222222222222222", commits: ["2222222222222222222222222222222222222222"], builderManifestSha256: `sha256:${"a".repeat(64)}` }, builderAttemptId: "attempt-01", reviewerAttemptId: "attempt-02", approvedAt: "2026-09-19T00:00:00.000Z", reviewerManifestPath: "/reviewer.json", reviewerManifestSha256: `sha256:${"b".repeat(64)}`, worktreeSnapshot: { head: "2222222222222222222222222222222222222222", dirtyStateFingerprint: `sha256:${"c".repeat(64)}`, dirtyPaths: [], operationMarkers: [] }, verdict: "approved" }, attempts: [{ id: "attempt-01", role: "builder", state: "reported", preparedAt: "2026-09-19T00:00:00.000Z", actualModel: { model: "builder/primary", thinkingLevel: "high" }, specificationHash: `sha256:${"a".repeat(64)}`, baseRevision, assignmentPath: "/a", reportPath: "/r", evidenceDirectory: "/e", dispatch: { phase: "prompted", branch: "b", agentName: "builder", worktreePath: "/w", workspaceId: "ws", paneId: "p", terminalId: "t", assignmentSha256: `sha256:${"d".repeat(64)}`, promptedAt: "2026-09-19T00:00:00.000Z" }, evidence: { phase: "finalized", finalizedAt: "2026-09-19T00:00:01.000Z", status: "completed", reportSha256: `sha256:${"e".repeat(64)}`, manifestPath: "/m", manifestSha256: `sha256:${"f".repeat(64)}`, producedRevision: "2222222222222222222222222222222222222222" } }] });
		const earlier = queueTask("task-01", "pending");
		const result = selectIntegrationQueueHead({ integrationBase: { kind: "git", branch: "main", revision: baseRevision }, tasks: [earlier, later] });
		expect(result).toMatchObject({ kind: "waiting", taskId: "task-01" });
	});

	it.each([
		["failed merge", "failed", "integration-failed"],
		["unexpected checkout", "ambiguous", "integration-ambiguous"],
		["foreign preflight", "preflight", "integration-preflight"],
	] as const)("durably blocks the ordered queue after a %s without touching the peer Task", async (_label, integration, attentionReason) => {
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-coordination-integration-boundary-"));
		roots.push(root);
		const config = createConfigStore();
		await config.saveRecoveryDefaults(recovery(2));
		await config.saveModelPlans(root, models);
		const effects: MultiEffects = { currentHead: baseRevision, integrations: [], verifications: 0, stops: [] };
		const dependencies = await makeCompletionDependencies(root, 2, effects, {}, { integration });
		const command = register(dependencies)();
		const approved = await prepareApprovedPair(root, dependencies, command);
		const peerBefore = structuredClone(approved.run.tasks[1]);
		const attemptsBefore = effects.integrations.length;
		const blocked = await resumeUntil(root, command, (candidate) => candidate.run.tasks[0]?.attentionReason === attentionReason);
		const owner = blocked.run.tasks[0]!;
		const peer = blocked.run.tasks[1]!;
		expect(owner.attention).toBe("needs-user");
		expect(owner.attentionReason).toBe(attentionReason);
		expect(owner.integration?.phase).toBe(integration === "ambiguous" ? "ambiguous" : integration === "failed" ? "failed" : undefined);
		if (integration === "ambiguous") expect(owner.integration).toMatchObject({ observed: { head: "9999999999999999999999999999999999999999", rangeExact: true } });
		if (integration === "failed") expect(owner.integration).toMatchObject({ exitCode: 1, diagnostic: "scripted merge failure", targetRevision: baseRevision });
		if (integration === "preflight") expect(owner.attentionDiagnostic).toContain("foreign@");
		expect(peer).toEqual(peerBefore);
		expect(selectIntegrationQueueHead(blocked.run)).toMatchObject({ kind: "waiting", taskId: "task-01", reason: "attention" });
		expect(effects.integrations.length).toBe(integration === "preflight" ? attemptsBefore : attemptsBefore + 1);
		expect(effects.verifications).toBe(0);
		expect(blocked.run.finalVerificationExecution).toBeUndefined();
		expect(blocked.run.completion).toBeUndefined();
		await command("resume", multiContext(root));
		const after = await dependencies.runJournal.loadActive(root);
		expect(after.kind).toBe("loaded");
		if (after.kind !== "loaded") return;
		expect(after.journal.run.tasks[0]?.attentionReason).toBe(attentionReason);
		expect(after.journal.run.tasks[1]).toEqual(peerBefore);
		expect(effects.integrations.length).toBe(integration === "preflight" ? attemptsBefore : attemptsBefore + 1);
		expect(effects.verifications).toBe(0);
		expect(effects.stops).toHaveLength(0);
	});

	it("runs the registered multi-Task monitor wait for exact current Attempts, earliest deadline, and loser cancellation", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-coordination-monitor-wait-"));
		roots.push(root);
		const config = createConfigStore();
		await config.saveRecoveryDefaults(recovery(2));
		await config.saveModelPlans(root, models);
		const effects: MultiEffects = { currentHead: baseRevision, integrations: [], verifications: 0, stops: [] };
		const dependencies = await makeCompletionDependencies(root, 2, effects, {});
		const registered = registerWithEvents(dependencies);
		await registered.command("start", multiContext(root));
		const active = await resumeUntil(root, registered.command, (candidate) => candidate.run.tasks[1]?.phase === "building");
		effects.now = new Date("2026-09-19T00:00:10.000Z");
		const silenceStamp = new Date(effects.now.getTime() - 1_000).toISOString();
		const tuned = advanceRunJournal(active, dependencies.clock.now(), (next) => {
			next.run.effectiveSettings = { ...next.run.effectiveSettings, passiveInspectionIntervalSeconds: 7, secondInspectionAndNudgeIntervalSeconds: 2 };
			const task = next.run.tasks[0]!;
			const attempt = task.attempts[0]!;
			task.attention = "suspected-stall";
			task.attentionReason = "silence-passive-inspection";
			attempt.recovery = { live: { observedAt: silenceStamp, kind: "working", lifecycle: "working", stateChangeSequence: 1 }, silence: suspectedSilence(attempt, silenceStamp) };
		});
		expect((await dependencies.runJournal.replaceActive(root, tuned)).kind).toBe("replaced");
		const waitCalls: Array<{ name: string; timeoutMs: number; identity: { name: string; workspaceId: string; paneId: string; terminalId: string } }> = [];
		const resolvers = new Map<string, (result: MonitorWaitResult) => void>();
		const cancelled: string[] = [];
		dependencies.herdr.inspectManagedAgent = async (identity) => ({ kind: "observed", identity, lifecycle: "working", stateChangeSequence: 4 });
		dependencies.herdr.waitForManagedAgent = async (identity, timeoutMs, signal) => await new Promise<MonitorWaitResult>((resolve) => {
			let settled = false;
			waitCalls.push({ name: identity.name, timeoutMs, identity });
			resolvers.set(identity.name, (result) => { if (!settled) { settled = true; resolve(result); } });
			signal.addEventListener("abort", () => { if (!settled) { settled = true; cancelled.push(identity.name); resolve({ kind: "cancelled" }); } }, { once: true });
		});
		await registered.event("session_start")({ type: "session_start", reason: "multi-task-monitor" }, multiContext(root));
		for (let index = 0; index < 4_000 && waitCalls.length < 2; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
		expect(waitCalls.map((call) => call.name)).toEqual(active.run.tasks.slice(0, 2).map((task) => task.attempts.at(-1)).map((attempt) => (attempt && "agentName" in attempt.dispatch ? attempt.dispatch.agentName : "missing")));
		expect(waitCalls.map((call) => call.timeoutMs)).toEqual([1_000, 1_000]);
		const monitored = await waitUntilLoaded(root, (candidate) => candidate.run.monitors?.length === 2);
		expect(monitored.run.monitor).toBeUndefined();
		expect(monitored.run.monitors?.map((checkpoint) => checkpoint.taskId)).toEqual(["task-01", "task-02"]);
		expect(monitored.run.monitors?.map((checkpoint) => checkpoint.attemptId)).toEqual(active.run.tasks.slice(0, 2).map((task) => task.attempts.at(-1)!.id));
		const winner = waitCalls[0]!;
		resolvers.get(winner.name)?.({ kind: "settled", lifecycle: "idle", identity: winner.identity, stateChangeSequence: 5 });
		for (let index = 0; index < 4_000 && cancelled.length === 0; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
		expect(cancelled).toContain(waitCalls[1]!.name);
		await registered.event("session_shutdown")({ type: "session_shutdown", reason: "test" }, multiContext(root));
	});

	it("commits registered multi-Task monitor checkpoints in Task order and preserves the newer CAS winner", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-coordination-monitor-cas-"));
		roots.push(root);
		const config = createConfigStore();
		await config.saveRecoveryDefaults(recovery(2));
		await config.saveModelPlans(root, models);
		const effects: MultiEffects = { currentHead: baseRevision, integrations: [], verifications: 0, stops: [] };
		const observed: { condition?: string } = {};
		const dependencies = await makeCompletionDependencies(root, 2, effects, observed);
		delete dependencies.herdr.waitForManagedAgent;
		const registered = registerWithEvents(dependencies);
		await registered.command("start", multiContext(root));
		await resumeUntil(root, registered.command, (candidate) => candidate.run.tasks[1]?.phase === "building");
		const originalReplace = dependencies.runJournal.replaceActive.bind(dependencies.runJournal);
		let injected = false;
		let loserKind: string | undefined;
		dependencies.runJournal.replaceActive = async (repositoryRoot, candidate) => {
			if (!injected && candidate.run.monitors?.length === 2) {
				injected = true;
				const current = await dependencies.runJournal.loadActive(repositoryRoot);
				if (current.kind !== "loaded") throw new Error("current Journal missing during monitor CAS test");
				const newer = advanceRunJournal(current.journal, dependencies.clock.now(), (next) => {
					next.run.monitors = candidate.run.monitors!.map((checkpoint) => checkpoint.taskId === "task-02" ? { ...checkpoint, terminal: { kind: "observed", byteCount: 99, sha256: sha256("newer-task-02") } } : { ...checkpoint });
				});
				expect((await originalReplace(repositoryRoot, newer)).kind).toBe("replaced");
			}
			const loser = await originalReplace(repositoryRoot, candidate);
			if (injected) loserKind = loser.kind;
			return loser;
		};
		await registered.event("session_start")({ type: "session_start", reason: "multi-task-monitor-cas" }, multiContext(root));
		const winner = await waitUntilLoaded(root, (candidate) => injected && loserKind !== undefined && candidate.run.monitors?.some((checkpoint) => checkpoint.taskId === "task-02" && checkpoint.terminal.kind === "observed" && checkpoint.terminal.byteCount === 99) === true);
		expect(injected).toBe(true);
		expect(loserKind).toBe("invalid-candidate");
		expect(observed.condition).toBe("degraded");
		expect(winner.run.monitors?.map((checkpoint) => checkpoint.taskId)).toEqual(["task-01", "task-02"]);
		expect(winner.run.monitors?.find((checkpoint) => checkpoint.taskId === "task-02")?.terminal).toMatchObject({ kind: "observed", byteCount: 99 });
		await registered.event("session_shutdown")({ type: "session_shutdown", reason: "test" }, multiContext(root));
	});

	it("keeps registered silence and transient retry lineage isolated to one Task", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-coordination-task-isolation-"));
		roots.push(root);
		const isolationModels: ProjectModelPlans = {
			builder: { primary: { model: "builder/primary", thinkingLevel: "high" }, fallbacks: [{ model: "builder/fallback", thinkingLevel: "medium" }] },
			reviewer: { primary: { model: "reviewer/primary", thinkingLevel: "high" }, fallbacks: [] },
		};
		const config = createConfigStore();
		await config.saveRecoveryDefaults(recovery(2));
		await config.saveModelPlans(root, isolationModels);
		const effects: MultiEffects = { currentHead: baseRevision, integrations: [], verifications: 0, stops: [] };
		const dependencies = await makeCompletionDependencies(root, 2, effects, {}, { modelPlan: isolationModels, transientRetryLimit: 2, builderTransientFailures: 1 });
		const inspectProcesses = dependencies.process.inspectAttemptProcesses!;
		dependencies.process.inspectAttemptProcesses = async (input) => ({ ...(await inspectProcesses(input)), processCount: 1 });
		let command = register(dependencies)();
		await command("start", multiContext(root));
		let journal = await resumeUntil(root, command, (candidate) => candidate.run.tasks[1]?.phase === "building");
		const taskOrderBeforeTakeover = journal.run.tasks.map((task) => task.contract.id);
		let takeoverKind: string | undefined;
		dependencies.ui = { ...dependencies.ui, presentResumeResult(value) { takeoverKind = value.kind; } };
		const replacementCommand = register(dependencies)();
		await replacementCommand("resume --takeover", multiContext(root, "controller-b"));
		expect(takeoverKind).toBe("taken-over");
		const afterTakeover = await dependencies.runJournal.loadActive(root);
		expect(afterTakeover.kind).toBe("loaded");
		if (afterTakeover.kind !== "loaded") return;
		expect(afterTakeover.journal.run.controllerSessionId).toBe("controller-b");
		expect(afterTakeover.journal.run.tasks.map((task) => task.contract.id)).toEqual(taskOrderBeforeTakeover);
		expect(countActiveTasks(afterTakeover.journal.run)).toBeLessThanOrEqual(2);
		command = replacementCommand;
		const ownerSession = "controller-b";
		const taskAInitial = journal.run.tasks[0]!;
		const initialAttempt = taskAInitial.attempts[0]!;
		if (initialAttempt.role !== "builder" || (initialAttempt.dispatch.phase !== "prompted" && initialAttempt.dispatch.phase !== "reconciled-active")) throw new Error("Task A Builder identity missing");
		const taskBInitialAttempt = journal.run.tasks[1]!.attempts[0]!;
		if (taskBInitialAttempt.role !== "builder" || (taskBInitialAttempt.dispatch.phase !== "prompted" && taskBInitialAttempt.dispatch.phase !== "reconciled-active")) throw new Error("Task B Builder identity missing");
		const taskAIdentity = { name: initialAttempt.dispatch.agentName, workspaceId: initialAttempt.dispatch.workspaceId, paneId: initialAttempt.dispatch.paneId, terminalId: initialAttempt.dispatch.terminalId };
		const taskBIdentity = { name: taskBInitialAttempt.dispatch.agentName, workspaceId: taskBInitialAttempt.dispatch.workspaceId, paneId: taskBInitialAttempt.dispatch.paneId, terminalId: taskBInitialAttempt.dispatch.terminalId };
		const replacementNames = new Set<string>();
		const replacementStarted = new Set<string>();
		dependencies.herdr.inspectManagedAgent = async (identity) => {
			if (identity.name === taskAIdentity.name || identity.name === taskBIdentity.name || replacementStarted.has(identity.name)) return { kind: "observed", identity, lifecycle: "working", stateChangeSequence: 1 };
			if (replacementNames.has(identity.name)) return { kind: "missing", diagnostic: "scripted replacement has not started" };
			return { kind: "missing", diagnostic: "unrecognized test identity" };
		};
		const createRecoveryPane = dependencies.herdr.createRecoveryPane!;
		dependencies.herdr.createRecoveryPane = async (input) => { replacementNames.add(input.agentName); return createRecoveryPane(input); };
		const startReplacementAgent = dependencies.herdr.startReplacementAgent!;
		dependencies.herdr.startReplacementAgent = async (input) => { replacementStarted.add(input.name); return startReplacementAgent(input); };
		journal = await resumeUntil(root, command, (candidate) => candidate.run.tasks[0]?.attempts[0]?.recovery?.live !== undefined, 30, ownerSession);
		journal = await resumeUntil(root, command, (candidate) => candidate.run.tasks[1]?.attempts[0]?.recovery?.live !== undefined, 30, ownerSession);
		const taskBBefore = structuredClone(journal.run.tasks[1]);
		journal = advanceRunJournal(journal, dependencies.clock.now(), (next) => { next.run.effectiveSettings = { ...next.run.effectiveSettings, passiveInspectionIntervalSeconds: 1, secondInspectionAndNudgeIntervalSeconds: 1, nudgeGracePeriodSeconds: 1 }; });
		expect((await dependencies.runJournal.replaceActive(root, journal)).kind).toBe("replaced");
		expect(journal.run.tasks[1]).toEqual(taskBBefore);
		const liveAt = journal.run.tasks[0]!.attempts[0]!.recovery!.live.observedAt;
		const taskAAttempt = journal.run.tasks[0]!.attempts[0]!;
		const inspection = await exactSilenceSnapshot(root, dependencies, taskAAttempt);
		journal = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
			const task = next.run.tasks[0];
			const attempt = task?.attempts[0];
			if (!task || !attempt) throw new Error("Task A disappeared while seeding its registered silence checkpoint");
			attempt.recovery = { ...(attempt.recovery ?? { live: { observedAt: liveAt, kind: "working" as const, lifecycle: "working" as const, stateChangeSequence: 1 } }), silence: { phase: "suspected", lastProgressAt: liveAt, phaseAt: liveAt, inspection } };
			task.attention = "suspected-stall";
			task.attentionReason = "silence-passive-inspection";
			task.attentionDiagnostic = "No authoritative progress was observed after the passive inspection interval.";
		});
		expect((await dependencies.runJournal.replaceActive(root, journal)).kind).toBe("replaced");
		effects.now = new Date(Date.parse(liveAt) + 1_000);
		journal = await resumeUntil(root, command, (candidate) => candidate.run.tasks[0]?.attempts[0]?.recovery?.silence?.phase === "nudged", 30, ownerSession);
		expect(effects.nudges).toBe(1);
		expect(journal.run.tasks[1]).toEqual(taskBBefore);
		const nudgedAt = Date.parse(journal.run.tasks[0]!.attempts[0]!.recovery!.silence!.phaseAt);
		effects.now = new Date(nudgedAt + 1_000);
		journal = await resumeUntil(root, command, (candidate) => candidate.run.tasks[0]?.attempts[0]?.recovery?.silence?.phase === "interrupted", 30, ownerSession);
		expect(effects.interrupts).toBe(1);
		expect(journal.run.tasks[1]).toEqual(taskBBefore);
		journal = await resumeUntil(root, command, (candidate) => candidate.run.tasks[0]?.attempts[0]?.recovery?.silence?.phase === "resumed", 30, ownerSession);
		expect(effects.resumes).toBe(1);
		expect(journal.run.tasks[1]).toEqual(taskBBefore);
		const resumedAt = Date.parse(journal.run.tasks[0]!.attempts[0]!.recovery!.silence!.phaseAt);
		const activeBeforeReplacement = countActiveTasks(journal.run);
		effects.now = new Date(resumedAt + 1_000);
		journal = await resumeUntil(root, command, (candidate) => candidate.run.tasks[0]?.attempts.some((attempt) => attempt.replacement?.kind === "silent-agent-recovery") === true, 30, ownerSession);
		expect(journal.run.tasks[1]).toEqual(taskBBefore);
		expect(countActiveTasks(journal.run)).toBeLessThanOrEqual(activeBeforeReplacement);
		expect(effects.recoveryPanes ?? 0).toBe(0);
		let transientFailureAttempt: AttemptRecord | undefined;
		for (let index = 0; index < 8 && !(journal.run.tasks[0]?.attempts.some((attempt) => attempt.replacement?.kind === "transient-recovery" && attempt.replacement.retryOrdinal === 2)); index += 1) {
			journal = await command("resume", multiContext(root, ownerSession)).then(async () => {
				const loaded = await dependencies.runJournal.loadActive(root);
				if (loaded.kind !== "loaded") throw new Error("Task-isolation Journal disappeared");
				return loaded.journal;
			});
			transientFailureAttempt ??= journal.run.tasks[0]?.attempts.find((attempt) => attempt.recovery?.infrastructure !== undefined);
		}
		const taskA = journal.run.tasks[0]!;
		const replacementAttempts = taskA.attempts.filter((attempt) => attempt.replacement);
		expect(replacementAttempts.map((attempt) => attempt.replacement && attempt.replacement.retryOrdinal)).toEqual([1, 2]);
		expect(replacementAttempts.map((attempt) => attempt.replacement && attempt.replacement.replacesAttemptId)).toEqual(["attempt-01", "attempt-02"]);
		expect(transientFailureAttempt?.recovery?.infrastructure?.kind).toBe("provider-network-interruption");
		expect(replacementAttempts[1]?.replacement).toMatchObject({ kind: "transient-recovery", retryOrdinal: 2, modelSelection: { kind: "approved-fallback", planIndex: 1, reason: "same-model-retry-failed" } });
		expect(replacementAttempts[1]?.actualModel).toEqual(isolationModels.builder.fallbacks[0]);
		expect(journal.run.tasks[1]).toEqual(taskBBefore);
		expect(countActiveTasks(journal.run)).toBeLessThanOrEqual(activeBeforeReplacement);
		expect(new Set([initialAttempt.assignmentPath, taskBInitialAttempt.assignmentPath]).size).toBe(2);
		expect(new Set([initialAttempt.dispatch.worktreePath, taskBInitialAttempt.dispatch.worktreePath]).size).toBe(2);
		expect(effects.replacementStarts).toBeGreaterThan(0);
		expect(effects.replacementPrompts).toBeGreaterThan(0);
	});
});
