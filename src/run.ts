import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import {
	cloneModelPlans,
	cloneRecoveryDefaults,
	isThinkingLevel,
	parseCanonicalModelReference,
	validateProjectModelPlans,
	validateRecoveryDefaults,
	type ConfigDiagnostic,
	type ProjectModelPlans,
	type ModelChoice,
	type RecoveryDefaults,
} from "./config.ts";
import type { ReviewSubject, ReviewerFinding, ReviewerIndependence } from "./review.ts";
import { serializeReviewerAssignment as serializeReviewerAssignmentDocument, validateReviewerAssignment as validateReviewerAssignmentDocument, deserializeReviewerAssignment as deserializeReviewerAssignmentDocument, type ReviewerAssignmentDocument } from "./review.ts";

export const RUN_JOURNAL_SCHEMA_VERSION = 1 as const;

export type RunStatus = "active";
export type TaskPhase = "pending" | "building" | "reviewing" | "reworking" | "approved";
export type TaskAttention = "none" | "blocked" | "needs-user";
export type TaskAttentionReason = "rework-preflight" | "protected-evidence" | "rework-exhausted";

export type Verification =
	| { kind: "command"; command: string }
	| { kind: "criteria"; criteria: string; deterministicCommandWaiver?: string };

export type ExpectedArtifact =
	| { kind: "git-commit" }
	| { kind: "file"; path: string }
	| { kind: "evidence"; description: string };

export interface TaskContract {
	id: string;
	requiredOutcome: string;
	allowedScope: string[];
	expectedArtifacts: ExpectedArtifact[];
	verification: Verification;
	reviewRequired: boolean;
}

export type DispatchRecord =
	| { phase: "worktree-intended"; branch: string; agentName: string }
	| {
			phase: "agent-intended";
			branch: string;
			agentName: string;
			worktreePath: string;
			workspaceId: string;
			paneId: string;
			terminalId: string;
		}
	| {
			phase: "prompt-intended";
			branch: string;
			agentName: string;
			worktreePath: string;
			workspaceId: string;
			paneId: string;
			terminalId: string;
			assignmentSha256: string;
		}
	| {
			phase: "prompted";
			branch: string;
			agentName: string;
			worktreePath: string;
			workspaceId: string;
			paneId: string;
			terminalId: string;
			assignmentSha256: string;
			promptedAt: string;
		};

export type ReworkDispatchRecord =
	| {
			phase: "assignment-intended";
			branch: string;
			agentName: string;
			worktreePath: string;
			workspaceId: string;
			paneId: string;
			terminalId: string;
			cycle: number;
			priorBuilderAttemptId: string;
			priorReviewerAttemptId: string;
			reviewedSubject: ReviewSubject;
			reviewerManifestPath: string;
			reviewerManifestSha256: string;
			findings: ReviewerFinding[];
	  }
	| {
			phase: "prompt-intended";
			branch: string;
			agentName: string;
			worktreePath: string;
			workspaceId: string;
			paneId: string;
			terminalId: string;
			cycle: number;
			priorBuilderAttemptId: string;
			priorReviewerAttemptId: string;
			reviewedSubject: ReviewSubject;
			reviewerManifestPath: string;
			reviewerManifestSha256: string;
			findings: ReviewerFinding[];
			assignmentSha256: string;
	  }
	| {
			phase: "prompted";
			branch: string;
			agentName: string;
			worktreePath: string;
			workspaceId: string;
			paneId: string;
			terminalId: string;
			cycle: number;
			priorBuilderAttemptId: string;
			priorReviewerAttemptId: string;
			reviewedSubject: ReviewSubject;
			reviewerManifestPath: string;
			reviewerManifestSha256: string;
			findings: ReviewerFinding[];
			assignmentSha256: string;
			promptedAt: string;
	  };

export type BuilderDispatchRecord = DispatchRecord | ReworkDispatchRecord;

export type ReviewerDispatchRecord =
	| { phase: "pane-intended"; sourcePaneId: string; worktreePath: string; agentName: string; branch: string; workspaceId?: string; paneId?: string; terminalId?: string }
	| { phase: "agent-intended"; agentName: string; worktreePath: string; workspaceId: string; paneId: string; terminalId: string; branch: string }
	| { phase: "prompt-intended"; agentName: string; worktreePath: string; workspaceId: string; paneId: string; terminalId: string; assignmentSha256: string; branch: string }
	| { phase: "prompted"; agentName: string; worktreePath: string; workspaceId: string; paneId: string; terminalId: string; assignmentSha256: string; promptedAt: string; branch: string };

export interface BuilderAttemptRecord {
	id: string;
	role: "builder";
	state: "prepared" | "active" | "reported";
	preparedAt: string;
	activatedAt?: string;
	actualModel: ModelChoice;
	specificationHash: string;
	baseRevision: string;
	assignmentPath: string;
	reportPath: string;
	evidenceDirectory: string;
	dispatch: BuilderDispatchRecord;
	evidence?: BuilderEvidenceRecord;
}

export interface ReviewWorktreeSnapshot {
	head: string;
	dirtyStateFingerprint: string;
	dirtyPaths: string[];
	operationMarkers: string[];
}

export type ReviewerEvidenceRecord =
	| { phase: "finalization-intended"; checkedAt: string; reportSha256: string; manifestPath: string; manifestSha256: string; subject: ReviewSubject; status?: "completed" | "blocked" | "failed"; producedRevision?: string | null }
	| { phase: "finalized"; finalizedAt: string; verdict: "approved" | "changes-required"; reportSha256: string; manifestPath: string; manifestSha256: string; subject: ReviewSubject; status?: "completed" | "blocked" | "failed"; producedRevision?: string | null };

export type ReportRepairFailure = "missing-report" | "malformed-report" | "evidence-incomplete";

export type ReviewerReportRepair =
	| { phase: "request-intended"; failure: ReportRepairFailure; diagnostics: string[]; observedReportSha256: string | null; intendedAt: string }
	| { phase: "requested"; failure: ReportRepairFailure; diagnostics: string[]; observedReportSha256: string | null; intendedAt: string; requestedAt: string }
	| { phase: "blocked"; failure: ReportRepairFailure; diagnostics: string[]; observedReportSha256: string | null; intendedAt: string; requestedAt: string; secondFailure: ReportRepairFailure; secondDiagnostics: string[]; secondObservedReportSha256: string | null; blockedAt: string };

export interface ReviewerAttemptRecord {
	id: string;
	role: "reviewer";
	state: "prepared" | "active" | "reported";
	preparedAt: string;
	activatedAt?: string;
	actualModel: ModelChoice;
	specificationHash: string;
	assignmentPath: string;
	reportPath: string;
	evidenceDirectory: string;
	subject: ReviewSubject;
	independence: ReviewerIndependence;
	worktree: { path: string; baseline: ReviewWorktreeSnapshot };
	dispatch: ReviewerDispatchRecord;
	reportRepair?: ReviewerReportRepair;
	integrity?: { kind: "preserved"; after: ReviewWorktreeSnapshot } | { kind: "violated"; detectedAt: string; before: ReviewWorktreeSnapshot; after: ReviewWorktreeSnapshot; code: "reviewer-modified-worktree" };
	evidence?: ReviewerEvidenceRecord;
}

export type AttemptRecord = BuilderAttemptRecord | ReviewerAttemptRecord;

export type EvidenceRejectionCode =
	| "assignment-changed"
	| "report-or-evidence-invalid"
	| "scope-violation"
	| "dirty-worktree"
	| "missing-assignment"
	| "assignment-hash-mismatch"
	| "assignment-invalid"
	| "report-invalid"
	| "report-identity-mismatch"
	| "report-model-mismatch"
	| "report-specification-mismatch"
	| "report-check-mismatch"
	| "report-artifact-mismatch"
	| "missing-evidence"
	| "unsafe-path"
	| "size-mismatch"
	| "hash-mismatch"
	| "commit-range-mismatch"
	| "finalization-conflict"
	| "storage-error";

export type BuilderEvidenceRecord =
	| {
			phase: "rejected";
			checkedAt: string;
			reportSha256?: string;
			codes: EvidenceRejectionCode[];
			summary: string;
	  }
	| {
			phase: "finalization-intended";
			checkedAt: string;
			reportSha256: string;
			manifestPath: string;
			manifestSha256: string;
	  }
	| {
			phase: "finalized";
			finalizedAt: string;
			status: "completed" | "blocked" | "failed";
			reportSha256: string;
			manifestPath: string;
			manifestSha256: string;
			producedRevision: string | null;
	  };

export type FinalizedCheckFact =
	| { kind: "command"; command: string; exitCode: number; summary: string; logId: string }
	| { kind: "criteria"; criteria: string; result: "met" | "not-met"; summary: string; logId: string };

export interface FinalizedArtifactFact {
	kind: ExpectedArtifact["kind"];
	identity: string;
	originalPath: string | null;
	evidencePath: string | null;
	finalizedPath: string | null;
	size: number | null;
	sha256: string | null;
}

export interface FinalizedEvidenceManifest {
	schemaVersion: 1;
	identity: { runId: string; taskId: string; attemptId: string; role: "builder" };
	status: "completed" | "blocked" | "failed";
	summary: string;
	blockers: string[];
	actualModel: ModelChoice;
	specificationHash: string;
	assignmentSha256: string;
	report: { originalPath: string; finalizedPath: string; size: number; sha256: string };
	checks: FinalizedCheckFact[];
	logs: Array<{ id: string; originalPath: string; finalizedPath: string; size: number; sha256: string }>;
	artifacts: FinalizedArtifactFact[];
	producedRevision: string | null;
	code?: { approvedBase: string; producedHead: string; commits: string[]; changedPaths: Array<{ status: string; paths: string[] }> };
}

export interface BuilderAssignmentDocument {
	schemaVersion: 1;
	assignment: {
		runId: string;
		taskId: string;
		attemptId: string;
		role: "builder";
		requiredOutcome: string;
		allowedScope: string[];
		expectedArtifacts: ExpectedArtifact[];
		reportPath: string;
		evidenceDirectory: string;
		verification: Verification;
		actualModel: ModelChoice;
		specificationHash: string;
		baseRevision: string;
		worktree: { path: string; branch: string };
			herdr: { workspaceId: string; paneId: string; terminalId: string; agentName: string };
			rework?: ReworkAssignmentFacts;
	};
}

export type AssignmentDocument = BuilderAssignmentDocument | ReviewerAssignmentDocument;

export interface ReworkAssignmentFacts {
	cycle: number;
	priorBuilderAttemptId: string;
	priorReviewerAttemptId: string;
	reviewedSubject: ReviewSubject;
	reviewerEvidence: { manifestPath: string; manifestSha256: string };
	findings: ReviewerFinding[];
}

export interface TaskRecord {
	specificationVersion: 1;
	specificationHash: string;
	contract: TaskContract;
	phase: TaskPhase;
	attention: TaskAttention;
	attentionDiagnostic?: string;
	attentionReason?: TaskAttentionReason;
	attempts: AttemptRecord[];
	reworkCycles: number;
	approval?: TaskApproval;
}

export type TaskApproval =
	| {
			phase: "valid";
			approvedAt: string;
			builderAttemptId: string;
			reviewerAttemptId: string;
			subject: ReviewSubject;
			reviewerManifestPath: string;
			reviewerManifestSha256: string;
			worktreeSnapshot: ReviewWorktreeSnapshot;
			verdict: "approved";
	  }
	| {
			phase: "invalidated";
			approvedAt: string;
			builderAttemptId: string;
			reviewerAttemptId: string;
			subject: ReviewSubject;
			reviewerManifestPath: string;
			reviewerManifestSha256: string;
			worktreeSnapshot: ReviewWorktreeSnapshot;
			verdict: "approved";
			invalidatedAt: string;
			reason: "head-changed" | "dirty-state-changed" | "subject-changed" | "evidence-changed" | "approval-invalid";
			diagnostic: string;
			observedSnapshot?: ReviewWorktreeSnapshot;
	  };

export type IntegrationBase =
	| { kind: "none" }
	| { kind: "git"; branch: string; revision: string };

export interface RunRecord {
	id: string;
	status: RunStatus;
	declaredOutcome: string;
	createdAt: string;
	updatedAt: string;
	controllerSessionId: string;
	integrationBase: IntegrationBase;
	tasks: TaskRecord[];
	modelPlan: ProjectModelPlans;
	effectiveSettings: RecoveryDefaults;
	finalVerification: Verification;
}

export interface RunJournal {
	schemaVersion: typeof RUN_JOURNAL_SCHEMA_VERSION;
	journalRevision: number;
	run: RunRecord;
}

export interface ActivityEntry {
	timestamp: string;
	runId: string;
	event: string;
	message: string;
}

export interface RunDraftTask {
	requiredOutcome: string;
	allowedScope: string[];
	expectedArtifacts: ExpectedArtifact[];
	verification: Verification;
	reviewRequired: boolean;
	/** Accepted for test/UI convenience, but persisted IDs are generated from array order. */
	id?: string;
}

export interface RunDraft {
	declaredOutcome: string;
	tasks: RunDraftTask[];
	modelPlan: ProjectModelPlans;
	effectiveSettings?: RecoveryDefaults;
	finalVerification: Verification;
}

export interface RunDraftInput {
	recovery: RecoveryDefaults;
	modelPlans: ProjectModelPlans | undefined;
	modelChoices: readonly { reference: string; name: string }[];
	activeJournalPath: string;
	activityLogDirectory: string;
}

export type RunDraftResult = { kind: "cancelled" } | { kind: "drafted"; draft: RunDraft };

export interface RunConfirmationTask {
	number: number;
	contract: TaskContract;
	specificationHash: string;
	warnings: string[];
}

export interface RunConfirmationSummary {
	runId: string;
	declaredOutcome: string;
	tasks: RunConfirmationTask[];
	modelPlan: ProjectModelPlans;
	effectiveSettings: RecoveryDefaults;
	integrationBase: IntegrationBase;
	finalVerification: Verification;
	activeJournalPath: string;
	activityLogPath: string;
	markdown: string;
}

export interface RunIdentity {
	runId: string;
	createdAt: string;
}

export interface RunDiagnostic {
	code: "invalid-run" | "invalid-task" | "invalid-contract" | "invalid-activity" | "invalid-config";
	message: string;
	path?: string;
}

