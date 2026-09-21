import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { createRunJournalAdapter } from "../src/adapters.ts";
import { registerStewardExtension, type StewardCommandContext, type StewardCommandHandler, type StewardRegistrationSurface } from "../src/extension.ts";
import { builderAssignmentSha256, type RunDraft, type RunJournal } from "../src/run.ts";
import { resolveRunJournalPaths } from "../src/run-journal-store.ts";
import { serializeBuilderAttemptReport, type BuilderAttemptReport } from "../src/attempt-report.ts";
import type { ProjectModelPlans, RecoveryDefaults } from "../src/config.ts";
import type { CancellationResult, CleanupResult, HerdrStopResult, RunJournalAdapter, StewardDependencies, StewardUiAdapter, StatusView } from "../src/steward.ts";

const roots: string[] = [];
const baseRevision = "0123456789abcdef0123456789abcdef01234567";
const headRevision = "1111111111111111111111111111111111111111";
const modelPlan: ProjectModelPlans = {
	builder: { primary: { model: "builder/model", thinkingLevel: "high" }, fallbacks: [] },
	reviewer: { primary: { model: "reviewer/model", thinkingLevel: "high" }, fallbacks: [] },
};
const recovery: RecoveryDefaults = {
	passiveInspectionIntervalSeconds: 301,
	secondInspectionAndNudgeIntervalSeconds: 302,
	nudgeGracePeriodSeconds: 121,
	externalCommandWarningThresholdSeconds: 1801,
	maximumActiveTasks: 1,
	transientRetryLimit: 1,
	reworkCycleLimit: 4,
};

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});

function sha(bytes: Buffer): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function draft(): RunDraft {
	return {
		declaredOutcome: "Cancel only after preserving the exact Steward evidence",
		tasks: [{
			requiredOutcome: "Implement the bounded change",
			allowedScope: ["src"],
			expectedArtifacts: [{ kind: "git-commit" }, { kind: "file", path: "src/change.ts" }],
			verification: { kind: "command", command: "npm test" },
			reviewRequired: true,
		}, {
			requiredOutcome: "Preserve the second bounded change as pending cancellation work",
			allowedScope: ["src"],
			expectedArtifacts: [{ kind: "file", path: "src/other-change.ts" }],
			verification: { kind: "command", command: "npm test" },
			reviewRequired: false,
		}],
		modelPlan,
		effectiveSettings: recovery,
		finalVerification: { kind: "command", command: "npm test" },
	};
}

function context(root: string): StewardCommandContext {
	return {
		mode: "tui",
		hasUI: true,
		cwd: root,
		modelRegistry: {} as StewardCommandContext["modelRegistry"],
		model: undefined,
		thinkingLevel: undefined,
		scopedModels: [],
		sessionManager: { getSessionId: () => "controller-session" } as StewardCommandContext["sessionManager"],
		ui: { select: async () => undefined, input: async () => undefined, confirm: async () => false, notify() {}, setStatus() {} },
	};
}

function registered(dependencies: StewardDependencies): () => StewardCommandHandler {
	let handler: StewardCommandHandler | undefined;
	const surface: StewardRegistrationSurface = { on() {}, registerCommand(_name, options) { handler = options.handler; } };
	registerStewardExtension(surface, () => dependencies);
	return () => {
		if (!handler) throw new Error("Steward command was not registered");
		return handler;
	};
}

