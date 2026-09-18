import {
	parseCanonicalModelReference,
	isThinkingLevel,
	type ModelChoice,
} from "./config.ts";
import {
	specificationHash,
	type AttemptRecord,
	type BuilderAssignmentDocument,
	type ExpectedArtifact,
	type TaskContract,
} from "./run.ts";

export const BUILDER_REPORT_SCHEMA_VERSION = 1 as const;
export const MAX_BUILDER_REPORT_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 2_000;
const MAX_BLOCKER_BYTES = 1_000;
const MAX_COLLECTION_ENTRIES = 100;

export type BuilderReportStatus = "completed" | "blocked" | "failed";

export interface ReportedArtifactGitCommit {
	kind: "git-commit";
	baseRevision: string;
	headRevision: string;
	commits: string[];
}

export interface ReportedArtifactFile {
	kind: "file";
	path: string;
	evidencePath: string;
	size: number;
	sha256: string;
}

export interface ReportedArtifactEvidence {
	kind: "evidence";
	description: string;
	path: string;
	size: number;
	sha256: string;
}

export type ReportedArtifact = ReportedArtifactGitCommit | ReportedArtifactFile | ReportedArtifactEvidence;

export type ReportedCheck =
	| { kind: "command"; command: string; exitCode: number; summary: string; logId: string }
	| { kind: "criteria"; criteria: string; result: "met" | "not-met"; summary: string; logId: string };

export interface ReportedLogReference {
	id: string;
	path: string;
	size: number;
	sha256: string;
}

export interface BuilderAttemptReport {
	schemaVersion: typeof BUILDER_REPORT_SCHEMA_VERSION;
	identity: {
		runId: string;
		taskId: string;
		attemptId: string;
		role: "builder";
		specificationHash: string;
		assignmentSha256: string;
	};
	status: BuilderReportStatus;
	summary: string;
	blockers: string[];
	producedArtifacts: ReportedArtifact[];
	actualModel: ModelChoice;
	checks: ReportedCheck[];
	logReferences: ReportedLogReference[];
	producedRevision: string | null;
}

export interface ReportDiagnostic {
	code: string;
	message: string;
	path?: string;
}

export interface ProducedGitFacts {
	kind: "inspected";
	base: string;
	head: string;
	commits: string[];
	changedPaths: Array<{ status: string; paths: string[] }>;
	clean: true;
}