export function validateActivityEntry(value: unknown, path = "activity.log"): { value?: ActivityEntry; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || !exactKeys(value, ["timestamp", "runId", "event", "message"]) || !canonicalTimestamp(value.timestamp) || !safeIdentifier(value.runId) || !value.runId.startsWith("run-") || !trimmedString(value.event) || !trimmedString(value.message)) {
		return { diagnostics: [diagnostic("invalid-activity", "Activity entries must contain exactly timestamp, runId, event, and message with non-empty values.", path)] };
	}
	return { value: { timestamp: value.timestamp, runId: value.runId, event: value.event, message: value.message }, diagnostics: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function diagnostic(code: RunDiagnostic["code"], message: string, path?: string): RunDiagnostic {
	return { code, message, ...(path ? { path } : {}) };
}

function trimmedString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value === value.trim() && !value.includes("\u0000");
}

function safeIdentifier(value: unknown): value is string {
	return trimmedString(value) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function safeBranch(value: unknown): value is string {
	return trimmedString(value) && !value.includes("\u0000") && !value.startsWith("-");
}

function canonicalTimestamp(value: unknown): value is string {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value;
}

function pathValue(value: unknown): value is string {
	if (!trimmedString(value) || isAbsolute(value) || value.includes("\\") || /^[A-Za-z]:[\\/]/.test(value)) return false;
	const segments = value.split("/");
	return segments.every((segment) => segment.length > 0 && segment !== ".." && segment !== ".");
}

function absolutePathValue(value: unknown): value is string {
	return typeof value === "string" && isAbsolute(value) && value === value.trim() && !value.includes("\u0000");
}

function modelChoiceValue(value: unknown, path: string): { value?: ModelChoice; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || !exactKeys(value, ["model", "thinkingLevel"]) || typeof value.model !== "string" || !parseCanonicalModelReference(value.model) || !isThinkingLevel(value.thinkingLevel)) {
		return { diagnostics: [diagnostic("invalid-task", "Model choices must contain exactly a canonical model reference and thinking level.", path)] };
	}
	return { value: { model: value.model, thinkingLevel: value.thinkingLevel }, diagnostics: [] };
}

function validateDispatch(value: unknown, path: string): { value?: BuilderDispatchRecord; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || typeof value.phase !== "string") return { diagnostics: [diagnostic("invalid-task", "Dispatch intent must be a recognized object.", path)] };
	if (value.phase === "assignment-intended" || ((value.phase === "prompt-intended" || value.phase === "prompted") && Object.prototype.hasOwnProperty.call(value, "cycle"))) {
		const required = ["phase", "branch", "agentName", "worktreePath", "workspaceId", "paneId", "terminalId", "cycle", "priorBuilderAttemptId", "priorReviewerAttemptId", "reviewedSubject", "reviewerManifestPath", "reviewerManifestSha256", "findings", ...(value.phase === "assignment-intended" ? [] : ["assignmentSha256"]), ...(value.phase === "prompted" ? ["promptedAt"] : [])];
		if (!exactKeys(value, required) || !safeBranch(value.branch) || !herdrName(value.agentName) || !absolutePathValue(value.worktreePath) || !trimmedString(value.workspaceId) || !trimmedString(value.paneId) || !trimmedString(value.terminalId) || !Number.isSafeInteger(value.cycle) || (value.cycle as number) < 1 || !safeIdentifier(value.priorBuilderAttemptId) || !safeIdentifier(value.priorReviewerAttemptId) || !absolutePathValue(value.reviewerManifestPath) || typeof value.reviewerManifestSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.reviewerManifestSha256) || !Array.isArray(value.findings) || value.findings.length === 0 || value.findings.length > 100) return { diagnostics: [diagnostic("invalid-task", "Rework dispatch has invalid exact identity, cycle, evidence, or findings fields.", path)] };
		const subject = validateReviewSubject(value.reviewedSubject, `${path}.reviewedSubject`);
		const findings = validateReviewerFindings(value.findings, `${path}.findings`);
		const extraDiagnostics = [...subject.diagnostics, ...findings.diagnostics];
		if (value.phase !== "assignment-intended" && (typeof value.assignmentSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.assignmentSha256))) extraDiagnostics.push(diagnostic("invalid-task", "Rework prompt dispatch requires an Assignment hash.", `${path}.assignmentSha256`));
		if (value.phase === "prompted" && !canonicalTimestamp(value.promptedAt)) extraDiagnostics.push(diagnostic("invalid-task", "Rework prompted dispatch requires a canonical timestamp.", `${path}.promptedAt`));
		if (extraDiagnostics.length > 0 || !subject.value || !findings.value) return { diagnostics: extraDiagnostics };
		return {
			value: {
				phase: value.phase as ReworkDispatchRecord["phase"],
				branch: value.branch,
				agentName: value.agentName,
				worktreePath: value.worktreePath,
				workspaceId: value.workspaceId,
				paneId: value.paneId,
				terminalId: value.terminalId,
				cycle: value.cycle as number,
				priorBuilderAttemptId: value.priorBuilderAttemptId,
				priorReviewerAttemptId: value.priorReviewerAttemptId,
				reviewedSubject: subject.value,
				reviewerManifestPath: value.reviewerManifestPath,
				reviewerManifestSha256: value.reviewerManifestSha256,
				findings: findings.value,
				...(value.phase !== "assignment-intended" ? { assignmentSha256: value.assignmentSha256 as string } : {}),
				...(value.phase === "prompted" ? { promptedAt: value.promptedAt as string } : {}),
			} as ReworkDispatchRecord,
			diagnostics: [],
		};
	}
	const common = ["phase", "branch", "agentName"];
	const required = value.phase === "worktree-intended"
		? common
		: value.phase === "agent-intended"
			? [...common, "worktreePath", "workspaceId", "paneId", "terminalId"]
			: value.phase === "prompt-intended"
				? [...common, "worktreePath", "workspaceId", "paneId", "terminalId", "assignmentSha256"]
				: value.phase === "prompted"
					? [...common, "worktreePath", "workspaceId", "paneId", "terminalId", "assignmentSha256", "promptedAt"]
					: undefined;
	if (!required || !exactKeys(value, required)) return { diagnostics: [diagnostic("invalid-task", "Dispatch intent has unknown or missing keys.", path)] };
	if (!safeBranch(value.branch) || !herdrName(value.agentName)) return { diagnostics: [diagnostic("invalid-task", "Dispatch branch or agent name is unsafe.", path)] };
	if (value.phase === "worktree-intended") return { value: { phase: value.phase, branch: value.branch, agentName: value.agentName }, diagnostics: [] };
	if (!absolutePathValue(value.worktreePath) || !trimmedString(value.workspaceId) || !trimmedString(value.paneId) || !trimmedString(value.terminalId)) return { diagnostics: [diagnostic("invalid-task", "Actual dispatch identities and worktree path must be non-empty.", path)] };
	if (value.phase === "agent-intended") return { value: { phase: value.phase, branch: value.branch, agentName: value.agentName, worktreePath: value.worktreePath, workspaceId: value.workspaceId, paneId: value.paneId, terminalId: value.terminalId }, diagnostics: [] };
	if (typeof value.assignmentSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.assignmentSha256)) return { diagnostics: [diagnostic("invalid-task", "Dispatch intent requires a lowercase Assignment byte hash.", path)] };
	if (value.phase === "prompt-intended") return { value: { phase: value.phase, branch: value.branch, agentName: value.agentName, worktreePath: value.worktreePath, workspaceId: value.workspaceId, paneId: value.paneId, terminalId: value.terminalId, assignmentSha256: value.assignmentSha256 }, diagnostics: [] };
	if (!canonicalTimestamp(value.promptedAt)) return { diagnostics: [diagnostic("invalid-task", "Prompted dispatch requires a canonical timestamp.", `${path}.promptedAt`)] };
	return { value: { phase: "prompted", branch: value.branch, agentName: value.agentName, worktreePath: value.worktreePath, workspaceId: value.workspaceId, paneId: value.paneId, terminalId: value.terminalId, assignmentSha256: value.assignmentSha256, promptedAt: value.promptedAt }, diagnostics: [] };
}

function validateReviewSnapshot(value: unknown, path: string): { value?: ReviewWorktreeSnapshot; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || !exactKeys(value, ["head", "dirtyStateFingerprint", "dirtyPaths", "operationMarkers"]) || typeof value.head !== "string" || !/^[0-9a-f]{40}$/.test(value.head) || typeof value.dirtyStateFingerprint !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.dirtyStateFingerprint) || !Array.isArray(value.dirtyPaths) || value.dirtyPaths.length > 100 || value.dirtyPaths.some((item) => !pathValue(item)) || !Array.isArray(value.operationMarkers) || value.operationMarkers.length > 10 || value.operationMarkers.some((item) => !safeIdentifier(item))) return { diagnostics: [diagnostic("invalid-task", "Review worktree snapshot is invalid.", path)] };
	return { value: { head: value.head, dirtyStateFingerprint: value.dirtyStateFingerprint, dirtyPaths: [...value.dirtyPaths] as string[], operationMarkers: [...value.operationMarkers] as string[] }, diagnostics: [] };
}

function validateReviewerFindings(value: unknown, path: string): { value?: ReviewerFinding[]; diagnostics: RunDiagnostic[] } {
	if (!Array.isArray(value) || value.length === 0 || value.length > 100) return { diagnostics: [diagnostic("invalid-task", "Reviewer findings must be a bounded non-empty array.", path)] };
	const findings: ReviewerFinding[] = [];
	const diagnostics: RunDiagnostic[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const item = value[index];
		const itemPath = `${path}[${index}]`;
		if (!isRecord(item)) {
			diagnostics.push(diagnostic("invalid-task", "Reviewer finding must be an object.", itemPath));
			continue;
		}
		const hasPath = Object.prototype.hasOwnProperty.call(item, "path");
		if (!exactKeys(item, hasPath ? ["id", "severity", "summary", "detail", "path"] : ["id", "severity", "summary", "detail"]) || !safeIdentifier(item.id) || !["blocker", "major", "minor", "info"].includes(item.severity as string) || !boundedText(item.summary, 2_000) || !boundedText(item.detail, 8_000) || (hasPath && !pathValue(item.path))) {
			diagnostics.push(diagnostic("invalid-task", "Reviewer finding has invalid exact bounded fields.", itemPath));
			continue;
		}
		findings.push({ id: item.id, severity: item.severity as ReviewerFinding["severity"], summary: item.summary, detail: item.detail, ...(hasPath ? { path: item.path as string } : {}) });
	}
	if (new Set(findings.map((finding) => finding.id)).size !== findings.length) diagnostics.push(diagnostic("invalid-task", "Reviewer finding IDs must be unique.", path));
	return diagnostics.length > 0 ? { diagnostics } : { value: findings, diagnostics: [] };
}

function validateReportRepair(value: unknown, path: string): { value?: ReviewerReportRepair; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || typeof value.phase !== "string") return { diagnostics: [diagnostic("invalid-task", "Reviewer reportRepair must be a recognized phase record.", path)] };
	const failure = (item: unknown): item is ReportRepairFailure => item === "missing-report" || item === "malformed-report" || item === "evidence-incomplete";
	if (value.phase === "request-intended" || value.phase === "requested") {
		const keys = value.phase === "request-intended" ? ["phase", "failure", "diagnostics", "observedReportSha256", "intendedAt"] : ["phase", "failure", "diagnostics", "observedReportSha256", "intendedAt", "requestedAt"];
		if (!exactKeys(value, keys) || !failure(value.failure) || !Array.isArray(value.diagnostics) || value.diagnostics.length === 0 || value.diagnostics.length > 8 || value.diagnostics.some((item) => !boundedText(item, 2_000)) || (value.observedReportSha256 !== null && (typeof value.observedReportSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.observedReportSha256))) || !canonicalTimestamp(value.intendedAt) || (value.phase === "requested" && !canonicalTimestamp(value.requestedAt))) return { diagnostics: [diagnostic("invalid-task", "Reviewer reportRepair intent has invalid exact bounded fields.", path)] };
		return { value: { phase: value.phase, failure: value.failure, diagnostics: [...value.diagnostics] as string[], observedReportSha256: value.observedReportSha256 as string | null, intendedAt: value.intendedAt as string, ...(value.phase === "requested" ? { requestedAt: value.requestedAt as string } : {}) }, diagnostics: [] } as { value?: ReviewerReportRepair; diagnostics: RunDiagnostic[] };
	}
	if (value.phase === "blocked" && exactKeys(value, ["phase", "failure", "diagnostics", "observedReportSha256", "intendedAt", "requestedAt", "secondFailure", "secondDiagnostics", "secondObservedReportSha256", "blockedAt"]) && failure(value.failure) && Array.isArray(value.diagnostics) && value.diagnostics.length > 0 && value.diagnostics.length <= 8 && value.diagnostics.every((item) => boundedText(item, 2_000)) && (value.observedReportSha256 === null || (typeof value.observedReportSha256 === "string" && /^sha256:[0-9a-f]{64}$/.test(value.observedReportSha256))) && canonicalTimestamp(value.intendedAt) && canonicalTimestamp(value.requestedAt) && failure(value.secondFailure) && Array.isArray(value.secondDiagnostics) && value.secondDiagnostics.length > 0 && value.secondDiagnostics.length <= 8 && value.secondDiagnostics.every((item) => boundedText(item, 2_000)) && (value.secondObservedReportSha256 === null || (typeof value.secondObservedReportSha256 === "string" && /^sha256:[0-9a-f]{64}$/.test(value.secondObservedReportSha256))) && canonicalTimestamp(value.blockedAt)) return { value: { phase: "blocked", failure: value.failure, diagnostics: [...value.diagnostics] as string[], observedReportSha256: value.observedReportSha256 as string | null, intendedAt: value.intendedAt, requestedAt: value.requestedAt, secondFailure: value.secondFailure, secondDiagnostics: [...value.secondDiagnostics] as string[], secondObservedReportSha256: value.secondObservedReportSha256 as string | null, blockedAt: value.blockedAt }, diagnostics: [] };
	return { diagnostics: [diagnostic("invalid-task", "Reviewer reportRepair has invalid exact fields.", path)] };
}

