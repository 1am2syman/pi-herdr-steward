import { createHash } from "node:crypto";

import { isThinkingLevel, parseCanonicalModelReference, type ConfigDiagnostic, type ModelChoice } from "./config.ts";
import type {
	AttemptRecord,
	AttemptContinuation,
	FinalizedEvidenceManifest,
	ReviewWorktreeSnapshot,
	ReviewerAttemptRecord,
	TaskContract,
} from "./run.ts";
import { formatTaskFactInstruction } from "./reconciliation.ts";
import type { ReportedCheck, ReportedLogReference } from "./attempt-report.ts";

export const REVIEW_REPORT_SCHEMA_VERSION = 1 as const;
export const MAX_REVIEW_REPORT_BYTES = 64 * 1024;

export type ReviewSubjectArtifact = {
	kind: "file" | "evidence";
	identity: string;
	size: number;
	sha256: string;
	finalizedPath: string;
};

export type ReviewSubject =
	| {
			kind: "git";
			baseRevision: string;
			headRevision: string;
			commits: string[];
			builderManifestSha256: string;
	  }
	| {
			kind: "non-git";
			artifacts: ReviewSubjectArtifact[];
			builderManifestSha256: string;
	  };

export type ReviewerIndependence =
	| { kind: "different-provider-family"; builderProvider: string; reviewerProvider: string }
	| { kind: "same-provider-family-approved"; provider: string; approvedAt: string; controllerSessionId: string };

export interface ReviewerChoiceInspection {
	choice: ModelChoice;
	available: boolean;
	diagnostics: ConfigDiagnostic[];
}

export type ReviewerModelSelection =
	| { kind: "independent"; choice: ModelChoice; builderProvider: string; reviewerProvider: string }
	| { kind: "same-family-approval-required"; choice: ModelChoice; provider: string }
	| { kind: "unavailable"; diagnostics: ConfigDiagnostic[] };

export function selectReviewerModel(actualBuilderModel: ModelChoice, inspections: readonly ReviewerChoiceInspection[]): ReviewerModelSelection {
	const builderReference = parseCanonicalModelReference(actualBuilderModel.model);
	const builderProvider = builderReference?.provider;
	const availableSameFamily: ReviewerChoiceInspection[] = [];
	const diagnostics: ConfigDiagnostic[] = [];
	for (const inspection of inspections) {
		if (!inspection.available) {
			diagnostics.push(...inspection.diagnostics);
			continue;
		}
		const reviewerReference = parseCanonicalModelReference(inspection.choice.model);
		if (!builderProvider || !reviewerReference) {
			diagnostics.push({ code: "invalid-model", role: "reviewer", index: inspections.indexOf(inspection), reference: inspection.choice.model, message: "Reviewer and Builder models must be canonical provider/model-id references." });
			continue;
		}
		if (reviewerReference.provider !== builderProvider) return { kind: "independent", choice: { ...inspection.choice }, builderProvider, reviewerProvider: reviewerReference.provider };
		availableSameFamily.push(inspection);
	}
	const same = availableSameFamily[0];
	if (same) {
		const provider = parseCanonicalModelReference(same.choice.model)?.provider;
		if (provider) return { kind: "same-family-approval-required", choice: { ...same.choice }, provider };
	}
	return { kind: "unavailable", diagnostics };
}

function hash(bytes: string | Buffer): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, maximum: number): value is string {
	return typeof value === "string" && value.length > 0 && value === value.trim() && !value.includes("\u0000") && Buffer.byteLength(value, "utf8") <= maximum;
}

