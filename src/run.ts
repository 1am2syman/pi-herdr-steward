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
import type { TaskFactKey } from "./reconciliation.ts";
import { formatTaskFactInstruction } from "./reconciliation.ts";

export const RUN_JOURNAL_SCHEMA_VERSION = 1 as const;

export type RunStatus = "active" | "completing" | "completed";
export type TaskPhase = "pending" | "building" | "reviewing" | "reworking" | "approved" | "integrating" | "completed";
export type TaskAttention = "none" | "blocked" | "waiting-external" | "suspected-stall" | "recovering" | "needs-user";
export type TaskAttentionReason =
	| "rework-preflight"
	| "protected-evidence"
	| "rework-exhausted"
	| "review-approval-required"
	| "integration-preflight"
	| "integration-failed"
	| "integration-ambiguous"
	| "final-verification-unexecutable"
	| "final-verification-failed"
	| "final-verification-ambiguous"
	| "verification-dirtied-checkout"
	| "agent-stop-failed"
	| "archive-failed"
	| "reconciliation-blocked-question"
	| "reconciliation-report-missing"
	| "reconciliation-live-unclear"
	| "reconciliation-agent-missing"
	| "silence-passive-inspection"
	| "external-process-live"
	| "external-process-grace"
	| "silence-effect-ambiguous"
	| "silence-recovery-exhausted"
	| "transient-infrastructure-recovery"
	| "transient-stop-ambiguous"
	| "transient-fallback-unavailable"
	| "transient-retries-exhausted";

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
	| { phase: "replacement-pane-intended"; branch: string; worktreePath: string; agentName: string; sourcePaneId: string; workspaceId: string }
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
		}
	| {
			phase: "reconciled-active";
			branch: string;
			agentName: string;
			worktreePath: string;
			workspaceId: string;
			paneId: string;
			terminalId: string;
			assignmentSha256: string;
			reconciledAt: string;
			basis: "valid-report" | "matching-live-agent";
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
		  }
	| {
			phase: "reconciled-active";
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
			reconciledAt: string;
			basis: "valid-report" | "matching-live-agent";
		};

export type BuilderDispatchRecord = DispatchRecord | ReworkDispatchRecord;

export type ReviewerDispatchRecord =
	| { phase: "pane-intended"; sourcePaneId: string; worktreePath: string; agentName: string; branch: string; workspaceId?: string; paneId?: string; terminalId?: string }
	| { phase: "replacement-pane-intended"; sourcePaneId: string; worktreePath: string; agentName: string; branch: string; workspaceId: string }
	| { phase: "agent-intended"; agentName: string; worktreePath: string; workspaceId: string; paneId: string; terminalId: string; branch: string }
	| { phase: "prompt-intended"; agentName: string; worktreePath: string; workspaceId: string; paneId: string; terminalId: string; assignmentSha256: string; branch: string }
	| { phase: "prompted"; agentName: string; worktreePath: string; workspaceId: string; paneId: string; terminalId: string; assignmentSha256: string; promptedAt: string; branch: string }
	| { phase: "reconciled-active"; agentName: string; worktreePath: string; workspaceId: string; paneId: string; terminalId: string; assignmentSha256: string; branch: string; reconciledAt: string; basis: "valid-report" | "matching-live-agent" };

export interface RecoveryAgentIdentity {
	name: string;
	workspaceId: string;
	paneId: string;
	terminalId: string;
}

export interface RecoveryPreservation {
	observedAt: string;
	worktreePath: string;
	branch: string;
	head: string | null;
	worktree: MonitorDigest;
	git: { head: string | null; digest: string | null; diagnostic?: string };
	assignment: { path: string; sha256: string; size: number; kind?: never; diagnostic?: never } | { path: string; sha256?: never; size?: never; kind: "missing" | "unavailable"; diagnostic?: string };
	report: MonitorReportObservation;
	evidence: { directory: string; count: number; byteCount: number; sha256: string; entries: Array<{ path: string; size: number; sha256: string }> };
}

export type SilenceProcessObservation =
	| {
			kind: "live-external";
			paneId: string;
			shellPid: number;
			foregroundProcessGroupId: number;
			processCount: number;
			digest: string;
			classification: "test" | "build" | "child";
			executableName: string;
	  }
	| {
			kind: "none";
			paneId: string;
			shellPid: number;
			foregroundProcessGroupId: number;
			processCount: number;
			digest: string;
	  }
	| { kind: "unavailable"; diagnostic: string };

export interface SilenceInspectionSnapshot {
	attemptId: string;
	role: "builder" | "reviewer";
	agent: RecoveryAgentIdentity;
	lifecycle: MonitorLifecycle;
	stateChangeSequence: number | null;
	terminal: MonitorDigest;
	worktree: MonitorDigest;
	git: { head: string | null; digest: string | null; diagnostic?: string };
	assignment: { path: string; size: number; sha256: string };
	report: MonitorReportObservation;
	evidence: { directory: string; count: number; byteCount: number; sha256: string; entries: Array<{ path: string; size: number; sha256: string }> };
	process: SilenceProcessObservation;
}

export type SilencePhase =
	| { phase: "suspected"; lastProgressAt: string; phaseAt: string; inspection: SilenceInspectionSnapshot }
	| { phase: "inspection-incomplete"; lastProgressAt: string; phaseAt: string; inspection: SilenceInspectionSnapshot; diagnostic: string }
	| { phase: "waiting-external"; lastProgressAt: string; phaseAt: string; inspection: SilenceInspectionSnapshot; firstObservedAt: string; lastObservedAt: string; process: Extract<SilenceProcessObservation, { kind: "live-external" }>; warnedAt?: string }
	| { phase: "external-grace"; lastProgressAt: string; phaseAt: string; inspection: SilenceInspectionSnapshot; firstObservedAt: string; lastObservedAt: string; exitedAt: string; process: Extract<SilenceProcessObservation, { kind: "live-external" }>; warnedAt?: string }
	| { phase: "nudge-intended"; lastProgressAt: string; phaseAt: string; inspection: SilenceInspectionSnapshot; target: RecoveryAgentIdentity; intendedAt: string; promptSha256: string }
	| { phase: "nudged"; lastProgressAt: string; phaseAt: string; inspection: SilenceInspectionSnapshot; target: RecoveryAgentIdentity; intendedAt: string; nudgedAt: string; promptSha256: string }
	| { phase: "nudge-ambiguous"; lastProgressAt: string; phaseAt: string; inspection: SilenceInspectionSnapshot; target: RecoveryAgentIdentity; intendedAt: string; observedAt: string; promptSha256: string; diagnostic: string }
	| { phase: "interrupt-intended"; lastProgressAt: string; phaseAt: string; inspection: SilenceInspectionSnapshot; target: RecoveryAgentIdentity; intendedAt: string }
	| { phase: "interrupted"; lastProgressAt: string; phaseAt: string; inspection: SilenceInspectionSnapshot; target: RecoveryAgentIdentity; intendedAt: string; interruptedAt: string }
	| { phase: "interrupt-ambiguous"; lastProgressAt: string; phaseAt: string; inspection: SilenceInspectionSnapshot; target: RecoveryAgentIdentity; intendedAt: string; observedAt: string; diagnostic: string }
	| { phase: "resume-intended"; lastProgressAt: string; phaseAt: string; inspection: SilenceInspectionSnapshot; target: RecoveryAgentIdentity; intendedAt: string; promptSha256: string }
	| { phase: "resumed"; lastProgressAt: string; phaseAt: string; inspection: SilenceInspectionSnapshot; target: RecoveryAgentIdentity; intendedAt: string; resumedAt: string; promptSha256: string }
	| { phase: "resume-ambiguous"; lastProgressAt: string; phaseAt: string; inspection: SilenceInspectionSnapshot; target: RecoveryAgentIdentity; intendedAt: string; observedAt: string; promptSha256: string; diagnostic: string }
	| { phase: "replacement-intended"; lastProgressAt: string; phaseAt: string; inspection: SilenceInspectionSnapshot; target: RecoveryAgentIdentity; intendedAt: string; retryOrdinal: 1 | 2 }
	| { phase: "replacement-ambiguous"; lastProgressAt: string; phaseAt: string; inspection: SilenceInspectionSnapshot; target: RecoveryAgentIdentity; intendedAt: string; observedAt: string; retryOrdinal: 1 | 2; diagnostic: string }
	| { phase: "exhausted"; lastProgressAt: string; phaseAt: string; inspection: SilenceInspectionSnapshot; retryOrdinal: 0 | 1 | 2 };

export type TransientInfrastructureKind = "provider-network-interruption" | "agent-startup-failure" | "herdr-command-failure" | "unexpected-process-exit";
export type TransientInfrastructureStage = "worktree-create" | "pane-split" | "agent-start" | "agent-prompt" | "agent-runtime";

export type RecoveryStop =
	| { phase: "not-required"; reason: "never-started" | "already-missing" | "preservation-unavailable" }
	| { phase: "intended"; intendedAt: string; agent: RecoveryAgentIdentity }
	| { phase: "acknowledged"; intendedAt: string; acknowledgedAt: string; agent: RecoveryAgentIdentity }
	| { phase: "ambiguous"; intendedAt: string; observedAt: string; agent: RecoveryAgentIdentity; diagnostic: string };

export interface InfrastructureOutcome {
	kind: TransientInfrastructureKind;
	stage: TransientInfrastructureStage;
	observedAt: string;
	code: string;
	diagnostic: string;
	source: "typed-herdr-result" | "exact-agent-missing";
	stop: RecoveryStop;
}

export type AttemptReplacement =
	| {
			kind: "silent-agent-recovery";
			replacesAttemptId: string;
			retryOrdinal: 1 | 2;
			preservedAt: string;
	  }
	| {
			kind: "transient-recovery";
			trigger: "silent-agent-recovery" | TransientInfrastructureKind;
			replacesAttemptId: string;
			retryOrdinal: 1 | 2;
			preservedAt: string;
			modelSelection:
				| { kind: "same-model-first"; planIndex: number }
				| { kind: "approved-fallback"; planIndex: number; reason: "same-model-unavailable" | "same-model-retry-failed"; skipped: Array<{ planIndex: number; model: string; codes: string[] }> };
	  };

export interface AttemptRecovery {
	live: {
		observedAt: string;
		kind: "working" | "blocked" | "settled" | "unclear" | "missing";
		lifecycle?: "working" | "blocked" | "idle" | "done" | "unknown";
		stateChangeSequence?: number | null;
		diagnostic?: string;
	};
	infrastructure?: InfrastructureOutcome;
	reportRequest?:
		| { phase: "intended"; intendedAt: string; agent: RecoveryAgentIdentity; reportPath: string }
		| { phase: "requested"; intendedAt: string; requestedAt: string; agent: RecoveryAgentIdentity; reportPath: string }
		| { phase: "ambiguous"; intendedAt: string; observedAt: string; agent: RecoveryAgentIdentity; reportPath: string; diagnostic: string }
		| { phase: "blocked"; intendedAt: string; requestedAt?: string; blockedAt: string; agent: RecoveryAgentIdentity; reportPath: string; diagnostic: string };
	blockedAnswer?:
		| { phase: "intended"; intendedAt: string; agent: RecoveryAgentIdentity; questionSha256: string; fact: TaskFactKey; answerSha256: string }
		| { phase: "acknowledged"; intendedAt: string; acknowledgedAt: string; agent: RecoveryAgentIdentity; questionSha256: string; fact: TaskFactKey; answerSha256: string }
		| { phase: "ambiguous"; intendedAt: string; observedAt: string; agent: RecoveryAgentIdentity; questionSha256: string; fact: TaskFactKey; answerSha256: string; diagnostic: string };
	preservation?: RecoveryPreservation;
	silence?: SilencePhase;
}

export interface BuilderAttemptRecord {
	id: string;
	role: "builder";
	state: "prepared" | "active" | "awaiting-report" | "reported" | "ended-error" | "superseded";
	preparedAt: string;
	activatedAt?: string;
	actualModel: ModelChoice;
	specificationHash: string;
	baseRevision: string;
	assignmentPath: string;
	reportPath: string;
	evidenceDirectory: string;
	dispatch: BuilderDispatchRecord;
	replacement?: AttemptReplacement;
	recovery?: AttemptRecovery;
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
	state: "prepared" | "active" | "awaiting-report" | "reported" | "ended-error" | "superseded";
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
	replacement?: AttemptReplacement;
	recovery?: AttemptRecovery;
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
			continuation?: AttemptContinuation;
	};
}

export type AssignmentDocument = BuilderAssignmentDocument | ReviewerAssignmentDocument;

export interface AttemptContinuation {
	predecessorAttemptId: string;
	retryOrdinal: 1 | 2;
	preservedWorktree: { path: string; branch: string; head: string | null };
	priorAssignmentPath: string;
	priorReportPath: string;
	priorEvidenceDirectory: string;
}

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
	integration?: TaskIntegration;
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

export interface IntegrationCheckoutObservation {
	branch: string | null;
	head: string | null;
	dirtyPaths: string[];
	operationMarkers: string[];
	rangeExact: boolean;
}

export interface ApprovedIntegrationIdentity {
	targetBranch: string;
	targetRevision: string;
	approvedBaseRevision: string;
	approvedHeadRevision: string;
	approvedCommits: string[];
	builderAttemptId: string;
	reviewerAttemptId: string;
	builderManifestSha256: string;
	reviewerManifestSha256: string;
	action:
		| { kind: "fast-forward"; argv: ["merge", "--ff-only", "--no-edit", string] }
		| { kind: "merge-commit"; argv: ["merge", "--no-ff", "--no-edit", string] };
}

export type TaskIntegration =
	| (ApprovedIntegrationIdentity & { phase: "intended"; intendedAt: string })
	| (ApprovedIntegrationIdentity & { phase: "integrated"; intendedAt: string; integratedAt: string; observedHead: string })
	| (ApprovedIntegrationIdentity & { phase: "failed"; intendedAt: string; observedAt: string; exitCode: number | null; diagnostic: string })
	| (ApprovedIntegrationIdentity & { phase: "ambiguous"; intendedAt: string; observedAt: string; exitCode: number | null; diagnostic: string; observed: IntegrationCheckoutObservation });

export type FinalVerificationExecution =
	| {
			phase: "intended";
			id: "verification-01";
			command: string;
			cwd: string;
			logPath: string;
			resultPath: string;
			intendedAt: string;
	  }
	| {
			phase: "passed" | "failed";
			id: "verification-01";
			command: string;
			cwd: string;
			logPath: string;
			resultPath: string;
			intendedAt: string;
			startedAt: string;
			completedAt: string;
			exitCode: number;
			killed: false;
			logSha256: string;
			resultSha256: string;
			checkout: IntegrationCheckoutObservation;
	  }
	| {
			phase: "ambiguous";
			id: "verification-01";
			command: string;
			cwd: string;
			logPath: string;
			resultPath: string;
			intendedAt: string;
			observedAt: string;
			exitCode: number | null;
			killed: boolean | null;
			diagnostic: string;
			logSha256?: string;
			resultSha256?: string;
			checkout?: IntegrationCheckoutObservation;
	  };

export const COMPLETION_GATE_PREDICATES = [
	"one-task-exact-specification",
	"builder-evidence-finalized",
	"reviewer-evidence-finalized",
	"approval-current",
	"integration-exact",
	"final-verification-passed",
	"integration-checkout-clean",
	"no-unresolved-attention",
] as const;

export type CompletionGatePredicate = (typeof COMPLETION_GATE_PREDICATES)[number];

export interface CompletionGateFacts {
	evaluatedAt: string;
	taskId: string;
	integratedHead: string;
	verificationResultSha256: string;
	verificationLogSha256: string;
	checkout: IntegrationCheckoutObservation;
	predicates: CompletionGatePredicate[];
}

export const MULTI_COMPLETION_GATE_PREDICATES = [
	"all-tasks-exact-specification",
	"all-task-evidence-finalized",
	"all-approvals-current",
	"ordered-integration-prefix",
	"final-verification-passed",
	"integration-checkout-clean",
	"no-unresolved-attention",
] as const;

export type MultiCompletionGatePredicate = (typeof MULTI_COMPLETION_GATE_PREDICATES)[number];

export interface MultiCompletionTaskFacts {
	taskId: string;
	kind: "code" | "non-code";
	builderAttemptId: string;
	reviewerAttemptId?: string;
	source?: {
		baseRevision: string;
		headRevision: string;
		commits: string[];
		builderManifestSha256: string;
		reviewerManifestSha256: string;
	};
	integration?: {
		targetBranch: string;
		targetRevision: string;
		approvedBaseRevision: string;
		approvedHeadRevision: string;
		approvedCommits: string[];
		observedHead: string;
		action: ApprovedIntegrationIdentity["action"];
	};
}

export interface MultiCompletionGateFacts {
	kind: "multi-task";
	evaluatedAt: string;
	tasks: MultiCompletionTaskFacts[];
	integratedHead: string;
	verificationResultSha256: string;
	verificationLogSha256: string;
	checkout: IntegrationCheckoutObservation;
	predicates: MultiCompletionGatePredicate[];
}

export type AnyCompletionGateFacts = CompletionGateFacts | MultiCompletionGateFacts;

export type CompletionAgentRole = "builder" | "reviewer";

export interface CompletionAgentIdentity {
	role: CompletionAgentRole;
	agentName: string;
	workspaceId: string;
	paneId: string;
	terminalId: string;
}

export type CompletionStopResource =
	| (CompletionAgentIdentity & { state: "intended"; intendedAt: string })
	| (CompletionAgentIdentity & {
			state: "acknowledged";
			intendedAt: string;
			acknowledgedAt: string;
			acknowledgement: { name: string; workspaceId: string; tabId: string; paneId: string; terminalId: string };
	  });

export interface CompletionStopFailure {
	state: "failed" | "ambiguous";
		resource: CompletionAgentIdentity;
		observedAt: string;
		diagnostic: string;
}

export interface CompletionReportInventoryItem {
	taskId: string;
	attemptId: string;
	role: CompletionAgentRole;
	sourcePath: string;
	destinationPath: string;
	size: number;
	sha256: string;
}

export interface CompletionArchiveIntent {
	intendedAt: string;
	archiveDirectory: string;
	runPath: string;
	previousRunPath: string;
	manifestPath: string;
	activeJournalSha256: string;
	previousJournalSha256: string;
	verification: { logPath: string; resultPath: string; logSha256: string; resultSha256: string };
	reports: CompletionReportInventoryItem[];
}

export type CompletionRecord =
	| { phase: "gate-passed"; gate: AnyCompletionGateFacts }
	| { phase: "stops-intended"; gate: AnyCompletionGateFacts; resources: CompletionStopResource[] }
	| { phase: "stops-incomplete"; gate: AnyCompletionGateFacts; resources: CompletionStopResource[]; failure: CompletionStopFailure }
	| { phase: "stops-complete"; gate: AnyCompletionGateFacts; resources: Array<Extract<CompletionStopResource, { state: "acknowledged" }>> }
	| { phase: "archive-intended"; gate: AnyCompletionGateFacts; resources: Array<Extract<CompletionStopResource, { state: "acknowledged" }>>; archive: CompletionArchiveIntent }
	| { phase: "archived"; gate: AnyCompletionGateFacts; resources: Array<Extract<CompletionStopResource, { state: "acknowledged" }>>; archive: CompletionArchiveIntent; archivedAt: string };

export type MonitorLifecycle = "working" | "blocked" | "idle" | "done" | "unknown" | "unavailable";

export type MonitorDigest =
	| { kind: "observed"; byteCount: number; sha256: string }
	| { kind: "unavailable"; diagnostic: string };

export type MonitorReportObservation =
	| { kind: "missing" }
	| { kind: "present"; size: number; sha256: string }
	| { kind: "unavailable"; diagnostic: string };

export interface MonitorCheckpoint {
	observedAt: string;
	taskId: string;
	attemptId: string;
	role: "builder" | "reviewer";
	agent: {
		name: string;
		workspaceId: string;
		paneId: string;
		terminalId: string;
		lifecycle: MonitorLifecycle;
		stateChangeSequence: number | null;
	};
	terminal: MonitorDigest;
	worktree: MonitorDigest;
	git: { head: string | null; digest: string | null; diagnostic?: string };
	report: MonitorReportObservation;
}

export type CompletionGateResult =
	| { passed: true; facts: Omit<CompletionGateFacts, "evaluatedAt"> | Omit<MultiCompletionGateFacts, "evaluatedAt"> }
	| { passed: false; failures: string[] };

/**
 * Evaluate the ticket-08 Completion Gate from already validated durable facts.
 *
 * This function deliberately has no clock, filesystem, Git, process, UI, or
 * Herdr dependency.  Callers must load/hash protected evidence and obtain the
 * fresh checkout observation before calling it; the returned facts are only a
 * proof summary and never perform a transition.
 */
export function evaluateCompletionGate(journal: RunJournal, checkout: IntegrationCheckoutObservation): CompletionGateResult {
	if (journal.run.tasks.length > 1) return evaluateMultiCompletionGate(journal, checkout);
	const failures: string[] = [];
	if (journal.run.tasks.length !== 1) failures.push("exactly one Task is required");
	const task = journal.run.tasks[0];
	const base = journal.run.integrationBase;
	if (!task || base.kind !== "git" || task.contract.expectedArtifacts.filter((artifact) => artifact.kind === "git-commit").length !== 1 || !task.specificationHash.startsWith("sha256:")) failures.push("the Run must contain one exact code-changing Task specification");
	const approval = task?.approval;
	const builder = task?.attempts.find((attempt): attempt is BuilderAttemptRecord => attempt.id === approval?.builderAttemptId && attempt.role === "builder");
	const reviewer = task?.attempts.find((attempt): attempt is ReviewerAttemptRecord => attempt.id === approval?.reviewerAttemptId && attempt.role === "reviewer");
	const builderEvidence = builder?.evidence;
	const reviewerEvidence = reviewer?.evidence;
	if (!builder || builderEvidence?.phase !== "finalized" || builderEvidence.status !== "completed" || !builderEvidence.manifestPath || !builderEvidence.manifestSha256 || builderEvidence.producedRevision === null) failures.push("finalized completed Builder evidence is required");
	if (!reviewer || reviewerEvidence?.phase !== "finalized" || reviewerEvidence.verdict !== "approved" || reviewer.integrity?.kind !== "preserved") failures.push("finalized approved Reviewer evidence with preserved integrity is required");
	if (!approval || approval.phase !== "valid" || !builder || !reviewer || reviewerEvidence?.phase !== "finalized" || builderEvidence?.phase !== "finalized" || JSON.stringify(approval.subject) !== JSON.stringify(reviewer.subject) || approval.builderAttemptId !== builder.id || approval.reviewerAttemptId !== reviewer.id || approval.reviewerManifestSha256 !== reviewerEvidence.manifestSha256 || approval.worktreeSnapshot.dirtyPaths.length !== 0 || approval.worktreeSnapshot.operationMarkers.length !== 0) failures.push("the current Approval must bind the exact final evidence and clean Reviewer snapshot");
	const integration = task?.integration;
	const subject = approval?.phase === "valid" ? approval.subject : undefined;
	const integrationMatches = Boolean(integration && integration.phase === "integrated" && approval?.phase === "valid" && base.kind === "git" && subject?.kind === "git" && subject.commits.at(-1) === subject.headRevision && base.revision === subject.baseRevision && integration.targetBranch === base.branch && integration.targetRevision === base.revision && integration.approvedBaseRevision === base.revision && integration.approvedBaseRevision === subject.baseRevision && integration.approvedHeadRevision === subject.headRevision && integration.builderAttemptId === approval.builderAttemptId && integration.reviewerAttemptId === approval.reviewerAttemptId && integration.builderManifestSha256 === subject.builderManifestSha256 && integration.reviewerManifestSha256 === approval.reviewerManifestSha256 && integration.action.argv[0] === "merge" && integration.action.argv[1] === "--ff-only" && integration.action.argv[2] === "--no-edit" && integration.action.argv[3] === integration.approvedHeadRevision && JSON.stringify(integration.approvedCommits) === JSON.stringify(subject.commits));
	if (!integrationMatches) failures.push("the exact approved fast-forward integration identity is required");
	const execution = journal.run.finalVerificationExecution;
	if (!execution || execution.phase !== "passed" || journal.run.finalVerification.kind !== "command" || execution.command !== journal.run.finalVerification.command || execution.exitCode !== 0 || execution.killed || !execution.logSha256 || !execution.resultSha256) failures.push("one exact passing final-verification result is required");
	if (checkout.branch !== (base.kind === "git" ? base.branch : null) || checkout.head !== (integration?.phase === "integrated" ? integration.approvedHeadRevision : null) || checkout.dirtyPaths.length !== 0 || checkout.operationMarkers.length !== 0 || !checkout.rangeExact) failures.push("the fresh integration checkout must be exact, clean, and marker-free");
	if (journal.run.status === "completed" || task?.attention !== "none" || approval?.phase !== "valid" || task?.attempts.some((attempt) => attempt.role === "reviewer" && (attempt.reportRepair?.phase === "blocked" || attempt.integrity?.kind === "violated"))) failures.push("no unresolved attention or invalidated evidence may remain");
	if (failures.length > 0) return { passed: false, failures: failures.slice(0, 8) };
	const passedExecution = execution as FinalVerificationExecution & { phase: "passed"; resultSha256: string; logSha256: string };
	const integrated = integration as Extract<TaskIntegration, { phase: "integrated" }>;
	return {
		passed: true,
		facts: {
			taskId: task!.contract.id,
			integratedHead: integrated.approvedHeadRevision,
			verificationResultSha256: passedExecution.resultSha256,
			verificationLogSha256: passedExecution.logSha256,
			checkout: cloneIntegrationObservation(checkout),
			predicates: [...COMPLETION_GATE_PREDICATES],
		},
	};
}

