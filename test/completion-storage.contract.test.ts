import { removeFixture } from "./remove-fixture.ts";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { archiveCancelledRun, archiveCompletedRun, COMPLETION_OUTPUT_VERSION, decodeVerificationOutput, finalizeVerificationResult, inspectFinalVerificationResult, listTerminalArchives, resolveCompletionPaths, type ArchiveCancelledRunRequest, type CompletionReportSource } from "../src/completion-store.ts";
import { advanceRunJournal, buildInitialRunJournal, createRunIdentity, deserializeRunJournal, type BuilderAttemptRecord, type RunDraft, type RunJournal } from "../src/run.ts";
import type { ProjectModelPlans, RecoveryDefaults } from "../src/config.ts";
import { createRunJournalAdapter } from "../src/adapters.ts";
import { resolveRunJournalPaths } from "../src/run-journal-store.ts";
import { captureArchiveFixture } from "./ticket08-archive-fixture.ts";

const roots: string[] = [];
vi.setConfig({ testTimeout: 60_000 });

const cancelledRecovery: RecoveryDefaults = { passiveInspectionIntervalSeconds: 301, secondInspectionAndNudgeIntervalSeconds: 302, nudgeGracePeriodSeconds: 121, externalCommandWarningThresholdSeconds: 1801, maximumActiveTasks: 1, transientRetryLimit: 1, reworkCycleLimit: 4 };
const cancelledModelPlan: ProjectModelPlans = { builder: { primary: { model: "builder/model", thinkingLevel: "high" }, fallbacks: [] }, reviewer: { primary: { model: "reviewer/model", thinkingLevel: "high" }, fallbacks: [] } };

function cancelledDraft(): RunDraft {
	return {
		declaredOutcome: "Preserve cancellation evidence",
		tasks: [{ requiredOutcome: "Retain the run evidence", allowedScope: ["src"], expectedArtifacts: [{ kind: "git-commit" }], verification: { kind: "command", command: "npm test" }, reviewRequired: true }],
		modelPlan: cancelledModelPlan,
		effectiveSettings: cancelledRecovery,
		finalVerification: { kind: "command", command: "npm test" },
	};
}

function shaBuffer(value: Buffer): string {
	return hashBytes(value);
}

