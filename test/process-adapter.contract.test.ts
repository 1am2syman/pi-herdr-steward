import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { describe, expect, it } from "vitest";

import { createProcessAdapter } from "../src/adapters.ts";
import { resolveCompletionPaths } from "../src/completion-store.ts";
import type { ManagedVerificationInput } from "../src/steward.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function shellQuote(value: string): string {
	return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

function hashText(value: string): string {
	return "sha256:" + createHash("sha256").update(value, "utf8").digest("hex");
}

describe("ticket-08 process envelope", () => {
	it("invokes exactly /bin/sh -c with the frozen command and cwd", async () => {
		const calls: unknown[] = [];
		const adapter = createProcessAdapter(async (...args) => {
			calls.push(args);
			return { stdout: "out", stderr: "err", code: 7, killed: false };
		});
		const result = await adapter.runApprovedVerification!({ cwd: "/tmp/repository", command: "npm test -- --runInBand" });
		expect(result).toEqual({ kind: "completed", code: 7, stdout: "out", stderr: "err", killed: false });
		expect(calls).toEqual([["/bin/sh", ["-c", "npm test -- --runInBand"], { cwd: "/tmp/repository" }]]);
	});

	it("preserves killed results and converts runner throws to an ambiguous envelope", async () => {
		const killed = createProcessAdapter(async () => ({ stdout: "", stderr: "", code: 143, killed: true }));
		expect(await killed.runApprovedVerification!({ cwd: "/tmp/repository", command: "true" })).toEqual({ kind: "completed", code: 143, stdout: "", stderr: "", killed: true });
		const thrown = createProcessAdapter(async () => { throw new Error("runner unavailable"); });
		expect(await thrown.runApprovedVerification!({ cwd: "/tmp/repository", command: "true" })).toEqual({ kind: "thrown", message: "runner unavailable" });
	});

	it("rejects an unsafe command envelope before reaching the runner", async () => {
		let called = false;
		const adapter = createProcessAdapter(async () => { called = true; return { stdout: "", stderr: "", code: 0, killed: false }; });
		const result = await adapter.runApprovedVerification!({ cwd: "/tmp/repository", command: " true" });
		expect(result.kind).toBe("thrown");
		expect(called).toBe(false);
	});

	it.each([
		["empty command", ""],
		["leading whitespace", " npm test"],
		["trailing whitespace", "npm test "],
		["relative cwd", "npm test", "relative/repository"],
		["noncanonical cwd", "npm test", "/tmp/repository/../repository"],
	] as Array<[string, string, string?]>) ("rejects %s without launching a second or altered command", async (_label, command, cwd = "/tmp/repository") => {
		let called = false;
		const adapter = createProcessAdapter(async () => { called = true; return { stdout: "", stderr: "", code: 0, killed: false }; });
		const result = await adapter.runApprovedVerification!({ cwd, command });
		expect(result.kind).toBe("thrown");
		expect(called).toBe(false);
	});

	it("launches the managed runner with exact identity, waits without signals, and preserves the candidate", async () => {
		const root = await mkdtemp(join(tmpdir(), "steward-process-managed-"));
		roots.push(root);
		const release = join(root, "release");
		const marker = join(root, "marker");
		const paths = resolveCompletionPaths(root, "run-20260920T000000000Z-process", "verification-01");
		const input = {
			repositoryRoot: root,
			runId: "run-20260920T000000000Z-process",
			attemptId: "verification-01" as const,
			command: `while [ ! -f ${shellQuote(release)} ]; do sleep 0.01; done; printf managed > ${shellQuote(marker)}`,
			cwd: root,
			executionNonce: `sha256:${"b".repeat(64)}`,
			paths: { runtimeDirectory: paths.runtimeDirectory, descriptorPath: paths.descriptorPath, stdoutPath: paths.stdoutPath, stderrPath: paths.stderrPath, candidateResultPath: paths.candidateResultPath, logPath: paths.verificationLogPath, resultPath: paths.verificationResultPath },
		};
		const adapter = createProcessAdapter(undefined);
		expect(adapter).not.toHaveProperty("signal");
		expect(adapter).not.toHaveProperty("kill");
		const launched = await adapter.launchApprovedVerification!(input);
		expect(launched.kind).toBe("launched");
		if (launched.kind !== "launched") return;
		if (!launched.pid || !launched.startToken || !launched.executionNonce || !launched.argvSha256 || !launched.launchedAt) throw new Error("Managed launch did not return its exact identity.");
		const exact = { ...input, process: { pid: launched.pid, startToken: launched.startToken, executionNonce: launched.executionNonce, argvSha256: launched.argvSha256, commandSha256: hashText(input.command), launchedAt: launched.launchedAt } };
		let live: string | undefined;
		for (let index = 0; index < 100; index += 1) {
			live = await adapter.inspectApprovedVerification!(exact);
			if (live === "live") break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(live).toBe("live");
		await writeFile(release, "go\n");
		expect(await adapter.waitApprovedVerification!(exact, new AbortController().signal)).toBe("settled");
		expect(await readFile(marker, "utf8")).toBe("managed");
		expect(await access(paths.candidateResultPath).then(() => true, () => false)).toBe(true);
		expect(await adapter.inspectApprovedVerification!(exact)).toBe("exited");
	});

	it("supports abortable wait without inspecting or interfering with a process", async () => {
		const adapter = createProcessAdapter(undefined);
		const controller = new AbortController();
		controller.abort();
		const result = await adapter.waitApprovedVerification!({} as ManagedVerificationInput, controller.signal);
		expect(result).toBe("cancelled");
	});
});