function evaluateMultiCompletionGate(journal: RunJournal, checkout: IntegrationCheckoutObservation): CompletionGateResult {
	const failures: string[] = [];
	const base = journal.run.integrationBase;
	const execution = journal.run.finalVerificationExecution;
	if (base.kind !== "git") failures.push("multi-Task completion requires a git integration base");
	if (journal.run.status === "completed") failures.push("the Run is already completed");
	if (!execution || execution.phase !== "passed" || journal.run.finalVerification.kind !== "command" || execution.command !== journal.run.finalVerification.command || execution.exitCode !== 0 || execution.killed || !execution.logSha256 || !execution.resultSha256) failures.push("one exact passing final-verification result is required");
	let integratedHead = base.kind === "git" ? base.revision : "";
	const facts: MultiCompletionTaskFacts[] = [];
	for (const task of journal.run.tasks) {
		const builder = [...task.attempts].reverse().find((attempt): attempt is BuilderAttemptRecord => attempt.role === "builder");
		const reviewer = [...task.attempts].reverse().find((attempt): attempt is ReviewerAttemptRecord => attempt.role === "reviewer");
		if (!builder || builder.evidence?.phase !== "finalized" || builder.evidence.status !== "completed") failures.push(`${task.contract.id} lacks finalized completed Builder evidence`);
		if (task.attention !== "none" || task.attempts.some((attempt) => (attempt.role === "reviewer" && (attempt.reportRepair?.phase === "blocked" || attempt.integrity?.kind === "violated")))) failures.push(`${task.contract.id} has unresolved attention or evidence integrity failure`);
		const isCode = task.contract.expectedArtifacts.some((artifact) => artifact.kind === "git-commit");
		if (!isCode) {
			if (task.phase !== "completed") failures.push(`${task.contract.id} is not complete`);
			if (!builder) continue;
			facts.push({ taskId: task.contract.id, kind: "non-code", builderAttemptId: builder.id, ...(reviewer ? { reviewerAttemptId: reviewer.id } : {}) });
			continue;
		}
		const approval = task.approval;
		const subject = approval?.phase === "valid" && approval.subject.kind === "git" ? approval.subject : undefined;
		const builderEvidence = builder?.evidence;
		const reviewerEvidence = reviewer?.evidence;
		if (!reviewer || reviewerEvidence?.phase !== "finalized" || reviewerEvidence.verdict !== "approved" || reviewer.integrity?.kind !== "preserved" || !approval || approval.phase !== "valid" || !subject || approval.builderAttemptId !== builder?.id || approval.reviewerAttemptId !== reviewer.id || approval.reviewerManifestSha256 !== reviewerEvidence.manifestSha256 || JSON.stringify(approval.subject) !== JSON.stringify(reviewerEvidence.subject) || approval.worktreeSnapshot.dirtyPaths.length !== 0 || approval.worktreeSnapshot.operationMarkers.length !== 0) failures.push(`${task.contract.id} lacks current exact Approval and Reviewer evidence`);
		const integration = task.integration;
		const expectedAction = integration && integration.targetRevision === (base.kind === "git" ? integratedHead : "") && integration.approvedBaseRevision === subject?.baseRevision ? (integration.targetRevision === integration.approvedBaseRevision ? "fast-forward" : "merge-commit") : undefined;
		if (!integration || integration.phase !== "integrated" || !subject || subject.commits.at(-1) !== subject.headRevision || integration.targetBranch !== (base.kind === "git" ? base.branch : "") || integration.targetRevision !== integratedHead || integration.approvedBaseRevision !== subject.baseRevision || integration.approvedHeadRevision !== subject.headRevision || JSON.stringify(integration.approvedCommits) !== JSON.stringify(subject.commits) || integration.builderAttemptId !== approval?.builderAttemptId || integration.reviewerAttemptId !== approval?.reviewerAttemptId || integration.builderManifestSha256 !== subject.builderManifestSha256 || integration.reviewerManifestSha256 !== approval?.reviewerManifestSha256 || integration.observedHead !== integration.approvedHeadRevision && integration.action.kind === "fast-forward" || integration.action.kind !== expectedAction) failures.push(`${task.contract.id} lacks an exact ordered integration identity`);
		if (integration?.phase === "integrated") integratedHead = integration.observedHead;
		facts.push({ taskId: task.contract.id, kind: "code", builderAttemptId: builder?.id ?? "missing-builder", reviewerAttemptId: reviewer?.id ?? "missing-reviewer", ...(subject && builderEvidence?.phase === "finalized" && reviewerEvidence?.phase === "finalized" ? { source: { baseRevision: subject.baseRevision, headRevision: subject.headRevision, commits: [...subject.commits], builderManifestSha256: builderEvidence.manifestSha256, reviewerManifestSha256: reviewerEvidence.manifestSha256 } } : {}), ...(integration?.phase === "integrated" ? { integration: { targetBranch: integration.targetBranch, targetRevision: integration.targetRevision, approvedBaseRevision: integration.approvedBaseRevision, approvedHeadRevision: integration.approvedHeadRevision, approvedCommits: [...integration.approvedCommits], observedHead: integration.observedHead, action: integration.action } } : {}) });
	}
	if (base.kind === "git" && (checkout.branch !== base.branch || checkout.head !== integratedHead || checkout.dirtyPaths.length !== 0 || checkout.operationMarkers.length !== 0 || !checkout.rangeExact)) failures.push("the fresh integration checkout must be exact, clean, and marker-free");
	if (failures.length > 0 || !execution || execution.phase !== "passed" || base.kind !== "git") return { passed: false, failures: failures.slice(0, 8) };
	return { passed: true, facts: { kind: "multi-task", tasks: facts, integratedHead, verificationResultSha256: execution.resultSha256, verificationLogSha256: execution.logSha256, checkout: cloneIntegrationObservation(checkout), predicates: [...MULTI_COMPLETION_GATE_PREDICATES] } };
}

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
	finalVerificationExecution?: FinalVerificationExecution;
	completion?: CompletionRecord;
	monitor?: MonitorCheckpoint;
	monitors?: MonitorCheckpoint[];
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

function validateRecoveryIdentity(value: unknown, path: string): { value?: RecoveryAgentIdentity; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || !exactKeys(value, ["name", "workspaceId", "paneId", "terminalId"]) || !herdrName(value.name) || !trimmedString(value.workspaceId) || !trimmedString(value.paneId) || !trimmedString(value.terminalId)) return { diagnostics: [diagnostic("invalid-task", "Recovery agent identity must exactly identify a Steward Pi resource.", path)] };
	return { value: { name: value.name, workspaceId: value.workspaceId, paneId: value.paneId, terminalId: value.terminalId }, diagnostics: [] };
}

function validateRecoveryPreservation(value: unknown, path: string): { value?: RecoveryPreservation; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || !exactKeys(value, ["observedAt", "worktreePath", "branch", "head", "worktree", "git", "assignment", "report", "evidence"]) || !canonicalTimestamp(value.observedAt) || !absolutePathValue(value.worktreePath) || !safeBranch(value.branch) || (value.head !== null && (typeof value.head !== "string" || !/^[0-9a-f]{40}$/.test(value.head)))) return { diagnostics: [diagnostic("invalid-task", "Recovery preservation has invalid identity or timestamp fields.", path)] };
	const worktree = validateMonitorDigest(value.worktree, `${path}.worktree`);
	const report = validateMonitorReport(value.report, `${path}.report`);
	const git = value.git;
	const gitValid = isRecord(git) && (exactKeys(git, ["head", "digest"]) || exactKeys(git, ["head", "digest", "diagnostic"])) && (git.head === null || (typeof git.head === "string" && /^[0-9a-f]{40}$/.test(git.head))) && (git.digest === null || monitorHash(git.digest)) && (!Object.prototype.hasOwnProperty.call(git, "diagnostic") || monitorDiagnostic(git.diagnostic));
	if (!gitValid) return { diagnostics: [...worktree.diagnostics, ...report.diagnostics, diagnostic("invalid-task", "Recovery preservation Git observation is invalid.", `${path}.git`)] };
	const assignment = value.assignment;
	const assignmentValid = (isRecord(assignment) && exactKeys(assignment, ["path", "sha256", "size"]) && absolutePathValue(assignment.path) && monitorHash(assignment.sha256) && typeof assignment.size === "number" && Number.isSafeInteger(assignment.size) && assignment.size >= 0 && assignment.size <= 64 * 1024)
		|| (isRecord(assignment) && (assignment.kind === "missing" || assignment.kind === "unavailable") && exactKeys(assignment, assignment.kind === "missing" ? ["kind", "path"] : ["kind", "path", "diagnostic"]) && absolutePathValue(assignment.path) && (assignment.kind === "missing" || monitorDiagnostic(assignment.diagnostic)));
	const evidence = value.evidence;
	const entries = isRecord(evidence) && Array.isArray(evidence.entries) ? evidence.entries : undefined;
	const evidenceValid = isRecord(evidence) && exactKeys(evidence, ["directory", "count", "byteCount", "sha256", "entries"]) && absolutePathValue(evidence.directory) && typeof evidence.count === "number" && Number.isSafeInteger(evidence.count) && evidence.count >= 0 && evidence.count <= 512 && typeof evidence.byteCount === "number" && Number.isSafeInteger(evidence.byteCount) && evidence.byteCount >= 0 && evidence.byteCount <= 16 * 1024 * 1024 && monitorHash(evidence.sha256) && entries !== undefined && entries.length === evidence.count && entries.every((entry) => isRecord(entry) && exactKeys(entry, ["path", "size", "sha256"]) && pathValue(entry.path) && typeof entry.size === "number" && Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= 16 * 1024 * 1024 && monitorHash(entry.sha256));
	if (!assignmentValid || !evidenceValid || worktree.diagnostics.length > 0 || report.diagnostics.length > 0) return { diagnostics: [...worktree.diagnostics, ...report.diagnostics, diagnostic("invalid-task", "Recovery preservation contains invalid bounded Assignment or evidence observations.", path)] };
	return {
		value: {
			observedAt: value.observedAt,
			worktreePath: value.worktreePath,
			branch: value.branch,
			head: value.head,
			worktree: worktree.value!,
			git: { head: git.head as string | null, digest: git.digest as string | null, ...(Object.prototype.hasOwnProperty.call(git, "diagnostic") ? { diagnostic: git.diagnostic as string } : {}) },
				assignment: assignment.kind === "missing" || assignment.kind === "unavailable"
					? { kind: assignment.kind, path: assignment.path as string, ...(assignment.kind === "unavailable" ? { diagnostic: assignment.diagnostic as string } : {}) }
					: { path: assignment.path as string, sha256: assignment.sha256 as string, size: assignment.size as number },
			report: report.value!,
			evidence: { directory: evidence.directory as string, count: evidence.count as number, byteCount: evidence.byteCount as number, sha256: evidence.sha256 as string, entries: entries!.map((entry) => ({ path: (entry as Record<string, unknown>).path as string, size: (entry as Record<string, unknown>).size as number, sha256: (entry as Record<string, unknown>).sha256 as string })) },
		},
		diagnostics: [],
	};
}

function validateSilenceProcess(value: unknown, path: string): { value?: SilenceProcessObservation; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || typeof value.kind !== "string") return { diagnostics: [diagnostic("invalid-task", "Silence process observation must be a recognized exact record.", path)] };
	if (value.kind === "unavailable" && exactKeys(value, ["kind", "diagnostic"]) && boundedText(value.diagnostic, 2_000)) return { value: { kind: "unavailable", diagnostic: value.diagnostic }, diagnostics: [] };
	const common = (keys: string[]) => exactKeys(value, keys) && trimmedString(value.paneId) && typeof value.shellPid === "number" && Number.isSafeInteger(value.shellPid) && value.shellPid > 0 && typeof value.foregroundProcessGroupId === "number" && Number.isSafeInteger(value.foregroundProcessGroupId) && value.foregroundProcessGroupId > 0 && typeof value.processCount === "number" && Number.isSafeInteger(value.processCount) && value.processCount > 0 && value.processCount <= 512 && monitorHash(value.digest);
	if (value.kind === "none" && common(["kind", "paneId", "shellPid", "foregroundProcessGroupId", "processCount", "digest"])) return { value: { kind: "none", paneId: value.paneId as string, shellPid: value.shellPid as number, foregroundProcessGroupId: value.foregroundProcessGroupId as number, processCount: value.processCount as number, digest: value.digest as string }, diagnostics: [] };
	if (value.kind === "live-external" && common(["kind", "paneId", "shellPid", "foregroundProcessGroupId", "processCount", "digest", "classification", "executableName"]) && (value.classification === "test" || value.classification === "build" || value.classification === "child") && boundedText(value.executableName, 256)) return { value: { kind: "live-external", paneId: value.paneId as string, shellPid: value.shellPid as number, foregroundProcessGroupId: value.foregroundProcessGroupId as number, processCount: value.processCount as number, digest: value.digest as string, classification: value.classification, executableName: value.executableName }, diagnostics: [] };
	return { diagnostics: [diagnostic("invalid-task", "Silence process observation has invalid exact bounded fields.", path)] };
}

function validateSilenceInspection(value: unknown, path: string, attemptId: string, role: "builder" | "reviewer", dispatch: { agentName: string; workspaceId?: string; paneId?: string; terminalId?: string }): { value?: SilenceInspectionSnapshot; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || !exactKeys(value, ["attemptId", "role", "agent", "lifecycle", "stateChangeSequence", "terminal", "worktree", "git", "assignment", "report", "evidence", "process"]) || value.attemptId !== attemptId || value.role !== role) return { diagnostics: [diagnostic("invalid-task", "Silence inspection identity or exact keys are invalid.", path)] };
	const agent = validateRecoveryIdentity(value.agent, `${path}.agent`);
	const terminal = validateMonitorDigest(value.terminal, `${path}.terminal`);
	const worktree = validateMonitorDigest(value.worktree, `${path}.worktree`);
	const report = validateMonitorReport(value.report, `${path}.report`);
	const process = validateSilenceProcess(value.process, `${path}.process`);
	const git = value.git;
	const gitValid = isRecord(git) && (exactKeys(git, ["head", "digest"]) || exactKeys(git, ["head", "digest", "diagnostic"])) && (git.head === null || (typeof git.head === "string" && /^[0-9a-f]{40}$/.test(git.head))) && (git.digest === null || monitorHash(git.digest)) && (!Object.prototype.hasOwnProperty.call(git, "diagnostic") || monitorDiagnostic(git.diagnostic));
	const assignment = value.assignment;
	const assignmentValid = isRecord(assignment) && exactKeys(assignment, ["path", "size", "sha256"]) && absolutePathValue(assignment.path) && typeof assignment.size === "number" && Number.isSafeInteger(assignment.size) && assignment.size >= 0 && assignment.size <= 64 * 1024 && monitorHash(assignment.sha256);
	const evidence = value.evidence;
	const entries = isRecord(evidence) && Array.isArray(evidence.entries) ? evidence.entries : undefined;
	const evidenceValid = isRecord(evidence) && exactKeys(evidence, ["directory", "count", "byteCount", "sha256", "entries"]) && absolutePathValue(evidence.directory) && typeof evidence.count === "number" && Number.isSafeInteger(evidence.count) && evidence.count >= 0 && evidence.count <= 512 && typeof evidence.byteCount === "number" && Number.isSafeInteger(evidence.byteCount) && evidence.byteCount >= 0 && evidence.byteCount <= 16 * 1024 * 1024 && monitorHash(evidence.sha256) && entries !== undefined && entries.length === evidence.count && entries.every((entry) => isRecord(entry) && exactKeys(entry, ["path", "size", "sha256"]) && pathValue(entry.path) && typeof entry.size === "number" && Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= 16 * 1024 * 1024 && monitorHash(entry.sha256));
	const dispatchIdentity = dispatch as { agentName: string; workspaceId?: string; paneId?: string; terminalId?: string };
	const identityMatches = agent.value && agent.value.name === dispatchIdentity.agentName && agent.value.workspaceId === dispatchIdentity.workspaceId && agent.value.paneId === dispatchIdentity.paneId && agent.value.terminalId === dispatchIdentity.terminalId;
	const diagnostics = [...agent.diagnostics, ...terminal.diagnostics, ...worktree.diagnostics, ...report.diagnostics, ...process.diagnostics];
	if (!["working", "blocked", "idle", "done", "unknown", "unavailable"].includes(value.lifecycle as string)) diagnostics.push(diagnostic("invalid-task", "Silence inspection lifecycle is invalid.", `${path}.lifecycle`));
	if (value.stateChangeSequence !== null && (typeof value.stateChangeSequence !== "number" || !Number.isSafeInteger(value.stateChangeSequence) || value.stateChangeSequence < 0)) diagnostics.push(diagnostic("invalid-task", "Silence inspection state-change sequence is invalid.", `${path}.stateChangeSequence`));
	if (!gitValid) diagnostics.push(diagnostic("invalid-task", "Silence inspection Git observation is invalid.", `${path}.git`));
	if (!assignmentValid || !evidenceValid) diagnostics.push(diagnostic("invalid-task", "Silence inspection Assignment or evidence inventory is invalid.", path));
	if (!identityMatches) diagnostics.push(diagnostic("invalid-task", "Silence inspection identity does not match the Attempt dispatch.", path));
	if (process.value && process.value.kind !== "unavailable" && process.value.paneId !== dispatchIdentity.paneId) diagnostics.push(diagnostic("invalid-task", "Silence process observation does not match the Attempt pane identity.", `${path}.process`));
	if (diagnostics.length > 0 || !agent.value || !terminal.value || !worktree.value || !report.value || !process.value || !isRecord(git) || !isRecord(assignment) || !isRecord(evidence) || !entries) return { diagnostics };
	return { value: { attemptId: value.attemptId as string, role: value.role as "builder" | "reviewer", agent: agent.value, lifecycle: value.lifecycle as MonitorLifecycle, stateChangeSequence: value.stateChangeSequence as number | null, terminal: terminal.value, worktree: worktree.value, git: { head: git.head as string | null, digest: git.digest as string | null, ...(Object.prototype.hasOwnProperty.call(git, "diagnostic") ? { diagnostic: git.diagnostic as string } : {}) }, assignment: { path: assignment.path as string, size: assignment.size as number, sha256: assignment.sha256 as string }, report: report.value, evidence: { directory: evidence.directory as string, count: evidence.count as number, byteCount: evidence.byteCount as number, sha256: evidence.sha256 as string, entries: entries.map((entry) => ({ path: (entry as Record<string, unknown>).path as string, size: (entry as Record<string, unknown>).size as number, sha256: (entry as Record<string, unknown>).sha256 as string })) }, process: process.value }, diagnostics: [] };
}

function validateSilence(value: unknown, path: string, attemptId: string, role: "builder" | "reviewer", dispatch: { agentName: string; workspaceId?: string; paneId?: string; terminalId?: string }, preparedAt: string, attemptState: string): { value?: SilencePhase; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || typeof value.phase !== "string" || !canonicalTimestamp(value.lastProgressAt) || !canonicalTimestamp(value.phaseAt) || value.lastProgressAt < preparedAt || value.phaseAt < value.lastProgressAt || !isRecord(value.inspection)) return { diagnostics: [diagnostic("invalid-task", "Silence record has invalid common timestamps or inspection.", path)] };
	const inspection = validateSilenceInspection(value.inspection, `${path}.inspection`, attemptId, role, dispatch);
	const phase = value.phase as string;
	const target = Object.prototype.hasOwnProperty.call(value, "target") ? validateRecoveryIdentity(value.target, `${path}.target`) : { value: undefined, diagnostics: [] };
	const targetMatches = !target.value || (target.value.name === dispatch.agentName && target.value.workspaceId === dispatch.workspaceId && target.value.paneId === dispatch.paneId && target.value.terminalId === dispatch.terminalId);
	const commonKeys = ["phase", "lastProgressAt", "phaseAt", "inspection"];
	const timestamp = (key: string): boolean => canonicalTimestamp(value[key]);
	const hash = (key: string): boolean => monitorHash(value[key]);
	let expected: string[] | undefined;
	if (phase === "suspected") expected = commonKeys;
	else if (phase === "inspection-incomplete") expected = [...commonKeys, "diagnostic"];
	else if (phase === "waiting-external" || phase === "external-grace") expected = [...commonKeys, "firstObservedAt", "lastObservedAt", ...(phase === "external-grace" ? ["exitedAt"] : []), "process", ...(Object.prototype.hasOwnProperty.call(value, "warnedAt") ? ["warnedAt"] : [])];
	else if (["nudge-intended", "nudged", "nudge-ambiguous"].includes(phase)) expected = [...commonKeys, "target", "intendedAt", ...(phase === "nudge-intended" ? [] : phase === "nudged" ? ["nudgedAt"] : ["observedAt", "diagnostic"]), "promptSha256"];
	else if (["interrupt-intended", "interrupted", "interrupt-ambiguous"].includes(phase)) expected = [...commonKeys, "target", "intendedAt", ...(phase === "interrupt-intended" ? [] : phase === "interrupted" ? ["interruptedAt"] : ["observedAt", "diagnostic"])] ;
	else if (["resume-intended", "resumed", "resume-ambiguous"].includes(phase)) expected = [...commonKeys, "target", "intendedAt", ...(phase === "resume-intended" ? [] : phase === "resumed" ? ["resumedAt"] : ["observedAt", "diagnostic"]), "promptSha256"];
	else if (phase === "replacement-intended") expected = [...commonKeys, "target", "intendedAt", "retryOrdinal"];
	else if (phase === "replacement-ambiguous") expected = [...commonKeys, "target", "intendedAt", "observedAt", "retryOrdinal", "diagnostic"];
	else if (phase === "exhausted") expected = [...commonKeys, "retryOrdinal"];
	if (!expected || !exactKeys(value, expected)) return { diagnostics: [diagnostic("invalid-task", "Silence phase contains unknown or missing exact fields.", path)] };
	const diagnostics = [...inspection.diagnostics, ...target.diagnostics];
	if (target.value && !targetMatches) diagnostics.push(diagnostic("invalid-task", "Silence effect target does not match the exact Attempt identity.", `${path}.target`));
	if (["inspection-incomplete"].includes(phase) && !boundedText(value.diagnostic, 2_000)) diagnostics.push(diagnostic("invalid-task", "Incomplete silence inspection requires a bounded diagnostic.", `${path}.diagnostic`));
	const externalProcess = validateSilenceProcess(value.process, `${path}.process`).value;
	const expectedInspectionProcess = phase === "waiting-external" ? "live-external" : "none";
	if ((phase === "waiting-external" || phase === "external-grace") && (!canonicalTimestamp(value.firstObservedAt) || !canonicalTimestamp(value.lastObservedAt) || value.firstObservedAt < value.lastProgressAt || value.lastObservedAt < value.firstObservedAt || (phase === "external-grace" && (!canonicalTimestamp(value.exitedAt) || value.exitedAt < value.lastObservedAt)) || !externalProcess || externalProcess.kind !== "live-external" || externalProcess.paneId !== dispatch.paneId || inspection.value?.process.kind !== expectedInspectionProcess || (Object.prototype.hasOwnProperty.call(value, "warnedAt") && (!canonicalTimestamp(value.warnedAt) || value.warnedAt < value.firstObservedAt || value.warnedAt > value.lastObservedAt)))) diagnostics.push(diagnostic("invalid-task", "External silence phase has invalid process identity or timestamps.", path));
	if (Object.prototype.hasOwnProperty.call(value, "warnedAt") && !canonicalTimestamp(value.warnedAt)) diagnostics.push(diagnostic("invalid-task", "External warning timestamp is invalid.", `${path}.warnedAt`));
	if (["nudge-intended", "nudged", "nudge-ambiguous", "resume-intended", "resumed", "resume-ambiguous"].includes(phase) && !hash("promptSha256")) diagnostics.push(diagnostic("invalid-task", "Silence prompt hash is invalid.", `${path}.promptSha256`));
	if (["nudge-intended", "nudged", "nudge-ambiguous", "interrupt-intended", "interrupted", "interrupt-ambiguous", "resume-intended", "resumed", "resume-ambiguous", "replacement-intended", "replacement-ambiguous"].includes(phase) && !target.value) diagnostics.push(diagnostic("invalid-task", "Silence effect phase requires an exact target.", `${path}.target`));
	if (phase !== "suspected" && phase !== "inspection-incomplete" && phase !== "waiting-external" && phase !== "external-grace" && !timestamp("intendedAt") && phase !== "exhausted") diagnostics.push(diagnostic("invalid-task", "Silence effect intent timestamp is invalid.", path));
	for (const key of ["nudgedAt", "interruptedAt", "resumedAt", "observedAt", "exitedAt", "firstObservedAt", "lastObservedAt"]) if (Object.prototype.hasOwnProperty.call(value, key) && !canonicalTimestamp(value[key])) diagnostics.push(diagnostic("invalid-task", `Silence timestamp ${key} is invalid.`, `${path}.${key}`));
	for (const key of ["nudgedAt", "interruptedAt", "resumedAt", "observedAt", "exitedAt"]) if (Object.prototype.hasOwnProperty.call(value, key) && Object.prototype.hasOwnProperty.call(value, "intendedAt") && canonicalTimestamp(value[key]) && canonicalTimestamp(value.intendedAt) && value[key] < value.intendedAt) diagnostics.push(diagnostic("invalid-task", `Silence timestamp ${key} is not monotonic.`, `${path}.${key}`));
	if (Object.prototype.hasOwnProperty.call(value, "intendedAt") && canonicalTimestamp(value.intendedAt) && value.intendedAt < value.lastProgressAt) diagnostics.push(diagnostic("invalid-task", "Silence effect intent cannot precede the last authoritative progress.", `${path}.intendedAt`));
	if (["nudged", "interrupted", "resumed", "nudge-ambiguous", "interrupt-ambiguous", "resume-ambiguous"].includes(phase) && canonicalTimestamp(value.phaseAt) && canonicalTimestamp(value.intendedAt) && value.phaseAt < value.intendedAt) diagnostics.push(diagnostic("invalid-task", "Silence effect phase timestamp must include its durable intent.", `${path}.phaseAt`));
	if (["nudge-ambiguous", "interrupt-ambiguous", "resume-ambiguous", "replacement-ambiguous"].includes(phase) && !boundedText(value.diagnostic, 2_000)) diagnostics.push(diagnostic("invalid-task", "Ambiguous silence phase requires a bounded diagnostic.", `${path}.diagnostic`));
	if (["replacement-intended", "replacement-ambiguous"].includes(phase) && (value.retryOrdinal !== 1 && value.retryOrdinal !== 2)) diagnostics.push(diagnostic("invalid-task", "Silent replacement ordinal must be 1 or 2.", `${path}.retryOrdinal`));
	if (phase === "exhausted" && (value.retryOrdinal !== 0 && value.retryOrdinal !== 1 && value.retryOrdinal !== 2)) diagnostics.push(diagnostic("invalid-task", "Exhausted silent replacement ordinal must be 0, 1, or 2.", `${path}.retryOrdinal`));
	if (["suspected", "nudge-intended", "nudged", "nudge-ambiguous", "interrupt-intended", "interrupted", "interrupt-ambiguous", "resume-intended", "resumed", "resume-ambiguous", "replacement-intended", "replacement-ambiguous", "exhausted"].includes(phase) && inspection.value?.process.kind !== "none") diagnostics.push(diagnostic("invalid-task", "A silence recovery phase that can authorize or record a ladder rung requires proof that no external process is live.", `${path}.inspection.process`));
	if (phase === "replacement-intended" && attemptState !== "superseded") diagnostics.push(diagnostic("invalid-task", "A reserved silent replacement must supersede its predecessor in the same CAS transition.", path));
	if (!["replacement-intended", "replacement-ambiguous"].includes(phase) && attemptState === "superseded") diagnostics.push(diagnostic("invalid-task", "A superseded Attempt must retain the replacement reservation or ambiguity phase.", path));
	if (diagnostics.length > 0 || !inspection.value) return { diagnostics };
	return { value: { ...(value as unknown as SilencePhase), inspection: inspection.value } as SilencePhase, diagnostics: [] };
}

