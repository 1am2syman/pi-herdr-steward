import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { afterEach, it } from "vitest";

import {
	registerStewardExtension,
	type StewardCommandContext,
	type StewardCommandHandler,
	type StewardRegistrationSurface,
} from "../src/extension.ts";
import type { CompactionResult } from "@earendil-works/pi-coding-agent";
import { createRunJournalAdapter } from "../src/adapters.ts";
import { resolveRunJournalPaths } from "../src/run-journal-store.ts";
import { advanceRunJournal, buildInitialRunJournal, type BuilderAttemptRecord, type RunDraft, type RunJournal } from "../src/run.ts";
import type { ProjectModelPlans, RecoveryDefaults } from "../src/config.ts";
import type { StewardDependencies } from "../src/steward.ts";

const roots: string[] = [];
const createdAt = "2026-09-20T00:00:00.000Z";
const base = "0123456789abcdef0123456789abcdef01234567";
const models: ProjectModelPlans = {
	builder: { primary: { model: "builder/primary", thinkingLevel: "high" }, fallbacks: [] },
	reviewer: { primary: { model: "reviewer/primary", thinkingLevel: "high" }, fallbacks: [] },
};
const settings: RecoveryDefaults = {
	passiveInspectionIntervalSeconds: 301,
	secondInspectionAndNudgeIntervalSeconds: 302,
	nudgeGracePeriodSeconds: 121,
	externalCommandWarningThresholdSeconds: 1_801,
	maximumActiveTasks: 1,
	transientRetryLimit: 1,
	reworkCycleLimit: 2,
};

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function draft(): RunDraft {
	return {
		declaredOutcome: "Exercise one Controller owner",
		tasks: [{ requiredOutcome: "Keep the pending Task durable", allowedScope: ["src"], expectedArtifacts: [{ kind: "git-commit" }], verification: { kind: "command", command: "true" }, reviewRequired: false }],
		modelPlan: models,
		effectiveSettings: settings,
		finalVerification: { kind: "command", command: "true" },
	};
}

function context(root: string, sessionId: string, uiOverride: Partial<StewardCommandContext["ui"]> = {}): StewardCommandContext {
	return {
		mode: "tui",
		hasUI: true,
		cwd: root,
		modelRegistry: {} as StewardCommandContext["modelRegistry"],
		model: undefined,
		thinkingLevel: undefined,
		scopedModels: [],
		sessionManager: { getSessionId: () => sessionId } as StewardCommandContext["sessionManager"],
		ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined, notify() {}, setStatus() {}, ...uiOverride },
	};
}

type AnyHandler = (event: any, ctx: any) => Promise<any> | any;
type OwnershipCalls = { herdr: number; git: number; process: number; model: number; replace: number; activity: number; order: string[] };

function capture(): { surface: StewardRegistrationSurface; command: () => StewardCommandHandler; event: (name: string) => AnyHandler; commandCount: () => number } {
	let command: StewardCommandHandler | undefined;
	let commands = 0;
	const handlers = new Map<string, AnyHandler>();
	const surface = {
		on(name: string, handler: AnyHandler) { handlers.set(name, handler); },
		registerCommand(_name: "steward", options: { handler: StewardCommandHandler }) { commands += 1; command = options.handler; },
	} as unknown as StewardRegistrationSurface;
	return {
		surface,
		command() { if (!command) throw new Error("missing registered Steward command"); return command; },
		event(name) { const handler = handlers.get(name); if (!handler) throw new Error(`missing ${name} event`); return handler; },
		commandCount() { return commands; },
	};
}

