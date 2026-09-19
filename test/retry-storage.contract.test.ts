import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { afterEach, it } from "vitest";

import { createRunJournalStore } from "../src/run-journal-store.ts";
import { advanceRunJournal, buildInitialRunJournal, cloneRunJournal, deserializeRunJournal, serializeRunJournal, validateRunJournal, type BuilderAttemptRecord, type InfrastructureOutcome, type RunJournal } from "../src/run.ts";
import type { ProjectModelPlans, RecoveryDefaults } from "../src/config.ts";

const roots: string[] = [];
const revision = "0123456789abcdef0123456789abcdef01234567";
const plans: ProjectModelPlans = {
	builder: { primary: { model: "provider/primary", thinkingLevel: "high" }, fallbacks: [{ model: "provider/fallback", thinkingLevel: "medium" }] },
	reviewer: { primary: { model: "reviewer/primary", thinkingLevel: "medium" }, fallbacks: [] },
};
const settings: RecoveryDefaults = {
	passiveInspectionIntervalSeconds: 10,
	secondInspectionAndNudgeIntervalSeconds: 20,
	nudgeGracePeriodSeconds: 5,
	externalCommandWarningThresholdSeconds: 30,
	maximumActiveTasks: 1,
	transientRetryLimit: 2,
	reworkCycleLimit: 2,
};
const preparedAt = "2026-09-19T00:00:01.000Z";
const observedAt = "2026-09-19T00:00:03.000Z";
const pathRoot = "/tmp/retry-storage/run/tasks/task-01/attempts/attempt-01";
const assignmentPath = `${pathRoot}/assignment.json`;
const reportPath = `${pathRoot}/report.md`;
const evidenceDirectory = `${pathRoot}/evidence`;
const sha = (letter: string) => `sha256:${letter.repeat(64)}`;

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function baseJournal(): RunJournal {
	return buildInitialRunJournal({
		identity: { runId: "run-20260919T000000000Z-retry", createdAt: "2026-09-19T00:00:00.000Z" },
		controllerSessionId: "retry-storage",
		draft: {
			declaredOutcome: "Retain transient recovery evidence",
			tasks: [{ requiredOutcome: "Keep the code change", allowedScope: ["src"], expectedArtifacts: [{ kind: "git-commit" }], verification: { kind: "command", command: "npm test" }, reviewRequired: false }],
			modelPlan: plans,
			effectiveSettings: settings,
			finalVerification: { kind: "command", command: "npm test" },
		},
		modelPlan: plans,
		effectiveSettings: settings,
		integrationBase: { kind: "git", branch: "main", revision },
	});
}

function outcome(kind: InfrastructureOutcome["kind"]): InfrastructureOutcome {
	const exactMissing = kind === "unexpected-process-exit";
	return {
		kind,
		stage: kind === "agent-startup-failure" ? "agent-start" : kind === "herdr-command-failure" ? "pane-split" : kind === "unexpected-process-exit" ? "agent-runtime" : "agent-prompt",
		observedAt,
		code: exactMissing ? "agent_not_found" : kind,
		diagnostic: "bounded structured infrastructure fact",
		source: exactMissing ? "exact-agent-missing" : "typed-herdr-result",
		stop: { phase: "not-required", reason: "already-missing" },
	};
}