function safeIdentifier(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function safePath(value: unknown): value is string {
	if (!text(value, 4_096) || value.includes("\\") || value.startsWith("/")) return false;
	return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function absolutePath(value: unknown): value is string {
	return typeof value === "string" && value.startsWith("/") && value === value.trim() && !value.includes("\u0000") && !value.includes("\\") && value.split("/").every((part, index) => index === 0 || (part.length > 0 && part !== "." && part !== ".."));
}

function sha(value: unknown): value is string {
	return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function revision(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function timestamp(value: unknown): value is string {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value;
}

function cloneSubject(subject: ReviewSubject): ReviewSubject {
	return subject.kind === "git"
		? { kind: "git", baseRevision: subject.baseRevision, headRevision: subject.headRevision, commits: [...subject.commits], builderManifestSha256: subject.builderManifestSha256 }
		: { kind: "non-git", artifacts: subject.artifacts.map((artifact) => ({ ...artifact })), builderManifestSha256: subject.builderManifestSha256 };
}

export function reviewSubjectsEqual(left: ReviewSubject, right: ReviewSubject): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function worktreeSnapshotsEqual(left: ReviewWorktreeSnapshot, right: ReviewWorktreeSnapshot): boolean {
	return left.head === right.head && left.dirtyStateFingerprint === right.dirtyStateFingerprint && JSON.stringify(left.dirtyPaths) === JSON.stringify(right.dirtyPaths) && JSON.stringify(left.operationMarkers) === JSON.stringify(right.operationMarkers);
}

export function reviewSubjectFromFinalizedBuilderEvidence(input: {
	manifest: FinalizedEvidenceManifest;
	manifestSha256: string;
	manifestBytes?: string | Buffer;
	runId: string;
	taskId: string;
	builderAttemptId: string;
	builderBaseRevision: string;
	builderProducedRevision?: string | null;
}): { value?: ReviewSubject; message?: string } {
	const { manifest } = input;
	if (input.manifestSha256 !== hash(input.manifestBytes ?? (JSON.stringify(manifest, null, 2) + "\n"))) return { message: "Finalized Builder manifest hash does not match its bytes." };
	if (manifest.schemaVersion !== 1 || manifest.identity.runId !== input.runId || manifest.identity.taskId !== input.taskId || manifest.identity.attemptId !== input.builderAttemptId || manifest.identity.role !== "builder" || manifest.status !== "completed") return { message: "Finalized Builder manifest identity or completed status does not match the active Task." };
	if (!sha(input.manifestSha256)) return { message: "Finalized Builder manifest hash is invalid." };
	if (manifest.code) {
		if (!revision(input.builderBaseRevision) || (input.builderProducedRevision !== undefined && input.builderProducedRevision !== manifest.producedRevision) || manifest.code.approvedBase !== input.builderBaseRevision || manifest.code.producedHead !== manifest.producedRevision || !revision(manifest.code.producedHead) || manifest.code.commits.length === 0 || manifest.code.commits.some((commit) => !revision(commit))) return { message: "Finalized Builder Git facts do not match the durable Builder Attempt." };
		return { value: { kind: "git", baseRevision: manifest.code.approvedBase, headRevision: manifest.code.producedHead, commits: [...manifest.code.commits], builderManifestSha256: input.manifestSha256 } };
	}
	const artifacts: ReviewSubjectArtifact[] = [];
	for (const artifact of manifest.artifacts) {
		if (artifact.kind !== "file" && artifact.kind !== "evidence") continue;
		if (!artifact.finalizedPath || artifact.size === null || !artifact.sha256 || !sha(artifact.sha256) || !absolutePath(artifact.finalizedPath)) return { message: "Finalized non-Git Artifact lacks a protected path, size, or SHA-256." };
		artifacts.push({ kind: artifact.kind, identity: artifact.identity, size: artifact.size, sha256: artifact.sha256, finalizedPath: artifact.finalizedPath });
	}
	if (artifacts.length === 0) return { message: "Finalized non-Git Builder evidence contains no reviewable Artifacts." };
	return { value: { kind: "non-git", artifacts, builderManifestSha256: input.manifestSha256 } };
}

export function deserializeFinalizedBuilderEvidenceManifest(content: string, expectedSha256: string): { value?: FinalizedEvidenceManifest; message?: string } {
	if (hash(content) !== expectedSha256 || !content.endsWith("\n")) return { message: "Finalized Builder manifest bytes do not match the durable hash." };
	let value: unknown;
	try { value = JSON.parse(content) as unknown; } catch { return { message: "Finalized Builder manifest is malformed JSON." }; }
	if (!isRecord(value)) return { message: "Finalized Builder manifest must be an object." };
	const baseKeys = ["schemaVersion", "identity", "status", "summary", "blockers", "actualModel", "specificationHash", "assignmentSha256", "report", "checks", "logs", "artifacts", "producedRevision"];
	const keys = Object.prototype.hasOwnProperty.call(value, "code") ? [...baseKeys, "code"] : baseKeys;
	if (!exactKeys(value, keys)) return { message: `Finalized Builder manifest has invalid exact fields: key order (${Object.keys(value).join(",")} != ${keys.join(",")}).` };
	if (`${JSON.stringify(value, null, 2)}\n` !== content) return { message: "Finalized Builder manifest has invalid exact fields: non-canonical JSON." };
	if (value.schemaVersion !== 1 || value.status !== "completed" || !isRecord(value.identity) || value.identity.role !== "builder" || !Array.isArray(value.artifacts) || !Array.isArray(value.logs) || !Array.isArray(value.checks) || (value.producedRevision !== null && !revision(value.producedRevision))) return { message: "Finalized Builder manifest has invalid exact fields: value." };
	return { value: value as unknown as FinalizedEvidenceManifest };
}

export interface ReviewerAssignmentDocument {
	schemaVersion: 1;
	assignment: {
		runId: string;
		taskId: string;
		attemptId: string;
		role: "reviewer";
		requiredOutcome: string;
		reportPath: string;
		evidenceDirectory: string;
		actualModel: ModelChoice;
		specificationHash: string;
		subject: ReviewSubject;
		builderEvidence: { manifestPath: string; manifestSha256: string };
		independence: ReviewerIndependence;
		worktree: { path: string; baseline: ReviewWorktreeSnapshot };
		herdr: { workspaceId: string; paneId: string; terminalId: string; agentName: string };
		continuation?: AttemptContinuation;
	};
}

export interface ReviewerFinding {
	id: string;
	severity: "blocker" | "major" | "minor" | "info";
	summary: string;
	detail: string;
	path?: string;
}

export interface ReviewerAttemptReport {
	schemaVersion: 1;
	identity: { runId: string; taskId: string; attemptId: string; role: "reviewer"; specificationHash: string; assignmentSha256: string };
	status: "completed";
	summary: string;
	blockers: [];
	actualModel: ModelChoice;
	reviewedSubject: ReviewSubject;
	verdict: "approved" | "changes-required";
	findings: ReviewerFinding[];
	checks: ReportedCheck[];
	logReferences: ReportedLogReference[];
}

export interface ReviewDiagnostic {
	code: string;
	message: string;
	path?: string;
}

function duplicateSafeJson(content: string): unknown {
	let index = 0;
	const whitespace = () => { while (index < content.length && /[ \t\n\r]/.test(content[index] ?? "")) index += 1; };
	const stringEnd = (): number => {
		if (content[index] !== '"') throw new Error("JSON string expected.");
		let cursor = index + 1;
		while (cursor < content.length) {
			const current = content[cursor];
			if (current === "\\") { cursor += 2; continue; }
			if (current === '"') return cursor + 1;
			if (current && current < " ") throw new Error("JSON string contains a control character.");
			cursor += 1;
		}
		throw new Error("Unterminated JSON string.");
	};
	const parse = (): void => {
		whitespace();
		const current = content[index];
		if (current === "{") {
			index += 1;
			const keys = new Set<string>();
			whitespace();
			if (content[index] === "}") { index += 1; return; }
			while (true) {
				whitespace();
				const end = stringEnd();
				const key = JSON.parse(content.slice(index, end)) as unknown;
				if (typeof key !== "string" || keys.has(key)) throw new Error("JSON object contains a duplicate key.");
				keys.add(key); index = end; whitespace();
				if (content[index] !== ":") throw new Error("JSON object requires a colon.");
				index += 1; parse(); whitespace();
				if (content[index] === "}") { index += 1; return; }
				if (content[index] !== ",") throw new Error("JSON object requires a comma.");
				index += 1;
			}
		}
		if (current === "[") {
			index += 1; whitespace();
			if (content[index] === "]") { index += 1; return; }
			while (true) { parse(); whitespace(); if (content[index] === "]") { index += 1; return; } if (content[index] !== ",") throw new Error("JSON array requires a comma."); index += 1; }
		}
		if (current === '"') { index = stringEnd(); return; }
		const start = index;
		while (index < content.length && !/[ \t\n\r,\]}]/.test(content[index] ?? "")) index += 1;
		if (start === index) throw new Error("JSON value expected.");
		JSON.parse(content.slice(start, index));
	};
	parse(); whitespace(); if (index !== content.length) throw new Error("Trailing JSON content.");
	return JSON.parse(content) as unknown;
}

function subject(value: unknown, path: string): { value?: ReviewSubject; diagnostics: ReviewDiagnostic[] } {
	if (!isRecord(value) || typeof value.kind !== "string") return { diagnostics: [{ code: "invalid-subject", message: "Review subject must be a Git or non-Git subject.", path }] };
	if (value.kind === "git") {
		if (!exactKeys(value, ["kind", "baseRevision", "headRevision", "commits", "builderManifestSha256"]) || !revision(value.baseRevision) || !revision(value.headRevision) || !Array.isArray(value.commits) || value.commits.length === 0 || value.commits.some((commit) => !revision(commit)) || new Set(value.commits).size !== value.commits.length || !sha(value.builderManifestSha256)) return { diagnostics: [{ code: "invalid-subject", message: "Git Review subject has invalid exact revisions, range, or manifest hash.", path }] };
		return { value: { kind: "git", baseRevision: value.baseRevision, headRevision: value.headRevision, commits: [...value.commits] as string[], builderManifestSha256: value.builderManifestSha256 }, diagnostics: [] };
	}
	if (value.kind !== "non-git" || !exactKeys(value, ["kind", "artifacts", "builderManifestSha256"]) || !Array.isArray(value.artifacts) || value.artifacts.length === 0 || value.artifacts.length > 100 || !sha(value.builderManifestSha256)) return { diagnostics: [{ code: "invalid-subject", message: "Non-Git Review subject has invalid exact fields.", path }] };
	const artifacts: ReviewSubjectArtifact[] = [];
	for (let index = 0; index < value.artifacts.length; index += 1) {
		const item = value.artifacts[index];
		if (!isRecord(item) || !exactKeys(item, ["kind", "identity", "size", "sha256", "finalizedPath"]) || (item.kind !== "file" && item.kind !== "evidence") || !text(item.identity, 4_096) || typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 0 || !sha(item.sha256) || !absolutePath(item.finalizedPath)) return { diagnostics: [{ code: "invalid-subject", message: "Non-Git Review Artifact has invalid exact fields.", path: `${path}.artifacts[${index}]` }] };
		artifacts.push({ kind: item.kind, identity: item.identity, size: item.size as number, sha256: item.sha256, finalizedPath: item.finalizedPath as string });
	}
	if (new Set(artifacts.map((item) => item.identity)).size !== artifacts.length) return { diagnostics: [{ code: "invalid-subject", message: "Review Artifact identities must be unique.", path }] };
	return { value: { kind: "non-git", artifacts, builderManifestSha256: value.builderManifestSha256 }, diagnostics: [] };
}

function model(value: unknown, path: string): { value?: ModelChoice; diagnostics: ReviewDiagnostic[] } {
	if (!isRecord(value) || !exactKeys(value, ["model", "thinkingLevel"]) || typeof value.model !== "string" || !parseCanonicalModelReference(value.model) || !isThinkingLevel(value.thinkingLevel)) return { diagnostics: [{ code: "invalid-model", message: "Model choice is not canonical.", path }] };
	return { value: { model: value.model, thinkingLevel: value.thinkingLevel }, diagnostics: [] };
}

function parseFinding(value: unknown, path: string): { value?: ReviewerFinding; diagnostics: ReviewDiagnostic[] } {
	if (!isRecord(value)) return { diagnostics: [{ code: "invalid-finding", message: "Finding must be an object.", path }] };
	const hasPath = Object.prototype.hasOwnProperty.call(value, "path");
	const keys = hasPath ? ["id", "severity", "summary", "detail", "path"] : ["id", "severity", "summary", "detail"];
	if (!exactKeys(value, keys) || !safeIdentifier(value.id) || !["blocker", "major", "minor", "info"].includes(value.severity as string) || !text(value.summary, 2_000) || !text(value.detail, 8_000) || (hasPath && !safePath(value.path))) return { diagnostics: [{ code: "invalid-finding", message: "Finding contains invalid bounded fields.", path }] };
	return { value: { id: value.id, severity: value.severity as ReviewerFinding["severity"], summary: value.summary, detail: value.detail, ...(hasPath ? { path: value.path as string } : {}) }, diagnostics: [] };
}

function parseCheck(value: unknown, path: string): { value?: ReportedCheck; diagnostics: ReviewDiagnostic[] } {
	if (!isRecord(value) || typeof value.kind !== "string") return { diagnostics: [{ code: "invalid-check", message: "Check must be a command or criteria object.", path }] };
	if (value.kind === "command" && exactKeys(value, ["kind", "command", "exitCode", "summary", "logId"]) && text(value.command, 2_000) && Number.isSafeInteger(value.exitCode) && text(value.summary, 2_000) && safeIdentifier(value.logId)) return { value: { kind: "command", command: value.command, exitCode: value.exitCode as number, summary: value.summary, logId: value.logId }, diagnostics: [] };
	if (value.kind === "criteria" && exactKeys(value, ["kind", "criteria", "result", "summary", "logId"]) && text(value.criteria, 2_000) && (value.result === "met" || value.result === "not-met") && text(value.summary, 2_000) && safeIdentifier(value.logId)) return { value: { kind: "criteria", criteria: value.criteria, result: value.result, summary: value.summary, logId: value.logId }, diagnostics: [] };
	return { diagnostics: [{ code: "invalid-check", message: "Check contains invalid bounded fields.", path }] };
}

function parseLog(value: unknown, path: string): { value?: ReportedLogReference; diagnostics: ReviewDiagnostic[] } {
	if (!isRecord(value) || !exactKeys(value, ["id", "path", "size", "sha256"]) || !safeIdentifier(value.id) || !absolutePath(value.path) || typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0 || !sha(value.sha256)) return { diagnostics: [{ code: "invalid-log", message: "Log reference contains invalid fields.", path }] };
	return { value: { id: value.id, path: value.path, size: value.size as number, sha256: value.sha256 }, diagnostics: [] };
}

function parseIndependence(value: unknown, path: string): { value?: ReviewerIndependence; diagnostics: ReviewDiagnostic[] } {
	if (!isRecord(value) || typeof value.kind !== "string") return { diagnostics: [{ code: "invalid-independence", message: "Reviewer independence is invalid.", path }] };
	if (value.kind === "different-provider-family" && exactKeys(value, ["kind", "builderProvider", "reviewerProvider"]) && text(value.builderProvider, 256) && text(value.reviewerProvider, 256) && value.builderProvider !== value.reviewerProvider) return { value: { kind: value.kind, builderProvider: value.builderProvider, reviewerProvider: value.reviewerProvider }, diagnostics: [] };
	if (value.kind === "same-provider-family-approved" && exactKeys(value, ["kind", "provider", "approvedAt", "controllerSessionId"]) && text(value.provider, 256) && timestamp(value.approvedAt) && text(value.controllerSessionId, 512)) return { value: { kind: value.kind, provider: value.provider, approvedAt: value.approvedAt, controllerSessionId: value.controllerSessionId }, diagnostics: [] };
	return { diagnostics: [{ code: "invalid-independence", message: "Reviewer independence has invalid exact fields.", path }] };
}

export function serializeReviewerAssignment(document: ReviewerAssignmentDocument): string {
	if (!validateReviewerAssignment(document).value) throw new Error("Cannot serialize an invalid Reviewer Assignment.");
	return `${JSON.stringify(document, null, 2)}\n`;
}

export function validateReviewerAssignment(value: unknown, path = "assignment.json"): { value?: ReviewerAssignmentDocument; diagnostics: ReviewDiagnostic[] } {
	if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "assignment"]) || value.schemaVersion !== 1 || !isRecord(value.assignment)) return { diagnostics: [{ code: "invalid-assignment", message: "Reviewer Assignment must contain exactly schemaVersion and assignment.", path }] };
	const a = value.assignment;
	const hasContinuation = Object.prototype.hasOwnProperty.call(a, "continuation");
	const keys = ["runId", "taskId", "attemptId", "role", "requiredOutcome", "reportPath", "evidenceDirectory", "actualModel", "specificationHash", "subject", "builderEvidence", "independence", "worktree", "herdr", ...(hasContinuation ? ["continuation"] : [])];
	if (!exactKeys(a, keys) || !safeIdentifier(a.runId) || !safeIdentifier(a.taskId) || !safeIdentifier(a.attemptId) || a.role !== "reviewer" || !text(a.requiredOutcome, 8_000) || !absolutePath(a.reportPath) || !absolutePath(a.evidenceDirectory) || !sha(a.specificationHash)) return { diagnostics: [{ code: "invalid-assignment", message: "Reviewer Assignment identity, paths, or specification hash is invalid.", path }] };
	const actualModel = model(a.actualModel, `${path}.assignment.actualModel`);
	const reviewedSubject = subject(a.subject, `${path}.assignment.subject`);
	const independence = parseIndependence(a.independence, `${path}.assignment.independence`);
	const builderEvidence = a.builderEvidence;
	const worktree = a.worktree;
	const herdr = a.herdr;
	const diagnostics = [...actualModel.diagnostics, ...reviewedSubject.diagnostics, ...independence.diagnostics];
	if (!isRecord(builderEvidence) || !exactKeys(builderEvidence, ["manifestPath", "manifestSha256"]) || !absolutePath(builderEvidence.manifestPath) || !sha(builderEvidence.manifestSha256)) diagnostics.push({ code: "invalid-assignment", message: "Builder evidence pointer is invalid.", path: `${path}.assignment.builderEvidence` });
	if (!isRecord(worktree) || !exactKeys(worktree, ["path", "baseline"]) || !absolutePath(worktree.path)) diagnostics.push({ code: "invalid-assignment", message: "Reviewer worktree path is invalid.", path: `${path}.assignment.worktree` });
	if (!isRecord(herdr) || !exactKeys(herdr, ["workspaceId", "paneId", "terminalId", "agentName"]) || !text(herdr.workspaceId, 256) || !text(herdr.paneId, 256) || !text(herdr.terminalId, 256) || !/^[a-z][a-z0-9_-]{0,31}$/.test(String(herdr.agentName))) diagnostics.push({ code: "invalid-assignment", message: "Reviewer Herdr identities are invalid.", path: `${path}.assignment.herdr` });
	const baseline = isRecord(worktree) ? parseSnapshot(worktree.baseline, `${path}.assignment.worktree.baseline`) : { diagnostics: [] };
	diagnostics.push(...baseline.diagnostics);
	const continuation = hasContinuation ? parseContinuation(a.continuation, `${path}.assignment.continuation`) : { value: undefined, diagnostics: [] };
	diagnostics.push(...continuation.diagnostics);
	if (diagnostics.length > 0 || !actualModel.value || !reviewedSubject.value || !independence.value || !isRecord(builderEvidence) || !isRecord(worktree) || !isRecord(herdr) || !baseline.value || (hasContinuation && !continuation.value)) return { diagnostics };
	return { value: { schemaVersion: 1, assignment: { runId: a.runId as string, taskId: a.taskId as string, attemptId: a.attemptId as string, role: "reviewer", requiredOutcome: a.requiredOutcome as string, reportPath: a.reportPath as string, evidenceDirectory: a.evidenceDirectory as string, actualModel: actualModel.value, specificationHash: a.specificationHash as string, subject: reviewedSubject.value, builderEvidence: { manifestPath: builderEvidence.manifestPath as string, manifestSha256: builderEvidence.manifestSha256 as string }, independence: independence.value, worktree: { path: worktree.path as string, baseline: baseline.value }, herdr: { workspaceId: herdr.workspaceId as string, paneId: herdr.paneId as string, terminalId: herdr.terminalId as string, agentName: herdr.agentName as string }, ...(continuation.value ? { continuation: continuation.value } : {}) } }, diagnostics: [] };
}

