import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { chmod, link, lstat, open, readFile, realpath, rename, unlink, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { createAssignmentStore, resolveAssignmentPaths, type AssignmentCreateResult, type AssignmentPaths } from "./assignment-store.ts";
import { createAttemptEvidenceStore, type BuilderEvidenceInputRequest, type BuilderEvidenceInputs, type FinalizeBuilderEvidenceRequest, type FinalizeBuilderEvidenceResult, type ReferencedEvidenceRequest, type ReferencedEvidenceResult, type ReviewerEvidenceInputRequest, type ReviewerEvidenceInputs, type ReferencedReviewerEvidenceRequest, type ReferencedReviewerEvidenceResult, type FinalizeReviewerEvidenceRequest, type FinalizeReviewerEvidenceResult, type FinalizedManifestLoadResult } from "./attempt-evidence-store.ts";
import { archiveCancelledRun, archiveCompletedRun, finalizeVerificationResult, inspectFinalVerificationResult, listTerminalArchives, resolveCompletionPaths, type ArchiveCancelledRunRequest, type ArchiveCancelledRunResult, type ArchiveCompletedRunRequest, type ArchiveCompletedRunResult, type CompletionJournalPointers, type CompletionPaths, type FinalVerificationResultInspection, type TerminalArchiveListingResult, type VerificationEvidenceInput, type VerificationFinalizeResult } from "./completion-store.ts";
import {
	ensureProjectStateDirectory,
	ensureOwnedDirectory,
	filesystemErrorText,
	removeKnownTemporaryFile,
	resolveProjectStatePaths,
	syncDirectory,
} from "./project-state.ts";
import {
	classifyRunJournalEnvelope,
	deserializeRunJournal,
	serializeRunJournal,
	serializeRunJournalAtPath,
	validateActivityEntry,
	validateRunJournal,
	type ActivityEntry,
	type RunDiagnostic,
	type RunJournal,
	type AttemptRecord,
	type MonitorReportObservation,
	RUN_JOURNAL_SCHEMA_VERSION,
} from "./run.ts";

export interface RunJournalPaths {
	stewardDirectory: string;
	activePath: string;
	previousPath: string;
	activityRoot: string;
}

export type ActiveJournalMode = "normal" | "recovered" | "read-only";

export interface JournalSnapshotProvenance {
	path: string;
	sha256: string;
	byteCount: number;
}

export interface RunJournalMigration {
	id: string;
	fromVersion: number;
	targetVersion: typeof RUN_JOURNAL_SCHEMA_VERSION;
	migrate(value: unknown): unknown;
}

export type RunJournalMigrationRegistry = ReadonlyMap<number, RunJournalMigration>;

export interface JournalMigrationBasis {
	id: string;
	fromVersion: number;
	targetVersion: typeof RUN_JOURNAL_SCHEMA_VERSION;
	rawActiveSha256: string;
	migratedSha256: string;
}

export type ActiveRunLoadResult =
	| { kind: "missing"; paths: RunJournalPaths }
	| { kind: "loaded"; mode: "normal"; journal: RunJournal; paths: RunJournalPaths; active: JournalSnapshotProvenance }
	| { kind: "recovered"; mode: "recovered"; journal: RunJournal; paths: RunJournalPaths; active: JournalSnapshotProvenance; previous: JournalSnapshotProvenance; diagnostics: RunDiagnostic[] }
	| { kind: "migration-ready"; mode: "recovered"; journal: RunJournal; paths: RunJournalPaths; active: JournalSnapshotProvenance; migration: JournalMigrationBasis }
	| {
			kind: "invalid";
			mode: "read-only";
			paths: RunJournalPaths;
			reason: "invalid-snapshots" | "unsafe-snapshot" | "newer-schema" | "older-schema" | "migration-failed";
			diagnostics: RunDiagnostic[];
			active?: JournalSnapshotProvenance;
			previous?: JournalSnapshotProvenance;
	  };

export type ApplyRunJournalMigrationResult =
	| { kind: "applied"; journal: RunJournal; paths: RunJournalPaths; migration: JournalMigrationBasis }
	| { kind: "refused" | "stale" | "storage-error"; paths: RunJournalPaths; diagnostics: RunDiagnostic[] };

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

export type AttemptReportInspection =
	| { kind: "missing" }
	| { kind: "present"; size: number; sha256: string }
	| { kind: "unavailable"; diagnostic: string };

export type AttemptPreservationInspection =
	| { kind: "inspected"; assignment: { path: string; size: number; sha256: string } | { kind: "missing" | "unavailable"; path: string; diagnostic?: string }; report: MonitorReportObservation; evidence: { directory: string; count: number; byteCount: number; sha256: string; entries: Array<{ path: string; size: number; sha256: string }> } }
	| { kind: "unavailable"; diagnostic: string };

export type AttemptAssignmentInspection =
	| { kind: "loaded"; path: string; bytes: Buffer; size: number; sha256: string }
	| { kind: "missing" | "unavailable"; diagnostic: string };

export interface RunJournalStore {
	resolvePaths(repositoryRoot: string): RunJournalPaths;
	probeActive(repositoryRoot: string): "missing" | "present";
	loadActive(repositoryRoot: string): Promise<ActiveRunLoadResult>;
	applyMigration(repositoryRoot: string, expected: Extract<ActiveRunLoadResult, { kind: "migration-ready" }>): Promise<ApplyRunJournalMigrationResult>;
	createActive(repositoryRoot: string, journal: RunJournal): Promise<CreateActiveResult>;
	replaceActive(repositoryRoot: string, journal: RunJournal): Promise<ReplaceActiveResult>;
	appendActivity(repositoryRoot: string, entry: ActivityEntry): Promise<ActivityAppendResult>;
	inspectAttemptReport(repositoryRoot: string, reportPath: string): Promise<AttemptReportInspection>;
	inspectAttemptAssignment(input: { repositoryRoot: string; attempt: AttemptRecord }): Promise<AttemptAssignmentInspection>;
	inspectAttemptPreservation(input: { repositoryRoot: string; attempt: AttemptRecord }): Promise<AttemptPreservationInspection>;
	resolveAssignmentPaths(repositoryRoot: string, runId: string, taskId: string, attemptId: string): AssignmentPaths;
	createAssignment(repositoryRoot: string, document: import("./run.ts").AssignmentDocument): Promise<AssignmentCreateResult>;
	loadBuilderEvidenceInputs(input: BuilderEvidenceInputRequest): Promise<BuilderEvidenceInputs>;
	loadReviewerEvidenceInputs(input: ReviewerEvidenceInputRequest): Promise<ReviewerEvidenceInputs>;
	loadFinalizedEvidenceManifest(input: { manifestPath: string; manifestSha256: string }): Promise<FinalizedManifestLoadResult>;
	inspectReferencedEvidence(input: ReferencedEvidenceRequest): Promise<ReferencedEvidenceResult>;
	inspectReferencedReviewerEvidence(input: ReferencedReviewerEvidenceRequest): Promise<ReferencedReviewerEvidenceResult>;
	finalizeBuilderEvidence(input: FinalizeBuilderEvidenceRequest): Promise<FinalizeBuilderEvidenceResult>;
	finalizeReviewerEvidence(input: FinalizeReviewerEvidenceRequest): Promise<FinalizeReviewerEvidenceResult>;
	resolveCompletionPaths(repositoryRoot: string, runId: string, configDirNameOrAttempt?: string, attemptId?: import("./run.ts").FinalVerificationAttemptId): CompletionPaths;
	finalizeVerificationResult(input: VerificationEvidenceInput): Promise<VerificationFinalizeResult>;
	inspectFinalVerificationResult(input: { repositoryRoot: string; runId: string; command: string; cwd: string; attemptId: import("./run.ts").FinalVerificationAttemptId; executionNonce?: string; argvSha256?: string }): Promise<FinalVerificationResultInspection>;
	archiveCompletedRun(input: ArchiveCompletedRunRequest): Promise<ArchiveCompletedRunResult>;
	archiveCancelledRun(input: ArchiveCancelledRunRequest): Promise<ArchiveCancelledRunResult>;
	listTerminalArchives(repositoryRoot: string): Promise<TerminalArchiveListingResult>;
	loadCompletionJournalPointers(repositoryRoot: string): Promise<{ kind: "loaded"; pointers: CompletionJournalPointers } | { kind: "unavailable"; message: string }>;
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

interface StableRawSnapshot {
	path: string;
	bytes: Buffer;
	text: string;
	provenance: JournalSnapshotProvenance;
}

type JournalFileRead =
	| { kind: "missing" }
	| { kind: "unsafe"; diagnostics: RunDiagnostic[] }
	| { kind: "invalid"; diagnostics: RunDiagnostic[]; snapshot: StableRawSnapshot }
	| { kind: "newer"; schemaVersion: number; diagnostics: RunDiagnostic[]; snapshot: StableRawSnapshot }
	| { kind: "older"; schemaVersion: number; value: unknown; diagnostics: RunDiagnostic[]; snapshot: StableRawSnapshot }
	| { kind: "loaded"; journal: RunJournal; bytes: string; snapshot: StableRawSnapshot };

function sameFileFacts(left: { dev: number; ino: number; size: number }, right: { dev: number; ino: number; size: number }): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function unsafeSnapshotDiagnostic(path: string, message: string): RunDiagnostic[] {
	return [diag("invalid-run", `Unsafe Run Journal snapshot: ${message}`, path)];
}

async function readStableRawSnapshot(path: string): Promise<{ kind: "missing" } | { kind: "unsafe"; diagnostics: RunDiagnostic[] } | { kind: "read"; snapshot: StableRawSnapshot }> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	let initial: Awaited<ReturnType<typeof lstat>>;
	try {
		try {
			initial = await lstat(path);
		} catch (error: unknown) {
			if (missing(error)) return { kind: "missing" };
			return { kind: "unsafe", diagnostics: storageDiagnostics(path, error) };
		}
		if (!initial.isFile() || initial.isSymbolicLink()) return { kind: "unsafe", diagnostics: unsafeSnapshotDiagnostic(path, "the path is not a regular non-symlink file.") };
		try {
			handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		} catch (error: unknown) {
			return { kind: "unsafe", diagnostics: unsafeSnapshotDiagnostic(path, filesystemErrorText(error).slice(0, 2_000)) };
		}
		const before = await handle.stat();
		if (!before.isFile() || before.isSymbolicLink() || !sameFileFacts(initial, before)) return { kind: "unsafe", diagnostics: unsafeSnapshotDiagnostic(path, "the file changed before its descriptor was opened.") };
		const bytes = await handle.readFile();
		const after = await handle.stat();
		if (!after.isFile() || after.isSymbolicLink() || !sameFileFacts(before, after) || bytes.length !== before.size) return { kind: "unsafe", diagnostics: unsafeSnapshotDiagnostic(path, "the file changed while it was read.") };
		const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
		return { kind: "read", snapshot: { path, bytes, text: bytes.toString("utf8"), provenance: { path, sha256, byteCount: bytes.length } } };
	} catch (error: unknown) {
		return { kind: "unsafe", diagnostics: unsafeSnapshotDiagnostic(path, filesystemErrorText(error).slice(0, 2_000)) };
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function diagnosticsForJournalRead(result: Extract<JournalFileRead, { kind: "unsafe" | "invalid" | "newer" | "older" }>): RunDiagnostic[] {
	return result.diagnostics;
}

async function readJournalFile(path: string): Promise<JournalFileRead> {
	const raw = await readStableRawSnapshot(path);
	if (raw.kind !== "read") return raw;
	const envelope = classifyRunJournalEnvelope(raw.snapshot.text, path);
	if (envelope.kind === "malformed") return { kind: "invalid", diagnostics: envelope.diagnostics, snapshot: raw.snapshot };
	if (envelope.kind === "newer") {
		return {
			kind: "newer",
			schemaVersion: envelope.schemaVersion,
			diagnostics: [diag("invalid-run", `Run Journal schemaVersion ${envelope.schemaVersion} is newer than the supported schemaVersion ${RUN_JOURNAL_SCHEMA_VERSION}; update Steward before changing snapshots.`, path)],
			snapshot: raw.snapshot,
		};
	}
	if (envelope.kind === "older") {
		return {
			kind: "older",
			schemaVersion: envelope.schemaVersion,
			value: envelope.value,
			diagnostics: [diag("invalid-run", `Run Journal schemaVersion ${envelope.schemaVersion} is older than the supported schemaVersion ${RUN_JOURNAL_SCHEMA_VERSION}.`, path)],
			snapshot: raw.snapshot,
		};
	}
	const decoded = deserializeRunJournal(raw.snapshot.text, path);
	return decoded.value ? { kind: "loaded", journal: decoded.value, bytes: raw.snapshot.text, snapshot: raw.snapshot } : { kind: "invalid", diagnostics: decoded.diagnostics, snapshot: raw.snapshot };
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

function sha256(bytes: string | Buffer): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function migrationFromRegistry(registry: RunJournalMigrationRegistry | undefined, version: number): RunJournalMigration | undefined {
	if (!registry) return undefined;
	const candidate = registry.get(version);
	if (!candidate || candidate.fromVersion !== version || candidate.fromVersion >= RUN_JOURNAL_SCHEMA_VERSION || candidate.targetVersion !== RUN_JOURNAL_SCHEMA_VERSION || typeof candidate.id !== "string" || candidate.id.trim().length === 0 || candidate.id !== candidate.id.trim() || candidate.id.includes("\u0000") || typeof candidate.migrate !== "function") return undefined;
	return candidate;
}

function prepareMigration(input: { value: unknown; schemaVersion: number; snapshot: StableRawSnapshot }, migration: RunJournalMigration, path: string): { kind: "prepared"; journal: RunJournal; bytes: string; migration: JournalMigrationBasis } | { kind: "failed"; diagnostics: RunDiagnostic[] } {
	let migrated: unknown;
	try {
		migrated = migration.migrate(input.value);
	} catch (error: unknown) {
		return { kind: "failed", diagnostics: [diag("invalid-run", `Run Journal migration ${migration.id} failed: ${filesystemErrorText(error).slice(0, 2_000)}`, path)] };
	}
	const validation = validateRunJournal(migrated, path);
	if (!validation.value || validation.diagnostics.length > 0) return { kind: "failed", diagnostics: validation.diagnostics.length > 0 ? validation.diagnostics : [diag("invalid-run", `Run Journal migration ${migration.id} did not produce a valid schemaVersion ${RUN_JOURNAL_SCHEMA_VERSION} snapshot.`, path)] };
	const bytes = serializeRunJournalAtPath(validation.value, path);
	return {
		kind: "prepared",
		journal: validation.value,
		bytes,
		migration: {
			id: migration.id,
			fromVersion: input.schemaVersion,
			targetVersion: RUN_JOURNAL_SCHEMA_VERSION,
			rawActiveSha256: input.snapshot.provenance.sha256,
			migratedSha256: sha256(bytes),
		},
	};
}

interface PublishedExclusiveSnapshot {
	dev: number;
	ino: number;
	provenance: JournalSnapshotProvenance;
}

async function publishExclusiveSnapshot(path: string, bytes: string): Promise<"exists" | PublishedExclusiveSnapshot> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		await handle.writeFile(bytes, "utf8");
		await handle.sync();
		const info = await handle.stat();
		await handle.close();
		handle = undefined;
		const reread = await readStableRawSnapshot(path);
		if (reread.kind !== "read" || reread.snapshot.text !== bytes) throw new Error("Exclusive Run Journal snapshot changed before it was published.");
		await syncDirectory(dirname(path));
		return { dev: info.dev, ino: info.ino, provenance: reread.snapshot.provenance };
	} catch (error: unknown) {
		await handle?.close().catch(() => undefined);
		if (existsError(error)) return "exists";
		await unlink(path).catch(() => undefined);
		throw error;
	}
}

async function removePublishedSnapshot(path: string, published: PublishedExclusiveSnapshot): Promise<void> {
	try {
		const info = await lstat(path);
		if (info.dev !== published.dev || info.ino !== published.ino) return;
		await unlink(path);
		await syncDirectory(dirname(path));
	} catch (error: unknown) {
		if (!missing(error)) throw error;
	}
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

async function inspectStableAttemptReport(repositoryRoot: string, reportPath: string, configDirName: string): Promise<AttemptReportInspection> {
	const state = resolveProjectStatePaths(repositoryRoot, configDirName);
	const root = resolve(state.stewardDirectory);
	if (!isAbsolute(reportPath) || reportPath !== resolve(reportPath) || !reportPath.endsWith("/report.md")) return { kind: "unavailable", diagnostic: "Attempt Report path is not an exact Steward-owned report path." };
	const relativePath = relative(root, reportPath);
	if (relativePath.startsWith("..") || isAbsolute(relativePath) || relativePath.includes("\\") || relativePath.split("/").some((part) => part === "" || part === "." || part === "..") || !relativePath.startsWith("runs/")) return { kind: "unavailable", diagnostic: "Attempt Report path escaped the Steward state directory." };
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const info = await lstat(reportPath);
		if (!info.isFile() || info.isSymbolicLink()) return { kind: "unavailable", diagnostic: "Attempt Report is not a regular non-symlink file." };
		if (info.size > 64 * 1024) return { kind: "unavailable", diagnostic: "Attempt Report exceeds the bounded observation size." };
		if ((await realpath(reportPath)) !== reportPath) return { kind: "unavailable", diagnostic: "Attempt Report resolves through a symlink." };
		handle = await open(reportPath, constants.O_RDONLY | constants.O_NOFOLLOW);
		const before = await handle.stat();
		if (!before.isFile() || before.dev !== info.dev || before.ino !== info.ino || before.size !== info.size) return { kind: "unavailable", diagnostic: "Attempt Report changed before observation." };
		const digest = createHash("sha256");
		let size = 0;
		while (size <= 64 * 1024) {
			const chunk = Buffer.alloc(Math.min(64 * 1024, 64 * 1024 + 1 - size));
			const read = await handle.read(chunk, 0, chunk.length, null);
			if (read.bytesRead === 0) break;
			const bytes = chunk.subarray(0, read.bytesRead);
			size += read.bytesRead;
			if (size > 64 * 1024) return { kind: "unavailable", diagnostic: "Attempt Report exceeds the bounded observation size." };
			digest.update(bytes);
		}
		const after = await handle.stat();
		if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || size !== before.size) return { kind: "unavailable", diagnostic: "Attempt Report changed while it was observed." };
		return { kind: "present", size, sha256: `sha256:${digest.digest("hex")}` };
	} catch (error: unknown) {
		if (missing(error)) return { kind: "missing" };
		return { kind: "unavailable", diagnostic: filesystemErrorText(error).slice(0, 2_000) };
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function inspectPreservationFile(path: string, maximumBytes: number): Promise<{ size: number; sha256: string } | undefined> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink() || info.size > maximumBytes || (await realpath(path)) !== path) return undefined;
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const before = await handle.stat();
		if (!before.isFile() || before.dev !== info.dev || before.ino !== info.ino || before.size !== info.size) return undefined;
		const digest = createHash("sha256");
		const bytes = await handle.readFile();
		if (bytes.length !== info.size) return undefined;
		const after = await handle.stat();
		if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) return undefined;
		digest.update(bytes);
		return { size: bytes.length, sha256: `sha256:${digest.digest("hex")}` };
	} catch {
		return undefined;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function inspectAssignmentBytes(path: string, maximumBytes: number): Promise<AttemptAssignmentInspection> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink() || info.size > maximumBytes || (await realpath(path)) !== path) return { kind: "unavailable", diagnostic: "Assignment is not a stable regular non-symlink file." };
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const before = await handle.stat();
		if (!before.isFile() || before.dev !== info.dev || before.ino !== info.ino || before.size !== info.size) return { kind: "unavailable", diagnostic: "Assignment changed before observation." };
		const bytes = await handle.readFile();
		const after = await handle.stat();
		if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || bytes.length !== before.size) return { kind: "unavailable", diagnostic: "Assignment changed while it was observed." };
		return { kind: "loaded", path, bytes, size: bytes.length, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
	} catch (error: unknown) {
		return missing(error) ? { kind: "missing", diagnostic: "Assignment is missing." } : { kind: "unavailable", diagnostic: filesystemErrorText(error).slice(0, 2_000) };
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function inspectAttemptPreservation(input: { repositoryRoot: string; attempt: AttemptRecord }, configDirName: string): Promise<AttemptPreservationInspection> {
	const state = resolveProjectStatePaths(input.repositoryRoot, configDirName);
	const root = resolve(state.stewardDirectory);
	const expectedRoot = resolve(input.attempt.assignmentPath, "..");
	if (!isAbsolute(input.attempt.assignmentPath) || !isAbsolute(input.attempt.reportPath) || !isAbsolute(input.attempt.evidenceDirectory) || input.attempt.assignmentPath !== join(expectedRoot, "assignment.json") || input.attempt.reportPath !== join(expectedRoot, "report.md") || input.attempt.evidenceDirectory !== join(expectedRoot, "evidence") || !expectedRoot.startsWith(`${root}/`)) return { kind: "unavailable", diagnostic: "Attempt preservation paths are not deterministic Steward-owned paths." };
	const assignment = await inspectPreservationFile(input.attempt.assignmentPath, 64 * 1024);
	let assignmentObservation: { path: string; size: number; sha256: string } | { kind: "missing" | "unavailable"; path: string; diagnostic?: string };
	if (assignment) assignmentObservation = { path: input.attempt.assignmentPath, size: assignment.size, sha256: assignment.sha256 };
	else {
		try {
			await lstat(input.attempt.assignmentPath);
			assignmentObservation = { kind: "unavailable", path: input.attempt.assignmentPath, diagnostic: "Assignment is missing, unstable, or not a regular non-symlink file." };
		} catch (error: unknown) {
			assignmentObservation = missing(error) ? { kind: "missing", path: input.attempt.assignmentPath } : { kind: "unavailable", path: input.attempt.assignmentPath, diagnostic: filesystemErrorText(error).slice(0, 2_000) };
		}
	}
	const report = await inspectStableAttemptReport(input.repositoryRoot, input.attempt.reportPath, configDirName);
	let evidenceInfo: Awaited<ReturnType<typeof lstat>> | undefined;
	let evidenceMissing = false;
	try {
		evidenceInfo = await lstat(input.attempt.evidenceDirectory);
		if (!evidenceInfo.isDirectory() || evidenceInfo.isSymbolicLink() || (await realpath(input.attempt.evidenceDirectory)) !== input.attempt.evidenceDirectory) return { kind: "unavailable", diagnostic: "Evidence directory is not a stable non-symlink directory." };
	} catch (error: unknown) {
		if (missing(error)) evidenceMissing = true;
		else return { kind: "unavailable", diagnostic: "Evidence directory could not be inspected." };
	}
	const entries: Array<{ path: string; size: number; sha256: string }> = [];
	let byteCount = 0;
	async function walk(directory: string, relativeDirectory: string): Promise<boolean> {
		let names: string[];
		try { names = (await readdir(directory)).sort(); } catch { return false; }
		for (const name of names) {
			if (name.length === 0 || name === "." || name === ".." || name.includes("\u0000") || entries.length >= 512) return false;
			const absolute = join(directory, name);
			const relativePath = relativeDirectory.length > 0 ? `${relativeDirectory}/${name}` : name;
			let info;
			try { info = await lstat(absolute); } catch { return false; }
			if (info.isSymbolicLink()) return false;
			if (info.isDirectory()) {
				if (!(await walk(absolute, relativePath))) return false;
				continue;
			}
			if (!info.isFile() || info.size > 256 * 1024 || byteCount + info.size > 16 * 1024 * 1024) return false;
			const digest = await inspectPreservationFile(absolute, 256 * 1024);
			if (!digest) return false;
			entries.push({ path: relativePath, size: digest.size, sha256: digest.sha256 });
			byteCount += digest.size;
		}
		return true;
	}
	if (!evidenceMissing && !(await walk(input.attempt.evidenceDirectory, ""))) return { kind: "unavailable", diagnostic: "Evidence inventory was unstable, symlinked, or exceeded bounded preservation limits." };
	const inventory = JSON.stringify(entries);
	return { kind: "inspected", assignment: assignmentObservation, report: report.kind === "present" ? { kind: "present", size: report.size, sha256: report.sha256 } : report.kind === "missing" ? { kind: "missing" } : { kind: "unavailable", diagnostic: report.diagnostic }, evidence: { directory: input.attempt.evidenceDirectory, count: entries.length, byteCount, sha256: `sha256:${createHash("sha256").update(inventory, "utf8").digest("hex")}`, entries } };
}

export function resolveRunJournalPaths(repositoryRoot: string, configDirName = CONFIG_DIR_NAME): RunJournalPaths {
	return pathsFor(repositoryRoot, configDirName);
}

export function createRunJournalStore(options: { configDirName?: string; migrations?: RunJournalMigrationRegistry } = {}): RunJournalStore {
	const configDirName = options.configDirName ?? CONFIG_DIR_NAME;
	const migrations = options.migrations;
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
			const active = await readJournalFile(paths.activePath);
			if (active.kind === "missing") return { kind: "missing", paths };
			if (active.kind === "unsafe") return { kind: "invalid", mode: "read-only", reason: "unsafe-snapshot", paths, diagnostics: active.diagnostics };
			if (active.kind === "newer") return { kind: "invalid", mode: "read-only", reason: "newer-schema", paths, diagnostics: active.diagnostics, active: active.snapshot.provenance };
			if (active.kind === "older") {
				const migration = migrationFromRegistry(migrations, active.schemaVersion);
				if (!migration) return { kind: "invalid", mode: "read-only", reason: "older-schema", paths, diagnostics: [...active.diagnostics, diag("invalid-run", `No exact Run Journal migration is registered for schemaVersion ${active.schemaVersion}; the active and previous snapshots remain unchanged.`, paths.activePath)], active: active.snapshot.provenance };
				const prepared = prepareMigration({ value: active.value, schemaVersion: active.schemaVersion, snapshot: active.snapshot }, migration, paths.activePath);
				if (prepared.kind === "failed") return { kind: "invalid", mode: "read-only", reason: "migration-failed", paths, diagnostics: prepared.diagnostics, active: active.snapshot.provenance };
				return { kind: "migration-ready", mode: "recovered", journal: prepared.journal, paths, active: active.snapshot.provenance, migration: prepared.migration };
			}
			if (active.kind === "invalid") {
				const previous = await readJournalFile(paths.previousPath);
				if (previous.kind === "loaded") return { kind: "recovered", mode: "recovered", journal: previous.journal, paths, active: active.snapshot.provenance, previous: previous.snapshot.provenance, diagnostics: active.diagnostics };
				const previousDiagnostics = previous.kind === "missing" ? [diag("invalid-run", "Previous Run Journal snapshot is missing; a corrupt active snapshot cannot be revived without it.", paths.previousPath)] : diagnosticsForJournalRead(previous);
				return {
					kind: "invalid",
					mode: "read-only",
					reason: previous.kind === "unsafe" ? "unsafe-snapshot" : "invalid-snapshots",
					paths,
					diagnostics: [...active.diagnostics, ...previousDiagnostics],
					active: active.snapshot.provenance,
					...(previous.kind === "invalid" || previous.kind === "newer" || previous.kind === "older" ? { previous: previous.snapshot.provenance } : {}),
				};
			}
			return { kind: "loaded", mode: "normal", journal: active.journal, paths, active: active.snapshot.provenance };
		} catch (error: unknown) {
			return { kind: "invalid", mode: "read-only", reason: "unsafe-snapshot", paths, diagnostics: storageDiagnostics(paths.activePath, error) };
		}
	}

	async function applyMigration(repositoryRoot: string, expected: Extract<ActiveRunLoadResult, { kind: "migration-ready" }>): Promise<ApplyRunJournalMigrationResult> {
		const paths = resolvePaths(repositoryRoot);
		if (expected.paths.activePath !== paths.activePath || expected.paths.previousPath !== paths.previousPath) return { kind: "stale", paths, diagnostics: [diag("invalid-run", "Migration basis belongs to a different Steward state directory.", paths.activePath)] };
		let published: PublishedExclusiveSnapshot | undefined;
		let activeRenamed = false;
		let temporaryPath: string | undefined;
		try {
			const active = await readJournalFile(paths.activePath);
			if (active.kind !== "older" || active.snapshot.provenance.sha256 !== expected.migration.rawActiveSha256 || active.schemaVersion !== expected.migration.fromVersion) return { kind: "stale", paths, diagnostics: [diag("invalid-run", "Active Run Journal changed before the registered migration could be applied; no snapshot was changed.", paths.activePath)] };
			const migration = migrationFromRegistry(migrations, active.schemaVersion);
			if (!migration || migration.id !== expected.migration.id) return { kind: "stale", paths, diagnostics: [diag("invalid-run", "The exact registered Run Journal migration is no longer available; no snapshot was changed.", paths.activePath)] };
			const prepared = prepareMigration({ value: active.value, schemaVersion: active.schemaVersion, snapshot: active.snapshot }, migration, paths.activePath);
			if (prepared.kind === "failed" || prepared.migration.migratedSha256 !== expected.migration.migratedSha256) return { kind: "stale", paths, diagnostics: prepared.kind === "failed" ? prepared.diagnostics : [diag("invalid-run", "Run Journal migration output was not deterministic; no snapshot was changed.", paths.activePath)] };
			try {
				await lstat(paths.previousPath);
				return { kind: "refused", paths, diagnostics: [diag("invalid-run", "Schema-only migration refuses to overwrite any existing previous snapshot.", paths.previousPath)] };
			} catch (error: unknown) {
				if (!missing(error)) return { kind: "storage-error", paths, diagnostics: storageDiagnostics(paths.previousPath, error) };
			}
			const activeBeforePublish = await readJournalFile(paths.activePath);
			if (activeBeforePublish.kind !== "older" || activeBeforePublish.snapshot.provenance.sha256 !== expected.migration.rawActiveSha256) return { kind: "stale", paths, diagnostics: [diag("invalid-run", "Active Run Journal changed before migration publication; no snapshot was changed.", paths.activePath)] };
			const publishedResult = await publishExclusiveSnapshot(paths.previousPath, activeBeforePublish.snapshot.text);
			if (publishedResult === "exists") return { kind: "refused", paths, diagnostics: [diag("invalid-run", "A previous snapshot appeared before schema-only migration publication; no snapshot was overwritten.", paths.previousPath)] };
			published = publishedResult;
			const activeAfterPublish = await readJournalFile(paths.activePath);
			if (activeAfterPublish.kind !== "older" || activeAfterPublish.snapshot.provenance.sha256 !== expected.migration.rawActiveSha256) return { kind: "stale", paths, diagnostics: [diag("invalid-run", "Active Run Journal changed during schema-only migration publication; snapshots were preserved.", paths.activePath)] };
			temporaryPath = await writePreparedTemporary(paths.stewardDirectory, ACTIVE_NAME, prepared.bytes, (bytes) => validateFileBytes(bytes, paths.activePath));
			const activeBeforeRename = await readJournalFile(paths.activePath);
			if (activeBeforeRename.kind !== "older" || activeBeforeRename.snapshot.provenance.sha256 !== expected.migration.rawActiveSha256) return { kind: "stale", paths, diagnostics: [diag("invalid-run", "Active Run Journal changed before schema-only migration commit; snapshots were preserved.", paths.activePath)] };
			await rename(temporaryPath, paths.activePath);
			temporaryPath = undefined;
			activeRenamed = true;
			await syncDirectory(paths.stewardDirectory);
			return { kind: "applied", journal: prepared.journal, paths, migration: prepared.migration };
		} catch (error: unknown) {
			return { kind: "storage-error", paths, diagnostics: storageDiagnostics(paths.activePath, error) };
		} finally {
			if (temporaryPath) await removeKnownTemporaryFile(temporaryPath).catch(() => undefined);
			if (published && !activeRenamed) await removePublishedSnapshot(paths.previousPath, published).catch(() => undefined);
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
			if (current.kind !== "missing") return { kind: "active-exists", paths };
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
		if (current.kind !== "loaded") return { kind: "invalid-current", paths, diagnostics: current.diagnostics };
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

	async function inspectAttemptReport(repositoryRoot: string, reportPath: string): Promise<AttemptReportInspection> {
		return inspectStableAttemptReport(repositoryRoot, reportPath, configDirName);
	}

	async function inspectAttemptAssignment(input: { repositoryRoot: string; attempt: AttemptRecord }): Promise<AttemptAssignmentInspection> {
		const root = resolve(resolveProjectStatePaths(input.repositoryRoot, configDirName).stewardDirectory);
		const path = input.attempt.assignmentPath;
		if (!isAbsolute(path) || path !== resolve(path) || !path.startsWith(`${root}/`) || !path.endsWith("/assignment.json")) return { kind: "unavailable", diagnostic: "Assignment path is not an exact Steward-owned path." };
		return inspectAssignmentBytes(path, 64 * 1024);
	}

	async function inspectAttemptPreservationFor(input: { repositoryRoot: string; attempt: AttemptRecord }): Promise<AttemptPreservationInspection> {
		return inspectAttemptPreservation(input, configDirName);
	}

	async function archiveRun(input: ArchiveCompletedRunRequest): Promise<ArchiveCompletedRunResult> {
		const paths = resolvePaths(input.repositoryRoot);
		const active = await readJournalFile(paths.activePath);
		const previous = await readJournalFile(paths.previousPath);
		if (active.kind !== "loaded" || previous.kind !== "loaded") {
			const completionPaths = resolveCompletionPaths(input.repositoryRoot, input.runId, configDirName);
			return { kind: "storage-error", paths: completionPaths, message: "Both active and previous Journal pointers must be loaded before archive publication.", deletedActive: false, deletedPrevious: false };
		}
		return archiveCompletedRun({ ...input, activeRunBytes: Buffer.from(active.bytes, "utf8"), previousRunBytes: Buffer.from(previous.bytes, "utf8"), configDirName });
	}

	async function archiveCancelled(input: ArchiveCancelledRunRequest): Promise<ArchiveCancelledRunResult> {
		const paths = resolvePaths(input.repositoryRoot);
		const active = await readJournalFile(paths.activePath);
		const previous = await readJournalFile(paths.previousPath);
		if (active.kind !== "loaded" || previous.kind !== "loaded") {
			const completionPaths = resolveCompletionPaths(input.repositoryRoot, input.runId, configDirName);
			return { kind: "storage-error", paths: completionPaths, message: "Both active and previous Journal pointers must be loaded before cancelled archive publication.", deletedActive: false, deletedPrevious: false };
		}
		return archiveCancelledRun({ ...input, activeRunBytes: Buffer.from(active.bytes, "utf8"), previousRunBytes: Buffer.from(previous.bytes, "utf8"), configDirName });
	}

	async function loadCompletionJournalPointers(repositoryRoot: string): Promise<{ kind: "loaded"; pointers: CompletionJournalPointers } | { kind: "unavailable"; message: string }> {
		const paths = resolvePaths(repositoryRoot);
		try {
			const active = await readJournalFile(paths.activePath);
			const previous = await readJournalFile(paths.previousPath);
			if (active.kind !== "loaded" || previous.kind !== "loaded") return { kind: "unavailable", message: "Active and previous Journal pointers must both be valid regular Journals." };
			return { kind: "loaded", pointers: { activePath: paths.activePath, previousPath: paths.previousPath, activeBytes: Buffer.from(active.bytes, "utf8"), previousBytes: Buffer.from(previous.bytes, "utf8") } };
		} catch (error: unknown) {
			return { kind: "unavailable", message: filesystemErrorText(error) };
		}
	}

	return {
		resolvePaths,
		probeActive,
		loadActive,
		applyMigration,
		createActive,
		replaceActive,
		appendActivity,
		inspectAttemptReport,
		inspectAttemptAssignment,
		inspectAttemptPreservation: inspectAttemptPreservationFor,
		resolveAssignmentPaths: (repositoryRoot, runId, taskId, attemptId) => resolveAssignmentPaths(repositoryRoot, runId, taskId, attemptId, configDirName),
		createAssignment: assignmentStore.createAssignment,
		loadBuilderEvidenceInputs: evidenceStore.loadBuilderEvidenceInputs,
		loadReviewerEvidenceInputs: evidenceStore.loadReviewerEvidenceInputs,
		loadFinalizedEvidenceManifest: evidenceStore.loadFinalizedEvidenceManifest,
		inspectReferencedEvidence: evidenceStore.inspectReferencedEvidence,
		inspectReferencedReviewerEvidence: evidenceStore.inspectReferencedReviewerEvidence,
		finalizeBuilderEvidence: evidenceStore.finalizeBuilderEvidence,
		finalizeReviewerEvidence: evidenceStore.finalizeReviewerEvidence,
		resolveCompletionPaths: (repositoryRoot, runId, configDirNameOrAttempt, attemptId) => resolveCompletionPaths(repositoryRoot, runId, configDirNameOrAttempt ?? configDirName, attemptId),
		finalizeVerificationResult,
		inspectFinalVerificationResult: (input) => inspectFinalVerificationResult({ ...input, configDirName }),
		archiveCompletedRun: archiveRun,
		archiveCancelledRun: archiveCancelled,
		listTerminalArchives: (repositoryRoot) => listTerminalArchives(repositoryRoot, configDirName),
		loadCompletionJournalPointers,
	};
}

function requireLstat(path: string): boolean {
	// probeActive is intentionally synchronous to preserve the ticket-01 status seam.
	return Boolean(lstatSync(path));
}
