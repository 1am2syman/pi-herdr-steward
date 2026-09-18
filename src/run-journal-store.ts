import { randomUUID } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { chmod, link, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { createAssignmentStore, resolveAssignmentPaths, type AssignmentCreateResult, type AssignmentPaths } from "./assignment-store.ts";
import { createAttemptEvidenceStore, type BuilderEvidenceInputRequest, type BuilderEvidenceInputs, type FinalizeBuilderEvidenceRequest, type FinalizeBuilderEvidenceResult, type ReferencedEvidenceRequest, type ReferencedEvidenceResult, type ReviewerEvidenceInputRequest, type ReviewerEvidenceInputs, type ReferencedReviewerEvidenceRequest, type ReferencedReviewerEvidenceResult, type FinalizeReviewerEvidenceRequest, type FinalizeReviewerEvidenceResult, type FinalizedManifestLoadResult } from "./attempt-evidence-store.ts";
import {
	ensureProjectStateDirectory,
	ensureOwnedDirectory,
	filesystemErrorText,
	removeKnownTemporaryFile,
	resolveProjectStatePaths,
	syncDirectory,
} from "./project-state.ts";
import {
	deserializeRunJournal,
	serializeRunJournal,
	validateActivityEntry,
	validateRunJournal,
	type ActivityEntry,
	type RunDiagnostic,
	type RunJournal,
} from "./run.ts";

export interface RunJournalPaths {
	stewardDirectory: string;
	activePath: string;
	previousPath: string;
	activityRoot: string;
}

export type ActiveRunLoadResult =
	| { kind: "missing"; paths: RunJournalPaths }
	| { kind: "loaded"; journal: RunJournal; paths: RunJournalPaths }
	| { kind: "invalid"; paths: RunJournalPaths; diagnostics: RunDiagnostic[] };

export type CreateActiveResult =
	| { kind: "created"; journal: RunJournal; paths: RunJournalPaths }
	| { kind: "active-exists"; paths: RunJournalPaths }
	| { kind: "storage-error"; paths: RunJournalPaths; diagnostics: RunDiagnostic[] };

export type ReplaceActiveResult =
	| { kind: "replaced"; journal: RunJournal; paths: RunJournalPaths }
	| { kind: "active-missing"; paths: RunJournalPaths }
	| { kind: "invalid-current"; paths: RunJournalPaths; diagnostics: RunDiagnostic[] }
	| { kind: "invalid-candidate"; paths: RunJournalPaths; diagnostics: RunDiagnostic[] }
	| { kind: "storage-error"; paths: RunJournalPaths; diagnostics: RunDiagnostic[] };

export type ActivityAppendResult =
	| { kind: "appended"; path: string }
	| { kind: "storage-error"; path: string; diagnostics: RunDiagnostic[] };

export interface RunJournalStore {
	resolvePaths(repositoryRoot: string): RunJournalPaths;
	probeActive(repositoryRoot: string): "missing" | "present";
	loadActive(repositoryRoot: string): Promise<ActiveRunLoadResult>;
	createActive(repositoryRoot: string, journal: RunJournal): Promise<CreateActiveResult>;
	replaceActive(repositoryRoot: string, journal: RunJournal): Promise<ReplaceActiveResult>;
	appendActivity(repositoryRoot: string, entry: ActivityEntry): Promise<ActivityAppendResult>;
	resolveAssignmentPaths(repositoryRoot: string, runId: string, taskId: string, attemptId: string): AssignmentPaths;
	createAssignment(repositoryRoot: string, document: import("./run.ts").AssignmentDocument): Promise<AssignmentCreateResult>;
	loadBuilderEvidenceInputs(input: BuilderEvidenceInputRequest): Promise<BuilderEvidenceInputs>;
	loadReviewerEvidenceInputs(input: ReviewerEvidenceInputRequest): Promise<ReviewerEvidenceInputs>;
	loadFinalizedEvidenceManifest(input: { manifestPath: string; manifestSha256: string }): Promise<FinalizedManifestLoadResult>;
	inspectReferencedEvidence(input: ReferencedEvidenceRequest): Promise<ReferencedEvidenceResult>;
	inspectReferencedReviewerEvidence(input: ReferencedReviewerEvidenceRequest): Promise<ReferencedReviewerEvidenceResult>;
	finalizeBuilderEvidence(input: FinalizeBuilderEvidenceRequest): Promise<FinalizeBuilderEvidenceResult>;
	finalizeReviewerEvidence(input: FinalizeReviewerEvidenceRequest): Promise<FinalizeReviewerEvidenceResult>;
}

const ACTIVE_NAME = "active-run.json";
const PREVIOUS_NAME = "active-run.previous.json";
const RUNS_NAME = "runs";

function pathsFor(repositoryRoot: string, configDirName: string): RunJournalPaths {
	const state = resolveProjectStatePaths(repositoryRoot, configDirName);
	return {
		stewardDirectory: state.stewardDirectory,
		activePath: join(state.stewardDirectory, ACTIVE_NAME),
		previousPath: join(state.stewardDirectory, PREVIOUS_NAME),
		activityRoot: join(state.stewardDirectory, RUNS_NAME),
	};
}

function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function existsError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function diag(code: RunDiagnostic["code"], message: string, path: string): RunDiagnostic {
	return { code, message, path };
}

function storageDiagnostics(path: string, error: unknown): RunDiagnostic[] {
	return [diag("invalid-run", `${path}: ${filesystemErrorText(error)}`, path)];
}

async function regularFile(path: string): Promise<boolean> {
	try {
		const info = await lstat(path);
		return info.isFile();
	} catch (error: unknown) {
		if (missing(error)) return false;
		throw error;
	}
}

async function readJournalFile(path: string): Promise<{ kind: "missing" } | { kind: "invalid"; diagnostics: RunDiagnostic[] } | { kind: "loaded"; journal: RunJournal; bytes: string }> {
	if (!(await regularFile(path))) {
		try {
			await lstat(path);
			return { kind: "invalid", diagnostics: [diag("invalid-run", "Run Journal path is not a regular file.", path)] };
		} catch (error: unknown) {
			if (missing(error)) return { kind: "missing" };
			throw error;
		}
	}
	let bytes: string;
	try {
		bytes = await readFile(path, "utf8");
	} catch (error: unknown) {
		return { kind: "invalid", diagnostics: storageDiagnostics(path, error) };
	}
	const decoded = deserializeRunJournal(bytes, path);
	return decoded.value ? { kind: "loaded", journal: decoded.value, bytes } : { kind: "invalid", diagnostics: decoded.diagnostics };
}

async function writePreparedTemporary(directory: string, prefix: string, bytes: string, validate: (content: string) => boolean): Promise<string> {
	const temporaryPath = join(directory, `.${prefix}.${process.pid}.${randomUUID()}.tmp`);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		await handle.writeFile(bytes, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		const reread = await readFile(temporaryPath, "utf8");
		if (reread !== bytes || !validate(reread)) throw new Error("Validated temporary Run Journal bytes changed before commit.");
		return temporaryPath;
	} catch (error: unknown) {
		await handle?.close().catch(() => undefined);
		await unlink(temporaryPath).catch(() => undefined);
		throw error;
	}
}

async function validateCandidate(journal: RunJournal, path: string): Promise<{ bytes: string; diagnostics: RunDiagnostic[] }> {
	const validation = validateRunJournal(journal, path);
	if (!validation.value || validation.diagnostics.length > 0) return { bytes: "", diagnostics: validation.diagnostics };
	return { bytes: serializeRunJournal(validation.value), diagnostics: [] };
}

function validateFileBytes(bytes: string, path: string): boolean {
	return Boolean(deserializeRunJournal(bytes, path).value);
}

async function ensureNoUnexpectedPrevious(path: string): Promise<void> {
	try {
		const info = await lstat(path);
		if (!info.isFile()) throw new Error(`Previous Run Journal path is not a regular file: ${path}`);
		const decoded = deserializeRunJournal(await readFile(path, "utf8"), path);
		if (!decoded.value) throw new Error(`Previous Run Journal is invalid at ${path}.`);
	} catch (error: unknown) {
		if (!missing(error)) throw error;
	}
}

function runActivityPath(paths: RunJournalPaths, runId: string): string {
	return join(paths.activityRoot, runId, "activity.log");
}

export function resolveRunJournalPaths(repositoryRoot: string, configDirName = CONFIG_DIR_NAME): RunJournalPaths {
	return pathsFor(repositoryRoot, configDirName);
}

export function createRunJournalStore(options: { configDirName?: string } = {}): RunJournalStore {
	const configDirName = options.configDirName ?? CONFIG_DIR_NAME;
	const assignmentStore = createAssignmentStore({ configDirName });
	const evidenceStore = createAttemptEvidenceStore();

	function resolvePaths(repositoryRoot: string): RunJournalPaths {
		return pathsFor(repositoryRoot, configDirName);
	}

	function probeActive(repositoryRoot: string): "missing" | "present" {
		const path = resolvePaths(repositoryRoot).activePath;
		try {
			return requireLstat(path) ? "present" : "missing";
		} catch (error: unknown) {
			if (missing(error)) return "missing";
			return "present";
		}
	}

	async function loadActive(repositoryRoot: string): Promise<ActiveRunLoadResult> {
		const paths = resolvePaths(repositoryRoot);
		try {
			const result = await readJournalFile(paths.activePath);
			if (result.kind === "missing") return { kind: "missing", paths };
			if (result.kind === "invalid") return { kind: "invalid", paths, diagnostics: result.diagnostics };
			return { kind: "loaded", journal: result.journal, paths };
		} catch (error: unknown) {
			return { kind: "invalid", paths, diagnostics: storageDiagnostics(paths.activePath, error) };
		}
	}

	async function createActive(repositoryRoot: string, journal: RunJournal): Promise<CreateActiveResult> {
		const paths = resolvePaths(repositoryRoot);
		const validation = await validateCandidate(journal, paths.activePath);
		if (validation.diagnostics.length > 0) return { kind: "storage-error", paths, diagnostics: validation.diagnostics };
		if (journal.journalRevision !== 1) return { kind: "storage-error", paths, diagnostics: [diag("invalid-run", "Initial Run Journal creation requires journalRevision 1.", paths.activePath)] };
		try {
			await ensureProjectStateDirectory(repositoryRoot, configDirName);
			const current = await readJournalFile(paths.activePath);
			if (current.kind === "loaded" || current.kind === "invalid") return { kind: "active-exists", paths };
			const previous = await readJournalFile(paths.previousPath);
			if (previous.kind !== "missing") return { kind: "storage-error", paths, diagnostics: [diag("invalid-run", "Initial Run Journal creation requires an absent previous snapshot.", paths.previousPath)] };
			const temporaryPath = await writePreparedTemporary(paths.stewardDirectory, ACTIVE_NAME, validation.bytes, (bytes) => Boolean(deserializeRunJournal(bytes, paths.activePath).value));
			try {
				try {
					await link(temporaryPath, paths.activePath);
				} catch (error: unknown) {
					if (existsError(error)) return { kind: "active-exists", paths };
					throw error;
				}
				await syncDirectory(paths.stewardDirectory);
				return { kind: "created", journal: journal, paths };
			} finally {
				await removeKnownTemporaryFile(temporaryPath).catch(() => undefined);
			}
		} catch (error: unknown) {
			return { kind: "storage-error", paths, diagnostics: storageDiagnostics(paths.activePath, error) };
		}
	}

	async function replaceActive(repositoryRoot: string, journal: RunJournal): Promise<ReplaceActiveResult> {
		const paths = resolvePaths(repositoryRoot);
		const candidate = await validateCandidate(journal, paths.activePath);
		if (candidate.diagnostics.length > 0) return { kind: "invalid-candidate", paths, diagnostics: candidate.diagnostics };
		let current: Awaited<ReturnType<typeof readJournalFile>>;
		try {
			current = await readJournalFile(paths.activePath);
		} catch (error: unknown) {
			return { kind: "storage-error", paths, diagnostics: storageDiagnostics(paths.activePath, error) };
		}
		if (current.kind === "missing") {
			if (journal.journalRevision !== 1) return { kind: "active-missing", paths };
			const created = await createActive(repositoryRoot, journal);
			return created.kind === "created" ? { kind: "replaced", journal, paths } : created.kind === "active-exists" ? { kind: "storage-error", paths, diagnostics: [diag("invalid-run", "Active Run appeared during creation.", paths.activePath)] } : { kind: "storage-error", paths, diagnostics: created.diagnostics };
		}
		if (current.kind === "invalid") return { kind: "invalid-current", paths, diagnostics: current.diagnostics };
		if (journal.run.id !== current.journal.run.id || journal.journalRevision !== current.journal.journalRevision + 1) return { kind: "invalid-candidate", paths, diagnostics: [diag("invalid-run", "Replacement must keep the Run id and increment journalRevision exactly once.", paths.activePath)] };
		if (journal.run.createdAt !== current.journal.run.createdAt || journal.run.updatedAt <= current.journal.run.updatedAt) return { kind: "invalid-candidate", paths, diagnostics: [diag("invalid-run", "Replacement must preserve createdAt and advance updatedAt.", paths.activePath)] };
		try {
			await ensureProjectStateDirectory(repositoryRoot, configDirName);
			await ensureNoUnexpectedPrevious(paths.previousPath);
			const currentAgain = await readFile(paths.activePath, "utf8");
			if (currentAgain !== current.bytes) return { kind: "storage-error", paths, diagnostics: [diag("invalid-run", "Active Run changed during replacement; no snapshot was overwritten.", paths.activePath)] };
			let candidateTemp: string | undefined;
			let previousTemp: string | undefined;
			try {
				candidateTemp = await writePreparedTemporary(paths.stewardDirectory, ACTIVE_NAME, candidate.bytes, (bytes) => Boolean(deserializeRunJournal(bytes, paths.activePath).value));
				previousTemp = await writePreparedTemporary(paths.stewardDirectory, PREVIOUS_NAME, current.bytes, (bytes) => validateFileBytes(bytes, paths.previousPath));
				await rename(previousTemp, paths.previousPath);
				await syncDirectory(paths.stewardDirectory);
				await rename(candidateTemp, paths.activePath);
				await syncDirectory(paths.stewardDirectory);
				return { kind: "replaced", journal, paths };
			} finally {
				if (candidateTemp) await removeKnownTemporaryFile(candidateTemp).catch(() => undefined);
				if (previousTemp) await removeKnownTemporaryFile(previousTemp).catch(() => undefined);
			}
		} catch (error: unknown) {
			return { kind: "storage-error", paths, diagnostics: storageDiagnostics(paths.activePath, error) };
		}
	}

	async function appendActivity(repositoryRoot: string, entry: ActivityEntry): Promise<ActivityAppendResult> {
		const paths = resolvePaths(repositoryRoot);
		const path = runActivityPath(paths, entry.runId);
		const entryValidation = validateActivityEntry(entry, path);
		if (!entryValidation.value || entryValidation.diagnostics.length > 0) return { kind: "storage-error", path, diagnostics: entryValidation.diagnostics };
		const validatedEntry = entryValidation.value;
		const bytes = `${JSON.stringify({ timestamp: validatedEntry.timestamp, runId: validatedEntry.runId, event: validatedEntry.event, message: validatedEntry.message })}\n`;
		try {
			await ensureProjectStateDirectory(repositoryRoot, configDirName);
			await ensureOwnedDirectory(paths.activityRoot);
			const runDirectory = join(paths.activityRoot, validatedEntry.runId);
			await ensureOwnedDirectory(runDirectory);
			const info = await lstat(path).catch((error: unknown) => (missing(error) ? undefined : Promise.reject(error)));
			if (info && !info.isFile()) throw new Error(`Activity log path is not a regular file: ${path}`);
			if (info) await chmod(path, 0o600).catch(() => undefined);
			const handle = await open(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
			try {
				await handle.writeFile(bytes, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await syncDirectory(runDirectory);
			return { kind: "appended", path };
		} catch (error: unknown) {
			return { kind: "storage-error", path, diagnostics: storageDiagnostics(path, error) };
		}
	}

	return {
		resolvePaths,
		probeActive,
		loadActive,
		createActive,
		replaceActive,
		appendActivity,
		resolveAssignmentPaths: (repositoryRoot, runId, taskId, attemptId) => resolveAssignmentPaths(repositoryRoot, runId, taskId, attemptId, configDirName),
		createAssignment: assignmentStore.createAssignment,
		loadBuilderEvidenceInputs: evidenceStore.loadBuilderEvidenceInputs,
		loadReviewerEvidenceInputs: evidenceStore.loadReviewerEvidenceInputs,
		loadFinalizedEvidenceManifest: evidenceStore.loadFinalizedEvidenceManifest,
		inspectReferencedEvidence: evidenceStore.inspectReferencedEvidence,
		inspectReferencedReviewerEvidence: evidenceStore.inspectReferencedReviewerEvidence,
		finalizeBuilderEvidence: evidenceStore.finalizeBuilderEvidence,
		finalizeReviewerEvidence: evidenceStore.finalizeReviewerEvidence,
	};
}

function requireLstat(path: string): boolean {
	// probeActive is intentionally synchronous to preserve the ticket-01 status seam.
	return Boolean(lstatSync(path));
}