function validateReviewerDispatch(value: unknown, path: string): { value?: ReviewerDispatchRecord; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || typeof value.phase !== "string") return { diagnostics: [diagnostic("invalid-task", "Reviewer dispatch intent must be a recognized object.", path)] };
	const required = value.phase === "pane-intended"
		? ["phase", "sourcePaneId", "worktreePath", "agentName"]
		: value.phase === "agent-intended"
			? ["phase", "agentName", "worktreePath", "workspaceId", "paneId", "terminalId"]
			: value.phase === "prompt-intended"
				? ["phase", "agentName", "worktreePath", "workspaceId", "paneId", "terminalId", "assignmentSha256"]
				: value.phase === "prompted"
					? ["phase", "agentName", "worktreePath", "workspaceId", "paneId", "terminalId", "assignmentSha256", "promptedAt"]
					: undefined;
	if (!required || !exactKeys(value, required)) return { diagnostics: [diagnostic("invalid-task", "Reviewer dispatch intent has unknown or missing keys.", path)] };
	if (!herdrName(value.agentName) || !absolutePathValue(value.worktreePath)) return { diagnostics: [diagnostic("invalid-task", "Reviewer dispatch requires a safe name and absolute worktree path.", path)] };
	if (value.phase === "pane-intended") {
		if (!trimmedString(value.sourcePaneId)) return { diagnostics: [diagnostic("invalid-task", "Reviewer pane intent requires a source pane identity.", path)] };
		return { value: { phase: "pane-intended", sourcePaneId: value.sourcePaneId, worktreePath: value.worktreePath, agentName: value.agentName } as ReviewerDispatchRecord, diagnostics: [] };
	}
	if (!trimmedString(value.workspaceId) || !trimmedString(value.paneId) || !trimmedString(value.terminalId)) return { diagnostics: [diagnostic("invalid-task", "Reviewer dispatch identities must be non-empty.", path)] };
	if (value.phase === "agent-intended") return { value: { phase: "agent-intended", agentName: value.agentName, worktreePath: value.worktreePath, workspaceId: value.workspaceId, paneId: value.paneId, terminalId: value.terminalId } as ReviewerDispatchRecord, diagnostics: [] };
	if (typeof value.assignmentSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.assignmentSha256)) return { diagnostics: [diagnostic("invalid-task", "Reviewer prompt intent requires a lowercase Assignment hash.", path)] };
	if (value.phase === "prompt-intended") return { value: { phase: "prompt-intended", agentName: value.agentName, worktreePath: value.worktreePath, workspaceId: value.workspaceId, paneId: value.paneId, terminalId: value.terminalId, assignmentSha256: value.assignmentSha256 } as ReviewerDispatchRecord, diagnostics: [] };
	if (!canonicalTimestamp(value.promptedAt)) return { diagnostics: [diagnostic("invalid-task", "Reviewer prompted dispatch requires a canonical timestamp.", path)] };
	return { value: { phase: "prompted", agentName: value.agentName, worktreePath: value.worktreePath, workspaceId: value.workspaceId, paneId: value.paneId, terminalId: value.terminalId, assignmentSha256: value.assignmentSha256, promptedAt: value.promptedAt } as ReviewerDispatchRecord, diagnostics: [] };
}

function validateReviewerEvidence(value: unknown, path: string): { value?: ReviewerEvidenceRecord; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || typeof value.phase !== "string") return { diagnostics: [diagnostic("invalid-task", "Reviewer evidence must be a recognized phase record.", path)] };
	if (value.phase === "finalization-intended" && exactKeys(value, ["phase", "checkedAt", "reportSha256", "manifestPath", "manifestSha256", "subject"]) && canonicalTimestamp(value.checkedAt) && typeof value.reportSha256 === "string" && /^sha256:[0-9a-f]{64}$/.test(value.reportSha256) && absolutePathValue(value.manifestPath) && typeof value.manifestSha256 === "string" && /^sha256:[0-9a-f]{64}$/.test(value.manifestSha256)) { const subject = validateReviewSubject(value.subject, `${path}.subject`); return subject.value ? { value: { phase: value.phase, checkedAt: value.checkedAt, reportSha256: value.reportSha256, manifestPath: value.manifestPath, manifestSha256: value.manifestSha256, subject: subject.value }, diagnostics: subject.diagnostics } : { diagnostics: subject.diagnostics }; }
	if (value.phase === "finalized" && exactKeys(value, ["phase", "finalizedAt", "verdict", "reportSha256", "manifestPath", "manifestSha256", "subject"]) && canonicalTimestamp(value.finalizedAt) && (value.verdict === "approved" || value.verdict === "changes-required") && typeof value.reportSha256 === "string" && /^sha256:[0-9a-f]{64}$/.test(value.reportSha256) && absolutePathValue(value.manifestPath) && typeof value.manifestSha256 === "string" && /^sha256:[0-9a-f]{64}$/.test(value.manifestSha256)) { const subject = validateReviewSubject(value.subject, `${path}.subject`); return subject.value ? { value: { phase: value.phase, finalizedAt: value.finalizedAt, verdict: value.verdict, reportSha256: value.reportSha256, manifestPath: value.manifestPath, manifestSha256: value.manifestSha256, subject: subject.value }, diagnostics: subject.diagnostics } : { diagnostics: subject.diagnostics }; }
	return { diagnostics: [diagnostic("invalid-task", "Reviewer evidence has invalid exact fields.", path)] };
}

function validateReviewerAttempt(value: Record<string, unknown>, path: string, task: TaskContract, base: IntegrationBase): { value?: ReviewerAttemptRecord; diagnostics: RunDiagnostic[] } {
	const hasActivatedAt = Object.prototype.hasOwnProperty.call(value, "activatedAt");
	const hasIntegrity = Object.prototype.hasOwnProperty.call(value, "integrity");
	const hasEvidence = Object.prototype.hasOwnProperty.call(value, "evidence");
	const hasRepair = Object.prototype.hasOwnProperty.call(value, "reportRepair");
	const keys = ["id", "role", "state", "preparedAt", ...(hasActivatedAt ? ["activatedAt"] : []), "actualModel", "specificationHash", "assignmentPath", "reportPath", "evidenceDirectory", "subject", "independence", "worktree", "dispatch", ...(hasRepair ? ["reportRepair"] : []), ...(hasIntegrity ? ["integrity"] : []), ...(hasEvidence ? ["evidence"] : [])];
	if (!exactKeys(value, keys) || value.role !== "reviewer" || !safeIdentifier(value.id) || !["prepared", "active", "reported"].includes(value.state as string) || !canonicalTimestamp(value.preparedAt) || ((value.state === "active" || value.state === "reported") && !canonicalTimestamp(value.activatedAt)) || (value.state === "prepared" && (hasActivatedAt || hasIntegrity || hasEvidence || hasRepair)) || (value.state === "active" && !hasActivatedAt) || (value.state === "reported" && (!hasEvidence || !hasIntegrity))) return { diagnostics: [diagnostic("invalid-task", "Reviewer Attempt has invalid lifecycle fields.", path)] };
	const model = modelChoiceValue(value.actualModel, `${path}.actualModel`);
	const dispatch = validateReviewerDispatch(value.dispatch, `${path}.dispatch`);
	const snapshot = isRecord(value.worktree) && exactKeys(value.worktree, ["path", "baseline"]) && absolutePathValue(value.worktree.path) ? validateReviewSnapshot(value.worktree.baseline, `${path}.worktree.baseline`) : { diagnostics: [diagnostic("invalid-task", "Reviewer worktree is invalid.", `${path}.worktree`)] };
	const subjectResult = validateReviewSubject(value.subject, `${path}.subject`);
	const independence = validateReviewerIndependence(value.independence, `${path}.independence`);
	const evidence = hasEvidence ? validateReviewerEvidence(value.evidence, `${path}.evidence`) : { diagnostics: [] };
	const reportRepair = hasRepair ? validateReportRepair(value.reportRepair, `${path}.reportRepair`) : { diagnostics: [] };
	const integrity = hasIntegrity ? validateReviewerIntegrity(value.integrity, `${path}.integrity`) : { diagnostics: [] };
	const diagnostics = [...model.diagnostics, ...dispatch.diagnostics, ...snapshot.diagnostics, ...subjectResult.diagnostics, ...independence.diagnostics, ...evidence.diagnostics, ...reportRepair.diagnostics, ...integrity.diagnostics];
	if (typeof value.specificationHash !== "string" || value.specificationHash !== specificationHash(task)) diagnostics.push(diagnostic("invalid-task", "Reviewer Attempt specificationHash must match its Task contract.", `${path}.specificationHash`));
	if (base.kind !== "git") diagnostics.push(diagnostic("invalid-task", "Reviewer Attempt requires the Builder Git integration base in this slice.", path));
	if (!absolutePathValue(value.assignmentPath) || !absolutePathValue(value.reportPath) || !absolutePathValue(value.evidenceDirectory)) diagnostics.push(diagnostic("invalid-task", "Reviewer Attempt paths must be absolute.", path));
	if (dispatch.value && ((value.state === "active" || value.state === "reported") && (dispatch.value.phase !== "prompted" || value.activatedAt !== dispatch.value.promptedAt) || (value.state === "prepared" && dispatch.value.phase === "prompted"))) diagnostics.push(diagnostic("invalid-task", "Reviewer Attempt state and dispatch phase disagree.", path));
	if (reportRepair.value && (dispatch.value?.phase !== "prompted" || (value.state !== "active" && !(value.state === "reported" && reportRepair.value.phase === "requested")))) diagnostics.push(diagnostic("invalid-task", "Reviewer report repair must remain bound to the same prompted Reviewer; only a requested repair may be retained after valid finalization.", `${path}.reportRepair`));
	if (value.state === "reported" && evidence.value?.phase !== "finalized") diagnostics.push(diagnostic("invalid-task", "Reported Reviewer Attempts require finalized evidence.", `${path}.evidence`));
	if (value.state === "reported" && integrity.value?.kind !== "preserved" && integrity.value?.kind !== "violated") diagnostics.push(diagnostic("invalid-task", "Reported Reviewer Attempts require an integrity result.", `${path}.integrity`));
	if (hasRepair && dispatch.value?.phase !== "prompted") diagnostics.push(diagnostic("invalid-task", "Reviewer reportRepair is legal only after a prompted Reviewer dispatch.", `${path}.reportRepair`));
	if (diagnostics.length > 0 || !model.value || !dispatch.value || !snapshot.value || !subjectResult.value || !independence.value || (hasEvidence && !evidence.value) || (hasRepair && !reportRepair.value) || (hasIntegrity && !integrity.value) || !isRecord(value.worktree) || typeof value.worktree.path !== "string") return { diagnostics };
	return { value: { id: value.id as string, role: "reviewer", state: value.state as ReviewerAttemptRecord["state"], preparedAt: value.preparedAt as string, ...(value.state === "active" || value.state === "reported" ? { activatedAt: value.activatedAt as string } : {}), actualModel: model.value, specificationHash: value.specificationHash as string, assignmentPath: value.assignmentPath as string, reportPath: value.reportPath as string, evidenceDirectory: value.evidenceDirectory as string, subject: subjectResult.value, independence: independence.value, worktree: { path: value.worktree.path, baseline: snapshot.value }, dispatch: dispatch.value, ...(reportRepair.value ? { reportRepair: reportRepair.value } : {}), ...(integrity.value ? { integrity: integrity.value } : {}), ...(evidence.value ? { evidence: evidence.value } : {}) }, diagnostics: [] };
}

function validateReviewerIndependence(value: unknown, path: string): { value?: ReviewerIndependence; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || typeof value.kind !== "string") return { diagnostics: [diagnostic("invalid-task", "Reviewer independence is invalid.", path)] };
	if (value.kind === "different-provider-family" && exactKeys(value, ["kind", "builderProvider", "reviewerProvider"]) && trimmedString(value.builderProvider) && trimmedString(value.reviewerProvider) && value.builderProvider !== value.reviewerProvider) return { value: { kind: value.kind, builderProvider: value.builderProvider, reviewerProvider: value.reviewerProvider }, diagnostics: [] };
	if (value.kind === "same-provider-family-approved" && exactKeys(value, ["kind", "provider", "approvedAt", "controllerSessionId"]) && trimmedString(value.provider) && canonicalTimestamp(value.approvedAt) && trimmedString(value.controllerSessionId)) return { value: { kind: value.kind, provider: value.provider, approvedAt: value.approvedAt, controllerSessionId: value.controllerSessionId }, diagnostics: [] };
	return { diagnostics: [diagnostic("invalid-task", "Reviewer independence has invalid exact fields.", path)] };
}

function validateReviewSubject(value: unknown, path: string): { value?: ReviewSubject; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || typeof value.kind !== "string") return { diagnostics: [diagnostic("invalid-task", "Reviewer subject is invalid.", path)] };
	if (value.kind === "git" && exactKeys(value, ["kind", "baseRevision", "headRevision", "commits", "builderManifestSha256"]) && typeof value.baseRevision === "string" && /^[0-9a-f]{40}$/.test(value.baseRevision) && typeof value.headRevision === "string" && /^[0-9a-f]{40}$/.test(value.headRevision) && Array.isArray(value.commits) && value.commits.length > 0 && value.commits.every((commit) => typeof commit === "string" && /^[0-9a-f]{40}$/.test(commit)) && new Set(value.commits).size === value.commits.length && typeof value.builderManifestSha256 === "string" && /^sha256:[0-9a-f]{64}$/.test(value.builderManifestSha256)) return { value: { kind: "git", baseRevision: value.baseRevision, headRevision: value.headRevision, commits: [...value.commits] as string[], builderManifestSha256: value.builderManifestSha256 }, diagnostics: [] };
	if (value.kind === "non-git" && exactKeys(value, ["kind", "artifacts", "builderManifestSha256"]) && Array.isArray(value.artifacts) && value.artifacts.length > 0 && typeof value.builderManifestSha256 === "string" && /^sha256:[0-9a-f]{64}$/.test(value.builderManifestSha256)) {
		const artifacts = value.artifacts;
		if (artifacts.every((item) => isRecord(item) && exactKeys(item, ["kind", "identity", "size", "sha256", "finalizedPath"]) && (item.kind === "file" || item.kind === "evidence") && trimmedString(item.identity) && typeof item.size === "number" && Number.isSafeInteger(item.size) && item.size >= 0 && typeof item.sha256 === "string" && /^sha256:[0-9a-f]{64}$/.test(item.sha256) && absolutePathValue(item.finalizedPath))) return { value: { kind: "non-git", artifacts: artifacts.map((item) => ({ kind: item.kind as "file" | "evidence", identity: item.identity as string, size: item.size as number, sha256: item.sha256 as string, finalizedPath: item.finalizedPath as string })), builderManifestSha256: value.builderManifestSha256 }, diagnostics: [] };
	}
	return { diagnostics: [diagnostic("invalid-task", "Reviewer subject has invalid exact fields.", path)] };
}