async function cancelledArchiveFixture(root: string, withReport: boolean): Promise<{ input: ArchiveCancelledRunRequest; pointers: { activeBytes: Buffer; previousBytes: Buffer }; reportPath?: string }> {
	const store = createRunJournalAdapter();
	const initial = buildInitialRunJournal({ identity: createRunIdentity(new Date("2026-09-21T00:00:00.000Z"), "01234567-89ab-cdef-0123-456789abcdef"), controllerSessionId: "controller-session", draft: cancelledDraft(), modelPlan: cancelledModelPlan, effectiveSettings: cancelledRecovery, integrationBase: { kind: "git", branch: "main", revision: "0000000000000000000000000000000000000000" } });
	let prepared = initial;
	let reportPath: string | undefined;
	if (withReport) {
		const assignmentPaths = store.resolveAssignmentPaths(root, initial.run.id, "task-01", "attempt-01");
		reportPath = assignmentPaths.reportPath;
		const attempt: BuilderAttemptRecord = {
			id: "attempt-01",
			role: "builder",
			state: "prepared",
			preparedAt: "2026-09-21T00:00:00.001Z",
			actualModel: { ...cancelledModelPlan.builder.primary },
			specificationHash: initial.run.tasks[0]!.specificationHash,
			baseRevision: "0000000000000000000000000000000000000000",
			assignmentPath: assignmentPaths.assignmentPath,
			reportPath,
			evidenceDirectory: assignmentPaths.evidenceDirectory,
			dispatch: { phase: "worktree-intended", branch: "steward/run/task-01/attempt-01", agentName: "steward-b-01234567-01-01" },
		};
		prepared = advanceRunJournal(initial, new Date("2026-09-21T00:00:00.002Z"), (next) => {
			next.run.tasks[0]!.phase = "building";
			next.run.tasks[0]!.attempts.push(attempt);
		});
		await mkdir(assignmentPaths.evidenceDirectory, { recursive: true });
		await writeFile(reportPath, "stable cancelled report\n");
	}
	const stopsComplete = advanceRunJournal(prepared, new Date("2026-09-21T00:00:00.003Z"), (next) => {
		const task = next.run.tasks[0]!;
		const attempt = task.attempts[0];
		task.phase = "cancelled";
		if (attempt) attempt.state = "cancelled";
		next.run.status = "cancelled";
		next.run.cancellation = {
			phase: "stops-complete",
			cancelledAt: "2026-09-21T00:00:00.003Z",
			controllerSessionId: "controller-session",
			controllerLease: { sessionId: "controller-session", leaseId: initial.run.controllerLease!.leaseId },
			priorTasks: [{ taskId: "task-01", phase: withReport ? "building" : "pending", attention: "none", attempts: withReport ? [{ attemptId: "attempt-01", state: "prepared" }] : [] }],
			panes: [],
			worktrees: [],
			stops: withReport ? [{ taskId: "task-01", attemptId: "attempt-01", role: "builder", state: "not-required", reason: "never-started" }] : [],
		};
	});
	const created = await store.createActive(root, initial);
	if (created.kind !== "created") throw new Error(`Cancelled archive fixture could not create active Journal: ${created.kind} ${"diagnostics" in created ? created.diagnostics.map((item) => item.message).join("; ") : ""}`);
	const replacedPrepared = prepared.journalRevision === initial.journalRevision ? { kind: "replaced" as const } : await store.replaceActive(root, prepared);
	if (replacedPrepared.kind !== "replaced") throw new Error(`Cancelled archive fixture could not persist prepared Journal: ${replacedPrepared.kind} ${"diagnostics" in replacedPrepared ? replacedPrepared.diagnostics.map((item) => item.message).join("; ") : ""}`);
	const replaced = await store.replaceActive(root, stopsComplete);
	if (replaced.kind !== "replaced") throw new Error(`Cancelled archive fixture could not persist stops-complete Journal: ${replaced.kind} ${"diagnostics" in replaced ? replaced.diagnostics.map((item) => item.message).join("; ") : ""}`);
	const paths = resolveCompletionPaths(root, initial.run.id);
	const beforeIntent = await store.loadCompletionJournalPointers!(root);
	if (beforeIntent.kind !== "loaded") throw new Error("Cancelled archive fixture pointers were not available before archive intent.");
	const reports: CompletionReportSource[] = withReport && reportPath ? [{ taskId: "task-01", attemptId: "attempt-01", role: "builder", sourcePath: reportPath, destinationPath: "reports/task-01/attempt-01-builder.md", size: Buffer.byteLength("stable cancelled report\n"), sha256: shaBuffer(Buffer.from("stable cancelled report\n")) }] : [];
	const archiveIntent = advanceRunJournal(stopsComplete, new Date("2026-09-21T00:00:00.004Z"), (next) => {
		const current = next.run.cancellation;
		if (!current || current.phase !== "stops-complete") throw new Error("Cancelled archive fixture lost stops-complete state.");
		next.run.cancellation = {
			...current,
			phase: "archive-intended",
			archive: { intendedAt: "2026-09-21T00:00:00.004Z", archiveDirectory: paths.archiveDirectory, runPath: paths.archiveRunPath, previousRunPath: paths.archivePreviousRunPath, manifestPath: paths.archiveManifestPath, activeJournalSha256: shaBuffer(beforeIntent.pointers.activeBytes), previousJournalSha256: shaBuffer(beforeIntent.pointers.previousBytes), reports },
		};
	});
	await store.replaceActive(root, archiveIntent);
	const finalPointers = await store.loadCompletionJournalPointers!(root);
	if (finalPointers.kind !== "loaded") throw new Error("Cancelled archive fixture pointers were not available after archive intent.");
	const archived = advanceRunJournal(archiveIntent, new Date("2026-09-21T00:00:00.005Z"), (next) => {
		const current = next.run.cancellation;
		if (!current || current.phase !== "archive-intended") throw new Error("Cancelled archive fixture lost archive intent.");
		next.run.cancellation = { ...current, phase: "archived", archive: { ...current.archive, activeJournalSha256: shaBuffer(finalPointers.pointers.activeBytes), previousJournalSha256: shaBuffer(finalPointers.pointers.previousBytes) }, archivedAt: "2026-09-21T00:00:00.005Z" };
	});
	return { input: { repositoryRoot: root, runId: initial.run.id, run: archived, archivedAt: "2026-09-21T00:00:00.005Z", reports }, pointers: finalPointers.pointers, ...(reportPath ? { reportPath } : {}) };
}