function validateAttemptReplacement(value: unknown, path: string, attemptId: string): { value?: AttemptReplacement; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || !safeIdentifier(value.replacesAttemptId) || value.replacesAttemptId === attemptId || (value.retryOrdinal !== 1 && value.retryOrdinal !== 2) || !canonicalTimestamp(value.preservedAt)) return { diagnostics: [diagnostic("invalid-task", "Attempt replacement link has invalid exact fields.", path)] };
	if (value.kind === "silent-agent-recovery" && exactKeys(value, ["kind", "replacesAttemptId", "retryOrdinal", "preservedAt"])) return { value: { kind: "silent-agent-recovery", replacesAttemptId: value.replacesAttemptId, retryOrdinal: value.retryOrdinal as 1 | 2, preservedAt: value.preservedAt }, diagnostics: [] };
	if (value.kind !== "transient-recovery" || !exactKeys(value, ["kind", "trigger", "replacesAttemptId", "retryOrdinal", "preservedAt", "modelSelection"]) || !["silent-agent-recovery", "provider-network-interruption", "agent-startup-failure", "herdr-command-failure", "unexpected-process-exit"].includes(value.trigger as string) || !isRecord(value.modelSelection) || typeof value.modelSelection.kind !== "string") return { diagnostics: [diagnostic("invalid-task", "Transient replacement link has invalid exact fields.", path)] };
	const selection = value.modelSelection;
	if (selection.kind === "same-model-first" && exactKeys(selection, ["kind", "planIndex"]) && Number.isSafeInteger(selection.planIndex) && (selection.planIndex as number) >= 0) { const planIndex = selection.planIndex as number; return { value: { kind: "transient-recovery", trigger: value.trigger as "silent-agent-recovery" | TransientInfrastructureKind, replacesAttemptId: value.replacesAttemptId, retryOrdinal: value.retryOrdinal as 1 | 2, preservedAt: value.preservedAt, modelSelection: { kind: "same-model-first", planIndex } }, diagnostics: [] }; }
	if (selection.kind === "approved-fallback" && exactKeys(selection, ["kind", "planIndex", "reason", "skipped"]) && Number.isSafeInteger(selection.planIndex) && (selection.planIndex as number) >= 0 && (selection.reason === "same-model-unavailable" || selection.reason === "same-model-retry-failed") && Array.isArray(selection.skipped) && selection.skipped.length <= 8 && selection.skipped.every((item) => isRecord(item) && exactKeys(item, ["planIndex", "model", "codes"]) && Number.isSafeInteger(item.planIndex) && (item.planIndex as number) >= 0 && boundedText(item.model, 256) && Array.isArray(item.codes) && item.codes.length <= 8 && item.codes.every((code) => boundedText(code, 128)))) { const planIndex = selection.planIndex as number; return { value: { kind: "transient-recovery", trigger: value.trigger as "silent-agent-recovery" | TransientInfrastructureKind, replacesAttemptId: value.replacesAttemptId, retryOrdinal: value.retryOrdinal as 1 | 2, preservedAt: value.preservedAt, modelSelection: { kind: "approved-fallback", planIndex, reason: selection.reason, skipped: selection.skipped.map((item) => ({ planIndex: item.planIndex as number, model: item.model as string, codes: [...item.codes] as string[] })) } }, diagnostics: [] }; }
	return { diagnostics: [diagnostic("invalid-task", "Transient replacement model selection is invalid or unbounded.", `${path}.modelSelection`)] };
}

function validateRecoveryStop(value: unknown, path: string): { value?: import("./run.ts").RecoveryStop; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || typeof value.phase !== "string") return { diagnostics: [diagnostic("invalid-task", "Infrastructure stop record is invalid.", path)] };
	if (value.phase === "not-required" && exactKeys(value, ["phase", "reason"]) && (value.reason === "never-started" || value.reason === "already-missing" || value.reason === "preservation-unavailable")) return { value: { phase: value.phase, reason: value.reason }, diagnostics: [] };
	const agent = validateRecoveryIdentity(value.agent, `${path}.agent`);
	if (value.phase === "intended" && exactKeys(value, ["phase", "intendedAt", "agent"]) && canonicalTimestamp(value.intendedAt) && agent.value) return { value: { phase: value.phase, intendedAt: value.intendedAt, agent: agent.value }, diagnostics: [] };
	if (value.phase === "acknowledged" && exactKeys(value, ["phase", "intendedAt", "acknowledgedAt", "agent"]) && canonicalTimestamp(value.intendedAt) && canonicalTimestamp(value.acknowledgedAt) && value.acknowledgedAt >= value.intendedAt && agent.value) return { value: { phase: value.phase, intendedAt: value.intendedAt, acknowledgedAt: value.acknowledgedAt, agent: agent.value }, diagnostics: [] };
	if (value.phase === "ambiguous" && exactKeys(value, ["phase", "intendedAt", "observedAt", "agent", "diagnostic"]) && canonicalTimestamp(value.intendedAt) && canonicalTimestamp(value.observedAt) && value.observedAt >= value.intendedAt && boundedText(value.diagnostic, 2_000) && agent.value) return { value: { phase: value.phase, intendedAt: value.intendedAt, observedAt: value.observedAt, agent: agent.value, diagnostic: value.diagnostic }, diagnostics: [] };
	return { diagnostics: [diagnostic("invalid-task", "Infrastructure stop record has invalid exact identity or timestamps.", path)] };
}

function validateInfrastructureOutcome(value: unknown, path: string, preparedAt: string): { value?: import("./run.ts").InfrastructureOutcome; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || !exactKeys(value, ["kind", "stage", "observedAt", "code", "diagnostic", "source", "stop"]) || !["provider-network-interruption", "agent-startup-failure", "herdr-command-failure", "unexpected-process-exit"].includes(value.kind as string) || !["worktree-create", "pane-split", "agent-start", "agent-prompt", "agent-runtime"].includes(value.stage as string) || !canonicalTimestamp(value.observedAt) || value.observedAt < preparedAt || !boundedText(value.code, 256) || !boundedText(value.diagnostic, 2_000) || !["typed-herdr-result", "exact-agent-missing"].includes(value.source as string)) return { diagnostics: [diagnostic("invalid-task", "Infrastructure outcome has invalid exact bounded fields.", path)] };
	const stop = validateRecoveryStop(value.stop, `${path}.stop`);
	if (!stop.value) return { diagnostics: stop.diagnostics };
	if (value.kind === "unexpected-process-exit" && (value.source !== "exact-agent-missing" || value.code !== "agent_not_found")) return { diagnostics: [diagnostic("invalid-task", "Unexpected process exit requires the exact structured agent_not_found fact.", path)] };
	if (value.kind !== "unexpected-process-exit" && value.source === "exact-agent-missing") return { diagnostics: [diagnostic("invalid-task", "Only unexpected process exit may use exact-agent-missing evidence.", path)] };
	return { value: { kind: value.kind as TransientInfrastructureKind, stage: value.stage as TransientInfrastructureStage, observedAt: value.observedAt, code: value.code, diagnostic: value.diagnostic, source: value.source as "typed-herdr-result" | "exact-agent-missing", stop: stop.value }, diagnostics: [] };
}

function validateAttemptRecovery(value: unknown, path: string, dispatch: { agentName: string; workspaceId?: string; paneId?: string; terminalId?: string }, attempt: { id: string; role: "builder" | "reviewer"; reportPath: string; evidenceDirectory: string; state: string; preparedAt: string }): { value?: AttemptRecovery; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || !isRecord(value.live)) return { diagnostics: [diagnostic("invalid-task", "Attempt recovery requires one live observation.", path)] };
	const live = value.live;
	const liveKeys = ["observedAt", "kind", ...(Object.prototype.hasOwnProperty.call(live, "lifecycle") ? ["lifecycle"] : []), ...(Object.prototype.hasOwnProperty.call(live, "stateChangeSequence") ? ["stateChangeSequence"] : []), ...(Object.prototype.hasOwnProperty.call(live, "diagnostic") ? ["diagnostic"] : [])];
	let recovery: AttemptRecovery = { live: undefined as never };
	{
		if (Object.keys(live).some((key) => !["observedAt", "kind", "lifecycle", "stateChangeSequence", "diagnostic"].includes(key)) || !exactKeys(live, liveKeys) || !canonicalTimestamp(live.observedAt) || !["working", "blocked", "settled", "unclear", "missing"].includes(live.kind as string) || (Object.prototype.hasOwnProperty.call(live, "lifecycle") && !["working", "blocked", "idle", "done", "unknown"].includes(live.lifecycle as string)) || (Object.prototype.hasOwnProperty.call(live, "stateChangeSequence") && live.stateChangeSequence !== null && (typeof live.stateChangeSequence !== "number" || !Number.isSafeInteger(live.stateChangeSequence) || live.stateChangeSequence < 0)) || (Object.prototype.hasOwnProperty.call(live, "diagnostic") && !boundedText(live.diagnostic, 2_000))) return { diagnostics: [diagnostic("invalid-task", "Attempt recovery live observation is invalid or unbounded.", `${path}.live`)] };
		recovery.live = { observedAt: live.observedAt, kind: live.kind as NonNullable<AttemptRecovery["live"]>["kind"], ...(Object.prototype.hasOwnProperty.call(live, "lifecycle") ? { lifecycle: live.lifecycle as NonNullable<AttemptRecovery["live"]>["lifecycle"] } : {}), ...(Object.prototype.hasOwnProperty.call(live, "stateChangeSequence") ? { stateChangeSequence: live.stateChangeSequence as number | null } : {}), ...(Object.prototype.hasOwnProperty.call(live, "diagnostic") ? { diagnostic: live.diagnostic as string } : {}) };
		if ((recovery.live.kind === "working" && recovery.live.lifecycle !== "working") || (recovery.live.kind === "blocked" && recovery.live.lifecycle !== "blocked") || (recovery.live.kind === "settled" && recovery.live.lifecycle !== "idle" && recovery.live.lifecycle !== "done") || (recovery.live.kind === "missing" && recovery.live.lifecycle !== undefined) || (recovery.live.kind === "unclear" && recovery.live.lifecycle !== undefined && recovery.live.lifecycle !== "unknown")) return { diagnostics: [diagnostic("invalid-task", "Attempt recovery live kind and lifecycle disagree.", `${path}.live`)] };
	}
	if (Object.prototype.hasOwnProperty.call(value, "infrastructure")) {
		const infrastructure = validateInfrastructureOutcome(value.infrastructure, `${path}.infrastructure`, attempt.preparedAt);
		if (!infrastructure.value) return { diagnostics: infrastructure.diagnostics };
		recovery.infrastructure = infrastructure.value;
	}
	const dispatchIdentity = dispatch as { agentName?: string; workspaceId?: string; paneId?: string; terminalId?: string };
	const hasIdentity = typeof dispatchIdentity.workspaceId === "string" && typeof dispatchIdentity.paneId === "string" && typeof dispatchIdentity.terminalId === "string";
	const identityMatches = (candidate: RecoveryAgentIdentity): boolean => candidate.name === dispatchIdentity.agentName && candidate.workspaceId === dispatchIdentity.workspaceId && candidate.paneId === dispatchIdentity.paneId && candidate.terminalId === dispatchIdentity.terminalId;
	const validateRequest = (candidate: unknown, requestPath: string): AttemptRecovery["reportRequest"] | undefined => {
		if (!isRecord(candidate) || typeof candidate.phase !== "string") return undefined;
		const phase = candidate.phase;
		const keys = phase === "intended" ? ["phase", "intendedAt", "agent", "reportPath"] : phase === "requested" ? ["phase", "intendedAt", "requestedAt", "agent", "reportPath"] : phase === "ambiguous" ? ["phase", "intendedAt", "observedAt", "agent", "reportPath", "diagnostic"] : phase === "blocked" ? ["phase", "intendedAt", ...(Object.prototype.hasOwnProperty.call(candidate, "requestedAt") ? ["requestedAt"] : []), "blockedAt", "agent", "reportPath", "diagnostic"] : undefined;
		if (!keys || !exactKeys(candidate, keys) || !canonicalTimestamp(candidate.intendedAt) || (phase === "requested" && !canonicalTimestamp(candidate.requestedAt)) || (phase === "ambiguous" && !canonicalTimestamp(candidate.observedAt)) || (phase === "blocked" && !canonicalTimestamp(candidate.blockedAt)) || !absolutePathValue(candidate.reportPath) || candidate.reportPath !== attempt.reportPath || (phase !== "intended" && phase !== "requested" && phase !== "ambiguous" && phase !== "blocked") || !boundedText(candidate.diagnostic, 2_000) && phase !== "intended" && phase !== "requested") return undefined;
		const agent = validateRecoveryIdentity(candidate.agent, `${requestPath}.agent`);
		if (!agent.value || !hasIdentity || !identityMatches(agent.value)) return undefined;
		if (phase === "intended") return { phase, intendedAt: candidate.intendedAt, agent: agent.value, reportPath: candidate.reportPath };
		if (phase === "requested") return { phase, intendedAt: candidate.intendedAt as string, requestedAt: candidate.requestedAt as string, agent: agent.value, reportPath: candidate.reportPath as string };
		if (phase === "ambiguous") return { phase, intendedAt: candidate.intendedAt as string, observedAt: candidate.observedAt as string, agent: agent.value, reportPath: candidate.reportPath as string, diagnostic: candidate.diagnostic as string };
		return { phase, ...(Object.prototype.hasOwnProperty.call(candidate, "requestedAt") ? { requestedAt: candidate.requestedAt as string } : {}), intendedAt: candidate.intendedAt as string, blockedAt: candidate.blockedAt as string, agent: agent.value, reportPath: candidate.reportPath as string, diagnostic: candidate.diagnostic as string };
	};
	if (Object.prototype.hasOwnProperty.call(value, "reportRequest")) {
		const request = validateRequest(value.reportRequest, `${path}.reportRequest`);
		if (!request) return { diagnostics: [diagnostic("invalid-task", "Attempt recovery report request is invalid, mismatched, or points at a different report.", `${path}.reportRequest`)] };
		recovery.reportRequest = request;
	}
	if (Object.prototype.hasOwnProperty.call(value, "blockedAnswer")) {
		const candidate = value.blockedAnswer;
		if (!isRecord(candidate) || !["intended", "acknowledged", "ambiguous"].includes(candidate.phase as string)) return { diagnostics: [diagnostic("invalid-task", "Attempt recovery blocked answer is invalid.", `${path}.blockedAnswer`)] };
		const phase = candidate.phase as "intended" | "acknowledged" | "ambiguous";
		const keys = phase === "intended" ? ["phase", "intendedAt", "agent", "questionSha256", "fact", "answerSha256"] : phase === "acknowledged" ? ["phase", "intendedAt", "acknowledgedAt", "agent", "questionSha256", "fact", "answerSha256"] : ["phase", "intendedAt", "observedAt", "agent", "questionSha256", "fact", "answerSha256", "diagnostic"];
		const agent = validateRecoveryIdentity(candidate.agent, `${path}.blockedAnswer.agent`);
		if (!exactKeys(candidate, keys) || !agent.value || !identityMatches(agent.value) || !/^sha256:[0-9a-f]{64}$/.test(String(candidate.questionSha256)) || !/^sha256:[0-9a-f]{64}$/.test(String(candidate.answerSha256)) || !["requiredOutcome", "allowedScope", "expectedArtifacts", "verification", "reportPath", "evidenceDirectory", "reviewSubject"].includes(candidate.fact as string) || !canonicalTimestamp(candidate.intendedAt) || (phase === "acknowledged" && !canonicalTimestamp(candidate.acknowledgedAt)) || (phase === "ambiguous" && (!canonicalTimestamp(candidate.observedAt) || !boundedText(candidate.diagnostic, 2_000)))) return { diagnostics: [diagnostic("invalid-task", "Attempt recovery blocked answer has invalid exact fields.", `${path}.blockedAnswer`)] };
		recovery.blockedAnswer = phase === "intended" ? { phase, intendedAt: candidate.intendedAt as string, agent: agent.value, questionSha256: candidate.questionSha256 as string, fact: candidate.fact as TaskFactKey, answerSha256: candidate.answerSha256 as string } : phase === "acknowledged" ? { phase, intendedAt: candidate.intendedAt as string, acknowledgedAt: candidate.acknowledgedAt as string, agent: agent.value, questionSha256: candidate.questionSha256 as string, fact: candidate.fact as TaskFactKey, answerSha256: candidate.answerSha256 as string } : { phase, intendedAt: candidate.intendedAt as string, observedAt: candidate.observedAt as string, agent: agent.value, questionSha256: candidate.questionSha256 as string, fact: candidate.fact as TaskFactKey, answerSha256: candidate.answerSha256 as string, diagnostic: candidate.diagnostic as string };
	}
	if (Object.prototype.hasOwnProperty.call(value, "preservation")) {
		const preservation = validateRecoveryPreservation(value.preservation, `${path}.preservation`);
		if (!preservation.value) return { diagnostics: preservation.diagnostics };
		recovery.preservation = preservation.value;
	}
	if (Object.prototype.hasOwnProperty.call(value, "silence")) {
		const silence = validateSilence(value.silence, `${path}.silence`, attempt.id, attempt.role, dispatch, attempt.preparedAt, attempt.state);
		if (!silence.value) return { diagnostics: silence.diagnostics };
		recovery.silence = silence.value;
	}
	if (recovery.infrastructure) {
		const outcome = recovery.infrastructure;
		const stop = outcome.stop;
		if (stop.phase !== "not-required" && !recovery.preservation) return { diagnostics: [diagnostic("invalid-task", "Infrastructure stop effects require preservation to be retained first.", `${path}.preservation`)] };
		const identityProven = ["agent-intended", "assignment-intended", "prompt-intended", "prompted", "reconciled-active"].includes((dispatch as { phase?: string }).phase ?? "");
		if (outcome.source === "exact-agent-missing" && (!hasIdentity || !identityProven || !identityMatches(stop.phase === "not-required" ? { name: dispatchIdentity.agentName ?? "", workspaceId: dispatchIdentity.workspaceId ?? "", paneId: dispatchIdentity.paneId ?? "", terminalId: dispatchIdentity.terminalId ?? "" } : stop.agent))) return { diagnostics: [diagnostic("invalid-task", "Exact missing infrastructure evidence requires the earlier proven Attempt identity.", `${path}.infrastructure`)] };
		if (stop.phase !== "not-required" && (!hasIdentity || !identityMatches(stop.agent))) return { diagnostics: [diagnostic("invalid-task", "Infrastructure stop identity must match the exact Attempt dispatch.", `${path}.infrastructure.stop`)] };
		if (outcome.kind === "unexpected-process-exit" && (outcome.source !== "exact-agent-missing" || outcome.code !== "agent_not_found")) return { diagnostics: [diagnostic("invalid-task", "Unexpected process exit requires exact agent_not_found evidence.", `${path}.infrastructure`)] };
	}
	const invalidPreservationTimestamp = recovery.live.kind === "missing" && recovery.preservation !== undefined && recovery.preservation.observedAt < recovery.live.observedAt;
	if (recovery.live.observedAt < attempt.preparedAt || (recovery.infrastructure && recovery.infrastructure.observedAt < attempt.preparedAt) || (recovery.reportRequest && (recovery.reportRequest.intendedAt < attempt.preparedAt || (recovery.reportRequest.phase === "requested" && recovery.reportRequest.requestedAt < recovery.reportRequest.intendedAt) || (recovery.reportRequest.phase === "ambiguous" && recovery.reportRequest.observedAt < recovery.reportRequest.intendedAt) || (recovery.reportRequest.phase === "blocked" && ((recovery.reportRequest.requestedAt !== undefined && recovery.reportRequest.requestedAt < recovery.reportRequest.intendedAt) || recovery.reportRequest.blockedAt < recovery.reportRequest.intendedAt)))) || (recovery.blockedAnswer && (recovery.blockedAnswer.intendedAt < attempt.preparedAt || (recovery.blockedAnswer.phase === "acknowledged" && recovery.blockedAnswer.acknowledgedAt < recovery.blockedAnswer.intendedAt) || (recovery.blockedAnswer.phase === "ambiguous" && recovery.blockedAnswer.observedAt < recovery.blockedAnswer.intendedAt))) || invalidPreservationTimestamp) return { diagnostics: [diagnostic("invalid-task", "Attempt recovery timestamps must be canonical and monotonic from preparation through observation.", path)] };
	if (recovery.live.kind === "missing" && !recovery.preservation) return { diagnostics: [diagnostic("invalid-task", "A missing live agent requires preservation before recovery can be recorded.", `${path}.preservation`)] };
	if (recovery.preservation && (recovery.preservation.worktreePath !== ("worktreePath" in dispatch ? dispatch.worktreePath : "") || ("branch" in dispatch && recovery.preservation.branch !== dispatch.branch) || recovery.preservation.assignment.path !== (attempt.reportPath ? attempt.reportPath.replace(/\/report\.md$/, "/assignment.json") : "") || recovery.preservation.evidence.directory !== attempt.evidenceDirectory || recovery.preservation.report.kind === "unavailable" && recovery.preservation.report.diagnostic.length > 2_000)) return { diagnostics: [diagnostic("invalid-task", "Recovery preservation does not match the same Attempt identity.", `${path}.preservation`)] };
	if (exactKeys(value, ["live", ...(recovery.infrastructure ? ["infrastructure"] : []), ...(recovery.reportRequest ? ["reportRequest"] : []), ...(recovery.blockedAnswer ? ["blockedAnswer"] : []), ...(recovery.preservation ? ["preservation"] : []), ...(recovery.silence ? ["silence"] : [])]) === false) return { diagnostics: [diagnostic("invalid-task", "Attempt recovery contains unknown fields.", path)] };
	if (attempt.state === "awaiting-report" && !recovery.reportRequest) return { diagnostics: [diagnostic("invalid-task", "Awaiting-report Attempts require one durable report request.", path)] };
	if (attempt.state === "prepared" && (recovery.reportRequest || recovery.blockedAnswer || recovery.silence || recovery.live.kind === "working" || recovery.live.kind === "blocked" || recovery.live.kind === "settled")) return { diagnostics: [diagnostic("invalid-task", "Prepared Attempts cannot carry post-dispatch recovery actions.", path)] };
	if ((attempt.state === "awaiting-report" || attempt.state === "reported") && recovery.silence) return { diagnostics: [diagnostic("invalid-task", "Awaiting-report or reported Attempts cannot carry active silence recovery state.", `${path}.silence`)] };
	return { value: recovery, diagnostics: [] };
}