function dependencies(root: string): { deps: StewardDependencies; calls: OwnershipCalls } {
	const store = createRunJournalAdapter();
	const calls: OwnershipCalls = { herdr: 0, git: 0, process: 0, model: 0, replace: 0, activity: 0, order: [] };
	const originalReplace = store.replaceActive.bind(store);
	store.replaceActive = async (...args) => { calls.replace += 1; calls.order.push("replace"); return originalReplace(...args); };
	const originalActivity = store.appendActivity.bind(store);
	store.appendActivity = async (...args) => { calls.activity += 1; calls.order.push("activity"); return originalActivity(...args); };
	const ui = {
		presentStatus() {},
		async editConfiguration() { return { kind: "cancelled" as const }; },
		presentConfigurationResult() {},
		async draftRun() { return { kind: "cancelled" as const }; },
		async confirmRun() { return false; },
		presentStartResult() {},
		presentResumeResult() {},
	};
	return {
		calls,
		deps: {
			runJournal: store,
			herdr: {
				async checkAvailability() { calls.herdr += 1; return { kind: "available", status: "running", running: true, compatible: true, endpointCompatible: true }; },
			},
			git: {
				async inspectIntegrationBase() { calls.git += 1; return { kind: "ready", branch: "main", revision: base }; },
			},
			process: {},
			model: { listModelChoices: () => [], async validateModelPlans() { calls.model += 1; return []; }, async inspectModelChoice(choice) { return { choice, available: true, diagnostics: [] }; } },
			clock: { now: () => new Date("2026-09-20T00:00:00.100Z"), randomUUID: () => "01234567-89ab-cdef-0123-456789abcdef" },
			ui,
		},
	};
}

async function seed(root: string, controllerSessionId: string): Promise<RunJournal> {
		const store = createRunJournalAdapter();
	const journal = buildInitialRunJournal({ identity: { runId: "run-20260920T000000000Z-owner", createdAt }, controllerSessionId, draft: draft(), modelPlan: models, effectiveSettings: settings, integrationBase: { kind: "git", branch: "main", revision: base } });
		const created = await store.createActive(root, journal);
		equal(created.kind, "created");
		return journal;
}

async function seedPromptedAttempt(root: string, journal: RunJournal): Promise<RunJournal> {
	const store = createRunJournalAdapter();
	const task = journal.run.tasks[0]!;
	const paths = store.resolveAssignmentPaths(root, journal.run.id, task.contract.id, "attempt-01");
	const timestamp = "2026-09-20T00:00:00.001Z";
	const attempt: BuilderAttemptRecord = {
		id: "attempt-01",
		role: "builder",
		state: "active",
		preparedAt: timestamp,
		activatedAt: timestamp,
		actualModel: { model: "builder/primary", thinkingLevel: "high" },
		specificationHash: task.specificationHash,
		baseRevision: base,
		assignmentPath: paths.assignmentPath,
		reportPath: paths.reportPath,
		evidenceDirectory: paths.evidenceDirectory,
		dispatch: { phase: "prompted", branch: "steward/task-01", worktreePath: join(root, "builder-worktree"), agentName: "steward-b-abcdef12-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1", assignmentSha256: `sha256:${"a".repeat(64)}`, promptedAt: timestamp },
	};
	const candidate = advanceRunJournal(journal, new Date(timestamp), (next) => {
		const nextTask = next.run.tasks[0]!;
		nextTask.phase = "building";
		nextTask.attempts = [attempt];
	});
	const replaced = await store.replaceActive(root, candidate);
	if (replaced.kind !== "replaced") throw new Error("prompted ownership fixture was not persisted");
	return replaced.journal;
}

async function bytes(root: string, journal: RunJournal): Promise<{ active: string; previous: string; activity: string }> {
		const paths = resolveRunJournalPaths(root);
		const read = async (path: string): Promise<string> => await readFile(path, "utf8").catch(() => "<missing>");
		return { active: await read(paths.activePath), previous: await read(paths.previousPath), activity: await read(join(paths.activityRoot, journal.run.id, "activity.log")) };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let index = 0; index < 2_000; index += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("registered lifecycle checkpoint did not settle");
}

async function loadJournal(store: StewardDependencies["runJournal"], root: string): Promise<RunJournal> {
	const loaded = await store.loadActive(root);
	if (loaded.kind !== "loaded") throw new Error(`Expected an active Journal, got ${loaded.kind}.`);
	return loaded.journal;
}

async function mutateActiveJournal(root: string, update: (journal: RunJournal) => void): Promise<RunJournal> {
	const store = createRunJournalAdapter();
	const current = await loadJournal(store, root);
	const candidate = advanceRunJournal(current, new Date("2026-09-20T00:00:00.010Z"), update);
	const replaced = await store.replaceActive(root, candidate);
	if (replaced.kind !== "replaced") throw new Error(`Race fixture could not replace the active Journal: ${replaced.kind}.`);
	return replaced.journal;
}

