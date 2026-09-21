import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createRunJournalAdapter } from "../src/adapters.ts";
import { type ArchiveCompletedRunRequest } from "../src/completion-store.ts";
import { registerStewardExtension, type StewardCommandContext, type StewardCommandHandler, type StewardRegistrationSurface } from "../src/extension.ts";
import { builderAssignmentSha256, type RunConfirmationSummary, type RunDraft, type RunJournal } from "../src/run.ts";
import { resolveRunJournalPaths } from "../src/run-journal-store.ts";
import { serializeBuilderAttemptReport, type BuilderAttemptReport } from "../src/attempt-report.ts";
import { deserializeReviewerAssignment, serializeReviewerAttemptReport, type ReviewerAttemptReport } from "../src/review.ts";
import type { ProjectModelPlans, RecoveryDefaults } from "../src/config.ts";
import type { StewardDependencies, StewardUiAdapter, StatusView } from "../src/steward.ts";

const baseRevision = "0123456789abcdef0123456789abcdef01234567";
const commits = ["1111111111111111111111111111111111111111", "2222222222222222222222222222222222222222"];
const headRevision = commits[1]!;
const fingerprint = `sha256:${"a".repeat(64)}`;
const recovery: RecoveryDefaults = { passiveInspectionIntervalSeconds: 301, secondInspectionAndNudgeIntervalSeconds: 302, nudgeGracePeriodSeconds: 121, externalCommandWarningThresholdSeconds: 1801, maximumActiveTasks: 1, transientRetryLimit: 1, reworkCycleLimit: 4 };
const modelPlan: ProjectModelPlans = { builder: { primary: { model: "builder/model", thinkingLevel: "high" }, fallbacks: [] }, reviewer: { primary: { model: "reviewer/model", thinkingLevel: "high" }, fallbacks: [] } };

export type Ticket08ExtensionRegistrar = typeof registerStewardExtension;

export interface Ticket08CompletionEffects {
	merges: number;
	processes: number;
	stops: string[];
	notifications: number;
	confirmations?: number;
	confirmationSummaries?: RunConfirmationSummary[];
	archives?: number;
	state: "base" | "integrated";
}

function sha(bytes: Buffer): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

function draft(): RunDraft {
	return { declaredOutcome: "Complete one approved change", tasks: [{ requiredOutcome: "Implement the change", allowedScope: ["src"], expectedArtifacts: [{ kind: "git-commit" }, { kind: "file", path: "src/change.ts" }], verification: { kind: "command", command: "npm test" }, reviewRequired: true }], modelPlan, effectiveSettings: recovery, finalVerification: { kind: "command", command: "npm test" } };
}

function context(root: string): StewardCommandContext {
	return { mode: "tui", hasUI: true, cwd: root, modelRegistry: {} as StewardCommandContext["modelRegistry"], model: undefined, thinkingLevel: undefined, scopedModels: [], sessionManager: { getSessionId: () => "controller-session" } as StewardCommandContext["sessionManager"], ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined, notify() {}, setStatus() {} } };
}

function registered(dependencies: StewardDependencies, registrar: Ticket08ExtensionRegistrar = registerStewardExtension): () => StewardCommandHandler {
	let handler: StewardCommandHandler | undefined;
	const surface: StewardRegistrationSurface = { on() {}, registerCommand(_name, options) { handler = options.handler; } };
	registrar(surface, () => dependencies);
	return () => { if (!handler) throw new Error("Steward command was not registered"); return handler; };
}

async function invoke(root: string, dependencies: StewardDependencies, command: string, registrar: Ticket08ExtensionRegistrar = registerStewardExtension): Promise<StatusView> {
	let view: StatusView | undefined;
	dependencies.ui = { ...dependencies.ui, presentStatus(value) { view = value; } };
	await registered(dependencies, registrar)()(command, context(root));
	if (!view) throw new Error("registered status did not present a view");
	return view;
}

