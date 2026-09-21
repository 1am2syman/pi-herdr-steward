import { createHash } from "node:crypto";
import type { ConfigLoadResult, ConfigSaveResult } from "./config-store.ts";
import {
	formatModelPlans,
	formatRecoveryDefaults,
	parseCanonicalModelReference,
	cloneRecoveryDefaults,
	cloneModelPlans,
	validateProjectModelPlans,
	validateRecoveryDefaults,
	type ConfigDiagnostic,
	type ConfigurationScope,
	type ModelChoiceOption,
	type ProjectModelPlans,
	type RecoveryDefaults,
	type ThinkingLevel,
} from "./config.ts";
import type { ActiveRunLoadResult, ActivityAppendResult, AttemptReportInspection, CreateActiveResult, ApplyRunJournalMigrationResult, ActiveJournalMode } from "./run-journal-store.ts";
import type { TaskFactRequestResult } from "./reconciliation.ts";
import type { AssignmentCreateResult, AssignmentPaths } from "./assignment-store.ts";
import {
	buildInitialRunJournal,
	buildRunConfirmationSummary,
	buildRunRevisionConfirmationSummary,
	createRunIdentity,
	isCodeChanging,
	advanceRunJournal,
	buildBuilderAssignment,
	builderAssignmentSha256,
	formatBuilderPrompt,
	deserializeBuilderAssignment,
	serializeFinalizedEvidenceManifest,
	finalizedEvidenceManifestSha256,
	validateRunJournal,
	evaluateCompletionGate,
	COMPLETION_GATE_PREDICATES,
	validateRunDraft,
	validateRunRevisionDraft,
	specificationHash,
	cloneRunJournal,
	type IntegrationBase,
	type RunConfirmationSummary,
	type RunDraft,
	type RunDraftInput,
	type RunDraftResult,
	type RunRevisionDraft,
	type RunRevisionDraftInput,
	type RunRevisionDraftResult,
	type RunRevisionConfirmationSummary,
	type RunRevisionTaskDelta,
	type RunRevisionModelPlanDelta,
	type RevisionAttemptCancellation,
	type RecoveryStop,
	type RunRevisionRecord,
	type RunJournal,
	type AttemptRecord,
	type BuilderAttemptRecord,
	type BuilderAssignmentDocument,
	type DispatchRecord,
	type TaskRecord,
	type TaskAttentionReason,
	type BuilderEvidenceRecord,
	type ReviewerEvidenceRecord,
	type ReviewerAttemptRecord,
	type ReworkDispatchRecord,
	type IntegrationReworkDispatchRecord,
	type IntegrationReworkFacts,
	type IntegrationTargetDifference,
	type IntegrationTargetFacts,
	type IntegrationApplication,
	type IntegrationMergeability,
	type IntegrationReworkRecord,
	type ApprovedIntegrationIdentity,
	type TaskApproval,
	type ReportRepairFailure,
	type IntegrationCheckoutObservation,
	type TaskIntegration,
	type FinalVerificationExecution,
	type RecoverableFinalVerificationExecution,
	isRecoverableFinalVerificationExecution,
	type FinalVerificationAttempt,
	type FinalVerificationAttemptId,
	type FinalVerificationAttemptObservation,
	type FinalVerificationAttemptPaths,
	type FinalVerificationProcessIdentity,
	type FinalVerificationReworkFacts,
	type FinalVerificationReworkRecord,
	type FinalVerificationReworkDispatchRecord,
	type CompletionAgentIdentity,
	type CompletionStopResource,
	type CompletionStopFailure,
	type CompletionGateFacts,
	type AnyCompletionGateFacts,
	type CompletionArchiveIntent,
	type CompletionRecord,
	type CancellationRecord,
	type StewardOwnedPane,
	type StewardOwnedWorktree,
	type CancellationAgentStop,
	type CancellationArchiveIntent,
	type MonitorCheckpoint,
	type MonitorDigest,
	type MonitorLifecycle,
	type MonitorReportObservation,
	type SilenceProcessObservation,
	type SilenceInspectionSnapshot,
	type SilencePhase,
	type AttemptReplacement,
	type AttemptContinuation,
	type InfrastructureOutcome,
	type RecoveryPreservation,
	type ControllerPendingAction,
} from "./run.ts";
import {
	buildReviewerAssignment,
	buildFinalizedReviewerEvidenceManifest,
	formatReviewerPrompt,
	parseReviewerAttemptReport,
	deserializeReviewerAssignment,
	reviewSubjectFromFinalizedBuilderEvidence,
	serializeFinalizedReviewerEvidenceManifest,
	finalizedReviewerEvidenceManifestSha256,
	reviewerAssignmentSha256,
	selectReviewerModel,
	deserializeFinalizedBuilderEvidenceManifest,
	deserializeFinalizedReviewerEvidenceManifest,
	validateReviewerReportAgainstAssignment,
	worktreeSnapshotsEqual,
	type ReviewSubject,
	type ReviewerAssignmentDocument,
	type ReviewerAttemptReport,
	type ReviewerChoiceInspection,
	type ReviewerModelSelection,
	type ReviewerIndependence,
	type FinalizedReviewerEvidenceManifest,
} from "./review.ts";
import { join, resolve } from "node:path";
import {
	changedPathsInAllowedScope,
	parseBuilderAttemptReport,
	validateBuilderReportAgainstAssignment,
	validateReportedGitFacts,
	type BuilderAttemptReport,
} from "./attempt-report.ts";
import {
	finalizationCopyForArtifact,
	finalizationCopyForLog,
	sha256Bytes,
	type EvidencePaths,
} from "./attempt-evidence-store.ts";
import type {
	ArchiveCancelledRunRequest,
	ArchiveCancelledRunResult,
	ArchiveCompletedRunRequest,
	ArchiveCompletedRunResult,
	CompletionPaths,
	VerificationEvidenceInput,
	VerificationFinalizeResult,
} from "./completion-store.ts";
import { classifyInfrastructureFact, decideReconciliation, decideSilenceRecovery, parseTaskFactRequest, replacementRetryOrdinal, resolveTaskFactAnswer, selectTransientModel, taskFactValue, type ClassifiedInfrastructureFact, type ReconciliationDecision, type TaskFactKey, type SilenceRecoveryDecision } from "./reconciliation.ts";
import { allRequiredTasksIntegrated, selectIntegrationQueueHead, selectTaskAdmission, type IntegrationQueueDecision, type TaskAdmissionDecision } from "./coordination.ts";

export type { MonitorDigest, MonitorLifecycle, SilenceProcessObservation } from "./run.ts";

type ProvenDispatch = Extract<AttemptRecord["dispatch"], { phase: "prompted" | "reconciled-active" }>;
type ProvenAttempt = AttemptRecord & { dispatch: ProvenDispatch };
type AssignmentDispatch = Extract<AttemptRecord["dispatch"], { phase: "prompt-intended" | "prompted" | "reconciled-active" }>;
type AssignmentAttempt = AttemptRecord & { dispatch: AssignmentDispatch };

function finalVerificationEvidencePointers(execution: FinalVerificationExecution): { logPath: string; resultPath: string; logSha256: string; resultSha256: string } | undefined {
	if (isRecoverableFinalVerificationExecution(execution)) {
		const attempt = execution.attempts.at(-1);
		const observation = attempt?.observation;
		return attempt && observation?.kind === "complete" ? { logPath: attempt.paths.logPath, resultPath: attempt.paths.resultPath, logSha256: observation.logSha256, resultSha256: observation.resultSha256 } : undefined;
	}
	return execution.phase === "passed" || execution.phase === "failed" ? { logPath: execution.logPath, resultPath: execution.resultPath, logSha256: execution.logSha256, resultSha256: execution.resultSha256 } : undefined;
}

function finalVerificationStatusLines(execution: FinalVerificationExecution): string[] {
	if (isRecoverableFinalVerificationExecution(execution)) {
		const attempt = execution.attempts.at(-1);
		return [`Final verification: ${execution.phase} · ${attempt?.id ?? "unknown"}/${attempt?.kind ?? "unknown"}`, ...(attempt?.process ? [`Verification process: pid=${attempt.process.pid} nonce=${attempt.process.executionNonce}`] : []), ...(attempt?.observation ? [`Verification observation: ${attempt.observation.kind}`] : []), ...(attempt ? [`Verification result: ${attempt.paths.resultPath}`, `Verification output: ${attempt.paths.logPath}`] : [])];
	}
	return [`Final verification: ${execution.phase}`, ...(finalVerificationEvidencePointers(execution) ? [`Verification result: ${finalVerificationEvidencePointers(execution)!.resultPath}`, `Verification output: ${finalVerificationEvidencePointers(execution)!.logPath}`] : [])];
}

function hasProvenAgentIdentity(attempt: AttemptRecord): attempt is ProvenAttempt {
	return attempt.dispatch.phase === "prompted" || attempt.dispatch.phase === "reconciled-active";
}

function hasAssignmentIdentity(attempt: AttemptRecord): attempt is AssignmentAttempt {
	return attempt.dispatch.phase === "prompt-intended" || hasProvenAgentIdentity(attempt);
}

function attemptSpecificationVersion(attempt: AttemptRecord): number {
	return attempt.specificationVersion ?? 1;
}

function currentAttempts(task: TaskRecord): AttemptRecord[] {
	return task.attempts.filter((attempt) => attemptSpecificationVersion(attempt) === task.specificationVersion && attempt.state !== "cancelled");
}

function currentAttempt(task: TaskRecord): AttemptRecord | undefined {
	return currentAttempts(task).at(-1);
}

function currentAttemptForTask(task: TaskRecord): AttemptRecord | undefined {
	return currentAttempt(task);
}

function runAllowsWorkflowAdvance(run: RunJournal["run"] | RunJournal): boolean {
	const record = "run" in run ? run.run : run;
	return record.status !== "cancelled" && record.cancellation === undefined;
}

function attemptIdentity(attempt: AttemptRecord): ManagedAgentIdentity | undefined {
	if (!hasProvenAgentIdentity(attempt)) return undefined;
	const dispatch = attempt.dispatch;
	return { name: dispatch.agentName, workspaceId: dispatch.workspaceId, paneId: dispatch.paneId, terminalId: dispatch.terminalId };
}

/** The two presentation contexts supported by this slice. */
export type StatusTarget = "command" | "footer";

/** The only journal fact needed to decide ticket-01 status. */
export type ActiveRunProbe = "missing" | "present";

/** The read-only and configuration operations owned by the Run Journal adapter. */
export interface RunJournalAdapter {
	probeActive(repositoryRoot: string): ActiveRunProbe;
	loadActive(repositoryRoot: string): Promise<ActiveRunLoadResult>;
	applyMigration?(repositoryRoot: string, expected: Extract<ActiveRunLoadResult, { kind: "migration-ready" }>): Promise<ApplyRunJournalMigrationResult>;
	createActive(repositoryRoot: string, journal: RunJournal): Promise<CreateActiveResult>;
	replaceActive(repositoryRoot: string, journal: RunJournal): Promise<import("./run-journal-store.ts").ReplaceActiveResult>;
	appendActivity(repositoryRoot: string, entry: import("./run.ts").ActivityEntry): Promise<ActivityAppendResult>;
	inspectAttemptReport?(repositoryRoot: string, reportPath: string): Promise<AttemptReportInspection>;
	inspectAttemptAssignment?(input: { repositoryRoot: string; attempt: AttemptRecord }): Promise<import("./run-journal-store.ts").AttemptAssignmentInspection>;
	inspectAttemptPreservation?(input: { repositoryRoot: string; attempt: AttemptRecord }): Promise<import("./run-journal-store.ts").AttemptPreservationInspection>;
	resolveAssignmentPaths(repositoryRoot: string, runId: string, taskId: string, attemptId: string): AssignmentPaths;
	createAssignment(repositoryRoot: string, document: BuilderAssignmentDocument | ReviewerAssignmentDocument): Promise<AssignmentCreateResult>;
	loadBuilderEvidenceInputs?(input: import("./attempt-evidence-store.ts").BuilderEvidenceInputRequest): Promise<import("./attempt-evidence-store.ts").BuilderEvidenceInputs>;
	loadReviewerEvidenceInputs?(input: import("./attempt-evidence-store.ts").ReviewerEvidenceInputRequest): Promise<import("./attempt-evidence-store.ts").ReviewerEvidenceInputs>;
	loadFinalizedEvidenceManifest?(input: { manifestPath: string; manifestSha256: string }): Promise<import("./attempt-evidence-store.ts").FinalizedManifestLoadResult>;
	inspectReferencedEvidence?(input: import("./attempt-evidence-store.ts").ReferencedEvidenceRequest): Promise<import("./attempt-evidence-store.ts").ReferencedEvidenceResult>;
	inspectReferencedReviewerEvidence?(input: import("./attempt-evidence-store.ts").ReferencedReviewerEvidenceRequest): Promise<import("./attempt-evidence-store.ts").ReferencedReviewerEvidenceResult>;
	finalizeBuilderEvidence?(input: import("./attempt-evidence-store.ts").FinalizeBuilderEvidenceRequest): Promise<import("./attempt-evidence-store.ts").FinalizeBuilderEvidenceResult>;
	finalizeReviewerEvidence?(input: import("./attempt-evidence-store.ts").FinalizeReviewerEvidenceRequest): Promise<import("./attempt-evidence-store.ts").FinalizeReviewerEvidenceResult>;
	resolveCompletionPaths?(repositoryRoot: string, runId: string, configDirNameOrAttempt?: string, attemptId?: import("./run.ts").FinalVerificationAttemptId): CompletionPaths;
	finalizeVerificationResult?(input: VerificationEvidenceInput): Promise<VerificationFinalizeResult>;
	inspectFinalVerificationResult?(input: { repositoryRoot: string; runId: string; command: string; cwd: string; attemptId: import("./run.ts").FinalVerificationAttemptId; executionNonce?: string; argvSha256?: string }): Promise<import("./completion-store.ts").FinalVerificationResultInspection>;
	archiveCompletedRun?(input: ArchiveCompletedRunRequest): Promise<ArchiveCompletedRunResult>;
	archiveCancelledRun?(input: ArchiveCancelledRunRequest): Promise<ArchiveCancelledRunResult>;
	listTerminalArchives?(repositoryRoot: string): Promise<import("./completion-store.ts").TerminalArchiveListingResult>;
	loadCompletionJournalPointers?(repositoryRoot: string): Promise<{ kind: "loaded"; pointers: import("./completion-store.ts").CompletionJournalPointers } | { kind: "unavailable"; message: string }>;
	loadRecoveryDefaults(): Promise<ConfigLoadResult<RecoveryDefaults>>;
	loadModelPlans(repositoryRoot: string): Promise<ConfigLoadResult<ProjectModelPlans>>;
	saveRecoveryDefaults(recovery: RecoveryDefaults): Promise<ConfigSaveResult>;
	saveModelPlans(repositoryRoot: string, modelPlans: ProjectModelPlans): Promise<ConfigSaveResult>;
}

/** Empty adapter slots reserved for later, demonstrated uses. */
export type OpaqueAdapter = Readonly<Record<never, never>>;

export interface StewardUiSurface {
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
}

export interface ControllerSessionProposal {
	reference: string;
	thinkingLevel?: ThinkingLevel;
}

export interface ConfigurationEditorInput {
	recovery: RecoveryDefaults;
	modelPlans: ProjectModelPlans | undefined;
	recoveryPath: string;
	modelPlansPath: string;
	modelChoices: readonly ModelChoiceOption[];
	proposal: ControllerSessionProposal | undefined;
}

export type ConfigurationEditResult =
	| { kind: "cancelled" }
	| { kind: "save-recovery"; recovery: RecoveryDefaults }
	| { kind: "save-model-plans"; modelPlans: ProjectModelPlans };

/** The request-scoped presentation operations owned by the UI adapter. */
export interface StewardUiAdapter {
	presentStatus(statusView: StatusView, target: StatusTarget): void;
	editConfiguration(input: ConfigurationEditorInput): Promise<ConfigurationEditResult>;
	presentConfigurationResult(result: ConfigureResult): void;
	draftRun(input: RunDraftInput): Promise<RunDraftResult>;
	confirmRun(summary: RunConfirmationSummary): Promise<boolean>;
	draftRunRevision?(input: RunRevisionDraftInput): Promise<RunRevisionDraftResult>;
	confirmRunRevision?(summary: RunRevisionConfirmationSummary): Promise<boolean>;
	presentRevisionResult?(result: RevisionResult): void;
	confirmSameFamilyReview?(input: { builderModel: import("./config.ts").ModelChoice; reviewerModel: import("./config.ts").ModelChoice; subject: ReviewSubject; provider: string }): Promise<boolean>;
	confirmCancellation?(summary: CancellationConfirmationSummary): Promise<boolean>;
	presentCancellationResult?(result: CancellationResult): void;
	confirmCleanup?(summary: CleanupConfirmationSummary): Promise<boolean>;
	presentCleanupResult?(result: CleanupResult): void;
	presentStartResult(result: StartResult): void;
	presentResumeResult?(result: ResumeResult): void;
	notifyCompletion?(input: { runId: string; targetBranch: string; integratedHead: string; verificationResultPath: string; verificationLogPath: string; archivePath: string }): void;
	presentMonitorCondition?(input: MonitorConditionInput): void;
}

export interface StewardModelAdapter {
	listModelChoices(): readonly ModelChoiceOption[];
	validateModelPlans(modelPlans: ProjectModelPlans): Promise<ConfigDiagnostic[]>;
	inspectModelChoice?(choice: import("./config.ts").ModelChoice, role: "builder" | "reviewer", index: number): Promise<ReviewerChoiceInspection>;
}

/** The complete, deliberately fixed orchestration seam for this ticket. */
export interface StewardHerdrAdapter {
	checkAvailability(repositoryRoot: string): Promise<HerdrAvailability>;
	createBuilderWorktree?(input: { repositoryRoot: string; branch: string; baseRevision: string; label: string }): Promise<HerdrWorktreeCreateResult>;
	startBuilder?(input: { repositoryRoot: string; name: string; paneId: string; model: import("./config.ts").ModelChoice }): Promise<HerdrAgentStartResult>;
	promptBuilder?(input: { repositoryRoot: string; name: string; assignmentPrompt: string }): Promise<HerdrPromptResult>;
	createReviewerPane?(input: { repositoryRoot: string; sourcePaneId: string; worktreePath: string; branch: string; agentName: string; workspaceId: string }): Promise<HerdrReviewerPaneResult>;
	startReviewer?(input: { repositoryRoot: string; name: string; paneId: string; model: import("./config.ts").ModelChoice }): Promise<HerdrAgentStartResult>;
	promptReviewer?(input: { repositoryRoot: string; name: string; assignmentPrompt: string }): Promise<HerdrPromptResult>;
	readBlockedTaskFactRequest?(identity: ManagedAgentIdentity, role: "builder" | "reviewer"): Promise<TaskFactRequestResult>;
	answerBlockedTaskFact?(input: { repositoryRoot: string; identity: ManagedAgentIdentity; answer: string }): Promise<HerdrTaskFactAnswerResult>;
	requestAttemptReport?(input: { repositoryRoot: string; identity: ManagedAgentIdentity; role: "builder" | "reviewer"; reportPath: string; assignmentPath: string; evidenceDirectory: string }): Promise<HerdrPromptResult>;
	stopAgentGracefully?(input: { repositoryRoot: string; name: string; workspaceId: string; paneId: string; terminalId: string }): Promise<HerdrStopResult>;
	inspectManagedAgent?(identity: ManagedAgentIdentity): Promise<ManagedAgentInspection>;
	waitForManagedAgent?(identity: ManagedAgentIdentity, timeoutMs: number, signal: AbortSignal): Promise<MonitorWaitResult>;
	readManagedTerminal?(identity: ManagedAgentIdentity): Promise<MonitorDigest>;
	nudgeAgent?(input: { repositoryRoot: string; identity: ManagedAgentIdentity; prompt: string }): Promise<HerdrPromptResult>;
	interruptAgent?(input: { repositoryRoot: string; identity: ManagedAgentIdentity }): Promise<HerdrInputResult>;
	resumeAgent?(input: { repositoryRoot: string; identity: ManagedAgentIdentity; prompt: string }): Promise<HerdrPromptResult>;
	createRecoveryPane?(input: { repositoryRoot: string; sourcePaneId: string; workspaceId: string; worktreePath: string; branch: string; agentName: string }): Promise<HerdrReviewerPaneResult>;
	startReplacementAgent?(input: { repositoryRoot: string; name: string; paneId: string; model: import("./config.ts").ModelChoice }): Promise<HerdrAgentStartResult>;
	promptReplacementAgent?(input: { repositoryRoot: string; identity: ManagedAgentIdentity; assignmentPrompt: string }): Promise<HerdrPromptResult>;
	preflightCleanupWorkspace?(input: { repositoryRoot: string; workspaceId: string }): Promise<HerdrCleanupPreflightResult>;
	closeCleanupPane?(input: { repositoryRoot: string; workspaceId: string; paneId: string; terminalId: string }): Promise<HerdrCleanupEffectResult>;
	removeCleanupWorktree?(input: { repositoryRoot: string; workspaceId: string; path: string; branch: string }): Promise<HerdrCleanupEffectResult>;
}

export type HerdrWorktreeCreateResult =
	| { kind: "created"; branch: string; path: string; workspaceId: string; tabId: string; paneId: string; terminalId: string }
	| { kind: "failed"; stage: "worktree-create"; code: string; message: string };

export type HerdrAgentStartResult =
	| { kind: "started"; name: string; agentKind: "pi"; workspaceId: string; tabId: string; paneId: string; terminalId: string }
	| { kind: "name-collision"; code: "agent_name_taken"; message: string }
	| { kind: "failed"; stage: "agent-start"; code: string; message: string };

export type HerdrPromptResult =
	| { kind: "prompted"; name: string; workspaceId: string; tabId: string; paneId: string; terminalId: string }
	| { kind: "failed"; stage: "agent-prompt"; code: string; message: string };

export type HerdrTaskFactAnswerResult =
	| { kind: "acknowledged"; identity: ManagedAgentIdentity }
	| { kind: "failed"; message: string }
	| { kind: "ambiguous"; message: string };

export type HerdrReviewerPaneResult =
	| { kind: "created"; workspaceId: string; tabId: string; paneId: string; terminalId: string; sourcePaneId: string; worktreePath: string }
	| { kind: "failed"; stage: "pane-split"; code: string; message: string };

export type HerdrStopResult =
	| { kind: "acknowledged"; name: string; workspaceId: string; tabId: string; paneId: string; terminalId: string }
	| { kind: "failed" | "ambiguous"; message: string };

export type HerdrInputResult =
	| { kind: "acknowledged"; identity: ManagedAgentIdentity }
	| { kind: "failed" | "ambiguous"; message: string };

export type HerdrAvailability =
	| { kind: "available"; status: string; running: true; compatible: true; endpointCompatible: true; protocol?: number }
	| { kind: "unavailable"; message: string };

export interface HerdrCleanupPaneObservation {
	workspaceId: string;
	paneId: string;
	terminalId: string;
	root: boolean;
}

export interface HerdrCleanupWorktreeObservation {
	workspaceId: string;
	path: string;
	branch: string;
	rootPaneId?: string;
}

export type HerdrCleanupPreflightResult =
	| { kind: "ready"; workspaceId: string; panes: HerdrCleanupPaneObservation[]; worktrees: HerdrCleanupWorktreeObservation[] }
	| { kind: "missing"; resource: "workspace"; workspaceId: string }
	| { kind: "blocked" | "ambiguous"; message: string };

export type HerdrCleanupEffectResult =
	| { kind: "completed"; resourceId: string }
	| { kind: "missing"; resourceId: string }
	| { kind: "failed" | "ambiguous"; message: string };

export interface StewardGitAdapter {
	inspectIntegrationBase(repositoryRoot: string): Promise<IntegrationBaseInspection>;
	branchExists?(repositoryRoot: string, branch: string): Promise<boolean>;
	inspectBuilderWorktree?(worktreePath: string, expectedRevision: string): Promise<BuilderWorktreeInspection>;
	inspectProducedCodeArtifact?(input: { worktreePath: string; approvedBase: string; producedHead: string }): Promise<ProducedCodeArtifactInspection>;
	inspectReviewWorktree?(worktreePath: string): Promise<import("./run.ts").ReviewWorktreeSnapshot | { kind: "unavailable"; message: string }>;
	inspectIntegrationCheckout?(input: IntegrationCheckoutInput): Promise<IntegrationCheckoutResult>;
	integrateApprovedRange?(input: IntegrationMutationInput): Promise<GitCommandOutcome>;
	inspectManagedWorktreeProgress?(worktreePath: string): Promise<ManagedWorktreeProgress>;
}

export interface IntegrationCheckoutInput {
	repositoryRoot: string;
	targetBranch: string;
	targetRevision: string;
	approvedBaseRevision: string;
	approvedHeadRevision: string;
	approvedCommits: string[];
}

export type IntegrationCheckoutResult =
	| {
			kind: "inspected";
			observation: import("./run.ts").IntegrationCheckoutObservation;
			resolvedBaseRevision: string;
			resolvedHeadRevision: string;
			commits: string[];
			target?: IntegrationTargetFacts;
			application?: IntegrationApplication;
			difference?: IntegrationTargetDifference;
			mergeability?: IntegrationMergeability;
	  }
	| { kind: "unavailable"; message: string };

export interface IntegrationMutationInput extends IntegrationCheckoutInput {
	action:
		| { kind: "fast-forward"; argv: ["merge", "--ff-only", "--no-edit", string] }
		| { kind: "merge-commit"; argv: ["merge", "--no-ff", "--no-edit", string] };
}

export type GitCommandOutcome =
	| { kind: "completed"; code: number; stdout: string; stderr: string; killed: boolean }
	| { kind: "thrown"; message: string };

export type VerificationProcessOutcome =
	| { kind: "completed"; code: number; stdout: string; stderr: string; killed: boolean }
	| { kind: "thrown"; message: string };

export interface StewardProcessAdapter {
	runApprovedVerification?(input: { cwd: string; command: string }): Promise<VerificationProcessOutcome>;
	launchApprovedVerification?(input: ManagedVerificationInput): Promise<ManagedVerificationLaunchResult>;
	inspectApprovedVerification?(input: ManagedVerificationInput & { process?: import("./run.ts").FinalVerificationProcessIdentity }): Promise<"live" | "exited" | "not-launched" | "unclear">;
	waitApprovedVerification?(input: ManagedVerificationInput & { process?: import("./run.ts").FinalVerificationProcessIdentity }, signal: AbortSignal): Promise<"settled" | "cancelled" | "unclear">;
	inspectAttemptProcesses?(input: { repositoryRoot: string; identity: ManagedAgentIdentity }): Promise<SilenceProcessObservation>;
}

export interface ManagedVerificationInput {
	repositoryRoot: string;
	runId: string;
	attemptId: import("./run.ts").FinalVerificationAttemptId;
	command: string;
	cwd: string;
	executionNonce: string;
	paths: import("./run.ts").FinalVerificationAttemptPaths;
}

export interface ManagedVerificationLaunchResult {
	kind: "launched" | "not-launched" | "unclear";
	pid?: number;
	startToken?: string;
	argvSha256?: string;
	executionNonce?: string;
	launchedAt?: string;
	diagnostic?: string;
}

export type IntegrationBaseInspection =
	| { kind: "ready"; branch: string; revision: string }
	| { kind: "unavailable"; message: string };

export type BuilderWorktreeInspection =
	| { kind: "ready"; head: string; clean: true }
	| { kind: "unavailable"; message: string };

export type ProducedCodeArtifactInspection =
	| { kind: "inspected"; base: string; head: string; commits: string[]; changedPaths: Array<{ status: string; paths: string[] }>; clean: true }
	| { kind: "invalid"; code: "missing-revision" | "base-not-ancestor" | "head-mismatch" | "empty-range" | "dirty-worktree" | "git-operation-in-progress" | "malformed-git-output" | "git-inspection-failed"; message: string; dirtyPaths?: string[] };

export interface StewardClockAdapter {
	now(): Date;
	randomUUID(): string;
	wait?(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export interface ManagedAgentIdentity {
	name: string;
	workspaceId: string;
	paneId: string;
	terminalId: string;
}

export type ManagedAgentInspection =
	| { kind: "observed"; identity: ManagedAgentIdentity; lifecycle: MonitorLifecycle; stateChangeSequence: number | null }
	| { kind: "missing"; diagnostic: string; code?: "agent_not_found" }
	| { kind: "unclear"; diagnostic: string; availability?: "unavailable" };


export type MonitorWaitResult =
	| { kind: "settled"; lifecycle: Extract<MonitorLifecycle, "idle" | "done" | "blocked" | "unknown">; identity: ManagedAgentIdentity; stateChangeSequence: number | null }
	| { kind: "timeout" }
	| { kind: "unavailable"; diagnostic: string }
	| { kind: "cancelled" };

export type ManagedWorktreeProgress =
	| { kind: "observed"; head: string; worktree: MonitorDigest; git: { head: string; digest: MonitorDigest } }
	| { kind: "unavailable"; diagnostic: string };

export type MonitorTrigger = "start" | "lifecycle" | "fallback" | "settled" | "turn" | "compaction" | "compaction-success" | "prompt" | "manual";

export type MonitorWorkflowAction = "record-observation" | "finalize-builder-evidence" | "invalidate-approval" | "dispatch-builder" | "dispatch-reviewer" | "finalize-reviewer-evidence" | "request-reviewer-report-repair" | "dispatch-rework-builder" | "integrate-approved-range" | "run-final-verification" | "pass-completion-gate" | "stop-next-agent" | "publish-completion-archive" | "silence-nudge" | "silence-interrupt" | "silence-resume" | "reserve-silent-replacement" | "reserve-transient-replacement" | "none" | "approval-required" | "blocked" | "degraded";

export type MonitorCondition = "completed" | "cancelled" | "approval-required" | "blocked" | "degraded" | "ordinary";

export interface MonitorConditionInput {
	condition: MonitorCondition;
	runId?: string;
	journalRevision?: number;
	footerText: string;
	notification?: { key: string; message: string; type: "info" | "warning" | "error" };
}

export interface MonitorPassResult {
	action: MonitorWorkflowAction;
	journal?: RunJournal;
	note: string;
	condition: MonitorCondition;
	changedSources?: string[];
	diagnostic?: string;
	completed?: boolean;
	notification?: boolean;
}

export type ResumeResult =
	| { kind: "missing"; message: string }
	| { kind: "invalid"; message: string }
	| { kind: "recovered"; message: string }
	| { kind: "migration-applied"; journal: RunJournal; message: string }
	| { kind: "migration-failed"; message: string }
	| { kind: "foreign-session"; recordedSessionId: string; currentSessionId: string; message: string }
	| { kind: "already-owner"; currentSessionId: string; message: string }
	| { kind: "taken-over"; journal: RunJournal; message: string; pendingAction: ControllerPendingAction }
	| { kind: "stale"; message: string }
	| { kind: "usage"; message: string }
	| { kind: "reconciled"; result: MonitorPassResult }
	| { kind: "degraded"; message: string; result?: MonitorPassResult };

export type ControllerSessionRestoreResult =
	| { kind: "restored"; journal: RunJournal }
	| { kind: "dormant"; reason: "missing" | "invalid" | "recovery" | "foreign-session" | "completed" | "cancelled"; message: string; journal?: RunJournal };

export type CompactionContinuityResult =
	| { kind: "prepared"; journal: RunJournal; runId: string; journalRevision: number; controllerSessionId: string; pendingAction: ControllerPendingAction; block: string }
	| { kind: "missing" | "invalid" | "foreign-session" | "completed" | "cancelled" | "stale"; message: string };

export interface CompactionFailureDetails {
	reason: "manual" | "threshold" | "overflow";
	errorMessage?: string;
	aborted: boolean;
	willRetry: boolean;
	fromExtension: boolean;
}

export interface MonitorAdvanceOptions {
	interactive: boolean;
	maximumActions: 1;
	source?: "monitor" | "status" | "resume";
}

export interface StewardDependencies {
	runJournal: RunJournalAdapter;
	herdr: StewardHerdrAdapter;
	git: StewardGitAdapter;
	process: StewardProcessAdapter;
	model: StewardModelAdapter;
	clock: StewardClockAdapter;
	ui: StewardUiAdapter;
}

export interface EmptyFooterView {
	run: "none";
	attentionCount: 0;
	text: "steward: no active Run";
}

export interface ActiveFooterView {
	run: "active";
	attentionCount: number;
	text: string;
}

export interface EmptyStatusView {
	kind: "empty";
	markdown: "No active Steward Run exists in this repository.";
	footer: EmptyFooterView;
}

export interface ActiveAttemptStatusView {
	runId: string;
	taskId: string;
	taskPhase: "building" | "reworking" | "reviewing" | "approved";
	attemptId: string;
	role: "builder";
	attemptState: "prepared" | "active" | "awaiting-report" | "reported" | "ended-error" | "superseded" | "cancelled";
	assignmentPath?: string;
	assignmentHash?: string;
	actualModel?: import("./config.ts").ModelChoice;
	worktreeBranch?: string;
	worktreePath?: string;
	agentName?: string;
	paneId?: string;
	workspaceId?: string;
	reportPath: string;
	attention: "none" | "blocked" | "waiting-external" | "suspected-stall" | "recovering" | "needs-user";
	dispatchPhase: DispatchRecord["phase"] | "assignment-intended";
	evidence?: BuilderEvidenceRecord;
}

export interface ActiveStatusView {
	kind: "present";
	journalRecovery: ActiveJournalMode;
	markdown: string;
	footer: ActiveFooterView;
	activeAttempt?: ActiveAttemptStatusView;
}

export interface CompletedStatusView {
	kind: "present";
	completed: true;
	journalRecovery?: ActiveJournalMode;
	markdown: string;
	footer: EmptyFooterView;
}

export type StatusView = EmptyStatusView | ActiveStatusView | CompletedStatusView | CancelledStatusView;

export interface CancelledStatusView {
	kind: "present";
	cancelled: true;
	journalRecovery?: ActiveJournalMode;
	markdown: string;
	footer: ActiveFooterView;
}

export type CancellationConfirmationSummary = { runId: string; markdown: string };

export type CancellationResult =
	| { kind: "declined"; message: string }
	| { kind: "refused" | "stale" | "storage-error"; message: string }
	| { kind: "cancelled" | "archived" | "incomplete"; journal?: RunJournal; message: string };

export interface CleanupConfirmationSummary {
	markdown: string;
	archives: Array<{ runId: string; archiveDirectory: string; runSha256: string; manifestSha256: string }>;
	panes: StewardOwnedPane[];
	worktrees: StewardOwnedWorktree[];
}

export type CleanupResult =
	| { kind: "declined"; message: string }
	| { kind: "refused" | "stale" | "blocked" | "partial" | "storage-error"; message: string }
	| { kind: "noop" | "completed"; message: string };

export type ConfigureResult =
	| { kind: "cancelled"; scope?: ConfigurationScope; path?: string; message: string }
	| { kind: "saved"; scope: ConfigurationScope; path: string; message: string }
	| { kind: "invalid"; scope: ConfigurationScope; path: string; diagnostics: ConfigDiagnostic[]; message: string }
	| { kind: "load-error"; diagnostics: ConfigDiagnostic[]; message: string }
	| { kind: "save-error"; scope: ConfigurationScope; path: string; diagnostics: ConfigDiagnostic[]; message: string };

export type StartResult =
	| { kind: "cancelled"; message: string }
	| { kind: "refused"; message: string }
	| { kind: "started-and-dispatched"; journal: RunJournal; message: string }
	| { kind: "started-dispatch-pending"; journal: RunJournal; message: string }
	| { kind: "started-and-dispatched-with-warning"; journal: RunJournal; message: string }
	| { kind: "started"; journal: RunJournal; message: string }
	| { kind: "started-with-warning"; journal: RunJournal; message: string }
	| { kind: "storage-error"; message: string };

export type RevisionResult =
	| { kind: "cancelled"; message: string }
	| { kind: "refused"; message: string }
	| { kind: "missing" | "invalid" | "foreign-session" | "stale"; message: string; recordedSessionId?: string; currentSessionId?: string }
	| { kind: "revised"; journal: RunJournal; message: string }
	| { kind: "ambiguous"; journal: RunJournal; message: string };

/** The ticket-01 and ticket-02 orchestration operations. */
export interface Steward {
	status(repositoryRoot: string, target: StatusTarget, controllerSessionId?: string): Promise<StatusView>;
	resume(repositoryRoot: string, controllerSessionId: string, takeover?: boolean): Promise<ResumeResult>;
	takeover(repositoryRoot: string, controllerSessionId: string): Promise<ResumeResult>;
	restoreControllerSession(repositoryRoot: string, controllerSessionId: string): Promise<ControllerSessionRestoreResult>;
	prepareCompactionContinuity(repositoryRoot: string, controllerSessionId: string): Promise<CompactionContinuityResult>;
	recordCompactionFailure(repositoryRoot: string, controllerSessionId: string, details: CompactionFailureDetails): Promise<{ kind: "recorded" | "ignored" | "degraded"; message: string }>;
	configure(repositoryRoot: string, proposal?: ControllerSessionProposal): Promise<ConfigureResult>;
	start(repositoryRoot: string, controllerSessionId: string): Promise<StartResult>;
	revise(repositoryRoot: string, controllerSessionId: string): Promise<RevisionResult>;
	cancel(repositoryRoot: string, controllerSessionId: string): Promise<CancellationResult>;
	cleanup(repositoryRoot: string, controllerSessionId: string): Promise<CleanupResult>;
	waitForMonitorSignal(repositoryRoot: string, controllerSessionId: string, signal: AbortSignal): Promise<MonitorWaitResult>;
	observeMonitorProgress(repositoryRoot: string, controllerSessionId: string, trigger: MonitorTrigger): Promise<MonitorPassResult>;
	advanceNext(repositoryRoot: string, controllerSessionId: string, options: MonitorAdvanceOptions): Promise<MonitorPassResult>;
	presentMonitor(result: MonitorPassResult, target: "footer" | "command"): void;
}

const EMPTY_STATUS: EmptyStatusView = {
	kind: "empty",
	markdown: "No active Steward Run exists in this repository.",
	footer: {
		run: "none",
		attentionCount: 0,
		text: "steward: no active Run",
	},
};

function presentReviewStatus(journal: RunJournal, note?: string): ActiveStatusView {
	const task = journal.run.tasks.find((candidate) => candidate.phase === "reviewing");
	if (!task) return { kind: "present", journalRecovery: "normal", markdown: `Run ${journal.run.id} is active; no Reviewer Task is in progress.`, footer: { run: "active", attentionCount: 0, text: `steward: ${journal.run.id} · active · 0 attention` } };
	const reviewer = latestReviewerAttempt(task);
	const lines = [`Run ${journal.run.id}: active`, `Task ${task.contract.id}: reviewing`, `Rework cycles: ${task.reworkCycles}/${journal.run.effectiveSettings.reworkCycleLimit}`, `Attention: ${task.attention}`];
	if (reviewer) lines.push(...silenceStatusLines(journal, task, reviewer));
	if (reviewer) lines.push(...transientStatusLines(journal, task, reviewer));
	if (task.attentionReason) lines.push(`Attention reason: ${task.attentionReason}`);
	if (task.attentionDiagnostic) lines.push(`Attention diagnostic: ${task.attentionDiagnostic}`);
	if (task.approval?.phase === "invalidated") lines.push(`Approval: invalidated (${task.approval.reason}); preserved exact facts require user attention.`);
	if (!reviewer) {
		lines.push("Review dispatch pending; no Reviewer Attempt has been launched.");
	} else {
		lines.push(`Reviewer Attempt ${reviewer.id}: ${reviewer.state}`, `Reviewer dispatch phase: ${reviewer.dispatch.phase}`, `Reviewer Assignment: ${reviewer.assignmentPath}${reviewer.dispatch.phase === "prompt-intended" || reviewer.dispatch.phase === "prompted" ? ` (${reviewer.dispatch.assignmentSha256})` : ""}`, `Reviewer Report: ${reviewer.reportPath}`, `Reviewer Model: ${reviewer.actualModel.model} [thinking=${reviewer.actualModel.thinkingLevel}]`);
		if (reviewer.integrity?.kind === "violated") lines.push(`Review integrity: violated (${reviewer.integrity.after.head}, ${reviewer.integrity.after.dirtyStateFingerprint}); read-only violation retained and needs-user.`);
		else if (reviewer.integrity?.kind === "preserved") lines.push("Review integrity: preserved; worktree remained read-only.");
		if (reviewer.reportRepair?.phase === "request-intended") lines.push(`Reviewer report repair: request-intended (${reviewer.reportRepair.failure}); no duplicate prompt will be sent.`);
		else if (reviewer.reportRepair?.phase === "requested") lines.push(`Reviewer report repair: requested (${reviewer.reportRepair.failure}); awaiting the same Reviewer.`);
		else if (reviewer.reportRepair?.phase === "blocked") lines.push(`Reviewer report repair: blocked after a second ${reviewer.reportRepair.secondFailure} failure; no further prompt will be sent.`);
		if (reviewer.evidence?.phase === "finalized") lines.push(`Reviewer verdict recorded: ${reviewer.evidence.verdict}; Task remains reviewing.`);
		else if (reviewer.state === "active") lines.push("Awaiting Reviewer Attempt Report; Herdr lifecycle is not a verdict.");
	}
	if (note) lines.push(note);
	const attentionCount = task.attention === "none" ? 0 : 1;
	return { kind: "present", journalRecovery: "normal", markdown: lines.join("\n"), footer: { run: "active", attentionCount, text: `steward: ${journal.run.id} · reviewing · ${attentionCount} attention${reviewer?.recovery?.silence ? ` · silence ${reviewer.recovery.silence.phase}` : ""}` } };
}

function presentApprovedStatus(journal: RunJournal, note?: string): ActiveStatusView {
	const task = journal.run.tasks.find((candidate) => candidate.phase === "approved");
	if (!task || !task.approval) return { kind: "present", journalRecovery: "normal", markdown: `Run ${journal.run.id} is active; Approval state is unavailable.`, footer: { run: "active", attentionCount: 0, text: `steward: ${journal.run.id} · active · 0 attention` } };
	const lines = [`Run ${journal.run.id}: active`, `Task ${task.contract.id}: approved`, `Rework cycles: ${task.reworkCycles}/${journal.run.effectiveSettings.reworkCycleLimit}`, `Attention: ${task.attention}`, ...(task.attentionReason ? [`Attention reason: ${task.attentionReason}`] : []), ...(task.attentionDiagnostic ? [`Attention diagnostic: ${task.attentionDiagnostic}`] : []), `Approval: ${task.approval.phase}`, `Builder Attempt: ${task.approval.builderAttemptId}`, `Reviewer Attempt: ${task.approval.reviewerAttemptId}`, `Reviewer manifest: ${task.approval.reviewerManifestPath} (${task.approval.reviewerManifestSha256})`, `Review subject: ${JSON.stringify(task.approval.subject)}`, `Clean snapshot: ${task.approval.worktreeSnapshot.head} (${task.approval.worktreeSnapshot.dirtyStateFingerprint})`];
	if (note) lines.push(note);
	const attentionCount = task.attention === "none" ? 0 : 1;
	return { kind: "present", journalRecovery: "normal", markdown: lines.join("\n"), footer: { run: "active", attentionCount, text: `steward: ${journal.run.id} · approved · ${attentionCount} attention` } };
}

function integrationStatusLines(task: TaskRecord): string[] {
	const integration = task.integration;
	if (!integration) return [];
	const lines = [`Integration: ${integration.phase}`, `Integration target expected: ${integration.targetBranch}@${integration.targetRevision}`];
	if (integration.phase === "integrated") lines.push(`Integration application: exact @ ${integration.observedHead}`);
	if (integration.phase === "ambiguous") {
		lines.push(`Integration observed: ${integration.observed.branch ?? "detached"}@${integration.observed.head ?? "unknown"}`, `Integration dirty paths: ${integration.observed.dirtyPaths.join(", ") || "none"}`, `Integration operation markers: ${integration.observed.operationMarkers.join(", ") || "none"}`, `Integration application: absent/uncertain`);
		if (integration.difference) lines.push(`Integration delta commits: ${integration.difference.commits.join(", ") || "none"}`, `Integration delta paths: ${integration.difference.changedPaths.map((change) => `${change.status}:${change.paths.join("→")}`).join(", ") || "none"}${integration.difference.truncated ? " (truncated)" : ""}`);
	}
	const recovery = task.integrationRecoveries?.at(-1);
	if (recovery) lines.push(`Integration rework history: ${recovery.targetBranch}@${recovery.targetRevision} advanced to ${recovery.observed.head ?? "unknown"}; conflicts ${recovery.conflictPaths.join(", ")}`);
	return lines;
}

function presentCompletionStatus(journal: RunJournal, note?: string): ActiveStatusView {
	const task = journal.run.tasks[0];
	const completion = journal.run.completion;
	const verification = journal.run.finalVerificationExecution ? finalVerificationEvidencePointers(journal.run.finalVerificationExecution) : undefined;
	const lines = [`Run ${journal.run.id}: ${journal.run.status}`, ...(task ? [`Task ${task.contract.id}: ${task.phase}`, `Attention: ${task.attention}`, ...(task.attentionReason ? [`Attention reason: ${task.attentionReason}`] : []), ...(task.attentionDiagnostic ? [`Attention diagnostic: ${task.attentionDiagnostic}`] : []), ...integrationStatusLines(task)] : []), ...(journal.run.finalVerificationExecution ? [`Final verification: ${journal.run.finalVerificationExecution.phase}`, ...(verification ? [`Verification result: ${verification.resultPath}`] : [])] : []), ...(completion ? [`Completion: ${completion.phase}`] : []), ...(note ? [note] : [])];
	const attentionCount = task && task.attention !== "none" ? 1 : 0;
	return { kind: "present", journalRecovery: "normal", markdown: lines.join("\n"), footer: { run: "active", attentionCount, text: `steward: ${journal.run.id} · ${journal.run.status} · ${attentionCount} attention` } };
}

function presentCompletedStatus(journal: RunJournal, note?: string): CompletedStatusView {
	const completion = journal.run.completion;
	const gate = completion && "gate" in completion ? completion.gate : undefined;
	return { kind: "present", completed: true, markdown: [`Run ${journal.run.id}: completed`, ...(gate ? [`Integrated head: ${gate.integratedHead}`] : []), ...(completion?.phase === "archived" ? [`Archive: ${completion.archive.archiveDirectory}`, `Verification result: ${completion.archive.verification.resultPath}`, `Verification output: ${completion.archive.verification.logPath}`] : []), ...(note ? [note] : [])].join("\n"), footer: { run: "none", attentionCount: 0, text: "steward: no active Run" } };
}

function presentCancelledStatus(journal: RunJournal, note?: string): CancelledStatusView {
	const cancellation = journal.run.cancellation;
	const lines = [`Run ${journal.run.id}: cancelled`, `Cancellation: ${cancellation?.phase ?? "invalid"}`, ...(cancellation ? [`Cancelled at: ${cancellation.cancelledAt}`, `Owned panes retained: ${cancellation.panes.length}`, `Owned Builder worktrees retained: ${cancellation.worktrees.length}`, `Stop records: ${cancellation.stops.map((stop) => `${stop.role}/${stop.attemptId}/${stop.state}${stop.state === "not-required" ? ` (${stop.reason})` : ""}`).join(", ") || "none"}`, ...(cancellation.phase === "stops-incomplete" ? [`Stop failure: ${cancellation.failure.diagnostic}`] : []), ...(cancellation.phase === "archived" ? [`Archive: ${cancellation.archive.archiveDirectory}`] : [])] : []), "Normal advancement, replacement, integration, and verification are dormant; evidence is retained.", ...(note ? [note] : [])];
	return { kind: "present", cancelled: true, markdown: lines.join("\n"), footer: { run: "active", attentionCount: 0, text: `steward: ${journal.run.id} · cancelled` } };
}

function presentStatusForJournalRaw(journal: RunJournal, note?: string): StatusView {
	if (journal.run.status === "cancelled" || journal.run.cancellation) return presentCancelledStatus(journal, note);
	if (journal.run.tasks.length > 1) return presentMultiTaskStatus(journal, note);
	if (journal.run.status === "completed" || journal.run.completion?.phase === "archived") return presentCompletedStatus(journal, note);
	if (journal.run.status === "completing" || journal.run.tasks.some((candidate) => candidate.phase === "integrating" || candidate.phase === "completed")) return presentCompletionStatus(journal, note);
	if (journal.run.tasks.some((candidate) => candidate.phase === "approved")) return presentApprovedStatus(journal, note);
	if (journal.run.tasks.some((candidate) => candidate.phase === "reviewing")) return presentReviewStatus(journal, note);
	const task = journal.run.tasks.find((candidate) => (candidate.phase === "building" || candidate.phase === "reworking") && currentAttempt(candidate)?.role === "builder");
	const attempt = task ? currentAttempt(task) : undefined;
	if (!task || !attempt) {
		return {
			kind: "present",
			journalRecovery: "normal",
			markdown: [`Run ${journal.run.id} is active; no Builder Attempt has been dispatched.`, ...(note ? [note] : [])].join("\n"),
			footer: { run: "active", attentionCount: 0, text: `steward: ${journal.run.id} · active · 0 attention` },
		};
	}
	if (attempt.role !== "builder") return { kind: "present", journalRecovery: "normal", markdown: `Run ${journal.run.id} is active; Review is in progress.`, footer: { run: "active", attentionCount: 0, text: `steward: ${journal.run.id} · reviewing · 0 attention` } };
	const dispatch = attempt.dispatch;
	const actual = dispatch.phase === "worktree-intended" || dispatch.phase === "replacement-pane-intended" ? { worktreeBranch: dispatch.branch, ...(dispatch.phase === "replacement-pane-intended" ? { worktreePath: dispatch.worktreePath, agentName: dispatch.agentName } : {}) } : {
		worktreeBranch: dispatch.branch,
		worktreePath: dispatch.worktreePath,
		agentName: dispatch.agentName,
		paneId: dispatch.paneId,
		workspaceId: dispatch.workspaceId,
		...(dispatch.phase === "prompt-intended" || dispatch.phase === "prompted" || dispatch.phase === "reconciled-active" ? { assignmentHash: dispatch.assignmentSha256 } : {}),
	};
	const activeAttempt: ActiveAttemptStatusView = {
		runId: journal.run.id,
		taskId: task.contract.id,
		taskPhase: task.phase === "building" ? "building" : "reworking",
		attemptId: attempt.id,
		role: "builder",
		attemptState: attempt.state,
		assignmentPath: attempt.assignmentPath,
		actualModel: { ...attempt.actualModel },
		reportPath: attempt.reportPath,
		attention: task.attention,
		dispatchPhase: dispatch.phase,
		...actual,
		...(attempt.evidence ? { evidence: { ...attempt.evidence, ...(attempt.evidence.phase === "rejected" ? { codes: [...attempt.evidence.codes] } : {}) } } : {}),
	};
	const evidence = attempt.evidence;
	const silenceLines = silenceStatusLines(journal, task, attempt);
	const transientLines = transientStatusLines(journal, task, attempt);
	const evidenceLines = evidence?.phase === "rejected"
		? [`Evidence: rejected (${evidence.codes.join(", ")})`, `Evidence detail: ${evidence.summary}`, "Review: blocked; evidence is not valid."]
		: evidence?.phase === "finalization-intended"
			? [`Evidence: finalization intended (${evidence.manifestPath})`, "Evidence snapshot is not yet accepted; retry the matching Controller status."]
			: evidence?.phase === "finalized"
				? [`Evidence: finalized (${evidence.status})`, `Manifest: ${evidence.manifestPath} (${evidence.manifestSha256})`, `Report hash: ${evidence.reportSha256}`, ...(evidence.producedRevision ? [`Produced revision: ${evidence.producedRevision}`] : []), evidence.status === "completed" ? "Review dispatch pending." : "Review: blocked; retained Builder outcome is not Review-eligible."]
				: [];
	const lines = [
		`Run ${journal.run.id}: active`,
		`Task ${task.contract.id}: ${task.phase}`,
		`Attempt ${attempt.id}: ${attempt.state} (builder)`,
		`Dispatch phase: ${dispatch.phase}`,
		`Assignment: ${attempt.assignmentPath}${"assignmentHash" in activeAttempt && activeAttempt.assignmentHash ? ` (${activeAttempt.assignmentHash})` : ""}`,
		`Report: ${attempt.reportPath}`,
		`Model: ${attempt.actualModel.model} [thinking=${attempt.actualModel.thinkingLevel}]`,
		...(activeAttempt.worktreeBranch ? [`Worktree: ${activeAttempt.worktreeBranch} @ ${activeAttempt.worktreePath}`] : []),
		...(activeAttempt.agentName ? [`Herdr Builder: ${activeAttempt.agentName} (pane=${activeAttempt.paneId}, workspace=${activeAttempt.workspaceId})`] : []),
			`Attention: ${task.attention}`,
			...silenceLines,
			...transientLines,
		...(evidenceLines.length > 0 ? evidenceLines : [task.phase === "reworking" ? "Rework: awaiting the same Builder's validated Attempt Report." : "Completion: not inferred from Herdr activity; awaiting a validated Attempt Report."]),
		...(note ? [note] : []),
	];
	return {
		kind: "present",
		journalRecovery: "normal",
		markdown: lines.join("\n"),
		footer: { run: "active", attentionCount: task.attention === "none" ? 0 : 1, text: `steward: ${journal.run.id} · ${task.phase} · ${task.attention === "none" ? 0 : 1} attention${attempt.recovery?.silence ? ` · silence ${attempt.recovery.silence.phase}` : ""}` },
		activeAttempt,
	};
}

function withJournalRecovery(view: StatusView, mode: ActiveJournalMode, banner?: string): StatusView {
	if (view.kind === "empty") return view;
	const markdown = banner ? `${banner}\n${view.markdown}` : view.markdown;
	if ("completed" in view) return { ...view, journalRecovery: mode, markdown };
	if ("cancelled" in view) return { ...view, journalRecovery: mode, markdown, footer: { ...view.footer, text: mode === "normal" ? view.footer.text : `${view.footer.text} · journal ${mode}` } };
	return { ...view, journalRecovery: mode, markdown, footer: { ...view.footer, text: mode === "normal" ? view.footer.text : `${view.footer.text} · journal ${mode}` } };
}

function presentStatusForJournal(journal: RunJournal, note?: string): StatusView {
	const view = presentStatusForJournalRaw(journal, note);
	return withJournalRecovery(view, "normal", view.kind === "present" && !("completed" in view) && !("cancelled" in view) ? "Journal: active schema v1 snapshot" : undefined);
}

function journalRecoveryMessage(load: ActiveRunLoadResult): string {
	if (load.kind === "recovered") {
		return `Journal recovery: degraded; showing previous snapshot revision ${load.journal.journalRevision} because active is corrupt. Workflow is read-only and snapshots are unchanged.\nActive snapshot: ${load.active.path} (${load.active.sha256})\nPrevious snapshot: ${load.previous.path} (${load.previous.sha256})`;
	}
	if (load.kind === "migration-ready") {
		return `Journal recovery: migration ready; source schema v${load.migration.fromVersion} can be normalized to schema v${load.migration.targetVersion} by exact migration ${load.migration.id}. Active snapshot: ${load.paths.activePath} (${load.migration.rawActiveSha256}); previous snapshot: ${load.paths.previousPath} is untouched. Migrated hash: ${load.migration.migratedSha256}. No workflow action has been taken; resume explicitly to apply schema-only normalization.`;
	}
	if (load.kind !== "invalid") return "";
	const reason = load.reason === "newer-schema"
		? "A newer schema was found; update Steward before changing snapshots."
		: load.reason === "older-schema"
			? "An older schema was found without an exact registered migration; snapshots remain read-only."
			: load.reason === "migration-failed"
				? "The exact schema migration failed validation; snapshots remain read-only."
				: load.reason === "unsafe-snapshot"
					? "A snapshot was not a stable regular file; snapshots remain read-only."
					: "Neither snapshot is a valid current schema snapshot; snapshots remain read-only.";
	return `Journal recovery: read-only; ${reason}\nActive snapshot: ${load.paths.activePath}\nPrevious snapshot: ${load.paths.previousPath}\n${load.diagnostics.map((item) => item.message).join(" ")}`;
}

function presentRecoveryStatus(load: Exclude<ActiveRunLoadResult, { kind: "missing" | "loaded" }>): StatusView {
	if (load.kind === "invalid") {
		return {
			kind: "present",
			journalRecovery: "read-only",
			markdown: journalRecoveryMessage(load),
			footer: { run: "active", attentionCount: 0, text: "steward: active Run · journal read-only recovery" },
		};
	}
	return withJournalRecovery(presentStatusForJournalRaw(load.journal), load.mode, journalRecoveryMessage(load));
}

function presentMultiTaskStatus(journal: RunJournal, note?: string): ActiveStatusView | CompletedStatusView {
	if (journal.run.status === "completed" || journal.run.completion?.phase === "archived") return presentCompletedStatus(journal, note);
	const activePhases = new Set(["building", "reviewing", "reworking"]);
	const codeTasks = journal.run.tasks.filter((task) => task.contract.expectedArtifacts.some((artifact) => artifact.kind === "git-commit"));
	const integrated = codeTasks.filter((task) => task.integration?.phase === "integrated").length;
	const active = journal.run.tasks.filter((task) => activePhases.has(task.phase)).length;
	const approved = journal.run.tasks.filter((task) => task.phase === "approved").length;
	const attention = journal.run.tasks.filter((task) => task.attention !== "none").length;
	const queue = selectIntegrationQueueHead(journal.run);
	const nextIntegration = queue.kind === "ready" || queue.kind === "waiting" ? queue.taskId : "none";
	const lines = [`Run ${journal.run.id}: ${journal.run.status}`, ...(journal.run.finalVerificationExecution ? finalVerificationStatusLines(journal.run.finalVerificationExecution) : []), ...journal.run.tasks.map((task, index) => {
		const attempt = currentAttempt(task);
		const integration = task.integration?.phase ?? (task.contract.expectedArtifacts.some((artifact) => artifact.kind === "git-commit") ? "queued" : "n/a");
		const reason = task.attention !== "none" ? `/${task.attention}${task.attentionReason ? `:${task.attentionReason}` : ""}` : "";
		return `Task ${index + 1} ${task.contract.id}: ${task.phase}${reason} · ${attempt ? `${attempt.role}/${attempt.id}/${attempt.state}` : "no-attempt"} · integration ${integration}${task.integration?.phase === "ambiguous" ? ` · observed ${task.integration.observed.branch ?? "detached"}@${task.integration.observed.head ?? "unknown"}` : task.integration?.phase === "integrated" ? ` · applied @${task.integration.observedHead}` : ""}`;
	}), `Tasks ${integrated}/${codeTasks.length} integrated | Active ${active}/${journal.run.effectiveSettings.maximumActiveTasks} | Approved waiting ${approved} | Attention ${attention} | Next integration ${nextIntegration}`];
	const detail = journal.run.tasks.find((task) => activePhases.has(task.phase) || task.attention !== "none");
	const detailAttempt = detail ? currentAttempt(detail) : undefined;
	if (detail && detailAttempt) {
		lines.push(`Assignment: ${detailAttempt.assignmentPath}${"assignmentSha256" in detailAttempt.dispatch ? ` (${detailAttempt.dispatch.assignmentSha256})` : ""}`);
		lines.push(...integrationStatusLines(detail));
		if (detailAttempt.role === "builder" && detailAttempt.evidence?.phase !== "finalized") lines.push("Completion: not inferred from Herdr activity; awaiting a validated Attempt Report.");
	}
	if (note) lines.push(note);
	return { kind: "present", journalRecovery: "normal", markdown: lines.join("\n"), footer: { run: "active", attentionCount: attention, text: `steward: ${journal.run.id} · ${detail?.phase ?? journal.run.status} · ${attention} attention · ${active}/${journal.run.effectiveSettings.maximumActiveTasks} active` } };
}

function pendingControllerAction(journal: RunJournal): ControllerPendingAction {
	if (journal.run.status === "cancelled" || journal.run.cancellation) return { kind: "none" };
	const finalExecution = journal.run.finalVerificationExecution;
	if (finalExecution && isRecoverableFinalVerificationExecution(finalExecution) && (finalExecution.phase === "executing" || finalExecution.phase === "failed")) return { kind: "final-verification" };
	for (const task of journal.run.tasks) {
		const cancelled = task.attempts.find((candidate) => candidate.state === "cancelled" && (candidate.revisionCancellation?.stop.phase === "intended" || candidate.revisionCancellation?.stop.phase === "ambiguous"));
		if (cancelled?.state === "cancelled" && cancelled.revisionCancellation?.stop.phase === "intended") return { kind: "revision-stop", taskId: task.contract.id, attemptId: cancelled.id, role: cancelled.role };
		if (cancelled?.state === "cancelled" && cancelled.revisionCancellation?.stop.phase === "ambiguous") return { kind: "wait-attention", taskId: task.contract.id, attemptId: cancelled.id, role: cancelled.role };
		const attempt = currentAttempt(task);
		if (attempt && ["prepared", "active", "awaiting-report"].includes(attempt.state) && (attempt.dispatch.phase === "prompt-intended" || attempt.dispatch.phase === "prompted" || attempt.dispatch.phase === "reconciled-active")) return { kind: "reconcile-attempt", taskId: task.contract.id, attemptId: attempt.id, role: attempt.role };
		if (attempt?.role === "builder" && attempt.state === "reported" && attempt.evidence?.phase !== "finalized") return { kind: "validate-builder-evidence", taskId: task.contract.id, attemptId: attempt.id, role: "builder" };
		if (task.phase === "reviewing" && attempt?.role === "reviewer" && attempt.state === "reported") return { kind: attempt.evidence?.phase === "finalized" ? "advance-review" : "validate-approval", taskId: task.contract.id, attemptId: attempt.id, role: "reviewer" };
		if (task.integration && task.integration.phase !== "integrated") return { kind: "integrate-task", taskId: task.contract.id };
		if (task.attention !== "none" && attempt) return { kind: "wait-attention", taskId: task.contract.id, attemptId: attempt.id, role: attempt.role };
		if (task.phase === "approved") return { kind: "integrate-task", taskId: task.contract.id };
	}
	if (journal.run.status === "completing") return { kind: "final-verification" };
	if (journal.run.completion) return { kind: "completion-lifecycle" };
	if (selectTaskAdmission(journal.run).kind === "admit") {
		const admission = selectTaskAdmission(journal.run);
		return admission.kind === "admit" ? { kind: "admit-task", taskId: admission.taskId } : { kind: "none" };
	}
	return { kind: "none" };
}

function continuityBlock(runId: string, journalRevision: number, controllerSessionId: string, pendingAction: ControllerPendingAction): string {
	const identity = "taskId" in pendingAction
		? ` ${pendingAction.taskId}${"attemptId" in pendingAction ? `/${pendingAction.attemptId}/${pendingAction.role}` : ""}`
		: "";
	return [
		"--- Steward Controller Continuity ---",
		`Steward Run: ${runId}`,
		`Verified Journal revision: ${journalRevision}`,
		`Controller Session: ${controllerSessionId}`,
		`Pending Controller action: ${pendingAction.kind}${identity}`,
		"Authoritative recovery source: .pi/steward/active-run.json; reconcile before mutation.",
		"--- End Steward Controller Continuity ---",
	].join("\n");
}

function canonicalTakeoverHash(input: { runId: string; journalRevision: number; previousSessionId: string; previousLeaseId?: string; facts: unknown; pendingAction: ControllerPendingAction }): string {
	return `sha256:${createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex")}`;
}

function silenceStatusLines(journal: RunJournal, task: TaskRecord, attempt: AttemptRecord): string[] {
	const silence = attempt.recovery?.silence;
	if (!silence) return [];
	const used = task.attempts.filter((candidate) => candidate.replacement !== undefined).length;
	const deadline = new Date(nextSilenceDeadline(journal, attempt, new Date(journal.run.updatedAt).getTime())).toISOString();
	return [`Silence recovery: ${silence.phase}`, `Silent replacements: ${used}/${journal.run.effectiveSettings.transientRetryLimit}`, `Next silence deadline: ${deadline}`];
}

function transientStatusLines(journal: RunJournal, task: TaskRecord, attempt: AttemptRecord): string[] {
	const outcomeAttempt = task.attempts.slice().reverse().find((candidate) => candidate.recovery?.infrastructure);
	const outcome = outcomeAttempt?.recovery?.infrastructure;
	const preservation = outcomeAttempt?.recovery?.preservation;
	const replacement = attempt.replacement?.kind === "transient-recovery" ? attempt.replacement : undefined;
	if (!outcome && !replacement) return [];
	const used = task.attempts.filter((candidate) => candidate.replacement !== undefined).length;
	const lines = [`Transient replacements: ${used}/${journal.run.effectiveSettings.transientRetryLimit}`];
	if (outcome) lines.push(`Transient infrastructure: ${outcome.kind}`, `Transient stop: ${outcome.stop.phase}`);
	if (replacement) {
		lines.push(`Transient model: ${replacement.modelSelection.kind === "same-model-first" ? `same model (plan ${replacement.modelSelection.planIndex})` : `approved fallback (plan ${replacement.modelSelection.planIndex}, ${replacement.modelSelection.reason})`}`);
	}
	if (preservation) lines.push("Transient evidence: retained before stop/replacement decision.");
	return lines;
}

function resultForSaveFailure(scope: ConfigurationScope, save: ConfigSaveResult): ConfigureResult {
	return {
		kind: "save-error",
		scope,
		path: save.path,
		diagnostics: save.diagnostics,
		message: `Could not save ${scope} configuration; configuration unchanged at ${save.path}.`,
	};
}

type DispatchOutcome =
	| { kind: "dispatched"; journal: RunJournal; message: string; warnings: string[] }
	| { kind: "pending"; journal: RunJournal; message: string; warnings: string[] };

type EvidenceDecision =
	| { kind: "waiting"; journal: RunJournal; note: string }
	| { kind: "rejected"; journal: RunJournal; note: string }
	| { kind: "finalized"; journal: RunJournal; note: string }
	| { kind: "unaccepted"; journal: RunJournal; note: string };

type ReviewDecision = { journal: RunJournal; note: string; action?: MonitorWorkflowAction; diagnostic?: string };
type CompletionDecision = ReviewDecision & { completed?: boolean };

function evidencePathsFor(attempt: AttemptRecord): EvidencePaths {
	const attemptDirectory = resolve(attempt.assignmentPath, "..");
	return {
		attemptDirectory,
		assignmentPath: attempt.assignmentPath,
		reportPath: attempt.reportPath,
		evidenceDirectory: attempt.evidenceDirectory,
		finalizedDirectory: join(attemptDirectory, "finalized"),
	};
}

function rejectionCode(value: string): import("./run.ts").EvidenceRejectionCode {
	const allowed: readonly import("./run.ts").EvidenceRejectionCode[] = ["assignment-changed", "report-or-evidence-invalid", "scope-violation", "dirty-worktree", "missing-assignment", "assignment-hash-mismatch", "assignment-invalid", "report-invalid", "report-identity-mismatch", "report-model-mismatch", "report-specification-mismatch", "report-check-mismatch", "report-artifact-mismatch", "missing-evidence", "unsafe-path", "size-mismatch", "hash-mismatch", "commit-range-mismatch", "finalization-conflict", "storage-error"];
	return allowed.includes(value as import("./run.ts").EvidenceRejectionCode) ? value as import("./run.ts").EvidenceRejectionCode : "report-invalid";
}

function expectedArtifactIdentity(artifact: import("./attempt-report.ts").ReportedArtifact): string {
	return artifact.kind === "git-commit" ? "git-commit" : artifact.kind === "file" ? `file:${artifact.path}` : `evidence:${artifact.description}`;
}

function buildEvidenceManifest(input: {
	journal: RunJournal;
	task: TaskRecord;
	attempt: AttemptRecord;
	report: BuilderAttemptReport;
	reportSize: number;
	reportSha256: string;
	assignmentSha256: string;
	paths: EvidencePaths;
	files: import("./attempt-evidence-store.ts").ValidatedEvidenceFile[];
	gitFacts?: ProducedCodeArtifactInspection & { kind: "inspected" };
}): import("./run.ts").FinalizedEvidenceManifest {
	const fileFor = (path: string) => input.files.find((file) => file.path === path);
	const artifactFacts = input.report.producedArtifacts.map((artifact, index) => {
		if (artifact.kind === "git-commit") return { kind: "git-commit" as const, identity: "git-commit", originalPath: null, evidencePath: null, finalizedPath: null, size: null, sha256: null };
		const sourcePath = artifact.kind === "file" ? join(input.attempt.dispatch.phase === "worktree-intended" ? "/" : input.attempt.dispatch.worktreePath, ...artifact.path.split("/")) : null;
		const evidencePath = artifact.kind === "file" ? artifact.evidencePath : artifact.path;
		const copied = fileFor(evidencePath);
		return { kind: artifact.kind, identity: expectedArtifactIdentity(artifact), originalPath: sourcePath, evidencePath, finalizedPath: join(input.paths.finalizedDirectory, "artifacts", String(index).padStart(4, "0")), size: copied?.size ?? artifact.size, sha256: copied?.sha256 ?? artifact.sha256 };
	});
	const logs = input.report.logReferences.map((log) => {
		const copied = fileFor(log.path);
		return { id: log.id, originalPath: log.path, finalizedPath: join(input.paths.finalizedDirectory, "logs", `${log.id}.log`), size: copied?.size ?? log.size, sha256: copied?.sha256 ?? log.sha256 };
	});
	return {
		schemaVersion: 1,
		identity: { runId: input.journal.run.id, taskId: input.task.contract.id, attemptId: input.attempt.id, role: "builder" },
		status: input.report.status,
		summary: input.report.summary,
		blockers: [...input.report.blockers],
		actualModel: { ...input.report.actualModel },
		specificationHash: input.task.specificationHash,
		assignmentSha256: input.assignmentSha256,
		report: { originalPath: input.attempt.reportPath, finalizedPath: join(input.paths.finalizedDirectory, "report.md"), size: input.reportSize, sha256: input.reportSha256 },
		checks: input.report.checks.map((check) => ({ ...check })),
		logs,
		artifacts: artifactFacts,
		producedRevision: input.report.producedRevision,
		...(input.gitFacts ? { code: { approvedBase: input.gitFacts.base, producedHead: input.gitFacts.head, commits: [...input.gitFacts.commits], changedPaths: input.gitFacts.changedPaths.map((change) => ({ status: change.status, paths: [...change.paths] })) } } : {}),
	};
}

function activeBuilders(journal: RunJournal): Array<{ task: TaskRecord; index: number; attempt: BuilderAttemptRecord }> {
	return journal.run.tasks.flatMap((task, index) => {
		const attempt = currentAttempt(task);
		const reportEligible = attempt?.state === "active" || attempt?.state === "awaiting-report" || (attempt?.state === "prepared" && attempt.dispatch.phase === "prompt-intended");
		return (task.phase === "building" || task.phase === "reworking") && attempt?.role === "builder" && reportEligible && ["prompt-intended", "prompted", "reconciled-active"].includes(attempt.dispatch.phase) ? [{ task, index, attempt }] : [];
	});
}

function activeBuilder(journal: RunJournal, minimumIndex = 0): { task: TaskRecord; index: number; attempt: BuilderAttemptRecord } | undefined {
	return activeBuilders(journal).find((candidate) => candidate.index >= minimumIndex);
}

function rejectionSummary(codes: readonly string[], details: readonly string[]): string {
	const suffix = details.length > 0 ? ` ${details.join(" ")}` : "";
	return `${codes.join(", ")}.${suffix}`.slice(0, 2_000);
}

function rejectionEquivalent(left: BuilderEvidenceRecord | undefined, right: BuilderEvidenceRecord): boolean {
	return Boolean(left?.phase === "rejected" && right.phase === "rejected" && left.reportSha256 === right.reportSha256 && JSON.stringify(left.codes) === JSON.stringify(right.codes) && left.summary === right.summary);
}

function intentEquivalent(left: BuilderEvidenceRecord | undefined, right: BuilderEvidenceRecord): boolean {
	return Boolean(left?.phase === "finalization-intended" && right.phase === "finalization-intended" && left.reportSha256 === right.reportSha256 && left.manifestPath === right.manifestPath && left.manifestSha256 === right.manifestSha256);
}

async function validateActiveBuilderEvidence(repositoryRoot: string, controllerSessionId: string, loadedJournal: RunJournal, dependencies: StewardDependencies, selectedInput?: { task: TaskRecord; index: number; attempt: BuilderAttemptRecord }): Promise<EvidenceDecision> {
	const selected = selectedInput ?? activeBuilder(loadedJournal);
	if (!selected) return { kind: "waiting", journal: loadedJournal, note: "Evidence validation is waiting for exactly one active prompted Builder Attempt." };
	let { task, attempt } = selected;
	const paths = evidencePathsFor(attempt);
	let deterministic: AssignmentPaths;
	try {
		deterministic = dependencies.runJournal.resolveAssignmentPaths(repositoryRoot, loadedJournal.run.id, task.contract.id, attempt.id);
	} catch (error: unknown) {
		return persistEvidenceRejection(repositoryRoot, loadedJournal, task, attempt, dependencies, ["assignment-changed"], [error instanceof Error ? error.message : "Assignment path derivation failed."]);
	}
	if (deterministic.assignmentPath !== attempt.assignmentPath || deterministic.reportPath !== attempt.reportPath || deterministic.evidenceDirectory !== attempt.evidenceDirectory || loadedJournal.run.controllerSessionId !== controllerSessionId) return { kind: "waiting", journal: loadedJournal, note: "Controller authority or deterministic Assignment paths do not match; status is read-only." };
	if (!dependencies.runJournal.loadBuilderEvidenceInputs || !dependencies.runJournal.inspectReferencedEvidence || !dependencies.runJournal.finalizeBuilderEvidence) return { kind: "waiting", journal: loadedJournal, note: "Builder evidence adapters are unavailable; evidence remains unaccepted." };
	let inputs: import("./attempt-evidence-store.ts").BuilderEvidenceInputs;
	try {
		inputs = await dependencies.runJournal.loadBuilderEvidenceInputs({ repositoryRoot, paths, assignmentSha256: hasAssignmentIdentity(attempt) ? attempt.dispatch.assignmentSha256 : "" });
	} catch (error: unknown) {
		return persistEvidenceRejection(repositoryRoot, loadedJournal, task, attempt, dependencies, ["report-or-evidence-invalid"], [error instanceof Error ? error.message : "Evidence input loading failed."]);
	}
	if (inputs.kind === "report-missing") return { kind: "waiting", journal: loadedJournal, note: `Attempt Report is not present yet at ${attempt.reportPath}; completion is not inferred from Herdr activity.` };
	if (inputs.kind === "unsafe") {
		const top = inputs.code === "assignment-hash-mismatch" ? "assignment-changed" : "report-or-evidence-invalid";
		return persistEvidenceRejection(repositoryRoot, loadedJournal, task, attempt, dependencies, [top], [inputs.code, inputs.message], inputs.reportSha256);
	}
	const reportContent = inputs.reportBytes.toString("utf8");
	if (attempt.evidence?.phase === "rejected" && attempt.evidence.reportSha256 === inputs.reportSha256) return { kind: "rejected", journal: loadedJournal, note: `Evidence rejected (${attempt.evidence.codes.join(", ")}) for unchanged report hash; preserved evidence was not rewritten.` };
	if (attempt.evidence?.phase === "finalization-intended" && attempt.evidence.reportSha256 !== inputs.reportSha256) return { kind: "unaccepted", journal: loadedJournal, note: "A finalization was intended for different report bytes; the preserved snapshot remains unaccepted and no changed report was reparsed." };
	const parsed = parseBuilderAttemptReport(reportContent);
	if (!parsed.value || parsed.diagnostics.length > 0) return persistEvidenceRejection(repositoryRoot, loadedJournal, task, attempt, dependencies, ["report-or-evidence-invalid"], parsed.diagnostics.map((item) => `${item.code}: ${item.message}`), inputs.reportSha256);
	const assignmentDecoded = deserializeBuilderAssignment(inputs.assignmentBytes.toString("utf8"), attempt.assignmentPath);
	if (!assignmentDecoded.value || assignmentDecoded.diagnostics.length > 0) return persistEvidenceRejection(repositoryRoot, loadedJournal, task, attempt, dependencies, ["report-or-evidence-invalid"], assignmentDecoded.diagnostics.map((item) => item.message), inputs.reportSha256);
	const cross = validateBuilderReportAgainstAssignment({ report: parsed.value, assignment: assignmentDecoded.value, assignmentSha256: inputs.assignmentSha256, runId: loadedJournal.run.id, task: task.contract, attempt, baseRevision: attempt.baseRevision });
	if (!cross.value || cross.diagnostics.length > 0) {
		const assignmentChanged = cross.diagnostics.some((item) => item.code === "assignment-changed");
		const scopeViolation = cross.diagnostics.some((item) => item.code === "scope-violation");
		return persistEvidenceRejection(repositoryRoot, loadedJournal, task, attempt, dependencies, [assignmentChanged ? "assignment-changed" : scopeViolation ? "scope-violation" : "report-or-evidence-invalid"], cross.diagnostics.map((item) => `${item.code}: ${item.message}`), inputs.reportSha256);
	}
	let referenced: import("./attempt-evidence-store.ts").ReferencedEvidenceResult;
	try {
		referenced = await dependencies.runJournal.inspectReferencedEvidence({ repositoryRoot, paths, report: parsed.value, worktreePath: assignmentDecoded.value.assignment.worktree.path });
	} catch (error: unknown) {
		return persistEvidenceRejection(repositoryRoot, loadedJournal, task, attempt, dependencies, ["report-or-evidence-invalid"], [error instanceof Error ? error.message : "Referenced evidence inspection failed."], inputs.reportSha256);
	}
	if (referenced.kind !== "inspected") return persistEvidenceRejection(repositoryRoot, loadedJournal, task, attempt, dependencies, ["report-or-evidence-invalid"], [referenced.code, referenced.message], inputs.reportSha256);
	let gitFacts: Extract<ProducedCodeArtifactInspection, { kind: "inspected" }> | undefined;
	const gitArtifact = parsed.value.producedArtifacts.find((artifact): artifact is import("./attempt-report.ts").ReportedArtifactGitCommit => artifact.kind === "git-commit");
	if (gitArtifact) {
		if (!dependencies.git.inspectProducedCodeArtifact) return persistEvidenceRejection(repositoryRoot, loadedJournal, task, attempt, dependencies, ["report-or-evidence-invalid"], ["git-inspection-unavailable"], inputs.reportSha256);
		let inspected: ProducedCodeArtifactInspection;
		try { inspected = await dependencies.git.inspectProducedCodeArtifact({ worktreePath: assignmentDecoded.value.assignment.worktree.path, approvedBase: attempt.baseRevision, producedHead: gitArtifact.headRevision }); } catch (error: unknown) { return persistEvidenceRejection(repositoryRoot, loadedJournal, task, attempt, dependencies, ["report-or-evidence-invalid"], [error instanceof Error ? error.message : "Git Artifact inspection failed."], inputs.reportSha256); }
		if (inspected.kind === "invalid") {
			if (inspected.code === "dirty-worktree" || inspected.code === "git-operation-in-progress") return persistEvidenceRejection(repositoryRoot, loadedJournal, task, attempt, dependencies, ["dirty-worktree"], [inspected.message, ...(inspected.dirtyPaths ?? [])], inputs.reportSha256);
			return persistEvidenceRejection(repositoryRoot, loadedJournal, task, attempt, dependencies, ["report-or-evidence-invalid"], [inspected.code, inspected.message], inputs.reportSha256);
		}
		const gitDiagnostics = validateReportedGitFacts(gitArtifact, inspected);
		if (gitDiagnostics.length > 0) return persistEvidenceRejection(repositoryRoot, loadedJournal, task, attempt, dependencies, ["report-or-evidence-invalid"], gitDiagnostics.map((item) => item.message), inputs.reportSha256);
		if (!changedPathsInAllowedScope(inspected, task.contract.allowedScope)) return persistEvidenceRejection(repositoryRoot, loadedJournal, task, attempt, dependencies, ["scope-violation"], ["Git Artifact changed a path outside allowedScope."], inputs.reportSha256);
		gitFacts = inspected;
	}
	let journal = loadedJournal;
	if (attempt.state === "prepared" && attempt.dispatch.phase === "prompt-intended") {
		const reconciledAt = transitionTimestamp(journal, dependencies.clock.now());
		let promoted: RunJournal;
		try {
			promoted = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
				const nextTask = next.run.tasks.find((candidateTask) => candidateTask.contract.id === task.contract.id);
				const nextAttempt = nextTask?.attempts.find((candidate) => candidate.id === attempt.id);
				if (!nextTask || !nextAttempt || nextAttempt.role !== "builder" || nextAttempt.state !== "prepared" || nextAttempt.dispatch.phase !== "prompt-intended") throw new Error("Builder Attempt disappeared before valid-report reconciliation.");
				promoteMatchingDispatch(nextTask, nextAttempt, reconciledAt, "valid-report");
			});
		} catch (error: unknown) {
			return { kind: "unaccepted", journal, note: `Valid Builder report could not first reconcile its prepared dispatch; no evidence finalization was attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` };
		}
		const persistedPromotion = await dependencies.runJournal.replaceActive(repositoryRoot, promoted);
		if (persistedPromotion.kind !== "replaced") return { kind: "unaccepted", journal, note: "Valid Builder report reconciliation lost a Journal race; no evidence finalization was attempted." };
		journal = persistedPromotion.journal;
		const refreshedTask = journal.run.tasks.find((candidateTask) => candidateTask.contract.id === task.contract.id);
		const refreshedAttempt = refreshedTask?.attempts.find((candidate) => candidate.id === attempt.id);
		if (!refreshedTask || !refreshedAttempt || refreshedAttempt.role !== "builder") return { kind: "unaccepted", journal, note: "Valid Builder report reconciliation changed the current Attempt; no evidence finalization was attempted." };
		task = refreshedTask;
		attempt = refreshedAttempt;
	}
	const manifest = buildEvidenceManifest({ journal, task, attempt, report: parsed.value, reportSize: inputs.reportBytes.length, reportSha256: inputs.reportSha256, assignmentSha256: inputs.assignmentSha256, paths, files: referenced.files, ...(gitFacts ? { gitFacts } : {}) });
	const manifestBytes = Buffer.from(serializeFinalizedEvidenceManifest(manifest), "utf8");
	const manifestSha256 = finalizedEvidenceManifestSha256(manifest);
	const intent: BuilderEvidenceRecord = { phase: "finalization-intended", checkedAt: transitionTimestamp(journal, dependencies.clock.now()), reportSha256: inputs.reportSha256, manifestPath: join(paths.finalizedDirectory, "manifest.json"), manifestSha256 };
	if (!intentEquivalent(attempt.evidence, intent)) {
		const candidate = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
			const nextAttempt = [...(next.run.tasks.find((candidateTask) => candidateTask.contract.id === task.contract.id)?.attempts ?? [])].reverse().find((candidate): candidate is BuilderAttemptRecord => candidate.role === "builder");
			if (!nextAttempt) throw new Error("Builder Attempt disappeared before finalization intent.");
			nextAttempt.evidence = intent;
		});
		const persisted = await dependencies.runJournal.replaceActive(repositoryRoot, candidate);
		if (persisted.kind !== "replaced") return { kind: "unaccepted", journal, note: "Finalization intent could not be persisted; no evidence was accepted." };
		journal = persisted.journal;
	}
	const copies = referenced.files.filter((file) => parsed.value!.logReferences.some((log) => log.path === file.path)).map((file, index) => finalizationCopyForLog(parsed.value!.logReferences.find((log) => log.path === file.path)!, file.bytes, index));
	for (let index = 0; index < parsed.value.producedArtifacts.length; index += 1) {
		const artifact = parsed.value.producedArtifacts[index]!;
		if (artifact.kind === "git-commit") continue;
		const file = referenced.files.find((candidate) => candidate.path === (artifact.kind === "file" ? artifact.evidencePath : artifact.path));
		if (file) copies.push(finalizationCopyForArtifact(artifact, file.bytes, index));
	}
	const finalization = await dependencies.runJournal.finalizeBuilderEvidence({ paths, assignmentBytes: inputs.assignmentBytes, reportBytes: inputs.reportBytes, manifestBytes, manifestSha256, copies, originalPaths: [attempt.assignmentPath, attempt.reportPath, ...referenced.files.map((file) => file.path)] });
	if (finalization.kind === "conflict") return persistEvidenceRejection(repositoryRoot, journal, task, attempt, dependencies, ["report-or-evidence-invalid"], ["finalization-conflict", finalization.message], inputs.reportSha256);
	if (finalization.kind === "storage-error") return { kind: "unaccepted", journal, note: `Evidence snapshot could not be completed: ${finalization.message}` };
	if (finalization.kind !== "created" && finalization.kind !== "existing-match") return { kind: "unaccepted", journal, note: "Evidence snapshot could not be completed." };
	const finalized: BuilderEvidenceRecord = { phase: "finalized", finalizedAt: transitionTimestamp(journal, dependencies.clock.now()), status: parsed.value.status, reportSha256: inputs.reportSha256, manifestPath: finalization.manifestPath, manifestSha256: finalization.manifestSha256, producedRevision: parsed.value.producedRevision };
	const reportedJournal = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
		const nextAttempt = [...(next.run.tasks.find((candidateTask) => candidateTask.contract.id === task.contract.id)?.attempts ?? [])].reverse().find((candidate): candidate is BuilderAttemptRecord => candidate.role === "builder");
		if (!nextAttempt) throw new Error("Builder Attempt disappeared before finalization.");
		nextAttempt.state = "reported";
		delete nextAttempt.recovery;
		nextAttempt.evidence = finalized;
	});
	const replaced = await dependencies.runJournal.replaceActive(repositoryRoot, reportedJournal);
	if (replaced.kind !== "replaced") return { kind: "unaccepted", journal, note: "Evidence snapshot was created but the Run Journal was not updated to reported/finalized." };
	await dependencies.runJournal.appendActivity(repositoryRoot, { timestamp: replaced.journal.run.updatedAt, runId: replaced.journal.run.id, event: "builder-evidence-finalized", message: `Builder Attempt ${attempt.id} evidence finalized; Review is required but not started by ticket 05.` }).catch(() => undefined);
	return { kind: "finalized", journal: replaced.journal, note: "" };
}

async function persistEvidenceRejection(repositoryRoot: string, journal: RunJournal, task: TaskRecord, attempt: AttemptRecord, dependencies: StewardDependencies, topCodes: string[], details: string[], reportSha256?: string): Promise<EvidenceDecision> {
	const codes = [...new Set(topCodes.concat(details.map((detail) => detail.split(":")[0] ?? "").map(rejectionCode)))].map(rejectionCode);
	const rejection: BuilderEvidenceRecord = { phase: "rejected", checkedAt: transitionTimestamp(journal, dependencies.clock.now()), ...(reportSha256 ? { reportSha256 } : {}), codes: codes.length > 0 ? codes : ["report-or-evidence-invalid"], summary: rejectionSummary(codes, details) };
	const currentAttempt = [...(journal.run.tasks.find((candidate) => candidate.contract.id === task.contract.id)?.attempts ?? [])].reverse().find((candidate): candidate is BuilderAttemptRecord => candidate.role === "builder");
	if (!currentAttempt || currentAttempt.role !== "builder") return { kind: "rejected", journal, note: "Builder evidence rejection could not find the Builder Attempt; preserved state remains authoritative." };
	if (currentAttempt && rejectionEquivalent(currentAttempt.evidence, rejection)) return { kind: "rejected", journal, note: `Evidence rejected (${rejection.codes.join(", ")}); preserved bytes were not rewritten.` };
	const candidate = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
		const nextAttempt = [...(next.run.tasks.find((candidateTask) => candidateTask.contract.id === task.contract.id)?.attempts ?? [])].reverse().find((candidate): candidate is BuilderAttemptRecord => candidate.role === "builder");
		if (!nextAttempt) throw new Error("Builder Attempt disappeared while retaining evidence rejection.");
		if (nextAttempt.role !== "builder") throw new Error("Reviewer Attempt cannot receive Builder evidence.");
		nextAttempt.evidence = rejection;
	});
	const replaced = await dependencies.runJournal.replaceActive(repositoryRoot, candidate);
	if (replaced.kind !== "replaced") return { kind: "unaccepted", journal, note: `Evidence rejected (${rejection.codes.join(", ")}); durable rejection write failed and original evidence was preserved.` };
	await dependencies.runJournal.appendActivity(repositoryRoot, { timestamp: replaced.journal.run.updatedAt, runId: replaced.journal.run.id, event: "builder-evidence-rejected", message: `Builder Attempt ${attempt.id} evidence rejected: ${rejection.codes.join(", ")}.` }).catch(() => undefined);
	return { kind: "rejected", journal: replaced.journal, note: `Evidence rejected (${rejection.codes.join(", ")}); Review is blocked and original evidence is preserved.` };
}

function compactUuid(clock: StewardClockAdapter): string {
	const value = clock.randomUUID().replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 8);
	if (value.length === 0) throw new Error("Clock randomUUID must provide identity material.");
	return value;
}

function reviewTaskCandidate(journal: RunJournal, minimumIndex = 0): { task: TaskRecord; index: number; builder: BuilderAttemptRecord } | undefined {
	for (let index = minimumIndex; index < journal.run.tasks.length; index += 1) {
		const task = journal.run.tasks[index];
		if (!task || !task.contract.reviewRequired) continue;
		const latest = currentAttempt(task);
		const pausedBeforeReviewer = task.attention === "needs-user" && currentAttempts(task).length === 1;
		if ((task.attention !== "none" && !pausedBeforeReviewer) || (task.phase !== "reviewing" && task.phase !== "reworking" && task.phase !== "building") || latest?.role !== "builder") continue;
		const builder = latest;
		if (builder.state === "reported" && builder.evidence?.phase === "finalized" && builder.evidence.status === "completed") return { task, index, builder };
	}
	return undefined;
}

function reviewerForTask(task: TaskRecord): ReviewerAttemptRecord | undefined {
	const latest = currentAttempt(task);
	return latest?.role === "reviewer" ? latest : undefined;
}

function reviewerTaskCandidate(journal: RunJournal, minimumIndex = 0): { task: TaskRecord; index: number; builder: BuilderAttemptRecord; reviewer: ReviewerAttemptRecord } | undefined {
	for (let index = minimumIndex; index < journal.run.tasks.length; index += 1) {
		const task = journal.run.tasks[index];
		if (!task || !task.contract.reviewRequired || task.phase !== "reviewing" || task.attention !== "none") continue;
		const reviewer = reviewerForTask(task);
		const preceding = currentAttempts(task).at(-2);
		if (!reviewer || !preceding || preceding.role !== "builder") continue;
		if (preceding.state === "reported" && preceding.evidence?.phase === "finalized" && preceding.evidence.status === "completed") return { task, index, builder: preceding, reviewer };
	}
	return undefined;
}

function latestReviewerAttempt(task: TaskRecord): ReviewerAttemptRecord | undefined {
	return [...currentAttempts(task)].reverse().find((attempt): attempt is ReviewerAttemptRecord => attempt.role === "reviewer");
}

function reviewSnapshotFor(value: import("./run.ts").ReviewWorktreeSnapshot): import("./run.ts").ReviewWorktreeSnapshot {
	return { ...value, dirtyPaths: [...value.dirtyPaths], operationMarkers: [...value.operationMarkers] };
}

async function persistReviewJournal(repositoryRoot: string, journal: RunJournal, dependencies: StewardDependencies): Promise<RunJournal | undefined> {
	try {
		const replaced = await dependencies.runJournal.replaceActive(repositoryRoot, journal);
		return replaced.kind === "replaced" ? replaced.journal : undefined;
	} catch {
		return undefined;
	}
}

async function pauseReview(repositoryRoot: string, candidate: { task: TaskRecord; index: number }, journal: RunJournal, dependencies: StewardDependencies, note: string): Promise<ReviewDecision> {
	if (candidate.task.phase === "reviewing" && candidate.task.attention === "needs-user") return { journal, note };
	let paused: RunJournal;
	try {
		paused = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
			const task = next.run.tasks[candidate.index];
			if (!task) throw new Error("Review Task disappeared while pausing.");
			task.phase = "reviewing";
			task.attention = "needs-user";
			task.attentionDiagnostic = note.slice(0, 2_000);
			const latest = currentAttempt(task);
			if (latest?.role === "reviewer" && latest.evidence?.phase === "finalized" && latest.evidence.verdict === "changes-required") {
				const reason: TaskAttentionReason = note.includes("frozen rework limit") ? "rework-exhausted" : note.startsWith("Rework") || note.startsWith("Automatic same-Builder") ? "rework-preflight" : "protected-evidence";
				task.attentionReason = reason;
			}
		});
	} catch (error: unknown) {
		return { journal, note: `${note} Durable pause could not be built: ${error instanceof Error ? error.message : "Journal validation failed."}` };
	}
	const persisted = await persistReviewJournal(repositoryRoot, paused, dependencies);
	if (!persisted) return { journal, note: `${note} Durable pause could not be persisted; the existing Journal remains authoritative.` };
	await dependencies.runJournal.appendActivity(repositoryRoot, { timestamp: persisted.run.updatedAt, runId: persisted.run.id, event: "review-needs-user", message: note }).catch(() => undefined);
	return { journal: persisted, note };
}

function reviewerDispatchAttempt(attempt: ReviewerAttemptRecord, dispatch: ReviewerAttemptRecord["dispatch"]): ReviewerAttemptRecord {
	return { ...attempt, dispatch };
}

async function deriveReviewSubject(candidate: { runId: string; task: TaskRecord; builder: BuilderAttemptRecord }, dependencies: StewardDependencies): Promise<{ subject?: ReviewSubject; manifestPath?: string; manifestSha256?: string; message?: string }> {
	const evidence = candidate.builder.evidence;
	if (!evidence || evidence.phase !== "finalized") return { message: "Completed Builder evidence is not finalized." };
	if (!dependencies.runJournal.loadFinalizedEvidenceManifest) return { message: "Finalized Builder manifest loading is unavailable; Review dispatch is pending." };
	const loaded = await dependencies.runJournal.loadFinalizedEvidenceManifest({ manifestPath: evidence.manifestPath, manifestSha256: evidence.manifestSha256 });
	if (loaded.kind !== "loaded") return { message: loaded.message };
	const parsed = deserializeFinalizedBuilderEvidenceManifest(loaded.bytes.toString("utf8"), loaded.sha256);
	if (!parsed.value) return { message: parsed.message ?? "Finalized Builder manifest is invalid." };
	const subject = reviewSubjectFromFinalizedBuilderEvidence({ manifest: parsed.value, manifestBytes: loaded.bytes, manifestSha256: loaded.sha256, runId: candidate.runId, taskId: candidate.task.contract.id, builderAttemptId: candidate.builder.id, builderBaseRevision: candidate.builder.baseRevision, builderProducedRevision: evidence.producedRevision });
	return { subject: subject.value, manifestPath: evidence.manifestPath, manifestSha256: evidence.manifestSha256, message: subject.message };
}

async function recordReviewerViolation(repositoryRoot: string, journal: RunJournal, candidate: { index: number; task: TaskRecord }, reviewer: ReviewerAttemptRecord, after: import("./run.ts").ReviewWorktreeSnapshot, dependencies: StewardDependencies): Promise<ReviewDecision> {
	if (reviewer.integrity?.kind === "violated" && worktreeSnapshotsEqual(reviewer.integrity.after, after) && candidate.task.attention === "needs-user") return { journal, note: "Reviewer worktree changed; read-only violation is retained and no verdict was accepted." };
	let violated: RunJournal;
	try {
		violated = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
			const task = next.run.tasks[candidate.index];
			const attempt = task ? latestReviewerAttempt(task) : undefined;
			if (!task || !attempt) throw new Error("Reviewer Attempt disappeared while recording the read-only violation.");
			task.attention = "needs-user";
			attempt.integrity = { kind: "violated", detectedAt: transitionTimestamp(journal, dependencies.clock.now()), before: reviewSnapshotFor(attempt.worktree.baseline), after: reviewSnapshotFor(after), code: "reviewer-modified-worktree" };
		});
	} catch (error: unknown) {
		return { journal, note: `Reviewer worktree changed, but the read-only violation could not be built durably: ${error instanceof Error ? error.message : "Journal validation failed."}` };
	}
	const persisted = await persistReviewJournal(repositoryRoot, violated, dependencies);
	if (!persisted) return { journal, note: "Reviewer worktree changed; durable violation write failed, and original report/evidence bytes were preserved." };
	await dependencies.runJournal.appendActivity(repositoryRoot, { timestamp: persisted.run.updatedAt, runId: persisted.run.id, event: "reviewer-read-only-violation", message: `Reviewer Attempt ${reviewer.id} changed the assigned worktree; verdict was not accepted.` }).catch(() => undefined);
	return { journal: persisted, note: "Reviewer worktree changed; read-only violation is retained, attention is needs-user, and no verdict was accepted." };
}

function repairDiagnosticText(values: readonly string[]): string[] {
	return (values.length > 0 ? values : ["Reviewer report or referenced evidence is incomplete."]).map((value) => value.slice(0, 2_000)).slice(0, 8);
}

async function retainReviewerRepairFailure(repositoryRoot: string, journal: RunJournal, candidate: { index: number; task: TaskRecord }, reviewer: ReviewerAttemptRecord, failure: ReportRepairFailure, details: readonly string[], observedReportSha256: string | null, dependencies: StewardDependencies): Promise<ReviewDecision> {
	const diagnostics = repairDiagnosticText(details);
	if (reviewer.reportRepair?.phase === "blocked") return { journal, note: "Reviewer report repair is already blocked; no further prompt was sent." };
	if (reviewer.reportRepair?.phase === "requested") {
		let blocked: RunJournal;
		try {
			blocked = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
				const task = next.run.tasks[candidate.index];
				const attempt = task ? currentAttempt(task) : undefined;
				if (!task || !attempt || attempt.role !== "reviewer") throw new Error("Reviewer Attempt disappeared while blocking report repair.");
				if (reviewer.reportRepair?.phase !== "requested") throw new Error("Reviewer repair is not in requested state.");
				attempt.reportRepair = { ...reviewer.reportRepair, phase: "blocked", secondFailure: failure, secondDiagnostics: diagnostics, secondObservedReportSha256: observedReportSha256, blockedAt: transitionTimestamp(journal, dependencies.clock.now()) };
				task.attention = "blocked";
			});
		} catch (error: unknown) { return { journal, note: `Reviewer report repair remains invalid; durable block could not be built. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
		const persisted = await persistReviewJournal(repositoryRoot, blocked, dependencies);
		return persisted ? { journal: persisted, note: "Reviewer report repair failed a second time; Task is blocked and no further prompt will be sent." } : { journal, note: "Reviewer report repair failed a second time; durable block write failed and no further prompt was sent." };
	}
	if (reviewer.reportRepair?.phase === "request-intended") return { journal, note: "Reviewer report repair was already intended; no duplicate repair prompt was sent." };
	if (!hasProvenAgentIdentity(reviewer) || !dependencies.herdr.promptReviewer) return { journal, note: "Reviewer report is repairable, but the same Reviewer prompt adapter is unavailable; no repair was attempted." };
	let intended: RunJournal;
	try {
		intended = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
			const task = next.run.tasks[candidate.index];
				const attempt = task ? currentAttempt(task) : undefined;
			if (!task || !attempt || attempt.role !== "reviewer") throw new Error("Reviewer Attempt disappeared before repair intent.");
			attempt.reportRepair = { phase: "request-intended", failure, diagnostics, observedReportSha256, intendedAt: transitionTimestamp(journal, dependencies.clock.now()) };
		});
	} catch (error: unknown) { return { journal, note: `Reviewer report repair intent could not be built; no prompt was sent. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
	const persistedIntent = await persistReviewJournal(repositoryRoot, intended, dependencies);
	if (!persistedIntent) return { journal, note: "Reviewer report repair intent could not be persisted; no prompt was sent." };
	const assignmentPrompt = [
		"Steward Reviewer report repair request",
		"Repair only the existing Reviewer Attempt Report and its referenced evidence.",
		`Attempt: ${reviewer.id}`,
		`Assignment: ${reviewer.assignmentPath}`,
		`Report: ${reviewer.reportPath}`,
		`Evidence directory: ${reviewer.evidenceDirectory}`,
		`Immutable Review subject: ${JSON.stringify(reviewer.subject)}`,
		`Validation failures: ${diagnostics.join(" ")}`,
		"Do not modify the Review subject or worktree and do not dispatch another agent.",
	].join("\n");
	let prompted: HerdrPromptResult;
	try { prompted = await dependencies.herdr.promptReviewer({ repositoryRoot, name: reviewer.dispatch.agentName, assignmentPrompt }); }
	catch (error: unknown) { return { journal: persistedIntent, note: `Reviewer report repair prompt failed; request-intended state is retained without a resend. ${error instanceof Error ? error.message : "Herdr prompt failed."}` }; }
	if (prompted.kind !== "prompted" || prompted.name !== reviewer.dispatch.agentName || prompted.workspaceId !== reviewer.dispatch.workspaceId || prompted.paneId !== reviewer.dispatch.paneId || prompted.terminalId !== reviewer.dispatch.terminalId || !validIdentity(prompted.tabId)) return { journal: persistedIntent, note: "Reviewer report repair prompt envelope was malformed; request-intended state is retained without a resend." };
	let requested: RunJournal;
	try {
		requested = advanceRunJournal(persistedIntent, dependencies.clock.now(), (next) => {
			const task = next.run.tasks[candidate.index];
				const attempt = task ? currentAttempt(task) : undefined;
			if (!task || !attempt || attempt.role !== "reviewer" || attempt.reportRepair?.phase !== "request-intended") throw new Error("Reviewer repair intent disappeared after prompt.");
			attempt.reportRepair = { ...attempt.reportRepair, phase: "requested", requestedAt: transitionTimestamp(persistedIntent, dependencies.clock.now()) };
		});
	} catch (error: unknown) { return { journal: persistedIntent, note: `Reviewer report repair prompt succeeded but requested state could not be persisted; no resend will be attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
	const persistedRequested = await persistReviewJournal(repositoryRoot, requested, dependencies);
	return persistedRequested ? { journal: persistedRequested, note: `Reviewer Attempt ${reviewer.id} received one repair prompt; awaiting repaired report.` } : { journal: persistedIntent, note: "Reviewer report repair prompt succeeded but requested state could not be persisted; no resend will be attempted." };
}

async function validateActiveReviewerReport(repositoryRoot: string, journal: RunJournal, candidate: { index: number; task: TaskRecord; builder: BuilderAttemptRecord }, reviewer: ReviewerAttemptRecord, dependencies: StewardDependencies, advanceVerdict = true): Promise<ReviewDecision> {
	if (!dependencies.git.inspectReviewWorktree || !dependencies.runJournal.loadReviewerEvidenceInputs || !dependencies.runJournal.inspectReferencedReviewerEvidence || !dependencies.runJournal.finalizeReviewerEvidence) return { journal, note: "Review evidence adapters are unavailable; Review remains pending and no verdict was inferred." };
	let before: import("./run.ts").ReviewWorktreeSnapshot | { kind: "unavailable"; message: string };
	try { before = await dependencies.git.inspectReviewWorktree(reviewer.worktree.path); } catch (error: unknown) { return { journal, note: `Reviewer worktree inspection failed; no verdict was inferred. ${error instanceof Error ? error.message : "Inspection failed."}` }; }
	if ("kind" in before) return { journal, note: `Reviewer worktree inspection is unavailable; no verdict was inferred. ${before.message}` };
	if (!worktreeSnapshotsEqual(before, reviewer.worktree.baseline)) return recordReviewerViolation(repositoryRoot, journal, candidate, reviewer, before, dependencies);
	if (reviewer.integrity?.kind === "violated") return { journal, note: "Reviewer read-only violation is retained; finalized evidence bytes are preserved and no verdict is eligible." };
	if (reviewer.state === "reported" && reviewer.evidence?.phase === "finalized") return interpretReviewerVerdict(repositoryRoot, journal, candidate, reviewer, dependencies);
	const paths = evidencePathsFor(reviewer);
	const assignmentSha256 = hasAssignmentIdentity(reviewer) ? reviewer.dispatch.assignmentSha256 : "";
	let inputs: import("./attempt-evidence-store.ts").ReviewerEvidenceInputs;
	try { inputs = await dependencies.runJournal.loadReviewerEvidenceInputs({ repositoryRoot, paths, assignmentSha256 }); } catch (error: unknown) { return { journal, note: `Reviewer evidence loading failed; no verdict was inferred. ${error instanceof Error ? error.message : "Evidence loading failed."}` }; }
	if (inputs.kind === "report-missing") return retainReviewerRepairFailure(repositoryRoot, journal, candidate, reviewer, "missing-report", [`Reviewer Attempt Report is missing at ${reviewer.reportPath}.`], null, dependencies);
	if (inputs.kind === "unsafe") {
		if (["report-invalid", "missing-evidence", "hash-mismatch", "unsafe-path"].includes(inputs.code)) return retainReviewerRepairFailure(repositoryRoot, journal, candidate, reviewer, inputs.code === "report-invalid" ? "malformed-report" : "evidence-incomplete", [inputs.code, inputs.message], inputs.reportSha256 ?? null, dependencies);
		return { journal, note: `Reviewer evidence is not accepted (${inputs.code}); preserved bytes remain authoritative and no verdict was inferred.` };
	}
	const parsed = parseReviewerAttemptReport(inputs.reportBytes.toString("utf8"));
	if (!parsed.value || parsed.diagnostics.length > 0) return retainReviewerRepairFailure(repositoryRoot, journal, candidate, reviewer, "malformed-report", parsed.diagnostics.map((item) => `${item.code}: ${item.message}`), inputs.reportSha256, dependencies);
	const assignment = deserializeReviewerAssignment(inputs.assignmentBytes.toString("utf8"), reviewer.assignmentPath);
	if (!assignment.value || assignment.diagnostics.length > 0) return { journal, note: "Reviewer Assignment is invalid or changed; preserved bytes remain authoritative and no verdict was inferred." };
	const cross = validateReviewerReportAgainstAssignment({ report: parsed.value, assignment: assignment.value, assignmentSha256: inputs.assignmentSha256, runId: journal.run.id, task: candidate.task.contract, attempt: reviewer });
	if (!cross.value || cross.diagnostics.length > 0) {
		const repairable = cross.diagnostics.every((item) => ["model-mismatch", "subject-mismatch", "specification-mismatch"].includes(item.code));
		return repairable ? retainReviewerRepairFailure(repositoryRoot, journal, candidate, reviewer, "malformed-report", cross.diagnostics.map((item) => `${item.code}: ${item.message}`), inputs.reportSha256, dependencies) : { journal, note: `Reviewer Attempt Report is not accepted (${cross.diagnostics.map((item) => item.code).join(", ")}); no verdict was inferred.` };
	}
	let referenced: import("./attempt-evidence-store.ts").ReferencedReviewerEvidenceResult;
	try { referenced = await dependencies.runJournal.inspectReferencedReviewerEvidence({ repositoryRoot, paths, logReferences: parsed.value.logReferences }); } catch (error: unknown) { return { journal, note: `Reviewer evidence inspection failed; no verdict was inferred. ${error instanceof Error ? error.message : "Inspection failed."}` }; }
	if (referenced.kind !== "inspected") return retainReviewerRepairFailure(repositoryRoot, journal, candidate, reviewer, "evidence-incomplete", [referenced.code, referenced.message], inputs.reportSha256, dependencies);
	let after: import("./run.ts").ReviewWorktreeSnapshot | { kind: "unavailable"; message: string };
	try { after = await dependencies.git.inspectReviewWorktree(reviewer.worktree.path); } catch (error: unknown) { return { journal, note: `Reviewer worktree inspection failed before finalization; no verdict was inferred. ${error instanceof Error ? error.message : "Inspection failed."}` }; }
	if ("kind" in after) return { journal, note: `Reviewer worktree inspection is unavailable before finalization; no verdict was inferred. ${after.message}` };
	if (!worktreeSnapshotsEqual(after, reviewer.worktree.baseline)) return recordReviewerViolation(repositoryRoot, journal, candidate, reviewer, after, dependencies);
	let currentReviewer = reviewer;
	if (currentReviewer.dispatch.phase === "prompt-intended") {
		const reconciledAt = transitionTimestamp(journal, dependencies.clock.now());
		let promoted: RunJournal;
		try {
			promoted = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
				const nextTask = next.run.tasks[candidate.index];
				const nextReviewer = nextTask ? latestReviewerAttempt(nextTask) : undefined;
				if (!nextTask || !nextReviewer || nextReviewer.id !== currentReviewer.id || nextReviewer.state !== currentReviewer.state || nextReviewer.dispatch.phase !== "prompt-intended") throw new Error("Reviewer Attempt disappeared before valid-report reconciliation.");
				promoteMatchingDispatch(nextTask, nextReviewer, reconciledAt, "valid-report");
			});
		} catch (error: unknown) {
			return { journal, note: `Valid Reviewer report could not first reconcile its prepared dispatch; no evidence finalization was attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` };
		}
		const persistedPromotion = await persistReviewJournal(repositoryRoot, promoted, dependencies);
		if (!persistedPromotion) return { journal, note: "Valid Reviewer report reconciliation lost a Journal race; no evidence finalization was attempted." };
		journal = persistedPromotion;
		const refreshedTask = journal.run.tasks[candidate.index];
		const refreshedReviewer = refreshedTask ? latestReviewerAttempt(refreshedTask) : undefined;
		if (!refreshedTask || !refreshedReviewer || refreshedReviewer.id !== currentReviewer.id) return { journal, note: "Valid Reviewer report reconciliation changed the current Attempt; no evidence finalization was attempted." };
		currentReviewer = refreshedReviewer;
	}
	const finalDirectory = paths.finalizedDirectory;
	const logs = referenced.files.map((file) => { const log = parsed.value!.logReferences.find((item) => item.path === file.path)!; return { id: log.id, originalPath: file.path, finalizedPath: join(finalDirectory, "logs", `${log.id}.log`), size: file.size, sha256: file.sha256 }; });
	const manifest = buildFinalizedReviewerEvidenceManifest({ runId: journal.run.id, taskId: candidate.task.contract.id, attempt: currentReviewer, report: parsed.value, reportSize: inputs.reportBytes.length, reportSha256: inputs.reportSha256, assignmentSha256: inputs.assignmentSha256, finalizedDirectory: finalDirectory, logs, after });
	const manifestBytes = Buffer.from(serializeFinalizedReviewerEvidenceManifest(manifest), "utf8");
	const manifestSha256 = finalizedReviewerEvidenceManifestSha256(manifest);
	let intended: RunJournal;
	try {
		intended = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
			const task = next.run.tasks[candidate.index];
			const attempt = task ? latestReviewerAttempt(task) : undefined;
			if (!task || !attempt) throw new Error("Reviewer Attempt disappeared before finalization intent.");
			attempt.integrity = { kind: "preserved", after: reviewSnapshotFor(after as import("./run.ts").ReviewWorktreeSnapshot) };
			attempt.evidence = { phase: "finalization-intended", checkedAt: transitionTimestamp(journal, dependencies.clock.now()), reportSha256: inputs.reportSha256, manifestPath: join(finalDirectory, "manifest.json"), manifestSha256, subject: { ...currentReviewer.subject, ...(currentReviewer.subject.kind === "git" ? { commits: [...currentReviewer.subject.commits] } : { artifacts: currentReviewer.subject.artifacts.map((artifact) => ({ ...artifact })) }) } };
		});
	} catch (error: unknown) { return { journal, note: `Reviewer finalization intent could not be persisted; no verdict was accepted. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
	const persistedIntent = await persistReviewJournal(repositoryRoot, intended, dependencies);
	if (!persistedIntent) return { journal, note: "Reviewer finalization intent could not be persisted; no verdict was accepted." };
	const copies = referenced.files.map((file) => { const log = parsed.value!.logReferences.find((item) => item.path === file.path)!; return finalizationCopyForLog(log, file.bytes, 0); });
	const finalization = await dependencies.runJournal.finalizeReviewerEvidence({ paths, assignmentBytes: inputs.assignmentBytes, reportBytes: inputs.reportBytes, manifestBytes, manifestSha256, copies, originalPaths: [reviewer.assignmentPath, reviewer.reportPath, ...referenced.files.map((file) => file.path)] });
	if (finalization.kind !== "created" && finalization.kind !== "existing-match") {
		const message = "message" in finalization ? finalization.message : "storage failure";
		return { journal: persistedIntent, note: `Reviewer evidence was not finalized (${message}); no verdict was accepted.` };
	}
	const finalizedManifestPath = finalization.manifestPath;
	const finalizedManifestSha256 = finalization.manifestSha256;
	let reported: RunJournal;
	try {
		reported = advanceRunJournal(persistedIntent, dependencies.clock.now(), (next) => {
			const task = next.run.tasks[candidate.index];
			const attempt = task ? latestReviewerAttempt(task) : undefined;
			if (!task || !attempt) throw new Error("Reviewer Attempt disappeared after evidence finalization.");
			attempt.state = "reported";
			delete attempt.recovery;
			attempt.integrity = { kind: "preserved", after: reviewSnapshotFor(after as import("./run.ts").ReviewWorktreeSnapshot) };
			attempt.evidence = { phase: "finalized", finalizedAt: transitionTimestamp(persistedIntent, dependencies.clock.now()), verdict: parsed.value!.verdict, reportSha256: inputs.reportSha256, manifestPath: finalizedManifestPath, manifestSha256: finalizedManifestSha256, subject: { ...currentReviewer.subject, ...(currentReviewer.subject.kind === "git" ? { commits: [...currentReviewer.subject.commits] } : { artifacts: currentReviewer.subject.artifacts.map((artifact) => ({ ...artifact })) }) } };
		});
	} catch (error: unknown) { return { journal: persistedIntent, note: `Reviewer evidence was finalized but the reported Journal state could not be persisted; no resend will be attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
	const persisted = await persistReviewJournal(repositoryRoot, reported, dependencies);
	if (!persisted) return { journal: persistedIntent, note: "Reviewer evidence was finalized but the reported Journal state could not be persisted; no resend will be attempted." };
	await dependencies.runJournal.appendActivity(repositoryRoot, { timestamp: persisted.run.updatedAt, runId: persisted.run.id, event: "reviewer-evidence-finalized", message: `Reviewer Attempt ${reviewer.id} finalized with explicit ${parsed.value.verdict} verdict; Task remains reviewing.` }).catch(() => undefined);
	const updatedTask = persisted.run.tasks[candidate.index];
	const updatedReviewer = updatedTask ? currentAttempt(updatedTask) : undefined;
	return updatedTask && updatedReviewer?.role === "reviewer" && advanceVerdict ? interpretReviewerVerdict(repositoryRoot, persisted, { ...candidate, task: updatedTask }, updatedReviewer, dependencies) : { journal: persisted, note: "Reviewer evidence finalized; explicit verdict recorded while Task remains reviewing.", action: "finalize-reviewer-evidence" };
}

async function interpretReviewerVerdict(repositoryRoot: string, journal: RunJournal, candidate: { index: number; task: TaskRecord; builder: BuilderAttemptRecord }, reviewer: ReviewerAttemptRecord, dependencies: StewardDependencies): Promise<ReviewDecision> {
	if (reviewer.evidence?.phase !== "finalized" || reviewer.state !== "reported") return { journal, note: "Reviewer verdict is not finalized; no transition was inferred." };
	if (candidate.task.attention === "blocked" || candidate.task.attention === "needs-user") return { journal, note: candidate.task.attention === "blocked" ? "Reviewer report repair is blocked; no further effect was attempted." : "Review is paused for user attention; no further effect was attempted." };
	if (!dependencies.runJournal.loadFinalizedEvidenceManifest) return { journal, note: "Finalized Reviewer manifest loading is unavailable; verdict transition is pending." };
	const loaded = await dependencies.runJournal.loadFinalizedEvidenceManifest({ manifestPath: reviewer.evidence.manifestPath, manifestSha256: reviewer.evidence.manifestSha256 });
	if (loaded.kind !== "loaded") return pauseReview(repositoryRoot, candidate, journal, dependencies, `Protected Reviewer evidence is unavailable; no verdict transition was inferred. ${loaded.message}`);
	const manifest = deserializeFinalizedReviewerEvidenceManifest(loaded.bytes.toString("utf8"), loaded.sha256);
	if (!manifest.value || manifest.value.identity.runId !== journal.run.id || manifest.value.identity.taskId !== candidate.task.contract.id || manifest.value.identity.attemptId !== reviewer.id || manifest.value.verdict !== reviewer.evidence.verdict || JSON.stringify(manifest.value.subject) !== JSON.stringify(reviewer.subject)) return pauseReview(repositoryRoot, candidate, journal, dependencies, `Protected Reviewer evidence does not exactly match Attempt ${reviewer.id}; no verdict transition was inferred.`);
	if (reviewer.evidence.verdict === "approved") {
		if (!dependencies.git.inspectReviewWorktree) return pauseReview(repositoryRoot, candidate, journal, dependencies, "Approval requires a read-only Review worktree inspection; no approval was recorded.");
		let observed: import("./run.ts").ReviewWorktreeSnapshot | { kind: "unavailable"; message: string };
		try { observed = await dependencies.git.inspectReviewWorktree(reviewer.worktree.path); } catch (error: unknown) { return pauseReview(repositoryRoot, candidate, journal, dependencies, `Approval worktree inspection failed; no approval was recorded. ${error instanceof Error ? error.message : "Inspection failed."}`); }
		if ("kind" in observed) return pauseReview(repositoryRoot, candidate, journal, dependencies, `Approval worktree inspection is unavailable; no approval was recorded. ${observed.message}`);
		if (reviewer.integrity?.kind !== "preserved" || !reviewSnapshotsExact(observed, reviewer.integrity.after) || observed.dirtyPaths.length !== 0 || observed.operationMarkers.length !== 0 || (reviewer.subject.kind === "git" && observed.head !== reviewer.subject.headRevision)) return pauseReview(repositoryRoot, candidate, journal, dependencies, "Approved Review worktree no longer matches the protected clean snapshot; no approval was recorded.");
		const approval: TaskApproval = { phase: "valid", approvedAt: transitionTimestamp(journal, dependencies.clock.now()), builderAttemptId: candidate.builder.id, reviewerAttemptId: reviewer.id, subject: cloneReviewSubject(reviewer.subject), reviewerManifestPath: reviewer.evidence.manifestPath, reviewerManifestSha256: reviewer.evidence.manifestSha256, worktreeSnapshot: reviewSnapshotFor(observed), verdict: "approved" };
		let approved: RunJournal;
		try {
			approved = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
				const task = next.run.tasks[candidate.index];
				if (!task) throw new Error("Review Task disappeared while recording Approval.");
				task.phase = "approved";
				task.attention = "none";
				task.approval = approval;
			});
		} catch (error: unknown) { return { journal, note: `Approval could not be built durably; no external effect was attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
		const persisted = await persistReviewJournal(repositoryRoot, approved, dependencies);
		return persisted ? { journal: persisted, note: `Review approved exactly for ${reviewer.subject.kind === "git" ? reviewer.subject.headRevision : reviewer.id}; durable Approval recorded.` } : { journal, note: "Approval could not be persisted; the finalized Review evidence remains authoritative." };
	}
	if (journal.run.effectiveSettings.reworkCycleLimit <= candidate.task.reworkCycles) return pauseReview(repositoryRoot, candidate, journal, dependencies, `Review requested changes, but the frozen rework limit ${journal.run.effectiveSettings.reworkCycleLimit} is exhausted; all evidence is retained and no new Attempt was created.`);
	const findingFacts = manifest.value.findings;
	if (findingFacts.length === 0) return pauseReview(repositoryRoot, candidate, journal, dependencies, "Protected changes-required Reviewer evidence contains no actionable findings; no rework was created.");
	return dispatchReworkBuilder(repositoryRoot, journal, candidate, reviewer, findingFacts, dependencies);
}

function cloneReviewSubject(subject: ReviewSubject): ReviewSubject {
	return subject.kind === "git" ? { ...subject, commits: [...subject.commits] } : { ...subject, artifacts: subject.artifacts.map((artifact) => ({ ...artifact })) };
}

function reviewSubjectBindsBuilderForStatus(subject: ReviewSubject, builder: BuilderAttemptRecord): boolean {
	return builder.evidence?.phase === "finalized" && subject.builderManifestSha256 === builder.evidence.manifestSha256 && (subject.kind !== "git" || (subject.baseRevision === builder.baseRevision && subject.headRevision === builder.evidence.producedRevision));
}

function reviewSnapshotsExact(left: import("./run.ts").ReviewWorktreeSnapshot, right: import("./run.ts").ReviewWorktreeSnapshot): boolean {
	return left.head === right.head && left.dirtyStateFingerprint === right.dirtyStateFingerprint && JSON.stringify(left.dirtyPaths) === JSON.stringify(right.dirtyPaths) && JSON.stringify(left.operationMarkers) === JSON.stringify(right.operationMarkers);
}

async function dispatchReviewer(repositoryRoot: string, controllerSessionId: string, journalInput: RunJournal, candidate: { index: number; task: TaskRecord; builder: BuilderAttemptRecord }, subject: ReviewSubject, manifestPath: string, manifestSha256: string, baseline: import("./run.ts").ReviewWorktreeSnapshot, reviewerModel: import("./config.ts").ModelChoice, independence: ReviewerIndependence, dependencies: StewardDependencies): Promise<ReviewDecision> {
	if (!runAllowsWorkflowAdvance(journalInput)) return { journal: journalInput, note: "The Run is cancelled; Reviewer dispatch is dormant and no Herdr effect was attempted." };
	let journal = journalInput;
	if (!hasProvenAgentIdentity(candidate.builder)) return { journal, note: "Reviewer dispatch is waiting for a fully proven Builder identity; no Reviewer effect was attempted." };
	const builderDispatch = candidate.builder.dispatch;
	if (!dependencies.herdr.createReviewerPane || !dependencies.herdr.startReviewer || !dependencies.herdr.promptReviewer) return { journal, note: "Review dispatch pending; Reviewer Herdr adapters are unavailable." };
	const attemptId = `attempt-${String(candidate.task.attempts.length + 1).padStart(2, "0")}`;
	const paths = dependencies.runJournal.resolveAssignmentPaths(repositoryRoot, journal.run.id, candidate.task.contract.id, attemptId);
	let agentName = `steward-r-${compactUuid(dependencies.clock)}-${candidate.task.contract.id.replace(/[^0-9]/g, "").padStart(2, "0")}-${attemptId.slice(-2)}`;
	if (!safeHerdrName(agentName)) return { journal, note: "Reviewer dispatch pending; Steward could not derive a valid Reviewer name." };
	const prepared: ReviewerAttemptRecord = {
		id: attemptId,
		role: "reviewer",
		state: "prepared",
		preparedAt: transitionTimestamp(journal, dependencies.clock.now()),
		actualModel: { ...reviewerModel },
		...(journal.run.revisions ? { specificationVersion: candidate.task.specificationVersion } : {}),
		specificationHash: candidate.task.specificationHash,
		assignmentPath: paths.assignmentPath,
		reportPath: paths.reportPath,
		evidenceDirectory: paths.evidenceDirectory,
		subject,
		independence: { ...independence },
		worktree: { path: builderDispatch.worktreePath, baseline: reviewSnapshotFor(baseline) },
		dispatch: { phase: "pane-intended", sourcePaneId: builderDispatch.paneId, worktreePath: builderDispatch.worktreePath, agentName } as ReviewerAttemptRecord["dispatch"],
	};
	// The actual baseline is installed by the caller before this function; this branch only guards malformed construction.
	if (!prepared.worktree.baseline.head || !prepared.worktree.baseline.dirtyStateFingerprint) return { journal, note: "Reviewer dispatch pending; the pre-Review snapshot was not available." };
	let preparedJournal: RunJournal;
	try {
		preparedJournal = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
			const task = next.run.tasks[candidate.index];
			if (!task || task.attempts.some((attempt) => attempt.id === attemptId)) throw new Error("Reviewer Attempt already exists.");
			task.phase = "reviewing";
			task.attention = "none";
			delete task.attentionDiagnostic;
			delete task.attentionReason;
			task.attempts.push(prepared);
				clearTaskMonitor(next.run, task.contract.id);
		});
	} catch (error: unknown) { return { journal, note: `Reviewer pane intent could not be built; no pane was created. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
	const persistedPrepared = await persistReviewJournal(repositoryRoot, preparedJournal, dependencies);
	if (!persistedPrepared) return { journal, note: "Reviewer pane intent could not be persisted; no pane was created." };
	journal = persistedPrepared;
	let pane: import("./steward.ts").HerdrReviewerPaneResult;
		try { pane = await dependencies.herdr.createReviewerPane({ repositoryRoot, sourcePaneId: builderDispatch.paneId, worktreePath: builderDispatch.worktreePath, branch: builderDispatch.branch, agentName, workspaceId: builderDispatch.workspaceId }); }
		catch (error: unknown) { return { journal, note: `Reviewer pane creation failed; dispatch remains at pane-intended and no verdict exists. ${error instanceof Error ? error.message : "Herdr pane split failed."}` }; }
		if (pane.kind === "failed") {
			const currentTask = journal.run.tasks[candidate.index];
			const currentAttempt = currentTask ? latestReviewerAttempt(currentTask) : undefined;
			if (currentTask && currentAttempt) {
				const transition = await recoverTypedHerdrFailure({ repositoryRoot, controllerSessionId, journal, taskIndex: candidate.index, task: currentTask, attempt: currentAttempt, dependencies, stage: pane.stage, code: pane.code, diagnostic: pane.message });
				if (transition) return reviewDecisionFromTransient(transition);
			}
		}
		if (pane.kind !== "created" || pane.workspaceId !== builderDispatch.workspaceId || pane.sourcePaneId !== builderDispatch.paneId || pane.worktreePath !== builderDispatch.worktreePath || pane.paneId === builderDispatch.paneId || pane.terminalId === builderDispatch.terminalId || !validIdentity(pane.tabId)) return { journal, note: "Reviewer pane envelope was malformed or contradictory; dispatch remains at pane-intended and no verdict exists." };
	let agentIntent: RunJournal;
	try {
		agentIntent = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
			const task = next.run.tasks[candidate.index];
			const reviewer = task ? latestReviewerAttempt(task) : undefined;
			if (!reviewer) throw new Error("Reviewer Attempt disappeared before agent intent.");
			reviewer.dispatch = { phase: "agent-intended", agentName, worktreePath: builderDispatch.worktreePath, workspaceId: pane.workspaceId, paneId: pane.paneId, terminalId: pane.terminalId } as ReviewerAttemptRecord["dispatch"];
		});
	} catch (error: unknown) { return { journal, note: `Reviewer agent intent could not be persisted; dispatch remains at pane-intended. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
	const persistedAgentIntent = await persistReviewJournal(repositoryRoot, agentIntent, dependencies);
	if (!persistedAgentIntent) return { journal, note: "Reviewer agent intent could not be persisted; the Reviewer was not started." };
	journal = persistedAgentIntent;
	let started: import("./steward.ts").HerdrAgentStartResult | undefined;
	for (let collision = 0; collision < 8; collision += 1) {
		let result: import("./steward.ts").HerdrAgentStartResult;
		try { result = await dependencies.herdr.startReviewer({ repositoryRoot, name: agentName, paneId: pane.paneId, model: reviewerModel }); }
		catch (error: unknown) { return { journal, note: `Reviewer start failed; dispatch remains at agent-intended and no verdict exists. ${error instanceof Error ? error.message : "Herdr agent start failed."}` }; }
			if (result.kind !== "name-collision") { started = result; break; }
		if (collision === 7) return { journal, note: "Eight Steward-owned Reviewer names collided; dispatch remains pending and no verdict exists." };
			agentName = `steward-r-${compactUuid(dependencies.clock)}-${candidate.task.contract.id.replace(/[^0-9]/g, "").padStart(2, "0")}-${attemptId.slice(-2)}`;
		try {
			const renamed = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
				const task = next.run.tasks[candidate.index];
				const reviewer = task ? latestReviewerAttempt(task) : undefined;
				if (!reviewer) throw new Error("Reviewer Attempt disappeared while changing its name.");
				reviewer.dispatch = { phase: "agent-intended", agentName, worktreePath: builderDispatch.worktreePath, workspaceId: pane.workspaceId, paneId: pane.paneId, terminalId: pane.terminalId } as ReviewerAttemptRecord["dispatch"];
			});
			const persistedRename = await persistReviewJournal(repositoryRoot, renamed, dependencies);
			if (!persistedRename) return { journal, note: "Reviewer name collision could not be durably reconciled; no existing agent was adopted." };
			journal = persistedRename;
		} catch (error: unknown) { return { journal, note: `Reviewer name collision could not be reconciled; no existing agent was adopted. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
		}
		if (started?.kind === "failed") {
			const currentTask = journal.run.tasks[candidate.index];
			const currentAttempt = currentTask ? latestReviewerAttempt(currentTask) : undefined;
			if (currentTask && currentAttempt) {
				const transition = await recoverTypedHerdrFailure({ repositoryRoot, controllerSessionId, journal, taskIndex: candidate.index, task: currentTask, attempt: currentAttempt, dependencies, stage: started.stage, code: started.code, diagnostic: started.message, identity: { name: agentName, workspaceId: pane.workspaceId, paneId: pane.paneId, terminalId: pane.terminalId }, requireExactMissing: true });
				if (transition) return reviewDecisionFromTransient(transition);
			}
		}
		if (!started || started.kind !== "started" || started.name !== agentName || started.agentKind !== "pi" || started.workspaceId !== pane.workspaceId || started.paneId !== pane.paneId || started.terminalId !== pane.terminalId || !validIdentity(started.tabId)) return { journal, note: "Reviewer start envelope was malformed or contradictory; dispatch remains at agent-intended and no verdict exists." };
	let assignment: ReviewerAssignmentDocument;
	const activeTask = journal.run.tasks[candidate.index];
	const activeReviewer = activeTask ? latestReviewerAttempt(activeTask) : undefined;
	if (!activeReviewer) return { journal, note: "Reviewer Attempt disappeared before Assignment creation; no prompt was sent." };
	try { assignment = buildReviewerAssignment({ runId: journal.run.id, task: candidate.task.contract, attempt: activeReviewer, manifestPath, manifestSha256, workspaceId: pane.workspaceId, paneId: pane.paneId, terminalId: pane.terminalId, agentName }); }
	catch (error: unknown) { return { journal, note: `Reviewer Assignment could not be built; dispatch remains at agent-intended. ${error instanceof Error ? error.message : "Assignment validation failed."}` }; }
	let assignmentResult: AssignmentCreateResult;
	try { assignmentResult = await dependencies.runJournal.createAssignment(repositoryRoot, assignment); }
	catch (error: unknown) { return { journal, note: `Reviewer Assignment could not be persisted; the Reviewer was not prompted. ${error instanceof Error ? error.message : "Storage failed."}` }; }
	if (assignmentResult.kind !== "created" && assignmentResult.kind !== "existing-match") return { journal, note: "Reviewer Assignment conflicts with different bytes; dispatch remains pending and the Reviewer was not prompted." };
	const assignmentHash = reviewerAssignmentSha256(assignmentResult.bytes);
	let promptIntent: RunJournal;
	try {
		promptIntent = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
			const task = next.run.tasks[candidate.index];
			const reviewer = task ? latestReviewerAttempt(task) : undefined;
			if (!reviewer) throw new Error("Reviewer Attempt disappeared before prompt intent.");
			reviewer.dispatch = { phase: "prompt-intended", agentName, worktreePath: builderDispatch.worktreePath, workspaceId: pane.workspaceId, paneId: pane.paneId, terminalId: pane.terminalId, assignmentSha256: assignmentHash } as ReviewerAttemptRecord["dispatch"];
		});
	} catch (error: unknown) { return { journal, note: `Reviewer prompt intent could not be built; no prompt was sent. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
	const persistedPromptIntent = await persistReviewJournal(repositoryRoot, promptIntent, dependencies);
	if (!persistedPromptIntent) return { journal, note: "Reviewer prompt intent could not be persisted; no prompt was sent." };
	journal = persistedPromptIntent;
	let prompted: import("./steward.ts").HerdrPromptResult;
		try { prompted = await dependencies.herdr.promptReviewer({ repositoryRoot, name: agentName, assignmentPrompt: formatReviewerPrompt(assignment) }); }
		catch (error: unknown) { return { journal, note: `Reviewer prompt failed; dispatch remains at prompt-intended without a resend. ${error instanceof Error ? error.message : "Herdr prompt failed."}` }; }
		if (prompted.kind === "failed") {
			const currentTask = journal.run.tasks[candidate.index];
			const currentAttempt = currentTask ? latestReviewerAttempt(currentTask) : undefined;
			if (currentTask && currentAttempt) {
				const transition = await recoverTypedHerdrFailure({ repositoryRoot, controllerSessionId, journal, taskIndex: candidate.index, task: currentTask, attempt: currentAttempt, dependencies, stage: prompted.stage, code: prompted.code, diagnostic: prompted.message, identity: { name: agentName, workspaceId: pane.workspaceId, paneId: pane.paneId, terminalId: pane.terminalId }, requireExactMissing: true });
				if (transition) return reviewDecisionFromTransient(transition);
			}
		}
		if (prompted.kind !== "prompted" || prompted.name !== agentName || prompted.workspaceId !== pane.workspaceId || prompted.paneId !== pane.paneId || prompted.terminalId !== pane.terminalId || !validIdentity(prompted.tabId)) return { journal, note: "Reviewer prompt envelope was malformed or contradictory; dispatch remains at prompt-intended without a resend." };
	const promptedAt = transitionTimestamp(journal, dependencies.clock.now());
	let active: RunJournal;
	try {
		active = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
			const task = next.run.tasks[candidate.index];
			const reviewer = task ? latestReviewerAttempt(task) : undefined;
			if (!reviewer) throw new Error("Reviewer Attempt disappeared before activation.");
			reviewer.state = "active";
			reviewer.activatedAt = promptedAt;
			reviewer.dispatch = { phase: "prompted", agentName, worktreePath: builderDispatch.worktreePath, workspaceId: pane.workspaceId, paneId: pane.paneId, terminalId: pane.terminalId, assignmentSha256: assignmentHash, promptedAt } as ReviewerAttemptRecord["dispatch"];
		});
	} catch (error: unknown) { return { journal, note: `Reviewer prompt succeeded but activation could not be built; no resend will be attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
	const persistedActive = await persistReviewJournal(repositoryRoot, active, dependencies);
	if (!persistedActive) return { journal, note: "Reviewer prompt succeeded but activation could not be persisted; no resend will be attempted." };
	await dependencies.runJournal.appendActivity(repositoryRoot, { timestamp: persistedActive.run.updatedAt, runId: persistedActive.run.id, event: "reviewer-dispatched", message: `Prompted Reviewer ${agentName} with Assignment ${assignmentHash}.` }).catch(() => undefined);
	return { journal: persistedActive, note: `Reviewer Attempt ${activeReviewer.id} dispatched; awaiting an explicit Reviewer Attempt Report.` };
}

async function persistReviewApprovalRequired(repositoryRoot: string, journal: RunJournal, candidate: { index: number; task: TaskRecord }, choice: import("./config.ts").ModelChoice, provider: string, dependencies: StewardDependencies): Promise<ReviewDecision> {
	const note = `Same-provider Reviewer ${choice.model} requires explicit Controller approval for this exact Review subject (${provider}). Run /steward status in the Controller Session to approve it.`;
	if (candidate.task.attention === "needs-user" && candidate.task.attentionReason === "review-approval-required") return { journal, note, action: "approval-required" };
	let paused: RunJournal;
	try {
		paused = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
			const task = next.run.tasks[candidate.index];
			if (!task) throw new Error("Review Task disappeared while retaining approval-required state.");
			task.phase = "reviewing";
			task.attention = "needs-user";
			task.attentionReason = "review-approval-required";
			task.attentionDiagnostic = note.slice(0, 2_000);
		});
	} catch (error: unknown) {
		return { journal, note: `${note} Durable approval-required state could not be built: ${error instanceof Error ? error.message : "Journal validation failed."}`, action: "degraded" };
	}
	const persisted = await persistReviewJournal(repositoryRoot, paused, dependencies);
	if (!persisted) return { journal, note: `${note} Durable approval-required state could not be persisted; no Reviewer was launched.`, action: "degraded" };
	await dependencies.runJournal.appendActivity(repositoryRoot, { timestamp: persisted.run.updatedAt, runId: persisted.run.id, event: "review-approval-required", message: `Same-provider Reviewer ${choice.model} awaits explicit Controller approval for the exact Review subject.` }).catch(() => undefined);
	return { journal: persisted, note, action: "approval-required" };
}

async function advanceEligibleReview(repositoryRoot: string, controllerSessionId: string, journal: RunJournal, dependencies: StewardDependencies, automatic = false, minimumIndex = 0): Promise<ReviewDecision> {
	if (!runAllowsWorkflowAdvance(journal)) return { journal, note: "The Run is cancelled; Review advancement is dormant and no Herdr effect was attempted." };
	const reviewerSelected = reviewerTaskCandidate(journal, minimumIndex);
	if (reviewerSelected) {
		if (automatic && dependencies.runJournal.inspectAttemptReport) {
			let report: AttemptReportInspection;
			try { report = await dependencies.runJournal.inspectAttemptReport(repositoryRoot, reviewerSelected.reviewer.reportPath); } catch (error: unknown) { return { journal, note: `Reviewer report observation is unavailable; no repair or verdict action was attempted. ${error instanceof Error ? error.message : "Report inspection failed."}` }; }
			if (report.kind === "missing") return { journal, note: "Reviewer Attempt Report is not present yet; no repair or verdict was inferred." };
			if (report.kind === "unavailable") return { journal, note: `Reviewer report observation is unavailable; no repair or verdict action was attempted. ${report.diagnostic}` };
		}
		return validateActiveReviewerReport(repositoryRoot, journal, reviewerSelected, reviewerSelected.reviewer, dependencies, !automatic);
	}
	const selected = reviewTaskCandidate(journal, minimumIndex);
	if (!selected) return { journal, note: "" };
	if (automatic && selected.task.attentionReason === "review-approval-required") return { journal, note: selected.task.attentionDiagnostic ?? "Review awaits explicit Controller approval.", action: "approval-required" };
	const derived = await deriveReviewSubject({ runId: journal.run.id, task: selected.task, builder: selected.builder }, dependencies);
	if (!derived.subject || !derived.manifestPath || !derived.manifestSha256) return { journal, note: derived.message ?? "Review dispatch pending; immutable Builder evidence subject is unavailable." };
	if (!dependencies.model.inspectModelChoice) return { journal, note: "Review dispatch pending; Reviewer model inspection is unavailable." };
	const inspections: ReviewerChoiceInspection[] = [];
	const choices = [journal.run.modelPlan.reviewer.primary, ...journal.run.modelPlan.reviewer.fallbacks];
	for (let index = 0; index < choices.length; index += 1) {
		try { inspections.push(await dependencies.model.inspectModelChoice(choices[index]!, "reviewer", index)); }
		catch (error: unknown) { inspections.push({ choice: { ...choices[index]! }, available: false, diagnostics: [{ code: "unavailable-model", role: "reviewer", index, reference: choices[index]!.model, message: error instanceof Error ? error.message : "Reviewer model inspection failed." }] }); }
	}
	const selection: ReviewerModelSelection = selectReviewerModel(selected.builder.actualModel, inspections);
	let independence: ReviewerIndependence;
	if (selection.kind === "unavailable") return pauseReview(repositoryRoot, selected, journal, dependencies, `No available Reviewer Model Choice remains. Update the future Reviewer Model Plan explicitly; diagnostics: ${selection.diagnostics.map((item) => item.message).join(" ")}`);
	if (selection.kind === "same-family-approval-required") {
		if (automatic) return persistReviewApprovalRequired(repositoryRoot, journal, selected, selection.choice, selection.provider, dependencies);
		let confirmed = false;
		if (!dependencies.ui.confirmSameFamilyReview) return persistReviewApprovalRequired(repositoryRoot, journal, selected, selection.choice, selection.provider, dependencies);
		try { confirmed = await dependencies.ui.confirmSameFamilyReview({ builderModel: selected.builder.actualModel, reviewerModel: selection.choice, subject: derived.subject, provider: selection.provider }); }
		catch { confirmed = false; }
		if (!confirmed) return persistReviewApprovalRequired(repositoryRoot, journal, selected, selection.choice, selection.provider, dependencies);
		independence = { kind: "same-provider-family-approved", provider: selection.provider, approvedAt: dependencies.clock.now().toISOString(), controllerSessionId };
	} else independence = { kind: "different-provider-family", builderProvider: selection.builderProvider, reviewerProvider: selection.reviewerProvider };
	if (!dependencies.git.inspectReviewWorktree) return { journal, note: "Review dispatch pending; read-only Git snapshot inspection is unavailable." };
	let snapshot: import("./run.ts").ReviewWorktreeSnapshot | { kind: "unavailable"; message: string };
	if (!hasProvenAgentIdentity(selected.builder)) return { journal, note: "Review dispatch is waiting for the proven Builder identity; no Reviewer effect was attempted." };
	const builderDispatch = selected.builder.dispatch;
	try { snapshot = await dependencies.git.inspectReviewWorktree(builderDispatch.worktreePath); } catch (error: unknown) { return pauseReview(repositoryRoot, selected, journal, dependencies, `Pre-Review worktree inspection failed; no Reviewer was launched. ${error instanceof Error ? error.message : "Inspection failed."}`); }
	if ("kind" in snapshot) return pauseReview(repositoryRoot, selected, journal, dependencies, `Pre-Review worktree inspection is unavailable; no Reviewer was launched. ${snapshot.message}`);
	if (snapshot.head !== (selected.builder.evidence?.phase === "finalized" ? selected.builder.evidence.producedRevision : "") || snapshot.dirtyPaths.length > 0 || snapshot.operationMarkers.length > 0) return pauseReview(repositoryRoot, selected, journal, dependencies, "Pre-Review worktree differs from the finalized Builder subject; preserved worktree state requires user attention.");
	const preparedCandidate = { ...selected, task: selected.task };
	const dispatched = await dispatchReviewer(repositoryRoot, controllerSessionId, journal, preparedCandidate, derived.subject, derived.manifestPath, derived.manifestSha256, snapshot, selection.choice, independence, dependencies);
	return dispatched;
}

function transitionTimestamp(journal: RunJournal, now: Date): string {
	return new Date(Math.max(now.getTime(), new Date(journal.run.updatedAt).getTime() + 1)).toISOString();
}

function safeHerdrName(value: string): boolean {
	return /^[a-z][a-z0-9_-]{0,31}$/.test(value);
}

function validIdentity(value: string): boolean {
	return value.trim().length > 0 && value === value.trim() && !value.includes("\u0000");
}

function currentMonitorAttempt(journal: RunJournal): { task: TaskRecord; index: number; attempt: AttemptRecord } | undefined {
	const candidates: Array<{ task: TaskRecord; index: number; attempt: AttemptRecord }> = [];
	for (let index = 0; index < journal.run.tasks.length; index += 1) {
		const task = journal.run.tasks[index];
		const attempt = task ? currentAttempt(task) : undefined;
			if (!task || !attempt || (task.phase !== "building" && task.phase !== "reworking" && task.phase !== "reviewing" && task.phase !== "approved" && task.phase !== "integrating" && task.phase !== "completed") || (attempt.dispatch.phase !== "prompted" && attempt.dispatch.phase !== "reconciled-active")) continue;
		candidates.push({ task, index, attempt });
	}
	return candidates[0];
}

function currentMonitorAttempts(journal: RunJournal): Array<{ task: TaskRecord; index: number; attempt: AttemptRecord }> {
	const candidates: Array<{ task: TaskRecord; index: number; attempt: AttemptRecord }> = [];
	for (let index = 0; index < journal.run.tasks.length; index += 1) {
		const task = journal.run.tasks[index];
		const attempt = task ? currentAttempt(task) : undefined;
		if (!task || !attempt || !["building", "reworking", "reviewing", "approved", "integrating", "completed"].includes(task.phase) || (attempt.dispatch.phase !== "prompted" && attempt.dispatch.phase !== "reconciled-active")) continue;
		candidates.push({ task, index, attempt });
	}
	return candidates;
}

function clearTaskMonitor(run: RunJournal["run"], taskId: string): void {
	if (run.tasks.length <= 1) {
		delete run.monitor;
		return;
	}
	const retained = (run.monitors ?? []).filter((monitor) => monitor.taskId !== taskId);
	if (retained.length > 0) run.monitors = retained;
	else delete run.monitors;
	delete run.monitor;
}

function nextSilenceDeadline(journal: RunJournal, attempt: AttemptRecord, now: number): number {
	const passiveInspectionMs = Math.max(1, journal.run.effectiveSettings.passiveInspectionIntervalSeconds) * 1_000;
	const secondInspectionMs = Math.max(1, journal.run.effectiveSettings.secondInspectionAndNudgeIntervalSeconds) * 1_000;
	const nudgeGraceMs = Math.max(1, journal.run.effectiveSettings.nudgeGracePeriodSeconds) * 1_000;
	const externalWarningMs = Math.max(1, journal.run.effectiveSettings.externalCommandWarningThresholdSeconds) * 1_000;
	const silence = attempt.recovery?.silence;
	if (!silence) return now + passiveInspectionMs;
	if (silence.phase === "waiting-external") return silence.warnedAt ? now + passiveInspectionMs : Date.parse(silence.firstObservedAt) + externalWarningMs;
	if (silence.phase === "external-grace") return Date.parse(silence.exitedAt) + nudgeGraceMs;
	if (silence.phase === "suspected" || silence.phase === "inspection-incomplete") return Date.parse(silence.phaseAt) + secondInspectionMs;
	if (silence.phase === "nudged" || silence.phase === "resumed") return Date.parse(silence.phaseAt) + nudgeGraceMs;
	if (silence.phase === "interrupted") return now;
	return now + passiveInspectionMs;
}

function monitorIdentity(attempt: AttemptRecord): ManagedAgentIdentity | undefined {
	const dispatch = attempt.dispatch;
	return dispatch.phase === "prompted" || dispatch.phase === "reconciled-active" ? { name: dispatch.agentName, workspaceId: dispatch.workspaceId, paneId: dispatch.paneId, terminalId: dispatch.terminalId } : undefined;
}

function monitorChangedSources(previous: MonitorCheckpoint | undefined, next: MonitorCheckpoint): string[] {
	if (!previous) return ["lifecycle", "terminal", "worktree", "git", "report"];
	const changed: string[] = [];
	if (previous.agent.lifecycle !== next.agent.lifecycle || previous.agent.stateChangeSequence !== next.agent.stateChangeSequence || previous.agent.name !== next.agent.name || previous.agent.workspaceId !== next.agent.workspaceId || previous.agent.paneId !== next.agent.paneId || previous.agent.terminalId !== next.agent.terminalId) changed.push("lifecycle");
	if (JSON.stringify(previous.terminal) !== JSON.stringify(next.terminal)) changed.push("terminal");
	if (JSON.stringify(previous.worktree) !== JSON.stringify(next.worktree)) changed.push("worktree");
	if (JSON.stringify(previous.git) !== JSON.stringify(next.git)) changed.push("git");
	if (JSON.stringify(previous.report) !== JSON.stringify(next.report)) changed.push("report");
	return changed;
}

function monitorFooter(journal: RunJournal, condition: MonitorCondition, diagnostic?: string): string {
	if (condition === "completed") return "steward: no active Run";
	if (condition === "cancelled") return `steward: ${journal.run.id} · cancelled`;
	const task = journal.run.tasks.find((candidate) => candidate.attention !== "none") ?? journal.run.tasks[0];
	const attention = journal.run.tasks.filter((candidate) => candidate.attention !== "none").length;
	const phase = task?.phase ?? journal.run.status;
	const suffix = diagnostic ? ` · ${diagnostic.slice(0, 160)}` : "";
	const attempt = task ? currentAttempt(task) : undefined;
	const silence = task && attempt?.recovery?.silence;
	const silenceSuffix = silence ? ` · silence ${silence.phase} · ${task.attempts.filter((candidate) => candidate.replacement !== undefined).length}/${journal.run.effectiveSettings.transientRetryLimit} · next ${new Date(nextSilenceDeadline(journal, attempt, Date.parse(journal.run.updatedAt))).toISOString()}` : "";
	const transientCount = task?.attempts.filter((candidate) => candidate.replacement !== undefined).length ?? 0;
	const transientSuffix = task?.attempts.some((candidate) => candidate.recovery?.infrastructure) ? ` · transient ${transientCount}/${journal.run.effectiveSettings.transientRetryLimit}` : "";
	return `steward: ${journal.run.id} · ${phase} · ${attention} attention${silenceSuffix}${transientSuffix}${suffix}`;
}

async function validateApprovedTasks(repositoryRoot: string, journal: RunJournal, dependencies: StewardDependencies): Promise<ReviewDecision> {
	for (let index = 0; index < journal.run.tasks.length; index += 1) {
		const task = journal.run.tasks[index];
		if (!task || task.phase !== "approved" || !task.approval || task.approval.phase !== "valid") continue;
		const reviewer = task.attempts.find((attempt): attempt is ReviewerAttemptRecord => attempt.id === task.approval?.reviewerAttemptId && attempt.role === "reviewer");
		const builder = task.attempts.find((attempt): attempt is BuilderAttemptRecord => attempt.id === task.approval?.builderAttemptId && attempt.role === "builder");
		let reason: "head-changed" | "dirty-state-changed" | "subject-changed" | "evidence-changed" | "approval-invalid" | undefined;
		let diagnostic = "";
		let observedSnapshot: import("./run.ts").ReviewWorktreeSnapshot | undefined;
		if (!reviewer || !builder || reviewer.evidence?.phase !== "finalized" || builder.evidence?.phase !== "finalized" || reviewer.evidence.manifestPath !== task.approval.reviewerManifestPath || reviewer.evidence.manifestSha256 !== task.approval.reviewerManifestSha256 || JSON.stringify(reviewer.subject) !== JSON.stringify(task.approval.subject) || !reviewSubjectBindsBuilderForStatus(task.approval.subject, builder)) {
			reason = "evidence-changed";
			diagnostic = "Approval no longer matches the exact latest Builder/Reviewer Attempts or protected evidence.";
		}
		if (!reason && (!dependencies.runJournal.loadFinalizedEvidenceManifest || !dependencies.git.inspectReviewWorktree)) return { journal, note: "Approved Task revalidation adapters are unavailable; Approval remains unchanged and no effect was attempted." };
		if (!reason) {
			const loaded = await dependencies.runJournal.loadFinalizedEvidenceManifest!({ manifestPath: task.approval.reviewerManifestPath, manifestSha256: task.approval.reviewerManifestSha256 });
			if (loaded.kind !== "loaded") { reason = "evidence-changed"; diagnostic = loaded.message; }
			else {
				const manifest = deserializeFinalizedReviewerEvidenceManifest(loaded.bytes.toString("utf8"), loaded.sha256);
				if (!manifest.value || manifest.value.verdict !== "approved" || JSON.stringify(manifest.value.subject) !== JSON.stringify(task.approval.subject)) { reason = "subject-changed"; diagnostic = "Protected Reviewer manifest subject or verdict changed."; }
			}
		}
		if (!reason) {
			const snapshot = await dependencies.git.inspectReviewWorktree!(reviewer!.worktree.path);
			if ("kind" in snapshot) { reason = "approval-invalid"; diagnostic = snapshot.message; }
			else { observedSnapshot = snapshot; if (snapshot.head !== task.approval.worktreeSnapshot.head) reason = "head-changed"; else if (!reviewSnapshotsExact(snapshot, task.approval.worktreeSnapshot)) reason = "dirty-state-changed"; diagnostic = reason ? "Approved Review worktree snapshot changed after Approval." : ""; }
		}
		if (!reason) continue;
		let invalidated: RunJournal;
		try {
			invalidated = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
				const nextTask = next.run.tasks[index];
				if (!nextTask || !nextTask.approval || nextTask.approval.phase !== "valid") throw new Error("Approval disappeared while invalidating.");
				const current = nextTask.approval;
				nextTask.approval = { ...current, phase: "invalidated", invalidatedAt: transitionTimestamp(journal, dependencies.clock.now()), reason: reason!, diagnostic: diagnostic.slice(0, 2_000), ...(observedSnapshot ? { observedSnapshot: reviewSnapshotFor(observedSnapshot) } : {}) };
				nextTask.phase = "reviewing";
				nextTask.attention = "needs-user";
			});
		} catch (error: unknown) { return { journal, note: `Approval changed (${reason}) but invalidation could not be built durably. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
		const persisted = await persistReviewJournal(repositoryRoot, invalidated, dependencies);
		return persisted ? { journal: persisted, note: `Approval invalidated (${reason}); exact evidence and worktree were preserved and no new effect was attempted.` } : { journal, note: "Approval changed, but invalidation could not be persisted; no new effect was attempted." };
	}
	return { journal, note: "" };
}

function emptyIntegrationObservation(): IntegrationCheckoutObservation {
	return { branch: null, head: null, dirtyPaths: [], operationMarkers: [], rangeExact: false };
}

function completionAttentionReason(reason: TaskAttentionReason): boolean {
	return ["integration-preflight", "integration-failed", "integration-ambiguous", "final-verification-unexecutable", "final-verification-failed", "final-verification-ambiguous", "final-verification-ownership-unclear", "verification-dirtied-checkout", "agent-stop-failed", "archive-failed"].includes(reason);
}

async function persistCompletionAttention(repositoryRoot: string, journal: RunJournal, taskId: string, reason: TaskAttentionReason, diagnostic: string, dependencies: StewardDependencies): Promise<ReviewDecision> {
	if (!completionAttentionReason(reason)) return { journal, note: diagnostic };
	const task = journal.run.tasks.find((candidate) => candidate.contract.id === taskId);
	if (!task) return { journal, note: diagnostic };
	if (task.attention === "needs-user" && task.attentionReason === reason) return { journal, note: diagnostic };
	let candidate: RunJournal;
	try {
		candidate = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
			const nextTask = next.run.tasks.find((item) => item.contract.id === taskId);
			if (!nextTask) throw new Error("Completion Task disappeared while retaining attention.");
			if (nextTask.phase === "completed") nextTask.phase = "integrating";
			nextTask.attention = "needs-user";
			nextTask.attentionReason = reason;
			nextTask.attentionDiagnostic = diagnostic.slice(0, 2_000);
		});
	} catch (error: unknown) {
		return { journal, note: `Completion state could not be retained durably; no later effect was attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` };
	}
	const persisted = await persistReviewJournal(repositoryRoot, candidate, dependencies);
	return persisted ? { journal: persisted, note: diagnostic } : { journal, note: `Completion state could not be retained durably; no later effect was attempted. ${diagnostic}` };
}

async function loadCompletionEvidence(repositoryRoot: string, task: TaskRecord, journal: RunJournal, dependencies: StewardDependencies): Promise<{ subject: ReviewSubject; builder: BuilderAttemptRecord; reviewer: ReviewerAttemptRecord; builderManifest: import("./run.ts").FinalizedEvidenceManifest; reviewerManifest: FinalizedReviewerEvidenceManifest } | { message: string }> {
	const approval = task.approval;
	if (!approval || approval.phase !== "valid") return { message: "Current Approval is unavailable." };
	const builder = task.attempts.find((attempt): attempt is BuilderAttemptRecord => attempt.id === approval.builderAttemptId && attempt.role === "builder");
	const reviewer = task.attempts.find((attempt): attempt is ReviewerAttemptRecord => attempt.id === approval.reviewerAttemptId && attempt.role === "reviewer");
	if (!builder || !reviewer || builder.evidence?.phase !== "finalized" || reviewer.evidence?.phase !== "finalized" || reviewer.evidence.verdict !== "approved" || reviewer.integrity?.kind !== "preserved") return { message: "Protected final Builder/Reviewer evidence is not finalized and approved." };
	if (!dependencies.runJournal.loadFinalizedEvidenceManifest) return { message: "Protected finalized-manifest loading is unavailable." };
	const builderLoaded = await dependencies.runJournal.loadFinalizedEvidenceManifest({ manifestPath: builder.evidence.manifestPath, manifestSha256: builder.evidence.manifestSha256 });
	if (builderLoaded.kind !== "loaded") return { message: `Protected Builder manifest could not be loaded: ${builderLoaded.message}` };
	const builderManifest = deserializeFinalizedBuilderEvidenceManifest(builderLoaded.bytes.toString("utf8"), builderLoaded.sha256);
	if (!builderManifest.value) return { message: builderManifest.message ?? "Protected Builder manifest is invalid." };
	if (builderManifest.value.status !== "completed" || builderManifest.value.producedRevision === null) return { message: "Protected Builder manifest is not a completed code-changing result." };
	const derived = reviewSubjectFromFinalizedBuilderEvidence({ manifest: builderManifest.value, manifestBytes: builderLoaded.bytes, manifestSha256: builderLoaded.sha256, runId: journal.run.id, taskId: task.contract.id, builderAttemptId: builder.id, builderBaseRevision: builder.baseRevision, builderProducedRevision: builder.evidence.producedRevision });
	if (!derived.value) return { message: derived.message ?? "Protected Builder subject could not be reconstructed." };
	if (JSON.stringify(derived.value) !== JSON.stringify(approval.subject) || JSON.stringify(derived.value) !== JSON.stringify(reviewer.subject)) return { message: "Protected Builder/Reviewer subject changed from the current Approval." };
	const reviewerLoaded = await dependencies.runJournal.loadFinalizedEvidenceManifest({ manifestPath: approval.reviewerManifestPath, manifestSha256: approval.reviewerManifestSha256 });
	if (reviewerLoaded.kind !== "loaded") return { message: `Protected Reviewer manifest could not be loaded: ${reviewerLoaded.message}` };
	const reviewerManifest = deserializeFinalizedReviewerEvidenceManifest(reviewerLoaded.bytes.toString("utf8"), reviewerLoaded.sha256);
	if (!reviewerManifest.value || reviewerManifest.value.verdict !== "approved" || JSON.stringify(reviewerManifest.value.subject) !== JSON.stringify(approval.subject) || reviewerManifest.value.identity.attemptId !== reviewer.id || reviewerManifest.value.identity.runId !== journal.run.id || reviewerManifest.value.identity.taskId !== task.contract.id || reviewerManifest.value.report.sha256.length === 0) return { message: reviewerManifest.message ?? "Protected Reviewer manifest is invalid or no longer binds the Approval." };
	return { subject: derived.value, builder, reviewer, builderManifest: builderManifest.value, reviewerManifest: reviewerManifest.value };
}

function completionIntegrationIdentity(journal: RunJournal, task: TaskRecord, evidence: { subject: ReviewSubject; builder: BuilderAttemptRecord; reviewer: ReviewerAttemptRecord }, targetRevision?: string): TaskIntegration | undefined {
	if (journal.run.integrationBase.kind !== "git" || evidence.subject.kind !== "git" || evidence.builder.evidence?.phase !== "finalized" || evidence.reviewer.evidence?.phase !== "finalized") return undefined;
	const target = targetRevision ?? task.integrationRecoveries?.at(-1)?.observed.head ?? task.finalVerificationReworks?.at(-1)?.priorIntegration.observedHead ?? journal.run.integrationBase.revision;
	const action = target === evidence.subject.baseRevision ? { kind: "fast-forward" as const, argv: ["merge", "--ff-only", "--no-edit", evidence.subject.headRevision] as ["merge", "--ff-only", "--no-edit", string] } : { kind: "merge-commit" as const, argv: ["merge", "--no-ff", "--no-edit", evidence.subject.headRevision] as ["merge", "--no-ff", "--no-edit", string] };
	return {
		phase: "intended",
		targetBranch: journal.run.integrationBase.branch,
		targetRevision: target,
		approvedBaseRevision: evidence.subject.baseRevision,
		approvedHeadRevision: evidence.subject.headRevision,
		approvedCommits: [...evidence.subject.commits],
		builderAttemptId: evidence.builder.id,
		reviewerAttemptId: evidence.reviewer.id,
		builderManifestSha256: evidence.builder.evidence.manifestSha256,
		reviewerManifestSha256: evidence.reviewer.evidence.manifestSha256,
		action,
		intendedAt: "",
	};
}

function integrationIdentityMatches(actual: TaskIntegration, expected: TaskIntegration): boolean {
	return actual.targetBranch === expected.targetBranch
		&& actual.targetRevision === expected.targetRevision
		&& actual.approvedBaseRevision === expected.approvedBaseRevision
		&& actual.approvedHeadRevision === expected.approvedHeadRevision
		&& JSON.stringify(actual.approvedCommits) === JSON.stringify(expected.approvedCommits)
		&& actual.builderAttemptId === expected.builderAttemptId
		&& actual.reviewerAttemptId === expected.reviewerAttemptId
		&& actual.builderManifestSha256 === expected.builderManifestSha256
		&& actual.reviewerManifestSha256 === expected.reviewerManifestSha256
		&& JSON.stringify(actual.action) === JSON.stringify(expected.action);
}

function integrationIdentityOnly(identity: TaskIntegration): ApprovedIntegrationIdentity {
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
		action: identity.action.kind === "fast-forward"
			? { kind: "fast-forward", argv: [...identity.action.argv] as ["merge", "--ff-only", "--no-edit", string] }
			: { kind: "merge-commit", argv: [...identity.action.argv] as ["merge", "--no-ff", "--no-edit", string] },
	};
}

function completionIntegrationInput(repositoryRoot: string, integration: Extract<TaskIntegration, { phase: "integrated" }>): IntegrationCheckoutInput {
	return {
		repositoryRoot,
		targetBranch: integration.targetBranch,
		targetRevision: integration.targetRevision,
		approvedBaseRevision: integration.approvedBaseRevision,
		approvedHeadRevision: integration.approvedHeadRevision,
		approvedCommits: [...integration.approvedCommits],
	};
}

function integrationObservationExact(input: IntegrationCheckoutInput, result: import("./steward.ts").IntegrationCheckoutResult): boolean {
	if (result.kind !== "inspected" || !result.observation.rangeExact || result.observation.branch !== input.targetBranch || result.observation.dirtyPaths.length !== 0 || result.observation.operationMarkers.length !== 0 || result.resolvedBaseRevision !== input.approvedBaseRevision || result.resolvedHeadRevision !== input.approvedHeadRevision || JSON.stringify(result.commits) !== JSON.stringify(input.approvedCommits)) return false;
	return input.targetRevision === input.approvedBaseRevision ? result.observation.head === input.approvedHeadRevision : result.observation.head !== null && result.observation.head !== input.targetRevision && /^[0-9a-f]{40}$/.test(result.observation.head);
}

function integrationObservationUnchanged(input: IntegrationCheckoutInput, result: import("./steward.ts").IntegrationCheckoutResult): boolean {
	return result.kind === "inspected" && result.observation.branch === input.targetBranch && result.observation.head === input.targetRevision && result.observation.dirtyPaths.length === 0 && result.observation.operationMarkers.length === 0;
}

function integrationFactsAvailable(result: import("./steward.ts").IntegrationCheckoutResult): result is Extract<import("./steward.ts").IntegrationCheckoutResult, { kind: "inspected" }> & { target: IntegrationTargetFacts; application: IntegrationApplication } {
	return result.kind === "inspected" && result.target !== undefined && result.application !== undefined;
}

function integrationTargetDiagnostic(input: IntegrationCheckoutInput, result: Extract<import("./steward.ts").IntegrationCheckoutResult, { kind: "inspected" }>): string {
	const target = result.target;
	const expected = `${input.targetBranch}@${input.targetRevision}`;
	const observed = `${target?.observedBranch ?? result.observation.branch ?? "detached"}@${target?.observedHead ?? result.observation.head ?? "unknown"}`;
	const relation = target?.relation ?? "unavailable";
	const dirty = result.observation.dirtyPaths.length > 0 ? ` dirty=${result.observation.dirtyPaths.join(",")}` : "";
	const markers = result.observation.operationMarkers.length > 0 ? ` markers=${result.observation.operationMarkers.join(",")}` : "";
	const delta = result.difference ? ` deltaCommits=${result.difference.commits.join(",") || "none"} deltaPaths=${result.difference.changedPaths.map((change) => `${change.status}:${change.paths.join("→")}`).join(",") || "none"}${result.difference.truncated ? " delta=truncated" : ""}` : "";
	return `Integration target expected ${expected}; observed ${observed}; relation=${relation}.${dirty}${markers}${delta}`.slice(0, 2_000);
}

function integrationAmbiguousRecord(identity: TaskIntegration, result: Extract<import("./steward.ts").IntegrationCheckoutResult, { kind: "inspected" }>, observedAt: string, diagnostic: string): Extract<TaskIntegration, { phase: "ambiguous" }> {
	return {
		...integrationIdentityOnly(identity),
		phase: "ambiguous",
		intendedAt: "intendedAt" in identity && identity.intendedAt.length > 0 ? identity.intendedAt : observedAt,
		observedAt,
		exitCode: null,
		diagnostic: diagnostic.slice(0, 2_000),
		observed: { ...result.observation, dirtyPaths: [...result.observation.dirtyPaths], operationMarkers: [...result.observation.operationMarkers] },
		...(result.difference ? { difference: { commits: [...result.difference.commits], changedPaths: result.difference.changedPaths.map((change) => ({ status: change.status, paths: [...change.paths] })), truncated: result.difference.truncated } } : {}),
	};
}

async function persistIntegrationObservation(repositoryRoot: string, journal: RunJournal, taskIndex: number, identity: TaskIntegration, result: Extract<import("./steward.ts").IntegrationCheckoutResult, { kind: "inspected" }>, diagnostic: string, dependencies: StewardDependencies): Promise<CompletionDecision> {
		const observedAt = transitionTimestamp(journal, dependencies.clock.now());
		const ambiguous = integrationAmbiguousRecord(identity, result, observedAt, diagnostic);
		let candidate: RunJournal;
		try {
			candidate = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
				const task = next.run.tasks[taskIndex];
				if (!task) throw new Error("Integration Task disappeared while retaining its target observation.");
				if (task.integration && !integrationIdentityMatches(task.integration, identity)) throw new Error("Integration identity changed before retaining its target observation.");
				task.phase = "integrating";
				task.integration = ambiguous;
				task.attention = "needs-user";
				task.attentionReason = "integration-ambiguous";
				task.attentionDiagnostic = diagnostic.slice(0, 2_000);
			});
		} catch (error: unknown) {
			return { journal, note: `Integration observation could not be retained; no Git effect was attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` };
		}
		const persisted = await persistReviewJournal(repositoryRoot, candidate, dependencies);
		return persisted ? { journal: persisted, note: diagnostic.slice(0, 2_000), action: "record-observation" } : { journal, note: `Integration observation could not be persisted; no Git effect was attempted. ${diagnostic.slice(0, 1_700)}` };
}

async function persistIntegrationIntegrated(repositoryRoot: string, journal: RunJournal, taskIndex: number, identity: TaskIntegration, integrationHead: string, dependencies: StewardDependencies): Promise<CompletionDecision> {
		const integratedAt = transitionTimestamp(journal, dependencies.clock.now());
		let candidate: RunJournal;
		try {
			candidate = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
				const task = next.run.tasks[taskIndex];
				if (!task || !task.integration || !integrationIdentityMatches(task.integration, identity)) throw new Error("Integration identity changed before recording exact application.");
				const base = integrationIdentityOnly(identity);
				task.integration = { ...base, phase: "integrated", intendedAt: "intendedAt" in identity && identity.intendedAt.length > 0 ? identity.intendedAt : integratedAt, integratedAt, observedHead: integrationHead };
				task.phase = "integrating";
				task.attention = "none";
				delete task.attentionReason;
				delete task.attentionDiagnostic;
			});
		} catch (error: unknown) {
			return { journal, note: `Exact integration application was observed but could not be retained; no merge retry was attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` };
		}
		const persisted = await persistReviewJournal(repositoryRoot, candidate, dependencies);
		return persisted ? { journal: persisted, note: `Exact approved integration application was recognized at ${integrationHead}; no merge was repeated.`, action: "record-observation" } : { journal, note: "Exact integration application was observed but its classification could not be persisted; no merge retry was attempted." };
}

async function persistIntegrationFailed(repositoryRoot: string, journal: RunJournal, taskIndex: number, identity: TaskIntegration, exitCode: number | null, diagnostic: string, dependencies: StewardDependencies): Promise<CompletionDecision> {
	const observedAt = transitionTimestamp(journal, dependencies.clock.now());
	const failed: Extract<TaskIntegration, { phase: "failed" }> = { ...integrationIdentityOnly(identity), phase: "failed", intendedAt: "intendedAt" in identity && identity.intendedAt.length > 0 ? identity.intendedAt : observedAt, observedAt, exitCode, diagnostic: diagnostic.slice(0, 2_000) };
	let candidate: RunJournal;
	try {
		candidate = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
			const task = next.run.tasks[taskIndex];
			if (!task || !task.integration || !integrationIdentityMatches(task.integration, identity)) throw new Error("Integration identity changed before recording its failed fixed action.");
			task.integration = failed;
			task.phase = "integrating";
			task.attention = "needs-user";
			task.attentionReason = "integration-failed";
			task.attentionDiagnostic = diagnostic.slice(0, 2_000);
		});
	} catch (error: unknown) {
		return { journal, note: `The absent clean target after the fixed integration action could not be retained as failed; no merge retry was attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` };
	}
	const persisted = await persistReviewJournal(repositoryRoot, candidate, dependencies);
	return persisted ? { journal: persisted, note: diagnostic.slice(0, 2_000), action: "record-observation" } : { journal, note: "The fixed integration action failed at the unchanged clean target, but its failure could not be persisted; no merge retry was attempted." };
}

async function reconcileTaskIntegration(input: {
	repositoryRoot: string;
	journal: RunJournal;
	taskIndex: number;
	task: TaskRecord;
	evidence: { subject: ReviewSubject; builder: BuilderAttemptRecord; reviewer: ReviewerAttemptRecord };
	integrationInput: IntegrationCheckoutInput;
	dependencies: StewardDependencies;
}): Promise<CompletionDecision | undefined> {
	let journal = input.journal;
	let task = journal.run.tasks[input.taskIndex] ?? input.task;
	const current = task.integration;
	const expected = completionIntegrationIdentity(journal, task, input.evidence, input.integrationInput.targetRevision);
	if (!expected) return persistCompletionAttention(input.repositoryRoot, journal, task.contract.id, "integration-preflight", "Approved integration identity could not be reconstructed from protected Git evidence.", input.dependencies);
	if (current && !integrationIdentityMatches(current, expected)) return persistCompletionAttention(input.repositoryRoot, journal, task.contract.id, "integration-ambiguous", "Persisted integration identity no longer matches the current protected Approval and finalized evidence; no Git effect was attempted.", input.dependencies);
	const result = await inspectCompletionCheckout(input.integrationInput, input.dependencies);
	if (!integrationFactsAvailable(result)) return result.kind === "unavailable" ? persistCompletionAttention(input.repositoryRoot, journal, task.contract.id, "integration-preflight", `Integration checkout could not be inspected: ${result.message}`, input.dependencies) : undefined;
	const dirtyOrInProgress = result.observation.dirtyPaths.length > 0 || result.observation.operationMarkers.length > 0;
	const targetDiagnostic = integrationTargetDiagnostic(input.integrationInput, result);
	const persistedIdentity = current ?? expected;
	const hasPersistedIntent = current !== undefined;

	if (dirtyOrInProgress) {
		if (!hasPersistedIntent) return persistIntegrationObservation(input.repositoryRoot, journal, input.taskIndex, { ...expected, intendedAt: transitionTimestamp(journal, input.dependencies.clock.now()) }, result, `Git integration checkout is dirty or has an operation in progress; Steward preserved it without abort/reset/revert/checkout/clean. ${targetDiagnostic}`, input.dependencies);
		if (current?.phase === "integrated") return persistCompletionAttention(input.repositoryRoot, journal, task.contract.id, "integration-ambiguous", `The integrated target is now dirty or in progress; Git bytes and markers were preserved. ${targetDiagnostic}`, input.dependencies);
		return persistIntegrationObservation(input.repositoryRoot, journal, input.taskIndex, persistedIdentity, result, `Git integration checkout is dirty or has an operation in progress; Steward preserved all Git bytes and markers without an abort/reset/revert/checkout/clean effect. ${targetDiagnostic}`, input.dependencies);
	}

	if (result.target?.relation === "branch-changed") {
		const identity = hasPersistedIntent ? persistedIdentity : { ...expected, intendedAt: transitionTimestamp(journal, input.dependencies.clock.now()) };
		return persistIntegrationObservation(input.repositoryRoot, journal, input.taskIndex, identity, result, `Integration target branch changed; no Git mutation was attempted. ${targetDiagnostic}`, input.dependencies);
	}

	if (result.application.kind === "exact") {
		if (!hasPersistedIntent) return persistCompletionAttention(input.repositoryRoot, journal, task.contract.id, "integration-preflight", `The approved range is present externally, but no persisted Steward integration intent exists; success was not inferred. ${targetDiagnostic}`, input.dependencies);
		if (current?.phase === "integrated") return { journal, note: `Exact integration remains recorded at ${current.observedHead}; later target movement was not folded into Steward success.` };
		return persistIntegrationIntegrated(input.repositoryRoot, journal, input.taskIndex, persistedIdentity, result.application.integrationHead, input.dependencies);
	}

	if (result.target?.relation === "advanced" && result.mergeability?.kind === "conflicted" && result.difference && current?.phase !== "integrated") {
		const limit = journal.run.effectiveSettings.reworkCycleLimit;
		if (task.reworkCycles < limit) {
			return dispatchIntegrationReworkBuilder(input.repositoryRoot, journal, { index: input.taskIndex, task, builder: input.evidence.builder, reviewer: input.evidence.reviewer }, persistedIdentity, result, result.difference, result.mergeability.paths, input.dependencies);
		}
	}

	const movement = result.target?.relation !== "recorded";
	if (movement || result.mergeability?.kind === "unavailable" || result.mergeability?.kind === "clean") {
		const reason = result.mergeability?.kind === "unavailable" ? `Merge-tree classification was unavailable; no integration-rework Attempt was created. ${result.mergeability.diagnostic}` : movement ? "The recorded target moved or changed branch; no Git mutation was attempted." : "The advanced target is cleanly mergeable, but Steward does not invent a new integration action from movement facts.";
		if (!hasPersistedIntent) return persistIntegrationObservation(input.repositoryRoot, journal, input.taskIndex, { ...expected, intendedAt: transitionTimestamp(journal, input.dependencies.clock.now()) }, result, `${reason} ${targetDiagnostic}`, input.dependencies);
		return persistIntegrationObservation(input.repositoryRoot, journal, input.taskIndex, persistedIdentity, result, `${reason} ${targetDiagnostic}`, input.dependencies);
	}

	if (result.target?.relation === "recorded" && result.application.kind === "absent") {
		if (!hasPersistedIntent) {
			const intendedAt = transitionTimestamp(journal, input.dependencies.clock.now());
			let intended: RunJournal;
			try {
				intended = advanceRunJournal(journal, input.dependencies.clock.now(), (next) => {
					const nextTask = next.run.tasks[input.taskIndex];
					if (!nextTask || nextTask.integration) throw new Error("Integration Task changed before initial intent.");
					nextTask.phase = "integrating";
					nextTask.attention = "none";
					delete nextTask.attentionReason;
					delete nextTask.attentionDiagnostic;
					nextTask.integration = { ...expected, phase: "intended", intendedAt };
				});
			} catch (error: unknown) {
				return { journal, note: `Integration intent could not be persisted; no Git merge was attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` };
			}
			const persisted = await persistReviewJournal(input.repositoryRoot, intended, input.dependencies);
			if (!persisted) return { journal, note: "Integration intent could not be persisted; no Git merge was attempted." };
			journal = persisted;
			task = journal.run.tasks[input.taskIndex]!;
		}
		const activeIdentity = journal.run.tasks[input.taskIndex]?.integration;
		if (!activeIdentity || (activeIdentity.phase !== "intended" && activeIdentity.phase !== "retry-intended")) return { journal, note: "Integration intent is no longer eligible for one fixed recovery action; no merge was attempted." };
		if (activeIdentity.phase === "retry-intended") return persistIntegrationObservation(input.repositoryRoot, journal, input.taskIndex, activeIdentity, result, "The retry-intended integration remains absent at the unchanged clean target; acknowledgement is ambiguous and no third merge was attempted.", input.dependencies);
		const retryIntendedAt = transitionTimestamp(journal, input.dependencies.clock.now());
		let retry: RunJournal;
		try {
			retry = advanceRunJournal(journal, input.dependencies.clock.now(), (next) => {
				const nextTask = next.run.tasks[input.taskIndex];
				if (!nextTask?.integration || nextTask.integration.phase !== "intended" || !integrationIdentityMatches(nextTask.integration, activeIdentity)) throw new Error("Integration intent changed before retry reservation.");
				nextTask.integration = { ...nextTask.integration, phase: "retry-intended", retryIntendedAt };
			});
		} catch (error: unknown) {
			return { journal, note: `Integration retry reservation could not be built; no Git merge was attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` };
		}
		const persistedRetry = await persistReviewJournal(input.repositoryRoot, retry, input.dependencies);
		if (!persistedRetry) return { journal, note: "Integration retry reservation could not be persisted; no Git merge was attempted." };
		journal = persistedRetry;
		const stored = journal.run.tasks[input.taskIndex]?.integration;
		if (!stored || stored.phase !== "retry-intended") return { journal, note: "Integration retry reservation disappeared after CAS; no Git merge was attempted." };
		let outcome: GitCommandOutcome;
		try { outcome = input.dependencies.git.integrateApprovedRange ? await input.dependencies.git.integrateApprovedRange({ ...input.integrationInput, action: stored.action }) : { kind: "thrown", message: "Integration effect adapter is unavailable." }; }
		catch (error: unknown) { outcome = { kind: "thrown", message: error instanceof Error ? error.message : "Integration retry failed." }; }
		const post = await inspectCompletionCheckout(input.integrationInput, input.dependencies);
		if (!integrationFactsAvailable(post)) return { journal, note: `Integration retry acknowledgement is ambiguous; retry-intended remains durable and no merge was repeated. ${post.kind === "unavailable" ? post.message : "The post-probe omitted strict application facts."}`, action: "integrate-approved-range" };
		if (post.observation.dirtyPaths.length > 0 || post.observation.operationMarkers.length > 0) return persistIntegrationObservation(input.repositoryRoot, journal, input.taskIndex, stored, post, `Integration retry left a dirty or in-progress checkout; all Git bytes and markers were preserved. ${integrationTargetDiagnostic(input.integrationInput, post)}`, input.dependencies);
		if (post.application.kind === "exact") return persistIntegrationIntegrated(input.repositoryRoot, journal, input.taskIndex, stored, post.application.integrationHead, input.dependencies);
		const outcomeText = outcome.kind === "completed" ? (outcome.stderr.trim() || `Git integration exited with code ${outcome.code}.`) : outcome.message;
		if (post.target?.relation === "recorded" && outcome.kind === "completed") return persistIntegrationFailed(input.repositoryRoot, journal, input.taskIndex, stored, outcome.code, `The fixed integration action did not apply at the unchanged clean target (${outcomeText}); no third merge was attempted. ${integrationTargetDiagnostic(input.integrationInput, post)}`, input.dependencies);
		return persistIntegrationObservation(input.repositoryRoot, journal, input.taskIndex, stored, post, `The fixed integration retry returned without exact application (${outcomeText}); acknowledgement is ambiguous and no third merge was attempted. ${integrationTargetDiagnostic(input.integrationInput, post)}`, input.dependencies);
	}
	return undefined;
}

async function inspectCompletionCheckout(input: IntegrationCheckoutInput, dependencies: StewardDependencies): Promise<import("./steward.ts").IntegrationCheckoutResult> {
	if (!dependencies.git.inspectIntegrationCheckout) return { kind: "unavailable", message: "Read-only integration checkout inspection is unavailable." };
	try { return await dependencies.git.inspectIntegrationCheckout(input); }
	catch (error: unknown) { return { kind: "unavailable", message: error instanceof Error ? error.message : "Integration checkout inspection failed." }; }
}

function completionResources(journal: RunJournal): CompletionAgentIdentity[] {
	const resources: CompletionAgentIdentity[] = [];
	const seen = new Set<string>();
	for (const task of journal.run.tasks) {
		for (const attempt of task.attempts) {
			const dispatch = attempt.dispatch;
			if (dispatch.phase !== "prompted" && dispatch.phase !== "reconciled-active") continue;
			const resource: CompletionAgentIdentity = { role: attempt.role, agentName: dispatch.agentName, workspaceId: dispatch.workspaceId, paneId: dispatch.paneId, terminalId: dispatch.terminalId };
			const key = `${resource.role}/${resource.agentName}/${resource.workspaceId}/${resource.paneId}/${resource.terminalId}`;
			if (!seen.has(key)) { seen.add(key); resources.push(resource); }
		}
	}
	return resources;
}

function completionResourceKey(resource: CompletionAgentIdentity): string {
	return `${resource.role}/${resource.agentName}/${resource.workspaceId}/${resource.paneId}/${resource.terminalId}`;
}

function completionGateFacts(journal: RunJournal, checkout: IntegrationCheckoutObservation, dependencies: StewardDependencies): AnyCompletionGateFacts | undefined {
	const result = evaluateCompletionGate(journal, checkout);
	if (!result.passed) return undefined;
	const evaluatedAt = transitionTimestamp(journal, dependencies.clock.now());
	if ("kind" in result.facts) return { ...result.facts, evaluatedAt, predicates: [...result.facts.predicates] };
	return { ...result.facts, evaluatedAt, predicates: [...COMPLETION_GATE_PREDICATES] };
}

function cloneIntegratedIdentity(integration: Extract<TaskIntegration, { phase: "integrated" }>): Extract<TaskIntegration, { phase: "integrated" }> {
	return {
		...integration,
		approvedCommits: [...integration.approvedCommits],
		action: integration.action.kind === "fast-forward"
			? { kind: "fast-forward", argv: [...integration.action.argv] as ["merge", "--ff-only", "--no-edit", string] }
			: { kind: "merge-commit", argv: [...integration.action.argv] as ["merge", "--no-ff", "--no-edit", string] },
	};
}

function managedVerificationPaths(paths: CompletionPaths): FinalVerificationAttemptPaths {
	return { runtimeDirectory: paths.runtimeDirectory, descriptorPath: paths.descriptorPath, stdoutPath: paths.stdoutPath, stderrPath: paths.stderrPath, candidateResultPath: paths.candidateResultPath, logPath: paths.verificationLogPath, resultPath: paths.verificationResultPath };
}

function managedVerificationNonce(runId: string, attemptId: FinalVerificationAttemptId, command: string, cwd: string): string {
	return sha256Bytes(Buffer.from(`${runId}\n${attemptId}\n${command}\n${cwd}`, "utf8"));
}

function managedCompleteObservationFromResult(result: { startedAt: string; completedAt: string; exitCode: number; killed: false; logSha256: string; resultSha256: string }, checkout: IntegrationCheckoutObservation): Extract<FinalVerificationAttemptObservation, { kind: "complete" }> {
	return { kind: "complete", startedAt: result.startedAt, completedAt: result.completedAt, exitCode: result.exitCode, killed: false, logSha256: result.logSha256, resultSha256: result.resultSha256, checkout: { ...checkout, dirtyPaths: [...checkout.dirtyPaths], operationMarkers: [...checkout.operationMarkers] } };
}

function managedFinalVerificationAvailable(dependencies: StewardDependencies): boolean {
	return Boolean(dependencies.runJournal.resolveCompletionPaths && dependencies.runJournal.inspectFinalVerificationResult && dependencies.runJournal.finalizeVerificationResult && dependencies.process.launchApprovedVerification && dependencies.process.inspectApprovedVerification);
}

function managedExecutionLast(execution: RecoverableFinalVerificationExecution): FinalVerificationAttempt {
	return execution.attempts[execution.attempts.length - 1]!;
}

function managedExecutionComplete(execution: RecoverableFinalVerificationExecution): Extract<FinalVerificationAttemptObservation, { kind: "complete" }> | undefined {
	const observation = managedExecutionLast(execution).observation;
	return observation?.kind === "complete" ? observation : undefined;
}

function isFinalVerificationReworkDispatchForSteward(dispatch: AttemptRecord["dispatch"]): dispatch is FinalVerificationReworkDispatchRecord {
	return "verificationRework" in dispatch;
}

async function persistManagedFinalVerificationAmbiguous(repositoryRoot: string, journal: RunJournal, diagnostic: string, dependencies: StewardDependencies): Promise<CompletionDecision> {
	const current = journal.run.finalVerificationExecution;
	if (!current || !isRecoverableFinalVerificationExecution(current)) return { journal, note: diagnostic };
	if (current.phase === "ambiguous" && current.attempts.at(-1)?.observation?.kind === "ambiguous") return { journal, note: diagnostic };
	const observedAt = transitionTimestamp(journal, dependencies.clock.now());
	let candidate: RunJournal;
	try {
		candidate = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
			const execution = next.run.finalVerificationExecution;
			if (!execution || !isRecoverableFinalVerificationExecution(execution)) throw new Error("Managed final-verification execution disappeared before ambiguity classification.");
			execution.phase = "ambiguous";
			execution.attempts[execution.attempts.length - 1]!.observation = { kind: "ambiguous", observedAt, diagnostic: diagnostic.slice(0, 2_000) };
			for (const task of next.run.tasks) { task.attention = "needs-user"; task.attentionReason = "final-verification-ambiguous"; task.attentionDiagnostic = diagnostic.slice(0, 2_000); }
		});
	} catch (error: unknown) {
		return { journal, note: `Final-verification ambiguity could not be retained; no rerun or interference was attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` };
	}
	const persisted = await persistReviewJournal(repositoryRoot, candidate, dependencies);
	return persisted ? { journal: persisted, note: diagnostic, action: "run-final-verification" } : { journal, note: "Final-verification ambiguity could not be persisted; no rerun or interference was attempted." };
}

async function persistManagedFinalVerificationOwnershipUnclear(repositoryRoot: string, journal: RunJournal, diagnostic: string, dependencies: StewardDependencies): Promise<CompletionDecision> {
	if (journal.run.tasks.length === 0 || journal.run.tasks.every((task) => task.attention === "needs-user" && task.attentionReason === "final-verification-ownership-unclear")) return { journal, note: diagnostic };
	let candidate: RunJournal;
	try {
		candidate = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
			for (const task of next.run.tasks) {
				task.attention = "needs-user";
				task.attentionReason = "final-verification-ownership-unclear";
				task.attentionDiagnostic = diagnostic.slice(0, 2_000);
			}
		});
	} catch (error: unknown) {
		return { journal, note: `Final-verification ownership ambiguity could not be retained; no rework or interference was attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` };
	}
	const persisted = await persistReviewJournal(repositoryRoot, candidate, dependencies);
	return persisted ? { journal: persisted, note: diagnostic } : { journal, note: "Final-verification ownership ambiguity could not be persisted; no rework or interference was attempted." };
}

async function appendManagedRecoveryAttempt(repositoryRoot: string, journal: RunJournal, execution: RecoverableFinalVerificationExecution, diagnostic: string, dependencies: StewardDependencies): Promise<CompletionDecision> {
	if (execution.attempts.length !== 1) return persistManagedFinalVerificationAmbiguous(repositoryRoot, journal, "The recorded recovery attempt is non-live without a complete result; no third final-verification launch is permitted.", dependencies);
	const first = execution.attempts[0]!;
	const observedAt = transitionTimestamp(journal, dependencies.clock.now());
	const paths = dependencies.runJournal.resolveCompletionPaths!(repositoryRoot, journal.run.id, undefined, "verification-02");
	const second: FinalVerificationAttempt = { id: "verification-02", kind: "recovery-rerun", intendedAt: transitionTimestamp(journal, dependencies.clock.now()), paths: managedVerificationPaths(paths) };
	let candidate: RunJournal;
	try {
		candidate = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
			const current = next.run.finalVerificationExecution;
			if (!current || !isRecoverableFinalVerificationExecution(current) || current.attempts.length !== 1 || current.attempts[0]!.id !== first.id) throw new Error("Final-verification recovery predecessor changed before reservation.");
			current.attempts[0]!.observation = { kind: "inconclusive", observedAt, diagnostic: diagnostic.slice(0, 2_000) };
			current.attempts.push({ ...second, paths: { ...second.paths } });
			current.phase = "executing";
		});
	} catch (error: unknown) {
		return { journal, note: `Final-verification recovery reservation failed before the second launch. ${error instanceof Error ? error.message : "Journal validation failed."}` };
	}
	const persisted = await persistReviewJournal(repositoryRoot, candidate, dependencies);
	return persisted ? { journal: persisted, note: "The first final-verification attempt is durably non-live; one deterministic recovery rerun is reserved for the next Controller pass.", action: "run-final-verification" } : { journal, note: "Final-verification recovery reservation could not be persisted; no second launch was attempted." };
}

async function launchManagedFinalVerification(repositoryRoot: string, journal: RunJournal, execution: RecoverableFinalVerificationExecution, dependencies: StewardDependencies): Promise<CompletionDecision> {
	if (!runAllowsWorkflowAdvance(journal)) return { journal, note: "The Run is cancelled; final verification is dormant and no process was launched." };
	const attempt = managedExecutionLast(execution);
	const nonce = managedVerificationNonce(journal.run.id, attempt.id, execution.command, execution.cwd);
	const input: ManagedVerificationInput = { repositoryRoot, runId: journal.run.id, attemptId: attempt.id, command: execution.command, cwd: execution.cwd, executionNonce: nonce, paths: attempt.paths };
	let launched: ManagedVerificationLaunchResult;
	try { launched = await dependencies.process.launchApprovedVerification!(input); }
	catch (error: unknown) { launched = { kind: "unclear", diagnostic: error instanceof Error ? error.message : "Managed final-verification launch failed." }; }
	if (launched.kind === "not-launched") {
		if (attempt.id === "verification-01") return appendManagedRecoveryAttempt(repositoryRoot, journal, execution, launched.diagnostic ?? "The initial managed verification did not cross its publication boundary.", dependencies);
		return persistManagedFinalVerificationAmbiguous(repositoryRoot, journal, launched.diagnostic ?? "The recovery managed verification did not cross its publication boundary; no third launch is permitted.", dependencies);
	}
	if (launched.kind !== "launched" || launched.executionNonce !== nonce || !launched.pid || !Number.isSafeInteger(launched.pid) || launched.pid <= 0 || !launched.startToken || !launched.argvSha256 || !/^sha256:[0-9a-f]{64}$/.test(launched.argvSha256) || !launched.launchedAt) return persistManagedFinalVerificationAmbiguous(repositoryRoot, journal, launched.diagnostic ?? "Managed final-verification launch identity was unclear; no rerun or signal was attempted.", dependencies);
	const processIdentity: FinalVerificationProcessIdentity = { pid: launched.pid, startToken: launched.startToken, executionNonce: nonce, commandSha256: sha256Bytes(Buffer.from(execution.command, "utf8")), argvSha256: launched.argvSha256, launchedAt: launched.launchedAt };
	let candidate: RunJournal;
	try {
		candidate = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
			const current = next.run.finalVerificationExecution;
			if (!current || !isRecoverableFinalVerificationExecution(current) || current.attempts.at(-1)?.id !== attempt.id || current.attempts.at(-1)?.process) throw new Error("Final-verification launch predecessor changed before process identity CAS.");
			current.attempts[current.attempts.length - 1]!.process = { ...processIdentity };
		});
	} catch (error: unknown) {
		return { journal, note: `Managed final-verification launch was acknowledged but its process identity CAS lost; the next owner must inspect the exact descriptor. ${error instanceof Error ? error.message : "Journal validation failed."}` };
	}
	const persisted = await persistReviewJournal(repositoryRoot, candidate, dependencies);
	return persisted ? { journal: persisted, note: `Managed final verification ${attempt.id} launched with the frozen command; the exact process identity is durable.`, action: "run-final-verification" } : { journal, note: "Managed final-verification launch identity could not be persisted; no second launch or signal was attempted." };
}

async function consumeManagedFinalVerificationResult(input: { repositoryRoot: string; journal: RunJournal; execution: RecoverableFinalVerificationExecution; checkoutInput: IntegrationCheckoutInput; inspectCheckout: () => Promise<import("./steward.ts").IntegrationCheckoutResult>; dependencies: StewardDependencies }): Promise<CompletionDecision | undefined> {
	const { repositoryRoot, journal, execution, checkoutInput, inspectCheckout, dependencies } = input;
	const lastAttempt = managedExecutionLast(execution);
	const command = execution.command;
	const inspected = await dependencies.runJournal.inspectFinalVerificationResult!({ repositoryRoot, runId: journal.run.id, command, cwd: execution.cwd, attemptId: lastAttempt.id, executionNonce: lastAttempt.process?.executionNonce, argvSha256: lastAttempt.process?.argvSha256 });
	if (inspected.kind !== "complete") return undefined;
	let completeResult = inspected;
	if (inspected.source === "candidate") {
		if (!inspected.evidence) return persistManagedFinalVerificationAmbiguous(repositoryRoot, journal, "A managed candidate was complete but could not be bound to canonical immutable evidence; no rerun was attempted.", dependencies);
		let published: VerificationFinalizeResult;
		try { published = await dependencies.runJournal.finalizeVerificationResult!({ ...inspected.evidence }); }
		catch (error: unknown) { published = { kind: "storage-error", paths: inspected.paths, message: error instanceof Error ? error.message : "Canonical verification publication failed." }; }
		if (published.kind !== "created" && published.kind !== "existing-match") return persistManagedFinalVerificationAmbiguous(repositoryRoot, journal, `Complete managed verification evidence could not be published without clobbering bytes: ${"message" in published ? published.message : "unknown storage failure"}`, dependencies);
		completeResult = { ...inspected, source: "canonical", result: published.result, resultBytes: Buffer.from(JSON.stringify(published.result, null, 2) + "\n", "utf8"), logSha256: published.logSha256, resultSha256: published.resultSha256, paths: published.paths };
	}
	const post = await inspectCheckout();
	if (post.kind !== "inspected") return persistManagedFinalVerificationAmbiguous(repositoryRoot, journal, `Complete final-verification evidence is durable, but the fresh checkout observation is unavailable: ${post.message}`, dependencies);
	const checkout = post.observation;
	const exact = integrationObservationExact(checkoutInput, post);
	const dirtied = checkout.dirtyPaths.length > 0 || checkout.operationMarkers.length > 0;
	const observation = managedCompleteObservationFromResult({ ...completeResult.result, resultSha256: completeResult.resultSha256 }, checkout);
	const terminalPhase: RecoverableFinalVerificationExecution["phase"] = exact ? (completeResult.result.exitCode === 0 ? "passed" : "failed") : "ambiguous";
	const reason: TaskAttentionReason | undefined = exact ? undefined : dirtied ? "verification-dirtied-checkout" : "final-verification-ambiguous";
	let candidate: RunJournal;
	try {
		candidate = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
			const current = next.run.finalVerificationExecution;
			if (!current || !isRecoverableFinalVerificationExecution(current) || current.attempts.at(-1)?.id !== lastAttempt.id) throw new Error("Final-verification result predecessor changed before classification.");
			current.phase = terminalPhase;
			current.attempts[current.attempts.length - 1]!.observation = observation;
			if (reason) for (const task of next.run.tasks) { task.attention = "needs-user"; task.attentionReason = reason; task.attentionDiagnostic = dirtied ? `Verification preserved checkout dirt: ${[...checkout.dirtyPaths].sort().join(", ") || "none"}${checkout.operationMarkers.length > 0 ? `; markers: ${[...checkout.operationMarkers].sort().join(", ")}` : ""}.` : "Final verification could not be classified against the exact fresh checkout."; }
		});
	} catch (error: unknown) {
		return { journal, note: `Complete final-verification evidence was preserved but classification CAS was lost; no rerun was attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` };
	}
	const persisted = await persistReviewJournal(repositoryRoot, candidate, dependencies);
	return persisted ? { journal: persisted, note: terminalPhase === "passed" ? "Complete managed final-verification evidence was consumed without a rerun." : reason === "verification-dirtied-checkout" ? "Verification-created checkout dirt was preserved and blocks completion." : terminalPhase === "failed" ? "Complete managed final-verification failure was durably classified; ownership routing is queued." : "Final-verification evidence is durable but the fresh checkout is ambiguous.", action: "run-final-verification" } : { journal, note: "Complete final-verification classification could not be persisted; no rerun or routing was attempted." };
}

async function dispatchFinalVerificationRework(repositoryRoot: string, journalInput: RunJournal, execution: RecoverableFinalVerificationExecution, dependencies: StewardDependencies): Promise<CompletionDecision> {
	const journal = journalInput;
	if (journal.run.tasks.length !== 1) return persistManagedFinalVerificationOwnershipUnclear(repositoryRoot, journal, "Final-verification failure ownership is unclear because the Run contains multiple Tasks; integrations, Approval, evidence, and the failed result were preserved.", dependencies);
	const task = journal.run.tasks[0];
	const lastObservation = managedExecutionComplete(execution);
	if (!task || !task.integration || task.integration.phase !== "integrated" || !task.approval || task.approval.phase !== "valid" || !lastObservation || lastObservation.exitCode === 0 || lastObservation.checkout.dirtyPaths.length > 0 || lastObservation.checkout.operationMarkers.length > 0 || !lastObservation.checkout.rangeExact) return persistCompletionAttention(repositoryRoot, journal, task?.contract.id ?? "final-verification", "final-verification-ownership-unclear", "Final-verification failure ownership could not be proved from one exact clean integrated Approval; no rework was reserved.", dependencies);
	const builder = task.attempts.find((attempt): attempt is BuilderAttemptRecord => attempt.id === task.approval?.builderAttemptId && attempt.role === "builder");
	const reviewer = task.attempts.find((attempt): attempt is ReviewerAttemptRecord => attempt.id === task.approval?.reviewerAttemptId && attempt.role === "reviewer");
	const dispatch = builder?.dispatch;
	if (!builder || !reviewer || reviewer.state !== "reported" || reviewer.evidence?.phase !== "finalized" || reviewer.evidence.verdict !== "approved" || builder.evidence?.phase !== "finalized" || !dispatch || (dispatch.phase !== "prompted" && dispatch.phase !== "reconciled-active") || !dependencies.git.inspectBuilderWorktree || !dependencies.herdr.promptBuilder) return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "final-verification-ownership-unclear", "Final-verification failure ownership is unclear because the exact current Builder/Reviewer lineage is not uniquely provable; no rework was reserved.", dependencies);
	if (task.reworkCycles >= journal.run.effectiveSettings.reworkCycleLimit) return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "final-verification-failed", "Final-verification failed with the frozen rework budget exhausted; the failed result and integrated revision were preserved.", dependencies);
	let worktree: { kind: "ready"; head: string; clean: true } | { kind: "unavailable"; message: string };
	try { worktree = await dependencies.git.inspectBuilderWorktree(dispatch.worktreePath, reviewer.subject.kind === "git" ? reviewer.subject.headRevision : ""); }
	catch (error: unknown) { worktree = { kind: "unavailable", message: error instanceof Error ? error.message : "Builder worktree inspection failed." }; }
	if (reviewer.subject.kind !== "git" || worktree.kind !== "ready" || worktree.head !== reviewer.subject.headRevision || !worktree.clean) return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "final-verification-failed", `Same-Builder final-verification rework preflight failed; the failed result and integrated revision were preserved. ${worktree.kind === "unavailable" ? worktree.message : "The recorded Builder worktree is not the exact clean reviewed revision."}`, dependencies);
	const priorIntegration = cloneIntegratedIdentity(task.integration);
	const priorBuilderAttemptId = builder.id;
	const priorReviewerAttemptId = reviewer.id;
	const replacementBuilderAttemptId = `attempt-${String(task.attempts.length + 1).padStart(2, "0")}`;
	const failedExecution = { command: execution.command, attemptId: managedExecutionLast(execution).id, exitCode: lastObservation.exitCode, logPath: managedExecutionLast(execution).paths.logPath, resultPath: managedExecutionLast(execution).paths.resultPath, logSha256: lastObservation.logSha256, resultSha256: lastObservation.resultSha256 };
	const facts: FinalVerificationReworkFacts = { failedCommand: execution.command, failedAttemptId: failedExecution.attemptId, failedLogPath: failedExecution.logPath, failedResultPath: failedExecution.resultPath, failedLogSha256: failedExecution.logSha256, failedResultSha256: failedExecution.resultSha256, priorIntegration, priorBuilderAttemptId, priorReviewerAttemptId };
	const cycle = task.reworkCycles + 1;
	const reworkDispatch: FinalVerificationReworkDispatchRecord = { phase: "assignment-intended", branch: dispatch.branch, agentName: dispatch.agentName, worktreePath: dispatch.worktreePath, workspaceId: dispatch.workspaceId, paneId: dispatch.paneId, terminalId: dispatch.terminalId, cycle, priorBuilderAttemptId, priorReviewerAttemptId, verificationRework: facts };
	const assignmentPaths = dependencies.runJournal.resolveAssignmentPaths(repositoryRoot, journal.run.id, task.contract.id, replacementBuilderAttemptId);
	const prepared: BuilderAttemptRecord = { id: replacementBuilderAttemptId, role: "builder", state: "prepared", preparedAt: transitionTimestamp(journal, dependencies.clock.now()), actualModel: { ...builder.actualModel }, ...(journal.run.revisions ? { specificationVersion: task.specificationVersion } : {}), specificationHash: task.specificationHash, baseRevision: priorIntegration.observedHead, assignmentPath: assignmentPaths.assignmentPath, reportPath: assignmentPaths.reportPath, evidenceDirectory: assignmentPaths.evidenceDirectory, dispatch: reworkDispatch };
	let reserved: RunJournal;
	try {
		reserved = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
			const current = next.run.tasks[0];
			if (!current || current.attempts.length !== task.attempts.length || current.reworkCycles !== task.reworkCycles || current.integration?.phase !== "integrated" || current.approval?.phase !== "valid") throw new Error("Final-verification rework predecessor changed before reservation.");
			current.finalVerificationReworks = [...(current.finalVerificationReworks ?? []), { kind: "final-verification-failure", failedExecution, priorIntegration: cloneIntegratedIdentity(priorIntegration), priorBuilderAttemptId, priorReviewerAttemptId, replacementBuilderAttemptId, observedAt: transitionTimestamp(journal, dependencies.clock.now()) } satisfies FinalVerificationReworkRecord];
			current.approval = { ...current.approval, phase: "invalidated", invalidatedAt: transitionTimestamp(journal, dependencies.clock.now()), reason: "final-verification-failed", diagnostic: "Final verification returned a conclusive nonzero result; a fresh Builder revision and Review are required.", subject: { ...current.approval.subject, ...(current.approval.subject.kind === "git" ? { commits: [...current.approval.subject.commits] } : { artifacts: current.approval.subject.artifacts.map((artifact) => ({ ...artifact })) }) }, worktreeSnapshot: { ...current.approval.worktreeSnapshot, dirtyPaths: [...current.approval.worktreeSnapshot.dirtyPaths], operationMarkers: [...current.approval.worktreeSnapshot.operationMarkers] } };
			delete current.integration;
			delete next.run.finalVerificationExecution;
			current.phase = "reworking";
			current.attention = "none";
			delete current.attentionReason;
			delete current.attentionDiagnostic;
			current.reworkCycles = cycle;
			current.attempts.push({ ...prepared, dispatch: { ...reworkDispatch, verificationRework: { ...facts, priorIntegration: cloneIntegratedIdentity(priorIntegration) } } });
			clearTaskMonitor(next.run, current.contract.id);
		});
	} catch (error: unknown) { return { journal, note: `Final-verification rework reservation failed before Assignment or prompt effects. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
	const persistedReserved = await persistReviewJournal(repositoryRoot, reserved, dependencies);
	if (!persistedReserved) return { journal, note: "Final-verification rework reservation could not be persisted; no Assignment or prompt effect was attempted." };
	let currentJournal = persistedReserved;
	const currentTask = currentJournal.run.tasks[0];
	const currentAttempt = currentTask ? currentAttemptForTask(currentTask) : undefined;
	if (!currentTask || !currentAttempt || currentAttempt.role !== "builder") return { journal: currentJournal, note: "Reserved final-verification rework Attempt disappeared; no external effect was attempted." };
	let assignment: BuilderAssignmentDocument;
	try { assignment = buildBuilderAssignment({ run: currentJournal.run, task: currentTask, attempt: currentAttempt, worktreePath: dispatch.worktreePath, branch: dispatch.branch, workspaceId: dispatch.workspaceId, paneId: dispatch.paneId, terminalId: dispatch.terminalId, agentName: dispatch.agentName }); }
	catch (error: unknown) { return { journal: currentJournal, note: `Final-verification rework Assignment could not be built; the reserved Attempt is retained without a prompt. ${error instanceof Error ? error.message : "Assignment validation failed."}` }; }
	let assignmentResult: AssignmentCreateResult;
	try { assignmentResult = await dependencies.runJournal.createAssignment(repositoryRoot, assignment); }
	catch (error: unknown) { return { journal: currentJournal, note: `Final-verification rework Assignment storage failed; the reserved Attempt is retained without a prompt. ${error instanceof Error ? error.message : "Storage failed."}` }; }
	if (assignmentResult.kind !== "created" && assignmentResult.kind !== "existing-match") return { journal: currentJournal, note: "Final-verification rework Assignment conflicts with different bytes; the failed result and reserved Attempt are retained and no prompt was sent." };
	const assignmentHash = builderAssignmentSha256(assignmentResult.bytes);
	let promptIntent: RunJournal;
	try { promptIntent = advanceRunJournal(currentJournal, dependencies.clock.now(), (next) => { const attempt = next.run.tasks[0]?.attempts.at(-1); if (!attempt || attempt.role !== "builder" || !isFinalVerificationReworkDispatchForSteward(attempt.dispatch)) throw new Error("Final-verification rework Attempt disappeared before prompt intent."); attempt.dispatch = { ...attempt.dispatch, phase: "prompt-intended", assignmentSha256: assignmentHash }; }); }
	catch (error: unknown) { return { journal: currentJournal, note: `Final-verification rework prompt intent could not be persisted; no prompt was sent. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
	const persistedIntent = await persistReviewJournal(repositoryRoot, promptIntent, dependencies);
	if (!persistedIntent) return { journal: currentJournal, note: "Final-verification rework prompt intent could not be persisted; no prompt was sent." };
	currentJournal = persistedIntent;
	let prompted: HerdrPromptResult;
	try { prompted = await dependencies.herdr.promptBuilder({ repositoryRoot, name: dispatch.agentName, assignmentPrompt: formatBuilderPrompt(assignment) }); }
	catch (error: unknown) { return { journal: currentJournal, note: `Same Builder final-verification rework prompt failed; prompt-intended state is retained without a resend. ${error instanceof Error ? error.message : "Herdr prompt failed."}` }; }
	if (prompted.kind !== "prompted" || prompted.name !== dispatch.agentName || prompted.workspaceId !== dispatch.workspaceId || prompted.paneId !== dispatch.paneId || prompted.terminalId !== dispatch.terminalId || !validIdentity(prompted.tabId)) return { journal: currentJournal, note: "Same Builder final-verification rework prompt acknowledgement was malformed; prompt-intended state is retained without a resend." };
	let active: RunJournal;
	try { active = advanceRunJournal(currentJournal, dependencies.clock.now(), (next) => { const attempt = next.run.tasks[0]?.attempts.at(-1); if (!attempt || attempt.role !== "builder" || attempt.dispatch.phase !== "prompt-intended" || !isFinalVerificationReworkDispatchForSteward(attempt.dispatch)) throw new Error("Final-verification rework prompt intent disappeared after prompt."); attempt.state = "active"; attempt.activatedAt = transitionTimestamp(currentJournal, dependencies.clock.now()); attempt.dispatch = { ...attempt.dispatch, phase: "prompted", promptedAt: attempt.activatedAt }; }); }
	catch (error: unknown) { return { journal: currentJournal, note: `Same Builder final-verification rework prompt succeeded but activation could not be retained; no resend will be attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
	const persistedActive = await persistReviewJournal(repositoryRoot, active, dependencies);
	return persistedActive ? { journal: persistedActive, note: `Final-verification rework cycle ${cycle} reserved and prompted the existing Builder ${dispatch.agentName}; a fresh Review is mandatory.`, action: "dispatch-rework-builder" } : { journal: currentJournal, note: "Same Builder final-verification rework activation could not be persisted; no resend will be attempted." };
}

async function reconcileFinalVerification(input: { repositoryRoot: string; journal: RunJournal; checkoutInput: IntegrationCheckoutInput; inspectCheckout: () => Promise<import("./steward.ts").IntegrationCheckoutResult>; dependencies: StewardDependencies }): Promise<CompletionDecision | undefined> {
	const { repositoryRoot, dependencies } = input;
	if (!managedFinalVerificationAvailable(dependencies)) return undefined;
	let journal = input.journal;
	const command = journal.run.finalVerification.kind === "command" ? journal.run.finalVerification.command : undefined;
	if (!command || !dependencies.runJournal.resolveCompletionPaths || !dependencies.runJournal.inspectFinalVerificationResult || !dependencies.runJournal.finalizeVerificationResult || !dependencies.process.inspectApprovedVerification || !dependencies.process.launchApprovedVerification) return undefined;
	let execution = journal.run.finalVerificationExecution;
	if (!execution) {
		const preflight = await input.inspectCheckout();
		if (preflight.kind !== "inspected" || !integrationObservationExact(input.checkoutInput, preflight)) return persistCompletionAttention(repositoryRoot, journal, journal.run.tasks.find((task) => task.attention !== "none")?.contract.id ?? journal.run.tasks[0]?.contract.id ?? "final-verification", "integration-preflight", preflight.kind === "inspected" ? "The final integration checkout is not the exact clean target; no managed verification intent or process was created." : `The final integration checkout could not be inspected: ${preflight.message}`, dependencies);
		const paths = dependencies.runJournal.resolveCompletionPaths(repositoryRoot, journal.run.id, undefined, "verification-01");
		const initial: FinalVerificationAttempt = { id: "verification-01", kind: "initial", intendedAt: transitionTimestamp(journal, dependencies.clock.now()), paths: managedVerificationPaths(paths) };
		let candidate: RunJournal;
		try { candidate = advanceRunJournal(journal, dependencies.clock.now(), (next) => { if (next.run.finalVerificationExecution) throw new Error("Final-verification execution appeared before intent CAS."); next.run.finalVerificationExecution = { phase: "executing", command, cwd: repositoryRoot, attempts: [initial] }; }); }
		catch (error: unknown) { return { journal, note: `Managed final-verification intent could not be persisted; no process was launched. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
		const persisted = await persistReviewJournal(repositoryRoot, candidate, dependencies);
		return persisted ? { journal: persisted, note: "Managed final-verification intent is durable; launch is queued behind the Controller one-action boundary.", action: "run-final-verification" } : { journal, note: "Managed final-verification intent could not be persisted; no process was launched." };
	}
	if (!isRecoverableFinalVerificationExecution(execution)) return undefined;
	if (execution.cwd !== repositoryRoot || execution.command !== command) return persistManagedFinalVerificationAmbiguous(repositoryRoot, journal, "Managed final-verification command or cwd no longer matches the frozen Run identity.", dependencies);
	if (execution.phase === "ambiguous") return { journal, note: "Final verification is durably ambiguous; no rerun or interference was attempted." };
	if (execution.phase === "passed") return { journal, note: "Managed final verification already passed; the Completion Gate remains the only next action." };
	if (execution.phase === "failed") return dispatchFinalVerificationRework(repositoryRoot, journal, execution, dependencies);
	const consumed = await consumeManagedFinalVerificationResult({ ...input, execution });
	if (consumed) return consumed;
	const last = managedExecutionLast(execution);
	const processInput: ManagedVerificationInput & { process?: FinalVerificationProcessIdentity } = { repositoryRoot, runId: journal.run.id, attemptId: last.id, command, cwd: repositoryRoot, executionNonce: last.process?.executionNonce ?? managedVerificationNonce(journal.run.id, last.id, command, repositoryRoot), paths: last.paths, ...(last.process ? { process: last.process } : {}) };
	let liveness: "live" | "exited" | "not-launched" | "unclear";
	try { liveness = await dependencies.process.inspectApprovedVerification(processInput); }
	catch { liveness = "unclear"; }
	if (liveness === "live") return { journal, note: `Managed final verification ${last.id} is still live; the exact process remains untouched and the existing monitor wait owns observation.` };
	if (liveness === "unclear") return persistManagedFinalVerificationAmbiguous(repositoryRoot, journal, "Managed final-verification process identity or liveness could not be proved; no rerun was attempted.", dependencies);
	if (last.process && (liveness === "exited" || liveness === "not-launched")) return appendManagedRecoveryAttempt(repositoryRoot, journal, execution, "The recorded final-verification process is conclusively non-live without a complete durable result.", dependencies);
	if (last.observation?.kind === "inconclusive") {
		if (last.id === "verification-01") return appendManagedRecoveryAttempt(repositoryRoot, journal, execution, last.observation.diagnostic, dependencies);
		return persistManagedFinalVerificationAmbiguous(repositoryRoot, journal, "The recovery attempt is inconclusive without a complete result; no third launch is permitted.", dependencies);
	}
	return launchManagedFinalVerification(repositoryRoot, journal, execution, dependencies);
}

async function collectCompletionReports(repositoryRoot: string, journal: RunJournal, dependencies: StewardDependencies): Promise<import("./completion-store.ts").CompletionReportSource[] | { message: string }> {
	if (!dependencies.runJournal.loadFinalizedEvidenceManifest) return { message: "Protected finalized-manifest loading is unavailable for archive publication." };
	const reports: import("./completion-store.ts").CompletionReportSource[] = [];
	for (const task of journal.run.tasks) {
		for (const attempt of task.attempts) {
			if (!attempt.evidence || attempt.evidence.phase !== "finalized") continue;
			const loaded = await dependencies.runJournal.loadFinalizedEvidenceManifest({ manifestPath: attempt.evidence.manifestPath, manifestSha256: attempt.evidence.manifestSha256 });
			if (loaded.kind !== "loaded") return { message: `Protected ${attempt.role} manifest could not be loaded for archive: ${loaded.message}` };
			let report: { finalizedPath: string; size: number; sha256: string } | undefined;
			if (attempt.role === "builder") {
				const parsed = deserializeFinalizedBuilderEvidenceManifest(loaded.bytes.toString("utf8"), loaded.sha256);
				if (!parsed.value) return { message: parsed.message ?? "Protected Builder manifest is invalid for archive." };
				report = parsed.value.report;
			} else {
				const parsed = deserializeFinalizedReviewerEvidenceManifest(loaded.bytes.toString("utf8"), loaded.sha256);
				if (!parsed.value) return { message: parsed.message ?? "Protected Reviewer manifest is invalid for archive." };
				report = parsed.value.report;
			}
			reports.push({ taskId: task.contract.id, attemptId: attempt.id, role: attempt.role, sourcePath: report.finalizedPath, destinationPath: `reports/${task.contract.id}/${attempt.id}-${attempt.role}.md`, size: report.size, sha256: report.sha256 });
		}
	}
	return reports.length > 0 ? reports : { message: "No protected finalized Attempt Reports were available for archive publication." };
}

async function persistStopFailure(repositoryRoot: string, journal: RunJournal, taskId: string, resource: CompletionAgentIdentity, state: CompletionStopFailure["state"], diagnostic: string, dependencies: StewardDependencies): Promise<CompletionDecision> {
	const identity: CompletionAgentIdentity = { role: resource.role, agentName: resource.agentName, workspaceId: resource.workspaceId, paneId: resource.paneId, terminalId: resource.terminalId };
	const failure: CompletionStopFailure = { state, resource: identity, observedAt: transitionTimestamp(journal, dependencies.clock.now()), diagnostic: diagnostic.slice(0, 2_000) };
	let incomplete: RunJournal;
	try {
		incomplete = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
			const current = next.run.completion;
			const nextTask = next.run.tasks.find((candidate) => candidate.contract.id === taskId);
			if (!current || current.phase !== "stops-intended" || !nextTask) throw new Error("Graceful-stop intent disappeared while retaining its failure.");
			next.run.completion = { phase: "stops-incomplete", gate: current.gate, resources: current.resources.map((item) => item.state === "acknowledged" ? { ...item, acknowledgement: { ...item.acknowledgement } } : { ...item }), failure };
			nextTask.phase = "integrating";
			nextTask.attention = "needs-user";
			nextTask.attentionReason = "agent-stop-failed";
			nextTask.attentionDiagnostic = failure.diagnostic;
		});
	} catch (error: unknown) {
		return { journal, note: `Graceful-stop failure could not be retained durably; no /quit resend or archive was attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` };
	}
	const persisted = await persistReviewJournal(repositoryRoot, incomplete, dependencies);
	return persisted ? { journal: persisted, note: `Graceful stop paused at ${resource.agentName}; no archive or completion notification was attempted.` } : { journal, note: "Graceful-stop failure could not be retained durably; no /quit resend or archive was attempted." };
}

async function advanceMultiTaskIntegration(repositoryRoot: string, journalInput: RunJournal, dependencies: StewardDependencies): Promise<CompletionDecision> {
	let journal = journalInput;
	if (!runAllowsWorkflowAdvance(journalInput)) return { journal: journalInput, note: "The Run is cancelled; ordered integration is dormant and no Git effect was attempted." };
	const queue = selectIntegrationQueueHead(journal.run);
	if (queue.kind !== "ready") {
		if (queue.kind === "waiting" && (queue.reason === "integration" || queue.reason === "attention")) {
			const existingTask = journal.run.tasks[queue.index];
			if (existingTask?.integration && existingTask.integration.phase !== "integrated" && existingTask.approval?.phase === "valid" && journal.run.integrationBase.kind === "git") {
				const evidence = await loadCompletionEvidence(repositoryRoot, existingTask, journal, dependencies);
				if (!("message" in evidence) && evidence.subject.kind === "git") {
					const result = await reconcileTaskIntegration({ repositoryRoot, journal, taskIndex: queue.index, task: existingTask, evidence, integrationInput: { repositoryRoot, targetBranch: journal.run.integrationBase.branch, targetRevision: existingTask.integration.targetRevision, approvedBaseRevision: evidence.subject.baseRevision, approvedHeadRevision: evidence.subject.headRevision, approvedCommits: [...evidence.subject.commits] }, dependencies });
					if (result) return result;
				}
			}
		}
		return { journal, note: queue.kind === "waiting" ? `Task ${queue.taskId} is waiting for ordered ${queue.reason}; no later integration effect was attempted.` : "No ordered integration is ready." };
	}
	const task = journal.run.tasks[queue.index];
	if (!task) return { journal, note: "Ordered integration Task disappeared; no Git effect was attempted." };
	if (journal.run.finalVerification.kind !== "command") return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "final-verification-unexecutable", "Final verification is criteria-only; no ordered integration effect was attempted.", dependencies);
	if (!dependencies.git.inspectIntegrationCheckout || !dependencies.git.integrateApprovedRange) return { journal, note: "Integration adapters are unavailable; Approval remains queued and no Git effect was attempted." };
	const evidence = await loadCompletionEvidence(repositoryRoot, task, journal, dependencies);
	if ("message" in evidence) return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "integration-preflight", evidence.message, dependencies);
	if (evidence.subject.kind !== "git" || journal.run.integrationBase.kind !== "git") return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "integration-preflight", "Approved completion requires a Git Builder subject and Git integration base; no Git effect was attempted.", dependencies);
	const input: IntegrationCheckoutInput = { repositoryRoot, targetBranch: journal.run.integrationBase.branch, targetRevision: queue.targetRevision, approvedBaseRevision: evidence.subject.baseRevision, approvedHeadRevision: evidence.subject.headRevision, approvedCommits: [...evidence.subject.commits] };
	const preflight = await inspectCompletionCheckout(input, dependencies);
	if (integrationFactsAvailable(preflight)) {
		const recovered = await reconcileTaskIntegration({ repositoryRoot, journal, taskIndex: queue.index, task, evidence, integrationInput: input, dependencies });
		if (recovered) return recovered;
	}
	const preflightExact = preflight.kind === "inspected" && preflight.observation.rangeExact && preflight.observation.branch === input.targetBranch && preflight.observation.head === input.targetRevision && preflight.observation.dirtyPaths.length === 0 && preflight.observation.operationMarkers.length === 0 && preflight.resolvedBaseRevision === input.approvedBaseRevision && preflight.resolvedHeadRevision === input.approvedHeadRevision && JSON.stringify(preflight.commits) === JSON.stringify(input.approvedCommits);
	if (!preflightExact) return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "integration-preflight", preflight.kind === "inspected" ? `Integration checkout is not the clean exact ordered target (${preflight.observation.branch ?? "detached"}@${preflight.observation.head ?? "unknown"}); no Git effect was attempted.` : `Integration checkout could not be inspected: ${preflight.message}`, dependencies);
	const identity = completionIntegrationIdentity(journal, task, evidence, queue.targetRevision);
	if (!identity) return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "integration-preflight", "Approved integration identity could not be reconstructed from protected Git evidence.", dependencies);
	const intendedAt = transitionTimestamp(journal, dependencies.clock.now());
	let intended: RunJournal;
	try { intended = advanceRunJournal(journal, dependencies.clock.now(), (next) => { const nextTask = next.run.tasks[queue.index]; if (!nextTask) throw new Error("Ordered integration Task disappeared before intent."); nextTask.phase = "integrating"; nextTask.attention = "none"; delete nextTask.attentionDiagnostic; delete nextTask.attentionReason; nextTask.integration = { ...identity, phase: "intended", intendedAt }; }); }
	catch (error: unknown) { return { journal, note: `Integration intent could not be built durably; no Git merge was attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
	const persistedIntent = await persistReviewJournal(repositoryRoot, intended, dependencies);
	if (!persistedIntent) return { journal, note: "Integration intent could not be persisted; no Git merge was attempted." };
	journal = persistedIntent;
	let outcome: GitCommandOutcome;
	try { outcome = await dependencies.git.integrateApprovedRange({ ...input, action: identity.action }); }
	catch (error: unknown) { outcome = { kind: "thrown", message: error instanceof Error ? error.message : "Local Git integration failed." }; }
	const post = await inspectCompletionCheckout(input, dependencies);
	const exact = integrationObservationExact(input, post);
	const unchanged = integrationObservationUnchanged(input, post);
	let classified: TaskIntegration;
	if (exact && post.kind === "inspected") classified = { ...identity, phase: "integrated", intendedAt, integratedAt: transitionTimestamp(journal, dependencies.clock.now()), observedHead: post.observation.head ?? input.approvedHeadRevision };
	else if (unchanged) classified = { ...identity, phase: "failed", intendedAt, observedAt: transitionTimestamp(journal, dependencies.clock.now()), exitCode: outcome.kind === "completed" ? outcome.code : null, diagnostic: outcome.kind === "completed" ? (outcome.stderr.trim() || `Git integration exited with code ${outcome.code}.`).slice(0, 2_000) : outcome.message.slice(0, 2_000) };
	else { const observed = post.kind === "inspected" ? post.observation : emptyIntegrationObservation(); const diagnostic = post.kind === "unavailable" ? post.message : outcome.kind === "completed" ? (outcome.stderr.trim() || "Git integration left a partial or unexpected checkout state.") : outcome.message; classified = { ...identity, phase: "ambiguous", intendedAt, observedAt: transitionTimestamp(journal, dependencies.clock.now()), exitCode: outcome.kind === "completed" ? outcome.code : null, diagnostic: diagnostic.slice(0, 2_000), observed }; }
	let classifiedJournal: RunJournal;
	try { classifiedJournal = advanceRunJournal(journal, dependencies.clock.now(), (next) => { const nextTask = next.run.tasks[queue.index]; if (!nextTask) throw new Error("Ordered integration Task disappeared after Git effect."); nextTask.integration = classified; nextTask.phase = "integrating"; if (classified.phase === "integrated") { nextTask.attention = "none"; delete nextTask.attentionDiagnostic; delete nextTask.attentionReason; } else { nextTask.attention = "needs-user"; nextTask.attentionReason = classified.phase === "failed" ? "integration-failed" : "integration-ambiguous"; nextTask.attentionDiagnostic = classified.diagnostic; } }); }
	catch (error: unknown) { return { journal, note: `Git integration returned but post-state could not be retained durably; no merge retry was attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
	const persistedClassified = await persistReviewJournal(repositoryRoot, classifiedJournal, dependencies);
	if (!persistedClassified) return { journal, note: "Git integration returned but post-state could not be retained durably; no merge retry was attempted." };
	return { journal: persistedClassified, note: classified.phase === "integrated" ? `Approved range ${input.approvedHeadRevision} for ${task.contract.id} was integrated in ordered queue position ${queue.index + 1}.` : classified.diagnostic, action: "integrate-approved-range" };
}

async function advanceMultiTaskFinalization(repositoryRoot: string, journalInput: RunJournal, dependencies: StewardDependencies, oneAction: boolean): Promise<CompletionDecision> {
	let journal = journalInput;
	if (!runAllowsWorkflowAdvance(journalInput)) return { journal: journalInput, note: "The Run is cancelled; final verification is dormant and no process was launched." };
	if (!allRequiredTasksIntegrated(journal.run) || journal.run.tasks.some((task) => task.attention !== "none" || ["building", "reviewing", "reworking"].includes(task.phase))) return { journal, note: "Final verification is gated until every Task is complete, attention-free, and every ordered code integration is durable." };
	if (journal.run.finalVerification.kind !== "command") return { journal, note: "Final verification is criteria-only; no process was launched." };
	const codeTasks = journal.run.tasks.filter((task) => task.contract.expectedArtifacts.some((artifact) => artifact.kind === "git-commit"));
	const lastIntegration = codeTasks.at(-1)?.integration;
	if (journal.run.integrationBase.kind !== "git" || !lastIntegration || lastIntegration.phase !== "integrated") return { journal, note: "The complete ordered integration head is unavailable; final verification was not attempted." };
	const finalInput: IntegrationCheckoutInput = { repositoryRoot, targetBranch: journal.run.integrationBase.branch, targetRevision: lastIntegration.observedHead, approvedBaseRevision: lastIntegration.approvedBaseRevision, approvedHeadRevision: lastIntegration.approvedHeadRevision, approvedCommits: [...lastIntegration.approvedCommits] };
	const inspectFinal = async (): Promise<import("./steward.ts").IntegrationCheckoutResult> => inspectCompletionCheckout(finalInput, dependencies);
	const exactFinal = (result: import("./steward.ts").IntegrationCheckoutResult): result is Extract<import("./steward.ts").IntegrationCheckoutResult, { kind: "inspected" }> => result.kind === "inspected" && result.observation.branch === finalInput.targetBranch && result.observation.head === finalInput.targetRevision && result.observation.dirtyPaths.length === 0 && result.observation.operationMarkers.length === 0 && result.observation.rangeExact;
	let currentExecution = journal.run.finalVerificationExecution;
	const managedDecision = await reconcileFinalVerification({ repositoryRoot, journal, checkoutInput: finalInput, inspectCheckout: inspectFinal, dependencies });
	if (managedDecision) {
		const managedExecution = managedDecision.journal.run.finalVerificationExecution;
		if (!managedExecution || !isRecoverableFinalVerificationExecution(managedExecution) || managedExecution.phase !== "passed" || !managedExecutionComplete(managedExecution)) return managedDecision;
		journal = managedDecision.journal;
		currentExecution = managedExecution;
	}
	if (!currentExecution) {
		const fresh = await inspectFinal();
		if (!exactFinal(fresh) || !dependencies.process.runApprovedVerification || !dependencies.runJournal.resolveCompletionPaths || !dependencies.runJournal.finalizeVerificationResult) return { journal, note: exactFinal(fresh) ? "Final-verification process/storage adapters are unavailable; no process was launched." : "The fresh final integration checkout is not exact, clean, and marker-free; no verification effect was attempted." };
		const paths = dependencies.runJournal.resolveCompletionPaths(repositoryRoot, journal.run.id);
		const command = journal.run.finalVerification.kind === "command" ? journal.run.finalVerification.command : "";
		const intendedAt = transitionTimestamp(journal, dependencies.clock.now());
		let intended: RunJournal;
		try { intended = advanceRunJournal(journal, dependencies.clock.now(), (next) => { next.run.finalVerificationExecution = { phase: "intended", id: "verification-01", command, cwd: repositoryRoot, logPath: paths.verificationLogPath, resultPath: paths.verificationResultPath, intendedAt }; }); }
		catch (error: unknown) { return { journal, note: `Final-verification intent could not be persisted; no process was launched. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
		const persistedIntent = await persistReviewJournal(repositoryRoot, intended, dependencies);
		if (!persistedIntent) return { journal, note: "Final-verification intent could not be persisted; no process was launched." };
		journal = persistedIntent;
		const startedAt = transitionTimestamp(journal, dependencies.clock.now());
		let processResult: VerificationProcessOutcome;
		try { processResult = await dependencies.process.runApprovedVerification({ cwd: repositoryRoot, command }); }
		catch (error: unknown) { processResult = { kind: "thrown", message: error instanceof Error ? error.message : "Final-verification process failed." }; }
		const post = await inspectFinal();
		let finalizedResult: VerificationFinalizeResult | undefined;
		if (processResult.kind === "completed" && processResult.killed === false) {
			try { finalizedResult = await dependencies.runJournal.finalizeVerificationResult({ repositoryRoot, runId: journal.run.id, command, cwd: repositoryRoot, startedAt, completedAt: transitionTimestamp(journal, dependencies.clock.now()), exitCode: processResult.code, killed: false, stdout: processResult.stdout, stderr: processResult.stderr }); }
			catch (error: unknown) { finalizedResult = { kind: "storage-error", paths, message: error instanceof Error ? error.message : "Final-verification result storage failed." }; }
		}
		const completedResult = finalizedResult && (finalizedResult.kind === "created" || finalizedResult.kind === "existing-match") ? finalizedResult : undefined;
		const stored = Boolean(completedResult);
		const passed = processResult.kind === "completed" && processResult.killed === false && processResult.code === 0 && stored && exactFinal(post);
		const failed = processResult.kind === "completed" && processResult.killed === false && processResult.code !== 0 && stored && post.kind === "inspected";
		const execution: FinalVerificationExecution = passed || failed ? { phase: passed ? "passed" : "failed", id: "verification-01", command, cwd: repositoryRoot, logPath: paths.verificationLogPath, resultPath: paths.verificationResultPath, intendedAt, startedAt, completedAt: transitionTimestamp(journal, dependencies.clock.now()), exitCode: processResult.kind === "completed" ? processResult.code : 1, killed: false, logSha256: completedResult!.logSha256, resultSha256: completedResult!.resultSha256, checkout: (post as Extract<typeof post, { kind: "inspected" }>).observation } : { phase: "ambiguous", id: "verification-01", command, cwd: repositoryRoot, logPath: paths.verificationLogPath, resultPath: paths.verificationResultPath, intendedAt, observedAt: transitionTimestamp(journal, dependencies.clock.now()), exitCode: processResult.kind === "completed" ? processResult.code : null, killed: processResult.kind === "completed" ? processResult.killed : null, diagnostic: processResult.kind === "thrown" ? processResult.message : "Final verification did not produce a conclusive result.", ...(completedResult ? { logSha256: completedResult.logSha256, resultSha256: completedResult.resultSha256 } : {}), ...(post.kind === "inspected" ? { checkout: post.observation } : {}) };
		let recorded: RunJournal;
		try { recorded = advanceRunJournal(journal, dependencies.clock.now(), (next) => { next.run.finalVerificationExecution = execution; }); }
		catch (error: unknown) { return { journal, note: `Final-verification result could not be retained durably; no process rerun was attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
		const persisted = await persistReviewJournal(repositoryRoot, recorded, dependencies);
		if (!persisted) return { journal, note: "Final-verification result could not be retained durably; no process rerun was attempted." };
		journal = persisted;
		if (!passed) return { journal, note: "Final verification did not pass conclusively; completion remains gated.", action: "run-final-verification" };
		if (oneAction) return { journal, note: "Final verification completed and was durably classified; the Completion Gate is queued for a later pass.", action: "run-final-verification" };
	}
	const execution = journal.run.finalVerificationExecution;
	if (!execution || execution.phase !== "passed") return { journal, note: "Final verification has not produced a conclusive passing result; no rerun was attempted." };
	const fresh = await inspectFinal();
	if (!exactFinal(fresh)) return { journal, note: "The persisted verification result no longer has a fresh exact clean target checkout; the Completion Gate was not evaluated." };
	const gate = completionGateFacts(journal, fresh.observation, dependencies);
	if (!gate) {
		const result = evaluateCompletionGate(journal, fresh.observation);
		return { journal, note: `Completion Gate failed: ${result.passed ? "unknown" : result.failures.join(" ")}` };
	}
	let gateJournal: RunJournal;
	try { gateJournal = advanceRunJournal(journal, dependencies.clock.now(), (next) => { next.run.status = "completing"; for (const task of next.run.tasks) { task.phase = "completed"; task.attention = "none"; delete task.attentionReason; delete task.attentionDiagnostic; } next.run.completion = { phase: "gate-passed", gate }; }); }
	catch (error: unknown) { return { journal, note: `Completion Gate passed in memory but could not be retained durably; no agent stop or archive effect was attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
	const persistedGate = await persistReviewJournal(repositoryRoot, gateJournal, dependencies);
	if (!persistedGate) return { journal, note: "Completion Gate passed in memory but could not be retained durably; no agent stop or archive effect was attempted." };
	return oneAction ? { journal: persistedGate, note: "Multi-Task Completion Gate passed and was durably recorded; graceful stopping is queued for a later pass.", action: "pass-completion-gate" } : advanceCompletionLifecycle(repositoryRoot, persistedGate, dependencies);
}

async function advanceMultiTaskCompletion(repositoryRoot: string, journal: RunJournal, dependencies: StewardDependencies, oneAction: boolean): Promise<CompletionDecision> {
	const queue = selectIntegrationQueueHead(journal.run);
	if (queue.kind === "ready") return advanceMultiTaskIntegration(repositoryRoot, journal, dependencies);
	if (queue.kind === "waiting" && (queue.reason === "integration" || queue.reason === "attention")) return advanceMultiTaskIntegration(repositoryRoot, journal, dependencies);
	if (queue.kind === "waiting") return { journal, note: queue.reason === "attention" ? journal.run.tasks[queue.index]?.attentionDiagnostic ?? `Task ${queue.taskId} requires attention before integration.` : `Task ${queue.taskId} is waiting for ordered ${queue.reason}; no final verification was attempted.` };
	return advanceMultiTaskFinalization(repositoryRoot, journal, dependencies, oneAction);
}

async function advanceApprovedCompletion(repositoryRoot: string, journalInput: RunJournal, dependencies: StewardDependencies, oneAction = false): Promise<CompletionDecision> {
	if (!runAllowsWorkflowAdvance(journalInput)) return { journal: journalInput, note: "The Run is cancelled; completion advancement is dormant and no effect was attempted." };
	let journal = journalInput;
	if (journal.run.status === "completing") return advanceCompletionLifecycle(repositoryRoot, journal, dependencies, oneAction);
	if (journal.run.status !== "active") return { journal, note: "" };
	if (journal.run.tasks.length > 1) return advanceMultiTaskCompletion(repositoryRoot, journal, dependencies, oneAction);
	const approvedTasks = journal.run.tasks.filter((candidate) => candidate.phase === "approved" && candidate.attention === "none" && candidate.approval?.phase === "valid");
	const integratingTask = journal.run.tasks.find((candidate) => candidate.integration?.phase === "integrated");
	const pendingIntegrationTask = journal.run.tasks.find((candidate) => candidate.integration && candidate.integration.phase !== "integrated");
	if (pendingIntegrationTask && pendingIntegrationTask.approval?.phase === "valid" && journal.run.integrationBase.kind === "git") {
		const evidence = await loadCompletionEvidence(repositoryRoot, pendingIntegrationTask, journal, dependencies);
		if (!("message" in evidence) && evidence.subject.kind === "git") {
			const recovered = await reconcileTaskIntegration({ repositoryRoot, journal, taskIndex: 0, task: pendingIntegrationTask, evidence, integrationInput: { repositoryRoot, targetBranch: journal.run.integrationBase.branch, targetRevision: pendingIntegrationTask.integration!.targetRevision, approvedBaseRevision: evidence.subject.baseRevision, approvedHeadRevision: evidence.subject.headRevision, approvedCommits: [...evidence.subject.commits] }, dependencies });
			if (recovered) return recovered;
		}
	}
	if (approvedTasks.length === 0 && !integratingTask) return { journal, note: "" };
	if (approvedTasks.length > 1 || journal.run.tasks.length !== 1) {
		const target = approvedTasks[0] ?? journal.run.tasks[0];
		return target ? persistCompletionAttention(repositoryRoot, journal, target.contract.id, "integration-preflight", "Ticket-08 completion requires exactly one ordered code-changing Task; no integration effect was attempted.", dependencies) : { journal, note: "Ticket-08 completion requires exactly one ordered Task; no effect was attempted." };
	}
	let task = journal.run.tasks[0]!;
	if (!task.contract.expectedArtifacts.some((artifact) => artifact.kind === "git-commit") || !task.contract.reviewRequired) return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "integration-preflight", "Ticket-08 completion requires one reviewed code-changing Task; no integration effect was attempted.", dependencies);
	if (journal.run.finalVerification.kind !== "command") return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "final-verification-unexecutable", "Final verification is criteria-only; ticket-08 requires one frozen executable command and did not attempt integration or launch a process.", dependencies);
	if (task.phase === "approved" && task.attention === "none" && !task.integration) {
		if (!dependencies.git.inspectIntegrationCheckout || !dependencies.git.integrateApprovedRange) return { journal, note: "Integration adapters are unavailable; Approval remains unchanged and no Git effect was attempted." };
		const evidence = await loadCompletionEvidence(repositoryRoot, task, journal, dependencies);
		if ("message" in evidence) return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "integration-preflight", evidence.message, dependencies);
		if (evidence.subject.kind !== "git" || journal.run.integrationBase.kind !== "git") return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "integration-preflight", "Approved completion requires a Git Builder subject and Git integration base; no Git effect was attempted.", dependencies);
		const targetRevision = task.integrationRecoveries?.at(-1)?.observed.head ?? task.finalVerificationReworks?.at(-1)?.priorIntegration.observedHead ?? journal.run.integrationBase.revision;
		const input: IntegrationCheckoutInput = { repositoryRoot, targetBranch: journal.run.integrationBase.branch, targetRevision, approvedBaseRevision: evidence.subject.baseRevision, approvedHeadRevision: evidence.subject.headRevision, approvedCommits: [...evidence.subject.commits] };
		const preflight = await inspectCompletionCheckout(input, dependencies);
		if (integrationFactsAvailable(preflight)) {
			const recovered = await reconcileTaskIntegration({ repositoryRoot, journal, taskIndex: 0, task, evidence, integrationInput: input, dependencies });
			if (recovered) return recovered;
		}
		if (input.targetRevision !== input.approvedBaseRevision || preflight.kind !== "inspected" || !preflight.observation.rangeExact || preflight.observation.branch !== input.targetBranch || preflight.observation.head !== input.targetRevision || preflight.observation.dirtyPaths.length > 0 || preflight.observation.operationMarkers.length > 0 || preflight.resolvedBaseRevision !== input.approvedBaseRevision || preflight.resolvedHeadRevision !== input.approvedHeadRevision || JSON.stringify(preflight.commits) !== JSON.stringify(input.approvedCommits)) {
			const detail = preflight.kind === "inspected" ? `Integration checkout ${repositoryRoot} is not the clean exact target (${preflight.observation.branch ?? "detached"}@${preflight.observation.head ?? "unknown"}); the recorded Builder worktree remains untouched.` : `Integration checkout ${repositoryRoot} could not be inspected: ${preflight.message}`;
			return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "integration-preflight", detail, dependencies);
		}
		const identity = completionIntegrationIdentity(journal, task, evidence);
		if (!identity) return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "integration-preflight", "Approved integration identity could not be reconstructed from protected Git evidence.", dependencies);
		const intendedAt = transitionTimestamp(journal, dependencies.clock.now());
		let intended: RunJournal;
		try { intended = advanceRunJournal(journal, dependencies.clock.now(), (next) => { const nextTask = next.run.tasks[0]!; nextTask.phase = "integrating"; nextTask.attention = "none"; delete nextTask.attentionDiagnostic; delete nextTask.attentionReason; nextTask.integration = { ...identity, phase: "intended", intendedAt }; }); }
		catch (error: unknown) { return { journal, note: `Integration intent could not be built durably; no Git merge was attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
		const persistedIntent = await persistReviewJournal(repositoryRoot, intended, dependencies);
		if (!persistedIntent) return { journal, note: "Integration intent could not be persisted; no Git merge was attempted." };
		journal = persistedIntent;
		let outcome: GitCommandOutcome;
		try { outcome = await dependencies.git.integrateApprovedRange({ ...input, action: { kind: "fast-forward", argv: ["merge", "--ff-only", "--no-edit", input.approvedHeadRevision] } }); }
		catch (error: unknown) { outcome = { kind: "thrown", message: error instanceof Error ? error.message : "Git fast-forward integration failed." }; }
		const post = await inspectCompletionCheckout(input, dependencies);
		const exact = integrationObservationExact(input, post);
		const unchanged = integrationObservationUnchanged(input, post);
		let classified: TaskIntegration;
		if (exact) classified = { ...identity, phase: "integrated", intendedAt, integratedAt: transitionTimestamp(journal, dependencies.clock.now()), observedHead: input.approvedHeadRevision };
		else if (unchanged) classified = { ...identity, phase: "failed", intendedAt, observedAt: transitionTimestamp(journal, dependencies.clock.now()), exitCode: outcome.kind === "completed" ? outcome.code : null, diagnostic: outcome.kind === "completed" ? (outcome.stderr.trim() || `Git fast-forward integration exited with code ${outcome.code}.`).slice(0, 2_000) : outcome.message.slice(0, 2_000) };
		else { const observed = post.kind === "inspected" ? post.observation : emptyIntegrationObservation(); const diagnostic = post.kind === "unavailable" ? post.message : outcome.kind === "completed" ? (outcome.stderr.trim() || "Git integration left a partial or unexpected checkout state.") : outcome.message; classified = { ...identity, phase: "ambiguous", intendedAt, observedAt: transitionTimestamp(journal, dependencies.clock.now()), exitCode: outcome.kind === "completed" ? outcome.code : null, diagnostic: diagnostic.slice(0, 2_000), observed }; }
		let classifiedJournal: RunJournal;
		try { classifiedJournal = advanceRunJournal(journal, dependencies.clock.now(), (next) => { const nextTask = next.run.tasks[0]!; nextTask.integration = classified; if (classified.phase === "integrated") { nextTask.phase = "integrating"; nextTask.attention = "none"; delete nextTask.attentionDiagnostic; delete nextTask.attentionReason; } else { nextTask.phase = "integrating"; nextTask.attention = "needs-user"; nextTask.attentionReason = classified.phase === "failed" ? "integration-failed" : "integration-ambiguous"; nextTask.attentionDiagnostic = classified.diagnostic; } }); }
		catch (error: unknown) { return { journal, note: `Git integration returned but its post-state could not be retained durably; no merge retry was attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
		const persistedClassified = await persistReviewJournal(repositoryRoot, classifiedJournal, dependencies);
		if (!persistedClassified) return { journal, note: "Git integration returned but its post-state could not be retained durably; no merge retry was attempted." };
		journal = persistedClassified;
		if (classified.phase !== "integrated") return { journal, note: classified.diagnostic, action: "integrate-approved-range" };
		if (oneAction) return { journal, note: `Approved range ${input.approvedHeadRevision} was integrated and classified.`, action: "integrate-approved-range" };
	}
	task = journal.run.tasks[0]!;
	if (!task.integration || task.integration.phase === "intended") return { journal, note: task.integration ? "Integration intent is durably retained; ticket-08 will not retry or infer its post-state." : "" };
	if (task.integration.phase !== "integrated") return { journal, note: task.attentionDiagnostic ?? "Integration is paused for user attention; no retry or recovery was attempted." };
	if (task.attention !== "none") return { journal, note: task.attentionDiagnostic ?? "Integrated Task remains paused for user attention." };
	const managedInput = completionIntegrationInput(repositoryRoot, task.integration);
	const managedDecision = await reconcileFinalVerification({ repositoryRoot, journal, checkoutInput: managedInput, inspectCheckout: () => inspectCompletionCheckout(managedInput, dependencies), dependencies });
	if (managedDecision) {
		const managedExecution = managedDecision.journal.run.finalVerificationExecution;
		if (!managedExecution || !isRecoverableFinalVerificationExecution(managedExecution) || managedExecution.phase !== "passed" || !managedExecutionComplete(managedExecution)) return managedDecision;
		journal = managedDecision.journal;
	}
	if (!journal.run.finalVerificationExecution) {
		const evidence = await loadCompletionEvidence(repositoryRoot, task, journal, dependencies);
		if ("message" in evidence) return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "integration-preflight", `Completion evidence revalidation failed before verification intent: ${evidence.message}`, dependencies);
		const expectedIdentity = completionIntegrationIdentity(journal, task, evidence);
		if (!expectedIdentity || !integrationIdentityMatches(task.integration, expectedIdentity)) return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "integration-preflight", "Integrated identity no longer matches the current protected Approval and finalized evidence; no verification effect was attempted.", dependencies);
		const freshInput = completionIntegrationInput(repositoryRoot, task.integration);
		const freshCheckout = await inspectCompletionCheckout(freshInput, dependencies);
		if (!integrationObservationExact(freshInput, freshCheckout)) return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "integration-preflight", "The persisted integrated Task no longer has a fresh exact clean target checkout; no verification effect was attempted.", dependencies);
		if (!dependencies.process.runApprovedVerification || !dependencies.runJournal.resolveCompletionPaths || !dependencies.runJournal.finalizeVerificationResult) return { journal, note: "Final-verification process/storage adapters are unavailable; no process was launched." };
		const paths = dependencies.runJournal.resolveCompletionPaths(repositoryRoot, journal.run.id);
		const intendedAt = transitionTimestamp(journal, dependencies.clock.now());
		let intended: RunJournal;
		try { intended = advanceRunJournal(journal, dependencies.clock.now(), (next) => { next.run.finalVerificationExecution = { phase: "intended", id: "verification-01", command: journal.run.finalVerification.kind === "command" ? journal.run.finalVerification.command : "", cwd: repositoryRoot, logPath: paths.verificationLogPath, resultPath: paths.verificationResultPath, intendedAt }; }); }
		catch (error: unknown) { return { journal, note: `Final-verification intent could not be persisted; no process was launched. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
		const persistedIntent = await persistReviewJournal(repositoryRoot, intended, dependencies);
		if (!persistedIntent) return { journal, note: "Final-verification intent could not be persisted; no process was launched." };
		journal = persistedIntent;
		const command = journal.run.finalVerification.kind === "command" ? journal.run.finalVerification.command : "";
		const startedAt = transitionTimestamp(journal, dependencies.clock.now());
		let processResult: VerificationProcessOutcome;
		try { processResult = await dependencies.process.runApprovedVerification({ cwd: repositoryRoot, command }); }
		catch (error: unknown) { processResult = { kind: "thrown", message: error instanceof Error ? error.message : "Final-verification process failed." }; }
		const post = await inspectCompletionCheckout({ repositoryRoot, targetBranch: journal.run.integrationBase.kind === "git" ? journal.run.integrationBase.branch : "", targetRevision: journal.run.integrationBase.kind === "git" ? journal.run.integrationBase.revision : "", approvedBaseRevision: task.integration.approvedBaseRevision, approvedHeadRevision: task.integration.approvedHeadRevision, approvedCommits: [...task.integration.approvedCommits] }, dependencies);
		let logSha256: string | undefined;
		let resultSha256: string | undefined;
		let finalizedResult: VerificationFinalizeResult | undefined;
		if (processResult.kind === "completed" && processResult.killed === false) {
			try { finalizedResult = await dependencies.runJournal.finalizeVerificationResult({ repositoryRoot, runId: journal.run.id, command, cwd: repositoryRoot, startedAt, completedAt: transitionTimestamp(journal, dependencies.clock.now()), exitCode: processResult.code, killed: false, stdout: processResult.stdout, stderr: processResult.stderr }); }
			catch (error: unknown) { finalizedResult = { kind: "storage-error", paths, message: error instanceof Error ? error.message : "Final-verification result storage failed." }; }
			if (finalizedResult.kind === "created" || finalizedResult.kind === "existing-match") { logSha256 = finalizedResult.logSha256; resultSha256 = finalizedResult.resultSha256; }
		}
		const exact = post.kind === "inspected" && integrationObservationExact({ repositoryRoot, targetBranch: journal.run.integrationBase.kind === "git" ? journal.run.integrationBase.branch : "", targetRevision: journal.run.integrationBase.kind === "git" ? journal.run.integrationBase.revision : "", approvedBaseRevision: task.integration.approvedBaseRevision, approvedHeadRevision: task.integration.approvedHeadRevision, approvedCommits: [...task.integration.approvedCommits] }, post);
		const outputStorageOk = Boolean(logSha256 && resultSha256 && finalizedResult && (finalizedResult.kind === "created" || finalizedResult.kind === "existing-match"));
		let execution: FinalVerificationExecution;
		let reason: TaskAttentionReason | undefined;
		if (processResult.kind === "completed" && processResult.killed === false && outputStorageOk && processResult.code !== 0 && post.kind === "inspected") {
			execution = { phase: "failed", id: "verification-01", command, cwd: repositoryRoot, logPath: paths.verificationLogPath, resultPath: paths.verificationResultPath, intendedAt, startedAt, completedAt: transitionTimestamp(journal, dependencies.clock.now()), exitCode: processResult.code, killed: false, logSha256: logSha256!, resultSha256: resultSha256!, checkout: post.observation }; reason = "final-verification-failed";
		} else if (processResult.kind === "completed" && processResult.killed === false && processResult.code === 0 && outputStorageOk && exact && post.kind === "inspected") {
			execution = { phase: "passed", id: "verification-01", command, cwd: repositoryRoot, logPath: paths.verificationLogPath, resultPath: paths.verificationResultPath, intendedAt, startedAt, completedAt: transitionTimestamp(journal, dependencies.clock.now()), exitCode: 0, killed: false, logSha256: logSha256!, resultSha256: resultSha256!, checkout: post.observation };
		} else if (processResult.kind === "completed" && processResult.killed === false && outputStorageOk && post.kind === "inspected") {
			execution = { phase: "ambiguous", id: "verification-01", command, cwd: repositoryRoot, logPath: paths.verificationLogPath, resultPath: paths.verificationResultPath, intendedAt, observedAt: transitionTimestamp(journal, dependencies.clock.now()), exitCode: processResult.code, killed: false, diagnostic: exact ? "Verification output was durably stored but the result could not be classified as a conclusive pass or failure." : "Final verification changed or dirtied the integration checkout; preserved state requires user attention.", logSha256, resultSha256, checkout: post.observation }; reason = exact ? "final-verification-ambiguous" : "verification-dirtied-checkout";
		} else {
			const storageDiagnostic = finalizedResult && "message" in finalizedResult ? finalizedResult.message : undefined;
			execution = { phase: "ambiguous", id: "verification-01", command, cwd: repositoryRoot, logPath: paths.verificationLogPath, resultPath: paths.verificationResultPath, intendedAt, observedAt: transitionTimestamp(journal, dependencies.clock.now()), exitCode: processResult.kind === "completed" ? processResult.code : null, killed: processResult.kind === "completed" ? processResult.killed : null, diagnostic: processResult.kind === "thrown" ? processResult.message.slice(0, 2_000) : storageDiagnostic ? storageDiagnostic.slice(0, 2_000) : post.kind === "unavailable" ? post.message.slice(0, 2_000) : "Final verification acknowledgement was killed or incomplete.", ...(logSha256 ? { logSha256 } : {}), ...(resultSha256 ? { resultSha256 } : {}), ...(post.kind === "inspected" ? { checkout: post.observation } : {}) }; reason = post.kind === "inspected" && !exact ? "verification-dirtied-checkout" : "final-verification-ambiguous";
		}
		let completed: RunJournal;
		try { completed = advanceRunJournal(journal, dependencies.clock.now(), (next) => { next.run.finalVerificationExecution = execution; const nextTask = next.run.tasks[0]!; nextTask.phase = "integrating"; nextTask.attention = reason ? "needs-user" : "none"; if (reason) { nextTask.attentionReason = reason; nextTask.attentionDiagnostic = execution.phase === "ambiguous" ? execution.diagnostic : execution.phase === "failed" ? "Final verification returned a nonzero exit code." : "Final verification requires user attention."; } else { delete nextTask.attentionReason; delete nextTask.attentionDiagnostic; } }); }
		catch (error: unknown) { return { journal, note: `Final-verification result could not be retained durably; no process rerun was attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
		const persisted = await persistReviewJournal(repositoryRoot, completed, dependencies);
		if (!persisted) return { journal, note: "Final-verification result could not be retained durably; no process rerun was attempted." };
		journal = persisted;
		if (reason) return { journal, note: journal.run.tasks[0]?.attentionDiagnostic ?? "Final verification is paused for user attention." };
		if (oneAction) return { journal, note: "Final verification completed and was durably classified.", action: "run-final-verification" };
	}
	task = journal.run.tasks[0]!;
	if (task.attention !== "none") return { journal, note: task.attentionDiagnostic ?? "Final verification is paused for user attention; no rerun was attempted." };
	const execution = journal.run.finalVerificationExecution;
	if (!execution || execution.phase !== "passed") return { journal, note: "Final verification has not produced a conclusive passing result; no rerun was attempted." };
	const evidence = await loadCompletionEvidence(repositoryRoot, task, journal, dependencies);
	if ("message" in evidence) return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "integration-preflight", `Completion evidence revalidation failed before the Completion Gate: ${evidence.message}`, dependencies);
	const expectedIdentity = completionIntegrationIdentity(journal, task, evidence);
	const integration = task.integration;
	if (!integration || integration.phase !== "integrated" || !expectedIdentity || !integrationIdentityMatches(integration, expectedIdentity)) return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "integration-preflight", "Integrated identity no longer matches the current protected Approval and finalized evidence; the Completion Gate was not evaluated.", dependencies);
	const freshInput = completionIntegrationInput(repositoryRoot, integration);
	const freshObservation = await inspectCompletionCheckout(freshInput, dependencies);
	if (freshObservation.kind !== "inspected" || !integrationObservationExact(freshInput, freshObservation)) return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "integration-preflight", "The persisted verification result no longer has a fresh exact clean target checkout; the Completion Gate was not evaluated.", dependencies);
	const checkout = freshObservation.observation;
	const gate = completionGateFacts(journal, checkout, dependencies);
	if (!gate) {
		const result = evaluateCompletionGate(journal, checkout);
		return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "integration-preflight", `Completion Gate failed: ${result.passed ? "unknown" : result.failures.join(" ")}`, dependencies);
	}
	let gateJournal: RunJournal;
	try { gateJournal = advanceRunJournal(journal, dependencies.clock.now(), (next) => { next.run.status = "completing"; next.run.tasks[0]!.phase = "completed"; next.run.tasks[0]!.attention = "none"; delete next.run.tasks[0]!.attentionReason; delete next.run.tasks[0]!.attentionDiagnostic; next.run.completion = { phase: "gate-passed", gate }; }); }
	catch (error: unknown) { return { journal, note: `Completion Gate passed in memory but could not be retained durably; no agent stop or archive effect was attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
	const persistedGate = await persistReviewJournal(repositoryRoot, gateJournal, dependencies);
	if (!persistedGate) return { journal, note: "Completion Gate passed in memory but could not be retained durably; no agent stop or archive effect was attempted." };
	if (oneAction) return { journal: persistedGate, note: "Completion Gate passed and was durably recorded; graceful stopping is queued for a later pass.", action: "pass-completion-gate" };
	return advanceCompletionLifecycle(repositoryRoot, persistedGate, dependencies);
}

async function advanceCompletionLifecycle(repositoryRoot: string, journalInput: RunJournal, dependencies: StewardDependencies, oneAction = false): Promise<CompletionDecision> {
	let journal = journalInput;
	const task = journal.run.tasks[0];
	if (!task || journal.run.status !== "completing" || !journal.run.completion) return { journal, note: "" };
	const attentionTask = journal.run.tasks.find((candidate) => candidate.attention !== "none");
	if (attentionTask) return { journal, note: attentionTask.attentionDiagnostic ?? `Completion is paused (${attentionTask.attentionReason ?? "needs-user"}).` };
	let completion = journal.run.completion;
	if (completion.phase === "gate-passed") {
		const resources = completionResources(journal).map((resource) => ({ ...resource, state: "intended" as const, intendedAt: transitionTimestamp(journal, dependencies.clock.now()) }));
		if (resources.length === 0) return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "agent-stop-failed", "No distinct prompted Steward-created Builder or Reviewer resource was available for graceful stop.", dependencies);
		let intended: RunJournal;
		try { intended = advanceRunJournal(journal, dependencies.clock.now(), (next) => { next.run.completion = { phase: "stops-intended", gate: next.run.completion!.gate, resources }; }); }
		catch (error: unknown) { return { journal, note: `Graceful-stop intent could not be persisted; no /quit was sent. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
		const persisted = await persistReviewJournal(repositoryRoot, intended, dependencies);
		if (!persisted) return { journal, note: "Graceful-stop intent could not be persisted; no /quit was sent." };
		journal = persisted;
		completion = journal.run.completion!;
		if (oneAction) return { journal, note: "Graceful-stop intent was persisted; one recorded resource will be stopped on a later pass.", action: "stop-next-agent" };
	}
	if (completion.phase === "stops-intended") {
		const stopCompletion = completion;
		if (!dependencies.herdr.stopAgentGracefully) return persistStopFailure(repositoryRoot, journal, task.contract.id, stopCompletion.resources.find((resource) => resource.state === "intended") ?? stopCompletion.resources[0]!, "failed", "Graceful Herdr /quit is unavailable; no lifecycle inference, pane closure, or worktree cleanup was attempted.", dependencies);
		for (let index = 0; index < stopCompletion.resources.length; index += 1) {
			const resource = stopCompletion.resources[index]!;
			if (resource.state === "acknowledged") continue;
			let stopped: HerdrStopResult;
			try { stopped = await dependencies.herdr.stopAgentGracefully({ repositoryRoot, name: resource.agentName, workspaceId: resource.workspaceId, paneId: resource.paneId, terminalId: resource.terminalId }); }
			catch (error: unknown) { stopped = { kind: "ambiguous", message: error instanceof Error ? error.message : "Graceful /quit failed." }; }
			if (stopped.kind !== "acknowledged" || stopped.name !== resource.agentName || stopped.workspaceId !== resource.workspaceId || stopped.paneId !== resource.paneId || stopped.terminalId !== resource.terminalId || !validIdentity(stopped.tabId)) {
				return persistStopFailure(repositoryRoot, journal, task.contract.id, resource, stopped.kind === "ambiguous" ? "ambiguous" : "failed", stopped.kind === "acknowledged" ? "Herdr /quit acknowledgement identity did not match the recorded resource." : stopped.message, dependencies);
			}
			let acknowledged: RunJournal;
			try { acknowledged = advanceRunJournal(journal, dependencies.clock.now(), (next) => { const current = next.run.completion; if (!current || current.phase !== "stops-intended") throw new Error("Graceful-stop intent disappeared after acknowledgement."); current.resources[index] = { ...resource, state: "acknowledged", acknowledgedAt: transitionTimestamp(journal, dependencies.clock.now()), acknowledgement: { name: stopped.name, workspaceId: stopped.workspaceId, tabId: stopped.tabId, paneId: stopped.paneId, terminalId: stopped.terminalId } }; }); }
			catch (error: unknown) { return persistStopFailure(repositoryRoot, journal, task.contract.id, resource, "ambiguous", `Graceful-stop acknowledgement could not be retained; no resend will be attempted. ${error instanceof Error ? error.message : "Journal validation failed."}`, dependencies); }
			const persisted = await persistReviewJournal(repositoryRoot, acknowledged, dependencies);
			if (!persisted) return persistStopFailure(repositoryRoot, journal, task.contract.id, resource, "ambiguous", "Graceful-stop acknowledgement could not be persisted; no resend will be attempted.", dependencies);
			journal = persisted;
			completion = journal.run.completion!;
			if (oneAction) return { journal, note: `Gracefully stopped ${resource.agentName}; the next recorded resource remains queued.`, action: "stop-next-agent" };
		}
		completion = journal.run.completion!;
		if (completion.phase === "stops-intended" && completion.resources.every((resource) => resource.state === "acknowledged")) {
			let complete: RunJournal;
			try { complete = advanceRunJournal(journal, dependencies.clock.now(), (next) => { const current = next.run.completion; if (!current || current.phase !== "stops-intended") throw new Error("Graceful-stop state disappeared."); next.run.completion = { phase: "stops-complete", gate: current.gate, resources: current.resources.filter((resource): resource is Extract<CompletionStopResource, { state: "acknowledged" }> => resource.state === "acknowledged") }; }); }
			catch (error: unknown) { return { journal, note: `Graceful-stop completion could not be persisted; archive was not attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
			const persisted = await persistReviewJournal(repositoryRoot, complete, dependencies);
			if (!persisted) return { journal, note: "Graceful-stop completion could not be persisted; archive was not attempted." };
			journal = persisted;
			completion = journal.run.completion!;
			if (oneAction) return { journal, note: "All recorded resources are stopped; completion archive is queued for a later pass.", action: "stop-next-agent" };
		}
	}
	if (completion.phase === "stops-incomplete") return { journal, note: "Graceful stop is durably incomplete; no /quit resend, archive, cleanup, or notification was attempted." };
	if (completion.phase === "stops-complete") {
		const execution = journal.run.finalVerificationExecution;
		if (!execution || execution.phase !== "passed" || !dependencies.runJournal.resolveCompletionPaths || !dependencies.runJournal.archiveCompletedRun || !dependencies.runJournal.loadCompletionJournalPointers) return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "archive-failed", "Completed Run storage adapters or the immutable verification result are unavailable; archive was not attempted.", dependencies);
		const reports = await collectCompletionReports(repositoryRoot, journal, dependencies);
		if ("message" in reports) return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "archive-failed", reports.message, dependencies);
		const paths = dependencies.runJournal.resolveCompletionPaths(repositoryRoot, journal.run.id);
		const pointers = await dependencies.runJournal.loadCompletionJournalPointers(repositoryRoot);
		if (pointers.kind !== "loaded") return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "archive-failed", pointers.message, dependencies);
			const verification = finalVerificationEvidencePointers(execution);
			if (!verification) return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "archive-failed", "The passing final-verification evidence pointers are unavailable; archive was not attempted.", dependencies);
			const archive: CompletionArchiveIntent = { intendedAt: transitionTimestamp(journal, dependencies.clock.now()), archiveDirectory: paths.archiveDirectory, runPath: paths.archiveRunPath, previousRunPath: paths.archivePreviousRunPath, manifestPath: paths.archiveManifestPath, activeJournalSha256: sha256Bytes(pointers.pointers.activeBytes), previousJournalSha256: sha256Bytes(pointers.pointers.previousBytes), verification, reports };
		let archiveIntentJournal: RunJournal;
		try { archiveIntentJournal = advanceRunJournal(journal, dependencies.clock.now(), (next) => { const current = next.run.completion; if (!current || current.phase !== "stops-complete") throw new Error("Graceful-stop completion disappeared before archive intent."); next.run.completion = { phase: "archive-intended", gate: current.gate, resources: current.resources.map((resource) => ({ ...resource, acknowledgement: { ...resource.acknowledgement } })), archive }; }); }
		catch (error: unknown) { return { journal, note: `Archive intent could not be persisted; active evidence was preserved. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
		const persisted = await persistReviewJournal(repositoryRoot, archiveIntentJournal, dependencies);
		if (!persisted) return { journal, note: "Archive intent could not be persisted; active evidence was preserved." };
		journal = persisted;
		const finalPointers = await dependencies.runJournal.loadCompletionJournalPointers(repositoryRoot);
		if (finalPointers.kind !== "loaded") return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "archive-failed", finalPointers.message, dependencies);
		const finalJournal = advanceRunJournal(journal, dependencies.clock.now(), (next) => { const current = next.run.completion; if (!current || current.phase !== "archive-intended") throw new Error("Archive intent disappeared before final snapshot."); const archive = { ...current.archive, activeJournalSha256: sha256Bytes(finalPointers.pointers.activeBytes), previousJournalSha256: sha256Bytes(finalPointers.pointers.previousBytes) }; next.run.status = "completed"; for (const task of next.run.tasks) { task.phase = "completed"; task.attention = "none"; delete task.attentionReason; delete task.attentionDiagnostic; } next.run.completion = { phase: "archived", gate: current.gate, resources: current.resources.map((resource) => ({ ...resource, acknowledgement: { ...resource.acknowledgement } })), archive, archivedAt: transitionTimestamp(journal, dependencies.clock.now()) }; }, "archive/run.json");
		const published = await dependencies.runJournal.archiveCompletedRun({ repositoryRoot, runId: journal.run.id, run: finalJournal, archivedAt: finalJournal.run.completion?.phase === "archived" ? finalJournal.run.completion.archivedAt : dependencies.clock.now().toISOString(), verification: archive.verification, reports });
		if (published.kind !== "published" && published.kind !== "existing-match") return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "archive-failed", `Completion archive was not published: ${"message" in published ? published.message : "unknown archive failure"}`, dependencies);
		await dependencies.runJournal.appendActivity(repositoryRoot, { timestamp: finalJournal.run.updatedAt, runId: finalJournal.run.id, event: "run-completed", message: `Run ${finalJournal.run.id} was archived at ${paths.archiveDirectory}.` }).catch(() => undefined);
			try { dependencies.ui.notifyCompletion?.({ runId: journal.run.id, targetBranch: journal.run.integrationBase.kind === "git" ? journal.run.integrationBase.branch : "unknown", integratedHead: completion.gate.integratedHead, verificationResultPath: verification.resultPath, verificationLogPath: verification.logPath, archivePath: paths.archiveDirectory }); } catch { /* The archive remains authoritative if UI delivery fails. */ }
		return { journal: finalJournal, note: `Run ${journal.run.id} archived and completion notification was attempted.`, action: "publish-completion-archive", completed: true };
	}
	return { journal, note: "" };
}

async function dispatchIntegrationReworkBuilder(
	repositoryRoot: string,
	journalInput: RunJournal,
	candidate: { index: number; task: TaskRecord; builder: BuilderAttemptRecord; reviewer: ReviewerAttemptRecord },
	currentIntegration: TaskIntegration,
	result: Extract<import("./steward.ts").IntegrationCheckoutResult, { kind: "inspected" }>,
	difference: IntegrationTargetDifference,
	conflictPaths: string[],
	dependencies: StewardDependencies,
): Promise<ReviewDecision> {
	let journal = journalInput;
	const previousDispatch = candidate.builder.dispatch;
	const pauseRework = (diagnostic: string): Promise<ReviewDecision> => persistIntegrationObservation(repositoryRoot, journal, candidate.index, currentIntegration, result, diagnostic, dependencies);
	if ((previousDispatch.phase !== "prompted" && previousDispatch.phase !== "reconciled-active") || !dependencies.git.inspectBuilderWorktree || !dependencies.herdr.promptBuilder) return pauseRework("Advanced-target integration conflict requires the exact same proven Builder identity and read-only worktree/prompt adapters; no rework Attempt was reserved.");
	if (candidate.reviewer.evidence?.phase !== "finalized" || candidate.reviewer.evidence.verdict !== "approved" || candidate.reviewer.integrity?.kind !== "preserved" || candidate.reviewer.subject.kind !== "git") return pauseRework("Advanced-target integration conflict requires the immediately preceding finalized approved Review; no rework Attempt was reserved.");
	if (result.target?.relation !== "advanced" || result.observation.head === null || result.mergeability?.kind !== "conflicted") return pauseRework("Integration-rework preflight facts are no longer an exact clean advanced-target conflict; no Attempt was reserved.");
	const inspected = await dependencies.git.inspectBuilderWorktree(previousDispatch.worktreePath, candidate.reviewer.subject.headRevision).catch((error: unknown) => ({ kind: "unavailable" as const, message: error instanceof Error ? error.message : "Builder worktree inspection failed." }));
	if (inspected.kind !== "ready" || inspected.head !== candidate.reviewer.subject.headRevision || !inspected.clean) return pauseRework(`Integration-rework preflight requires the same clean Builder worktree at reviewed head ${candidate.reviewer.subject.headRevision}; no Attempt was reserved.`);
	const cycle = candidate.task.reworkCycles + 1;
	if (cycle > journal.run.effectiveSettings.reworkCycleLimit) return { journal, note: "The frozen rework cycle limit is exhausted; the advanced conflict remains needs-user and Git was not changed." };
	const attemptId = `attempt-${String(candidate.task.attempts.length + 1).padStart(2, "0")}`;
	const normalizedConflictPaths = [...new Set(conflictPaths)].sort();
	if (normalizedConflictPaths.length === 0 || normalizedConflictPaths.length > 100) return { journal, note: "The advanced conflict path facts are empty or exceed the bounded recovery shape; no Attempt was reserved." };
	const recoveryFacts: IntegrationReworkFacts = { targetBranch: currentIntegration.targetBranch, recordedTargetRevision: currentIntegration.targetRevision, advancedTargetRevision: result.observation.head, difference: { commits: [...difference.commits], changedPaths: difference.changedPaths.map((change) => ({ status: change.status, paths: [...change.paths] })), truncated: difference.truncated }, conflictPaths: normalizedConflictPaths };
	const priorApproval = candidate.task.approval;
	if (!priorApproval || priorApproval.phase !== "valid") return { journal, note: "The old valid Approval disappeared before integration-rework reservation; no Attempt was created." };
	const reviewerEvidence = candidate.reviewer.evidence;
	if (reviewerEvidence.phase !== "finalized") return { journal, note: "The old Reviewer manifest is not finalized; no integration-rework Attempt was created." };
	const dispatch: IntegrationReworkDispatchRecord = { phase: "assignment-intended", branch: previousDispatch.branch, agentName: previousDispatch.agentName, worktreePath: previousDispatch.worktreePath, workspaceId: previousDispatch.workspaceId, paneId: previousDispatch.paneId, terminalId: previousDispatch.terminalId, cycle, priorBuilderAttemptId: candidate.builder.id, priorReviewerAttemptId: candidate.reviewer.id, reviewedSubject: cloneReviewSubject(candidate.reviewer.subject), reviewerManifestPath: reviewerEvidence.manifestPath, reviewerManifestSha256: reviewerEvidence.manifestSha256, integrationRecovery: recoveryFacts };
	const paths = dependencies.runJournal.resolveAssignmentPaths(repositoryRoot, journal.run.id, candidate.task.contract.id, attemptId);
	const prepared: BuilderAttemptRecord = { id: attemptId, role: "builder", state: "prepared", preparedAt: transitionTimestamp(journal, dependencies.clock.now()), actualModel: { ...candidate.builder.actualModel }, ...(journal.run.revisions ? { specificationVersion: candidate.task.specificationVersion } : {}), specificationHash: candidate.task.specificationHash, baseRevision: result.observation.head, assignmentPath: paths.assignmentPath, reportPath: paths.reportPath, evidenceDirectory: paths.evidenceDirectory, dispatch };
	const observed = { ...result.observation, dirtyPaths: [...result.observation.dirtyPaths], operationMarkers: [...result.observation.operationMarkers] };
	let reserved: RunJournal;
	try {
		reserved = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
			const task = next.run.tasks[candidate.index];
			if (!task || task.attempts.length !== candidate.task.attempts.length || task.reworkCycles !== candidate.task.reworkCycles || !task.approval || task.approval.phase !== "valid" || (task.integration && !integrationIdentityMatches(task.integration, currentIntegration))) throw new Error("Integration-rework predecessor changed before cycle reservation.");
			const approval = task.approval;
			task.approval = { ...approval, phase: "invalidated", invalidatedAt: transitionTimestamp(journal, dependencies.clock.now()), reason: "target-advanced", diagnostic: `Recorded target ${currentIntegration.targetRevision} advanced to ${result.observation.head} and merge-tree found conflicts at ${normalizedConflictPaths.join(", ")}.` };
			const recovery: IntegrationReworkRecord = { targetBranch: currentIntegration.targetBranch, targetRevision: currentIntegration.targetRevision, approvedBaseRevision: currentIntegration.approvedBaseRevision, approvedHeadRevision: currentIntegration.approvedHeadRevision, approvedCommits: [...currentIntegration.approvedCommits], builderAttemptId: currentIntegration.builderAttemptId, reviewerAttemptId: currentIntegration.reviewerAttemptId, builderManifestSha256: currentIntegration.builderManifestSha256, reviewerManifestSha256: currentIntegration.reviewerManifestSha256, action: currentIntegration.action, kind: "advanced-target-conflict", ...(task.integration ? { intendedAt: task.integration.intendedAt } : {}), ...(task.integration?.phase === "retry-intended" ? { retryIntendedAt: task.integration.retryIntendedAt } : {}), observedAt: transitionTimestamp(journal, dependencies.clock.now()), observed, difference: recoveryFacts.difference, conflictPaths: normalizedConflictPaths, replacementBuilderAttemptId: attemptId };
			task.integrationRecoveries = [...(task.integrationRecoveries ?? []), recovery];
			delete task.integration;
			task.phase = "reworking";
			task.attention = "none";
			delete task.attentionReason;
			delete task.attentionDiagnostic;
			task.reworkCycles = cycle;
			task.attempts.push(prepared);
			clearTaskMonitor(next.run, task.contract.id);
		});
	} catch (error: unknown) {
		return { journal, note: `Integration-rework reservation failed before Assignment or prompt effects. ${error instanceof Error ? error.message : "Journal validation failed."}` };
	}
	const persistedReserved = await persistReviewJournal(repositoryRoot, reserved, dependencies);
	if (!persistedReserved) return { journal, note: "Integration-rework reservation could not be persisted; no Assignment or prompt effect was attempted." };
	journal = persistedReserved;
	const task = journal.run.tasks[candidate.index];
	const attempt = task ? currentAttempt(task) : undefined;
	if (!task || !attempt || attempt.role !== "builder") return { journal, note: "Reserved integration-rework Attempt disappeared; no external effect was attempted." };
	let assignment: BuilderAssignmentDocument;
	try { assignment = buildBuilderAssignment({ run: journal.run, task, attempt, worktreePath: previousDispatch.worktreePath, branch: previousDispatch.branch, workspaceId: previousDispatch.workspaceId, paneId: previousDispatch.paneId, terminalId: previousDispatch.terminalId, agentName: previousDispatch.agentName }); }
	catch (error: unknown) { return { journal, note: `Integration-rework Assignment could not be built; reserved Attempt is retained without a prompt. ${error instanceof Error ? error.message : "Assignment validation failed."}` }; }
	let assignmentResult: AssignmentCreateResult;
	try { assignmentResult = await dependencies.runJournal.createAssignment(repositoryRoot, assignment); } catch (error: unknown) { return { journal, note: `Integration-rework Assignment storage failed; reserved Attempt is retained without a prompt. ${error instanceof Error ? error.message : "Storage failed."}` }; }
	if (assignmentResult.kind !== "created" && assignmentResult.kind !== "existing-match") return { journal, note: "Integration-rework Assignment conflicts with different bytes; reserved Attempt is retained and no prompt was sent." };
	const assignmentHash = builderAssignmentSha256(assignmentResult.bytes);
	let promptIntent: RunJournal;
	try {
		promptIntent = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
			const currentTask = next.run.tasks[candidate.index];
			const current = currentTask ? currentAttempt(currentTask) : undefined;
			if (!current || current.role !== "builder" || !isIntegrationReworkDispatchForSteward(current.dispatch)) throw new Error("Reserved integration-rework Attempt disappeared before prompt intent.");
			current.dispatch = { ...current.dispatch, phase: "prompt-intended", assignmentSha256: assignmentHash };
		});
	} catch (error: unknown) { return { journal, note: `Integration-rework Builder prompt intent could not be built; no prompt was sent. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
	const persistedIntent = await persistReviewJournal(repositoryRoot, promptIntent, dependencies);
	if (!persistedIntent) return { journal, note: "Integration-rework Builder prompt intent could not be persisted; no prompt was sent." };
	journal = persistedIntent;
	let prompted: HerdrPromptResult;
	try { prompted = await dependencies.herdr.promptBuilder({ repositoryRoot, name: previousDispatch.agentName, assignmentPrompt: formatBuilderPrompt(assignment) }); } catch (error: unknown) { return { journal, note: `Same Builder integration-rework prompt failed; prompt-intended state is retained without a resend. ${error instanceof Error ? error.message : "Herdr prompt failed."}` }; }
	if (prompted.kind !== "prompted" || prompted.name !== previousDispatch.agentName || prompted.workspaceId !== previousDispatch.workspaceId || prompted.paneId !== previousDispatch.paneId || prompted.terminalId !== previousDispatch.terminalId || !validIdentity(prompted.tabId)) return { journal, note: "Same Builder integration-rework prompt acknowledgement was malformed or contradictory; prompt-intended state is retained without a resend." };
	let active: RunJournal;
	try {
		active = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
			const currentTask = next.run.tasks[candidate.index];
			const current = currentTask ? currentAttempt(currentTask) : undefined;
			if (!current || current.role !== "builder" || current.dispatch.phase !== "prompt-intended" || !("integrationRecovery" in current.dispatch)) throw new Error("Integration-rework prompt intent disappeared after prompt.");
			current.state = "active";
			current.activatedAt = transitionTimestamp(journal, dependencies.clock.now());
			current.dispatch = { ...current.dispatch, phase: "prompted", promptedAt: current.activatedAt };
		});
	} catch (error: unknown) { return { journal, note: `Same Builder integration-rework prompt succeeded but activation could not be built; no resend will be attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
	const persistedActive = await persistReviewJournal(repositoryRoot, active, dependencies);
	return persistedActive ? { journal: persistedActive, note: `Integration-rework cycle ${cycle} reserved and prompted the existing Builder ${previousDispatch.agentName} against advanced target ${result.observation.head}; awaiting fresh Attempt ${attemptId} evidence.`, action: "dispatch-rework-builder" } : { journal, note: "Same Builder integration-rework prompt succeeded but activation could not be persisted; no resend will be attempted." };
}

function isIntegrationReworkDispatchForSteward(dispatch: AttemptRecord["dispatch"]): dispatch is IntegrationReworkDispatchRecord {
	return "integrationRecovery" in dispatch;
}

async function dispatchReworkBuilder(repositoryRoot: string, journalInput: RunJournal, candidate: { index: number; task: TaskRecord; builder: BuilderAttemptRecord }, reviewer: ReviewerAttemptRecord, findings: import("./review.ts").ReviewerFinding[], dependencies: StewardDependencies): Promise<ReviewDecision> {
	if (!runAllowsWorkflowAdvance(journalInput)) return { journal: journalInput, note: "The Run is cancelled; Builder rework is dormant and no Herdr effect was attempted." };
	let journal = journalInput;
	const previousDispatch = candidate.builder.dispatch;
	if ((previousDispatch.phase !== "prompted" && previousDispatch.phase !== "reconciled-active") || !dependencies.git.inspectBuilderWorktree || !dependencies.herdr.promptBuilder) return pauseReview(repositoryRoot, candidate, journal, dependencies, "Rework requires the original proven Builder identity and read-only worktree/prompt adapters; no replacement Builder was created.");
	if (reviewer.subject.kind !== "git") return pauseReview(repositoryRoot, candidate, journal, dependencies, "Automatic same-Builder rework is only available for the existing Git flow; preserved non-Git evidence requires user attention.");
	let inspected: { kind: "ready"; head: string; clean: true } | { kind: "unavailable"; message: string };
	try { inspected = await dependencies.git.inspectBuilderWorktree(previousDispatch.worktreePath, reviewer.subject.headRevision); } catch (error: unknown) { return pauseReview(repositoryRoot, candidate, journal, dependencies, `Rework preflight failed; no Attempt was reserved. ${error instanceof Error ? error.message : "Builder worktree inspection failed."}`); }
	if (inspected.kind !== "ready" || inspected.head !== reviewer.subject.headRevision || !inspected.clean) return pauseReview(repositoryRoot, candidate, journal, dependencies, `Rework preflight requires the same clean Builder worktree at reviewed head ${reviewer.subject.headRevision}; no Attempt was reserved.`);
	const cycle = candidate.task.reworkCycles + 1;
	const attemptId = `attempt-${String(candidate.task.attempts.length + 1).padStart(2, "0")}`;
	const dispatch: ReworkDispatchRecord = { phase: "assignment-intended", branch: previousDispatch.branch, agentName: previousDispatch.agentName, worktreePath: previousDispatch.worktreePath, workspaceId: previousDispatch.workspaceId, paneId: previousDispatch.paneId, terminalId: previousDispatch.terminalId, cycle, priorBuilderAttemptId: candidate.builder.id, priorReviewerAttemptId: reviewer.id, reviewedSubject: cloneReviewSubject(reviewer.subject), reviewerManifestPath: reviewer.evidence?.phase === "finalized" ? reviewer.evidence.manifestPath : "", reviewerManifestSha256: reviewer.evidence?.phase === "finalized" ? reviewer.evidence.manifestSha256 : "", findings: findings.map((finding) => ({ ...finding })) };
	if (!dispatch.reviewerManifestPath || !dispatch.reviewerManifestSha256) return pauseReview(repositoryRoot, candidate, journal, dependencies, "Rework findings are not bound to a protected Reviewer manifest; no Attempt was reserved.");
	const paths = dependencies.runJournal.resolveAssignmentPaths(repositoryRoot, journal.run.id, candidate.task.contract.id, attemptId);
	const prepared: BuilderAttemptRecord = { id: attemptId, role: "builder", state: "prepared", preparedAt: transitionTimestamp(journal, dependencies.clock.now()), actualModel: { ...candidate.builder.actualModel }, ...(journal.run.revisions ? { specificationVersion: candidate.task.specificationVersion } : {}), specificationHash: candidate.task.specificationHash, baseRevision: candidate.builder.baseRevision, assignmentPath: paths.assignmentPath, reportPath: paths.reportPath, evidenceDirectory: paths.evidenceDirectory, dispatch };
	let reserved: RunJournal;
	try {
		reserved = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
			const task = next.run.tasks[candidate.index];
			if (!task || task.attempts.length !== candidate.task.attempts.length || task.reworkCycles !== candidate.task.reworkCycles) throw new Error("Rework predecessor changed before cycle reservation.");
			task.phase = "reworking";
			task.attention = "none";
			delete task.attentionDiagnostic;
			delete task.attentionReason;
			task.reworkCycles = cycle;
			task.attempts.push(prepared);
			clearTaskMonitor(next.run, task.contract.id);
		});
	} catch (error: unknown) { return { journal, note: `Rework cycle reservation failed before Assignment or prompt effects. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
	const persistedReserved = await persistReviewJournal(repositoryRoot, reserved, dependencies);
	if (!persistedReserved) return { journal, note: "Rework cycle reservation could not be persisted; no Assignment or prompt effect was attempted." };
	journal = persistedReserved;
	const task = journal.run.tasks[candidate.index];
	const attempt = task ? currentAttempt(task) : undefined;
	if (!task || !attempt || attempt.role !== "builder") return { journal, note: "Reserved rework Attempt disappeared; no external effect was attempted." };
	let assignment: BuilderAssignmentDocument;
	try { assignment = buildBuilderAssignment({ run: journal.run, task, attempt, worktreePath: previousDispatch.worktreePath, branch: previousDispatch.branch, workspaceId: previousDispatch.workspaceId, paneId: previousDispatch.paneId, terminalId: previousDispatch.terminalId, agentName: previousDispatch.agentName }); }
	catch (error: unknown) { return { journal, note: `Rework Assignment could not be built; reserved Attempt is retained without a prompt. ${error instanceof Error ? error.message : "Assignment validation failed."}` }; }
	let assignmentResult: AssignmentCreateResult;
	try { assignmentResult = await dependencies.runJournal.createAssignment(repositoryRoot, assignment); } catch (error: unknown) { return { journal, note: `Rework Assignment storage failed; reserved Attempt is retained without a prompt. ${error instanceof Error ? error.message : "Storage failed."}` }; }
	if (assignmentResult.kind !== "created" && assignmentResult.kind !== "existing-match") return { journal, note: "Rework Assignment conflicts with different bytes; reserved Attempt is retained and no prompt was sent." };
	const assignmentHash = builderAssignmentSha256(assignmentResult.bytes);
	let promptIntent: RunJournal;
	try {
		promptIntent = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
			const currentTask = next.run.tasks[candidate.index];
			const current = currentTask ? currentAttempt(currentTask) : undefined;
			if (!current || current.role !== "builder" || !("cycle" in current.dispatch)) throw new Error("Reserved rework Attempt disappeared before prompt intent.");
			current.dispatch = { ...current.dispatch, phase: "prompt-intended", assignmentSha256: assignmentHash };
		});
	} catch (error: unknown) { return { journal, note: `Rework Builder prompt intent could not be built; no prompt was sent. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
	const persistedIntent = await persistReviewJournal(repositoryRoot, promptIntent, dependencies);
	if (!persistedIntent) return { journal, note: "Rework Builder prompt intent could not be persisted; no prompt was sent." };
	journal = persistedIntent;
	let prompted: HerdrPromptResult;
	try { prompted = await dependencies.herdr.promptBuilder({ repositoryRoot, name: previousDispatch.agentName, assignmentPrompt: formatBuilderPrompt(assignment) }); } catch (error: unknown) { return { journal, note: `Same Builder rework prompt failed; prompt-intended state is retained without a resend. ${error instanceof Error ? error.message : "Herdr prompt failed."}` }; }
	if (prompted.kind === "failed") {
		const currentTask = journal.run.tasks[candidate.index];
		const latestAttempt = currentTask ? currentAttempt(currentTask) : undefined;
		if (currentTask && latestAttempt) {
			const transition = await recoverTypedHerdrFailure({ repositoryRoot, controllerSessionId: journal.run.controllerSessionId, journal, taskIndex: candidate.index, task: currentTask, attempt: latestAttempt, dependencies, stage: prompted.stage, code: prompted.code, diagnostic: prompted.message, identity: { name: previousDispatch.agentName, workspaceId: previousDispatch.workspaceId, paneId: previousDispatch.paneId, terminalId: previousDispatch.terminalId }, requireExactMissing: true });
			if (transition) return reviewDecisionFromTransient(transition);
		}
	}
	if (prompted.kind !== "prompted" || prompted.name !== previousDispatch.agentName || prompted.workspaceId !== previousDispatch.workspaceId || prompted.paneId !== previousDispatch.paneId || prompted.terminalId !== previousDispatch.terminalId || !validIdentity(prompted.tabId)) return { journal, note: "Same Builder rework prompt envelope was malformed; prompt-intended state is retained without a resend." };
	let active: RunJournal;
	try {
		active = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
			const currentTask = next.run.tasks[candidate.index];
			const current = currentTask ? currentAttempt(currentTask) : undefined;
			if (!current || current.role !== "builder" || current.dispatch.phase !== "prompt-intended") throw new Error("Rework prompt intent disappeared after prompt.");
			current.state = "active";
			current.activatedAt = transitionTimestamp(journal, dependencies.clock.now());
			current.dispatch = { ...current.dispatch, phase: "prompted", promptedAt: current.activatedAt };
		});
	} catch (error: unknown) { return { journal, note: `Same Builder rework prompt succeeded but activation could not be built; no resend will be attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
	const persistedActive = await persistReviewJournal(repositoryRoot, active, dependencies);
	return persistedActive ? { journal: persistedActive, note: `Rework cycle ${cycle} reserved and prompted the existing Builder ${previousDispatch.agentName}; awaiting ${attemptId} report.` } : { journal, note: "Same Builder rework prompt succeeded but activation could not be persisted; no resend will be attempted." };
}

function findInitialCodeTask(journal: RunJournal): { task: TaskRecord; index: number } | undefined {
	const admission = selectTaskAdmission(journal.run);
	if (admission.kind !== "admit") return undefined;
	const task = journal.run.tasks[admission.index];
	return task ? { task, index: admission.index } : undefined;
}

async function dispatchInitialBuilder(input: {
	repositoryRoot: string;
	controllerSessionId: string;
	journal: RunJournal;
	dependencies: StewardDependencies;
}): Promise<DispatchOutcome> {
	const { repositoryRoot, dependencies } = input;
	let journal = input.journal;
	if (!runAllowsWorkflowAdvance(journal)) return { kind: "pending", journal, message: "The Run is cancelled; Builder dispatch is dormant and no Herdr effect was attempted.", warnings: [] };
	const warnings: string[] = [];
	const pending = (message: string): DispatchOutcome => ({ kind: "pending", journal, message, warnings });
	const note = async (event: string, message: string): Promise<void> => {
		try {
			const result = await dependencies.runJournal.appendActivity(repositoryRoot, { timestamp: journal.run.updatedAt, runId: journal.run.id, event, message });
			if (result.kind !== "appended") warnings.push(`Activity logging degraded at ${result.path}.`);
		} catch (error: unknown) {
			warnings.push(`Activity logging degraded: ${error instanceof Error ? error.message : "append failed."}`);
		}
	};
	const persist = async (candidate: RunJournal, phase: string): Promise<boolean> => {
		try {
			const result = await dependencies.runJournal.replaceActive(repositoryRoot, candidate);
			if (result.kind === "replaced") {
				journal = result.journal;
				return true;
			}
			warnings.push(`Dispatch stopped at ${phase}: durable Journal replacement failed.`);
			return false;
		} catch (error: unknown) {
			warnings.push(`Dispatch stopped at ${phase}: ${error instanceof Error ? error.message : "durable Journal replacement failed."}`);
			return false;
		}
	};

	const admission = selectTaskAdmission(journal.run);
	const selected = admission.kind === "admit" ? { task: journal.run.tasks[admission.index]!, index: admission.index } : undefined;
	if (!selected) return { kind: "dispatched", journal, message: `Run ${journal.run.id} started; no approved code-changing Task is awaiting its initial Builder.`, warnings };
	const baseRevision = admission.kind === "admit" ? admission.baseRevision : journal.run.integrationBase.kind === "git" ? journal.run.integrationBase.revision : "";
	if (journal.run.integrationBase.kind !== "git") return pending("The Run has no Git integration base; Builder dispatch is pending and no external effect was attempted.");
	if (journal.run.controllerSessionId !== input.controllerSessionId) return pending("The Controller Session changed before Builder dispatch; the prepared action is pending reconciliation.");
	if (!dependencies.herdr.createBuilderWorktree || !dependencies.herdr.startBuilder || !dependencies.herdr.promptBuilder || !dependencies.git.branchExists || !dependencies.git.inspectBuilderWorktree) return pending("Builder dispatch adapters are unavailable; the Run is durable and dispatch is pending.");
	let modelDiagnostics: ConfigDiagnostic[];
	try {
		modelDiagnostics = await dependencies.model.validateModelPlans(journal.run.modelPlan);
	} catch (error: unknown) {
		return pending(`Builder Model Plan revalidation failed; dispatch is pending. ${error instanceof Error ? error.message : "Validation failed."}`);
	}
	if (modelDiagnostics.length > 0) return pending(`Builder Model Plan is no longer available; dispatch is pending. ${modelDiagnostics.map((item) => item.message).join(" ")}`);

	const task = selected.task;
	const attemptId = `attempt-${String(task.attempts.length + 1).padStart(2, "0")}`;
	const attemptFor = (candidateTask: TaskRecord | undefined): AttemptRecord | undefined => candidateTask?.attempts.find((attempt) => attempt.id === attemptId);
	const assignmentPaths = dependencies.runJournal.resolveAssignmentPaths(repositoryRoot, journal.run.id, task.contract.id, attemptId);
	let branch = `steward/${journal.run.id}/${task.contract.id}/${attemptId}`;
	try {
		let branchCollisions = 0;
		while (await dependencies.git.branchExists(repositoryRoot, branch)) {
			if (branchCollisions >= 8) return pending("Steward could not reserve a unique Builder branch namespace; dispatch is pending.");
			branchCollisions += 1;
			branch = `steward/${journal.run.id}/${task.contract.id}/${attemptId}-${compactUuid(dependencies.clock)}`;
		}
	} catch (error: unknown) {
		return pending(`Steward could not verify the Builder branch namespace; dispatch is pending. ${error instanceof Error ? error.message : "Branch inspection failed."}`);
	}
	let agentName = `steward-b-${compactUuid(dependencies.clock)}-${task.contract.id.replace(/[^0-9]/g, "").padStart(2, "0")}-01`;
	if (!safeHerdrName(agentName)) return pending("Steward could not derive a valid Herdr Builder name; dispatch is pending.");
	const model = { ...journal.run.modelPlan.builder.primary };
	const initialAttempt: BuilderAttemptRecord = {
		id: attemptId,
		role: "builder",
		state: "prepared",
		preparedAt: transitionTimestamp(journal, dependencies.clock.now()),
		actualModel: model,
		...(journal.run.revisions ? { specificationVersion: task.specificationVersion } : {}),
		specificationHash: task.specificationHash,
		baseRevision,
		assignmentPath: assignmentPaths.assignmentPath,
		reportPath: assignmentPaths.reportPath,
		evidenceDirectory: assignmentPaths.evidenceDirectory,
		dispatch: { phase: "worktree-intended", branch, agentName },
	};
	let prepared: RunJournal;
	try {
		prepared = advanceRunJournal(journal, dependencies.clock.now(), (candidate) => {
			const candidateTask = candidate.run.tasks[selected.index];
			if (!candidateTask) throw new Error("Selected Task disappeared before dispatch.");
			candidateTask.phase = "building";
			candidateTask.attempts = [...candidateTask.attempts, initialAttempt];
			clearTaskMonitor(candidate.run, candidateTask.contract.id);
		});
	} catch (error: unknown) {
		return pending(`Builder Attempt could not be prepared durably. ${error instanceof Error ? error.message : "Journal validation failed."}`);
	}
	if (!(await persist(prepared, "attempt-prepared"))) return pending("Builder Attempt preparation could not be persisted; dispatch is pending.");
	await note("attempt-prepared", `Prepared Builder Attempt ${attemptId} for Task ${task.contract.id}.`);

	let worktree: Extract<HerdrWorktreeCreateResult, { kind: "created" }>;
	try {
		const result = await dependencies.herdr.createBuilderWorktree({ repositoryRoot, branch, baseRevision, label: agentName });
		if (result.kind === "failed") {
			const currentTask = journal.run.tasks[selected.index];
			const currentAttempt = attemptFor(currentTask);
			if (currentTask && currentAttempt) {
				const transition = await recoverTypedHerdrFailure({ repositoryRoot, controllerSessionId: input.controllerSessionId, journal, taskIndex: selected.index, task: currentTask, attempt: currentAttempt, dependencies, stage: result.stage, code: result.code, diagnostic: result.message });
				if (transition) { journal = transition.journal; return pending(transition.note); }
			}
		}
		if (result.kind !== "created" || result.branch !== branch || !isAbsolutePath(result.path) || !validIdentity(result.workspaceId) || !validIdentity(result.paneId) || !validIdentity(result.terminalId) || !validIdentity(result.tabId)) return pending("Herdr returned a malformed or contradictory worktree envelope; dispatch is pending.");
		worktree = result;
	} catch (error: unknown) {
		return pending(`Builder worktree creation failed; dispatch is pending. ${error instanceof Error ? error.message : "Herdr worktree create failed."}`);
	}
	let inspected: BuilderWorktreeInspection;
	try {
		inspected = await dependencies.git.inspectBuilderWorktree(worktree.path, baseRevision);
	} catch (error: unknown) {
		return pending(`Builder worktree verification failed; dispatch is pending. ${error instanceof Error ? error.message : "Git inspection failed."}`);
	}
	if (inspected.kind !== "ready" || inspected.head !== baseRevision || !inspected.clean) return pending("Builder worktree base or clean-head verification failed; dispatch is pending.");

	let actualStart: Extract<HerdrAgentStartResult, { kind: "started" }> | undefined;
	for (let collision = 0; collision < 8; collision += 1) {
		let intended: RunJournal;
		try {
			intended = advanceRunJournal(journal, dependencies.clock.now(), (candidate) => {
				const candidateTask = candidate.run.tasks[selected.index];
				const candidateAttempt = attemptFor(candidateTask);
				if (!candidateTask || !candidateAttempt) throw new Error("Prepared Builder Attempt disappeared before agent start.");
				candidateAttempt.dispatch = { phase: "agent-intended", branch, agentName, worktreePath: worktree.path, workspaceId: worktree.workspaceId, paneId: worktree.paneId, terminalId: worktree.terminalId };
			});
		} catch (error: unknown) {
			return pending(`Builder agent intent could not be built durably; dispatch is pending. ${error instanceof Error ? error.message : "Journal validation failed."}`);
		}
		if (!(await persist(intended, "agent-intended"))) return pending("Builder agent intent could not be persisted; dispatch is pending.");
		if (collision === 0) await note("worktree-created", `Created Builder worktree ${worktree.path} on branch ${worktree.branch}.`);
		let started: HerdrAgentStartResult;
		try {
			started = await dependencies.herdr.startBuilder({ repositoryRoot, name: agentName, paneId: worktree.paneId, model });
		} catch (error: unknown) {
			return pending(`Builder agent start failed; dispatch is pending. ${error instanceof Error ? error.message : "Herdr agent start failed."}`);
		}
		if (started.kind === "failed") {
			const transition = await recoverTypedHerdrFailure({ repositoryRoot, controllerSessionId: input.controllerSessionId, journal, taskIndex: selected.index, task: journal.run.tasks[selected.index] ?? task, attempt: attemptFor(journal.run.tasks[selected.index]) ?? initialAttempt, dependencies, stage: started.stage, code: started.code, diagnostic: started.message, identity: { name: agentName, workspaceId: worktree.workspaceId, paneId: worktree.paneId, terminalId: worktree.terminalId }, requireExactMissing: true });
			if (transition) { journal = transition.journal; return pending(transition.note); }
		}
		if (started.kind === "name-collision") {
			if (collision === 7) return pending("Eight Steward-owned Builder names collided; the prepared Attempt is pending reconciliation.");
			agentName = `steward-b-${compactUuid(dependencies.clock)}-${task.contract.id.replace(/[^0-9]/g, "").padStart(2, "0")}-01`;
			if (!safeHerdrName(agentName)) return pending("Steward could not derive a valid replacement Herdr Builder name; dispatch is pending.");
			continue;
		}
		if (started.kind !== "started" || started.name !== agentName || started.agentKind !== "pi" || started.workspaceId !== worktree.workspaceId || started.paneId !== worktree.paneId || started.terminalId !== worktree.terminalId || !validIdentity(started.tabId)) return pending("Herdr returned a malformed or contradictory Builder start envelope; dispatch is pending.");
		actualStart = started;
		break;
	}
	if (!actualStart) return pending("Builder agent start did not produce an accepted identity; dispatch is pending.");
	await note("builder-started", `Started Builder ${agentName} in worktree ${worktree.path}.`);

		const agentIntent = attemptFor(journal.run.tasks[selected.index]);
		if (!agentIntent) return pending("Prepared Builder Attempt disappeared after agent start; dispatch is pending.");
		if (agentIntent.role !== "builder") return pending("Prepared Builder Attempt role changed; dispatch is pending.");
	let assignment: BuilderAssignmentDocument;
	try {
		assignment = buildBuilderAssignment({ run: journal.run, task: journal.run.tasks[selected.index], attempt: agentIntent, worktreePath: worktree.path, branch: worktree.branch, workspaceId: worktree.workspaceId, paneId: worktree.paneId, terminalId: worktree.terminalId, agentName });
	} catch (error: unknown) {
		return pending(`Builder Assignment could not be built; dispatch is pending. ${error instanceof Error ? error.message : "Assignment validation failed."}`);
	}
	let assignmentResult: AssignmentCreateResult;
	try {
		assignmentResult = await dependencies.runJournal.createAssignment(repositoryRoot, assignment);
	} catch (error: unknown) {
		return pending(`Builder Assignment could not be persisted; dispatch is pending. ${error instanceof Error ? error.message : "Assignment storage failed."}`);
	}
	if (assignmentResult.kind !== "created" && assignmentResult.kind !== "existing-match") return pending("Builder Assignment path conflicts with different bytes; dispatch is pending and the Builder was not prompted.");
	const assignmentHash = builderAssignmentSha256(assignmentResult.bytes);
	let promptIntent: RunJournal;
	try {
		promptIntent = advanceRunJournal(journal, dependencies.clock.now(), (candidate) => {
			const candidateTask = candidate.run.tasks[selected.index];
			const candidateAttempt = attemptFor(candidateTask);
			if (!candidateTask || !candidateAttempt) throw new Error("Prepared Builder Attempt disappeared before prompt intent.");
			candidateAttempt.dispatch = { phase: "prompt-intended", branch: worktree.branch, agentName, worktreePath: worktree.path, workspaceId: worktree.workspaceId, paneId: worktree.paneId, terminalId: worktree.terminalId, assignmentSha256: assignmentHash };
		});
	} catch (error: unknown) {
		return pending(`Builder prompt intent could not be built durably; dispatch is pending. ${error instanceof Error ? error.message : "Journal validation failed."}`);
	}
	if (!(await persist(promptIntent, "prompt-intended"))) return pending("Builder prompt intent could not be persisted; the Builder was not prompted.");
	let prompted: HerdrPromptResult;
	try {
		prompted = await dependencies.herdr.promptBuilder({ repositoryRoot, name: agentName, assignmentPrompt: formatBuilderPrompt(assignment) });
	} catch (error: unknown) {
		return pending(`Builder prompt failed; dispatch is pending without a resend. ${error instanceof Error ? error.message : "Herdr prompt failed."}`);
	}
	if (prompted.kind === "failed") {
		const transition = await recoverTypedHerdrFailure({ repositoryRoot, controllerSessionId: input.controllerSessionId, journal, taskIndex: selected.index, task: journal.run.tasks[selected.index] ?? task, attempt: attemptFor(journal.run.tasks[selected.index]) ?? agentIntent, dependencies, stage: prompted.stage, code: prompted.code, diagnostic: prompted.message, identity: { name: agentName, workspaceId: worktree.workspaceId, paneId: worktree.paneId, terminalId: worktree.terminalId }, requireExactMissing: true });
		if (transition) { journal = transition.journal; return pending(transition.note); }
	}
	if (prompted.kind !== "prompted" || prompted.name !== agentName || prompted.workspaceId !== worktree.workspaceId || prompted.paneId !== worktree.paneId || prompted.terminalId !== worktree.terminalId || !validIdentity(prompted.tabId)) return pending("Herdr returned a malformed or contradictory Builder prompt envelope; dispatch is pending without a resend.");
	const promptedAt = transitionTimestamp(journal, dependencies.clock.now());
	let active: RunJournal;
	try {
		active = advanceRunJournal(journal, dependencies.clock.now(), (candidate) => {
			const candidateTask = candidate.run.tasks[selected.index];
			const candidateAttempt = attemptFor(candidateTask);
			if (!candidateTask || !candidateAttempt) throw new Error("Prepared Builder Attempt disappeared before activation.");
			candidateAttempt.state = "active";
			candidateAttempt.activatedAt = promptedAt;
			candidateAttempt.dispatch = { phase: "prompted", branch: worktree.branch, agentName, worktreePath: worktree.path, workspaceId: worktree.workspaceId, paneId: worktree.paneId, terminalId: worktree.terminalId, assignmentSha256: assignmentHash, promptedAt };
		});
	} catch (error: unknown) {
		return pending(`Builder active Attempt could not be built durably; dispatch occurred and will not be resent. ${error instanceof Error ? error.message : "Journal validation failed."}`);
	}
	if (!(await persist(active, "active"))) return pending("Builder prompt succeeded, but active Attempt persistence failed; dispatch occurred and will not be resent.");
	await note("builder-dispatched", `Prompted Builder ${agentName} with Assignment ${assignmentHash}.`);
	return { kind: "dispatched", journal, message: `Run ${journal.run.id} dispatched Builder Attempt ${attemptId} for Task ${task.contract.id}. Assignment: ${assignmentResult.paths.assignmentPath}. Worktree: ${worktree.path}.`, warnings };
}

function isAbsolutePath(value: string): boolean {
	return value.startsWith("/") && value.trim() === value && !value.includes("\u0000");
}

type ReconciliationWorkflowResult = {
	kind: "none" | "changed" | "blocked" | "degraded";
	journal: RunJournal;
	note: string;
	action?: MonitorWorkflowAction;
	diagnostic?: string;
};

function reconciliationCandidate(journal: RunJournal, minimumIndex = 0): { index: number; task: TaskRecord; attempt: AttemptRecord } | undefined {
	const candidates: Array<{ index: number; task: TaskRecord; attempt: AttemptRecord }> = [];
	for (let index = minimumIndex; index < journal.run.tasks.length; index += 1) {
		const task = journal.run.tasks[index]!;
		const attempt = currentAttempt(task);
		const transientContinuation = attempt?.state === "ended-error" && task.attention === "recovering" && attempt.recovery?.infrastructure !== undefined;
		if (!attempt || !["building", "reworking", "reviewing"].includes(task.phase) || (!["prepared", "active", "awaiting-report"].includes(attempt.state) && !transientContinuation)) continue;
		if (attempt.role === "builder" && task.phase !== "building" && task.phase !== "reworking") continue;
		if (attempt.role === "reviewer" && task.phase !== "reviewing") continue;
		candidates.push({ index, task, attempt });
	}
	return candidates[0];
}

function recoveryIdentityFor(attempt: AttemptRecord): ManagedAgentIdentity | undefined {
	const dispatch = attempt.dispatch;
	if (dispatch.phase !== "agent-intended" && dispatch.phase !== "assignment-intended" && dispatch.phase !== "prompt-intended" && dispatch.phase !== "prompted" && dispatch.phase !== "reconciled-active") return undefined;
	return { name: dispatch.agentName, workspaceId: dispatch.workspaceId, paneId: dispatch.paneId, terminalId: dispatch.terminalId };
}

function exactIdentity(left: ManagedAgentIdentity, right: ManagedAgentIdentity): boolean {
	return left.name === right.name && left.workspaceId === right.workspaceId && left.paneId === right.paneId && left.terminalId === right.terminalId;
}

function optionalManagedAgentInspector(herdr: StewardHerdrAdapter): StewardHerdrAdapter["inspectManagedAgent"] {
	try {
		if (!Object.prototype.hasOwnProperty.call(herdr, "inspectManagedAgent")) return undefined;
		return herdr.inspectManagedAgent;
	} catch { return undefined; }
}

function recoveryLiveRecord(input: { observedAt: string; kind: "working" | "blocked" | "settled" | "unclear" | "missing"; lifecycle?: MonitorLifecycle; stateChangeSequence?: number | null; diagnostic?: string }): import("./run.ts").AttemptRecovery["live"] {
	const lifecycle = input.lifecycle === "unavailable" ? undefined : input.lifecycle;
	return { observedAt: input.observedAt, kind: input.kind, ...(lifecycle ? { lifecycle } : {}), ...(input.stateChangeSequence !== undefined ? { stateChangeSequence: input.stateChangeSequence } : {}), ...(input.diagnostic ? { diagnostic: input.diagnostic.slice(0, 2_000) } : {}) };
}

function sameRecoveryLive(left: import("./run.ts").AttemptRecovery["live"] | undefined, right: import("./run.ts").AttemptRecovery["live"]): boolean {
	return Boolean(left && left.kind === right.kind && left.lifecycle === right.lifecycle && left.stateChangeSequence === right.stateChangeSequence && left.diagnostic === right.diagnostic);
}

function promoteMatchingDispatch(task: TaskRecord, attempt: AttemptRecord, reconciledAt: string, basis: "matching-live-agent" | "valid-report"): void {
	if (attempt.dispatch.phase !== "prompt-intended") return;
	if (attempt.role === "builder") {
		const dispatch = attempt.dispatch;
		attempt.dispatch = { ...dispatch, phase: "reconciled-active", reconciledAt, basis };
	} else {
		const attemptIndex = task.attempts.findIndex((candidate) => candidate.id === attempt.id);
		const prior = attemptIndex > 0 ? task.attempts[attemptIndex - 1] : undefined;
		if (!prior || prior.role !== "builder" || !hasProvenAgentIdentity(prior)) throw new Error("Reviewer reconciliation cannot establish the preceding Builder branch identity.");
		const dispatch = attempt.dispatch;
		attempt.dispatch = { ...dispatch, phase: "reconciled-active", branch: prior.dispatch.branch, reconciledAt, basis };
	}
	if (attempt.state === "prepared") {
		attempt.state = "active";
		attempt.activatedAt = reconciledAt;
	}
}

function currentReconciliationAttempt(journal: RunJournal, index: number, attemptId: string): AttemptRecord | undefined {
	return journal.run.tasks[index]?.attempts.find((candidate) => candidate.id === attemptId);
}

function branchForAttempt(task: TaskRecord, attempt: AttemptRecord): string | undefined {
	if ("branch" in attempt.dispatch && typeof attempt.dispatch.branch === "string") return attempt.dispatch.branch;
	const attemptIndex = task.attempts.findIndex((candidate) => candidate.id === attempt.id);
	for (let priorIndex = attemptIndex - 1; priorIndex >= 0; priorIndex -= 1) {
		const preceding = task.attempts[priorIndex];
		if (preceding?.role === "builder" && "branch" in preceding.dispatch) return preceding.dispatch.branch;
	}
	return undefined;
}

function continuationForReplacement(task: TaskRecord, attempt: AttemptRecord): AttemptContinuation {
	if (!attempt.replacement) throw new Error("Replacement Attempt is missing its durable replacement link.");
	const predecessor = task.attempts.find((candidate) => candidate.id === attempt.replacement!.replacesAttemptId);
	if (!predecessor || predecessor.state !== "superseded" || !predecessor.recovery?.preservation) throw new Error("Replacement Attempt is missing the predecessor preservation inspection.");
	const preservation = predecessor.recovery.preservation;
	const branch = branchForAttempt(task, predecessor);
	if (!branch) throw new Error("Replacement Attempt is missing the predecessor branch identity.");
	return { predecessorAttemptId: predecessor.id, retryOrdinal: attempt.replacement.retryOrdinal, preservedWorktree: { path: preservation.worktreePath, branch, head: preservation.head }, priorAssignmentPath: preservation.assignment.path, priorReportPath: predecessor.reportPath, priorEvidenceDirectory: preservation.evidence.directory };
}

function continuationMatchesReplacement(task: TaskRecord, attempt: AttemptRecord, continuation: AttemptContinuation | undefined): boolean {
	if (!attempt.replacement || !continuation) return false;
	const predecessor = task.attempts.find((candidate) => candidate.id === attempt.replacement?.replacesAttemptId);
	const preservation = predecessor?.recovery?.preservation;
	const branch = predecessor ? branchForAttempt(task, predecessor) : undefined;
	return Boolean(predecessor && preservation && branch && predecessor.state === "superseded" && continuation.predecessorAttemptId === predecessor.id && continuation.retryOrdinal === attempt.replacement.retryOrdinal && continuation.preservedWorktree.path === preservation.worktreePath && continuation.preservedWorktree.branch === branch && continuation.preservedWorktree.head === preservation.head && continuation.priorAssignmentPath === preservation.assignment.path && continuation.priorReportPath === predecessor.reportPath && continuation.priorEvidenceDirectory === preservation.evidence.directory);
}

function preservationForSilenceSnapshot(task: TaskRecord, attempt: AttemptRecord, snapshot: SilenceInspectionSnapshot, observedAt: string): import("./run.ts").RecoveryPreservation | undefined {
	const branch = branchForAttempt(task, attempt);
	const worktreePath = "worktreePath" in attempt.dispatch ? attempt.dispatch.worktreePath : attempt.role === "reviewer" ? attempt.worktree.path : undefined;
	if (!branch || !worktreePath) return undefined;
	return { observedAt, worktreePath, branch, head: snapshot.git.head, worktree: snapshot.worktree, git: snapshot.git, assignment: snapshot.assignment, report: snapshot.report, evidence: snapshot.evidence };
}

type TransientTransition = { kind: "changed" | "degraded"; journal: RunJournal; note: string; action?: MonitorWorkflowAction; diagnostic?: string };

function reviewDecisionFromTransient(transition: TransientTransition): ReviewDecision {
	return { journal: transition.journal, note: transition.note, action: transition.action ?? (transition.kind === "degraded" ? "degraded" : "record-observation"), ...(transition.diagnostic ? { diagnostic: transition.diagnostic } : {}) };
}

function transientModelReason(attempt: AttemptRecord): "same-model-unavailable" | "same-model-retry-failed" {
	return attempt.replacement ? "same-model-retry-failed" : "same-model-unavailable";
}

async function inspectTransientPreservation(repositoryRoot: string, task: TaskRecord, attempt: AttemptRecord, dependencies: StewardDependencies, observedAt: string): Promise<RecoveryPreservation | undefined> {
	const branch = branchForAttempt(task, attempt);
	const worktreePath = "worktreePath" in attempt.dispatch ? attempt.dispatch.worktreePath : attempt.role === "reviewer" ? attempt.worktree.path : undefined;
	if (!branch || !worktreePath || !dependencies.runJournal.inspectAttemptPreservation || !dependencies.git.inspectManagedWorktreeProgress) return undefined;
	const [preserved, progress] = await Promise.all([
		dependencies.runJournal.inspectAttemptPreservation({ repositoryRoot, attempt }).catch(() => undefined),
		dependencies.git.inspectManagedWorktreeProgress(worktreePath).catch(() => undefined),
	]);
	if (!preserved || preserved.kind !== "inspected") return undefined;
	const worktree = progress?.kind === "observed" ? progress.worktree : { kind: "unavailable" as const, diagnostic: progress?.diagnostic ?? "Managed worktree inspection was unavailable." };
	const git = progress?.kind === "observed"
		? { head: progress.git.head, digest: progress.git.digest.kind === "observed" ? progress.git.digest.sha256 : null, ...(progress.git.digest.kind === "unavailable" ? { diagnostic: progress.git.digest.diagnostic } : {}) }
		: { head: null, digest: null, diagnostic: progress?.diagnostic ?? "Managed Git inspection was unavailable." };
	return {
		observedAt,
		worktreePath,
		branch,
		head: progress?.kind === "observed" ? progress.head : null,
		worktree,
		git,
		assignment: preserved.assignment,
		report: preserved.report,
		evidence: preserved.evidence,
	};
}

function transientPreservationReady(preservation: RecoveryPreservation): boolean {
	return preservation.worktree.kind === "observed" && preservation.git.head !== null && preservation.git.digest !== null && preservation.assignment.kind !== "unavailable" && preservation.report.kind !== "unavailable";
}

function infrastructureOutcome(input: ClassifiedInfrastructureFact, observedAt: string, stop: InfrastructureOutcome["stop"]): InfrastructureOutcome {
	return { kind: input.kind, stage: input.stage, observedAt, code: input.code.slice(0, 256), diagnostic: input.diagnostic.slice(0, 2_000), source: input.source ?? "typed-herdr-result", stop };
}

async function applyTransientInfrastructureRecovery(input: {
	repositoryRoot: string;
	controllerSessionId: string;
	journal: RunJournal;
	taskIndex: number;
	task: TaskRecord;
	attempt: AttemptRecord;
	fact: ClassifiedInfrastructureFact;
	dependencies: StewardDependencies;
	alreadyMissing?: boolean;
}): Promise<TransientTransition> {
	let journal = input.journal;
	const { dependencies, repositoryRoot, taskIndex, fact } = input;
	void input.controllerSessionId;
	let task = input.task;
	let attempt = input.attempt;
	const persist = async (update: (nextTask: TaskRecord, nextAttempt: AttemptRecord, nextJournal: RunJournal) => void): Promise<boolean> => {
		let candidate: RunJournal;
		try {
			candidate = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
				const nextTask = next.run.tasks[taskIndex];
				const nextAttempt = nextTask?.attempts.find((item) => item.id === attempt.id);
				if (!nextTask || !nextAttempt) throw new Error("Transient recovery Attempt disappeared before persistence.");
				update(nextTask, nextAttempt, next);
			});
		} catch { return false; }
		const replaced = await dependencies.runJournal.replaceActive(repositoryRoot, candidate).catch(() => undefined);
		if (!replaced || replaced.kind !== "replaced") return false;
		journal = replaced.journal;
		task = journal.run.tasks[taskIndex] ?? task;
		attempt = task.attempts.find((item) => item.id === attempt.id) ?? attempt;
		return true;
	};

	const observedAt = transitionTimestamp(journal, dependencies.clock.now());
	const preserved = await inspectTransientPreservation(repositoryRoot, task, attempt, dependencies, observedAt);
	const preservationReady = preserved !== undefined && transientPreservationReady(preserved);
	const failureLive = recoveryLiveRecord({ observedAt, kind: input.alreadyMissing || fact.kind === "unexpected-process-exit" ? preservationReady ? "missing" : "unclear" : "unclear", diagnostic: fact.diagnostic });
	const identity = recoveryIdentityFor(attempt);
	const existingOutcome = attempt.recovery?.infrastructure;
	if (existingOutcome?.stop.phase === "ambiguous") return { kind: "degraded", journal, note: existingOutcome.stop.diagnostic, diagnostic: "Transient stop ambiguity is durable; no effect will be repeated." };
	if (existingOutcome?.stop.phase === "intended") {
		const intendedStop = existingOutcome.stop;
		const diagnostic = "A graceful stop was intended but its acknowledgement was not retained; the exact stop effect is ambiguous and no replacement effect will be attempted.";
		const changed = await persist((nextTask, nextAttempt) => {
			nextAttempt.state = "ended-error";
			nextAttempt.recovery = { ...(nextAttempt.recovery ?? { live: failureLive }), live: failureLive, ...(preserved ? { preservation: preserved } : {}), infrastructure: infrastructureOutcome(fact, existingOutcome.observedAt, { phase: "ambiguous", intendedAt: intendedStop.intendedAt, observedAt, agent: intendedStop.agent, diagnostic }) };
			nextTask.attention = "needs-user";
			nextTask.attentionReason = "transient-stop-ambiguous";
			nextTask.attentionDiagnostic = diagnostic;
		});
		return changed ? { kind: "changed", journal, note: diagnostic } : { kind: "degraded", journal, note: diagnostic, diagnostic: "Transient stop ambiguity CAS failed." };
	}
	const stopRequired = identity !== undefined && !input.alreadyMissing && !(fact.kind === "agent-startup-failure" && attempt.state === "prepared") && fact.kind !== "unexpected-process-exit";
	if (!preservationReady) {
		if (existingOutcome?.stop.phase === "not-required" && existingOutcome.stop.reason === "preservation-unavailable") return { kind: "degraded", journal, note: "Typed transient infrastructure recovery remains retryable; fresh preservation is still unavailable, so no stop or replacement effect was attempted.", diagnostic: "Transient preservation is unavailable." };
		const stop: InfrastructureOutcome["stop"] = input.alreadyMissing || fact.kind === "unexpected-process-exit"
			? { phase: "not-required", reason: "already-missing" }
			: !stopRequired
				? { phase: "not-required", reason: "never-started" }
				: { phase: "not-required", reason: "preservation-unavailable" };
		const outcome = infrastructureOutcome(fact, observedAt, stop);
		const changed = await persist((nextTask, nextAttempt) => {
			nextAttempt.state = "ended-error";
			nextAttempt.recovery = { ...(nextAttempt.recovery ?? { live: failureLive }), live: failureLive, ...(nextAttempt.recovery?.reportRequest ? { reportRequest: nextAttempt.recovery.reportRequest } : {}), ...(nextAttempt.recovery?.blockedAnswer ? { blockedAnswer: nextAttempt.recovery.blockedAnswer } : {}), ...(preserved ? { preservation: preserved } : nextAttempt.recovery?.preservation ? { preservation: nextAttempt.recovery.preservation } : {}), ...(nextAttempt.recovery?.silence ? { silence: nextAttempt.recovery.silence } : {}), infrastructure: outcome };
			nextTask.attention = "recovering";
			nextTask.attentionReason = "transient-infrastructure-recovery";
			nextTask.attentionDiagnostic = "Typed transient infrastructure recovery is retained, but fresh bounded preservation is unavailable; no stop or replacement effect was attempted.";
		});
		return changed ? { kind: "changed", journal, note: "Typed transient failure was durably retained in retryable recovery, but fresh preservation was unavailable; no stop or replacement effect was attempted." } : { kind: "degraded", journal, note: "Typed transient failure was observed, but its retryable preservation-unavailable state could not be persisted; no stop or replacement effect was attempted.", diagnostic: "Transient recovery CAS failed." };
	}

	const storedStop = existingOutcome?.stop;
	const reusableStoredStop = storedStop && !(storedStop.phase === "not-required" && storedStop.reason === "preservation-unavailable") ? storedStop : undefined;
	let stop: InfrastructureOutcome["stop"] = reusableStoredStop ?? (fact.kind === "unexpected-process-exit" || input.alreadyMissing ? { phase: "not-required", reason: "already-missing" } : !stopRequired ? { phase: "not-required", reason: "never-started" } : { phase: "intended", intendedAt: observedAt, agent: identity! });
	let outcome = infrastructureOutcome(fact, observedAt, stop);
	if (!(await persist((nextTask, nextAttempt) => {
		nextAttempt.recovery = { ...(nextAttempt.recovery ?? { live: failureLive }), live: failureLive, preservation: preserved, infrastructure: outcome };
		nextAttempt.state = "ended-error";
		nextTask.attention = "recovering";
		nextTask.attentionReason = "transient-infrastructure-recovery";
		nextTask.attentionDiagnostic = stop.phase === "intended" ? "Typed transient infrastructure recovery is preserving exact evidence before one graceful stop." : "Typed transient infrastructure recovery retained the exact missing resource and is deriving one linked successor.";
	}))) return { kind: "degraded", journal, note: "Typed transient failure was observed, but its preservation and stop intent could not be persisted; no stop or replacement effect was attempted.", diagnostic: "Transient stop intent CAS failed." };

	if (stop.phase === "intended") {
		let stopped: HerdrStopResult;
		try { stopped = dependencies.herdr.stopAgentGracefully ? await dependencies.herdr.stopAgentGracefully({ repositoryRoot, name: identity!.name, workspaceId: identity!.workspaceId, paneId: identity!.paneId, terminalId: identity!.terminalId }) : { kind: "ambiguous", message: "Graceful stop adapter is unavailable." }; }
		catch (error: unknown) { stopped = { kind: "ambiguous", message: error instanceof Error ? error.message : "Graceful stop failed." }; }
		const exact = stopped.kind === "acknowledged" && stopped.name === identity!.name && stopped.workspaceId === identity!.workspaceId && stopped.paneId === identity!.paneId && stopped.terminalId === identity!.terminalId;
		const acknowledgedAt = transitionTimestamp(journal, dependencies.clock.now());
		stop = exact ? { phase: "acknowledged", intendedAt: observedAt, acknowledgedAt, agent: identity! } : { phase: "ambiguous", intendedAt: observedAt, observedAt: acknowledgedAt, agent: identity!, diagnostic: stopped.kind === "failed" || stopped.kind === "ambiguous" ? stopped.message : "Wrong-identity or malformed graceful stop acknowledgement." };
		outcome = infrastructureOutcome(fact, observedAt, stop);
		const recorded = await persist((nextTask, nextAttempt) => {
			nextAttempt.state = "ended-error";
			nextAttempt.recovery = { ...(nextAttempt.recovery ?? { live: failureLive }), live: failureLive, preservation: preserved, infrastructure: outcome };
			if (!exact) { nextTask.attention = "needs-user"; nextTask.attentionReason = "transient-stop-ambiguous"; nextTask.attentionDiagnostic = outcome.diagnostic; }
		});
		if (!recorded) return { kind: "degraded", journal, note: "Graceful stop was attempted, but its exact acknowledgement state could not be persisted; no replacement effect was attempted.", diagnostic: "Transient stop acknowledgement CAS failed." };
		if (!exact) return { kind: "changed", journal, note: "Graceful stop acknowledgement was not proven for the exact recorded identity; the durable ambiguity state forbids a replacement effect." };
	}

	const links = task.attempts.filter((candidate) => attemptSpecificationVersion(candidate) === task.specificationVersion).flatMap((candidate) => candidate.replacement ? [{ kind: candidate.replacement.kind, retryOrdinal: candidate.replacement.retryOrdinal, replacesAttemptId: candidate.replacement.replacesAttemptId, actualModel: candidate.actualModel }] : []);
	const ordinal = replacementRetryOrdinal(links, journal.run.effectiveSettings.transientRetryLimit);
	const finishNeedsUser = async (reason: "transient-fallback-unavailable" | "transient-retries-exhausted" | "transient-stop-ambiguous", diagnostic: string): Promise<TransientTransition> => {
		const changed = await persist((nextTask, nextAttempt) => {
			nextAttempt.state = "ended-error";
			nextAttempt.recovery = { ...(nextAttempt.recovery ?? { live: failureLive }), live: failureLive, preservation: preserved, infrastructure: outcome };
			nextTask.attention = "needs-user";
			nextTask.attentionReason = reason;
			nextTask.attentionDiagnostic = diagnostic.slice(0, 2_000);
		});
		return changed ? { kind: "changed", journal, note: diagnostic } : { kind: "degraded", journal, note: `${diagnostic} Durable needs-user state could not be persisted.`, diagnostic: "Transient terminal state CAS failed." };
	};
	if (!ordinal) return finishNeedsUser("transient-retries-exhausted", "The frozen transient replacement budget is exhausted; the latest Attempt ended with a typed infrastructure failure and no third successor was reserved.");

	const plan = journal.run.modelPlan[attempt.role];
	const choices = [plan.primary, ...plan.fallbacks];
	const inspections = await Promise.all(choices.map(async (choice, planIndex) => {
		if (!dependencies.model.inspectModelChoice) return { choice: { ...choice }, available: false, diagnostics: [{ code: "inspection-unavailable" }] };
		try { const inspected = await dependencies.model.inspectModelChoice(choice, attempt.role, planIndex); return { choice: { ...inspected.choice }, available: inspected.available, diagnostics: inspected.diagnostics.map((item) => ({ code: item.code })) }; }
		catch { return { choice: { ...choice }, available: false, diagnostics: [{ code: "inspection-failed" }] }; }
	}));
	const builderProvider = task.attempts.slice().reverse().find((candidate) => candidate.role === "builder" && candidate.id !== attempt.id)?.actualModel.model;
	const selection = selectTransientModel({ actualModel: attempt.actualModel, plan, inspections, reason: transientModelReason(attempt), ...(attempt.role === "reviewer" && builderProvider ? { requireProviderDifferentFrom: parseCanonicalModelReference(builderProvider)?.provider, allowSameProvider: attempt.independence.kind === "same-provider-family-approved" } : {}) });
	if (selection.kind === "unavailable") return finishNeedsUser("transient-fallback-unavailable", "No strictly-forward approved model remained for the typed transient recovery; no successor was reserved.");

	const dispatch = attempt.dispatch;
	const worktreePath = preserved.worktreePath;
	const branch = preserved.branch;
	const predecessor = task.attempts.slice(0, task.attempts.findIndex((candidate) => candidate.id === attempt.id)).reverse().find((candidate) => candidate.role === attempt.role || (attempt.role === "reviewer" && candidate.role === "builder"));
	const sourcePaneId = "paneId" in dispatch ? dispatch.paneId : "sourcePaneId" in dispatch ? dispatch.sourcePaneId : predecessor && "paneId" in predecessor.dispatch ? predecessor.dispatch.paneId : undefined;
	const workspaceId = "workspaceId" in dispatch ? dispatch.workspaceId : predecessor && "workspaceId" in predecessor.dispatch ? predecessor.dispatch.workspaceId : undefined;
	if (!sourcePaneId || !workspaceId) return finishNeedsUser(stop.phase === "not-required" ? "transient-fallback-unavailable" : "transient-stop-ambiguous", "The typed transient recovery has no exact source pane/workspace identity for a no-focus successor; no successor was reserved.");
	const nextAttemptId = `attempt-${String(task.attempts.length + 1).padStart(2, "0")}`;
	const paths = dependencies.runJournal.resolveAssignmentPaths(repositoryRoot, journal.run.id, task.contract.id, nextAttemptId);
	const replacementName = `${attempt.role === "builder" ? "steward-b" : "steward-r"}-${compactUuid(dependencies.clock)}-${nextAttemptId.replace(/[^0-9]/g, "")}`;
	if (!safeHerdrName(replacementName)) return finishNeedsUser("transient-fallback-unavailable", "A safe Steward-owned successor name could not be derived; no successor was reserved.");
	const modelSelection = selection.kind === "same-model-first" ? { kind: "same-model-first" as const, planIndex: selection.planIndex } : { kind: "approved-fallback" as const, planIndex: selection.planIndex, reason: selection.reason, skipped: selection.skipped };
	const replacement: AttemptReplacement = { kind: "transient-recovery", trigger: fact.kind, replacesAttemptId: attempt.id, retryOrdinal: ordinal, preservedAt: transitionTimestamp(journal, dependencies.clock.now()), modelSelection };
	const successorIndependence = attempt.role === "reviewer"
		? (() => {
			const builder = task.attempts.slice().reverse().find((candidate) => candidate.role === "builder");
			const builderProvider = builder ? parseCanonicalModelReference(builder.actualModel.model)?.provider : undefined;
			const reviewerProvider = parseCanonicalModelReference(selection.choice.model)?.provider;
			return builderProvider && reviewerProvider && builderProvider !== reviewerProvider
				? { kind: "different-provider-family" as const, builderProvider, reviewerProvider }
				: { ...attempt.independence };
		})()
		: undefined;
	const replacementDispatch = attempt.role === "builder"
		? { phase: "replacement-pane-intended" as const, branch, worktreePath, agentName: replacementName, sourcePaneId, workspaceId }
		: { phase: "replacement-pane-intended" as const, sourcePaneId, worktreePath, agentName: replacementName, branch, workspaceId };
	const reservedAt = replacement.preservedAt;
		const reserved = await persist((nextTask, nextAttempt, nextJournal) => {
		if (nextAttempt.state !== attempt.state || nextAttempt.id !== attempt.id) throw new Error("Transient predecessor changed before successor reservation.");
		nextAttempt.state = "superseded";
		nextAttempt.recovery = { ...(nextAttempt.recovery ?? { live: failureLive }), live: failureLive, preservation: preserved, infrastructure: outcome };
		const successor: AttemptRecord = attempt.role === "builder"
			? { id: nextAttemptId, role: "builder", state: "prepared", preparedAt: reservedAt, actualModel: { ...selection.choice }, ...(nextJournal.run.revisions ? { specificationVersion: nextTask.specificationVersion } : {}), specificationHash: attempt.specificationHash, baseRevision: attempt.baseRevision, assignmentPath: paths.assignmentPath, reportPath: paths.reportPath, evidenceDirectory: paths.evidenceDirectory, dispatch: replacementDispatch, replacement }
			: { id: nextAttemptId, role: "reviewer", state: "prepared", preparedAt: reservedAt, actualModel: { ...selection.choice }, ...(nextJournal.run.revisions ? { specificationVersion: nextTask.specificationVersion } : {}), specificationHash: attempt.specificationHash, assignmentPath: paths.assignmentPath, reportPath: paths.reportPath, evidenceDirectory: paths.evidenceDirectory, subject: attempt.subject, independence: successorIndependence!, worktree: { path: attempt.worktree.path, baseline: { ...attempt.worktree.baseline, dirtyPaths: [...attempt.worktree.baseline.dirtyPaths], operationMarkers: [...attempt.worktree.baseline.operationMarkers] } }, dispatch: replacementDispatch, replacement };
			nextTask.attempts.push(successor);
			clearTaskMonitor(nextJournal.run, nextTask.contract.id);
			nextTask.attention = "none";
		delete nextTask.attentionReason;
		delete nextTask.attentionDiagnostic;
	});
	return reserved ? { kind: "changed", journal, note: `Reserved transient replacement Attempt ${nextAttemptId} at retry ordinal ${ordinal}; no successor effect was attempted in this pass.`, action: "reserve-transient-replacement" } : { kind: "degraded", journal, note: "Typed transient recovery lost its successor reservation Journal race; no pane, start, or prompt effect was attempted.", diagnostic: "Transient successor reservation CAS failed." };
}

async function recoverTypedHerdrFailure(input: {
	repositoryRoot: string;
	controllerSessionId: string;
	journal: RunJournal;
	taskIndex: number;
	task: TaskRecord;
	attempt: AttemptRecord;
	dependencies: StewardDependencies;
	stage: import("./reconciliation.ts").TransientInfrastructureStage;
	code: string;
	diagnostic: string;
	identity?: ManagedAgentIdentity;
	requireExactMissing?: boolean;
}): Promise<TransientTransition | undefined> {
	const fact = classifyInfrastructureFact({ stage: input.stage, code: input.code, diagnostic: input.diagnostic, source: "typed-herdr-result" });
	if (!fact) return undefined;
	let alreadyMissing = false;
	if (input.requireExactMissing && (fact.kind === "agent-startup-failure" || fact.kind === "unexpected-process-exit")) {
		if (!input.identity || !input.dependencies.herdr.inspectManagedAgent) return undefined;
		let observed: ManagedAgentInspection;
		try { observed = await input.dependencies.herdr.inspectManagedAgent(input.identity); }
		catch { return undefined; }
		if (observed.kind !== "missing") return undefined;
		alreadyMissing = true;
	} else if (input.requireExactMissing && input.identity && input.dependencies.herdr.inspectManagedAgent) {
		try {
			const observed = await input.dependencies.herdr.inspectManagedAgent(input.identity);
			if (observed.kind === "missing") alreadyMissing = true;
		} catch { /* Typed provider/command facts remain authoritative; stop is still gated below. */ }
	}
	return applyTransientInfrastructureRecovery({ ...input, fact, alreadyMissing });
}

function sameFact(left: unknown, right: unknown): boolean {
	const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)])) : value;
	return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function factValueFromAssignment(field: TaskFactKey, task: TaskRecord, attempt: AttemptRecord, assignment: import("./run.ts").AssignmentDocument): unknown {
	const facts = assignment.assignment;
	switch (field) {
		case "requiredOutcome": return facts.requiredOutcome;
		case "allowedScope": return task.contract.allowedScope;
		case "expectedArtifacts": return task.contract.expectedArtifacts;
		case "verification": return task.contract.verification;
		case "reportPath": return facts.reportPath;
		case "evidenceDirectory": return facts.evidenceDirectory;
		case "reviewSubject": return attempt.role === "reviewer" && "subject" in facts ? facts.subject : undefined;
	}
}

async function verifiedTaskFactValue(repositoryRoot: string, runId: string, task: TaskRecord, attempt: AttemptRecord, dependencies: StewardDependencies, field: TaskFactKey): Promise<{ kind: "verified"; value: unknown } | { kind: "blocked"; diagnostic: string }> {
		if (!dependencies.runJournal.inspectAttemptAssignment) return { kind: "blocked", diagnostic: "The protected Assignment inspection adapter is unavailable." };
		const observed = await dependencies.runJournal.inspectAttemptAssignment({ repositoryRoot, attempt });
		if (observed.kind !== "loaded") return { kind: "blocked", diagnostic: observed.diagnostic };
		if (!hasAssignmentIdentity(attempt) || observed.sha256 !== attempt.dispatch.assignmentSha256 || observed.path !== attempt.assignmentPath) return { kind: "blocked", diagnostic: "The protected Assignment bytes do not match the exact recorded Attempt identity." };
		let decoded: import("./run.ts").AssignmentDocument | undefined;
		if (attempt.role === "builder") {
			const value = deserializeBuilderAssignment(observed.bytes.toString("utf8"), attempt.assignmentPath);
			decoded = value.value;
		} else {
			const value = deserializeReviewerAssignment(observed.bytes.toString("utf8"), attempt.assignmentPath);
			decoded = value.value;
		}
		if (!decoded || decoded.assignment.runId !== runId || decoded.assignment.taskId !== task.contract.id || decoded.assignment.attemptId !== attempt.id || decoded.assignment.specificationHash !== task.specificationHash || decoded.assignment.reportPath !== attempt.reportPath || decoded.assignment.evidenceDirectory !== attempt.evidenceDirectory) return { kind: "blocked", diagnostic: "The protected Assignment is malformed or no longer matches the frozen Task and Attempt." };
		const recordedIdentity = recoveryIdentityFor(attempt);
		if (!recordedIdentity || decoded.assignment.herdr.agentName !== recordedIdentity.name || decoded.assignment.herdr.workspaceId !== recordedIdentity.workspaceId || decoded.assignment.herdr.paneId !== recordedIdentity.paneId || decoded.assignment.herdr.terminalId !== recordedIdentity.terminalId) return { kind: "blocked", diagnostic: "The protected Assignment resource identity does not match the exact recorded agent." };
		if (attempt.role === "builder" && (!decoded.assignment.worktree || !('branch' in decoded.assignment.worktree) || decoded.assignment.worktree.path !== attempt.dispatch.worktreePath || decoded.assignment.worktree.branch !== attempt.dispatch.branch)) return { kind: "blocked", diagnostic: "The protected Builder Assignment worktree identity changed." };
		if (attempt.role === "reviewer" && decoded.assignment.worktree.path !== attempt.worktree.path) return { kind: "blocked", diagnostic: "The protected Reviewer Assignment worktree identity changed." };
		const assignedValue = factValueFromAssignment(field, task, attempt, decoded);
		const expectedValue = taskFactValue({ field, task: task.contract, attempt: { reportPath: attempt.reportPath, evidenceDirectory: attempt.evidenceDirectory, ...(attempt.role === "reviewer" ? { subject: attempt.subject } : {}) } });
		if (assignedValue === undefined || !sameFact(assignedValue, expectedValue)) return { kind: "blocked", diagnostic: "The requested Task fact does not equal the frozen Assignment and Journal facts." };
		return { kind: "verified", value: assignedValue };
}

async function reconcileOneCurrentAttempt(repositoryRoot: string, controllerSessionId: string, journalInput: RunJournal, dependencies: StewardDependencies, minimumIndex = 0): Promise<ReconciliationWorkflowResult> {
	let journal = journalInput;
	const selected = reconciliationCandidate(journal, minimumIndex);
	if (!selected) return { kind: "none", journal, note: "No current non-finalized Attempt requires reconciliation." };
	const { index } = selected;
	let task = selected.task;
	let attempt = selected.attempt;
	const persist = async (update: (nextTask: TaskRecord, nextAttempt: AttemptRecord) => void): Promise<boolean> => {
		let candidate: RunJournal;
		try {
			candidate = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
				const nextTask = next.run.tasks[index];
				const nextAttempt = nextTask?.attempts.find((item) => item.id === attempt.id);
				if (!nextTask || !nextAttempt) throw new Error("Reconciliation Attempt disappeared before the durable transition.");
				update(nextTask, nextAttempt);
			});
		} catch { return false; }
		const replaced = await dependencies.runJournal.replaceActive(repositoryRoot, candidate);
		if (replaced.kind !== "replaced") return false;
		journal = replaced.journal;
		return true;
	};

	if (attempt.state === "ended-error" && task.attention === "recovering" && attempt.recovery?.infrastructure) {
		const recorded = attempt.recovery.infrastructure;
		const fact = classifyInfrastructureFact({ stage: recorded.stage, code: recorded.code, diagnostic: recorded.diagnostic, source: recorded.source });
		if (!fact) return { kind: "degraded", journal, note: "The durable transient infrastructure fact is not an allowlisted typed fact; no recovery effect was attempted.", diagnostic: "Transient recovery fact could not be reclassified." };
		const transition = await applyTransientInfrastructureRecovery({ repositoryRoot, controllerSessionId, journal, taskIndex: index, task, attempt, fact, dependencies });
		return { kind: transition.kind, journal: transition.journal, note: transition.note, ...(transition.action ? { action: transition.action } : {}), ...(transition.diagnostic ? { diagnostic: transition.diagnostic } : {}) };
	}

		const continuePreparedDispatch = async (): Promise<ReconciliationWorkflowResult | undefined> => {
			if (attempt.state !== "prepared") return undefined;
		const markReplacementAmbiguous = async (diagnostic: string): Promise<RunJournal | undefined> => {
			if (!attempt.replacement) return undefined;
			const loaded = await dependencies.runJournal.loadActive(repositoryRoot).catch(() => undefined);
			if (!loaded || loaded.kind !== "loaded") return undefined;
			const predecessorId = attempt.replacement.replacesAttemptId;
			const observedAt = transitionTimestamp(loaded.journal, dependencies.clock.now());
			let candidate: RunJournal;
			try {
				candidate = advanceRunJournal(loaded.journal, dependencies.clock.now(), (next) => {
					const nextTask = next.run.tasks[index];
					const nextAttempt = nextTask?.attempts.find((item) => item.id === attempt.id);
					const predecessor = nextTask?.attempts.find((item) => item.id === predecessorId);
					const existing = predecessor?.recovery?.silence;
					if (!nextTask || !nextAttempt || nextAttempt.state !== "prepared" || !nextAttempt.replacement || nextAttempt.replacement.replacesAttemptId !== predecessorId || !predecessor || predecessor.state !== "superseded" || !existing) throw new Error("Replacement ambiguity target changed before persistence.");
					if (existing.phase === "replacement-ambiguous") return;
					if (existing.phase !== "replacement-intended") throw new Error("Replacement reservation disappeared before ambiguity persistence.");
					predecessor.recovery = { ...(predecessor.recovery ?? { live: recoveryLiveRecord({ observedAt, kind: "unclear", diagnostic: "Replacement ambiguity recovery observation." }) }), silence: { ...existing, phase: "replacement-ambiguous", phaseAt: observedAt, observedAt, diagnostic: diagnostic.slice(0, 2_000) } };
					nextTask.attention = "needs-user";
					nextTask.attentionReason = "silence-effect-ambiguous";
					nextTask.attentionDiagnostic = "A reserved replacement effect may have occurred without an exact acknowledgement; no replacement effect will be repeated.";
				});
		} catch { return undefined; }
			const replaced = await dependencies.runJournal.replaceActive(repositoryRoot, candidate).catch(() => undefined);
				return replaced?.kind === "replaced" ? replaced.journal : undefined;
			};
			const refreshReplacementPreservation = async (): Promise<{ kind: "ready"; journal: RunJournal; task: TaskRecord; attempt: AttemptRecord } | { kind: "blocked"; journal: RunJournal; note: string }> => {
				if (!attempt.replacement) return { kind: "ready", journal, task, attempt };
				const loaded = await dependencies.runJournal.loadActive(repositoryRoot).catch(() => undefined);
				if (!loaded || loaded.kind !== "loaded") return { kind: "blocked", journal, note: "The replacement reservation could not be freshly reloaded; no pane, start, Assignment, or prompt effect was attempted." };
				const freshTask = loaded.journal.run.tasks[index];
				const freshAttempt = freshTask?.attempts.find((candidate) => candidate.id === attempt.id);
				const predecessorId = attempt.replacement.replacesAttemptId;
				const predecessor = freshTask?.attempts.find((candidate) => candidate.id === predecessorId);
				const reservation = predecessor?.recovery?.preservation;
				if (!freshTask || !freshAttempt || freshAttempt.state !== "prepared" || JSON.stringify(freshAttempt.dispatch) !== JSON.stringify(attempt.dispatch) || !freshAttempt.replacement || freshAttempt.replacement.replacesAttemptId !== predecessorId || !predecessor || predecessor.state !== "superseded" || !reservation) return { kind: "blocked", journal: loaded.journal, note: "The replacement reservation or exact resource identity changed while its preserved resources were being re-inspected; no replacement effect was attempted." };
				const branch = branchForAttempt(freshTask, predecessor);
				const worktreePath = "worktreePath" in predecessor.dispatch ? predecessor.dispatch.worktreePath : predecessor.role === "reviewer" ? predecessor.worktree.path : undefined;
				if (!branch || !worktreePath || !dependencies.runJournal.inspectAttemptPreservation || !dependencies.git.inspectManagedWorktreeProgress) {
					journal = loaded.journal;
					task = freshTask;
					attempt = freshAttempt;
					const ambiguous = await markReplacementAmbiguous("Fresh replacement preservation inspection is unavailable; the reserved work and resources remain untouched.");
					return { kind: "blocked", journal: ambiguous ?? loaded.journal, note: ambiguous ? "Fresh replacement preservation inspection was unavailable; no replacement effect will be attempted again." : "Fresh replacement preservation inspection was unavailable and its no-resend tombstone could not be persisted." };
				}
				const preserved = await dependencies.runJournal.inspectAttemptPreservation({ repositoryRoot, attempt: predecessor }).catch((error: unknown) => ({ kind: "unavailable", diagnostic: error instanceof Error ? error.message : "Attempt preservation inspection failed." } as import("./run-journal-store.ts").AttemptPreservationInspection));
				const progress = await dependencies.git.inspectManagedWorktreeProgress(worktreePath).catch((error: unknown) => ({ kind: "unavailable", diagnostic: error instanceof Error ? error.message : "Managed worktree inspection failed." } as ManagedWorktreeProgress));
				if (preserved.kind !== "inspected" || progress.kind !== "observed" || progress.git.digest.kind !== "observed") {
					journal = loaded.journal;
					task = freshTask;
					attempt = freshAttempt;
					const diagnostic = preserved.kind !== "inspected" ? preserved.diagnostic : progress.kind !== "observed" ? progress.diagnostic : "Managed Git digest was unavailable during fresh replacement preservation inspection.";
					const ambiguous = await markReplacementAmbiguous(diagnostic);
					return { kind: "blocked", journal: ambiguous ?? loaded.journal, note: ambiguous ? "Fresh replacement preservation was unavailable; both resources remain retained and no replacement effect will be attempted again." : "Fresh replacement preservation was unavailable and its no-resend tombstone could not be persisted." };
				}
				const freshPreservation: import("./run.ts").RecoveryPreservation = {
					observedAt: transitionTimestamp(loaded.journal, dependencies.clock.now()),
					worktreePath,
					branch,
					head: progress.head,
					worktree: progress.worktree,
					git: { head: progress.git.head, digest: progress.git.digest.sha256 },
					assignment: preserved.assignment,
					report: preserved.report,
					evidence: preserved.evidence,
				};
				const sameReservation = sameFact({ ...reservation, observedAt: "" }, { ...freshPreservation, observedAt: "" });
				if (sameReservation) {
					journal = loaded.journal;
					task = freshTask;
					attempt = freshAttempt;
					return { kind: "ready", journal, task, attempt };
				}
				const observedAt = transitionTimestamp(loaded.journal, dependencies.clock.now());
				const diagnostic = "Preserved worktree, HEAD, Assignment, report, or evidence changed after replacement reservation; both resources were retained and no replacement effect was attempted.";
				let candidate: RunJournal;
				try {
					candidate = advanceRunJournal(loaded.journal, dependencies.clock.now(), (next) => {
						const nextTask = next.run.tasks[index];
						const nextAttempt = nextTask?.attempts.find((item) => item.id === freshAttempt.id);
						const nextPredecessor = nextTask?.attempts.find((item) => item.id === predecessorId);
						const current = nextPredecessor?.recovery?.silence;
						if (!nextTask || !nextAttempt || nextAttempt.state !== "prepared" || !nextAttempt.replacement || nextAttempt.replacement.replacesAttemptId !== predecessorId || !nextPredecessor || nextPredecessor.state !== "superseded" || !nextPredecessor.recovery || !current || !["replacement-intended", "replacement-ambiguous"].includes(current.phase)) throw new Error("Replacement reservation changed before fresh preservation evidence could be retained.");
						const silence: SilencePhase = current.phase === "replacement-intended"
							? { ...current, phase: "replacement-ambiguous", phaseAt: observedAt, observedAt, diagnostic }
							: current.phase === "replacement-ambiguous"
								? { ...current, phaseAt: observedAt, observedAt, diagnostic }
								: (() => { throw new Error("Replacement silence phase changed before fresh preservation evidence could be retained."); })();
						nextPredecessor.recovery = { ...nextPredecessor.recovery, preservation: freshPreservation, silence };
						nextTask.attention = "needs-user";
						nextTask.attentionReason = "silence-effect-ambiguous";
						nextTask.attentionDiagnostic = diagnostic;
					});
				} catch {
					return { kind: "blocked", journal: loaded.journal, note: "Preserved resources changed after replacement reservation, but the no-resend attention state could not be built; no replacement effect was attempted." };
				}
				const replaced = await dependencies.runJournal.replaceActive(repositoryRoot, candidate).catch(() => undefined);
				if (!replaced || replaced.kind !== "replaced") return { kind: "blocked", journal: loaded.journal, note: "Preserved resources changed after replacement reservation, but the fresh evidence and no-resend attention state lost a Journal race; no replacement effect was attempted." };
				return { kind: "blocked", journal: replaced.journal, note: "Preserved resources changed after replacement reservation; fresh evidence was retained, both resources remain untouched, and no replacement effect was attempted." };
			};
			if (attempt.replacement) {
				const predecessor = task.attempts.find((candidate) => candidate.id === attempt.replacement?.replacesAttemptId);
				if (predecessor?.recovery?.silence?.phase === "replacement-ambiguous") return { kind: "degraded", journal, note: "The linked replacement has an ambiguity tombstone; no pane, start, Assignment, or prompt effect will be repeated." };
			}
			if (attempt.dispatch.phase === "prompt-intended") {
			if (!attempt.replacement) return undefined;
			const dispatch = attempt.dispatch;
			if (!("workspaceId" in dispatch) || !("paneId" in dispatch) || !("terminalId" in dispatch) || !("assignmentSha256" in dispatch)) return { kind: "degraded", journal, note: "The reserved replacement prompt intent lacks an exact resource identity; no prompt was resent." };
			const identity = { name: dispatch.agentName, workspaceId: dispatch.workspaceId, paneId: dispatch.paneId, terminalId: dispatch.terminalId };
			if (!dependencies.runJournal.inspectAttemptAssignment) return { kind: "degraded", journal, note: "The reserved replacement Assignment cannot be reloaded; no prompt was attempted." };
			const observed = await dependencies.runJournal.inspectAttemptAssignment({ repositoryRoot, attempt }).catch((error: unknown) => ({ kind: "unavailable", diagnostic: error instanceof Error ? error.message : "Replacement Assignment inspection failed." } as import("./run-journal-store.ts").AttemptAssignmentInspection));
			if (observed.kind !== "loaded" || observed.sha256 !== dispatch.assignmentSha256) return { kind: "degraded", journal, note: "The reserved replacement Assignment bytes do not match its prompt intent; no prompt was attempted." };
			let prompt: string;
			try {
				if (attempt.role === "builder") {
					const assignment = deserializeBuilderAssignment(observed.bytes.toString("utf8"), attempt.assignmentPath).value;
					if (!assignment) throw new Error("Replacement Builder Assignment is invalid.");
					prompt = formatBuilderPrompt(assignment);
				} else {
					const assignment = deserializeReviewerAssignment(observed.bytes.toString("utf8"), attempt.assignmentPath).value;
					if (!assignment) throw new Error("Replacement Reviewer Assignment is invalid.");
					prompt = formatReviewerPrompt(assignment);
				}
				} catch (error: unknown) { return { kind: "degraded", journal, note: `The reserved replacement Assignment could not be formatted; no prompt was attempted. ${error instanceof Error ? error.message : "Assignment decode failed."}` }; }
				const promptPreservation = await refreshReplacementPreservation();
				if (promptPreservation.kind === "blocked") return { kind: "degraded", journal: promptPreservation.journal, note: promptPreservation.note };
				journal = promptPreservation.journal;
				task = promptPreservation.task;
				attempt = promptPreservation.attempt;
				let prompted: HerdrPromptResult;
			try { prompted = dependencies.herdr.promptReplacementAgent ? await dependencies.herdr.promptReplacementAgent({ repositoryRoot, identity, assignmentPrompt: prompt }) : { kind: "failed", stage: "agent-prompt", code: "adapter-unavailable", message: "Replacement prompt adapter is unavailable." }; }
			catch (error: unknown) { prompted = { kind: "failed", stage: "agent-prompt", code: "runner-error", message: error instanceof Error ? error.message : "Replacement prompt failed." }; }
			if (prompted.kind === "failed") {
				const transition = await recoverTypedHerdrFailure({ repositoryRoot, controllerSessionId, journal, taskIndex: index, task, attempt, dependencies, stage: prompted.stage, code: prompted.code, diagnostic: prompted.message, identity, requireExactMissing: true });
				if (transition) return { kind: transition.kind, journal: transition.journal, note: transition.note, ...(transition.action ? { action: transition.action } : {}) };
			}
			const exact = prompted.kind === "prompted" && prompted.name === identity.name && prompted.workspaceId === identity.workspaceId && prompted.paneId === identity.paneId && prompted.terminalId === identity.terminalId;
			if (!exact) {
				const ambiguous = await markReplacementAmbiguous(prompted.kind === "failed" ? prompted.message : "Wrong-identity or malformed replacement prompt acknowledgement.");
				return { kind: "degraded", journal: ambiguous ?? journal, note: ambiguous ? `Replacement Attempt ${attempt.id} prompt delivery is ambiguous; its durable tombstone forbids a resend.` : `Replacement Attempt ${attempt.id} prompt was not proven for the exact identity; its prompt intent is retained and will not be resent.` };
			}
			const activatedAt = transitionTimestamp(journal, dependencies.clock.now());
			const changed = await persist((_nextTask, nextAttempt) => {
				if (nextAttempt.role !== attempt.role || nextAttempt.state !== "prepared" || nextAttempt.dispatch.phase !== "prompt-intended") throw new Error("Replacement prompt intent disappeared before activation.");
				nextAttempt.state = "active";
				nextAttempt.activatedAt = activatedAt;
				nextAttempt.dispatch = { ...nextAttempt.dispatch, phase: "prompted", promptedAt: activatedAt } as AttemptRecord["dispatch"];
			});
			if (changed) return { kind: "changed", journal, note: `Prompted linked replacement Attempt ${attempt.id} once with its immutable continuation Assignment.`, action: "record-observation" };
			const ambiguous = await markReplacementAmbiguous("Replacement prompt succeeded but activation persistence was ambiguous.");
			return { kind: "degraded", journal: ambiguous ?? journal, note: ambiguous ? "Replacement prompt activation is ambiguous; its durable tombstone forbids a resend." : "Replacement prompt succeeded, but activation could not be persisted; no prompt will be resent." };
		}
		const dispatch = attempt.dispatch;
			if (dispatch.phase === "replacement-pane-intended") {
				if (!dependencies.herdr.createRecoveryPane || !dependencies.herdr.inspectManagedAgent || !("sourcePaneId" in dispatch) || !("worktreePath" in dispatch)) return { kind: "degraded", journal, note: "The reserved silent replacement is missing its exact no-focus recovery-pane adapter; no pane or agent effect was attempted." };
				const panePreservation = await refreshReplacementPreservation();
				if (panePreservation.kind === "blocked") return { kind: "degraded", journal: panePreservation.journal, note: panePreservation.note };
				journal = panePreservation.journal;
				task = panePreservation.task;
				attempt = panePreservation.attempt;
				let pane: HerdrReviewerPaneResult;
			try { pane = await dependencies.herdr.createRecoveryPane({ repositoryRoot, sourcePaneId: dispatch.sourcePaneId, workspaceId: dispatch.workspaceId, worktreePath: dispatch.worktreePath, branch: dispatch.branch, agentName: dispatch.agentName }); }
			catch (error: unknown) {
				const ambiguous = await markReplacementAmbiguous(error instanceof Error ? error.message : "Recovery pane split failed.");
				return { kind: "degraded", journal: ambiguous ?? journal, note: ambiguous ? "The reserved replacement pane effect is ambiguous; its durable tombstone forbids a second pane split." : "The reserved silent replacement pane could not be created; the same prepared Attempt remains pending." };
			}
			if (pane.kind === "failed") {
				const transition = await recoverTypedHerdrFailure({ repositoryRoot, controllerSessionId, journal, taskIndex: index, task, attempt, dependencies, stage: pane.stage, code: pane.code, diagnostic: pane.message });
				if (transition) return { kind: transition.kind, journal: transition.journal, note: transition.note, ...(transition.action ? { action: transition.action } : {}) };
			}
			if (pane.kind !== "created" || pane.sourcePaneId !== dispatch.sourcePaneId || pane.worktreePath !== dispatch.worktreePath || pane.workspaceId !== dispatch.workspaceId || !validIdentity(pane.paneId) || !validIdentity(pane.terminalId) || !validIdentity(pane.tabId)) {
				const ambiguous = await markReplacementAmbiguous("Herdr returned a malformed or contradictory recovery-pane identity.");
				return { kind: "degraded", journal: ambiguous ?? journal, note: ambiguous ? "The reserved replacement pane acknowledgement is ambiguous; its durable tombstone forbids a second pane split." : "The reserved silent replacement returned a malformed or contradictory pane identity; no resource was adopted." };
			}
			const changed = await persist((_nextTask, nextAttempt) => {
				if (nextAttempt.state !== "prepared" || nextAttempt.dispatch.phase !== "replacement-pane-intended") throw new Error("Reserved silent replacement changed before pane identity persistence.");
				nextAttempt.dispatch = nextAttempt.role === "builder"
					? { phase: "agent-intended", branch: dispatch.branch, agentName: dispatch.agentName, worktreePath: dispatch.worktreePath, workspaceId: pane.workspaceId, paneId: pane.paneId, terminalId: pane.terminalId }
					: { phase: "agent-intended", agentName: dispatch.agentName, worktreePath: dispatch.worktreePath, workspaceId: pane.workspaceId, paneId: pane.paneId, terminalId: pane.terminalId } as ReviewerAttemptRecord["dispatch"];
			});
			if (changed) return { kind: "changed", journal, note: `Reserved silent replacement Attempt ${attempt.id} now records its exact no-focus pane; no agent was started in this pass.`, action: "record-observation" };
			const ambiguous = await markReplacementAmbiguous("The recovery pane was created but its exact identity could not be persisted.");
			return { kind: "degraded", journal: ambiguous ?? journal, note: ambiguous ? "The replacement pane was created but its identity persistence was ambiguous; no second pane split will occur." : "The replacement pane was created, but its exact identity could not be persisted; no later effect was attempted." };
		}
		if (dispatch.phase === "pane-intended") return { kind: "degraded", journal, note: "Reviewer pane creation was interrupted before an exact returned pane identity; the same prepared Attempt is preserved and no second pane was split." };

		if (attempt.role === "builder" && dispatch.phase === "worktree-intended") {
			if (!dependencies.herdr.createBuilderWorktree || !dependencies.git.inspectBuilderWorktree) return { kind: "degraded", journal, note: "The prepared Builder worktree phase cannot continue because its exact no-clobber adapters are unavailable." };
			let created: HerdrWorktreeCreateResult;
			try {
				created = await dependencies.herdr.createBuilderWorktree({ repositoryRoot, branch: dispatch.branch, baseRevision: attempt.baseRevision, label: dispatch.agentName });
			} catch (error: unknown) {
				return { kind: "degraded", journal, note: `Prepared Builder worktree creation failed; the same Attempt remains pending. ${error instanceof Error ? error.message : "Worktree creation failed."}` };
			}
			if (created.kind === "failed") {
				const transition = await recoverTypedHerdrFailure({ repositoryRoot, controllerSessionId, journal, taskIndex: index, task, attempt, dependencies, stage: created.stage, code: created.code, diagnostic: created.message });
				if (transition) return { kind: transition.kind, journal: transition.journal, note: transition.note, ...(transition.action ? { action: transition.action } : {}) };
			}
			if (created.kind !== "created" || created.branch !== dispatch.branch || !isAbsolutePath(created.path) || !validIdentity(created.workspaceId) || !validIdentity(created.paneId) || !validIdentity(created.terminalId) || !validIdentity(created.tabId)) return { kind: "degraded", journal, note: "Prepared Builder worktree creation returned a malformed or contradictory envelope; no resource was adopted." };
			let inspected: BuilderWorktreeInspection;
			try { inspected = await dependencies.git.inspectBuilderWorktree(created.path, attempt.baseRevision); }
			catch (error: unknown) { return { kind: "degraded", journal, note: `Prepared Builder worktree verification failed; no later effect was attempted. ${error instanceof Error ? error.message : "Git inspection failed."}` }; }
			if (inspected.kind !== "ready" || inspected.head !== attempt.baseRevision || !inspected.clean) return { kind: "degraded", journal, note: "Prepared Builder worktree base or clean-head verification failed; the same Attempt remains pending." };
			const changed = await persist((_nextTask, nextAttempt) => {
				if (nextAttempt.role !== "builder" || nextAttempt.dispatch.phase !== "worktree-intended") throw new Error("Prepared Builder Attempt changed before worktree continuation.");
				nextAttempt.dispatch = { phase: "agent-intended", branch: dispatch.branch, agentName: dispatch.agentName, worktreePath: created.path, workspaceId: created.workspaceId, paneId: created.paneId, terminalId: created.terminalId };
			});
			return changed ? { kind: "changed", journal, note: `Prepared Builder Attempt ${attempt.id} now records the exact no-clobber worktree identity; no agent was started in this pass.`, action: "record-observation" } : { kind: "degraded", journal, note: "Prepared Builder worktree was verified, but its exact identity could not be persisted; no later effect was attempted." };
		}

		if ((attempt.role === "builder" && (dispatch.phase === "agent-intended" || dispatch.phase === "assignment-intended")) || (attempt.role === "reviewer" && dispatch.phase === "agent-intended")) {
			if (dispatch.phase === "assignment-intended" && attempt.role !== "builder") return { kind: "degraded", journal, note: "Only a prepared rework Builder may continue an Assignment-intended phase; the prepared Attempt remains unchanged." };
			const identity = "workspaceId" in dispatch && typeof dispatch.workspaceId === "string" && "paneId" in dispatch && typeof dispatch.paneId === "string" && "terminalId" in dispatch && typeof dispatch.terminalId === "string"
				? { name: dispatch.agentName, workspaceId: dispatch.workspaceId, paneId: dispatch.paneId, terminalId: dispatch.terminalId }
				: undefined;
			const inspectManagedAgent = optionalManagedAgentInspector(dependencies.herdr);
			if (!identity || !inspectManagedAgent) return { kind: "degraded", journal, note: "Prepared Agent-intended Attempt lacks an exact inspectable resource identity; it remains pending without adoption." };
			let inspected: ManagedAgentInspection;
			try { inspected = await inspectManagedAgent(identity); }
			catch (error: unknown) { return { kind: "degraded", journal, note: `Prepared Agent-intended identity inspection failed; no start or Assignment effect was attempted. ${error instanceof Error ? error.message : "Herdr inspection failed."}` }; }
				if (inspected.kind === "unclear") return { kind: "degraded", journal, note: `Prepared Agent-intended identity is unclear; the same Attempt remains pending. ${inspected.diagnostic}` };
				if (inspected.kind === "missing") {
					if (attempt.replacement) {
						const startPreservation = await refreshReplacementPreservation();
						if (startPreservation.kind === "blocked") return { kind: "degraded", journal: startPreservation.journal, note: startPreservation.note };
						journal = startPreservation.journal;
						task = startPreservation.task;
						attempt = startPreservation.attempt;
					}
					let started: HerdrAgentStartResult;
				try {
					started = dependencies.herdr.startReplacementAgent && attempt.replacement
						? await dependencies.herdr.startReplacementAgent({ repositoryRoot, name: identity.name, paneId: identity.paneId, model: attempt.actualModel })
						: attempt.role === "builder"
							? dependencies.herdr.startBuilder ? await dependencies.herdr.startBuilder({ repositoryRoot, name: identity.name, paneId: identity.paneId, model: attempt.actualModel }) : { kind: "failed", stage: "agent-start", code: "adapter-unavailable", message: "Builder start adapter is unavailable." } as HerdrAgentStartResult
							: dependencies.herdr.startReviewer ? await dependencies.herdr.startReviewer({ repositoryRoot, name: identity.name, paneId: identity.paneId, model: attempt.actualModel }) : { kind: "failed", stage: "agent-start", code: "adapter-unavailable", message: "Reviewer start adapter is unavailable." } as HerdrAgentStartResult;
				} catch (error: unknown) {
					const ambiguous = await markReplacementAmbiguous(error instanceof Error ? error.message : "Replacement agent start failed.");
					return { kind: "degraded", journal: ambiguous ?? journal, note: ambiguous ? "The replacement start effect is ambiguous; its durable tombstone forbids another start." : "The prepared replacement start failed; no later effect was attempted." };
				}
				if (started.kind === "name-collision") {
					const replacement = `${attempt.role === "builder" ? "steward-b" : "steward-r"}-${compactUuid(dependencies.clock)}-${attempt.id.replace(/[^0-9]/g, "") || "01"}-r`;
					if (!safeHerdrName(replacement)) return { kind: "degraded", journal, note: "The prepared Attempt's exact name collided, but a safe same-Attempt name could not be derived." };
					const changed = await persist((_nextTask, nextAttempt) => {
						if (nextAttempt.role !== attempt.role || nextAttempt.dispatch.phase !== dispatch.phase) throw new Error("Prepared Attempt changed during same-Attempt name collision handling.");
						nextAttempt.dispatch = { ...nextAttempt.dispatch, agentName: replacement } as AttemptRecord["dispatch"];
					});
					return changed ? { kind: "changed", journal, note: `The prepared ${attempt.role} name collided; a new Steward-owned name was retained inside Attempt ${attempt.id} and no other Attempt was created.`, action: "record-observation" } : { kind: "degraded", journal, note: "The prepared Attempt name collision could not be durably reconciled; no second Attempt was created." };
				}
				if (started.kind === "failed") {
					const transition = await recoverTypedHerdrFailure({ repositoryRoot, controllerSessionId, journal, taskIndex: index, task, attempt, dependencies, stage: started.stage, code: started.code, diagnostic: started.message, identity, requireExactMissing: true });
					if (transition) return { kind: transition.kind, journal: transition.journal, note: transition.note, ...(transition.action ? { action: transition.action } : {}) };
				}
				if (started.kind !== "started" || started.name !== identity.name || started.agentKind !== "pi" || started.workspaceId !== identity.workspaceId || started.paneId !== identity.paneId || started.terminalId !== identity.terminalId || !validIdentity(started.tabId)) {
					const ambiguous = await markReplacementAmbiguous(started.kind === "failed" ? started.message : "The replacement agent start acknowledgement was malformed or contradictory.");
					return { kind: "degraded", journal: ambiguous ?? journal, note: ambiguous ? "The replacement start acknowledgement is ambiguous; its durable tombstone forbids another start." : "The prepared Attempt start envelope was malformed or contradictory; no resource was adopted." };
				}
				return { kind: "changed", journal, note: `The exact recorded ${attempt.role} resource was missing during its prepared start phase; its same-Attempt start was attempted once and will be re-inspected before any later effect.`, action: "record-observation" };
			}
			if (inspected.kind !== "observed" || !exactIdentity(inspected.identity, identity)) return { kind: "degraded", journal, note: "The prepared Attempt resource did not match its exact recorded identity; no adoption or later effect was attempted." };

			let assignment: BuilderAssignmentDocument | ReviewerAssignmentDocument;
			try {
				if (attempt.role === "builder") {
					assignment = buildBuilderAssignment({ run: journal.run, task, attempt, worktreePath: dispatch.worktreePath, branch: dispatch.branch, workspaceId: identity.workspaceId, paneId: identity.paneId, terminalId: identity.terminalId, agentName: identity.name, ...(attempt.replacement ? { continuation: continuationForReplacement(task, attempt) } : {}) });
				} else {
					const attemptIndex = task.attempts.findIndex((candidateAttempt) => candidateAttempt.id === attempt.id);
					const predecessor = attemptIndex > 0 ? task.attempts[attemptIndex - 1] : undefined;
					let builder: AttemptRecord | undefined;
					for (let priorIndex = attemptIndex - 1; priorIndex >= 0; priorIndex -= 1) {
						if (task.attempts[priorIndex]?.role === "builder") {
							builder = task.attempts[priorIndex];
							break;
						}
					}
					if (attempt.replacement && (!predecessor || predecessor.role !== "reviewer")) return { kind: "degraded", journal, note: "Prepared Reviewer replacement is missing its immediately preceding superseded Reviewer; no prompt was attempted." };
					if (!builder || builder.role !== "builder" || builder.evidence?.phase !== "finalized") return { kind: "degraded", journal, note: "Prepared Reviewer Assignment cannot be rebuilt without the exact finalized Builder subject; no prompt was attempted." };
					assignment = buildReviewerAssignment({ runId: journal.run.id, task: task.contract, attempt, manifestPath: builder.evidence.manifestPath, manifestSha256: builder.evidence.manifestSha256, workspaceId: identity.workspaceId, paneId: identity.paneId, terminalId: identity.terminalId, agentName: identity.name, ...(attempt.replacement ? { continuation: continuationForReplacement(task, attempt) } : {}) });
				}
			} catch (error: unknown) { return { kind: "degraded", journal, note: `The prepared ${attempt.role} Assignment could not be rebuilt; no prompt was attempted. ${error instanceof Error ? error.message : "Assignment validation failed."}` }; }
				const continuation = assignment.assignment.continuation;
				if ((attempt.replacement && !continuationMatchesReplacement(task, attempt, continuation)) || (!attempt.replacement && continuation !== undefined)) return { kind: "degraded", journal, note: "The prepared Assignment continuation did not match the exact replacement predecessor and preservation facts; no prompt was attempted." };
				if (attempt.replacement) {
					const assignmentPreservation = await refreshReplacementPreservation();
					if (assignmentPreservation.kind === "blocked") return { kind: "degraded", journal: assignmentPreservation.journal, note: assignmentPreservation.note };
					journal = assignmentPreservation.journal;
					task = assignmentPreservation.task;
					attempt = assignmentPreservation.attempt;
				}
				let created: AssignmentCreateResult;
			try { created = await dependencies.runJournal.createAssignment(repositoryRoot, assignment); }
			catch (error: unknown) { return { kind: "degraded", journal, note: `The prepared ${attempt.role} Assignment could not be persisted; no prompt was attempted. ${error instanceof Error ? error.message : "Assignment storage failed."}` }; }
			if (created.kind !== "created" && created.kind !== "existing-match") return { kind: "degraded", journal, note: `The prepared ${attempt.role} Assignment conflicts with existing bytes; no prompt was attempted.` };
			const assignmentHash = attempt.role === "builder" ? builderAssignmentSha256(created.bytes) : reviewerAssignmentSha256(created.bytes);
			const changed = await persist((_nextTask, nextAttempt) => {
				if (nextAttempt.role !== attempt.role || nextAttempt.dispatch.phase !== dispatch.phase) throw new Error("Prepared Attempt changed before prompt intent.");
				nextAttempt.dispatch = { ...nextAttempt.dispatch, phase: "prompt-intended", assignmentSha256: assignmentHash } as AttemptRecord["dispatch"];
			});
			return changed ? { kind: "changed", journal, note: `The existing ${attempt.role} Assignment was reused for Attempt ${attempt.id}; prompt intent is durable and the original Assignment will not be resent.`, action: "record-observation" } : { kind: "degraded", journal, note: `The existing ${attempt.role} Assignment was verified, but prompt intent could not be persisted; no prompt was attempted.` };
		}

		return { kind: "degraded", journal, note: `Prepared Attempt ${attempt.id} is at ${dispatch.phase}; the phase is preserved and no duplicate effect was attempted.` };
	};

	const preparedContinuation = await continuePreparedDispatch();
	if (preparedContinuation) return preparedContinuation;

	const reportPath = attempt.reportPath;
	let reportState: "valid" | "invalid" | "missing" | "unclear" = "missing";
	if (attempt.role === "builder") {
		const candidate = activeBuilder(journal, minimumIndex);
		if (candidate && candidate.task.contract.id === task.contract.id && candidate.attempt.id === attempt.id && journal.run.controllerSessionId === controllerSessionId) {
			const evidence = await validateActiveBuilderEvidence(repositoryRoot, controllerSessionId, journal, dependencies, candidate);
			journal = evidence.journal;
			if (evidence.kind === "unaccepted") return { kind: "degraded", journal, note: evidence.note, diagnostic: evidence.note };
			if (evidence.kind === "finalized" || journal.run.tasks[index]?.attempts.find((item) => item.id === attempt.id)?.state === "reported") return { kind: "changed", journal, note: evidence.note || `Builder Attempt ${attempt.id} report was validated and finalized.`, action: "finalize-builder-evidence" };
			const observed = dependencies.runJournal.inspectAttemptReport ? await dependencies.runJournal.inspectAttemptReport(repositoryRoot, reportPath).catch(() => ({ kind: "unavailable", diagnostic: "Attempt Report observation failed." } as AttemptReportInspection)) : { kind: "missing" as const };
			reportState = observed.kind === "present" ? "invalid" : observed.kind === "unavailable" ? "unclear" : "missing";
		}
	} else {
		const reviewerIndex = task.attempts.findIndex((candidate) => candidate.id === attempt.id);
		const latestBuilder = reviewerIndex > 0 ? task.attempts[reviewerIndex - 1] : undefined;
		const reviewer = attempt.role === "reviewer" ? attempt : undefined;
		if (reviewer && latestBuilder?.role === "builder" && latestBuilder.state === "reported" && dependencies.runJournal.inspectAttemptReport) {
			const observed = await dependencies.runJournal.inspectAttemptReport(repositoryRoot, reportPath).catch(() => ({ kind: "unavailable", diagnostic: "Reviewer Attempt Report observation failed." } as AttemptReportInspection));
			reportState = observed.kind === "present" ? "invalid" : observed.kind === "unavailable" ? "unclear" : "missing";
			if (observed.kind === "present") {
				const review = await validateActiveReviewerReport(repositoryRoot, journal, { index, task, builder: latestBuilder }, reviewer, dependencies, false);
				journal = review.journal;
				if (journal.run.tasks[index]?.attempts.find((item) => item.id === attempt.id)?.state === "reported") return { kind: "changed", journal, note: review.note || `Reviewer Attempt ${attempt.id} report was validated and finalized.`, action: "finalize-reviewer-evidence" };
			}
		}
	}
	// Report rejection may have updated the bounded evidence fact; all later
	// reconciliation reads must use the same Attempt from the replacement.
		const refreshed = currentReconciliationAttempt(journal, index, attempt.id);
		if (!refreshed) return { kind: "degraded", journal, note: "The current Attempt disappeared during report reconciliation; no later effect was attempted." };
		attempt = refreshed;
		task = journal.run.tasks[index] ?? task;
		const retainedCorrectnessRejection = attempt.evidence?.phase === "rejected"
			|| (attempt.role === "reviewer" && attempt.integrity?.kind === "violated")
			|| (attempt.role === "reviewer" && attempt.reportRepair?.phase === "blocked");
		if (retainedCorrectnessRejection) reportState = "invalid";

	const dispatch = attempt.dispatch;
	const liveIdentity = recoveryIdentityFor(attempt);
	if (!liveIdentity) {
		if (dispatch.phase === "pane-intended" || dispatch.phase === "worktree-intended" || dispatch.phase === "agent-intended" || dispatch.phase === "assignment-intended") return { kind: "degraded", journal, note: "The current Attempt is prepared before an exact live identity; its phase is preserved for explicit continuation." };
		const persisted = await persist((nextTask, nextAttempt) => {
			const existing = nextAttempt.recovery;
			nextAttempt.recovery = { live: recoveryLiveRecord({ observedAt: transitionTimestamp(journal, dependencies.clock.now()), kind: "unclear", diagnostic: "The exact recorded Herdr identity could not be inspected." }), ...(existing?.reportRequest ? { reportRequest: existing.reportRequest } : {}), ...(existing?.blockedAnswer ? { blockedAnswer: existing.blockedAnswer } : {}), ...(existing?.preservation ? { preservation: existing.preservation } : {}) };
			nextTask.attention = "recovering";
			nextTask.attentionReason = "reconciliation-live-unclear";
			nextTask.attentionDiagnostic = "The exact recorded Herdr identity could not be inspected.";
		});
		return persisted ? { kind: "changed", journal, note: "Attempt live identity is unclear; state was preserved without an effect." } : { kind: "degraded", journal, note: "Attempt live identity is unclear, but the recovery observation could not be persisted." };
	}
	const inspectManagedAgent = optionalManagedAgentInspector(dependencies.herdr);
	if (!inspectManagedAgent) return { kind: journal.journalRevision === journalInput.journalRevision ? "none" : "changed", journal, note: "Herdr identity inspection is unavailable; the existing Attempt evidence remains authoritative without a recovery mutation." };

	let inspected: ManagedAgentInspection;
	try { inspected = await inspectManagedAgent(liveIdentity); } catch (error: unknown) { inspected = { kind: "unclear", diagnostic: error instanceof Error ? error.message : "Herdr inspection failed." }; }
	if (inspected.kind === "observed" && !exactIdentity(inspected.identity, liveIdentity)) inspected = { kind: "unclear", diagnostic: "Herdr returned a different name, workspace, pane, or terminal identity." };
	if (inspected.kind === "unclear" && inspected.availability === "unavailable") return { kind: "degraded", journal, note: "Herdr observation is temporarily unavailable; the exact Attempt and attention state remain unchanged.", diagnostic: inspected.diagnostic.slice(0, 2_000) };
	const observedAt = transitionTimestamp(journal, dependencies.clock.now());
	if (inspected.kind === "missing" && inspected.code === "agent_not_found" && reportState === "missing") {
		const fact = classifyInfrastructureFact({ stage: "agent-runtime", code: "agent_not_found", diagnostic: inspected.diagnostic, source: "exact-agent-missing" });
		if (fact) return applyTransientInfrastructureRecovery({ repositoryRoot, controllerSessionId, journal, taskIndex: index, task, attempt, fact, dependencies, alreadyMissing: true });
	}
	const liveKind = inspected.kind === "observed"
		? inspected.lifecycle === "working" || inspected.lifecycle === "blocked" ? inspected.lifecycle : inspected.lifecycle === "idle" || inspected.lifecycle === "done" ? "settled" : "unclear"
		: inspected.kind === "missing" ? "missing" : "unclear";
	const observedLifecycle = inspected.kind === "observed" && inspected.lifecycle !== "unavailable" ? inspected.lifecycle : undefined;
	const decision = decideReconciliation({ report: reportState, live: { kind: liveKind, ...(observedLifecycle ? { lifecycle: observedLifecycle } : {}) } });

	if (decision.kind === "working-or-blocked" && decision.lifecycle === "working") {
		const live = recoveryLiveRecord({ observedAt, kind: "working", lifecycle: "working", stateChangeSequence: inspected.kind === "observed" ? inspected.stateChangeSequence : null });
		const current = currentReconciliationAttempt(journal, index, attempt.id);
		const needsPromotion = current?.dispatch.phase === "prompt-intended" || current?.state === "prepared";
		const needsObservation = !sameRecoveryLive(current?.recovery?.live, live) || (task.attention === "recovering" && ["reconciliation-live-unclear", "reconciliation-agent-missing"].includes(task.attentionReason ?? ""));
		if (!needsPromotion && !needsObservation) return { kind: "none", journal, note: "The exact recorded agent is working; no effect was attempted." };
		const changed = await persist((nextTask, nextAttempt) => {
			promoteMatchingDispatch(nextTask, nextAttempt, observedAt, "matching-live-agent");
			const existing = nextAttempt.recovery;
			nextAttempt.recovery = { live, ...(existing?.reportRequest ? { reportRequest: existing.reportRequest } : {}), ...(existing?.blockedAnswer ? { blockedAnswer: existing.blockedAnswer } : {}), ...(existing?.preservation ? { preservation: existing.preservation } : {}) };
			if (nextTask.attention === "recovering" && ["reconciliation-live-unclear", "reconciliation-agent-missing"].includes(nextTask.attentionReason ?? "")) { nextTask.attention = "none"; delete nextTask.attentionReason; delete nextTask.attentionDiagnostic; }
		});
		return changed ? { kind: "changed", journal, note: "The exact recorded agent is working; reconciliation is waiting with no prompt or replacement effect." } : { kind: "none", journal, note: "The exact recorded agent is working; no effect was attempted." };
	}

	if (decision.kind === "working-or-blocked" && decision.lifecycle === "blocked") {
		const existingAnswer = attempt.recovery?.blockedAnswer;
		if (existingAnswer) {
			const live = recoveryLiveRecord({ observedAt, kind: "blocked", lifecycle: "blocked", stateChangeSequence: inspected.kind === "observed" ? inspected.stateChangeSequence : null });
			const needsPromotion = attempt.dispatch.phase === "prompt-intended" || attempt.state === "prepared";
			const needsBlock = existingAnswer.phase !== "acknowledged" && (task.attention !== "blocked" || task.attentionReason !== "reconciliation-blocked-question");
			if (!needsPromotion && !needsBlock && sameRecoveryLive(attempt.recovery?.live, live)) return { kind: "none", journal, note: "The exact agent is blocked; its existing Task-fact answer intent prevents a duplicate input." };
			const changed = await persist((nextTask, nextAttempt) => {
				promoteMatchingDispatch(nextTask, nextAttempt, observedAt, "matching-live-agent");
				if (existingAnswer.phase !== "acknowledged") {
					nextTask.attention = "blocked";
					nextTask.attentionReason = "reconciliation-blocked-question";
					nextTask.attentionDiagnostic = existingAnswer.phase === "ambiguous" ? existingAnswer.diagnostic : "A Task-fact answer already exists for this Attempt; no second answer will be sent.";
				}
				const blockedAnswer = existingAnswer.phase === "intended" ? { ...existingAnswer, phase: "ambiguous" as const, observedAt, diagnostic: "The prior Task-fact answer intent was interrupted; no second answer will be sent." } : existingAnswer;
				nextAttempt.recovery = { ...(nextAttempt.recovery ?? { live }), live, blockedAnswer };
			});
			return changed ? { kind: "blocked", journal, note: "The blocked Task-fact answer intent remains durable; no second answer was sent." } : { kind: "degraded", journal, note: "The blocked Task-fact answer state could not be persisted; no second answer was sent." };
		}
		const request = dependencies.herdr.readBlockedTaskFactRequest ? await dependencies.herdr.readBlockedTaskFactRequest(liveIdentity, attempt.role) : { kind: "unstructured", diagnostic: "No canonical Task-fact request adapter is available." } as const;
		if (request.kind !== "fact-request") {
			const changed = await persist((nextTask, nextAttempt) => { nextTask.attention = "blocked"; nextTask.attentionReason = "reconciliation-blocked-question"; nextTask.attentionDiagnostic = request.diagnostic.slice(0, 2_000); const existing = nextAttempt.recovery; nextAttempt.recovery = { live: recoveryLiveRecord({ observedAt, kind: "blocked", lifecycle: "blocked", stateChangeSequence: inspected.kind === "observed" ? inspected.stateChangeSequence : null }), ...(existing?.reportRequest ? { reportRequest: existing.reportRequest } : {}), ...(existing?.preservation ? { preservation: existing.preservation } : {}) }; });
			return changed ? { kind: "blocked", journal, note: "The blocked agent did not present one canonical approved Task-fact request; user attention is required." } : { kind: "degraded", journal, note: "The blocked-agent question could not be persisted." };
		}
		if (request.request.field === "reviewSubject" && attempt.role !== "reviewer") {
			const changed = await persist((nextTask, nextAttempt) => {
				nextTask.attention = "blocked";
				nextTask.attentionReason = "reconciliation-blocked-question";
				nextTask.attentionDiagnostic = "The blocked Builder requested a Reviewer-only Task fact; no input was sent.";
				const existing = nextAttempt.recovery;
				nextAttempt.recovery = { live: recoveryLiveRecord({ observedAt, kind: "blocked", lifecycle: "blocked", stateChangeSequence: inspected.kind === "observed" ? inspected.stateChangeSequence : null }), ...(existing?.reportRequest ? { reportRequest: existing.reportRequest } : {}), ...(existing?.preservation ? { preservation: existing.preservation } : {}) };
			});
			return changed ? { kind: "blocked", journal, note: "The blocked agent requested a Reviewer-only Task fact; no input was sent." } : { kind: "degraded", journal, note: "The blocked Reviewer-only Task-fact question could not be persisted." };
		}
		const verifiedFact = await verifiedTaskFactValue(repositoryRoot, journal.run.id, task, attempt, dependencies, request.request.field);
		if (verifiedFact.kind !== "verified") {
			const diagnostic = verifiedFact.diagnostic;
			const changed = await persist((nextTask, nextAttempt) => { nextTask.attention = "blocked"; nextTask.attentionReason = "reconciliation-blocked-question"; nextTask.attentionDiagnostic = diagnostic.slice(0, 2_000); const existing = nextAttempt.recovery; nextAttempt.recovery = { live: recoveryLiveRecord({ observedAt, kind: "blocked", lifecycle: "blocked", stateChangeSequence: inspected.kind === "observed" ? inspected.stateChangeSequence : null }), ...(existing?.reportRequest ? { reportRequest: existing.reportRequest } : {}), ...(existing?.preservation ? { preservation: existing.preservation } : {}) }; });
			return changed ? { kind: "blocked", journal, note: "The blocked Task-fact request was not answered because the protected Assignment was unavailable or changed." } : { kind: "degraded", journal, note: "The protected Assignment could not be verified before answering; no input was sent." };
		}
		const answer = resolveTaskFactAnswer(request.request.field, verifiedFact.value);
		if (answer.kind !== "answer") return { kind: "blocked", journal, note: "The blocked Task-fact request is not derivable from the current frozen contract; no input was sent." };
		const intended = await persist((nextTask, nextAttempt) => { promoteMatchingDispatch(nextTask, nextAttempt, observedAt, "matching-live-agent"); nextTask.attention = "none"; delete nextTask.attentionReason; delete nextTask.attentionDiagnostic; const existing = nextAttempt.recovery; nextAttempt.recovery = { live: recoveryLiveRecord({ observedAt, kind: "blocked", lifecycle: "blocked", stateChangeSequence: inspected.kind === "observed" ? inspected.stateChangeSequence : null }), ...(existing?.reportRequest ? { reportRequest: existing.reportRequest } : {}), blockedAnswer: { phase: "intended", intendedAt: observedAt, agent: liveIdentity, questionSha256: request.request.questionSha256, fact: request.request.field, answerSha256: answer.answer.answerSha256 }, ...(existing?.preservation ? { preservation: existing.preservation } : {}) }; });
		if (!intended) return { kind: "degraded", journal, note: "Task-fact answer intent could not be persisted; no input was sent." };
		let delivered: HerdrTaskFactAnswerResult;
		try {
			delivered = dependencies.herdr.answerBlockedTaskFact ? await dependencies.herdr.answerBlockedTaskFact({ repositoryRoot, identity: liveIdentity, answer: answer.answer.answer }) : { kind: "failed", message: "Task-fact answer adapter is unavailable." };
		} catch (error: unknown) {
			delivered = { kind: "ambiguous", message: error instanceof Error ? error.message : "Task-fact answer delivery failed." };
		}
		const acknowledged = delivered.kind === "acknowledged" && "identity" in delivered ? exactIdentity(delivered.identity, liveIdentity) : false;
		const recorded = await persist((nextTask, nextAttempt) => {
			const current = nextAttempt.recovery?.blockedAnswer;
			if (!current || current.phase !== "intended") throw new Error("Task-fact answer intent disappeared before acknowledgement.");
			nextAttempt.recovery = { ...(nextAttempt.recovery ?? { live: recoveryLiveRecord({ observedAt, kind: "blocked", lifecycle: "blocked" }) }), live: recoveryLiveRecord({ observedAt, kind: "blocked", lifecycle: "blocked" }), blockedAnswer: acknowledged ? { ...current, phase: "acknowledged", acknowledgedAt: transitionTimestamp(journal, dependencies.clock.now()) } : { ...current, phase: "ambiguous", observedAt: transitionTimestamp(journal, dependencies.clock.now()), diagnostic: delivered.kind === "failed" || delivered.kind === "ambiguous" ? delivered.message : "Wrong-identity Task-fact acknowledgement." } };
			if (!acknowledged) { nextTask.attention = "blocked"; nextTask.attentionReason = "reconciliation-blocked-question"; nextTask.attentionDiagnostic = "Task-fact input delivery could not be proven for the exact recorded agent."; }
		});
		return recorded ? { kind: acknowledged ? "changed" : "blocked", journal, note: acknowledged ? "One canonical approved Task fact was delivered to the exact blocked agent." : "Task-fact delivery is ambiguous; the durable intent prevents a resend." } : { kind: "degraded", journal, note: "Task-fact delivery occurred or was attempted, but its acknowledgement state could not be persisted; no resend will be attempted." };
	}

	if (decision.kind === "settled") {
		const existing = attempt.recovery?.reportRequest;
		if (existing) {
			if (existing.phase === "blocked" || existing.phase === "ambiguous" || existing.phase === "requested" || existing.phase === "intended") {
				const live = recoveryLiveRecord({ observedAt, kind: "settled", lifecycle: decision.lifecycle, stateChangeSequence: inspected.kind === "observed" ? inspected.stateChangeSequence : null });
				const alreadyBlocked = existing.phase === "blocked" && task.attention === "blocked" && task.attentionReason === "reconciliation-report-missing" && sameRecoveryLive(attempt.recovery?.live, live);
				if (alreadyBlocked) return { kind: "blocked", journal, note: "The exact settled agent has already received its one report request; no second request was sent." };
				const changed = await persist((nextTask, nextAttempt) => {
					promoteMatchingDispatch(nextTask, nextAttempt, observedAt, "matching-live-agent");
					nextTask.attention = "blocked";
					nextTask.attentionReason = "reconciliation-report-missing";
					nextTask.attentionDiagnostic = "The one allowed Attempt Report request has not produced a valid report; no request will be repeated.";
					nextAttempt.state = "awaiting-report";
					const requestedAt = existing.phase === "requested" || existing.phase === "blocked" ? existing.requestedAt : undefined;
					nextAttempt.recovery = { ...(nextAttempt.recovery ?? { live }), live, reportRequest: existing.phase === "blocked" ? existing : { phase: "blocked", intendedAt: existing.intendedAt, ...(requestedAt ? { requestedAt } : {}), blockedAt: transitionTimestamp(journal, dependencies.clock.now()), agent: existing.agent, reportPath: existing.reportPath, diagnostic: "The one allowed Attempt Report request did not produce a valid report; no request will be repeated." } };
				});
				return changed ? { kind: "blocked", journal, note: "The exact settled agent already has one report request; no second request was sent." } : { kind: "degraded", journal, note: "The exact settled agent has one report request, but its blocked state could not be persisted; no second request was sent." };
			}
		}
		const requestIntent = await persist((nextTask, nextAttempt) => { promoteMatchingDispatch(nextTask, nextAttempt, observedAt, "matching-live-agent"); nextTask.attention = "none"; delete nextTask.attentionReason; delete nextTask.attentionDiagnostic; nextAttempt.state = "awaiting-report"; const existing = nextAttempt.recovery; nextAttempt.recovery = { live: recoveryLiveRecord({ observedAt, kind: "settled", lifecycle: decision.lifecycle, stateChangeSequence: inspected.kind === "observed" ? inspected.stateChangeSequence : null }), ...(existing?.blockedAnswer ? { blockedAnswer: existing.blockedAnswer } : {}), ...(existing?.preservation ? { preservation: existing.preservation } : {}), reportRequest: { phase: "intended", intendedAt: observedAt, agent: liveIdentity, reportPath: attempt.reportPath } }; });
		if (!requestIntent) return { kind: "degraded", journal, note: "Attempt report-request intent could not be persisted; no prompt was sent." };
		let requested: HerdrPromptResult;
		try {
			requested = dependencies.herdr.requestAttemptReport ? await dependencies.herdr.requestAttemptReport({ repositoryRoot, identity: liveIdentity, role: attempt.role, reportPath: attempt.reportPath, assignmentPath: attempt.assignmentPath, evidenceDirectory: attempt.evidenceDirectory }) : { kind: "failed", stage: "agent-prompt", code: "adapter-unavailable", message: "Attempt report-request adapter is unavailable." };
		} catch (error: unknown) {
			requested = { kind: "failed", stage: "agent-prompt", code: "runner-error", message: error instanceof Error ? error.message : "Attempt report request failed." };
		}
		const exact = requested.kind === "prompted" && requested.name === liveIdentity.name && requested.workspaceId === liveIdentity.workspaceId && requested.paneId === liveIdentity.paneId && requested.terminalId === liveIdentity.terminalId;
		const recorded = await persist((nextTask, nextAttempt) => {
			const current = nextAttempt.recovery?.reportRequest;
			if (!current || current.phase !== "intended") throw new Error("Attempt report-request intent disappeared before acknowledgement.");
			nextAttempt.recovery = { live: recoveryLiveRecord({ observedAt, kind: "settled", lifecycle: decision.lifecycle }), ...(nextAttempt.recovery?.blockedAnswer ? { blockedAnswer: nextAttempt.recovery.blockedAnswer } : {}), ...(nextAttempt.recovery?.preservation ? { preservation: nextAttempt.recovery.preservation } : {}), reportRequest: exact ? { ...current, phase: "requested", requestedAt: transitionTimestamp(journal, dependencies.clock.now()) } : { ...current, phase: "ambiguous", observedAt: transitionTimestamp(journal, dependencies.clock.now()), diagnostic: requested.kind === "failed" ? requested.message : "Wrong-identity or malformed report-request acknowledgement." } };
			if (!exact) { nextTask.attention = "blocked"; nextTask.attentionReason = "reconciliation-report-missing"; nextTask.attentionDiagnostic = "Attempt report-request delivery was not proven; no request will be repeated."; }
		});
		return recorded ? { kind: exact ? "changed" : "blocked", journal, note: exact ? "One same-identity Attempt Report request was delivered; awaiting the report." : "Attempt Report request delivery is ambiguous; no request will be repeated." } : { kind: "degraded", journal, note: "Attempt Report request was attempted, but acknowledgement state could not be persisted; no resend will be attempted." };
	}

	if (decision.kind === "unclear") {
		const diagnostic = inspected.kind === "unclear" ? inspected.diagnostic : "Herdr live state was not safely classifiable.";
		const live = recoveryLiveRecord({ observedAt, kind: "unclear", diagnostic });
		if (task.attention === "recovering" && task.attentionReason === "reconciliation-live-unclear" && task.attentionDiagnostic === diagnostic.slice(0, 2_000) && sameRecoveryLive(attempt.recovery?.live, live)) return { kind: "none", journal, note: "Herdr live state remains unclear; the Attempt and worktree remain preserved without an effect." };
		const changed = await persist((nextTask, nextAttempt) => { nextTask.attention = "recovering"; nextTask.attentionReason = "reconciliation-live-unclear"; nextTask.attentionDiagnostic = diagnostic.slice(0, 2_000); const existing = nextAttempt.recovery; nextAttempt.recovery = { live, ...(existing?.reportRequest ? { reportRequest: existing.reportRequest } : {}), ...(existing?.blockedAnswer ? { blockedAnswer: existing.blockedAnswer } : {}), ...(existing?.preservation ? { preservation: existing.preservation } : {}) }; });
		return changed ? { kind: "changed", journal, note: "Herdr live state is unclear; the Attempt and worktree were preserved without an effect." } : { kind: "degraded", journal, note: "Herdr live state is unclear, but the bounded recovery observation could not be persisted." };
	}

	if (decision.kind === "missing") {
		if (!dependencies.runJournal.inspectAttemptPreservation) return { kind: "degraded", journal, note: "The exact missing agent was observed, but preservation inspection is unavailable; no missing transition was recorded." };
		const preservationBranch = branchForAttempt(task, attempt);
		if (!hasAssignmentIdentity(attempt) || !preservationBranch) return { kind: "degraded", journal, note: "The exact missing agent was observed, but its deterministic worktree identity could not be established; no missing transition was recorded." };
		const preserved = await dependencies.runJournal.inspectAttemptPreservation({ repositoryRoot, attempt });
		if (preserved.kind !== "inspected") return { kind: "degraded", journal, note: `The exact missing agent was observed, but preservation failed: ${preserved.diagnostic}` };
		const progress = dependencies.git.inspectManagedWorktreeProgress && hasAssignmentIdentity(attempt) ? await dependencies.git.inspectManagedWorktreeProgress(attempt.dispatch.worktreePath).catch(() => ({ kind: "unavailable", diagnostic: "Git preservation inspection failed." } as ManagedWorktreeProgress)) : { kind: "unavailable", diagnostic: "Git preservation inspection is unavailable." } as ManagedWorktreeProgress;
		const preservation: import("./run.ts").RecoveryPreservation = {
			observedAt,
			worktreePath: attempt.dispatch.worktreePath,
			branch: preservationBranch,
			head: progress.kind === "observed" ? progress.head : null,
			worktree: progress.kind === "observed" ? progress.worktree : { kind: "unavailable", diagnostic: progress.diagnostic },
			git: progress.kind === "observed" ? { head: progress.git.head, digest: progress.git.digest.kind === "observed" ? progress.git.digest.sha256 : null, ...(progress.git.digest.kind === "unavailable" ? { diagnostic: progress.git.digest.diagnostic } : {}) } : { head: null, digest: null, diagnostic: progress.diagnostic },
			assignment: preserved.assignment,
			report: preserved.report,
			evidence: preserved.evidence,
		};
		const missingLive = recoveryLiveRecord({ observedAt, kind: "missing", diagnostic: inspected.kind === "missing" ? inspected.diagnostic : undefined });
		const priorPreservation = attempt.recovery?.preservation;
		const samePreservation = priorPreservation && JSON.stringify({ ...priorPreservation, observedAt: "" }) === JSON.stringify({ ...preservation, observedAt: "" });
		if (task.attention === "recovering" && task.attentionReason === "reconciliation-agent-missing" && samePreservation) return { kind: "none", journal, note: "The exact recorded agent remains missing; the preserved Attempt state remains authoritative and no effect was attempted." };
		const changed = await persist((nextTask, nextAttempt) => { nextTask.attention = "recovering"; nextTask.attentionReason = "reconciliation-agent-missing"; nextTask.attentionDiagnostic = "The exact recorded agent is missing; worktree, Assignment, report, and evidence were preserved before any future replacement decision."; const existing = nextAttempt.recovery; nextAttempt.recovery = { live: missingLive, ...(existing?.reportRequest ? { reportRequest: existing.reportRequest } : {}), ...(existing?.blockedAnswer ? { blockedAnswer: existing.blockedAnswer } : {}), preservation }; });
		return changed ? { kind: "changed", journal, note: "The exact recorded agent is missing; worktree, Assignment, report, and evidence were preserved before the recovering stop." } : { kind: "degraded", journal, note: "The exact recorded agent is missing, but the preservation transition could not be persisted." };
	}

	return { kind: "none", journal, note: "No reconciliation effect was selected." };
}

async function reconcileCurrentAttempt(repositoryRoot: string, controllerSessionId: string, journalInput: RunJournal, dependencies: StewardDependencies): Promise<ReconciliationWorkflowResult> {
	let journal = journalInput;
	let minimumIndex = 0;
	let note = "No current non-finalized Attempt requires reconciliation.";
	while (true) {
		const candidate = reconciliationCandidate(journal, minimumIndex);
		if (!candidate) return { kind: "none", journal, note };
		const result = await reconcileOneCurrentAttempt(repositoryRoot, controllerSessionId, journal, dependencies, minimumIndex);
		if (result.kind !== "none") return result;
		journal = result.journal;
		note = result.note;
		minimumIndex = candidate.index + 1;
	}
}

type SilenceInspectionResult =
	| { kind: "complete"; snapshot: SilenceInspectionSnapshot }
	| { kind: "incomplete"; snapshot?: SilenceInspectionSnapshot; diagnostic: string };

function silenceHash(value: string): string {
	return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function silencePrompt(kind: "nudge" | "resume", attempt: AttemptRecord): string {
	return kind === "nudge"
		? `STEWARD_SILENCE_NUDGE ${attempt.id}: continue the existing Assignment and write the Attempt Report; do not restart, change scope, or dispatch another agent.`
		: `STEWARD_SILENCE_RESUME ${attempt.id}: resume the existing Assignment from the preserved worktree and continue the same Attempt; do not restart, change scope, or dispatch another agent.`;
}

function silenceSourceFacts(snapshot: SilenceInspectionSnapshot): string {
	return JSON.stringify({ lifecycle: snapshot.lifecycle, stateChangeSequence: snapshot.stateChangeSequence, terminal: snapshot.terminal, worktree: snapshot.worktree, git: snapshot.git, assignment: snapshot.assignment, report: snapshot.report, evidence: snapshot.evidence });
}

function silenceSnapshotsChanged(previous: SilenceInspectionSnapshot | undefined, next: SilenceInspectionSnapshot): boolean {
	return previous === undefined || silenceSourceFacts(previous) !== silenceSourceFacts(next);
}

function silenceProcessChanged(left: SilenceProcessObservation | undefined, right: SilenceProcessObservation): boolean {
	if (!left || left.kind !== right.kind) return true;
	if (left.kind === "live-external" && right.kind === "live-external") return left.digest !== right.digest || left.paneId !== right.paneId || left.foregroundProcessGroupId !== right.foregroundProcessGroupId;
	if (left.kind === "none" && right.kind === "none") return left.digest !== right.digest || left.paneId !== right.paneId;
	return left.kind !== right.kind;
}

type CancellationAttemptPlan = {
	taskId: string;
	attemptId: string;
	role: "builder" | "reviewer";
	identity?: ManagedAgentIdentity;
	duplicateIdentity?: boolean;
	ownershipGap?: "worktree-intended" | "pane-intended" | "replacement-pane-intended";
};

type CancellationOwnership = {
	priorTasks: import("./run.ts").CancellationPriorTask[];
	panes: StewardOwnedPane[];
	worktrees: StewardOwnedWorktree[];
	attempts: CancellationAttemptPlan[];
};

function dispatchIdentityFor(attempt: AttemptRecord): ManagedAgentIdentity | undefined {
	const dispatch = attempt.dispatch as unknown as Record<string, unknown>;
	if (!["agentName", "workspaceId", "paneId", "terminalId"].every((key) => typeof dispatch[key] === "string" && (dispatch[key] as string).trim().length > 0)) return undefined;
	return { name: dispatch.agentName as string, workspaceId: dispatch.workspaceId as string, paneId: dispatch.paneId as string, terminalId: dispatch.terminalId as string };
}

function dispatchPathFacts(attempt: AttemptRecord): { branch?: string; worktreePath?: string } {
	const dispatch = attempt.dispatch as unknown as Record<string, unknown>;
	return {
		...(typeof dispatch.branch === "string" ? { branch: dispatch.branch } : {}),
		...(typeof dispatch.worktreePath === "string" ? { worktreePath: dispatch.worktreePath } : {}),
	};
}

function cancellationOwnershipFor(journal: RunJournal): CancellationOwnership {
	const panes: StewardOwnedPane[] = [];
	const worktrees: StewardOwnedWorktree[] = [];
	const paneById = new Map<string, StewardOwnedPane>();
	const worktreeByPath = new Map<string, StewardOwnedWorktree>();
	const worktreeByBranch = new Map<string, StewardOwnedWorktree>();
	const worktreeByRootPane = new Map<string, StewardOwnedWorktree>();
	const agentKeys = new Set<string>();
	const attempts: CancellationAttemptPlan[] = [];
	const priorTasks: import("./run.ts").CancellationPriorTask[] = [];
	for (const task of journal.run.tasks) {
		const changing = task.attempts.filter((attempt) => ["prepared", "active", "awaiting-report"].includes(attempt.state));
		if (task.phase !== "completed") priorTasks.push({ taskId: task.contract.id, phase: task.phase as Exclude<import("./run.ts").TaskPhase, "cancelled" | "completed">, attention: task.attention, attempts: changing.map((attempt) => ({ attemptId: attempt.id, state: attempt.state as "prepared" | "active" | "awaiting-report" })) });
		for (const attempt of task.attempts) {
			const identity = dispatchIdentityFor(attempt);
			const pathFacts = dispatchPathFacts(attempt);
			if (identity) {
				const paneKey = `${identity.workspaceId}/${identity.paneId}`;
				const kind: StewardOwnedPane["kind"] = attempt.role === "builder" ? "builder-root" : attempt.replacement ? "recovery" : "reviewer";
				const pane: StewardOwnedPane = { runId: journal.run.id, taskId: task.contract.id, attemptId: attempt.id, role: attempt.role, kind, workspaceId: identity.workspaceId, paneId: identity.paneId, terminalId: identity.terminalId };
				const priorPane = paneById.get(paneKey);
				if (priorPane && (priorPane.terminalId !== pane.terminalId || priorPane.role !== pane.role || priorPane.kind !== pane.kind)) throw new Error(`Conflicting recorded pane identity for ${paneKey}.`);
				if (!priorPane) { paneById.set(paneKey, pane); panes.push(pane); }
			}
			if (attempt.role === "reviewer" && "workspaceId" in attempt.dispatch && "paneId" in attempt.dispatch && "terminalId" in attempt.dispatch && typeof attempt.dispatch.workspaceId === "string" && typeof attempt.dispatch.paneId === "string" && typeof attempt.dispatch.terminalId === "string") {
				const paneKey = `${attempt.dispatch.workspaceId}/${attempt.dispatch.paneId}`;
				const pane: StewardOwnedPane = { runId: journal.run.id, taskId: task.contract.id, attemptId: attempt.id, role: "reviewer", kind: attempt.replacement ? "recovery" : "reviewer", workspaceId: attempt.dispatch.workspaceId, paneId: attempt.dispatch.paneId, terminalId: attempt.dispatch.terminalId };
				const priorPane = paneById.get(paneKey);
				if (priorPane && (priorPane.terminalId !== pane.terminalId || priorPane.role !== pane.role || priorPane.kind !== pane.kind)) throw new Error(`Conflicting recorded pane identity for ${paneKey}.`);
				if (!priorPane) { paneById.set(paneKey, pane); panes.push(pane); }
			}
			if (attempt.role === "builder" && identity && pathFacts.branch && pathFacts.worktreePath) {
				const worktreeKey = pathFacts.worktreePath;
				const worktree: StewardOwnedWorktree = { runId: journal.run.id, taskId: task.contract.id, attemptId: attempt.id, workspaceId: identity.workspaceId, paneId: identity.paneId, terminalId: identity.terminalId, branch: pathFacts.branch, path: pathFacts.worktreePath };
				const priorByPath = worktreeByPath.get(worktree.path);
				const priorByBranch = worktreeByBranch.get(worktree.branch);
				const priorByRootPane = worktreeByRootPane.get(`${worktree.workspaceId}/${worktree.paneId}`);
				const priorFacts = [...new Set([priorByPath, priorByBranch, priorByRootPane].filter((candidate): candidate is StewardOwnedWorktree => candidate !== undefined))];
				if (priorFacts.some((priorWorktree) => priorWorktree.workspaceId !== worktree.workspaceId || priorWorktree.path !== worktree.path || priorWorktree.branch !== worktree.branch || priorWorktree.paneId !== worktree.paneId || priorWorktree.terminalId !== worktree.terminalId)) throw new Error(`Conflicting recorded Builder worktree identity for ${worktreeKey}.`);
				if (priorFacts.length === 0) { worktreeByPath.set(worktree.path, worktree); worktreeByBranch.set(worktree.branch, worktree); worktreeByRootPane.set(`${worktree.workspaceId}/${worktree.paneId}`, worktree); worktrees.push(worktree); }
			}
		}
		for (const attempt of changing) {
			const identity = dispatchIdentityFor(attempt);
			if (!identity) {
				const dispatchPhase = (attempt.dispatch as { phase?: unknown }).phase;
				const ownershipGap = dispatchPhase === "worktree-intended" || dispatchPhase === "pane-intended" || dispatchPhase === "replacement-pane-intended" ? dispatchPhase : undefined;
				attempts.push({ taskId: task.contract.id, attemptId: attempt.id, role: attempt.role, ...(ownershipGap ? { ownershipGap } : {}) });
				continue;
			}
			const key = `${attempt.role}/${identity.name}/${identity.workspaceId}/${identity.paneId}/${identity.terminalId}`;
			const duplicateIdentity = agentKeys.has(key);
			agentKeys.add(key);
			attempts.push({ taskId: task.contract.id, attemptId: attempt.id, role: attempt.role, identity, ...(duplicateIdentity ? { duplicateIdentity: true } : {}) });
		}
	}
	panes.sort((left, right) => `${left.workspaceId}/${left.paneId}/${left.terminalId}/${left.taskId}/${left.attemptId}`.localeCompare(`${right.workspaceId}/${right.paneId}/${right.terminalId}/${right.taskId}/${right.attemptId}`));
	worktrees.sort((left, right) => `${left.workspaceId}/${left.path}/${left.branch}/${left.taskId}/${left.attemptId}`.localeCompare(`${right.workspaceId}/${right.path}/${right.branch}/${right.taskId}/${right.attemptId}`));
	return { priorTasks, panes, worktrees, attempts };
}

async function collectCancellationReports(repositoryRoot: string, journal: RunJournal, dependencies: StewardDependencies): Promise<import("./completion-store.ts").CompletionReportSource[] | { message: string }> {
	if (!dependencies.runJournal.inspectAttemptReport) return { message: "Attempt Report inspection is unavailable; cancelled archive publication was not attempted." };
	const reports: import("./completion-store.ts").CompletionReportSource[] = [];
	for (const task of journal.run.tasks) for (const attempt of task.attempts) {
		let inspection: AttemptReportInspection;
		try { inspection = await dependencies.runJournal.inspectAttemptReport(repositoryRoot, attempt.reportPath); }
		catch (error: unknown) { return { message: `Attempt Report inspection failed; cancelled archive publication was not attempted. ${error instanceof Error ? error.message : "Read-only inspection failed."}` }; }
		if (inspection.kind === "unavailable") return { message: `Attempt Report inspection was unavailable; cancelled archive publication was not attempted. ${inspection.diagnostic}` };
		if (inspection.kind === "present") reports.push({ taskId: task.contract.id, attemptId: attempt.id, role: attempt.role, sourcePath: attempt.reportPath, destinationPath: `reports/${task.contract.id}/${attempt.id}-${attempt.role}.md`, size: inspection.size, sha256: inspection.sha256 });
	}
	return reports;
}

type CleanupInventory = {
	archives: Array<{ runId: string; archiveDirectory: string; runSha256: string; manifestSha256: string }>;
	panes: StewardOwnedPane[];
	worktrees: StewardOwnedWorktree[];
};

function cleanupInventoryForArchives(archives: readonly import("./completion-store.ts").TerminalArchiveSnapshot[]): CleanupInventory {
	const panes = new Map<string, StewardOwnedPane>();
	const worktrees = new Map<string, StewardOwnedWorktree>();
	const worktreesByBranch = new Map<string, StewardOwnedWorktree>();
	const worktreesByRootPane = new Map<string, StewardOwnedWorktree>();
	const addPane = (pane: StewardOwnedPane): void => {
		const key = `${pane.workspaceId}/${pane.paneId}`;
		const prior = panes.get(key);
		if (prior && (prior.terminalId !== pane.terminalId || prior.role !== pane.role || prior.kind !== pane.kind)) throw new Error(`Conflicting archived pane ownership for ${key}.`);
		if (!prior) panes.set(key, pane);
	};
	const addWorktree = (worktree: StewardOwnedWorktree): void => {
		const priorByPath = worktrees.get(worktree.path);
		const priorByBranch = worktreesByBranch.get(worktree.branch);
		const priorByRootPane = worktreesByRootPane.get(`${worktree.workspaceId}/${worktree.paneId}`);
		const priorFacts = [...new Set([priorByPath, priorByBranch, priorByRootPane].filter((candidate): candidate is StewardOwnedWorktree => candidate !== undefined))];
		if (priorFacts.some((prior) => prior.workspaceId !== worktree.workspaceId || prior.path !== worktree.path || prior.branch !== worktree.branch || prior.paneId !== worktree.paneId || prior.terminalId !== worktree.terminalId)) throw new Error(`Conflicting archived worktree ownership for ${worktree.path}.`);
		if (priorFacts.length === 0) { worktrees.set(worktree.path, worktree); worktreesByBranch.set(worktree.branch, worktree); worktreesByRootPane.set(`${worktree.workspaceId}/${worktree.paneId}`, worktree); }
	};
	for (const archive of archives) {
		if (archive.kind === "cancelled") {
			const cancellation = archive.run.run.cancellation;
			if (!cancellation || cancellation.phase !== "archived") throw new Error(`Cancelled archive ${archive.run.run.id} has no archived cancellation facts.`);
			for (const pane of cancellation.panes) addPane({ ...pane });
			for (const worktree of cancellation.worktrees) addWorktree({ ...worktree });
			continue;
		}
		const completion = archive.run.run.completion;
		if (!completion || completion.phase !== "archived") throw new Error(`Completed archive ${archive.run.run.id} has no archived completion facts.`);
		for (const resource of completion.resources) {
			const attempt = archive.run.run.tasks.flatMap((task) => task.attempts.map((candidate) => ({ task, candidate }))).find(({ candidate }) => candidate.role === resource.role && dispatchIdentityFor(candidate)?.name === resource.agentName && dispatchIdentityFor(candidate)?.workspaceId === resource.workspaceId && dispatchIdentityFor(candidate)?.paneId === resource.paneId && dispatchIdentityFor(candidate)?.terminalId === resource.terminalId);
			if (!attempt) throw new Error(`Completed archive ${archive.run.run.id} has a resource without matching persisted Attempt dispatch.`);
			addPane({ runId: archive.run.run.id, taskId: attempt.task.contract.id, attemptId: attempt.candidate.id, role: resource.role, kind: resource.role === "builder" ? "builder-root" : attempt.candidate.replacement ? "recovery" : "reviewer", workspaceId: resource.workspaceId, paneId: resource.paneId, terminalId: resource.terminalId });
		}
		for (const task of archive.run.run.tasks) for (const attempt of task.attempts) {
			if (attempt.role !== "builder") continue;
			const identity = dispatchIdentityFor(attempt);
			const pathFacts = dispatchPathFacts(attempt);
			if (!identity || !pathFacts.branch || !pathFacts.worktreePath) continue;
			addWorktree({ runId: archive.run.run.id, taskId: task.contract.id, attemptId: attempt.id, workspaceId: identity.workspaceId, paneId: identity.paneId, terminalId: identity.terminalId, branch: pathFacts.branch, path: pathFacts.worktreePath });
		}
	}
	return {
		archives: archives.map((archive) => ({ runId: archive.run.run.id, archiveDirectory: archive.archiveDirectory, runSha256: archive.runSha256, manifestSha256: archive.manifestSha256 })).sort((left, right) => left.runId.localeCompare(right.runId)),
		panes: [...panes.values()].sort((left, right) => `${left.workspaceId}/${left.paneId}/${left.terminalId}`.localeCompare(`${right.workspaceId}/${right.paneId}/${right.terminalId}`)),
		worktrees: [...worktrees.values()].sort((left, right) => `${left.workspaceId}/${left.path}/${left.branch}`.localeCompare(`${right.workspaceId}/${right.path}/${right.branch}`)),
	};
}

async function inspectSilenceAttempt(repositoryRoot: string, task: TaskRecord, attempt: AttemptRecord, identity: ManagedAgentIdentity, dependencies: StewardDependencies): Promise<SilenceInspectionResult> {
	const inspectedAgent = dependencies.herdr.inspectManagedAgent ? await dependencies.herdr.inspectManagedAgent(identity).catch((error: unknown) => ({ kind: "unclear", diagnostic: error instanceof Error ? error.message : "Herdr inspection failed." } as ManagedAgentInspection)) : { kind: "unclear", diagnostic: "Herdr inspection adapter is unavailable." } as ManagedAgentInspection;
	const lifecycle = inspectedAgent.kind === "observed" && exactIdentity(inspectedAgent.identity, identity) ? inspectedAgent.lifecycle : "unavailable";
	const stateChangeSequence = inspectedAgent.kind === "observed" && exactIdentity(inspectedAgent.identity, identity) ? inspectedAgent.stateChangeSequence : null;
	const diagnostics: string[] = [];
	if (inspectedAgent.kind !== "observed" || !exactIdentity(inspectedAgent.identity, identity)) diagnostics.push(inspectedAgent.kind === "observed" ? "Herdr returned a different identity." : inspectedAgent.diagnostic);
	let terminal: MonitorDigest = { kind: "unavailable", diagnostic: "Herdr terminal observation is unavailable." };
	if (dependencies.herdr.readManagedTerminal) terminal = await dependencies.herdr.readManagedTerminal(identity).catch((error: unknown) => ({ kind: "unavailable", diagnostic: error instanceof Error ? error.message : "Herdr terminal inspection failed." }));
	else diagnostics.push("Herdr terminal inspection adapter is unavailable.");
	let worktree: MonitorDigest = { kind: "unavailable", diagnostic: "Managed worktree inspection is unavailable." };
	let git: { head: string | null; digest: string | null; diagnostic?: string } = { head: null, digest: null, diagnostic: "Managed Git inspection is unavailable." };
	const worktreePath = "worktreePath" in attempt.dispatch ? attempt.dispatch.worktreePath : attempt.role === "reviewer" ? attempt.worktree.path : "";
	if (dependencies.git.inspectManagedWorktreeProgress && worktreePath.length > 0) {
		const progress = await dependencies.git.inspectManagedWorktreeProgress(worktreePath).catch((error: unknown) => ({ kind: "unavailable", diagnostic: error instanceof Error ? error.message : "Managed worktree inspection failed." } as ManagedWorktreeProgress));
		if (progress.kind === "observed") { worktree = progress.worktree; git = { head: progress.git.head, digest: progress.git.digest.kind === "observed" ? progress.git.digest.sha256 : null, ...(progress.git.digest.kind === "unavailable" ? { diagnostic: progress.git.digest.diagnostic } : {}) }; }
		else { worktree = { kind: "unavailable", diagnostic: progress.diagnostic }; git = { head: null, digest: null, diagnostic: progress.diagnostic }; }
	} else diagnostics.push("Managed worktree inspection adapter is unavailable.");
	const preserved = dependencies.runJournal.inspectAttemptPreservation ? await dependencies.runJournal.inspectAttemptPreservation({ repositoryRoot, attempt }).catch((error: unknown) => ({ kind: "unavailable", diagnostic: error instanceof Error ? error.message : "Attempt preservation inspection failed." } as import("./run-journal-store.ts").AttemptPreservationInspection)) : { kind: "unavailable", diagnostic: "Attempt preservation inspection adapter is unavailable." } as import("./run-journal-store.ts").AttemptPreservationInspection;
	if (preserved.kind !== "inspected") diagnostics.push(preserved.diagnostic);
	const process = dependencies.process.inspectAttemptProcesses ? await dependencies.process.inspectAttemptProcesses({ repositoryRoot, identity }).catch((error: unknown) => ({ kind: "unavailable", diagnostic: error instanceof Error ? error.message : "Process inspection failed." } as SilenceProcessObservation)) : { kind: "unavailable", diagnostic: "Process inspection adapter is unavailable." } as SilenceProcessObservation;
	if (process.kind === "unavailable") diagnostics.push(process.diagnostic);
	if (preserved.kind !== "inspected" || "kind" in preserved.assignment) return { kind: "incomplete", diagnostic: diagnostics.join(" ").slice(0, 2_000) || "Assignment preservation is not yet complete." };
	const snapshot: SilenceInspectionSnapshot = { attemptId: attempt.id, role: attempt.role, agent: { ...identity }, lifecycle, stateChangeSequence, terminal, worktree, git, assignment: preserved.assignment, report: preserved.report, evidence: preserved.evidence, process };
	if (diagnostics.length > 0 || terminal.kind === "unavailable" || worktree.kind === "unavailable" || git.diagnostic) return { kind: "incomplete", snapshot, diagnostic: diagnostics.join(" ").slice(0, 2_000) || "One or more passive inspection sources were unavailable." };
	return { kind: "complete", snapshot };
}

/** Assemble the plain-function orchestration seam without adding lifecycle machinery. */
export function createSteward({ runJournal, herdr, git, process, model, clock, ui }: StewardDependencies): Steward {
	function controllerIdentityMatches(journal: RunJournal, currentSessionId: string): boolean {
		return journal.run.controllerSessionId === currentSessionId && (!journal.run.controllerLease || journal.run.controllerLease.sessionId === currentSessionId);
	}

	async function inspectTakeoverFacts(repositoryRoot: string, journal: RunJournal): Promise<unknown[]> {
		const facts: unknown[] = [];
		for (const task of journal.run.tasks) {
			const attempt = currentAttempt(task);
			if (!attempt || !["building", "reviewing", "reworking"].includes(task.phase)) {
				facts.push({ taskId: task.contract.id, phase: task.phase, attention: task.attention });
				continue;
			}
			const identity = "workspaceId" in attempt.dispatch && typeof attempt.dispatch.workspaceId === "string" && "paneId" in attempt.dispatch && typeof attempt.dispatch.paneId === "string" && "terminalId" in attempt.dispatch && typeof attempt.dispatch.terminalId === "string" && "agentName" in attempt.dispatch && typeof attempt.dispatch.agentName === "string"
				? { name: attempt.dispatch.agentName, workspaceId: attempt.dispatch.workspaceId, paneId: attempt.dispatch.paneId, terminalId: attempt.dispatch.terminalId }
				: undefined;
			const report = runJournal.inspectAttemptReport ? await runJournal.inspectAttemptReport(repositoryRoot, attempt.reportPath).catch((error: unknown) => ({ kind: "unavailable", diagnostic: error instanceof Error ? error.message.slice(0, 500) : "Attempt Report inspection failed." })) : { kind: "unavailable", diagnostic: "Attempt Report inspection is unavailable." };
			const live = identity && herdr.inspectManagedAgent ? await herdr.inspectManagedAgent(identity).catch((error: unknown) => ({ kind: "unclear", diagnostic: error instanceof Error ? error.message.slice(0, 500) : "Herdr inspection failed." } as ManagedAgentInspection)) : { kind: "unclear", diagnostic: "Exact Herdr identity is unavailable." } as ManagedAgentInspection;
			const worktreePath = "worktreePath" in attempt.dispatch ? attempt.dispatch.worktreePath : attempt.role === "reviewer" ? attempt.worktree.path : "";
			const worktree = worktreePath && git.inspectManagedWorktreeProgress ? await git.inspectManagedWorktreeProgress(worktreePath).catch((error: unknown) => ({ kind: "unavailable", diagnostic: error instanceof Error ? error.message.slice(0, 500) : "Managed worktree inspection failed." } as ManagedWorktreeProgress)) : { kind: "unavailable", diagnostic: "Managed worktree inspection is unavailable." } as ManagedWorktreeProgress;
			const assignment = runJournal.inspectAttemptAssignment ? await runJournal.inspectAttemptAssignment({ repositoryRoot, attempt }).catch((error: unknown) => ({ kind: "unavailable", diagnostic: error instanceof Error ? error.message.slice(0, 500) : "Assignment inspection failed." })) : { kind: "unavailable", diagnostic: "Assignment inspection is unavailable." };
			const preservation = runJournal.inspectAttemptPreservation ? await runJournal.inspectAttemptPreservation({ repositoryRoot, attempt }).catch((error: unknown) => ({ kind: "unavailable", diagnostic: error instanceof Error ? error.message.slice(0, 500) : "Evidence inspection failed." })) : { kind: "unavailable", diagnostic: "Evidence inspection is unavailable." };
			facts.push({ taskId: task.contract.id, attemptId: attempt.id, role: attempt.role, report: report.kind, live: live.kind, ...(live.kind === "observed" ? { lifecycle: live.lifecycle, stateChangeSequence: live.stateChangeSequence } : {}), worktree: worktree.kind, assignment: assignment.kind, preservation: preservation.kind });
		}
		return facts;
	}

	function presentCancellation(result: CancellationResult): CancellationResult {
		ui.presentCancellationResult?.(result);
		return result;
	}

	async function cancel(repositoryRoot: string, controllerSessionId: string): Promise<CancellationResult> {
		let loaded: ActiveRunLoadResult;
		try { loaded = await runJournal.loadActive(repositoryRoot); }
		catch (error: unknown) { return presentCancellation({ kind: "storage-error", message: `Cancellation could not inspect the active Run; no external effect was attempted. ${error instanceof Error ? error.message : "Read-only inspection failed."}` }); }
		if (loaded.kind === "missing") return presentCancellation({ kind: "refused", message: "No active Steward Run exists; cancellation performed no mutation." });
		if (loaded.kind !== "loaded") return presentCancellation({ kind: "refused", message: `${journalRecoveryMessage(loaded)} Cancellation performed no mutation or external effect.` });
		const basis = loaded.journal;
		if (basis.run.status === "cancelled" || basis.run.cancellation) return presentCancellation({ kind: "refused", message: `Run ${basis.run.id} is already cancelled; inspect status for the durable stop/archive phase.` });
		if (basis.run.status !== "active") return presentCancellation({ kind: "refused", message: `Run ${basis.run.id} is ${basis.run.status}; cancellation is only available for an active Run.` });
		if (!controllerIdentityMatches(basis, controllerSessionId)) return presentCancellation({ kind: "refused", message: `Run ${basis.run.id} belongs to Controller Session ${basis.run.controllerSessionId}; cancellation performed no mutation.` });
		if (!ui.confirmCancellation) return presentCancellation({ kind: "refused", message: "Cancellation confirmation UI is unavailable; no mutation occurred." });
		let confirmed: boolean;
		try { confirmed = await ui.confirmCancellation({ runId: basis.run.id, markdown: `Cancel Steward Run ${basis.run.id}?\n\nCancellation makes the Run terminal before any Herdr inspection or /quit. Existing work, Assignments, reports, evidence, activity, verification files, branches, commits, and ownership facts are preserved for inspection and explicit cleanup.` }); }
		catch (error: unknown) { return presentCancellation({ kind: "refused", message: `Cancellation confirmation failed; no mutation occurred. ${error instanceof Error ? error.message : "Interactive confirmation failed."}` }); }
		if (!confirmed) return presentCancellation({ kind: "declined", message: `Cancellation declined; Run ${basis.run.id} and all evidence remain byte-for-byte unchanged.` });
		let confirmedRun: ActiveRunLoadResult;
		try { confirmedRun = await runJournal.loadActive(repositoryRoot); }
		catch (error: unknown) { return presentCancellation({ kind: "stale", message: `The active Run could not be rechecked after confirmation; no external effect was attempted. ${error instanceof Error ? error.message : "Read-only inspection failed."}` }); }
		if (confirmedRun.kind !== "loaded" || confirmedRun.journal.run.id !== basis.run.id || confirmedRun.journal.journalRevision !== basis.journalRevision || confirmedRun.journal.run.controllerSessionId !== basis.run.controllerSessionId || JSON.stringify(confirmedRun.journal.run.controllerLease) !== JSON.stringify(basis.run.controllerLease)) return presentCancellation({ kind: "stale", message: "The active Run, Journal revision, Controller Session, or lease changed during confirmation; no external effect was attempted." });
		let ownership: CancellationOwnership;
		try { ownership = cancellationOwnershipFor(confirmedRun.journal); }
		catch (error: unknown) { return presentCancellation({ kind: "refused", message: `Recorded ownership is conflicting; no cancellation or Herdr effect was attempted. ${error instanceof Error ? error.message : "Ownership facts are not exact."}` }); }
		const cancelledAt = transitionTimestamp(confirmedRun.journal, clock.now());
		const initialStops: CancellationAgentStop[] = ownership.attempts.map((target) => target.duplicateIdentity && target.identity
			? { taskId: target.taskId, attemptId: target.attemptId, role: target.role, state: "not-required", reason: "already-stopped", agent: { role: target.role, agentName: target.identity.name, workspaceId: target.identity.workspaceId, paneId: target.identity.paneId, terminalId: target.identity.terminalId } }
			: target.identity
			? { taskId: target.taskId, attemptId: target.attemptId, role: target.role, state: "intended", agent: { role: target.role, agentName: target.identity.name, workspaceId: target.identity.workspaceId, paneId: target.identity.paneId, terminalId: target.identity.terminalId }, intendedAt: cancelledAt }
			: target.ownershipGap
			? { taskId: target.taskId, attemptId: target.attemptId, role: target.role, state: "not-required", reason: "ownership-gap" }
			: { taskId: target.taskId, attemptId: target.attemptId, role: target.role, state: "not-required", reason: "never-started" });
		let durable: RunJournal;
		try {
			durable = advanceRunJournal(confirmedRun.journal, clock.now(), (next) => {
				for (const task of next.run.tasks) {
					if (task.phase === "completed") continue;
					task.phase = "cancelled";
					for (const attempt of task.attempts) if (["prepared", "active", "awaiting-report"].includes(attempt.state)) attempt.state = "cancelled";
				}
				next.run.status = "cancelled";
				next.run.cancellation = {
					phase: "stops-intended",
					cancelledAt,
					controllerSessionId,
					...(next.run.controllerLease ? { controllerLease: { sessionId: next.run.controllerLease.sessionId, leaseId: next.run.controllerLease.leaseId } } : {}),
					priorTasks: ownership.priorTasks.map((task) => ({ ...task, attempts: task.attempts.map((attempt) => ({ ...attempt })) })),
					panes: ownership.panes.map((pane) => ({ ...pane })),
					worktrees: ownership.worktrees.map((worktree) => ({ ...worktree })),
					stops: initialStops,
				};
			});
		} catch (error: unknown) { return presentCancellation({ kind: "storage-error", message: `Cancellation could not build the durable terminal transition; no Herdr inspection or /quit was attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` }); }
		let replaced: import("./run-journal-store.ts").ReplaceActiveResult;
		try { replaced = await runJournal.replaceActive(repositoryRoot, durable); }
		catch (error: unknown) { return presentCancellation({ kind: "storage-error", message: `Cancellation could not persist before interruption; no Herdr inspection or /quit was attempted. ${error instanceof Error ? error.message : "Journal storage failed."}` }); }
		if (replaced.kind !== "replaced") return presentCancellation({ kind: "storage-error", message: "Cancellation lost the active Journal compare-and-swap before interruption; no Herdr inspection or /quit was attempted." });
		let journal = replaced.journal;
		await runJournal.appendActivity(repositoryRoot, { timestamp: journal.run.updatedAt, runId: journal.run.id, event: "run-cancelled", message: `Run ${journal.run.id} became durably cancelled before Herdr inspection or graceful stop.` }).catch(() => undefined);
		const persistStop = async (index: number, state: CancellationAgentStop, failure?: import("./run.ts").CancellationStopFailure): Promise<RunJournal | undefined> => {
			try {
				const candidate = advanceRunJournal(journal, clock.now(), (next) => {
					const current = next.run.cancellation;
					if (!current || (current.phase !== "stops-intended" && current.phase !== "stops-incomplete")) throw new Error("Cancellation stop state disappeared.");
					current.stops[index] = state;
					if (failure) next.run.cancellation = { ...current, phase: "stops-incomplete", failure };
				});
				const result = await runJournal.replaceActive(repositoryRoot, candidate);
				return result.kind === "replaced" ? result.journal : undefined;
			} catch { return undefined; }
		};

		const stops = journal.run.cancellation?.stops ?? [];
		for (let index = 0; index < stops.length; index += 1) {
			const stop = stops[index]!;
			if (stop.state === "not-required" || stop.state === "acknowledged") continue;
			if (stop.state !== "intended") return presentCancellation({ kind: "incomplete", journal, message: `Cancellation remains incomplete at ${stop.taskId}/${stop.attemptId}; no stop was resent and no archive or cleanup was attempted.` });
			const identity = { name: stop.agent.agentName, workspaceId: stop.agent.workspaceId, paneId: stop.agent.paneId, terminalId: stop.agent.terminalId };
			let inspection: ManagedAgentInspection;
			try { inspection = herdr.inspectManagedAgent ? await herdr.inspectManagedAgent(identity) : { kind: "unclear", diagnostic: "Herdr inspection adapter is unavailable." }; }
			catch (error: unknown) { inspection = { kind: "unclear", diagnostic: error instanceof Error ? error.message : "Herdr inspection failed." }; }
			if (inspection.kind === "missing") {
				const missingStop: CancellationAgentStop = { taskId: stop.taskId, attemptId: stop.attemptId, role: stop.role, state: "not-required", reason: "already-missing", agent: { ...stop.agent } };
				const persistedMissing = await persistStop(index, missingStop);
				if (!persistedMissing) return presentCancellation({ kind: "incomplete", journal, message: `Agent ${identity.name} was already missing, but that no-op could not be retained; no stop was resent.` });
				journal = persistedMissing;
				continue;
			}
			if (inspection.kind !== "observed" || !exactIdentity(inspection.identity, identity)) {
				const diagnostic = inspection.kind === "unclear" ? inspection.diagnostic : "Herdr returned a foreign Agent identity.";
				const failure: import("./run.ts").CancellationStopFailure = { taskId: stop.taskId, attemptId: stop.attemptId, role: stop.role, state: "ambiguous", observedAt: transitionTimestamp(journal, clock.now()), diagnostic: diagnostic.slice(0, 2_000) };
				const failedStop: CancellationAgentStop = { ...stop, state: "ambiguous", observedAt: failure.observedAt, diagnostic: failure.diagnostic };
				const persistedFailure = await persistStop(index, failedStop, failure);
				return presentCancellation({ kind: "incomplete", journal: persistedFailure ?? journal, message: `Cancellation stop is ambiguous for ${identity.name}; no /quit resend, archive, or cleanup was attempted.` });
			}
			if (!herdr.stopAgentGracefully) {
				const diagnostic = "Graceful Agent stop adapter is unavailable.";
				const failure: import("./run.ts").CancellationStopFailure = { taskId: stop.taskId, attemptId: stop.attemptId, role: stop.role, state: "failed", observedAt: transitionTimestamp(journal, clock.now()), diagnostic };
				const failedStop: CancellationAgentStop = { ...stop, state: "failed", observedAt: failure.observedAt, diagnostic };
				const persistedFailure = await persistStop(index, failedStop, failure);
				return presentCancellation({ kind: "incomplete", journal: persistedFailure ?? journal, message: `Cancellation could not gracefully stop ${identity.name}; no archive or cleanup was attempted.` });
			}
			let stopped: HerdrStopResult;
			try { stopped = await herdr.stopAgentGracefully({ repositoryRoot, ...identity }); }
			catch (error: unknown) { stopped = { kind: "ambiguous", message: error instanceof Error ? error.message : "Graceful /quit failed." }; }
			if (stopped.kind !== "acknowledged" || stopped.name !== identity.name || stopped.workspaceId !== identity.workspaceId || stopped.paneId !== identity.paneId || stopped.terminalId !== identity.terminalId || !validIdentity(stopped.tabId)) {
				const diagnostic = stopped.kind === "acknowledged" ? "Graceful stop returned a foreign or incomplete Agent identity." : stopped.message;
				const failure: import("./run.ts").CancellationStopFailure = { taskId: stop.taskId, attemptId: stop.attemptId, role: stop.role, state: stopped.kind === "ambiguous" ? "ambiguous" : "failed", observedAt: transitionTimestamp(journal, clock.now()), diagnostic: diagnostic.slice(0, 2_000) };
				const failedStop: CancellationAgentStop = { ...stop, state: failure.state, observedAt: failure.observedAt, diagnostic: failure.diagnostic };
				const persistedFailure = await persistStop(index, failedStop, failure);
				return presentCancellation({ kind: "incomplete", journal: persistedFailure ?? journal, message: `Cancellation stop for ${identity.name} is ${failure.state}; no resend, archive, or cleanup was attempted.` });
			}
			const acknowledged: CancellationAgentStop = { ...stop, state: "acknowledged", acknowledgedAt: transitionTimestamp(journal, clock.now()), acknowledgement: { name: stopped.name, workspaceId: stopped.workspaceId, tabId: stopped.tabId, paneId: stopped.paneId, terminalId: stopped.terminalId } };
			const persistedAcknowledgement = await persistStop(index, acknowledged);
			if (!persistedAcknowledgement) return presentCancellation({ kind: "incomplete", journal, message: `Graceful stop for ${identity.name} succeeded but its acknowledgement could not be persisted; no /quit resend was attempted.` });
			journal = persistedAcknowledgement;
			await runJournal.appendActivity(repositoryRoot, { timestamp: journal.run.updatedAt, runId: journal.run.id, event: "run-cancel-stop-acknowledged", message: `Gracefully stopped exact Agent ${identity.name} for ${stop.taskId}/${stop.attemptId}.` }).catch(() => undefined);
		}
		let stopsComplete: RunJournal;
		try {
			stopsComplete = advanceRunJournal(journal, clock.now(), (next) => {
				const current = next.run.cancellation;
				if (!current || current.phase !== "stops-intended" || current.stops.some((stop) => stop.state !== "acknowledged" && stop.state !== "not-required")) throw new Error("Cancellation stops are not conclusive.");
				next.run.cancellation = { ...current, phase: "stops-complete" };
			});
		} catch (error: unknown) { return presentCancellation({ kind: "incomplete", journal, message: `Cancellation stops are conclusive in memory but could not be retained; archive was not attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` }); }
		const persistedComplete = await persistReviewJournal(repositoryRoot, stopsComplete, { runJournal, herdr, git, process, model, clock, ui });
		if (!persistedComplete) return presentCancellation({ kind: "incomplete", journal, message: "Cancellation stops are conclusive in memory but could not be persisted; archive was not attempted." });
		journal = persistedComplete;
		const reports = await collectCancellationReports(repositoryRoot, journal, { runJournal, herdr, git, process, model, clock, ui });
		if ("message" in reports) return presentCancellation({ kind: "incomplete", journal, message: reports.message });
		if (!runJournal.resolveCompletionPaths || !runJournal.loadCompletionJournalPointers || !runJournal.archiveCancelledRun) return presentCancellation({ kind: "incomplete", journal, message: "Cancelled archive storage adapters are unavailable; the cancelled Run and evidence remain active for inspection." });
		const paths = runJournal.resolveCompletionPaths(repositoryRoot, journal.run.id);
		const pointers = await runJournal.loadCompletionJournalPointers(repositoryRoot);
		if (pointers.kind !== "loaded") return presentCancellation({ kind: "incomplete", journal, message: `Cancelled archive publication was not attempted: ${pointers.message}` });
		const archive: CancellationArchiveIntent = { intendedAt: transitionTimestamp(journal, clock.now()), archiveDirectory: paths.archiveDirectory, runPath: paths.archiveRunPath, previousRunPath: paths.archivePreviousRunPath, manifestPath: paths.archiveManifestPath, activeJournalSha256: sha256Bytes(pointers.pointers.activeBytes), previousJournalSha256: sha256Bytes(pointers.pointers.previousBytes), reports: reports.map((report) => ({ ...report })) };
		let archiveIntent: RunJournal;
		try { archiveIntent = advanceRunJournal(journal, clock.now(), (next) => { const current = next.run.cancellation; if (!current || current.phase !== "stops-complete") throw new Error("Cancellation stops-complete state disappeared before archive intent."); next.run.cancellation = { ...current, phase: "archive-intended", archive: { ...archive, reports: archive.reports.map((report) => ({ ...report })) } }; }); }
		catch (error: unknown) { return presentCancellation({ kind: "incomplete", journal, message: `Cancelled archive intent could not be persisted; evidence was preserved. ${error instanceof Error ? error.message : "Journal validation failed."}` }); }
		const persistedIntent = await persistReviewJournal(repositoryRoot, archiveIntent, { runJournal, herdr, git, process, model, clock, ui });
		if (!persistedIntent) return presentCancellation({ kind: "incomplete", journal, message: "Cancelled archive intent could not be persisted; evidence was preserved." });
		journal = persistedIntent;
		const finalPointers = await runJournal.loadCompletionJournalPointers(repositoryRoot);
		if (finalPointers.kind !== "loaded") return presentCancellation({ kind: "incomplete", journal, message: `Cancelled archive publication was not attempted: ${finalPointers.message}` });
		let archived: RunJournal;
		const archivedAt = transitionTimestamp(journal, clock.now());
		try { archived = advanceRunJournal(journal, clock.now(), (next) => { const current = next.run.cancellation; if (!current || current.phase !== "archive-intended") throw new Error("Cancellation archive intent disappeared before final snapshot."); next.run.cancellation = { ...current, phase: "archived", archive: { ...current.archive, activeJournalSha256: sha256Bytes(finalPointers.pointers.activeBytes), previousJournalSha256: sha256Bytes(finalPointers.pointers.previousBytes), reports: current.archive.reports.map((report) => ({ ...report })) }, archivedAt }; }); }
		catch (error: unknown) { return presentCancellation({ kind: "incomplete", journal, message: `Cancelled archive snapshot could not be built; live evidence was preserved. ${error instanceof Error ? error.message : "Journal validation failed."}` }); }
		const published = await runJournal.archiveCancelledRun({ repositoryRoot, runId: journal.run.id, run: archived, archivedAt, reports });
		if (published.kind !== "published" && published.kind !== "existing-match") return presentCancellation({ kind: "incomplete", journal, message: `Cancelled archive was not published; active Journal and evidence remain authoritative. ${"message" in published ? published.message : "Archive storage failed."}` });
		await runJournal.appendActivity(repositoryRoot, { timestamp: archived.run.updatedAt, runId: archived.run.id, event: "run-cancelled-archived", message: `Cancelled Run ${archived.run.id} was published at ${paths.archiveDirectory}; historical evidence was retained.` }).catch(() => undefined);
		return presentCancellation({ kind: "archived", journal: archived, message: `Run ${archived.run.id} was cancelled, gracefully stopped where exact identities were available, and archived at ${paths.archiveDirectory}. Evidence and ownership facts were retained.` });
	}

	function presentCleanup(result: CleanupResult): CleanupResult {
		ui.presentCleanupResult?.(result);
		return result;
	}

	function cleanupSummary(inventory: CleanupInventory): CleanupConfirmationSummary {
		const lines = ["Clean up only these exact Steward-owned Herdr resources?", "", ...inventory.archives.map((archive) => `Archive ${archive.runId}: ${archive.archiveDirectory} (${archive.runSha256}, manifest ${archive.manifestSha256})`), "", "Owned panes:", ...(inventory.panes.length > 0 ? inventory.panes.map((pane) => `- ${pane.runId} ${pane.kind}: workspace=${pane.workspaceId} pane=${pane.paneId} terminal=${pane.terminalId}`) : ["- none"]), "", "Builder worktrees:", ...(inventory.worktrees.length > 0 ? inventory.worktrees.map((worktree) => `- ${worktree.runId}: workspace=${worktree.workspaceId} branch=${worktree.branch} path=${worktree.path}`) : ["- none"]), "", "Archives, Assignments, Attempt Reports, evidence, activity logs, verification logs/results, branches, and commits are retained. Unrelated or mismatched resources will block the whole cleanup."];
		return { markdown: lines.join("\n"), archives: inventory.archives.map((archive) => ({ ...archive })), panes: inventory.panes.map((pane) => ({ ...pane })), worktrees: inventory.worktrees.map((worktree) => ({ ...worktree })) };
	}

	async function cleanup(repositoryRoot: string, _controllerSessionId: string): Promise<CleanupResult> {
		let active: ActiveRunLoadResult;
		try { active = await runJournal.loadActive(repositoryRoot); }
		catch (error: unknown) { return presentCleanup({ kind: "refused", message: `Cleanup could not inspect the active Run; no Herdr effect was attempted. ${error instanceof Error ? error.message : "Read-only inspection failed."}` }); }
		if (active.kind === "loaded") return presentCleanup({ kind: "refused", message: active.journal.run.status === "cancelled" ? `Run ${active.journal.run.id} is still present as a cancelled active pointer; inspect status and finish its stop/archive lifecycle before cleanup.` : `A nonterminal active Run ${active.journal.run.id} exists; cleanup will not interleave with live orchestration.` });
		if (active.kind !== "missing") return presentCleanup({ kind: "refused", message: `${journalRecoveryMessage(active)} Cleanup has no ownership authority and performed no Herdr effect.` });
		if (!runJournal.listTerminalArchives) return presentCleanup({ kind: "refused", message: "Terminal archive listing is unavailable; no cleanup effect was attempted." });
		const listed = await runJournal.listTerminalArchives(repositoryRoot);
		if (listed.kind !== "loaded") return presentCleanup({ kind: "refused", message: `Terminal archives are not a strict cleanup basis; no Herdr effect was attempted. ${listed.message}` });
		let inventory: CleanupInventory;
		try { inventory = cleanupInventoryForArchives(listed.archives); }
		catch (error: unknown) { return presentCleanup({ kind: "refused", message: `Terminal archive ownership is conflicting; no Herdr effect was attempted. ${error instanceof Error ? error.message : "Exact ownership derivation failed."}` }); }
		if (inventory.panes.length === 0 && inventory.worktrees.length === 0) return presentCleanup({ kind: "noop", message: listed.archives.length > 0 ? "No exact Steward-owned panes or Builder worktrees were recorded; cleanup was a no-op and all evidence remains retained." : "No terminal Steward archives exist; cleanup was a no-op." });
		if (!ui.confirmCleanup) return presentCleanup({ kind: "refused", message: "Cleanup confirmation UI is unavailable; no Herdr effect was attempted." });
		let confirmed: boolean;
		try { confirmed = await ui.confirmCleanup(cleanupSummary(inventory)); }
		catch (error: unknown) { return presentCleanup({ kind: "declined", message: `Cleanup confirmation failed; no Herdr effect was attempted. ${error instanceof Error ? error.message : "Interactive confirmation failed."}` }); }
		if (!confirmed) return presentCleanup({ kind: "declined", message: "Cleanup declined; archives, ownership evidence, and live resources remain unchanged." });
		const freshActive = await runJournal.loadActive(repositoryRoot);
		if (freshActive.kind !== "missing") return presentCleanup({ kind: "stale", message: "The active Run state changed after cleanup confirmation; no Herdr effect was attempted." });
		const freshListed = await runJournal.listTerminalArchives(repositoryRoot);
		if (freshListed.kind !== "loaded") return presentCleanup({ kind: "stale", message: `Terminal archive ownership changed or became unavailable after cleanup confirmation; no Herdr effect was attempted. ${freshListed.message}` });
		let freshInventory: CleanupInventory;
		try { freshInventory = cleanupInventoryForArchives(freshListed.archives); }
		catch (error: unknown) { return presentCleanup({ kind: "stale", message: `Terminal archive ownership changed after cleanup confirmation; no Herdr effect was attempted. ${error instanceof Error ? error.message : "Exact ownership derivation failed."}` }); }
		if (JSON.stringify(freshInventory) !== JSON.stringify(inventory)) return presentCleanup({ kind: "stale", message: "The exact archive hashes or ownership inventory changed after cleanup confirmation; no Herdr effect was attempted." });
		if (!herdr.preflightCleanupWorkspace || !herdr.closeCleanupPane || !herdr.removeCleanupWorktree) return presentCleanup({ kind: "blocked", message: "Strict Herdr cleanup preflight/effect adapters are unavailable; no cleanup effect was attempted." });
		const workspaceIds = [...new Set([...inventory.panes.map((pane) => pane.workspaceId), ...inventory.worktrees.map((worktree) => worktree.workspaceId)])].sort();
		const paneByWorkspace = new Map<string, StewardOwnedPane[]>();
		for (const pane of inventory.panes) paneByWorkspace.set(pane.workspaceId, [...(paneByWorkspace.get(pane.workspaceId) ?? []), pane]);
		const worktreeByWorkspace = new Map<string, StewardOwnedWorktree[]>();
		for (const worktree of inventory.worktrees) worktreeByWorkspace.set(worktree.workspaceId, [...(worktreeByWorkspace.get(worktree.workspaceId) ?? []), worktree]);
		const preflight = new Map<string, Extract<HerdrCleanupPreflightResult, { kind: "ready" }> | Extract<HerdrCleanupPreflightResult, { kind: "missing" }>>();
		for (const workspaceId of workspaceIds) {
			let result: HerdrCleanupPreflightResult;
			try { result = await herdr.preflightCleanupWorkspace({ repositoryRoot, workspaceId }); }
			catch (error: unknown) { return presentCleanup({ kind: "blocked", message: `Cleanup preflight failed for workspace ${workspaceId}; zero cleanup effects were attempted. ${error instanceof Error ? error.message : "Herdr preflight failed."}` }); }
			if (result.kind === "missing") { preflight.set(workspaceId, result); continue; }
			if (result.kind !== "ready") return presentCleanup({ kind: "blocked", message: `Cleanup preflight is ${result.kind} for workspace ${workspaceId}; zero cleanup effects were attempted. ${result.message}` });
			const recordedPanes = paneByWorkspace.get(workspaceId) ?? [];
			const recordedWorktrees = worktreeByWorkspace.get(workspaceId) ?? [];
			const livePaneKeys = new Set<string>();
			for (const pane of result.panes) {
				const paneKey = `${pane.paneId}/${pane.terminalId}`;
				if (livePaneKeys.has(paneKey)) return presentCleanup({ kind: "blocked", message: `Cleanup preflight found a duplicated pane identity in workspace ${workspaceId}; zero cleanup effects were attempted.` });
				livePaneKeys.add(paneKey);
				const owned = recordedPanes.find((candidate) => candidate.paneId === pane.paneId);
				if (!owned || pane.workspaceId !== workspaceId || owned.terminalId !== pane.terminalId || (owned.kind === "builder-root") !== pane.root) return presentCleanup({ kind: "blocked", message: `Cleanup preflight found an unrecognized, reused, or contradictory pane in workspace ${workspaceId}; zero cleanup effects were attempted.` });
			}
			const liveWorktreeKeys = new Set<string>();
			for (const worktree of result.worktrees) {
				const worktreeKey = `${worktree.path}/${worktree.branch}`;
				if (liveWorktreeKeys.has(worktreeKey)) return presentCleanup({ kind: "blocked", message: `Cleanup preflight found a duplicated worktree identity in workspace ${workspaceId}; zero cleanup effects were attempted.` });
				liveWorktreeKeys.add(worktreeKey);
				const owned = recordedWorktrees.find((candidate) => candidate.path === worktree.path && candidate.branch === worktree.branch);
				const rootPane = result.panes.find((pane) => pane.paneId === worktree.rootPaneId);
				if (!owned || worktree.workspaceId !== workspaceId || worktree.rootPaneId !== owned.paneId || !rootPane || !rootPane.root) return presentCleanup({ kind: "blocked", message: `Cleanup preflight found an unrecognized, foreign, or contradictory worktree in workspace ${workspaceId}; zero cleanup effects were attempted.` });
			}
			preflight.set(workspaceId, result);
		}
		const closed: string[] = [];
		for (const pane of inventory.panes) {
			const state = preflight.get(pane.workspaceId);
			if (!state || state.kind === "missing") continue;
			const live = state.panes.find((candidate) => candidate.paneId === pane.paneId && candidate.terminalId === pane.terminalId);
			if (!live || live.root) continue;
			let effect: HerdrCleanupEffectResult;
			try { effect = await herdr.closeCleanupPane({ repositoryRoot, workspaceId: pane.workspaceId, paneId: pane.paneId, terminalId: pane.terminalId }); }
			catch (error: unknown) { return presentCleanup({ kind: "partial", message: `Cleanup closed ${closed.length} pane(s), then failed ambiguously at pane ${pane.paneId}; no later resource was touched. ${error instanceof Error ? error.message : "Pane close failed."}` }); }
			if (effect.kind === "missing") continue;
			if (effect.kind !== "completed") return presentCleanup({ kind: "partial", message: `Cleanup closed ${closed.length} pane(s), then failed at pane ${pane.paneId}; no later resource was touched. ${effect.message}` });
			closed.push(pane.paneId);
		}
		const removed: string[] = [];
		for (const worktree of inventory.worktrees) {
			const state = preflight.get(worktree.workspaceId);
			if (!state || state.kind === "missing") continue;
			const live = state.worktrees.find((candidate) => candidate.path === worktree.path && candidate.branch === worktree.branch);
			if (!live) continue;
			let effect: HerdrCleanupEffectResult;
			try { effect = await herdr.removeCleanupWorktree({ repositoryRoot, workspaceId: worktree.workspaceId, path: worktree.path, branch: worktree.branch }); }
			catch (error: unknown) { return presentCleanup({ kind: "partial", message: `Cleanup closed ${closed.length} pane(s) and removed ${removed.length} worktree(s), then failed ambiguously at ${worktree.path}; no later resource was touched. ${error instanceof Error ? error.message : "Worktree removal failed."}` }); }
			if (effect.kind === "missing") continue;
			if (effect.kind !== "completed") return presentCleanup({ kind: "partial", message: `Cleanup closed ${closed.length} pane(s) and removed ${removed.length} worktree(s), then failed at ${worktree.path}; no later resource was touched. ${effect.message}` });
			removed.push(worktree.path);
		}
		return presentCleanup({ kind: "completed", message: `Cleanup completed for ${closed.length} non-root pane(s) and ${removed.length} Builder worktree(s). Archives and all historical evidence remain retained.` });
	}

	async function takeover(repositoryRoot: string, controllerSessionId: string): Promise<ResumeResult> {
		const initial = await runJournal.loadActive(repositoryRoot);
		if (initial.kind === "missing") return { kind: "missing", message: "No active Steward Run exists in this repository." };
		if (initial.kind === "migration-ready") return applyMigrationResume(repositoryRoot, initial);
		if (initial.kind === "recovered") return { kind: "recovered", message: `${journalRecoveryMessage(initial)} Takeover is dormant; resume remains read-only until the active snapshot is repaired.` };
		if (initial.kind === "invalid") return { kind: "invalid", message: `${journalRecoveryMessage(initial)} Takeover is read-only.` };
		if (initial.journal.run.status === "cancelled" || initial.journal.run.cancellation) return { kind: "stale", message: "The active Steward Run is cancelled; takeover is dormant." };
		if (initial.journal.run.status === "completed" || initial.journal.run.completion?.phase === "archived") return { kind: "stale", message: "The active Steward Run is completed; takeover is dormant." };
		if (controllerIdentityMatches(initial.journal, controllerSessionId)) return { kind: "already-owner", currentSessionId: controllerSessionId, message: "This Controller Session already owns the active Steward Run; use plain resume." };
		const basis = initial.journal;
		const previousSessionId = basis.run.controllerSessionId;
		const previousLease = basis.run.controllerLease;
		let facts: unknown[];
		try { facts = await inspectTakeoverFacts(repositoryRoot, basis); }
		catch (error: unknown) { return { kind: "stale", message: `Takeover reconciliation was unavailable; no Controller identity changed. ${error instanceof Error ? error.message.slice(0, 2_000) : "Read-only inspection failed."}` }; }
		const pendingAction = pendingControllerAction(basis);
		const reconciliationSha256 = canonicalTakeoverHash({ runId: basis.run.id, journalRevision: basis.journalRevision, previousSessionId, ...(previousLease ? { previousLeaseId: previousLease.leaseId } : {}), facts, pendingAction });
		const completedAt = new Date(Math.max(clock.now().getTime(), new Date(basis.run.updatedAt).getTime())).toISOString();
		const current = await runJournal.loadActive(repositoryRoot);
		if (current.kind !== "loaded" || current.journal.run.id !== basis.run.id || current.journal.journalRevision !== basis.journalRevision || current.journal.run.controllerSessionId !== previousSessionId || JSON.stringify(current.journal.run.controllerLease) !== JSON.stringify(previousLease)) return { kind: "stale", message: "The active Run changed during read-only takeover reconciliation; no Controller identity changed." };
		let candidate: RunJournal;
		try {
			candidate = advanceRunJournal(current.journal, clock.now(), (next) => {
				const acquiredAt = new Date(Math.max(clock.now().getTime(), new Date(current.journal.run.updatedAt).getTime() + 1, new Date(completedAt).getTime())).toISOString();
				const rawLeaseId = clock.randomUUID().replace(/[^A-Za-z0-9._-]/g, "").slice(0, 72);
				const proposedLeaseId = `lease-${rawLeaseId || `${current.journal.journalRevision + 1}`}`;
				const leaseId = proposedLeaseId === previousLease?.leaseId ? `${proposedLeaseId}-takeover-${current.journal.journalRevision + 1}`.slice(0, 128) : proposedLeaseId;
				next.run.controllerSessionId = controllerSessionId;
				next.run.controllerLease = {
					sessionId: controllerSessionId,
					leaseId,
					acquiredAt,
					acquiredJournalRevision: current.journal.journalRevision + 1,
					takeover: {
						previousSessionId,
						...(previousLease ? { previousLeaseId: previousLease.leaseId } : {}),
						reconciledAt: completedAt,
						basisJournalRevision: current.journal.journalRevision,
						reconciliationSha256,
						pendingAction,
					},
				};
			});
		} catch (error: unknown) { return { kind: "degraded", message: `Takeover candidate was rejected; no Controller identity changed. ${error instanceof Error ? error.message.slice(0, 2_000) : "Journal validation failed."}` }; }
		let replaced: import("./run-journal-store.ts").ReplaceActiveResult;
		try { replaced = await runJournal.replaceActive(repositoryRoot, candidate); }
		catch (error: unknown) { return { kind: "degraded", message: `Takeover storage failed; no Controller identity was claimed. ${error instanceof Error ? error.message.slice(0, 2_000) : "CAS failed."}` }; }
		if (replaced.kind !== "replaced") return { kind: "stale", message: "Takeover lost the Run Journal compare-and-swap; the actual winner remains authoritative." };
		let warning = "";
		try {
			const activity = await runJournal.appendActivity(repositoryRoot, { timestamp: replaced.journal.run.updatedAt, runId: replaced.journal.run.id, event: "controller-taken-over", message: `Controller Session ${controllerSessionId} took ownership from ${previousSessionId} after read-only reconciliation at Journal revision ${basis.journalRevision}.` });
			if (activity.kind !== "appended") warning = " Activity logging is degraded; ownership remains authoritative.";
		} catch { warning = " Activity logging is degraded; ownership remains authoritative."; }
		return { kind: "taken-over", journal: replaced.journal, pendingAction, message: `Controller ownership transferred to Session ${controllerSessionId}; the next serialized pass will reconcile before one workflow action.${warning}` };
	}

	async function applyMigrationResume(repositoryRoot: string, load: Extract<ActiveRunLoadResult, { kind: "migration-ready" }>): Promise<ResumeResult> {
		if (!runJournal.applyMigration) return { kind: "migration-failed", message: `${journalRecoveryMessage(load)} This adapter cannot perform the explicit schema-only normalization; no snapshot or workflow fact changed.` };
		let applied: ApplyRunJournalMigrationResult;
		try { applied = await runJournal.applyMigration(repositoryRoot, load); }
		catch (error: unknown) { return { kind: "migration-failed", message: `${journalRecoveryMessage(load)} Schema-only normalization failed without a workflow action. ${error instanceof Error ? error.message : "Migration storage failed."}` }; }
		if (applied.kind === "applied") return { kind: "migration-applied", journal: applied.journal, message: `Only schema normalization ${applied.migration.id} was applied from v${applied.migration.fromVersion} to v${applied.migration.targetVersion}; no workflow reconciliation occurred. Resume again to continue normally.` };
		return { kind: "migration-failed", message: `${journalRecoveryMessage(load)} Schema-only normalization was not applied; no workflow action occurred. ${applied.diagnostics.map((item) => item.message).join(" ")}` };
	}

	async function restoreControllerSession(repositoryRoot: string, controllerSessionId: string): Promise<ControllerSessionRestoreResult> {
		const loaded = await runJournal.loadActive(repositoryRoot);
		if (loaded.kind === "missing") return { kind: "dormant", reason: "missing", message: "No active Steward Run exists; Controller monitoring is dormant." };
		if (loaded.kind === "recovered" || loaded.kind === "migration-ready") return { kind: "dormant", reason: "recovery", message: `${journalRecoveryMessage(loaded)} Controller monitoring is dormant.` };
		if (loaded.kind === "invalid") return { kind: "dormant", reason: "invalid", message: "Active Steward Run state is invalid; Controller monitoring is dormant." };
		if (loaded.journal.run.status === "cancelled" || loaded.journal.run.cancellation) return { kind: "dormant", reason: "cancelled", message: "The Steward Run is cancelled; Controller monitoring is dormant.", journal: loaded.journal };
		if (loaded.journal.run.status === "completed" || loaded.journal.run.completion?.phase === "archived") return { kind: "dormant", reason: "completed", message: "The Steward Run is completed; Controller monitoring is dormant.", journal: loaded.journal };
		if (!controllerIdentityMatches(loaded.journal, controllerSessionId)) return { kind: "dormant", reason: "foreign-session", message: `This Pi Session is foreign to Controller Session ${loaded.journal.run.controllerSessionId}; run /steward resume --takeover to claim it.`, journal: loaded.journal };
		return { kind: "restored", journal: loaded.journal };
	}

	async function prepareCompactionContinuity(repositoryRoot: string, controllerSessionId: string): Promise<CompactionContinuityResult> {
		const first = await runJournal.loadActive(repositoryRoot);
		if (first.kind === "missing") return { kind: "missing", message: "No active Steward Run exists; normal Pi compaction remains available." };
		if (first.kind === "recovered" || first.kind === "migration-ready") return { kind: "invalid", message: `${journalRecoveryMessage(first)} normal Pi compaction remains available without Controller monitoring.` };
		if (first.kind === "invalid") return { kind: "invalid", message: "Active Steward Run state is invalid; normal Pi compaction remains available." };
		if (first.journal.run.status === "cancelled" || first.journal.run.cancellation) return { kind: "cancelled", message: "The Steward Run is cancelled; normal Pi compaction remains available." };
		if (first.journal.run.status === "completed" || first.journal.run.completion?.phase === "archived") return { kind: "completed", message: "The Steward Run is completed; normal Pi compaction remains available." };
		if (!controllerIdentityMatches(first.journal, controllerSessionId)) return { kind: "foreign-session", message: `This Pi Session is foreign to Controller Session ${first.journal.run.controllerSessionId}; normal Pi compaction remains available.` };
		const pendingAction = pendingControllerAction(first.journal);
		const second = await runJournal.loadActive(repositoryRoot);
		if (second.kind !== "loaded" || second.journal.run.id !== first.journal.run.id || second.journal.journalRevision !== first.journal.journalRevision || JSON.stringify(second.journal.run.controllerLease) !== JSON.stringify(first.journal.run.controllerLease) || !controllerIdentityMatches(second.journal, controllerSessionId)) return { kind: "stale", message: "The Run changed while continuity was being verified; normal Pi compaction remains available." };
		return { kind: "prepared", journal: second.journal, runId: second.journal.run.id, journalRevision: second.journal.journalRevision, controllerSessionId, pendingAction, block: continuityBlock(second.journal.run.id, second.journal.journalRevision, controllerSessionId, pendingAction) };
	}

	async function recordCompactionFailure(repositoryRoot: string, controllerSessionId: string, details: CompactionFailureDetails): Promise<{ kind: "recorded" | "ignored" | "degraded"; message: string }> {
		const loaded = await runJournal.loadActive(repositoryRoot);
		if (loaded.kind !== "loaded" || !controllerIdentityMatches(loaded.journal, controllerSessionId) || loaded.journal.run.status === "cancelled" || loaded.journal.run.cancellation || loaded.journal.run.status === "completed" || loaded.journal.run.completion?.phase === "archived") return { kind: "ignored", message: "Compaction failure was not recorded because this session is not an active non-cancelled Controller." };
		const safeError = details.errorMessage?.replace(/[\u0000\r\n]+/g, " ").slice(0, 500);
		const message = `Compaction failed (${details.reason}; aborted=${details.aborted}; willRetry=${details.willRetry}; fromExtension=${details.fromExtension})${safeError ? `: ${safeError}` : ""}. Task state remains authoritative and unchanged.`;
		try {
			const result = await runJournal.appendActivity(repositoryRoot, { timestamp: loaded.journal.run.updatedAt, runId: loaded.journal.run.id, event: "compaction-continuity-failed", message });
			return result.kind === "appended" ? { kind: "recorded", message } : { kind: "degraded", message: `${message} Activity logging is degraded.` };
		} catch { return { kind: "degraded", message: `${message} Activity logging is degraded.` }; }
	}

	async function status(repositoryRoot: string, target: StatusTarget, controllerSessionId?: string): Promise<StatusView> {
		const loaded = await runJournal.loadActive(repositoryRoot);
		if (loaded.kind === "loaded" && (loaded.journal.run.status === "cancelled" || loaded.journal.run.cancellation)) {
			const statusView = withJournalRecovery(presentCancelledStatus(loaded.journal), "normal");
			ui.presentStatus(statusView, target);
			return statusView;
		}
		let statusView: StatusView = loaded.kind === "missing"
			? EMPTY_STATUS
			: loaded.kind !== "loaded"
				? presentRecoveryStatus(loaded)
				: presentStatusForJournal(loaded.journal);
		if (loaded.kind === "loaded" && target === "command" && controllerSessionId !== undefined && controllerIdentityMatches(loaded.journal, controllerSessionId)) {
			let currentJournal = loaded.journal;
			let note = "";
			const hasRecoverySignal = currentJournal.run.tasks.some((candidateTask) => {
				const latest = currentAttempt(candidateTask);
				return latest !== undefined && (latest.state === "prepared" || latest.state === "awaiting-report" || latest.dispatch.phase === "prompt-intended" || latest.dispatch.phase === "reconciled-active" || latest.recovery !== undefined);
			});
			const reconciliation = optionalManagedAgentInspector(herdr) || hasRecoverySignal
				? await reconcileCurrentAttempt(repositoryRoot, controllerSessionId, currentJournal, { runJournal, herdr, git, process, model, clock, ui })
				: { kind: "none" as const, journal: currentJournal, note: "" };
			currentJournal = reconciliation.journal;
			if (reconciliation.kind !== "none") {
				statusView = currentJournal.run.status === "completed" ? presentCompletedStatus(currentJournal, reconciliation.note) : presentStatusForJournal(currentJournal, reconciliation.note);
				ui.presentStatus(statusView, target);
				return statusView;
			}
			const builderCandidates = currentJournal.run.tasks.length > 1 ? activeBuilders(currentJournal) : (activeBuilder(currentJournal) ? [activeBuilder(currentJournal)!] : []);
			for (const candidate of builderCandidates) {
				const beforeBuilderRevision = currentJournal.journalRevision;
				const decision = await validateActiveBuilderEvidence(repositoryRoot, controllerSessionId, currentJournal, { runJournal, herdr, git, process, model, clock, ui }, candidate);
				currentJournal = decision.journal;
				note = decision.note;
				if (currentJournal.journalRevision !== beforeBuilderRevision || decision.kind !== "waiting") break;
			}
			const approvedCheck = await validateApprovedTasks(repositoryRoot, currentJournal, { runJournal, herdr, git, process, model, clock, ui });
			currentJournal = approvedCheck.journal;
			if (approvedCheck.note) note = note ? `${note} ${approvedCheck.note}` : approvedCheck.note;
			const approvalInvalidated = currentJournal.run.tasks.some((task) => task.approval?.phase === "invalidated" && task.attention === "needs-user");
			const review = approvalInvalidated
				? { journal: currentJournal, note: "Approval invalidation is durable; no Reviewer or Builder effect was attempted." }
				: await advanceEligibleReview(repositoryRoot, controllerSessionId, currentJournal, { runJournal, herdr, git, process, model, clock, ui });
			currentJournal = review.journal;
			if (review.note) note = note ? `${note} ${review.note}` : review.note;
			const completion = await advanceApprovedCompletion(repositoryRoot, currentJournal, { runJournal, herdr, git, process, model, clock, ui });
			currentJournal = completion.journal;
			if (completion.note) note = note ? `${note} ${completion.note}` : completion.note;
			const latestTask = currentJournal.run.tasks.find((candidate) => candidate.phase === "building" && currentAttempt(candidate)?.role === "builder");
			const latestAttempt = latestTask ? currentAttempt(latestTask) : undefined;
			if (latestTask?.phase === "building" && latestAttempt?.role === "builder" && latestAttempt.state === "reported" && latestAttempt.evidence?.phase === "finalized" && note.startsWith("Review dispatch pending")) note = `Builder Attempt ${latestAttempt.id} report was validated and finalized.`;
			statusView = completion.completed ? presentCompletedStatus(currentJournal, completion.note) : presentStatusForJournal(currentJournal, note);
		} else if (loaded.kind === "loaded" && target === "command" && controllerSessionId !== undefined && !controllerIdentityMatches(loaded.journal, controllerSessionId)) {
			statusView = presentStatusForJournal(loaded.journal, `Controller Session ${loaded.journal.run.controllerSessionId} is recorded; current Session ${controllerSessionId} is read-only. Run /steward resume --takeover to reconcile and claim ownership.`);
		}
		ui.presentStatus(statusView, target);
		return statusView;
	}

	async function resume(repositoryRoot: string, controllerSessionId: string, takeoverRequested = false): Promise<ResumeResult> {
		if (takeoverRequested) {
			const result = await takeover(repositoryRoot, controllerSessionId);
			ui.presentResumeResult?.(result);
			return result;
		}
		const loaded = await runJournal.loadActive(repositoryRoot);
		let result: ResumeResult;
		if (loaded.kind === "missing") result = { kind: "missing", message: "No active Steward Run exists in this repository." };
		else if (loaded.kind === "migration-ready") result = await applyMigrationResume(repositoryRoot, loaded);
		else if (loaded.kind === "recovered") result = { kind: "recovered", message: `${journalRecoveryMessage(loaded)} Resume is read-only; repair or explicitly choose a schema-only migration before workflow continuation.` };
		else if (loaded.kind === "invalid") result = { kind: "invalid", message: `${journalRecoveryMessage(loaded)} Resume is read-only; no workflow action occurred.` };
		else if (loaded.journal.run.status === "cancelled" || loaded.journal.run.cancellation) result = { kind: "stale", message: `Run ${loaded.journal.run.id} is cancelled; resume is dormant and performed no workflow effect.` };
		else if (!controllerIdentityMatches(loaded.journal, controllerSessionId)) result = { kind: "foreign-session", recordedSessionId: loaded.journal.run.controllerSessionId, currentSessionId: controllerSessionId, message: `The active Steward Run belongs to Controller Session ${loaded.journal.run.controllerSessionId}; resume performed no mutation. Run /steward resume --takeover to reconcile and claim ownership.` };
		else {
			const pass = await advanceNext(repositoryRoot, controllerSessionId, { interactive: true, maximumActions: 1, source: "resume" });
			result = pass.condition === "degraded" ? { kind: "degraded", message: pass.note, result: pass } : { kind: "reconciled", result: pass };
		}
		ui.presentResumeResult?.(result);
		return result;
	}

	async function configure(repositoryRoot: string, proposal?: ControllerSessionProposal): Promise<ConfigureResult> {
		const [recoveryLoad, modelPlansLoad] = await Promise.all([
			runJournal.loadRecoveryDefaults(),
			runJournal.loadModelPlans(repositoryRoot),
		]);
		const loadDiagnostics = [...recoveryLoad.diagnostics, ...modelPlansLoad.diagnostics];
		if (loadDiagnostics.length > 0 || recoveryLoad.value === undefined) {
			const result: ConfigureResult = {
				kind: "load-error",
				diagnostics:
					loadDiagnostics.length > 0
						? loadDiagnostics
						: [{ code: "load-error", message: `Could not load ${recoveryLoad.path}.`, path: recoveryLoad.path }],
				message: "Configuration could not be loaded; no changes were made.",
			};
			ui.presentConfigurationResult(result);
			return result;
		}

		const edit = await ui.editConfiguration({
			recovery: recoveryLoad.value,
			modelPlans: modelPlansLoad.value,
			recoveryPath: recoveryLoad.path,
			modelPlansPath: modelPlansLoad.path,
			modelChoices: model.listModelChoices(),
			proposal,
		});
		if (edit.kind === "cancelled") {
			const result: ConfigureResult = { kind: "cancelled", message: "Cancelled; configuration unchanged." };
			ui.presentConfigurationResult(result);
			return result;
		}

		if (edit.kind === "save-recovery") {
			const validation = validateRecoveryDefaults(edit.recovery, recoveryLoad.path);
			if (!validation.value || validation.diagnostics.length > 0) {
				const result: ConfigureResult = {
					kind: "invalid",
					scope: "recovery",
					path: recoveryLoad.path,
					diagnostics: validation.diagnostics,
					message: "Recovery defaults are invalid; configuration unchanged.",
				};
				ui.presentConfigurationResult(result);
				return result;
			}

			const save = await runJournal.saveRecoveryDefaults(validation.value);
			if (save.kind === "error") {
				const result = resultForSaveFailure("recovery", save);
				ui.presentConfigurationResult(result);
				return result;
			}
			const reloaded = await runJournal.loadRecoveryDefaults();
			if (reloaded.kind === "error" || !reloaded.value) {
				const result: ConfigureResult = {
					kind: "load-error",
					diagnostics:
						reloaded.diagnostics.length > 0
							? reloaded.diagnostics
							: [{ code: "load-error", message: `Could not reload ${reloaded.path}.`, path: reloaded.path }],
					message: `Saved ${save.path}, but could not reload it for confirmation.`,
				};
				ui.presentConfigurationResult(result);
				return result;
			}
			const result: ConfigureResult = {
				kind: "saved",
				scope: "recovery",
				path: reloaded.path,
				message: `Saved and reloaded recovery defaults at ${reloaded.path}: ${formatRecoveryDefaults(reloaded.value)}.`,
			};
			ui.presentConfigurationResult(result);
			return result;
		}

		const structural = validateProjectModelPlans(edit.modelPlans, modelPlansLoad.path);
		const diagnostics = structural.value ? await model.validateModelPlans(structural.value) : structural.diagnostics;
		if (!structural.value || diagnostics.length > 0) {
			const result: ConfigureResult = {
				kind: "invalid",
				scope: "model-plans",
				path: modelPlansLoad.path,
				diagnostics,
				message: "Model Plans are invalid; configuration unchanged.",
			};
			ui.presentConfigurationResult(result);
			return result;
		}

		const save = await runJournal.saveModelPlans(repositoryRoot, structural.value);
		if (save.kind === "error") {
			const result = resultForSaveFailure("model-plans", save);
			ui.presentConfigurationResult(result);
			return result;
		}
		const reloaded = await runJournal.loadModelPlans(repositoryRoot);
		if (reloaded.kind === "error" || !reloaded.value) {
			const result: ConfigureResult = {
				kind: "load-error",
				diagnostics:
					reloaded.diagnostics.length > 0
						? reloaded.diagnostics
						: [{ code: "load-error", message: `Could not reload ${reloaded.path}.`, path: reloaded.path }],
				message: `Saved ${save.path}, but could not reload it for confirmation.`,
			};
			ui.presentConfigurationResult(result);
			return result;
		}
		const result: ConfigureResult = {
			kind: "saved",
			scope: "model-plans",
			path: reloaded.path,
			message: `Saved and reloaded project Model Plans at ${reloaded.path}: ${formatModelPlans(reloaded.value)}.`,
		};
		ui.presentConfigurationResult(result);
		return result;
	}

	function presentStart(result: StartResult): StartResult {
		ui.presentStartResult(result);
		return result;
	}

	function refuse(message: string): StartResult {
		return presentStart({ kind: "refused", message });
	}

	async function start(repositoryRoot: string, controllerSessionId: string): Promise<StartResult> {
		let initialActive: ActiveRunLoadResult;
		try {
			initialActive = await runJournal.loadActive(repositoryRoot);
		} catch (error: unknown) {
			return refuse(`Run Journal could not be inspected; no Run was started. ${error instanceof Error ? error.message : "Read-only inspection failed."}`);
		}
		if (initialActive.kind === "loaded") return refuse(`An active Steward Run already exists at ${initialActive.paths.activePath}; use status, resume, cancel, or cleanup.`);
		if (initialActive.kind !== "missing") return refuse(`${journalRecoveryMessage(initialActive)} Run start is disabled; no workflow or external effect was attempted.`);

		let availability: HerdrAvailability;
		try {
			availability = await herdr.checkAvailability(repositoryRoot);
		} catch (error: unknown) {
			return refuse(`Herdr is unavailable; restore the running compatible server before starting a Run. ${error instanceof Error ? error.message : "Availability check failed."}`);
		}
		if (availability.kind !== "available") return refuse(`Herdr is unavailable; restore the running compatible server before starting a Run. ${availability.message}`);

		let recoveryLoad: ConfigLoadResult<RecoveryDefaults>;
		let modelPlansLoad: ConfigLoadResult<ProjectModelPlans>;
		try {
			[recoveryLoad, modelPlansLoad] = await Promise.all([runJournal.loadRecoveryDefaults(), runJournal.loadModelPlans(repositoryRoot)]);
		} catch (error: unknown) {
			return refuse(`Run start configuration could not be loaded; no changes were made. ${error instanceof Error ? error.message : "Configuration load failed."}`);
		}
		if (recoveryLoad.kind === "error" || !recoveryLoad.value || modelPlansLoad.kind === "error") {
			const diagnostics = [...recoveryLoad.diagnostics, ...modelPlansLoad.diagnostics];
			return refuse(`Run start configuration is invalid; no changes were made. ${diagnostics.map((item) => item.message).join(" ")}`);
		}
		const draftInput: RunDraftInput = {
			recovery: cloneRecoveryDefaults(recoveryLoad.value),
			modelPlans: modelPlansLoad.value ? cloneModelPlans(modelPlansLoad.value) : undefined,
			modelChoices: model.listModelChoices(),
			activeJournalPath: initialActive.paths.activePath,
			activityLogDirectory: initialActive.paths.activityRoot,
		};
		let draftResult: RunDraftResult;
		try {
			draftResult = await ui.draftRun(draftInput);
		} catch (error: unknown) {
			return refuse(`Run draft could not be collected; no changes were made. ${error instanceof Error ? error.message : "Interactive draft failed."}`);
		}
		if (draftResult.kind === "cancelled") return presentStart({ kind: "cancelled", message: "Cancelled; no Run was started." });
		const draftValidation = validateRunDraft(draftResult.draft, recoveryLoad.value);
		if (!draftValidation.value || draftValidation.diagnostics.length > 0) return refuse(`The Run draft is invalid; no Run was started. ${draftValidation.diagnostics.map((item) => item.message).join(" ")}`);
		const draft = draftValidation.value;
		const identity = createRunIdentity(clock.now(), clock.randomUUID());
		const effectiveSettings = cloneRecoveryDefaults(draft.effectiveSettings ?? recoveryLoad.value);
		const settingsValidation = validateRecoveryDefaults(effectiveSettings, "run.effectiveSettings");
		if (!settingsValidation.value || settingsValidation.diagnostics.length > 0) return refuse("Effective settings are invalid; no Run was started.");

		let modelDiagnostics: ConfigDiagnostic[];
		try {
			modelDiagnostics = await model.validateModelPlans(draft.modelPlan);
		} catch (error: unknown) {
			return refuse(`Required Model Plans could not be validated; no Run was started. ${error instanceof Error ? error.message : "Model validation failed."}`);
		}
		if (modelDiagnostics.length > 0) return refuse(`Required Model Plans are unavailable; no substitution was made. ${modelDiagnostics.map((item) => `${item.code}${item.role ? ` ${item.role}[${item.index ?? 0}]` : ""} ${item.reference ?? ""}: ${item.message}`).join(" ")}`);

		let integrationBase: IntegrationBase = { kind: "none" };
		if (isCodeChanging(draft.tasks)) {
			let inspection: IntegrationBaseInspection;
			try {
				inspection = await git.inspectIntegrationBase(repositoryRoot);
			} catch (error: unknown) {
				return refuse(`Git integration base is unavailable; no Run was started. ${error instanceof Error ? error.message : "Git inspection failed."}`);
			}
			if (inspection.kind !== "ready") return refuse(`Git integration base is unavailable; no Run was started. ${inspection.message}`);
			integrationBase = { kind: "git", branch: inspection.branch, revision: inspection.revision };
		}
		let journal: RunJournal;
		try {
			journal = buildInitialRunJournal({ identity, controllerSessionId, draft, modelPlan: draft.modelPlan, effectiveSettings: settingsValidation.value, integrationBase });
		} catch (error: unknown) {
			return refuse(`Run draft is invalid; no Run was started. ${error instanceof Error ? error.message : "Run validation failed."}`);
		}
		const summary = buildRunConfirmationSummary({ journal, activeJournalPath: initialActive.paths.activePath, activityLogPath: `${initialActive.paths.activityRoot}/${journal.run.id}/activity.log` });
		let confirmed: boolean;
		try {
			confirmed = await ui.confirmRun(summary);
		} catch (error: unknown) {
			return refuse(`Run confirmation failed; no Run was started. ${error instanceof Error ? error.message : "Interactive confirmation failed."}`);
		}
		if (!confirmed) return presentStart({ kind: "cancelled", message: "Cancelled; no Run was started." });

		let confirmedActive: ActiveRunLoadResult;
		try {
			confirmedActive = await runJournal.loadActive(repositoryRoot);
		} catch (error: unknown) {
			return refuse(`The active Run state could not be rechecked after confirmation; start again. ${error instanceof Error ? error.message : "Read-only inspection failed."}`);
		}
		if (confirmedActive.kind !== "missing") return refuse("The active Run state changed during confirmation; start again without changing the confirmed draft.");
		let confirmedHerdr: HerdrAvailability;
		try {
			confirmedHerdr = await herdr.checkAvailability(repositoryRoot);
		} catch (error: unknown) {
			return refuse(`Herdr changed during confirmation; start again. ${error instanceof Error ? error.message : "Availability recheck failed."}`);
		}
		if (confirmedHerdr.kind !== "available") return refuse(`Herdr changed during confirmation; start again. ${confirmedHerdr.message}`);
		let confirmedModelDiagnostics: ConfigDiagnostic[];
		try {
			confirmedModelDiagnostics = await model.validateModelPlans(journal.run.modelPlan);
		} catch (error: unknown) {
			return refuse(`Required Model Plans changed during confirmation; start again. ${error instanceof Error ? error.message : "Model validation failed."}`);
		}
		if (confirmedModelDiagnostics.length > 0) return refuse(`Required Model Plans changed during confirmation; start again. ${confirmedModelDiagnostics.map((item) => item.message).join(" ")}`);
		if (journal.run.integrationBase.kind === "git") {
			let confirmedGit: IntegrationBaseInspection;
			try {
				confirmedGit = await git.inspectIntegrationBase(repositoryRoot);
			} catch (error: unknown) {
				return refuse(`Git branch, revision, or clean-base state changed during confirmation; start again. ${error instanceof Error ? error.message : "Git recheck failed."}`);
			}
			if (confirmedGit.kind !== "ready" || confirmedGit.branch !== journal.run.integrationBase.branch || confirmedGit.revision !== journal.run.integrationBase.revision) return refuse("Git branch, revision, or clean-base state changed during confirmation; start again.");
		}
		const validated = validateRunJournal(journal, initialActive.paths.activePath);
		if (!validated.value || validated.diagnostics.length > 0) return refuse("The confirmed Run Journal failed strict validation; no Run was started.");
		let created: CreateActiveResult;
		try {
			created = await runJournal.createActive(repositoryRoot, validated.value);
		} catch (error: unknown) {
			return presentStart({ kind: "storage-error", message: `Run Journal could not be created; no Run was started. ${error instanceof Error ? error.message : "Storage failed."}` });
		}
		if (created.kind === "active-exists") return refuse("Another active Run won the start race; no Run was overwritten.");
		if (created.kind !== "created") return presentStart({ kind: "storage-error", message: `Run Journal could not be created at ${created.paths.activePath}; no Run was started. ${created.diagnostics.map((item) => item.message).join(" ")}` });
		const startWarnings: string[] = [];
		try {
			const activity = await runJournal.appendActivity(repositoryRoot, { timestamp: validated.value.run.createdAt, runId: validated.value.run.id, event: "run-started", message: "Run Journal created; all Tasks are pending." });
			if (activity.kind !== "appended") startWarnings.push(`non-authoritative activity logging is degraded at ${activity.path}.`);
		} catch (error: unknown) {
			startWarnings.push(`non-authoritative activity logging is degraded: ${error instanceof Error ? error.message : "Activity append failed."}`);
		}
		const dispatch = await dispatchInitialBuilder({ repositoryRoot, controllerSessionId, journal: validated.value, dependencies: { runJournal, herdr, git, process, model, clock, ui } });
		const warnings = [...startWarnings, ...dispatch.warnings];
		const warningText = warnings.length > 0 ? ` Warnings: ${warnings.join(" ")}` : "";
		if (dispatch.kind === "pending") {
			if (startWarnings.length > 0) return presentStart({ kind: "started-with-warning", journal: dispatch.journal, message: `${dispatch.message}${warningText} The active-run.json Journal remains authoritative.` });
			return presentStart({ kind: "started-dispatch-pending", journal: dispatch.journal, message: `${dispatch.message}${warningText} The active-run.json Journal remains authoritative.` });
		}
		if (warnings.length > 0) return presentStart({ kind: "started-and-dispatched-with-warning", journal: dispatch.journal, message: `${dispatch.message}${warningText}` });
		return presentStart({ kind: "started-and-dispatched", journal: dispatch.journal, message: dispatch.message });
	}

	function presentRevision(result: RevisionResult): RevisionResult {
		ui.presentRevisionResult?.(result);
		return result;
	}

	function revisionStopForAttempt(attempt: AttemptRecord, timestamp: string): RecoveryStop {
		const identity = recoveryIdentityFor(attempt);
		return identity ? { phase: "intended", intendedAt: timestamp, agent: identity } : { phase: "not-required", reason: "never-started" };
	}

	function revisionPreview(journal: RunJournal, draft: RunRevisionDraft): { taskDeltas: RunRevisionTaskDelta[]; modelPlanDelta?: RunRevisionModelPlanDelta } {
		const taskDeltas: RunRevisionTaskDelta[] = [];
		for (let index = 0; index < journal.run.tasks.length; index += 1) {
			const task = journal.run.tasks[index]!;
			const proposed = draft.tasks[index]!;
			if (JSON.stringify(task.contract) === JSON.stringify(proposed.contract)) continue;
			const currentAttempts = task.attempts.filter((attempt) => attemptSpecificationVersion(attempt) === task.specificationVersion);
			const cancelledAttemptIds = currentAttempts.filter((attempt) => ["prepared", "active", "awaiting-report"].includes(attempt.state)).map((attempt) => attempt.id);
			const invalidatedReviewerAttempts = currentAttempts.filter((attempt): attempt is ReviewerAttemptRecord => attempt.role === "reviewer" && attempt.evidence?.phase === "finalized").map((attempt) => ({ attemptId: attempt.id, manifestPath: attempt.evidence!.manifestPath, manifestSha256: attempt.evidence!.manifestSha256 }));
			const prior = cloneRunJournal(journal).run.tasks[index]!;
			taskDeltas.push({
				taskId: task.contract.id,
				before: { specificationVersion: task.specificationVersion, specificationHash: task.specificationHash, contract: prior.contract },
				after: { specificationVersion: task.specificationVersion + 1, specificationHash: specificationHash(proposed.contract), contract: JSON.parse(JSON.stringify(proposed.contract)) as TaskRecord["contract"] },
				priorReworkCycles: task.reworkCycles,
				cancelledAttemptIds,
				invalidatedReviewerAttempts,
				...(prior.approval ? { priorApproval: prior.approval } : {}),
				...(prior.integration ? { priorIntegration: prior.integration } : {}),
				...(prior.integrationRecoveries ? { priorIntegrationRecoveries: prior.integrationRecoveries } : {}),
				...(prior.finalVerificationReworks ? { priorFinalVerificationReworks: prior.finalVerificationReworks } : {}),
			});
		}
		const modelPlanDelta = JSON.stringify(journal.run.modelPlan) === JSON.stringify(draft.modelPlan) ? undefined : { before: cloneModelPlans(journal.run.modelPlan), after: cloneModelPlans(draft.modelPlan) };
		return { taskDeltas, ...(modelPlanDelta ? { modelPlanDelta } : {}) };
	}

	async function persistRevisionStop(repositoryRoot: string, journal: RunJournal, taskId: string, attemptId: string, stop: RecoveryStop, diagnosticText?: string): Promise<RunJournal | undefined> {
		try {
			const candidate = advanceRunJournal(journal, clock.now(), (next) => {
				const task = next.run.tasks.find((item) => item.contract.id === taskId);
				const attempt = task?.attempts.find((item) => item.id === attemptId);
				if (!task || !attempt || attempt.state !== "cancelled" || !attempt.revisionCancellation) throw new Error("Revision stop target disappeared.");
				attempt.revisionCancellation.stop = stop;
				if (stop.phase === "ambiguous") {
					task.attention = "needs-user";
					task.attentionReason = "revision-stop-ambiguous";
					task.attentionDiagnostic = (diagnosticText ?? stop.diagnostic).slice(0, 2_000);
				}
			});
			const replaced = await runJournal.replaceActive(repositoryRoot, candidate);
			return replaced.kind === "replaced" ? replaced.journal : undefined;
		} catch { return undefined; }
	}

	async function reconcileRevisionStops(repositoryRoot: string, journal: RunJournal, controllerSessionId: string, directStop = false): Promise<{ journal: RunJournal; note: string; ambiguous: boolean }> {
		let current = journal;
		for (const task of current.run.tasks) for (const attempt of task.attempts) {
			const cancellation = attempt.revisionCancellation;
			if (attempt.state !== "cancelled" || !cancellation) continue;
			if (cancellation.stop.phase === "ambiguous") return { journal: current, note: "A prior revision stop remains ambiguous; the revised Task is blocked and no new Builder was admitted.", ambiguous: true };
			if (cancellation.stop.phase !== "intended") continue;
			const identity = cancellation.stop.agent;
			if (current.run.controllerSessionId !== controllerSessionId) return { journal: current, note: "Controller ownership changed while reconciling a revision stop; no effect was attempted.", ambiguous: true };
			if (!directStop) {
				let inspection: ManagedAgentInspection | undefined;
				try { inspection = herdr.inspectManagedAgent ? await herdr.inspectManagedAgent(identity) : undefined; } catch (error: unknown) { inspection = { kind: "unclear", diagnostic: error instanceof Error ? error.message : "Managed Agent inspection failed." }; }
				if (inspection?.kind === "missing") {
					const acknowledged: RecoveryStop = { phase: "acknowledged", intendedAt: cancellation.stop.intendedAt, acknowledgedAt: transitionTimestamp(current, clock.now()), agent: identity };
					const persisted = await persistRevisionStop(repositoryRoot, current, task.contract.id, attempt.id, acknowledged);
					if (!persisted) return { journal: current, note: "Revision stop acknowledgement lost its Journal race; resume will reconcile before admission.", ambiguous: true };
					current = persisted;
					continue;
				}
				if (inspection?.kind !== "observed" || !exactIdentity(inspection.identity, identity)) {
					const diagnosticText = inspection?.kind === "unclear" ? inspection.diagnostic : "The exact revision-stop Agent identity was not observable.";
					const ambiguous: RecoveryStop = { phase: "ambiguous", intendedAt: cancellation.stop.intendedAt, observedAt: transitionTimestamp(current, clock.now()), agent: identity, diagnostic: diagnosticText.slice(0, 2_000) };
					const persisted = await persistRevisionStop(repositoryRoot, current, task.contract.id, attempt.id, ambiguous, diagnosticText);
					return { journal: persisted ?? current, note: "Revision stop is ambiguous; the revised Task remains blocked and no new Builder was admitted.", ambiguous: true };
				}
			}
			if (!herdr.stopAgentGracefully) {
				const ambiguous: RecoveryStop = { phase: "ambiguous", intendedAt: cancellation.stop.intendedAt, observedAt: transitionTimestamp(current, clock.now()), agent: identity, diagnostic: "Graceful Agent stop adapter is unavailable." };
				const persisted = await persistRevisionStop(repositoryRoot, current, task.contract.id, attempt.id, ambiguous, ambiguous.diagnostic);
				return { journal: persisted ?? current, note: "Revision stop is ambiguous because graceful stop is unavailable; no new Builder was admitted.", ambiguous: true };
			}
			let stopped: HerdrStopResult;
			try { stopped = await herdr.stopAgentGracefully({ repositoryRoot, name: identity.name, workspaceId: identity.workspaceId, paneId: identity.paneId, terminalId: identity.terminalId }); } catch (error: unknown) { stopped = { kind: "ambiguous", message: error instanceof Error ? error.message : "Graceful Agent stop failed." }; }
			if (stopped.kind !== "acknowledged" || stopped.name !== identity.name || stopped.workspaceId !== identity.workspaceId || stopped.paneId !== identity.paneId || stopped.terminalId !== identity.terminalId) {
				const diagnosticText = stopped.kind === "acknowledged" ? "Graceful stop returned a foreign Agent identity." : stopped.message;
				const ambiguous: RecoveryStop = { phase: "ambiguous", intendedAt: cancellation.stop.intendedAt, observedAt: transitionTimestamp(current, clock.now()), agent: identity, diagnostic: diagnosticText.slice(0, 2_000) };
				const persisted = await persistRevisionStop(repositoryRoot, current, task.contract.id, attempt.id, ambiguous, diagnosticText);
				return { journal: persisted ?? current, note: "Revision stop is ambiguous; the revised Task remains blocked and no new Builder was admitted.", ambiguous: true };
			}
			const acknowledged: RecoveryStop = { phase: "acknowledged", intendedAt: cancellation.stop.intendedAt, acknowledgedAt: transitionTimestamp(current, clock.now()), agent: identity };
			const persisted = await persistRevisionStop(repositoryRoot, current, task.contract.id, attempt.id, acknowledged);
			if (!persisted) return { journal: current, note: "Revision stop acknowledgement lost its Journal race; resume will reconcile before admission.", ambiguous: true };
			current = persisted;
		}
		return { journal: current, note: "All revision stop intents are durably acknowledged.", ambiguous: false };
	}

	async function revise(repositoryRoot: string, controllerSessionId: string): Promise<RevisionResult> {
		let loaded: ActiveRunLoadResult;
		try { loaded = await runJournal.loadActive(repositoryRoot); } catch (error: unknown) { return presentRevision({ kind: "invalid", message: `Revision could not inspect the active Run; no mutation occurred. ${error instanceof Error ? error.message : "Read-only inspection failed."}` }); }
		if (loaded.kind === "missing") return presentRevision({ kind: "missing", message: "No active Steward Run exists; revision performed no mutation." });
		if (loaded.kind !== "loaded") return presentRevision({ kind: "invalid", message: `${journalRecoveryMessage(loaded)} Revision performed no mutation or external effect.` });
		const basis = loaded.journal;
		if (basis.run.status !== "active" || basis.run.completion?.phase === "archived") return presentRevision({ kind: "refused", message: "Only an active, non-completing Steward Run can be revised; no mutation occurred." });
		const finalExecution = basis.run.finalVerificationExecution;
		if (finalExecution && ((isRecoverableFinalVerificationExecution(finalExecution) && (finalExecution.phase === "executing" || finalExecution.phase === "ambiguous")) || (!isRecoverableFinalVerificationExecution(finalExecution) && finalExecution.phase === "intended"))) return presentRevision({ kind: "refused", message: "Revision is refused while final verification is intended, executing, or ambiguous; no mutation occurred." });
		if (!controllerIdentityMatches(basis, controllerSessionId)) return presentRevision({ kind: "foreign-session", recordedSessionId: basis.run.controllerSessionId, currentSessionId: controllerSessionId, message: `The active Run belongs to Controller Session ${basis.run.controllerSessionId}; revision performed no mutation. Use /steward resume --takeover explicitly.` });
		if (!ui.draftRunRevision || !ui.confirmRunRevision) return presentRevision({ kind: "refused", message: "Revision UI is unavailable; no mutation occurred." });
		const draftInput: RunRevisionDraftInput = {
			runId: basis.run.id,
			tasks: basis.run.tasks.map((task) => ({ id: task.contract.id, contract: JSON.parse(JSON.stringify(task.contract)) as TaskRecord["contract"] })),
			modelPlan: cloneModelPlans(basis.run.modelPlan),
			modelChoices: model.listModelChoices(),
			activeJournalPath: loaded.paths.activePath,
			activityLogPath: `${loaded.paths.activityRoot}/${basis.run.id}/activity.log`,
		};
		let draftResult: RunRevisionDraftResult;
		try { draftResult = await ui.draftRunRevision(draftInput); } catch (error: unknown) { return presentRevision({ kind: "cancelled", message: `Revision draft was not collected; no mutation occurred. ${error instanceof Error ? error.message : "Interactive draft failed."}` }); }
		if (draftResult.kind === "cancelled") return presentRevision({ kind: "cancelled", message: "Revision cancelled; the active Run and all evidence remain unchanged." });
		const draftValidation = validateRunRevisionDraft(draftResult.draft, basis);
		if (!draftValidation.value || draftValidation.diagnostics.length > 0) return presentRevision({ kind: "refused", message: `Revision draft is invalid; no mutation occurred. ${draftValidation.diagnostics.map((item) => item.message).join(" ")}` });
		const draft = draftValidation.value;
		const preview = revisionPreview(basis, draft);
		const summary = buildRunRevisionConfirmationSummary({ journal: basis, draft, taskDeltas: preview.taskDeltas, modelPlanDelta: preview.modelPlanDelta, basisJournalRevision: basis.journalRevision });
		let confirmed: boolean;
		try { confirmed = await ui.confirmRunRevision(summary); } catch (error: unknown) { return presentRevision({ kind: "cancelled", message: `Revision confirmation failed; no mutation occurred. ${error instanceof Error ? error.message : "Interactive confirmation failed."}` }); }
		if (!confirmed) return presentRevision({ kind: "cancelled", message: "Revision cancelled; the active Run and all evidence remain unchanged." });
		let confirmedModelDiagnostics: ConfigDiagnostic[];
		try { confirmedModelDiagnostics = await model.validateModelPlans(draft.modelPlan); } catch (error: unknown) { return presentRevision({ kind: "refused", message: `The revised Model Plan could not be validated; no mutation occurred. ${error instanceof Error ? error.message : "Model validation failed."}` }); }
		if (confirmedModelDiagnostics.length > 0) return presentRevision({ kind: "refused", message: `The revised Model Plan is unavailable; no mutation occurred. ${confirmedModelDiagnostics.map((item) => item.message).join(" ")}` });
		let reloaded: ActiveRunLoadResult;
		try { reloaded = await runJournal.loadActive(repositoryRoot); } catch (error: unknown) { return presentRevision({ kind: "stale", message: `The active Run could not be rechecked after confirmation; no mutation occurred. ${error instanceof Error ? error.message : "Read-only inspection failed."}` }); }
		if (reloaded.kind !== "loaded" || reloaded.journal.run.id !== basis.run.id || reloaded.journal.journalRevision !== basis.journalRevision || reloaded.journal.run.controllerSessionId !== basis.run.controllerSessionId || JSON.stringify(reloaded.journal.run.controllerLease) !== JSON.stringify(basis.run.controllerLease)) return presentRevision({ kind: "stale", message: "The active Run changed during confirmation; no revision, activity, stop, or dispatch effect was attempted." });
		const confirmedValidation = validateRunRevisionDraft(draft, reloaded.journal);
		if (!confirmedValidation.value || confirmedValidation.diagnostics.length > 0) return presentRevision({ kind: "stale", message: "The confirmed revision no longer matches the active Run; no mutation occurred." });
		const revisionNumber = (reloaded.journal.run.revisions?.at(-1)?.revision ?? 1) + 1;
		const confirmedPreview = revisionPreview(reloaded.journal, confirmedValidation.value);
		const confirmedAt = transitionTimestamp(reloaded.journal, clock.now());
		let candidate: RunJournal;
		try {
			candidate = advanceRunJournal(reloaded.journal, clock.now(), (next) => {
				const revision: RunRevisionRecord = { revision: revisionNumber, confirmedAt, controllerSessionId, basisJournalRevision: reloaded.journal.journalRevision, taskDeltas: confirmedPreview.taskDeltas.map((delta) => ({ ...delta, cancelledAttemptIds: [...delta.cancelledAttemptIds], invalidatedReviewerAttempts: delta.invalidatedReviewerAttempts.map((reviewer) => ({ ...reviewer })) })), ...(confirmedPreview.modelPlanDelta ? { modelPlanDelta: confirmedPreview.modelPlanDelta } : {}) };
				for (const delta of revision.taskDeltas) {
					const task = next.run.tasks.find((item) => item.contract.id === delta.taskId);
					if (!task) throw new Error("Revision Task disappeared before CAS.");
					const oldVersion = task.specificationVersion;
					for (const attempt of task.attempts) {
						if (attemptSpecificationVersion(attempt) !== oldVersion || !["prepared", "active", "awaiting-report"].includes(attempt.state)) continue;
						const previousState = attempt.state as "prepared" | "active" | "awaiting-report";
						const stop = revisionStopForAttempt(attempt, confirmedAt);
						attempt.state = "cancelled";
						attempt.revisionCancellation = { reason: "task-specification-revised", cancelledAt: confirmedAt, previousState, oldSpecificationVersion: oldVersion, oldSpecificationHash: task.specificationHash, replacementSpecificationVersion: oldVersion + 1, replacementSpecificationHash: delta.after.specificationHash, owningRunRevision: revisionNumber, stop };
					}
					task.contract = JSON.parse(JSON.stringify(delta.after.contract)) as TaskRecord["contract"];
					task.specificationVersion = delta.after.specificationVersion;
					task.specificationHash = delta.after.specificationHash;
					task.phase = "pending";
					task.reworkCycles = 0;
					task.attention = "none";
					delete task.attentionDiagnostic;
					delete task.attentionReason;
					if (task.approval?.phase === "valid") task.approval = { ...task.approval, phase: "invalidated", invalidatedAt: confirmedAt, reason: "task-specification-revised", diagnostic: `Task specification revised from ${delta.before.specificationHash} to ${delta.after.specificationHash}.` };
					else delete task.approval;
					delete task.integration;
					delete task.integrationRecoveries;
					delete task.finalVerificationReworks;
				}
				if (confirmedPreview.modelPlanDelta) next.run.modelPlan = cloneModelPlans(confirmedPreview.modelPlanDelta.after);
				if (next.run.finalVerificationExecution && revision.taskDeltas.length > 0 && (next.run.finalVerificationExecution.phase === "passed" || next.run.finalVerificationExecution.phase === "failed")) {
					revision.invalidatedFinalVerification = { execution: next.run.finalVerificationExecution, invalidatedAt: confirmedAt, reason: "task-specification-revised" };
					delete next.run.finalVerificationExecution;
				}
				if (next.run.monitor && revision.taskDeltas.some((delta) => delta.taskId === next.run.monitor?.taskId)) delete next.run.monitor;
				if (next.run.monitors) next.run.monitors = next.run.monitors.filter((monitor) => !revision.taskDeltas.some((delta) => delta.taskId === monitor.taskId));
				next.run.revisions = next.run.revisions ? [...next.run.revisions, revision] : [revision];
			});
		} catch (error: unknown) { return presentRevision({ kind: "refused", message: `Revision candidate failed strict validation; no mutation occurred. ${error instanceof Error ? error.message : "Journal validation failed."}` }); }
		let replaced: import("./run-journal-store.ts").ReplaceActiveResult;
		try { replaced = await runJournal.replaceActive(repositoryRoot, candidate); } catch (error: unknown) { return presentRevision({ kind: "stale", message: `Revision CAS failed; no external effect was attempted. ${error instanceof Error ? error.message : "Storage failed."}` }); }
		if (replaced.kind !== "replaced") return presentRevision({ kind: "stale", message: "Revision CAS lost its race; no external effect was attempted." });
		let current = replaced.journal;
		try { await runJournal.appendActivity(repositoryRoot, { timestamp: current.run.updatedAt, runId: current.run.id, event: "run-revised", message: `Run revision ${revisionNumber} confirmed; changed Tasks: ${confirmedPreview.taskDeltas.map((delta) => delta.taskId).join(", ") || "none"}.` }); } catch { /* authoritative Journal already records the revision */ }
		const reconciled = await reconcileRevisionStops(repositoryRoot, current, controllerSessionId, true);
		current = reconciled.journal;
		if (reconciled.ambiguous) return presentRevision({ kind: "ambiguous", journal: current, message: reconciled.note });
		return presentRevision({ kind: "revised", journal: current, message: `Run ${current.run.id} revised at specification revision ${revisionNumber}; no new Builder was dispatched in this command.` });
	}

	const monitorDependencies: StewardDependencies = { runJournal, herdr, git, process, model, clock, ui };

	type SilencePass = { kind: "none" | "changed" | "degraded" | "effect"; journal: RunJournal; note: string; action?: MonitorWorkflowAction; diagnostic?: string; notification?: boolean };

	async function persistSilence(repositoryRoot: string, journal: RunJournal, taskIndex: number, attemptId: string, update: (task: TaskRecord, attempt: AttemptRecord, nextJournal: RunJournal) => void): Promise<RunJournal | undefined> {
		let candidate: RunJournal;
		try {
			candidate = advanceRunJournal(journal, clock.now(), (next) => {
				const task = next.run.tasks[taskIndex];
				const attempt = task?.attempts.find((item) => item.id === attemptId);
				if (!task || !attempt) throw new Error("Silence Attempt disappeared before the durable transition.");
				update(task, attempt, next);
			});
			} catch { return undefined; }
		const replaced = await runJournal.replaceActive(repositoryRoot, candidate).catch(() => undefined);
		return replaced?.kind === "replaced" ? replaced.journal : undefined;
	}

	function silenceAttention(task: TaskRecord, attention: TaskRecord["attention"], reason?: TaskAttentionReason, diagnostic?: string): void {
		task.attention = attention;
		if (reason) task.attentionReason = reason; else delete task.attentionReason;
		if (diagnostic) task.attentionDiagnostic = diagnostic.slice(0, 2_000); else delete task.attentionDiagnostic;
	}

	function ticket11Attention(task: TaskRecord): boolean {
		return task.attention === "waiting-external" || task.attention === "suspected-stall" || (task.attention === "recovering" && task.attentionReason === "silence-effect-ambiguous") || (task.attention === "needs-user" && task.attentionReason === "silence-recovery-exhausted");
	}

	async function advanceSilenceRecovery(repositoryRoot: string, journalInput: RunJournal, taskIndex: number, taskInput: TaskRecord, attemptInput: AttemptRecord): Promise<SilencePass> {
		if (!hasProvenAgentIdentity(attemptInput) || attemptInput.state !== "active") return { kind: "none", journal: journalInput, note: "The current Attempt is not an active proven resource for silence recovery." };
		const identity = attemptIdentity(attemptInput);
		if (!identity) return { kind: "none", journal: journalInput, note: "The current Attempt has no exact identity for silence recovery." };
		const inspected = await inspectSilenceAttempt(repositoryRoot, taskInput, attemptInput, identity, monitorDependencies);
		const existingSilence = attemptInput.recovery?.silence;
		if (inspected.kind === "incomplete" && !inspected.snapshot) return { kind: "degraded", journal: journalInput, note: `Passive silence inspection was incomplete; no recovery input was attempted. ${inspected.diagnostic}`, diagnostic: inspected.diagnostic };
		const snapshot = inspected.snapshot;
		if (!snapshot) return { kind: "degraded", journal: journalInput, note: "Passive silence inspection returned no bounded snapshot; no recovery input was attempted.", diagnostic: "Missing passive silence snapshot." };
		if (existingSilence?.phase === "exhausted") return { kind: "none", journal: journalInput, note: "Silent-agent recovery is durably exhausted; no replacement effect will be repeated." };
		const now = clock.now().getTime();
		const nowIso = transitionTimestamp(journalInput, clock.now());
		const previousSnapshot = existingSilence?.inspection;
		const sourceChanged = previousSnapshot !== undefined && silenceSnapshotsChanged(previousSnapshot, snapshot);
		const processObservation = snapshot.process;
		const priorProcess = previousSnapshot?.process;
		const processChanged = previousSnapshot !== undefined && silenceProcessChanged(priorProcess, processObservation);
		const progressChanged = sourceChanged || processChanged;
		const baseLive = attemptInput.recovery?.live ?? recoveryLiveRecord({ observedAt: nowIso, kind: "working", lifecycle: "working", stateChangeSequence: snapshot.stateChangeSequence });
		const persistPhase = async (phase: SilencePhase, attention: TaskRecord["attention"], reason?: TaskAttentionReason, diagnostic?: string, preserve?: import("./run.ts").RecoveryPreservation): Promise<RunJournal | undefined> => persistSilence(repositoryRoot, journalInput, taskIndex, attemptInput.id, (task, attempt) => {
			const existing = attempt.recovery;
			attempt.recovery = { live: { ...baseLive, observedAt: nowIso, lifecycle: "working", stateChangeSequence: snapshot.stateChangeSequence }, ...(existing?.reportRequest ? { reportRequest: existing.reportRequest } : {}), ...(existing?.blockedAnswer ? { blockedAnswer: existing.blockedAnswer } : {}), ...(preserve ? { preservation: preserve } : existing?.preservation ? { preservation: existing.preservation } : {}), silence: phase };
			silenceAttention(task, attention, reason, diagnostic);
		});
		if (existingSilence && ["nudge-intended", "nudge-ambiguous", "interrupt-intended", "interrupt-ambiguous", "resume-intended", "resume-ambiguous"].includes(existingSilence.phase)) {
			if (existingSilence.phase.endsWith("ambiguous") || existingSilence.phase.endsWith("intended") && (inspected.kind !== "complete" || snapshot.process.kind !== "none")) {
				return { kind: "none", journal: journalInput, note: existingSilence.phase.endsWith("ambiguous") ? "A silence recovery effect is ambiguous; its durable tombstone forbids any resend." : "A silence recovery effect remains unresolved while passive inspection is incomplete or an external process is live; no duplicate input will be sent." };
			}
			const observedAt = transitionTimestamp(journalInput, clock.now());
			const diagnostic = "A prior silence recovery effect has no durable acknowledgement; its external result is ambiguous and will not be repeated.";
			const ambiguous = await persistSilence(repositoryRoot, journalInput, taskIndex, attemptInput.id, (task, attempt) => {
				const current = attempt.recovery?.silence;
				if (!current || current.phase !== existingSilence.phase) throw new Error("Silence effect intent disappeared before ambiguity persistence.");
				const silence: SilencePhase = current.phase === "nudge-intended"
					? { ...current, phase: "nudge-ambiguous", phaseAt: observedAt, observedAt, diagnostic }
					: current.phase === "interrupt-intended"
						? { ...current, phase: "interrupt-ambiguous", phaseAt: observedAt, observedAt, diagnostic }
					: current.phase === "resume-intended"
						? { ...current, phase: "resume-ambiguous", phaseAt: observedAt, observedAt, diagnostic }
					: current;
				attempt.recovery = { ...(attempt.recovery ?? { live: baseLive }), live: { ...baseLive, observedAt }, silence };
				silenceAttention(task, "recovering", "silence-effect-ambiguous", diagnostic);
			});
			return ambiguous ? { kind: "changed", journal: ambiguous, note: "A silence recovery intent lacked a durable acknowledgement; ambiguity was recorded and no effect was repeated.", action: "record-observation", diagnostic } : { kind: "degraded", journal: journalInput, note: "A silence recovery intent lacked a durable acknowledgement, but its ambiguity could not be persisted; no effect will be repeated.", diagnostic };
		}

		if (inspected.kind === "incomplete") {
			const phase: SilencePhase = { phase: "inspection-incomplete", lastProgressAt: existingSilence?.lastProgressAt ?? attemptInput.activatedAt ?? attemptInput.preparedAt, phaseAt: existingSilence?.phaseAt ?? nowIso, inspection: snapshot, diagnostic: inspected.diagnostic };
			if (existingSilence?.phase === "inspection-incomplete" && existingSilence.diagnostic === inspected.diagnostic && !sourceChanged) return { kind: "degraded", journal: journalInput, note: `Passive silence inspection remains incomplete; no recovery input was attempted. ${inspected.diagnostic}`, diagnostic: inspected.diagnostic };
			const persisted = await persistPhase(phase, "suspected-stall", "silence-passive-inspection", inspected.diagnostic);
			return persisted ? { kind: "changed", journal: persisted, note: `Passive silence inspection is incomplete; recovery effects are forbidden. ${inspected.diagnostic}`, diagnostic: inspected.diagnostic } : { kind: "degraded", journal: journalInput, note: "Incomplete passive silence inspection could not be persisted; no recovery input was attempted.", diagnostic: inspected.diagnostic };
		}

		if (processObservation.kind === "live-external") {
			const priorExternalPhase = existingSilence?.phase === "waiting-external" || existingSilence?.phase === "external-grace" ? existingSilence : undefined;
			const priorLive = priorExternalPhase?.process;
			const sameProcess = priorLive && priorLive.digest === processObservation.digest && priorLive.paneId === processObservation.paneId && priorLive.foregroundProcessGroupId === processObservation.foregroundProcessGroupId;
			const firstObservedAt = sameProcess && priorExternalPhase ? priorExternalPhase.firstObservedAt : nowIso;
			const warnedAt = sameProcess ? priorExternalPhase?.warnedAt : undefined;
			const warningDue = !warnedAt && now >= new Date(firstObservedAt).getTime() + journalInput.run.effectiveSettings.externalCommandWarningThresholdSeconds * 1_000;
			const phase: SilencePhase = { phase: "waiting-external", lastProgressAt: existingSilence?.lastProgressAt ?? nowIso, phaseAt: sameProcess && priorExternalPhase ? priorExternalPhase.phaseAt : nowIso, inspection: snapshot, firstObservedAt, lastObservedAt: nowIso, process: processObservation, ...(warningDue ? { warnedAt: nowIso } : warnedAt ? { warnedAt } : {}) };
			if (!sameProcess || existingSilence?.phase !== "waiting-external" || warningDue) {
				const persisted = await persistPhase(phase, "waiting-external", "external-process-live", "A foreground external process is live; Steward is waiting without sending input.");
				return persisted ? { kind: "changed", journal: persisted, note: warningDue ? `External ${processObservation.classification} process remains live; warning threshold reached and no input was sent.` : `External ${processObservation.classification} process is live; deadlines are suspended without input.`, notification: warningDue } : { kind: "degraded", journal: journalInput, note: "External-process waiting state could not be persisted; no input was sent.", diagnostic: "Silence journal CAS failed." };
			}
			return { kind: "none", journal: journalInput, note: "The same external process remains live; no input or replacement effect was attempted." };
		}

		if ((existingSilence?.phase === "waiting-external" || existingSilence?.phase === "external-grace") && priorProcess?.kind === "live-external" && processObservation.kind === "none" && processChanged) {
			const phase: SilencePhase = { phase: "external-grace", lastProgressAt: existingSilence.lastProgressAt, phaseAt: nowIso, inspection: snapshot, firstObservedAt: existingSilence.firstObservedAt, lastObservedAt: existingSilence.lastObservedAt, exitedAt: nowIso, process: priorProcess, ...(existingSilence.warnedAt ? { warnedAt: existingSilence.warnedAt } : {}) };
			const persisted = await persistPhase(phase, "waiting-external", "external-process-grace", "The exact external process exited; the grace period is active and no input was sent.");
			return persisted ? { kind: "changed", journal: persisted, note: "The external process exited; no recovery input is permitted until the grace period ends." } : { kind: "degraded", journal: journalInput, note: "External-process grace could not be persisted; no input was sent.", diagnostic: "Silence journal CAS failed." };
		}

		const priorPhase = existingSilence?.phase;
		if (priorPhase === "external-grace") {
			const graceDeadline = new Date(existingSilence.exitedAt).getTime() + journalInput.run.effectiveSettings.nudgeGracePeriodSeconds * 1_000;
			if (now < graceDeadline) return { kind: "none", journal: journalInput, note: "External-process grace remains active; no recovery input was attempted." };
			if (!sourceChanged && existingSilence.inspection.process.kind === "none") {
				const phase: SilencePhase = { phase: "suspected", lastProgressAt: existingSilence.lastProgressAt, phaseAt: nowIso, inspection: snapshot };
				const persisted = await persistPhase(phase, "suspected-stall", "silence-passive-inspection", "External-process grace ended; a fresh unchanged passive inspection found no external process.");
				return persisted ? { kind: "changed", journal: persisted, note: "External-process grace ended; suspected-stall was durably recorded without input." } : { kind: "degraded", journal: journalInput, note: "Post-grace suspected-stall state could not be persisted; no input was sent." };
			}
		}
		if (progressChanged && priorPhase && priorPhase !== "external-grace") {
			const cleared = await persistSilence(repositoryRoot, journalInput, taskIndex, attemptInput.id, (task, attempt) => {
				const existing = attempt.recovery;
				if (existing) { delete existing.silence; attempt.recovery = { ...existing, live: { ...existing.live, observedAt: nowIso, stateChangeSequence: snapshot.stateChangeSequence } }; }
				else attempt.recovery = { live: { ...baseLive, observedAt: nowIso, stateChangeSequence: snapshot.stateChangeSequence } };
				if (ticket11Attention(task)) silenceAttention(task, "none");
			});
			return cleared ? { kind: "changed", journal: cleared, note: "Authoritative progress changed during passive inspection; the silence ladder was reset without input." } : { kind: "degraded", journal: journalInput, note: "Authoritative progress changed, but the silence reset could not be persisted; no input was attempted." };
		}

		const lastProgressAt = existingSilence?.lastProgressAt ?? attemptInput.recovery?.live.observedAt ?? attemptInput.activatedAt ?? attemptInput.preparedAt;
		const phaseAt = existingSilence?.phaseAt ?? lastProgressAt;
		const base = { now, passiveInspectionMs: journalInput.run.effectiveSettings.passiveInspectionIntervalSeconds * 1_000, secondInspectionMs: journalInput.run.effectiveSettings.secondInspectionAndNudgeIntervalSeconds * 1_000, nudgeGraceMs: journalInput.run.effectiveSettings.nudgeGracePeriodSeconds * 1_000, externalWarningMs: journalInput.run.effectiveSettings.externalCommandWarningThresholdSeconds * 1_000, lastProgressAt: new Date(lastProgressAt).getTime(), phaseAt: new Date(phaseAt).getTime(), retryOrdinal: journalInput.run.tasks[taskIndex]?.attempts.filter((item) => attemptSpecificationVersion(item) === attemptSpecificationVersion(attemptInput) && item.replacement).length ?? 0, retryLimit: journalInput.run.effectiveSettings.transientRetryLimit, process: "none" as const, unchanged: !sourceChanged && !processChanged };
		const decision = decideSilenceRecovery({ ...base, phase: priorPhase === "suspected" ? "suspected" : priorPhase === "nudged" ? "nudged" : priorPhase === "interrupted" ? "interrupted" : priorPhase === "resumed" ? "resumed" : "none" });
		if (decision.kind === "wait" || decision.kind === "inspection-incomplete") return { kind: "none", journal: journalInput, note: "Passive inspection is unchanged but no silence recovery deadline is due." };
		if (decision.kind === "suspect") {
			const phase: SilencePhase = { phase: "suspected", lastProgressAt, phaseAt: nowIso, inspection: snapshot };
			const persisted = await persistPhase(phase, "suspected-stall", "silence-passive-inspection", "No authoritative progress was observed after the passive inspection interval.");
			return persisted ? { kind: "changed", journal: persisted, note: "No authoritative progress was observed; suspected-stall was recorded without input." } : { kind: "degraded", journal: journalInput, note: "Suspected-stall could not be persisted; no input was sent." };
		}
		if (decision.kind === "nudge") {
			const prompt = silencePrompt("nudge", attemptInput);
			const intended: SilencePhase = { phase: "nudge-intended", lastProgressAt, phaseAt: nowIso, inspection: snapshot, target: identity, intendedAt: nowIso, promptSha256: silenceHash(prompt) };
			const intentJournal = await persistPhase(intended, "suspected-stall", "silence-passive-inspection");
			if (!intentJournal) return { kind: "degraded", journal: journalInput, note: "Status-nudge intent could not be persisted; no input was sent.", diagnostic: "Silence journal CAS failed." };
			let result: HerdrPromptResult;
			try { result = herdr.nudgeAgent ? await herdr.nudgeAgent({ repositoryRoot, identity, prompt }) : { kind: "failed", stage: "agent-prompt", code: "adapter-unavailable", message: "Status-nudge adapter is unavailable." }; }
			catch (error: unknown) { result = { kind: "failed", stage: "agent-prompt", code: "runner-error", message: error instanceof Error ? error.message : "Status nudge failed." }; }
			const exact = result.kind === "prompted" && result.name === identity.name && result.workspaceId === identity.workspaceId && result.paneId === identity.paneId && result.terminalId === identity.terminalId;
			const observedAt = transitionTimestamp(intentJournal, clock.now());
			const recorded = await persistSilence(repositoryRoot, intentJournal, taskIndex, attemptInput.id, (task, attempt) => {
				const current = attempt.recovery?.silence;
				if (!current || current.phase !== "nudge-intended") throw new Error("Status-nudge intent disappeared before acknowledgement.");
				attempt.recovery = { ...(attempt.recovery ?? { live: baseLive }), live: { ...baseLive, observedAt }, silence: exact ? { ...current, phase: "nudged", phaseAt: observedAt, nudgedAt: observedAt } : { ...current, phase: "nudge-ambiguous", phaseAt: observedAt, observedAt, diagnostic: result.kind === "failed" ? result.message : "Wrong-identity status-nudge acknowledgement." } };
				if (!exact) silenceAttention(task, "recovering", "silence-effect-ambiguous", "Status-nudge acknowledgement was not proven; no duplicate nudge will be sent.");
			});
			return recorded ? { kind: "effect", journal: recorded, note: exact ? "One exact same-agent status nudge was acknowledged; no retry was consumed." : "Status-nudge delivery is ambiguous; its durable tombstone forbids a resend.", action: "silence-nudge" } : { kind: "degraded", journal: intentJournal, note: "Status nudge was attempted, but its acknowledgement state could not be persisted; no resend will occur.", diagnostic: "Silence acknowledgement CAS failed." };
		}
		if (decision.kind === "interrupt") {
			const intended: SilencePhase = { phase: "interrupt-intended", lastProgressAt, phaseAt: nowIso, inspection: snapshot, target: identity, intendedAt: nowIso };
			const intentJournal = await persistPhase(intended, "suspected-stall", "silence-passive-inspection");
			if (!intentJournal) return { kind: "degraded", journal: journalInput, note: "Logical Escape intent could not be persisted; no input was sent.", diagnostic: "Silence journal CAS failed." };
			let result: HerdrInputResult;
			try { result = herdr.interruptAgent ? await herdr.interruptAgent({ repositoryRoot, identity }) : { kind: "failed", message: "Logical Escape adapter is unavailable." }; }
			catch (error: unknown) { result = { kind: "ambiguous", message: error instanceof Error ? error.message : "Logical Escape failed." }; }
			const exact = result.kind === "acknowledged" && exactIdentity(result.identity, identity);
			const observedAt = transitionTimestamp(intentJournal, clock.now());
			const recorded = await persistSilence(repositoryRoot, intentJournal, taskIndex, attemptInput.id, (task, attempt) => {
				const current = attempt.recovery?.silence;
				if (!current || current.phase !== "interrupt-intended") throw new Error("Logical Escape intent disappeared before acknowledgement.");
				attempt.recovery = { ...(attempt.recovery ?? { live: baseLive }), live: { ...baseLive, observedAt }, silence: exact ? { ...current, phase: "interrupted", phaseAt: observedAt, interruptedAt: observedAt } : { ...current, phase: "interrupt-ambiguous", phaseAt: observedAt, observedAt, diagnostic: result.kind !== "acknowledged" ? result.message : "Wrong-identity Logical Escape acknowledgement." } };
				if (!exact) silenceAttention(task, "recovering", "silence-effect-ambiguous", "Logical Escape acknowledgement was not proven; no duplicate input will be sent.");
			});
			return recorded ? { kind: "effect", journal: recorded, note: exact ? "One logical Escape was acknowledged for the exact same agent; no signal or process kill was used." : "Logical Escape delivery is ambiguous; its durable tombstone forbids a resend.", action: "silence-interrupt" } : { kind: "degraded", journal: intentJournal, note: "Logical Escape was attempted, but its acknowledgement state could not be persisted; no resend will occur.", diagnostic: "Silence acknowledgement CAS failed." };
		}
		if (decision.kind === "resume") {
			const prompt = silencePrompt("resume", attemptInput);
			const intended: SilencePhase = { phase: "resume-intended", lastProgressAt, phaseAt: nowIso, inspection: snapshot, target: identity, intendedAt: nowIso, promptSha256: silenceHash(prompt) };
			const intentJournal = await persistPhase(intended, "suspected-stall", "silence-passive-inspection");
			if (!intentJournal) return { kind: "degraded", journal: journalInput, note: "Same-agent resume intent could not be persisted; no input was sent.", diagnostic: "Silence journal CAS failed." };
			let result: HerdrPromptResult;
			try { result = herdr.resumeAgent ? await herdr.resumeAgent({ repositoryRoot, identity, prompt }) : { kind: "failed", stage: "agent-prompt", code: "adapter-unavailable", message: "Same-agent resume adapter is unavailable." }; }
			catch (error: unknown) { result = { kind: "failed", stage: "agent-prompt", code: "runner-error", message: error instanceof Error ? error.message : "Same-agent resume failed." }; }
			const exact = result.kind === "prompted" && result.name === identity.name && result.workspaceId === identity.workspaceId && result.paneId === identity.paneId && result.terminalId === identity.terminalId;
			const observedAt = transitionTimestamp(intentJournal, clock.now());
			const recorded = await persistSilence(repositoryRoot, intentJournal, taskIndex, attemptInput.id, (task, attempt) => {
				const current = attempt.recovery?.silence;
				if (!current || current.phase !== "resume-intended") throw new Error("Same-agent resume intent disappeared before acknowledgement.");
				attempt.recovery = { ...(attempt.recovery ?? { live: baseLive }), live: { ...baseLive, observedAt }, silence: exact ? { ...current, phase: "resumed", phaseAt: observedAt, resumedAt: observedAt } : { ...current, phase: "resume-ambiguous", phaseAt: observedAt, observedAt, diagnostic: result.kind === "failed" ? result.message : "Wrong-identity same-agent resume acknowledgement." } };
				if (!exact) silenceAttention(task, "recovering", "silence-effect-ambiguous", "Same-agent resume acknowledgement was not proven; no duplicate resume will be sent.");
			});
			return recorded ? { kind: "effect", journal: recorded, note: exact ? "The same exact agent was resumed once; no retry was consumed." : "Same-agent resume delivery is ambiguous; its durable tombstone forbids a resend.", action: "silence-resume" } : { kind: "degraded", journal: intentJournal, note: "Same-agent resume was attempted, but its acknowledgement state could not be persisted; no resend will occur.", diagnostic: "Silence acknowledgement CAS failed." };
		}
		if (decision.kind === "exhausted") {
			const phase: SilencePhase = { phase: "exhausted", lastProgressAt, phaseAt: nowIso, inspection: snapshot, retryOrdinal: decision.retryOrdinal };
			const persisted = await persistPhase(phase, "needs-user", "silence-recovery-exhausted", "The frozen silent-agent replacement limit is exhausted; all existing work and resources were retained.");
			return persisted ? { kind: "changed", journal: persisted, note: "Silent-agent recovery is exhausted; no replacement or destructive effect was attempted." } : { kind: "degraded", journal: journalInput, note: "Silent-agent exhaustion could not be persisted; no replacement was attempted." };
		}
		if (decision.kind === "replace") {
			const predecessor = attemptInput;
			const ordinal = decision.retryOrdinal;
			const preserved = preservationForSilenceSnapshot(taskInput, predecessor, snapshot, nowIso);
			const branch = branchForAttempt(taskInput, predecessor);
			if (!preserved || !branch) return { kind: "degraded", journal: journalInput, note: "Replacement was due, but exact preservation/worktree identity was unavailable; no replacement was reserved." };
			const nextAttemptId = `attempt-${String(taskInput.attempts.length + 1).padStart(2, "0")}`;
			const paths = runJournal.resolveAssignmentPaths(repositoryRoot, journalInput.run.id, taskInput.contract.id, nextAttemptId);
			const replacementName = `${predecessor.role === "builder" ? "steward-b" : "steward-r"}-${compactUuid(clock)}-${nextAttemptId.replace(/[^0-9]/g, "")}`;
			if (!safeHerdrName(replacementName)) return { kind: "degraded", journal: journalInput, note: "A safe Steward-owned replacement name could not be derived; no replacement was reserved." };
			const replacement: AttemptReplacement = { kind: "silent-agent-recovery", replacesAttemptId: predecessor.id, retryOrdinal: ordinal as 1 | 2, preservedAt: nowIso };
			const replacementDispatch = predecessor.role === "builder"
				? { phase: "replacement-pane-intended" as const, branch, worktreePath: preserved.worktreePath, agentName: replacementName, sourcePaneId: predecessor.dispatch.paneId, workspaceId: predecessor.dispatch.workspaceId }
				: { phase: "replacement-pane-intended" as const, sourcePaneId: predecessor.dispatch.paneId, worktreePath: preserved.worktreePath, agentName: replacementName, branch, workspaceId: predecessor.dispatch.workspaceId };
			let reserved: RunJournal | undefined;
			try {
				reserved = await persistSilence(repositoryRoot, journalInput, taskIndex, predecessor.id, (task, attempt, nextJournal) => {
					if (attempt.role !== predecessor.role || attempt.state !== predecessor.state || attempt.id !== predecessor.id) throw new Error("Replacement predecessor changed before reservation.");
					attempt.state = "superseded";
					const existing = attempt.recovery;
					attempt.recovery = { live: { ...baseLive, observedAt: nowIso }, ...(existing?.reportRequest ? { reportRequest: existing.reportRequest } : {}), ...(existing?.blockedAnswer ? { blockedAnswer: existing.blockedAnswer } : {}), preservation: preserved, silence: { phase: "replacement-intended", lastProgressAt, phaseAt, inspection: snapshot, target: identity, intendedAt: nowIso, retryOrdinal: ordinal } };
					const nextAttempt: AttemptRecord = predecessor.role === "builder"
						? { id: nextAttemptId, role: "builder", state: "prepared", preparedAt: nowIso, actualModel: { ...predecessor.actualModel }, ...(nextJournal.run.revisions ? { specificationVersion: task.specificationVersion } : {}), specificationHash: predecessor.specificationHash, baseRevision: predecessor.baseRevision, assignmentPath: paths.assignmentPath, reportPath: paths.reportPath, evidenceDirectory: paths.evidenceDirectory, dispatch: replacementDispatch, replacement }
						: { id: nextAttemptId, role: "reviewer", state: "prepared", preparedAt: nowIso, actualModel: { ...predecessor.actualModel }, ...(nextJournal.run.revisions ? { specificationVersion: task.specificationVersion } : {}), specificationHash: predecessor.specificationHash, assignmentPath: paths.assignmentPath, reportPath: paths.reportPath, evidenceDirectory: paths.evidenceDirectory, subject: predecessor.subject, independence: { ...predecessor.independence }, worktree: { path: predecessor.worktree.path, baseline: { ...predecessor.worktree.baseline, dirtyPaths: [...predecessor.worktree.baseline.dirtyPaths], operationMarkers: [...predecessor.worktree.baseline.operationMarkers] } }, dispatch: replacementDispatch, replacement };
					task.attempts.push(nextAttempt);
					clearTaskMonitor(nextJournal.run, task.contract.id);
					silenceAttention(task, "none");
				});
			} catch (error: unknown) { return { kind: "degraded", journal: journalInput, note: `Silent replacement reservation failed; no pane or prompt effect was attempted. ${error instanceof Error ? error.message : "Journal validation failed."}`, diagnostic: "Replacement reservation failed." }; }
			if (!reserved) return { kind: "degraded", journal: journalInput, note: "Silent replacement reservation lost a Journal race; no pane or prompt effect was attempted.", diagnostic: "Replacement reservation CAS failed." };
			return { kind: "effect", journal: reserved, note: `Reserved linked silent replacement Attempt ${nextAttemptId} at retry ordinal ${ordinal}; no pane was created in this pass.`, action: "reserve-silent-replacement" };
		}
		return { kind: "none", journal: journalInput, note: "Silence recovery has no due effect." };
	}

	function monitorResult(action: MonitorWorkflowAction, journal: RunJournal | undefined, note: string, diagnostic?: string, completed = false, changedSources?: readonly string[], notification?: boolean): MonitorPassResult {
		let condition: MonitorCondition;
		if (journal?.run.status === "cancelled" || journal?.run.cancellation) condition = "cancelled";
		else if (completed || journal?.run.status === "completed" || journal?.run.completion?.phase === "archived") condition = "completed";
		else if (journal?.run.tasks.some((task) => task.attention === "needs-user" && task.attentionReason === "review-approval-required") || action === "approval-required") condition = "approval-required";
		else if (journal?.run.tasks.some((task) => task.attention !== "none") || action === "blocked") condition = "blocked";
		else if (diagnostic || action === "degraded") condition = "degraded";
		else condition = "ordinary";
		return { action, ...(journal ? { journal } : {}), note, condition, ...(diagnostic ? { diagnostic } : {}), ...(completed ? { completed: true } : {}), ...(changedSources ? { changedSources: [...changedSources] } : {}), ...(notification !== undefined ? { notification } : {}) };
	}

	function observationIdentity(attempt: AttemptRecord): ManagedAgentIdentity | undefined {
		return monitorIdentity(attempt);
	}

	async function observeMonitorProgress(repositoryRoot: string, controllerSessionId: string, trigger: MonitorTrigger): Promise<MonitorPassResult> {
		const loaded = await runJournal.loadActive(repositoryRoot);
		if (loaded.kind !== "loaded") return monitorResult(loaded.kind === "missing" ? "none" : "degraded", undefined, loaded.kind === "missing" ? "No active Run exists; monitoring is dormant." : `${journalRecoveryMessage(loaded)} Monitoring is dormant.`, loaded.kind === "missing" ? undefined : "Run Journal recovery is read-only.");
		const journal = loaded.journal;
		if (!controllerIdentityMatches(journal, controllerSessionId)) return monitorResult("none", journal, "Controller Session does not match; monitor observation is read-only.");
		if (journal.run.status === "cancelled" || journal.run.cancellation) return monitorResult("none", journal, "Run is cancelled; monitoring is dormant.");
		if (journal.run.status === "completed" || journal.run.completion?.phase === "archived") return monitorResult("none", journal, "Run is completed; monitoring is dormant.", undefined, true);
		const selected = currentMonitorAttempts(journal);
		if (selected.length === 0) return monitorResult("none", journal, "No current prompted Steward Attempt is available for monitoring.");
		const observations = await Promise.all(selected.map(async (current) => {
			const identity = observationIdentity(current.attempt);
			if (!identity) return { current, checkpoint: undefined, changedSources: [], degraded: true };
			let agent: ManagedAgentInspection = { kind: "unclear", diagnostic: "Herdr monitoring inspection is unavailable." };
			try { if (herdr.inspectManagedAgent) agent = await herdr.inspectManagedAgent(identity); } catch (error: unknown) { agent = { kind: "unclear", diagnostic: error instanceof Error ? error.message : "Herdr monitoring inspection failed." }; }
			let terminal: MonitorDigest = { kind: "unavailable", diagnostic: "Herdr terminal observation is unavailable." };
			try { if (herdr.readManagedTerminal) terminal = await herdr.readManagedTerminal(identity); } catch (error: unknown) { terminal = { kind: "unavailable", diagnostic: error instanceof Error ? error.message : "Herdr terminal observation failed." }; }
			let worktree: MonitorDigest = { kind: "unavailable", diagnostic: "Managed worktree observation is unavailable." };
			let gitProgress: { head: string | null; digest: string | null; diagnostic?: string } = { head: null, digest: null, diagnostic: "Managed Git observation is unavailable." };
			try {
				const progress = git.inspectManagedWorktreeProgress ? await git.inspectManagedWorktreeProgress(current.attempt.dispatch.phase === "prompted" || current.attempt.dispatch.phase === "reconciled-active" ? current.attempt.dispatch.worktreePath : "") : { kind: "unavailable", diagnostic: "Managed worktree observation is unavailable." } as ManagedWorktreeProgress;
				if (progress.kind === "observed") { worktree = progress.worktree; gitProgress = { head: progress.git.head, digest: progress.git.digest.kind === "observed" ? progress.git.digest.sha256 : null, ...(progress.git.digest.kind === "unavailable" ? { diagnostic: progress.git.digest.diagnostic } : {}) }; }
				else { worktree = { kind: "unavailable", diagnostic: progress.diagnostic }; gitProgress = { head: null, digest: null, diagnostic: progress.diagnostic }; }
			} catch (error: unknown) { const diagnostic = error instanceof Error ? error.message : "Managed worktree observation failed."; worktree = { kind: "unavailable", diagnostic }; gitProgress = { head: null, digest: null, diagnostic }; }
			let report: MonitorReportObservation = { kind: "unavailable", diagnostic: "Attempt Report observation is unavailable." };
			try {
				if (runJournal.inspectAttemptReport) report = await runJournal.inspectAttemptReport(repositoryRoot, current.attempt.reportPath);
			} catch (error: unknown) { report = { kind: "unavailable", diagnostic: error instanceof Error ? error.message : "Attempt Report observation failed." }; }
			const lifecycle = agent.kind === "observed" ? agent.lifecycle : "unavailable";
			const stateChangeSequence = agent.kind === "observed" ? agent.stateChangeSequence : null;
			const observedAt = new Date(Math.max(clock.now().getTime(), new Date(journal.run.updatedAt).getTime() + 1)).toISOString();
			const checkpoint: MonitorCheckpoint = { observedAt, taskId: current.task.contract.id, attemptId: current.attempt.id, role: current.attempt.role, agent: { ...identity, lifecycle, stateChangeSequence }, terminal, worktree, git: gitProgress, report };
			const priorMonitor = journal.run.tasks.length > 1 ? journal.run.monitors?.find((item) => item.taskId === checkpoint.taskId && item.attemptId === checkpoint.attemptId && item.role === checkpoint.role) : journal.run.monitor;
			const changedSources = monitorChangedSources(priorMonitor, checkpoint);
			const degraded = agent.kind === "unclear" || terminal.kind === "unavailable" || worktree.kind === "unavailable" || Boolean(gitProgress.diagnostic) || report.kind === "unavailable";
			return { current, checkpoint, changedSources, degraded };
		}));
		const changedObservations = observations.filter((item): item is typeof item & { checkpoint: MonitorCheckpoint } => item.checkpoint !== undefined && item.changedSources.length > 0);
		const changedSources = [...new Set(changedObservations.flatMap((item) => item.changedSources))];
		const degraded = observations.some((item) => item.degraded);
		if (changedObservations.length === 0) return monitorResult(degraded ? "degraded" : "none", journal, `${trigger} monitoring scan found no changed durable facts.`, degraded ? "One or more monitoring sources were unavailable." : undefined, false, changedSources);
		let candidate: RunJournal;
		try { candidate = advanceRunJournal(journal, clock.now(), (next) => { if (next.run.tasks.length > 1) { const keys = new Set(changedObservations.map((item) => `${item.checkpoint.taskId}/${item.checkpoint.attemptId}/${item.checkpoint.role}`)); const monitors = (next.run.monitors ?? []).filter((item) => !keys.has(`${item.taskId}/${item.attemptId}/${item.role}`)); monitors.push(...changedObservations.map((item) => item.checkpoint)); monitors.sort((left, right) => next.run.tasks.findIndex((task) => task.contract.id === left.taskId) - next.run.tasks.findIndex((task) => task.contract.id === right.taskId)); next.run.monitors = monitors; delete next.run.monitor; } else next.run.monitor = changedObservations[0]!.checkpoint; }); }
		catch (error: unknown) { return monitorResult("degraded", journal, "Monitor observation could not be built durably; workflow state was unchanged.", error instanceof Error ? error.message : "Monitor checkpoint validation failed.", false, changedSources); }
		if (!runJournal.replaceActive) return monitorResult("degraded", journal, "Monitor checkpoint storage is unavailable; workflow state was unchanged.", "Monitor checkpoint storage is unavailable.", false, changedSources);
		let replaced: import("./run-journal-store.ts").ReplaceActiveResult;
		try { replaced = await runJournal.replaceActive(repositoryRoot, candidate); } catch (error: unknown) { return monitorResult("degraded", journal, "Monitor checkpoint could not be persisted; no workflow action was attempted.", error instanceof Error ? error.message : "Monitor checkpoint storage failed.", false, changedSources); }
		if (replaced.kind !== "replaced") return monitorResult("degraded", journal, "Monitor checkpoint lost a Journal race or encountered invalid current state; no workflow action was attempted.", "Monitor checkpoint replacement was rejected.", false, changedSources);
		let activityFailed = false;
		try {
			const observedLabel = journal.run.tasks.length > 1 ? `Attempts ${changedObservations.map((item) => item.checkpoint.attemptId).join(", ")}` : `Attempt ${changedObservations[0]!.checkpoint.attemptId}`;
			const activity = await runJournal.appendActivity(repositoryRoot, { timestamp: replaced.journal.run.updatedAt, runId: replaced.journal.run.id, event: "monitor-observed", message: `Observed ${observedLabel}: ${changedSources.join(", ")}.` });
			activityFailed = activity.kind !== "appended";
		} catch { activityFailed = true; }
		if (activityFailed) return monitorResult("degraded", replaced.journal, "Monitor checkpoint persisted, but activity logging is degraded; no workflow action was attempted.", "Activity append failed after authoritative checkpoint persistence.", false, changedSources);
		const observedLabel = journal.run.tasks.length > 1 ? `Attempts ${changedObservations.map((item) => item.checkpoint.attemptId).join(", ")}` : `Attempt ${changedObservations[0]!.checkpoint.attemptId}`;
		return monitorResult(degraded ? "degraded" : "record-observation", replaced.journal, `Observed ${observedLabel}: ${changedSources.join(", ")}.`, degraded ? "One or more monitoring sources were unavailable." : undefined, false, changedSources);
	}

	async function waitForMonitorSignal(repositoryRoot: string, controllerSessionId: string, signal: AbortSignal): Promise<MonitorWaitResult> {
		const loaded = await runJournal.loadActive(repositoryRoot);
		if (loaded.kind !== "loaded") return { kind: "unavailable", diagnostic: loaded.kind === "missing" ? "No active non-cancelled Controller-owned Run is available for a lifecycle wait." : `${journalRecoveryMessage(loaded)} Lifecycle wait is dormant.` };
		if (!controllerIdentityMatches(loaded.journal, controllerSessionId) || loaded.journal.run.status === "cancelled" || loaded.journal.run.cancellation || loaded.journal.run.status === "completed" || loaded.journal.run.completion?.phase === "archived") return { kind: "unavailable", diagnostic: "No active non-cancelled Controller-owned Run is available for a lifecycle wait." };
		const finalExecution = loaded.journal.run.finalVerificationExecution;
		if (finalExecution && isRecoverableFinalVerificationExecution(finalExecution) && finalExecution.phase === "executing" && finalExecution.attempts.at(-1)?.process && process.waitApprovedVerification) {
			const attempt = finalExecution.attempts.at(-1)!;
			const managedInput: ManagedVerificationInput & { process?: FinalVerificationProcessIdentity } = { repositoryRoot, runId: loaded.journal.run.id, attemptId: attempt.id, command: finalExecution.command, cwd: finalExecution.cwd, executionNonce: attempt.process!.executionNonce, paths: attempt.paths, process: attempt.process };
			let waited: "settled" | "cancelled" | "unclear";
			try { waited = await process.waitApprovedVerification(managedInput, signal); }
			catch (error: unknown) { return { kind: "unavailable", diagnostic: error instanceof Error ? error.message : "Managed final-verification wait failed." }; }
			if (waited === "cancelled") return { kind: "cancelled" };
			if (waited === "unclear") return { kind: "unavailable", diagnostic: "Managed final-verification liveness became unclear; no workflow action was attempted." };
			return { kind: "settled", lifecycle: "done", identity: { name: "final-verification", workspaceId: loaded.journal.run.id, paneId: attempt.id, terminalId: "managed-runner" }, stateChangeSequence: null };
		}
		if (loaded.journal.run.tasks.length > 1) {
			const selected = currentMonitorAttempts(loaded.journal);
			if (selected.length === 0 || !herdr.inspectManagedAgent || !herdr.waitForManagedAgent) return { kind: "unavailable", diagnostic: "No current prompted multi-Task Attempt or Herdr lifecycle wait is available." };
			const identities = selected.map((candidate) => observationIdentity(candidate.attempt));
			if (identities.some((identity) => !identity)) return { kind: "unavailable", diagnostic: "A current multi-Task Attempt lacks an exact Herdr identity." };
			const now = clock.now().getTime();
			const deadline = Math.min(...selected.map((candidate) => nextSilenceDeadline(loaded.journal, candidate.attempt, now)));
			const remaining = deadline - now;
			if (remaining <= 0) return { kind: "timeout" };
			const waiters = identities.map((identity) => herdr.inspectManagedAgent!(identity!).then((inspection) => ({ kind: "inspection" as const, inspection, identity: identity! })).catch((error: unknown) => ({ kind: "error" as const, identity: identity!, diagnostic: error instanceof Error ? error.message : "Herdr inspection failed." })));
			const inspected = await Promise.all(waiters);
			const unavailable = inspected.find((item) => item.kind === "error");
			if (unavailable?.kind === "error") return { kind: "unavailable", diagnostic: unavailable.diagnostic };
			const working = inspected.filter((item): item is Extract<typeof item, { kind: "inspection" }> => item.kind === "inspection" && item.inspection.kind === "observed" && item.inspection.lifecycle === "working");
			if (working.length === 0) {
				try { if (clock.wait) await clock.wait(remaining, signal); } catch { return { kind: "cancelled" }; }
				return signal.aborted ? { kind: "cancelled" } : { kind: "timeout" };
			}
			const controllers = working.map(() => new AbortController());
			const abortAll = (): void => { for (const controller of controllers) controller.abort(); };
			const onAbort = (): void => abortAll();
			signal.addEventListener("abort", onAbort, { once: true });
			try {
				const waited = await Promise.race(working.map((item, index) => herdr.waitForManagedAgent!(item.identity, Math.min(remaining, 30_000), controllers[index]!.signal).catch((error: unknown) => ({ kind: "unavailable" as const, diagnostic: error instanceof Error ? error.message : "Herdr lifecycle wait failed." }))));
				if (signal.aborted) return { kind: "cancelled" };
				if (waited.kind === "settled") return waited;
				if (waited.kind === "cancelled") return waited;
				if (waited.kind === "unavailable") return waited;
				if (remaining <= 30_000) return { kind: "timeout" };
				try { if (clock.wait) await clock.wait(remaining, signal); } catch { return { kind: "cancelled" }; }
				return signal.aborted ? { kind: "cancelled" } : { kind: "timeout" };
			} finally {
				signal.removeEventListener("abort", onAbort);
				abortAll();
			}
		}
		const selected = currentMonitorAttempt(loaded.journal);
		const identity = selected ? observationIdentity(selected.attempt) : undefined;
		if (!identity || !herdr.inspectManagedAgent || !herdr.waitForManagedAgent) return { kind: "unavailable", diagnostic: "The current prompted Attempt or Herdr lifecycle wait is unavailable." };
		const waitForDeadline = async (): Promise<"timeout" | "cancelled"> => {
			const remaining = nextSilenceDeadline(loaded.journal, selected!.attempt, clock.now().getTime()) - clock.now().getTime();
			if (remaining <= 0) return "timeout";
			try { if (clock.wait) await clock.wait(remaining, signal); } catch { return "cancelled"; }
			return "timeout";
		};
		let inspected: ManagedAgentInspection;
		try { inspected = await herdr.inspectManagedAgent(identity); } catch {
			return { kind: await waitForDeadline() };
		}
		if (inspected.kind !== "observed") {
			return { kind: await waitForDeadline() };
		}
		if (inspected.lifecycle !== "working") {
			return { kind: await waitForDeadline() };
		}
		if (signal.aborted) return { kind: "cancelled" };
		const waitMs = nextSilenceDeadline(loaded.journal, selected!.attempt, clock.now().getTime()) - clock.now().getTime();
		if (waitMs <= 0) return { kind: "timeout" };
		try {
			const waited = await herdr.waitForManagedAgent(identity, Math.min(waitMs, 30_000), signal);
			if (waited.kind === "timeout" || waited.kind === "unavailable") {
				try { if (clock.wait) await clock.wait(waitMs, signal); } catch { return { kind: "cancelled" }; }
			}
			return waited.kind === "unavailable" ? { kind: "timeout" } : waited;
		} catch (error: unknown) { return signal.aborted || (error instanceof Error && error.name === "AbortError") ? { kind: "cancelled" } : { kind: "unavailable", diagnostic: error instanceof Error ? error.message : "Herdr lifecycle wait failed." }; }
	}

	async function advanceNext(repositoryRoot: string, controllerSessionId: string, options: MonitorAdvanceOptions): Promise<MonitorPassResult> {
		const loaded = await runJournal.loadActive(repositoryRoot);
		if (loaded.kind !== "loaded") return monitorResult(loaded.kind === "missing" ? "none" : "degraded", undefined, loaded.kind === "missing" ? "No active Run exists; advancement is dormant." : `${journalRecoveryMessage(loaded)} Advancement is dormant.`, loaded.kind === "missing" ? undefined : "Run Journal recovery is read-only.");
		let journal = loaded.journal;
		if (!controllerIdentityMatches(journal, controllerSessionId)) return monitorResult("none", journal, "Controller Session does not match; advancement is read-only.");
		if (journal.run.status === "cancelled" || journal.run.cancellation) return monitorResult("none", journal, "Run is cancelled; advancement is dormant.");
		if (journal.run.status === "completed" || journal.run.completion?.phase === "archived") return monitorResult("none", journal, "Run is completed; advancement is dormant.", undefined, true);
		const revisionStops = await reconcileRevisionStops(repositoryRoot, journal, controllerSessionId);
		if (revisionStops.ambiguous) return monitorResult("blocked", revisionStops.journal, revisionStops.note, revisionStops.note);
		if (revisionStops.journal.journalRevision !== journal.journalRevision) return monitorResult("stop-next-agent", revisionStops.journal, revisionStops.note);
		journal = revisionStops.journal;
		const reconciliation = await reconcileCurrentAttempt(repositoryRoot, controllerSessionId, journal, monitorDependencies);
		journal = reconciliation.journal;
		if (reconciliation.kind !== "none") {
			const action = reconciliation.action ?? (reconciliation.kind === "degraded" ? "degraded" : reconciliation.kind === "blocked" ? "blocked" : "record-observation");
			let activityDiagnostic: string | undefined;
			if (journal.journalRevision !== loaded.journal.journalRevision) {
				try {
					const activity = await runJournal.appendActivity(repositoryRoot, { timestamp: journal.run.updatedAt, runId: journal.run.id, event: "reconciliation-observed", message: reconciliation.note });
					if (activity.kind !== "appended") activityDiagnostic = "Activity append failed after authoritative reconciliation persistence.";
				} catch (error: unknown) {
					activityDiagnostic = error instanceof Error ? error.message.slice(0, 2_000) : "Activity append failed after authoritative reconciliation persistence.";
				}
			}
			return monitorResult(activityDiagnostic ? "degraded" : action, journal, reconciliation.note, activityDiagnostic);
		}
		const activity = { failed: false, diagnostic: "" };
		const authoritativeActivity = monitorDependencies.runJournal.appendActivity.bind(monitorDependencies.runJournal);
		const deps: StewardDependencies = {
			...monitorDependencies,
			runJournal: {
				...monitorDependencies.runJournal,
				appendActivity: async (root, entry) => {
					try {
						const result = await authoritativeActivity(root, entry);
						if (result.kind !== "appended") {
							activity.failed = true;
							activity.diagnostic = "Activity append failed after authoritative workflow persistence.";
						}
						return result;
					} catch (error: unknown) {
						activity.failed = true;
						activity.diagnostic = error instanceof Error ? error.message.slice(0, 2_000) : "Activity append failed after authoritative workflow persistence.";
						throw error;
					}
				},
			},
		};
		const activityDegraded = (journalValue: RunJournal, note: string): MonitorPassResult | undefined => activity.failed ? monitorResult("degraded", journalValue, `${note} Workflow state remains authoritative; no later automatic action was attempted in this pass.`, activity.diagnostic) : undefined;
		for (const candidate of activeBuilders(journal)) {
			const beforeRevision = journal.journalRevision;
			const decision = await validateActiveBuilderEvidence(repositoryRoot, controllerSessionId, journal, deps, candidate);
			journal = decision.journal;
			const degraded = activityDegraded(journal, decision.note || "Builder evidence decision completed.");
			if (degraded) return degraded;
			if (journal.journalRevision !== beforeRevision) return monitorResult("finalize-builder-evidence", journal, decision.note || "Builder evidence was durably finalized.");
			if (decision.kind !== "waiting") break;
		}
		for (let minimumIndex = 0; minimumIndex < journal.run.tasks.length; minimumIndex += 1) {
			const silenceCandidate = reconciliationCandidate(journal, minimumIndex);
			if (!silenceCandidate) break;
			const silence = await advanceSilenceRecovery(repositoryRoot, journal, silenceCandidate.index, silenceCandidate.task, silenceCandidate.attempt);
			if (silence.kind === "none") continue;
			let diagnostic = silence.diagnostic;
			if (silence.journal.journalRevision !== journal.journalRevision) {
				try {
					const activityResult = await runJournal.appendActivity(repositoryRoot, { timestamp: silence.journal.run.updatedAt, runId: silence.journal.run.id, event: "silence-recovery-observed", message: silence.note });
					if (activityResult.kind !== "appended") diagnostic = diagnostic ?? "Activity append failed after authoritative silence recovery persistence.";
				} catch (error: unknown) {
					diagnostic = diagnostic ?? (error instanceof Error ? error.message.slice(0, 2_000) : "Activity append failed after authoritative silence recovery persistence.");
				}
			}
			return monitorResult(silence.action ?? (silence.kind === "degraded" ? "degraded" : "record-observation"), silence.journal, silence.note, diagnostic, false, undefined, silence.notification);
		}
		const beforeApprovalRevision = journal.journalRevision;
		const approval = await validateApprovedTasks(repositoryRoot, journal, deps);
		journal = approval.journal;
		const approvalDegraded = activityDegraded(journal, approval.note || "Approval decision completed.");
		if (approvalDegraded) return approvalDegraded;
		if (journal.journalRevision !== beforeApprovalRevision) return monitorResult("invalidate-approval", journal, approval.note || "Approval was invalidated before a later effect.");
		const beforeReview = journal.journalRevision;
		let review = { journal, note: "" } as ReviewDecision;
		for (let minimumIndex = 0; minimumIndex < journal.run.tasks.length; minimumIndex += 1) {
			review = await advanceEligibleReview(repositoryRoot, controllerSessionId, journal, deps, !options.interactive, minimumIndex);
			journal = review.journal;
			const reviewDegraded = activityDegraded(journal, review.note || "Review decision completed.");
			if (reviewDegraded) return reviewDegraded;
			if (review.action) return monitorResult(review.action, journal, review.note, review.diagnostic);
			if (journal.journalRevision !== beforeReview) {
				const changedTask = journal.run.tasks[minimumIndex];
				const latest = changedTask ? currentAttempt(changedTask) : undefined;
				const action: MonitorWorkflowAction = changedTask?.phase === "approved" ? "finalize-reviewer-evidence" : latest?.role === "reviewer" ? "dispatch-reviewer" : "dispatch-rework-builder";
				return monitorResult(action, journal, review.note);
			}
		}
		const completion = await advanceApprovedCompletion(repositoryRoot, journal, deps, true);
		journal = completion.journal;
		const completionDegraded = activityDegraded(journal, completion.note || "Completion decision completed.");
		if (completionDegraded) return completionDegraded;
		if (completion.action) return monitorResult(completion.action, journal, completion.note, completion.diagnostic, completion.completed);
		const admission = selectTaskAdmission(journal.run);
		if (admission.kind === "admit") {
			const dispatched = await dispatchInitialBuilder({ repositoryRoot, controllerSessionId, journal, dependencies: deps });
			return monitorResult(dispatched.kind === "dispatched" ? "dispatch-builder" : "degraded", dispatched.journal, dispatched.message, dispatched.kind === "pending" ? dispatched.message : undefined);
		}
		return monitorResult("none", journal, completion.note, completion.diagnostic, completion.completed);
	}

	function presentMonitor(result: MonitorPassResult, target: "footer" | "command"): void {
		const journal = result.journal;
		if (!ui.presentMonitorCondition) return;
		const footerText = journal ? monitorFooter(journal, result.condition, result.diagnostic) : result.condition === "degraded" ? "steward: monitoring degraded" : "steward: no active Run";
		const notification = result.notification === false ? undefined : result.condition === "approval-required" ? { key: `${journal?.run.id ?? "none"}:approval-required:${journal?.journalRevision ?? 0}`, message: result.note, type: "warning" as const } : result.condition === "blocked" ? { key: `${journal?.run.id ?? "none"}:blocked:${journal?.journalRevision ?? 0}`, message: result.note, type: "warning" as const } : result.condition === "degraded" ? { key: `${journal?.run.id ?? "none"}:degraded:${result.diagnostic ?? result.note}`, message: result.note, type: "warning" as const } : undefined;
		ui.presentMonitorCondition({ condition: result.condition, ...(journal ? { runId: journal.run.id, journalRevision: journal.journalRevision } : {}), footerText, ...(notification ? { notification } : {}) });
		if (target === "command" && journal) ui.presentStatus(presentStatusForJournal(journal, result.note), "command");
	}

	return { status, resume, takeover, restoreControllerSession, prepareCompactionContinuity, recordCompactionFailure, configure, start, revise, cancel, cleanup, waitForMonitorSignal, observeMonitorProgress, advanceNext, presentMonitor };
}