async function activityEvents(root: string): Promise<string[]> {
	const paths = resolveRunJournalPaths(root);
	const activityPath = join(paths.activityRoot, "run-20260920T000000000Z-owner", "activity.log");
	const content = await readFile(activityPath, "utf8").catch(() => "");
	return content.trim().length === 0 ? [] : content.trimEnd().split("\n").map((line) => (JSON.parse(line) as { event: string }).event);
}

it.sequential("registered foreign status and plain resume remain read-only before explicit takeover", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-ownership-functional-"));
	roots.push(root);
	const seeded = await seed(root, "controller-a");
	const { deps, calls } = dependencies(root);
	const registered = capture();
	const statuses: string[] = [];
	const resumes: string[] = [];
	const ui = deps.ui;
	deps.ui = { ...ui, presentStatus(value) { if (value.kind === "present") statuses.push(value.markdown); }, presentResumeResult(value) { resumes.push(value.kind === "reconciled" ? "reconciled" : value.message); } };
	registerStewardExtension(registered.surface, () => deps);
	const a = context(root, "controller-a");
	const b = context(root, "controller-b");
	await registered.event("session_start")({ type: "session_start", reason: "startup" }, a);
	await registered.event("session_start")({ type: "session_start", reason: "new" }, b);
	const before = await bytes(root, seeded);
	await registered.command()("status", b);
	await registered.command()("resume", b);
	const after = await bytes(root, seeded);
	deepStrictEqual(after, before);
	ok(statuses.at(-1)?.includes("controller-b") && statuses.at(-1)?.includes("resume --takeover"), JSON.stringify(statuses));
	ok(resumes.at(-1)?.includes("resume --takeover"), JSON.stringify(resumes));
	equal(calls.herdr, 0);
	equal(calls.git, 0);
	equal(calls.process, 0);
	equal(calls.model, 0);
	equal(calls.replace, 0);
	equal(calls.activity, 0);
	await registered.event("session_shutdown")({ type: "session_shutdown", reason: "quit" }, b);
});

it.sequential("registered takeover reconciles before one CAS, records the lease, and activates only the winner", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-ownership-takeover-"));
	roots.push(root);
	const seeded = await seed(root, "controller-a");
	await seedPromptedAttempt(root, seeded);
	const { deps, calls } = dependencies(root);
	const report = deps.runJournal.inspectAttemptReport!;
	const assignment = deps.runJournal.inspectAttemptAssignment!;
	const preservation = deps.runJournal.inspectAttemptPreservation!;
	deps.runJournal.inspectAttemptReport = async (...args) => { calls.order.push("report"); return report(...args); };
	deps.runJournal.inspectAttemptAssignment = async (...args) => { calls.order.push("assignment"); return assignment(...args); };
	deps.runJournal.inspectAttemptPreservation = async (...args) => { calls.order.push("preservation"); return preservation(...args); };
	deps.herdr.inspectManagedAgent = async (identity) => { calls.herdr += 1; calls.order.push("herdr"); return { kind: "observed", identity, lifecycle: "working", stateChangeSequence: 1 }; };
	deps.git.inspectManagedWorktreeProgress = async () => { calls.git += 1; calls.order.push("git"); return { kind: "unavailable", diagnostic: "test worktree is not present" }; };
	const registered = capture();
	registerStewardExtension(registered.surface, () => deps);
	const b = context(root, "controller-b");
	const before = await bytes(root, seeded);
	await registered.command()("resume --takeover", b);
	const loaded = await deps.runJournal.loadActive(root);
	ok(loaded.kind === "loaded");
	if (loaded.kind !== "loaded") return;
	equal(loaded.journal.run.controllerSessionId, "controller-b");
	equal(loaded.journal.journalRevision, 3);
	ok(loaded.journal.run.controllerLease?.takeover);
	equal(loaded.journal.run.controllerLease?.takeover?.basisJournalRevision, 2);
	equal(loaded.journal.run.controllerLease?.takeover?.pendingAction.kind, "reconcile-attempt");
	equal(loaded.journal.run.controllerLease?.takeover?.pendingAction.attemptId, "attempt-01");
	deepStrictEqual(calls.order.slice(0, -2), ["report", "herdr", "git", "assignment", "preservation"]);
	equal(calls.replace, 1);
	equal(calls.activity, 1);
	equal(calls.order.at(-2), "replace");
	equal(calls.order.at(-1), "activity");
	equal(calls.process, 0);
	equal(calls.model, 0);
	const after = await bytes(root, seeded);
	ok(after.active !== before.active);
	ok(after.previous !== before.previous);
});

