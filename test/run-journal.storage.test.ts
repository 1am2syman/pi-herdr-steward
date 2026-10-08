import { removeFixture } from "./remove-fixture.ts";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepStrictEqual, equal, match, ok, throws } from "node:assert/strict";
import { afterEach, it, vi } from "vitest";

import { createRunJournalStore } from "../src/run-journal-store.ts";
import { createAttemptEvidenceStore, sha256Bytes } from "../src/attempt-evidence-store.ts";
import { resolveAssignmentPaths } from "../src/assignment-store.ts";
import { buildBuilderAssignment, buildInitialRunJournal, cloneRunJournal, COMPLETION_GATE_PREDICATES, deserializeBuilderAssignment, deserializeRunJournal, serializeBuilderAssignment, serializeRunJournal, serializeRunJournalAtPath, validateRunJournal, type AttemptContinuation, type AttemptRecovery, type BuilderAttemptRecord, type MonitorCheckpoint, type ReviewerAttemptRecord, type ReviewWorktreeSnapshot, type RunJournal } from "../src/run.ts";
import { buildReviewerAssignment, deserializeReviewerAssignment, serializeReviewerAssignment, type ReviewSubject } from "../src/review.ts";
import { type ProjectModelPlans, type RecoveryDefaults } from "../src/config.ts";
import type { BuilderAssignmentDocument } from "../src/run.ts";

const roots: string[] = [];
vi.setConfig({ testTimeout: 60_000 });
const plans: ProjectModelPlans = {
	builder: { primary: { model: "builder/primary", thinkingLevel: "high" }, fallbacks: [] },
	reviewer: { primary: { model: "reviewer/primary", thinkingLevel: "medium" }, fallbacks: [] },
};
const settings: RecoveryDefaults = {
	passiveInspectionIntervalSeconds: 301,
	secondInspectionAndNudgeIntervalSeconds: 302,
	nudgeGracePeriodSeconds: 121,
	externalCommandWarningThresholdSeconds: 1801,
	maximumActiveTasks: 1,
	transientRetryLimit: 1,
	reworkCycleLimit: 4,
};

afterEach(async () => {
	for (const root of roots.splice(0)) await removeFixture(root);
});

function journal(runId: string, revision = 1, updatedAt = "2026-09-17T18:00:00.000Z"): RunJournal {
	const created = buildInitialRunJournal({
		identity: { runId, createdAt: "2026-09-17T18:00:00.000Z" },
		controllerSessionId: "storage-session",
		draft: {
			declaredOutcome: "Persist the requested outcome",
			tasks: [{ requiredOutcome: "Keep an evidence record", allowedScope: ["reports/result.md"], expectedArtifacts: [{ kind: "evidence", description: "A deterministic report" }], verification: { kind: "command", command: "npm test" }, reviewRequired: true }],
			modelPlan: plans,
			effectiveSettings: settings,
			finalVerification: { kind: "command", command: "npm test" },
		},
		modelPlan: plans,
		effectiveSettings: settings,
		integrationBase: { kind: "none" },
	});
	return { ...created, journalRevision: revision, run: { ...created.run, updatedAt } };
}

function recoveryJournal(variant: "working" | "reconciled" | "awaiting" | "missing"): RunJournal {
	const base = buildInitialRunJournal({
		identity: { runId: "run-20260918T000000000Z-recovery", createdAt: "2026-09-18T00:00:00.000Z" },
		controllerSessionId: "storage-session",
		draft: {
			declaredOutcome: "Persist recovery facts",
			tasks: [{ requiredOutcome: "Keep the exact Attempt", allowedScope: ["src"], expectedArtifacts: [{ kind: "git-commit" }], verification: { kind: "command", command: "npm test" }, reviewRequired: false }],
			modelPlan: plans,
			effectiveSettings: settings,
			finalVerification: { kind: "command", command: "npm test" },
		},
		modelPlan: plans,
		effectiveSettings: settings,
		integrationBase: { kind: "git", branch: "main", revision: "0".repeat(40) },
	});
	const task = base.run.tasks[0]!;
	const assignmentPath = "/tmp/recovery-run/runs/run-20260918T000000000Z-recovery/tasks/task-01/attempt-01/assignment.json";
	const attemptBase: BuilderAttemptRecord = {
		id: "attempt-01",
		role: "builder",
		state: variant === "awaiting" ? "awaiting-report" : "active",
		preparedAt: "2026-09-18T00:00:01.000Z",
		activatedAt: "2026-09-18T00:00:02.000Z",
		actualModel: { ...plans.builder.primary },
		specificationHash: task.specificationHash,
		baseRevision: "0".repeat(40),
		assignmentPath,
		reportPath: assignmentPath.replace("assignment.json", "report.md"),
		evidenceDirectory: assignmentPath.replace("assignment.json", "evidence"),
		dispatch: ({
			phase: variant === "reconciled" ? "reconciled-active" : "prompted",
			branch: "steward/run/task/attempt-01",
			agentName: "steward-b-abcdef12-01-01",
			worktreePath: "/tmp/recovery-run/worktree",
			workspaceId: "workspace-1",
			paneId: "pane-1",
			terminalId: "terminal-1",
			assignmentSha256: `sha256:${"a".repeat(64)}`,
			...(variant === "reconciled" ? { reconciledAt: "2026-09-18T00:00:02.000Z", basis: "matching-live-agent" as const } : { promptedAt: "2026-09-18T00:00:02.000Z" }),
		} as BuilderAttemptRecord["dispatch"]),
	};
	const liveKind: AttemptRecovery["live"]["kind"] = variant === "missing" ? "missing" : variant === "awaiting" ? "settled" : variant === "reconciled" ? "unclear" : "working";
	const recovery: AttemptRecovery = {
		live: { observedAt: "2026-09-18T00:00:03.000Z", kind: liveKind, ...(liveKind === "working" ? { lifecycle: "working" as const } : liveKind === "settled" ? { lifecycle: "idle" as const } : liveKind === "unclear" ? { lifecycle: "unknown" as const, diagnostic: "bounded unclear observation" } : {}) },
		...(variant === "awaiting" ? { reportRequest: { phase: "requested" as const, intendedAt: "2026-09-18T00:00:03.000Z", requestedAt: "2026-09-18T00:00:04.000Z", agent: { name: "steward-b-abcdef12-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" }, reportPath: assignmentPath.replace("assignment.json", "report.md") } } : {}),
		...(variant === "missing" ? { preservation: { observedAt: "2026-09-18T00:00:04.000Z", worktreePath: "/tmp/recovery-run/worktree", branch: "steward/run/task/attempt-01", head: "1".repeat(40), worktree: { kind: "observed" as const, byteCount: 0, sha256: `sha256:${"b".repeat(64)}` }, git: { head: "1".repeat(40), digest: `sha256:${"c".repeat(64)}` }, assignment: { path: assignmentPath, sha256: `sha256:${"d".repeat(64)}`, size: 10 }, report: { kind: "missing" as const }, evidence: { directory: assignmentPath.replace("assignment.json", "evidence"), count: 0, byteCount: 0, sha256: `sha256:${"e".repeat(64)}`, entries: [] } } } : {}),
	};
	const value: RunJournal = { ...base, journalRevision: 2, run: { ...base.run, updatedAt: "2026-09-18T00:00:05.000Z", tasks: [{ ...task, phase: "building", attention: variant === "missing" || variant === "reconciled" ? "recovering" : "none", ...(variant === "missing" ? { attentionReason: "reconciliation-agent-missing" as const } : variant === "reconciled" ? { attentionReason: "reconciliation-live-unclear" as const } : {}), attempts: [{ ...attemptBase, recovery }] }] } };
	const validated = validateRunJournal(value);
	if (!validated.value) throw new Error(validated.diagnostics.map((item) => item.message).join("; "));
	return validated.value;
}