function validateReviewerIntegrity(value: unknown, path: string): { value?: ReviewerAttemptRecord["integrity"]; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || typeof value.kind !== "string") return { diagnostics: [diagnostic("invalid-task", "Reviewer integrity is invalid.", path)] };
	if (value.kind === "preserved" && exactKeys(value, ["kind", "after"])) { const after = validateReviewSnapshot(value.after, `${path}.after`); return after.value ? { value: { kind: "preserved", after: after.value }, diagnostics: after.diagnostics } : { diagnostics: after.diagnostics }; }
	if (value.kind === "violated" && exactKeys(value, ["kind", "detectedAt", "before", "after", "code"]) && canonicalTimestamp(value.detectedAt) && value.code === "reviewer-modified-worktree") { const before = validateReviewSnapshot(value.before, `${path}.before`); const after = validateReviewSnapshot(value.after, `${path}.after`); return before.value && after.value ? { value: { kind: "violated", detectedAt: value.detectedAt, before: before.value, after: after.value, code: value.code }, diagnostics: [...before.diagnostics, ...after.diagnostics] } : { diagnostics: [...before.diagnostics, ...after.diagnostics] }; }
	return { diagnostics: [diagnostic("invalid-task", "Reviewer integrity has invalid exact fields.", path)] };
}

function validateAttempt(value: unknown, path: string, task: TaskContract, base: IntegrationBase): { value?: AttemptRecord; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value)) return { diagnostics: [diagnostic("invalid-task", "Attempt must be an object.", path)] };
	const hasActivatedAt = Object.prototype.hasOwnProperty.call(value, "activatedAt");
	const hasEvidence = Object.prototype.hasOwnProperty.call(value, "evidence");
	const keys = ["id", "role", "state", "preparedAt", ...(hasActivatedAt ? ["activatedAt"] : []), "actualModel", "specificationHash", "baseRevision", "assignmentPath", "reportPath", "evidenceDirectory", "dispatch", ...(hasEvidence ? ["evidence"] : [])];
	if (!exactKeys(value, keys) || !safeIdentifier(value.id) || value.role !== "builder" || (value.state !== "prepared" && value.state !== "active" && value.state !== "reported") || !canonicalTimestamp(value.preparedAt) || ((value.state === "active" || value.state === "reported") && !canonicalTimestamp(value.activatedAt)) || (value.state === "prepared" && hasActivatedAt) || (value.state === "prepared" && hasEvidence) || (value.state === "active" && !hasActivatedAt) || (value.state === "reported" && !hasEvidence)) {
		return { diagnostics: [diagnostic("invalid-task", "Attempt has invalid lifecycle fields.", path)] };
	}
	const model = modelChoiceValue(value.actualModel, `${path}.actualModel`);
	const dispatch = validateDispatch(value.dispatch, `${path}.dispatch`);
	const evidence = hasEvidence ? validateEvidenceRecord(value.evidence, `${path}.evidence`) : { diagnostics: [] };
	const diagnostics = [...model.diagnostics, ...dispatch.diagnostics, ...evidence.diagnostics];
	if (typeof value.specificationHash !== "string" || value.specificationHash !== specificationHash(task)) diagnostics.push(diagnostic("invalid-task", "Attempt specificationHash must match its Task contract.", `${path}.specificationHash`));
	if (typeof value.baseRevision !== "string" || base.kind !== "git" || value.baseRevision !== base.revision) diagnostics.push(diagnostic("invalid-task", "Attempt baseRevision must match the Run integration base.", `${path}.baseRevision`));
	if (!absolutePathValue(value.assignmentPath) || !absolutePathValue(value.reportPath) || !absolutePathValue(value.evidenceDirectory)) diagnostics.push(diagnostic("invalid-task", "Attempt evidence paths must be absolute and safe.", path));
	if (dispatch.value) {
		if ((value.state === "active" || value.state === "reported") && (dispatch.value.phase !== "prompted" || value.activatedAt !== dispatch.value.promptedAt)) diagnostics.push(diagnostic("invalid-task", "Active or reported Attempts require a prompted dispatch and matching activation timestamp.", path));
		if (value.state === "prepared" && dispatch.value.phase === "prompted") diagnostics.push(diagnostic("invalid-task", "Prepared Attempts cannot have a prompted dispatch.", path));
	}
	if (value.state === "reported" && evidence.value?.phase !== "finalized") diagnostics.push(diagnostic("invalid-task", "Reported Attempts require finalized Builder evidence.", `${path}.evidence`));
	if (value.state === "active" && evidence.value?.phase === "finalized") diagnostics.push(diagnostic("invalid-task", "Active Attempts cannot contain finalized Builder evidence.", `${path}.evidence`));
	if (evidence.value?.phase === "finalized" && evidence.value.status === "completed" && task.expectedArtifacts.some((artifact) => artifact.kind === "git-commit") && evidence.value.producedRevision === null) diagnostics.push(diagnostic("invalid-task", "Completed code-changing Attempts require a produced revision in finalized evidence.", `${path}.evidence.producedRevision`));
	if (diagnostics.length > 0 || !model.value || !dispatch.value || (hasEvidence && !evidence.value) || typeof value.id !== "string" || typeof value.preparedAt !== "string" || typeof value.specificationHash !== "string" || typeof value.baseRevision !== "string" || typeof value.assignmentPath !== "string" || typeof value.reportPath !== "string" || typeof value.evidenceDirectory !== "string") return { diagnostics };
	return {
		value: {
			id: value.id,
			role: "builder",
			state: value.state,
			preparedAt: value.preparedAt,
			...(value.state === "active" || value.state === "reported" ? { activatedAt: value.activatedAt as string } : {}),
			actualModel: model.value,
			specificationHash: value.specificationHash,
			baseRevision: value.baseRevision,
			assignmentPath: value.assignmentPath,
			reportPath: value.reportPath,
			evidenceDirectory: value.evidenceDirectory,
			dispatch: dispatch.value,
			...(evidence.value ? { evidence: evidence.value } : {}),
		},
		diagnostics: [],
	};
}

function validateEvidenceRecord(value: unknown, path: string): { value?: BuilderEvidenceRecord; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || typeof value.phase !== "string") return { diagnostics: [diagnostic("invalid-task", "Builder evidence must be a recognized phase record.", path)] };
	if (value.phase === "rejected") {
		const hasReportHash = Object.prototype.hasOwnProperty.call(value, "reportSha256");
		const keys = hasReportHash ? ["phase", "checkedAt", "reportSha256", "codes", "summary"] : ["phase", "checkedAt", "codes", "summary"];
		if (!exactKeys(value, keys) || !canonicalTimestamp(value.checkedAt) || (hasReportHash && (typeof value.reportSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.reportSha256))) || !Array.isArray(value.codes) || value.codes.length === 0 || value.codes.length > 32 || value.codes.some((code) => typeof code !== "string" || !safeIdentifier(code)) || new Set(value.codes).size !== value.codes.length || !boundedText(value.summary, 2000)) return { diagnostics: [diagnostic("invalid-task", "Rejected Builder evidence has invalid bounded fields.", path)] };
		return { value: { phase: "rejected", checkedAt: value.checkedAt, ...(hasReportHash ? { reportSha256: value.reportSha256 as string } : {}), codes: [...value.codes] as EvidenceRejectionCode[], summary: value.summary }, diagnostics: [] };
	}
	if (value.phase === "finalization-intended") {
		if (!exactKeys(value, ["phase", "checkedAt", "reportSha256", "manifestPath", "manifestSha256"]) || !canonicalTimestamp(value.checkedAt) || typeof value.reportSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.reportSha256) || !absolutePathValue(value.manifestPath) || typeof value.manifestSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.manifestSha256)) return { diagnostics: [diagnostic("invalid-task", "Finalization intent has invalid paths, hashes, or timestamp.", path)] };
		return { value: { phase: "finalization-intended", checkedAt: value.checkedAt, reportSha256: value.reportSha256, manifestPath: value.manifestPath, manifestSha256: value.manifestSha256 }, diagnostics: [] };
	}
	if (value.phase === "finalized") {
		if (!exactKeys(value, ["phase", "finalizedAt", "status", "reportSha256", "manifestPath", "manifestSha256", "producedRevision"]) || !canonicalTimestamp(value.finalizedAt) || (value.status !== "completed" && value.status !== "blocked" && value.status !== "failed") || typeof value.reportSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.reportSha256) || !absolutePathValue(value.manifestPath) || typeof value.manifestSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.manifestSha256) || (value.producedRevision !== null && (typeof value.producedRevision !== "string" || !/^[0-9a-f]{40}$/.test(value.producedRevision)))) return { diagnostics: [diagnostic("invalid-task", "Finalized Builder evidence has invalid paths, hashes, status, or revision.", path)] };
		return { value: { phase: "finalized", finalizedAt: value.finalizedAt, status: value.status, reportSha256: value.reportSha256, manifestPath: value.manifestPath, manifestSha256: value.manifestSha256, producedRevision: value.producedRevision }, diagnostics: [] };
	}
	return { diagnostics: [diagnostic("invalid-task", "Unknown Builder evidence phase.", path)] };
}