function parseContinuation(value: unknown, path: string): { value?: AttemptContinuation; diagnostics: ReviewDiagnostic[] } {
	if (!isRecord(value) || !exactKeys(value, ["predecessorAttemptId", "retryOrdinal", "preservedWorktree", "priorAssignmentPath", "priorReportPath", "priorEvidenceDirectory"]) || !safeIdentifier(value.predecessorAttemptId) || (value.retryOrdinal !== 1 && value.retryOrdinal !== 2) || !absolutePath(value.priorAssignmentPath) || !absolutePath(value.priorReportPath) || !absolutePath(value.priorEvidenceDirectory)) return { diagnostics: [{ code: "invalid-assignment", message: "Assignment continuation has invalid exact identity or paths.", path }] };
	const worktree = value.preservedWorktree;
	if (!isRecord(worktree) || !exactKeys(worktree, ["path", "branch", "head"]) || !absolutePath(worktree.path) || !safePath(worktree.branch) || (worktree.head !== null && !revision(worktree.head))) return { diagnostics: [{ code: "invalid-assignment", message: "Assignment continuation preserved worktree is invalid.", path: `${path}.preservedWorktree` }] };
	return { value: { predecessorAttemptId: value.predecessorAttemptId, retryOrdinal: value.retryOrdinal as 1 | 2, preservedWorktree: { path: worktree.path, branch: worktree.branch, head: worktree.head as string | null }, priorAssignmentPath: value.priorAssignmentPath, priorReportPath: value.priorReportPath, priorEvidenceDirectory: value.priorEvidenceDirectory }, diagnostics: [] };
}