it.sequential.each([
	"invalid journal",
	"owner changed during inspection",
	"revision changed during inspection",
	"lease changed during inspection",
	"rejected CAS",
	"byte-race replaceActive",
	"activity append failure after a winning CAS",
] as const)("registered takeover refuses %s without a false success or workflow effect", async (caseName) => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-ownership-stale-"));
	roots.push(root);
	const seeded = await seed(root, "controller-a");
	const { deps, calls } = dependencies(root);
	let result: import("../src/steward.ts").ResumeResult | undefined;
	deps.ui = { ...deps.ui, presentResumeResult(value) { result = value; } };
	const registered = capture();
	registerStewardExtension(registered.surface, () => deps);
	const b = context(root, "controller-b");

	if (caseName === "invalid journal") {
		await writeFile(resolveRunJournalPaths(root).activePath, "{ invalid journal\n", "utf8");
		await registered.command()("resume --takeover", b);
		equal(result?.kind, "invalid");
		equal(calls.replace, 0);
		equal(calls.activity, 0);
		equal(calls.herdr + calls.git + calls.process + calls.model, 0);
		return;
	}

	await seedPromptedAttempt(root, seeded);
	if (caseName === "rejected CAS") {
		deps.runJournal.replaceActive = async () => ({ kind: "invalid-current", paths: resolveRunJournalPaths(root), diagnostics: [] });
	} else if (caseName === "byte-race replaceActive") {
		const replace = deps.runJournal.replaceActive;
		let raced = false;
		deps.runJournal.replaceActive = async (...args) => {
			if (!raced) {
				raced = true;
				await mutateActiveJournal(root, (next) => { next.run.declaredOutcome = "CAS byte race"; });
			}
			return replace(...args);
		};
	} else if (caseName === "activity append failure after a winning CAS") {
		deps.runJournal.appendActivity = async () => {
			calls.activity += 1;
			calls.order.push("activity");
			return { kind: "storage-error", path: join(resolveRunJournalPaths(root).activityRoot, seeded.run.id, "activity.log"), diagnostics: [] };
		};
	} else {
		const report = deps.runJournal.inspectAttemptReport!;
		let changed = false;
		deps.runJournal.inspectAttemptReport = async (...args) => {
			const observed = await report(...args);
			if (!changed) {
				changed = true;
				await mutateActiveJournal(root, (next) => {
					if (caseName === "owner changed during inspection") {
						next.run.controllerSessionId = "controller-z";
						if (next.run.controllerLease) next.run.controllerLease = { ...next.run.controllerLease, sessionId: "controller-z", leaseId: "lease-controller-z" };
					} else if (caseName === "revision changed during inspection") {
						next.run.declaredOutcome = "revision changed during inspection";
					} else if (caseName === "lease changed during inspection" && next.run.controllerLease) {
						next.run.controllerLease = { ...next.run.controllerLease, leaseId: "lease-controller-a-changed" };
					}
				});
			}
			return observed;
		};
	}

	await registered.command()("resume --takeover", b);
	if (caseName === "activity append failure after a winning CAS") {
		equal(result?.kind, "taken-over");
		if (result?.kind === "taken-over") ok(result.message.includes("Activity logging is degraded"));
		const after = await loadJournal(deps.runJournal, root);
		equal(after.run.controllerSessionId, "controller-b");
		equal(after.journalRevision, 3);
		equal(calls.replace, 1);
		equal(calls.activity, 1);
		equal((await activityEvents(root)).filter((event) => event === "controller-taken-over").length, 0);
	} else if (caseName === "rejected CAS") {
		equal(result?.kind, "stale");
		const after = await loadJournal(deps.runJournal, root);
		equal(after.run.controllerSessionId, "controller-a");
		equal(after.journalRevision, 2);
		equal(calls.replace, 0);
		equal(calls.activity, 0);
	} else if (caseName === "byte-race replaceActive") {
		equal(result?.kind, "stale");
		const after = await loadJournal(deps.runJournal, root);
		equal(after.run.controllerSessionId, "controller-a");
		equal(after.journalRevision, 3);
		equal(calls.replace, 1);
		equal(calls.activity, 0);
	} else {
		equal(result?.kind, "stale");
		const after = await loadJournal(deps.runJournal, root);
		equal(after.run.controllerSessionId, caseName === "owner changed during inspection" ? "controller-z" : "controller-a");
		equal(after.journalRevision, 3);
		equal(calls.replace, 0);
		equal(calls.activity, 0);
	}
	equal(calls.herdr + calls.git + calls.process + calls.model, 0);
});

