import type { ConfigLoadResult, ConfigSaveResult } from "./config-store.ts";
import {
	formatModelPlans,
	formatRecoveryDefaults,
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
import type { ActiveRunLoadResult, ActivityAppendResult, CreateActiveResult } from "./run-journal-store.ts";
import type { AssignmentCreateResult, AssignmentPaths } from "./assignment-store.ts";
import {
	buildInitialRunJournal,
	buildRunConfirmationSummary,
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
	type IntegrationBase,
	type RunConfirmationSummary,
	type RunDraft,
	type RunDraftInput,
	type RunDraftResult,
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
	type TaskApproval,
	type ReportRepairFailure,
	type IntegrationCheckoutObservation,
	type TaskIntegration,
	type FinalVerificationExecution,
	type CompletionAgentIdentity,
	type CompletionStopResource,
	type CompletionStopFailure,
	type CompletionGateFacts,
	type CompletionArchiveIntent,
	type CompletionRecord,
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
	ArchiveCompletedRunRequest,
	ArchiveCompletedRunResult,
	CompletionPaths,
	VerificationEvidenceInput,
	VerificationFinalizeResult,
} from "./completion-store.ts";

/** The two presentation contexts supported by this slice. */
export type StatusTarget = "command" | "footer";

/** The only journal fact needed to decide ticket-01 status. */
export type ActiveRunProbe = "missing" | "present";

/** The read-only and configuration operations owned by the Run Journal adapter. */
export interface RunJournalAdapter {
	probeActive(repositoryRoot: string): ActiveRunProbe;
	loadActive(repositoryRoot: string): Promise<ActiveRunLoadResult>;
	createActive(repositoryRoot: string, journal: RunJournal): Promise<CreateActiveResult>;
	replaceActive(repositoryRoot: string, journal: RunJournal): Promise<import("./run-journal-store.ts").ReplaceActiveResult>;
	appendActivity(repositoryRoot: string, entry: import("./run.ts").ActivityEntry): Promise<ActivityAppendResult>;
	resolveAssignmentPaths(repositoryRoot: string, runId: string, taskId: string, attemptId: string): AssignmentPaths;
	createAssignment(repositoryRoot: string, document: BuilderAssignmentDocument | ReviewerAssignmentDocument): Promise<AssignmentCreateResult>;
	loadBuilderEvidenceInputs?(input: import("./attempt-evidence-store.ts").BuilderEvidenceInputRequest): Promise<import("./attempt-evidence-store.ts").BuilderEvidenceInputs>;
	loadReviewerEvidenceInputs?(input: import("./attempt-evidence-store.ts").ReviewerEvidenceInputRequest): Promise<import("./attempt-evidence-store.ts").ReviewerEvidenceInputs>;
	loadFinalizedEvidenceManifest?(input: { manifestPath: string; manifestSha256: string }): Promise<import("./attempt-evidence-store.ts").FinalizedManifestLoadResult>;
	inspectReferencedEvidence?(input: import("./attempt-evidence-store.ts").ReferencedEvidenceRequest): Promise<import("./attempt-evidence-store.ts").ReferencedEvidenceResult>;
	inspectReferencedReviewerEvidence?(input: import("./attempt-evidence-store.ts").ReferencedReviewerEvidenceRequest): Promise<import("./attempt-evidence-store.ts").ReferencedReviewerEvidenceResult>;
	finalizeBuilderEvidence?(input: import("./attempt-evidence-store.ts").FinalizeBuilderEvidenceRequest): Promise<import("./attempt-evidence-store.ts").FinalizeBuilderEvidenceResult>;
	finalizeReviewerEvidence?(input: import("./attempt-evidence-store.ts").FinalizeReviewerEvidenceRequest): Promise<import("./attempt-evidence-store.ts").FinalizeReviewerEvidenceResult>;
	resolveCompletionPaths?(repositoryRoot: string, runId: string): CompletionPaths;
	finalizeVerificationResult?(input: VerificationEvidenceInput): Promise<VerificationFinalizeResult>;
	archiveCompletedRun?(input: ArchiveCompletedRunRequest): Promise<ArchiveCompletedRunResult>;
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
	confirmSameFamilyReview?(input: { builderModel: import("./config.ts").ModelChoice; reviewerModel: import("./config.ts").ModelChoice; subject: ReviewSubject; provider: string }): Promise<boolean>;
	presentStartResult(result: StartResult): void;
	notifyCompletion?(input: { runId: string; targetBranch: string; integratedHead: string; verificationResultPath: string; verificationLogPath: string; archivePath: string }): void;
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
	stopAgentGracefully?(input: { repositoryRoot: string; name: string; workspaceId: string; paneId: string; terminalId: string }): Promise<HerdrStopResult>;
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

export type HerdrReviewerPaneResult =
	| { kind: "created"; workspaceId: string; tabId: string; paneId: string; terminalId: string; sourcePaneId: string; worktreePath: string }
	| { kind: "failed"; stage: "pane-split"; code: string; message: string };

export type HerdrStopResult =
	| { kind: "acknowledged"; name: string; workspaceId: string; tabId: string; paneId: string; terminalId: string }
	| { kind: "failed" | "ambiguous"; message: string };

export type HerdrAvailability =
	| { kind: "available"; status: string; running: true; compatible: true; endpointCompatible: true; protocol?: number }
	| { kind: "unavailable"; message: string };

export interface StewardGitAdapter {
	inspectIntegrationBase(repositoryRoot: string): Promise<IntegrationBaseInspection>;
	branchExists?(repositoryRoot: string, branch: string): Promise<boolean>;
	inspectBuilderWorktree?(worktreePath: string, expectedRevision: string): Promise<BuilderWorktreeInspection>;
	inspectProducedCodeArtifact?(input: { worktreePath: string; approvedBase: string; producedHead: string }): Promise<ProducedCodeArtifactInspection>;
	inspectReviewWorktree?(worktreePath: string): Promise<import("./run.ts").ReviewWorktreeSnapshot | { kind: "unavailable"; message: string }>;
	inspectIntegrationCheckout?(input: IntegrationCheckoutInput): Promise<IntegrationCheckoutResult>;
	integrateApprovedRange?(input: IntegrationMutationInput): Promise<GitCommandOutcome>;
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
	| { kind: "inspected"; observation: import("./run.ts").IntegrationCheckoutObservation; resolvedBaseRevision: string; resolvedHeadRevision: string; commits: string[] }
	| { kind: "unavailable"; message: string };

export interface IntegrationMutationInput extends IntegrationCheckoutInput {
	action: { kind: "fast-forward"; argv: ["merge", "--ff-only", "--no-edit", string] };
}

export type GitCommandOutcome =
	| { kind: "completed"; code: number; stdout: string; stderr: string; killed: boolean }
	| { kind: "thrown"; message: string };

export type VerificationProcessOutcome =
	| { kind: "completed"; code: number; stdout: string; stderr: string; killed: boolean }
	| { kind: "thrown"; message: string };

export interface StewardProcessAdapter {
	runApprovedVerification?(input: { cwd: string; command: string }): Promise<VerificationProcessOutcome>;
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
	attemptState: "prepared" | "active" | "reported";
	assignmentPath?: string;
	assignmentHash?: string;
	actualModel?: import("./config.ts").ModelChoice;
	worktreeBranch?: string;
	worktreePath?: string;
	agentName?: string;
	paneId?: string;
	workspaceId?: string;
	reportPath: string;
	attention: "none" | "blocked" | "needs-user";
	dispatchPhase: DispatchRecord["phase"] | "assignment-intended";
	evidence?: BuilderEvidenceRecord;
}

export interface ActiveStatusView {
	kind: "present";
	markdown: string;
	footer: ActiveFooterView;
	activeAttempt?: ActiveAttemptStatusView;
}

export interface CompletedStatusView {
	kind: "present";
	completed: true;
	markdown: string;
	footer: EmptyFooterView;
}

export type StatusView = EmptyStatusView | ActiveStatusView | CompletedStatusView;

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

/** The ticket-01 and ticket-02 orchestration operations. */
export interface Steward {
	status(repositoryRoot: string, target: StatusTarget, controllerSessionId?: string): Promise<StatusView>;
	configure(repositoryRoot: string, proposal?: ControllerSessionProposal): Promise<ConfigureResult>;
	start(repositoryRoot: string, controllerSessionId: string): Promise<StartResult>;
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
	if (!task) return { kind: "present", markdown: `Run ${journal.run.id} is active; no Reviewer Task is in progress.`, footer: { run: "active", attentionCount: 0, text: `steward: ${journal.run.id} · active · 0 attention` } };
	const reviewer = latestReviewerAttempt(task);
	const lines = [`Run ${journal.run.id}: active`, `Task ${task.contract.id}: reviewing`, `Rework cycles: ${task.reworkCycles}/${journal.run.effectiveSettings.reworkCycleLimit}`, `Attention: ${task.attention}`];
	if (task.attentionReason) lines.push(`Attention reason: ${task.attentionReason}`);
	if (task.attentionDiagnostic) lines.push(`Attention diagnostic: ${task.attentionDiagnostic}`);
	if (task.approval?.phase === "invalidated") lines.push(`Approval: invalidated (${task.approval.reason}); preserved exact facts require user attention.`);
	if (!reviewer) {
		lines.push("Review dispatch pending; no Reviewer Attempt has been launched.");
	} else {
		lines.push(`Reviewer Attempt ${reviewer.id}: ${reviewer.state}`, `Reviewer dispatch phase: ${reviewer.dispatch.phase}`, `Reviewer Assignment: ${reviewer.assignmentPath}${reviewer.dispatch.phase === "prompt-intended" || reviewer.dispatch.phase === "prompted" ? ` (${reviewer.dispatch.assignmentSha256})` : ""}`, `Reviewer Report: ${reviewer.reportPath}`, `Reviewer Model: ${reviewer.actualModel.model} [thinking=${reviewer.actualModel.thinkingLevel}]`);
		if (reviewer.integrity?.kind === "violated") lines.push(`Review integrity: violated (${reviewer.integrity.after.head}, ${reviewer.integrity.after.dirtyStateFingerprint}); verdict retained but needs-user.`);
		else if (reviewer.integrity?.kind === "preserved") lines.push("Review integrity: preserved; worktree remained read-only.");
		if (reviewer.reportRepair?.phase === "request-intended") lines.push(`Reviewer report repair: request-intended (${reviewer.reportRepair.failure}); no duplicate prompt will be sent.`);
		else if (reviewer.reportRepair?.phase === "requested") lines.push(`Reviewer report repair: requested (${reviewer.reportRepair.failure}); awaiting the same Reviewer.`);
		else if (reviewer.reportRepair?.phase === "blocked") lines.push(`Reviewer report repair: blocked after a second ${reviewer.reportRepair.secondFailure} failure; no further prompt will be sent.`);
		if (reviewer.evidence?.phase === "finalized") lines.push(`Reviewer verdict recorded: ${reviewer.evidence.verdict}; Task remains reviewing.`);
		else if (reviewer.state === "active") lines.push("Awaiting Reviewer Attempt Report; Herdr lifecycle is not a verdict.");
	}
	if (note) lines.push(note);
	const attentionCount = task.attention === "none" ? 0 : 1;
	return { kind: "present", markdown: lines.join("\n"), footer: { run: "active", attentionCount, text: `steward: ${journal.run.id} · reviewing · ${attentionCount} attention` } };
}

function presentApprovedStatus(journal: RunJournal, note?: string): ActiveStatusView {
	const task = journal.run.tasks.find((candidate) => candidate.phase === "approved");
	if (!task || !task.approval) return { kind: "present", markdown: `Run ${journal.run.id} is active; Approval state is unavailable.`, footer: { run: "active", attentionCount: 0, text: `steward: ${journal.run.id} · active · 0 attention` } };
	const lines = [`Run ${journal.run.id}: active`, `Task ${task.contract.id}: approved`, `Rework cycles: ${task.reworkCycles}/${journal.run.effectiveSettings.reworkCycleLimit}`, `Attention: ${task.attention}`, ...(task.attentionReason ? [`Attention reason: ${task.attentionReason}`] : []), ...(task.attentionDiagnostic ? [`Attention diagnostic: ${task.attentionDiagnostic}`] : []), `Approval: ${task.approval.phase}`, `Builder Attempt: ${task.approval.builderAttemptId}`, `Reviewer Attempt: ${task.approval.reviewerAttemptId}`, `Reviewer manifest: ${task.approval.reviewerManifestPath} (${task.approval.reviewerManifestSha256})`, `Review subject: ${JSON.stringify(task.approval.subject)}`, `Clean snapshot: ${task.approval.worktreeSnapshot.head} (${task.approval.worktreeSnapshot.dirtyStateFingerprint})`];
	if (note) lines.push(note);
	const attentionCount = task.attention === "none" ? 0 : 1;
	return { kind: "present", markdown: lines.join("\n"), footer: { run: "active", attentionCount, text: `steward: ${journal.run.id} · approved · ${attentionCount} attention` } };
}

function presentCompletionStatus(journal: RunJournal, note?: string): ActiveStatusView {
	const task = journal.run.tasks[0];
	const completion = journal.run.completion;
	const lines = [`Run ${journal.run.id}: ${journal.run.status}`, ...(task ? [`Task ${task.contract.id}: ${task.phase}`, `Attention: ${task.attention}`, ...(task.attentionReason ? [`Attention reason: ${task.attentionReason}`] : []), ...(task.attentionDiagnostic ? [`Attention diagnostic: ${task.attentionDiagnostic}`] : [])] : []), ...(task?.integration ? [`Integration: ${task.integration.phase}`] : []), ...(journal.run.finalVerificationExecution ? [`Final verification: ${journal.run.finalVerificationExecution.phase}`, `Verification result: ${journal.run.finalVerificationExecution.resultPath}`] : []), ...(completion ? [`Completion: ${completion.phase}`] : []), ...(note ? [note] : [])];
	const attentionCount = task && task.attention !== "none" ? 1 : 0;
	return { kind: "present", markdown: lines.join("\n"), footer: { run: "active", attentionCount, text: `steward: ${journal.run.id} · ${journal.run.status} · ${attentionCount} attention` } };
}

function presentCompletedStatus(journal: RunJournal, note?: string): CompletedStatusView {
	const completion = journal.run.completion;
	const gate = completion && "gate" in completion ? completion.gate : undefined;
	return { kind: "present", completed: true, markdown: [`Run ${journal.run.id}: completed`, ...(gate ? [`Integrated head: ${gate.integratedHead}`] : []), ...(completion?.phase === "archived" ? [`Archive: ${completion.archive.archiveDirectory}`, `Verification result: ${completion.archive.verification.resultPath}`, `Verification output: ${completion.archive.verification.logPath}`] : []), ...(note ? [note] : [])].join("\n"), footer: { run: "none", attentionCount: 0, text: "steward: no active Run" } };
}

function presentStatusForJournal(journal: RunJournal, note?: string): StatusView {
	if (journal.run.status === "completed" || journal.run.completion?.phase === "archived") return presentCompletedStatus(journal, note);
	if (journal.run.status === "completing" || journal.run.tasks.some((candidate) => candidate.phase === "integrating" || candidate.phase === "completed")) return presentCompletionStatus(journal, note);
	if (journal.run.tasks.some((candidate) => candidate.phase === "approved")) return presentApprovedStatus(journal, note);
	if (journal.run.tasks.some((candidate) => candidate.phase === "reviewing")) return presentReviewStatus(journal, note);
	const task = journal.run.tasks.find((candidate) => (candidate.phase === "building" || candidate.phase === "reworking") && candidate.attempts.at(-1)?.role === "builder");
	const attempt = task?.attempts.at(-1);
	if (!task || !attempt) {
		return {
			kind: "present",
			markdown: `Run ${journal.run.id} is active; no Builder Attempt has been dispatched.`,
			footer: { run: "active", attentionCount: 0, text: `steward: ${journal.run.id} · active · 0 attention` },
		};
	}
	if (attempt.role !== "builder") return { kind: "present", markdown: `Run ${journal.run.id} is active; Review is in progress.`, footer: { run: "active", attentionCount: 0, text: `steward: ${journal.run.id} · reviewing · 0 attention` } };
	const dispatch = attempt.dispatch;
	const actual = dispatch.phase === "worktree-intended" ? {} : {
		worktreeBranch: dispatch.branch,
		worktreePath: dispatch.worktreePath,
		agentName: dispatch.agentName,
		paneId: dispatch.paneId,
		workspaceId: dispatch.workspaceId,
		...(dispatch.phase === "prompt-intended" || dispatch.phase === "prompted" ? { assignmentHash: dispatch.assignmentSha256 } : {}),
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
		...(evidenceLines.length > 0 ? evidenceLines : [task.phase === "reworking" ? "Rework: awaiting the same Builder's validated Attempt Report." : "Completion: not inferred from Herdr activity; awaiting a validated Attempt Report."]),
		...(note ? [note] : []),
	];
	return {
		kind: "present",
		markdown: lines.join("\n"),
		footer: { run: "active", attentionCount: task.attention === "needs-user" || task.attention === "blocked" ? 1 : 0, text: `steward: ${journal.run.id} · ${task.phase} · ${task.attention === "needs-user" || task.attention === "blocked" ? 1 : 0} attention` },
		activeAttempt,
	};
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

type ReviewDecision = { journal: RunJournal; note: string };
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

function activeBuilder(journal: RunJournal): { task: TaskRecord; attempt: BuilderAttemptRecord } | undefined {
	const candidates = journal.run.tasks.flatMap((task) => {
		const attempt = task.attempts[task.attempts.length - 1];
		return (task.phase === "building" || task.phase === "reworking") && attempt?.role === "builder" && attempt.state === "active" && attempt.dispatch.phase === "prompted" ? [{ task, attempt }] : [];
	});
	return candidates.length === 1 ? candidates[0] : undefined;
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

async function validateActiveBuilderEvidence(repositoryRoot: string, controllerSessionId: string, loadedJournal: RunJournal, dependencies: StewardDependencies): Promise<EvidenceDecision> {
	const selected = activeBuilder(loadedJournal);
	if (!selected) return { kind: "waiting", journal: loadedJournal, note: "Evidence validation is waiting for exactly one active prompted Builder Attempt." };
	const { task, attempt } = selected;
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
		inputs = await dependencies.runJournal.loadBuilderEvidenceInputs({ repositoryRoot, paths, assignmentSha256: attempt.dispatch.phase === "prompted" ? attempt.dispatch.assignmentSha256 : "" });
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
	const manifest = buildEvidenceManifest({ journal: loadedJournal, task, attempt, report: parsed.value, reportSize: inputs.reportBytes.length, reportSha256: inputs.reportSha256, assignmentSha256: inputs.assignmentSha256, paths, files: referenced.files, ...(gitFacts ? { gitFacts } : {}) });
	const manifestBytes = Buffer.from(serializeFinalizedEvidenceManifest(manifest), "utf8");
	const manifestSha256 = finalizedEvidenceManifestSha256(manifest);
	const intent: BuilderEvidenceRecord = { phase: "finalization-intended", checkedAt: transitionTimestamp(loadedJournal, dependencies.clock.now()), reportSha256: inputs.reportSha256, manifestPath: join(paths.finalizedDirectory, "manifest.json"), manifestSha256 };
	let journal = loadedJournal;
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
	if (replaced.kind !== "replaced") return { kind: "rejected", journal, note: `Evidence rejected (${rejection.codes.join(", ")}); durable rejection write failed and original evidence was preserved.` };
	await dependencies.runJournal.appendActivity(repositoryRoot, { timestamp: replaced.journal.run.updatedAt, runId: replaced.journal.run.id, event: "builder-evidence-rejected", message: `Builder Attempt ${attempt.id} evidence rejected: ${rejection.codes.join(", ")}.` }).catch(() => undefined);
	return { kind: "rejected", journal: replaced.journal, note: `Evidence rejected (${rejection.codes.join(", ")}); Review is blocked and original evidence is preserved.` };
}

function compactUuid(clock: StewardClockAdapter): string {
	const value = clock.randomUUID().replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 8);
	if (value.length === 0) throw new Error("Clock randomUUID must provide identity material.");
	return value;
}

function reviewTaskCandidate(journal: RunJournal): { task: TaskRecord; index: number; builder: BuilderAttemptRecord } | undefined {
	for (let index = 0; index < journal.run.tasks.length; index += 1) {
		const task = journal.run.tasks[index];
		if (!task || !task.contract.reviewRequired) continue;
		const latest = task.attempts[task.attempts.length - 1];
		const pausedBeforeReviewer = task.attention === "needs-user" && task.attempts.length === 1;
		if ((task.attention !== "none" && !pausedBeforeReviewer) || (task.phase !== "reviewing" && task.phase !== "reworking" && task.phase !== "building") || latest?.role !== "builder") continue;
		const builder = latest;
		if (builder.state === "reported" && builder.evidence?.phase === "finalized" && builder.evidence.status === "completed") return { task, index, builder };
	}
	return undefined;
}

function reviewerForTask(task: TaskRecord): ReviewerAttemptRecord | undefined {
	const latest = task.attempts[task.attempts.length - 1];
	return latest?.role === "reviewer" ? latest : undefined;
}

function reviewerTaskCandidate(journal: RunJournal): { task: TaskRecord; index: number; builder: BuilderAttemptRecord; reviewer: ReviewerAttemptRecord } | undefined {
	for (let index = 0; index < journal.run.tasks.length; index += 1) {
		const task = journal.run.tasks[index];
		if (!task || !task.contract.reviewRequired || task.phase !== "reviewing" || task.attention !== "none") continue;
		const reviewer = reviewerForTask(task);
		const preceding = task.attempts[task.attempts.length - 2];
		if (!reviewer || !preceding || preceding.role !== "builder") continue;
		if (preceding.state === "reported" && preceding.evidence?.phase === "finalized" && preceding.evidence.status === "completed") return { task, index, builder: preceding, reviewer };
	}
	return undefined;
}

function latestReviewerAttempt(task: TaskRecord): ReviewerAttemptRecord | undefined {
	return [...task.attempts].reverse().find((attempt): attempt is ReviewerAttemptRecord => attempt.role === "reviewer");
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
			const latest = task.attempts.at(-1);
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
				const attempt = task?.attempts[task.attempts.length - 1];
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
	if (!reviewer.dispatch || reviewer.dispatch.phase !== "prompted" || !dependencies.herdr.promptReviewer) return { journal, note: "Reviewer report is repairable, but the same Reviewer prompt adapter is unavailable; no repair was attempted." };
	let intended: RunJournal;
	try {
		intended = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
			const task = next.run.tasks[candidate.index];
			const attempt = task?.attempts[task.attempts.length - 1];
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
			const attempt = task?.attempts[task.attempts.length - 1];
			if (!task || !attempt || attempt.role !== "reviewer" || attempt.reportRepair?.phase !== "request-intended") throw new Error("Reviewer repair intent disappeared after prompt.");
			attempt.reportRepair = { ...attempt.reportRepair, phase: "requested", requestedAt: transitionTimestamp(persistedIntent, dependencies.clock.now()) };
		});
	} catch (error: unknown) { return { journal: persistedIntent, note: `Reviewer report repair prompt succeeded but requested state could not be persisted; no resend will be attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
	const persistedRequested = await persistReviewJournal(repositoryRoot, requested, dependencies);
	return persistedRequested ? { journal: persistedRequested, note: `Reviewer Attempt ${reviewer.id} received one repair prompt; awaiting repaired report.` } : { journal: persistedIntent, note: "Reviewer report repair prompt succeeded but requested state could not be persisted; no resend will be attempted." };
}

async function validateActiveReviewerReport(repositoryRoot: string, journal: RunJournal, candidate: { index: number; task: TaskRecord; builder: BuilderAttemptRecord }, reviewer: ReviewerAttemptRecord, dependencies: StewardDependencies): Promise<ReviewDecision> {
	if (!dependencies.git.inspectReviewWorktree || !dependencies.runJournal.loadReviewerEvidenceInputs || !dependencies.runJournal.inspectReferencedReviewerEvidence || !dependencies.runJournal.finalizeReviewerEvidence) return { journal, note: "Review evidence adapters are unavailable; Review remains pending and no verdict was inferred." };
	let before: import("./run.ts").ReviewWorktreeSnapshot | { kind: "unavailable"; message: string };
	try { before = await dependencies.git.inspectReviewWorktree(reviewer.worktree.path); } catch (error: unknown) { return { journal, note: `Reviewer worktree inspection failed; no verdict was inferred. ${error instanceof Error ? error.message : "Inspection failed."}` }; }
	if ("kind" in before) return { journal, note: `Reviewer worktree inspection is unavailable; no verdict was inferred. ${before.message}` };
	if (!worktreeSnapshotsEqual(before, reviewer.worktree.baseline)) return recordReviewerViolation(repositoryRoot, journal, candidate, reviewer, before, dependencies);
	if (reviewer.integrity?.kind === "violated") return { journal, note: "Reviewer read-only violation is retained; finalized evidence bytes are preserved and no verdict is eligible." };
	if (reviewer.state === "reported" && reviewer.evidence?.phase === "finalized") return interpretReviewerVerdict(repositoryRoot, journal, candidate, reviewer, dependencies);
	const paths = evidencePathsFor(reviewer);
	const assignmentSha256 = reviewer.dispatch.phase === "prompt-intended" || reviewer.dispatch.phase === "prompted" ? reviewer.dispatch.assignmentSha256 : "";
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
	const finalDirectory = paths.finalizedDirectory;
	const logs = referenced.files.map((file) => { const log = parsed.value!.logReferences.find((item) => item.path === file.path)!; return { id: log.id, originalPath: file.path, finalizedPath: join(finalDirectory, "logs", `${log.id}.log`), size: file.size, sha256: file.sha256 }; });
	const manifest = buildFinalizedReviewerEvidenceManifest({ runId: journal.run.id, taskId: candidate.task.contract.id, attempt: reviewer, report: parsed.value, reportSize: inputs.reportBytes.length, reportSha256: inputs.reportSha256, assignmentSha256: inputs.assignmentSha256, finalizedDirectory: finalDirectory, logs, after });
	const manifestBytes = Buffer.from(serializeFinalizedReviewerEvidenceManifest(manifest), "utf8");
	const manifestSha256 = finalizedReviewerEvidenceManifestSha256(manifest);
	let intended: RunJournal;
	try {
		intended = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
			const task = next.run.tasks[candidate.index];
			const attempt = task ? latestReviewerAttempt(task) : undefined;
			if (!task || !attempt) throw new Error("Reviewer Attempt disappeared before finalization intent.");
			attempt.integrity = { kind: "preserved", after: reviewSnapshotFor(after as import("./run.ts").ReviewWorktreeSnapshot) };
			attempt.evidence = { phase: "finalization-intended", checkedAt: transitionTimestamp(journal, dependencies.clock.now()), reportSha256: inputs.reportSha256, manifestPath: join(finalDirectory, "manifest.json"), manifestSha256, subject: { ...reviewer.subject, ...(reviewer.subject.kind === "git" ? { commits: [...reviewer.subject.commits] } : { artifacts: reviewer.subject.artifacts.map((artifact) => ({ ...artifact })) }) } };
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
			attempt.integrity = { kind: "preserved", after: reviewSnapshotFor(after as import("./run.ts").ReviewWorktreeSnapshot) };
			attempt.evidence = { phase: "finalized", finalizedAt: transitionTimestamp(persistedIntent, dependencies.clock.now()), verdict: parsed.value!.verdict, reportSha256: inputs.reportSha256, manifestPath: finalizedManifestPath, manifestSha256: finalizedManifestSha256, subject: { ...reviewer.subject, ...(reviewer.subject.kind === "git" ? { commits: [...reviewer.subject.commits] } : { artifacts: reviewer.subject.artifacts.map((artifact) => ({ ...artifact })) }) } };
		});
	} catch (error: unknown) { return { journal: persistedIntent, note: `Reviewer evidence was finalized but the reported Journal state could not be persisted; no resend will be attempted. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
	const persisted = await persistReviewJournal(repositoryRoot, reported, dependencies);
	if (!persisted) return { journal: persistedIntent, note: "Reviewer evidence was finalized but the reported Journal state could not be persisted; no resend will be attempted." };
	await dependencies.runJournal.appendActivity(repositoryRoot, { timestamp: persisted.run.updatedAt, runId: persisted.run.id, event: "reviewer-evidence-finalized", message: `Reviewer Attempt ${reviewer.id} finalized with explicit ${parsed.value.verdict} verdict; Task remains reviewing.` }).catch(() => undefined);
	const updatedTask = persisted.run.tasks[candidate.index];
	const updatedReviewer = updatedTask?.attempts[updatedTask.attempts.length - 1];
	return updatedTask && updatedReviewer?.role === "reviewer" ? interpretReviewerVerdict(repositoryRoot, persisted, { ...candidate, task: updatedTask }, updatedReviewer, dependencies) : { journal: persisted, note: "Reviewer evidence finalized; explicit verdict recorded while Task remains reviewing." };
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
	let journal = journalInput;
	const builderDispatch = candidate.builder.dispatch;
	if (builderDispatch.phase !== "prompted") return { journal, note: "Reviewer dispatch is waiting for a fully prompted Builder identity; no Reviewer effect was attempted." };
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
		});
	} catch (error: unknown) { return { journal, note: `Reviewer pane intent could not be built; no pane was created. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
	const persistedPrepared = await persistReviewJournal(repositoryRoot, preparedJournal, dependencies);
	if (!persistedPrepared) return { journal, note: "Reviewer pane intent could not be persisted; no pane was created." };
	journal = persistedPrepared;
	let pane: import("./steward.ts").HerdrReviewerPaneResult;
	try { pane = await dependencies.herdr.createReviewerPane({ repositoryRoot, sourcePaneId: builderDispatch.paneId, worktreePath: builderDispatch.worktreePath, branch: builderDispatch.branch, agentName, workspaceId: builderDispatch.workspaceId }); }
	catch (error: unknown) { return { journal, note: `Reviewer pane creation failed; dispatch remains at pane-intended and no verdict exists. ${error instanceof Error ? error.message : "Herdr pane split failed."}` }; }
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

async function advanceEligibleReview(repositoryRoot: string, controllerSessionId: string, journal: RunJournal, dependencies: StewardDependencies): Promise<ReviewDecision> {
	const reviewerSelected = reviewerTaskCandidate(journal);
	if (reviewerSelected) return validateActiveReviewerReport(repositoryRoot, journal, reviewerSelected, reviewerSelected.reviewer, dependencies);
	const selected = reviewTaskCandidate(journal);
	if (!selected) return { journal, note: "" };
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
		let confirmed = false;
		if (!dependencies.ui.confirmSameFamilyReview) return pauseReview(repositoryRoot, selected, journal, dependencies, "Same-provider Reviewer confirmation is unavailable; Review is paused for explicit Controller confirmation.");
		try { confirmed = await dependencies.ui.confirmSameFamilyReview({ builderModel: selected.builder.actualModel, reviewerModel: selection.choice, subject: derived.subject, provider: selection.provider }); }
		catch { confirmed = false; }
		if (!confirmed) return pauseReview(repositoryRoot, selected, journal, dependencies, `Same-provider Reviewer ${selection.choice.model} was not approved for this exact subject; Review is paused for explicit Controller confirmation.`);
		independence = { kind: "same-provider-family-approved", provider: selection.provider, approvedAt: dependencies.clock.now().toISOString(), controllerSessionId };
	} else independence = { kind: "different-provider-family", builderProvider: selection.builderProvider, reviewerProvider: selection.reviewerProvider };
	if (!dependencies.git.inspectReviewWorktree) return { journal, note: "Review dispatch pending; read-only Git snapshot inspection is unavailable." };
	let snapshot: import("./run.ts").ReviewWorktreeSnapshot | { kind: "unavailable"; message: string };
	const builderDispatch = selected.builder.dispatch;
	if (builderDispatch.phase !== "prompted") return { journal, note: "Review dispatch is waiting for the prompted Builder identity; no Reviewer effect was attempted." };
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
	return ["integration-preflight", "integration-failed", "integration-ambiguous", "final-verification-unexecutable", "final-verification-failed", "final-verification-ambiguous", "verification-dirtied-checkout", "agent-stop-failed", "archive-failed"].includes(reason);
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

function completionIntegrationIdentity(journal: RunJournal, task: TaskRecord, evidence: { subject: ReviewSubject; builder: BuilderAttemptRecord; reviewer: ReviewerAttemptRecord }): TaskIntegration | undefined {
	if (journal.run.integrationBase.kind !== "git" || evidence.subject.kind !== "git" || evidence.builder.evidence?.phase !== "finalized" || evidence.reviewer.evidence?.phase !== "finalized") return undefined;
	return {
		phase: "intended",
		targetBranch: journal.run.integrationBase.branch,
		targetRevision: journal.run.integrationBase.revision,
		approvedBaseRevision: evidence.subject.baseRevision,
		approvedHeadRevision: evidence.subject.headRevision,
		approvedCommits: [...evidence.subject.commits],
		builderAttemptId: evidence.builder.id,
		reviewerAttemptId: evidence.reviewer.id,
		builderManifestSha256: evidence.builder.evidence.manifestSha256,
		reviewerManifestSha256: evidence.reviewer.evidence.manifestSha256,
		action: { kind: "fast-forward", argv: ["merge", "--ff-only", "--no-edit", evidence.subject.headRevision] },
		intendedAt: "",
	};
}

function integrationObservationExact(input: IntegrationCheckoutInput, result: import("./steward.ts").IntegrationCheckoutResult): boolean {
	return input.targetRevision === input.approvedBaseRevision && result.kind === "inspected" && result.observation.rangeExact && result.observation.branch === input.targetBranch && result.observation.head === input.approvedHeadRevision && result.observation.dirtyPaths.length === 0 && result.observation.operationMarkers.length === 0 && result.resolvedBaseRevision === input.approvedBaseRevision && result.resolvedHeadRevision === input.approvedHeadRevision && JSON.stringify(result.commits) === JSON.stringify(input.approvedCommits);
}

function integrationObservationUnchanged(input: IntegrationCheckoutInput, result: import("./steward.ts").IntegrationCheckoutResult): boolean {
	return input.targetRevision === input.approvedBaseRevision && result.kind === "inspected" && result.observation.branch === input.targetBranch && result.observation.head === input.targetRevision && result.observation.dirtyPaths.length === 0 && result.observation.operationMarkers.length === 0;
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
			if (dispatch.phase !== "prompted") continue;
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

function completionGateFacts(journal: RunJournal, checkout: IntegrationCheckoutObservation, dependencies: StewardDependencies): CompletionGateFacts | undefined {
	const result = evaluateCompletionGate(journal, checkout);
	if (!result.passed) return undefined;
	return { ...result.facts, evaluatedAt: transitionTimestamp(journal, dependencies.clock.now()), predicates: [...COMPLETION_GATE_PREDICATES] };
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
	const failure: CompletionStopFailure = { state, resource: { ...resource }, observedAt: transitionTimestamp(journal, dependencies.clock.now()), diagnostic: diagnostic.slice(0, 2_000) };
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

async function advanceApprovedCompletion(repositoryRoot: string, journalInput: RunJournal, dependencies: StewardDependencies): Promise<CompletionDecision> {
	let journal = journalInput;
	if (journal.run.status === "completing") return advanceCompletionLifecycle(repositoryRoot, journal, dependencies);
	if (journal.run.status !== "active") return { journal, note: "" };
	const approvedTasks = journal.run.tasks.filter((candidate) => candidate.phase === "approved" && candidate.attention === "none" && candidate.approval?.phase === "valid");
	const integratingTask = journal.run.tasks.find((candidate) => candidate.integration?.phase === "integrated");
	if (approvedTasks.length === 0 && !integratingTask) return { journal, note: "" };
	if (approvedTasks.length > 1 || journal.run.tasks.length !== 1) {
		const target = approvedTasks[0] ?? journal.run.tasks[0];
		return target ? persistCompletionAttention(repositoryRoot, journal, target.contract.id, "integration-preflight", "Ticket-08 completion requires exactly one ordered code-changing Task; no integration effect was attempted.", dependencies) : { journal, note: "Ticket-08 completion requires exactly one ordered Task; no effect was attempted." };
	}
	let task = journal.run.tasks[0]!;
	if (!task.contract.expectedArtifacts.some((artifact) => artifact.kind === "git-commit") || !task.contract.reviewRequired) return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "integration-preflight", "Ticket-08 completion requires one reviewed code-changing Task; no integration effect was attempted.", dependencies);
	if (task.phase === "approved" && task.attention === "none" && !task.integration) {
		if (!dependencies.git.inspectIntegrationCheckout || !dependencies.git.integrateApprovedRange) return { journal, note: "Integration adapters are unavailable; Approval remains unchanged and no Git effect was attempted." };
		const evidence = await loadCompletionEvidence(repositoryRoot, task, journal, dependencies);
		if ("message" in evidence) return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "integration-preflight", evidence.message, dependencies);
		if (evidence.subject.kind !== "git" || journal.run.integrationBase.kind !== "git") return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "integration-preflight", "Approved completion requires a Git Builder subject and Git integration base; no Git effect was attempted.", dependencies);
		const input: IntegrationCheckoutInput = { repositoryRoot, targetBranch: journal.run.integrationBase.branch, targetRevision: journal.run.integrationBase.revision, approvedBaseRevision: evidence.subject.baseRevision, approvedHeadRevision: evidence.subject.headRevision, approvedCommits: [...evidence.subject.commits] };
		const preflight = await inspectCompletionCheckout(input, dependencies);
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
		if (classified.phase !== "integrated") return { journal, note: classified.diagnostic };
	}
	task = journal.run.tasks[0]!;
	if (!task.integration || task.integration.phase === "intended") return { journal, note: task.integration ? "Integration intent is durably retained; ticket-08 will not retry or infer its post-state." : "" };
	if (task.integration.phase !== "integrated") return { journal, note: task.attentionDiagnostic ?? "Integration is paused for user attention; no retry or recovery was attempted." };
	if (task.attention !== "none") return { journal, note: task.attentionDiagnostic ?? "Integrated Task remains paused for user attention." };
	if (!journal.run.finalVerificationExecution) {
		if (journal.run.finalVerification.kind !== "command") return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "final-verification-unexecutable", "Final verification is criteria-only; ticket-08 requires one frozen executable command and did not launch a process.", dependencies);
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
	}
	task = journal.run.tasks[0]!;
	if (task.attention !== "none") return { journal, note: task.attentionDiagnostic ?? "Final verification is paused for user attention; no rerun was attempted." };
	const execution = journal.run.finalVerificationExecution;
	if (!execution || execution.phase !== "passed") return { journal, note: "Final verification has not produced a conclusive passing result; no rerun was attempted." };
	const checkout = execution.checkout;
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
	return advanceCompletionLifecycle(repositoryRoot, persistedGate, dependencies);
}

async function advanceCompletionLifecycle(repositoryRoot: string, journalInput: RunJournal, dependencies: StewardDependencies): Promise<CompletionDecision> {
	let journal = journalInput;
	const task = journal.run.tasks[0];
	if (!task || journal.run.status !== "completing" || !journal.run.completion) return { journal, note: "" };
	if (task.attention !== "none") return { journal, note: task.attentionDiagnostic ?? `Completion is paused (${task.attentionReason ?? "needs-user"}).` };
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
		const archive: CompletionArchiveIntent = { intendedAt: transitionTimestamp(journal, dependencies.clock.now()), archiveDirectory: paths.archiveDirectory, runPath: paths.archiveRunPath, previousRunPath: paths.archivePreviousRunPath, manifestPath: paths.archiveManifestPath, activeJournalSha256: sha256Bytes(pointers.pointers.activeBytes), previousJournalSha256: sha256Bytes(pointers.pointers.previousBytes), verification: { logPath: execution.logPath, resultPath: execution.resultPath, logSha256: execution.logSha256, resultSha256: execution.resultSha256 }, reports };
		let archiveIntentJournal: RunJournal;
		try { archiveIntentJournal = advanceRunJournal(journal, dependencies.clock.now(), (next) => { const current = next.run.completion; if (!current || current.phase !== "stops-complete") throw new Error("Graceful-stop completion disappeared before archive intent."); next.run.completion = { phase: "archive-intended", gate: current.gate, resources: current.resources.map((resource) => ({ ...resource, acknowledgement: { ...resource.acknowledgement } })), archive }; }); }
		catch (error: unknown) { return { journal, note: `Archive intent could not be persisted; active evidence was preserved. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
		const persisted = await persistReviewJournal(repositoryRoot, archiveIntentJournal, dependencies);
		if (!persisted) return { journal, note: "Archive intent could not be persisted; active evidence was preserved." };
		journal = persisted;
		const finalPointers = await dependencies.runJournal.loadCompletionJournalPointers(repositoryRoot);
		if (finalPointers.kind !== "loaded") return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "archive-failed", finalPointers.message, dependencies);
		const finalJournal = advanceRunJournal(journal, dependencies.clock.now(), (next) => { const current = next.run.completion; if (!current || current.phase !== "archive-intended") throw new Error("Archive intent disappeared before final snapshot."); const archive = { ...current.archive, activeJournalSha256: sha256Bytes(finalPointers.pointers.activeBytes), previousJournalSha256: sha256Bytes(finalPointers.pointers.previousBytes) }; next.run.status = "completed"; next.run.tasks[0]!.phase = "completed"; next.run.tasks[0]!.attention = "none"; delete next.run.tasks[0]!.attentionReason; delete next.run.tasks[0]!.attentionDiagnostic; next.run.completion = { phase: "archived", gate: current.gate, resources: current.resources.map((resource) => ({ ...resource, acknowledgement: { ...resource.acknowledgement } })), archive, archivedAt: transitionTimestamp(journal, dependencies.clock.now()) }; }, "archive/run.json");
		const published = await dependencies.runJournal.archiveCompletedRun({ repositoryRoot, runId: journal.run.id, run: finalJournal, archivedAt: finalJournal.run.completion?.phase === "archived" ? finalJournal.run.completion.archivedAt : dependencies.clock.now().toISOString(), verification: archive.verification, reports });
		if (published.kind !== "published" && published.kind !== "existing-match") return persistCompletionAttention(repositoryRoot, journal, task.contract.id, "archive-failed", `Completion archive was not published: ${"message" in published ? published.message : "unknown archive failure"}`, dependencies);
		await dependencies.runJournal.appendActivity(repositoryRoot, { timestamp: finalJournal.run.updatedAt, runId: finalJournal.run.id, event: "run-completed", message: `Run ${finalJournal.run.id} was archived at ${paths.archiveDirectory}.` }).catch(() => undefined);
		try { dependencies.ui.notifyCompletion?.({ runId: journal.run.id, targetBranch: journal.run.integrationBase.kind === "git" ? journal.run.integrationBase.branch : "unknown", integratedHead: completion.gate.integratedHead, verificationResultPath: execution.resultPath, verificationLogPath: execution.logPath, archivePath: paths.archiveDirectory }); } catch { /* The archive remains authoritative if UI delivery fails. */ }
		return { journal: finalJournal, note: `Run ${journal.run.id} archived and completion notification was attempted.`, completed: true };
	}
	return { journal, note: "" };
}

async function dispatchReworkBuilder(repositoryRoot: string, journalInput: RunJournal, candidate: { index: number; task: TaskRecord; builder: BuilderAttemptRecord }, reviewer: ReviewerAttemptRecord, findings: import("./review.ts").ReviewerFinding[], dependencies: StewardDependencies): Promise<ReviewDecision> {
	let journal = journalInput;
	const previousDispatch = candidate.builder.dispatch;
	if (previousDispatch.phase !== "prompted" || !dependencies.git.inspectBuilderWorktree || !dependencies.herdr.promptBuilder) return pauseReview(repositoryRoot, candidate, journal, dependencies, "Rework requires the original prompted Builder identity and read-only worktree/prompt adapters; no replacement Builder was created.");
	if (reviewer.subject.kind !== "git") return pauseReview(repositoryRoot, candidate, journal, dependencies, "Automatic same-Builder rework is only available for the existing Git flow; preserved non-Git evidence requires user attention.");
	let inspected: { kind: "ready"; head: string; clean: true } | { kind: "unavailable"; message: string };
	try { inspected = await dependencies.git.inspectBuilderWorktree(previousDispatch.worktreePath, reviewer.subject.headRevision); } catch (error: unknown) { return pauseReview(repositoryRoot, candidate, journal, dependencies, `Rework preflight failed; no Attempt was reserved. ${error instanceof Error ? error.message : "Builder worktree inspection failed."}`); }
	if (inspected.kind !== "ready" || inspected.head !== reviewer.subject.headRevision || !inspected.clean) return pauseReview(repositoryRoot, candidate, journal, dependencies, `Rework preflight requires the same clean Builder worktree at reviewed head ${reviewer.subject.headRevision}; no Attempt was reserved.`);
	const cycle = candidate.task.reworkCycles + 1;
	const attemptId = `attempt-${String(candidate.task.attempts.length + 1).padStart(2, "0")}`;
	const dispatch: ReworkDispatchRecord = { phase: "assignment-intended", branch: previousDispatch.branch, agentName: previousDispatch.agentName, worktreePath: previousDispatch.worktreePath, workspaceId: previousDispatch.workspaceId, paneId: previousDispatch.paneId, terminalId: previousDispatch.terminalId, cycle, priorBuilderAttemptId: candidate.builder.id, priorReviewerAttemptId: reviewer.id, reviewedSubject: cloneReviewSubject(reviewer.subject), reviewerManifestPath: reviewer.evidence?.phase === "finalized" ? reviewer.evidence.manifestPath : "", reviewerManifestSha256: reviewer.evidence?.phase === "finalized" ? reviewer.evidence.manifestSha256 : "", findings: findings.map((finding) => ({ ...finding })) };
	if (!dispatch.reviewerManifestPath || !dispatch.reviewerManifestSha256) return pauseReview(repositoryRoot, candidate, journal, dependencies, "Rework findings are not bound to a protected Reviewer manifest; no Attempt was reserved.");
	const paths = dependencies.runJournal.resolveAssignmentPaths(repositoryRoot, journal.run.id, candidate.task.contract.id, attemptId);
	const prepared: BuilderAttemptRecord = { id: attemptId, role: "builder", state: "prepared", preparedAt: transitionTimestamp(journal, dependencies.clock.now()), actualModel: { ...candidate.builder.actualModel }, specificationHash: candidate.task.specificationHash, baseRevision: candidate.builder.baseRevision, assignmentPath: paths.assignmentPath, reportPath: paths.reportPath, evidenceDirectory: paths.evidenceDirectory, dispatch };
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
		});
	} catch (error: unknown) { return { journal, note: `Rework cycle reservation failed before Assignment or prompt effects. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
	const persistedReserved = await persistReviewJournal(repositoryRoot, reserved, dependencies);
	if (!persistedReserved) return { journal, note: "Rework cycle reservation could not be persisted; no Assignment or prompt effect was attempted." };
	journal = persistedReserved;
	const task = journal.run.tasks[candidate.index];
	const attempt = task?.attempts[task.attempts.length - 1];
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
			const current = currentTask?.attempts[currentTask.attempts.length - 1];
			if (!current || current.role !== "builder" || !("cycle" in current.dispatch)) throw new Error("Reserved rework Attempt disappeared before prompt intent.");
			current.dispatch = { ...current.dispatch, phase: "prompt-intended", assignmentSha256: assignmentHash };
		});
	} catch (error: unknown) { return { journal, note: `Rework Builder prompt intent could not be built; no prompt was sent. ${error instanceof Error ? error.message : "Journal validation failed."}` }; }
	const persistedIntent = await persistReviewJournal(repositoryRoot, promptIntent, dependencies);
	if (!persistedIntent) return { journal, note: "Rework Builder prompt intent could not be persisted; no prompt was sent." };
	journal = persistedIntent;
	let prompted: HerdrPromptResult;
	try { prompted = await dependencies.herdr.promptBuilder({ repositoryRoot, name: previousDispatch.agentName, assignmentPrompt: formatBuilderPrompt(assignment) }); } catch (error: unknown) { return { journal, note: `Same Builder rework prompt failed; prompt-intended state is retained without a resend. ${error instanceof Error ? error.message : "Herdr prompt failed."}` }; }
	if (prompted.kind !== "prompted" || prompted.name !== previousDispatch.agentName || prompted.workspaceId !== previousDispatch.workspaceId || prompted.paneId !== previousDispatch.paneId || prompted.terminalId !== previousDispatch.terminalId || !validIdentity(prompted.tabId)) return { journal, note: "Same Builder rework prompt envelope was malformed; prompt-intended state is retained without a resend." };
	let active: RunJournal;
	try {
		active = advanceRunJournal(journal, dependencies.clock.now(), (next) => {
			const currentTask = next.run.tasks[candidate.index];
			const current = currentTask?.attempts[currentTask.attempts.length - 1];
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
	for (let index = 0; index < journal.run.tasks.length; index += 1) {
		const task = journal.run.tasks[index];
		if (task && task.phase === "pending" && task.attempts.length === 0 && isCodeChanging([task])) return { task, index };
	}
	return undefined;
}

async function dispatchInitialBuilder(input: {
	repositoryRoot: string;
	controllerSessionId: string;
	journal: RunJournal;
	dependencies: StewardDependencies;
}): Promise<DispatchOutcome> {
	const { repositoryRoot, dependencies } = input;
	let journal = input.journal;
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

	const selected = findInitialCodeTask(journal);
	if (!selected) return { kind: "dispatched", journal, message: `Run ${journal.run.id} started; no approved code-changing Task is awaiting its initial Builder.`, warnings };
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
	const attemptId = "attempt-01";
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
	const initialAttempt: AttemptRecord = {
		id: attemptId,
		role: "builder",
		state: "prepared",
		preparedAt: transitionTimestamp(journal, dependencies.clock.now()),
		actualModel: model,
		specificationHash: task.specificationHash,
		baseRevision: journal.run.integrationBase.revision,
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
			candidateTask.attempts = [initialAttempt];
		});
	} catch (error: unknown) {
		return pending(`Builder Attempt could not be prepared durably. ${error instanceof Error ? error.message : "Journal validation failed."}`);
	}
	if (!(await persist(prepared, "attempt-prepared"))) return pending("Builder Attempt preparation could not be persisted; dispatch is pending.");
	await note("attempt-prepared", `Prepared Builder Attempt ${attemptId} for Task ${task.contract.id}.`);

	let worktree: Extract<HerdrWorktreeCreateResult, { kind: "created" }>;
	try {
		const result = await dependencies.herdr.createBuilderWorktree({ repositoryRoot, branch, baseRevision: journal.run.integrationBase.revision, label: agentName });
		if (result.kind !== "created" || result.branch !== branch || !isAbsolutePath(result.path) || !validIdentity(result.workspaceId) || !validIdentity(result.paneId) || !validIdentity(result.terminalId) || !validIdentity(result.tabId)) return pending("Herdr returned a malformed or contradictory worktree envelope; dispatch is pending.");
		worktree = result;
	} catch (error: unknown) {
		return pending(`Builder worktree creation failed; dispatch is pending. ${error instanceof Error ? error.message : "Herdr worktree create failed."}`);
	}
	let inspected: BuilderWorktreeInspection;
	try {
		inspected = await dependencies.git.inspectBuilderWorktree(worktree.path, journal.run.integrationBase.revision);
	} catch (error: unknown) {
		return pending(`Builder worktree verification failed; dispatch is pending. ${error instanceof Error ? error.message : "Git inspection failed."}`);
	}
	if (inspected.kind !== "ready" || inspected.head !== journal.run.integrationBase.revision || !inspected.clean) return pending("Builder worktree base or clean-head verification failed; dispatch is pending.");

	let actualStart: Extract<HerdrAgentStartResult, { kind: "started" }> | undefined;
	for (let collision = 0; collision < 8; collision += 1) {
		let intended: RunJournal;
		try {
			intended = advanceRunJournal(journal, dependencies.clock.now(), (candidate) => {
				const candidateTask = candidate.run.tasks[selected.index];
				const candidateAttempt = candidateTask?.attempts[0];
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

		const agentIntent = journal.run.tasks[selected.index]?.attempts[0];
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
			const candidateAttempt = candidateTask?.attempts[0];
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
	if (prompted.kind !== "prompted" || prompted.name !== agentName || prompted.workspaceId !== worktree.workspaceId || prompted.paneId !== worktree.paneId || prompted.terminalId !== worktree.terminalId || !validIdentity(prompted.tabId)) return pending("Herdr returned a malformed or contradictory Builder prompt envelope; dispatch is pending without a resend.");
	const promptedAt = transitionTimestamp(journal, dependencies.clock.now());
	let active: RunJournal;
	try {
		active = advanceRunJournal(journal, dependencies.clock.now(), (candidate) => {
			const candidateTask = candidate.run.tasks[selected.index];
			const candidateAttempt = candidateTask?.attempts[0];
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

/** Assemble the plain-function orchestration seam without adding lifecycle machinery. */
export function createSteward({ runJournal, herdr, git, process, model, clock, ui }: StewardDependencies): Steward {
	void process;
	async function status(repositoryRoot: string, target: StatusTarget, controllerSessionId?: string): Promise<StatusView> {
		const loaded = await runJournal.loadActive(repositoryRoot);
		let statusView: StatusView = loaded.kind === "missing"
			? EMPTY_STATUS
			: loaded.kind === "invalid"
				? {
					kind: "present" as const,
					markdown: `Active Steward Run state is invalid at ${loaded.paths.activePath}; status is read-only. ${loaded.diagnostics.map((item) => item.message).join(" ")}`,
					footer: { run: "active" as const, attentionCount: 0 as const, text: "steward: active Run needs recovery" },
				}
				: presentStatusForJournal(loaded.journal);
		if (loaded.kind === "loaded" && target === "command" && controllerSessionId !== undefined && loaded.journal.run.controllerSessionId === controllerSessionId) {
			let currentJournal = loaded.journal;
			let note = "";
			const candidate = activeBuilder(currentJournal);
			if (candidate) {
				const decision = await validateActiveBuilderEvidence(repositoryRoot, controllerSessionId, currentJournal, { runJournal, herdr, git, process, model, clock, ui });
				currentJournal = decision.journal;
				note = decision.note;
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
			statusView = completion.completed ? presentCompletedStatus(currentJournal, completion.note) : presentStatusForJournal(currentJournal, note);
		} else if (loaded.kind === "loaded" && target === "command" && controllerSessionId !== undefined && loaded.journal.run.controllerSessionId !== controllerSessionId) {
			statusView = presentStatusForJournal(loaded.journal, "Controller Session does not match; evidence validation is read-only until the authorized Controller returns.");
		}
		ui.presentStatus(statusView, target);
		return statusView;
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
		if (initialActive.kind === "invalid") return refuse(`Run start is disabled because the active Run Journal is invalid at ${initialActive.paths.activePath}. Recovery snapshots: ${initialActive.paths.activePath} and ${initialActive.paths.previousPath}.`);

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

	return { status, configure, start };
}