function maxHistoryJournal(): RunJournal {
	const maxSettings = { ...settings, reworkCycleLimit: 5 };
	const base = buildInitialRunJournal({
		identity: { runId: "run-20260917T180000000Z-maxhistory", createdAt: "2026-09-17T18:00:00.000Z" },
		controllerSessionId: "storage-session",
		draft: {
			declaredOutcome: "Persist a maximum Review history",
			tasks: [{ requiredOutcome: "Keep the code change reviewable", allowedScope: ["src/change.ts"], expectedArtifacts: [{ kind: "git-commit" }], verification: { kind: "command", command: "npm test" }, reviewRequired: true }],
			modelPlan: plans,
			effectiveSettings: maxSettings,
			finalVerification: { kind: "command", command: "npm test" },
		},
		modelPlan: plans,
		effectiveSettings: maxSettings,
		integrationBase: { kind: "git", branch: "main", revision: "0".repeat(40) },
	});
	const task = base.run.tasks[0]!;
	const timestamp = "2026-09-17T18:00:00.000Z";
	const sha = (prefix: string, index: number) => `sha256:${prefix.repeat(63)}${index.toString(16)}`;
	const revision = (index: number) => index.toString(16).padStart(40, "0");
	const snapshot = (index: number): ReviewWorktreeSnapshot => ({ head: revision(index), dirtyStateFingerprint: sha("c", index), dirtyPaths: [], operationMarkers: [] });
	const builderPaths = (attempt: number) => ({ assignmentPath: `/tmp/max-history/attempt-${String(attempt).padStart(2, "0")}/assignment.json`, reportPath: `/tmp/max-history/attempt-${String(attempt).padStart(2, "0")}/report.md`, evidenceDirectory: `/tmp/max-history/attempt-${String(attempt).padStart(2, "0")}/evidence` });
	const attempts: Array<BuilderAttemptRecord | ReviewerAttemptRecord> = [];
	const builderIdentity = { branch: "steward/run/task/attempt-01", agentName: "steward-b-abcdef12-01-01", worktreePath: "/tmp/max-history/builder", workspaceId: "workspace-1", paneId: "builder-pane", terminalId: "builder-terminal" };
	for (let cycle = 0; cycle <= 5; cycle += 1) {
		const builderNumber = cycle * 2 + 1;
		const builderPath = builderPaths(builderNumber);
		const builderManifest = sha("a", builderNumber);
		const builder: BuilderAttemptRecord = {
			id: `attempt-${String(builderNumber).padStart(2, "0")}`, role: "builder", state: "reported", preparedAt: timestamp, activatedAt: timestamp, actualModel: { ...plans.builder.primary }, specificationHash: task.specificationHash, baseRevision: "0".repeat(40), ...builderPath,
			dispatch: cycle === 0 ? { phase: "prompted", ...builderIdentity, assignmentSha256: sha("d", builderNumber), promptedAt: timestamp } : { phase: "prompted", ...builderIdentity, cycle, priorBuilderAttemptId: `attempt-${String(builderNumber - 2).padStart(2, "0")}`, priorReviewerAttemptId: `attempt-${String(builderNumber - 1).padStart(2, "0")}`, reviewedSubject: (attempts[attempts.length - 1] as ReviewerAttemptRecord).subject, reviewerManifestPath: `/tmp/max-history/attempt-${String(builderNumber - 1).padStart(2, "0")}/finalized/manifest.json`, reviewerManifestSha256: (attempts[attempts.length - 1] as ReviewerAttemptRecord).evidence!.phase === "finalized" ? (attempts[attempts.length - 1] as ReviewerAttemptRecord).evidence!.manifestSha256 : sha("b", builderNumber - 1), findings: [{ id: `finding-${cycle}`, severity: "major", summary: "Fix the protected finding.", detail: "Fix the protected finding before the next Review." }], assignmentSha256: sha("d", builderNumber), promptedAt: timestamp },
			evidence: { phase: "finalized", finalizedAt: timestamp, status: "completed", reportSha256: sha("e", builderNumber), manifestPath: `/tmp/max-history/attempt-${String(builderNumber).padStart(2, "0")}/finalized/manifest.json`, manifestSha256: builderManifest, producedRevision: revision(builderNumber) },
		};
		attempts.push(builder);
		const reviewerNumber = builderNumber + 1;
		const subject: ReviewSubject = { kind: "git", baseRevision: "0".repeat(40), headRevision: revision(builderNumber), commits: ["1".repeat(40), revision(builderNumber)], builderManifestSha256: builderManifest };
		const reviewerPath = builderPaths(reviewerNumber);
		const reviewer: ReviewerAttemptRecord = {
			id: `attempt-${String(reviewerNumber).padStart(2, "0")}`, role: "reviewer", state: "reported", preparedAt: timestamp, activatedAt: timestamp, actualModel: { ...plans.reviewer.primary }, specificationHash: task.specificationHash, ...reviewerPath, subject, independence: { kind: "different-provider-family", builderProvider: "builder", reviewerProvider: "reviewer" }, worktree: { path: "/tmp/max-history/builder", baseline: snapshot(builderNumber) }, dispatch: { phase: "prompted", agentName: `steward-r-abcdef12-01-${String(reviewerNumber).padStart(2, "0")}`, worktreePath: "/tmp/max-history/builder", workspaceId: "workspace-1", paneId: `reviewer-pane-${reviewerNumber}`, terminalId: `reviewer-terminal-${reviewerNumber}`, assignmentSha256: sha("f", reviewerNumber), promptedAt: timestamp } as ReviewerAttemptRecord["dispatch"], integrity: { kind: "preserved", after: snapshot(builderNumber) }, evidence: { phase: "finalized", finalizedAt: timestamp, verdict: cycle === 5 ? "approved" : "changes-required", reportSha256: sha("b", reviewerNumber), manifestPath: `/tmp/max-history/attempt-${String(reviewerNumber).padStart(2, "0")}/finalized/manifest.json`, manifestSha256: sha("b", reviewerNumber), subject },
		};
		attempts.push(reviewer);
	}
	const finalBuilder = attempts[10] as BuilderAttemptRecord;
	const finalReviewer = attempts[11] as ReviewerAttemptRecord;
	const finalSubject = finalReviewer.subject;
	const finalEvidence = finalReviewer.evidence;
	if (!finalEvidence || finalEvidence.phase !== "finalized") throw new Error("fixture final Reviewer evidence missing");
	const result: RunJournal = { ...base, journalRevision: 2, run: { ...base.run, updatedAt: "2026-09-17T18:12:00.000Z", tasks: [{ ...task, phase: "approved", attention: "none", attempts, reworkCycles: 5, approval: { phase: "valid", approvedAt: timestamp, builderAttemptId: finalBuilder.id, reviewerAttemptId: finalReviewer.id, subject: finalSubject, reviewerManifestPath: finalEvidence.manifestPath, reviewerManifestSha256: finalEvidence.manifestSha256, worktreeSnapshot: snapshot(11), verdict: "approved" } }] } };
	const validated = validateRunJournal(result);
	if (!validated.value) throw new Error(validated.diagnostics.map((item) => item.message).join("; "));
	return validated.value;
}

function replacementThenReworkJournal(): RunJournal {
	const raw = JSON.parse(JSON.stringify(maxHistoryJournal())) as Record<string, unknown>;
	const run = raw.run as Record<string, unknown>;
	const task = (run.tasks as Array<Record<string, unknown>>)[0]!;
	const history = task.attempts as Array<Record<string, unknown>>;
	const originalBuilder = JSON.parse(JSON.stringify(history[0])) as Record<string, unknown>;
	const originalReviewer = JSON.parse(JSON.stringify(history[1])) as Record<string, unknown>;
	const reworkBuilder = JSON.parse(JSON.stringify(history[2])) as Record<string, unknown>;
	const timestamp = "2026-09-17T18:01:00.000Z";
	const hash = `sha256:${"a".repeat(64)}`;
	const reviewerDispatch = originalReviewer.dispatch as Record<string, unknown>;
	const reviewerIdentity = {
		name: reviewerDispatch.agentName,
		workspaceId: reviewerDispatch.workspaceId,
		paneId: reviewerDispatch.paneId,
		terminalId: reviewerDispatch.terminalId,
	};
	const preservation = {
		observedAt: timestamp,
		worktreePath: reviewerDispatch.worktreePath,
		branch: "steward/run/task/attempt-02",
		head: "0".repeat(40),
		worktree: { kind: "observed", byteCount: 0, sha256: hash },
		git: { head: "0".repeat(40), digest: hash },
		assignment: { path: originalReviewer.assignmentPath, sha256: hash, size: 1 },
		report: { kind: "missing" },
		evidence: { directory: originalReviewer.evidenceDirectory, count: 0, byteCount: 0, sha256: hash, entries: [] },
	};
	const inspection = {
		attemptId: originalReviewer.id,
		role: "reviewer",
		agent: reviewerIdentity,
		lifecycle: "working",
		stateChangeSequence: null,
		terminal: { kind: "observed", byteCount: 0, sha256: hash },
		worktree: { kind: "observed", byteCount: 0, sha256: hash },
		git: { head: "0".repeat(40), digest: hash },
		assignment: { path: originalReviewer.assignmentPath, size: 1, sha256: hash },
		report: { kind: "missing" },
		evidence: { directory: originalReviewer.evidenceDirectory, count: 0, byteCount: 0, sha256: hash, entries: [] },
		process: { kind: "none", paneId: reviewerIdentity.paneId, shellPid: 101, foregroundProcessGroupId: 101, processCount: 1, digest: hash },
	};
	originalReviewer.state = "superseded";
	originalReviewer.recovery = {
		live: { observedAt: timestamp, kind: "working", lifecycle: "working" },
		preservation,
		silence: { phase: "replacement-intended", lastProgressAt: timestamp, phaseAt: timestamp, inspection, target: reviewerIdentity, intendedAt: timestamp, retryOrdinal: 1 },
	};
	const replacementReviewer = JSON.parse(JSON.stringify(originalReviewer)) as Record<string, unknown>;
	delete replacementReviewer.recovery;
	replacementReviewer.id = "attempt-03";
	replacementReviewer.state = "reported";
	replacementReviewer.preparedAt = timestamp;
	replacementReviewer.activatedAt = timestamp;
	replacementReviewer.assignmentPath = "/tmp/max-history/replacement-reviewer-03/assignment.json";
	replacementReviewer.reportPath = "/tmp/max-history/replacement-reviewer-03/report.md";
	replacementReviewer.evidenceDirectory = "/tmp/max-history/replacement-reviewer-03/evidence";
	replacementReviewer.dispatch = { ...reviewerDispatch, agentName: "steward-r-abcdef12-01-03", paneId: "reviewer-pane-03", terminalId: "reviewer-terminal-03", promptedAt: timestamp };
	replacementReviewer.replacement = { kind: "silent-agent-recovery", replacesAttemptId: "attempt-02", retryOrdinal: 1, preservedAt: timestamp };
	const replacementEvidence = replacementReviewer.evidence as Record<string, unknown>;
	const reworkDispatch = reworkBuilder.dispatch as Record<string, unknown>;
	const replacementSubject = replacementReviewer.subject;
	const replacementManifest = replacementEvidence.manifestSha256;
	reworkBuilder.id = "attempt-04";
	reworkBuilder.state = "prepared";
	delete reworkBuilder.activatedAt;
	delete reworkBuilder.evidence;
	delete reworkBuilder.recovery;
	reworkBuilder.assignmentPath = "/tmp/max-history/rework-builder-04/assignment.json";
	reworkBuilder.reportPath = "/tmp/max-history/rework-builder-04/report.md";
	reworkBuilder.evidenceDirectory = "/tmp/max-history/rework-builder-04/evidence";
	const { assignmentSha256: _assignmentSha256, promptedAt: _promptedAt, ...reworkIdentity } = reworkDispatch;
	reworkBuilder.dispatch = { ...reworkIdentity, phase: "assignment-intended", cycle: 1, priorBuilderAttemptId: "attempt-01", priorReviewerAttemptId: "attempt-03", reviewedSubject: replacementSubject, reviewerManifestSha256: replacementManifest };
	task.phase = "reworking";
	task.attention = "none";
	delete task.attentionReason;
	delete task.attentionDiagnostic;
	delete task.approval;
	task.reworkCycles = 1;
	task.attempts = [originalBuilder, originalReviewer, replacementReviewer, reworkBuilder];
	(run.effectiveSettings as Record<string, unknown>).transientRetryLimit = 2;
	run.updatedAt = "2026-09-17T18:02:00.000Z";
	const validated = validateRunJournal(raw);
	if (!validated.value) throw new Error(validated.diagnostics.map((item) => item.message).join("; "));
	return validated.value;
}

