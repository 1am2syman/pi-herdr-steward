import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, writeFile, readdir } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { createOwnedTemporaryDirectory, ensureOwnedDirectory, removeKnownTemporaryDirectory, syncDirectory, syncFile } from "./project-state.ts";
import type { BuilderAttemptReport, ReportedArtifact, ReportedLogReference } from "./attempt-report.ts";

export const MAX_LOG_BYTES = 16 * 1024 * 1024;
export const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;

export interface EvidencePaths {
	attemptDirectory: string;
	assignmentPath: string;
	reportPath: string;
	evidenceDirectory: string;
	finalizedDirectory: string;
}

export interface BuilderEvidenceInputRequest {
	repositoryRoot: string;
	paths: EvidencePaths;
	assignmentSha256: string;
}

export type BuilderEvidenceInputs =
	| { kind: "report-missing"; paths: EvidencePaths }
	| {
			kind: "loaded";
			paths: EvidencePaths;
			assignmentBytes: Buffer;
			reportBytes: Buffer;
			assignmentSha256: string;
			reportSha256: string;
		}
	| { kind: "unsafe"; paths: EvidencePaths; code: string; message: string; reportSha256?: string };

export interface ReferencedEvidenceRequest {
	repositoryRoot: string;
	paths: EvidencePaths;
	report: BuilderAttemptReport;
	worktreePath: string;
}

export interface ValidatedEvidenceFile {
	path: string;
	bytes: Buffer;
	size: number;
	sha256: string;
}

export type ReferencedEvidenceResult =
	| { kind: "inspected"; files: ValidatedEvidenceFile[] }
	| { kind: "invalid"; code: string; message: string; files: ValidatedEvidenceFile[] };

export interface FinalizationCopy {
	relativePath: string;
	bytes: Buffer;
	size: number;
	sha256: string;
}

export interface FinalizeBuilderEvidenceRequest {
	paths: EvidencePaths;
	assignmentBytes: Buffer;
	reportBytes: Buffer;
	manifestBytes: Buffer;
	manifestSha256: string;
	copies: FinalizationCopy[];
	originalPaths?: string[];
}

export type FinalizeBuilderEvidenceResult =
	| { kind: "created" | "existing-match"; manifestPath: string; manifestSha256: string }
	| { kind: "conflict" | "storage-error"; message: string };

function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function exists(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function errorText(error: unknown): string {
	return error instanceof Error && error.message.length > 0 ? error.message : "Filesystem operation failed.";
}

function hash(bytes: Buffer): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function safeAbsolute(value: string): boolean {
	return isAbsolute(value) && value === resolve(value) && !value.includes("\u0000");
}

function contained(root: string, path: string): boolean {
	if (!safeAbsolute(root) || !safeAbsolute(path)) return false;
	const rootPrefix = root.endsWith("/") ? root : `${root}/`;
	return path.startsWith(rootPrefix) && path !== rootPrefix && !path.startsWith(`${rootPrefix}finalized/`);
}

async function stableFile(path: string, maximumBytes: number, requiredMode?: number): Promise<{ kind: "missing" } | { kind: "invalid"; message: string } | { kind: "loaded"; bytes: Buffer; size: number; sha256: string }> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink()) return { kind: "invalid", message: `Evidence path is not a regular file: ${path}` };
		if (requiredMode !== undefined && (info.mode & 0o777) !== requiredMode) return { kind: "invalid", message: `Protected Assignment mode is not ${requiredMode.toString(8)}: ${path}` };
		if (info.size > maximumBytes) return { kind: "invalid", message: `Evidence file exceeds the ${maximumBytes}-byte read bound: ${path}` };
		const canonical = await realpath(path);
		if (canonical !== path) return { kind: "invalid", message: `Evidence path resolves through a symlink: ${path}` };
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const before = await handle.stat();
		if (!before.isFile() || before.dev !== info.dev || before.ino !== info.ino || before.size !== info.size) return { kind: "invalid", message: `Evidence file changed before reading: ${path}` };
		const chunks: Buffer[] = [];
		const digest = createHash("sha256");
		let size = 0;
		while (size <= maximumBytes) {
			const chunk = Buffer.alloc(Math.min(64 * 1024, maximumBytes + 1 - size));
			const read = await handle.read(chunk, 0, chunk.length, null);
			if (read.bytesRead === 0) break;
			const bytes = chunk.subarray(0, read.bytesRead);
			size += read.bytesRead;
			if (size > maximumBytes) return { kind: "invalid", message: `Evidence file exceeds the ${maximumBytes}-byte read bound: ${path}` };
			digest.update(bytes);
			chunks.push(bytes);
		}
		const after = await handle.stat();
		const bytes = Buffer.concat(chunks, size);
		if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || bytes.length !== before.size) return { kind: "invalid", message: `Evidence file changed while reading: ${path}` };
		return { kind: "loaded", bytes, size: bytes.length, sha256: `sha256:${digest.digest("hex")}` };
	} catch (error: unknown) {
		return missing(error) ? { kind: "missing" } : { kind: "invalid", message: `${path}: ${errorText(error)}` };
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function validUtf8(bytes: Buffer): boolean {
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return true;
	} catch {
		return false;
	}
}

