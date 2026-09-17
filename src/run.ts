import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import {
	cloneModelPlans,
	cloneRecoveryDefaults,
	validateProjectModelPlans,
	validateRecoveryDefaults,
	type ConfigDiagnostic,
	type ProjectModelPlans,
	type RecoveryDefaults,
} from "./config.ts";

export const RUN_JOURNAL_SCHEMA_VERSION = 1 as const;

export type RunStatus = "active";
export type TaskPhase = "pending";
export type TaskAttention = "none";

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

export interface TaskRecord {
	specificationVersion: 1;
	specificationHash: string;
	contract: TaskContract;
	phase: TaskPhase;
	attention: TaskAttention;
	attempts: [];
	reworkCycles: 0;
}

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
	if (!trimmedString(value) || isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\")) return false;
	const segments = value.split(/[\\/]/);
	return segments.every((segment) => segment.length > 0 && segment !== ".." && segment !== ".");
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

function canonicalContract(contract: TaskContract): TaskContract {
	return cloneContract(contract);
}

export function serializeTaskContract(contract: TaskContract): string {
	return JSON.stringify(canonicalContract(contract));
}

export function specificationHash(contract: TaskContract): string {
	return `sha256:${createHash("sha256").update(serializeTaskContract(contract), "utf8").digest("hex")}`;
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
		if (!isRecord(task) || !exactKeys(task, ["specificationVersion", "specificationHash", "contract", "phase", "attention", "attempts", "reworkCycles"])) {
			diagnostics.push(diagnostic("invalid-task", "Task contains unknown or missing initialization keys.", taskPath));
			continue;
		}
		const contractResult = validateContract(task.contract, `${taskPath}.contract`, true);
		const taskDiagnostics = [...contractResult.diagnostics];
		if (task.specificationVersion !== 1) taskDiagnostics.push(diagnostic("invalid-task", "Task specificationVersion must be 1.", `${taskPath}.specificationVersion`));
		if (typeof task.specificationHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(task.specificationHash) || (contractResult.value && specificationHash(contractResult.value) !== task.specificationHash)) taskDiagnostics.push(diagnostic("invalid-task", "Task specificationHash does not match its exact contract.", `${taskPath}.specificationHash`));
		if (task.phase !== "pending" || task.attention !== "none" || !Array.isArray(task.attempts) || task.attempts.length !== 0 || task.reworkCycles !== 0) taskDiagnostics.push(diagnostic("invalid-task", "New Tasks must be pending with no attention, attempts, or rework cycles.", taskPath));
		if (contractResult.value && taskIds.has(contractResult.value.id)) taskDiagnostics.push(diagnostic("invalid-task", "Task IDs must be unique.", `${taskPath}.contract.id`));
		if (contractResult.value) taskIds.add(contractResult.value.id);
		if (taskDiagnostics.length > 0 || !contractResult.value || typeof task.specificationHash !== "string") diagnostics.push(...taskDiagnostics);
		else tasks.push({ specificationVersion: 1, specificationHash: task.specificationHash, contract: contractResult.value, phase: "pending", attention: "none", attempts: [], reworkCycles: 0 });
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