function boundedText(value: unknown, maximumBytes: number): value is string {
	return trimmedString(value) && Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function herdrName(value: unknown): value is string {
	return typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
}

function cloneArtifact(artifact: ExpectedArtifact): ExpectedArtifact {
	return artifact.kind === "git-commit"
		? { kind: "git-commit" }
		: artifact.kind === "file"
			? { kind: "file", path: artifact.path }
			: { kind: "evidence", description: artifact.description };
}

function cloneVerification(verification: Verification): Verification {
	return verification.kind === "command"
		? { kind: "command", command: verification.command }
		: {
				kind: "criteria",
				criteria: verification.criteria,
				...(verification.deterministicCommandWaiver ? { deterministicCommandWaiver: verification.deterministicCommandWaiver } : {}),
			};
}

function cloneContract(contract: TaskContract): TaskContract {
	return {
		id: contract.id,
		requiredOutcome: contract.requiredOutcome,
		allowedScope: [...contract.allowedScope],
		expectedArtifacts: contract.expectedArtifacts.map(cloneArtifact),
		verification: cloneVerification(contract.verification),
		reviewRequired: contract.reviewRequired,
	};
}

function cloneDispatch(dispatch: DispatchRecord): DispatchRecord {
	return { ...dispatch };
}

function cloneBuilderDispatch(dispatch: BuilderDispatchRecord): BuilderDispatchRecord {
	if (dispatch.phase === "assignment-intended" && "cycle" in dispatch) return { ...dispatch, reviewedSubject: cloneReviewSubject(dispatch.reviewedSubject), findings: dispatch.findings.map((finding) => ({ ...finding })) };
	if ((dispatch.phase === "prompt-intended" || dispatch.phase === "prompted") && "cycle" in dispatch) return { ...dispatch, reviewedSubject: cloneReviewSubject(dispatch.reviewedSubject), findings: dispatch.findings.map((finding) => ({ ...finding })) };
	return cloneDispatch(dispatch as DispatchRecord);
}

function cloneReviewSubject(subject: ReviewSubject): ReviewSubject {
	return subject.kind === "git" ? { ...subject, commits: [...subject.commits] } : { ...subject, artifacts: subject.artifacts.map((artifact) => ({ ...artifact })) };
}

function cloneAttempt(attempt: AttemptRecord): AttemptRecord {
	if (attempt.role === "reviewer") {
		return {
			...attempt,
			actualModel: { ...attempt.actualModel },
			subject: attempt.subject.kind === "git" ? { ...attempt.subject, commits: [...attempt.subject.commits] } : { ...attempt.subject, artifacts: attempt.subject.artifacts.map((artifact) => ({ ...artifact })) },
			independence: { ...attempt.independence },
			worktree: { path: attempt.worktree.path, baseline: { ...attempt.worktree.baseline, dirtyPaths: [...attempt.worktree.baseline.dirtyPaths], operationMarkers: [...attempt.worktree.baseline.operationMarkers] } },
				dispatch: { ...attempt.dispatch },
				...(attempt.reportRepair ? { reportRepair: attempt.reportRepair.phase === "blocked" ? { ...attempt.reportRepair, diagnostics: [...attempt.reportRepair.diagnostics], secondDiagnostics: [...attempt.reportRepair.secondDiagnostics] } : { ...attempt.reportRepair, diagnostics: [...attempt.reportRepair.diagnostics] } } : {}),
			...(attempt.integrity ? { integrity: attempt.integrity.kind === "preserved" ? { kind: "preserved", after: { ...attempt.integrity.after, dirtyPaths: [...attempt.integrity.after.dirtyPaths], operationMarkers: [...attempt.integrity.after.operationMarkers] } } : { ...attempt.integrity, before: { ...attempt.integrity.before, dirtyPaths: [...attempt.integrity.before.dirtyPaths], operationMarkers: [...attempt.integrity.before.operationMarkers] }, after: { ...attempt.integrity.after, dirtyPaths: [...attempt.integrity.after.dirtyPaths], operationMarkers: [...attempt.integrity.after.operationMarkers] } } } : {}),
			...(attempt.evidence ? { evidence: { ...attempt.evidence, subject: attempt.evidence.subject.kind === "git" ? { ...attempt.evidence.subject, commits: [...attempt.evidence.subject.commits] } : { ...attempt.evidence.subject, artifacts: attempt.evidence.subject.artifacts.map((artifact) => ({ ...artifact })) } } } : {}),
		};
	}
	return {
		...attempt,
		actualModel: { ...attempt.actualModel },
		dispatch: cloneBuilderDispatch(attempt.dispatch),
		...(attempt.evidence ? { evidence: cloneEvidence(attempt.evidence) } : {}),
	};
}

function cloneEvidence(evidence: BuilderEvidenceRecord): BuilderEvidenceRecord {
	return evidence.phase === "rejected"
		? { ...evidence, codes: [...evidence.codes] }
		: { ...evidence };
}

function cloneApproval(approval: TaskApproval): TaskApproval {
	return approval.phase === "valid"
		? { ...approval, subject: cloneReviewSubject(approval.subject), worktreeSnapshot: { ...approval.worktreeSnapshot, dirtyPaths: [...approval.worktreeSnapshot.dirtyPaths], operationMarkers: [...approval.worktreeSnapshot.operationMarkers] } }
		: { ...approval, subject: cloneReviewSubject(approval.subject), worktreeSnapshot: { ...approval.worktreeSnapshot, dirtyPaths: [...approval.worktreeSnapshot.dirtyPaths], operationMarkers: [...approval.worktreeSnapshot.operationMarkers] }, ...(approval.observedSnapshot ? { observedSnapshot: { ...approval.observedSnapshot, dirtyPaths: [...approval.observedSnapshot.dirtyPaths], operationMarkers: [...approval.observedSnapshot.operationMarkers] } } : {}) };
}

function canonicalContract(contract: TaskContract): TaskContract {
	return cloneContract(contract);
}

export function serializeTaskContract(contract: TaskContract): string {
	return JSON.stringify(canonicalContract(contract));
}

export function specificationHash(contract: TaskContract): string {
	return `sha256:${createHash("sha256").update(serializeTaskContract(contract), "utf8").digest("hex")}`;
}

export function serializeFinalizedEvidenceManifest(manifest: FinalizedEvidenceManifest): string {
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function finalizedEvidenceManifestSha256(manifest: FinalizedEvidenceManifest): string {
	return `sha256:${createHash("sha256").update(serializeFinalizedEvidenceManifest(manifest), "utf8").digest("hex")}`;
}

function validateVerification(value: unknown, path: string, requiresWaiver: boolean): { value?: Verification; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || typeof value.kind !== "string") {
		return { diagnostics: [diagnostic("invalid-contract", "Verification must be a command or criteria object.", path)] };
	}
	if (value.kind === "command") {
		if (!exactKeys(value, ["kind", "command"]) || !trimmedString(value.command)) {
			return { diagnostics: [diagnostic("invalid-contract", "Command verification must contain exactly a non-empty command.", path)] };
		}
		return { value: { kind: "command", command: value.command }, diagnostics: [] };
	}
	if (value.kind !== "criteria") {
		return { diagnostics: [diagnostic("invalid-contract", "Verification kind must be command or criteria.", path)] };
	}
	const hasWaiver = Object.prototype.hasOwnProperty.call(value, "deterministicCommandWaiver");
	const expectedKeys = hasWaiver ? ["kind", "criteria", "deterministicCommandWaiver"] : ["kind", "criteria"];
	if (!exactKeys(value, expectedKeys) || !trimmedString(value.criteria) || (hasWaiver && !trimmedString(value.deterministicCommandWaiver))) {
		return { diagnostics: [diagnostic("invalid-contract", "Criteria verification has invalid keys or empty values.", path)] };
	}
	if (requiresWaiver && !hasWaiver) {
		return { diagnostics: [diagnostic("invalid-contract", "Code-changing criteria verification requires a deterministic command waiver.", path)] };
	}
	return {
		value: {
			kind: "criteria",
			criteria: value.criteria as string,
			...(hasWaiver ? { deterministicCommandWaiver: value.deterministicCommandWaiver as string } : {}),
		},
		diagnostics: [],
	};
}

function validateExpectedArtifacts(value: unknown, path: string): { value?: ExpectedArtifact[]; diagnostics: RunDiagnostic[] } {
	if (!Array.isArray(value) || value.length === 0) {
		return { diagnostics: [diagnostic("invalid-contract", "expectedArtifacts must be a non-empty ordered array.", path)] };
	}
	const diagnostics: RunDiagnostic[] = [];
	const artifacts: ExpectedArtifact[] = [];
	let commits = 0;
	for (let index = 0; index < value.length; index += 1) {
		const artifact = value[index];
		const artifactPath = `${path}[${index}]`;
		if (!isRecord(artifact) || typeof artifact.kind !== "string") {
			diagnostics.push(diagnostic("invalid-contract", "Artifact must be a git-commit, file, or evidence object.", artifactPath));
			continue;
		}
		if (artifact.kind === "git-commit") {
			if (!exactKeys(artifact, ["kind"])) diagnostics.push(diagnostic("invalid-contract", "A git-commit Artifact has no additional fields.", artifactPath));
			else {
				commits += 1;
				artifacts.push({ kind: "git-commit" });
			}
			continue;
		}
		if (artifact.kind === "file") {
			if (!exactKeys(artifact, ["kind", "path"]) || !pathValue(artifact.path)) diagnostics.push(diagnostic("invalid-contract", "File Artifacts require one safe relative path.", artifactPath));
			else artifacts.push({ kind: "file", path: artifact.path });
			continue;
		}
		if (artifact.kind === "evidence") {
			if (!exactKeys(artifact, ["kind", "description"]) || !trimmedString(artifact.description)) diagnostics.push(diagnostic("invalid-contract", "Evidence Artifacts require a non-empty description.", artifactPath));
			else artifacts.push({ kind: "evidence", description: artifact.description });
			continue;
		}
		diagnostics.push(diagnostic("invalid-contract", "Unknown Artifact kind.", artifactPath));
	}
	if (commits > 1) diagnostics.push(diagnostic("invalid-contract", "A Task may contain at most one git-commit Artifact.", path));
	return diagnostics.length > 0 ? { diagnostics } : { value: artifacts, diagnostics: [] };
}

function validateContract(value: unknown, path: string, requireId: boolean): { value?: TaskContract; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || !exactKeys(value, ["id", "requiredOutcome", "allowedScope", "expectedArtifacts", "verification", "reviewRequired"])) {
		return { diagnostics: [diagnostic("invalid-contract", "Task contracts must contain exactly the six documented fields.", path)] };
	}
	const diagnostics: RunDiagnostic[] = [];
	if ((requireId && !safeIdentifier(value.id)) || (!requireId && value.id !== undefined && !safeIdentifier(value.id))) diagnostics.push(diagnostic("invalid-contract", "Task id must be filesystem-safe ASCII.", `${path}.id`));
	if (!trimmedString(value.requiredOutcome)) diagnostics.push(diagnostic("invalid-contract", "requiredOutcome must be a non-empty trimmed string.", `${path}.requiredOutcome`));
	const allowedScope = Array.isArray(value.allowedScope) ? value.allowedScope : undefined;
	if (!allowedScope || allowedScope.length === 0 || allowedScope.some((item) => !pathValue(item))) {
		diagnostics.push(diagnostic("invalid-contract", "allowedScope must be a non-empty ordered list of safe relative paths.", `${path}.allowedScope`));
	} else if (new Set(allowedScope).size !== allowedScope.length) {
		diagnostics.push(diagnostic("invalid-contract", "allowedScope must not contain duplicates.", `${path}.allowedScope`));
	}
	const artifacts = validateExpectedArtifacts(value.expectedArtifacts, `${path}.expectedArtifacts`);
	diagnostics.push(...artifacts.diagnostics);
	const codeChanging = artifacts.value?.some((artifact) => artifact.kind === "git-commit") ?? false;
	const verification = validateVerification(value.verification, `${path}.verification`, codeChanging);
	diagnostics.push(...verification.diagnostics);
	if (typeof value.reviewRequired !== "boolean") diagnostics.push(diagnostic("invalid-contract", "reviewRequired must be boolean.", `${path}.reviewRequired`));
	if (diagnostics.length > 0 || !allowedScope || !artifacts.value || !verification.value || typeof value.reviewRequired !== "boolean") return { diagnostics };
	const id = value.id;
	const requiredOutcome = value.requiredOutcome;
	if (typeof id !== "string" || typeof requiredOutcome !== "string") return { diagnostics };
	const contract: TaskContract = {
		id,
		requiredOutcome,
		allowedScope: [...allowedScope],
		expectedArtifacts: artifacts.value,
		verification: verification.value,
		reviewRequired: value.reviewRequired,
	};
	return { value: contract, diagnostics: [] };
}

function validateIntegrationBase(value: unknown, path: string): { value?: IntegrationBase; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || typeof value.kind !== "string") return { diagnostics: [diagnostic("invalid-run", "integrationBase must be none or git.", path)] };
	if (value.kind === "none") return exactKeys(value, ["kind"]) ? { value: { kind: "none" }, diagnostics: [] } : { diagnostics: [diagnostic("invalid-run", "A none integration base has no additional fields.", path)] };
	if (value.kind !== "git" || !exactKeys(value, ["kind", "branch", "revision"]) || !safeBranch(value.branch) || typeof value.revision !== "string" || !/^[0-9a-f]{40}$/.test(value.revision)) return { diagnostics: [diagnostic("invalid-run", "A git integration base requires a safe branch and full lowercase SHA-1 revision.", path)] };
	return { value: { kind: "git", branch: value.branch, revision: value.revision }, diagnostics: [] };
}

function validateTaskApproval(value: unknown, path: string): { value?: TaskApproval; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || typeof value.phase !== "string") return { diagnostics: [diagnostic("invalid-task", "Task approval must be a valid or invalidated record.", path)] };
	const baseKeys = ["phase", "approvedAt", "builderAttemptId", "reviewerAttemptId", "subject", "reviewerManifestPath", "reviewerManifestSha256", "worktreeSnapshot", "verdict"];
	if (value.phase === "valid") {
		if (!exactKeys(value, baseKeys) || !canonicalTimestamp(value.approvedAt) || !safeIdentifier(value.builderAttemptId) || !safeIdentifier(value.reviewerAttemptId) || value.verdict !== "approved" || !absolutePathValue(value.reviewerManifestPath) || typeof value.reviewerManifestSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.reviewerManifestSha256)) return { diagnostics: [diagnostic("invalid-task", "Valid approval has invalid exact identity fields.", path)] };
		const subject = validateReviewSubject(value.subject, `${path}.subject`);
		const snapshot = validateReviewSnapshot(value.worktreeSnapshot, `${path}.worktreeSnapshot`);
		return subject.value && snapshot.value && subject.diagnostics.length === 0 && snapshot.diagnostics.length === 0 ? { value: { phase: "valid", approvedAt: value.approvedAt, builderAttemptId: value.builderAttemptId, reviewerAttemptId: value.reviewerAttemptId, subject: subject.value, reviewerManifestPath: value.reviewerManifestPath, reviewerManifestSha256: value.reviewerManifestSha256, worktreeSnapshot: snapshot.value, verdict: "approved" }, diagnostics: [] } : { diagnostics: [...subject.diagnostics, ...snapshot.diagnostics] };
	}
	if (value.phase !== "invalidated" || !exactKeys(value, [...baseKeys, "invalidatedAt", "reason", "diagnostic", ...(Object.prototype.hasOwnProperty.call(value, "observedSnapshot") ? ["observedSnapshot"] : [])]) || !canonicalTimestamp(value.approvedAt) || !canonicalTimestamp(value.invalidatedAt) || !safeIdentifier(value.builderAttemptId) || !safeIdentifier(value.reviewerAttemptId) || value.verdict !== "approved" || !absolutePathValue(value.reviewerManifestPath) || typeof value.reviewerManifestSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.reviewerManifestSha256) || !["head-changed", "dirty-state-changed", "subject-changed", "evidence-changed", "approval-invalid"].includes(value.reason as string) || !boundedText(value.diagnostic, 2_000)) return { diagnostics: [diagnostic("invalid-task", "Invalidated approval has invalid exact fields.", path)] };
	const subject = validateReviewSubject(value.subject, `${path}.subject`);
	const snapshot = validateReviewSnapshot(value.worktreeSnapshot, `${path}.worktreeSnapshot`);
	const observed = Object.prototype.hasOwnProperty.call(value, "observedSnapshot") ? validateReviewSnapshot(value.observedSnapshot, `${path}.observedSnapshot`) : { diagnostics: [] };
	if (!subject.value || !snapshot.value || subject.diagnostics.length > 0 || snapshot.diagnostics.length > 0 || observed.diagnostics.length > 0) return { diagnostics: [...subject.diagnostics, ...snapshot.diagnostics, ...observed.diagnostics] };
	return { value: { phase: "invalidated", approvedAt: value.approvedAt, builderAttemptId: value.builderAttemptId, reviewerAttemptId: value.reviewerAttemptId, subject: subject.value, reviewerManifestPath: value.reviewerManifestPath, reviewerManifestSha256: value.reviewerManifestSha256, worktreeSnapshot: snapshot.value, verdict: "approved", invalidatedAt: value.invalidatedAt, reason: value.reason as "head-changed" | "dirty-state-changed" | "subject-changed" | "evidence-changed" | "approval-invalid", diagnostic: value.diagnostic, ...(observed.value ? { observedSnapshot: observed.value } : {}) }, diagnostics: [] };
}

function isReworkDispatch(value: BuilderDispatchRecord): value is ReworkDispatchRecord {
	return "cycle" in value;
}

function validateAttemptSequence(attempts: AttemptRecord[], rawTask: Record<string, unknown>, contract: TaskContract | undefined, path: string, diagnostics: RunDiagnostic[]): void {
	if (!contract) return;
	for (let index = 0; index < attempts.length; index += 1) {
		const attempt = attempts[index]!;
		const expectedId = `attempt-${String(index + 1).padStart(2, "0")}`;
		if (attempt.id !== expectedId) diagnostics.push(diagnostic("invalid-task", "Attempt IDs must be contiguous and derived from sequence position.", `${path}.attempts[${index}].id`));
		if (attempt.role !== (index % 2 === 0 ? "builder" : "reviewer")) diagnostics.push(diagnostic("invalid-task", "Attempt roles must strictly alternate starting with Builder.", `${path}.attempts[${index}].role`));
		if (index === 0 && attempt.role === "builder" && isReworkDispatch(attempt.dispatch)) diagnostics.push(diagnostic("invalid-task", "The first Builder Attempt must use the initial dispatch variant.", `${path}.attempts[${index}].dispatch`));
		if (index > 0 && attempt.role === "builder" && !isReworkDispatch(attempt.dispatch)) diagnostics.push(diagnostic("invalid-task", "Later Builder Attempts must use the rework dispatch variant.", `${path}.attempts[${index}].dispatch`));
		if (attempt.role === "reviewer" && index > 0) {
			const preceding = attempts[index - 1];
			if (preceding?.role !== "builder" || preceding.state === "prepared" || preceding.evidence?.phase !== "finalized" || !reviewSubjectBindsBuilder(attempt.subject, preceding)) diagnostics.push(diagnostic("invalid-task", "Each Reviewer must bind the immediately preceding finalized Builder subject.", `${path}.attempts[${index}]`));
		}
		if (attempt.role === "builder" && index > 0 && isReworkDispatch(attempt.dispatch)) {
			const priorBuilder = attempts[index - 2];
			const priorReviewer = attempts[index - 1];
			const priorDispatch = priorBuilder?.role === "builder" ? priorBuilder.dispatch : undefined;
			const sameBuilder = priorDispatch?.phase === "prompted" && attempt.dispatch.branch === priorDispatch.branch && attempt.dispatch.agentName === priorDispatch.agentName && attempt.dispatch.worktreePath === priorDispatch.worktreePath && attempt.dispatch.workspaceId === priorDispatch.workspaceId && attempt.dispatch.paneId === priorDispatch.paneId && attempt.dispatch.terminalId === priorDispatch.terminalId;
			const sameReviewEvidence = priorReviewer?.role === "reviewer" && priorReviewer.evidence?.phase === "finalized" && attempt.dispatch.reviewerManifestPath === priorReviewer.evidence.manifestPath && attempt.dispatch.reviewerManifestSha256 === priorReviewer.evidence.manifestSha256;
			if (!priorBuilder || priorBuilder.role !== "builder" || !priorReviewer || priorReviewer.role !== "reviewer" || priorReviewer.state !== "reported" || priorReviewer.evidence?.phase !== "finalized" || priorReviewer.evidence.verdict !== "changes-required" || attempt.dispatch.priorBuilderAttemptId !== priorBuilder.id || attempt.dispatch.priorReviewerAttemptId !== priorReviewer.id || attempt.dispatch.cycle !== Math.ceil(index / 2) || !reviewSubjectsEqual(attempt.dispatch.reviewedSubject, priorReviewer.subject) || !sameReviewEvidence || !sameBuilder) diagnostics.push(diagnostic("invalid-task", "Rework Builder backlinks, protected evidence, subject, identity, and cycle must match the immediately preceding changes-required Review.", `${path}.attempts[${index}]`));
		}
	}
	const expectedRework = attempts.filter((attempt) => attempt.role === "builder" && isReworkDispatch(attempt.dispatch)).length;
	if ((rawTask.reworkCycles as unknown) !== expectedRework) diagnostics.push(diagnostic("invalid-task", "reworkCycles must equal the number of rework Builder Attempts.", `${path}.reworkCycles`));
	if (attempts.length === 12 && (rawTask.reworkCycles as unknown) !== 5) diagnostics.push(diagnostic("invalid-task", "The maximum alternating history requires exactly five rework cycles.", `${path}.reworkCycles`));
}

