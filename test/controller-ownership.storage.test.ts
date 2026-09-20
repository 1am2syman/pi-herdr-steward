import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { afterEach, describe, it } from "vitest";

import { createRunJournalAdapter } from "../src/adapters.ts";
import { resolveRunJournalPaths } from "../src/run-journal-store.ts";
import {
	advanceRunJournal,
	buildInitialRunJournal,
	cloneRunJournal,
	serializeRunJournal,
	validateRunJournal,
	type RunDraft,
	type RunJournal,
} from "../src/run.ts";
import type { ProjectModelPlans, RecoveryDefaults } from "../src/config.ts";

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
		declaredOutcome: "Preserve the storage contract",
		tasks: [{ requiredOutcome: "Persist one bounded change", allowedScope: ["src"], expectedArtifacts: [{ kind: "file", path: "src/change.ts" }], verification: { kind: "command", command: "true" }, reviewRequired: false }],
		modelPlan: models,
		effectiveSettings: settings,
		finalVerification: { kind: "command", command: "true" },
	};
}

function initial(controllerSessionId: string): RunJournal {
	return buildInitialRunJournal({
		identity: { runId: "run-20260920T000000000Z-storage", createdAt },
		controllerSessionId,
		draft: draft(),
		modelPlan: models,
		effectiveSettings: settings,
		integrationBase: { kind: "none" },
	});
}

describe("Controller ownership storage", () => {
	it("round-trips and deep-clones initial and takeover lease branches", () => {
		const owner = initial("controller-a");
		const lease = owner.run.controllerLease;
		ok(lease);
		equal(lease.acquiredJournalRevision, 1);
		equal(lease.acquiredAt, createdAt);
		ok(!lease.takeover);

		const takeover = advanceRunJournal(owner, new Date("2026-09-20T00:00:00.001Z"), (next) => {
			next.run.controllerSessionId = "controller-b";
			next.run.controllerLease = {
				sessionId: "controller-b",
				leaseId: "lease-bbbbbbbb",
				acquiredAt: "2026-09-20T00:00:00.001Z",
				acquiredJournalRevision: 2,
				takeover: {
					previousSessionId: "controller-a",
					previousLeaseId: lease.leaseId,
					reconciledAt: createdAt,
					basisJournalRevision: 1,
					reconciliationSha256: `sha256:${"a".repeat(64)}`,
					pendingAction: { kind: "admit-task", taskId: "task-01" },
				},
			};
		});
		const validated = validateRunJournal(takeover);
		ok(validated.value, JSON.stringify(validated.diagnostics));
		deepStrictEqual(validated.value, takeover);
		const cloned = cloneRunJournal(takeover);
		deepStrictEqual(cloned, takeover);
		if (!cloned.run.controllerLease?.takeover) throw new Error("takeover lease was not cloned");
		cloned.run.controllerLease.takeover.pendingAction = { kind: "none" };
		equal(takeover.run.controllerLease?.takeover?.pendingAction.kind, "admit-task");
	});

	it("preserves legacy schema-v1 bytes when controllerLease is absent", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-ownership-storage-"));
		roots.push(root);
		const journal = initial("legacy-controller");
		const raw = JSON.parse(serializeRunJournal(journal)) as { run: Record<string, unknown> };
		delete raw.run.controllerLease;
		const legacyBytes = `${JSON.stringify(raw, null, 2)}\n`;
		const paths = resolveRunJournalPaths(root);
		await mkdir(paths.stewardDirectory, { recursive: true });
		await writeFile(paths.activePath, legacyBytes, "utf8");
		const store = createRunJournalAdapter();
		const loaded = await store.loadActive(root);
		ok(loaded.kind === "loaded", loaded.kind === "invalid" ? JSON.stringify(loaded.diagnostics) : "legacy Journal missing");
		if (loaded.kind !== "loaded") return;
		equal(serializeRunJournal(loaded.journal), legacyBytes);
		ok(!loaded.journal.run.controllerLease);

		const winner = advanceRunJournal(loaded.journal, new Date("2026-09-20T00:00:00.001Z"), () => undefined);
		const replaced = await store.replaceActive(root, winner);
		equal(replaced.kind, "replaced");
		const activeBefore = await readFile(paths.activePath, "utf8");
		const previousBefore = await readFile(paths.previousPath, "utf8");
		const stale = advanceRunJournal(loaded.journal, new Date("2026-09-20T00:00:00.001Z"), (next) => { next.run.declaredOutcome = "stale candidate"; });
		const rejected = await store.replaceActive(root, stale);
		equal(rejected.kind, "invalid-candidate");
		equal(await readFile(paths.activePath, "utf8"), activeBefore);
		equal(await readFile(paths.previousPath, "utf8"), previousBefore);
	});

	it("rejects malformed, mismatched, same-owner, and foreign pending-action leases", () => {
		const baseJournal = initial("controller-a");
		const takeover = advanceRunJournal(baseJournal, new Date("2026-09-20T00:00:00.001Z"), (next) => {
			next.run.controllerSessionId = "controller-b";
			next.run.controllerLease = {
				sessionId: "controller-b",
				leaseId: "lease-bbbbbbbb",
				acquiredAt: "2026-09-20T00:00:00.001Z",
				acquiredJournalRevision: 2,
				takeover: {
					previousSessionId: "controller-a",
					previousLeaseId: "lease-aaaaaaaa",
					reconciledAt: createdAt,
					basisJournalRevision: 1,
					reconciliationSha256: `sha256:${"b".repeat(64)}`,
					pendingAction: { kind: "admit-task", taskId: "task-01" },
				},
			};
		});
		const cases: Array<[string, (raw: Record<string, any>) => void]> = [
			["unknown lease key", (raw) => { raw.run.controllerLease.unexpected = true; }],
			["session mismatch", (raw) => { raw.run.controllerLease.sessionId = "other"; }],
			["same owner", (raw) => { raw.run.controllerLease.takeover.previousSessionId = "controller-b"; }],
			["bad hash", (raw) => { raw.run.controllerLease.takeover.reconciliationSha256 = "sha256:UPPER"; }],
			["foreign pending task", (raw) => { raw.run.controllerLease.takeover.pendingAction = { kind: "admit-task", taskId: "task-foreign" }; }],
			["impossible basis", (raw) => { raw.run.controllerLease.takeover.basisJournalRevision = 2; }],
		];
		for (const [label, mutate] of cases) {
			const raw = JSON.parse(JSON.stringify(takeover)) as Record<string, any>;
			mutate(raw);
			const result = validateRunJournal(raw, `${label}.json`);
			ok(!result.value && result.diagnostics.length > 0, `${label} unexpectedly validated`);
		}
	});
});
