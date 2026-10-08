import { removeFixture } from "./remove-fixture.ts";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { createProcessAdapter, createRunJournalAdapter } from "../src/adapters.ts";
import { registerStewardExtension, type StewardCommandContext, type StewardCommandHandler, type StewardRegistrationSurface } from "../src/extension.ts";
import { builderAssignmentSha256, deserializeRunJournal, isRecoverableFinalVerificationExecution, type RunDraft, type RunJournal } from "../src/run.ts";
import { serializeBuilderAttemptReport, type BuilderAttemptReport } from "../src/attempt-report.ts";
import { deserializeReviewerAssignment, serializeReviewerAttemptReport, type ReviewerAttemptReport } from "../src/review.ts";
import type { ModelChoice, ProjectModelPlans, RecoveryDefaults } from "../src/config.ts";
import { createSteward } from "../src/steward.ts";
import type { GitCommandOutcome, HerdrStopResult, IntegrationCheckoutResult, StewardDependencies, StewardUiAdapter, StatusView } from "../src/steward.ts";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const baseRevision = "0123456789abcdef0123456789abcdef01234567";
const commits = ["1111111111111111111111111111111111111111", "2222222222222222222222222222222222222222"];
const headRevision = commits[1]!;
const fingerprint = `sha256:${"a".repeat(64)}`;
const recovery: RecoveryDefaults = { passiveInspectionIntervalSeconds: 301, secondInspectionAndNudgeIntervalSeconds: 302, nudgeGracePeriodSeconds: 121, externalCommandWarningThresholdSeconds: 1801, maximumActiveTasks: 1, transientRetryLimit: 1, reworkCycleLimit: 4 };
const modelPlan: ProjectModelPlans = { builder: { primary: { model: "builder/model", thinkingLevel: "high" }, fallbacks: [] }, reviewer: { primary: { model: "reviewer/model", thinkingLevel: "high" }, fallbacks: [] } };

afterEach(async () => {
	for (const root of roots.splice(0)) await removeFixture(root);
});

function sha(bytes: Buffer): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function shellQuote(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

function draft(finalCommand: string, taskCount: number): RunDraft {
	return {
		declaredOutcome: "Complete the verified change",
		tasks: Array.from({ length: taskCount }, (_, index) => ({ requiredOutcome: `Implement change ${index + 1}`, allowedScope: ["src"], expectedArtifacts: [{ kind: "git-commit" as const }, { kind: "file" as const, path: `src/change-${index + 1}.ts` }], verification: { kind: "command" as const, command: "true" }, reviewRequired: true })),
		modelPlan,
		effectiveSettings: recovery,
		finalVerification: { kind: "command", command: finalCommand },
	};
}

function context(root: string): StewardCommandContext {
	return { mode: "tui", hasUI: true, cwd: root, modelRegistry: {} as StewardCommandContext["modelRegistry"], model: undefined, thinkingLevel: undefined, scopedModels: [], sessionManager: { getSessionId: () => "controller-session" } as StewardCommandContext["sessionManager"], ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined, notify() {}, setStatus() {} } };
}

function registered(dependencies: StewardDependencies): () => StewardCommandHandler {
	let handler: StewardCommandHandler | undefined;
	const surface: StewardRegistrationSurface = { on() {}, registerCommand(_name, options) { handler = options.handler; } };
	registerStewardExtension(surface, () => dependencies);
	return () => { if (!handler) throw new Error("steward command was not registered"); return handler; };
}

async function invoke(root: string, dependencies: StewardDependencies): Promise<StatusView> {
	let view: StatusView | undefined;
	dependencies.ui = { ...dependencies.ui, presentStatus(value) { view = value; } };
	await registered(dependencies)()("status", context(root));
	if (!view) throw new Error("registered status did not present a view");
	return view;
}

interface Effects {
	state: "base" | "integrated";
	merges: number;
	processStops: string[];
	builderPrompts: string[];
	notifications: number;
}

async function checkoutObservation(root: string, effects: Effects, input?: { approvedBaseRevision: string; approvedHeadRevision: string; approvedCommits: string[] }): Promise<IntegrationCheckoutResult> {
	const dirtyPaths: string[] = [];
	try { if ((await readFile(join(root, "README.md"), "utf8")) !== "baseline\n") dirtyPaths.push("README.md"); } catch { dirtyPaths.push("README.md"); }
	try { await access(join(root, "verification-created.txt")); dirtyPaths.push("verification-created.txt"); } catch { /* absent */ }
	return { kind: "inspected", observation: { branch: "main", head: effects.state === "base" ? baseRevision : headRevision, dirtyPaths, operationMarkers: [], rangeExact: true }, resolvedBaseRevision: input?.approvedBaseRevision ?? baseRevision, resolvedHeadRevision: input?.approvedHeadRevision ?? headRevision, commits: input?.approvedCommits ? [...input.approvedCommits] : [...commits] };
}

