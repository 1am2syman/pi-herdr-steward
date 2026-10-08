import { removeFixture } from "./remove-fixture.ts";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { afterEach, it } from "vitest";

import { createRunJournalAdapter } from "../src/adapters.ts";
import { registerStewardExtension, type StewardCommandContext, type StewardCommandHandler, type StewardRegistrationSurface } from "../src/extension.ts";
import { serializeBuilderAttemptReport, type BuilderAttemptReport } from "../src/attempt-report.ts";
import { builderAssignmentSha256, type RunDraft, type RunJournal } from "../src/run.ts";
import type { ProjectModelPlans, RecoveryDefaults } from "../src/config.ts";
import type { ProducedCodeArtifactInspection, StewardDependencies, StewardUiAdapter, StatusView } from "../src/steward.ts";

const roots: string[] = [];
const baseRevision = "0123456789abcdef0123456789abcdef01234567";
const commits = ["1111111111111111111111111111111111111111", "2222222222222222222222222222222222222222"];
const headRevision = commits[1]!;
const modelPlans: ProjectModelPlans = {
	builder: { primary: { model: "builder/primary", thinkingLevel: "high" }, fallbacks: [] },
	reviewer: { primary: { model: "reviewer/primary", thinkingLevel: "high" }, fallbacks: [] },
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
	for (const root of roots.splice(0)) await removeFixture(root);
});