async function validateNoSymlinkRoot(path: string): Promise<boolean> {
	try {
		const info = await lstat(path);
		if (!info.isDirectory() || info.isSymbolicLink()) return false;
		return (await realpath(path)) === path;
	} catch {
		return false;
	}
}

async function inspectOne(path: string, root: string, maximumBytes: number): Promise<{ file?: ValidatedEvidenceFile; message?: string }> {
	if (!contained(root, path)) return { message: `Unsafe evidence path outside Attempt evidenceDirectory: ${path}` };
	const result = await stableFile(path, maximumBytes);
	if (result.kind === "missing") return { message: `Referenced evidence file is missing: ${path}` };
	if (result.kind === "invalid") return { message: result.message };
	return { file: { path, bytes: result.bytes, size: result.size, sha256: result.sha256 } };
}

export function createAttemptEvidenceStore() {
	async function loadBuilderEvidenceInputs(input: BuilderEvidenceInputRequest): Promise<BuilderEvidenceInputs> {
		const { paths } = input;
		if (!safeAbsolute(paths.attemptDirectory) || !safeAbsolute(paths.assignmentPath) || !safeAbsolute(paths.reportPath) || !safeAbsolute(paths.evidenceDirectory) || !safeAbsolute(paths.finalizedDirectory) || paths.assignmentPath !== join(paths.attemptDirectory, "assignment.json") || paths.reportPath !== join(paths.attemptDirectory, "report.md") || paths.evidenceDirectory !== join(paths.attemptDirectory, "evidence") || paths.finalizedDirectory !== join(paths.attemptDirectory, "finalized") || !(await validateNoSymlinkRoot(paths.attemptDirectory)) || !(await validateNoSymlinkRoot(paths.evidenceDirectory))) return { kind: "unsafe", paths, code: "unsafe-path", message: "Attempt evidence paths are not deterministic protected regular paths." };
		const report = await stableFile(paths.reportPath, 64 * 1024);
		if (report.kind === "missing") return { kind: "report-missing", paths };
		if (report.kind === "invalid") return { kind: "unsafe", paths, code: "report-invalid", message: report.message };
		if (!validUtf8(report.bytes)) return { kind: "unsafe", paths, code: "report-invalid", message: "Attempt Report is not valid UTF-8." };
		const assignment = await stableFile(paths.assignmentPath, MAX_EVIDENCE_BYTES, 0o600);
		if (assignment.kind === "missing") return { kind: "unsafe", paths, code: "missing-assignment", message: "Builder Assignment is missing." };
		if (assignment.kind === "invalid") return { kind: "unsafe", paths, code: "assignment-invalid", message: assignment.message };
		if (!validUtf8(assignment.bytes)) return { kind: "unsafe", paths, code: "assignment-invalid", message: "Builder Assignment is not valid UTF-8." };
		const assignmentSha256 = hash(assignment.bytes);
		if (assignmentSha256 !== input.assignmentSha256) return { kind: "unsafe", paths, code: "assignment-hash-mismatch", message: "Builder Assignment bytes changed after dispatch." };
		return { kind: "loaded", paths, assignmentBytes: assignment.bytes, reportBytes: report.bytes, assignmentSha256, reportSha256: report.sha256 };
	}

	async function inspectReferencedEvidence(input: ReferencedEvidenceRequest): Promise<ReferencedEvidenceResult> {
		const files: ValidatedEvidenceFile[] = [];
		const errors: string[] = [];
		const worktree = resolve(input.worktreePath);
		if (!(await validateNoSymlinkRoot(worktree))) errors.push(`Builder worktree is not a real directory: ${input.worktreePath}`);
		for (const artifact of input.report.producedArtifacts) {
			if (artifact.kind === "git-commit") continue;
			const path = artifact.kind === "file" ? artifact.evidencePath : artifact.path;
			const result = await inspectOne(path, input.paths.evidenceDirectory, MAX_EVIDENCE_BYTES);
			if (result.file) {
				files.push(result.file);
				if (result.file.size !== artifact.size || result.file.sha256 !== artifact.sha256) errors.push(`Evidence size or SHA-256 does not match the report: ${path}`);
			} else if (result.message) errors.push(result.message);
			if (artifact.kind === "file") {
				const sourcePath = join(worktree, ...artifact.path.split("/"));
				const source = await inspectOne(sourcePath, worktree, MAX_EVIDENCE_BYTES);
				if (!source.file) errors.push(source.message ?? `Source file is missing: ${sourcePath}`);
				else if (source.file.size !== artifact.size || source.file.sha256 !== artifact.sha256) errors.push(`Source file size or SHA-256 does not match the report: ${artifact.path}`);
			}
		}
		for (const log of input.report.logReferences) {
			const result = await inspectOne(log.path, input.paths.evidenceDirectory, MAX_LOG_BYTES);
			if (result.file) {
				files.push(result.file);
				if (result.file.size !== log.size || result.file.sha256 !== log.sha256) errors.push(`Log size or SHA-256 does not match the report: ${log.path}`);
			} else if (result.message) errors.push(result.message);
		}
		return errors.length > 0 ? { kind: "invalid", code: errors.some((error) => error.includes("Unsafe")) ? "unsafe-path" : errors.some((error) => error.includes("missing")) ? "missing-evidence" : "hash-mismatch", message: errors.join(" ").slice(0, 4_000), files } : { kind: "inspected", files };
	}

	async function finalizeBuilderEvidence(input: FinalizeBuilderEvidenceRequest): Promise<FinalizeBuilderEvidenceResult> {
		const finalDirectory = input.paths.finalizedDirectory;
		const manifestPath = join(finalDirectory, "manifest.json");
		if (finalDirectory !== join(input.paths.attemptDirectory, "finalized") || input.manifestSha256 !== hash(input.manifestBytes)) return { kind: "storage-error", message: "Finalization target or manifest hash is not deterministic." };
		try {
			const existing = await lstat(finalDirectory).catch((error: unknown) => (missing(error) ? undefined : Promise.reject(error)));
			if (existing) {
				if (!existing.isDirectory() || existing.isSymbolicLink()) return { kind: "conflict", message: "Finalized evidence path is not a regular directory." };
				const result = await compareExisting(finalDirectory, input);
				if (result.kind === "existing-match") await protectOriginals(input.originalPaths ?? []);
				return result;
			}
			const temporary = await createOwnedTemporaryDirectory(input.paths.attemptDirectory, "finalized");
			try {
				await writeFinalizationFiles(temporary, input);
				try {
					await rename(temporary, finalDirectory);
				} catch (error: unknown) {
					if (!exists(error)) throw error;
					return await compareExisting(finalDirectory, input);
				}
				await syncDirectory(input.paths.attemptDirectory);
				await protectOriginals(input.originalPaths ?? []);
				return { kind: "created", manifestPath, manifestSha256: input.manifestSha256 };
			} finally {
				await removeKnownTemporaryDirectory(temporary).catch(() => undefined);
			}
		} catch (error: unknown) {
			return { kind: "storage-error", message: errorText(error) };
		}
	}

	return { loadBuilderEvidenceInputs, inspectReferencedEvidence, finalizeBuilderEvidence };
}