function hashBytes(value: Buffer): string {
	return "sha256:" + createHash("sha256").update(value).digest("hex");
}

afterEach(async () => {
	for (const root of roots.splice(0)) await removeFixture(root);
});

describe("ticket-08 completion evidence storage", () => {
	it("publishes length-framed stdout/stderr exactly and refuses a different second result", async () => {
		const root = await mkdtemp(join(tmpdir(), "steward-t08-completion-"));
		roots.push(root);
		const input = { repositoryRoot: root, runId: "run-20260918T000000000Z-storage", command: "printf frozen", cwd: root, startedAt: "2026-09-18T00:00:00.001Z", completedAt: "2026-09-18T00:00:00.002Z", exitCode: 0, killed: false as const, stdout: "out\n", stderr: Buffer.from([0, 255, 10]) };
		const created = await finalizeVerificationResult(input);
		expect(created.kind).toBe("created");
		if (created.kind !== "created") return;
		const log = await readFile(created.paths.verificationLogPath);
		const decoded = decodeVerificationOutput(log);
		expect(decoded?.stdout.toString("utf8")).toBe("out\n");
		expect(decoded?.stderr).toEqual(Buffer.from([0, 255, 10]));
		expect((await finalizeVerificationResult(input)).kind).toBe("existing-match");
		const conflict = await finalizeVerificationResult({ ...input, stdout: "changed" });
		expect(conflict.kind).toBe("conflict");
		expect((await readFile(created.paths.verificationLogPath)).equals(log)).toBe(true);
	});

	it("rejects an over-limit channel without creating evidence", async () => {
		const root = await mkdtemp(join(tmpdir(), "steward-t08-completion-limit-"));
		roots.push(root);
		const result = await finalizeVerificationResult({ repositoryRoot: root, runId: "run-20260918T000000000Z-limit", command: "true", cwd: root, startedAt: "2026-09-18T00:00:00.001Z", completedAt: "2026-09-18T00:00:00.002Z", exitCode: 0, killed: false, stdout: Buffer.alloc(16 * 1024 * 1024 + 1), stderr: "" });
		expect(result.kind).toBe("storage-error");
	});

	it("inspects immutable candidate evidence, publishes it without clobbering, and isolates attempt paths", async () => {
		const root = await mkdtemp(join(tmpdir(), "steward-t16-candidate-storage-"));
		roots.push(root);
		const runId = "run-20260920T000000000Z-candidate";
		const command = "printf candidate";
		const startedAt = "2026-09-20T00:00:00.001Z";
		const completedAt = "2026-09-20T00:00:00.002Z";
		const stdout = Buffer.from("candidate-out\n");
		const stderr = Buffer.from("candidate-err\n");
		const log = Buffer.concat([Buffer.from(COMPLETION_OUTPUT_VERSION + "\nstdout-bytes:" + stdout.length + "\nstderr-bytes:" + stderr.length + "\n\n"), stdout, stderr]);
		const paths = resolveCompletionPaths(root, runId, "verification-01");
		await mkdir(paths.runtimeDirectory, { recursive: true, mode: 0o700 });
		await writeFile(paths.descriptorPath, JSON.stringify({ schemaVersion: 1, attemptId: "verification-01", executionNonce: "sha256:" + "d".repeat(64), command, cwd: root, pid: 1234, startedAt }));
		await writeFile(paths.stdoutPath, stdout);
		await writeFile(paths.stderrPath, stderr);
		await writeFile(paths.candidateResultPath, JSON.stringify({ schemaVersion: 1, attemptId: "verification-01", executionNonce: "sha256:" + "d".repeat(64), command, cwd: root, startedAt, completedAt, exitCode: 7, killed: false, stdoutBytes: stdout.length, stderrBytes: stderr.length, stdoutSha256: hashBytes(stdout), stderrSha256: hashBytes(stderr), logSha256: hashBytes(log), argvSha256: "sha256:" + "e".repeat(64) }));
		const candidate = await inspectFinalVerificationResult({ repositoryRoot: root, runId, command, cwd: root, attemptId: "verification-01", executionNonce: "sha256:" + "d".repeat(64), argvSha256: "sha256:" + "e".repeat(64) });
		if (candidate.kind !== "complete") throw new Error(candidate.message);
		expect(candidate.kind).toBe("complete");
		if (candidate.kind !== "complete" || !candidate.evidence) return;
		const published = await finalizeVerificationResult(candidate.evidence);
		expect(published.kind).toBe("created");
		const canonical = await inspectFinalVerificationResult({ repositoryRoot: root, runId, command, cwd: root, attemptId: "verification-01" });
		expect(canonical.kind).toBe("complete");
		if (canonical.kind === "complete") expect(canonical.source).toBe("canonical");
		const partialPaths = resolveCompletionPaths(root, runId, "verification-02");
		await mkdir(partialPaths.runtimeDirectory, { recursive: true, mode: 0o700 });
		const partialBytes = Buffer.from("partial");
		await writeFile(partialPaths.stdoutPath, partialBytes);
		const partial = await inspectFinalVerificationResult({ repositoryRoot: root, runId, command, cwd: root, attemptId: "verification-02" });
		expect(partial.kind).toBe("partial");
		expect(await readFile(partialPaths.stdoutPath)).toEqual(partialBytes);
		const second = await finalizeVerificationResult({ ...candidate.evidence, attemptId: "verification-02" });
		expect(second.kind).toBe("created");
		if (second.kind === "created") expect(second.paths.verificationDirectory).not.toBe(published.kind === "created" ? published.paths.verificationDirectory : "");
		const secondCanonical = await inspectFinalVerificationResult({ repositoryRoot: root, runId, command, cwd: root, attemptId: "verification-02" });
		expect(secondCanonical.kind).toBe("complete");
		if (secondCanonical.kind === "complete") expect(secondCanonical.source).toBe("canonical");
	});
});

