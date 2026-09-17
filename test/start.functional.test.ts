import { existsSync } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";
import { afterEach, it } from "vitest";

import { createRunJournalAdapter } from "../src/adapters.ts";
import { createConfigStore } from "../src/config-store.ts";
import { registerStewardExtension, type StewardCommandContext, type StewardCommandHandler, type StewardRegistrationSurface } from "../src/extension.ts";
import { createRunJournalStore } from "../src/run-journal-store.ts";
import { buildInitialRunJournal, type RunDraft, type RunJournal } from "../src/run.ts";
import type { ProjectModelPlans, RecoveryDefaults } from "../src/config.ts";
import type { RunJournalAdapter, StewardDependencies, StewardModelAdapter, StewardUiAdapter } from "../src/steward.ts";

const roots: string[] = [];
const START_FILESYSTEM_TEST_TIMEOUT_MS = 15_000;
const modelPlans: ProjectModelPlans = {
	builder: { primary: { model: "builder/primary", thinkingLevel: "high" }, fallbacks: [{ model: "builder/fallback", thinkingLevel: "medium" }] },
	reviewer: { primary: { model: "reviewer/primary", thinkingLevel: "high" }, fallbacks: [{ model: "reviewer/fallback", thinkingLevel: "low" }] },
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
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-start-"));
	roots.push(root);
	return root;
}

function makeSurface(capture: { handler?: StewardCommandHandler }, factory: (request: Parameters<NonNullable<typeof createTestDependencies>>[0]) => StewardDependencies): StewardRegistrationSurface {
	return {
		on() {},
		registerCommand(_name, options) {
			capture.handler = options.handler;
		},
	};
}

type DependencyOptions = {
	root: string;
	ui: StewardUiAdapter;
	runJournal?: StewardDependencies["runJournal"];
	herdr?: StewardDependencies["herdr"];
	git?: StewardDependencies["git"];
	model?: StewardModelAdapter;
	clock?: StewardDependencies["clock"];
};

function createTestDependencies(options: DependencyOptions): StewardDependencies {
	return {
		runJournal: options.runJournal ?? createRunJournalAdapter(),
		herdr: options.herdr ?? { async checkAvailability() { return { kind: "available", status: "running", running: true, compatible: true, endpointCompatible: true }; } },
		git: options.git ?? { async inspectIntegrationBase() { return { kind: "ready", branch: "main", revision: "0123456789abcdef0123456789abcdef01234567" }; } },
		process: {},
		model: options.model ?? { listModelChoices: () => [], async validateModelPlans() { return []; } },
		clock: options.clock ?? { now: () => new Date("2026-09-17T18:00:00.000Z"), randomUUID: () => "01234567-89ab-cdef-0123-456789abcdef" },
		ui: options.ui,
	};
}

function context(root: string, mode: StewardCommandContext["mode"] = "tui"): StewardCommandContext {
	return {
		mode,
		hasUI: mode === "tui",
		cwd: root,
		modelRegistry: {} as StewardCommandContext["modelRegistry"],
		model: undefined,
		thinkingLevel: undefined,
		scopedModels: [],
		sessionManager: { getSessionId: () => "controller-session-fixed" } as StewardCommandContext["sessionManager"],
		ui: { select: async () => undefined, input: async () => undefined, confirm: async () => false, notify() {}, setStatus() {} },
	};
}

function draft(): RunDraft {
	return {
		declaredOutcome: "Ship the confirmed change",
		tasks: [
			{ requiredOutcome: "Implement the approved behavior", allowedScope: ["src/change.ts", "test/change.test.ts"], expectedArtifacts: [{ kind: "git-commit" }, { kind: "file", path: "reports/attempt.md" }], verification: { kind: "command", command: "npm test -- test/change.test.ts" }, reviewRequired: true },
			{ requiredOutcome: "Record the evidence", allowedScope: ["reports/attempt.md"], expectedArtifacts: [{ kind: "evidence", description: "A complete verification record" }], verification: { kind: "criteria", criteria: "All required checks are green" }, reviewRequired: true },
		],
		modelPlan: modelPlans,
		effectiveSettings: recovery,
		finalVerification: { kind: "command", command: "npm test" },
	};
}