function dependencies(root: string, effects: Effects, configuredDraft: RunDraft): StewardDependencies {
	const runJournal = createRunJournalAdapter();
	let clockTick = 0;
	const builders = new Map<string, { workspaceId: string; tabId: string; paneId: string; terminalId: string }>();
	const reviewers = new Map<string, { workspaceId: string; tabId: string; paneId: string; terminalId: string }>();
	const ui: StewardUiAdapter = {
		presentStatus() {},
		async editConfiguration() { return { kind: "cancelled" }; },
		presentConfigurationResult() {},
		async draftRun() { return { kind: "drafted" as const, draft: configuredDraft }; },
		async confirmRun() { return true; },
		presentStartResult() {},
		notifyCompletion() { effects.notifications += 1; },
	};
	return {
		runJournal,
		herdr: {
			async checkAvailability() { return { kind: "available", status: "running", running: true, compatible: true, endpointCompatible: true }; },
			async createBuilderWorktree(input) { const taskKey = input.branch.match(/(task-[^/]+)/)?.[1] ?? "task-01"; const path = join(root, `${taskKey}-worktree`); await mkdir(join(path, "src"), { recursive: true }); const resource = { workspaceId: `workspace-${taskKey}`, tabId: `tab-${taskKey}`, paneId: `${taskKey}-builder-pane`, terminalId: `${taskKey}-builder-terminal` }; builders.set(resource.paneId, resource); return { kind: "created", branch: input.branch, path, ...resource }; },
			async startBuilder(input) { const resource = [...builders.values()].find((candidate) => candidate.paneId === input.paneId) ?? { workspaceId: "workspace-task-01", tabId: "tab-task-01", paneId: input.paneId, terminalId: "task-01-builder-terminal" }; builders.set(input.name, resource); return { kind: "started", name: input.name, agentKind: "pi", workspaceId: resource.workspaceId, tabId: resource.tabId, paneId: resource.paneId, terminalId: resource.terminalId }; },
			async promptBuilder(input) { effects.builderPrompts.push(input.name); const resource = builders.get(input.name) ?? { workspaceId: "workspace-task-01", tabId: "tab-task-01", paneId: "task-01-builder-pane", terminalId: "task-01-builder-terminal" }; return { kind: "prompted", name: input.name, workspaceId: resource.workspaceId, tabId: resource.tabId, paneId: resource.paneId, terminalId: resource.terminalId }; },
			async createReviewerPane(input) { const resource = { workspaceId: input.workspaceId, tabId: `${input.workspaceId}-reviewer-tab`, paneId: `${input.sourcePaneId}-reviewer-pane`, terminalId: `${input.sourcePaneId}-reviewer-terminal` }; reviewers.set(resource.paneId, resource); return { kind: "created", ...resource, sourcePaneId: input.sourcePaneId, worktreePath: input.worktreePath }; },
			async startReviewer(input) { const resource = reviewers.get(input.paneId) ?? { workspaceId: "workspace-task-01", tabId: "tab-task-01-reviewer", paneId: input.paneId, terminalId: "task-01-reviewer-terminal" }; reviewers.set(input.name, resource); return { kind: "started", name: input.name, agentKind: "pi", workspaceId: resource.workspaceId, tabId: resource.tabId, paneId: resource.paneId, terminalId: resource.terminalId }; },
			async promptReviewer(input) { const resource = reviewers.get(input.name) ?? { workspaceId: "workspace-task-01", tabId: "tab-task-01-reviewer", paneId: "task-01-reviewer-pane", terminalId: "task-01-reviewer-terminal" }; return { kind: "prompted", name: input.name, workspaceId: resource.workspaceId, tabId: resource.tabId, paneId: resource.paneId, terminalId: resource.terminalId }; },
			async stopAgentGracefully(input) { effects.processStops.push(input.name); return { kind: "acknowledged", name: input.name, workspaceId: input.workspaceId, tabId: "tab-1", paneId: input.paneId, terminalId: input.terminalId } satisfies HerdrStopResult; },
		},
		git: {
			async inspectIntegrationBase() { return { kind: "ready", branch: "main", revision: baseRevision }; },
			async branchExists() { return false; },
			async inspectBuilderWorktree(_path, expectedRevision) { return { kind: "ready", head: expectedRevision, clean: true }; },
			async inspectProducedCodeArtifact(input) { return { kind: "inspected", base: input.approvedBase, head: input.producedHead, commits: [...commits], changedPaths: [{ status: "M", paths: ["src/change.ts"] }], clean: true }; },
			async inspectReviewWorktree() { return { head: headRevision, dirtyStateFingerprint: fingerprint, dirtyPaths: [], operationMarkers: [] }; },
			async inspectIntegrationCheckout(input) { return checkoutObservation(root, effects, input); },
			async integrateApprovedRange(_input): Promise<GitCommandOutcome> { effects.merges += 1; effects.state = "integrated"; return { kind: "completed", code: 0, stdout: "fast-forward\n", stderr: "", killed: false }; },
		},
		process: createProcessAdapter(undefined),
		model: { listModelChoices: () => [], async validateModelPlans() { return []; }, async inspectModelChoice(choice: ModelChoice) { return { choice, available: true, diagnostics: [] }; } },
		clock: { now: () => new Date(2026, 8, 20, 0, 0, 0, ++clockTick), randomUUID },
		ui,
	};
}