it.sequential("registered stale old-owner pass loses after takeover without a post-CAS effect", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-ownership-old-owner-"));
	roots.push(root);
	const seeded = await seed(root, "controller-a");
	await seedPromptedAttempt(root, seeded);
	const ownerA = dependencies(root);
	const contenderB = dependencies(root);
	let oldOwnerResult: import("../src/steward.ts").ResumeResult | undefined;
	let contenderResult: import("../src/steward.ts").ResumeResult | undefined;
	ownerA.deps.ui = { ...ownerA.deps.ui, presentResumeResult(value) { oldOwnerResult = value; } };
	contenderB.deps.ui = { ...contenderB.deps.ui, presentResumeResult(value) { contenderResult = value; } };
	let releaseOldOwner!: () => void;
	let reportOldOwnerReached!: () => void;
	const oldOwnerReached = new Promise<void>((resolve) => { reportOldOwnerReached = resolve; });
	const oldOwnerRelease = new Promise<void>((resolve) => { releaseOldOwner = resolve; });
	const originalReplace = ownerA.deps.runJournal.replaceActive;
	let paused = false;
	ownerA.deps.runJournal.replaceActive = async (...args) => {
		if (!paused) {
			paused = true;
			reportOldOwnerReached();
			await oldOwnerRelease;
		}
		return originalReplace(...args);
	};
	const registeredA = capture();
	const registeredB = capture();
	registerStewardExtension(registeredA.surface, () => ownerA.deps);
	registerStewardExtension(registeredB.surface, () => contenderB.deps);
	const oldOwnerPass = registeredA.command()("resume", context(root, "controller-a"));
	await oldOwnerReached;
	await registeredB.command()("resume --takeover", context(root, "controller-b"));
	equal(contenderResult?.kind, "taken-over");
	releaseOldOwner();
	await oldOwnerPass;
	equal(oldOwnerResult?.kind, "degraded");
	const winner = await loadJournal(contenderB.deps.runJournal, root);
	equal(winner.run.controllerSessionId, "controller-b");
	equal(winner.journalRevision, 3);
	equal(ownerA.calls.replace, 1, JSON.stringify(ownerA.calls.order));
	equal(ownerA.calls.activity, 0);
	equal(ownerA.calls.herdr + ownerA.calls.git + ownerA.calls.process + ownerA.calls.model, 0);
	equal(contenderB.calls.replace, 1);
	equal(contenderB.calls.activity, 1);
	equal((await activityEvents(root)).filter((event) => event === "controller-taken-over").length, 1);
});