function parseSnapshot(value: unknown, path: string): { value?: ReviewWorktreeSnapshot; diagnostics: ReviewDiagnostic[] } {
	if (!isRecord(value) || !exactKeys(value, ["head", "dirtyStateFingerprint", "dirtyPaths", "operationMarkers"]) || !revision(value.head) || !sha(value.dirtyStateFingerprint) || !Array.isArray(value.dirtyPaths) || value.dirtyPaths.length > 100 || value.dirtyPaths.some((item) => !safePath(item)) || !Array.isArray(value.operationMarkers) || value.operationMarkers.length > 10 || value.operationMarkers.some((item) => !safeIdentifier(item))) return { diagnostics: [{ code: "invalid-snapshot", message: "Review worktree snapshot is invalid.", path }] };
	return { value: { head: value.head, dirtyStateFingerprint: value.dirtyStateFingerprint, dirtyPaths: [...value.dirtyPaths] as string[], operationMarkers: [...value.operationMarkers] as string[] }, diagnostics: [] };
}

export function deserializeReviewerAssignment(content: string, path?: string): { value?: ReviewerAssignmentDocument; diagnostics: ReviewDiagnostic[] } {
	try { return validateReviewerAssignment(JSON.parse(content) as unknown, path); } catch { return { diagnostics: [{ code: "invalid-assignment", message: "Reviewer Assignment contains malformed JSON.", path }] }; }
}