async function initializeRepository(root: string): Promise<void> {
	await mkdir(join(root, "src"), { recursive: true });
	await writeFile(join(root, "README.md"), "baseline\n");
	await writeFile(join(root, ".gitignore"), ".pi/\nbuilder-worktree/\n");
	await execFile("git", ["init", "--initial-branch=main"], { cwd: root });
	await execFile("git", ["config", "user.email", "steward-test@example.invalid"], { cwd: root });
	await execFile("git", ["config", "user.name", "Steward Test"], { cwd: root });
	await execFile("git", ["add", "."], { cwd: root });
	await execFile("git", ["commit", "-m", "fixture"], { cwd: root });
}

async function fixture(finalCommand: string, taskCount = 1): Promise<{ root: string; marker: string; effects: Effects; dependencies: StewardDependencies }> {
	const sandbox = await mkdtemp(join(tmpdir(), "steward-final-verification-"));
	roots.push(sandbox);
	const root = join(sandbox, "repo");
	const marker = join(sandbox, "verification-runs");
	await mkdir(root, { recursive: true });
	await initializeRepository(root);
	await mkdir(join(root, "builder-worktree", "src"), { recursive: true });
	const effects: Effects = { state: "base", merges: 0, processStops: [], builderPrompts: [], notifications: 0 };
	return { root, marker, effects, dependencies: dependencies(root, effects, draft(finalCommand, taskCount)) };
}

async function load(root: string): Promise<RunJournal> {
	const loaded = await createRunJournalAdapter().loadActive(root);
	if (loaded.kind !== "loaded") throw new Error(`active journal ${loaded.kind}`);
	return loaded.journal;
}

async function loadCurrentOrArchive(root: string): Promise<RunJournal | undefined> {
	const active = await createRunJournalAdapter().loadActive(root);
	if (active.kind === "loaded") return active.journal;
	if (active.kind !== "missing") return undefined;
	const archiveRoot = join(root, ".pi", "steward", "archives");
	const runs = await readdir(archiveRoot).catch(() => []);
	if (runs.length !== 1) return undefined;
	const archivePath = join(archiveRoot, runs[0]!, "run.json");
	const decoded = deserializeRunJournal(await readFile(archivePath, "utf8"), archivePath);
	return decoded.value;
}

async function start(root: string, dependencies: StewardDependencies): Promise<RunJournal> {
	await registered(dependencies)()("start", context(root));
	return load(root);
}

async function fileExists(path: string): Promise<boolean> {
	try { await access(path); return true; } catch { return false; }
}