function transientJournal(kind: InfrastructureOutcome["kind"]): RunJournal {
	const journal = baseJournal();
	const exactMissing = kind === "unexpected-process-exit";
	const task = journal.run.tasks[0]!;
	const identity = { name: "steward-b-abcdef12-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" };
	const attempt: BuilderAttemptRecord = {
		id: "attempt-01",
		role: "builder",
		state: "ended-error",
		preparedAt,
		activatedAt: "2026-09-19T00:00:02.000Z",
		actualModel: { ...plans.builder.primary },
		specificationHash: task.specificationHash,
		baseRevision: revision,
		assignmentPath,
		reportPath,
		evidenceDirectory,
		dispatch: { phase: "prompted", branch: "steward/run/task/attempt-01", agentName: identity.name, worktreePath: "/tmp/retry-storage/worktree", workspaceId: identity.workspaceId, paneId: identity.paneId, terminalId: identity.terminalId, assignmentSha256: sha("a"), promptedAt: "2026-09-19T00:00:02.000Z" },
		recovery: {
			live: exactMissing ? { observedAt, kind: "missing", diagnostic: "exact identity absent" } : { observedAt, kind: "unclear", lifecycle: "unknown", diagnostic: "typed failure retained" },
			preservation: {
				observedAt,
				worktreePath: "/tmp/retry-storage/worktree",
				branch: "steward/run/task/attempt-01",
				head: revision,
				worktree: { kind: "observed", byteCount: 0, sha256: sha("b") },
				git: { head: revision, digest: sha("c") },
				assignment: { path: assignmentPath, sha256: sha("d"), size: 10 },
				report: { kind: "missing" },
				evidence: { directory: evidenceDirectory, count: 0, byteCount: 0, sha256: sha("e"), entries: [] },
			},
			infrastructure: outcome(kind),
		},
	};
	const result = validateRunJournal({ ...journal, journalRevision: 2, run: { ...journal.run, updatedAt: observedAt, tasks: [{ ...task, phase: "building", attention: "needs-user", attentionReason: "transient-fallback-unavailable", attentionDiagnostic: "No eligible approved successor was available.", attempts: [attempt] }] } });
	if (!result.value) throw new Error(result.diagnostics.map((item) => `${item.path}: ${item.message}`).join("; "));
	return result.value;
}

function transientReplacementJournal(): RunJournal {
	const journal = transientJournal("provider-network-interruption");
	const task = journal.run.tasks[0]!;
	const predecessor = task.attempts[0] as BuilderAttemptRecord;
	const successorRoot = cloneRunJournal(journal).run.tasks[0]!.attempts[0] as BuilderAttemptRecord;
	const successorPaths = {
		assignmentPath: "/tmp/retry-storage/run/tasks/task-01/attempts/attempt-02/assignment.json",
		reportPath: "/tmp/retry-storage/run/tasks/task-01/attempts/attempt-02/report.md",
		evidenceDirectory: "/tmp/retry-storage/run/tasks/task-01/attempts/attempt-02/evidence",
	};
	const successorObservedAt = "2026-09-19T00:00:06.000Z";
	const successor: BuilderAttemptRecord = {
		...successorRoot,
		id: "attempt-02",
		state: "ended-error",
		preparedAt: "2026-09-19T00:00:04.000Z",
		activatedAt: "2026-09-19T00:00:05.000Z",
		actualModel: { ...plans.builder.fallbacks[0] },
		...successorPaths,
		dispatch: { ...predecessor.dispatch, phase: "prompted", promptedAt: "2026-09-19T00:00:05.000Z" } as BuilderAttemptRecord["dispatch"],
		replacement: {
			kind: "transient-recovery",
			trigger: "provider-network-interruption",
			replacesAttemptId: predecessor.id,
			retryOrdinal: 1,
			preservedAt: "2026-09-19T00:00:04.000Z",
			modelSelection: { kind: "approved-fallback", planIndex: 1, reason: "same-model-retry-failed", skipped: [{ planIndex: 0, model: plans.builder.primary.model, codes: ["same-model-retry-failed"] }] },
		},
		recovery: {
			live: { observedAt: successorObservedAt, kind: "unclear", lifecycle: "unknown", diagnostic: "typed failure retained" },
			preservation: {
				...predecessor.recovery!.preservation!,
				observedAt: successorObservedAt,
				assignment: { path: successorPaths.assignmentPath, sha256: sha("d"), size: 10 },
				report: { kind: "missing" },
				evidence: { ...predecessor.recovery!.preservation!.evidence, directory: successorPaths.evidenceDirectory },
			},
			infrastructure: { ...outcome("provider-network-interruption"), observedAt: successorObservedAt, stop: { phase: "not-required", reason: "already-missing" } },
		},
	};
	const result = validateRunJournal({ ...journal, journalRevision: 3, run: { ...journal.run, updatedAt: successorObservedAt, tasks: [{ ...task, phase: "building", attention: "needs-user", attentionReason: "transient-fallback-unavailable", attentionDiagnostic: "No eligible approved successor was available.", attempts: [{ ...predecessor, state: "ended-error" }, successor] }] } });
	if (!result.value) throw new Error(result.diagnostics.map((item) => `${item.path}: ${item.message}`).join("; "));
	return result.value;
}

	it.sequential.each(["provider-network-interruption", "agent-startup-failure", "herdr-command-failure", "unexpected-process-exit"] as const)("round-trips the %s outcome without changing schema version", (kind) => {
	const journal = transientJournal(kind);
	const cloned = cloneRunJournal(journal);
	deepStrictEqual(cloned, journal);
	const decoded = deserializeRunJournal(serializeRunJournal(journal));
	ok(decoded.value);
	if (decoded.value) {
		equal(decoded.value.schemaVersion, 1);
		equal(decoded.value.run.tasks[0]?.attempts[0]?.recovery?.infrastructure?.kind, kind);
	}
});

