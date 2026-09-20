import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import {
	createOwnedTemporaryDirectory,
	ensureProjectStateDirectory,
	ensureOwnedDirectory,
	removeKnownTemporaryDirectory,
	resolveProjectStatePaths,
	syncDirectory,
	syncFile,
} from "./project-state.ts";
import { deserializeRunJournal, serializeRunJournalAtPath, validateRunJournal, type CompletionAgentRole, type FinalVerificationAttemptId, type RunJournal } from "./run.ts";

export const MAX_VERIFICATION_OUTPUT_BYTES = 16 * 1024 * 1024;
export const COMPLETION_OUTPUT_VERSION = "steward-verification-output-v1" as const;

export interface CompletionPaths {
	runDirectory: string;
	verificationDirectory: string;
	verificationLogPath: string;
	verificationResultPath: string;
	runtimeDirectory: string;
	descriptorPath: string;
	stdoutPath: string;
	stderrPath: string;
	candidateResultPath: string;
	archiveDirectory: string;
	archiveRunPath: string;
	archivePreviousRunPath: string;
	archiveManifestPath: string;
	archiveReportsDirectory: string;
}

export interface CompletionJournalPointers {
	activePath: string;
	previousPath: string;
	activeBytes: Buffer;
	previousBytes: Buffer;
}

export interface VerificationEvidenceInput {
	repositoryRoot: string;
	runId: string;
	command: string;
	cwd: string;
	startedAt: string;
	completedAt: string;
	exitCode: number;
	killed: false;
	stdout: string | Buffer;
	stderr: string | Buffer;
	configDirName?: string;
	attemptId?: FinalVerificationAttemptId;
}

export interface FinalizedVerificationResult {
	schemaVersion: 1;
	command: string;
	cwd: string;
	startedAt: string;
	completedAt: string;
	exitCode: number;
	killed: false;
	stdoutBytes: number;
	stderrBytes: number;
	stdoutSha256: string;
	stderrSha256: string;
	logSha256: string;
	logPath: string;
}

export type VerificationFinalizeResult =
	| { kind: "created" | "existing-match"; paths: CompletionPaths; logSha256: string; resultSha256: string; result: FinalizedVerificationResult }
	| { kind: "conflict" | "storage-error"; paths: CompletionPaths; message: string };

export type FinalVerificationResultInspection =
	| { kind: "complete"; source: "canonical" | "candidate"; paths: CompletionPaths; result: FinalizedVerificationResult; resultBytes: Buffer; logSha256: string; resultSha256: string; evidence?: VerificationEvidenceInput }
	| { kind: "partial" | "missing" | "invalid" | "unavailable"; paths: CompletionPaths; message: string };

export interface CompletionReportSource {
	taskId: string;
	attemptId: string;
	role: CompletionAgentRole;
	sourcePath: string;
	destinationPath: string;
	size: number;
	sha256: string;
}

export interface ArchiveVerificationPointer {
	logPath: string;
	resultPath: string;
	logSha256: string;
	resultSha256: string;
}

export interface ArchiveCompletedRunInput {
	repositoryRoot: string;
	runId: string;
	run: RunJournal;
	previousRunBytes: Buffer | string;
	activeRunBytes: Buffer | string;
	archivedAt: string;
	verification: ArchiveVerificationPointer;
	reports: readonly CompletionReportSource[];
	configDirName?: string;
}

export type ArchiveCompletedRunRequest = Omit<ArchiveCompletedRunInput, "activeRunBytes" | "previousRunBytes">;

export type ArchiveCompletedRunResult =
	| { kind: "published" | "existing-match"; paths: CompletionPaths; manifestBytes: Buffer; deletedActive: true; deletedPrevious: true }
	| { kind: "conflict" | "race" | "storage-error"; paths: CompletionPaths; message: string; deletedActive: false; deletedPrevious: false };

interface ArchiveManifest {
	schemaVersion: 1;
	runId: string;
	activeRunSha256: string;
	previousRunSha256: string;
	archivedAt: string;
	verification: ArchiveVerificationPointer;
	reports: CompletionReportSource[];
}

function hash(bytes: Buffer): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function errorText(error: unknown): string {
	return error instanceof Error && error.message.length > 0 ? error.message : "Completion storage failed.";
}