function dependencies(root: string, effects: Ticket08CompletionEffects): StewardDependencies {
	const runJournal = createRunJournalAdapter();
	const archiveCompletedRun = runJournal.archiveCompletedRun;
	if (!archiveCompletedRun) throw new Error("Completion fixture requires the production archive adapter");
	runJournal.archiveCompletedRun = async (input) => {
		effects.archives = (effects.archives ?? 0) + 1;
		return archiveCompletedRun(input);
	};
	const builderPath = join(root, "builder-worktree");
	let uuid = 0;
	const ui: StewardUiAdapter = {
		presentStatus() {},
		async editConfiguration() { return { kind: "cancelled" }; },
		presentConfigurationResult() {},
		async draftRun() { return { kind: "drafted" as const, draft: draft() }; },
		async confirmRun(summary) {
			effects.confirmations = (effects.confirmations ?? 0) + 1;
			effects.confirmationSummaries = [...(effects.confirmationSummaries ?? []), summary];
			return true;
		},
		presentStartResult() {},
		notifyCompletion() { effects.notifications += 1; },
	};
	const checkout = () => ({ kind: "inspected" as const, observation: { branch: "main", head: effects.state === "base" ? baseRevision : headRevision, dirtyPaths: [], operationMarkers: [], rangeExact: true }, resolvedBaseRevision: baseRevision, resolvedHeadRevision: headRevision, commits: [...commits] });
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
			async stopAgentGracefully(input) { effects.stops.push(input.name); return { kind: "acknowledged", name: input.name, workspaceId: input.workspaceId, tabId: "tab-1", paneId: input.paneId, terminalId: input.terminalId }; },
		},
		git: {
			async inspectIntegrationBase() { return { kind: "ready", branch: "main", revision: baseRevision }; },
			async branchExists() { return false; },
			async inspectBuilderWorktree(_path, expectedRevision) { return { kind: "ready", head: expectedRevision, clean: true }; },
			async inspectProducedCodeArtifact(input) { return { kind: "inspected", base: baseRevision, head: input.producedHead, commits: [...commits], changedPaths: [{ status: "M", paths: ["src/change.ts"] }], clean: true }; },
			async inspectReviewWorktree() { return { head: headRevision, dirtyStateFingerprint: fingerprint, dirtyPaths: [], operationMarkers: [] }; },
			async inspectIntegrationCheckout() { return checkout(); },
			async integrateApprovedRange() { effects.merges += 1; effects.state = "integrated"; return { kind: "completed", code: 0, stdout: "fast-forward\n", stderr: "", killed: false }; },
		},
		process: { async runApprovedVerification(input) { effects.processes += 1; if (input.command !== "npm test" || input.cwd !== root) throw new Error("unexpected verification invocation"); return { kind: "completed", code: 0, stdout: "all good\n", stderr: "", killed: false }; } },
		model: { listModelChoices: () => [], async validateModelPlans() { return []; }, async inspectModelChoice(choice) { return { choice, available: true, diagnostics: [] }; } },
		clock: { now: () => new Date("2026-09-18T00:00:00.000Z"), randomUUID: () => `01234567-89ab-cdef-0123-456789abcde${++uuid}` },
		ui,
	};
}

async function start(root: string, deps: StewardDependencies, registrar: Ticket08ExtensionRegistrar = registerStewardExtension): Promise<RunJournal> {
	await mkdir(join(root, "builder-worktree", "src"), { recursive: true });
	await registered(deps, registrar)()("start", context(root));
	const result = await deps.runJournal.loadActive(root);
	if (result.kind !== "loaded") throw new Error("Run was not created");
	return result.journal;
}