it("rejects ended-error without an outcome and stop-before-preservation", () => {
	const valid = transientJournal("provider-network-interruption");
	const withoutOutcome = cloneRunJournal(valid);
	delete withoutOutcome.run.tasks[0]!.attempts[0]!.recovery!.infrastructure;
	const missingOutcome = validateRunJournal(withoutOutcome);
	ok(missingOutcome.diagnostics.length > 0);

	const stoppedEarly = cloneRunJournal(valid);
	const recovery = stoppedEarly.run.tasks[0]!.attempts[0]!.recovery!;
	delete recovery.preservation;
	recovery.infrastructure = { ...outcome("provider-network-interruption"), stop: { phase: "intended", intendedAt: observedAt, agent: { name: "steward-b-abcdef12-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" } } };
	const invalidStop = validateRunJournal(stoppedEarly);
	ok(invalidStop.diagnostics.some((item) => item.message.includes("preservation")));
});

it("rejects unknown outcome fields and false exact-missing identity", () => {
	const unknown = JSON.parse(JSON.stringify(transientJournal("provider-network-interruption"))) as Record<string, any>;
	unknown.run.tasks[0].attempts[0].recovery.infrastructure.extra = true;
	ok(validateRunJournal(unknown).diagnostics.length > 0);

	const falseMissing = JSON.parse(JSON.stringify(transientJournal("unexpected-process-exit"))) as Record<string, any>;
	falseMissing.run.tasks[0].attempts[0].recovery.infrastructure.stop = { phase: "not-required", reason: "already-missing" };
	falseMissing.run.tasks[0].attempts[0].dispatch = { phase: "worktree-intended", branch: "steward/run/task/attempt-01", agentName: "steward-b-abcdef12-01-01" };
	ok(validateRunJournal(falseMissing).diagnostics.length > 0);
});

it("rejects a transient link with a backward or wrong frozen model-plan index", () => {
	const invalid = JSON.parse(JSON.stringify(transientReplacementJournal())) as Record<string, any>;
	invalid.run.tasks[0].attempts[1].replacement.modelSelection.planIndex = 0;
	ok(validateRunJournal(invalid).diagnostics.some((item) => item.message.includes("frozen role plan") || item.message.includes("strictly forward")));
});

type InvalidRetryJournalCase = { name: string; candidate: () => Record<string, any> };