async function writeBuilder(root: string, journal: RunJournal, taskIndex: number): Promise<void> {
	const task = journal.run.tasks[taskIndex];
	const attempt = task?.attempts.at(-1);
	if (!task || !attempt || attempt.role !== "builder" || await fileExists(attempt.reportPath) || !await fileExists(attempt.assignmentPath)) return;
	const assignment = JSON.parse(await readFile(attempt.assignmentPath, "utf8")) as { assignment: { actualModel: BuilderAttemptReport["actualModel"]; specificationHash: string; worktree: { path: string } } };
	const artifact = Buffer.from(`${task.contract.id}\n`, "utf8");
	const artifactPath = join(attempt.evidenceDirectory, "artifact.snapshot");
	const logPath = join(attempt.evidenceDirectory, "check.log");
	await writeFile(join(assignment.assignment.worktree.path, "src", `change-${taskIndex + 1}.ts`), artifact);
	await writeFile(artifactPath, artifact);
	await writeFile(logPath, "pass\n");
	const verification = task.contract.verification;
	const checks: BuilderAttemptReport["checks"] = verification.kind === "criteria"
		? [{ kind: "criteria", criteria: verification.criteria, result: "met", summary: "met", logId: "check-1" }]
		: [{ kind: "command", command: verification.command, exitCode: 0, summary: "pass", logId: "check-1" }];
	const report: BuilderAttemptReport = { schemaVersion: 1, identity: { runId: journal.run.id, taskId: task.contract.id, attemptId: attempt.id, role: "builder", specificationHash: assignment.assignment.specificationHash, assignmentSha256: builderAssignmentSha256(await readFile(attempt.assignmentPath, "utf8")) }, status: "completed", summary: "Builder completed.", blockers: [], producedArtifacts: [{ kind: "git-commit", baseRevision: attempt.baseRevision, headRevision, commits }, { kind: "file", path: `src/change-${taskIndex + 1}.ts`, evidencePath: artifactPath, size: artifact.length, sha256: sha(artifact) }], actualModel: assignment.assignment.actualModel, checks, logReferences: [{ id: "check-1", path: logPath, size: 5, sha256: sha(Buffer.from("pass\n")) }], producedRevision: headRevision };
	await writeFile(attempt.reportPath, serializeBuilderAttemptReport(report));
}

async function writeReviewer(journal: RunJournal, taskIndex: number): Promise<void> {
	const task = journal.run.tasks[taskIndex];
	const attempt = task?.attempts.at(-1);
	if (!task || !attempt || attempt.role !== "reviewer" || await fileExists(attempt.reportPath)) return;
	const assignmentBytes = await readFile(attempt.assignmentPath);
	const assignment = deserializeReviewerAssignment(assignmentBytes.toString("utf8"));
	if (!assignment.value) throw new Error("Reviewer assignment is invalid");
	const report: ReviewerAttemptReport = { schemaVersion: 1, identity: { runId: journal.run.id, taskId: task.contract.id, attemptId: attempt.id, role: "reviewer", specificationHash: attempt.specificationHash, assignmentSha256: sha(assignmentBytes) }, status: "completed", summary: "Approved.", blockers: [], actualModel: attempt.actualModel, reviewedSubject: assignment.value.assignment.subject, verdict: "approved", findings: [], checks: [], logReferences: [] };
	await writeFile(attempt.reportPath, serializeReviewerAttemptReport(report));
}

async function reachIntegrated(root: string, dependencies: StewardDependencies): Promise<RunJournal> {
	await start(root, dependencies);
	for (let pass = 0; pass < 36; pass += 1) {
		const journal = await load(root);
		for (let index = 0; index < journal.run.tasks.length; index += 1) {
			await writeBuilder(root, journal, index);
			await writeReviewer(journal, index);
		}
		const afterReports = await load(root);
		if (afterReports.run.tasks.every((task) => task.integration?.phase === "integrated")) return afterReports;
		await invoke(root, dependencies);
		const afterStatus = await load(root);
		if (afterStatus.run.tasks.length > 1 && afterStatus.run.tasks[0]?.integration?.phase === "integrated" && afterStatus.run.tasks.slice(1).some((task) => task.phase === "pending")) {
			await createSteward(dependencies).advanceNext(root, "controller-session", { interactive: true, maximumActions: 1, source: "resume" });
		}
	}
	throw new Error("fixture did not reach integrated state");
}

async function launch(root: string, dependencies: StewardDependencies): Promise<RunJournal> {
	await invoke(root, dependencies);
	return load(root);
}

async function runUntilActivePhase(root: string, dependencies: StewardDependencies, phases: readonly string[]): Promise<RunJournal> {
	// Managed commands can sleep for two seconds; use a wall-clock budget rather than
	// a loop count whose effective deadline varies with filesystem speed.
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const current = await loadCurrentOrArchive(root);
		if (!current) throw new Error("final-verification journal disappeared");
		if (current.run.finalVerificationExecution && phases.includes(current.run.finalVerificationExecution.phase)) return current;
		await delay(30);
		await invoke(root, dependencies);
	}
	throw new Error("fixture did not reach the requested final-verification phase");
}