function uiForStart(result: { summary?: Parameters<StewardUiAdapter["confirmRun"]>[0]; result?: import("../src/steward.ts").StartResult }, confirm = true): StewardUiAdapter {
	return {
		presentStatus() {},
		async editConfiguration() { return { kind: "cancelled" }; },
		presentConfigurationResult() {},
		async draftRun() { return { kind: "drafted" as const, draft: draft() }; },
		async confirmRun(summary) { result.summary = summary; return confirm; },
		presentStartResult(value) { result.result = value; },
	};
}

it.sequential("registered /steward start confirms and persists one frozen pending Run", async () => {
	const root = await makeRoot();
	const config = createConfigStore();
	await config.saveRecoveryDefaults(recovery);
	await config.saveModelPlans(root, modelPlans);
	const capture: { handler?: StewardCommandHandler } = {};
	const observed: { summary?: Parameters<StewardUiAdapter["confirmRun"]>[0]; result?: import("../src/steward.ts").StartResult } = {};
	let herdrCalls = 0;
	let gitCalls = 0;
	let modelCalls = 0;
	const deps = createTestDependencies({
		root,
		ui: uiForStart(observed),
		herdr: { async checkAvailability() { herdrCalls += 1; return { kind: "available", status: "running", running: true, compatible: true, endpointCompatible: true }; } },
		git: { async inspectIntegrationBase() { gitCalls += 1; return { kind: "ready", branch: "main", revision: "0123456789abcdef0123456789abcdef01234567" }; } },
		model: { listModelChoices: () => [], async validateModelPlans() { modelCalls += 1; return []; } },
	});
	registerStewardExtension({ on() {}, registerCommand(_name, options) { capture.handler = options.handler; } }, () => deps);
	if (!capture.handler) throw new Error("missing command handler");
	await capture.handler("start", context(root));
	ok(observed.summary);
	if (!observed.summary || !observed.result || (observed.result.kind !== "started" && observed.result.kind !== "started-with-warning" && observed.result.kind !== "started-dispatch-pending")) return;
	if (observed.result.kind === "started-dispatch-pending") match(observed.result.message, /Builder dispatch adapters are unavailable; the Run is durable and dispatch is pending/);
	match(observed.summary.markdown, /Task 1.*requiredOutcome: Implement the approved behavior/s);
	match(observed.summary.markdown, /Task 2.*requiredOutcome: Record the evidence/s);
	match(observed.summary.markdown, /sha256:[0-9a-f]{64}/);
	match(observed.summary.markdown, /builder\/primary.*thinking=high.*builder\/fallback.*thinking=medium/s);
	match(observed.summary.markdown, /reviewer\/primary.*thinking=high.*reviewer\/fallback.*thinking=low/s);
	match(observed.summary.markdown, /main @ 0123456789abcdef0123456789abcdef01234567/);
	match(observed.summary.markdown, /maximumActiveTasks/);
	match(observed.summary.markdown, /non-authoritative.*active-run\.json.*Run Journal/s);
	const journalPath = join(root, ".pi", "steward", "active-run.json");
	const journal = JSON.parse(await readFile(journalPath, "utf8")) as RunJournal;
	equal(journal.schemaVersion, 1);
	equal(journal.journalRevision, 1);
	equal(journal.run.id, "run-20260917T180000000Z-01234567");
	equal(journal.run.controllerSessionId, "controller-session-fixed");
	deepStrictEqual(journal.run.effectiveSettings, recovery);
	deepStrictEqual(journal.run.modelPlan, modelPlans);
	deepStrictEqual(journal.run.tasks.map((task) => [task.phase, task.attention, task.attempts, task.reworkCycles]), [["pending", "none", [], 0], ["pending", "none", [], 0]]);
	equal(herdrCalls, 2);
	equal(gitCalls, 2);
	equal(modelCalls, 2);
	const activityPath = join(root, ".pi", "steward", "runs", journal.run.id, "activity.log");
	const activity = JSON.parse((await readFile(activityPath, "utf8")).trim()) as Record<string, string>;
	deepStrictEqual(Object.keys(activity), ["timestamp", "runId", "event", "message"]);
	equal(activity.event, "run-started");
	equal((await stat(journalPath)).mode & 0o777, 0o600);
}, START_FILESYSTEM_TEST_TIMEOUT_MS);