function validateDispatch(value: unknown, path: string): { value?: BuilderDispatchRecord; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || typeof value.phase !== "string") return { diagnostics: [diagnostic("invalid-task", "Dispatch intent must be a recognized object.", path)] };
	if (value.phase === "assignment-intended" || ((value.phase === "prompt-intended" || value.phase === "prompted" || value.phase === "reconciled-active") && Object.prototype.hasOwnProperty.call(value, "cycle"))) {
		const required = ["phase", "branch", "agentName", "worktreePath", "workspaceId", "paneId", "terminalId", "cycle", "priorBuilderAttemptId", "priorReviewerAttemptId", "reviewedSubject", "reviewerManifestPath", "reviewerManifestSha256", "findings", ...(value.phase === "assignment-intended" ? [] : ["assignmentSha256"]), ...(value.phase === "prompted" ? ["promptedAt"] : []), ...(value.phase === "reconciled-active" ? ["reconciledAt", "basis"] : [])];
		if (!exactKeys(value, required) || !safeBranch(value.branch) || !herdrName(value.agentName) || !absolutePathValue(value.worktreePath) || !trimmedString(value.workspaceId) || !trimmedString(value.paneId) || !trimmedString(value.terminalId) || !Number.isSafeInteger(value.cycle) || (value.cycle as number) < 1 || !safeIdentifier(value.priorBuilderAttemptId) || !safeIdentifier(value.priorReviewerAttemptId) || !absolutePathValue(value.reviewerManifestPath) || typeof value.reviewerManifestSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.reviewerManifestSha256) || !Array.isArray(value.findings) || value.findings.length === 0 || value.findings.length > 100) return { diagnostics: [diagnostic("invalid-task", "Rework dispatch has invalid exact identity, cycle, evidence, or findings fields.", path)] };
		const subject = validateReviewSubject(value.reviewedSubject, `${path}.reviewedSubject`);
		const findings = validateReviewerFindings(value.findings, `${path}.findings`);
		const extraDiagnostics = [...subject.diagnostics, ...findings.diagnostics];
			if (value.phase !== "assignment-intended" && (typeof value.assignmentSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.assignmentSha256))) extraDiagnostics.push(diagnostic("invalid-task", "Rework prompt dispatch requires an Assignment hash.", `${path}.assignmentSha256`));
			if (value.phase === "prompted" && !canonicalTimestamp(value.promptedAt)) extraDiagnostics.push(diagnostic("invalid-task", "Rework prompted dispatch requires a canonical timestamp.", `${path}.promptedAt`));
			if (value.phase === "reconciled-active" && (!canonicalTimestamp(value.reconciledAt) || !["valid-report", "matching-live-agent"].includes(value.basis as string))) extraDiagnostics.push(diagnostic("invalid-task", "Reconciled rework dispatch requires a canonical timestamp and basis.", path));
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
					...(value.phase === "reconciled-active" ? { reconciledAt: value.reconciledAt as string, basis: value.basis as "valid-report" | "matching-live-agent" } : {}),
			} as ReworkDispatchRecord,
			diagnostics: [],
		};
	}
	const common = ["phase", "branch", "agentName"];
	const required = value.phase === "worktree-intended"
		? common
		: value.phase === "replacement-pane-intended"
			? [...common, "worktreePath", "sourcePaneId", "workspaceId"]
		: value.phase === "agent-intended"
			? [...common, "worktreePath", "workspaceId", "paneId", "terminalId"]
			: value.phase === "prompt-intended"
				? [...common, "worktreePath", "workspaceId", "paneId", "terminalId", "assignmentSha256"]
				: value.phase === "prompted"
					? [...common, "worktreePath", "workspaceId", "paneId", "terminalId", "assignmentSha256", "promptedAt"]
					: value.phase === "reconciled-active"
						? [...common, "worktreePath", "workspaceId", "paneId", "terminalId", "assignmentSha256", "reconciledAt", "basis"]
						: undefined;
	if (!required || !exactKeys(value, required)) return { diagnostics: [diagnostic("invalid-task", "Dispatch intent has unknown or missing keys.", path)] };
	if (!safeBranch(value.branch) || !herdrName(value.agentName)) return { diagnostics: [diagnostic("invalid-task", "Dispatch branch or agent name is unsafe.", path)] };
	if (value.phase === "worktree-intended") return { value: { phase: value.phase, branch: value.branch, agentName: value.agentName }, diagnostics: [] };
	if (value.phase === "replacement-pane-intended") {
		if (!absolutePathValue(value.worktreePath) || !trimmedString(value.sourcePaneId) || !trimmedString(value.workspaceId)) return { diagnostics: [diagnostic("invalid-task", "Replacement pane intent requires the exact preserved worktree and source identity.", path)] };
		return { value: { phase: value.phase, branch: value.branch, worktreePath: value.worktreePath, agentName: value.agentName, sourcePaneId: value.sourcePaneId, workspaceId: value.workspaceId }, diagnostics: [] };
	}
	if (!absolutePathValue(value.worktreePath) || !trimmedString(value.workspaceId) || !trimmedString(value.paneId) || !trimmedString(value.terminalId)) return { diagnostics: [diagnostic("invalid-task", "Actual dispatch identities and worktree path must be non-empty.", path)] };
	if (value.phase === "agent-intended") return { value: { phase: value.phase, branch: value.branch, agentName: value.agentName, worktreePath: value.worktreePath, workspaceId: value.workspaceId, paneId: value.paneId, terminalId: value.terminalId }, diagnostics: [] };
	if (typeof value.assignmentSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.assignmentSha256)) return { diagnostics: [diagnostic("invalid-task", "Dispatch intent requires a lowercase Assignment byte hash.", path)] };
	if (value.phase === "prompt-intended") return { value: { phase: value.phase, branch: value.branch, agentName: value.agentName, worktreePath: value.worktreePath, workspaceId: value.workspaceId, paneId: value.paneId, terminalId: value.terminalId, assignmentSha256: value.assignmentSha256 }, diagnostics: [] };
	if (value.phase === "reconciled-active") {
		if (!canonicalTimestamp(value.reconciledAt) || !["valid-report", "matching-live-agent"].includes(value.basis as string)) return { diagnostics: [diagnostic("invalid-task", "Reconciled dispatch requires a canonical timestamp and recognized basis.", path)] };
		return { value: { phase: "reconciled-active", branch: value.branch, agentName: value.agentName, worktreePath: value.worktreePath, workspaceId: value.workspaceId, paneId: value.paneId, terminalId: value.terminalId, assignmentSha256: value.assignmentSha256, reconciledAt: value.reconciledAt, basis: value.basis } as DispatchRecord, diagnostics: [] };
	}
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
		: value.phase === "replacement-pane-intended"
			? ["phase", "sourcePaneId", "worktreePath", "agentName", "branch", "workspaceId"]
		: value.phase === "agent-intended"
			? ["phase", "agentName", "worktreePath", "workspaceId", "paneId", "terminalId"]
			: value.phase === "prompt-intended"
				? ["phase", "agentName", "worktreePath", "workspaceId", "paneId", "terminalId", "assignmentSha256"]
				: value.phase === "prompted"
					? ["phase", "agentName", "worktreePath", "workspaceId", "paneId", "terminalId", "assignmentSha256", "promptedAt"]
					: value.phase === "reconciled-active"
						? ["phase", "agentName", "worktreePath", "workspaceId", "paneId", "terminalId", "assignmentSha256", "branch", "reconciledAt", "basis"]
						: undefined;
	if (!required || !exactKeys(value, required)) return { diagnostics: [diagnostic("invalid-task", "Reviewer dispatch intent has unknown or missing keys.", path)] };
	if (!herdrName(value.agentName) || !absolutePathValue(value.worktreePath)) return { diagnostics: [diagnostic("invalid-task", "Reviewer dispatch requires a safe name and absolute worktree path.", path)] };
	if (value.phase === "pane-intended") {
		if (!trimmedString(value.sourcePaneId)) return { diagnostics: [diagnostic("invalid-task", "Reviewer pane intent requires a source pane identity.", path)] };
		return { value: { phase: "pane-intended", sourcePaneId: value.sourcePaneId, worktreePath: value.worktreePath, agentName: value.agentName } as ReviewerDispatchRecord, diagnostics: [] };
	}
	if (value.phase === "replacement-pane-intended") {
		if (!safeBranch(value.branch) || !trimmedString(value.sourcePaneId) || !trimmedString(value.workspaceId)) return { diagnostics: [diagnostic("invalid-task", "Replacement Reviewer pane intent is invalid.", path)] };
		return { value: { phase: value.phase, sourcePaneId: value.sourcePaneId, worktreePath: value.worktreePath, agentName: value.agentName, branch: value.branch, workspaceId: value.workspaceId }, diagnostics: [] };
	}
	if (!trimmedString(value.workspaceId) || !trimmedString(value.paneId) || !trimmedString(value.terminalId)) return { diagnostics: [diagnostic("invalid-task", "Reviewer dispatch identities must be non-empty.", path)] };
	if (value.phase === "agent-intended") return { value: { phase: "agent-intended", agentName: value.agentName, worktreePath: value.worktreePath, workspaceId: value.workspaceId, paneId: value.paneId, terminalId: value.terminalId } as ReviewerDispatchRecord, diagnostics: [] };
	if (typeof value.assignmentSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.assignmentSha256)) return { diagnostics: [diagnostic("invalid-task", "Reviewer prompt intent requires a lowercase Assignment hash.", path)] };
	if (value.phase === "prompt-intended") return { value: { phase: "prompt-intended", agentName: value.agentName, worktreePath: value.worktreePath, workspaceId: value.workspaceId, paneId: value.paneId, terminalId: value.terminalId, assignmentSha256: value.assignmentSha256 } as ReviewerDispatchRecord, diagnostics: [] };
	if (value.phase === "reconciled-active") {
		if (!safeBranch(value.branch) || !canonicalTimestamp(value.reconciledAt) || !["valid-report", "matching-live-agent"].includes(value.basis as string)) return { diagnostics: [diagnostic("invalid-task", "Reconciled Reviewer dispatch requires an exact branch, timestamp, and basis.", path)] };
		return { value: { phase: "reconciled-active", agentName: value.agentName, worktreePath: value.worktreePath, workspaceId: value.workspaceId, paneId: value.paneId, terminalId: value.terminalId, assignmentSha256: value.assignmentSha256, branch: value.branch, reconciledAt: value.reconciledAt, basis: value.basis } as ReviewerDispatchRecord, diagnostics: [] };
	}
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
	const hasRecovery = Object.prototype.hasOwnProperty.call(value, "recovery");
	const hasReplacement = Object.prototype.hasOwnProperty.call(value, "replacement");
	const keys = ["id", "role", "state", "preparedAt", ...(hasActivatedAt ? ["activatedAt"] : []), "actualModel", "specificationHash", "assignmentPath", "reportPath", "evidenceDirectory", "subject", "independence", "worktree", "dispatch", ...(hasReplacement ? ["replacement"] : []), ...(hasRecovery ? ["recovery"] : []), ...(hasRepair ? ["reportRepair"] : []), ...(hasIntegrity ? ["integrity"] : []), ...(hasEvidence ? ["evidence"] : [])];
	if (!exactKeys(value, keys) || value.role !== "reviewer" || !safeIdentifier(value.id) || !["prepared", "active", "awaiting-report", "reported", "ended-error", "superseded"].includes(value.state as string) || !canonicalTimestamp(value.preparedAt) || ((value.state === "active" || value.state === "awaiting-report" || value.state === "reported") && !canonicalTimestamp(value.activatedAt)) || (value.state === "superseded" && hasActivatedAt && !canonicalTimestamp(value.activatedAt)) || (value.state === "prepared" && (hasActivatedAt || hasIntegrity || hasRepair || (hasEvidence && isRecord(value.evidence) && value.evidence.phase !== "rejected"))) || (value.state === "active" && !hasActivatedAt) || (value.state === "awaiting-report" && (!hasActivatedAt || !hasRecovery || (hasEvidence && (!isRecord(value.evidence) || value.evidence.phase !== "rejected")))) || (value.state === "reported" && (!hasEvidence || !hasIntegrity))) return { diagnostics: [diagnostic("invalid-task", "Reviewer Attempt has invalid lifecycle fields.", path)] };
	const model = modelChoiceValue(value.actualModel, `${path}.actualModel`);
	const dispatch = validateReviewerDispatch(value.dispatch, `${path}.dispatch`);
	const replacement = hasReplacement ? validateAttemptReplacement(value.replacement, `${path}.replacement`, value.id as string) : { diagnostics: [] };
	const snapshot = isRecord(value.worktree) && exactKeys(value.worktree, ["path", "baseline"]) && absolutePathValue(value.worktree.path) ? validateReviewSnapshot(value.worktree.baseline, `${path}.worktree.baseline`) : { diagnostics: [diagnostic("invalid-task", "Reviewer worktree is invalid.", `${path}.worktree`)] };
	const subjectResult = validateReviewSubject(value.subject, `${path}.subject`);
	const independence = validateReviewerIndependence(value.independence, `${path}.independence`);
	const evidence = hasEvidence ? validateReviewerEvidence(value.evidence, `${path}.evidence`) : { diagnostics: [] };
	const reportRepair = hasRepair ? validateReportRepair(value.reportRepair, `${path}.reportRepair`) : { diagnostics: [] };
	const integrity = hasIntegrity ? validateReviewerIntegrity(value.integrity, `${path}.integrity`) : { diagnostics: [] };
	const recovery = hasRecovery && dispatch.value ? validateAttemptRecovery(value.recovery, `${path}.recovery`, dispatch.value, { id: value.id as string, role: "reviewer", reportPath: value.reportPath as string, evidenceDirectory: value.evidenceDirectory as string, state: value.state as string, preparedAt: value.preparedAt as string }) : { diagnostics: hasRecovery ? [diagnostic("invalid-task", "Reviewer recovery requires a recognized dispatch identity.", `${path}.recovery`)] : [] };
	const diagnostics = [...model.diagnostics, ...dispatch.diagnostics, ...replacement.diagnostics, ...snapshot.diagnostics, ...subjectResult.diagnostics, ...independence.diagnostics, ...evidence.diagnostics, ...reportRepair.diagnostics, ...integrity.diagnostics, ...recovery.diagnostics];
	if (typeof value.specificationHash !== "string" || value.specificationHash !== specificationHash(task)) diagnostics.push(diagnostic("invalid-task", "Reviewer Attempt specificationHash must match its Task contract.", `${path}.specificationHash`));
	if (base.kind !== "git") diagnostics.push(diagnostic("invalid-task", "Reviewer Attempt requires the Builder Git integration base in this slice.", path));
	if (!absolutePathValue(value.assignmentPath) || !absolutePathValue(value.reportPath) || !absolutePathValue(value.evidenceDirectory)) diagnostics.push(diagnostic("invalid-task", "Reviewer Attempt paths must be absolute.", path));
	if (dispatch.value && ((value.state === "active" || value.state === "awaiting-report" || value.state === "reported") && !["prompted", "reconciled-active"].includes(dispatch.value.phase) || value.state === "superseded" && !["agent-intended", "assignment-intended", "prompt-intended", "prompted", "reconciled-active"].includes(dispatch.value.phase) || (value.state === "active" || value.state === "reported") && dispatch.value.phase === "prompted" && value.activatedAt !== dispatch.value.promptedAt || (value.state === "active" || value.state === "reported") && dispatch.value.phase === "reconciled-active" && value.activatedAt !== dispatch.value.reconciledAt || (value.state === "prepared" && ["prompted", "reconciled-active"].includes(dispatch.value.phase)))) diagnostics.push(diagnostic("invalid-task", "Reviewer Attempt state and dispatch phase disagree.", path));
	if (dispatch.value && value.state === "ended-error" && ["prompted", "reconciled-active"].includes(dispatch.value.phase) && (!hasActivatedAt || !canonicalTimestamp(value.activatedAt))) diagnostics.push(diagnostic("invalid-task", "An active-time ended-error Reviewer Attempt must retain its activation timestamp.", path));
	if (reportRepair.value && (!["prompted", "reconciled-active"].includes(dispatch.value?.phase ?? "") || (value.state !== "active" && !(value.state === "reported" && reportRepair.value.phase === "requested")))) diagnostics.push(diagnostic("invalid-task", "Reviewer report repair must remain bound to the same prompted Reviewer; only a requested repair may be retained after valid finalization.", `${path}.reportRepair`));
	if (value.state === "reported" && evidence.value?.phase !== "finalized") diagnostics.push(diagnostic("invalid-task", "Reported Reviewer Attempts require finalized evidence.", `${path}.evidence`));
	if (value.state === "ended-error" && !recovery.value?.infrastructure) diagnostics.push(diagnostic("invalid-task", "Ended-error Reviewer Attempts require a typed infrastructure outcome.", `${path}.recovery`));
	if (recovery.value?.infrastructure && evidence.value?.phase === "finalized") diagnostics.push(diagnostic("invalid-task", "Infrastructure outcomes cannot coexist with finalized Reviewer evidence.", `${path}.recovery`));
	if (value.state === "reported" && integrity.value?.kind !== "preserved" && integrity.value?.kind !== "violated") diagnostics.push(diagnostic("invalid-task", "Reported Reviewer Attempts require an integrity result.", `${path}.integrity`));
	if (hasRepair && !["prompted", "reconciled-active"].includes(dispatch.value?.phase ?? "")) diagnostics.push(diagnostic("invalid-task", "Reviewer reportRepair is legal only after an actual Reviewer dispatch.", `${path}.reportRepair`));
	if (diagnostics.length > 0 || !model.value || !dispatch.value || (hasReplacement && !replacement.value) || !snapshot.value || !subjectResult.value || !independence.value || (hasEvidence && !evidence.value) || (hasRepair && !reportRepair.value) || (hasIntegrity && !integrity.value) || (hasRecovery && !recovery.value) || !isRecord(value.worktree) || typeof value.worktree.path !== "string") return { diagnostics };
	return { value: { id: value.id as string, role: "reviewer", state: value.state as ReviewerAttemptRecord["state"], preparedAt: value.preparedAt as string, ...(value.state === "active" || value.state === "awaiting-report" || value.state === "reported" || (value.state === "superseded" && hasActivatedAt) || (value.state === "ended-error" && hasActivatedAt) ? { activatedAt: value.activatedAt as string } : {}), actualModel: model.value, specificationHash: value.specificationHash as string, assignmentPath: value.assignmentPath as string, reportPath: value.reportPath as string, evidenceDirectory: value.evidenceDirectory as string, subject: subjectResult.value, independence: independence.value, worktree: { path: value.worktree.path, baseline: snapshot.value }, dispatch: dispatch.value, ...(replacement.value ? { replacement: replacement.value } : {}), ...(recovery.value ? { recovery: recovery.value } : {}), ...(reportRepair.value ? { reportRepair: reportRepair.value } : {}), ...(integrity.value ? { integrity: integrity.value } : {}), ...(evidence.value ? { evidence: evidence.value } : {}) }, diagnostics: [] };
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
	const hasRecovery = Object.prototype.hasOwnProperty.call(value, "recovery");
	const hasReplacement = Object.prototype.hasOwnProperty.call(value, "replacement");
	const keys = ["id", "role", "state", "preparedAt", ...(hasActivatedAt ? ["activatedAt"] : []), "actualModel", "specificationHash", "baseRevision", "assignmentPath", "reportPath", "evidenceDirectory", "dispatch", ...(hasReplacement ? ["replacement"] : []), ...(hasRecovery ? ["recovery"] : []), ...(hasEvidence ? ["evidence"] : [])];
	if (!exactKeys(value, keys) || !safeIdentifier(value.id) || value.role !== "builder" || !["prepared", "active", "awaiting-report", "reported", "ended-error", "superseded"].includes(value.state as string) || !canonicalTimestamp(value.preparedAt) || ((value.state === "active" || value.state === "awaiting-report" || value.state === "reported") && !canonicalTimestamp(value.activatedAt)) || (value.state === "superseded" && hasActivatedAt && !canonicalTimestamp(value.activatedAt)) || (value.state === "prepared" && (hasActivatedAt || (hasEvidence && isRecord(value.evidence) && value.evidence.phase !== "rejected"))) || (value.state === "active" && !hasActivatedAt) || (value.state === "awaiting-report" && (!hasActivatedAt || !hasRecovery || (hasEvidence && (!isRecord(value.evidence) || value.evidence.phase !== "rejected")))) || (value.state === "reported" && !hasEvidence)) {
		return { diagnostics: [diagnostic("invalid-task", "Attempt has invalid lifecycle fields.", path)] };
	}
	const model = modelChoiceValue(value.actualModel, `${path}.actualModel`);
	const dispatch = validateDispatch(value.dispatch, `${path}.dispatch`);
	const replacement = hasReplacement ? validateAttemptReplacement(value.replacement, `${path}.replacement`, value.id as string) : { diagnostics: [] };
	const evidence = hasEvidence ? validateEvidenceRecord(value.evidence, `${path}.evidence`) : { diagnostics: [] };
	const recovery = hasRecovery && dispatch.value ? validateAttemptRecovery(value.recovery, `${path}.recovery`, dispatch.value, { id: value.id as string, role: "builder", reportPath: value.reportPath as string, evidenceDirectory: value.evidenceDirectory as string, state: value.state as string, preparedAt: value.preparedAt as string }) : { diagnostics: hasRecovery ? [diagnostic("invalid-task", "Builder recovery requires a recognized dispatch identity.", `${path}.recovery`)] : [] };
	const diagnostics = [...model.diagnostics, ...dispatch.diagnostics, ...replacement.diagnostics, ...evidence.diagnostics, ...recovery.diagnostics];
	if (typeof value.specificationHash !== "string" || value.specificationHash !== specificationHash(task)) diagnostics.push(diagnostic("invalid-task", "Attempt specificationHash must match its Task contract.", `${path}.specificationHash`));
	if (typeof value.baseRevision !== "string" || base.kind !== "git" || !/^[0-9a-f]{40}$/.test(value.baseRevision)) diagnostics.push(diagnostic("invalid-task", "Attempt baseRevision must be a full lowercase revision for the Git integration base.", `${path}.baseRevision`));
	if (!absolutePathValue(value.assignmentPath) || !absolutePathValue(value.reportPath) || !absolutePathValue(value.evidenceDirectory)) diagnostics.push(diagnostic("invalid-task", "Attempt evidence paths must be absolute and safe.", path));
	if (dispatch.value) {
		if ((value.state === "active" || value.state === "awaiting-report" || value.state === "reported") && !["prompted", "reconciled-active"].includes(dispatch.value.phase)) diagnostics.push(diagnostic("invalid-task", "Active, awaiting-report, or reported Attempts require a proven dispatch.", path));
		if (value.state === "superseded" && !["worktree-intended", "replacement-pane-intended", "agent-intended", "assignment-intended", "prompt-intended", "prompted", "reconciled-active"].includes(dispatch.value.phase)) diagnostics.push(diagnostic("invalid-task", "Superseded Attempts require a retained dispatch identity.", path));
		if ((value.state === "active" || value.state === "reported" || value.state === "superseded" || value.state === "ended-error") && dispatch.value.phase === "prompted" && value.activatedAt !== dispatch.value.promptedAt && value.state !== "ended-error") diagnostics.push(diagnostic("invalid-task", "Active, reported, or superseded Attempts require a matching prompted activation timestamp.", path));
		if ((value.state === "active" || value.state === "awaiting-report" || value.state === "reported" || value.state === "superseded" || value.state === "ended-error") && dispatch.value.phase === "reconciled-active" && value.activatedAt !== dispatch.value.reconciledAt && value.state !== "ended-error") diagnostics.push(diagnostic("invalid-task", "Reconciled Attempts require a matching reconciliation timestamp.", path));
		if (value.state === "prepared" && ["prompted", "reconciled-active"].includes(dispatch.value.phase)) diagnostics.push(diagnostic("invalid-task", "Prepared Attempts cannot have a proven dispatch.", path));
		if (value.state === "ended-error" && ["prompted", "reconciled-active"].includes(dispatch.value.phase) && (!hasActivatedAt || !canonicalTimestamp(value.activatedAt))) diagnostics.push(diagnostic("invalid-task", "An active-time ended-error Attempt must retain its activation timestamp.", path));
	}
	if (value.state === "reported" && evidence.value?.phase !== "finalized") diagnostics.push(diagnostic("invalid-task", "Reported Attempts require finalized Builder evidence.", `${path}.evidence`));
	if (value.state === "ended-error" && !recovery.value?.infrastructure) diagnostics.push(diagnostic("invalid-task", "Ended-error Attempts require a typed infrastructure outcome.", `${path}.recovery`));
	if (recovery.value?.infrastructure && evidence.value?.phase === "finalized") diagnostics.push(diagnostic("invalid-task", "Infrastructure outcomes cannot coexist with finalized Builder evidence.", `${path}.recovery`));
	if (value.state === "active" && evidence.value?.phase === "finalized") diagnostics.push(diagnostic("invalid-task", "Active Attempts cannot contain finalized Builder evidence.", `${path}.evidence`));
	if (evidence.value?.phase === "finalized" && evidence.value.status === "completed" && task.expectedArtifacts.some((artifact) => artifact.kind === "git-commit") && evidence.value.producedRevision === null) diagnostics.push(diagnostic("invalid-task", "Completed code-changing Attempts require a produced revision in finalized evidence.", `${path}.evidence.producedRevision`));
	if (diagnostics.length > 0 || !model.value || !dispatch.value || (hasReplacement && !replacement.value) || (hasEvidence && !evidence.value) || (hasRecovery && !recovery.value) || typeof value.id !== "string" || typeof value.preparedAt !== "string" || typeof value.specificationHash !== "string" || typeof value.baseRevision !== "string" || typeof value.assignmentPath !== "string" || typeof value.reportPath !== "string" || typeof value.evidenceDirectory !== "string") return { diagnostics };
	return {
		value: {
			id: value.id,
			role: "builder",
			state: value.state as BuilderAttemptRecord["state"],
			preparedAt: value.preparedAt,
			...(value.state === "active" || value.state === "awaiting-report" || value.state === "reported" || (value.state === "superseded" && hasActivatedAt) || (value.state === "ended-error" && hasActivatedAt) ? { activatedAt: value.activatedAt as string } : {}),
			actualModel: model.value,
			specificationHash: value.specificationHash,
			baseRevision: value.baseRevision,
			assignmentPath: value.assignmentPath,
			reportPath: value.reportPath,
			evidenceDirectory: value.evidenceDirectory,
				dispatch: dispatch.value,
				...(replacement.value ? { replacement: replacement.value } : {}),
				...(recovery.value ? { recovery: recovery.value } : {}),
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
	if ((dispatch.phase === "prompt-intended" || dispatch.phase === "prompted" || dispatch.phase === "reconciled-active") && "cycle" in dispatch) return { ...dispatch, reviewedSubject: cloneReviewSubject(dispatch.reviewedSubject), findings: dispatch.findings.map((finding) => ({ ...finding })) };
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
			...(attempt.replacement ? { replacement: { ...attempt.replacement } } : {}),
			...(attempt.recovery ? { recovery: cloneRecovery(attempt.recovery) } : {}),
				...(attempt.reportRepair ? { reportRepair: attempt.reportRepair.phase === "blocked" ? { ...attempt.reportRepair, diagnostics: [...attempt.reportRepair.diagnostics], secondDiagnostics: [...attempt.reportRepair.secondDiagnostics] } : { ...attempt.reportRepair, diagnostics: [...attempt.reportRepair.diagnostics] } } : {}),
			...(attempt.integrity ? { integrity: attempt.integrity.kind === "preserved" ? { kind: "preserved", after: { ...attempt.integrity.after, dirtyPaths: [...attempt.integrity.after.dirtyPaths], operationMarkers: [...attempt.integrity.after.operationMarkers] } } : { ...attempt.integrity, before: { ...attempt.integrity.before, dirtyPaths: [...attempt.integrity.before.dirtyPaths], operationMarkers: [...attempt.integrity.before.operationMarkers] }, after: { ...attempt.integrity.after, dirtyPaths: [...attempt.integrity.after.dirtyPaths], operationMarkers: [...attempt.integrity.after.operationMarkers] } } } : {}),
			...(attempt.evidence ? { evidence: { ...attempt.evidence, subject: attempt.evidence.subject.kind === "git" ? { ...attempt.evidence.subject, commits: [...attempt.evidence.subject.commits] } : { ...attempt.evidence.subject, artifacts: attempt.evidence.subject.artifacts.map((artifact) => ({ ...artifact })) } } } : {}),
		};
	}
	return {
		...attempt,
			actualModel: { ...attempt.actualModel },
			dispatch: cloneBuilderDispatch(attempt.dispatch),
		...(attempt.replacement ? { replacement: { ...attempt.replacement } } : {}),
		...(attempt.recovery ? { recovery: cloneRecovery(attempt.recovery) } : {}),
		...(attempt.evidence ? { evidence: cloneEvidence(attempt.evidence) } : {}),
	};
}

function cloneRecovery(recovery: AttemptRecovery): AttemptRecovery {
	return {
		live: { ...recovery.live },
		...(recovery.infrastructure ? { infrastructure: { ...recovery.infrastructure, stop: { ...recovery.infrastructure.stop, ...(recovery.infrastructure.stop.phase === "intended" || recovery.infrastructure.stop.phase === "acknowledged" || recovery.infrastructure.stop.phase === "ambiguous" ? { agent: { ...recovery.infrastructure.stop.agent } } : {}) } } } : {}),
		...(recovery.reportRequest ? { reportRequest: { ...recovery.reportRequest, agent: { ...recovery.reportRequest.agent } } } : {}),
		...(recovery.blockedAnswer ? { blockedAnswer: { ...recovery.blockedAnswer, agent: { ...recovery.blockedAnswer.agent } } } : {}),
		...(recovery.preservation ? { preservation: { ...recovery.preservation, worktree: { ...recovery.preservation.worktree }, git: { ...recovery.preservation.git }, assignment: { ...recovery.preservation.assignment }, report: { ...recovery.preservation.report }, evidence: { ...recovery.preservation.evidence, entries: recovery.preservation.evidence.entries.map((entry) => ({ ...entry })) } } } : {}),
		...(recovery.silence ? { silence: cloneSilence(recovery.silence) } : {}),
	};
}

