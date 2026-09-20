import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { afterEach, it, vi } from "vitest";

import { registerStewardExtension, type StewardCommandContext, type StewardCommandHandler, type StewardRegistrationSurface } from "../src/extension.ts";
import { createStewardSessionMonitor } from "../src/monitor.ts";
import { createRunJournalAdapter } from "../src/adapters.ts";
import { resolveRunJournalPaths } from "../src/run-journal-store.ts";
import { serializeBuilderAttemptReport, type BuilderAttemptReport } from "../src/attempt-report.ts";
import { advanceRunJournal, buildInitialRunJournal, builderAssignmentSha256, type RunDraft, type RunJournal } from "../src/run.ts";
import type { ProjectModelPlans, RecoveryDefaults } from "../src/config.ts";
import { deserializeReviewerAssignment, serializeReviewerAttemptReport, type ReviewerAttemptReport } from "../src/review.ts";
import { createSteward, type MonitorPassResult, type Steward, type StewardDependencies, type StewardUiAdapter } from "../src/steward.ts";

const roots: string[] = [];
vi.setConfig({ testTimeout: 60_000 });
const baseRevision = "0123456789abcdef0123456789abcdef01234567";
const headRevision = "1111111111111111111111111111111111111111";
const commitRevision = headRevision;
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

function digest(bytes: Buffer | string): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function draft(plan: ProjectModelPlans = modelPlans): RunDraft {
	return {
		declaredOutcome: "Ship the automatically reviewed change",
		tasks: [{
			requiredOutcome: "Implement the approved change",
			allowedScope: ["src"],
			expectedArtifacts: [{ kind: "git-commit" }, { kind: "file", path: "src/change.ts" }],
			verification: { kind: "command", command: "npm test" },
			reviewRequired: true,
		}],
		modelPlan: plan,
		effectiveSettings: settings,
		finalVerification: { kind: "command", command: "npm test" },
	};
}

function sameFamilyDraft(): RunDraft {
	return draft({
		builder: { primary: { model: "builder/primary", thinkingLevel: "high" }, fallbacks: [] },
		reviewer: { primary: { model: "builder/reviewer", thinkingLevel: "high" }, fallbacks: [] },
	});
}

function context(root: string, session = "monitor-controller"): StewardCommandContext {
	return {
		mode: "tui",
		hasUI: true,
		cwd: root,
		modelRegistry: {} as StewardCommandContext["modelRegistry"],
		model: undefined,
		thinkingLevel: undefined,
		scopedModels: [],
		sessionManager: { getSessionId: () => session } as StewardCommandContext["sessionManager"],
		ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined, notify() {}, setStatus() {} },
	};
}

type EventHandler = (event: unknown, context: StewardCommandContext) => unknown;

function capture(): { surface: StewardRegistrationSurface; command(): StewardCommandHandler; event(name: string): EventHandler } {
	let command: StewardCommandHandler | undefined;
	const handlers = new Map<string, EventHandler>();
	const surface = {
		on(name: string, handler: EventHandler) { handlers.set(name, handler); },
		registerCommand(_name: "steward", options: { handler: StewardCommandHandler }) { command = options.handler; },
	} as unknown as StewardRegistrationSurface;
	return {
		surface,
		command() { if (!command) throw new Error("missing steward command"); return command; },
		event(name) { const handler = handlers.get(name); if (!handler) throw new Error(`missing ${name} handler`); return handler; },
	};
}