it.sequential("start cancellation during drafting and final confirmation is a filesystem no-op", async () => {
	const root = await makeRoot();
	let capture: { handler?: StewardCommandHandler } = {};
	const cancelledUi: StewardUiAdapter = {
		...uiForStart({}),
		async draftRun() { return { kind: "cancelled" }; },
	};
	registerStewardExtension({ on() {}, registerCommand(_name, options) { capture.handler = options.handler; } }, () => createTestDependencies({ root, ui: cancelledUi }));
	if (!capture.handler) throw new Error("missing command handler");
	await capture.handler("start", context(root));
	equal(existsSync(join(root, ".pi")), false);

	const configured = await makeRoot();
	const config = createConfigStore();
	await config.saveModelPlans(configured, modelPlans);
	const before = JSON.stringify(await readdir(join(configured, ".pi", "steward")));
	capture = {};
	const finalCancel = uiForStart({}, false);
	registerStewardExtension({ on() {}, registerCommand(_name, options) { capture.handler = options.handler; } }, () => createTestDependencies({ root: configured, ui: finalCancel }));
	if (!capture.handler) throw new Error("missing command handler");
	await capture.handler("start", context(configured));
	equal(JSON.stringify(await readdir(join(configured, ".pi", "steward"))), before);
	equal(existsSync(join(configured, ".pi", "steward", "active-run.json")), false);
}, START_FILESYSTEM_TEST_TIMEOUT_MS);

it.sequential("non-TUI start refuses before adapter construction", async () => {
	const root = await makeRoot();
	let factoryCalls = 0;
	const capture: { handler?: StewardCommandHandler } = {};
	registerStewardExtension({ on() {}, registerCommand(_name, options) { capture.handler = options.handler; } }, () => {
		factoryCalls += 1;
		throw new Error("factory must not be constructed");
	});
	if (!capture.handler) throw new Error("missing command handler");
	for (const mode of ["rpc", "json", "print"] as const) await rejects(capture.handler("start", context(root, mode)), /Steward start requires interactive TUI mode\./);
	equal(factoryCalls, 0);
	equal(existsSync(join(root, ".pi")), false);
});

it.sequential("an existing active Run refuses before Herdr/model/UI work", async () => {
	const root = await makeRoot();
	const store = createRunJournalAdapter();
	const seeded = buildInitialRunJournal({ identity: { runId: "run-20260917T180000000Z-existing", createdAt: "2026-09-17T18:00:00.000Z" }, controllerSessionId: "existing", draft: draft(), modelPlan: modelPlans, effectiveSettings: recovery, integrationBase: { kind: "git", branch: "main", revision: "0123456789abcdef0123456789abcdef01234567" } });
	await store.createActive(root, seeded);
	let herdrCalls = 0;
	const result: { result?: import("../src/steward.ts").StartResult } = {};
	const ui = uiForStart(result);
	const deps = createTestDependencies({ root, ui, herdr: { async checkAvailability() { herdrCalls += 1; return { kind: "available", status: "running", running: true, compatible: true, endpointCompatible: true }; } } });
	const capture: { handler?: StewardCommandHandler } = {};
	registerStewardExtension({ on() {}, registerCommand(_name, options) { capture.handler = options.handler; } }, () => deps);
	if (!capture.handler) throw new Error("missing command handler");
	await capture.handler("start", context(root));
	equal(herdrCalls, 0);
	ok(result.result?.kind === "refused");
});