it.sequential("registered concurrent takeovers elect one revision-N+1 owner and one monitor", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-ownership-concurrent-"));
	roots.push(root);
	const seeded = await seed(root, "controller-a");
	await seedPromptedAttempt(root, seeded);
	const contenderB = dependencies(root);
	const contenderC = dependencies(root);
	const depsB = contenderB.deps;
	const depsC = contenderC.deps;
	let inspections = 0;
	let releaseInspections!: () => void;
	let reportBothInspected!: () => void;
	const bothInspected = new Promise<void>((resolve) => { reportBothInspected = resolve; });
	const release = new Promise<void>((resolve) => { releaseInspections = resolve; });
	const inspectReportB = depsB.runJournal.inspectAttemptReport!;
	const inspectReportC = depsC.runJournal.inspectAttemptReport!;
	const inspectDuringTakeover = async (inspect: typeof inspectReportB, ...args: Parameters<typeof inspectReportB>) => {
		const observed = await inspect(...args);
		inspections += 1;
		if (inspections === 2) reportBothInspected();
		await release;
		return observed;
	};
	depsB.runJournal.inspectAttemptReport = (...args) => inspectDuringTakeover(inspectReportB, ...args);
	depsC.runJournal.inspectAttemptReport = (...args) => inspectDuringTakeover(inspectReportC, ...args);
	const casResults: string[] = [];
	let replaceCalls = 0;
	let releaseSecondReplace!: () => void;
	const firstReplaceDone = new Promise<void>((resolve) => { releaseSecondReplace = resolve; });
	const gateReplace = async (replace: typeof depsB.runJournal.replaceActive, ...args: Parameters<typeof depsB.runJournal.replaceActive>) => {
		const call = replaceCalls;
		replaceCalls += 1;
		if (call === 1) await firstReplaceDone;
		const outcome = await replace(...args);
		casResults.push(outcome.kind);
		if (call === 0) releaseSecondReplace();
		return outcome;
	};
	const replaceB = depsB.runJournal.replaceActive;
	const replaceC = depsC.runJournal.replaceActive;
	depsB.runJournal.replaceActive = (...args) => gateReplace(replaceB, ...args);
	depsC.runJournal.replaceActive = (...args) => gateReplace(replaceC, ...args);
	let waitCalls = 0;
	const configureMonitorAdapters = (deps: StewardDependencies): void => {
		deps.herdr.inspectManagedAgent = async (identity) => ({ kind: "observed", identity, lifecycle: "working", stateChangeSequence: 1 });
		deps.herdr.waitForManagedAgent = async (_identity, _timeoutMs, signal) => await new Promise((resolve) => {
		waitCalls += 1;
		signal.addEventListener("abort", () => resolve({ kind: "cancelled" }), { once: true });
		});
	};
	configureMonitorAdapters(depsB);
	configureMonitorAdapters(depsC);
	let winnerResult: import("../src/steward.ts").ResumeResult | undefined;
	let loserResult: import("../src/steward.ts").ResumeResult | undefined;
	const winnerSurface = capture();
	const loserSurface = capture();
	depsB.ui = { ...depsB.ui, presentResumeResult(value) { winnerResult = value; } };
	depsC.ui = { ...depsC.ui, presentResumeResult(value) { loserResult = value; } };
	registerStewardExtension(winnerSurface.surface, () => depsB);
	registerStewardExtension(loserSurface.surface, () => depsC);
	const b = context(root, "controller-b");
	const c = context(root, "controller-c");
	await winnerSurface.event("session_start")({ type: "session_start", reason: "replacement" }, b);
	await loserSurface.event("session_start")({ type: "session_start", reason: "replacement" }, c);
	const winnerPass = winnerSurface.command()("resume --takeover", b);
	const loserPass = loserSurface.command()("resume --takeover", c);
	await bothInspected;
	releaseInspections();
	await Promise.all([winnerPass, loserPass]);
	ok(winnerResult?.kind === "taken-over" || loserResult?.kind === "taken-over", JSON.stringify({ winnerResult, loserResult, casResults, contenderB: contenderB.calls, contenderC: contenderC.calls }));
	ok(winnerResult?.kind === "taken-over" ? loserResult?.kind === "stale" : false, JSON.stringify({ winnerResult, loserResult, casResults, contenderB: contenderB.calls, contenderC: contenderC.calls }));
	const winnerSession = winnerResult?.kind === "taken-over" ? "controller-b" : "controller-c";
	const current = await loadJournal(depsB.runJournal, root);
	equal(current.journalRevision, 3);
	equal(current.run.controllerSessionId, winnerSession);
	equal(current.run.controllerLease?.takeover?.basisJournalRevision, 2);
	equal((await activityEvents(root)).filter((event) => event === "controller-taken-over").length, 1);
	equal(casResults.filter((kind) => kind === "replaced").length, 1);
	await waitFor(() => waitCalls === 1);
	await winnerSurface.event("session_shutdown")({ type: "session_shutdown", reason: "quit" }, b);
	await loserSurface.event("session_shutdown")({ type: "session_shutdown", reason: "quit" }, c);
});