export function reviewerAssignmentSha256(content: string): string { return hash(content); }

export function buildReviewerAssignment(input: {
	runId: string;
	task: TaskContract;
	attempt: ReviewerAttemptRecord;
	manifestPath: string;
	manifestSha256: string;
	workspaceId: string;
	paneId: string;
	terminalId: string;
	agentName: string;
	continuation?: AttemptContinuation;
}): ReviewerAssignmentDocument {
	if (input.attempt.dispatch.phase !== "agent-intended" && input.attempt.dispatch.phase !== "prompt-intended" && input.attempt.dispatch.phase !== "prompted" && input.attempt.dispatch.phase !== "reconciled-active") throw new Error("Reviewer Assignment requires actual Reviewer identities.");
	if (input.attempt.replacement && !input.continuation) throw new Error("Replacement Reviewer Assignment requires its exact predecessor continuation.");
	if (!input.attempt.replacement && input.continuation) throw new Error("A non-replacement Reviewer Assignment cannot carry a replacement continuation.");
	const assignment: ReviewerAssignmentDocument = { schemaVersion: 1, assignment: { runId: input.runId, taskId: input.task.id, attemptId: input.attempt.id, role: "reviewer", requiredOutcome: input.task.requiredOutcome, reportPath: input.attempt.reportPath, evidenceDirectory: input.attempt.evidenceDirectory, actualModel: { ...input.attempt.actualModel }, specificationHash: input.attempt.specificationHash, subject: cloneSubject(input.attempt.subject), builderEvidence: { manifestPath: input.manifestPath, manifestSha256: input.manifestSha256 }, independence: { ...input.attempt.independence }, worktree: { path: input.attempt.worktree.path, baseline: { ...input.attempt.worktree.baseline, dirtyPaths: [...input.attempt.worktree.baseline.dirtyPaths], operationMarkers: [...input.attempt.worktree.baseline.operationMarkers] } }, herdr: { workspaceId: input.workspaceId, paneId: input.paneId, terminalId: input.terminalId, agentName: input.agentName }, ...(input.continuation ? { continuation: { ...input.continuation, preservedWorktree: { ...input.continuation.preservedWorktree } } } : {}) } };
	const validation = validateReviewerAssignment(assignment);
	if (!validation.value || validation.diagnostics.length > 0) throw new Error(`Cannot build Reviewer Assignment: ${validation.diagnostics.map((item) => item.message).join("; ")}`);
	return validation.value;
}