it.sequential("registered cancel durably precedes stop and cleanup removes only exact owned resources", async () => {
	const root = await mkdtemp(join(tmpdir(), "steward-t18-cancel-cleanup-"));
	roots.push(root);
	const runJournal = createRunJournalAdapter();
	await runJournal.saveRecoveryDefaults(recovery);
	await runJournal.saveModelPlans(root, modelPlan);
	const builderPath = join(root, "builder-worktree");
	await mkdir(join(builderPath, "src"), { recursive: true });
	const unrelatedPath = join(root, "unrelated-worktree");
	const unrelatedMarker = join(unrelatedPath, "survives.txt");
	await mkdir(unrelatedPath, { recursive: true });
	await writeFile(unrelatedMarker, "unrelated resource\n");
	const effects = {
		builderPrompts: 0,
		reviewerPrompts: 0,
		reviewerStarts: 0,
		inspections: [] as string[],
		stops: [] as string[],
		preflights: [] as string[],
		closedPanes: [] as string[],
		removedWorktrees: [] as string[],
	};
	let allowCancellation = false;
	let cleanupConfirmations = 0;
	let cancellationResult: CancellationResult | undefined;
	let cleanupResult: CleanupResult | undefined;
	let statusView: StatusView | undefined;
	let cleanupSummary: Parameters<NonNullable<StewardUiAdapter["confirmCleanup"]>>[0] | undefined;

	const ui: StewardUiAdapter = {
		presentStatus(value) { statusView = value; },
		async editConfiguration() { return { kind: "cancelled" }; },
		presentConfigurationResult() {},
		async draftRun() { return { kind: "drafted" as const, draft: draft() }; },
		async confirmRun() { return true; },
		presentStartResult() {},
		async confirmCancellation() { return allowCancellation; },
		presentCancellationResult(value) { cancellationResult = value; },
		async confirmCleanup(summary) {
			cleanupSummary = summary;
			cleanupConfirmations += 1;
			return cleanupConfirmations > 1;
		},
		presentCleanupResult(value) { cleanupResult = value; },
	};

	const deps: StewardDependencies = {
		runJournal,
		herdr: {
			async checkAvailability() { return { kind: "available", status: "running", running: true, compatible: true, endpointCompatible: true }; },
			async createBuilderWorktree(input) { return { kind: "created", branch: input.branch, path: builderPath, workspaceId: "workspace-owned", tabId: "tab-root", paneId: "pane-root", terminalId: "terminal-root" }; },
			async startBuilder(input) { return { kind: "started", name: input.name, agentKind: "pi", workspaceId: "workspace-owned", tabId: "tab-root", paneId: "pane-root", terminalId: "terminal-root" }; },
			async promptBuilder(input) { effects.builderPrompts += 1; return { kind: "prompted", name: input.name, workspaceId: "workspace-owned", tabId: "tab-root", paneId: "pane-root", terminalId: "terminal-root" }; },
			async createReviewerPane(input) { return { kind: "created", workspaceId: "workspace-owned", tabId: "tab-reviewer", paneId: "pane-reviewer", terminalId: "terminal-reviewer", sourcePaneId: input.sourcePaneId, worktreePath: input.worktreePath }; },
			async startReviewer(input) { effects.reviewerStarts += 1; return { kind: "started", name: input.name, agentKind: "pi", workspaceId: "workspace-owned", tabId: "tab-reviewer", paneId: "pane-reviewer", terminalId: "terminal-reviewer" }; },
			async promptReviewer(input) { effects.reviewerPrompts += 1; return { kind: "prompted", name: input.name, workspaceId: "workspace-owned", tabId: "tab-reviewer", paneId: "pane-reviewer", terminalId: "terminal-reviewer" }; },
			async inspectManagedAgent(identity) {
				effects.inspections.push(identity.name);
				if (allowCancellation) {
					const live = await runJournal.loadActive(root);
					expect(live.kind).toBe("loaded");
					if (live.kind === "loaded") {
						expect(live.journal.run.status).toBe("cancelled");
						expect(live.journal.run.cancellation?.phase).toBe("stops-intended");
						expect(live.journal.run.cancellation?.stops.some((stop) => stop.state === "intended" && stop.agent.agentName === identity.name && stop.agent.workspaceId === identity.workspaceId && stop.agent.paneId === identity.paneId && stop.agent.terminalId === identity.terminalId)).toBe(true);
					}
				}
				return { kind: "observed", identity: { ...identity }, lifecycle: "working", stateChangeSequence: 1 };
			},
			async stopAgentGracefully(input): Promise<HerdrStopResult> {
				effects.stops.push(input.name);
				const live = await runJournal.loadActive(root);
				expect(live.kind).toBe("loaded");
				if (live.kind === "loaded") expect(live.journal.run.cancellation?.phase).toBe("stops-intended");
				return { kind: "acknowledged", name: input.name, workspaceId: input.workspaceId, tabId: "tab-reviewer", paneId: input.paneId, terminalId: input.terminalId };
			},
			async preflightCleanupWorkspace(input) {
				effects.preflights.push(input.workspaceId);
				if (input.workspaceId === "workspace-unrelated") return { kind: "ready", workspaceId: input.workspaceId, panes: [{ workspaceId: input.workspaceId, paneId: "pane-unrelated", terminalId: "terminal-unrelated", root: false }], worktrees: [{ workspaceId: input.workspaceId, path: unrelatedPath, branch: "steward/unrelated", rootPaneId: "pane-unrelated" }] };
				const owned = cleanupSummary?.worktrees.find((worktree) => worktree.workspaceId === input.workspaceId);
				if (!owned) return { kind: "ambiguous", message: "missing test ownership" };
				return {
					kind: "ready",
					workspaceId: input.workspaceId,
					panes: [
						{ workspaceId: input.workspaceId, paneId: "pane-root", terminalId: "terminal-root", root: true },
						{ workspaceId: input.workspaceId, paneId: "pane-reviewer", terminalId: "terminal-reviewer", root: false },
					],
					worktrees: [{ workspaceId: input.workspaceId, path: owned.path, branch: owned.branch, rootPaneId: "pane-root" }],
				};
			},
			async closeCleanupPane(input) { effects.closedPanes.push(input.paneId); return { kind: "completed", resourceId: input.paneId }; },
			async removeCleanupWorktree(input) { effects.removedWorktrees.push(input.path); return { kind: "completed", resourceId: input.path }; },
		},
		git: {
			async inspectIntegrationBase() { return { kind: "ready", branch: "main", revision: baseRevision }; },
			async branchExists() { return false; },
			async inspectBuilderWorktree(_path, expectedRevision) { return { kind: "ready", head: expectedRevision, clean: true }; },
			async inspectProducedCodeArtifact(input) { return { kind: "inspected", base: baseRevision, head: input.producedHead, commits: [headRevision], changedPaths: [{ status: "M", paths: ["src/change.ts"] }], clean: true }; },
			async inspectReviewWorktree() { return { head: headRevision, dirtyStateFingerprint: `sha256:${"a".repeat(64)}`, dirtyPaths: [], operationMarkers: [] }; },
		},
		process: {},
		model: { listModelChoices: () => [], async validateModelPlans() { return []; }, async inspectModelChoice(choice) { return { choice, available: true, diagnostics: [] }; } },
		clock: { now: () => new Date("2026-09-21T00:00:00.000Z"), randomUUID: () => "01234567-89ab-cdef-0123-456789abcdef" },
		ui,
	};

	const handler = registered(deps)();
	await handler("start", context(root));
	const started = await runJournal.loadActive(root);
	expect(started.kind).toBe("loaded");
	if (started.kind !== "loaded") return;
	const builder = started.journal.run.tasks[0]?.attempts[0];
	expect(builder?.role).toBe("builder");
	if (!builder || builder.role !== "builder") return;

	const assignmentBytes = await readFile(builder.assignmentPath);
	const assignment = JSON.parse(assignmentBytes.toString("utf8")) as { assignment: { actualModel: BuilderAttemptReport["actualModel"]; specificationHash: string } };
	const artifact = Buffer.from("cancel-cleanup evidence\n");
	const evidencePath = join(builder.evidenceDirectory, "artifact.snapshot");
	const logPath = join(builder.evidenceDirectory, "check.log");
	await mkdir(builder.evidenceDirectory, { recursive: true });
	await writeFile(join(builderPath, "src", "change.ts"), artifact);
	await writeFile(evidencePath, artifact);
	await writeFile(logPath, "pass\n");
	const report: BuilderAttemptReport = {
		schemaVersion: 1,
		identity: { runId: started.journal.run.id, taskId: started.journal.run.tasks[0]!.contract.id, attemptId: builder.id, role: "builder", specificationHash: assignment.assignment.specificationHash, assignmentSha256: builderAssignmentSha256(assignmentBytes.toString("utf8")) },
		status: "completed",
		summary: "Builder produced the bounded cancellation evidence.",
		blockers: [],
		producedArtifacts: [
			{ kind: "git-commit", baseRevision, headRevision, commits: [headRevision] },
			{ kind: "file", path: "src/change.ts", evidencePath, size: artifact.length, sha256: sha(artifact) },
		],
		actualModel: assignment.assignment.actualModel,
		checks: [{ kind: "command", command: "npm test", exitCode: 0, summary: "pass", logId: "check-1" }],
		logReferences: [{ id: "check-1", path: logPath, size: 5, sha256: sha(Buffer.from("pass\n")) }],
		producedRevision: headRevision,
	};
	await writeFile(builder.reportPath, serializeBuilderAttemptReport(report));

	await handler("status", context(root));
	const evidenceFinalized = await runJournal.loadActive(root);
	expect(evidenceFinalized.kind).toBe("loaded");
	if (evidenceFinalized.kind !== "loaded") return;
	expect(evidenceFinalized.journal.run.tasks[0]?.attempts.at(-1)?.state).toBe("reported");
	await handler("status", context(root));
	const reviewing = await runJournal.loadActive(root);
	expect(reviewing.kind).toBe("loaded");
	if (reviewing.kind !== "loaded") return;
	expect(reviewing.journal.run.tasks[0]?.phase).toBe("reviewing");
	expect(reviewing.journal.run.tasks[0]?.attempts.at(-1)?.role).toBe("reviewer");
	const reviewer = reviewing.journal.run.tasks[0]!.attempts.at(-1)!;
	const assignmentSnapshot = await readFile(builder.assignmentPath);
	const evidenceSnapshot = await readFile(evidencePath);
	const activityPath = join(root, ".pi", "steward", "runs", reviewing.journal.run.id, "activity.log");
	const activitySnapshot = await readFile(activityPath);
			const activeBeforeDecline = await readFile(resolveRunJournalPaths(root).activePath);

	await handler("cancel", context(root));
	expect(cancellationResult?.kind).toBe("declined");
	expect(await readFile(resolveRunJournalPaths(root).activePath)).toEqual(activeBeforeDecline);
	expect(effects.stops).toEqual([]);

	allowCancellation = true;
	await handler("cancel", context(root));
	expect(cancellationResult?.kind).toBe("archived");
	expect(effects.stops).toEqual(["steward-r-01234567-01-02"]);
	const terminalArchives = await runJournal.listTerminalArchives!(root);
	expect(terminalArchives.kind).toBe("loaded");
	if (terminalArchives.kind !== "loaded") return;
	expect(terminalArchives.archives).toHaveLength(1);
		const archive = terminalArchives.archives[0]!;
		expect(archive.kind).toBe("cancelled");
		expect(archive.run.run.cancellation?.phase).toBe("archived");
		expect(archive.run.run.tasks).toHaveLength(2);
		expect(archive.run.run.tasks[1]?.phase).toBe("cancelled");
		expect(archive.run.run.cancellation?.priorTasks.map((task) => task.taskId)).toEqual(["task-01", "task-02"]);
		expect(archive.run.run.cancellation?.stops.some((stop) => stop.state === "acknowledged" && stop.agent.agentName === effects.stops[0])).toBe(true);

	const promptsBeforeDormancy = { builder: effects.builderPrompts, reviewer: effects.reviewerPrompts, starts: effects.reviewerStarts };
	await handler("status", context(root));
	await handler("resume", context(root));
	expect(statusView?.kind).toBe("empty");
	expect(effects.builderPrompts).toBe(promptsBeforeDormancy.builder);
	expect(effects.reviewerPrompts).toBe(promptsBeforeDormancy.reviewer);
	expect(effects.reviewerStarts).toBe(promptsBeforeDormancy.starts);

	await handler("cleanup", context(root));
	expect(cleanupResult?.kind).toBe("declined");
	expect(effects.preflights).toEqual([]);
	expect(effects.closedPanes).toEqual([]);
	expect(effects.removedWorktrees).toEqual([]);
	await handler("cleanup", context(root));
	expect(cleanupResult?.kind).toBe("completed");
	expect(cleanupSummary?.panes.map((pane) => `${pane.workspaceId}/${pane.paneId}/${pane.terminalId}`)).toEqual(["workspace-owned/pane-reviewer/terminal-reviewer", "workspace-owned/pane-root/terminal-root"]);
	expect(cleanupSummary?.worktrees).toHaveLength(1);
	expect(effects.preflights).toEqual(["workspace-owned"]);
	expect(effects.closedPanes).toEqual(["pane-reviewer"]);
	expect(effects.removedWorktrees).toEqual([builderPath]);
	expect(effects.preflights).not.toContain("workspace-unrelated");
	expect(effects.closedPanes).not.toContain("pane-unrelated");
	expect(effects.removedWorktrees).not.toContain(unrelatedPath);
	expect(await readFile(unrelatedMarker, "utf8")).toBe("unrelated resource\n");

	expect(await readFile(builder.assignmentPath)).toEqual(assignmentSnapshot);
	expect(await readFile(evidencePath)).toEqual(evidenceSnapshot);
	expect((await readFile(activityPath)).subarray(0, activitySnapshot.length)).toEqual(activitySnapshot);
	expect(await readFile(join(archive.archiveDirectory, "run.json"))).toBeTruthy();
	expect(await runJournal.probeActive(root)).toBe("missing");

	let failCancellationPersistence = false;
	const failingRunJournal: RunJournalAdapter = {
		...runJournal,
		async replaceActive(repositoryRoot, candidate) {
			if (failCancellationPersistence && candidate.run.status === "cancelled" && candidate.run.cancellation?.phase === "stops-intended") return { kind: "storage-error", paths: resolveRunJournalPaths(repositoryRoot), diagnostics: [] };
			return runJournal.replaceActive(repositoryRoot, candidate);
		},
	};
	const failingHandler = registered({ ...deps, runJournal: failingRunJournal })();
	await failingHandler("start", context(root));
	const inspectionsBeforePersistenceFailure = effects.inspections.length;
	const stopsBeforePersistenceFailure = effects.stops.length;
	failCancellationPersistence = true;
	await failingHandler("cancel", context(root));
	expect(cancellationResult?.kind).toBe("storage-error");
	expect(effects.inspections).toHaveLength(inspectionsBeforePersistenceFailure);
	expect(effects.stops).toHaveLength(stopsBeforePersistenceFailure);
	const failedCancellationRun = await runJournal.loadActive(root);
	expect(failedCancellationRun.kind).toBe("loaded");
	if (failedCancellationRun.kind === "loaded") expect(failedCancellationRun.journal.run.status).toBe("active");
}, 60_000);