function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function exists(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function safeAbsolute(path: string): boolean {
	return isAbsolute(path) && path === resolve(path) && !path.includes("\u0000") && !path.includes("\\");
}

function safeIdentifier(value: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function contained(root: string, path: string): boolean {
	if (!safeAbsolute(root) || !safeAbsolute(path)) return false;
	const prefix = root.endsWith("/") ? root : `${root}/`;
	return path.startsWith(prefix) && path !== prefix && !path.includes("/../") && !path.endsWith("/..");
}

function canonicalTimestamp(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value;
}

function buffer(value: string | Buffer): Buffer {
	return Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, "utf8");
}

function outputLog(stdout: Buffer, stderr: Buffer): Buffer {
	const header = Buffer.from(`${COMPLETION_OUTPUT_VERSION}\nstdout-bytes:${stdout.length}\nstderr-bytes:${stderr.length}\n\n`, "utf8");
	return Buffer.concat([header, stdout, stderr]);
}

export function decodeVerificationOutput(bytes: Buffer): { stdout: Buffer; stderr: Buffer } | undefined {
	const marker = Buffer.from(`${COMPLETION_OUTPUT_VERSION}\nstdout-bytes:`, "utf8");
	if (!bytes.subarray(0, marker.length).equals(marker)) return undefined;
	const headerEnd = bytes.indexOf(Buffer.from("\n\n", "utf8"), marker.length);
	if (headerEnd < 0) return undefined;
	const header = bytes.subarray(0, headerEnd).toString("utf8").split("\n");
	if (header.length !== 3 || !header[1]?.startsWith("stdout-bytes:") || !header[2]?.startsWith("stderr-bytes:")) return undefined;
	const stdoutBytes = Number(header[1].slice("stdout-bytes:".length));
	const stderrBytes = Number(header[2].slice("stderr-bytes:".length));
	if (!Number.isSafeInteger(stdoutBytes) || !Number.isSafeInteger(stderrBytes) || stdoutBytes < 0 || stderrBytes < 0 || stdoutBytes > MAX_VERIFICATION_OUTPUT_BYTES || stderrBytes > MAX_VERIFICATION_OUTPUT_BYTES || stdoutBytes + stderrBytes > MAX_VERIFICATION_OUTPUT_BYTES * 2) return undefined;
	const content = bytes.subarray(headerEnd + 2);
	if (content.length !== stdoutBytes + stderrBytes) return undefined;
	return { stdout: Buffer.from(content.subarray(0, stdoutBytes)), stderr: Buffer.from(content.subarray(stdoutBytes)) };
}

export function resolveCompletionPaths(repositoryRoot: string, runId: string, configDirNameOrAttempt = CONFIG_DIR_NAME, requestedAttemptId: FinalVerificationAttemptId = "verification-01"): CompletionPaths {
	if (!safeAbsolute(repositoryRoot) || !safeIdentifier(runId) || !runId.startsWith("run-")) throw new Error("Completion paths require an absolute repository root and safe Run id.");
	const isAttempt = configDirNameOrAttempt === "verification-01" || configDirNameOrAttempt === "verification-02";
	const configDirName = isAttempt ? CONFIG_DIR_NAME : configDirNameOrAttempt;
	const attemptId = isAttempt ? configDirNameOrAttempt as FinalVerificationAttemptId : requestedAttemptId;
	const state = resolveProjectStatePaths(repositoryRoot, configDirName);
	const runDirectory = join(state.stewardDirectory, "runs", runId);
	const verificationDirectory = join(runDirectory, "completion", "final-verification", attemptId);
	const runtimeDirectory = join(verificationDirectory, "runtime");
	const archiveDirectory = join(state.stewardDirectory, "archives", runId);
	return {
		runDirectory,
		verificationDirectory,
		verificationLogPath: join(verificationDirectory, "output.log"),
		verificationResultPath: join(verificationDirectory, "result.json"),
		runtimeDirectory,
		descriptorPath: join(runtimeDirectory, "descriptor.json"),
		stdoutPath: join(runtimeDirectory, "stdout"),
		stderrPath: join(runtimeDirectory, "stderr"),
		candidateResultPath: join(runtimeDirectory, "candidate-result.json"),
		archiveDirectory,
		archiveRunPath: join(archiveDirectory, "run.json"),
		archivePreviousRunPath: join(archiveDirectory, "previous-run.json"),
		archiveManifestPath: join(archiveDirectory, "manifest.json"),
		archiveReportsDirectory: join(archiveDirectory, "reports"),
	};
}

async function regularFile(path: string): Promise<boolean> {
	try {
		const info = await lstat(path);
		return info.isFile() && !info.isSymbolicLink();
	} catch (error: unknown) {
		if (missing(error)) return false;
		throw error;
	}
}

async function stableFile(path: string, maximum: number): Promise<{ bytes: Buffer; size: number; sha256: string } | undefined> {
	let before: Awaited<ReturnType<typeof lstat>>;
	try {
		before = await lstat(path);
	} catch (error: unknown) {
		if (missing(error)) return undefined;
		throw error;
	}
	if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) throw new Error(`Completion source is not a bounded regular file: ${path}`);
	const bytes = await readFile(path);
	const after = await lstat(path);
	if (!after.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.size !== before.size || bytes.length !== before.size) throw new Error(`Completion source changed while being read: ${path}`);
	return { bytes, size: bytes.length, sha256: hash(bytes) };
}

async function writeImmutableFile(path: string, bytes: Buffer): Promise<void> {
	const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await chmod(path, 0o400).catch(() => undefined);
}

async function compareFile(path: string, expected: Buffer): Promise<boolean> {
	const value = await stableFile(path, Math.max(MAX_VERIFICATION_OUTPUT_BYTES * 2, expected.length));
	return Boolean(value && value.size === expected.length && value.sha256 === hash(expected) && value.bytes.equals(expected));
}

