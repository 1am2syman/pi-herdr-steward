import { createHash } from "node:crypto";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRunJournalAdapter } from "../src/adapters.ts";
import { buildInitialRunJournal, deserializeRunJournal, evaluateCompletionGate, serializeRunJournal, validateRunJournal, type BuilderAttemptRecord, type ReviewWorktreeSnapshot, type ReviewerAttemptRecord, type RunDraft, type RunJournal, type TaskRecord } from "../src/run.ts";
import { validateRecoveryDefaults, type ProjectModelPlans, type RecoveryDefaults } from "../src/config.ts";
import type { ReviewSubject } from "../src/review.ts";

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

function digest(label: string): string {
	return `sha256:${createHash("sha256").update(label, "utf8").digest("hex")}`;
}

function approvedIntegratingTask(task: TaskRecord, taskIndex: 0 | 1, head: string): TaskRecord {
	const taskId = task.contract.id;
	const directory = `/tmp/coordination-storage/${taskId}`;
	const branch = `steward/run/${taskId}/attempt-01`;
	const builderAssignment = `${directory}/attempt-01/assignment.json`;
	const builderReport = `${directory}/attempt-01/report.md`;
	const builderEvidence = `${directory}/attempt-01/evidence`;
	const builderManifestSha256 = digest(`${taskId}-builder-manifest`);
	const reviewerManifestSha256 = digest(`${taskId}-reviewer-manifest`);
	const builder: BuilderAttemptRecord = {
		id: "attempt-01", role: "builder", state: "reported", preparedAt: "2026-09-19T00:00:01.000Z", activatedAt: "2026-09-19T00:00:02.000Z", actualModel: { ...models.builder.primary }, specificationHash: task.specificationHash, baseRevision: base, assignmentPath: builderAssignment, reportPath: builderReport, evidenceDirectory: builderEvidence,
		dispatch: { phase: "prompted", branch, agentName: `steward-b-storage-${taskIndex}`, worktreePath: `${directory}/worktree`, workspaceId: `workspace-${taskId}`, paneId: `builder-pane-${taskId}`, terminalId: `builder-terminal-${taskId}`, assignmentSha256: digest(`${taskId}-assignment`), promptedAt: "2026-09-19T00:00:02.000Z" },
		evidence: { phase: "finalized", finalizedAt: "2026-09-19T00:00:03.000Z", status: "completed", reportSha256: digest(`${taskId}-builder-report`), manifestPath: `${builderEvidence}/manifest.json`, manifestSha256: builderManifestSha256, producedRevision: head },
	};
	const snapshot: ReviewWorktreeSnapshot = { head, dirtyStateFingerprint: digest(`${taskId}-snapshot`), dirtyPaths: [], operationMarkers: [] };
	const subject: ReviewSubject = { kind: "git", baseRevision: base, headRevision: head, commits: [head], builderManifestSha256 };
	const reviewer: ReviewerAttemptRecord = {
		id: "attempt-02", role: "reviewer", state: "reported", preparedAt: "2026-09-19T00:00:04.000Z", activatedAt: "2026-09-19T00:00:05.000Z", actualModel: { ...models.reviewer.primary }, specificationHash: task.specificationHash, assignmentPath: `${directory}/attempt-02/assignment.json`, reportPath: `${directory}/attempt-02/report.md`, evidenceDirectory: `${directory}/attempt-02/evidence`, subject, independence: { kind: "different-provider-family", builderProvider: "builder", reviewerProvider: "reviewer" }, worktree: { path: `${directory}/worktree`, baseline: snapshot },
		dispatch: { phase: "prompted", agentName: `steward-r-storage-${taskIndex}`, worktreePath: `${directory}/worktree`, workspaceId: `workspace-${taskId}`, paneId: `reviewer-pane-${taskId}`, terminalId: `reviewer-terminal-${taskId}`, assignmentSha256: digest(`${taskId}-reviewer-assignment`), promptedAt: "2026-09-19T00:00:05.000Z" } as ReviewerAttemptRecord["dispatch"],
		integrity: { kind: "preserved", after: snapshot },
		evidence: { phase: "finalized", finalizedAt: "2026-09-19T00:00:06.000Z", verdict: "approved", reportSha256: digest(`${taskId}-reviewer-report`), manifestPath: `${directory}/attempt-02/evidence/manifest.json`, manifestSha256: reviewerManifestSha256, subject },
	};
	return {
		...task,
		phase: "integrating",
		attention: "none",
		attempts: [builder, reviewer],
		reworkCycles: 0,
		approval: { phase: "valid", approvedAt: "2026-09-19T00:00:07.000Z", builderAttemptId: builder.id, reviewerAttemptId: reviewer.id, subject, reviewerManifestPath: reviewer.evidence!.manifestPath, reviewerManifestSha256, worktreeSnapshot: snapshot, verdict: "approved" },
	};
}