function reviewSubjectBindsBuilder(subject: ReviewSubject, builder: AttemptRecord): boolean {
	if (builder.role !== "builder" || builder.evidence?.phase !== "finalized" || subject.builderManifestSha256 !== builder.evidence.manifestSha256) return false;
	return subject.kind === "git" ? subject.baseRevision === builder.baseRevision && subject.headRevision === builder.evidence.producedRevision : true;
}

function reviewSubjectsEqual(left: ReviewSubject, right: ReviewSubject): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function snapshotsEqual(left: ReviewWorktreeSnapshot, right: ReviewWorktreeSnapshot): boolean {
	return left.head === right.head && left.dirtyStateFingerprint === right.dirtyStateFingerprint && JSON.stringify(left.dirtyPaths) === JSON.stringify(right.dirtyPaths) && JSON.stringify(left.operationMarkers) === JSON.stringify(right.operationMarkers);
}

function validateRunRecord(value: unknown, path: string): { value?: RunRecord; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || !exactKeys(value, ["id", "status", "declaredOutcome", "createdAt", "updatedAt", "controllerSessionId", "integrationBase", "tasks", "modelPlan", "effectiveSettings", "finalVerification"])) {
		return { diagnostics: [diagnostic("invalid-run", "Run contains unknown or missing keys.", path)] };
	}
	const diagnostics: RunDiagnostic[] = [];
	if (!safeIdentifier(value.id) || !String(value.id).startsWith("run-")) diagnostics.push(diagnostic("invalid-run", "Run id must be a filesystem-safe run identifier.", `${path}.id`));
	if (value.status !== "active") diagnostics.push(diagnostic("invalid-run", "Active journals require status active.", `${path}.status`));
	if (!trimmedString(value.declaredOutcome)) diagnostics.push(diagnostic("invalid-run", "declaredOutcome must be non-empty.", `${path}.declaredOutcome`));
	if (!canonicalTimestamp(value.createdAt) || !canonicalTimestamp(value.updatedAt) || value.createdAt > value.updatedAt) diagnostics.push(diagnostic("invalid-run", "Run timestamps must be canonical UTC ISO values in order.", `${path}.createdAt`));
	if (!trimmedString(value.controllerSessionId)) diagnostics.push(diagnostic("invalid-run", "controllerSessionId must be non-empty.", `${path}.controllerSessionId`));
	const base = validateIntegrationBase(value.integrationBase, `${path}.integrationBase`);
	diagnostics.push(...base.diagnostics);
	const rawTasks = Array.isArray(value.tasks) ? value.tasks : undefined;
	if (!rawTasks || rawTasks.length === 0) diagnostics.push(diagnostic("invalid-run", "Run requires at least one ordered Task.", `${path}.tasks`));
	const tasks: TaskRecord[] = [];
	const taskIds = new Set<string>();
	for (let index = 0; index < (rawTasks?.length ?? 0); index += 1) {
		const taskPath = `${path}.tasks[${index}]`;
		const task = rawTasks?.[index];
		if (!isRecord(task)) {
			diagnostics.push(diagnostic("invalid-task", "Task contains unknown or missing initialization keys.", taskPath));
			continue;
		}
		const hasApproval = Object.prototype.hasOwnProperty.call(task, "approval");
		const hasAttentionDiagnostic = Object.prototype.hasOwnProperty.call(task, "attentionDiagnostic");
		const hasAttentionReason = Object.prototype.hasOwnProperty.call(task, "attentionReason");
		if (!exactKeys(task, ["specificationVersion", "specificationHash", "contract", "phase", "attention", ...(hasAttentionDiagnostic ? ["attentionDiagnostic"] : []), ...(hasAttentionReason ? ["attentionReason"] : []), "attempts", "reworkCycles", ...(hasApproval ? ["approval"] : [])])) {
			diagnostics.push(diagnostic("invalid-task", "Task contains unknown or missing initialization keys.", taskPath));
			continue;
		}
		const contractResult = validateContract(task.contract, `${taskPath}.contract`, true);
		const taskDiagnostics = [...contractResult.diagnostics];
		const approval = hasApproval ? validateTaskApproval(task.approval, `${taskPath}.approval`) : { diagnostics: [] };
		taskDiagnostics.push(...approval.diagnostics);
		if (task.specificationVersion !== 1) taskDiagnostics.push(diagnostic("invalid-task", "Task specificationVersion must be 1.", `${taskPath}.specificationVersion`));
		if (typeof task.specificationHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(task.specificationHash) || (contractResult.value && specificationHash(contractResult.value) !== task.specificationHash)) taskDiagnostics.push(diagnostic("invalid-task", "Task specificationHash does not match its exact contract.", `${taskPath}.specificationHash`));
		const settingsLimit = isRecord(value.effectiveSettings) && Number.isSafeInteger(value.effectiveSettings.reworkCycleLimit) ? value.effectiveSettings.reworkCycleLimit as number : 5;
		if (!["pending", "building", "reviewing", "reworking", "approved"].includes(task.phase as string) || !["none", "blocked", "needs-user"].includes(task.attention as string) || !Array.isArray(task.attempts) || !Number.isSafeInteger(task.reworkCycles) || (task.reworkCycles as number) < 0 || (task.reworkCycles as number) > 5 || (task.reworkCycles as number) > settingsLimit) taskDiagnostics.push(diagnostic("invalid-task", "Task has an invalid phase, attention, Attempt sequence, or bounded rework counter.", taskPath));
		if (hasAttentionDiagnostic && (!boundedText(task.attentionDiagnostic, 2_000) || task.attention === "none")) taskDiagnostics.push(diagnostic("invalid-task", "Task attentionDiagnostic must be bounded and accompany durable attention.", `${taskPath}.attentionDiagnostic`));
		if (hasAttentionReason && (!["rework-preflight", "protected-evidence", "rework-exhausted"].includes(task.attentionReason as string) || task.attention === "none")) taskDiagnostics.push(diagnostic("invalid-task", "Task attentionReason must be a recognized durable attention reason.", `${taskPath}.attentionReason`));
		const attempts: AttemptRecord[] = [];
		if (Array.isArray(task.attempts)) {
			if (task.attempts.length > 12) taskDiagnostics.push(diagnostic("invalid-task", "A Task allows at most the initial pair plus five rework/review cycles.", `${taskPath}.attempts`));
			for (let attemptIndex = 0; attemptIndex < task.attempts.length; attemptIndex += 1) {
				const rawAttempt = task.attempts[attemptIndex];
				const attemptResult = contractResult.value && base.value
					? isRecord(rawAttempt) && rawAttempt.role === "reviewer"
						? validateReviewerAttempt(rawAttempt, `${taskPath}.attempts[${attemptIndex}]`, contractResult.value, base.value)
						: validateAttempt(rawAttempt, `${taskPath}.attempts[${attemptIndex}]`, contractResult.value, base.value)
					: { diagnostics: [diagnostic("invalid-task", "Attempt cannot be validated without a valid Task and integration base.", `${taskPath}.attempts[${attemptIndex}]`)] };
				if (attemptResult.value) attempts.push(attemptResult.value);
				taskDiagnostics.push(...attemptResult.diagnostics);
			}
		}
		validateAttemptSequence(attempts, task as Record<string, unknown>, contractResult.value, taskPath, taskDiagnostics);
		const latest = attempts[attempts.length - 1];
		const latestReviewer = latest?.role === "reviewer" ? latest : undefined;
		const latestBuilder = latest?.role === "builder" ? latest : undefined;
		if (task.phase === "pending" && attempts.length !== 0) taskDiagnostics.push(diagnostic("invalid-task", "Pending Tasks must not have Attempts.", taskPath));
		if (task.phase === "building" && (attempts.length !== 1 || attempts[0]?.role !== "builder")) taskDiagnostics.push(diagnostic("invalid-task", "Building Tasks require exactly one Builder Attempt.", taskPath));
		if (task.phase === "reworking" && (attempts.length < 3 || !latestBuilder || !isReworkDispatch(latestBuilder.dispatch))) taskDiagnostics.push(diagnostic("invalid-task", "Reworking Tasks require a latest reserved rework Builder Attempt.", taskPath));
		if (task.phase === "reviewing" && !latestReviewer && !(attempts.length === 1 && attempts[0]?.role === "builder" && task.attention === "needs-user")) taskDiagnostics.push(diagnostic("invalid-task", "Reviewing Tasks require a latest Reviewer Attempt unless Review is durably paused before dispatch.", taskPath));
		if (task.phase === "reviewing" && latestReviewer && latestReviewer.state === "reported" && task.attention === "needs-user" && latestReviewer.integrity?.kind !== "violated" && latestReviewer.evidence?.phase !== "finalized") taskDiagnostics.push(diagnostic("invalid-task", "A reported Reviewer with needs-user attention requires finalized evidence or a recorded integrity violation.", taskPath));
		if (task.phase === "reviewing" && latestReviewer && task.attention === "needs-user" && latestReviewer.evidence?.phase === "finalized" && latestReviewer.evidence.verdict === "changes-required") {
			if (!boundedText(task.attentionDiagnostic, 2_000)) taskDiagnostics.push(diagnostic("invalid-task", "A paused changes-required Review requires a bounded durable diagnostic.", `${taskPath}.attentionDiagnostic`));
			else if (task.reworkCycles !== settingsLimit && task.attentionReason !== "rework-preflight" && task.attentionReason !== "protected-evidence") taskDiagnostics.push(diagnostic("invalid-task", "A below-limit changes-required pause must record a rework preflight or protected evidence reason.", `${taskPath}.attentionReason`));
			else if (task.reworkCycles === settingsLimit && task.attentionReason !== "rework-exhausted" && task.attentionReason !== "protected-evidence" && task.attentionReason !== "rework-preflight") taskDiagnostics.push(diagnostic("invalid-task", "A changes-required pause at the frozen limit must retain an exhaustion or safety reason.", `${taskPath}.attentionReason`));
		}
		if (task.phase === "approved" && (!approval.value || approval.value.phase !== "valid" || task.attention !== "none" || !latestReviewer || latestReviewer.state !== "reported" || latestReviewer.evidence?.phase !== "finalized" || latestReviewer.evidence.verdict !== "approved")) taskDiagnostics.push(diagnostic("invalid-task", "Approved Tasks require a valid Approval bound to a finalized approved Reviewer.", taskPath));
		if (task.attention === "blocked" && (!latestReviewer || latestReviewer.reportRepair?.phase !== "blocked")) taskDiagnostics.push(diagnostic("invalid-task", "Blocked attention requires the latest Reviewer report repair to be blocked.", taskPath));
		if (approval.value?.phase === "valid" && task.phase !== "approved") taskDiagnostics.push(diagnostic("invalid-task", "A valid Approval requires approved Task phase.", `${taskPath}.approval`));
		if (approval.value?.phase === "invalidated" && task.phase === "approved") taskDiagnostics.push(diagnostic("invalid-task", "An invalidated Approval cannot coexist with approved Task phase.", `${taskPath}.approval`));
		if (approval.value) {
			const approvedBuilder = attempts.find((attempt): attempt is BuilderAttemptRecord => attempt.id === approval.value!.builderAttemptId && attempt.role === "builder");
			const approvedReviewer = attempts.find((attempt): attempt is ReviewerAttemptRecord => attempt.id === approval.value!.reviewerAttemptId && attempt.role === "reviewer");
			if (!approvedBuilder || !approvedReviewer || attempts[attempts.length - 2]?.id !== approval.value.builderAttemptId || attempts[attempts.length - 1]?.id !== approval.value.reviewerAttemptId || approvedBuilder.evidence?.phase !== "finalized" || approvedReviewer.evidence?.phase !== "finalized" || approvedReviewer.evidence.verdict !== "approved" || approvedReviewer.evidence.manifestPath !== approval.value.reviewerManifestPath || approvedReviewer.evidence.manifestSha256 !== approval.value.reviewerManifestSha256 || approvedReviewer.integrity?.kind !== "preserved" || !reviewSubjectBindsBuilder(approval.value.subject, approvedBuilder) || !reviewSubjectsEqual(approval.value.subject, approvedReviewer.subject) || !snapshotsEqual(approval.value.worktreeSnapshot, approvedReviewer.integrity.after) || approval.value.worktreeSnapshot.dirtyPaths.length !== 0 || approval.value.worktreeSnapshot.operationMarkers.length !== 0 || (approval.value.subject.kind === "git" && approval.value.worktreeSnapshot.head !== approval.value.subject.headRevision)) taskDiagnostics.push(diagnostic("invalid-task", "Approval must bind the exact final Builder and Reviewer Attempts, subject, protected evidence, and clean snapshot.", `${taskPath}.approval`));
		}
		if (contractResult.value && taskIds.has(contractResult.value.id)) taskDiagnostics.push(diagnostic("invalid-task", "Task IDs must be unique.", `${taskPath}.contract.id`));
		if (contractResult.value) taskIds.add(contractResult.value.id);
		if (taskDiagnostics.length > 0 || !contractResult.value || typeof task.specificationHash !== "string") diagnostics.push(...taskDiagnostics);
		else tasks.push({ specificationVersion: 1, specificationHash: task.specificationHash, contract: contractResult.value, phase: task.phase as TaskPhase, attention: task.attention as TaskAttention, ...(hasAttentionDiagnostic ? { attentionDiagnostic: task.attentionDiagnostic as string } : {}), ...(hasAttentionReason ? { attentionReason: task.attentionReason as TaskAttentionReason } : {}), attempts, reworkCycles: task.reworkCycles as number, ...(approval.value ? { approval: approval.value } : {}) });
	}
	const plans = validateProjectModelPlans(value.modelPlan, `${path}.modelPlan`);
	if (!plans.value || plans.diagnostics.length > 0) diagnostics.push(...plans.diagnostics.map((item: ConfigDiagnostic) => diagnostic("invalid-config", item.message, item.path)));
	const settings = validateRecoveryDefaults(value.effectiveSettings, `${path}.effectiveSettings`);
	if (!settings.value || settings.diagnostics.length > 0) diagnostics.push(...settings.diagnostics.map((item) => diagnostic("invalid-config", item.message, item.path)));
	const codeChanging = tasks.some((task) => task.contract.expectedArtifacts.some((artifact) => artifact.kind === "git-commit"));
	if (base.value && (codeChanging !== (base.value.kind === "git"))) diagnostics.push(diagnostic("invalid-run", "integrationBase must be git exactly for code-changing Runs and none otherwise.", `${path}.integrationBase`));
	const finalVerification = validateVerification(value.finalVerification, `${path}.finalVerification`, codeChanging);
	diagnostics.push(...finalVerification.diagnostics);
	if (diagnostics.length > 0 || !base.value || !plans.value || !settings.value || !finalVerification.value || tasks.length !== (rawTasks?.length ?? 0)) return { diagnostics };
	const id = value.id;
	const declaredOutcome = value.declaredOutcome;
	const createdAt = value.createdAt;
	const updatedAt = value.updatedAt;
	const controllerSessionId = value.controllerSessionId;
	if (typeof id !== "string" || typeof declaredOutcome !== "string" || typeof createdAt !== "string" || typeof updatedAt !== "string" || typeof controllerSessionId !== "string") return { diagnostics: [diagnostic("invalid-run", "Run contains invalid string fields.", path)] };
	return {
		value: {
			id,
			status: "active",
			declaredOutcome,
			createdAt,
			updatedAt,
			controllerSessionId,
			integrationBase: base.value,
			tasks,
			modelPlan: cloneModelPlans(plans.value),
			effectiveSettings: cloneRecoveryDefaults(settings.value),
			finalVerification: finalVerification.value,
		},
		diagnostics: [],
	};
}

