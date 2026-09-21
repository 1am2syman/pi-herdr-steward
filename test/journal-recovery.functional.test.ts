import { createHash } from "node:crypto";
import { mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { afterEach, it, vi } from "vitest";

import { createPiUiAdapter, createRunJournalAdapter } from "../src/adapters.ts";
import { registerStewardExtension, type StewardCommandContext, type StewardCommandHandler, type StewardRegistrationSurface, type StewardSessionContext } from "../src/extension.ts";
import { resolveRunJournalPaths, type RunJournalMigration, type RunJournalMigrationRegistry } from "../src/run-journal-store.ts";
import { advanceRunJournal, buildInitialRunJournal, serializeRunJournal, type RunJournal } from "../src/run.ts";
import type { ResumeResult, StewardDependencies, StatusView } from "../src/steward.ts";

const roots: string[] = [];
vi.setConfig({ testTimeout: 60_000 });
const controllerSessionId = "journal-recovery-session";
const plans = {
	builder: { primary: { model: "builder/primary", thinkingLevel: "high" as const }, fallbacks: [] },
	reviewer: { primary: { model: "reviewer/primary", thinkingLevel: "medium" as const }, fallbacks: [] },
};
const settings = {
	passiveInspectionIntervalSeconds: 301,
	secondInspectionAndNudgeIntervalSeconds: 302,
	nudgeGracePeriodSeconds: 121,
	externalCommandWarningThresholdSeconds: 1_801,
	maximumActiveTasks: 1,
	transientRetryLimit: 1,
	reworkCycleLimit: 4,
};

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type EffectCounters = { herdr: number; git: number; process: number; model: number; clock: number };

function hash(bytes: string | Buffer): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function journal(): RunJournal {
	return buildInitialRunJournal({
		identity: { runId: "run-20260921T100000000Z-recovery", createdAt: "2026-09-21T10:00:00.000Z" },
		controllerSessionId,
		draft: {
			declaredOutcome: "Recover damaged Journal snapshots conservatively",
			tasks: [{ requiredOutcome: "Preserve the exact recovery boundary", allowedScope: ["src"], expectedArtifacts: [{ kind: "evidence", description: "Recovery evidence" }], verification: { kind: "command", command: "npm run typecheck" }, reviewRequired: false }],
			modelPlan: plans,
			effectiveSettings: settings,
			finalVerification: { kind: "command", command: "npm run typecheck" },
		},
		modelPlan: plans,
		effectiveSettings: settings,
		integrationBase: { kind: "none" },
	});
}

function throwingAdapter(slot: keyof EffectCounters, counters: EffectCounters): object {
	return new Proxy({}, {
		get(_target, property) {
			counters[slot] += 1;
			throw new Error(`unexpected recovery ${slot} effect: ${String(property)}`);
		},
	});
}

function commandContext(root: string): StewardCommandContext {
	return {
		mode: "tui",
		hasUI: true,
		cwd: root,
		modelRegistry: {} as StewardCommandContext["modelRegistry"],
		model: undefined,
		thinkingLevel: undefined,
		scopedModels: [],
		sessionManager: { getSessionId: () => controllerSessionId } as StewardCommandContext["sessionManager"],
		ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined, notify() {}, setStatus() {} },
	};
}

function sessionContext(root: string): StewardSessionContext {
	return commandContext(root) as StewardSessionContext;
}

interface Harness {
	dependencies: StewardDependencies;
	command: StewardCommandHandler;
	sessionStart?: (event: unknown, context: StewardSessionContext) => Promise<void>;
	presentations: StatusView[];
	resumeResults: Array<{ kind: string; message: string }>;
	notifications: string[];
}