function replacementExhaustedJournal(): RunJournal {
	const raw = JSON.parse(JSON.stringify(recoveryJournal("working"))) as Record<string, unknown>;
	const run = raw.run as Record<string, unknown>;
	const task = (run.tasks as Array<Record<string, unknown>>)[0]!;
	const original = (task.attempts as Array<Record<string, unknown>>)[0]!;
	const hash = `sha256:${"a".repeat(64)}`;
	const makeAttempt = (index: number, state: "active" | "superseded", preparedAt: string, activatedAt: string, name: string, paneId: string, terminalId: string, silence: Record<string, unknown>, replacement?: Record<string, unknown>): Record<string, unknown> => {
		const assignmentPath = `/tmp/recovery-run/runs/run-20260918T000000000Z-recovery/tasks/task-01/attempt-${String(index).padStart(2, "0")}/assignment.json`;
		const attempt = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
		attempt.id = `attempt-${String(index).padStart(2, "0")}`;
		attempt.state = state;
		attempt.preparedAt = preparedAt;
		attempt.activatedAt = activatedAt;
		attempt.assignmentPath = assignmentPath;
		attempt.reportPath = assignmentPath.replace("assignment.json", "report.md");
		attempt.evidenceDirectory = assignmentPath.replace("assignment.json", "evidence");
		attempt.dispatch = { phase: "prompted", branch: "steward/run/task/attempt-01", agentName: name, worktreePath: "/tmp/recovery-run/worktree", workspaceId: "workspace-1", paneId, terminalId, assignmentSha256: hash, promptedAt: activatedAt };
		const inspectedSilence = silence.inspection as Record<string, unknown>;
		attempt.recovery = { live: { observedAt: activatedAt, kind: "working", lifecycle: "working" }, silence: { ...silence, inspection: { ...inspectedSilence, attemptId: attempt.id, agent: { name, workspaceId: "workspace-1", paneId, terminalId }, assignment: { path: assignmentPath, size: 1, sha256: hash }, evidence: { directory: attempt.evidenceDirectory, count: 0, byteCount: 0, sha256: hash, entries: [] }, process: { kind: "none", paneId, shellPid: 101 + index, foregroundProcessGroupId: 101 + index, processCount: 1, digest: hash } } } };
		if (state === "superseded") {
			(attempt.recovery as Record<string, unknown>).preservation = { observedAt: silence.intendedAt, worktreePath: "/tmp/recovery-run/worktree", branch: "steward/run/task/attempt-01", head: "0".repeat(40), worktree: { kind: "observed", byteCount: 0, sha256: hash }, git: { head: "0".repeat(40), digest: hash }, assignment: { path: assignmentPath, sha256: hash, size: 1 }, report: { kind: "missing" }, evidence: { directory: attempt.evidenceDirectory, count: 0, byteCount: 0, sha256: hash, entries: [] } };
		}
		if (replacement) attempt.replacement = replacement;
		return attempt;
	};
	const inspection = { attemptId: "attempt-01", role: "builder", agent: { name: "steward-b-abcdef12-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" }, lifecycle: "working", stateChangeSequence: null, terminal: { kind: "observed", byteCount: 0, sha256: hash }, worktree: { kind: "observed", byteCount: 0, sha256: hash }, git: { head: "0".repeat(40), digest: hash }, assignment: { path: original.assignmentPath, size: 1, sha256: hash }, report: { kind: "missing" }, evidence: { directory: original.evidenceDirectory, count: 0, byteCount: 0, sha256: hash, entries: [] }, process: { kind: "none", paneId: "pane-1", shellPid: 101, foregroundProcessGroupId: 101, processCount: 1, digest: hash } };
	const firstSilence = { phase: "replacement-intended", lastProgressAt: "2026-09-18T00:00:03.000Z", phaseAt: "2026-09-18T00:00:04.000Z", inspection, target: inspection.agent, intendedAt: "2026-09-18T00:00:04.000Z", retryOrdinal: 1 };
	const secondSilence = { phase: "replacement-intended", lastProgressAt: "2026-09-18T00:00:06.000Z", phaseAt: "2026-09-18T00:00:07.000Z", inspection: { ...inspection, attemptId: "attempt-02", agent: { ...inspection.agent, name: "steward-b-abcdef12-01-02", paneId: "pane-2", terminalId: "terminal-2" }, assignment: { path: "/tmp/recovery-run/runs/run-20260918T000000000Z-recovery/tasks/task-01/attempt-02/assignment.json", size: 1, sha256: hash }, evidence: { ...inspection.evidence, directory: "/tmp/recovery-run/runs/run-20260918T000000000Z-recovery/tasks/task-01/attempt-02/evidence" }, process: { ...inspection.process, paneId: "pane-2", shellPid: 102, foregroundProcessGroupId: 102 } }, target: { name: "steward-b-abcdef12-01-02", workspaceId: "workspace-1", paneId: "pane-2", terminalId: "terminal-2" }, intendedAt: "2026-09-18T00:00:07.000Z", retryOrdinal: 2 };
	const exhaustedSilence = { phase: "exhausted", lastProgressAt: "2026-09-18T00:00:08.000Z", phaseAt: "2026-09-18T00:00:09.000Z", inspection: { ...inspection, attemptId: "attempt-03", agent: { ...inspection.agent, name: "steward-b-abcdef12-01-03", paneId: "pane-3", terminalId: "terminal-3" }, assignment: { path: "/tmp/recovery-run/runs/run-20260918T000000000Z-recovery/tasks/task-01/attempt-03/assignment.json", size: 1, sha256: hash }, evidence: { ...inspection.evidence, directory: "/tmp/recovery-run/runs/run-20260918T000000000Z-recovery/tasks/task-01/attempt-03/evidence" }, process: { ...inspection.process, paneId: "pane-3", shellPid: 103, foregroundProcessGroupId: 103 } }, retryOrdinal: 2 };
	const first = makeAttempt(1, "superseded", "2026-09-18T00:00:01.000Z", "2026-09-18T00:00:02.000Z", "steward-b-abcdef12-01-01", "pane-1", "terminal-1", firstSilence);
	const second = makeAttempt(2, "superseded", "2026-09-18T00:00:04.000Z", "2026-09-18T00:00:05.000Z", "steward-b-abcdef12-01-02", "pane-2", "terminal-2", secondSilence, { kind: "silent-agent-recovery", replacesAttemptId: "attempt-01", retryOrdinal: 1, preservedAt: "2026-09-18T00:00:04.000Z" });
	const third = makeAttempt(3, "active", "2026-09-18T00:00:07.000Z", "2026-09-18T00:00:08.000Z", "steward-b-abcdef12-01-03", "pane-3", "terminal-3", exhaustedSilence, { kind: "silent-agent-recovery", replacesAttemptId: "attempt-02", retryOrdinal: 2, preservedAt: "2026-09-18T00:00:07.000Z" });
	(task.attempts as Array<Record<string, unknown>>).splice(0, 1, first, second, third);
	task.phase = "building";
	task.attention = "needs-user";
	task.attentionReason = "silence-recovery-exhausted";
	delete task.attentionDiagnostic;
	task.reworkCycles = 0;
	(run.effectiveSettings as Record<string, unknown>).transientRetryLimit = 2;
	run.updatedAt = "2026-09-18T00:00:10.000Z";
	const validated = validateRunJournal(raw);
	if (!validated.value) throw new Error(validated.diagnostics.map((item) => item.message).join("; "));
	return validated.value;
}

function completedHistoryJournal(): RunJournal {
	const raw = JSON.parse(JSON.stringify(maxHistoryJournal())) as Record<string, unknown>;
	const run = raw.run as Record<string, unknown>;
	const tasks = run.tasks as Array<Record<string, unknown>>;
	const task = tasks[0]!;
	const attempts = task.attempts as Array<Record<string, unknown>>;
	const builder = attempts[10]!;
	const reviewer = attempts[11]!;
	const builderEvidence = builder.evidence as Record<string, unknown>;
	const reviewerEvidence = reviewer.evidence as Record<string, unknown>;
	const subject = reviewerEvidence.subject as Record<string, unknown>;
	const head = String(subject.headRevision);
	const commits = [...(subject.commits as string[])];
	const builderManifest = String(builderEvidence.manifestSha256);
	const reviewerManifest = String(reviewerEvidence.manifestSha256);
	const checkout = { branch: "main", head, dirtyPaths: [], operationMarkers: [], rangeExact: true };
	const completionRoot = "/tmp/max-history";
	const runId = String(run.id);
	const verificationRoot = `${completionRoot}/runs/${runId}/completion/final-verification/verification-01`;
	const verification = {
		phase: "passed",
		id: "verification-01",
		command: "npm test",
		cwd: `${completionRoot}/repository`,
		logPath: `${verificationRoot}/output.log`,
		resultPath: `${verificationRoot}/result.json`,
		intendedAt: "2026-09-17T18:06:00.000Z",
		startedAt: "2026-09-17T18:06:01.000Z",
		completedAt: "2026-09-17T18:06:02.000Z",
		exitCode: 0,
		killed: false,
		logSha256: `sha256:${"d".repeat(64)}`,
		resultSha256: `sha256:${"e".repeat(64)}`,
		checkout,
	};
	task.phase = "completed";
	task.attention = "none";
	task.integration = {
		phase: "integrated",
		targetBranch: "main",
		targetRevision: "0".repeat(40),
		approvedBaseRevision: "0".repeat(40),
		approvedHeadRevision: head,
		approvedCommits: commits,
		builderAttemptId: String(builder.id),
		reviewerAttemptId: String(reviewer.id),
		builderManifestSha256: builderManifest,
		reviewerManifestSha256: reviewerManifest,
		action: { kind: "fast-forward", argv: ["merge", "--ff-only", "--no-edit", head] },
		intendedAt: "2026-09-17T18:05:00.000Z",
		integratedAt: "2026-09-17T18:05:01.000Z",
		observedHead: head,
	};
	run.finalVerificationExecution = verification;
	const reports = attempts.map((attempt) => {
		const evidence = attempt.evidence as Record<string, unknown>;
		return {
			taskId: String(task.contract && (task.contract as Record<string, unknown>).id),
			attemptId: String(attempt.id),
			role: String(attempt.role),
			sourcePath: String(attempt.reportPath),
			destinationPath: `reports/task-01/${String(attempt.id)}-${String(attempt.role)}.md`,
			size: 1,
			sha256: String(evidence.reportSha256),
		};
	});
	const prompted = new Set<string>();
	const resources: Array<Record<string, unknown>> = [];
	for (const attempt of attempts) {
		const dispatch = attempt.dispatch as Record<string, unknown>;
		const identity = `${String(attempt.role)}/${String(dispatch.agentName)}/${String(dispatch.workspaceId)}/${String(dispatch.paneId)}/${String(dispatch.terminalId)}`;
		if (prompted.has(identity)) continue;
		prompted.add(identity);
		const intendedAt = "2026-09-17T18:08:00.000Z";
		resources.push({
			role: attempt.role,
			agentName: dispatch.agentName,
			workspaceId: dispatch.workspaceId,
			paneId: dispatch.paneId,
			terminalId: dispatch.terminalId,
			state: "acknowledged",
			intendedAt,
			acknowledgedAt: "2026-09-17T18:09:00.000Z",
			acknowledgement: { name: dispatch.agentName, workspaceId: dispatch.workspaceId, tabId: `tab-${String(resources.length + 1)}`, paneId: dispatch.paneId, terminalId: dispatch.terminalId },
		});
	}
	const gate = {
		evaluatedAt: "2026-09-17T18:07:00.000Z",
		taskId: "task-01",
		integratedHead: head,
		verificationResultSha256: verification.resultSha256,
		verificationLogSha256: verification.logSha256,
		checkout,
		predicates: [...COMPLETION_GATE_PREDICATES],
	};
	run.status = "completed";
	run.updatedAt = "2026-09-17T18:12:00.000Z";
	run.completion = {
		phase: "archived",
		gate,
		resources,
		archive: {
			intendedAt: "2026-09-17T18:10:00.000Z",
			archiveDirectory: `${completionRoot}/archive`,
			runPath: `${completionRoot}/archive/run.json`,
			previousRunPath: `${completionRoot}/archive/previous-run.json`,
			manifestPath: `${completionRoot}/archive/manifest.json`,
			activeJournalSha256: `sha256:${"f".repeat(64)}`,
			previousJournalSha256: `sha256:${"0".repeat(64)}`,
			verification: { logPath: verification.logPath, resultPath: verification.resultPath, logSha256: verification.logSha256, resultSha256: verification.resultSha256 },
			reports,
		},
		archivedAt: "2026-09-17T18:12:00.000Z",
	};
	raw.journalRevision = 4;
	const validated = validateRunJournal(raw, `${completionRoot}/archive/run.json`);
	if (!validated.value) throw new Error(validated.diagnostics.map((item) => item.message).join("; "));
	return validated.value;
}