export function validateRunJournal(value: unknown, path?: string): { value?: RunJournal; diagnostics: RunDiagnostic[] } {
	const journalPath = path ?? "active-run.json";
	if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "journalRevision", "run"])) return { diagnostics: [diagnostic("invalid-run", "Run Journal contains unknown or missing keys.", journalPath)] };
	if (value.schemaVersion !== RUN_JOURNAL_SCHEMA_VERSION) return { diagnostics: [diagnostic("invalid-run", "Unsupported Run Journal schemaVersion; expected 1.", journalPath)] };
	if (typeof value.journalRevision !== "number" || !Number.isSafeInteger(value.journalRevision) || value.journalRevision < 1) return { diagnostics: [diagnostic("invalid-run", "journalRevision must be a positive safe integer.", `${journalPath}.journalRevision`)] };
	const result = validateRunRecord(value.run, `${journalPath}.run`);
	if (result.value && value.journalRevision === 1 && result.value.createdAt !== result.value.updatedAt) result.diagnostics.push(diagnostic("invalid-run", "Initial Run Journal revision must have equal createdAt and updatedAt values.", `${journalPath}.run.updatedAt`));
	return result.value && result.diagnostics.length === 0 ? { value: { schemaVersion: 1, journalRevision: value.journalRevision, run: result.value }, diagnostics: [] } : { diagnostics: result.diagnostics };
}

export function decodeRunJournal(value: unknown, path?: string): { value?: RunJournal; diagnostics: RunDiagnostic[] } {
	return validateRunJournal(value, path);
}

export function deserializeRunJournal(content: string, path?: string): { value?: RunJournal; diagnostics: RunDiagnostic[] } {
	try {
		return decodeRunJournal(JSON.parse(content) as unknown, path);
	} catch {
		return { diagnostics: [diagnostic("invalid-run", "Run Journal contains malformed JSON.", path)] };
	}
}

function validateAssignment(value: unknown, path = "assignment.json"): { value?: AssignmentDocument; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "assignment"]) || value.schemaVersion !== 1 || !isRecord(value.assignment)) return { diagnostics: [diagnostic("invalid-task", "Assignment must contain exactly schemaVersion 1 and assignment.", path)] };
	const assignment = value.assignment;
	if (assignment.role === "reviewer") {
		const reviewer = validateReviewerAssignmentDocument(value, path);
		return reviewer.value ? { value: reviewer.value, diagnostics: [] } : { diagnostics: reviewer.diagnostics.map((item) => diagnostic("invalid-task", item.message, item.path)) };
	}
	const hasRework = Object.prototype.hasOwnProperty.call(assignment, "rework");
	const keys = ["runId", "taskId", "attemptId", "role", "requiredOutcome", "allowedScope", "expectedArtifacts", "reportPath", "evidenceDirectory", "verification", "actualModel", "specificationHash", "baseRevision", "worktree", "herdr", ...(hasRework ? ["rework"] : [])];
	if (!exactKeys(assignment, keys)) return { diagnostics: [diagnostic("invalid-task", "Assignment contains unknown or missing keys.", path)] };
	const diagnostics: RunDiagnostic[] = [];
	if (!safeIdentifier(assignment.runId) || !assignment.runId.startsWith("run-")) diagnostics.push(diagnostic("invalid-task", "Assignment runId is unsafe.", `${path}.assignment.runId`));
	if (!safeIdentifier(assignment.taskId) || !safeIdentifier(assignment.attemptId) || assignment.role !== "builder") diagnostics.push(diagnostic("invalid-task", "Assignment identity or role is invalid.", `${path}.assignment`));
	if (!trimmedString(assignment.requiredOutcome) || !Array.isArray(assignment.allowedScope) || assignment.allowedScope.length === 0 || assignment.allowedScope.some((item) => !pathValue(item))) diagnostics.push(diagnostic("invalid-task", "Assignment scope and required outcome are invalid.", `${path}.assignment`));
	const artifacts = validateExpectedArtifacts(assignment.expectedArtifacts, `${path}.assignment.expectedArtifacts`);
	diagnostics.push(...artifacts.diagnostics);
	const codeChanging = artifacts.value?.some((artifact) => artifact.kind === "git-commit") ?? false;
	const verification = validateVerification(assignment.verification, `${path}.assignment.verification`, codeChanging);
	diagnostics.push(...verification.diagnostics);
	const model = modelChoiceValue(assignment.actualModel, `${path}.assignment.actualModel`);
	diagnostics.push(...model.diagnostics);
	if (!absolutePathValue(assignment.reportPath) || !absolutePathValue(assignment.evidenceDirectory)) diagnostics.push(diagnostic("invalid-task", "Assignment report paths must be absolute.", `${path}.assignment`));
	if (typeof assignment.specificationHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(assignment.specificationHash) || typeof assignment.baseRevision !== "string" || !/^[0-9a-f]{40}$/.test(assignment.baseRevision)) diagnostics.push(diagnostic("invalid-task", "Assignment hashes and baseRevision are invalid.", `${path}.assignment`));
	const worktree = assignment.worktree;
	if (!isRecord(worktree) || !exactKeys(worktree, ["path", "branch"]) || !absolutePathValue(worktree.path) || !safeBranch(worktree.branch)) diagnostics.push(diagnostic("invalid-task", "Assignment worktree is invalid.", `${path}.assignment.worktree`));
	const herdr = assignment.herdr;
	if (!isRecord(herdr) || !exactKeys(herdr, ["workspaceId", "paneId", "terminalId", "agentName"]) || !trimmedString(herdr.workspaceId) || !trimmedString(herdr.paneId) || !trimmedString(herdr.terminalId) || !herdrName(herdr.agentName)) diagnostics.push(diagnostic("invalid-task", "Assignment Herdr identities are invalid.", `${path}.assignment.herdr`));
	let rework: ReworkAssignmentFacts | undefined;
	if (hasRework) {
		const raw = assignment.rework;
		if (!isRecord(raw) || !exactKeys(raw, ["cycle", "priorBuilderAttemptId", "priorReviewerAttemptId", "reviewedSubject", "reviewerEvidence", "findings"]) || !Number.isSafeInteger(raw.cycle) || (raw.cycle as number) < 1 || !safeIdentifier(raw.priorBuilderAttemptId) || !safeIdentifier(raw.priorReviewerAttemptId)) diagnostics.push(diagnostic("invalid-task", "Rework Assignment facts have invalid exact identity fields.", `${path}.assignment.rework`));
		else {
			const subject = validateReviewSubject(raw.reviewedSubject, `${path}.assignment.rework.reviewedSubject`);
			const evidence = raw.reviewerEvidence;
			const findings = validateReviewerFindings(raw.findings, `${path}.assignment.rework.findings`);
			if (!isRecord(evidence) || !exactKeys(evidence, ["manifestPath", "manifestSha256"]) || !absolutePathValue(evidence.manifestPath) || typeof evidence.manifestSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(evidence.manifestSha256)) diagnostics.push(diagnostic("invalid-task", "Rework Reviewer evidence pointer is invalid.", `${path}.assignment.rework.reviewerEvidence`));
			if (subject.value && findings.value && isRecord(evidence) && absolutePathValue(evidence.manifestPath) && typeof evidence.manifestSha256 === "string" && /^sha256:[0-9a-f]{64}$/.test(evidence.manifestSha256) && subject.diagnostics.length === 0 && findings.diagnostics.length === 0) rework = { cycle: raw.cycle as number, priorBuilderAttemptId: raw.priorBuilderAttemptId, priorReviewerAttemptId: raw.priorReviewerAttemptId, reviewedSubject: subject.value, reviewerEvidence: { manifestPath: evidence.manifestPath, manifestSha256: evidence.manifestSha256 }, findings: findings.value };
			diagnostics.push(...subject.diagnostics, ...findings.diagnostics);
		}
	}
	if (diagnostics.length > 0 || !artifacts.value || !verification.value || !model.value || typeof assignment.runId !== "string" || typeof assignment.taskId !== "string" || typeof assignment.attemptId !== "string" || typeof assignment.requiredOutcome !== "string" || !Array.isArray(assignment.allowedScope) || typeof assignment.reportPath !== "string" || typeof assignment.evidenceDirectory !== "string" || typeof assignment.specificationHash !== "string" || typeof assignment.baseRevision !== "string" || !isRecord(worktree) || typeof worktree.path !== "string" || typeof worktree.branch !== "string" || !isRecord(herdr) || typeof herdr.workspaceId !== "string" || typeof herdr.paneId !== "string" || typeof herdr.terminalId !== "string" || typeof herdr.agentName !== "string") return { diagnostics };
	return {
		value: {
			schemaVersion: 1,
			assignment: {
				runId: assignment.runId,
				taskId: assignment.taskId,
				attemptId: assignment.attemptId,
				role: "builder",
				requiredOutcome: assignment.requiredOutcome,
				allowedScope: [...assignment.allowedScope] as string[],
				expectedArtifacts: artifacts.value,
				reportPath: assignment.reportPath,
				evidenceDirectory: assignment.evidenceDirectory,
				verification: verification.value,
				actualModel: model.value,
				specificationHash: assignment.specificationHash,
				baseRevision: assignment.baseRevision,
				worktree: { path: worktree.path, branch: worktree.branch },
				herdr: { workspaceId: herdr.workspaceId, paneId: herdr.paneId, terminalId: herdr.terminalId, agentName: herdr.agentName },
				...(rework ? { rework } : {}),
			},
		},
		diagnostics: [],
	};
}

export function decodeBuilderAssignment(value: unknown, path?: string): { value?: BuilderAssignmentDocument; diagnostics: RunDiagnostic[] } {
	const result = validateAssignment(value, path);
	return result.value && result.value.assignment.role === "builder" ? { value: result.value as BuilderAssignmentDocument, diagnostics: result.diagnostics } : { diagnostics: result.diagnostics.length > 0 ? result.diagnostics : [diagnostic("invalid-task", "Assignment is not a Builder Assignment.", path)] };
}

export function serializeBuilderAssignment(document: BuilderAssignmentDocument): string {
	const validated = decodeBuilderAssignment(document).value;
	if (!validated) throw new Error("Cannot serialize an invalid Builder Assignment.");
	return `${JSON.stringify(validated, null, 2)}\n`;
}

export function deserializeBuilderAssignment(content: string, path?: string): { value?: BuilderAssignmentDocument; diagnostics: RunDiagnostic[] } {
	try {
		return decodeBuilderAssignment(JSON.parse(content) as unknown, path);
	} catch {
		return { diagnostics: [diagnostic("invalid-task", "Assignment contains malformed JSON.", path)] };
	}
}

export function decodeReviewerAssignment(value: unknown, path?: string): { value?: ReviewerAssignmentDocument; diagnostics: RunDiagnostic[] } {
	const result = validateAssignment(value, path);
	return result.value && result.value.assignment.role === "reviewer" ? { value: result.value as ReviewerAssignmentDocument, diagnostics: result.diagnostics } : { diagnostics: result.diagnostics.length > 0 ? result.diagnostics : [diagnostic("invalid-task", "Assignment is not a Reviewer Assignment.", path)] };
}

export function serializeReviewerAssignment(document: ReviewerAssignmentDocument): string {
	return serializeReviewerAssignmentDocument(document);
}