function registerHarness(root: string, runJournal: ReturnType<typeof createRunJournalAdapter>, counters: EffectCounters, migrations?: RunJournalMigrationRegistry): Harness {
	const presentations: StatusView[] = [];
	const resumeResults: Array<{ kind: string; message: string }> = [];
	const notifications: string[] = [];
	const productionUi = createPiUiAdapter({
		notify(message) { notifications.push(message); },
		setStatus() {},
	});
	const ui = {
		...productionUi,
		presentStatus(view: StatusView, target: "command" | "footer") {
			presentations.push(view);
			productionUi.presentStatus(view, target);
		},
		presentResumeResult(result: ResumeResult) {
			resumeResults.push({ kind: result.kind, message: "message" in result ? result.message : result.result.note });
			productionUi.presentResumeResult?.(result);
		},
	};
	const dependencies: StewardDependencies = {
		runJournal: migrations === undefined ? runJournal : createRunJournalAdapter({ migrations }),
		herdr: throwingAdapter("herdr", counters) as never,
		git: throwingAdapter("git", counters) as never,
		process: throwingAdapter("process", counters) as never,
		model: throwingAdapter("model", counters) as never,
		clock: throwingAdapter("clock", counters) as never,
		ui,
	};
	let command: Harness["command"] | undefined;
	let sessionStart: Harness["sessionStart"];
	const surface: StewardRegistrationSurface = {
		on(event, handler) {
			if (event === "session_start") sessionStart = handler as unknown as Harness["sessionStart"];
		},
		registerCommand(_name, options) { command = options.handler; },
	};
	registerStewardExtension(surface, () => dependencies);
	if (!command) throw new Error("Steward command was not registered.");
	deepStrictEqual(Object.keys(dependencies).sort(), ["clock", "git", "herdr", "model", "process", "runJournal", "ui"]);
	return { dependencies, command, ...(sessionStart ? { sessionStart } : {}), presentations, resumeResults, notifications };
}

async function createActive(root: string, adapter: ReturnType<typeof createRunJournalAdapter>): Promise<{ paths: ReturnType<typeof resolveRunJournalPaths>; base: RunJournal }> {
	const base = journal();
	const created = await adapter.createActive(root, base);
	if (created.kind !== "created") throw new Error(`could not create active fixture: ${JSON.stringify(created)}`);
	return { paths: resolveRunJournalPaths(root), base };
}

async function createPrevious(root: string, adapter: ReturnType<typeof createRunJournalAdapter>, base: RunJournal): Promise<void> {
	const next = advanceRunJournal(base, new Date("2026-09-21T10:00:01.000Z"), () => undefined);
	const replaced = await adapter.replaceActive(root, next);
	if (replaced.kind !== "replaced") throw new Error(`could not create previous fixture: ${JSON.stringify(replaced)}`);
}

async function legacyBytes(path: string): Promise<string> {
	const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
	value.schemaVersion = 0;
	return `${JSON.stringify(value)}\n`;
}

async function assertNoRecoveryEffects(counters: EffectCounters): Promise<void> {
	deepStrictEqual(counters, { herdr: 0, git: 0, process: 0, model: 0, clock: 0 });
}

