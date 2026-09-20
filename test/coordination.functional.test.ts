import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createConfigStore } from "../src/config-store.ts";
import { createRunJournalAdapter } from "../src/adapters.ts";
import { registerStewardExtension, type StewardCommandContext, type StewardCommandHandler, type StewardRegistrationSurface } from "../src/extension.ts";
import { selectIntegrationQueueHead } from "../src/coordination.ts";
import { builderAssignmentSha256 } from "../src/run.ts";
import { serializeBuilderAttemptReport, type BuilderAttemptReport } from "../src/attempt-report.ts";
import { deserializeReviewerAssignment, reviewerAssignmentSha256, serializeReviewerAttemptReport, type ReviewerAttemptReport } from "../src/review.ts";
import type { ProjectModelPlans, RecoveryDefaults } from "../src/config.ts";
import type { RunDraft, RunJournal, TaskRecord } from "../src/run.ts";
import type { GitCommandOutcome, IntegrationCheckoutInput, IntegrationCheckoutResult, StewardDependencies, StewardUiAdapter, VerificationProcessOutcome } from "../src/steward.ts";

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
};

function multiDraft(maximumActiveTasks: number): RunDraft {
	return {
		declaredOutcome: "Complete the ordered coordinated changes",
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

function multiContext(root: string): StewardCommandContext {
	return { ...context(root), sessionManager: { getSessionId: () => "coordination-controller" } as StewardCommandContext["sessionManager"] };
}

async function makeCompletionDependencies(root: string, maximumActiveTasks: number, effects: MultiEffects, observed: { markdown?: string }): Promise<StewardDependencies> {
	const runJournal = createRunJournalAdapter();
	let sequence = 0;
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
			const ids = identityFor(task.contract.id, "reviewer");
			return { kind: "prompted", name: input.name, workspaceId: ids.workspaceId, tabId: ids.tabId, paneId: ids.paneId, terminalId: ids.terminalId };
		},
		async inspectManagedAgent(identity) { return { kind: "observed", identity, lifecycle: "working", stateChangeSequence: 1 }; },
		async readManagedTerminal() { return { kind: "observed", byteCount: 0, sha256: `sha256:${"1".repeat(64)}` }; },
		async stopAgentGracefully(input) { effects.stops.push(input.name); return { kind: "acknowledged", name: input.name, workspaceId: input.workspaceId, tabId: "stopped-tab", paneId: input.paneId, terminalId: input.terminalId }; },
	};
	const ui: StewardUiAdapter = {
		presentStatus(value) { if (value.kind === "present") observed.markdown = value.markdown; },
		async draftRun() { return { kind: "drafted", draft: multiDraft(maximumActiveTasks) }; },
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
			return { kind: "inspected", observation: { branch: "main", head: effects.currentHead, dirtyPaths: [], operationMarkers: [], rangeExact: true }, resolvedBaseRevision: input.approvedBaseRevision, resolvedHeadRevision: input.approvedHeadRevision, commits: [...input.approvedCommits] };
		},
		async integrateApprovedRange(input): Promise<GitCommandOutcome> {
			const taskId = Object.keys(taskHead).find((id) => taskHead[id] === input.approvedHeadRevision) ?? "unknown";
			const observedHead = input.action.kind === "fast-forward" ? input.approvedHeadRevision : effects.integrations.length === 1 ? "4444444444444444444444444444444444444444" : "5555555555555555555555555555555555555555";
			effects.integrations.push({ taskId, kind: input.action.kind, targetRevision: input.targetRevision, observedHead });
			effects.currentHead = observedHead;
			return { kind: "completed", code: 0, stdout: "merged\n", stderr: "", killed: false };
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
	return { runJournal, herdr, git, process, model: { listModelChoices: () => [], async validateModelPlans() { return []; }, async inspectModelChoice(choice) { return { choice, available: true, diagnostics: [] }; } }, clock: { now: () => new Date("2026-09-19T00:00:00.000Z"), randomUUID: () => `00000000-0000-0000-0000-${String(++sequence).padStart(12, "0")}` }, ui };
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

async function resumeUntil(root: string, command: StewardCommandHandler, predicate: (journal: RunJournal) => boolean, limit = 30): Promise<RunJournal> {
	for (let index = 0; index < limit; index += 1) {
		await command("resume", multiContext(root));
		const journal = await createRunJournalAdapter().loadActive(root);
		if (journal.kind === "loaded" && predicate(journal.journal)) return journal.journal;
	}
	throw new Error("registered Controller did not reach the expected multi-Task state");
}

afterEach(async () => { for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true }); });

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

	it("keeps approved completion order as the integration queue even when a later Task is ready", () => {
		const later = queueTask("task-02", "approved", { approval: { phase: "valid", subject: { kind: "git", baseRevision, headRevision: "2222222222222222222222222222222222222222", commits: ["2222222222222222222222222222222222222222"], builderManifestSha256: `sha256:${"a".repeat(64)}` }, builderAttemptId: "attempt-01", reviewerAttemptId: "attempt-02", approvedAt: "2026-09-19T00:00:00.000Z", reviewerManifestPath: "/reviewer.json", reviewerManifestSha256: `sha256:${"b".repeat(64)}`, worktreeSnapshot: { head: "2222222222222222222222222222222222222222", dirtyStateFingerprint: `sha256:${"c".repeat(64)}`, dirtyPaths: [], operationMarkers: [] }, verdict: "approved" }, attempts: [{ id: "attempt-01", role: "builder", state: "reported", preparedAt: "2026-09-19T00:00:00.000Z", actualModel: { model: "builder/primary", thinkingLevel: "high" }, specificationHash: `sha256:${"a".repeat(64)}`, baseRevision, assignmentPath: "/a", reportPath: "/r", evidenceDirectory: "/e", dispatch: { phase: "prompted", branch: "b", agentName: "builder", worktreePath: "/w", workspaceId: "ws", paneId: "p", terminalId: "t", assignmentSha256: `sha256:${"d".repeat(64)}`, promptedAt: "2026-09-19T00:00:00.000Z" }, evidence: { phase: "finalized", finalizedAt: "2026-09-19T00:00:01.000Z", status: "completed", reportSha256: `sha256:${"e".repeat(64)}`, manifestPath: "/m", manifestSha256: `sha256:${"f".repeat(64)}`, producedRevision: "2222222222222222222222222222222222222222" } }] });
		const earlier = queueTask("task-01", "pending");
		const result = selectIntegrationQueueHead({ integrationBase: { kind: "git", branch: "main", revision: baseRevision }, tasks: [earlier, later] });
		expect(result).toMatchObject({ kind: "waiting", taskId: "task-01" });
	});
});