export function deserializeReviewerAssignment(content: string, path?: string): { value?: ReviewerAssignmentDocument; diagnostics: RunDiagnostic[] } {
	try {
		return decodeReviewerAssignment(JSON.parse(content) as unknown, path);
	} catch {
		return { diagnostics: [diagnostic("invalid-task", "Reviewer Assignment contains malformed JSON.", path)] };
	}
}

export function builderAssignmentSha256(content: string): string {
	return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

export function buildBuilderAssignment(input: {
	run: RunRecord;
	task: TaskRecord;
	attempt: BuilderAttemptRecord;
	worktreePath: string;
	branch: string;
	workspaceId: string;
	paneId: string;
	terminalId: string;
	agentName: string;
}): BuilderAssignmentDocument {
	if (input.run.integrationBase.kind !== "git" || (input.task.phase !== "building" && input.task.phase !== "reworking") || input.attempt.state !== "prepared") throw new Error("Builder Assignment requires a prepared Builder Task with a Git base.");
	if (input.attempt.dispatch.phase !== "agent-intended" && input.attempt.dispatch.phase !== "prompt-intended" && input.attempt.dispatch.phase !== "prompted" && input.attempt.dispatch.phase !== "assignment-intended") throw new Error("Builder Assignment requires actual Builder resources.");
	if (input.task.specificationHash !== specificationHash(input.task.contract) || input.attempt.specificationHash !== input.task.specificationHash) throw new Error("Builder Assignment requires the exact approved Task specification hash.");
	const dispatch = input.attempt.dispatch;
	const rework = "cycle" in dispatch ? {
		cycle: dispatch.cycle,
		priorBuilderAttemptId: dispatch.priorBuilderAttemptId,
		priorReviewerAttemptId: dispatch.priorReviewerAttemptId,
		reviewedSubject: cloneReviewSubject(dispatch.reviewedSubject),
		reviewerEvidence: { manifestPath: dispatch.reviewerManifestPath, manifestSha256: dispatch.reviewerManifestSha256 },
		findings: dispatch.findings.map((finding) => ({ ...finding })),
	} : undefined;
	const document: BuilderAssignmentDocument = {
		schemaVersion: 1,
		assignment: {
			runId: input.run.id,
			taskId: input.task.contract.id,
			attemptId: input.attempt.id,
			role: "builder",
			requiredOutcome: input.task.contract.requiredOutcome,
			allowedScope: [...input.task.contract.allowedScope],
			expectedArtifacts: input.task.contract.expectedArtifacts.map(cloneArtifact),
			reportPath: input.attempt.reportPath,
			evidenceDirectory: input.attempt.evidenceDirectory,
			verification: cloneVerification(input.task.contract.verification),
			actualModel: { ...input.attempt.actualModel },
			specificationHash: input.task.specificationHash,
			baseRevision: input.attempt.baseRevision,
			worktree: { path: input.worktreePath, branch: input.attempt.dispatch.branch },
			herdr: { workspaceId: input.workspaceId, paneId: input.paneId, terminalId: input.terminalId, agentName: input.agentName },
			...(rework ? { rework } : {}),
		},
	};
	const validated = validateAssignment(document);
	if (!validated.value || validated.diagnostics.length > 0) throw new Error(`Cannot build Builder Assignment: ${validated.diagnostics.map((item) => item.message).join("; ")}`);
	return validated.value as BuilderAssignmentDocument;
}

export function formatBuilderPrompt(document: BuilderAssignmentDocument): string {
	const assignment = document.assignment;
	return [
		`Steward Builder Assignment ${assignment.runId}/${assignment.taskId}/${assignment.attemptId}`,
		"",
		"The following Assignment is authoritative and bounded:",
		serializeBuilderAssignment(document).trimEnd(),
		"",
		`Modify only these worktree-relative paths: ${assignment.allowedScope.join(", ")}.`,
		"Produce every expected Artifact, run the stated verification, and write the Attempt Report to the absolute reportPath.",
		...(assignment.rework ? [`This is bounded rework cycle ${assignment.rework.cycle} for the same Builder. Address only the protected findings from Reviewer Attempt ${assignment.rework.priorReviewerAttemptId} and produce a complete Artifact from the frozen Run base to the new head.`] : []),
		"Terminal or Herdr state is not completion; the Attempt Report is required.",
		"Do not modify unrelated paths or dispatch another agent.",
	].join("\n");
}

export function cloneRunJournal(journal: RunJournal): RunJournal {
	return {
		schemaVersion: 1,
		journalRevision: journal.journalRevision,
		run: {
			...journal.run,
			integrationBase: journal.run.integrationBase.kind === "git" ? { ...journal.run.integrationBase } : { kind: "none" },
			tasks: journal.run.tasks.map((task) => ({ ...task, contract: cloneContract(task.contract), attempts: task.attempts.map(cloneAttempt), ...(task.approval ? { approval: cloneApproval(task.approval) } : {}) })),
			modelPlan: cloneModelPlans(journal.run.modelPlan),
			effectiveSettings: cloneRecoveryDefaults(journal.run.effectiveSettings),
			finalVerification: cloneVerification(journal.run.finalVerification),
		},
	};
}

export function advanceRunJournal(journal: RunJournal, now: Date, update: (candidate: RunJournal) => void): RunJournal {
	const candidate = cloneRunJournal(journal);
	update(candidate);
	const requested = now.getTime();
	const previous = new Date(journal.run.updatedAt).getTime();
	const next = Math.max(requested, previous + 1);
	if (!Number.isFinite(next)) throw new Error("Run Journal timestamp cannot advance.");
	candidate.journalRevision += 1;
	candidate.run.updatedAt = new Date(next).toISOString();
	const validation = validateRunJournal(candidate);
	if (!validation.value || validation.diagnostics.length > 0) throw new Error(`Cannot advance invalid Run Journal: ${validation.diagnostics.map((item) => item.message).join("; ")}`);
	return validation.value;
}

export function serializeRunJournal(journal: RunJournal): string {
	const normalized = validateRunJournal(journal).value;
	if (!normalized) throw new Error("Cannot serialize an invalid Run Journal.");
	return `${JSON.stringify(normalized, null, 2)}\n`;
}

export function createRunIdentity(now: Date, uuid: string): RunIdentity {
	const createdAt = now.toISOString();
	const compactTime = createdAt.replace(/[-:.]/g, "");
	const compactUuid = uuid.replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
	if (!compactUuid) throw new Error("Clock randomUUID must provide filesystem-safe identity material.");
	return { runId: `run-${compactTime}-${compactUuid}`, createdAt };
}

export function isCodeChanging(tasks: readonly TaskRecord[] | readonly RunDraftTask[]): boolean {
	return tasks.some((task) => {
		const artifacts = "contract" in task ? task.contract.expectedArtifacts : task.expectedArtifacts;
		return artifacts.some((artifact: ExpectedArtifact) => artifact.kind === "git-commit");
	});
}

export function buildInitialRunJournal(input: {
	identity: RunIdentity;
	controllerSessionId: string;
	draft: RunDraft;
	modelPlan: ProjectModelPlans;
	effectiveSettings: RecoveryDefaults;
	integrationBase: IntegrationBase;
}): RunJournal {
	const tasks = input.draft.tasks.map((draftTask, index) => {
		const contract: TaskContract = {
			id: `task-${String(index + 1).padStart(2, "0")}`,
			requiredOutcome: draftTask.requiredOutcome,
			allowedScope: [...draftTask.allowedScope],
			expectedArtifacts: draftTask.expectedArtifacts.map(cloneArtifact),
			verification: cloneVerification(draftTask.verification),
			reviewRequired: draftTask.reviewRequired,
		};
		return {
			specificationVersion: 1 as const,
			specificationHash: specificationHash(contract),
			contract,
			phase: "pending" as const,
			attention: "none" as const,
			attempts: [] as [],
			reworkCycles: 0 as const,
		};
	});
	const journal: RunJournal = {
		schemaVersion: 1,
		journalRevision: 1,
		run: {
			id: input.identity.runId,
			status: "active",
			declaredOutcome: input.draft.declaredOutcome,
			createdAt: input.identity.createdAt,
			updatedAt: input.identity.createdAt,
			controllerSessionId: input.controllerSessionId,
			integrationBase: input.integrationBase.kind === "none" ? { kind: "none" } : { ...input.integrationBase },
			tasks,
			modelPlan: cloneModelPlans(input.modelPlan),
			effectiveSettings: cloneRecoveryDefaults(input.effectiveSettings),
			finalVerification: cloneVerification(input.draft.finalVerification),
		},
	};
	const validation = validateRunJournal(journal);
	if (!validation.value || validation.diagnostics.length > 0) throw new Error(`Cannot build invalid Run Journal: ${validation.diagnostics.map((item) => item.message).join("; ")}`);
	return validation.value;
}

/** Validate and normalize an in-memory TUI draft before volatile preflights run. */
export function validateRunDraft(draft: unknown, fallbackSettings: RecoveryDefaults): { value?: RunDraft; diagnostics: RunDiagnostic[] } {
	if (!isRecord(draft)) return { diagnostics: [diagnostic("invalid-contract", "Run draft must be an object.", "run")] };
	const candidate = { ...draft, effectiveSettings: draft.effectiveSettings ?? cloneRecoveryDefaults(fallbackSettings) } as unknown as RunDraft;
	try {
		const provisional = buildInitialRunJournal({
			identity: { runId: "run-00000000T000000000Z-validation", createdAt: "2000-01-01T00:00:00.000Z" },
			controllerSessionId: "draft-validation",
			draft: candidate,
			modelPlan: candidate.modelPlan,
			effectiveSettings: candidate.effectiveSettings as RecoveryDefaults,
			integrationBase: isCodeChanging(candidate.tasks) ? { kind: "git", branch: "validation", revision: "0000000000000000000000000000000000000000" } : { kind: "none" },
		});
		return {
			value: {
				declaredOutcome: provisional.run.declaredOutcome,
				tasks: provisional.run.tasks.map((task) => ({
					requiredOutcome: task.contract.requiredOutcome,
					allowedScope: [...task.contract.allowedScope],
					expectedArtifacts: task.contract.expectedArtifacts.map(cloneArtifact),
					verification: cloneVerification(task.contract.verification),
					reviewRequired: task.contract.reviewRequired,
				})),
				modelPlan: cloneModelPlans(provisional.run.modelPlan),
				effectiveSettings: cloneRecoveryDefaults(provisional.run.effectiveSettings),
				finalVerification: cloneVerification(provisional.run.finalVerification),
			},
			diagnostics: [],
		};
	} catch (error: unknown) {
		return { diagnostics: [diagnostic("invalid-contract", error instanceof Error ? error.message : "Run draft validation failed.", "run")] };
	}
}

export function createActivityEntry(timestamp: Date, runId: string): ActivityEntry {
	return { timestamp: timestamp.toISOString(), runId, event: "run-started", message: "Run Journal created; all Tasks are pending." };
}

export function buildRunConfirmationSummary(input: {
	journal: RunJournal;
	activeJournalPath: string;
	activityLogPath: string;
}): RunConfirmationSummary {
	const tasks = input.journal.run.tasks.map((task, index) => ({
		number: index + 1,
		contract: cloneContract(task.contract),
		specificationHash: task.specificationHash,
		warnings: [
			...(isCodeChanging([task]) && !task.contract.reviewRequired ? ["WARNING: code-changing Task has Review disabled."] : []),
			...(task.contract.verification.kind === "criteria" && task.contract.verification.deterministicCommandWaiver ? ["WARNING: criteria-only verification uses an explicit deterministic command waiver."] : []),
		],
	}));
	const run = input.journal.run;
	const markdown = [
		`Run ${run.id}: ${run.declaredOutcome}`,
		"",
		...tasks.flatMap((task) => [
			`Task ${task.number} (${task.contract.id})`,
			`  requiredOutcome: ${task.contract.requiredOutcome}`,
			`  allowedScope: ${task.contract.allowedScope.join(", ")}`,
			`  expectedArtifacts: ${task.contract.expectedArtifacts.map((artifact) => artifact.kind === "file" ? `file:${artifact.path}` : artifact.kind === "evidence" ? `evidence:${artifact.description}` : artifact.kind).join(", ")}`,
			`  verification: ${task.contract.verification.kind === "command" ? `command:${task.contract.verification.command}` : `criteria:${task.contract.verification.criteria}${task.contract.verification.deterministicCommandWaiver ? ` (waiver:${task.contract.verification.deterministicCommandWaiver})` : ""}`}`,
			`  reviewRequired: ${task.contract.reviewRequired}`,
			`  specificationHash: ${task.specificationHash}`,
			...task.warnings.map((warning) => `  ${warning}`),
		]),
		"",
		`Builder Model Plan: ${formatModelPlan(run.modelPlan.builder)}`,
		`Reviewer Model Plan: ${formatModelPlan(run.modelPlan.reviewer)}`,
		`Integration base: ${run.integrationBase.kind === "none" ? "none" : `${run.integrationBase.branch} @ ${run.integrationBase.revision}`}`,
		`Effective settings (maximumActiveTasks is frozen): ${JSON.stringify(run.effectiveSettings)}`,
		`Final verification: ${run.finalVerification.kind === "command" ? run.finalVerification.command : `${run.finalVerification.criteria}${run.finalVerification.deterministicCommandWaiver ? ` (waiver:${run.finalVerification.deterministicCommandWaiver})` : ""}`}`,
		...(run.finalVerification.kind === "criteria" && run.finalVerification.deterministicCommandWaiver ? ["WARNING: final criteria-only verification uses an explicit deterministic command waiver."] : []),
		`Active journal: ${input.activeJournalPath}`,
		`Activity log: ${input.activityLogPath} (non-authoritative; active-run.json is the Run Journal)`,
	].join("\n");
	return {
		runId: run.id,
		declaredOutcome: run.declaredOutcome,
		tasks,
		modelPlan: cloneModelPlans(run.modelPlan),
		effectiveSettings: cloneRecoveryDefaults(run.effectiveSettings),
		integrationBase: run.integrationBase.kind === "none" ? { kind: "none" } : { ...run.integrationBase },
		finalVerification: cloneVerification(run.finalVerification),
		activeJournalPath: input.activeJournalPath,
		activityLogPath: input.activityLogPath,
		markdown,
	};
}

function formatModelPlan(plan: ProjectModelPlans["builder"]): string {
	return [plan.primary, ...plan.fallbacks].map((choice, index) => `${index === 0 ? "primary" : `fallback-${index}`}:${choice.model}[thinking=${choice.thinkingLevel}]`).join(", ");
}