function cloneSilence(silence: SilencePhase): SilencePhase {
	const inspection = {
		...silence.inspection,
		agent: { ...silence.inspection.agent },
		terminal: { ...silence.inspection.terminal },
		worktree: { ...silence.inspection.worktree },
		git: { ...silence.inspection.git },
		assignment: { ...silence.inspection.assignment },
		report: { ...silence.inspection.report },
		evidence: { ...silence.inspection.evidence, entries: silence.inspection.evidence.entries.map((entry) => ({ ...entry })) },
		process: { ...silence.inspection.process },
	};
	const target = "target" in silence ? { target: { ...silence.target } } : {};
	if (silence.phase === "waiting-external" || silence.phase === "external-grace") return { ...silence, inspection, process: { ...silence.process }, ...target };
	return { ...silence, inspection, ...target } as SilencePhase;
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

function cloneIntegrationObservation(observation: IntegrationCheckoutObservation): IntegrationCheckoutObservation {
	return {
		branch: observation.branch,
		head: observation.head,
		dirtyPaths: [...observation.dirtyPaths],
		operationMarkers: [...observation.operationMarkers],
		rangeExact: observation.rangeExact,
	};
}

function cloneApprovedIntegrationIdentity(identity: ApprovedIntegrationIdentity): ApprovedIntegrationIdentity {
	const action = identity.action.kind === "fast-forward"
		? { kind: "fast-forward" as const, argv: [...identity.action.argv] as ["merge", "--ff-only", "--no-edit", string] }
		: { kind: "merge-commit" as const, argv: [...identity.action.argv] as ["merge", "--no-ff", "--no-edit", string] };
	return {
		targetBranch: identity.targetBranch,
		targetRevision: identity.targetRevision,
		approvedBaseRevision: identity.approvedBaseRevision,
		approvedHeadRevision: identity.approvedHeadRevision,
		approvedCommits: [...identity.approvedCommits],
		builderAttemptId: identity.builderAttemptId,
		reviewerAttemptId: identity.reviewerAttemptId,
		builderManifestSha256: identity.builderManifestSha256,
		reviewerManifestSha256: identity.reviewerManifestSha256,
		action,
	};
}

function cloneIntegration(integration: TaskIntegration): TaskIntegration {
	const identity = cloneApprovedIntegrationIdentity(integration);
	if (integration.phase === "intended") return { ...identity, phase: "intended", intendedAt: integration.intendedAt };
	if (integration.phase === "integrated") return { ...identity, phase: "integrated", intendedAt: integration.intendedAt, integratedAt: integration.integratedAt, observedHead: integration.observedHead };
	if (integration.phase === "failed") return { ...identity, phase: "failed", intendedAt: integration.intendedAt, observedAt: integration.observedAt, exitCode: integration.exitCode, diagnostic: integration.diagnostic };
	return { ...identity, phase: "ambiguous", intendedAt: integration.intendedAt, observedAt: integration.observedAt, exitCode: integration.exitCode, diagnostic: integration.diagnostic, observed: cloneIntegrationObservation(integration.observed) };
}

function cloneVerificationExecution(execution: FinalVerificationExecution): FinalVerificationExecution {
	if (execution.phase === "intended") return { ...execution };
	if (execution.phase === "ambiguous") return { ...execution, ...(execution.checkout ? { checkout: cloneIntegrationObservation(execution.checkout) } : {}) };
	return { ...execution, checkout: cloneIntegrationObservation(execution.checkout) };
}

function cloneCompletionResource(resource: CompletionStopResource): CompletionStopResource {
	return resource.state === "intended" ? { ...resource } : { ...resource, acknowledgement: { ...resource.acknowledgement } };
}

function cloneCompletionGate(gate: CompletionGateFacts): CompletionGateFacts {
	return { ...gate, checkout: cloneIntegrationObservation(gate.checkout), predicates: [...gate.predicates] };
}

function cloneAnyCompletionGate(gate: AnyCompletionGateFacts): AnyCompletionGateFacts {
	if (!("tasks" in gate)) return cloneCompletionGate(gate);
	return {
		...gate,
		tasks: gate.tasks.map((task) => ({
			...task,
			...(task.source ? { source: { ...task.source, commits: [...task.source.commits] } } : {}),
			...(task.integration ? { integration: { ...task.integration, approvedCommits: [...task.integration.approvedCommits], action: task.integration.action.kind === "fast-forward" ? { kind: "fast-forward" as const, argv: [...task.integration.action.argv] as ["merge", "--ff-only", "--no-edit", string] } : { kind: "merge-commit" as const, argv: [...task.integration.action.argv] as ["merge", "--no-ff", "--no-edit", string] } } } : {}),
		})),
		checkout: cloneIntegrationObservation(gate.checkout),
		predicates: [...gate.predicates],
	};
}

function cloneCompletionArchive(archive: CompletionArchiveIntent): CompletionArchiveIntent {
	return { ...archive, verification: { ...archive.verification }, reports: archive.reports.map((report) => ({ ...report })) };
}

function cloneCompletion(completion: CompletionRecord): CompletionRecord {
	const gate = cloneAnyCompletionGate(completion.gate);
	if (completion.phase === "gate-passed") return { phase: completion.phase, gate };
	if (completion.phase === "stops-intended") return { phase: completion.phase, gate, resources: completion.resources.map(cloneCompletionResource) };
	if (completion.phase === "stops-incomplete") return { phase: completion.phase, gate, resources: completion.resources.map(cloneCompletionResource), failure: { ...completion.failure, resource: { ...completion.failure.resource } } };
	if (completion.phase === "stops-complete") return { phase: completion.phase, gate, resources: completion.resources.map((resource) => cloneCompletionResource(resource) as Extract<CompletionStopResource, { state: "acknowledged" }>) };
	if (completion.phase === "archive-intended") return { phase: completion.phase, gate, resources: completion.resources.map((resource) => cloneCompletionResource(resource) as Extract<CompletionStopResource, { state: "acknowledged" }>), archive: cloneCompletionArchive(completion.archive) };
	return { phase: completion.phase, gate, resources: completion.resources.map((resource) => cloneCompletionResource(resource) as Extract<CompletionStopResource, { state: "acknowledged" }>), archive: cloneCompletionArchive(completion.archive), archivedAt: completion.archivedAt };
}

function cloneMonitorDigest(digest: MonitorDigest): MonitorDigest {
	return digest.kind === "observed" ? { ...digest } : { ...digest };
}

function cloneMonitorCheckpoint(monitor: MonitorCheckpoint): MonitorCheckpoint {
	return {
		observedAt: monitor.observedAt,
		taskId: monitor.taskId,
		attemptId: monitor.attemptId,
		role: monitor.role,
		agent: { ...monitor.agent },
		terminal: cloneMonitorDigest(monitor.terminal),
		worktree: cloneMonitorDigest(monitor.worktree),
		git: { ...monitor.git },
		report: { ...monitor.report },
	};
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

function validateIntegrationObservation(value: unknown, path: string): { value?: IntegrationCheckoutObservation; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || !exactKeys(value, ["branch", "head", "dirtyPaths", "operationMarkers", "rangeExact"]) || (value.branch !== null && !safeBranch(value.branch)) || (value.head !== null && (typeof value.head !== "string" || !/^[0-9a-f]{40}$/.test(value.head))) || !Array.isArray(value.dirtyPaths) || value.dirtyPaths.length > 100 || value.dirtyPaths.some((item) => !pathValue(item)) || !Array.isArray(value.operationMarkers) || value.operationMarkers.length > 10 || value.operationMarkers.some((item) => !safeIdentifier(item)) || new Set(value.operationMarkers).size !== value.operationMarkers.length || JSON.stringify([...value.operationMarkers].sort()) !== JSON.stringify(value.operationMarkers) || typeof value.rangeExact !== "boolean") return { diagnostics: [diagnostic("invalid-run", "Integration checkout observation has invalid exact bounded fields.", path)] };
	return { value: { branch: value.branch as string | null, head: value.head as string | null, dirtyPaths: [...value.dirtyPaths] as string[], operationMarkers: [...value.operationMarkers] as string[], rangeExact: value.rangeExact }, diagnostics: [] };
}

function validateApprovedIntegrationIdentity(value: Record<string, unknown>, path: string): { value?: ApprovedIntegrationIdentity; diagnostics: RunDiagnostic[] } {
	const action = value.action;
	const required = ["phase", "targetBranch", "targetRevision", "approvedBaseRevision", "approvedHeadRevision", "approvedCommits", "builderAttemptId", "reviewerAttemptId", "builderManifestSha256", "reviewerManifestSha256", "action"];
	const validAction = isRecord(action) && exactKeys(action, ["kind", "argv"]) && Array.isArray(action.argv) && action.argv.length === 4 && action.argv[0] === "merge" && action.argv[2] === "--no-edit" && action.argv[3] === value.approvedHeadRevision && ((action.kind === "fast-forward" && action.argv[1] === "--ff-only") || (action.kind === "merge-commit" && action.argv[1] === "--no-ff"));
	if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) || !safeBranch(value.targetBranch) || typeof value.targetRevision !== "string" || !/^[0-9a-f]{40}$/.test(value.targetRevision) || typeof value.approvedBaseRevision !== "string" || !/^[0-9a-f]{40}$/.test(value.approvedBaseRevision) || typeof value.approvedHeadRevision !== "string" || !/^[0-9a-f]{40}$/.test(value.approvedHeadRevision) || !Array.isArray(value.approvedCommits) || value.approvedCommits.length === 0 || value.approvedCommits.length > 100 || value.approvedCommits.some((commit) => typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) || new Set(value.approvedCommits).size !== value.approvedCommits.length || !safeIdentifier(value.builderAttemptId) || !safeIdentifier(value.reviewerAttemptId) || typeof value.builderManifestSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.builderManifestSha256) || typeof value.reviewerManifestSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.reviewerManifestSha256) || !validAction) return { diagnostics: [diagnostic("invalid-task", "Task integration identity or fixed local merge action is invalid.", path)] };
	const actionKind = action.kind as "fast-forward" | "merge-commit";
	return {
		value: {
			targetBranch: value.targetBranch as string,
			targetRevision: value.targetRevision as string,
			approvedBaseRevision: value.approvedBaseRevision as string,
			approvedHeadRevision: value.approvedHeadRevision as string,
			approvedCommits: [...value.approvedCommits] as string[],
			builderAttemptId: value.builderAttemptId as string,
			reviewerAttemptId: value.reviewerAttemptId as string,
			builderManifestSha256: value.builderManifestSha256 as string,
			reviewerManifestSha256: value.reviewerManifestSha256 as string,
			action: actionKind === "fast-forward"
				? { kind: "fast-forward", argv: ["merge", "--ff-only", "--no-edit", value.approvedHeadRevision as string] }
				: { kind: "merge-commit", argv: ["merge", "--no-ff", "--no-edit", value.approvedHeadRevision as string] },
		},
		diagnostics: [],
	};
}

function validateTaskIntegration(value: unknown, path: string): { value?: TaskIntegration; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || typeof value.phase !== "string") return { diagnostics: [diagnostic("invalid-task", "Task integration must be a recognized phase record.", path)] };
	const identity = validateApprovedIntegrationIdentity(value, path);
	if (!identity.value || identity.diagnostics.length > 0) return { diagnostics: identity.diagnostics };
	if (value.phase === "intended" && exactKeys(value, ["phase", "targetBranch", "targetRevision", "approvedBaseRevision", "approvedHeadRevision", "approvedCommits", "builderAttemptId", "reviewerAttemptId", "builderManifestSha256", "reviewerManifestSha256", "action", "intendedAt"]) && canonicalTimestamp(value.intendedAt)) return { value: { ...identity.value, phase: "intended", intendedAt: value.intendedAt }, diagnostics: [] };
	if (value.phase === "integrated" && exactKeys(value, ["phase", "targetBranch", "targetRevision", "approvedBaseRevision", "approvedHeadRevision", "approvedCommits", "builderAttemptId", "reviewerAttemptId", "builderManifestSha256", "reviewerManifestSha256", "action", "intendedAt", "integratedAt", "observedHead"]) && canonicalTimestamp(value.intendedAt) && canonicalTimestamp(value.integratedAt) && value.integratedAt >= value.intendedAt && typeof value.observedHead === "string" && /^[0-9a-f]{40}$/.test(value.observedHead) && ((identity.value.action.kind === "fast-forward" && value.observedHead === value.approvedHeadRevision) || (identity.value.action.kind === "merge-commit" && value.observedHead !== value.targetRevision))) return { value: { ...identity.value, phase: "integrated", intendedAt: value.intendedAt, integratedAt: value.integratedAt, observedHead: value.observedHead }, diagnostics: [] };
	if (value.phase === "failed" && exactKeys(value, ["phase", "targetBranch", "targetRevision", "approvedBaseRevision", "approvedHeadRevision", "approvedCommits", "builderAttemptId", "reviewerAttemptId", "builderManifestSha256", "reviewerManifestSha256", "action", "intendedAt", "observedAt", "exitCode", "diagnostic"]) && canonicalTimestamp(value.intendedAt) && canonicalTimestamp(value.observedAt) && value.observedAt >= value.intendedAt && (value.exitCode === null || (typeof value.exitCode === "number" && Number.isSafeInteger(value.exitCode))) && boundedText(value.diagnostic, 2_000)) return { value: { ...identity.value, phase: "failed", intendedAt: value.intendedAt, observedAt: value.observedAt, exitCode: value.exitCode, diagnostic: value.diagnostic }, diagnostics: [] };
	if (value.phase === "ambiguous" && exactKeys(value, ["phase", "targetBranch", "targetRevision", "approvedBaseRevision", "approvedHeadRevision", "approvedCommits", "builderAttemptId", "reviewerAttemptId", "builderManifestSha256", "reviewerManifestSha256", "action", "intendedAt", "observedAt", "exitCode", "diagnostic", "observed"]) && canonicalTimestamp(value.intendedAt) && canonicalTimestamp(value.observedAt) && value.observedAt >= value.intendedAt && (value.exitCode === null || (typeof value.exitCode === "number" && Number.isSafeInteger(value.exitCode))) && boundedText(value.diagnostic, 2_000)) {
		const observed = validateIntegrationObservation(value.observed, `${path}.observed`);
		return observed.value && observed.diagnostics.length === 0 ? { value: { ...identity.value, phase: "ambiguous", intendedAt: value.intendedAt, observedAt: value.observedAt, exitCode: value.exitCode, diagnostic: value.diagnostic, observed: observed.value }, diagnostics: [] } : { diagnostics: observed.diagnostics };
	}
	return { diagnostics: [diagnostic("invalid-task", "Task integration has invalid exact phase fields.", path)] };
}

function validateFinalVerificationExecution(value: unknown, path: string, finalVerification: Verification): { value?: FinalVerificationExecution; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || typeof value.phase !== "string") return { diagnostics: [diagnostic("invalid-run", "Final verification execution must be a recognized phase record.", path)] };
	const common = ["id", "command", "cwd", "logPath", "resultPath"];
	const command = finalVerification.kind === "command" ? finalVerification.command : undefined;
	const validCommon = value.id === "verification-01" && typeof value.command === "string" && value.command === command && absolutePathValue(value.cwd) && absolutePathValue(value.logPath) && absolutePathValue(value.resultPath) && value.logPath.endsWith("/completion/final-verification/verification-01/output.log") && value.resultPath.endsWith("/completion/final-verification/verification-01/result.json");
	if (!validCommon) return { diagnostics: [diagnostic("invalid-run", "Final verification execution must bind the frozen command and deterministic absolute paths.", path)] };
	const commonValues = { command: value.command as string, cwd: value.cwd as string, logPath: value.logPath as string, resultPath: value.resultPath as string };
	if (value.phase === "intended" && exactKeys(value, [...common, "phase", "intendedAt"]) && canonicalTimestamp(value.intendedAt)) return { value: { phase: "intended", id: "verification-01", ...commonValues, intendedAt: value.intendedAt }, diagnostics: [] };
	if ((value.phase === "passed" || value.phase === "failed") && exactKeys(value, [...common, "phase", "intendedAt", "startedAt", "completedAt", "exitCode", "killed", "logSha256", "resultSha256", "checkout"]) && canonicalTimestamp(value.intendedAt) && canonicalTimestamp(value.startedAt) && canonicalTimestamp(value.completedAt) && value.startedAt >= value.intendedAt && value.completedAt >= value.startedAt && typeof value.exitCode === "number" && Number.isSafeInteger(value.exitCode) && value.killed === false && typeof value.logSha256 === "string" && /^sha256:[0-9a-f]{64}$/.test(value.logSha256) && typeof value.resultSha256 === "string" && /^sha256:[0-9a-f]{64}$/.test(value.resultSha256)) {
		const checkout = validateIntegrationObservation(value.checkout, `${path}.checkout`);
		if (!checkout.value || checkout.diagnostics.length > 0) return { diagnostics: checkout.diagnostics };
		if (value.phase === "passed" && value.exitCode !== 0) return { diagnostics: [diagnostic("invalid-run", "Passed final verification requires exit code zero.", path)] };
		if (value.phase === "failed" && value.exitCode === 0) return { diagnostics: [diagnostic("invalid-run", "Failed final verification requires a nonzero exit code.", path)] };
		return { value: { phase: value.phase, id: "verification-01", ...commonValues, intendedAt: value.intendedAt, startedAt: value.startedAt, completedAt: value.completedAt, exitCode: value.exitCode, killed: false, logSha256: value.logSha256, resultSha256: value.resultSha256, checkout: checkout.value }, diagnostics: [] };
	}
	if (value.phase === "ambiguous" && exactKeys(value, [...common, "phase", "intendedAt", "observedAt", "exitCode", "killed", "diagnostic", ...(Object.prototype.hasOwnProperty.call(value, "logSha256") ? ["logSha256"] : []), ...(Object.prototype.hasOwnProperty.call(value, "resultSha256") ? ["resultSha256"] : []), ...(Object.prototype.hasOwnProperty.call(value, "checkout") ? ["checkout"] : [])]) && canonicalTimestamp(value.intendedAt) && canonicalTimestamp(value.observedAt) && value.observedAt >= value.intendedAt && (value.exitCode === null || (typeof value.exitCode === "number" && Number.isSafeInteger(value.exitCode))) && (value.killed === null || typeof value.killed === "boolean") && boundedText(value.diagnostic, 2_000) && (!Object.prototype.hasOwnProperty.call(value, "logSha256") || (typeof value.logSha256 === "string" && /^sha256:[0-9a-f]{64}$/.test(value.logSha256))) && (!Object.prototype.hasOwnProperty.call(value, "resultSha256") || (typeof value.resultSha256 === "string" && /^sha256:[0-9a-f]{64}$/.test(value.resultSha256)))) {
		const checkout = Object.prototype.hasOwnProperty.call(value, "checkout") ? validateIntegrationObservation(value.checkout, `${path}.checkout`) : { diagnostics: [] };
		if (checkout.diagnostics.length > 0) return { diagnostics: checkout.diagnostics };
		return { value: { phase: "ambiguous", id: "verification-01", ...commonValues, intendedAt: value.intendedAt, observedAt: value.observedAt, exitCode: value.exitCode, killed: value.killed, diagnostic: value.diagnostic, ...(typeof value.logSha256 === "string" ? { logSha256: value.logSha256 } : {}), ...(typeof value.resultSha256 === "string" ? { resultSha256: value.resultSha256 } : {}), ...(checkout.value ? { checkout: checkout.value } : {}) }, diagnostics: [] };
	}
	return { diagnostics: [diagnostic("invalid-run", "Final verification execution has invalid exact phase fields.", path)] };
}

function validateCompletionGate(value: unknown, path: string): { value?: AnyCompletionGateFacts; diagnostics: RunDiagnostic[] } {
	if (isRecord(value) && value.kind === "multi-task") {
		if (!exactKeys(value, ["kind", "evaluatedAt", "tasks", "integratedHead", "verificationResultSha256", "verificationLogSha256", "checkout", "predicates"]) || !canonicalTimestamp(value.evaluatedAt) || !Array.isArray(value.tasks) || value.tasks.length === 0 || typeof value.integratedHead !== "string" || !/^[0-9a-f]{40}$/.test(value.integratedHead) || typeof value.verificationResultSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.verificationResultSha256) || typeof value.verificationLogSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.verificationLogSha256) || !Array.isArray(value.predicates) || JSON.stringify(value.predicates) !== JSON.stringify([...MULTI_COMPLETION_GATE_PREDICATES])) return { diagnostics: [diagnostic("invalid-run", "Multi-Task Completion Gate facts must contain every named predicate exactly once.", path)] };
		const tasks: MultiCompletionTaskFacts[] = [];
		const diagnostics: RunDiagnostic[] = [];
		for (let index = 0; index < value.tasks.length; index += 1) {
			const item = value.tasks[index];
			const itemPath = `${path}.tasks[${index}]`;
			if (!isRecord(item) || (item.kind !== "code" && item.kind !== "non-code") || !safeIdentifier(item.taskId) || !safeIdentifier(item.builderAttemptId)) {
				diagnostics.push(diagnostic("invalid-run", "Multi-Task Completion facts contain an invalid Task identity.", itemPath));
				continue;
			}
			const hasReviewer = Object.prototype.hasOwnProperty.call(item, "reviewerAttemptId");
			const hasSource = Object.prototype.hasOwnProperty.call(item, "source");
			const hasIntegration = Object.prototype.hasOwnProperty.call(item, "integration");
			if (!exactKeys(item, ["taskId", "kind", "builderAttemptId", ...(hasReviewer ? ["reviewerAttemptId"] : []), ...(hasSource ? ["source"] : []), ...(hasIntegration ? ["integration"] : [])]) || (hasReviewer && !safeIdentifier(item.reviewerAttemptId)) || (item.kind === "code" && (!hasReviewer || !hasSource || !hasIntegration)) || (item.kind === "non-code" && (hasSource || hasIntegration))) {
				diagnostics.push(diagnostic("invalid-run", "Multi-Task Completion facts have invalid exact Task fields.", itemPath));
				continue;
			}
			let source: MultiCompletionTaskFacts["source"];
			if (hasSource) {
				const raw = item.source;
				if (!isRecord(raw) || !exactKeys(raw, ["baseRevision", "headRevision", "commits", "builderManifestSha256", "reviewerManifestSha256"]) || typeof raw.baseRevision !== "string" || !/^[0-9a-f]{40}$/.test(raw.baseRevision) || typeof raw.headRevision !== "string" || !/^[0-9a-f]{40}$/.test(raw.headRevision) || !Array.isArray(raw.commits) || raw.commits.length === 0 || raw.commits.some((commit) => typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) || typeof raw.builderManifestSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(raw.builderManifestSha256) || typeof raw.reviewerManifestSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(raw.reviewerManifestSha256)) {
					diagnostics.push(diagnostic("invalid-run", "Multi-Task Completion source identity is invalid.", `${itemPath}.source`));
					continue;
				}
				source = { baseRevision: raw.baseRevision, headRevision: raw.headRevision, commits: [...raw.commits] as string[], builderManifestSha256: raw.builderManifestSha256, reviewerManifestSha256: raw.reviewerManifestSha256 };
			}
			let integration: MultiCompletionTaskFacts["integration"];
			if (hasIntegration) {
				const raw = item.integration;
				const action = isRecord(raw) ? raw.action : undefined;
				if (!isRecord(raw) || !exactKeys(raw, ["targetBranch", "targetRevision", "approvedBaseRevision", "approvedHeadRevision", "approvedCommits", "observedHead", "action"]) || !safeBranch(raw.targetBranch) || typeof raw.targetRevision !== "string" || !/^[0-9a-f]{40}$/.test(raw.targetRevision) || typeof raw.approvedBaseRevision !== "string" || !/^[0-9a-f]{40}$/.test(raw.approvedBaseRevision) || typeof raw.approvedHeadRevision !== "string" || !/^[0-9a-f]{40}$/.test(raw.approvedHeadRevision) || !Array.isArray(raw.approvedCommits) || raw.approvedCommits.length === 0 || raw.approvedCommits.some((commit) => typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) || typeof raw.observedHead !== "string" || !/^[0-9a-f]{40}$/.test(raw.observedHead) || !isRecord(action) || !exactKeys(action, ["kind", "argv"]) || !Array.isArray(action.argv) || action.argv.length !== 4 || action.argv[0] !== "merge" || action.argv[2] !== "--no-edit" || action.argv[3] !== raw.approvedHeadRevision || !((action.kind === "fast-forward" && action.argv[1] === "--ff-only") || (action.kind === "merge-commit" && action.argv[1] === "--no-ff"))) {
					diagnostics.push(diagnostic("invalid-run", "Multi-Task Completion integration identity is invalid.", `${itemPath}.integration`));
					continue;
				}
				const rawAction = raw.action as Record<string, unknown>;
				integration = { targetBranch: raw.targetBranch, targetRevision: raw.targetRevision, approvedBaseRevision: raw.approvedBaseRevision, approvedHeadRevision: raw.approvedHeadRevision, approvedCommits: [...raw.approvedCommits] as string[], observedHead: raw.observedHead, action: rawAction.kind === "fast-forward" ? { kind: "fast-forward", argv: ["merge", "--ff-only", "--no-edit", raw.approvedHeadRevision] } : { kind: "merge-commit", argv: ["merge", "--no-ff", "--no-edit", raw.approvedHeadRevision] } };
			}
			tasks.push({ taskId: item.taskId, kind: item.kind, builderAttemptId: item.builderAttemptId, ...(hasReviewer ? { reviewerAttemptId: item.reviewerAttemptId as string } : {}), ...(source ? { source } : {}), ...(integration ? { integration } : {}) });
		}
		const ids = tasks.map((task) => task.taskId);
		if (new Set(ids).size !== ids.length) diagnostics.push(diagnostic("invalid-run", "Multi-Task Completion identities must be unique.", `${path}.tasks`));
		const checkout = validateIntegrationObservation(value.checkout, `${path}.checkout`);
		diagnostics.push(...checkout.diagnostics);
		return diagnostics.length > 0 || !checkout.value ? { diagnostics } : { value: { kind: "multi-task", evaluatedAt: value.evaluatedAt, tasks, integratedHead: value.integratedHead, verificationResultSha256: value.verificationResultSha256, verificationLogSha256: value.verificationLogSha256, checkout: checkout.value, predicates: [...value.predicates] as MultiCompletionGatePredicate[] }, diagnostics: [] };
	}
	if (!isRecord(value) || !exactKeys(value, ["evaluatedAt", "taskId", "integratedHead", "verificationResultSha256", "verificationLogSha256", "checkout", "predicates"]) || !canonicalTimestamp(value.evaluatedAt) || !safeIdentifier(value.taskId) || typeof value.integratedHead !== "string" || !/^[0-9a-f]{40}$/.test(value.integratedHead) || typeof value.verificationResultSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.verificationResultSha256) || typeof value.verificationLogSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.verificationLogSha256) || !Array.isArray(value.predicates) || JSON.stringify(value.predicates) !== JSON.stringify([...COMPLETION_GATE_PREDICATES]) || value.predicates.some((predicate) => !COMPLETION_GATE_PREDICATES.includes(predicate as CompletionGatePredicate))) return { diagnostics: [diagnostic("invalid-run", "Completion Gate facts must contain every named predicate exactly once.", path)] };
	const checkout = validateIntegrationObservation(value.checkout, `${path}.checkout`);
	return checkout.value && checkout.diagnostics.length === 0 ? { value: { evaluatedAt: value.evaluatedAt, taskId: value.taskId, integratedHead: value.integratedHead, verificationResultSha256: value.verificationResultSha256, verificationLogSha256: value.verificationLogSha256, checkout: checkout.value, predicates: [...value.predicates] as CompletionGatePredicate[] }, diagnostics: [] } : { diagnostics: checkout.diagnostics };
}

