import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { afterEach, it, vi } from "vitest";

import { createRunJournalAdapter } from "../src/adapters.ts";
import { registerStewardExtension, type StewardCommandContext, type StewardCommandHandler, type StewardRegistrationSurface } from "../src/extension.ts";
import { deserializeBuilderAssignment, builderAssignmentSha256, type RunDraft, type RunJournal } from "../src/run.ts";
import type { ProjectModelPlans, RecoveryDefaults } from "../src/config.ts";
import type { StewardDependencies, StewardUiAdapter } from "../src/steward.ts";

const roots: string[] = [];
vi.setConfig({ testTimeout: 60000 });
const baseRevision = "0123456789abcdef0123456789abcdef01234567";
const modelPlans: ProjectModelPlans = {
	builder: { primary: { model: "builder/primary", thinkingLevel: "high" }, fallbacks: [{ model: "builder/fallback", thinkingLevel: "medium" }] },
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
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-dispatch-"));
	roots.push(root);
	return root;
}

function draft(): RunDraft {
	return {
		declaredOutcome: "Build the approved change",
		tasks: [
			{ requiredOutcome: "Implement the approved Builder change", allowedScope: ["src/change.ts"], expectedArtifacts: [{ kind: "git-commit" }, { kind: "file", path: "reports/attempt.md" }], verification: { kind: "command", command: "npm test" }, reviewRequired: true },
			{ requiredOutcome: "Keep the evidence record", allowedScope: ["reports/attempt.md"], expectedArtifacts: [{ kind: "evidence", description: "Attempt evidence" }], verification: { kind: "criteria", criteria: "The Builder report exists" }, reviewRequired: true },
		],
		modelPlan: modelPlans,
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
		sessionManager: { getSessionId: () => "dispatch-controller" } as StewardCommandContext["sessionManager"],
		ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined, notify() {}, setStatus() {} },
	};
}

function ui(result: { value?: import("../src/steward.ts").StartResult }): StewardUiAdapter {
	return {
		presentStatus() {},
		async editConfiguration() { return { kind: "cancelled" }; },
		presentConfigurationResult() {},
		async draftRun() { return { kind: "drafted" as const, draft: draft() }; },
		async confirmRun() { return true; },
		presentStartResult(value) { result.value = value; },
	};
}

function capture(): { surface: StewardRegistrationSurface; getHandler(): StewardCommandHandler } {
	let handler: StewardCommandHandler | undefined;
	return {
		surface: { on() {}, registerCommand(_name, options) { handler = options.handler; } },
		getHandler() { if (!handler) throw new Error("missing steward handler"); return handler; },
	};
}

function dependencies(root: string, hooks: { onCreate?: (journal: RunJournal) => Promise<void>; onStart?: (journal: RunJournal) => Promise<void>; onPrompt?: (journal: RunJournal, assignment: string) => Promise<void>; collision?: boolean } = {}): StewardDependencies {
	const journal = createRunJournalAdapter();
	let uuid = 0;
	let collisionReturned = false;
	return {
		runJournal: journal,
		herdr: {
			async checkAvailability() { return { kind: "available", status: "running", running: true, compatible: true, endpointCompatible: true }; },
			async createBuilderWorktree() {
				const active = await journal.loadActive(root);
				if (active.kind !== "loaded") throw new Error("journal not durable before worktree create");
				await hooks.onCreate?.(active.journal);
				return { kind: "created", branch: active.journal.run.tasks[0]!.attempts[0]!.dispatch.branch, path: join(root, "builder-worktree"), workspaceId: "workspace-1", tabId: "tab-1", paneId: "pane-1", terminalId: "terminal-1" };
			},
			async startBuilder() {
				const active = await journal.loadActive(root);
				if (active.kind !== "loaded") throw new Error("journal not durable before agent start");
				await hooks.onStart?.(active.journal);
				if (hooks.collision && !collisionReturned) {
					collisionReturned = true;
					return { kind: "name-collision", code: "agent_name_taken", message: "already exists" };
				}
				return { kind: "started", name: active.journal.run.tasks[0]!.attempts[0]!.dispatch.agentName, agentKind: "pi", workspaceId: "workspace-1", tabId: "tab-1", paneId: "pane-1", terminalId: "terminal-1" };
			},
			async promptBuilder(input) {
				const active = await journal.loadActive(root);
				if (active.kind !== "loaded") throw new Error("journal not durable before prompt");
				const assignmentPath = active.journal.run.tasks[0]!.attempts[0]!.assignmentPath;
				const bytes = await readFile(assignmentPath, "utf8");
				await hooks.onPrompt?.(active.journal, bytes);
				return { kind: "prompted", name: input.name, workspaceId: "workspace-1", tabId: "tab-1", paneId: "pane-1", terminalId: "terminal-1" };
			},
		},
		git: {
			async inspectIntegrationBase() { return { kind: "ready", branch: "main", revision: baseRevision }; },
			async branchExists() { return false; },
			async inspectBuilderWorktree(_path, expectedRevision) { return { kind: "ready", head: expectedRevision, clean: true }; },
		},
		process: {},
		model: { listModelChoices: () => [], async validateModelPlans() { return []; } },
		clock: { now: () => new Date("2026-09-17T18:00:00.000Z"), randomUUID: () => `0000000${++uuid}-89ab-cdef-0123-456789abcdef` },
		ui: ui({}),
	};
}