const invalidRetryJournalCases: InvalidRetryJournalCase[] = [
	{
		name: "outcome plus finalized evidence",
		candidate: () => {
			const value = JSON.parse(JSON.stringify(transientJournal("provider-network-interruption"))) as Record<string, any>;
			value.run.tasks[0].attempts[0].evidence = { phase: "finalized" };
			return value;
		},
	},
	{
		name: "superseded without an immediate successor",
		candidate: () => {
			const value = JSON.parse(JSON.stringify(transientJournal("provider-network-interruption"))) as Record<string, any>;
			value.run.tasks[0].attempts[0].state = "superseded";
			return value;
		},
	},
	{
		name: "ordinal gap",
		candidate: () => {
			const value = JSON.parse(JSON.stringify(transientReplacementJournal())) as Record<string, any>;
			value.run.tasks[0].attempts[1].replacement.retryOrdinal = 2;
			return value;
		},
	},
	{
		name: "duplicate ordinal",
		candidate: () => {
			const value = JSON.parse(JSON.stringify(transientReplacementJournal())) as Record<string, any>;
			const duplicate = JSON.parse(JSON.stringify(value.run.tasks[0].attempts[1])) as Record<string, any>;
			duplicate.id = "attempt-03";
			duplicate.preparedAt = "2026-09-19T00:00:07.000Z";
			duplicate.replacement.replacesAttemptId = "attempt-02";
			duplicate.replacement.preservedAt = duplicate.preparedAt;
			value.run.tasks[0].attempts[1].state = "superseded";
			value.run.tasks[0].attempts.push(duplicate);
			return value;
		},
	},
	{
		name: "over-limit ordinal",
		candidate: () => {
			const value = JSON.parse(JSON.stringify(transientReplacementJournal())) as Record<string, any>;
			value.run.effectiveSettings.transientRetryLimit = 0;
			return value;
		},
	},
	{
		name: "successor model mismatch",
		candidate: () => {
			const value = JSON.parse(JSON.stringify(transientReplacementJournal())) as Record<string, any>;
			value.run.tasks[0].attempts[1].actualModel = value.run.modelPlan.builder.primary;
			return value;
		},
	},
	{
		name: "replacement continuation mismatch",
		candidate: () => {
			const value = JSON.parse(JSON.stringify(transientReplacementJournal())) as Record<string, any>;
			value.run.tasks[0].attempts[1].replacement.preservedAt = "2026-09-19T00:00:05.000Z";
			return value;
		},
	},
	{
		name: "changed subject",
		candidate: () => {
			const value = JSON.parse(JSON.stringify(transientReplacementJournal())) as Record<string, any>;
			value.run.tasks[0].contract.requiredOutcome = "changed after reservation";
			return value;
		},
	},
	{
		name: "changed worktree",
		candidate: () => {
			const value = JSON.parse(JSON.stringify(transientReplacementJournal())) as Record<string, any>;
			value.run.tasks[0].attempts[1].dispatch.worktreePath = "/tmp/retry-storage/changed-worktree";
			return value;
		},
	},
	{
		name: "changed specification",
		candidate: () => {
			const value = JSON.parse(JSON.stringify(transientReplacementJournal())) as Record<string, any>;
			value.run.tasks[0].specificationHash = sha("f");
			return value;
		},
	},
	{
		name: "changed base",
		candidate: () => {
			const value = JSON.parse(JSON.stringify(transientReplacementJournal())) as Record<string, any>;
			value.run.tasks[0].attempts[1].baseRevision = "1111111111111111111111111111111111111111";
			return value;
		},
	},
	{
		name: "invalid attention",
		candidate: () => {
			const value = JSON.parse(JSON.stringify(transientJournal("provider-network-interruption"))) as Record<string, any>;
			value.run.tasks[0].attention = "none";
			return value;
		},
	},
];

it.each(invalidRetryJournalCases)("rejects the registered retry invariant: $name", ({ candidate }) => {
	ok(validateRunJournal(candidate).diagnostics.length > 0);
});

it("rejects a stale replacement candidate without clobbering the active Journal", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-retry-storage-"));
	roots.push(root);
	const store = createRunJournalStore();
	const seed = baseJournal();
	equal((await store.createActive(root, seed)).kind, "created");
	const newer = advanceRunJournal(seed, new Date("2026-09-19T00:00:02.000Z"), (candidate) => { candidate.run.declaredOutcome = "newer authoritative recovery"; });
	equal((await store.replaceActive(root, newer)).kind, "replaced");
	const stale = advanceRunJournal(seed, new Date("2026-09-19T00:00:01.000Z"), (candidate) => { candidate.run.declaredOutcome = "stale recovery"; });
	equal((await store.replaceActive(root, stale)).kind, "invalid-candidate");
	const bytes = await readFile(join(root, ".pi", "steward", "active-run.json"), "utf8");
	equal(JSON.parse(bytes).run.declaredOutcome, "newer authoritative recovery");
});