function validateCompletionAgentIdentity(value: unknown, path: string, exact = true): { value?: CompletionAgentIdentity; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || (exact && !exactKeys(value, ["role", "agentName", "workspaceId", "paneId", "terminalId"])) || (value.role !== "builder" && value.role !== "reviewer") || !herdrName(value.agentName) || !trimmedString(value.workspaceId) || !trimmedString(value.paneId) || !trimmedString(value.terminalId)) return { diagnostics: [diagnostic("invalid-run", "Completion agent identity has invalid exact fields.", path)] };
	return { value: { role: value.role, agentName: value.agentName, workspaceId: value.workspaceId, paneId: value.paneId, terminalId: value.terminalId }, diagnostics: [] };
}

function validateCompletionResource(value: unknown, path: string): { value?: CompletionStopResource; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || typeof value.state !== "string") return { diagnostics: [diagnostic("invalid-run", "Completion stop resource must have a recognized state.", path)] };
	const identity = validateCompletionAgentIdentity(value, path, false);
	if (!identity.value || identity.diagnostics.length > 0) return { diagnostics: identity.diagnostics };
	if (value.state === "intended" && exactKeys(value, ["role", "agentName", "workspaceId", "paneId", "terminalId", "state", "intendedAt"]) && canonicalTimestamp(value.intendedAt)) return { value: { ...identity.value, state: "intended", intendedAt: value.intendedAt }, diagnostics: [] };
	if (value.state === "acknowledged" && exactKeys(value, ["role", "agentName", "workspaceId", "paneId", "terminalId", "state", "intendedAt", "acknowledgedAt", "acknowledgement"]) && canonicalTimestamp(value.intendedAt) && canonicalTimestamp(value.acknowledgedAt) && value.acknowledgedAt >= value.intendedAt && isRecord(value.acknowledgement) && exactKeys(value.acknowledgement, ["name", "workspaceId", "tabId", "paneId", "terminalId"]) && value.acknowledgement.name === value.agentName && value.acknowledgement.workspaceId === value.workspaceId && value.acknowledgement.paneId === value.paneId && value.acknowledgement.terminalId === value.terminalId && trimmedString(value.acknowledgement.tabId)) {
		const acknowledgement = value.acknowledgement as Record<string, unknown>;
		return { value: { ...identity.value, state: "acknowledged", intendedAt: value.intendedAt, acknowledgedAt: value.acknowledgedAt, acknowledgement: { name: acknowledgement.name as string, workspaceId: acknowledgement.workspaceId as string, tabId: acknowledgement.tabId as string, paneId: acknowledgement.paneId as string, terminalId: acknowledgement.terminalId as string } }, diagnostics: [] };
	}
	return { diagnostics: [diagnostic("invalid-run", "Completion stop resource has invalid exact acknowledgement fields.", path)] };
}

function validateCompletionFailure(value: unknown, path: string): { value?: CompletionStopFailure; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || !exactKeys(value, ["state", "resource", "observedAt", "diagnostic"]) || (value.state !== "failed" && value.state !== "ambiguous") || !canonicalTimestamp(value.observedAt) || !boundedText(value.diagnostic, 2_000)) return { diagnostics: [diagnostic("invalid-run", "Completion stop failure has invalid exact fields.", path)] };
	const resource = validateCompletionAgentIdentity(value.resource, `${path}.resource`);
	return resource.value && resource.diagnostics.length === 0 ? { value: { state: value.state, resource: resource.value, observedAt: value.observedAt, diagnostic: value.diagnostic }, diagnostics: [] } : { diagnostics: resource.diagnostics };
}

function validateReportInventory(value: unknown, path: string): { value?: CompletionReportInventoryItem[]; diagnostics: RunDiagnostic[] } {
	if (!Array.isArray(value) || value.length === 0 || value.length > 24) return { diagnostics: [diagnostic("invalid-run", "Completion report inventory must be a bounded non-empty array.", path)] };
	const inventory: CompletionReportInventoryItem[] = [];
	const diagnostics: RunDiagnostic[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const item = value[index];
		if (!isRecord(item) || !exactKeys(item, ["taskId", "attemptId", "role", "sourcePath", "destinationPath", "size", "sha256"]) || !safeIdentifier(item.taskId) || !safeIdentifier(item.attemptId) || (item.role !== "builder" && item.role !== "reviewer") || !absolutePathValue(item.sourcePath) || !pathValue(item.destinationPath) || typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 0 || typeof item.sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(item.sha256)) {
			diagnostics.push(diagnostic("invalid-run", "Completion report inventory item has invalid exact fields.", `${path}[${index}]`));
			continue;
		}
		inventory.push({ taskId: item.taskId, attemptId: item.attemptId, role: item.role, sourcePath: item.sourcePath, destinationPath: item.destinationPath, size: item.size, sha256: item.sha256 });
	}
	const identities = inventory.map((item) => `${item.taskId}/${item.attemptId}/${item.role}`);
	if (new Set(identities).size !== identities.length) diagnostics.push(diagnostic("invalid-run", "Completion report inventory identities must be unique.", path));
	return diagnostics.length > 0 ? { diagnostics } : { value: inventory, diagnostics: [] };
}

function validateArchiveIntent(value: unknown, path: string): { value?: CompletionArchiveIntent; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || !exactKeys(value, ["intendedAt", "archiveDirectory", "runPath", "previousRunPath", "manifestPath", "activeJournalSha256", "previousJournalSha256", "verification", "reports"]) || !canonicalTimestamp(value.intendedAt) || !absolutePathValue(value.archiveDirectory) || !absolutePathValue(value.runPath) || !absolutePathValue(value.previousRunPath) || !absolutePathValue(value.manifestPath) || typeof value.activeJournalSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.activeJournalSha256) || typeof value.previousJournalSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.previousJournalSha256) || !isRecord(value.verification) || !exactKeys(value.verification, ["logPath", "resultPath", "logSha256", "resultSha256"]) || !absolutePathValue(value.verification.logPath) || !absolutePathValue(value.verification.resultPath) || typeof value.verification.logSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.verification.logSha256) || typeof value.verification.resultSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.verification.resultSha256)) return { diagnostics: [diagnostic("invalid-run", "Completion archive intent has invalid exact paths, hashes, or verification pointers.", path)] };
	const reports = validateReportInventory(value.reports, `${path}.reports`);
	return reports.value && reports.diagnostics.length === 0 ? { value: { intendedAt: value.intendedAt, archiveDirectory: value.archiveDirectory, runPath: value.runPath, previousRunPath: value.previousRunPath, manifestPath: value.manifestPath, activeJournalSha256: value.activeJournalSha256, previousJournalSha256: value.previousJournalSha256, verification: { logPath: value.verification.logPath, resultPath: value.verification.resultPath, logSha256: value.verification.logSha256, resultSha256: value.verification.resultSha256 }, reports: reports.value }, diagnostics: [] } : { diagnostics: reports.diagnostics };
}

function validateCompletion(value: unknown, path: string): { value?: CompletionRecord; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || typeof value.phase !== "string" || !isRecord(value.gate)) return { diagnostics: [diagnostic("invalid-run", "Completion must contain a recognized phase and Gate facts.", path)] };
	const gate = validateCompletionGate(value.gate, `${path}.gate`);
	if (!gate.value || gate.diagnostics.length > 0) return { diagnostics: gate.diagnostics };
	if (value.phase === "gate-passed" && exactKeys(value, ["phase", "gate"])) return { value: { phase: "gate-passed", gate: gate.value }, diagnostics: [] };
	if (value.phase === "stops-intended" && exactKeys(value, ["phase", "gate", "resources"]) && Array.isArray(value.resources)) {
		const resources = value.resources.map((resource, index) => validateCompletionResource(resource, `${path}.resources[${index}]`));
		if (resources.length > 0 && resources.every((result) => result.value) && new Set(resources.map((result) => `${result.value!.role}/${result.value!.agentName}/${result.value!.workspaceId}/${result.value!.paneId}/${result.value!.terminalId}`)).size === resources.length && resources.every((result) => result.value?.state === "intended" || result.value?.state === "acknowledged")) return { value: { phase: "stops-intended", gate: gate.value, resources: resources.map((result) => result.value!) }, diagnostics: [] };
		return { diagnostics: resources.flatMap((result) => result.diagnostics.length > 0 ? result.diagnostics : [diagnostic("invalid-run", "Stops-intended resources must be unique and acknowledged only after intent.", path)]) };
	}
	if (value.phase === "stops-incomplete" && exactKeys(value, ["phase", "gate", "resources", "failure"]) && Array.isArray(value.resources)) {
		const resources = value.resources.map((resource, index) => validateCompletionResource(resource, `${path}.resources[${index}]`));
		const failure = validateCompletionFailure(value.failure, `${path}.failure`);
		if (failure.value && resources.every((result) => result.value) && resources.every((result) => result.value?.state === "intended" || result.value?.state === "acknowledged")) return { value: { phase: "stops-incomplete", gate: gate.value, resources: resources.map((result) => result.value!) as CompletionStopResource[], failure: failure.value }, diagnostics: [] };
		return { diagnostics: [...resources.flatMap((result) => result.diagnostics), ...failure.diagnostics] };
	}
	if (value.phase === "stops-complete" && exactKeys(value, ["phase", "gate", "resources"]) && Array.isArray(value.resources)) {
		const resources = value.resources.map((resource, index) => validateCompletionResource(resource, `${path}.resources[${index}]`));
		if (resources.length > 0 && resources.every((result) => result.value?.state === "acknowledged")) return { value: { phase: "stops-complete", gate: gate.value, resources: resources.map((result) => result.value!) as Array<Extract<CompletionStopResource, { state: "acknowledged" }>> }, diagnostics: [] };
		return { diagnostics: resources.flatMap((result) => result.diagnostics.length > 0 ? result.diagnostics : [diagnostic("invalid-run", "Stops-complete requires acknowledged resources.", path)]) };
	}
	if (value.phase === "archive-intended" && exactKeys(value, ["phase", "gate", "resources", "archive"]) && Array.isArray(value.resources)) {
		const resources = value.resources.map((resource, index) => validateCompletionResource(resource, `${path}.resources[${index}]`));
		const archive = validateArchiveIntent(value.archive, `${path}.archive`);
		if (archive.value && resources.length > 0 && resources.every((result) => result.value?.state === "acknowledged")) return { value: { phase: "archive-intended", gate: gate.value, resources: resources.map((result) => result.value!) as Array<Extract<CompletionStopResource, { state: "acknowledged" }>>, archive: archive.value }, diagnostics: [] };
		return { diagnostics: [...resources.flatMap((result) => result.diagnostics), ...archive.diagnostics] };
	}
	if (value.phase === "archived" && exactKeys(value, ["phase", "gate", "resources", "archive", "archivedAt"]) && canonicalTimestamp(value.archivedAt) && Array.isArray(value.resources)) {
		const resources = value.resources.map((resource, index) => validateCompletionResource(resource, `${path}.resources[${index}]`));
		const archive = validateArchiveIntent(value.archive, `${path}.archive`);
		if (archive.value && resources.length > 0 && resources.every((result) => result.value?.state === "acknowledged")) return { value: { phase: "archived", gate: gate.value, resources: resources.map((result) => result.value!) as Array<Extract<CompletionStopResource, { state: "acknowledged" }>>, archive: archive.value, archivedAt: value.archivedAt }, diagnostics: [] };
		return { diagnostics: [...resources.flatMap((result) => result.diagnostics), ...archive.diagnostics] };
	}
	return { diagnostics: [diagnostic("invalid-run", "Completion has invalid exact phase fields.", path)] };
}

function isReworkDispatch(value: BuilderDispatchRecord): value is ReworkDispatchRecord {
	return "cycle" in value;
}

function validateAttemptSequence(attempts: AttemptRecord[], rawTask: Record<string, unknown>, contract: TaskContract | undefined, modelPlans: ProjectModelPlans | undefined, path: string, diagnostics: RunDiagnostic[]): void {
	if (!contract) return;
	for (let index = 0; index < attempts.length; index += 1) {
		const attempt = attempts[index]!;
		const expectedId = `attempt-${String(index + 1).padStart(2, "0")}`;
		if (attempt.id !== expectedId) diagnostics.push(diagnostic("invalid-task", "Attempt IDs must be contiguous and derived from sequence position.", `${path}.attempts[${index}].id`));
		const predecessor = attempts[index - 1];
		const isReplacement = attempt.replacement !== undefined;
		if (!isReplacement && attempt.role !== (index === 0 ? "builder" : predecessor?.role === "builder" ? "reviewer" : "builder")) diagnostics.push(diagnostic("invalid-task", "Attempt roles must alternate except for an exact linked silent-agent replacement.", `${path}.attempts[${index}].role`));
			if (isReplacement) {
				const predecessorSilence = predecessor?.recovery?.silence;
				const replacementSilence = predecessorSilence && (predecessorSilence.phase === "replacement-intended" || predecessorSilence.phase === "replacement-ambiguous") ? predecessorSilence : undefined;
				const isTransient = attempt.replacement?.kind === "transient-recovery";
				const predecessorEnded = isTransient ? (predecessor?.state === "ended-error" || predecessor?.state === "superseded") : predecessor?.state === "superseded";
				const preserveAt = isTransient ? predecessor?.recovery?.infrastructure?.observedAt : replacementSilence?.intendedAt;
				const sameModel = isTransient
					? (attempt.replacement?.kind === "transient-recovery" && attempt.replacement.modelSelection.kind !== "same-model-first") || JSON.stringify(attempt.actualModel) === JSON.stringify(predecessor?.actualModel)
					: JSON.stringify(attempt.actualModel) === JSON.stringify(predecessor?.actualModel);
				if (!predecessor || predecessor.role !== attempt.role || !predecessorEnded || attempt.replacement?.replacesAttemptId !== predecessor.id || attempt.replacement.preservedAt < (preserveAt ?? predecessor.preparedAt) || attempt.preparedAt !== attempt.replacement?.preservedAt || attempt.specificationHash !== predecessor.specificationHash || !predecessor.recovery?.preservation || (!isTransient && !replacementSilence) || (!isTransient && replacementSilence?.intendedAt !== attempt.replacement?.preservedAt) || (isTransient && !predecessor.recovery.infrastructure) || !sameModel) diagnostics.push(diagnostic("invalid-task", "Replacement must immediately follow and exactly link the predecessor preservation, outcome, and same-role lineage.", `${path}.attempts[${index}].replacement`));
				if (isTransient && attempt.replacement?.kind === "transient-recovery" && predecessor) {
					const rolePlan = modelPlans?.[attempt.role];
					const choices = rolePlan ? [rolePlan.primary, ...rolePlan.fallbacks] : [];
					const predecessorIndex = choices.findIndex((choice) => JSON.stringify(choice) === JSON.stringify(predecessor.actualModel));
					const selection = attempt.replacement.modelSelection;
					const selected = choices[selection.planIndex];
					if (!rolePlan || predecessorIndex < 0 || !selected || JSON.stringify(selected) !== JSON.stringify(attempt.actualModel)) {
						diagnostics.push(diagnostic("invalid-task", "Transient replacement must bind its model selection to the frozen role plan and actual model.", `${path}.attempts[${index}].replacement.modelSelection`));
					} else if (selection.kind === "same-model-first") {
						if (selection.planIndex !== predecessorIndex) diagnostics.push(diagnostic("invalid-task", "Same-model-first replacement must select the predecessor's frozen plan index.", `${path}.attempts[${index}].replacement.modelSelection.planIndex`));
					} else if (selection.planIndex <= predecessorIndex || selection.skipped.length !== selection.planIndex - predecessorIndex || selection.skipped.some((skipped, skippedIndex) => {
						const skippedChoice = choices[skipped.planIndex];
						return skipped.planIndex !== predecessorIndex + skippedIndex || !skippedChoice || skippedChoice.model !== skipped.model;
					})) {
						diagnostics.push(diagnostic("invalid-task", "Approved fallback must move strictly forward through the frozen model plan and retain each skipped choice.", `${path}.attempts[${index}].replacement.modelSelection`));
					}
				}
				if (attempt.replacement) {
					const expectedOrdinal = attempts.slice(0, index).filter((candidate) => candidate.replacement !== undefined).length + 1;
					if (attempt.replacement.retryOrdinal !== expectedOrdinal) diagnostics.push(diagnostic("invalid-task", "Replacement ordinal must equal the global replacement link position in Task order.", `${path}.attempts[${index}].replacement.retryOrdinal`));
				}
				const precedingBuilder = (candidateIndex: number): BuilderAttemptRecord | undefined => {
					for (let priorIndex = candidateIndex - 1; priorIndex >= 0; priorIndex -= 1) {
						const candidate = attempts[priorIndex];
						if (candidate?.role === "builder") return candidate;
					}
					return undefined;
				};
				const lineageFacts = (candidate: AttemptRecord | undefined, candidateIndex: number): { branch?: string; worktreePath?: string; paneId?: string; workspaceId?: string } => {
					if (!candidate) return {};
					const dispatch = candidate.dispatch;
					const builder = precedingBuilder(candidateIndex);
					const builderDispatch = builder?.dispatch;
					return {
						branch: "branch" in dispatch ? dispatch.branch : builderDispatch && "branch" in builderDispatch ? builderDispatch.branch : candidate.recovery?.preservation?.branch,
						worktreePath: "worktreePath" in dispatch ? dispatch.worktreePath : candidate.role === "reviewer" ? candidate.worktree.path : candidate.recovery?.preservation?.worktreePath ?? (builderDispatch && "worktreePath" in builderDispatch ? builderDispatch.worktreePath : undefined),
						paneId: "paneId" in dispatch ? dispatch.paneId : "sourcePaneId" in dispatch ? dispatch.sourcePaneId : builderDispatch && "paneId" in builderDispatch ? builderDispatch.paneId : undefined,
						workspaceId: "workspaceId" in dispatch ? dispatch.workspaceId : builderDispatch && "workspaceId" in builderDispatch ? builderDispatch.workspaceId : undefined,
					};
				};
				const attemptFacts = lineageFacts(attempt, index);
				const predecessorFacts = lineageFacts(predecessor, index - 1);
				const replacementDispatch = attempt.dispatch;
				const sourcePaneMatches = !predecessor || replacementDispatch.phase !== "replacement-pane-intended" || (replacementDispatch.sourcePaneId === predecessorFacts.paneId && replacementDispatch.workspaceId === predecessorFacts.workspaceId);
				const reviewerBuilder = precedingBuilder(index - 1);
				const reviewerBuilderProvider = reviewerBuilder ? parseCanonicalModelReference(reviewerBuilder.actualModel.model)?.provider : undefined;
				const predecessorReviewerProvider = predecessor?.role === "reviewer" ? parseCanonicalModelReference(predecessor.actualModel.model)?.provider : undefined;
				const successorReviewerProvider = attempt.role === "reviewer" ? parseCanonicalModelReference(attempt.actualModel.model)?.provider : undefined;
				const transientReviewerProviderChange = isTransient && attempt.role === "reviewer" && predecessor?.role === "reviewer"
					? reviewerBuilderProvider !== undefined && predecessorReviewerProvider !== undefined && successorReviewerProvider !== undefined
						&& attempt.independence.kind === "different-provider-family"
						&& attempt.independence.builderProvider === reviewerBuilderProvider
						&& attempt.independence.reviewerProvider === successorReviewerProvider
						&& successorReviewerProvider !== reviewerBuilderProvider
						&& ((predecessor.independence.kind === "different-provider-family"
							&& predecessor.independence.builderProvider === reviewerBuilderProvider
							&& predecessor.independence.reviewerProvider === predecessorReviewerProvider)
							|| (predecessor.independence.kind === "same-provider-family-approved"
								&& predecessor.independence.provider === reviewerBuilderProvider
								&& predecessorReviewerProvider === reviewerBuilderProvider))
					: false;
				const reviewerIndependenceMatches = attempt.role === "reviewer" && predecessor?.role === "reviewer" && (JSON.stringify(attempt.independence) === JSON.stringify(predecessor.independence) || transientReviewerProviderChange);
				const reviewerFactsMatch = attempt.role !== "reviewer" || !predecessor || (predecessor.role === "reviewer" && JSON.stringify(attempt.subject) === JSON.stringify(predecessor.subject) && reviewerIndependenceMatches && JSON.stringify(attempt.worktree.baseline) === JSON.stringify(predecessor.worktree.baseline));
					if (attemptFacts.worktreePath !== predecessorFacts.worktreePath || attemptFacts.branch !== predecessorFacts.branch || !sourcePaneMatches || !reviewerFactsMatch) diagnostics.push(diagnostic("invalid-task", "Replacement must retain the predecessor identity, subject, worktree, and branch facts.", `${path}.attempts[${index}]`));
		}
		if (index === 0 && attempt.role === "builder" && isReworkDispatch(attempt.dispatch)) diagnostics.push(diagnostic("invalid-task", "The first Builder Attempt must use the initial dispatch variant.", `${path}.attempts[${index}].dispatch`));
		if (index > 0 && attempt.role === "builder" && !isReplacement && !isReworkDispatch(attempt.dispatch)) diagnostics.push(diagnostic("invalid-task", "Later non-replacement Builder Attempts must use the rework dispatch variant.", `${path}.attempts[${index}].dispatch`));
		if (attempt.role === "reviewer" && index > 0 && !isReplacement) {
			const preceding = attempts[index - 1];
			if (preceding?.role !== "builder" || preceding.state === "prepared" || preceding.evidence?.phase !== "finalized" || !reviewSubjectBindsBuilder(attempt.subject, preceding)) diagnostics.push(diagnostic("invalid-task", "Each Reviewer must bind the immediately preceding finalized Builder subject.", `${path}.attempts[${index}]`));
		}
		if (attempt.role === "builder" && index > 0 && isReworkDispatch(attempt.dispatch)) {
			const priorReviewer = attempts[index - 1];
			let priorBuilder: AttemptRecord | undefined;
			for (let priorIndex = index - 2; priorIndex >= 0; priorIndex -= 1) {
				if (attempts[priorIndex]?.role === "builder") {
					priorBuilder = attempts[priorIndex];
					break;
				}
			}
			const priorDispatch = priorBuilder?.role === "builder" ? priorBuilder.dispatch : undefined;
			const sameBuilder = (priorDispatch?.phase === "prompted" || priorDispatch?.phase === "reconciled-active") && (attempt.dispatch.phase === "assignment-intended" || attempt.dispatch.phase === "prompt-intended" || attempt.dispatch.phase === "prompted" || attempt.dispatch.phase === "reconciled-active") && attempt.dispatch.branch === priorDispatch.branch && attempt.dispatch.agentName === priorDispatch.agentName && attempt.dispatch.worktreePath === priorDispatch.worktreePath && attempt.dispatch.workspaceId === priorDispatch.workspaceId && attempt.dispatch.paneId === priorDispatch.paneId && attempt.dispatch.terminalId === priorDispatch.terminalId;
			const sameReviewEvidence = priorReviewer?.role === "reviewer" && priorReviewer.evidence?.phase === "finalized" && attempt.dispatch.reviewerManifestPath === priorReviewer.evidence.manifestPath && attempt.dispatch.reviewerManifestSha256 === priorReviewer.evidence.manifestSha256;
			const expectedCycle = attempts.slice(0, index).filter((candidate) => candidate.role === "builder" && candidate.replacement === undefined && isReworkDispatch(candidate.dispatch)).length + 1;
			if (!priorBuilder || priorBuilder.role !== "builder" || !priorReviewer || priorReviewer.role !== "reviewer" || priorReviewer.state !== "reported" || priorReviewer.evidence?.phase !== "finalized" || priorReviewer.evidence.verdict !== "changes-required" || attempt.dispatch.priorBuilderAttemptId !== priorBuilder.id || attempt.dispatch.priorReviewerAttemptId !== priorReviewer.id || attempt.dispatch.cycle !== expectedCycle || !reviewSubjectsEqual(attempt.dispatch.reviewedSubject, priorReviewer.subject) || !sameReviewEvidence || !sameBuilder) diagnostics.push(diagnostic("invalid-task", "Rework Builder backlinks, protected evidence, subject, identity, and logical lineage cycle must match the preceding changes-required Review.", `${path}.attempts[${index}]`));
		}
	}
	const expectedRework = attempts.filter((attempt) => attempt.role === "builder" && !attempt.replacement && isReworkDispatch(attempt.dispatch)).length;
	if ((rawTask.reworkCycles as unknown) !== expectedRework) diagnostics.push(diagnostic("invalid-task", "reworkCycles must equal the number of rework Builder Attempts.", `${path}.reworkCycles`));
	if (attempts.length > 20) diagnostics.push(diagnostic("invalid-task", "A Task allows a bounded alternating history plus silent replacements.", `${path}.attempts`));
	const replacementOrdinals = attempts.flatMap((attempt) => attempt.replacement ? [attempt.replacement.retryOrdinal] : []);
	if (new Set(replacementOrdinals).size !== replacementOrdinals.length || replacementOrdinals.some((ordinal, index) => ordinal !== index + 1)) diagnostics.push(diagnostic("invalid-task", "Silent replacement ordinals must be unique and derive from the ordered Attempt links.", `${path}.attempts`));
	const exhaustedSilence = attempts.at(-1)?.recovery?.silence;
	if (exhaustedSilence?.phase === "exhausted" && (exhaustedSilence.retryOrdinal !== replacementOrdinals.length || exhaustedSilence.retryOrdinal > 2)) diagnostics.push(diagnostic("invalid-task", "Exhausted silence state must record exactly the bounded replacement links already consumed.", `${path}.attempts`));
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

function monitorDiagnostic(value: unknown): value is string {
	return boundedText(value, 2_000);
}

function monitorHash(value: unknown): value is string {
	return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function validateMonitorDigest(value: unknown, path: string): { value?: MonitorDigest; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || typeof value.kind !== "string") return { diagnostics: [diagnostic("invalid-run", "Monitor digest must be an observed or unavailable record.", path)] };
	if (value.kind === "observed" && exactKeys(value, ["kind", "byteCount", "sha256"]) && typeof value.byteCount === "number" && Number.isSafeInteger(value.byteCount) && value.byteCount >= 0 && value.byteCount <= 16 * 1024 * 1024 && monitorHash(value.sha256)) return { value: { kind: "observed", byteCount: value.byteCount, sha256: value.sha256 }, diagnostics: [] };
	if (value.kind === "unavailable" && exactKeys(value, ["kind", "diagnostic"]) && monitorDiagnostic(value.diagnostic)) return { value: { kind: "unavailable", diagnostic: value.diagnostic }, diagnostics: [] };
	return { diagnostics: [diagnostic("invalid-run", "Monitor digest has invalid exact bounded fields.", path)] };
}

function validateMonitorReport(value: unknown, path: string): { value?: MonitorReportObservation; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || typeof value.kind !== "string") return { diagnostics: [diagnostic("invalid-run", "Monitor report observation must be a recognized record.", path)] };
	if (value.kind === "missing" && exactKeys(value, ["kind"])) return { value: { kind: "missing" }, diagnostics: [] };
	if (value.kind === "present" && exactKeys(value, ["kind", "size", "sha256"]) && typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size >= 0 && value.size <= 64 * 1024 && monitorHash(value.sha256)) return { value: { kind: "present", size: value.size, sha256: value.sha256 }, diagnostics: [] };
	if (value.kind === "unavailable" && exactKeys(value, ["kind", "diagnostic"]) && monitorDiagnostic(value.diagnostic)) return { value: { kind: "unavailable", diagnostic: value.diagnostic }, diagnostics: [] };
	return { diagnostics: [diagnostic("invalid-run", "Monitor report observation has invalid exact bounded fields.", path)] };
}