async function writeCopy(path: string, bytes: Buffer): Promise<void> {
	await writeFile(path, bytes, { mode: 0o400, flag: "wx" });
	await chmod(path, 0o400).catch(() => undefined);
	await syncFile(path);
}

async function writeFinalizationFiles(directory: string, input: FinalizeBuilderEvidenceRequest): Promise<void> {
	await ensureOwnedDirectory(join(directory, "logs"));
	await ensureOwnedDirectory(join(directory, "artifacts"));
	await writeCopy(join(directory, "manifest.json"), input.manifestBytes);
	await writeCopy(join(directory, "assignment.json"), input.assignmentBytes);
	await writeCopy(join(directory, "report.md"), input.reportBytes);
	for (const copy of input.copies) {
		const path = join(directory, copy.relativePath);
		if (relative(directory, path).startsWith("..") || isAbsolute(relative(directory, path))) throw new Error("Finalization copy escaped its private directory.");
		await writeCopy(path, copy.bytes);
	}
	await syncDirectory(join(directory, "logs"));
	await syncDirectory(join(directory, "artifacts"));
	await chmod(join(directory, "logs"), 0o500).catch(() => undefined);
	await chmod(join(directory, "artifacts"), 0o500).catch(() => undefined);
	await chmod(directory, 0o500).catch(() => undefined);
	await syncDirectory(directory);
}