async function drain(): Promise<void> {
	for (let index = 0; index < 80; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForCheckpoint(dependencies: StewardDependencies, root: string): Promise<void> {
	for (let index = 0; index < 4_000; index += 1) {
		const loaded = await dependencies.runJournal.loadActive(root);
		if (loaded.kind === "loaded" && loaded.journal.run.monitor) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("monitor checkpoint did not settle");
}

async function waitForReviewer(dependencies: StewardDependencies, root: string): Promise<RunJournal> {
	for (let index = 0; index < 4_000; index += 1) {
		const loaded = await dependencies.runJournal.loadActive(root);
		const reviewer = loaded.kind === "loaded" ? loaded.journal.run.tasks[0]?.attempts[1] : undefined;
		if (loaded.kind === "loaded" && reviewer?.role === "reviewer" && reviewer.state === "active" && reviewer.dispatch.phase === "prompted") return loaded.journal;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("automatic Reviewer dispatch did not settle");
}

async function writeBuilderReport(root: string, journal: RunJournal): Promise<void> {
	const task = journal.run.tasks[0]!;
	const attempt = task.attempts[0]!;
	const assignment = JSON.parse(await readFile(attempt.assignmentPath, "utf8")) as { assignment: { actualModel: BuilderAttemptReport["actualModel"] } };
	const evidencePath = join(attempt.evidenceDirectory, "change.snapshot");
	const logPath = join(attempt.evidenceDirectory, "check.log");
	const artifact = Buffer.from("approved change\n");
	await mkdir(join(root, "builder-worktree", "src"), { recursive: true });
	await writeFile(join(root, "builder-worktree", "src", "change.ts"), artifact);
	await writeFile(evidencePath, artifact);
	const log = Buffer.from("npm test: pass\n");
	await writeFile(logPath, log);
	const report: BuilderAttemptReport = {
		schemaVersion: 1,
		identity: { runId: journal.run.id, taskId: task.contract.id, attemptId: attempt.id, role: "builder", specificationHash: task.specificationHash, assignmentSha256: builderAssignmentSha256(await readFile(attempt.assignmentPath, "utf8")) },
		status: "completed",
		summary: "Builder completed the approved change.",
		blockers: [],
		producedArtifacts: [
			{ kind: "git-commit", baseRevision, headRevision, commits: [commitRevision] },
			{ kind: "file", path: "src/change.ts", evidencePath, size: artifact.length, sha256: digest(artifact) },
		],
		actualModel: assignment.assignment.actualModel,
		checks: [{ kind: "command", command: "npm test", exitCode: 0, summary: "All tests passed.", logId: "check-1" }],
		logReferences: [{ id: "check-1", path: logPath, size: log.length, sha256: digest(log) }],
		producedRevision: headRevision,
	};
	await writeFile(attempt.reportPath, serializeBuilderAttemptReport(report), "utf8");
}

async function writeReviewerReport(journal: RunJournal): Promise<void> {
	const task = journal.run.tasks[0]!;
	const attempt = task.attempts[1]!;
	if (attempt.role !== "reviewer") throw new Error("Reviewer missing");
	const assignment = deserializeReviewerAssignment(await readFile(attempt.assignmentPath, "utf8"));
	if (!assignment.value) throw new Error("Reviewer Assignment is invalid");
	const report: ReviewerAttemptReport = {
		schemaVersion: 1,
		identity: { runId: journal.run.id, taskId: task.contract.id, attemptId: attempt.id, role: "reviewer", specificationHash: attempt.specificationHash, assignmentSha256: digest(await readFile(attempt.assignmentPath)) },
		status: "completed",
		summary: "Approved change.",
		blockers: [],
		actualModel: attempt.actualModel,
		reviewedSubject: assignment.value.assignment.subject,
		verdict: "approved",
		findings: [],
		checks: [],
		logReferences: [],
	};
	await writeFile(attempt.reportPath, serializeReviewerAttemptReport(report), "utf8");
}

async function startDormantRegisteredRun(root: string, dependencies: StewardDependencies): Promise<{ registered: ReturnType<typeof capture>; ctx: StewardCommandContext; journal: RunJournal }> {
	await mkdir(join(root, "builder-worktree", "src"), { recursive: true });
	const registered = capture();
	registerStewardExtension(registered.surface, () => dependencies);
	const ctx = context(root);
	await registered.command()("start", ctx);
	const loaded = await dependencies.runJournal.loadActive(root);
	if (loaded.kind !== "loaded") throw new Error("missing started Journal");
	return { registered, ctx, journal: loaded.journal };
}

function makeDependencies(root: string, presentations: Array<{ condition: string; footerText: string; notification?: string }>, effects: { builderPrompts: number; reviewerStarts: number; reviewerPrompts: number; merges?: number; mergeArgv?: string[][]; processes?: number; verificationCommands?: string[]; stops?: string[]; archivePublished?: () => void; completionNotified?: () => void }, waitState: { resolve?: (value: { kind: "settled"; lifecycle: "idle"; identity: { name: string; workspaceId: string; paneId: string; terminalId: string }; stateChangeSequence: number | null }) => void }, options: { sameFamilyOnly?: boolean } = {}): StewardDependencies {
	const runJournal = createRunJournalAdapter();
	let uuid = 0;
	const builderPath = join(root, "builder-worktree");
	let integrationState: "base" | "integrated" = "base";
	const archiveCompletedRun = runJournal.archiveCompletedRun?.bind(runJournal);
	if (!archiveCompletedRun) throw new Error("Completion archive adapter is unavailable in the durable test fixture");
	runJournal.archiveCompletedRun = async (input) => {
		const active = await runJournal.loadActive(root);
		if (active.kind !== "loaded" || active.journal.run.completion?.phase !== "archive-intended") throw new Error("Completion archive effect was attempted without a persisted archive intent.");
		const published = await archiveCompletedRun(input);
		effects.archivePublished?.();
		return published;
	};
	const ui: StewardUiAdapter = {
		presentStatus() {},
		async editConfiguration() { return { kind: "cancelled" }; },
		presentConfigurationResult() {},
		async draftRun() { return { kind: "drafted" as const, draft: options.sameFamilyOnly ? sameFamilyDraft() : draft() }; },
		async confirmRun() { return true; },
		presentStartResult() {},
		presentMonitorCondition(input) { presentations.push({ condition: input.condition, footerText: input.footerText, ...(input.notification ? { notification: input.notification.message } : {}) }); },
	};
	const managed = () => ({ name: "steward-b-01234567-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" });
	return {
		runJournal,
		herdr: {
			async checkAvailability() { return { kind: "available", status: "running", running: true, compatible: true, endpointCompatible: true }; },
			async createBuilderWorktree() {
				const active = await runJournal.loadActive(root);
				if (active.kind !== "loaded") throw new Error("missing Journal before Builder worktree");
				return { kind: "created", branch: active.journal.run.tasks[0]!.attempts[0]!.dispatch.branch, path: builderPath, workspaceId: "workspace-1", tabId: "tab-1", paneId: "pane-1", terminalId: "terminal-1" };
			},
			async startBuilder() { return { kind: "started", name: managed().name, agentKind: "pi", workspaceId: "workspace-1", tabId: "tab-1", paneId: "pane-1", terminalId: "terminal-1" }; },
			async promptBuilder() { effects.builderPrompts += 1; return { kind: "prompted", name: managed().name, workspaceId: "workspace-1", tabId: "tab-1", paneId: "pane-1", terminalId: "terminal-1" }; },
			async createReviewerPane() { return { kind: "created", workspaceId: "workspace-1", tabId: "tab-2", paneId: "pane-2", terminalId: "terminal-2", sourcePaneId: "pane-1", worktreePath: builderPath }; },
			async startReviewer() { effects.reviewerStarts += 1; return { kind: "started", name: "steward-r-01234567-01-02", agentKind: "pi", workspaceId: "workspace-1", tabId: "tab-2", paneId: "pane-2", terminalId: "terminal-2" }; },
			async promptReviewer() { effects.reviewerPrompts += 1; return { kind: "prompted", name: "steward-r-01234567-01-02", workspaceId: "workspace-1", tabId: "tab-2", paneId: "pane-2", terminalId: "terminal-2" }; },
			async stopAgentGracefully(input) {
				effects.stops ??= [];
				effects.stops.push(input.name);
				const active = await runJournal.loadActive(root);
				if (active.kind !== "loaded" || active.journal.run.completion?.phase !== "stops-intended" || active.journal.run.completion.resources.find((resource) => resource.agentName === input.name)?.state !== "intended") throw new Error("Graceful-stop effect was attempted without the matching persisted stop intent.");
				return { kind: "acknowledged", name: input.name, workspaceId: input.workspaceId, tabId: input.paneId === "pane-1" ? "tab-1" : "tab-2", paneId: input.paneId, terminalId: input.terminalId };
			},
			async inspectManagedAgent(identity) { return { kind: "observed", identity, lifecycle: "working", stateChangeSequence: 8 }; },
			async waitForManagedAgent(identity, _timeout, signal) {
				return await new Promise((resolve) => {
					waitState.resolve = (value) => resolve(value);
					signal.addEventListener("abort", () => resolve({ kind: "cancelled" as const }), { once: true });
				});
			},
			async readManagedTerminal() { return { kind: "observed", byteCount: 0, sha256: digest("") }; },
		},
		git: {
			async inspectIntegrationBase() { return { kind: "ready", branch: "main", revision: baseRevision }; },
			async branchExists() { return false; },
			async inspectBuilderWorktree(_path, expectedRevision) { return { kind: "ready", head: expectedRevision, clean: true }; },
			async inspectProducedCodeArtifact() { return { kind: "inspected", base: baseRevision, head: headRevision, commits: [commitRevision], changedPaths: [{ status: "M", paths: ["src/change.ts"] }], clean: true }; },
			async inspectReviewWorktree() { return { head: headRevision, dirtyStateFingerprint: digest("review-clean"), dirtyPaths: [], operationMarkers: [] }; },
			async inspectManagedWorktreeProgress() { return { kind: "observed", head: headRevision, worktree: { kind: "observed", byteCount: 0, sha256: digest("") }, git: { head: headRevision, digest: { kind: "observed", byteCount: 0, sha256: digest("") } } }; },
			async inspectIntegrationCheckout(input) {
				const head = integrationState === "integrated" ? input.approvedHeadRevision : input.targetRevision;
				return { kind: "inspected", observation: { branch: input.targetBranch, head, dirtyPaths: [], operationMarkers: [], rangeExact: true }, resolvedBaseRevision: input.approvedBaseRevision, resolvedHeadRevision: input.approvedHeadRevision, commits: [...input.approvedCommits] };
			},
			async integrateApprovedRange(input) {
				effects.merges = (effects.merges ?? 0) + 1;
				effects.mergeArgv ??= [];
				effects.mergeArgv.push([...input.action.argv]);
				deepStrictEqual(input.action.argv, ["merge", "--ff-only", "--no-edit", headRevision]);
				const active = await runJournal.loadActive(root);
				if (active.kind !== "loaded" || active.journal.run.tasks[0]?.integration?.phase !== "intended") throw new Error("Git merge effect was attempted without a persisted integration intent.");
				integrationState = "integrated";
				return { kind: "completed", code: 0, stdout: `fast-forward ${input.approvedHeadRevision}\n`, stderr: "", killed: false };
			},
		},
		process: {
			async runApprovedVerification(input) {
				effects.processes = (effects.processes ?? 0) + 1;
				effects.verificationCommands ??= [];
				effects.verificationCommands.push(input.command);
				equal(input.command, "npm test");
				const active = await runJournal.loadActive(root);
				if (active.kind !== "loaded" || active.journal.run.finalVerificationExecution?.phase !== "intended") throw new Error("Verification effect was attempted without a persisted verification intent.");
				return { kind: "completed", code: 0, stdout: `verified ${input.command}\n`, stderr: "", killed: false };
			},
			async inspectAttemptProcesses(input) {
				return { kind: "none", paneId: input.identity.paneId, shellPid: 101, foregroundProcessGroupId: 101, processCount: 1, digest: digest("managed-process") };
			},
		},
		model: {
			listModelChoices: () => [],
			async validateModelPlans() { return []; },
			async inspectModelChoice(choice) { return { choice: { ...choice }, available: true, diagnostics: [] }; },
		},
		clock: { now: () => new Date("2026-09-18T00:00:00.000Z"), randomUUID: () => `01234567-89ab-cdef-0123-456789abcde${++uuid}` },
		ui: {
			...ui,
			notifyCompletion() { effects.completionNotified?.(); },
		},
	};
}

it.sequential("registered lifecycle flow waits for safe idle and advances Builder evidence to an exact Reviewer", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-monitor-"));
	roots.push(root);
	const presentations: Array<{ condition: string; footerText: string; notification?: string }> = [];
	const effects = { builderPrompts: 0, reviewerStarts: 0, reviewerPrompts: 0 };
	const waitState: { resolve?: (value: { kind: "settled"; lifecycle: "idle"; identity: { name: string; workspaceId: string; paneId: string; terminalId: string }; stateChangeSequence: number | null }) => void } = {};
	const dependencies = makeDependencies(root, presentations, effects, waitState);
	const registered = capture();
	registerStewardExtension(registered.surface, () => dependencies);
	const ctx = context(root);
	await registered.event("session_start")({ type: "session_start", reason: "startup" }, ctx);
	await drain();
	await registered.command()("start", ctx);
	await drain();
	await waitForCheckpoint(dependencies, root);
	await drain();
	equal(effects.builderPrompts, 1);

	let loaded = await dependencies.runJournal.loadActive(root);
	if (loaded.kind !== "loaded") throw new Error("missing started Journal");
	await writeBuilderReport(root, loaded.journal);
	await readFile(loaded.journal.run.tasks[0]!.attempts[0]!.reportPath, "utf8");
	await registered.event("agent_start")({ type: "agent_start" }, ctx);
	await registered.event("turn_end")({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, ctx);
	await drain();
	equal(effects.reviewerStarts, 0);
	equal(effects.reviewerPrompts, 0);

	await registered.event("session_before_compact")({ type: "session_before_compact" }, ctx);
	await registered.event("agent_settled")({ type: "agent_settled" }, ctx);
	await drain();
	equal(effects.reviewerStarts, 0);
	await registered.event("session_compact")({ type: "session_compact" }, ctx);
	await registered.event("ui_prompt_start")({ type: "ui_prompt_start", source: "test" }, ctx);
	await registered.event("agent_settled")({ type: "agent_settled" }, ctx);
	await drain();
	equal(effects.reviewerStarts, 0);
	await registered.event("ui_prompt_end")({ type: "ui_prompt_end", source: "test" }, ctx);
	waitState.resolve?.({ kind: "settled", lifecycle: "idle", identity: { ...((loaded.journal.run.tasks[0]!.attempts[0]!.dispatch) as { agentName: string; workspaceId: string; paneId: string; terminalId: string }), name: "steward-b-01234567-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" }, stateChangeSequence: 9 });
	await drain();

	const reviewerJournal = await waitForReviewer(dependencies, root);
	await drain();
	const task = reviewerJournal.run.tasks[0]!;
	const builder = task.attempts[0]!;
	const reviewer = task.attempts[1]!;
	equal(builder.role, "builder");
	equal(builder.state, "reported");
	equal(builder.evidence?.phase, "finalized");
	equal(reviewer.role, "reviewer");
	equal(reviewer.state, "active");
	equal(reviewer.dispatch.phase, "prompted");
	equal(reviewer.subject.kind, "git");
	equal(reviewer.subject.headRevision, headRevision);
	equal(effects.reviewerStarts, 1);
	equal(effects.reviewerPrompts, 1);
	ok(presentations.every((item) => !item.footerText.includes("dashboard")));
	await registered.event("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx);
}, 60_000);

it.sequential("reconstructs the registered owner monitor across shutdown, reload, and replacement", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-monitor-reconstruct-"));
	roots.push(root);
	const effects = { builderPrompts: 0, reviewerStarts: 0, reviewerPrompts: 0 };
	const waitState: { resolve?: (value: { kind: "settled"; lifecycle: "idle"; identity: { name: string; workspaceId: string; paneId: string; terminalId: string }; stateChangeSequence: number | null }) => void } = {};
	const dependencies = makeDependencies(root, [], effects, waitState);
	const registered = await startDormantRegisteredRun(root, dependencies);
	let waitCalls = 0;
	let cancelled = 0;
	dependencies.herdr.waitForManagedAgent = async (_identity, _timeout, signal) => await new Promise((resolve) => {
		waitCalls += 1;
		signal.addEventListener("abort", () => { cancelled += 1; resolve({ kind: "cancelled" }); }, { once: true });
	});
	const owner = context(root, "monitor-controller");
	const replacement = context(root, "replacement-controller");
	await registered.registered.event("session_start")({ type: "session_start", reason: "startup" }, owner);
	for (let index = 0; index < 4_000 && waitCalls < 1; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
	equal(waitCalls, 1);
	await registered.registered.event("session_shutdown")({ type: "session_shutdown", reason: "reload" }, owner);
	equal(cancelled, 1);
	await registered.registered.event("session_start")({ type: "session_start", reason: "reload" }, owner);
	for (let index = 0; index < 4_000 && waitCalls < 2; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
	equal(waitCalls, 2);
	await registered.registered.event("session_shutdown")({ type: "session_shutdown", reason: "new" }, owner);
	await registered.registered.event("session_start")({ type: "session_start", reason: "new" }, replacement);
	await drain();
	equal(waitCalls, 2);
	await registered.registered.command()("resume --takeover", replacement);
	for (let index = 0; index < 4_000 && waitCalls < 3; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
	equal(waitCalls, 3);
	await registered.registered.event("session_shutdown")({ type: "session_shutdown", reason: "resume" }, replacement);
	await registered.registered.event("session_start")({ type: "session_start", reason: "resume" }, replacement);
	for (let index = 0; index < 4_000 && waitCalls < 4; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
	equal(waitCalls, 4);
	await registered.registered.event("session_shutdown")({ type: "session_shutdown", reason: "quit" }, replacement);
	ok(cancelled >= 4);
}, 60_000);

it.sequential("wakes one registered ordinary action only after successful compaction reaches safe idle", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-monitor-compaction-success-"));
	roots.push(root);
	const presentations: Array<{ condition: string; footerText: string; notification?: string }> = [];
	const effects = { builderPrompts: 0, reviewerStarts: 0, reviewerPrompts: 0 };
	const waitState: { resolve?: (value: { kind: "settled"; lifecycle: "idle"; identity: { name: string; workspaceId: string; paneId: string; terminalId: string }; stateChangeSequence: number | null }) => void } = {};
	const dependencies = makeDependencies(root, presentations, effects, waitState);
	const registered = capture();
	registerStewardExtension(registered.surface, () => dependencies);
	const ctx = context(root);
	await registered.event("session_start")({ type: "session_start", reason: "startup" }, ctx);
	await registered.command()("start", ctx);
	await drain();
	await waitForCheckpoint(dependencies, root);
	await drain();
	const sequence: string[] = [];
	const inspectAgent = dependencies.herdr.inspectManagedAgent!;
	dependencies.herdr.inspectManagedAgent = async (identity) => { sequence.push("reconciliation"); return inspectAgent(identity); };
	const startReviewer = dependencies.herdr.startReviewer!;
	dependencies.herdr.startReviewer = async (...args) => { sequence.push("ordinary-action"); return startReviewer(...args); };
	const journal = await dependencies.runJournal.loadActive(root);
	if (journal.kind !== "loaded") throw new Error("missing compaction-success Journal");
	await writeBuilderReport(root, journal.journal);
	await registered.event("agent_start")({ type: "agent_start" }, ctx);
	await registered.event("turn_end")({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, ctx);
	await drain();
	equal(effects.reviewerStarts, 0);
	await registered.event("session_before_compact")({ type: "session_before_compact", willRetry: true }, ctx);
	await registered.event("agent_settled")({ type: "agent_settled" }, ctx);
	await drain();
	equal(effects.reviewerStarts, 0);
	await registered.event("session_compact")({ type: "session_compact" }, ctx);
	await registered.event("ui_prompt_start")({ type: "ui_prompt_start", source: "test" }, ctx);
	await registered.event("agent_settled")({ type: "agent_settled" }, ctx);
	await drain();
	equal(effects.reviewerStarts, 0);
	await registered.event("ui_prompt_end")({ type: "ui_prompt_end", source: "test" }, ctx);
	await registered.event("turn_end")({ type: "turn_end", turnIndex: 1, message: {}, toolResults: [] }, ctx);
	waitState.resolve?.({ kind: "settled", lifecycle: "idle", identity: { name: "steward-b-01234567-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" }, stateChangeSequence: 9 });
	const after = await waitForReviewer(dependencies, root);
	equal(after.run.tasks[0]?.attempts.at(-1)?.role, "reviewer");
	equal(after.run.tasks[0]?.attempts.at(-1)?.state, "active");
	equal(effects.reviewerStarts, 1);
	equal(effects.reviewerPrompts, 1);
	const ordinaryAction = sequence.indexOf("ordinary-action");
	ok(ordinaryAction > 0);
	ok(sequence.slice(0, ordinaryAction).includes("reconciliation"));
	await registered.event("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx);
}, 60_000);

it.sequential("never requests a registered advance after compaction failure", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-monitor-compaction-failure-"));
	roots.push(root);
	const effects = { builderPrompts: 0, reviewerStarts: 0, reviewerPrompts: 0 };
	const waitState: { resolve?: (value: { kind: "settled"; lifecycle: "idle"; identity: { name: string; workspaceId: string; paneId: string; terminalId: string }; stateChangeSequence: number | null }) => void } = {};
	const dependencies = makeDependencies(root, [], effects, waitState);
	const registered = capture();
	registerStewardExtension(registered.surface, () => dependencies);
	const ctx = context(root);
	await registered.event("session_start")({ type: "session_start", reason: "startup" }, ctx);
	await registered.command()("start", ctx);
	await drain();
	await waitForCheckpoint(dependencies, root);
	const journal = await dependencies.runJournal.loadActive(root);
	if (journal.kind !== "loaded") throw new Error("missing compaction-failure Journal");
	await writeBuilderReport(root, journal.journal);
	await registered.event("agent_start")({ type: "agent_start" }, ctx);
	await registered.event("session_before_compact")({ type: "session_before_compact", willRetry: true }, ctx);
	await registered.event("session_compact_failed")({ type: "session_compact_failed", reason: "overflow", errorMessage: "failed", aborted: false, willRetry: true, fromExtension: false }, ctx);
	await registered.event("agent_settled")({ type: "agent_settled" }, ctx);
	await drain();
	equal(effects.reviewerStarts, 0);
	equal(effects.reviewerPrompts, 0);
	const after = await dependencies.runJournal.loadActive(root);
	if (after.kind !== "loaded") throw new Error("compaction-failure Journal disappeared");
	equal(after.journal.run.tasks[0]?.attempts.at(-1)?.role, "builder");
	equal(after.journal.run.tasks[0]?.attempts.at(-1)?.state, "active");
	await registered.event("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx);
}, 60_000);

it.sequential("records lifecycle, terminal, worktree, Git, and report progress independently and skips unchanged scans", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-monitor-progress-"));
	roots.push(root);
	const presentations: Array<{ condition: string; footerText: string; notification?: string }> = [];
	const effects = { builderPrompts: 0, reviewerStarts: 0, reviewerPrompts: 0 };
	const dependencies = makeDependencies(root, presentations, effects, {});
	const { journal } = await startDormantRegisteredRun(root, dependencies);
	const steward = createSteward(dependencies);
	const first = await steward.observeMonitorProgress(root, "monitor-controller", "manual");
	if (!first.journal) throw new Error("initial monitor observation did not return a Journal");
	const activityPath = join(resolveRunJournalPaths(root).activityRoot, journal.run.id, "activity.log");
	const activityAfterFirst = await readFile(activityPath, "utf8");
	const unchanged = await steward.observeMonitorProgress(root, "monitor-controller", "manual");
	if (!unchanged.journal) throw new Error("unchanged monitor observation did not return a Journal");
	equal(unchanged.journal.journalRevision, first.journal.journalRevision);
	equal((await readFile(activityPath, "utf8")), activityAfterFirst);
	const changed = async (label: string, update: () => Promise<void> | void): Promise<void> => {
		await update();
		const before = await dependencies.runJournal.loadActive(root);
		if (before.kind !== "loaded") throw new Error(`missing Journal before ${label}`);
		const result = await steward.observeMonitorProgress(root, "monitor-controller", "manual");
		if (!result.journal) throw new Error(`missing Journal after ${label}`);
		equal(result.journal.journalRevision, before.journal.journalRevision + 1, label);
		match((await readFile(activityPath, "utf8")).trimEnd().split("\n").at(-1) ?? "", new RegExp(label));
	};
	await changed("lifecycle", () => {
		dependencies.herdr.inspectManagedAgent = async (identity) => ({ kind: "observed", identity, lifecycle: "idle", stateChangeSequence: 9 });
	});
	await changed("terminal", () => {
		dependencies.herdr.readManagedTerminal = async () => ({ kind: "observed", byteCount: 8, sha256: digest("terminal") });
	});
	await changed("worktree", () => {
		dependencies.git.inspectManagedWorktreeProgress = async () => ({ kind: "observed", head: headRevision, worktree: { kind: "observed", byteCount: 9, sha256: digest("worktree") }, git: { head: headRevision, digest: { kind: "observed", byteCount: 0, sha256: digest("") } } });
	});
	await changed("git", () => {
		dependencies.git.inspectManagedWorktreeProgress = async () => ({ kind: "observed", head: "3333333333333333333333333333333333333333", worktree: { kind: "observed", byteCount: 9, sha256: digest("worktree") }, git: { head: "3333333333333333333333333333333333333333", digest: { kind: "observed", byteCount: 3, sha256: digest("git") } } });
	});
	const active = await dependencies.runJournal.loadActive(root);
	if (active.kind !== "loaded") throw new Error("missing current Builder Attempt");
	const builder = active.journal.run.tasks[0]!.attempts[0]!;
	await changed("report", () => writeFile(builder.reportPath, "report progress\n"));
	equal(effects.reviewerStarts, 0);
	equal(effects.reviewerPrompts, 0);
}, 60_000);

it.sequential.each(["absent", "truncated", "contradictory"] as const)("does not read an $0 activity log while persisting the authoritative monitor checkpoint", async (activityState) => {
	const root = await mkdtemp(join(tmpdir(), `pi-herdr-steward-monitor-activity-${activityState}-`));
	roots.push(root);
	const presentations: Array<{ condition: string; footerText: string; notification?: string }> = [];
	const effects = { builderPrompts: 0, reviewerStarts: 0, reviewerPrompts: 0 };
	const dependencies = makeDependencies(root, presentations, effects, {});
	const { journal } = await startDormantRegisteredRun(root, dependencies);
	const activityPath = join(resolveRunJournalPaths(root).activityRoot, journal.run.id, "activity.log");
	dependencies.herdr.inspectManagedAgent = async (identity) => ({ kind: "observed", identity, lifecycle: "idle", stateChangeSequence: 9 });
	if (activityState === "absent") await rm(activityPath, { force: true });
	else if (activityState === "truncated") await writeFile(activityPath, "{\"event\":\n", "utf8");
	else await writeFile(activityPath, JSON.stringify({ event: "monitor-observed", runId: "contradictory-run", message: "not authoritative" }) + "\n", "utf8");
	const before = await dependencies.runJournal.loadActive(root);
	if (before.kind !== "loaded") throw new Error("missing activity independence fixture");
	const result = await createSteward(dependencies).observeMonitorProgress(root, "monitor-controller", "manual");
	if (!result.journal) throw new Error(`${activityState} activity log prevented monitor checkpoint`);
	equal(result.condition, "ordinary");
	equal(result.action, "record-observation");
	equal(result.journal.journalRevision, before.journal.journalRevision + 1);
}, 60_000);

it.sequential("uses the exact lifecycle wait first and the frozen passive interval for timeout or unavailable fallback", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-monitor-wait-"));
	roots.push(root);
	const dependencies = makeDependencies(root, [], { builderPrompts: 0, reviewerStarts: 0, reviewerPrompts: 0 }, {});
	await startDormantRegisteredRun(root, dependencies);
	const steward = createSteward(dependencies);
	let waitCalls = 0;
	let fallbackWaits = 0;
	dependencies.clock.wait = async (milliseconds, signal) => {
		equal(milliseconds, 1_000);
		fallbackWaits += 1;
		if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
	};
	dependencies.herdr.waitForManagedAgent = async () => {
		waitCalls += 1;
		return { kind: "timeout" };
	};
	equal((await steward.waitForMonitorSignal(root, "monitor-controller", new AbortController().signal)).kind, "timeout");
	equal(waitCalls, 1);
	equal(fallbackWaits, 1);
	dependencies.herdr.waitForManagedAgent = async () => {
		waitCalls += 1;
		return { kind: "unavailable", diagnostic: "server unavailable" };
	};
	equal((await steward.waitForMonitorSignal(root, "monitor-controller", new AbortController().signal)).kind, "timeout");
	equal(waitCalls, 2);
	equal(fallbackWaits, 2);
	dependencies.herdr.inspectManagedAgent = async (identity) => ({ kind: "unclear", diagnostic: "agent disappeared" });
	equal((await steward.waitForMonitorSignal(root, "monitor-controller", new AbortController().signal)).kind, "timeout");
	equal(waitCalls, 2);
	equal(fallbackWaits, 3);
}, 60_000);

it.sequential("schedules the lifecycle wait from the earliest durable silence deadline", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-monitor-silence-deadline-"));
	roots.push(root);
	const dependencies = makeDependencies(root, [], { builderPrompts: 0, reviewerStarts: 0, reviewerPrompts: 0 }, {});
	const { journal } = await startDormantRegisteredRun(root, dependencies);
	const task = journal.run.tasks[0]!;
	const attempt = task.attempts[0]!;
	if (attempt.role !== "builder" || attempt.dispatch.phase !== "prompted") throw new Error("silence deadline fixture lacks a prompted Builder");
	const stamp = attempt.activatedAt ?? attempt.preparedAt;
	const hash = `sha256:${"a".repeat(64)}`;
	const identity = { name: attempt.dispatch.agentName, workspaceId: attempt.dispatch.workspaceId, paneId: attempt.dispatch.paneId, terminalId: attempt.dispatch.terminalId };
	const silence = {
		phase: "suspected" as const,
		lastProgressAt: stamp,
		phaseAt: stamp,
		inspection: {
			attemptId: attempt.id,
			role: "builder" as const,
			agent: identity,
			lifecycle: "working" as const,
			stateChangeSequence: 8,
			terminal: { kind: "observed" as const, byteCount: 0, sha256: hash },
			worktree: { kind: "observed" as const, byteCount: 0, sha256: hash },
			git: { head: baseRevision, digest: hash },
			assignment: { path: attempt.assignmentPath, size: 1, sha256: hash },
			report: { kind: "missing" as const },
			evidence: { directory: attempt.evidenceDirectory, count: 0, byteCount: 0, sha256: hash, entries: [] },
			process: { kind: "none" as const, paneId: identity.paneId, shellPid: 101, foregroundProcessGroupId: 101, processCount: 1, digest: hash },
		},
	};
	const candidate = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
		const nextTask = next.run.tasks[0]!;
		const nextAttempt = nextTask.attempts[0]!;
		nextTask.attention = "suspected-stall";
		nextTask.attentionReason = "silence-passive-inspection";
		nextAttempt.recovery = { live: { observedAt: stamp, kind: "working", lifecycle: "working", stateChangeSequence: 8 }, silence };
	});
	const replaced = await dependencies.runJournal.replaceActive(root, candidate);
	equal(replaced.kind, "replaced");
	const expected = Date.parse(stamp) + settings.secondInspectionAndNudgeIntervalSeconds * 1_000 - dependencies.clock.now().getTime();
	let requestedTimeout = 0;
	let fallbackWait = 0;
	dependencies.herdr.waitForManagedAgent = async (_resource, timeout) => {
		requestedTimeout = timeout;
		return { kind: "timeout" };
	};
	dependencies.clock.wait = async (milliseconds) => { fallbackWait = milliseconds; };
	const result = await createSteward(dependencies).waitForMonitorSignal(root, "monitor-controller", new AbortController().signal);
	equal(result.kind, "timeout");
	equal(requestedTimeout, Math.min(expected, 30_000));
	equal(fallbackWait, expected);
}, 60_000);

it.sequential("keeps foreign, stale, and wrong-resource observations read-only", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-monitor-authority-"));
	roots.push(root);
	const effects = { builderPrompts: 0, reviewerStarts: 0, reviewerPrompts: 0 };
	const dependencies = makeDependencies(root, [], effects, {});
	const { journal } = await startDormantRegisteredRun(root, dependencies);
	const steward = createSteward(dependencies);
	let inspections = 0;
	const inspect = dependencies.herdr.inspectManagedAgent!;
	dependencies.herdr.inspectManagedAgent = async (identity) => { inspections += 1; return inspect(identity); };
	const foreignBefore = await dependencies.runJournal.loadActive(root);
	if (foreignBefore.kind !== "loaded") throw new Error("missing foreign authority fixture");
	const foreign = await steward.observeMonitorProgress(root, "foreign-controller", "manual");
	equal(foreign.journal?.journalRevision, foreignBefore.journal.journalRevision);
	equal(inspections, 0);
	const paths = foreignBefore.paths;
	const activityBefore = await readFile(join(paths.activityRoot, journal.run.id, "activity.log"), "utf8");
	const originalReplace = dependencies.runJournal.replaceActive.bind(dependencies.runJournal);
	let staleInjected = false;
	dependencies.runJournal.replaceActive = async (repositoryRoot, candidate) => {
		if (!staleInjected && candidate.run.monitor) {
			staleInjected = true;
			const current = await dependencies.runJournal.loadActive(repositoryRoot);
			if (current.kind !== "loaded") throw new Error("missing current Journal for stale replacement");
			const newer = advanceRunJournal(current.journal, dependencies.clock.now(), (next) => { next.run.monitor = candidate.run.monitor; });
			const won = await originalReplace(repositoryRoot, newer);
			if (won.kind !== "replaced") throw new Error("concurrent Journal update did not persist");
		}
		return originalReplace(repositoryRoot, candidate);
	};
	const stale = await steward.observeMonitorProgress(root, "monitor-controller", "manual");
	equal(stale.condition, "degraded");
	equal(effects.reviewerPrompts, 0);
	equal(await readFile(join(paths.activityRoot, journal.run.id, "activity.log"), "utf8"), activityBefore);
	dependencies.runJournal.replaceActive = originalReplace;
	dependencies.herdr.inspectManagedAgent = async () => ({ kind: "unclear", diagnostic: "recorded terminal was replaced" });
	const wrong = await steward.observeMonitorProgress(root, "monitor-controller", "manual");
	equal(wrong.condition, "degraded");
	equal(effects.reviewerStarts, 0);
	equal(effects.reviewerPrompts, 0);
}, 60_000);

it.sequential("bounds automatic advancement to one workflow action and does not repeat after activity failure", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-monitor-action-"));
	roots.push(root);
	const effects = { builderPrompts: 0, reviewerStarts: 0, reviewerPrompts: 0 };
	const dependencies = makeDependencies(root, [], effects, {});
	const { journal } = await startDormantRegisteredRun(root, dependencies);
	await writeBuilderReport(root, journal);
	const steward = createSteward(dependencies);
	const finalized = await steward.advanceNext(root, "monitor-controller", { interactive: false, maximumActions: 1 });
	equal(finalized.action, "finalize-builder-evidence");
	equal(effects.reviewerPrompts, 0);
	dependencies.runJournal.appendActivity = async () => ({ kind: "storage-error", path: "activity.log", diagnostics: [] });
	const dispatched = await steward.advanceNext(root, "monitor-controller", { interactive: false, maximumActions: 1 });
	equal(dispatched.condition, "degraded");
	equal(effects.reviewerPrompts, 1);
	const repeatable = await steward.advanceNext(root, "monitor-controller", { interactive: false, maximumActions: 1 });
	equal(repeatable.action, "degraded");
	equal(repeatable.condition, "degraded");
	equal(effects.reviewerPrompts, 1);
	const repeat = await steward.advanceNext(root, "monitor-controller", { interactive: false, maximumActions: 1 });
	equal(effects.reviewerPrompts, 1);
	equal(repeat.action, "none");
}, 60_000);

it.sequential("does not spin when an automatic action reports no durable Journal progress", async () => {
	const journal = buildInitialRunJournal({
		identity: { runId: "run-monitor-no-op-20260918T000000000Z-01234567", createdAt: "2026-09-18T00:00:00.000Z" },
		controllerSessionId: "monitor-controller",
		draft: draft(),
		modelPlan: modelPlans,
		effectiveSettings: settings,
		integrationBase: { kind: "git", branch: "main", revision: baseRevision },
	});
	let advanceCalls = 0;
	let resolveInitialObserve!: () => void;
	const initialObserve = new Promise<void>((resolve) => { resolveInitialObserve = resolve; });
	const presentations: MonitorPassResult[] = [];
	const observed: MonitorPassResult = { action: "none", journal, note: "observed", condition: "ordinary" };
	const noOpSteward = {
		async waitForMonitorSignal(_root: string, _session: string, signal: AbortSignal) {
			return await new Promise<{ kind: "cancelled" }>((resolve) => signal.addEventListener("abort", () => resolve({ kind: "cancelled" }), { once: true }));
		},
		async observeMonitorProgress() { resolveInitialObserve(); return observed; },
		async advanceNext() {
			advanceCalls += 1;
			return advanceCalls < 3
				? { action: "finalize-reviewer-evidence" as const, journal, note: "already finalized", condition: "ordinary" as const }
				: { action: "none" as const, journal, note: "bounded fallback", condition: "ordinary" as const };
		},
		presentMonitor(result: MonitorPassResult) { presentations.push(result); },
	} as unknown as Steward;
	const monitor = createStewardSessionMonitor({ repositoryRoot: "/tmp/no-op-monitor", controllerSessionId: "monitor-controller", steward: noOpSteward });
	monitor.markAgentBusy();
	monitor.start();
	await initialObserve;
	await drain();
	monitor.markAgentSettled();
	await drain();
	equal(advanceCalls, 1);
	deepStrictEqual([...new Set(presentations.map((result) => result.journal?.journalRevision))], [journal.journalRevision]);
	equal(presentations.at(-1)?.action, "none");
	await monitor.stop();
}, 60_000);

it.sequential("interprets an automatic approved Reviewer verdict and advances the real completion chain one action at a time", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-monitor-completion-"));
	roots.push(root);
	let archivePublishes = 0;
	let completionNotifications = 0;
	let resolveCompletionNotified!: () => void;
	let resolveArchivePublished!: () => void;
	let resolveArchiveAction!: () => void;
	const archivePublished = new Promise<void>((resolve) => { resolveArchivePublished = resolve; });
	const completionNotified = new Promise<void>((resolve) => { resolveCompletionNotified = resolve; });
	const archiveAction = new Promise<void>((resolve) => { resolveArchiveAction = resolve; });
	const effects = { builderPrompts: 0, reviewerStarts: 0, reviewerPrompts: 0, merges: 0, mergeArgv: [] as string[][], processes: 0, verificationCommands: [] as string[], stops: [] as string[], archivePublished: () => { archivePublishes += 1; resolveArchivePublished(); }, completionNotified: () => { completionNotifications += 1; resolveCompletionNotified(); } };
	const dependencies = makeDependencies(root, [], effects, {});
	const { journal: started } = await startDormantRegisteredRun(root, dependencies);
	const steward = createSteward(dependencies);
	const completionActions: string[] = [];
	const monitorPasses: Array<{ before: number; after: number; action: string }> = [];
	const drainOnePass = async (): Promise<MonitorPassResult> => {
		const before = await dependencies.runJournal.loadActive(root);
		if (before.kind !== "loaded") throw new Error("missing Journal before monitor pass");
		const result = await steward.advanceNext(root, "monitor-controller", { interactive: false, maximumActions: 1 });
		const after = await dependencies.runJournal.loadActive(root);
		if (after.kind !== "loaded") throw new Error("monitor pass removed the active Journal before archive closure");
		completionActions.push(result.action);
		ok(after.journal.journalRevision >= before.journal.journalRevision, `Journal revision regressed during ${result.action}`);
		return result;
	};

	await writeBuilderReport(root, started);
	const finalizedBuilder = await drainOnePass();
	equal(finalizedBuilder.action, "finalize-builder-evidence");
	const dispatchedReviewer = await drainOnePass();
	equal(dispatchedReviewer.action, "dispatch-reviewer");
	let reviewerJournal = await dependencies.runJournal.loadActive(root);
	if (reviewerJournal.kind !== "loaded") throw new Error("missing Reviewer Journal");
	await writeReviewerReport(reviewerJournal.journal);
	const finalizedReviewer = await drainOnePass();
	equal(finalizedReviewer.action, "finalize-reviewer-evidence");
	const approved = await drainOnePass();
	equal(approved.journal?.run.tasks[0]?.phase, "approved");
	equal(approved.journal?.run.integrationBase.kind, "git", JSON.stringify(approved.journal?.run.integrationBase));
	ok(approved.journal!.journalRevision > finalizedReviewer.journal!.journalRevision, "automatic Reviewer verdict did not advance the Journal");
	deepStrictEqual(completionActions, ["finalize-builder-evidence", "dispatch-reviewer", "finalize-reviewer-evidence", "finalize-reviewer-evidence"]);

	const monitorPresentations: Array<{ condition: string; footerText: string }> = [];
	const monitorUi = dependencies.ui;
	dependencies.ui = {
		...monitorUi,
		presentMonitorCondition(input) { monitorPresentations.push({ condition: input.condition, footerText: input.footerText }); },
	};
	const monitorSteward = createSteward(dependencies);
	const monitorAdvance = monitorSteward.advanceNext.bind(monitorSteward);
	monitorSteward.advanceNext = async (...args) => {
		const before = await dependencies.runJournal.loadActive(root);
		if (before.kind !== "loaded") throw new Error("missing Journal before automatic completion pass");
		const result = await monitorAdvance(...args);
		const after = await dependencies.runJournal.loadActive(root);
		const afterRevision = after.kind === "loaded" ? after.journal.journalRevision : result.journal?.journalRevision ?? before.journal.journalRevision;
		monitorPasses.push({ before: before.journal.journalRevision, after: afterRevision, action: result.action });
		ok(afterRevision > before.journal.journalRevision, `automatic pass ${result.action} did not persist a durable transition`);
		if (result.action === "publish-completion-archive") resolveArchiveAction();
		return result;
	};
	monitorSteward.waitForMonitorSignal = async () => ({ kind: "unavailable", diagnostic: "test monitor waiter is dormant" });
	const monitor = createStewardSessionMonitor({ repositoryRoot: root, controllerSessionId: "monitor-controller", steward: monitorSteward });
	try {
		monitor.start();
		monitor.markAgentSettled();
		monitor.wake("settled");
		await archivePublished;
		await completionNotified;
		await archiveAction;
		await drain();
		equal(archivePublishes, 1);
		equal(completionNotifications, 1);
		deepStrictEqual(monitorPasses.map((pass) => pass.action), ["integrate-approved-range", "run-final-verification", "pass-completion-gate", "stop-next-agent", "stop-next-agent", "stop-next-agent", "stop-next-agent", "publish-completion-archive"]);
		equal(effects.merges, 1);
		deepStrictEqual(effects.mergeArgv, [["merge", "--ff-only", "--no-edit", headRevision]]);
		equal(effects.processes, 1);
		deepStrictEqual(effects.verificationCommands, ["npm test"]);
		equal(effects.stops?.length, 2);
		deepStrictEqual(effects.stops, ["steward-b-01234567-01-01", "steward-r-01234567-01-02"]);
		equal(monitorPasses.length, 8);
		ok(monitorPresentations.some((item) => item.condition === "completed" && item.footerText === "steward: no active Run"));
		const actionCountAfterCompletion = monitorPasses.length;
		monitor.wake("manual");
		await drain();
		equal(monitorPasses.length, actionCountAfterCompletion);
		equal((await dependencies.runJournal.probeActive(root)), "missing");
	} finally {
		await monitor.stop();
	}

}, 60_000);

it.sequential("retains same-family approval-required state without calling confirmation", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-monitor-approval-"));
	roots.push(root);
	const effects = { builderPrompts: 0, reviewerStarts: 0, reviewerPrompts: 0 };
	const dependencies = makeDependencies(root, [], effects, {}, { sameFamilyOnly: true });
	const { journal } = await startDormantRegisteredRun(root, dependencies);
	await writeBuilderReport(root, journal);
	let confirmations = 0;
	dependencies.ui.confirmSameFamilyReview = async () => { confirmations += 1; return true; };
	const steward = createSteward(dependencies);
	await steward.advanceNext(root, "monitor-controller", { interactive: false, maximumActions: 1 });
	const approval = await steward.advanceNext(root, "monitor-controller", { interactive: false, maximumActions: 1 });
	equal(approval.action, "approval-required");
	equal(confirmations, 0);
	const loaded = await dependencies.runJournal.loadActive(root);
	if (loaded.kind !== "loaded") throw new Error("missing approval-required Journal");
	equal(loaded.journal.run.tasks[0]!.attentionReason, "review-approval-required");
	const repeated = await steward.advanceNext(root, "monitor-controller", { interactive: false, maximumActions: 1 });
	equal(repeated.action, "approval-required");
	equal(confirmations, 0);
}, 60_000);