it.sequential("unavailable Herdr refuses before drafting and writes", async () => {
	const root = await makeRoot();
	let drafted = 0;
	const result: { result?: import("../src/steward.ts").StartResult } = {};
	const ui = { ...uiForStart(result), async draftRun() { drafted += 1; return { kind: "cancelled" as const }; } };
	const capture: { handler?: StewardCommandHandler } = {};
	registerStewardExtension({ on() {}, registerCommand(_name, options) { capture.handler = options.handler; } }, () => createTestDependencies({ root, ui, herdr: { async checkAvailability() { return { kind: "unavailable", message: "server stopped" }; } } }));
	if (!capture.handler) throw new Error("missing command handler");
	await capture.handler("start", context(root));
	equal(drafted, 0);
	ok(result.result?.kind === "refused");
	equal(existsSync(join(root, ".pi")), false);
});

it.sequential("unavailable required Model Plans refuse before Git, confirmation, or writes", async () => {
	const root = await makeRoot();
	let drafted = 0;
	let confirmed = 0;
	let gitCalls = 0;
	let modelCalls = 0;
	const result: { result?: import("../src/steward.ts").StartResult } = {};
	const ui = {
		...uiForStart(result),
		async draftRun() {
			drafted += 1;
			return { kind: "drafted" as const, draft: draft() };
		},
		async confirmRun() {
			confirmed += 1;
			return true;
		},
	};
	const capture: { handler?: StewardCommandHandler } = {};
	registerStewardExtension({ on() {}, registerCommand(_name, options) { capture.handler = options.handler; } }, () => createTestDependencies({
		root,
		ui,
		git: { async inspectIntegrationBase() { gitCalls += 1; return { kind: "ready", branch: "main", revision: "0123456789abcdef0123456789abcdef01234567" }; } },
		model: {
			listModelChoices: () => [],
			async validateModelPlans() {
				modelCalls += 1;
				return [{ code: "unavailable-model", role: "builder", index: 1, reference: "builder/fallback", message: "fallback is not available" }];
			},
		},
	}));
	if (!capture.handler) throw new Error("missing command handler");
	await capture.handler("start", context(root));
	equal(drafted, 1);
	equal(modelCalls, 1);
	equal(gitCalls, 0);
	equal(confirmed, 0);
	ok(result.result?.kind === "refused");
	equal(existsSync(join(root, ".pi")), false);
});

it.sequential("dirty or unavailable Git integration base refuses before confirmation or writes", async () => {
	const root = await makeRoot();
	let confirmed = 0;
	let gitCalls = 0;
	const result: { result?: import("../src/steward.ts").StartResult } = {};
	const ui = {
		...uiForStart(result),
		async confirmRun() {
			confirmed += 1;
			return true;
		},
	};
	const capture: { handler?: StewardCommandHandler } = {};
	registerStewardExtension({ on() {}, registerCommand(_name, options) { capture.handler = options.handler; } }, () => createTestDependencies({
		root,
		ui,
		git: { async inspectIntegrationBase() { gitCalls += 1; return { kind: "unavailable", message: "The checkout is dirty." }; } },
	}));
	if (!capture.handler) throw new Error("missing command handler");
	await capture.handler("start", context(root));
	equal(gitCalls, 1);
	equal(confirmed, 0);
	ok(result.result?.kind === "refused");
	equal(existsSync(join(root, ".pi")), false);
});

it.sequential("activity logging failure leaves the authoritative journal and reports degraded logging", async () => {
	const root = await makeRoot();
	const production = createRunJournalAdapter();
	const observed: { result?: import("../src/steward.ts").StartResult } = {};
	const runJournal: RunJournalAdapter = {
		...production,
		async appendActivity() {
			return { kind: "storage-error", path: join(root, ".pi", "steward", "runs", "activity.log"), diagnostics: [] };
		},
	};
	const capture: { handler?: StewardCommandHandler } = {};
	registerStewardExtension({ on() {}, registerCommand(_name, options) { capture.handler = options.handler; } }, () => createTestDependencies({ root, runJournal, ui: uiForStart(observed) }));
	if (!capture.handler) throw new Error("missing command handler");
	await capture.handler("start", context(root));
	ok(observed.result?.kind === "started-with-warning");
	equal(existsSync(join(root, ".pi", "steward", "active-run.json")), true);
	match(observed.result?.message ?? "", /non-authoritative activity logging is degraded/);
});