function digest(bytes: Buffer): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function draft(status: "code" | "non-git" = "code"): RunDraft {
	return {
		declaredOutcome: "Build the approved change",
		tasks: [{ requiredOutcome: "Implement the approved Builder change", allowedScope: ["src", "reports"], expectedArtifacts: status === "code" ? [{ kind: "git-commit" }, { kind: "file", path: "src/change.ts" }] : [{ kind: "evidence", description: "Builder evidence" }], verification: { kind: "command", command: "npm test" }, reviewRequired: true }],
		modelPlan: modelPlans,
		effectiveSettings: recovery,
		finalVerification: { kind: "command", command: "npm test" },
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

function capture(): { surface: StewardRegistrationSurface; handler: () => StewardCommandHandler; presentations: StatusView[] } {
	let command: StewardCommandHandler | undefined;
	const presentations: StatusView[] = [];
	return {
		surface: { on() {}, registerCommand(_name, options) { command = options.handler; } },
		handler() { if (!command) throw new Error("missing command handler"); return command; },
		presentations,
	};
}

function makeDependencies(root: string, gitResult: ProducedCodeArtifactInspection, statusResult: { value?: StatusView }, reportKind: "completed" | "blocked" = "completed"): StewardDependencies {
	const runJournal = createRunJournalAdapter();
	let uuid = 0;
	const builderPath = join(root, "builder-worktree");
	const ui: StewardUiAdapter = {
		presentStatus(value) { statusResult.value = value; },
		async editConfiguration() { return { kind: "cancelled" }; },
		presentConfigurationResult() {},
		async draftRun() { return { kind: "drafted" as const, draft: draft() }; },
		async confirmRun() { return true; },
		presentStartResult() {},
	};
	return {
		runJournal,
		herdr: {
			async checkAvailability() { return { kind: "available", status: "running", running: true, compatible: true, endpointCompatible: true }; },
			async createBuilderWorktree() {
				const active = await runJournal.loadActive(root);
				if (active.kind !== "loaded") throw new Error("Journal missing before worktree creation");
				const attempt = active.journal.run.tasks[0]!.attempts[0]!;
				return { kind: "created", branch: attempt.dispatch.branch, path: builderPath, workspaceId: "workspace-1", tabId: "tab-1", paneId: "pane-1", terminalId: "terminal-1" };
			},
			async startBuilder() {
				const active = await runJournal.loadActive(root);
				if (active.kind !== "loaded") throw new Error("Journal missing before agent start");
				const attempt = active.journal.run.tasks[0]!.attempts[0]!;
				return { kind: "started", name: attempt.dispatch.agentName, agentKind: "pi", workspaceId: "workspace-1", tabId: "tab-1", paneId: "pane-1", terminalId: "terminal-1" };
			},
			async promptBuilder(input) { return { kind: "prompted", name: input.name, workspaceId: "workspace-1", tabId: "tab-1", paneId: "pane-1", terminalId: "terminal-1" }; },
		},
		git: {
			async inspectIntegrationBase() { return { kind: "ready", branch: "main", revision: baseRevision }; },
			async branchExists() { return false; },
			async inspectBuilderWorktree(_path, expectedRevision) { return { kind: "ready", head: expectedRevision, clean: true }; },
			async inspectProducedCodeArtifact() { return gitResult; },
		},
		process: {},
		model: { listModelChoices: () => [], async validateModelPlans() { return []; } },
		clock: { now: () => new Date("2026-09-18T00:00:00.000Z"), randomUUID: () => `01234567-89ab-cdef-0123-456789abcde${++uuid}` },
		ui,
	};
}

async function startRun(root: string, dependencies: StewardDependencies): Promise<RunJournal> {
	await mkdir(join(root, "builder-worktree", "src"), { recursive: true });
	const registered = capture();
	registerStewardExtension(registered.surface, () => dependencies);
	await registered.handler()("start", context(root));
	const loaded = await dependencies.runJournal.loadActive(root);
	if (loaded.kind !== "loaded") throw new Error("Run did not start");
	ok(loaded.journal.run.tasks[0]!.attempts[0]!.state === "active");
	return loaded.journal;
}

async function writeReport(root: string, journal: RunJournal, status: "completed" | "blocked" = "completed", overrides: Partial<BuilderAttemptReport> = {}): Promise<BuilderAttemptReport> {
	const task = journal.run.tasks[0]!;
	const attempt = task.attempts[0]!;
	const assignment = JSON.parse(await readFile(attempt.assignmentPath, "utf8")) as { assignment: { actualModel: BuilderAttemptReport["actualModel"]; specificationHash: string; worktree: { path: string }; }; };
	const evidencePath = join(attempt.evidenceDirectory, "artifact.snapshot");
	const logPath = join(attempt.evidenceDirectory, "check.log");
	const sourcePath = join(assignment.assignment.worktree.path, "src", "change.ts");
	const artifactBytes = Buffer.from("approved artifact\n");
	await writeFile(sourcePath, artifactBytes);
	await writeFile(evidencePath, artifactBytes);
	const logBytes = Buffer.from("npm test: pass\n");
	await writeFile(logPath, logBytes);
	const report: BuilderAttemptReport = {
		schemaVersion: 1,
		identity: { runId: journal.run.id, taskId: task.contract.id, attemptId: attempt.id, role: "builder", specificationHash: assignment.assignment.specificationHash, assignmentSha256: builderAssignmentSha256(await readFile(attempt.assignmentPath, "utf8")) },
		status,
		summary: status === "completed" ? "Builder completed the approved change." : "Builder is blocked by a retained issue.",
		blockers: status === "completed" ? [] : ["A required external dependency is unavailable."],
		producedArtifacts: status === "completed" ? [{ kind: "git-commit", baseRevision, headRevision, commits }, { kind: "file", path: "src/change.ts", evidencePath, size: artifactBytes.length, sha256: digest(artifactBytes) }] : [],
		actualModel: assignment.assignment.actualModel,
		checks: [{ kind: "command", command: "npm test", exitCode: status === "completed" ? 0 : 1, summary: status === "completed" ? "All tests passed." : "The check could not run.", logId: "check-1" }],
		logReferences: [{ id: "check-1", path: logPath, size: logBytes.length, sha256: digest(logBytes) }],
		producedRevision: status === "completed" ? headRevision : null,
		...overrides,
	};
	await writeFile(attempt.reportPath, serializeBuilderAttemptReport(report), "utf8");
	return report;
}

async function invokeStatus(root: string, dependencies: StewardDependencies, sessionId = "controller-session"): Promise<StatusView> {
	const observed: { value?: StatusView } = {};
	dependencies.ui = { ...dependencies.ui, presentStatus(value) { observed.value = value; } };
	const registered = capture();
	registerStewardExtension(registered.surface, () => dependencies);
	await registered.handler()("status", context(root, sessionId));
	if (!observed.value) throw new Error("status was not presented");
	return observed.value;
}

const cleanGit: ProducedCodeArtifactInspection = { kind: "inspected", base: baseRevision, head: headRevision, commits, changedPaths: [{ status: "M", paths: ["src/change.ts"] }], clean: true };

it.sequential("registered status finalizes valid Builder evidence and keeps Review dispatch pending when Reviewer adapters are absent", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-evidence-"));
	roots.push(root);
	const statusResult: { value?: StatusView } = {};
	const dependencies = makeDependencies(root, cleanGit, statusResult);
	const journal = await startRun(root, dependencies);
	const attempt = journal.run.tasks[0]!.attempts[0]!;
	await writeReport(root, journal);
	equal(existsSync(join(attempt.assignmentPath, "..", "finalized")), false);
	const beforeRevision = (await dependencies.runJournal.loadActive(root)).kind === "loaded" ? ((await dependencies.runJournal.loadActive(root)) as { kind: "loaded"; journal: RunJournal }).journal.journalRevision : 0;
	const view = await invokeStatus(root, dependencies);
	match(view.markdown, /Review dispatch pending\./);
	const accepted = await dependencies.runJournal.loadActive(root);
	if (accepted.kind !== "loaded") throw new Error("accepted Journal missing");
	const acceptedAttempt = accepted.journal.run.tasks[0]!.attempts[0]!;
	equal(acceptedAttempt.state, "reported");
	equal(acceptedAttempt.evidence?.phase, "finalized");
	equal(accepted.journal.run.tasks[0]!.phase, "building");
	equal(existsSync(join(attempt.assignmentPath, "..", "finalized", "manifest.json")), true);
	equal((await readdir(join(attempt.assignmentPath, "..", "finalized", "artifacts"))).length, 1);
	const finalizedReport = await readFile(join(attempt.assignmentPath, "..", "finalized", "report.md"), "utf8");
	equal(finalizedReport, await readFile(attempt.reportPath, "utf8"));
	const second = await invokeStatus(root, dependencies);
	equal(second.markdown, view.markdown);
	const after = await dependencies.runJournal.loadActive(root);
	if (after.kind !== "loaded") throw new Error("Journal missing after retry");
	equal(after.journal.journalRevision, accepted.journal.journalRevision);
	ok(after.journal.journalRevision > beforeRevision);
}, 60_000);

it.sequential("registered status rejects assignment, report, scope, and dirty evidence without partial acceptance", async () => {
	const cases: Array<{ name: string; git: ProducedCodeArtifactInspection; mutate?: (journal: RunJournal) => Promise<void>; expected: string }> = [
		{ name: "assignment-changed", git: cleanGit, expected: "assignment-changed", mutate: async (journal) => { const path = journal.run.tasks[0]!.attempts[0]!.assignmentPath; const raw = JSON.parse(await readFile(path, "utf8")) as { assignment: { requiredOutcome: string } }; raw.assignment.requiredOutcome = "changed after dispatch"; await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`); await chmod(path, 0o600); } },
		{ name: "report-or-evidence-invalid", git: cleanGit, expected: "report-or-evidence-invalid", mutate: async (journal) => { const report = await writeReport(rootForCurrent, journal); report.logReferences[0]!.sha256 = digest(Buffer.from("wrong")); await writeFile(journal.run.tasks[0]!.attempts[0]!.reportPath, serializeBuilderAttemptReport(report)); } },
		{ name: "scope-violation", git: { ...cleanGit, changedPaths: [{ status: "R100", paths: ["outside.txt", "src/change.ts"] }] }, expected: "scope-violation" },
		{ name: "dirty-worktree", git: { kind: "invalid", code: "dirty-worktree", message: "tracked and untracked changes", dirtyPaths: ["src/change.ts", "untracked.txt"] }, expected: "dirty-worktree" },
	];
	for (const testCase of cases) {
		const root = await mkdtemp(join(tmpdir(), `pi-herdr-steward-${testCase.name}-`));
		roots.push(root);
		rootForCurrent = root;
		const statusResult: { value?: StatusView } = {};
		const dependencies = makeDependencies(root, testCase.git, statusResult);
		const journal = await startRun(root, dependencies);
		await writeReport(root, journal);
		if (testCase.mutate) await testCase.mutate(journal);
		const before = await readFile(journal.run.tasks[0]!.attempts[0]!.reportPath);
		const view = await invokeStatus(root, dependencies);
		match(view.markdown, new RegExp(testCase.expected));
		const rejected = await dependencies.runJournal.loadActive(root);
		if (rejected.kind !== "loaded") throw new Error("rejected Journal missing");
		equal(rejected.journal.run.tasks[0]!.attempts[0]!.state, "active");
		equal(rejected.journal.run.tasks[0]!.attempts[0]!.evidence?.phase, "rejected");
		equal(rejected.journal.run.tasks[0]!.attempts[0]!.evidence?.codes.includes(testCase.expected as never), true);
		equal(existsSync(join(journal.run.tasks[0]!.attempts[0]!.assignmentPath, "..", "finalized")), false);
		deepStrictEqual(await readFile(journal.run.tasks[0]!.attempts[0]!.reportPath), before);
		const revision = rejected.journal.journalRevision;
		await invokeStatus(root, dependencies);
		const retry = await dependencies.runJournal.loadActive(root);
		if (retry.kind !== "loaded") throw new Error("retry Journal missing");
		equal(retry.journal.journalRevision, revision);
	}
}, 60_000);

let rootForCurrent = "";

it.sequential("blocked Builder evidence is finalized and retained without Review eligibility", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-blocked-"));
	roots.push(root);
	const statusResult: { value?: StatusView } = {};
	const dependencies = makeDependencies(root, cleanGit, statusResult, "blocked");
	const journal = await startRun(root, dependencies);
	await writeReport(root, journal, "blocked");
	const view = await invokeStatus(root, dependencies);
	match(view.markdown, /retained Builder outcome is not Review-eligible/);
	const accepted = await dependencies.runJournal.loadActive(root);
	if (accepted.kind !== "loaded") throw new Error("blocked Journal missing");
	equal(accepted.journal.run.tasks[0]!.attempts[0]!.state, "reported");
	equal(accepted.journal.run.tasks[0]!.attempts[0]!.evidence?.phase, "finalized");
	equal(accepted.journal.run.tasks[0]!.attempts[0]!.evidence?.status, "blocked");
}, 60_000);

it.sequential("footer and non-controller status stay read-only", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-authority-"));
	roots.push(root);
	const statusResult: { value?: StatusView } = {};
	const dependencies = makeDependencies(root, cleanGit, statusResult);
	const journal = await startRun(root, dependencies);
	await writeReport(root, journal);
	const before = (await dependencies.runJournal.loadActive(root));
	if (before.kind !== "loaded") throw new Error("Journal missing");
	const view = await invokeStatus(root, dependencies, "another-session");
	match(view.markdown, /Controller Session controller-session is recorded; current Session another-session is read-only\. Run \/steward resume --takeover to reconcile and claim ownership\./);
	const after = await dependencies.runJournal.loadActive(root);
	if (after.kind !== "loaded") throw new Error("Journal missing after authority check");
	equal(after.journal.journalRevision, before.journal.journalRevision);
	equal(after.journal.run.tasks[0]!.attempts[0]!.state, "active");
}, 60_000);