it.sequential("derives a blocked condition and warning for durable needs-user attention", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-monitor-needs-user-"));
	roots.push(root);
	const presentations: Array<{ condition: string; footerText: string; notification?: string }> = [];
	const dependencies = makeDependencies(root, presentations, { builderPrompts: 0, reviewerStarts: 0, reviewerPrompts: 0 }, {});
	const { journal } = await startDormantRegisteredRun(root, dependencies);
	const attention = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
		const task = next.run.tasks[0]!;
		task.attention = "needs-user";
		task.attentionReason = "agent-stop-failed";
		task.attentionDiagnostic = "The recorded Builder did not acknowledge /quit.";
	});
	const replaced = await dependencies.runJournal.replaceActive(root, attention);
	equal(replaced.kind, "replaced");
	const steward = createSteward(dependencies);
	const result = await steward.advanceNext(root, "monitor-controller", { interactive: false, maximumActions: 1 });
	equal(result.condition, "blocked");
	steward.presentMonitor(result, "footer");
	const presentation = presentations.at(-1);
	equal(presentation?.condition, "blocked");
	equal(presentation?.notification, result.note);
	ok(presentation?.footerText.includes("1 attention"));
	const repeatedPresentations: MonitorPassResult[] = [];
	const monitorSteward = {
		async waitForMonitorSignal(_root: string, _session: string, signal: AbortSignal) {
			return await new Promise<{ kind: "cancelled" }>((resolve) => signal.addEventListener("abort", () => resolve({ kind: "cancelled" }), { once: true }));
		},
		async observeMonitorProgress() { return result; },
		async advanceNext() { return result; },
		presentMonitor(value: MonitorPassResult) { repeatedPresentations.push(value); },
	} as unknown as Steward;
	const monitor = createStewardSessionMonitor({ repositoryRoot: root, controllerSessionId: "monitor-controller", steward: monitorSteward });
	try {
		monitor.markAgentBusy();
		monitor.start();
		await drain();
		monitor.markAgentSettled();
		await drain();
		ok(repeatedPresentations.length >= 2);
		equal(repeatedPresentations.filter((value) => value.notification !== false).length, 1);
		equal(repeatedPresentations.at(-1)?.notification, false);
	} finally {
		await monitor.stop();
	}
}, 60_000);