export function formatReviewerPrompt(document: ReviewerAssignmentDocument): string {
	return [`Steward Reviewer Assignment ${document.assignment.runId}/${document.assignment.taskId}/${document.assignment.attemptId}`, "", "The following Assignment is authoritative and bounded:", serializeReviewerAssignment(document).trimEnd(), "", "Inspect only the exact Review subject in the Assignment.", "Treat the worktree as read-only: do not edit, commit, reset, stash, clean, revert, or delete files.", `Write the Reviewer Attempt Report to ${document.assignment.reportPath} using verdict approved or changes-required only after completing the Review.`, "Terminal or Herdr lifecycle state is not a verdict; only the strictly parsed Attempt Report is authoritative.", formatTaskFactInstruction(), "Do not dispatch another agent."].join("\n");
}

export function serializeReviewerAttemptReport(report: ReviewerAttemptReport, body = ""): string {
	const frontmatter = { schemaVersion: 1, identity: report.identity, status: report.status, summary: report.summary, blockers: report.blockers, actualModel: report.actualModel, reviewedSubject: report.reviewedSubject, verdict: report.verdict, findings: report.findings, checks: report.checks, logReferences: report.logReferences };
	return `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n${body.length === 0 ? "" : body.endsWith("\n") ? body : `${body}\n`}`;
}

export function parseReviewerAttemptReport(content: string): { value?: ReviewerAttemptReport; diagnostics: ReviewDiagnostic[] } {
	if (Buffer.byteLength(content, "utf8") > MAX_REVIEW_REPORT_BYTES || content.startsWith("\uFEFF") || content.includes("\u0000") || content.includes("\r") || !content.startsWith("---\n") || !content.endsWith("\n")) return { diagnostics: [{ code: "invalid-report", message: "Reviewer Attempt Report must be bounded LF Markdown without BOM or NUL.", path: "report" }] };
	const closing = content.indexOf("\n---\n", 4);
	if (closing < 0) return { diagnostics: [{ code: "invalid-report", message: "Reviewer Attempt Report requires one JSON frontmatter block.", path: "report" }] };
	const json = content.slice(4, closing);
	let parsed: unknown;
	try { parsed = duplicateSafeJson(json); } catch (error: unknown) { return { diagnostics: [{ code: "invalid-report", message: error instanceof Error ? error.message : "Reviewer Report JSON is malformed.", path: "report" }] }; }
	const keys = ["schemaVersion", "identity", "status", "summary", "blockers", "actualModel", "reviewedSubject", "verdict", "findings", "checks", "logReferences"];
	if (!isRecord(parsed) || !exactKeys(parsed, keys) || parsed.schemaVersion !== 1 || parsed.status !== "completed" || parsed.verdict !== "approved" && parsed.verdict !== "changes-required" || !text(parsed.summary, 2_000) || !Array.isArray(parsed.blockers) || parsed.blockers.length !== 0 || !Array.isArray(parsed.findings) || parsed.findings.length > 100 || !Array.isArray(parsed.checks) || parsed.checks.length > 100 || !Array.isArray(parsed.logReferences) || parsed.logReferences.length > 100 || JSON.stringify(parsed, null, 2) !== json) return { diagnostics: [{ code: "invalid-report", message: "Reviewer Report top-level fields or canonical JSON are invalid.", path: "report" }] };
	const identity = parsed.identity;
	const identityOk = isRecord(identity) && exactKeys(identity, ["runId", "taskId", "attemptId", "role", "specificationHash", "assignmentSha256"]) && safeIdentifier(identity.runId) && safeIdentifier(identity.taskId) && safeIdentifier(identity.attemptId) && identity.role === "reviewer" && sha(identity.specificationHash) && sha(identity.assignmentSha256);
	const actualModel = model(parsed.actualModel, "report.actualModel");
	const reviewed = subject(parsed.reviewedSubject, "report.reviewedSubject");
	const findings: ReviewerFinding[] = [];
	const checks: ReportedCheck[] = [];
	const logs: ReportedLogReference[] = [];
	const diagnostics: ReviewDiagnostic[] = [];
	if (!identityOk) diagnostics.push({ code: "invalid-identity", message: "Reviewer Report identity is invalid.", path: "report.identity" });
	diagnostics.push(...actualModel.diagnostics, ...reviewed.diagnostics);
	for (let index = 0; index < parsed.findings.length; index += 1) { const result = parseFinding(parsed.findings[index], `report.findings[${index}]`); diagnostics.push(...result.diagnostics); if (result.value) findings.push(result.value); }
	for (let index = 0; index < parsed.checks.length; index += 1) { const result = parseCheck(parsed.checks[index], `report.checks[${index}]`); diagnostics.push(...result.diagnostics); if (result.value) checks.push(result.value); }
	for (let index = 0; index < parsed.logReferences.length; index += 1) { const result = parseLog(parsed.logReferences[index], `report.logReferences[${index}]`); diagnostics.push(...result.diagnostics); if (result.value) logs.push(result.value); }
	if (new Set(findings.map((finding) => finding.id)).size !== findings.length) diagnostics.push({ code: "ambiguous-finding", message: "Finding IDs must be unique.", path: "report.findings" });
	if (parsed.verdict === "changes-required" && findings.length === 0) diagnostics.push({ code: "missing-finding", message: "changes-required Reviewer Reports require an actionable finding.", path: "report.findings" });
	if (new Set(logs.map((log) => log.id)).size !== logs.length || new Set(logs.map((log) => log.path)).size !== logs.length) diagnostics.push({ code: "ambiguous-log", message: "Log identities and paths must be unique.", path: "report.logReferences" });
	const logIds = new Set(logs.map((log) => log.id));
	for (const check of checks) if (!logIds.has(check.logId)) diagnostics.push({ code: "missing-log-reference", message: `Check refers to missing log ${check.logId}.`, path: "report.checks" });
	for (const log of logs) if (!checks.some((check) => check.logId === log.id)) diagnostics.push({ code: "unused-log-reference", message: `Log ${log.id} is not used by a check.`, path: "report.logReferences" });
	if (diagnostics.length > 0 || !identityOk || !actualModel.value || !reviewed.value) return { diagnostics };
	return { value: { schemaVersion: 1, identity: { runId: identity.runId as string, taskId: identity.taskId as string, attemptId: identity.attemptId as string, role: "reviewer", specificationHash: identity.specificationHash as string, assignmentSha256: identity.assignmentSha256 as string }, status: "completed", summary: parsed.summary, blockers: [], actualModel: actualModel.value, reviewedSubject: reviewed.value, verdict: parsed.verdict, findings, checks, logReferences: logs }, diagnostics: [] };
}