it.sequential.each([
	"foreign",
	"invalid",
	"completed",
	"stale revision between continuity loads",
	"post-shutdown",
] as const)("registered %s compaction continuity stays fail-closed and leaves Pi compaction available", async (caseName) => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-ownership-compaction-state-"));
	roots.push(root);
	const seeded = await seed(root, "controller-owner");
	const { deps } = dependencies(root);
	const registered = capture();
	let hostCalls = 0;
	registerStewardExtension(registered.surface, () => deps, undefined, async () => {
		hostCalls += 1;
		return { summary: "unexpected custom compaction", firstKeptEntryId: "entry-1", tokensBefore: 1, usage: { input: 1, output: 1, totalTokens: 2 } as never, details: {} } as unknown as CompactionResult;
	});
	const owner = context(root, "controller-owner");
	const foreign = context(root, "controller-foreign");
	const session = caseName === "foreign" ? foreign : owner;
	if (caseName === "invalid" || caseName === "completed") {
		const path = resolveRunJournalPaths(root).activePath;
		const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		const run = raw.run as Record<string, unknown>;
		if (caseName === "invalid") raw.run = { ...run, declaredOutcome: "invalid fixture", unexpected: true };
		else raw.run = { ...run, status: "completed" };
		await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
	}
	if (caseName === "stale revision between continuity loads") {
		await registered.event("session_start")({ type: "session_start", reason: "test" }, owner);
		await registered.event("session_shutdown")({ type: "session_shutdown", reason: "reload" }, owner);
		await registered.command()("status", owner);
	} else if (caseName !== "post-shutdown") await registered.event("session_start")({ type: "session_start", reason: "test" }, session);
	if (caseName === "stale revision between continuity loads") {
		const originalLoad = deps.runJournal.loadActive;
		let eventLoad = 0;
		deps.runJournal.loadActive = async (...args) => {
			const loaded = await originalLoad(...args);
			eventLoad += 1;
			if (eventLoad === 1) await mutateActiveJournal(root, (next) => { next.run.declaredOutcome = "continuity race"; });
			return loaded;
		};
	}
	if (caseName === "post-shutdown") {
		await registered.event("session_start")({ type: "session_start", reason: "test" }, owner);
		await registered.event("session_shutdown")({ type: "session_shutdown", reason: "reload" }, owner);
	}
	const before = await bytes(root, seeded);
	const result = await registered.event("session_before_compact")({ type: "session_before_compact", preparation: { branchEntries: [] }, branchEntries: [], customInstructions: "keep default compaction", reason: "manual", willRetry: false, signal: new AbortController().signal }, session);
	equal(result, undefined);
	equal(hostCalls, 0);
	const after = await bytes(root, seeded);
	equal(after.activity, before.activity);
	if (caseName !== "stale revision between continuity loads") deepStrictEqual(after, before);
	if (caseName !== "post-shutdown") await registered.event("session_shutdown")({ type: "session_shutdown", reason: "quit" }, session);
});

it.sequential("successful and failed registered compaction hooks preserve continuity and failure-only diagnostics", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-ownership-compaction-"));
	roots.push(root);
	await mkdir(root, { recursive: true });
	const seeded = await seed(root, "controller-owner");
	const { deps } = dependencies(root);
	const registered = capture();
	const hostCalls: Array<{ instructions: string | undefined; continuity: string }> = [];
	const warnings: string[] = [];
	registerStewardExtension(registered.surface, () => deps, undefined, async (event, _ctx, continuity) => {
		hostCalls.push({ instructions: event.customInstructions, continuity });
		return { summary: "summary from Pi", firstKeptEntryId: "entry-1", tokensBefore: 42, usage: { input: 1, output: 2, totalTokens: 3 } as never, details: { source: "test" } } as unknown as CompactionResult;
	});
	const ctx = context(root, "controller-owner");
	await registered.event("session_start")({ type: "session_start", reason: "startup" }, ctx);
	const signal = new AbortController().signal;
	const beforeEvent = { type: "session_before_compact", preparation: { branchEntries: [] }, branchEntries: [], customInstructions: "keep this instruction", reason: "manual", willRetry: false, signal };
	const success = await registered.event("session_before_compact")(beforeEvent, ctx);
	ok(success?.compaction);
	if (!success?.compaction) return;
	ok(hostCalls[0]?.instructions?.includes("keep this instruction"));
	ok(hostCalls[0]?.continuity.includes(`Steward Run: ${seeded.run.id}`));
	ok(hostCalls[0]?.continuity.includes("Pending Controller action: admit-task task-01"));
	equal(success.compaction.firstKeptEntryId, "entry-1");
	equal(success.compaction.tokensBefore, 42);
	await registered.event("session_compact")({ type: "session_compact", compactionEntry: {}, fromExtension: true, reason: "manual", willRetry: false }, ctx);
	await registered.event("session_shutdown")({ type: "session_shutdown", reason: "reload" }, ctx);

	const beforeFailure = await bytes(root, seeded);
	const throwing = capture();
	const failureWarnings: string[] = [];
	const failureDeps = dependencies(root).deps;
	registerStewardExtension(throwing.surface, () => failureDeps, undefined, async () => { throw new Error("continuity failed\nwith details"); });
	const failureCtx = context(root, "controller-owner", { notify(message, type) { if (type === "warning") failureWarnings.push(message); } });
	await throwing.event("session_start")({ type: "session_start", reason: "reload" }, failureCtx);
	const failed = await throwing.event("session_before_compact")(beforeEvent, failureCtx);
	equal(failed, undefined);
	await throwing.event("session_compact_failed")({ type: "session_compact_failed", reason: "overflow", errorMessage: "continuity failed\nwith details", aborted: false, willRetry: false, fromExtension: true }, failureCtx);
	const afterFailure = await bytes(root, seeded);
	equal(afterFailure.active, beforeFailure.active);
	equal(afterFailure.previous, beforeFailure.previous);
	ok(afterFailure.activity.includes("compaction-continuity-failed"));
	ok(failureWarnings.some((message) => message.includes("continuity failed with details")));
	await throwing.event("session_shutdown")({ type: "session_shutdown", reason: "quit" }, failureCtx);
});