function multiIntegrationJournal(phase: "failed" | "ambiguous"): RunJournal {
	const initial = journal();
	const first = approvedIntegratingTask(initial.run.tasks[0]!, 0, "1".repeat(40));
	first.integration = { phase: "integrated", targetBranch: "main", targetRevision: base, approvedBaseRevision: base, approvedHeadRevision: "1".repeat(40), approvedCommits: ["1".repeat(40)], builderAttemptId: "attempt-01", reviewerAttemptId: "attempt-02", builderManifestSha256: first.approval!.subject.kind === "git" ? first.approval!.subject.builderManifestSha256 : digest("missing"), reviewerManifestSha256: first.approval!.reviewerManifestSha256, action: { kind: "fast-forward", argv: ["merge", "--ff-only", "--no-edit", "1".repeat(40)] }, intendedAt: "2026-09-19T00:00:08.000Z", integratedAt: "2026-09-19T00:00:09.000Z", observedHead: "1".repeat(40) };
	const second = approvedIntegratingTask(initial.run.tasks[1]!, 1, "2".repeat(40));
	const identity = { targetBranch: "main", targetRevision: "1".repeat(40), approvedBaseRevision: base, approvedHeadRevision: "2".repeat(40), approvedCommits: ["2".repeat(40)], builderAttemptId: "attempt-01", reviewerAttemptId: "attempt-02", builderManifestSha256: second.approval!.subject.kind === "git" ? second.approval!.subject.builderManifestSha256 : digest("missing"), reviewerManifestSha256: second.approval!.reviewerManifestSha256, action: { kind: "merge-commit" as const, argv: ["merge", "--no-ff", "--no-edit", "2".repeat(40)] as ["merge", "--no-ff", "--no-edit", string] } };
	second.attention = "needs-user";
	second.attentionReason = phase === "failed" ? "integration-failed" : "integration-ambiguous";
	second.attentionDiagnostic = phase === "failed" ? "The typed local merge failed; the target checkout remains unchanged." : "The typed local merge returned an ambiguous checkout observation.";
	second.integration = phase === "failed"
		? { ...identity, phase, intendedAt: "2026-09-19T00:00:10.000Z", observedAt: "2026-09-19T00:00:11.000Z", exitCode: 1, diagnostic: "scripted merge failure" }
		: { ...identity, phase, intendedAt: "2026-09-19T00:00:10.000Z", observedAt: "2026-09-19T00:00:11.000Z", exitCode: 0, diagnostic: "Checkout identity or range could not be proven after the local merge.", observed: { branch: "main", head: "9".repeat(40), dirtyPaths: [], operationMarkers: [], rangeExact: false } };
	const candidate: RunJournal = { ...initial, journalRevision: 2, run: { ...initial.run, updatedAt: "2026-09-19T00:00:11.000Z", tasks: [first, second] } };
	const validated = validateRunJournal(candidate);
	if (!validated.value || validated.diagnostics.length > 0) throw new Error(validated.diagnostics.map((item) => item.message).join("; "));
	return validated.value;
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

	it.each(["failed", "ambiguous"] as const)("accepts a valid multi-Task merge-commit %s record and rejects malformed or queue-bypassing variants", (phase) => {
		const valid = multiIntegrationJournal(phase);
		const roundTrip = deserializeRunJournal(serializeRunJournal(valid));
		expect(roundTrip.value?.run.tasks[1]?.integration?.phase).toBe(phase);
		expect(roundTrip.value?.run.tasks[1]?.integration?.action.kind).toBe("merge-commit");

		const malformedAction = JSON.parse(serializeRunJournal(valid)) as { run: { tasks: Array<{ integration: { action: { argv: string[] } } }> } };
		malformedAction.run.tasks[1]!.integration.action.argv[1] = "--ff-only";
		expect(deserializeRunJournal(JSON.stringify(malformedAction)).value).toBeUndefined();

		const malformedObservation = JSON.parse(serializeRunJournal(multiIntegrationJournal("ambiguous"))) as { run: { tasks: Array<{ integration: { observed: { rangeExact: boolean } } }> } };
		malformedObservation.run.tasks[1]!.integration.observed.rangeExact = "false" as unknown as boolean;
		expect(deserializeRunJournal(JSON.stringify(malformedObservation)).value).toBeUndefined();

		const bypass = JSON.parse(serializeRunJournal(valid)) as { run: { tasks: Array<Record<string, unknown>> } };
		const first = bypass.run.tasks[0]!;
		delete first.integration;
		first.phase = "approved";
		expect(deserializeRunJournal(JSON.stringify(bypass)).value).toBeUndefined();
	});
});