async function listFiles(root: string): Promise<string[]> {
	const result: string[] = [];
	async function visit(directory: string, prefix: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const next = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(join(directory, entry.name), next);
			else if (entry.isFile() && !entry.isSymbolicLink()) result.push(next);
			else throw new Error(`Archive contains an unsafe entry: ${next}`);
		}
	}
	await visit(root, "");
	return result.sort();
}

function canonicalResult(input: VerificationEvidenceInput, paths: CompletionPaths, log: Buffer): { result: FinalizedVerificationResult; resultBytes: Buffer; logSha256: string } {
	const stdout = buffer(input.stdout);
	const stderr = buffer(input.stderr);
	if (stdout.length > MAX_VERIFICATION_OUTPUT_BYTES || stderr.length > MAX_VERIFICATION_OUTPUT_BYTES) throw new Error("Verification output exceeds the immutable bounded limit.");
	if (!input.command || input.command !== input.command.trim() || !safeAbsolute(resolve(input.cwd)) || !canonicalTimestamp(input.startedAt) || !canonicalTimestamp(input.completedAt) || !Number.isSafeInteger(input.exitCode) || input.killed !== false) throw new Error("Verification result contains invalid exact fields.");
	const logSha256 = hash(log);
	const result: FinalizedVerificationResult = {
		schemaVersion: 1,
		command: input.command,
		cwd: input.cwd,
		startedAt: input.startedAt,
		completedAt: input.completedAt,
		exitCode: input.exitCode,
		killed: false,
		stdoutBytes: stdout.length,
		stderrBytes: stderr.length,
		stdoutSha256: hash(stdout),
		stderrSha256: hash(stderr),
		logSha256,
		logPath: paths.verificationLogPath,
	};
	return { result, resultBytes: Buffer.from(`${JSON.stringify(result, null, 2)}\n`, "utf8"), logSha256 };
}

export async function finalizeVerificationResult(input: VerificationEvidenceInput): Promise<VerificationFinalizeResult> {
	const paths = resolveCompletionPaths(input.repositoryRoot, input.runId, input.configDirName, input.attemptId);
	try {
		if (!contained(paths.runDirectory, paths.verificationDirectory) || !contained(paths.runDirectory, paths.verificationLogPath) || !contained(paths.runDirectory, paths.verificationResultPath)) return { kind: "storage-error", paths, message: "Verification paths escaped the Run directory." };
		const log = outputLog(buffer(input.stdout), buffer(input.stderr));
		const canonical = canonicalResult(input, paths, log);
		const existingDirectory = await lstat(paths.verificationDirectory).catch((error: unknown) => (missing(error) ? undefined : Promise.reject(error)));
		if (existingDirectory) {
			if (!existingDirectory.isDirectory() || existingDirectory.isSymbolicLink()) return { kind: "conflict", paths, message: "Verification directory is not a regular immutable directory." };
			const existingLog = await stableFile(paths.verificationLogPath, MAX_VERIFICATION_OUTPUT_BYTES * 2);
			const existingResult = await stableFile(paths.verificationResultPath, MAX_VERIFICATION_OUTPUT_BYTES * 2);
			if (existingLog || existingResult) {
				if (!existingLog || !existingResult || existingLog.sha256 !== canonical.logSha256 || !existingLog.bytes.equals(log) || existingResult.sha256 !== hash(canonical.resultBytes) || !existingResult.bytes.equals(canonical.resultBytes)) return { kind: "conflict", paths, message: "Existing verification evidence differs; no bytes were overwritten." };
				return { kind: "existing-match", paths, logSha256: canonical.logSha256, resultSha256: hash(canonical.resultBytes), result: canonical.result };
			}
			try {
				await writeImmutableFile(paths.verificationLogPath, log);
				await writeImmutableFile(paths.verificationResultPath, canonical.resultBytes);
				await syncDirectory(paths.verificationDirectory);
				return { kind: "created", paths, logSha256: canonical.logSha256, resultSha256: hash(canonical.resultBytes), result: canonical.result };
			} catch (error: unknown) {
				if (exists(error)) {
					const racedLog = await stableFile(paths.verificationLogPath, MAX_VERIFICATION_OUTPUT_BYTES * 2);
					const racedResult = await stableFile(paths.verificationResultPath, MAX_VERIFICATION_OUTPUT_BYTES * 2);
					if (racedLog && racedResult && racedLog.sha256 === canonical.logSha256 && racedLog.bytes.equals(log) && racedResult.sha256 === hash(canonical.resultBytes) && racedResult.bytes.equals(canonical.resultBytes)) return { kind: "existing-match", paths, logSha256: canonical.logSha256, resultSha256: hash(canonical.resultBytes), result: canonical.result };
				}
				return { kind: "conflict", paths, message: "Existing verification evidence differs; no bytes were overwritten." };
			}
		}
		const state = await ensureProjectStateDirectory(input.repositoryRoot, input.configDirName);
		await ensureOwnedDirectory(join(state.stewardDirectory, "runs"));
		await ensureOwnedDirectory(paths.runDirectory);
		await ensureOwnedDirectory(join(paths.runDirectory, "completion"));
		await ensureOwnedDirectory(join(paths.runDirectory, "completion", "final-verification"));
		const temporary = await createOwnedTemporaryDirectory(dirname(paths.verificationDirectory), "verification");
		try {
			await writeImmutableFile(join(temporary, "output.log"), log);
			await writeImmutableFile(join(temporary, "result.json"), canonical.resultBytes);
			await chmod(temporary, 0o500).catch(() => undefined);
			await syncDirectory(temporary);
			try {
				await rename(temporary, paths.verificationDirectory);
			} catch (error: unknown) {
				if (!exists(error)) throw error;
				const files = await listFiles(paths.verificationDirectory);
				if (files.length !== 2 || !(await compareFile(paths.verificationLogPath, log)) || !(await compareFile(paths.verificationResultPath, canonical.resultBytes))) return { kind: "conflict", paths, message: "Verification publication raced with different bytes; no bytes were overwritten." };
				return { kind: "existing-match", paths, logSha256: canonical.logSha256, resultSha256: hash(canonical.resultBytes), result: canonical.result };
			}
			await syncDirectory(dirname(paths.verificationDirectory));
			return { kind: "created", paths, logSha256: canonical.logSha256, resultSha256: hash(canonical.resultBytes), result: canonical.result };
		} finally {
			await removeKnownTemporaryDirectory(temporary).catch(() => undefined);
		}
	} catch (error: unknown) {
		return { kind: "storage-error", paths, message: errorText(error).slice(0, 2_000) };
	}
}