it.sequential("shutdown aborts the wait and ignores a late lifecycle completion", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-monitor-shutdown-"));
	roots.push(root);
	const presentations: Array<{ condition: string; footerText: string; notification?: string }> = [];
	const effects = { builderPrompts: 0, reviewerStarts: 0, reviewerPrompts: 0 };
	const waitState: { resolve?: (value: { kind: "settled"; lifecycle: "idle"; identity: { name: string; workspaceId: string; paneId: string; terminalId: string }; stateChangeSequence: number | null }) => void } = {};
	const dependencies = makeDependencies(root, presentations, effects, waitState);
	const registered = capture();
	registerStewardExtension(registered.surface, () => dependencies);
	const ctx = context(root);
	await registered.event("session_start")({ type: "session_start", reason: "startup" }, ctx);
	await registered.command()("start", ctx);
	await drain();
	const beforeShutdown = presentations.length;
	await registered.event("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx);
	waitState.resolve?.({ kind: "settled", lifecycle: "idle", identity: { name: "steward-b-01234567-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" }, stateChangeSequence: 99 });
	await drain();
	equal(effects.reviewerStarts, 0);
	equal(effects.reviewerPrompts, 0);
	equal(presentations.length, beforeShutdown);
}, 60_000);

it.sequential("presents ordinary, approval-required, blocked, degraded, and completed monitor conditions through the bounded footer surface", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-monitor-footer-"));
	roots.push(root);
	const presentations: Array<{ condition: string; footerText: string; notification?: string }> = [];
	const effects = { builderPrompts: 0, reviewerStarts: 0, reviewerPrompts: 0 };
	const dependencies = makeDependencies(root, presentations, effects, {});
	const journal = buildInitialRunJournal({ identity: { runId: "run-footer-20260918T000000000Z-01234567", createdAt: "2026-09-18T00:00:00.000Z" }, controllerSessionId: "monitor-controller", draft: draft(), modelPlan: modelPlans, effectiveSettings: settings, integrationBase: { kind: "git", branch: "main", revision: baseRevision } });
	const steward = createSteward(dependencies);
	steward.presentMonitor({ action: "none", journal, note: "Review is in progress.", condition: "ordinary" }, "footer");
	steward.presentMonitor({ action: "approval-required", journal, note: "Approval required for this exact subject.", condition: "approval-required" }, "footer");
	steward.presentMonitor({ action: "blocked", journal, note: "Blocked.", condition: "blocked" }, "footer");
	steward.presentMonitor({ action: "degraded", journal, note: "Degraded.", diagnostic: "source unavailable", condition: "degraded" }, "footer");
	steward.presentMonitor({ action: "none", journal, note: "Completed.", condition: "completed", completed: true }, "footer");
	equal(presentations.length, 5);
	equal(presentations[0]?.condition, "ordinary");
	ok(presentations[0]?.footerText.includes("pending"));
	equal(presentations[1]?.notification, "Approval required for this exact subject.");
	equal(presentations[2]?.notification, "Blocked.");
	equal(presentations[3]?.notification, "Degraded.");
	equal(presentations[4]?.footerText, "steward: no active Run");
	ok(presentations.every((item) => !item.footerText.includes("dashboard")));
});