async function writeBuilder(root: string, journal: RunJournal): Promise<void> {
	const task = journal.run.tasks[0]!;
	const attempt = task.attempts[0]!;
	if (attempt.role !== "builder") throw new Error("Builder missing");
	const assignment = JSON.parse(await readFile(attempt.assignmentPath, "utf8")) as { assignment: { actualModel: BuilderAttemptReport["actualModel"]; specificationHash: string } };
	const artifact = Buffer.from("approved\n");
	const evidencePath = join(attempt.evidenceDirectory, "artifact.snapshot");
	const logPath = join(attempt.evidenceDirectory, "check.log");
	await writeFile(join(root, "builder-worktree", "src", "change.ts"), artifact);
	await writeFile(evidencePath, artifact);
	await writeFile(logPath, "pass\n");
	const report: BuilderAttemptReport = { schemaVersion: 1, identity: { runId: journal.run.id, taskId: task.contract.id, attemptId: attempt.id, role: "builder", specificationHash: assignment.assignment.specificationHash, assignmentSha256: builderAssignmentSha256(await readFile(attempt.assignmentPath, "utf8")) }, status: "completed", summary: "Builder completed.", blockers: [], producedArtifacts: [{ kind: "git-commit", baseRevision, headRevision, commits }, { kind: "file", path: "src/change.ts", evidencePath, size: artifact.length, sha256: sha(artifact) }], actualModel: assignment.assignment.actualModel, checks: [{ kind: "command", command: "npm test", exitCode: 0, summary: "pass", logId: "check-1" }], logReferences: [{ id: "check-1", path: logPath, size: 5, sha256: sha(Buffer.from("pass\n")) }], producedRevision: headRevision };
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

export async function captureArchiveFixture(root: string): Promise<{ request: ArchiveCompletedRunRequest; activeBytes: Buffer; previousBytes: Buffer; paths: ReturnType<typeof resolveRunJournalPaths> }> {
	const effects: Ticket08CompletionEffects = { merges: 0, processes: 0, stops: [], notifications: 0, confirmations: 0, archives: 0, state: "base" };
	const deps = dependencies(root, effects);
	const started = await start(root, deps);
	await writeBuilder(root, started);
	await invoke(root, deps, "status");
	const reviewerDispatch = await deps.runJournal.loadActive(root);
	if (reviewerDispatch.kind !== "loaded") throw new Error("Reviewer dispatch did not persist");
	await writeReviewer(reviewerDispatch.journal);
	let request: ArchiveCompletedRunRequest | undefined;
	deps.runJournal.archiveCompletedRun = async (input) => { request = input; throw new Error("captured for direct storage contract"); };
	await invoke(root, deps, "status").catch(() => undefined);
	if (!request) throw new Error("Archive request was not captured");
	const paths = resolveRunJournalPaths(root);
	return { request, activeBytes: await readFile(paths.activePath), previousBytes: await readFile(paths.previousPath), paths };
}

export interface Ticket08CompletionFlow {
	effects: Ticket08CompletionEffects;
	deps: StewardDependencies;
	started: RunJournal;
	reviewerDispatch: RunJournal;
	finalView: StatusView;
	archiveDirectory: string;
}

/** Drive the registered ticket-08 completion path with a caller-supplied extension export. */
export async function driveTicket08CompletionFlow(root: string, registrar: Ticket08ExtensionRegistrar = registerStewardExtension): Promise<Ticket08CompletionFlow> {
	const effects: Ticket08CompletionEffects = { merges: 0, processes: 0, stops: [], notifications: 0, confirmations: 0, archives: 0, state: "base" };
	const deps = dependencies(root, effects);
	const started = await start(root, deps, registrar);
	await writeBuilder(root, started);
	await invoke(root, deps, "status", registrar);
	const loaded = await deps.runJournal.loadActive(root);
	if (loaded.kind !== "loaded") throw new Error("Reviewer dispatch did not persist");
	await writeReviewer(loaded.journal);
	const finalView = await invoke(root, deps, "status", registrar);
	if (finalView.kind !== "present" || !("completed" in finalView) || !finalView.completed) throw new Error("Registered completion flow did not reach a completed view");
	const archiveRoot = join(root, ".pi", "steward", "archives");
	const archives = await readdir(archiveRoot);
	if (archives.length !== 1 || !archives[0]) throw new Error(`Expected one completed archive, found ${archives.length}`);
	return { effects, deps, started, reviewerDispatch: loaded.journal, finalView, archiveDirectory: join(archiveRoot, archives[0]) };
}