it.sequential("registered start persists each durable phase before the next Builder effect", async () => {
	const root = await makeRoot();
	const observed: { value?: import("../src/steward.ts").StartResult } = {};
	const deps = dependencies(root, {
		onCreate: async (journal) => {
			const task = journal.run.tasks[0]!;
			deepStrictEqual([task.phase, task.attempts[0]!.state, task.attempts[0]!.dispatch.phase], ["building", "prepared", "worktree-intended"]);
			equal(existsSync(task.attempts[0]!.assignmentPath), false);
		},
		onStart: async (journal) => equal(journal.run.tasks[0]!.attempts[0]!.dispatch.phase, "agent-intended"),
		onPrompt: async (journal, bytes) => {
			equal(journal.run.tasks[0]!.attempts[0]!.dispatch.phase, "prompt-intended");
			const decoded = deserializeBuilderAssignment(bytes);
			ok(decoded.value);
			equal(await stat(journal.run.tasks[0]!.attempts[0]!.assignmentPath).then((value) => value.mode & 0o777), 0o600);
			equal(journal.run.tasks[0]!.attempts[0]!.dispatch.assignmentSha256, builderAssignmentSha256(bytes));
		},
	});
	deps.ui = ui(observed);
	const registered = capture();
	registerStewardExtension(registered.surface, () => deps);
	await registered.getHandler()("start", context(root));
	ok(observed.value?.kind === "started-and-dispatched");
	const loaded = await deps.runJournal.loadActive(root);
	if (loaded.kind !== "loaded") throw new Error("active journal missing");
	const [builder, untouched] = loaded.journal.run.tasks;
	equal(builder?.phase, "building");
	equal(builder?.attempts.length, 1);
	equal(builder?.attempts[0]?.state, "active");
	equal(builder?.attempts[0]?.dispatch.phase, "prompted");
	equal(untouched?.phase, "pending");
	equal(untouched?.attempts.length, 0);
	match(observed.value && "message" in observed.value ? observed.value.message : "", /dispatched Builder Attempt/);
});

it.sequential("retrying start refuses the active Run and reuses one Assignment", async () => {
	const root = await makeRoot();
	const first: { value?: import("../src/steward.ts").StartResult } = {};
	const deps = dependencies(root);
	deps.ui = ui(first);
	const registered = capture();
	registerStewardExtension(registered.surface, () => deps);
	await registered.getHandler()("start", context(root));
	const active = await deps.runJournal.loadActive(root);
	if (active.kind !== "loaded") throw new Error("active journal missing");
	const assignmentPath = active.journal.run.tasks[0]!.attempts[0]!.assignmentPath;
	const bytes = await readFile(assignmentPath, "utf8");
	const second: { value?: import("../src/steward.ts").StartResult } = {};
	deps.ui = ui(second);
	await registered.getHandler()("start", context(root));
	ok(second.value?.kind === "refused");
	equal(await readFile(assignmentPath, "utf8"), bytes);
	const after = await deps.runJournal.loadActive(root);
	if (after.kind !== "loaded") throw new Error("active journal missing after retry");
	equal(after.journal.run.tasks[0]!.attempts.length, 1);
	match(second.value && "message" in second.value ? second.value.message : "", /active Steward Run/);
});

it.sequential("name collision changes only the intended name inside attempt-01", async () => {
	const root = await makeRoot();
	const observed: { value?: import("../src/steward.ts").StartResult } = {};
	const deps = dependencies(root, { collision: true });
	deps.ui = ui(observed);
	const registered = capture();
	registerStewardExtension(registered.surface, () => deps);
	await registered.getHandler()("start", context(root));
	ok(observed.value?.kind === "started-and-dispatched");
	const loaded = await deps.runJournal.loadActive(root);
	if (loaded.kind !== "loaded") throw new Error("active journal missing");
	const attempt = loaded.journal.run.tasks[0]!.attempts[0]!;
	equal(attempt.id, "attempt-01");
	equal(attempt.state, "active");
	ok(attempt.dispatch.agentName.endsWith("-01"));
	equal((await readFile(attempt.assignmentPath, "utf8")).includes(attempt.dispatch.agentName), true);
});