it.sequential("recovers real Journal files only through typed read-only or explicit schema-only paths", async () => {
	const adapter = createRunJournalAdapter();

	{
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-journal-normal-"));
		roots.push(root);
		const fixture = await createActive(root, adapter);
		const counters: EffectCounters = { herdr: 0, git: 0, process: 0, model: 0, clock: 0 };
		const harness = registerHarness(root, adapter, counters);
		await harness.command("status", commandContext(root));
		const view = harness.presentations.at(-1);
		if (!view || view.kind !== "present") throw new Error("normal status did not present a Run");
		equal(view.journalRecovery, "normal");
		ok(view.markdown.includes("Journal: active schema v1 snapshot"));
		equal((await adapter.loadActive(root)).kind, "loaded");
		equal((await readFile(fixture.paths.activePath, "utf8")), serializeRunJournal(fixture.base));
		await assertNoRecoveryEffects(counters);
	}

	{
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-journal-recovered-"));
		roots.push(root);
		const fixture = await createActive(root, adapter);
		await createPrevious(root, adapter, fixture.base);
		const activeBefore = await readFile(fixture.paths.activePath, "utf8");
		const previousBefore = await readFile(fixture.paths.previousPath, "utf8");
		await writeFile(fixture.paths.activePath, "{ damaged active snapshot\n");
		const activeDamaged = await readFile(fixture.paths.activePath, "utf8");
		const counters: EffectCounters = { herdr: 0, git: 0, process: 0, model: 0, clock: 0 };
		const harness = registerHarness(root, adapter, counters);
		if (!harness.sessionStart) throw new Error("session_start was not registered");
		await harness.sessionStart({}, sessionContext(root));
		const loaded = await adapter.loadActive(root);
		if (loaded.kind !== "recovered") throw new Error(`expected recovered load, got ${loaded.kind}`);
		equal(loaded.mode, "recovered");
		equal(loaded.previous.path, fixture.paths.previousPath);
		equal(loaded.previous.sha256, hash(previousBefore));
		equal(loaded.active.sha256, hash(activeDamaged));
		await harness.command("status", commandContext(root));
		const view = harness.presentations.at(-1);
		if (!view || view.kind !== "present") throw new Error("recovered status did not present a Run");
		equal(view.journalRecovery, "recovered");
		ok(view.markdown.includes("Journal recovery: degraded"));
		await harness.command("resume", commandContext(root));
		equal(harness.resumeResults.at(-1)?.kind, "recovered");
		equal(await readFile(fixture.paths.activePath, "utf8"), activeDamaged);
		equal(await readFile(fixture.paths.previousPath, "utf8"), previousBefore);
		notEqualBytes(activeBefore, activeDamaged);
		await assertNoRecoveryEffects(counters);
	}

	{
		for (const previousKind of ["malformed", "symlink"] as const) {
			const root = await mkdtemp(join(tmpdir(), `pi-herdr-journal-both-invalid-${previousKind}-`));
			roots.push(root);
			const fixture = await createActive(root, adapter);
			await createPrevious(root, adapter, fixture.base);
			await writeFile(fixture.paths.activePath, "{ damaged active snapshot\n");
			if (previousKind === "malformed") await writeFile(fixture.paths.previousPath, "not-json\n");
			else {
				await writeFile(join(root, "previous-target.json"), "not-json\n");
				await rm(fixture.paths.previousPath, { force: true });
				await symlink(join(root, "previous-target.json"), fixture.paths.previousPath);
			}
			const activeBefore = await readFile(fixture.paths.activePath, "utf8");
			const previousBefore = previousKind === "malformed" ? await readFile(fixture.paths.previousPath, "utf8") : await readlink(fixture.paths.previousPath);
			const counters: EffectCounters = { herdr: 0, git: 0, process: 0, model: 0, clock: 0 };
			const harness = registerHarness(root, adapter, counters);
			await harness.command("status", commandContext(root));
			const view = harness.presentations.at(-1);
			if (!view || view.kind !== "present") throw new Error("read-only status did not present a Run");
			equal(view.journalRecovery, "read-only");
			ok(view.markdown.includes("Journal recovery: read-only"));
			await harness.command("resume", commandContext(root));
			equal(harness.resumeResults.at(-1)?.kind, "invalid");
			equal(await readFile(fixture.paths.activePath, "utf8"), activeBefore);
			if (previousKind === "malformed") equal(await readFile(fixture.paths.previousPath, "utf8"), previousBefore);
			else equal(await readlink(fixture.paths.previousPath), previousBefore);
			await assertNoRecoveryEffects(counters);
		}
	}

	{
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-journal-newer-"));
		roots.push(root);
		const fixture = await createActive(root, adapter);
		await createPrevious(root, adapter, fixture.base);
		const newer = JSON.parse(await readFile(fixture.paths.activePath, "utf8")) as Record<string, unknown>;
		newer.schemaVersion = 2;
		await writeFile(fixture.paths.activePath, `${JSON.stringify(newer)}\n`);
		const activeBefore = await readFile(fixture.paths.activePath, "utf8");
		const previousBefore = await readFile(fixture.paths.previousPath, "utf8");
		const counters: EffectCounters = { herdr: 0, git: 0, process: 0, model: 0, clock: 0 };
		const harness = registerHarness(root, adapter, counters);
		const loaded = await adapter.loadActive(root);
		if (loaded.kind !== "invalid") throw new Error(`expected invalid newer load, got ${loaded.kind}`);
		equal(loaded.reason, "newer-schema");
		await harness.command("status", commandContext(root));
		const view = harness.presentations.at(-1);
		if (!view || view.kind !== "present") throw new Error("newer-schema status did not present a Run");
		ok(view.markdown.includes("newer schema"));
		await harness.command("resume", commandContext(root));
		equal(harness.resumeResults.at(-1)?.kind, "invalid");
		equal(await readFile(fixture.paths.activePath, "utf8"), activeBefore);
		equal(await readFile(fixture.paths.previousPath, "utf8"), previousBefore);
		await assertNoRecoveryEffects(counters);
	}

	{
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-journal-older-unregistered-"));
		roots.push(root);
		const fixture = await createActive(root, adapter);
		await createPrevious(root, adapter, fixture.base);
		await writeFile(fixture.paths.activePath, await legacyBytes(fixture.paths.activePath));
		const activeBefore = await readFile(fixture.paths.activePath, "utf8");
		const previousBefore = await readFile(fixture.paths.previousPath, "utf8");
		const counters: EffectCounters = { herdr: 0, git: 0, process: 0, model: 0, clock: 0 };
		const harness = registerHarness(root, adapter, counters);
		const loaded = await adapter.loadActive(root);
		if (loaded.kind !== "invalid") throw new Error(`expected invalid older load, got ${loaded.kind}`);
		equal(loaded.reason, "older-schema");
		await harness.command("status", commandContext(root));
		const view = harness.presentations.at(-1);
		if (!view || view.kind !== "present") throw new Error("older-schema status did not present a Run");
		ok(view.markdown.includes("older schema"));
		await harness.command("resume", commandContext(root));
		equal(harness.resumeResults.at(-1)?.kind, "invalid");
		equal(await readFile(fixture.paths.activePath, "utf8"), activeBefore);
		equal(await readFile(fixture.paths.previousPath, "utf8"), previousBefore);
		await assertNoRecoveryEffects(counters);
	}

	const migration: RunJournalMigration = {
		id: "fixture-v0-to-v1",
		fromVersion: 0,
		targetVersion: 1,
		migrate(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("legacy envelope is not an object");
			return { ...value, schemaVersion: 1 };
		},
	};

	{
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-journal-migration-"));
		roots.push(root);
		const registeredAdapter = createRunJournalAdapter({ migrations: new Map([[0, migration]]) });
		const fixture = await createActive(root, registeredAdapter);
		const old = await legacyBytes(fixture.paths.activePath);
		await writeFile(fixture.paths.activePath, old);
		const counters: EffectCounters = { herdr: 0, git: 0, process: 0, model: 0, clock: 0 };
		const harness = registerHarness(root, registeredAdapter, counters, new Map([[0, migration]]));
		const ready = await registeredAdapter.loadActive(root);
		if (ready.kind !== "migration-ready") throw new Error(`expected migration-ready load, got ${ready.kind}`);
		equal(ready.mode, "recovered");
		equal(ready.migration.id, migration.id);
		await harness.command("status", commandContext(root));
		const view = harness.presentations.at(-1);
		if (!view || view.kind !== "present") throw new Error("migration-ready status did not present a Run");
		equal(view.journalRecovery, "recovered");
		await harness.command("resume", commandContext(root));
		equal(harness.resumeResults.at(-1)?.kind, "migration-applied");
		equal(await readFile(fixture.paths.previousPath, "utf8"), old);
		equal(await readFile(fixture.paths.activePath, "utf8"), serializeRunJournal(fixture.base));
		const normal = await registeredAdapter.loadActive(root);
		equal(normal.kind, "loaded");
		await assertNoRecoveryEffects(counters);
	}

	{
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-journal-migration-refused-"));
		roots.push(root);
		const registeredAdapter = createRunJournalAdapter({ migrations: new Map([[0, migration]]) });
		const fixture = await createActive(root, registeredAdapter);
		const old = await legacyBytes(fixture.paths.activePath);
		await writeFile(fixture.paths.activePath, old);
		await writeFile(fixture.paths.previousPath, "existing previous bytes\n");
		const activeBefore = await readFile(fixture.paths.activePath, "utf8");
		const previousBefore = await readFile(fixture.paths.previousPath, "utf8");
		const counters: EffectCounters = { herdr: 0, git: 0, process: 0, model: 0, clock: 0 };
		const harness = registerHarness(root, registeredAdapter, counters, new Map([[0, migration]]));
		await harness.command("resume", commandContext(root));
		equal(harness.resumeResults.at(-1)?.kind, "migration-failed");
		equal(await readFile(fixture.paths.activePath, "utf8"), activeBefore);
		equal(await readFile(fixture.paths.previousPath, "utf8"), previousBefore);
		await assertNoRecoveryEffects(counters);
	}
});

function notEqualBytes(left: string, right: string): void {
	if (left === right) throw new Error("expected distinct snapshot bytes");
}
