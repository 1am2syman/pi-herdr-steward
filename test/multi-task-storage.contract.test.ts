import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRunJournalAdapter } from "../src/adapters.ts";
import { buildInitialRunJournal, deserializeRunJournal, evaluateCompletionGate, serializeRunJournal, type RunDraft, type RunJournal } from "../src/run.ts";
import { validateRecoveryDefaults, type ProjectModelPlans, type RecoveryDefaults } from "../src/config.ts";

const roots: string[] = [];
const base = "0123456789abcdef0123456789abcdef01234567";
const models: ProjectModelPlans = { builder: { primary: { model: "builder/primary", thinkingLevel: "high" }, fallbacks: [] }, reviewer: { primary: { model: "reviewer/primary", thinkingLevel: "high" }, fallbacks: [] } };
const settings: RecoveryDefaults = { passiveInspectionIntervalSeconds: 301, secondInspectionAndNudgeIntervalSeconds: 302, nudgeGracePeriodSeconds: 121, externalCommandWarningThresholdSeconds: 1801, maximumActiveTasks: 2, transientRetryLimit: 1, reworkCycleLimit: 4 };

function draft(): RunDraft {
	return { declaredOutcome: "two changes", tasks: [
		{ requiredOutcome: "a", allowedScope: ["src/a"], expectedArtifacts: [{ kind: "git-commit" }], verification: { kind: "command", command: "true" }, reviewRequired: true },
		{ requiredOutcome: "b", allowedScope: ["src/b"], expectedArtifacts: [{ kind: "git-commit" }], verification: { kind: "command", command: "true" }, reviewRequired: true },
	], modelPlan: models, effectiveSettings: settings, finalVerification: { kind: "command", command: "true" } };
}

function journal(): RunJournal {
	return buildInitialRunJournal({ identity: { runId: "run-20260919T000000000Z-storage", createdAt: "2026-09-19T00:00:00.000Z" }, controllerSessionId: "controller", draft: draft(), modelPlan: models, effectiveSettings: settings, integrationBase: { kind: "git", branch: "main", revision: base } });
}

afterEach(async () => { for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true }); });

describe("ticket-13 schema and storage boundaries", () => {
	it("rejects duplicate IDs, malformed task collections, and unknown task keys without normalization", () => {
		const duplicate = structuredClone(journal()) as unknown as Record<string, unknown>;
		const run = duplicate.run as Record<string, unknown>;
		const tasks = run.tasks as Array<Record<string, unknown>>;
		tasks[1] = { ...tasks[1], contract: { ...(tasks[1]!.contract as Record<string, unknown>), id: "task-01" } };
		expect(deserializeRunJournal(JSON.stringify(duplicate)).value).toBeUndefined();
		const unknown = structuredClone(journal()) as unknown as Record<string, unknown>;
		const unknownTasks = (unknown.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>;
		unknownTasks[0] = { ...unknownTasks[0], unexpected: true };
		expect(deserializeRunJournal(JSON.stringify(unknown)).value).toBeUndefined();
		const empty = structuredClone(journal()) as unknown as Record<string, unknown>;
		(empty.run as Record<string, unknown>).tasks = [];
		expect(deserializeRunJournal(JSON.stringify(empty)).value).toBeUndefined();
	});

	it("rejects both monitor representations and preserves legacy bytes when no additive fields are present", () => {
		const legacy = journal();
		const bytes = serializeRunJournal(legacy);
		expect(serializeRunJournal(deserializeRunJournal(bytes).value!).toString()).toBe(bytes);
		const both = structuredClone(legacy) as unknown as Record<string, unknown>;
		const run = both.run as Record<string, unknown>;
		run.monitor = {};
		run.monitors = [];
		expect(deserializeRunJournal(JSON.stringify(both)).value).toBeUndefined();
	});

	it("uses storage CAS and no-clobber behavior for stale replacements", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-coordination-storage-"));
		roots.push(root);
		const store = createRunJournalAdapter();
		const initial = journal();
		expect((await store.createActive(root, initial)).kind).toBe("created");
		const stale = structuredClone(initial);
		stale.journalRevision = 2;
		stale.run.updatedAt = "2026-09-19T00:00:01.000Z";
		const result = await store.replaceActive(root, stale);
		expect(result.kind).toBe("replaced");
		const staleAgain = structuredClone(initial);
		staleAgain.journalRevision = 2;
		staleAgain.run.updatedAt = "2026-09-19T00:00:02.000Z";
		expect((await store.replaceActive(root, staleAgain)).kind).toBe("invalid-candidate");
		const activePath = join(root, ".pi", "steward", "active-run.json");
		const bytes = await readFile(activePath, "utf8");
		expect(bytes).toContain('"journalRevision": 2');
		expect(await readFile(activePath, "utf8")).toBe(bytes);
	});

	it("freezes the accepted cap and rejects zero through the existing config validator", async () => {
		expect(validateRecoveryDefaults({ ...settings, maximumActiveTasks: 0 }, "recovery").value).toBeUndefined();
		const max = buildInitialRunJournal({ identity: { runId: "run-20260919T000000000Z-max", createdAt: "2026-09-19T00:00:00.000Z" }, controllerSessionId: "controller", draft: { ...draft(), effectiveSettings: { ...settings, maximumActiveTasks: Number.MAX_SAFE_INTEGER } }, modelPlan: models, effectiveSettings: { ...settings, maximumActiveTasks: Number.MAX_SAFE_INTEGER }, integrationBase: { kind: "git", branch: "main", revision: base } });
		expect(max.run.effectiveSettings.maximumActiveTasks).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("does not pass the multi-Task Completion Gate before the ordered integration prefix exists", () => {
		const result = evaluateCompletionGate(journal(), { branch: "main", head: base, dirtyPaths: [], operationMarkers: [], rangeExact: true });
		expect(result.passed).toBe(false);
		if (!result.passed) expect(result.failures).toEqual(expect.arrayContaining(["one exact passing final-verification result is required"]));
	});
});