function exactResult(value: unknown, paths: CompletionPaths, command: string, cwd: string, log: { bytes: Buffer; sha256: string }, result: { bytes: Buffer; sha256: string }): FinalizedVerificationResult | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const keys = ["schemaVersion", "command", "cwd", "startedAt", "completedAt", "exitCode", "killed", "stdoutBytes", "stderrBytes", "stdoutSha256", "stderrSha256", "logSha256", "logPath"];
	if (Object.keys(raw).sort().join("\0") !== keys.sort().join("\0") || raw.schemaVersion !== 1 || raw.command !== command || raw.cwd !== cwd || typeof raw.startedAt !== "string" || !canonicalTimestamp(raw.startedAt) || typeof raw.completedAt !== "string" || !canonicalTimestamp(raw.completedAt) || raw.completedAt < raw.startedAt || typeof raw.exitCode !== "number" || !Number.isSafeInteger(raw.exitCode) || raw.killed !== false || typeof raw.stdoutBytes !== "number" || !Number.isSafeInteger(raw.stdoutBytes) || typeof raw.stderrBytes !== "number" || !Number.isSafeInteger(raw.stderrBytes) || typeof raw.stdoutSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(raw.stdoutSha256) || typeof raw.stderrSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(raw.stderrSha256) || raw.logSha256 !== log.sha256 || raw.logPath !== paths.verificationLogPath || raw.stdoutBytes < 0 || raw.stderrBytes < 0 || raw.stdoutBytes > MAX_VERIFICATION_OUTPUT_BYTES || raw.stderrBytes > MAX_VERIFICATION_OUTPUT_BYTES) return undefined;
	return { schemaVersion: 1, command, cwd, startedAt: raw.startedAt, completedAt: raw.completedAt, exitCode: raw.exitCode, killed: false, stdoutBytes: raw.stdoutBytes, stderrBytes: raw.stderrBytes, stdoutSha256: raw.stdoutSha256, stderrSha256: raw.stderrSha256, logSha256: log.sha256, logPath: paths.verificationLogPath };
}