describe("ticket-08 completed archive storage", () => {
	it("publishes immutable mode-restricted bytes, reuses an identical archive, and deletes only matching pointers", async () => {
		const root = await mkdtemp(join(tmpdir(), "steward-t08-archive-storage-"));
		roots.push(root);
		const fixture = await captureArchiveFixture(root);
		const publish = await archiveCompletedRun({ ...fixture.request, activeRunBytes: fixture.activeBytes, previousRunBytes: fixture.previousBytes });
		expect(publish.kind).toBe("published");
		const archiveDirectory = fixture.request.run.run.completion && "archive" in fixture.request.run.run.completion ? fixture.request.run.run.completion.archive.archiveDirectory : "";
		expect(await stat(archiveDirectory).then((value) => value.mode & 0o777)).toBe(0o500);
		expect(await stat(join(archiveDirectory, "run.json")).then((value) => value.mode & 0o777)).toBe(0o400);
		expect(await stat(join(archiveDirectory, "previous-run.json")).then((value) => value.mode & 0o777)).toBe(0o400);
		expect(await stat(join(archiveDirectory, "manifest.json")).then((value) => value.mode & 0o777)).toBe(0o400);
		expect(await stat(join(archiveDirectory, "reports")).then((value) => value.mode & 0o777)).toBe(0o500);
		const runBytes = await readFile(join(archiveDirectory, "run.json"));
		await writeFile(fixture.paths.activePath, fixture.activeBytes);
		await writeFile(fixture.paths.previousPath, fixture.previousBytes);
		const existing = await archiveCompletedRun({ ...fixture.request, activeRunBytes: fixture.activeBytes, previousRunBytes: fixture.previousBytes });
		expect(existing.kind).toBe("existing-match");
		expect(await readFile(join(archiveDirectory, "run.json"))).toEqual(runBytes);
		expect(await stat(fixture.paths.activePath).catch(() => undefined)).toBeUndefined();
		expect(await stat(fixture.paths.previousPath).catch(() => undefined)).toBeUndefined();
	});

	it("refuses existing conflicts and protected source changes without clobbering pointers", async () => {
		const root = await mkdtemp(join(tmpdir(), "steward-t08-archive-conflict-storage-"));
		roots.push(root);
		const fixture = await captureArchiveFixture(root);
		const source = fixture.request.reports[0]!;
		const originalSource = await readFile(source.sourcePath);
		await chmod(source.sourcePath, 0o600); // Deliberate corruption must work without root.
		await writeFile(source.sourcePath, Buffer.from("changed protected report\n"));
		const sourceChanged = await archiveCompletedRun({ ...fixture.request, activeRunBytes: fixture.activeBytes, previousRunBytes: fixture.previousBytes });
		expect(sourceChanged.kind).toBe("storage-error");
		expect(await readFile(fixture.paths.activePath)).toEqual(fixture.activeBytes);
		expect(await readFile(fixture.paths.previousPath)).toEqual(fixture.previousBytes);
		await writeFile(source.sourcePath, originalSource);
		const archiveDirectory = fixture.request.run.run.completion && "archive" in fixture.request.run.run.completion ? fixture.request.run.run.completion.archive.archiveDirectory : "";
		await mkdir(archiveDirectory, { recursive: true });
		await writeFile(join(archiveDirectory, "unexpected"), "do not overwrite\n");
		const conflict = await archiveCompletedRun({ ...fixture.request, activeRunBytes: fixture.activeBytes, previousRunBytes: fixture.previousBytes });
		expect(conflict.kind).toBe("conflict");
		expect(await readFile(join(archiveDirectory, "unexpected"), "utf8")).toBe("do not overwrite\n");
		expect(await readFile(fixture.paths.activePath)).toEqual(fixture.activeBytes);
		expect(await readFile(fixture.paths.previousPath)).toEqual(fixture.previousBytes);
	});

	it("returns race and preserves both pointers when the journal changes before conditional deletion", async () => {
		const root = await mkdtemp(join(tmpdir(), "steward-t08-archive-race-"));
		roots.push(root);
		const fixture = await captureArchiveFixture(root);
		const first = await archiveCompletedRun({ ...fixture.request, activeRunBytes: fixture.activeBytes, previousRunBytes: fixture.previousBytes });
		expect(first.kind).toBe("published");
		await writeFile(fixture.paths.activePath, fixture.activeBytes);
		await writeFile(fixture.paths.previousPath, fixture.previousBytes);
		const activeJournal = deserializeRunJournal(fixture.activeBytes.toString("utf8"), fixture.paths.activePath);
		if (!activeJournal.value) throw new Error("Archive fixture active predecessor did not decode");
		const changed = advanceRunJournal(activeJournal.value, new Date("2026-09-18T00:00:01.000Z"), () => {});
		const store = createRunJournalAdapter();
		expect((await store.replaceActive(root, changed)).kind).toBe("replaced");
		const liveActive = await readFile(fixture.paths.activePath);
		const livePrevious = await readFile(fixture.paths.previousPath);
		const raced = await archiveCompletedRun({ ...fixture.request, activeRunBytes: fixture.activeBytes, previousRunBytes: fixture.previousBytes });
		expect(raced.kind).toBe("race");
		expect(await readFile(fixture.paths.activePath)).toEqual(liveActive);
		expect(await readFile(fixture.paths.previousPath)).toEqual(livePrevious);
		expect(resolveRunJournalPaths(root).activePath).toBe(fixture.paths.activePath);
	});
});