function validateMonitorCheckpoint(value: unknown, path: string, run: { createdAt: string; updatedAt: string; tasks: TaskRecord[] }): { value?: MonitorCheckpoint; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value) || !exactKeys(value, ["observedAt", "taskId", "attemptId", "role", "agent", "terminal", "worktree", "git", "report"])) return { diagnostics: [diagnostic("invalid-run", "Monitor checkpoint contains unknown or missing keys.", path)] };
	const diagnostics: RunDiagnostic[] = [];
	if (!canonicalTimestamp(value.observedAt) || value.observedAt < run.createdAt || value.observedAt > run.updatedAt) diagnostics.push(diagnostic("invalid-run", "Monitor observedAt must be a canonical timestamp within the Run lifetime.", `${path}.observedAt`));
	if (!safeIdentifier(value.taskId) || !safeIdentifier(value.attemptId) || (value.role !== "builder" && value.role !== "reviewer")) diagnostics.push(diagnostic("invalid-run", "Monitor checkpoint identity fields are invalid.", path));
	const agent = value.agent;
	if (!isRecord(agent) || !exactKeys(agent, ["name", "workspaceId", "paneId", "terminalId", "lifecycle", "stateChangeSequence"]) || !herdrName(agent.name) || !trimmedString(agent.workspaceId) || !trimmedString(agent.paneId) || !trimmedString(agent.terminalId) || !["working", "blocked", "idle", "done", "unknown", "unavailable"].includes(agent.lifecycle as string) || (agent.stateChangeSequence !== null && (typeof agent.stateChangeSequence !== "number" || !Number.isSafeInteger(agent.stateChangeSequence) || agent.stateChangeSequence < 0))) diagnostics.push(diagnostic("invalid-run", "Monitor agent identity or lifecycle has invalid exact fields.", `${path}.agent`));
	const terminal = validateMonitorDigest(value.terminal, `${path}.terminal`);
	const worktree = validateMonitorDigest(value.worktree, `${path}.worktree`);
	const report = validateMonitorReport(value.report, `${path}.report`);
	diagnostics.push(...terminal.diagnostics, ...worktree.diagnostics, ...report.diagnostics);
	const git = value.git;
	if (!isRecord(git) || !exactKeys(git, Object.prototype.hasOwnProperty.call(git, "diagnostic") ? ["head", "digest", "diagnostic"] : ["head", "digest"]) || (git.head !== null && (typeof git.head !== "string" || !/^[0-9a-f]{40}$/.test(git.head))) || (git.digest !== null && !monitorHash(git.digest)) || (Object.prototype.hasOwnProperty.call(git, "diagnostic") && !monitorDiagnostic(git.diagnostic))) diagnostics.push(diagnostic("invalid-run", "Monitor Git observation has invalid exact fields.", `${path}.git`));
	const task = run.tasks.find((candidate) => candidate.contract.id === value.taskId);
	const attempt = task?.attempts.find((candidate) => candidate.id === value.attemptId);
	const latest = task?.attempts.at(-1);
	const dispatch = attempt?.dispatch;
	const actualDispatch = dispatch as AttemptRecord["dispatch"] | undefined;
	if (!task || !attempt || !latest || latest.id !== attempt.id || attempt.role !== value.role || !["prompted", "reconciled-active"].includes(actualDispatch?.phase ?? "") || !isRecord(agent) || !actualDispatch || !("workspaceId" in actualDispatch) || !("paneId" in actualDispatch) || !("terminalId" in actualDispatch) || agent.name !== actualDispatch.agentName || agent.workspaceId !== actualDispatch.workspaceId || agent.paneId !== actualDispatch.paneId || agent.terminalId !== actualDispatch.terminalId) diagnostics.push(diagnostic("invalid-run", "Monitor checkpoint must identify the current proven Attempt and its exact recorded Herdr resource.", path));
	if (diagnostics.length > 0 || !isRecord(agent) || !terminal.value || !worktree.value || !report.value || !isRecord(git)) return { diagnostics };
	return { value: { observedAt: value.observedAt as string, taskId: value.taskId as string, attemptId: value.attemptId as string, role: value.role as "builder" | "reviewer", agent: { name: agent.name as string, workspaceId: agent.workspaceId as string, paneId: agent.paneId as string, terminalId: agent.terminalId as string, lifecycle: agent.lifecycle as MonitorLifecycle, stateChangeSequence: agent.stateChangeSequence as number | null }, terminal: terminal.value, worktree: worktree.value, git: { head: git.head as string | null, digest: git.digest as string | null, ...(Object.prototype.hasOwnProperty.call(git, "diagnostic") ? { diagnostic: git.diagnostic as string } : {}) }, report: report.value }, diagnostics: [] };
}

function validateMonitorCheckpoints(value: unknown, path: string, run: { createdAt: string; updatedAt: string; tasks: TaskRecord[] }): { value?: MonitorCheckpoint[]; diagnostics: RunDiagnostic[] } {
	if (!Array.isArray(value) || value.length === 0 || value.length > run.tasks.length) return { diagnostics: [diagnostic("invalid-run", "monitors must be a bounded non-empty ordered array.", path)] };
	const diagnostics: RunDiagnostic[] = [];
	const monitors: MonitorCheckpoint[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const result = validateMonitorCheckpoint(value[index], `${path}[${index}]`, run);
		if (result.value) monitors.push(result.value);
		diagnostics.push(...result.diagnostics);
	}
	const taskOrder = run.tasks.map((task) => task.contract.id);
	const identities = monitors.map((monitor) => `${monitor.taskId}/${monitor.attemptId}/${monitor.role}`);
	if (new Set(identities).size !== identities.length) diagnostics.push(diagnostic("invalid-run", "monitor identities must be unique.", path));
	if (monitors.some((monitor, index) => index > 0 && taskOrder.indexOf(monitor.taskId) < taskOrder.indexOf(monitors[index - 1]!.taskId))) diagnostics.push(diagnostic("invalid-run", "monitors must retain Task array order.", path));
	return diagnostics.length > 0 ? { diagnostics } : { value: monitors, diagnostics: [] };
}

function validateRunRecord(value: unknown, path: string, options: { atActivePath: boolean } = { atActivePath: false }): { value?: RunRecord; diagnostics: RunDiagnostic[] } {
	if (!isRecord(value)) {
		return { diagnostics: [diagnostic("invalid-run", "Run contains unknown or missing keys.", path)] };
	}
	const hasFinalVerificationExecution = Object.prototype.hasOwnProperty.call(value, "finalVerificationExecution");
	const hasCompletion = Object.prototype.hasOwnProperty.call(value, "completion");
	const hasMonitor = Object.prototype.hasOwnProperty.call(value, "monitor");
	const hasMonitors = Object.prototype.hasOwnProperty.call(value, "monitors");
	if (hasMonitor && hasMonitors) return { diagnostics: [diagnostic("invalid-run", "Run cannot contain both legacy monitor and multi-Task monitors.", path)] };
	if (!exactKeys(value, ["id", "status", "declaredOutcome", "createdAt", "updatedAt", "controllerSessionId", "integrationBase", "tasks", "modelPlan", "effectiveSettings", "finalVerification", ...(hasFinalVerificationExecution ? ["finalVerificationExecution"] : []), ...(hasCompletion ? ["completion"] : []), ...(hasMonitor ? ["monitor"] : []), ...(hasMonitors ? ["monitors"] : [])])) return { diagnostics: [diagnostic("invalid-run", "Run contains unknown or missing keys.", path)] };
	const diagnostics: RunDiagnostic[] = [];
	if (!safeIdentifier(value.id) || !String(value.id).startsWith("run-")) diagnostics.push(diagnostic("invalid-run", "Run id must be a filesystem-safe run identifier.", `${path}.id`));
	if (value.status !== "active" && value.status !== "completing" && value.status !== "completed") diagnostics.push(diagnostic("invalid-run", "Run status must be active, completing, or completed.", `${path}.status`));
	if (value.status === "completed" && options.atActivePath) diagnostics.push(diagnostic("invalid-run", "Completed Run snapshots are not legal in active-run.json.", `${path}.status`));
	if (!trimmedString(value.declaredOutcome)) diagnostics.push(diagnostic("invalid-run", "declaredOutcome must be non-empty.", `${path}.declaredOutcome`));
	if (!canonicalTimestamp(value.createdAt) || !canonicalTimestamp(value.updatedAt) || value.createdAt > value.updatedAt) diagnostics.push(diagnostic("invalid-run", "Run timestamps must be canonical UTC ISO values in order.", `${path}.createdAt`));
	if (!trimmedString(value.controllerSessionId)) diagnostics.push(diagnostic("invalid-run", "controllerSessionId must be non-empty.", `${path}.controllerSessionId`));
	const base = validateIntegrationBase(value.integrationBase, `${path}.integrationBase`);
	diagnostics.push(...base.diagnostics);
	const rawTasks = Array.isArray(value.tasks) ? value.tasks : undefined;
	if (!rawTasks || rawTasks.length === 0) diagnostics.push(diagnostic("invalid-run", "Run requires at least one ordered Task.", `${path}.tasks`));
	const plans = validateProjectModelPlans(value.modelPlan, `${path}.modelPlan`);
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
		const hasIntegration = Object.prototype.hasOwnProperty.call(task, "integration");
		const hasAttentionDiagnostic = Object.prototype.hasOwnProperty.call(task, "attentionDiagnostic");
		const hasAttentionReason = Object.prototype.hasOwnProperty.call(task, "attentionReason");
		if (!exactKeys(task, ["specificationVersion", "specificationHash", "contract", "phase", "attention", ...(hasAttentionDiagnostic ? ["attentionDiagnostic"] : []), ...(hasAttentionReason ? ["attentionReason"] : []), "attempts", "reworkCycles", ...(hasApproval ? ["approval"] : []), ...(hasIntegration ? ["integration"] : [])])) {
			diagnostics.push(diagnostic("invalid-task", "Task contains unknown or missing initialization keys.", taskPath));
			continue;
		}
		const contractResult = validateContract(task.contract, `${taskPath}.contract`, true);
		const taskDiagnostics = [...contractResult.diagnostics];
		const approval = hasApproval ? validateTaskApproval(task.approval, `${taskPath}.approval`) : { diagnostics: [] };
		taskDiagnostics.push(...approval.diagnostics);
		const integration = hasIntegration ? validateTaskIntegration(task.integration, `${taskPath}.integration`) : { diagnostics: [] };
		taskDiagnostics.push(...integration.diagnostics);
		if (task.specificationVersion !== 1) taskDiagnostics.push(diagnostic("invalid-task", "Task specificationVersion must be 1.", `${taskPath}.specificationVersion`));
		if (typeof task.specificationHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(task.specificationHash) || (contractResult.value && specificationHash(contractResult.value) !== task.specificationHash)) taskDiagnostics.push(diagnostic("invalid-task", "Task specificationHash does not match its exact contract.", `${taskPath}.specificationHash`));
		const settingsLimit = isRecord(value.effectiveSettings) && Number.isSafeInteger(value.effectiveSettings.reworkCycleLimit) ? value.effectiveSettings.reworkCycleLimit as number : 5;
		if (!["pending", "building", "reviewing", "reworking", "approved", "integrating", "completed"].includes(task.phase as string) || !["none", "blocked", "waiting-external", "suspected-stall", "recovering", "needs-user"].includes(task.attention as string) || !Array.isArray(task.attempts) || !Number.isSafeInteger(task.reworkCycles) || (task.reworkCycles as number) < 0 || (task.reworkCycles as number) > 5 || (task.reworkCycles as number) > settingsLimit) taskDiagnostics.push(diagnostic("invalid-task", "Task has an invalid phase, attention, Attempt sequence, or bounded rework counter.", taskPath));
		if (hasAttentionDiagnostic && (!boundedText(task.attentionDiagnostic, 2_000) || task.attention === "none")) taskDiagnostics.push(diagnostic("invalid-task", "Task attentionDiagnostic must be bounded and accompany durable attention.", `${taskPath}.attentionDiagnostic`));
		if (hasAttentionReason && (!["rework-preflight", "protected-evidence", "rework-exhausted", "review-approval-required", "integration-preflight", "integration-failed", "integration-ambiguous", "final-verification-unexecutable", "final-verification-failed", "final-verification-ambiguous", "verification-dirtied-checkout", "agent-stop-failed", "archive-failed", "reconciliation-blocked-question", "reconciliation-report-missing", "reconciliation-live-unclear", "reconciliation-agent-missing", "silence-passive-inspection", "external-process-live", "external-process-grace", "silence-effect-ambiguous", "silence-recovery-exhausted", "transient-infrastructure-recovery", "transient-stop-ambiguous", "transient-fallback-unavailable", "transient-retries-exhausted"].includes(task.attentionReason as string) || task.attention === "none")) taskDiagnostics.push(diagnostic("invalid-task", "Task attentionReason must be a recognized durable attention reason.", `${taskPath}.attentionReason`));
		const attempts: AttemptRecord[] = [];
		if (Array.isArray(task.attempts)) {
			if (task.attempts.length > 20) taskDiagnostics.push(diagnostic("invalid-task", "A Task allows at most the initial pair plus five rework/review cycles and bounded silent replacements.", `${taskPath}.attempts`));
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
		validateAttemptSequence(attempts, task as Record<string, unknown>, contractResult.value, plans.value, taskPath, taskDiagnostics);
		const transientLimit = isRecord(value.effectiveSettings) && Number.isSafeInteger(value.effectiveSettings.transientRetryLimit) ? value.effectiveSettings.transientRetryLimit as number : 2;
		if (attempts.some((attempt) => attempt.replacement !== undefined && attempt.replacement.retryOrdinal > transientLimit)) taskDiagnostics.push(diagnostic("invalid-task", "Silent replacement ordinals cannot exceed the frozen transient retry limit.", `${taskPath}.attempts`));
		const currentSilence = attempts.at(-1)?.recovery?.silence;
		const expectedExhaustedOrdinal = transientLimit >= 2 ? 2 : transientLimit === 1 ? 1 : 0;
		if (currentSilence?.phase === "exhausted" && currentSilence.retryOrdinal !== expectedExhaustedOrdinal) taskDiagnostics.push(diagnostic("invalid-task", "Exhausted silence state must record the bounded ordinal implied by the frozen transient retry limit.", `${taskPath}.attempts`));
		const latest = attempts[attempts.length - 1];
		const latestReviewer = latest?.role === "reviewer" ? latest : undefined;
		const latestBuilder = latest?.role === "builder" ? latest : undefined;
		if (task.phase === "pending" && attempts.length !== 0) taskDiagnostics.push(diagnostic("invalid-task", "Pending Tasks must not have Attempts.", taskPath));
		if (task.phase === "building" && (!latestBuilder || (latestBuilder.state === "superseded" || (latestBuilder.state === "ended-error" && task.attention !== "needs-user" && task.attention !== "recovering")))) taskDiagnostics.push(diagnostic("invalid-task", "Building Tasks require one current Builder Attempt.", taskPath));
		if (task.phase === "reworking" && (attempts.length < 3 || !latestBuilder || (latestBuilder.replacement === undefined && latestBuilder.state !== "ended-error" && !isReworkDispatch(latestBuilder.dispatch)))) taskDiagnostics.push(diagnostic("invalid-task", "Reworking Tasks require a latest reserved rework or transient ended-error Builder Attempt.", taskPath));
		if (task.phase === "reviewing" && !latestReviewer && !(attempts.length === 1 && attempts[0]?.role === "builder" && task.attention === "needs-user")) taskDiagnostics.push(diagnostic("invalid-task", "Reviewing Tasks require a latest Reviewer Attempt unless Review is durably paused before dispatch.", taskPath));
		if (task.phase === "reviewing" && latestReviewer && latestReviewer.state === "reported" && task.attention === "needs-user" && latestReviewer.integrity?.kind !== "violated" && latestReviewer.evidence?.phase !== "finalized") taskDiagnostics.push(diagnostic("invalid-task", "A reported Reviewer with needs-user attention requires finalized evidence or a recorded integrity violation.", taskPath));
		if (task.phase === "reviewing" && latestReviewer && task.attention === "needs-user" && latestReviewer.evidence?.phase === "finalized" && latestReviewer.evidence.verdict === "changes-required") {
			if (!boundedText(task.attentionDiagnostic, 2_000)) taskDiagnostics.push(diagnostic("invalid-task", "A paused changes-required Review requires a bounded durable diagnostic.", `${taskPath}.attentionDiagnostic`));
			else if (task.reworkCycles !== settingsLimit && task.attentionReason !== "rework-preflight" && task.attentionReason !== "protected-evidence") taskDiagnostics.push(diagnostic("invalid-task", "A below-limit changes-required pause must record a rework preflight or protected evidence reason.", `${taskPath}.attentionReason`));
			else if (task.reworkCycles === settingsLimit && task.attentionReason !== "rework-exhausted" && task.attentionReason !== "protected-evidence" && task.attentionReason !== "rework-preflight") taskDiagnostics.push(diagnostic("invalid-task", "A changes-required pause at the frozen limit must retain an exhaustion or safety reason.", `${taskPath}.attentionReason`));
		}
		if (task.phase === "approved" && (!approval.value || approval.value.phase !== "valid" || (task.attention !== "none" && !["integration-preflight", "final-verification-unexecutable"].includes(task.attentionReason as string)) || !latestReviewer || latestReviewer.state !== "reported" || latestReviewer.evidence?.phase !== "finalized" || latestReviewer.evidence.verdict !== "approved")) taskDiagnostics.push(diagnostic("invalid-task", "Approved Tasks require a valid Approval bound to a finalized approved Reviewer.", taskPath));
		if ((task.phase === "integrating" || task.phase === "completed") && (!approval.value || approval.value.phase !== "valid" || !integration.value)) taskDiagnostics.push(diagnostic("invalid-task", "Integrating and completed Tasks require a current Approval and integration record.", taskPath));
		if (task.phase === "completed" && (task.attention !== "none" || integration.value?.phase !== "integrated")) taskDiagnostics.push(diagnostic("invalid-task", "Completed Tasks require an integrated identity and no attention.", taskPath));
		if (integration.value?.phase === "intended" && (task.phase !== "integrating" || task.attention !== "none")) taskDiagnostics.push(diagnostic("invalid-task", "An intended integration requires an integrating Task with no attention.", `${taskPath}.integration`));
		if (integration.value?.phase === "integrated" && task.phase !== "integrating" && task.phase !== "completed") taskDiagnostics.push(diagnostic("invalid-task", "An integrated record requires an integrating or completed Task.", `${taskPath}.integration`));
		if ((integration.value?.phase === "failed" || integration.value?.phase === "ambiguous") && (task.phase !== "integrating" || task.attention !== "needs-user" || (integration.value.phase === "failed" ? task.attentionReason !== "integration-failed" : task.attentionReason !== "integration-ambiguous"))) taskDiagnostics.push(diagnostic("invalid-task", "Failed or ambiguous integration requires structured needs-user attention.", `${taskPath}.integration`));
		if (!hasIntegration && ["integrating", "completed"].includes(task.phase as string)) taskDiagnostics.push(diagnostic("invalid-task", "Integrating and completed Tasks cannot omit integration facts.", taskPath));
		const latestRecovery = latest?.recovery;
		if (task.attention === "blocked" && (!latestReviewer || latestReviewer.reportRepair?.phase !== "blocked") && !(latestRecovery && (latestRecovery.live.kind === "blocked" || latestRecovery.reportRequest?.phase === "blocked" || latestRecovery.reportRequest?.phase === "ambiguous" || latestRecovery.blockedAnswer?.phase === "ambiguous"))) taskDiagnostics.push(diagnostic("invalid-task", "Blocked attention requires a Reviewer repair block or a ticket-10 recovery block.", taskPath));
		if (task.attention === "recovering" && (!latestRecovery || ((latestRecovery.live.kind !== "unclear" && latestRecovery.live.kind !== "missing") && !latestRecovery.silence && !latestRecovery.infrastructure) || !["reconciliation-live-unclear", "reconciliation-agent-missing", "silence-effect-ambiguous", "transient-infrastructure-recovery"].includes(task.attentionReason as string))) taskDiagnostics.push(diagnostic("invalid-task", "Recovering attention requires an unclear, missing, ambiguous, or typed infrastructure recovery observation.", taskPath));
			if (task.attention === "waiting-external" && (!latestRecovery?.silence || !["waiting-external", "external-grace"].includes(latestRecovery.silence.phase))) taskDiagnostics.push(diagnostic("invalid-task", "Waiting-external attention requires a durable external process or grace observation.", taskPath));
			if (task.attention === "suspected-stall" && (!latestRecovery?.silence || !["suspected", "inspection-incomplete", "nudge-intended", "nudged", "interrupt-intended", "interrupted", "resume-intended", "resumed"].includes(latestRecovery.silence.phase))) taskDiagnostics.push(diagnostic("invalid-task", "Suspected-stall attention requires a durable passive inspection or an in-flight same-Agent recovery rung.", taskPath));
			if (task.attention === "needs-user" && task.attentionReason === "silence-recovery-exhausted" && (!latestRecovery?.silence || latestRecovery.silence.phase !== "exhausted")) taskDiagnostics.push(diagnostic("invalid-task", "Exhausted silence recovery requires a durable exhausted phase.", taskPath));
			if (task.attention === "needs-user" && ["transient-stop-ambiguous", "transient-fallback-unavailable", "transient-retries-exhausted"].includes(task.attentionReason as string) && !latestRecovery?.infrastructure) taskDiagnostics.push(diagnostic("invalid-task", "Transient needs-user attention requires a durable typed infrastructure outcome.", taskPath));
			if (["waiting-external", "suspected-stall"].includes(task.attention as string) && !["building", "reviewing", "reworking"].includes(task.phase as string)) taskDiagnostics.push(diagnostic("invalid-task", "Silence attention is only legal while an active work Attempt is building, reviewing, or reworking.", taskPath));
		if (latest?.state === "superseded") taskDiagnostics.push(diagnostic("invalid-task", "A superseded Attempt must be followed immediately by its linked replacement.", taskPath));
		if (approval.value?.phase === "valid" && !["approved", "integrating", "completed"].includes(task.phase as string)) taskDiagnostics.push(diagnostic("invalid-task", "A valid Approval requires approved, integrating, or completed Task phase.", `${taskPath}.approval`));
		if (approval.value?.phase === "invalidated" && ["approved", "integrating", "completed"].includes(task.phase as string)) taskDiagnostics.push(diagnostic("invalid-task", "An invalidated Approval cannot coexist with an approved, integrating, or completed Task phase.", `${taskPath}.approval`));
		if (approval.value) {
			const approvedBuilder = attempts.find((attempt): attempt is BuilderAttemptRecord => attempt.id === approval.value!.builderAttemptId && attempt.role === "builder");
			const approvedReviewer = attempts.find((attempt): attempt is ReviewerAttemptRecord => attempt.id === approval.value!.reviewerAttemptId && attempt.role === "reviewer");
			if (!approvedBuilder || !approvedReviewer || attempts[attempts.length - 2]?.id !== approval.value.builderAttemptId || attempts[attempts.length - 1]?.id !== approval.value.reviewerAttemptId || approvedBuilder.evidence?.phase !== "finalized" || approvedBuilder.evidence.status !== "completed" || approvedReviewer.evidence?.phase !== "finalized" || approvedReviewer.evidence.verdict !== "approved" || approvedReviewer.evidence.manifestPath !== approval.value.reviewerManifestPath || approvedReviewer.evidence.manifestSha256 !== approval.value.reviewerManifestSha256 || approvedReviewer.integrity?.kind !== "preserved" || !reviewSubjectBindsBuilder(approval.value.subject, approvedBuilder) || !reviewSubjectsEqual(approval.value.subject, approvedReviewer.subject) || !snapshotsEqual(approval.value.worktreeSnapshot, approvedReviewer.integrity.after) || approval.value.worktreeSnapshot.dirtyPaths.length !== 0 || approval.value.worktreeSnapshot.operationMarkers.length !== 0 || (approval.value.subject.kind === "git" && approval.value.worktreeSnapshot.head !== approval.value.subject.headRevision)) taskDiagnostics.push(diagnostic("invalid-task", "Approval must bind the exact final completed Builder and Reviewer Attempts, subject, protected evidence, and clean snapshot.", `${taskPath}.approval`));
		}
		if (integration.value && approval.value?.phase === "valid" && base.value?.kind === "git") {
			const subject = approval.value.subject;
			const builder = attempts.find((attempt): attempt is BuilderAttemptRecord => attempt.id === approval.value!.builderAttemptId && attempt.role === "builder");
			const reviewer = attempts.find((attempt): attempt is ReviewerAttemptRecord => attempt.id === approval.value!.reviewerAttemptId && attempt.role === "reviewer");
			const expectedCommits = subject.kind === "git" ? subject.commits : [];
			const expectedHead = subject.kind === "git" ? subject.headRevision : "";
			const expectedBase = subject.kind === "git" ? subject.baseRevision : "";
			const actionMatches = integration.value.action.argv[0] === "merge" && integration.value.action.argv[2] === "--no-edit" && integration.value.action.argv[3] === expectedHead && ((integration.value.action.kind === "fast-forward" && integration.value.action.argv[1] === "--ff-only") || (integration.value.action.kind === "merge-commit" && integration.value.action.argv[1] === "--no-ff"));
			const legacySingle = (rawTasks?.length ?? 0) === 1;
			const identityMatches = subject.kind === "git" && expectedCommits.at(-1) === expectedHead && (!legacySingle || expectedBase === base.value.revision) && integration.value.targetBranch === base.value.branch && (!legacySingle || integration.value.targetRevision === base.value.revision) && integration.value.approvedBaseRevision === expectedBase && integration.value.approvedHeadRevision === expectedHead && JSON.stringify(integration.value.approvedCommits) === JSON.stringify(expectedCommits) && integration.value.builderAttemptId === approval.value.builderAttemptId && integration.value.reviewerAttemptId === approval.value.reviewerAttemptId && integration.value.builderManifestSha256 === subject.builderManifestSha256 && integration.value.reviewerManifestSha256 === approval.value.reviewerManifestSha256 && actionMatches && (!legacySingle || integration.value.action.kind === "fast-forward");
			if (!builder || !reviewer || reviewer.evidence?.phase !== "finalized" || builder.evidence?.phase !== "finalized" || builder.evidence.manifestSha256 !== integration.value.builderManifestSha256 || reviewer.evidence.manifestSha256 !== integration.value.reviewerManifestSha256 || !identityMatches) taskDiagnostics.push(diagnostic("invalid-task", "Integration identity must remain exactly bound to the current Approval and protected final evidence.", `${taskPath}.integration`));
		}
		if (contractResult.value && taskIds.has(contractResult.value.id)) taskDiagnostics.push(diagnostic("invalid-task", "Task IDs must be unique.", `${taskPath}.contract.id`));
		if (contractResult.value) taskIds.add(contractResult.value.id);
		if (taskDiagnostics.length > 0 || !contractResult.value || typeof task.specificationHash !== "string") diagnostics.push(...taskDiagnostics);
		else tasks.push({ specificationVersion: 1, specificationHash: task.specificationHash, contract: contractResult.value, phase: task.phase as TaskPhase, attention: task.attention as TaskAttention, ...(hasAttentionDiagnostic ? { attentionDiagnostic: task.attentionDiagnostic as string } : {}), ...(hasAttentionReason ? { attentionReason: task.attentionReason as TaskAttentionReason } : {}), attempts, reworkCycles: task.reworkCycles as number, ...(approval.value ? { approval: approval.value } : {}), ...(integration.value ? { integration: integration.value } : {}) });
	}
	if (!plans.value || plans.diagnostics.length > 0) diagnostics.push(...plans.diagnostics.map((item: ConfigDiagnostic) => diagnostic("invalid-config", item.message, item.path)));
	const settings = validateRecoveryDefaults(value.effectiveSettings, `${path}.effectiveSettings`);
	if (!settings.value || settings.diagnostics.length > 0) diagnostics.push(...settings.diagnostics.map((item) => diagnostic("invalid-config", item.message, item.path)));
	const codeChanging = tasks.some((task) => task.contract.expectedArtifacts.some((artifact) => artifact.kind === "git-commit"));
	if (base.value && (codeChanging !== (base.value.kind === "git"))) diagnostics.push(diagnostic("invalid-run", "integrationBase must be git exactly for code-changing Runs and none otherwise.", `${path}.integrationBase`));
	if (base.value?.kind === "git") {
		const owned = new Map<string, string>();
		const claim = (identity: string, taskId: string, field: string): void => {
			if (!identity) return;
			const prior = owned.get(`${field}/${identity}`);
			if (prior && prior !== taskId) diagnostics.push(diagnostic("invalid-run", `Resource ${field} is shared by Tasks ${prior} and ${taskId}.`, `${path}.tasks`));
			else owned.set(`${field}/${identity}`, taskId);
		};
		const integratedHeads = tasks.flatMap((task, index) => task.integration?.phase === "integrated" ? [{ index, head: task.integration.observedHead, integratedAt: task.integration.integratedAt }] : []);
		let expectedTarget = base.value.revision;
		let queueOpen = false;
		for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
			const task = tasks[taskIndex]!;
			for (const attempt of task.attempts) {
				claim(attempt.assignmentPath, task.contract.id, "assignment");
				claim(attempt.reportPath, task.contract.id, "report");
				claim(attempt.evidenceDirectory, task.contract.id, "evidence");
				const dispatch = attempt.dispatch;
				if ("branch" in dispatch) claim(dispatch.branch, task.contract.id, "branch");
				if ("worktreePath" in dispatch) claim(dispatch.worktreePath, task.contract.id, "worktree");
				if ("agentName" in dispatch) claim(dispatch.agentName, task.contract.id, "agent");
				if ("workspaceId" in dispatch && typeof dispatch.workspaceId === "string") claim(dispatch.workspaceId, task.contract.id, "workspace");
				if ("paneId" in dispatch && typeof dispatch.paneId === "string") claim(dispatch.paneId, task.contract.id, "pane");
				if ("terminalId" in dispatch && typeof dispatch.terminalId === "string") claim(dispatch.terminalId, task.contract.id, "terminal");
				if (attempt.role === "builder" && attempt.baseRevision !== base.value.revision && !integratedHeads.some((entry) => entry.index < taskIndex && entry.integratedAt <= attempt.preparedAt && entry.head === attempt.baseRevision)) diagnostics.push(diagnostic("invalid-task", "Builder Attempt baseRevision must be the Run base or an ordered head integrated before that Attempt was prepared.", `${path}.tasks.${task.contract.id}.attempts`));
			}
			const isCode = task.contract.expectedArtifacts.some((artifact) => artifact.kind === "git-commit");
			if (!isCode) continue;
			const integration = task.integration;
			const historicalHeads = new Set([base.value.revision, ...tasks.slice(0, taskIndex).flatMap((candidate) => candidate.integration?.phase === "integrated" ? [candidate.integration.observedHead] : [])]);
			if (integration && !historicalHeads.has(integration.approvedBaseRevision)) diagnostics.push(diagnostic("invalid-task", "Integration source base must be the Run base or a previously integrated ordered head.", `${path}.tasks.${task.contract.id}.integration`));
			if (integration?.phase === "integrated") {
				if (queueOpen || integration.targetRevision !== expectedTarget || integration.targetBranch !== base.value.branch || integration.approvedBaseRevision !== (task.approval?.phase === "valid" && task.approval.subject.kind === "git" ? task.approval.subject.baseRevision : "") || integration.action.kind !== (integration.targetRevision === integration.approvedBaseRevision ? "fast-forward" : "merge-commit")) diagnostics.push(diagnostic("invalid-task", "Integrated code Tasks must form one ordered prefix with the exact local action.", `${path}.tasks.${task.contract.id}.integration`));
				expectedTarget = integration.observedHead;
				queueOpen = false;
			} else if (integration) {
				if (queueOpen || integration.targetRevision !== expectedTarget || integration.targetBranch !== base.value.branch) diagnostics.push(diagnostic("invalid-task", "Only the first non-integrated code Task may retain an integration intent or classified result.", `${path}.tasks.${task.contract.id}.integration`));
				queueOpen = true;
			} else {
				queueOpen = true;
			}
		}
	}
	const finalVerification = validateVerification(value.finalVerification, `${path}.finalVerification`, codeChanging);
	diagnostics.push(...finalVerification.diagnostics);
	const finalVerificationExecution = hasFinalVerificationExecution && finalVerification.value ? validateFinalVerificationExecution(value.finalVerificationExecution, `${path}.finalVerificationExecution`, finalVerification.value) : { diagnostics: [] };
	diagnostics.push(...finalVerificationExecution.diagnostics);
	const completion = hasCompletion ? validateCompletion(value.completion, `${path}.completion`) : { diagnostics: [] };
	diagnostics.push(...completion.diagnostics);
	const monitor = hasMonitor ? validateMonitorCheckpoint(value.monitor, `${path}.monitor`, { createdAt: value.createdAt as string, updatedAt: value.updatedAt as string, tasks }) : { diagnostics: [] };
	diagnostics.push(...monitor.diagnostics);
	const monitors = hasMonitors ? validateMonitorCheckpoints(value.monitors, `${path}.monitors`, { createdAt: value.createdAt as string, updatedAt: value.updatedAt as string, tasks }) : { diagnostics: [] };
	diagnostics.push(...monitors.diagnostics);
	if (hasMonitors && tasks.length < 2) diagnostics.push(diagnostic("invalid-run", "The multi-Task monitors representation requires more than one Task.", `${path}.monitors`));
	if (completion.value) {
		const prompted = new Set<string>();
		const promptedInOrder: string[] = [];
			for (const task of tasks) for (const attempt of task.attempts) if (attempt.dispatch.phase === "prompted" || attempt.dispatch.phase === "reconciled-active") {
			const identity = `${attempt.role}/${attempt.dispatch.agentName}/${attempt.dispatch.workspaceId}/${attempt.dispatch.paneId}/${attempt.dispatch.terminalId}`;
			if (!prompted.has(identity)) promptedInOrder.push(identity);
			prompted.add(identity);
		}
		const resources = "resources" in completion.value ? completion.value.resources : [];
		const identities = resources.map((resource) => `${resource.role}/${resource.agentName}/${resource.workspaceId}/${resource.paneId}/${resource.terminalId}`);
		if (new Set(identities).size !== identities.length || identities.some((identity) => !prompted.has(identity))) diagnostics.push(diagnostic("invalid-run", "Completion resources must be distinct actual prompted Steward-created agents.", `${path}.completion`));
		if (completion.value.phase !== "gate-passed" && (JSON.stringify(identities) !== JSON.stringify(promptedInOrder))) diagnostics.push(diagnostic("invalid-run", "Completion resources must retain every distinct prompted agent in Attempt order.", `${path}.completion.resources`));
		for (const resource of resources) if (resource.state === "acknowledged" && (resource.acknowledgement.name !== resource.agentName || resource.acknowledgement.workspaceId !== resource.workspaceId || resource.acknowledgement.paneId !== resource.paneId || resource.acknowledgement.terminalId !== resource.terminalId)) diagnostics.push(diagnostic("invalid-run", "Completion acknowledgement must identify the exact recorded agent resource.", `${path}.completion`));
		if (completion.value.phase === "stops-incomplete") {
			const failureIdentity = `${completion.value.failure.resource.role}/${completion.value.failure.resource.agentName}/${completion.value.failure.resource.workspaceId}/${completion.value.failure.resource.paneId}/${completion.value.failure.resource.terminalId}`;
			const failureIndex = identities.indexOf(failureIdentity);
			if (failureIndex < 0 || resources[failureIndex]?.state !== "intended" || resources.slice(0, failureIndex).some((resource) => resource.state !== "acknowledged") || resources.slice(failureIndex + 1).some((resource) => resource.state !== "intended")) diagnostics.push(diagnostic("invalid-run", "Completion stop failure must identify the first unacknowledged resource and retain the bounded stop order.", `${path}.completion.failure`));
		}
		if (completion.value.phase === "archive-intended" || completion.value.phase === "archived") {
			const expectedReports = tasks.flatMap((task) => task.attempts.filter((attempt) => attempt.evidence?.phase === "finalized").map((attempt) => `${task.contract.id}/${attempt.id}/${attempt.role}`));
			const archivedReports = completion.value.archive.reports.map((report) => `${report.taskId}/${report.attemptId}/${report.role}`);
			if (JSON.stringify(expectedReports) !== JSON.stringify(archivedReports) || completion.value.archive.reports.some((report) => report.destinationPath !== `reports/${report.taskId}/${report.attemptId}-${report.role}.md`)) diagnostics.push(diagnostic("invalid-run", "Completion archive inventory must retain exactly every protected finalized Attempt Report in Attempt order.", `${path}.completion.archive.reports`));
		}
	}
	if (value.status === "active" && completion.value) diagnostics.push(diagnostic("invalid-run", "Active Run Journals cannot contain completion records.", `${path}.completion`));
	if (value.status === "completing" && (!completion.value || completion.value.phase === "archived")) diagnostics.push(diagnostic("invalid-run", "Completing Runs require a non-archived completion record.", `${path}.completion`));
	if (value.status === "completed" && (!completion.value || completion.value.phase !== "archived" || tasks.some((task) => task.phase !== "completed" || task.attention !== "none"))) diagnostics.push(diagnostic("invalid-run", "Completed Run snapshots require archived completion and completed attention-free Tasks.", path));
	const orderedCodeTasks = tasks.filter((task) => task.contract.expectedArtifacts.some((artifact) => artifact.kind === "git-commit"));
	const allCodeIntegrated = orderedCodeTasks.every((task) => task.integration?.phase === "integrated");
	const allTasksReadyForFinalVerification = tasks.every((task) => task.contract.expectedArtifacts.some((artifact) => artifact.kind === "git-commit") ? task.integration?.phase === "integrated" : task.phase === "completed");
	const lastIntegratedTask = orderedCodeTasks.at(-1);
	const finalIntegratedHead = lastIntegratedTask?.integration?.phase === "integrated" ? lastIntegratedTask.integration.observedHead : (base.value?.kind === "git" ? base.value.revision : null);
	if (finalVerificationExecution.value && tasks.length > 1 && (!allTasksReadyForFinalVerification || !allCodeIntegrated || tasks.some((task) => task.attention !== "none" || ["building", "reviewing", "reworking"].includes(task.phase)))) diagnostics.push(diagnostic("invalid-run", "Multi-Task final verification requires the complete ordered integration prefix and no active or attention Task.", `${path}.finalVerificationExecution`));
	if (finalVerificationExecution.value && tasks.length === 1 && tasks[0] && (!tasks[0].integration || tasks[0].integration.phase !== "integrated")) diagnostics.push(diagnostic("invalid-run", "Final verification execution requires a completed exact integration.", `${path}.finalVerificationExecution`));
	if (finalVerificationExecution.value && tasks[0] && (!finalVerificationExecution.value.logPath.includes(`/runs/${value.id}/completion/final-verification/verification-01/`) || !finalVerificationExecution.value.resultPath.includes(`/runs/${value.id}/completion/final-verification/verification-01/`))) diagnostics.push(diagnostic("invalid-run", "Final verification paths must be deterministic inside this Run's completion directory.", `${path}.finalVerificationExecution`));
	if (finalVerificationExecution.value?.phase === "intended" && tasks.length === 1 && tasks[0] && (tasks[0].phase !== "integrating" || tasks[0].attention !== "none")) diagnostics.push(diagnostic("invalid-run", "Final verification intent requires an attention-free integrating Task.", `${path}.finalVerificationExecution`));
	if (finalVerificationExecution.value?.phase === "passed" && tasks[0] && (finalVerificationExecution.value.checkout.dirtyPaths.length > 0 || finalVerificationExecution.value.checkout.operationMarkers.length > 0 || !finalVerificationExecution.value.checkout.rangeExact || base.value?.kind !== "git" || !allCodeIntegrated || finalVerificationExecution.value.checkout.branch !== base.value.branch || finalVerificationExecution.value.checkout.head !== finalIntegratedHead)) diagnostics.push(diagnostic("invalid-run", "Passed final verification requires the exact clean integrated checkout.", `${path}.finalVerificationExecution`));
	if (completion.value && tasks[0]) {
		const gate = completion.value.gate;
		if ("tasks" in gate) {
			let gateHead = base.value?.kind === "git" ? base.value.revision : "";
			const gateEntriesMatch = tasks.length >= 2 && gate.tasks.length === tasks.length && tasks.every((task, index) => {
				const entry = gate.tasks[index];
				const builder = [...task.attempts].reverse().find((attempt): attempt is BuilderAttemptRecord => attempt.role === "builder");
				const reviewer = [...task.attempts].reverse().find((attempt): attempt is ReviewerAttemptRecord => attempt.role === "reviewer");
				if (!entry || entry.taskId !== task.contract.id || entry.builderAttemptId !== builder?.id || (entry.reviewerAttemptId ?? undefined) !== (reviewer?.id ?? undefined) || entry.kind !== (task.contract.expectedArtifacts.some((artifact) => artifact.kind === "git-commit") ? "code" : "non-code")) return false;
				if (entry.kind === "non-code") return task.phase === "completed" && !entry.source && !entry.integration;
				const subject = task.approval?.phase === "valid" && task.approval.subject.kind === "git" ? task.approval.subject : undefined;
				const builderEvidence = builder?.evidence?.phase === "finalized" ? builder.evidence : undefined;
				const reviewerEvidence = reviewer?.evidence?.phase === "finalized" ? reviewer.evidence : undefined;
				const integration = task.integration?.phase === "integrated" ? task.integration : undefined;
				if (!subject || !builderEvidence || !reviewerEvidence || !integration || !entry.source || !entry.integration || entry.source.baseRevision !== subject.baseRevision || entry.source.headRevision !== subject.headRevision || JSON.stringify(entry.source.commits) !== JSON.stringify(subject.commits) || entry.source.builderManifestSha256 !== builderEvidence.manifestSha256 || entry.source.reviewerManifestSha256 !== reviewerEvidence.manifestSha256 || entry.integration.targetBranch !== integration.targetBranch || entry.integration.targetRevision !== integration.targetRevision || entry.integration.approvedBaseRevision !== integration.approvedBaseRevision || entry.integration.approvedHeadRevision !== integration.approvedHeadRevision || JSON.stringify(entry.integration.approvedCommits) !== JSON.stringify(integration.approvedCommits) || entry.integration.observedHead !== integration.observedHead || JSON.stringify(entry.integration.action) !== JSON.stringify(integration.action) || integration.targetRevision !== gateHead) return false;
				gateHead = integration.observedHead;
				return true;
			});
			if (!gateEntriesMatch || gate.integratedHead !== gateHead || tasks.some((task) => task.contract.expectedArtifacts.some((artifact) => artifact.kind === "git-commit") && task.integration?.phase !== "integrated") || finalVerificationExecution.value?.phase !== "passed" || gate.verificationLogSha256 !== finalVerificationExecution.value.logSha256 || gate.verificationResultSha256 !== finalVerificationExecution.value.resultSha256 || (finalVerificationExecution.value?.phase === "passed" && JSON.stringify(gate.checkout) !== JSON.stringify(finalVerificationExecution.value.checkout))) diagnostics.push(diagnostic("invalid-run", "Multi-Task Completion Gate facts must remain bound to every ordered integrated Task and passing verification evidence.", `${path}.completion.gate`));
		} else if (gate.taskId !== tasks[0].contract.id || tasks[0].integration?.phase !== "integrated" || gate.integratedHead !== tasks[0].integration.approvedHeadRevision || finalVerificationExecution.value?.phase !== "passed" || gate.verificationLogSha256 !== finalVerificationExecution.value.logSha256 || gate.verificationResultSha256 !== finalVerificationExecution.value.resultSha256) diagnostics.push(diagnostic("invalid-run", "Completion Gate facts must remain bound to the current integrated Task and passing verification evidence.", `${path}.completion.gate`));
	}
	if (value.status === "completed" && (!finalVerificationExecution.value || finalVerificationExecution.value.phase !== "passed")) diagnostics.push(diagnostic("invalid-run", "Completed Run snapshots require one passing final verification execution.", path));
	if (finalVerificationExecution.value?.phase === "passed" && tasks[0]?.phase === "completed" && value.status !== "completing" && value.status !== "completed") diagnostics.push(diagnostic("invalid-run", "A passed final verification cannot be detached from completion.", `${path}.finalVerificationExecution`));
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
			status: value.status as RunStatus,
			declaredOutcome,
			createdAt,
			updatedAt,
			controllerSessionId,
			integrationBase: base.value,
			tasks,
			modelPlan: cloneModelPlans(plans.value),
			effectiveSettings: cloneRecoveryDefaults(settings.value),
			finalVerification: finalVerification.value,
			...(finalVerificationExecution.value ? { finalVerificationExecution: finalVerificationExecution.value } : {}),
			...(completion.value ? { completion: completion.value } : {}),
			...(monitor.value ? { monitor: monitor.value } : {}),
			...(monitors.value ? { monitors: monitors.value } : {}),
		},
		diagnostics: [],
	};
}