export async function inspectFinalVerificationResult(input: { repositoryRoot: string; runId: string; command: string; cwd: string; attemptId: FinalVerificationAttemptId; executionNonce?: string; argvSha256?: string; configDirName?: string }): Promise<FinalVerificationResultInspection> {
	const paths = resolveCompletionPaths(input.repositoryRoot, input.runId, input.configDirName, input.attemptId);
	try {
		if (!contained(paths.runDirectory, paths.verificationDirectory) || !contained(paths.runDirectory, paths.runtimeDirectory) || !contained(paths.runDirectory, paths.verificationLogPath) || !contained(paths.runDirectory, paths.verificationResultPath) || !contained(paths.runDirectory, paths.candidateResultPath)) return { kind: "invalid", paths, message: "Verification inspection paths escaped the Run directory." };
		const canonicalLog = await stableFile(paths.verificationLogPath, MAX_VERIFICATION_OUTPUT_BYTES * 2);
		const canonicalResultBytes = await stableFile(paths.verificationResultPath, MAX_VERIFICATION_OUTPUT_BYTES * 2);
		if (canonicalLog && canonicalResultBytes) {
			const decoded = decodeVerificationOutput(canonicalLog.bytes);
			if (!decoded) return { kind: "invalid", paths, message: "Canonical verification log has invalid channel framing." };
			const parsed = (() => { try { return JSON.parse(canonicalResultBytes.bytes.toString("utf8")) as unknown; } catch { return undefined; } })();
			const result = exactResult(parsed, paths, input.command, input.cwd, canonicalLog, canonicalResultBytes);
			if (!result || result.stdoutBytes !== decoded.stdout.length || result.stderrBytes !== decoded.stderr.length || result.stdoutSha256 !== hash(decoded.stdout) || result.stderrSha256 !== hash(decoded.stderr)) return { kind: "invalid", paths, message: "Canonical verification result has invalid exact fields or channel hashes." };
			return { kind: "complete", source: "canonical", paths, result, resultBytes: canonicalResultBytes.bytes, logSha256: canonicalLog.sha256, resultSha256: canonicalResultBytes.sha256 };
		}
		const candidateBytes = await stableFile(paths.candidateResultPath, MAX_VERIFICATION_OUTPUT_BYTES * 2);
		const stdout = await stableFile(paths.stdoutPath, MAX_VERIFICATION_OUTPUT_BYTES);
		const stderr = await stableFile(paths.stderrPath, MAX_VERIFICATION_OUTPUT_BYTES);
		const descriptor = await stableFile(paths.descriptorPath, 64 * 1024);
		const anyCanonical = Boolean(canonicalLog || canonicalResultBytes);
		if (!candidateBytes && !stdout && !stderr && !descriptor) return { kind: anyCanonical ? "partial" : "missing", paths, message: anyCanonical ? "Canonical verification evidence is partial." : "No complete verification evidence exists." };
		if (!candidateBytes || !stdout || !stderr || !descriptor) return { kind: "partial", paths, message: "Managed verification candidate is incomplete." };
		let candidate: Record<string, unknown>;
		let descriptorValue: Record<string, unknown>;
		try {
			const parsed = JSON.parse(candidateBytes.bytes.toString("utf8")) as unknown;
			const parsedDescriptor = JSON.parse(descriptor.bytes.toString("utf8")) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !parsedDescriptor || typeof parsedDescriptor !== "object" || Array.isArray(parsedDescriptor)) return { kind: "invalid", paths, message: "Managed verification candidate JSON is not an object." };
			candidate = parsed as Record<string, unknown>;
			descriptorValue = parsedDescriptor as Record<string, unknown>;
		} catch {
			return { kind: "invalid", paths, message: "Managed verification candidate JSON is malformed." };
		}
		const candidateKeys = ["schemaVersion", "attemptId", "executionNonce", "command", "cwd", "startedAt", "completedAt", "exitCode", "killed", "stdoutBytes", "stderrBytes", "stdoutSha256", "stderrSha256", "logSha256", "argvSha256"];
		if (Object.keys(candidate).sort().join("\0") !== candidateKeys.sort().join("\0") || candidate.schemaVersion !== 1 || candidate.attemptId !== input.attemptId || (input.executionNonce !== undefined && candidate.executionNonce !== input.executionNonce) || candidate.command !== input.command || candidate.cwd !== input.cwd || typeof candidate.startedAt !== "string" || !canonicalTimestamp(candidate.startedAt) || typeof candidate.completedAt !== "string" || !canonicalTimestamp(candidate.completedAt) || candidate.completedAt < candidate.startedAt || typeof candidate.exitCode !== "number" || !Number.isSafeInteger(candidate.exitCode) || candidate.killed !== false || candidate.stdoutBytes !== stdout.size || candidate.stderrBytes !== stderr.size || candidate.stdoutBytes > MAX_VERIFICATION_OUTPUT_BYTES || candidate.stderrBytes > MAX_VERIFICATION_OUTPUT_BYTES || candidate.stdoutSha256 !== stdout.sha256 || candidate.stderrSha256 !== stderr.sha256 || candidate.logSha256 !== hash(outputLog(stdout.bytes, stderr.bytes)) || typeof candidate.argvSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(candidate.argvSha256) || (input.argvSha256 !== undefined && candidate.argvSha256 !== input.argvSha256) || Object.keys(descriptorValue).sort().join("\0") !== ["schemaVersion", "attemptId", "executionNonce", "command", "cwd", "pid", "startedAt"].sort().join("\0") || descriptorValue.schemaVersion !== 1 || descriptorValue.attemptId !== input.attemptId || descriptorValue.executionNonce !== candidate.executionNonce || descriptorValue.command !== input.command || descriptorValue.cwd !== input.cwd || typeof descriptorValue.pid !== "number" || !Number.isSafeInteger(descriptorValue.pid) || descriptorValue.pid <= 0 || descriptorValue.startedAt !== candidate.startedAt) return { kind: "invalid", paths, message: "Managed verification candidate identity or hashes are invalid." };
		const evidence: VerificationEvidenceInput = { repositoryRoot: input.repositoryRoot, runId: input.runId, command: input.command, cwd: input.cwd, startedAt: candidate.startedAt, completedAt: candidate.completedAt, exitCode: candidate.exitCode, killed: false, stdout: stdout.bytes, stderr: stderr.bytes, configDirName: input.configDirName, attemptId: input.attemptId };
		const log = outputLog(stdout.bytes, stderr.bytes);
		const canonical = canonicalResult(evidence, paths, log);
		return { kind: "complete", source: "candidate", paths, result: canonical.result, resultBytes: canonical.resultBytes, logSha256: canonical.logSha256, resultSha256: hash(canonical.resultBytes), evidence };
	} catch (error: unknown) {
		return { kind: "unavailable", paths, message: errorText(error).slice(0, 2_000) };
	}
}