export interface NormalizedBuilderEvidence {
	report: BuilderAttemptReport;
	assignment: BuilderAssignmentDocument;
	assignmentSha256: string;
	reportSha256?: string;
	gitArtifact?: ReportedArtifactGitCommit;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function trimmed(value: unknown, maximumBytes: number): value is string {
	return typeof value === "string" && value.length > 0 && value === value.trim() && !value.includes("\u0000") && new TextEncoder().encode(value).byteLength <= maximumBytes;
}

function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function hashValue(value: unknown): value is string {
	return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function revision(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function safeIdentifier(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function safePath(value: unknown): value is string {
	if (!trimmed(value, 4_096) || value.includes("\\") || value.startsWith("/") || value.startsWith("~")) return false;
	const parts = value.split("/");
	return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function absolutePath(value: unknown): value is string {
	if (!trimmed(value, 4_096) || value.includes("\\") || !value.startsWith("/")) return false;
	const parts = value.split("/");
	return parts.every((part, index) => index === 0 || (part.length > 0 && part !== "." && part !== ".."));
}

function containedPath(root: string, value: string): boolean {
	if (!absolutePath(value) || !absolutePath(root)) return false;
	const rootWithSlash = root.endsWith("/") ? root : `${root}/`;
	return value.startsWith(rootWithSlash) && value !== rootWithSlash && !value.startsWith(`${rootWithSlash}finalized/`);
}

function boundedArray(value: unknown): value is unknown[] {
	return Array.isArray(value) && value.length <= MAX_COLLECTION_ENTRIES;
}

function model(value: unknown, path: string): { value?: ModelChoice; diagnostics: ReportDiagnostic[] } {
	if (!isRecord(value) || !exactKeys(value, ["model", "thinkingLevel"]) || typeof value.model !== "string" || !parseCanonicalModelReference(value.model) || !isThinkingLevel(value.thinkingLevel)) return { diagnostics: [{ code: "invalid-model", message: "actualModel must be an exact ModelChoice.", path }] };
	return { value: { model: value.model, thinkingLevel: value.thinkingLevel }, diagnostics: [] };
}

function parseJsonWithoutDuplicateKeys(content: string): unknown {
	let index = 0;
	const whitespace = () => { while (index < content.length && /[ \t\n\r]/.test(content[index] ?? "")) index += 1; };
	const stringEnd = (): number => {
		if (content[index] !== '"') throw new Error("JSON string expected.");
		let cursor = index + 1;
		while (cursor < content.length) {
			const character = content[cursor];
			if (character === "\\") { cursor += 2; continue; }
			if (character === '"') return cursor + 1;
			if (character && character < " ") throw new Error("JSON string contains a control character.");
			cursor += 1;
		}
		throw new Error("Unterminated JSON string.");
	};
	const value = (): void => {
		whitespace();
		const character = content[index];
		if (character === "{") {
			index += 1;
			const keys = new Set<string>();
			whitespace();
			if (content[index] === "}") { index += 1; return; }
			while (true) {
				whitespace();
				const end = stringEnd();
				const key = JSON.parse(content.slice(index, end)) as unknown;
				if (typeof key !== "string" || keys.has(key)) throw new Error("JSON object contains a duplicate key.");
				keys.add(key);
				index = end;
				whitespace();
				if (content[index] !== ":") throw new Error("JSON object requires a colon.");
				index += 1;
				value();
				whitespace();
				if (content[index] === "}") { index += 1; return; }
				if (content[index] !== ",") throw new Error("JSON object requires a comma.");
				index += 1;
			}
		}
		if (character === "[") {
			index += 1;
			whitespace();
			if (content[index] === "]") { index += 1; return; }
			while (true) {
				value();
				whitespace();
				if (content[index] === "]") { index += 1; return; }
				if (content[index] !== ",") throw new Error("JSON array requires a comma.");
				index += 1;
			}
		}
		if (character === '"') { index = stringEnd(); return; }
		const start = index;
		while (index < content.length && !/[ \t\n\r,\]}]/.test(content[index] ?? "")) index += 1;
		if (start === index) throw new Error("JSON value expected.");
		JSON.parse(content.slice(start, index));
	};
	value();
	whitespace();
	if (index !== content.length) throw new Error("Trailing JSON content.");
	return JSON.parse(content) as unknown;
}

function parseArtifact(value: unknown, path: string): { value?: ReportedArtifact; diagnostics: ReportDiagnostic[] } {
	if (!isRecord(value) || typeof value.kind !== "string") return { diagnostics: [{ code: "invalid-artifact", message: "Artifact must be a recognized object.", path }] };
	if (value.kind === "git-commit") {
		if (!exactKeys(value, ["kind", "baseRevision", "headRevision", "commits"]) || !revision(value.baseRevision) || !revision(value.headRevision) || !Array.isArray(value.commits) || value.commits.length === 0 || value.commits.length > MAX_COLLECTION_ENTRIES || value.commits.some((item) => !revision(item)) || new Set(value.commits).size !== value.commits.length) return { diagnostics: [{ code: "invalid-artifact", message: "git-commit Artifacts require a full ordered unique commit range.", path }] };
		return { value: { kind: "git-commit", baseRevision: value.baseRevision, headRevision: value.headRevision, commits: [...value.commits] as string[] }, diagnostics: [] };
	}
	if (value.kind === "file") {
		if (!exactKeys(value, ["kind", "path", "evidencePath", "size", "sha256"]) || !safePath(value.path) || !absolutePath(value.evidencePath) || typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0 || !hashValue(value.sha256)) return { diagnostics: [{ code: "invalid-artifact", message: "file Artifacts require a safe path, snapshot path, size, and SHA-256.", path }] };
		return { value: { kind: "file", path: value.path, evidencePath: value.evidencePath, size: value.size, sha256: value.sha256 }, diagnostics: [] };
	}
	if (value.kind === "evidence") {
		if (!exactKeys(value, ["kind", "description", "path", "size", "sha256"]) || !trimmed(value.description, 4_096) || !absolutePath(value.path) || typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0 || !hashValue(value.sha256)) return { diagnostics: [{ code: "invalid-artifact", message: "Evidence Artifacts require a description, contained path, size, and SHA-256.", path }] };
		return { value: { kind: "evidence", description: value.description, path: value.path, size: value.size, sha256: value.sha256 }, diagnostics: [] };
	}
	return { diagnostics: [{ code: "invalid-artifact", message: "Unknown Artifact kind.", path }] };
}

function parseCheck(value: unknown, path: string): { value?: ReportedCheck; diagnostics: ReportDiagnostic[] } {
	if (!isRecord(value) || typeof value.kind !== "string") return { diagnostics: [{ code: "invalid-check", message: "Check must be a command or criteria object.", path }] };
	if (value.kind === "command") {
		if (!exactKeys(value, ["kind", "command", "exitCode", "summary", "logId"]) || !trimmed(value.command, MAX_TEXT_BYTES) || typeof value.exitCode !== "number" || !Number.isSafeInteger(value.exitCode) || !trimmed(value.summary, MAX_TEXT_BYTES) || !safeIdentifier(value.logId)) return { diagnostics: [{ code: "invalid-check", message: "Command checks have invalid bounded fields.", path }] };
		return { value: { kind: "command", command: value.command, exitCode: value.exitCode, summary: value.summary, logId: value.logId }, diagnostics: [] };
	}
	if (value.kind === "criteria") {
		if (!exactKeys(value, ["kind", "criteria", "result", "summary", "logId"]) || !trimmed(value.criteria, MAX_TEXT_BYTES) || (value.result !== "met" && value.result !== "not-met") || !trimmed(value.summary, MAX_TEXT_BYTES) || !safeIdentifier(value.logId)) return { diagnostics: [{ code: "invalid-check", message: "Criteria checks have invalid bounded fields.", path }] };
		return { value: { kind: "criteria", criteria: value.criteria, result: value.result, summary: value.summary, logId: value.logId }, diagnostics: [] };
	}
	return { diagnostics: [{ code: "invalid-check", message: "Unknown check kind.", path }] };
}

function parseLog(value: unknown, path: string): { value?: ReportedLogReference; diagnostics: ReportDiagnostic[] } {
	if (!isRecord(value) || !exactKeys(value, ["id", "path", "size", "sha256"]) || !safeIdentifier(value.id) || !absolutePath(value.path) || typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0 || !hashValue(value.sha256)) return { diagnostics: [{ code: "invalid-log", message: "Log references have invalid bounded fields.", path }] };
	return { value: { id: value.id, path: value.path, size: value.size, sha256: value.sha256 }, diagnostics: [] };
}

function parseIdentity(value: unknown, path: string): { value?: BuilderAttemptReport["identity"]; diagnostics: ReportDiagnostic[] } {
	if (!isRecord(value) || !exactKeys(value, ["runId", "taskId", "attemptId", "role", "specificationHash", "assignmentSha256"]) || !safeIdentifier(value.runId) || !safeIdentifier(value.taskId) || !safeIdentifier(value.attemptId) || value.role !== "builder" || !hashValue(value.specificationHash) || !hashValue(value.assignmentSha256)) return { diagnostics: [{ code: "invalid-identity", message: "Report identity has invalid keys or values.", path }] };
	return { value: { runId: value.runId, taskId: value.taskId, attemptId: value.attemptId, role: "builder", specificationHash: value.specificationHash, assignmentSha256: value.assignmentSha256 }, diagnostics: [] };
}

function parseFrontmatter(content: string): { value?: BuilderAttemptReport; diagnostics: ReportDiagnostic[] } {
	if (utf8Bytes(content) > MAX_BUILDER_REPORT_BYTES || content.startsWith("\uFEFF") || content.includes("\u0000") || content.includes("\r") || !content.startsWith("---\n") || !content.endsWith("\n")) return { diagnostics: [{ code: "invalid-report", message: "Attempt Report must be bounded UTF-8 Markdown with LF endings and no BOM or NUL.", path: "report" }] };
	const closing = content.indexOf("\n---\n", 4);
	if (closing < 0) return { diagnostics: [{ code: "invalid-report", message: "Attempt Report requires one canonical JSON frontmatter block.", path: "report" }] };
	const json = content.slice(4, closing);
	let parsed: unknown;
	try { parsed = parseJsonWithoutDuplicateKeys(json); } catch (error: unknown) { return { diagnostics: [{ code: "invalid-report", message: error instanceof Error ? error.message : "Attempt Report JSON is malformed.", path: "report" }] }; }
	if (!isRecord(parsed) || !exactKeys(parsed, ["schemaVersion", "identity", "status", "summary", "blockers", "producedArtifacts", "actualModel", "checks", "logReferences", "producedRevision"]) || parsed.schemaVersion !== BUILDER_REPORT_SCHEMA_VERSION || (parsed.status !== "completed" && parsed.status !== "blocked" && parsed.status !== "failed") || !trimmed(parsed.summary, MAX_TEXT_BYTES) || !Array.isArray(parsed.blockers) || parsed.blockers.length > 32 || parsed.blockers.some((item) => !trimmed(item, MAX_BLOCKER_BYTES)) || new Set(parsed.blockers).size !== parsed.blockers.length || !boundedArray(parsed.producedArtifacts) || !boundedArray(parsed.checks) || !boundedArray(parsed.logReferences) || (parsed.producedRevision !== null && !revision(parsed.producedRevision))) return { diagnostics: [{ code: "invalid-report", message: "Attempt Report contains invalid top-level fields or bounds.", path: "report" }] };
	if (Object.keys(parsed).join("\u0000") !== ["schemaVersion", "identity", "status", "summary", "blockers", "producedArtifacts", "actualModel", "checks", "logReferences", "producedRevision"].join("\u0000") || JSON.stringify(parsed, null, 2) !== json) return { diagnostics: [{ code: "non-canonical-report", message: "Attempt Report JSON must use the exact two-space canonical serialization.", path: "report" }] };
	const identity = parseIdentity(parsed.identity, "report.identity");
	const actualModel = model(parsed.actualModel, "report.actualModel");
	const artifacts: ReportedArtifact[] = [];
	const checks: ReportedCheck[] = [];
	const logs: ReportedLogReference[] = [];
	const diagnostics = [...identity.diagnostics, ...actualModel.diagnostics];
	for (let index = 0; index < parsed.producedArtifacts.length; index += 1) { const result = parseArtifact(parsed.producedArtifacts[index], `report.producedArtifacts[${index}]`); diagnostics.push(...result.diagnostics); if (result.value) artifacts.push(result.value); }
	for (let index = 0; index < parsed.checks.length; index += 1) { const result = parseCheck(parsed.checks[index], `report.checks[${index}]`); diagnostics.push(...result.diagnostics); if (result.value) checks.push(result.value); }
	for (let index = 0; index < parsed.logReferences.length; index += 1) { const result = parseLog(parsed.logReferences[index], `report.logReferences[${index}]`); diagnostics.push(...result.diagnostics); if (result.value) logs.push(result.value); }
	if (diagnostics.length > 0 || !identity.value || !actualModel.value) return { diagnostics };
	if (parsed.status === "completed" && parsed.blockers.length !== 0) diagnostics.push({ code: "invalid-status", message: "Completed reports cannot contain blockers.", path: "report.blockers" });
	if (parsed.status === "blocked" && parsed.blockers.length === 0) diagnostics.push({ code: "invalid-status", message: "Blocked reports require at least one blocker.", path: "report.blockers" });
	const identities = artifacts.map((artifact) => artifact.kind === "git-commit" ? "git-commit" : artifact.kind === "file" ? `file:${artifact.path}` : `evidence:${artifact.description}`);
	if (new Set(identities).size !== identities.length) diagnostics.push({ code: "ambiguous-artifact", message: "Artifact identities must be unique.", path: "report.producedArtifacts" });
	if (new Set(checks.map((check) => check.kind === "command" ? `command:${check.command}` : `criteria:${check.criteria}`)).size !== checks.length) diagnostics.push({ code: "ambiguous-check", message: "Check identities must be unique.", path: "report.checks" });
	if (new Set(logs.map((log) => log.id)).size !== logs.length || new Set(logs.map((log) => log.path)).size !== logs.length) diagnostics.push({ code: "ambiguous-log", message: "Log identities and paths must be unique.", path: "report.logReferences" });
	const targetPaths = [...artifacts.flatMap((artifact) => artifact.kind === "file" ? [artifact.evidencePath] : artifact.kind === "evidence" ? [artifact.path] : []), ...logs.map((log) => log.path)];
	if (new Set(targetPaths).size !== targetPaths.length) diagnostics.push({ code: "ambiguous-path", message: "Artifact and log file targets must be unique.", path: "report" });
	const logIds = new Set(logs.map((log) => log.id));
	for (const check of checks) if (!logIds.has(check.logId)) diagnostics.push({ code: "missing-log-reference", message: `Check refers to missing log ${check.logId}.`, path: "report.checks" });
	for (const log of logs) if (!checks.some((check) => check.logId === log.id)) diagnostics.push({ code: "unused-log-reference", message: `Log ${log.id} is not used by a check.`, path: "report.logReferences" });
	return diagnostics.length > 0 ? { diagnostics } : { value: { schemaVersion: 1, identity: identity.value, status: parsed.status, summary: parsed.summary, blockers: [...parsed.blockers] as string[], producedArtifacts: artifacts, actualModel: actualModel.value, checks, logReferences: logs, producedRevision: parsed.producedRevision }, diagnostics: [] };
}

export function parseBuilderAttemptReport(content: string): { value?: BuilderAttemptReport; diagnostics: ReportDiagnostic[] } {
	return parseFrontmatter(content);
}

export function serializeBuilderAttemptReport(report: BuilderAttemptReport, body = ""): string {
	const frontmatter = {
		schemaVersion: 1,
		identity: report.identity,
		status: report.status,
		summary: report.summary,
		blockers: report.blockers,
		producedArtifacts: report.producedArtifacts,
		actualModel: report.actualModel,
		checks: report.checks,
		logReferences: report.logReferences,
		producedRevision: report.producedRevision,
	};
	const normalizedBody = body.length === 0 ? "" : body.endsWith("\n") ? body : `${body}\n`;
	return `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n${normalizedBody}`;
}

function equalJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function validateExpectedArtifact(reportArtifact: ReportedArtifact, expected: ExpectedArtifact, evidenceDirectory: string, path: string): ReportDiagnostic[] {
	if (expected.kind === "git-commit") return reportArtifact.kind === "git-commit" ? [] : [{ code: "artifact-mismatch", message: "Expected a git-commit Artifact.", path }];
	if (expected.kind === "file") return reportArtifact.kind === "file" && reportArtifact.path === expected.path ? containedPath(evidenceDirectory, reportArtifact.evidencePath) ? [] : [{ code: "unsafe-path", message: "File Artifact evidencePath is outside the Attempt evidence directory.", path }] : [{ code: "artifact-mismatch", message: "File Artifact identity does not match the Assignment.", path }];
	return reportArtifact.kind === "evidence" && reportArtifact.description === expected.description && containedPath(evidenceDirectory, reportArtifact.path) ? [] : [{ code: reportArtifact.kind === "evidence" && reportArtifact.description === expected.description ? "unsafe-path" : "artifact-mismatch", message: "Evidence Artifact identity or path does not match the Assignment.", path }];
}

function allowedScopePath(path: string, allowedScope: readonly string[]): boolean {
	if (!safePath(path)) return false;
	return allowedScope.some((scope) => safePath(scope) && (path === scope || path.startsWith(`${scope}/`)));
}

export function isAllowedBuilderScopePath(path: string, allowedScope: readonly string[]): boolean {
	return allowedScopePath(path, allowedScope);
}

export function validateBuilderReportAgainstAssignment(input: {
	report: BuilderAttemptReport;
	assignment: BuilderAssignmentDocument;
	assignmentSha256: string;
	runId: string;
	task: TaskContract;
	attempt: AttemptRecord;
	baseRevision: string;
}): { value?: NormalizedBuilderEvidence; diagnostics: ReportDiagnostic[] } {
	const { report, assignment, task, attempt } = input;
	const diagnostics: ReportDiagnostic[] = [];
	const expectedHash = specificationHash(task);
	if (assignment.assignment.runId !== input.runId || assignment.assignment.taskId !== task.id || assignment.assignment.attemptId !== attempt.id || report.identity.runId !== input.runId || report.identity.taskId !== task.id || report.identity.attemptId !== attempt.id || report.identity.role !== "builder" || assignment.assignment.role !== "builder") diagnostics.push({ code: "identity-mismatch", message: "Assignment and Attempt Report identities do not match the active Run.", path: "identity" });
	if (assignment.assignment.specificationHash !== expectedHash || attempt.specificationHash !== expectedHash || report.identity.specificationHash !== expectedHash) diagnostics.push({ code: "specification-mismatch", message: "Assignment, Task, Attempt, and report specification hashes disagree.", path: "identity.specificationHash" });
	if (report.identity.assignmentSha256 !== input.assignmentSha256) diagnostics.push({ code: "assignment-hash-mismatch", message: "Attempt Report does not name the immutable Assignment byte hash.", path: "identity.assignmentSha256" });
	if (!equalJson(assignment.assignment.expectedArtifacts, task.expectedArtifacts) || assignment.assignment.requiredOutcome !== task.requiredOutcome || !equalJson(assignment.assignment.allowedScope, task.allowedScope) || !equalJson(assignment.assignment.verification, task.verification)) diagnostics.push({ code: "assignment-changed", message: "Assignment facts do not equal the approved Task contract.", path: "assignment" });
	if (assignment.assignment.baseRevision !== input.baseRevision || attempt.baseRevision !== input.baseRevision || assignment.assignment.actualModel.model !== attempt.actualModel.model || assignment.assignment.actualModel.thinkingLevel !== attempt.actualModel.thinkingLevel || report.actualModel.model !== attempt.actualModel.model || report.actualModel.thinkingLevel !== attempt.actualModel.thinkingLevel) diagnostics.push({ code: "model-or-base-mismatch", message: "Assignment, Attempt, report model, or approved base differs.", path: "actualModel" });
	if (attempt.dispatch.phase === "worktree-intended" || assignment.assignment.worktree.path !== attempt.dispatch.worktreePath || assignment.assignment.worktree.branch !== attempt.dispatch.branch || assignment.assignment.reportPath !== attempt.reportPath || assignment.assignment.evidenceDirectory !== attempt.evidenceDirectory) diagnostics.push({ code: "path-mismatch", message: "Assignment paths or Builder worktree identity do not match the active Attempt.", path: "assignment" });
	const artifactIdentities = report.producedArtifacts.map((artifact) => artifact.kind === "git-commit" ? "git-commit" : artifact.kind === "file" ? `file:${artifact.path}` : `evidence:${artifact.description}`);
	const expectedIdentities = task.expectedArtifacts.map((artifact) => artifact.kind === "git-commit" ? "git-commit" : artifact.kind === "file" ? `file:${artifact.path}` : `evidence:${artifact.description}`);
	if (report.status === "completed" && (report.producedArtifacts.length !== task.expectedArtifacts.length || !artifactIdentities.every((identity, index) => identity === expectedIdentities[index]))) diagnostics.push({ code: "artifact-mismatch", message: "Completed reports must contain every expected Artifact in Assignment order.", path: "producedArtifacts" });
	if (report.status !== "completed") {
		let cursor = 0;
		for (const identity of artifactIdentities) { const next = expectedIdentities.indexOf(identity, cursor); if (next < cursor) diagnostics.push({ code: "artifact-mismatch", message: "Blocked or failed Artifact lists must be ordered Assignment subsets.", path: "producedArtifacts" }); else cursor = next + 1; }
	}
	for (let index = 0; index < report.producedArtifacts.length; index += 1) {
		const expected = task.expectedArtifacts[expectedIdentities.indexOf(artifactIdentities[index] ?? "")];
		if (expected) diagnostics.push(...validateExpectedArtifact(report.producedArtifacts[index]!, expected, assignment.assignment.evidenceDirectory, `producedArtifacts[${index}]`));
	}
	const gitArtifact = report.producedArtifacts.find((artifact): artifact is ReportedArtifactGitCommit => artifact.kind === "git-commit");
	if (gitArtifact && report.producedRevision !== gitArtifact.headRevision) diagnostics.push({ code: "revision-mismatch", message: "producedRevision must equal the reported git Artifact head.", path: "producedRevision" });
	if (!gitArtifact && report.producedRevision !== null) diagnostics.push({ code: "revision-mismatch", message: "producedRevision must be null without a git-commit Artifact.", path: "producedRevision" });
	const verification = task.verification;
	if (verification.kind === "command") {
		const matching = report.checks.filter((check): check is Extract<ReportedCheck, { kind: "command" }> => check.kind === "command" && check.command === verification.command);
		if (matching.length !== 1) diagnostics.push({ code: "check-mismatch", message: "Report must contain exactly one check for the approved command.", path: "checks" });
		if (report.status === "completed" && matching[0]?.exitCode !== 0) diagnostics.push({ code: "check-not-passed", message: "Completed reports require an approved command check with exit code 0.", path: "checks" });
	} else {
		const matching = report.checks.filter((check): check is Extract<ReportedCheck, { kind: "criteria" }> => check.kind === "criteria" && check.criteria === verification.criteria);
		if (matching.length !== 1) diagnostics.push({ code: "check-mismatch", message: "Report must contain exactly one check for the approved criteria.", path: "checks" });
		if (report.status === "completed" && matching[0]?.result !== "met") diagnostics.push({ code: "check-not-passed", message: "Completed reports require approved criteria with result met.", path: "checks" });
	}
	for (const artifact of report.producedArtifacts) {
		if (artifact.kind === "file" && !allowedScopePath(artifact.path, task.allowedScope)) diagnostics.push({ code: "scope-violation", message: `Artifact path ${artifact.path} is outside allowedScope.`, path: "producedArtifacts" });
	}
	for (const log of report.logReferences) if (!containedPath(assignment.assignment.evidenceDirectory, log.path)) diagnostics.push({ code: "unsafe-path", message: `Log path ${log.path} is outside the Attempt evidence directory.`, path: "logReferences" });
	return diagnostics.length > 0 ? { diagnostics } : { value: { report, assignment, assignmentSha256: input.assignmentSha256, gitArtifact }, diagnostics: [] };
}

export function validateReportedGitFacts(reportArtifact: ReportedArtifactGitCommit, facts: ProducedGitFacts): ReportDiagnostic[] {
	if (facts.kind !== "inspected" || !facts.clean || reportArtifact.baseRevision !== facts.base || reportArtifact.headRevision !== facts.head || reportArtifact.commits.length !== facts.commits.length || reportArtifact.commits.some((commit, index) => commit !== facts.commits[index])) return [{ code: "commit-range-mismatch", message: "Reported Git base, head, or exact ordered commit range differs from read-only Git inspection.", path: "producedArtifacts" }];
	return [];
}

export function changedPathsInAllowedScope(facts: ProducedGitFacts, allowedScope: readonly string[]): boolean {
	return facts.changedPaths.every((change) => change.paths.every((path) => allowedScopePath(path, allowedScope)));
}