export function validateReviewerReportAgainstAssignment(input: { report: ReviewerAttemptReport; assignment: ReviewerAssignmentDocument; assignmentSha256: string; runId: string; task: TaskContract; attempt: ReviewerAttemptRecord }): { value?: ReviewerAttemptReport; diagnostics: ReviewDiagnostic[] } {
	const diagnostics: ReviewDiagnostic[] = [];
	const { report, assignment } = input;
	if (assignment.assignment.runId !== input.runId || assignment.assignment.taskId !== input.task.id || assignment.assignment.attemptId !== input.attempt.id || report.identity.runId !== input.runId || report.identity.taskId !== input.task.id || report.identity.attemptId !== input.attempt.id || report.identity.role !== "reviewer") diagnostics.push({ code: "identity-mismatch", message: "Reviewer Report identity does not match the durable Run, Task, Assignment, or Attempt.", path: "identity" });
	if (assignment.assignment.specificationHash !== input.attempt.specificationHash) diagnostics.push({ code: "specification-mismatch", message: "Reviewer Assignment specification hash does not match the Task.", path: "assignment.specificationHash" });
	if (report.identity.specificationHash !== input.attempt.specificationHash) diagnostics.push({ code: "specification-mismatch", message: "Reviewer Report specification hash does not match the Task.", path: "identity.specificationHash" });
	if (report.identity.specificationHash !== assignment.assignment.specificationHash) diagnostics.push({ code: "specification-mismatch", message: "Reviewer Report specification hash does not match the Assignment.", path: "identity.specificationHash" });
	if (report.identity.assignmentSha256 !== input.assignmentSha256 || report.identity.assignmentSha256 !== reviewerAssignmentSha256(serializeReviewerAssignment(assignment))) diagnostics.push({ code: "assignment-changed", message: "Reviewer Report Assignment hash does not match the protected Assignment bytes.", path: "identity.assignmentSha256" });
	if (JSON.stringify(report.actualModel) !== JSON.stringify(assignment.assignment.actualModel) || JSON.stringify(report.actualModel) !== JSON.stringify(input.attempt.actualModel)) diagnostics.push({ code: "model-mismatch", message: "Reviewer Report model differs from the durable Assignment.", path: "actualModel" });
	if (!reviewSubjectsEqual(report.reviewedSubject, assignment.assignment.subject) || !reviewSubjectsEqual(report.reviewedSubject, input.attempt.subject)) diagnostics.push({ code: "subject-mismatch", message: "Reviewer Report subject differs from the immutable Assignment subject.", path: "reviewedSubject" });
	if (JSON.stringify(assignment.assignment.independence) !== JSON.stringify(input.attempt.independence)) diagnostics.push({ code: "independence-mismatch", message: "Reviewer independence differs from the durable Review Attempt.", path: "independence" });
	return diagnostics.length > 0 ? { diagnostics } : { value: report, diagnostics: [] };
}

export interface FinalizedReviewerEvidenceManifest {
	schemaVersion: 1;
	identity: { runId: string; taskId: string; attemptId: string; role: "reviewer" };
	status: "completed";
	verdict: "approved" | "changes-required";
	summary: string;
	findings: ReviewerFinding[];
	actualModel: ModelChoice;
	specificationHash: string;
	assignmentSha256: string;
	subject: ReviewSubject;
	independence: ReviewerIndependence;
	report: { originalPath: string; finalizedPath: string; size: number; sha256: string };
	logs: Array<{ id: string; originalPath: string; finalizedPath: string; size: number; sha256: string }>;
	before: ReviewWorktreeSnapshot;
	after: ReviewWorktreeSnapshot;
}

export function serializeFinalizedReviewerEvidenceManifest(manifest: FinalizedReviewerEvidenceManifest): string { return `${JSON.stringify(manifest, null, 2)}\n`; }
export function finalizedReviewerEvidenceManifestSha256(manifest: FinalizedReviewerEvidenceManifest): string { return hash(serializeFinalizedReviewerEvidenceManifest(manifest)); }