describe("ticket-18 cancelled archive storage", () => {
	it("publishes a zero-report cancelled archive, reuses an identical archive, and exposes strict terminal listing", async () => {
		const root = await mkdtemp(join(tmpdir(), "steward-t18-cancelled-archive-"));
		roots.push(root);
		const fixture = await cancelledArchiveFixture(root, false);
		const published = await archiveCancelledRun({ ...fixture.input, activeRunBytes: fixture.pointers.activeBytes, previousRunBytes: fixture.pointers.previousBytes });
		expect(published.kind).toBe("published");
		const paths = resolveCompletionPaths(root, fixture.input.runId);
		expect(await stat(paths.archiveDirectory).then((value) => value.mode & 0o777)).toBe(0o500);
		expect(await stat(paths.archiveRunPath).then((value) => value.mode & 0o777)).toBe(0o400);
		expect(await stat(paths.archivePreviousRunPath).then((value) => value.mode & 0o777)).toBe(0o400);
		expect(await stat(paths.archiveManifestPath).then((value) => value.mode & 0o777)).toBe(0o400);
		expect(await stat(paths.archiveReportsDirectory).catch(() => undefined)).toBeUndefined();
		const listed = await listTerminalArchives(root);
		expect(listed.kind).toBe("loaded");
		if (listed.kind !== "loaded") return;
		expect(listed.archives).toHaveLength(1);
		expect(listed.archives[0]?.kind).toBe("cancelled");

		const journalPaths = resolveRunJournalPaths(root);
		await writeFile(journalPaths.activePath, fixture.pointers.activeBytes);
		await writeFile(journalPaths.previousPath, fixture.pointers.previousBytes);
		const existing = await archiveCancelledRun({ ...fixture.input, activeRunBytes: fixture.pointers.activeBytes, previousRunBytes: fixture.pointers.previousBytes });
		expect(existing.kind).toBe("existing-match");
		expect(await stat(journalPaths.activePath).catch(() => undefined)).toBeUndefined();
		expect(await stat(journalPaths.previousPath).catch(() => undefined)).toBeUndefined();
	});

	it("preserves cancelled pointers when a report changes and rejects unsafe archive contents", async () => {
		const root = await mkdtemp(join(tmpdir(), "steward-t18-cancelled-adversary-"));
		roots.push(root);
		const fixture = await cancelledArchiveFixture(root, true);
		if (!fixture.reportPath) throw new Error("Cancelled report fixture did not create a report");
		const original = await readFile(fixture.reportPath);
		await writeFile(fixture.reportPath, Buffer.from("changed cancelled report\n"));
		const changed = await archiveCancelledRun({ ...fixture.input, activeRunBytes: fixture.pointers.activeBytes, previousRunBytes: fixture.pointers.previousBytes });
		expect(changed.kind).toBe("storage-error");
		expect(await readFile(resolveRunJournalPaths(root).activePath)).toEqual(fixture.pointers.activeBytes);
		expect(await readFile(resolveRunJournalPaths(root).previousPath)).toEqual(fixture.pointers.previousBytes);
		await writeFile(fixture.reportPath, original);
		const published = await archiveCancelledRun({ ...fixture.input, activeRunBytes: fixture.pointers.activeBytes, previousRunBytes: fixture.pointers.previousBytes });
		expect(published.kind).toBe("published");
		const paths = resolveCompletionPaths(root, fixture.input.runId);
		await chmod(paths.archiveDirectory, 0o700); // Simulate an adversary with write access.
		await writeFile(join(paths.archiveDirectory, "unexpected"), "unsafe\n");
		expect((await listTerminalArchives(root)).kind).toBe("unavailable");
		await rm(join(paths.archiveDirectory, "unexpected"), { force: true });
		await symlink(paths.archiveRunPath, join(paths.archiveDirectory, "run-link"));
		expect((await listTerminalArchives(root)).kind).toBe("unavailable");
		await rm(join(paths.archiveDirectory, "run-link"), { force: true });
		const manifest = JSON.parse((await readFile(paths.archiveManifestPath)).toString("utf8")) as Record<string, unknown>;
		manifest.unknown = true;
		await chmod(paths.archiveManifestPath, 0o600);
		await writeFile(paths.archiveManifestPath, `${JSON.stringify(manifest)}\n`);
		expect((await listTerminalArchives(root)).kind).toBe("unavailable");
	});
});