it.sequential("reconstructs one owner monitor across reload and keeps a replacement session dormant until takeover", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-ownership-lifecycle-"));
	roots.push(root);
	const seeded = await seed(root, "controller-a");
	await seedPromptedAttempt(root, seeded);
	const { deps } = dependencies(root);
	const digest = `sha256:${"c".repeat(64)}`;
	let waitCalls = 0;
	let abortedWaits = 0;
	const waitResolvers: Array<(value: { kind: "settled"; lifecycle: "idle"; identity: { name: string; workspaceId: string; paneId: string; terminalId: string }; stateChangeSequence: number | null }) => void> = [];
	deps.herdr.inspectManagedAgent = async (identity) => ({ kind: "observed", identity, lifecycle: "working", stateChangeSequence: 1 });
	deps.herdr.readManagedTerminal = async () => ({ kind: "observed", byteCount: 0, sha256: digest });
	deps.git.inspectManagedWorktreeProgress = async () => ({ kind: "observed", head: base, worktree: { kind: "observed", byteCount: 0, sha256: digest }, git: { head: base, digest: { kind: "observed", byteCount: 0, sha256: digest } } });
	deps.herdr.waitForManagedAgent = async (identity, _timeoutMs, signal) => await new Promise((resolve) => {
		waitCalls += 1;
		waitResolvers.push((value) => resolve(value));
		signal.addEventListener("abort", () => { abortedWaits += 1; resolve({ kind: "cancelled" }); }, { once: true });
	});
	const registered = capture();
	registerStewardExtension(registered.surface, () => deps);
	const a = context(root, "controller-a");
	const b = context(root, "controller-b");
	await registered.event("session_start")({ type: "session_start", reason: "startup" }, a);
	await waitFor(() => waitCalls === 1);
	await registered.event("session_shutdown")({ type: "session_shutdown", reason: "reload" }, a);
	equal(abortedWaits, 1);
	await registered.event("session_start")({ type: "session_start", reason: "reload" }, a);
	await waitFor(() => waitCalls === 2);
	await registered.event("session_shutdown")({ type: "session_shutdown", reason: "new" }, a);
	await registered.event("session_start")({ type: "session_start", reason: "new" }, b);
	const dormantCalls = waitCalls;
	await new Promise<void>((resolve) => setImmediate(resolve));
	equal(waitCalls, dormantCalls);
	await registered.command()("resume --takeover", b);
	await waitFor(() => waitCalls === dormantCalls + 1);
	await registered.event("session_shutdown")({ type: "session_shutdown", reason: "resume" }, b);
	await registered.event("session_start")({ type: "session_start", reason: "resume" }, b);
	await waitFor(() => waitCalls === dormantCalls + 2);
	for (const resolve of waitResolvers) resolve({ kind: "settled", lifecycle: "idle", identity: { name: "steward-b-abcdef12-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" }, stateChangeSequence: 2 });
	await registered.event("session_shutdown")({ type: "session_shutdown", reason: "quit" }, b);
	ok(abortedWaits >= 4);
});