export function deserializeFinalizedReviewerEvidenceManifest(content: string, expectedSha256: string): { value?: FinalizedReviewerEvidenceManifest; message?: string } {
	if (hash(content) !== expectedSha256 || !content.endsWith("\n")) return { message: "Finalized Reviewer manifest bytes do not match the durable hash." };
	let parsed: unknown;
	try { parsed = JSON.parse(content) as unknown; } catch { return { message: "Finalized Reviewer manifest is malformed JSON." }; }
	if (!isRecord(parsed)) return { message: "Finalized Reviewer manifest must be an object." };
	const keys = ["schemaVersion", "identity", "status", "verdict", "summary", "findings", "actualModel", "specificationHash", "assignmentSha256", "subject", "independence", "report", "logs", "before", "after"];
	if (!exactKeys(parsed, keys) || `${JSON.stringify(parsed, null, 2)}\n` !== content || parsed.schemaVersion !== 1 || parsed.status !== "completed" || (parsed.verdict !== "approved" && parsed.verdict !== "changes-required") || !text(parsed.summary, 2_000) || !sha(parsed.specificationHash) || !sha(parsed.assignmentSha256) || !isRecord(parsed.identity) || parsed.identity.role !== "reviewer" || !safeIdentifier(parsed.identity.runId) || !safeIdentifier(parsed.identity.taskId) || !safeIdentifier(parsed.identity.attemptId)) return { message: "Finalized Reviewer manifest has invalid exact fields." };
	const modelResult = model(parsed.actualModel, "manifest.actualModel");
	const subjectResult = subject(parsed.subject, "manifest.subject");
	const independenceResult = parseIndependence(parsed.independence, "manifest.independence");
	if (!modelResult.value || !subjectResult.value || !independenceResult.value || !Array.isArray(parsed.findings) || !Array.isArray(parsed.logs) || !isRecord(parsed.report) || !isRecord(parsed.before) || !isRecord(parsed.after)) return { message: "Finalized Reviewer manifest contains invalid subject, identity, or evidence fields." };
	const findings: ReviewerFinding[] = [];
	for (const [index, item] of parsed.findings.entries()) { const finding = parseFinding(item, `manifest.findings[${index}]`); if (!finding.value) return { message: "Finalized Reviewer manifest contains invalid findings." }; findings.push(finding.value); }
	if (parsed.verdict === "changes-required" && findings.length === 0) return { message: "Finalized Reviewer manifest requires actionable findings for changes-required." };
	const report = parsed.report;
	if (!exactKeys(report, ["originalPath", "finalizedPath", "size", "sha256"]) || !absolutePath(report.originalPath) || !absolutePath(report.finalizedPath) || !Number.isSafeInteger(report.size) || (report.size as number) < 0 || !sha(report.sha256)) return { message: "Finalized Reviewer report pointer is invalid." };
	const before = parseSnapshot(parsed.before, "manifest.before");
	const after = parseSnapshot(parsed.after, "manifest.after");
	if (!before.value || !after.value) return { message: "Finalized Reviewer snapshots are invalid." };
	const logs: FinalizedReviewerEvidenceManifest["logs"] = [];
	for (const [index, item] of parsed.logs.entries()) {
		if (!isRecord(item) || !exactKeys(item, ["id", "originalPath", "finalizedPath", "size", "sha256"]) || !safeIdentifier(item.id) || !absolutePath(item.originalPath) || !absolutePath(item.finalizedPath) || !Number.isSafeInteger(item.size) || (item.size as number) < 0 || !sha(item.sha256)) return { message: `Finalized Reviewer log ${index} is invalid.` };
		logs.push({ id: item.id, originalPath: item.originalPath, finalizedPath: item.finalizedPath, size: item.size as number, sha256: item.sha256 });
	}
	return { value: { schemaVersion: 1, identity: { runId: parsed.identity.runId as string, taskId: parsed.identity.taskId as string, attemptId: parsed.identity.attemptId as string, role: "reviewer" }, status: "completed", verdict: parsed.verdict, summary: parsed.summary, findings, actualModel: modelResult.value, specificationHash: parsed.specificationHash, assignmentSha256: parsed.assignmentSha256, subject: subjectResult.value, independence: independenceResult.value, report: { originalPath: report.originalPath as string, finalizedPath: report.finalizedPath as string, size: report.size as number, sha256: report.sha256 as string }, logs, before: before.value, after: after.value }, message: undefined };
}

export function buildFinalizedReviewerEvidenceManifest(input: { runId: string; taskId: string; attempt: ReviewerAttemptRecord; report: ReviewerAttemptReport; reportSize: number; reportSha256: string; assignmentSha256: string; finalizedDirectory: string; logs: Array<{ id: string; originalPath: string; finalizedPath: string; size: number; sha256: string }>; after: ReviewWorktreeSnapshot }): FinalizedReviewerEvidenceManifest {
	return { schemaVersion: 1, identity: { runId: input.runId, taskId: input.taskId, attemptId: input.attempt.id, role: "reviewer" }, status: "completed", verdict: input.report.verdict, summary: input.report.summary, findings: input.report.findings.map((finding) => ({ ...finding })), actualModel: { ...input.report.actualModel }, specificationHash: input.attempt.specificationHash, assignmentSha256: input.assignmentSha256, subject: cloneSubject(input.attempt.subject), independence: { ...input.attempt.independence }, report: { originalPath: input.attempt.reportPath, finalizedPath: `${input.finalizedDirectory}/report.md`, size: input.reportSize, sha256: input.reportSha256 }, logs: input.logs.map((log) => ({ ...log })), before: { ...input.attempt.worktree.baseline, dirtyPaths: [...input.attempt.worktree.baseline.dirtyPaths], operationMarkers: [...input.attempt.worktree.baseline.operationMarkers] }, after: { ...input.after, dirtyPaths: [...input.after.dirtyPaths], operationMarkers: [...input.after.operationMarkers] } };
}

export function reviewerSubjectFromAttempt(attempt: AttemptRecord): ReviewSubject | undefined {
	return attempt.role === "reviewer" ? cloneSubject(attempt.subject) : undefined;
}