function archiveManifest(input: ArchiveCompletedRunInput, paths: CompletionPaths, active: Buffer, previous: Buffer): { value: ArchiveManifest; bytes: Buffer } {
	const reports = input.reports.map((report) => ({ ...report }));
	const value: ArchiveManifest = {
		schemaVersion: 1,
		runId: input.runId,
		activeRunSha256: hash(active),
		previousRunSha256: hash(previous),
		archivedAt: input.archivedAt,
		verification: { ...input.verification },
		reports,
	};
	return { value, bytes: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8") };
}

function expectedArchiveFiles(paths: CompletionPaths, runBytes: Buffer, previousBytes: Buffer, manifestBytes: Buffer, reports: readonly CompletionReportSource[], reportBytes: readonly Buffer[]): Map<string, Buffer> {
	const expected = new Map<string, Buffer>([["run.json", runBytes], ["previous-run.json", previousBytes], ["manifest.json", manifestBytes]]);
	for (let index = 0; index < reports.length; index += 1) {
		const destination = reports[index]?.destinationPath;
		if (destination) expected.set(destination, reportBytes[index]!);
	}
	return expected;
}

async function compareArchive(directory: string, expected: Map<string, Buffer>): Promise<boolean> {
	const actual = await listFiles(directory);
	const paths = [...expected.keys()].sort();
	if (JSON.stringify(actual) !== JSON.stringify(paths)) return false;
	for (const [path, bytes] of expected) if (!(await compareFile(join(directory, path), bytes))) return false;
	return true;
}

function reportDestination(paths: CompletionPaths, report: CompletionReportSource): string {
	if (!safeIdentifier(report.taskId) || !safeIdentifier(report.attemptId) || (report.role !== "builder" && report.role !== "reviewer") || !safeAbsolute(report.sourcePath) || !report.destinationPath || isAbsolute(report.destinationPath) || report.destinationPath.includes("\\") || report.destinationPath.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error("Archive report inventory contains an unsafe identity or path.");
	const expected = `reports/${report.taskId}/${report.attemptId}-${report.role}.md`;
	if (report.destinationPath !== expected) throw new Error("Archive report destination is not deterministic.");
	const full = join(paths.archiveDirectory, report.destinationPath);
	if (!contained(paths.archiveDirectory, full)) throw new Error("Archive report destination escaped the archive.");
	return full;
}

async function loadReports(paths: CompletionPaths, reports: readonly CompletionReportSource[]): Promise<Buffer[]> {
	const bytes: Buffer[] = [];
	const identities = new Set<string>();
	for (const report of reports) {
		const identity = `${report.taskId}/${report.attemptId}/${report.role}`;
		if (identities.has(identity) || !Number.isSafeInteger(report.size) || report.size < 0 || !/^sha256:[0-9a-f]{64}$/.test(report.sha256)) throw new Error("Archive report inventory is duplicated or has invalid size/hash.");
		identities.add(identity);
		reportDestination(paths, report);
		if (!contained(paths.runDirectory, report.sourcePath)) throw new Error(`Protected report source escaped the Steward Run directory: ${report.sourcePath}`);
		const loaded = await stableFile(report.sourcePath, MAX_VERIFICATION_OUTPUT_BYTES);
		if (!loaded || loaded.size !== report.size || loaded.sha256 !== report.sha256) throw new Error(`Protected report changed or is missing: ${report.sourcePath}`);
		bytes.push(loaded.bytes);
	}
	if (reports.length === 0) throw new Error("Archive report inventory cannot be empty.");
	return bytes;
}

async function reportsUnchanged(paths: CompletionPaths, reports: readonly CompletionReportSource[], expected: readonly Buffer[]): Promise<boolean> {
	for (let index = 0; index < reports.length; index += 1) {
		const report = reports[index]!;
		if (!contained(paths.runDirectory, report.sourcePath)) return false;
		const current = await stableFile(report.sourcePath, MAX_VERIFICATION_OUTPUT_BYTES);
		if (!current || current.size !== report.size || current.sha256 !== report.sha256 || !current.bytes.equals(expected[index]!)) return false;
	}
	return true;
}

function sameReportInventory(left: readonly CompletionReportSource[], right: readonly CompletionReportSource[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		const a = left[index]!;
		const b = right[index]!;
		if (a.taskId !== b.taskId || a.attemptId !== b.attemptId || a.role !== b.role || a.sourcePath !== b.sourcePath || a.destinationPath !== b.destinationPath || a.size !== b.size || a.sha256 !== b.sha256) return false;
	}
	return true;
}

function validateArchiveInput(input: ArchiveCompletedRunInput, paths: CompletionPaths, active: Buffer, previous: Buffer): string | undefined {
	if (input.run.run.id !== input.runId) return "Archive Run identity does not match the requested Run id.";
	const completion = input.run.run.completion;
	if (!completion || completion.phase !== "archived") return "Archive Run snapshot does not contain archived completion state.";
	const archive = completion.archive;
	if (archive.archiveDirectory !== paths.archiveDirectory || archive.runPath !== paths.archiveRunPath || archive.previousRunPath !== paths.archivePreviousRunPath || archive.manifestPath !== paths.archiveManifestPath) return "Archive paths are not the deterministic Run archive paths.";
	if (archive.activeJournalSha256 !== hash(active) || archive.previousJournalSha256 !== hash(previous)) return "Archive journal hashes do not match the live pointer bytes.";
	if (archive.verification.logPath !== input.verification.logPath || archive.verification.resultPath !== input.verification.resultPath || archive.verification.logSha256 !== input.verification.logSha256 || archive.verification.resultSha256 !== input.verification.resultSha256) return "Archive verification pointers do not match the durable verification result.";
	if (!sameReportInventory(archive.reports, input.reports)) return "Archive report inventory does not match the protected report inputs.";
	if (completion.archivedAt !== input.archivedAt || archive.intendedAt > completion.archivedAt) return "Archive timestamps are not ordered or do not match the archived snapshot.";
	if (input.verification.logPath !== paths.verificationLogPath || input.verification.resultPath !== paths.verificationResultPath || !contained(paths.runDirectory, input.verification.logPath) || !contained(paths.runDirectory, input.verification.resultPath)) return "Verification pointers escaped the deterministic Run completion directory.";
	return undefined;
}

async function verifyVerificationEvidence(paths: CompletionPaths, verification: ArchiveVerificationPointer, run: RunJournal): Promise<void> {
	if (verification.logPath !== paths.verificationLogPath || verification.resultPath !== paths.verificationResultPath || !contained(paths.runDirectory, verification.logPath) || !contained(paths.runDirectory, verification.resultPath)) throw new Error("Verification pointers escaped the deterministic Run completion directory.");
	const log = await stableFile(verification.logPath, MAX_VERIFICATION_OUTPUT_BYTES * 2);
	const result = await stableFile(verification.resultPath, MAX_VERIFICATION_OUTPUT_BYTES * 2);
	if (!log || log.sha256 !== verification.logSha256 || !result || result.sha256 !== verification.resultSha256) throw new Error("Durable verification evidence is missing or changed.");
	const decoded = decodeVerificationOutput(log.bytes);
	let parsed: unknown;
	try { parsed = JSON.parse(result.bytes.toString("utf8")); } catch { throw new Error("Durable verification result is not canonical JSON."); }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Durable verification result is not an object.");
	const value = parsed as Record<string, unknown>;
	const expectedKeys = ["schemaVersion", "command", "cwd", "startedAt", "completedAt", "exitCode", "killed", "stdoutBytes", "stderrBytes", "stdoutSha256", "stderrSha256", "logSha256", "logPath"];
	if (Object.keys(value).sort().join("\0") !== expectedKeys.sort().join("\0") || value.schemaVersion !== 1 || !decoded || value.logSha256 !== log.sha256 || value.logPath !== paths.verificationLogPath || value.command !== (run.run.finalVerification.kind === "command" ? run.run.finalVerification.command : "") || value.cwd !== run.run.finalVerificationExecution?.cwd || typeof value.startedAt !== "string" || !canonicalTimestamp(value.startedAt) || typeof value.completedAt !== "string" || !canonicalTimestamp(value.completedAt) || value.completedAt < value.startedAt || value.killed !== false || value.exitCode !== 0 || value.stdoutBytes !== decoded.stdout.length || value.stderrBytes !== decoded.stderr.length || value.stdoutSha256 !== hash(decoded.stdout) || value.stderrSha256 !== hash(decoded.stderr) || typeof value.stdoutSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.stdoutSha256) || typeof value.stderrSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.stderrSha256)) throw new Error("Durable verification result has invalid exact fields or channel hashes.");
}

