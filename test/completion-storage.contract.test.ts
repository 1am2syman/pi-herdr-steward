import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { decodeVerificationOutput, finalizeVerificationResult } from "../src/completion-store.ts";

const roots: string[] = [];

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
});
