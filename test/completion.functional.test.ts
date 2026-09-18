import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRunJournalAdapter } from "../src/adapters.ts";
import { registerStewardExtension, type StewardCommandContext, type StewardCommandHandler, type StewardRegistrationSurface } from "../src/extension.ts";
import { builderAssignmentSha256, type RunDraft, type RunJournal } from "../src/run.ts";
import { serializeBuilderAttemptReport, type BuilderAttemptReport } from "../src/attempt-report.ts";
import { deserializeReviewerAssignment, serializeReviewerAttemptReport, type ReviewerAttemptReport } from "../src/review.ts";
import type { ModelChoice, ProjectModelPlans, RecoveryDefaults } from "../src/config.ts";
import type { IntegrationCheckoutResult, StewardDependencies, StewardUiAdapter, StatusView } from "../src/steward.ts";

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

function dependencies(root: string, effects: { merges: number; processes: number; stops: string[]; notifications: number; state: "base" | "integrated" }): StewardDependencies {
	const runJournal = createRunJournalAdapter();
	const builderPath = join(root, "builder-worktree");
	let uuid = 0;
	const ui: StewardUiAdapter = {
		presentStatus() {},
		async editConfiguration() { return { kind: "cancelled" }; },
		presentConfigurationResult() {},
		async draftRun() { return { kind: "drafted" as const, draft: draft() }; },
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
		process: { async runApprovedVerification(input) { effects.processes += 1; expect(input).toEqual({ cwd: root, command: "npm test" }); return { kind: "completed", code: 0, stdout: "all good\n", stderr: "", killed: false }; } },
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
	}, 15_000);

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
	}, 15_000);
});