async function deleteMatchingPointers(paths: CompletionPaths, active: Buffer, previous: Buffer): Promise<"deleted" | "race"> {
	const activeCurrent = await readFile(join(dirname(paths.archiveDirectory), "..", "active-run.json")).catch((error: unknown) => (missing(error) ? undefined : Promise.reject(error)));
	const previousCurrent = await readFile(join(dirname(paths.archiveDirectory), "..", "active-run.previous.json")).catch((error: unknown) => (missing(error) ? undefined : Promise.reject(error)));
	if (!activeCurrent || !previousCurrent || !activeCurrent.equals(active) || !previousCurrent.equals(previous)) return "race";
	await unlink(join(dirname(paths.archiveDirectory), "..", "active-run.json"));
	await unlink(join(dirname(paths.archiveDirectory), "..", "active-run.previous.json"));
	await syncDirectory(join(dirname(paths.archiveDirectory), ".."));
	return "deleted";
}

export async function archiveCompletedRun(input: ArchiveCompletedRunInput): Promise<ArchiveCompletedRunResult> {
	const paths = resolveCompletionPaths(input.repositoryRoot, input.runId, input.configDirName);
	const active = buffer(input.activeRunBytes);
	const previous = buffer(input.previousRunBytes);
	try {
		const validated = validateRunJournal(input.run, paths.archiveRunPath);
		if (!validated.value || validated.diagnostics.length > 0 || input.run.run.status !== "completed" || input.run.run.completion?.phase !== "archived") return { kind: "storage-error", paths, message: "Archive Run snapshot is not a strict completed archived Journal.", deletedActive: false, deletedPrevious: false };
		const activeJournal = deserializeRunJournal(active.toString("utf8"), join(dirname(paths.archiveDirectory), "..", "active-run.json"));
		const previousJournal = deserializeRunJournal(previous.toString("utf8"), join(dirname(paths.archiveDirectory), "..", "active-run.previous.json"));
		if (!activeJournal.value || !previousJournal.value || activeJournal.value.run.id !== input.runId || previousJournal.value.run.id !== input.runId || activeJournal.value.run.status !== "completing" || activeJournal.value.run.completion?.phase !== "archive-intended" || input.run.journalRevision !== activeJournal.value.journalRevision + 1 || activeJournal.value.journalRevision !== previousJournal.value.journalRevision + 1) return { kind: "storage-error", paths, message: "Archive pointers are not the exact completing Run predecessor chain.", deletedActive: false, deletedPrevious: false };
		const bindingError = validateArchiveInput(input, paths, active, previous);
		if (bindingError) return { kind: "storage-error", paths, message: bindingError, deletedActive: false, deletedPrevious: false };
		const runBytes = Buffer.from(serializeRunJournalAtPath(validated.value, paths.archiveRunPath), "utf8");
		if (!safeAbsolute(paths.archiveDirectory) || !canonicalTimestamp(input.archivedAt) || !/^sha256:[0-9a-f]{64}$/.test(input.verification.logSha256) || !/^sha256:[0-9a-f]{64}$/.test(input.verification.resultSha256)) return { kind: "storage-error", paths, message: "Archive intent contains invalid exact paths, time, or hashes.", deletedActive: false, deletedPrevious: false };
		await verifyVerificationEvidence(paths, input.verification, validated.value);
		const reportBytes = await loadReports(paths, input.reports);
		const manifest = archiveManifest(input, paths, active, previous);
		const expected = expectedArchiveFiles(paths, runBytes, previous, manifest.bytes, input.reports, reportBytes);
		const existing = await lstat(paths.archiveDirectory).catch((error: unknown) => (missing(error) ? undefined : Promise.reject(error)));
		if (existing) {
			if (!existing.isDirectory() || existing.isSymbolicLink() || !(await compareArchive(paths.archiveDirectory, expected))) return { kind: "conflict", paths, message: "Existing completion archive differs; no archive bytes were overwritten.", deletedActive: false, deletedPrevious: false };
			const deletion = await deleteMatchingPointers(paths, active, previous);
			if (deletion === "race") return { kind: "race", paths, message: "Live journal pointers changed before conditional archive cleanup.", deletedActive: false, deletedPrevious: false };
			return { kind: "existing-match", paths, manifestBytes: manifest.bytes, deletedActive: true, deletedPrevious: true };
		}
		const state = resolveProjectStatePaths(input.repositoryRoot, input.configDirName);
		await ensureOwnedDirectory(state.stewardDirectory);
		await ensureOwnedDirectory(join(state.stewardDirectory, "archives"));
		const temporary = await createOwnedTemporaryDirectory(join(state.stewardDirectory, "archives"), "archive");
		try {
			await ensureOwnedDirectory(join(temporary, "reports"));
			await writeImmutableFile(join(temporary, "run.json"), runBytes);
			await writeImmutableFile(join(temporary, "previous-run.json"), previous);
			await writeImmutableFile(join(temporary, "manifest.json"), manifest.bytes);
			for (let index = 0; index < input.reports.length; index += 1) {
				const report = input.reports[index]!;
				const destination = reportDestination(paths, report);
				const relativePath = relative(paths.archiveDirectory, destination);
				const destinationDirectory = dirname(join(temporary, relativePath));
				await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
				await writeImmutableFile(join(temporary, relativePath), reportBytes[index]!);
			}
			if (!(await reportsUnchanged(paths, input.reports, reportBytes))) return { kind: "storage-error", paths, message: "A protected report changed before archive publication; no archive or pointer was changed.", deletedActive: false, deletedPrevious: false };
			await chmod(join(temporary, "reports"), 0o500).catch(() => undefined);
			await chmod(temporary, 0o500).catch(() => undefined);
			await syncDirectory(temporary);
			try {
				await rename(temporary, paths.archiveDirectory);
			} catch (error: unknown) {
				if (!exists(error)) throw error;
				if (!(await compareArchive(paths.archiveDirectory, expected))) return { kind: "conflict", paths, message: "Archive publication raced with different bytes; no archive bytes were overwritten.", deletedActive: false, deletedPrevious: false };
			}
			await syncDirectory(dirname(paths.archiveDirectory));
			const deletion = await deleteMatchingPointers(paths, active, previous);
			if (deletion === "race") return { kind: "race", paths, message: "Live journal pointers changed before conditional archive cleanup.", deletedActive: false, deletedPrevious: false };
			return { kind: "published", paths, manifestBytes: manifest.bytes, deletedActive: true, deletedPrevious: true };
		} finally {
			await removeKnownTemporaryDirectory(temporary).catch(() => undefined);
		}
	} catch (error: unknown) {
		return { kind: "storage-error", paths, message: errorText(error).slice(0, 2_000), deletedActive: false, deletedPrevious: false };
	}
}