async function protectOriginals(paths: readonly string[]): Promise<void> {
	for (const path of paths) await chmod(path, 0o400).catch(() => undefined);
}

async function compareExisting(directory: string, input: FinalizeBuilderEvidenceRequest): Promise<FinalizeBuilderEvidenceResult> {
	const expected = new Map<string, Buffer>([["manifest.json", input.manifestBytes], ["assignment.json", input.assignmentBytes], ["report.md", input.reportBytes], ...input.copies.map((copy) => [copy.relativePath, copy.bytes] as const)]);
	for (const [relativePath, bytes] of expected) {
		const path = join(directory, relativePath);
		const actual = await stableFile(path, Math.max(MAX_LOG_BYTES, MAX_EVIDENCE_BYTES));
		if (actual.kind !== "loaded" || actual.sha256 !== hash(bytes) || !actual.bytes.equals(bytes)) return { kind: "conflict", message: `Finalized evidence differs at ${path}; preserved bytes were not overwritten.` };
	}
	const actualPaths = await listRelativeFiles(directory);
	if (actualPaths.length !== expected.size || actualPaths.some((path) => !expected.has(path))) return { kind: "conflict", message: "Finalized evidence contains unexpected files; preserved bytes were not overwritten." };
	return { kind: "existing-match", manifestPath: join(directory, "manifest.json"), manifestSha256: input.manifestSha256 };
}

async function listRelativeFiles(directory: string): Promise<string[]> {
	const files: string[] = [];
	async function visit(current: string, prefix: string): Promise<void> {
		for (const entry of await readdir(current, { withFileTypes: true })) {
			const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory()) await visit(join(current, entry.name), relativePath);
			else if (entry.isFile()) files.push(relativePath);
			else throw new Error(`Finalized evidence contains a non-regular entry: ${relativePath}`);
		}
	}
	await visit(directory, "");
	return files;
}

export function finalizationCopyForLog(log: ReportedLogReference, bytes: Buffer, index: number): FinalizationCopy {
	return { relativePath: join("logs", `${basename(log.id)}.log`), bytes, size: bytes.length, sha256: hash(bytes) };
}

export function finalizationCopyForArtifact(artifact: ReportedArtifact, bytes: Buffer, index: number): FinalizationCopy {
	return { relativePath: join("artifacts", String(index).padStart(4, "0")), bytes, size: bytes.length, sha256: hash(bytes) };
}

export function sha256Bytes(bytes: Buffer): string {
	return hash(bytes);
}