it.sequential("dispatch failures preserve the last durable phase and never overstate success", async () => {
	const cases = [
		{ name: "worktree", phase: "worktree-intended" as const, configure(deps: StewardDependencies) {
			deps.herdr.createBuilderWorktree = async () => ({ kind: "failed", stage: "worktree-create", code: "create-failed", message: "create failed" });
		} },
		{ name: "base", phase: "worktree-intended" as const, configure(deps: StewardDependencies) {
			deps.git.inspectBuilderWorktree = async () => ({ kind: "unavailable", message: "base mismatch" });
		} },
		{ name: "agent", phase: "agent-intended" as const, configure(deps: StewardDependencies) {
			deps.herdr.startBuilder = async () => ({ kind: "failed", stage: "agent-start", code: "pane-busy", message: "pane busy" });
		} },
		{ name: "assignment", phase: "agent-intended" as const, configure(deps: StewardDependencies) {
			deps.runJournal.createAssignment = async (repositoryRoot, document) => {
				const paths = deps.runJournal.resolveAssignmentPaths(repositoryRoot, document.assignment.runId, document.assignment.taskId, document.assignment.attemptId);
				return { kind: "conflict", paths, diagnostics: [{ code: "invalid-task", message: "Assignment conflict", path: paths.assignmentPath }] };
			};
		} },
		{ name: "prompt", phase: "prompt-intended" as const, configure(deps: StewardDependencies) {
			deps.herdr.promptBuilder = async () => ({ kind: "failed", stage: "agent-prompt", code: "prompt-failed", message: "prompt failed" });
		} },
		{ name: "active-write", phase: "prompt-intended" as const, configure(deps: StewardDependencies) {
			const production = deps.runJournal;
			let replacements = 0;
			deps.runJournal = {
				...production,
				async replaceActive(repositoryRoot, journal) {
					replacements += 1;
					if (replacements === 4) {
						const current = await production.loadActive(repositoryRoot);
						if (current.kind !== "loaded") throw new Error("active Journal disappeared during final-write test");
						return { kind: "storage-error", paths: current.paths, diagnostics: [] };
					}
					return production.replaceActive(repositoryRoot, journal);
				},
			};
		} },
	] as const;

	for (const failure of cases) {
		const root = await makeRoot();
		const observed: { value?: import("../src/steward.ts").StartResult } = {};
		const deps = dependencies(root);
		failure.configure(deps);
		deps.ui = ui(observed);
		const registered = capture();
		registerStewardExtension(registered.surface, () => deps);
		await registered.getHandler()("start", context(root));
		ok(observed.value?.kind === "started-dispatch-pending");
		const active = await deps.runJournal.loadActive(root);
		if (active.kind !== "loaded") throw new Error(`missing active Journal after ${failure.name} failure`);
		const attempt = active.journal.run.tasks[0]?.attempts[0];
		if (!attempt) throw new Error(`missing Attempt after ${failure.name} failure`);
		equal(active.journal.run.tasks[0]?.phase, "building");
		equal(attempt.state, "prepared");
		equal(attempt.dispatch.phase, failure.phase);
		if (failure.name === "active-write") {
			const second: { value?: import("../src/steward.ts").StartResult } = {};
			deps.ui = ui(second);
			await registered.getHandler()("start", context(root));
			ok(second.value?.kind === "refused");
		}
	}
});

it.sequential("registered status projects the validated journal without live-state access", async () => {
	const root = await makeRoot();
	const observed: { value?: import("../src/steward.ts").StartResult; status?: import("../src/steward.ts").StatusView } = {};
	const deps = dependencies(root);
	deps.ui = { ...ui(observed), presentStatus(value) { observed.status = value; } };
	const registered = capture();
	registerStewardExtension(registered.surface, () => deps);
	await registered.getHandler()("start", context(root));
	const failures = new Proxy({}, { get() { throw new Error("live adapter access during status"); } });
	deps.herdr = failures as never;
	deps.git = failures as never;
	deps.process = failures as never;
	deps.model = failures as never;
	deps.clock = failures as never;
	await registered.getHandler()("status", context(root));
	ok(observed.status?.kind === "present");
	if (!observed.status || observed.status.kind !== "present") return;
	match(observed.status.markdown, /Completion: not inferred from Herdr activity; awaiting a validated Attempt Report\./);
	match(observed.status.markdown, /Assignment: .*sha256:[0-9a-f]{64}/);
	match(observed.status.footer.text, /building · 0 attention/);
});