function monitoredHistoryJournal(): RunJournal {
	const base = maxHistoryJournal();
	const task = base.run.tasks[0]!;
	const attempt = task.attempts.at(-1)!;
	if (attempt.dispatch.phase !== "prompted") throw new Error("monitor fixture requires a prompted latest Attempt");
	const digest = { kind: "observed" as const, byteCount: 0, sha256: `sha256:${"a".repeat(64)}` };
	const checkpoint: MonitorCheckpoint = {
		observedAt: base.run.updatedAt,
		taskId: task.contract.id,
		attemptId: attempt.id,
		role: attempt.role,
		agent: { name: attempt.dispatch.agentName, workspaceId: attempt.dispatch.workspaceId, paneId: attempt.dispatch.paneId, terminalId: attempt.dispatch.terminalId, lifecycle: "idle", stateChangeSequence: 12 },
		terminal: digest,
		worktree: digest,
		git: { head: "0".repeat(40), digest: `sha256:${"b".repeat(64)}` },
		report: { kind: "present", size: 0, sha256: `sha256:${"c".repeat(64)}` },
	};
	const validated = validateRunJournal({ ...base, run: { ...base.run, monitor: checkpoint } });
	if (!validated.value) throw new Error(validated.diagnostics.map((item) => item.message).join("; "));
	return validated.value;
}

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-storage-"));
	roots.push(root);
	return root;
}

async function listTemporaryFiles(directory: string): Promise<string[]> {
	return (await readdir(directory)).filter((name) => name.endsWith(".tmp"));
}

it.sequential("creates an exact protected journal and reloads it", async () => {
	const root = await makeRoot();
	const store = createRunJournalStore();
	const input = journal("run-20260917T180000000Z-storagea");
	const result = await store.createActive(root, input);
	equal(result.kind, "created");
	if (result.kind !== "created") return;
	const bytes = await readFile(result.paths.activePath, "utf8");
	equal(bytes, serializeRunJournal(input));
	ok(!existsSync(result.paths.previousPath));
	equal(await readFile(join(result.paths.stewardDirectory, ".gitignore"), "utf8"), "*\n");
	equal((await stat(result.paths.stewardDirectory)).mode & 0o777, 0o700);
	equal((await stat(result.paths.activePath)).mode & 0o777, 0o600);
	deepStrictEqual((await store.loadActive(root)).kind, "loaded");
	ok(!Object.prototype.hasOwnProperty.call(input.run, "monitor"));
	deepStrictEqual(await listTemporaryFiles(result.paths.stewardDirectory), []);
});