it.sequential("post-confirmation active, Herdr, model, and Git changes refuse without persistence", async () => {
	const cases = ["active", "herdr", "model", "git"] as const;
	for (const change of cases) {
		const root = await makeRoot();
		const observed: { result?: import("../src/steward.ts").StartResult } = {};
		const production = createRunJournalAdapter();
		const baseRevision = "0123456789abcdef0123456789abcdef01234567";
		const changedRevision = "fedcba9876543210fedcba9876543210fedcba98";
		let activeLoads = 0;
		let herdrCalls = 0;
		let modelCalls = 0;
		let gitCalls = 0;
		const runJournal = change === "active"
			? {
				...production,
				async loadActive(repositoryRoot: string) {
					activeLoads += 1;
					if (activeLoads === 2) {
						const competing = buildInitialRunJournal({ identity: { runId: "run-20260917T180000000Z-competing", createdAt: "2026-09-17T18:00:00.000Z" }, controllerSessionId: "competing", draft: draft(), modelPlan: modelPlans, effectiveSettings: recovery, integrationBase: { kind: "git", branch: "main", revision: baseRevision } });
						await production.createActive(repositoryRoot, competing);
					}
					return production.loadActive(repositoryRoot);
				},
			}
			: production;
		const deps = createTestDependencies({
			root,
			runJournal,
			ui: uiForStart(observed),
			herdr: {
				async checkAvailability() {
					herdrCalls += 1;
					return change === "herdr" && herdrCalls === 2
						? { kind: "unavailable", message: "endpoint became stale" }
						: { kind: "available", status: "running", running: true, compatible: true, endpointCompatible: true };
				},
			},
			model: {
				listModelChoices: () => [],
				async validateModelPlans() {
					modelCalls += 1;
					return change === "model" && modelCalls === 2
						? [{ code: "unavailable-model", role: "reviewer", index: 0, reference: "reviewer/primary", message: "model became unavailable" }]
						: [];
				},
			},
			git: {
				async inspectIntegrationBase() {
					gitCalls += 1;
					return change === "git" && gitCalls === 2
						? { kind: "ready", branch: "main", revision: changedRevision }
						: { kind: "ready", branch: "main", revision: baseRevision };
				},
			},
		});
		const capture: { handler?: StewardCommandHandler } = {};
		registerStewardExtension({ on() {}, registerCommand(_name, options) { capture.handler = options.handler; } }, () => deps);
		if (!capture.handler) throw new Error("missing command handler");
		await capture.handler("start", context(root));
		ok(observed.result?.kind === "refused");
		if (change !== "active") equal(existsSync(join(root, ".pi")), false);
	}
});

it.sequential("exclusive creation race refuses without overwriting the competing Run or appending activity", async () => {
	const root = await makeRoot();
	const production = createRunJournalAdapter();
	const competing = buildInitialRunJournal({ identity: { runId: "run-20260917T180000000Z-racewinner", createdAt: "2026-09-17T18:00:00.000Z" }, controllerSessionId: "race-winner", draft: draft(), modelPlan: modelPlans, effectiveSettings: recovery, integrationBase: { kind: "git", branch: "main", revision: "0123456789abcdef0123456789abcdef01234567" } });
	const runJournal: RunJournalAdapter = {
		...production,
		async createActive(repositoryRoot, _journal) {
			await production.createActive(repositoryRoot, competing);
			return { kind: "active-exists", paths: createRunJournalStore().resolvePaths(repositoryRoot) };
		},
	};
	const observed: { result?: import("../src/steward.ts").StartResult } = {};
	const capture: { handler?: StewardCommandHandler } = {};
	registerStewardExtension({ on() {}, registerCommand(_name, options) { capture.handler = options.handler; } }, () => createTestDependencies({ root, runJournal, ui: uiForStart(observed) }));
	if (!capture.handler) throw new Error("missing command handler");
	await capture.handler("start", context(root));
	ok(observed.result?.kind === "refused");
	const active = JSON.parse(await readFile(join(root, ".pi", "steward", "active-run.json"), "utf8")) as RunJournal;
	equal(active.run.id, competing.run.id);
	equal(existsSync(join(root, ".pi", "steward", "runs", competing.run.id, "activity.log")), false);
});
