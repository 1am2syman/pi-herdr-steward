import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { archiveCompletedRun, COMPLETION_OUTPUT_VERSION, decodeVerificationOutput, finalizeVerificationResult, inspectFinalVerificationResult, resolveCompletionPaths } from "../src/completion-store.ts";
import { advanceRunJournal, deserializeRunJournal } from "../src/run.ts";
import { createRunJournalAdapter } from "../src/adapters.ts";
import { resolveRunJournalPaths } from "../src/run-journal-store.ts";
import { captureArchiveFixture } from "./ticket08-archive-fixture.ts";

const roots: string[] = [];
vi.setConfig({ testTimeout: 60_000 });

function hashBytes(value: Buffer): string {
	return "sha256:" + createHash("sha256").update(value).digest("hex");
}

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
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