it.sequential("round-trips ticket-10 recovery branches and rejects impossible recovery combinations", async () => {
	for (const variant of ["working", "reconciled", "awaiting", "missing"] as const) {
		const value = recoveryJournal(variant);
		const bytes = serializeRunJournal(value);
		const decoded = deserializeRunJournal(bytes, "active-run.json");
		ok(decoded.value, `${variant} recovery did not decode`);
		if (!decoded.value) continue;
		deepStrictEqual(decoded.value, value);
		deepStrictEqual(cloneRunJournal(value), value);
	}
	const missing = JSON.parse(serializeRunJournal(recoveryJournal("missing"))) as Record<string, unknown>;
	const missingTask = (missing.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>;
	const missingAttempt = missingTask[0]!.attempts as Array<Record<string, unknown>>;
	const missingRecovery = missingAttempt[0]!.recovery as Record<string, unknown>;
	delete missingRecovery.preservation;
	ok(!deserializeRunJournal(JSON.stringify(missing), "active-run.json").value, "missing recovery without preservation was accepted");
	const awaiting = JSON.parse(serializeRunJournal(recoveryJournal("awaiting"))) as Record<string, unknown>;
	const awaitingAttempt = ((awaiting.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!.attempts as Array<Record<string, unknown>>;
	delete (awaitingAttempt[0]!.recovery as Record<string, unknown>).reportRequest;
	ok(!deserializeRunJournal(JSON.stringify(awaiting), "active-run.json").value, "awaiting-report without request was accepted");
	const unknown = JSON.parse(serializeRunJournal(recoveryJournal("working"))) as Record<string, unknown>;
	const unknownAttempt = ((unknown.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!.attempts as Array<Record<string, unknown>>;
	((unknownAttempt[0]!.recovery as Record<string, unknown>).live as Record<string, unknown>).unexpected = true;
	ok(!deserializeRunJournal(JSON.stringify(unknown), "active-run.json").value, "unknown recovery keys were accepted");
	const mismatchedIdentity = JSON.parse(serializeRunJournal(recoveryJournal("awaiting"))) as Record<string, unknown>;
	const mismatchedRecovery = (((mismatchedIdentity.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!.attempts as Array<Record<string, unknown>>)[0]!.recovery as Record<string, unknown>;
	((mismatchedRecovery.reportRequest as Record<string, unknown>).agent as Record<string, unknown>).paneId = "other-pane";
	ok(!deserializeRunJournal(JSON.stringify(mismatchedIdentity), "active-run.json").value, "mismatched recovery identity was accepted");
	const badTimestamp = JSON.parse(serializeRunJournal(recoveryJournal("working"))) as Record<string, unknown>;
	const badTimestampRecovery = (((badTimestamp.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!.attempts as Array<Record<string, unknown>>)[0]!.recovery as Record<string, unknown>;
	(badTimestampRecovery.live as Record<string, unknown>).observedAt = "not-a-timestamp";
	ok(!deserializeRunJournal(JSON.stringify(badTimestamp), "active-run.json").value, "bad recovery timestamp was accepted");
	const badPath = JSON.parse(serializeRunJournal(recoveryJournal("awaiting"))) as Record<string, unknown>;
	const badPathRecovery = (((badPath.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!.attempts as Array<Record<string, unknown>>)[0]!.recovery as Record<string, unknown>;
	(badPathRecovery.reportRequest as Record<string, unknown>).reportPath = "/tmp/recovery-run/other-report.md";
	ok(!deserializeRunJournal(JSON.stringify(badPath), "active-run.json").value, "mismatched recovery path was accepted");
	const awaitingWithFinalizedEvidence = JSON.parse(serializeRunJournal(recoveryJournal("awaiting"))) as Record<string, unknown>;
	const awaitingWithFinalizedAttempt = (((awaitingWithFinalizedEvidence.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!.attempts as Array<Record<string, unknown>>)[0]!;
	awaitingWithFinalizedAttempt.evidence = { phase: "finalized", finalizedAt: "2026-09-18T00:00:05.000Z", status: "completed", reportSha256: `sha256:${"f".repeat(64)}`, manifestPath: "/tmp/recovery-run/finalized/manifest.json", manifestSha256: `sha256:${"e".repeat(64)}`, producedRevision: "1".repeat(40) };
	ok(!deserializeRunJournal(JSON.stringify(awaitingWithFinalizedEvidence), "active-run.json").value, "awaiting-report with finalized evidence was accepted");
});

it.sequential("keeps schema-v1 journals additive and rejects impossible silence attention/state combinations", async () => {
	const legacy = journal("run-20260917T180000000Z-schema-v1");
	const legacyBytes = serializeRunJournal(legacy);
	const legacyDecoded = deserializeRunJournal(legacyBytes, "active-run.json");
	ok(legacyDecoded.value, "schema-v1 journal without ticket-11 keys did not decode");
	if (legacyDecoded.value) deepStrictEqual(legacyDecoded.value, legacy);

	const candidate = JSON.parse(serializeRunJournal(recoveryJournal("working"))) as Record<string, unknown>;
	const run = candidate.run as Record<string, unknown>;
	const task = (run.tasks as Array<Record<string, unknown>>)[0]!;
	const attempt = (task.attempts as Array<Record<string, unknown>>)[0]!;
	const sha = `sha256:${"a".repeat(64)}`;
	task.attention = "suspected-stall";
	task.attentionReason = "silence-passive-inspection";
	(attempt.recovery as Record<string, unknown>).silence = {
		phase: "suspected",
		lastProgressAt: "2026-09-18T00:00:03.000Z",
		phaseAt: "2026-09-18T00:00:04.000Z",
		inspection: {
			attemptId: "attempt-01",
			role: "builder",
			agent: { name: "steward-b-abcdef12-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" },
			lifecycle: "working",
			stateChangeSequence: null,
			terminal: { kind: "observed", byteCount: 0, sha256: sha },
			worktree: { kind: "observed", byteCount: 0, sha256: sha },
			git: { head: "0".repeat(40), digest: sha },
			assignment: { path: "/tmp/recovery-run/runs/run-20260918T000000000Z-recovery/tasks/task-01/attempt-01/assignment.json", size: 1, sha256: sha },
			report: { kind: "missing" },
			evidence: { directory: "/tmp/recovery-run/runs/run-20260918T000000000Z-recovery/tasks/task-01/attempt-01/evidence", count: 0, byteCount: 0, sha256: sha, entries: [] },
			process: { kind: "none", paneId: "pane-1", shellPid: 101, foregroundProcessGroupId: 101, processCount: 1, digest: sha },
		},
	};
	const valid = validateRunJournal(candidate);
	ok(valid.value, valid.diagnostics.map((item) => item.message).join("; "));

	const unknown = JSON.parse(JSON.stringify(candidate)) as Record<string, unknown>;
	const unknownAttempt = ((unknown.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!.attempts as Array<Record<string, unknown>>;
	((unknownAttempt[0]!.recovery as Record<string, unknown>).silence as Record<string, unknown>).unexpected = true;
	ok(!validateRunJournal(unknown).value, "unknown silence fields were accepted");

	const impossibleAttention = JSON.parse(JSON.stringify(candidate)) as Record<string, unknown>;
	const impossibleTask = ((impossibleAttention.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!;
	impossibleTask.attention = "waiting-external";
	ok(!validateRunJournal(impossibleAttention).value, "waiting-external attention without an external phase was accepted");

	const impossibleSuperseded = JSON.parse(JSON.stringify(candidate)) as Record<string, unknown>;
	const impossibleAttempt = ((impossibleSuperseded.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!.attempts as Array<Record<string, unknown>>;
	impossibleAttempt[0]!.state = "superseded";
	ok(!validateRunJournal(impossibleSuperseded).value, "superseded Attempt without replacement-intended state was accepted");

	const exhausted = JSON.parse(JSON.stringify(candidate)) as Record<string, unknown>;
	((exhausted.run as Record<string, unknown>).effectiveSettings as Record<string, unknown>).transientRetryLimit = 0;
	const exhaustedTask = ((exhausted.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!;
	const exhaustedAttempt = (exhaustedTask.attempts as Array<Record<string, unknown>>)[0]!;
	exhaustedTask.attention = "needs-user";
	exhaustedTask.attentionReason = "silence-recovery-exhausted";
	const exhaustedSilence = (exhaustedAttempt.recovery as Record<string, unknown>).silence as Record<string, unknown>;
	exhaustedSilence.phase = "exhausted";
	exhaustedSilence.retryOrdinal = 0;
	delete exhaustedSilence.target;
	delete exhaustedSilence.intendedAt;
	delete exhaustedSilence.promptSha256;
	delete exhaustedSilence.observedAt;
	delete exhaustedSilence.diagnostic;
	const validZeroBudget = validateRunJournal(exhausted);
	ok(validZeroBudget.value, validZeroBudget.diagnostics.map((item) => item.message).join("; "));
	const boundedTwoResult = deserializeRunJournal(serializeRunJournal(replacementExhaustedJournal()), "active-run.json");
	ok(boundedTwoResult.value, boundedTwoResult.diagnostics.map((item) => item.message).join("; "));
	const impossibleExhaustion = JSON.parse(JSON.stringify(exhausted)) as Record<string, unknown>;
	const impossibleExhaustionTask = ((impossibleExhaustion.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!;
	const impossibleExhaustionSilence = ((((impossibleExhaustionTask.attempts as Array<Record<string, unknown>>)[0]!).recovery as Record<string, unknown>).silence as Record<string, unknown>);
	impossibleExhaustionSilence.retryOrdinal = 1;
	ok(!validateRunJournal(impossibleExhaustion).value, "exhausted silence with no consumed replacement was accepted");
	const overLimit = JSON.parse(JSON.stringify(replacementExhaustedJournal())) as Record<string, unknown>;
	(overLimit.run as Record<string, unknown>).effectiveSettings = { ...(overLimit.run as Record<string, unknown>).effectiveSettings as Record<string, unknown>, transientRetryLimit: 1 };
	ok(!validateRunJournal(overLimit).value, "replacement links beyond the frozen retry limit were accepted");
	const brokenOrdinal = JSON.parse(JSON.stringify(replacementExhaustedJournal())) as Record<string, unknown>;
	const brokenAttempts = (((brokenOrdinal.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!.attempts as Array<Record<string, unknown>>);
	(brokenAttempts[2]!.replacement as Record<string, unknown>).retryOrdinal = 1;
	ok(!validateRunJournal(brokenOrdinal).value, "replacement link ordinals not derived from ordered links were accepted");
	});

it.sequential("round-trips every ticket-11 silence union branch", async () => {
	const timestamp = "2026-09-18T00:00:04.000Z";
	const later = "2026-09-18T00:00:05.000Z";
	const final = "2026-09-18T00:00:06.000Z";
	const hash = `sha256:${"a".repeat(64)}`;
	const base = JSON.parse(serializeRunJournal(recoveryJournal("working"))) as Record<string, unknown>;
	const baseRun = base.run as Record<string, unknown>;
	const baseTask = (baseRun.tasks as Array<Record<string, unknown>>)[0]!;
	const baseAttempt = (baseTask.attempts as Array<Record<string, unknown>>)[0]!;
	const baseDispatch = baseAttempt.dispatch as Record<string, unknown>;
	const identity = { name: baseDispatch.agentName, workspaceId: baseDispatch.workspaceId, paneId: baseDispatch.paneId, terminalId: baseDispatch.terminalId };
	const inspection = {
		attemptId: baseAttempt.id,
		role: "builder",
		agent: identity,
		lifecycle: "working",
		stateChangeSequence: null,
		terminal: { kind: "observed", byteCount: 0, sha256: hash },
		worktree: { kind: "observed", byteCount: 0, sha256: hash },
		git: { head: "0".repeat(40), digest: hash },
		assignment: { path: baseAttempt.assignmentPath, size: 1, sha256: hash },
		report: { kind: "missing" },
		evidence: { directory: baseAttempt.evidenceDirectory, count: 0, byteCount: 0, sha256: hash, entries: [] },
		process: { kind: "none", paneId: baseDispatch.paneId, shellPid: 101, foregroundProcessGroupId: 101, processCount: 1, digest: hash },
	};
	const target = identity;
	const promptSha256 = hash;
	const branches: Array<{ name: string; attention: string; attentionReason?: string; silence: Record<string, unknown> }> = [
		{ name: "suspected", attention: "suspected-stall", attentionReason: "silence-passive-inspection", silence: { phase: "suspected", lastProgressAt: "2026-09-18T00:00:03.000Z", phaseAt: timestamp, inspection } },
		{ name: "inspection-incomplete", attention: "suspected-stall", attentionReason: "silence-passive-inspection", silence: { phase: "inspection-incomplete", lastProgressAt: "2026-09-18T00:00:03.000Z", phaseAt: timestamp, inspection: { ...inspection, process: { kind: "unavailable", diagnostic: "process observer unavailable" } }, diagnostic: "passive source unavailable" } },
		{ name: "waiting-external", attention: "waiting-external", attentionReason: "external-process-live", silence: { phase: "waiting-external", lastProgressAt: "2026-09-18T00:00:03.000Z", phaseAt: timestamp, inspection: { ...inspection, process: { kind: "live-external", paneId: baseDispatch.paneId, shellPid: 101, foregroundProcessGroupId: 101, processCount: 2, digest: hash, classification: "test", executableName: "vitest" } }, firstObservedAt: timestamp, lastObservedAt: later, process: { kind: "live-external", paneId: baseDispatch.paneId, shellPid: 101, foregroundProcessGroupId: 101, processCount: 2, digest: hash, classification: "test", executableName: "vitest" }, warnedAt: later } },
		{ name: "external-grace", attention: "waiting-external", attentionReason: "external-process-grace", silence: { phase: "external-grace", lastProgressAt: "2026-09-18T00:00:03.000Z", phaseAt: timestamp, inspection, firstObservedAt: timestamp, lastObservedAt: later, exitedAt: final, process: { kind: "live-external", paneId: baseDispatch.paneId, shellPid: 101, foregroundProcessGroupId: 101, processCount: 2, digest: hash, classification: "test", executableName: "vitest" }, warnedAt: later } },
		{ name: "nudge-intended", attention: "suspected-stall", silence: { phase: "nudge-intended", lastProgressAt: "2026-09-18T00:00:03.000Z", phaseAt: timestamp, inspection, target, intendedAt: timestamp, promptSha256 } },
		{ name: "nudged", attention: "suspected-stall", silence: { phase: "nudged", lastProgressAt: "2026-09-18T00:00:03.000Z", phaseAt: final, inspection, target, intendedAt: timestamp, nudgedAt: final, promptSha256 } },
		{ name: "nudge-ambiguous", attention: "needs-user", attentionReason: "silence-effect-ambiguous", silence: { phase: "nudge-ambiguous", lastProgressAt: "2026-09-18T00:00:03.000Z", phaseAt: final, inspection, target, intendedAt: timestamp, observedAt: final, promptSha256, diagnostic: "nudge result was malformed" } },
		{ name: "interrupt-intended", attention: "suspected-stall", silence: { phase: "interrupt-intended", lastProgressAt: "2026-09-18T00:00:03.000Z", phaseAt: timestamp, inspection, target, intendedAt: timestamp } },
		{ name: "interrupted", attention: "suspected-stall", silence: { phase: "interrupted", lastProgressAt: "2026-09-18T00:00:03.000Z", phaseAt: final, inspection, target, intendedAt: timestamp, interruptedAt: final } },
		{ name: "interrupt-ambiguous", attention: "needs-user", attentionReason: "silence-effect-ambiguous", silence: { phase: "interrupt-ambiguous", lastProgressAt: "2026-09-18T00:00:03.000Z", phaseAt: final, inspection, target, intendedAt: timestamp, observedAt: final, diagnostic: "interrupt result was killed" } },
		{ name: "resume-intended", attention: "suspected-stall", silence: { phase: "resume-intended", lastProgressAt: "2026-09-18T00:00:03.000Z", phaseAt: timestamp, inspection, target, intendedAt: timestamp, promptSha256 } },
		{ name: "resumed", attention: "suspected-stall", silence: { phase: "resumed", lastProgressAt: "2026-09-18T00:00:03.000Z", phaseAt: final, inspection, target, intendedAt: timestamp, resumedAt: final, promptSha256 } },
		{ name: "resume-ambiguous", attention: "needs-user", attentionReason: "silence-effect-ambiguous", silence: { phase: "resume-ambiguous", lastProgressAt: "2026-09-18T00:00:03.000Z", phaseAt: final, inspection, target, intendedAt: timestamp, observedAt: final, promptSha256, diagnostic: "resume identity was wrong" } },
		{ name: "exhausted", attention: "needs-user", attentionReason: "silence-recovery-exhausted", silence: { phase: "exhausted", lastProgressAt: "2026-09-18T00:00:03.000Z", phaseAt: timestamp, inspection, retryOrdinal: 0 } },
	];
	for (const branch of branches) {
		const candidate = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
		const run = candidate.run as Record<string, unknown>;
		const task = (run.tasks as Array<Record<string, unknown>>)[0]!;
		const attempt = (task.attempts as Array<Record<string, unknown>>)[0]!;
		task.attention = branch.attention;
		if (branch.attentionReason) task.attentionReason = branch.attentionReason;
		else delete task.attentionReason;
		attempt.recovery = { live: { observedAt: "2026-09-18T00:00:03.000Z", kind: "working", lifecycle: "working" }, silence: branch.silence };
		if (branch.name === "exhausted") (run.effectiveSettings as Record<string, unknown>).transientRetryLimit = 0;
		run.updatedAt = "2026-09-18T00:00:10.000Z";
		const validated = validateRunJournal(candidate);
		ok(validated.value, `${branch.name} did not validate: ${validated.diagnostics.map((item) => item.message).join("; ")}`);
		if (validated.value) {
			const decoded = deserializeRunJournal(serializeRunJournal(validated.value), "active-run.json");
			ok(decoded.value, `${branch.name} did not round-trip`);
		}
	}
	for (const name of ["replacement-intended", "replacement-ambiguous"] as const) {
		const candidate = JSON.parse(JSON.stringify(replacementExhaustedJournal())) as Record<string, unknown>;
		const task = ((candidate.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!;
		const attempt = (task.attempts as Array<Record<string, unknown>>)[0]!;
		const silence = (attempt.recovery as Record<string, unknown>).silence as Record<string, unknown>;
		if (name === "replacement-ambiguous") Object.assign(silence, { phase: name, observedAt: final, diagnostic: "replacement pane acknowledgement was lost" });
		const validated = validateRunJournal(candidate);
		ok(validated.value, `${name} did not validate: ${validated.diagnostics.map((item) => item.message).join("; ")}`);
		if (validated.value) ok(deserializeRunJournal(serializeRunJournal(validated.value), "active-run.json").value, `${name} did not round-trip`);
	}
});

it.sequential("accepts a logical rework after a linked same-role replacement", async () => {
	const value = replacementThenReworkJournal();
	ok(value.run.tasks[0]?.attempts[3]?.role === "builder");
	equal((value.run.tasks[0]?.attempts[3]?.dispatch as { cycle: number }).cycle, 1);
});

it.sequential("accepts only exact replacement Assignment continuation and rejects stale or misplaced continuation", async () => {
	const value = cloneRunJournal(replacementExhaustedJournal());
	const task = value.run.tasks[0]!;
	const source = task.attempts.at(-1);
	const predecessor = task.attempts.at(-2);
	if (!source || source.role !== "builder" || !predecessor || predecessor.role !== "builder" || !predecessor.recovery?.preservation) throw new Error("replacement Builder fixture is incomplete");
	const sourceDispatch = source.dispatch;
	if (!("worktreePath" in sourceDispatch) || !("workspaceId" in sourceDispatch) || !("paneId" in sourceDispatch) || !("terminalId" in sourceDispatch)) throw new Error("replacement Builder dispatch identity is incomplete");
	const prepared: BuilderAttemptRecord = { ...source, state: "prepared", dispatch: { phase: "agent-intended", branch: sourceDispatch.branch, agentName: sourceDispatch.agentName, worktreePath: sourceDispatch.worktreePath, workspaceId: sourceDispatch.workspaceId, paneId: sourceDispatch.paneId, terminalId: sourceDispatch.terminalId } };
	delete prepared.activatedAt;
	delete prepared.recovery;
	const preparedDispatch = prepared.dispatch as Extract<BuilderAttemptRecord["dispatch"], { phase: "agent-intended" }>;
	(task.attempts as Array<typeof prepared | typeof predecessor>).splice(task.attempts.length - 1, 1, prepared);
	task.attention = "none";
	delete task.attentionReason;
	delete task.attentionDiagnostic;
	const preservation = predecessor.recovery.preservation;
	const continuation: AttemptContinuation = { predecessorAttemptId: predecessor.id, retryOrdinal: source.replacement?.retryOrdinal ?? 2, preservedWorktree: { path: preservation.worktreePath, branch: preservation.branch, head: preservation.head }, priorAssignmentPath: predecessor.assignmentPath, priorReportPath: predecessor.reportPath, priorEvidenceDirectory: predecessor.evidenceDirectory };
	const assignment = buildBuilderAssignment({ run: value.run, task, attempt: prepared, worktreePath: preparedDispatch.worktreePath, branch: preparedDispatch.branch, workspaceId: preparedDispatch.workspaceId, paneId: preparedDispatch.paneId, terminalId: preparedDispatch.terminalId, agentName: preparedDispatch.agentName, continuation });
	const bytes = serializeBuilderAssignment(assignment);
	const decoded = deserializeBuilderAssignment(bytes, prepared.assignmentPath);
	ok(decoded.value, decoded.diagnostics.map((item) => item.message).join("; "));
	deepStrictEqual(decoded.value?.assignment.continuation, continuation);
	const malformed = JSON.parse(bytes) as { assignment: { continuation: { retryOrdinal: number } } };
	malformed.assignment.continuation.retryOrdinal = 3;
	ok(!deserializeBuilderAssignment(JSON.stringify(malformed), prepared.assignmentPath).value, "out-of-range continuation ordinal was accepted");
	throws(() => buildBuilderAssignment({ run: value.run, task, attempt: prepared, worktreePath: preparedDispatch.worktreePath, branch: preparedDispatch.branch, workspaceId: preparedDispatch.workspaceId, paneId: preparedDispatch.paneId, terminalId: preparedDispatch.terminalId, agentName: preparedDispatch.agentName }));
	const ordinary = { ...prepared };
	delete ordinary.replacement;
	throws(() => buildBuilderAssignment({ run: value.run, task, attempt: ordinary, worktreePath: preparedDispatch.worktreePath, branch: preparedDispatch.branch, workspaceId: preparedDispatch.workspaceId, paneId: preparedDispatch.paneId, terminalId: preparedDispatch.terminalId, agentName: preparedDispatch.agentName, continuation }));
});

it.sequential("executes and parses the replacement Reviewer Assignment continuation contract", async () => {
	const value = replacementThenReworkJournal();
	const task = value.run.tasks[0]!;
	const source = task.attempts[2];
	const predecessor = task.attempts[1];
	const builder = task.attempts[0];
	if (!source || source.role !== "reviewer" || !predecessor || predecessor.role !== "reviewer" || !predecessor.recovery?.preservation || !builder || builder.role !== "builder" || !builder.evidence || builder.evidence.phase !== "finalized") throw new Error("replacement Reviewer fixture is incomplete");
	const builderEvidence = builder.evidence;
	if (source.dispatch.phase !== "prompted") throw new Error("replacement Reviewer dispatch is not promptable");
	const prepared = { ...source, state: "prepared" as const, dispatch: { ...source.dispatch, phase: "agent-intended" as const } };
	delete prepared.activatedAt;
	delete prepared.evidence;
	delete prepared.integrity;
	delete prepared.recovery;
	const dispatch = prepared.dispatch;
	const continuation: AttemptContinuation = { predecessorAttemptId: predecessor.id, retryOrdinal: source.replacement?.retryOrdinal ?? 1, preservedWorktree: { path: predecessor.recovery.preservation.worktreePath, branch: predecessor.recovery.preservation.branch, head: predecessor.recovery.preservation.head }, priorAssignmentPath: predecessor.assignmentPath, priorReportPath: predecessor.reportPath, priorEvidenceDirectory: predecessor.evidenceDirectory };
	const assignment = buildReviewerAssignment({ runId: value.run.id, task: task.contract, attempt: prepared, manifestPath: builderEvidence.manifestPath, manifestSha256: builderEvidence.manifestSha256, workspaceId: dispatch.workspaceId, paneId: dispatch.paneId, terminalId: dispatch.terminalId, agentName: dispatch.agentName, continuation });
	const bytes = serializeReviewerAssignment(assignment);
	const decoded = deserializeReviewerAssignment(bytes, prepared.reportPath);
	ok(decoded.value, decoded.diagnostics.map((item) => item.message).join("; "));
	deepStrictEqual(decoded.value?.assignment.continuation, continuation);
	throws(() => buildReviewerAssignment({ runId: value.run.id, task: task.contract, attempt: prepared, manifestPath: builderEvidence.manifestPath, manifestSha256: builderEvidence.manifestSha256, workspaceId: dispatch.workspaceId, paneId: dispatch.paneId, terminalId: dispatch.terminalId, agentName: dispatch.agentName }));
	const ordinary = { ...prepared };
	delete ordinary.replacement;
	throws(() => buildReviewerAssignment({ runId: value.run.id, task: task.contract, attempt: ordinary, manifestPath: builderEvidence.manifestPath, manifestSha256: builderEvidence.manifestSha256, workspaceId: dispatch.workspaceId, paneId: dispatch.paneId, terminalId: dispatch.terminalId, agentName: dispatch.agentName, continuation }));
});

it.sequential("accepts an optional strict monitor checkpoint, clones it, and rejects unknown monitor keys", async () => {
	const root = await makeRoot();
	const store = createRunJournalStore();
	const monitored = monitoredHistoryJournal();
	const seed = cloneRunJournal(monitored);
	seed.journalRevision = 1;
	seed.run.updatedAt = seed.run.createdAt;
	seed.run.status = "active";
	seed.run.tasks = seed.run.tasks.map((task) => { const { approval: _approval, ...withoutApproval } = task; return { ...withoutApproval, phase: "pending" as const, attention: "none" as const, attempts: [], reworkCycles: 0 }; });
	delete seed.run.monitor;
	const created = await store.createActive(root, seed);
	if (created.kind !== "created") throw new Error("monitor fixture seed was not created");
	const cloned = cloneRunJournal(monitored);
	deepStrictEqual(cloned.run.monitor, monitored.run.monitor);
	const replaced = await store.replaceActive(root, monitored);
	equal(replaced.kind, "replaced");
	const loaded = await store.loadActive(root);
	if (loaded.kind !== "loaded") throw new Error("monitored Journal did not reload");
	deepStrictEqual(loaded.journal.run.monitor, monitored.run.monitor);
	const paths = store.resolvePaths(root);
	const candidate = JSON.parse(serializeRunJournal(monitored)) as Record<string, unknown>;
	const run = candidate.run as Record<string, unknown>;
	run.monitor = { ...(run.monitor as Record<string, unknown>), unexpected: true };
	const decoded = deserializeRunJournal(JSON.stringify(candidate), paths.activePath);
	ok(!decoded.value);
	const rejected = await store.replaceActive(root, candidate as unknown as RunJournal);
	equal(rejected.kind, "invalid-candidate");
	equal(await readFile(paths.activePath, "utf8"), serializeRunJournal(monitored));
});

it.sequential("rejects a stale silence CAS candidate without clobbering newer recovery evidence", async () => {
	const root = await makeRoot();
	const store = createRunJournalStore();
	const seed = replacementExhaustedJournal();
	const current = { ...seed, journalRevision: 1, run: { ...seed.run, updatedAt: seed.run.createdAt } };
	if ((await store.createActive(root, current)).kind !== "created") throw new Error("silence CAS fixture was not created");
	const newer = { ...current, journalRevision: 2, run: { ...current.run, updatedAt: "2026-09-18T00:00:11.000Z", declaredOutcome: "newer recovery evidence" } };
	if ((await store.replaceActive(root, newer)).kind !== "replaced") throw new Error("newer silence Journal was not installed");
	const stale = await store.replaceActive(root, current);
	equal(stale.kind, "invalid-candidate");
	const loaded = await store.loadActive(root);
	if (loaded.kind !== "loaded") throw new Error("newer silence Journal disappeared");
	equal(loaded.journal.journalRevision, newer.journalRevision);
	equal(loaded.journal.run.declaredOutcome, "newer recovery evidence");
});

it.sequential("rejects a stale monitor replacement without clobbering the newer Journal", async () => {
	const root = await makeRoot();
	const store = createRunJournalStore();
	const monitored = monitoredHistoryJournal();
	const seed = cloneRunJournal(monitored);
	seed.journalRevision = 1;
	seed.run.updatedAt = seed.run.createdAt;
	seed.run.status = "active";
	seed.run.tasks = seed.run.tasks.map((task) => { const { approval: _approval, ...withoutApproval } = task; return { ...withoutApproval, phase: "pending" as const, attention: "none" as const, attempts: [], reworkCycles: 0 }; });
	delete seed.run.monitor;
	if ((await store.createActive(root, seed)).kind !== "created") throw new Error("stale fixture seed was not created");
	if ((await store.replaceActive(root, monitored)).kind !== "replaced") throw new Error("stale fixture monitor was not installed");
	const current = cloneRunJournal(monitored);
	const newer = { ...current, journalRevision: current.journalRevision + 1, run: { ...current.run, updatedAt: "2026-09-17T18:13:00.000Z", declaredOutcome: "Newer authoritative bytes" } };
	if ((await store.replaceActive(root, newer)).kind !== "replaced") throw new Error("newer Journal was not installed");
	const stale = { ...current, run: { ...current.run, updatedAt: "2026-09-17T18:12:30.000Z" } };
	const result = await store.replaceActive(root, stale);
	equal(result.kind, "invalid-candidate");
	const loaded = await store.loadActive(root);
	if (loaded.kind !== "loaded") throw new Error("newer Journal disappeared");
	equal(loaded.journal.journalRevision, newer.journalRevision);
	equal(loaded.journal.run.declaredOutcome, newer.run.declaredOutcome);
});

it.sequential("two initial creates race without clobbering either complete input", async () => {
	const root = await makeRoot();
	const store = createRunJournalStore();
	const first = journal("run-20260917T180000000Z-raceone");
	const second = journal("run-20260917T180000000Z-racetwo");
	const results = await Promise.all([store.createActive(root, first), store.createActive(root, second)]);
	equal(results.filter((result) => result.kind === "created").length, 1);
	equal(results.filter((result) => result.kind === "active-exists").length, 1);
	const paths = store.resolvePaths(root);
	const active = await readFile(paths.activePath, "utf8");
	ok(active === serializeRunJournal(first) || active === serializeRunJournal(second));
	ok(!existsSync(paths.previousPath));
	deepStrictEqual(await listTemporaryFiles(paths.stewardDirectory), []);
});

it.sequential("replacement preserves the immediate previous valid snapshot", async () => {
	const root = await makeRoot();
	const store = createRunJournalStore();
	const a = journal("run-20260917T180000000Z-replacea");
	await store.createActive(root, a);
	const paths = store.resolvePaths(root);
	const b = journal(a.run.id, 2, "2026-09-17T18:01:00.000Z");
	const replacedB = await store.replaceActive(root, b);
	equal(replacedB.kind, "replaced");
	equal(await readFile(paths.activePath, "utf8"), serializeRunJournal(b));
	equal(await readFile(paths.previousPath, "utf8"), serializeRunJournal(a));
	const c = journal(a.run.id, 3, "2026-09-17T18:02:00.000Z");
	await store.replaceActive(root, c);
	equal(await readFile(paths.activePath, "utf8"), serializeRunJournal(c));
	equal(await readFile(paths.previousPath, "utf8"), serializeRunJournal(b));
	ok(!existsSync(join(paths.activityRoot, a.run.id, "activity.log")));
});

it.sequential("rejects malformed and invalid candidates without changing snapshots", async () => {
	const root = await makeRoot();
	const store = createRunJournalStore();
	const a = journal("run-20260917T180000000Z-invalids");
	await store.createActive(root, a);
	const paths = store.resolvePaths(root);
	const beforeActive = await readFile(paths.activePath, "utf8");
	const candidates: unknown[] = [
		{ schemaVersion: 1 },
		{ ...journal(a.run.id, 2), run: { ...journal(a.run.id, 2).run, tasks: [{ ...journal(a.run.id, 2).run.tasks[0], specificationHash: "sha256:" + "0".repeat(64) }] } },
		journal("run-20260917T180000000Z-other", 2),
		journal(a.run.id, 4),
	];
	for (const candidate of candidates) {
		const result = await store.replaceActive(root, candidate as unknown as RunJournal);
		ok(result.kind === "invalid-candidate" || result.kind === "storage-error");
		equal(await readFile(paths.activePath, "utf8"), beforeActive);
	}
	await writeFile(paths.activePath, "{\"schemaVersion\":1}\n");
	const invalidCurrent = await store.replaceActive(root, journal(a.run.id, 2));
	equal(invalidCurrent.kind, "invalid-current");
	equal(await readFile(paths.activePath, "utf8"), "{\"schemaVersion\":1}\n");
});

it.sequential("round-trips the valid 12-Attempt history and rejects impossible mutations without clobbering", async () => {
	const root = await makeRoot();
	const store = createRunJournalStore();
	const maximum = maxHistoryJournal();
	const initial = { ...maximum, journalRevision: 1, run: { ...maximum.run, updatedAt: maximum.run.createdAt, tasks: maximum.run.tasks.map(({ approval: _approval, ...task }) => ({ ...task, phase: "pending" as const, attention: "none" as const, attempts: [], reworkCycles: 0 })) } };
	const created = await store.createActive(root, initial);
	if (created.kind !== "created") throw new Error(`maximum journal seed failed: ${JSON.stringify(created)}`);
	const replaced = await store.replaceActive(root, maximum);
	if (replaced.kind !== "replaced") throw new Error(`maximum journal replace failed: ${JSON.stringify(replaced)}`);
	const paths = store.resolvePaths(root);
	const bytes = await readFile(paths.activePath, "utf8");
	equal(bytes, serializeRunJournal(maximum));
	const decoded = deserializeRunJournal(bytes, paths.activePath);
	ok(decoded.value);
	deepStrictEqual(decoded.value, maximum);
	const mutations: Array<[string, (candidate: Record<string, unknown>) => void]> = [
		["gap", (candidate) => { const attempts = ((candidate.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!.attempts as Array<Record<string, unknown>>; attempts[3]!.id = "attempt-99"; }],
		["role-order", (candidate) => { const attempts = ((candidate.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!.attempts as Array<Record<string, unknown>>; attempts[1]!.role = "builder"; }],
		["counter", (candidate) => { (((candidate.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!).reworkCycles = 4; }],
		["cycle-limit", (candidate) => { const attempts = ((candidate.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!.attempts as Array<Record<string, unknown>>; (attempts[2]!.dispatch as Record<string, unknown>).cycle = 6; }],
		["backlink", (candidate) => { const attempts = ((candidate.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!.attempts as Array<Record<string, unknown>>; (attempts[2]!.dispatch as Record<string, unknown>).priorReviewerAttemptId = "attempt-12"; }],
		["approval-subject", (candidate) => { const task = ((candidate.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!; ((task.approval as Record<string, unknown>).subject as Record<string, unknown>).builderManifestSha256 = `sha256:${"f".repeat(64)}`; }],
		["later-attempt", (candidate) => { const task = ((candidate.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!; const attempts = task.attempts as Array<Record<string, unknown>>; attempts.push({ ...attempts[0], id: "attempt-13" }); }],
		["phase", (candidate) => { (((candidate.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!).phase = "reworking"; }],
		["repair", (candidate) => { const attempts = ((candidate.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!.attempts as Array<Record<string, unknown>>; attempts[11]!.reportRepair = { phase: "requested" }; }],
	];
	for (const [name, mutate] of mutations) {
		const candidate = JSON.parse(bytes) as Record<string, unknown>;
		candidate.journalRevision = 3;
		mutate(candidate);
		const result = await store.replaceActive(root, candidate as unknown as RunJournal);
		ok(result.kind === "invalid-candidate" || result.kind === "storage-error", `${name} mutation was accepted`);
		equal(await readFile(paths.activePath, "utf8"), bytes, `${name} mutation clobbered the active journal`);
	}
});

it.sequential("rejects completed bytes at the active path while accepting the immutable archive snapshot", async () => {
	const root = await makeRoot();
	const store = createRunJournalStore();
	const initial = journal("run-20260917T180000000Z-completed-active");
	const created = await store.createActive(root, initial);
	if (created.kind !== "created") throw new Error("active seed was not created");
	const paths = store.resolvePaths(root);
	const completed = completedHistoryJournal();
	const archivePath = join(root, "archive", "run.json");
	const archiveBytes = Buffer.from(serializeRunJournalAtPath(completed, archivePath));
	const archiveDecoded = deserializeRunJournal(archiveBytes.toString("utf8"), archivePath);
	ok(archiveDecoded.value, "completed archive snapshot must remain valid at run.json");
	const before = await readFile(paths.activePath);
	const replacement = await store.replaceActive(root, completed);
	equal(replacement.kind, "invalid-candidate");
	deepStrictEqual(await readFile(paths.activePath), before);
	const createAgain = await store.createActive(root, completed);
	equal(createAgain.kind, "storage-error");
	deepStrictEqual(await readFile(paths.activePath), before);
	await writeFile(paths.activePath, archiveBytes);
	const direct = deserializeRunJournal(archiveBytes.toString("utf8"), paths.activePath);
	ok(!direct.value);
	match(direct.diagnostics.map((item) => item.message).join("; "), /active-run/);
	const loaded = await store.loadActive(root);
	equal(loaded.kind, "invalid");
	deepStrictEqual(await readFile(paths.activePath), archiveBytes);
	const rejectedCurrent = await store.replaceActive(root, initial);
	equal(rejectedCurrent.kind, "invalid-current");
	deepStrictEqual(await readFile(paths.activePath), archiveBytes);
	const invalidArchiveCases: Array<[string, (candidate: Record<string, unknown>) => void]> = [
		["altered command", (candidate) => { (candidate.run as Record<string, unknown>).finalVerification = { kind: "command", command: "npm run altered" }; }],
		["second verification id", (candidate) => { ((candidate.run as Record<string, unknown>).finalVerificationExecution as Record<string, unknown>).id = "verification-02"; }],
		["gate predicate mutation", (candidate) => { (((candidate.run as Record<string, unknown>).completion as Record<string, unknown>).gate as Record<string, unknown>).predicates = [...COMPLETION_GATE_PREDICATES].reverse(); }],
	];
	for (const [name, mutate] of invalidArchiveCases) {
		const candidate = JSON.parse(archiveBytes.toString("utf8")) as Record<string, unknown>;
		mutate(candidate);
		ok(!deserializeRunJournal(JSON.stringify(candidate), archivePath).value, `${name} unexpectedly decoded as an archive`);
		const result = await store.replaceActive(root, candidate as unknown as RunJournal);
		equal(result.kind, "invalid-candidate", `${name} replacement was accepted`);
		deepStrictEqual(await readFile(paths.activePath), archiveBytes, `${name} clobbered active bytes`);
	}
});

it.sequential("atomic reads observe only complete old or new snapshots", async () => {
	const root = await makeRoot();
	const store = createRunJournalStore();
	const a = journal("run-20260917T180000000Z-sampled");
	a.run.declaredOutcome = "A".repeat(50_000);
	await store.createActive(root, a);
	const paths = store.resolvePaths(root);
	const b = { ...a, journalRevision: 2, run: { ...a.run, updatedAt: "2026-09-17T18:01:00.000Z", declaredOutcome: "B".repeat(50_000) } };
	const versions = [2, 3, 4, 5, 6].map((revision) => ({ ...a, journalRevision: revision, run: { ...a.run, updatedAt: `2026-09-17T18:0${revision - 1}:00.000Z`, declaredOutcome: String.fromCharCode(64 + revision).repeat(50_000) } }));
	const expected = new Set([serializeRunJournal(a), ...versions.map(serializeRunJournal)]);
	const reads: Promise<void>[] = [];
	for (let index = 0; index < 50; index += 1) {
		reads.push((async () => {
			const bytes = await readFile(paths.activePath, "utf8");
			ok(expected.has(bytes), `unexpected partial bytes at sample ${index}`);
			ok(deserializeRunJournal(bytes, paths.activePath).value);
		})());
		await store.replaceActive(root, versions[index % versions.length]);
	}
	await Promise.all(reads);
});

it.sequential("Assignment creation is deterministic, protected, no-clobber, and byte-identity reusable", async () => {
	const root = await makeRoot();
	const store = createRunJournalStore();
	const runId = "run-20260917T180000000Z-assignment";
	const paths = resolveAssignmentPaths(root, runId, "task-01", "attempt-01");
	const document: BuilderAssignmentDocument = {
		schemaVersion: 1,
		assignment: {
			runId,
			taskId: "task-01",
			attemptId: "attempt-01",
			role: "builder",
			requiredOutcome: "Implement the bounded change",
			allowedScope: ["src/change.ts"],
			expectedArtifacts: [{ kind: "git-commit" }],
			reportPath: paths.reportPath,
			evidenceDirectory: paths.evidenceDirectory,
			verification: { kind: "command", command: "npm test" },
			actualModel: { model: "builder/primary", thinkingLevel: "high" },
			specificationHash: "sha256:" + "a".repeat(64),
			baseRevision: "0123456789abcdef0123456789abcdef01234567",
			worktree: { path: "/tmp/builder-worktree", branch: "steward/run/task/attempt-01" },
			herdr: { workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1", agentName: "steward-b-abcdef12-01-01" },
		},
	};
	const first = await store.createAssignment(root, document);
	equal(first.kind, "created");
	const bytes = await readFile(paths.assignmentPath, "utf8");
	equal(await stat(paths.assignmentPath).then((value) => value.mode & 0o777), 0o600);
	const second = await store.createAssignment(root, document);
	equal(second.kind, "existing-match");
	equal(await readFile(paths.assignmentPath, "utf8"), bytes);
	const conflict = await store.createAssignment(root, { ...document, assignment: { ...document.assignment, requiredOutcome: "A different bounded change" } });
	equal(conflict.kind, "conflict");
	equal(await readFile(paths.assignmentPath, "utf8"), bytes);
	deepStrictEqual(await listTemporaryFiles(paths.attemptDirectory), []);
});

it.sequential("finalized evidence is an exact protected no-clobber snapshot", async () => {
	const root = await makeRoot();
	const store = createRunJournalStore();
	const runId = "run-20260917T180000000Z-finalize";
	const paths = resolveAssignmentPaths(root, runId, "task-01", "attempt-01");
	const document: BuilderAssignmentDocument = {
		schemaVersion: 1,
		assignment: {
			runId,
			taskId: "task-01",
			attemptId: "attempt-01",
			role: "builder",
			requiredOutcome: "Persist exact evidence",
			allowedScope: ["reports/result.md"],
			expectedArtifacts: [{ kind: "evidence", description: "A deterministic report" }],
			reportPath: paths.reportPath,
			evidenceDirectory: paths.evidenceDirectory,
			verification: { kind: "command", command: "npm test" },
			actualModel: { model: "builder/primary", thinkingLevel: "high" },
			specificationHash: "sha256:" + "a".repeat(64),
			baseRevision: "0123456789abcdef0123456789abcdef01234567",
			worktree: { path: "/tmp/builder-worktree", branch: "steward/run/task/attempt-01" },
			herdr: { workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1", agentName: "steward-b-abcdef12-01-01" },
		},
	};
	const assignmentBytes = Buffer.from("assignment\n");
	const reportBytes = Buffer.from("report\n");
	const manifestBytes = Buffer.from("manifest-v1\n");
	const copyBytes = Buffer.from("npm test output\n");
	await store.createAssignment(root, document);
	await writeFile(paths.reportPath, reportBytes, { mode: 0o600 });
	const finalizedDirectory = join(paths.attemptDirectory, "finalized");
	const evidenceStore = createAttemptEvidenceStore();
	const input = {
		paths: { attemptDirectory: paths.attemptDirectory, assignmentPath: paths.assignmentPath, reportPath: paths.reportPath, evidenceDirectory: paths.evidenceDirectory, finalizedDirectory },
		assignmentBytes,
		reportBytes,
		manifestBytes,
		manifestSha256: sha256Bytes(manifestBytes),
		copies: [{ relativePath: "logs/check.log", bytes: copyBytes, size: copyBytes.length, sha256: sha256Bytes(copyBytes) }],
		originalPaths: [paths.reportPath],
	};
	const created = await evidenceStore.finalizeBuilderEvidence(input);
	equal(created.kind, "created");
	deepStrictEqual(await readFile(join(finalizedDirectory, "manifest.json")), manifestBytes);
	deepStrictEqual(await readFile(join(finalizedDirectory, "logs/check.log")), copyBytes);
	equal((await stat(join(finalizedDirectory, "manifest.json"))).mode & 0o777, 0o400);
	equal((await stat(finalizedDirectory)).mode & 0o777, 0o500);
	equal((await stat(paths.reportPath)).mode & 0o777, 0o400);
	const reused = await evidenceStore.finalizeBuilderEvidence(input);
	equal(reused.kind, "existing-match");
	const conflictingManifest = Buffer.from("manifest-v2\n");
	const conflict = await evidenceStore.finalizeBuilderEvidence({ ...input, manifestBytes: conflictingManifest, manifestSha256: sha256Bytes(conflictingManifest) });
	equal(conflict.kind, "conflict");
	deepStrictEqual(await readFile(join(finalizedDirectory, "manifest.json")), manifestBytes);
	deepStrictEqual(await listTemporaryFiles(paths.attemptDirectory), []);
});