async function runUntilAttemptCount(root: string, dependencies: StewardDependencies, count: number): Promise<RunJournal> {
	for (let pass = 0; pass < 80; pass += 1) {
		const current = await load(root);
		if (managedExecution(current)?.attempts.length === count) return current;
		await delay(30);
		await invoke(root, dependencies);
	}
	throw new Error(`fixture did not reach ${count} final-verification attempts`);
}

async function markerCount(path: string): Promise<number> {
	try { return (await readFile(path, "utf8")).length; } catch { return 0; }
}

function managedExecution(journal: RunJournal) {
	const execution = journal.run.finalVerificationExecution;
	return execution && isRecoverableFinalVerificationExecution(execution) ? execution : undefined;
}

describe("ticket-16 registered final-verification recovery", () => {
	it("waits on the exact live managed verification without Journal or process interference", async () => {
		const { root, marker, effects, dependencies } = await fixture("placeholder", 1);
		const configured = dependencies.ui.draftRun;
		dependencies.ui.draftRun = async (input) => { const drafted = await configured(input); if (drafted.kind !== "drafted") return drafted; return { kind: "drafted", draft: { ...drafted.draft, finalVerification: { kind: "command", command: `printf x >> ${shellQuote(marker)}; sleep 1; printf ok` } } }; };
		await reachIntegrated(root, dependencies);
		const launched = await launch(root, dependencies);
		expect(launched.run.finalVerificationExecution?.phase).toBe("executing");
		expect(managedExecution(launched)?.attempts[0]?.process).toBeDefined();
		const activePath = join(root, ".pi", "steward", "active-run.json");
		const before = await readFile(activePath);
		const waitResult = await (await import("../src/steward.ts")).createSteward(dependencies).waitForMonitorSignal(root, "controller-session", new AbortController().signal);
		const after = await readFile(activePath);
		expect(waitResult).toMatchObject({ kind: "settled", lifecycle: "done" });
		expect(after.equals(before)).toBe(true);
		expect(effects.merges).toBe(1);
		expect(effects.builderPrompts).toHaveLength(1);
		expect(await markerCount(marker)).toBe(1);
	}, 20_000);

	it("consumes a complete durable result without a second launch", async () => {
		const { root, marker, dependencies } = await fixture("placeholder", 1);
		const configured = dependencies.ui.draftRun;
		dependencies.ui.draftRun = async (input) => { const drafted = await configured(input); if (drafted.kind !== "drafted") return drafted; return { kind: "drafted", draft: { ...drafted.draft, finalVerification: { kind: "command", command: `printf x >> ${shellQuote(marker)}; printf pass` } } }; };
		await reachIntegrated(root, dependencies);
		await launch(root, dependencies);
		const terminal = await runUntilActivePhase(root, dependencies, ["passed"]);
		expect(await markerCount(marker)).toBe(1);
		expect(terminal.run.finalVerificationExecution?.phase).toBe("passed");
		expect(managedExecution(terminal)?.attempts).toHaveLength(1);
		expect(managedExecution(terminal)?.attempts[0]?.observation?.kind).toBe("complete");
	}, 20_000);

	it("records one deterministic recovery rerun for an inconclusive first attempt and never creates a third", async () => {
		const { root, marker, dependencies } = await fixture("placeholder", 1);
		const configured = dependencies.ui.draftRun;
		dependencies.ui.draftRun = async (input) => { const drafted = await configured(input); if (drafted.kind !== "drafted") return drafted; return { kind: "drafted", draft: { ...drafted.draft, finalVerification: { kind: "command", command: `printf x >> ${shellQuote(marker)}; sleep 2; printf recovered` } } }; };
		const realProcess = dependencies.process;
		dependencies.process = { ...realProcess, async inspectApprovedVerification(input) { if (input.attemptId === "verification-01") return "exited"; return realProcess.inspectApprovedVerification!(input); } };
		await reachIntegrated(root, dependencies);
		await launch(root, dependencies);
		const reserved = await runUntilAttemptCount(root, dependencies, 2);
		expect(managedExecution(reserved)?.attempts).toHaveLength(2);
		expect(managedExecution(reserved)?.attempts.map((attempt) => attempt.id)).toEqual(["verification-01", "verification-02"]);
		const recovered = await runUntilActivePhase(root, dependencies, ["passed"]);
		expect(managedExecution(recovered)?.attempts).toHaveLength(2);
		expect(await markerCount(marker)).toBe(2);
		await delay(2_200);
		expect(await markerCount(marker)).toBe(2);
	}, 20_000);

	it("routes a clear single-Task failure to the same Builder for a fresh Review", async () => {
		const { root, marker, effects, dependencies } = await fixture("placeholder", 1);
		const configured = dependencies.ui.draftRun;
		dependencies.ui.draftRun = async (input) => { const drafted = await configured(input); if (drafted.kind !== "drafted") return drafted; return { kind: "drafted", draft: { ...drafted.draft, finalVerification: { kind: "command", command: `printf x >> ${shellQuote(marker)}; exit 7` } } }; };
		const integrated = await reachIntegrated(root, dependencies);
		const originalBuilder = integrated.run.tasks[0]!.attempts.find((attempt) => attempt.role === "builder");
		expect(originalBuilder).toBeDefined();
		await launch(root, dependencies);
		const failed = await runUntilActivePhase(root, dependencies, ["failed"]);
		expect(await markerCount(marker)).toBe(1);
		await invoke(root, dependencies);
		const reworked = await load(root);
		const task = reworked.run.tasks[0]!;
		expect(task.finalVerificationReworks).toHaveLength(1);
		expect(task.approval?.phase).toBe("invalidated");
		expect(task.approval && "reason" in task.approval ? task.approval.reason : undefined).toBe("final-verification-failed");
		expect(task.integration).toBeUndefined();
		expect(task.phase).toBe("reworking");
		expect(task.attempts.at(-1)?.role).toBe("builder");
		expect(task.attempts.at(-1)?.dispatch).toMatchObject({ agentName: originalBuilder && "dispatch" in originalBuilder ? originalBuilder.dispatch.agentName : "" });
		expect(task.attempts.at(-1)?.dispatch).toMatchObject({ verificationRework: { priorIntegration: { observedHead: headRevision } } });
		expect(effects.builderPrompts).toHaveLength(2);
		expect(managedExecution(failed)?.attempts[0]?.observation?.kind).toBe("complete");
	}, 20_000);

	it("preserves every integrated Task and records needs-user when multi-Task failure ownership is unclear", async () => {
		const { root, marker, dependencies } = await fixture("placeholder", 2);
		const configured = dependencies.ui.draftRun;
		dependencies.ui.draftRun = async (input) => { const drafted = await configured(input); if (drafted.kind !== "drafted") return drafted; return { kind: "drafted", draft: { ...drafted.draft, finalVerification: { kind: "command", command: `printf x >> ${shellQuote(marker)}; exit 9` } } }; };
		await reachIntegrated(root, dependencies);
		await launch(root, dependencies);
		await runUntilActivePhase(root, dependencies, ["failed"]);
		await invoke(root, dependencies);
		const preserved = await load(root);
		expect(preserved.run.finalVerificationExecution?.phase).toBe("failed");
		expect(preserved.run.tasks).toHaveLength(2);
		for (const task of preserved.run.tasks) {
			expect(task.integration?.phase).toBe("integrated");
			expect(task.approval?.phase).toBe("valid");
			expect(task.attention).toBe("needs-user");
			expect(task.attentionReason).toBe("final-verification-ownership-unclear");
		}
		expect(await markerCount(marker)).toBe(1);
	}, 20_000);

	it("preserves tracked and untracked verification dirt and blocks without rerun", async () => {
		const { root, marker, dependencies } = await fixture("placeholder", 1);
		const configured = dependencies.ui.draftRun;
		dependencies.ui.draftRun = async (input) => { const drafted = await configured(input); if (drafted.kind !== "drafted") return drafted; return { kind: "drafted", draft: { ...drafted.draft, finalVerification: { kind: "command", command: `printf x >> ${shellQuote(marker)}; printf changed > ${shellQuote(join(root, "README.md"))}; printf dirt > ${shellQuote(join(root, "verification-created.txt"))}` } } }; };
		await reachIntegrated(root, dependencies);
		await launch(root, dependencies);
		const ambiguous = await runUntilActivePhase(root, dependencies, ["ambiguous"]);
		expect(await markerCount(marker)).toBe(1);
		expect(await readFile(join(root, "README.md"), "utf8")).toBe("changed");
		expect(await readFile(join(root, "verification-created.txt"), "utf8")).toBe("dirt");
		expect(ambiguous.run.tasks[0]?.attention).toBe("needs-user");
		expect(ambiguous.run.tasks[0]?.attentionReason).toBe("verification-dirtied-checkout");
		expect(managedExecution(ambiguous)?.attempts).toHaveLength(1);
	}, 20_000);
});