export function validateRunJournal(value: unknown, path?: string): { value?: RunJournal; diagnostics: RunDiagnostic[] } {
	const journalPath = path ?? "active-run.json";
	if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "journalRevision", "run"])) return { diagnostics: [diagnostic("invalid-run", "Run Journal contains unknown or missing keys.", journalPath)] };
	if (value.schemaVersion !== RUN_JOURNAL_SCHEMA_VERSION) return { diagnostics: [diagnostic("invalid-run", "Unsupported Run Journal schemaVersion; expected 1.", journalPath)] };
	if (typeof value.journalRevision !== "number" || !Number.isSafeInteger(value.journalRevision) || value.journalRevision < 1) return { diagnostics: [diagnostic("invalid-run", "journalRevision must be a positive safe integer.", `${journalPath}.journalRevision`)] };
	const atActivePath = journalPath === "active-run.json" || journalPath.endsWith("/active-run.json");
	const result = validateRunRecord(value.run, `${journalPath}.run`, { atActivePath });
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
	const hasContinuation = Object.prototype.hasOwnProperty.call(assignment, "continuation");
	const keys = ["runId", "taskId", "attemptId", "role", "requiredOutcome", "allowedScope", "expectedArtifacts", "reportPath", "evidenceDirectory", "verification", "actualModel", "specificationHash", "baseRevision", "worktree", "herdr", ...(hasRework ? ["rework"] : []), ...(hasContinuation ? ["continuation"] : [])];
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
	let continuation: AttemptContinuation | undefined;
	if (hasContinuation) {
		const raw = assignment.continuation;
		if (!isRecord(raw) || !exactKeys(raw, ["predecessorAttemptId", "retryOrdinal", "preservedWorktree", "priorAssignmentPath", "priorReportPath", "priorEvidenceDirectory"]) || !safeIdentifier(raw.predecessorAttemptId) || (raw.retryOrdinal !== 1 && raw.retryOrdinal !== 2) || !absolutePathValue(raw.priorAssignmentPath) || !absolutePathValue(raw.priorReportPath) || !absolutePathValue(raw.priorEvidenceDirectory)) diagnostics.push(diagnostic("invalid-task", "Assignment continuation has invalid exact identity or paths.", `${path}.assignment.continuation`));
		else {
			const preserved = raw.preservedWorktree;
			if (!isRecord(preserved) || !exactKeys(preserved, ["path", "branch", "head"]) || !absolutePathValue(preserved.path) || !safeBranch(preserved.branch) || (preserved.head !== null && (typeof preserved.head !== "string" || !/^[0-9a-f]{40}$/.test(preserved.head)))) diagnostics.push(diagnostic("invalid-task", "Assignment continuation preserved worktree is invalid.", `${path}.assignment.continuation.preservedWorktree`));
			else continuation = { predecessorAttemptId: raw.predecessorAttemptId, retryOrdinal: raw.retryOrdinal as 1 | 2, preservedWorktree: { path: preserved.path, branch: preserved.branch, head: preserved.head as string | null }, priorAssignmentPath: raw.priorAssignmentPath, priorReportPath: raw.priorReportPath, priorEvidenceDirectory: raw.priorEvidenceDirectory };
		}
	}
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
	if (diagnostics.length > 0 || !artifacts.value || !verification.value || !model.value || typeof assignment.runId !== "string" || typeof assignment.taskId !== "string" || typeof assignment.attemptId !== "string" || typeof assignment.requiredOutcome !== "string" || !Array.isArray(assignment.allowedScope) || typeof assignment.reportPath !== "string" || typeof assignment.evidenceDirectory !== "string" || typeof assignment.specificationHash !== "string" || typeof assignment.baseRevision !== "string" || !isRecord(worktree) || typeof worktree.path !== "string" || typeof worktree.branch !== "string" || !isRecord(herdr) || typeof herdr.workspaceId !== "string" || typeof herdr.paneId !== "string" || typeof herdr.terminalId !== "string" || typeof herdr.agentName !== "string" || (hasContinuation && !continuation)) return { diagnostics };
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
				...(continuation ? { continuation } : {}),
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
	continuation?: AttemptContinuation;
}): BuilderAssignmentDocument {
	if (input.run.integrationBase.kind !== "git" || (input.task.phase !== "building" && input.task.phase !== "reworking") || input.attempt.state !== "prepared") throw new Error("Builder Assignment requires a prepared Builder Task with a Git base.");
	if (input.attempt.dispatch.phase !== "agent-intended" && input.attempt.dispatch.phase !== "prompt-intended" && input.attempt.dispatch.phase !== "prompted" && input.attempt.dispatch.phase !== "assignment-intended") throw new Error("Builder Assignment requires actual Builder resources.");
	if (input.task.specificationHash !== specificationHash(input.task.contract) || input.attempt.specificationHash !== input.task.specificationHash) throw new Error("Builder Assignment requires the exact approved Task specification hash.");
	if (input.attempt.replacement && !input.continuation) throw new Error("Replacement Builder Assignment requires its exact predecessor continuation.");
	if (!input.attempt.replacement && input.continuation) throw new Error("A non-replacement Builder Assignment cannot carry a replacement continuation.");
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
				...(input.continuation ? { continuation: { ...input.continuation, preservedWorktree: { ...input.continuation.preservedWorktree } } } : {}),
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
		formatTaskFactInstruction(),
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
			tasks: journal.run.tasks.map((task) => ({ ...task, contract: cloneContract(task.contract), attempts: task.attempts.map(cloneAttempt), ...(task.approval ? { approval: cloneApproval(task.approval) } : {}), ...(task.integration ? { integration: cloneIntegration(task.integration) } : {}) })),
			modelPlan: cloneModelPlans(journal.run.modelPlan),
			effectiveSettings: cloneRecoveryDefaults(journal.run.effectiveSettings),
			finalVerification: cloneVerification(journal.run.finalVerification),
			...(journal.run.finalVerificationExecution ? { finalVerificationExecution: cloneVerificationExecution(journal.run.finalVerificationExecution) } : {}),
			...(journal.run.completion ? { completion: cloneCompletion(journal.run.completion) } : {}),
			...(journal.run.monitor ? { monitor: cloneMonitorCheckpoint(journal.run.monitor) } : {}),
			...(journal.run.monitors ? { monitors: journal.run.monitors.map(cloneMonitorCheckpoint) } : {}),
		},
	};
}

export function advanceRunJournal(journal: RunJournal, now: Date, update: (candidate: RunJournal) => void, validationPath = "active-run.json"): RunJournal {
	const candidate = cloneRunJournal(journal);
	update(candidate);
	const requested = now.getTime();
	const previous = new Date(journal.run.updatedAt).getTime();
	const next = Math.max(requested, previous + 1);
	if (!Number.isFinite(next)) throw new Error("Run Journal timestamp cannot advance.");
	candidate.journalRevision += 1;
	candidate.run.updatedAt = new Date(next).toISOString();
	const validation = validateRunJournal(candidate, validationPath);
	if (!validation.value || validation.diagnostics.length > 0) throw new Error(`Cannot advance invalid Run Journal: ${validation.diagnostics.map((item) => item.message).join("; ")}`);
	return validation.value;
}

export function serializeRunJournal(journal: RunJournal): string {
	return serializeRunJournalAtPath(journal, "active-run.json");
}

export function serializeRunJournalAtPath(journal: RunJournal, path: string): string {
	const normalized = validateRunJournal(journal, path).value;
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
