import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { it } from "vitest";

import {
	buildInitialRunJournal,
	cloneRunJournal,
	decodeRunJournal,
	deserializeRunJournal,
	serializeRunJournal,
	validateRunJournal,
	type RunDraft,
	type RunJournal,
} from "../src/run.ts";
import type { ProjectModelPlans, RecoveryDefaults } from "../src/config.ts";

const settings: RecoveryDefaults = {
	passiveInspectionIntervalSeconds: 301,
	secondInspectionAndNudgeIntervalSeconds: 302,
	nudgeGracePeriodSeconds: 121,
	externalCommandWarningThresholdSeconds: 1801,
	maximumActiveTasks: 1,
	transientRetryLimit: 1,
	reworkCycleLimit: 5,
};

const models: ProjectModelPlans = {
	builder: { primary: { model: "builder/main", thinkingLevel: "high" }, fallbacks: [] },
	reviewer: { primary: { model: "reviewer/main", thinkingLevel: "high" }, fallbacks: [] },
};

const draft: RunDraft = {
	declaredOutcome: "Reviewable change",
	tasks: [{ requiredOutcome: "Implement the change", allowedScope: ["src"], expectedArtifacts: [{ kind: "git-commit" }], verification: { kind: "command", command: "npm test" }, reviewRequired: true }],
	modelPlan: models,
	effectiveSettings: settings,
	finalVerification: { kind: "command", command: "npm test" },
};

function initial(): RunJournal {
	return buildInitialRunJournal({
		identity: { runId: "run-rework-test", createdAt: "2026-09-18T00:00:00.000Z" },
		controllerSessionId: "controller-session",
		draft,
		modelPlan: models,
		effectiveSettings: settings,
		integrationBase: { kind: "git", branch: "main", revision: "0123456789abcdef0123456789abcdef01234567" },
	});
}

it("ticket-07 freezes the rework limit, keeps old journals decodable, and rejects impossible task states", () => {
	const journal = initial();
	equal(journal.run.effectiveSettings.reworkCycleLimit, 5);
	equal(journal.run.tasks[0]?.reworkCycles, 0);
	const bytes = serializeRunJournal(journal);
	const decoded = deserializeRunJournal(bytes);
	ok(decoded.value);
	deepStrictEqual(decoded.value, journal);
	const cloned = cloneRunJournal(journal);
	deepStrictEqual(cloned, journal);

	const oldShape = JSON.parse(bytes) as Record<string, unknown>;
	const oldDecoded = decodeRunJournal(oldShape);
	ok(oldDecoded.value);
	const task = (oldShape.run as { tasks: Array<Record<string, unknown>> }).tasks[0]!;
	delete task.approval;
	ok(decodeRunJournal(oldShape).value);

	const impossiblePhase = JSON.parse(bytes) as Record<string, unknown>;
	(impossiblePhase.run as { tasks: Array<Record<string, unknown>> }).tasks[0]!.phase = "reworking";
	ok(!validateRunJournal(impossiblePhase).value);
	const impossibleCounter = JSON.parse(bytes) as Record<string, unknown>;
	(impossibleCounter.run as { tasks: Array<Record<string, unknown>> }).tasks[0]!.reworkCycles = 6;
	ok(!validateRunJournal(impossibleCounter).value);
	const extraKey = JSON.parse(bytes) as Record<string, unknown>;
	(extraKey.run as Record<string, unknown>).unexpected = true;
	ok(!validateRunJournal(extraKey).value);
});
