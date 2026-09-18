import { link, lstat, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import {
	createOwnedTemporaryFile,
	ensureOwnedDirectory,
	ensureProjectStateDirectory,
	filesystemErrorText,
	removeKnownTemporaryFile,
	resolveProjectStatePaths,
	syncDirectory,
} from "./project-state.ts";
import {
	deserializeBuilderAssignment,
	deserializeReviewerAssignment,
	serializeBuilderAssignment,
	serializeReviewerAssignment,
	type AssignmentDocument,
	type RunDiagnostic,
} from "./run.ts";
import type { ReviewerAssignmentDocument } from "./review.ts";

export interface AssignmentPaths {
	attemptDirectory: string;
	assignmentPath: string;
	reportPath: string;
	evidenceDirectory: string;
}

export type AssignmentCreateResult =
	| { kind: "created"; paths: AssignmentPaths; bytes: string }
	| { kind: "existing-match"; paths: AssignmentPaths; bytes: string }
	| { kind: "conflict"; paths: AssignmentPaths; diagnostics: RunDiagnostic[] }
	| { kind: "storage-error"; paths: AssignmentPaths; diagnostics: RunDiagnostic[] };

function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function exists(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function diagnostic(message: string, path: string): RunDiagnostic {
	return { code: "invalid-task", message, path };
}

function safeSegment(value: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function pathsFor(repositoryRoot: string, runId: string, taskId: string, attemptId: string, configDirName: string): AssignmentPaths {
	if (!safeSegment(runId) || !safeSegment(taskId) || !safeSegment(attemptId)) throw new Error("Assignment identifiers are not filesystem-safe.");
	const state = resolveProjectStatePaths(repositoryRoot, configDirName);
	const attemptDirectory = join(state.stewardDirectory, "runs", runId, "tasks", taskId, "attempts", attemptId);
	return {
		attemptDirectory,
		assignmentPath: join(attemptDirectory, "assignment.json"),
		reportPath: join(attemptDirectory, "report.md"),
		evidenceDirectory: join(attemptDirectory, "evidence"),
	};
}

async function ensureAttemptDirectories(paths: AssignmentPaths, stewardDirectory: string): Promise<void> {
	let current = stewardDirectory;
	const segments = relative(stewardDirectory, paths.attemptDirectory).split("/");
	if (segments.length !== 6 || segments[0] !== "runs" || segments[2] !== "tasks" || segments[4] !== "attempts" || segments.some((segment) => !safeSegment(segment))) throw new Error("Assignment Attempt directory escaped Steward state.");
	for (const part of segments) {
		current = join(current, part);
		await ensureOwnedDirectory(current);
	}
	await ensureOwnedDirectory(paths.evidenceDirectory);
}

async function readExisting(path: string): Promise<{ kind: "missing" } | { kind: "invalid"; diagnostics: RunDiagnostic[]; bytes?: string }> {
	try {
		const info = await lstat(path);
		if (!info.isFile()) return { kind: "invalid", diagnostics: [diagnostic("Assignment path is not a regular file.", path)] };
		if ((info.mode & 0o777) !== 0o600) return { kind: "invalid", diagnostics: [diagnostic("Assignment file must be protected with mode 0600.", path)] };
		const bytes = await readFile(path, "utf8");
		const decoded = bytes.includes('"role": "reviewer"') ? deserializeReviewerAssignment(bytes, path) : deserializeBuilderAssignment(bytes, path);
		return decoded.value ? { kind: "invalid", diagnostics: [], bytes } : { kind: "invalid", diagnostics: decoded.diagnostics, bytes };
	} catch (error: unknown) {
		if (missing(error)) return { kind: "missing" };
		throw error;
	}
}

export function resolveAssignmentPaths(repositoryRoot: string, runId: string, taskId: string, attemptId: string, configDirName = CONFIG_DIR_NAME): AssignmentPaths {
	return pathsFor(repositoryRoot, runId, taskId, attemptId, configDirName);
}

export function createAssignmentStore(options: { configDirName?: string } = {}) {
	const configDirName = options.configDirName ?? CONFIG_DIR_NAME;

	async function createAssignment(repositoryRoot: string, document: AssignmentDocument): Promise<AssignmentCreateResult> {
		let paths: AssignmentPaths;
		try {
			paths = pathsFor(repositoryRoot, document.assignment.runId, document.assignment.taskId, document.assignment.attemptId, configDirName);
		} catch (error: unknown) {
			const fallback = resolveProjectStatePaths(repositoryRoot, configDirName).stewardDirectory;
			return { kind: "storage-error", paths: { attemptDirectory: fallback, assignmentPath: join(fallback, "assignment.json"), reportPath: join(fallback, "report.md"), evidenceDirectory: join(fallback, "evidence") }, diagnostics: [diagnostic(filesystemErrorText(error), fallback)] };
		}
		const expected = paths;
		if (document.assignment.reportPath !== expected.reportPath || document.assignment.evidenceDirectory !== expected.evidenceDirectory) return { kind: "conflict", paths, diagnostics: [diagnostic("Assignment evidence paths do not match their deterministic Attempt directory.", paths.assignmentPath)] };
		let bytes: string;
		try {
			bytes = document.assignment.role === "reviewer" ? serializeReviewerAssignment(document as ReviewerAssignmentDocument) : serializeBuilderAssignment(document as Extract<AssignmentDocument, { assignment: { role: "builder" } }>);
			await ensureProjectStateDirectory(repositoryRoot, configDirName);
			await ensureAttemptDirectories(paths, resolveProjectStatePaths(repositoryRoot, configDirName).stewardDirectory);
			const current = await readExisting(paths.assignmentPath);
			if (current.kind !== "missing") {
				if (current.bytes === bytes && current.diagnostics.length === 0) return { kind: "existing-match", paths, bytes };
				return { kind: "conflict", paths, diagnostics: current.diagnostics.length > 0 ? current.diagnostics : [diagnostic("Assignment already exists with different bytes.", paths.assignmentPath)] };
			}
			const temporaryPath = await createOwnedTemporaryFile(paths.attemptDirectory, "assignment", bytes);
			try {
				const reread = await readFile(temporaryPath, "utf8");
				const rereadDecoded = document.assignment.role === "reviewer" ? deserializeReviewerAssignment(reread, paths.assignmentPath) : deserializeBuilderAssignment(reread, paths.assignmentPath);
				if (reread !== bytes || !rereadDecoded.value) throw new Error("Validated Assignment bytes changed before commit.");
				try {
					await link(temporaryPath, paths.assignmentPath);
				} catch (error: unknown) {
					if (!exists(error)) throw error;
					const raced = await readExisting(paths.assignmentPath);
					if (raced.kind !== "missing" && raced.bytes === bytes && raced.diagnostics.length === 0) return { kind: "existing-match", paths, bytes };
					return { kind: "conflict", paths, diagnostics: [diagnostic("Assignment appeared with different bytes during no-clobber creation.", paths.assignmentPath)] };
				}
				await syncDirectory(paths.attemptDirectory);
				return { kind: "created", paths, bytes };
			} finally {
				await removeKnownTemporaryFile(temporaryPath).catch(() => undefined);
			}
		} catch (error: unknown) {
			return { kind: "storage-error", paths, diagnostics: [diagnostic(`${paths.assignmentPath}: ${filesystemErrorText(error)}`, paths.assignmentPath)] };
		}
	}

	return { createAssignment };
}

export type AssignmentStore = ReturnType<typeof createAssignmentStore>;
