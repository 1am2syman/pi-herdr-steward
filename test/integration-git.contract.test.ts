import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { createGitAdapter } from "../src/adapters.ts";

const execFile = promisify(execFileCallback);
const roots: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
	try {
		const result = await execFile("git", args, { cwd });
		return result.stdout.trim();
	} catch (error: unknown) {
		const value = error as { stdout?: string; stderr?: string };
		throw new Error(`${value.stderr ?? "git failed"}\n${value.stdout ?? ""}`);
	}
}

function runner(calls: string[][]) {
	return async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
		calls.push([command, ...args]);
		try {
			const result = await execFile(command, args, { cwd: options?.cwd });
			return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
		} catch (error: unknown) {
			const value = error as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
			return { stdout: value.stdout ?? "", stderr: value.stderr ?? "", code: typeof value.code === "number" ? value.code : 1, killed: value.killed === true };
		}
	};
}

afterEach(async () => {
	for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true });
});

describe("ticket-08 local Git integration contract", () => {
	it("derives the exact range and performs one local fast-forward merge", async () => {
		const root = await mkdtemp(join(tmpdir(), "steward-t08-git-"));
		roots.push(root);
		await git(root, ["init", "-b", "main"]);
		await git(root, ["config", "user.email", "test@example.invalid"]);
		await git(root, ["config", "user.name", "Steward Test"]);
		await writeFile(join(root, "file.txt"), "base\n");
		await git(root, ["add", "file.txt"]);
		await git(root, ["commit", "-m", "base"]);
		const base = await git(root, ["rev-parse", "HEAD"]);
		const builder = await mkdtemp(join(tmpdir(), "steward-t08-builder-"));
		roots.push(builder);
		await git(root, ["worktree", "add", "-b", "builder/t08", builder, base]);
		await writeFile(join(builder, "file.txt"), "one\n");
		await git(builder, ["add", "file.txt"]);
		await git(builder, ["commit", "-m", "one"]);
		await writeFile(join(builder, "file.txt"), "two\n");
		await git(builder, ["add", "file.txt"]);
		await git(builder, ["commit", "-m", "two"]);
		const head = await git(builder, ["rev-parse", "HEAD"]);
		const commits = (await git(builder, ["rev-list", "--reverse", `${base}..${head}`])).split("\n");
		const calls: string[][] = [];
		const adapter = createGitAdapter(runner(calls));
		const input = { repositoryRoot: root, targetBranch: "main", targetRevision: base, approvedBaseRevision: base, approvedHeadRevision: head, approvedCommits: commits };
		const before = await adapter.inspectIntegrationCheckout!(input);
		expect(before.kind).toBe("inspected");
		if (before.kind !== "inspected") return;
		expect(before.observation.rangeExact).toBe(true);
		const wrongBase = await adapter.inspectIntegrationCheckout!({ ...input, approvedBaseRevision: "3333333333333333333333333333333333333333" });
		expect(wrongBase.kind).toBe("unavailable");
		const rangeMismatch = await adapter.inspectIntegrationCheckout!({ ...input, approvedCommits: [...commits].reverse() });
		expect(rangeMismatch.kind).toBe("inspected");
		if (rangeMismatch.kind === "inspected") expect(rangeMismatch.observation.rangeExact).toBe(false);
		expect(calls.some((call) => call.includes("merge"))).toBe(false);
		const outcome = await adapter.integrateApprovedRange!({ ...input, action: { kind: "fast-forward", argv: ["merge", "--ff-only", "--no-edit", head] } });
		expect(outcome.kind).toBe("completed");
		expect(calls.some((call) => JSON.stringify(call) === JSON.stringify(["git", "merge", "--ff-only", "--no-edit", head]))).toBe(true);
		const after = await adapter.inspectIntegrationCheckout!({ ...input, targetRevision: base });
		expect(after.kind).toBe("inspected");
		if (after.kind === "inspected") expect({ ...after.observation, head: after.observation.head, dirtyPaths: after.observation.dirtyPaths }).toMatchObject({ branch: "main", head, dirtyPaths: [], operationMarkers: [], rangeExact: true });
		expect(calls.some((call) => call.includes("push") || call.includes("fetch") || call.includes("pull"))).toBe(false);
	});

	it("performs one exact local no-ff merge for an approved range on a diverged target", async () => {
		const root = await mkdtemp(join(tmpdir(), "steward-t08-git-merge-"));
		roots.push(root);
		await git(root, ["init", "-b", "main"]);
		await git(root, ["config", "user.email", "test@example.invalid"]);
		await git(root, ["config", "user.name", "Steward Test"]);
		await writeFile(join(root, "base.txt"), "base\n");
		await git(root, ["add", "base.txt"]);
		await git(root, ["commit", "-m", "base"]);
		const base = await git(root, ["rev-parse", "HEAD"]);
		const builder = await mkdtemp(join(tmpdir(), "steward-t08-builder-merge-"));
		roots.push(builder);
		await git(root, ["worktree", "add", "-b", "builder/t08-merge", builder, base]);
		await writeFile(join(builder, "change.txt"), "builder\n");
		await git(builder, ["add", "change.txt"]);
		await git(builder, ["commit", "-m", "builder change"]);
		const head = await git(builder, ["rev-parse", "HEAD"]);
		await writeFile(join(root, "target.txt"), "target\n");
		await git(root, ["add", "target.txt"]);
		await git(root, ["commit", "-m", "target side change"]);
		const target = await git(root, ["rev-parse", "HEAD"]);
		const calls: string[][] = [];
		const adapter = createGitAdapter(runner(calls));
		const foreignPostflight = await adapter.inspectIntegrationCheckout!({ repositoryRoot: root, targetBranch: "main", targetRevision: base, approvedBaseRevision: base, approvedHeadRevision: head, approvedCommits: [head] });
		expect(foreignPostflight.kind).toBe("inspected");
		if (foreignPostflight.kind === "inspected") expect(foreignPostflight.observation.rangeExact).toBe(false);
		const outcome = await adapter.integrateApprovedRange!({ repositoryRoot: root, targetBranch: "main", targetRevision: target, approvedBaseRevision: base, approvedHeadRevision: head, approvedCommits: [head], action: { kind: "merge-commit", argv: ["merge", "--no-ff", "--no-edit", head] } });
		expect(outcome).toMatchObject({ kind: "completed", code: 0, killed: false });
		expect(calls.filter((call) => call[1] === "merge")).toEqual([["git", "merge", "--no-ff", "--no-edit", head]]);
		const merged = await git(root, ["rev-parse", "HEAD"]);
		expect(merged).not.toBe(target);
		expect(await git(root, ["rev-list", "--parents", "-n", "1", "HEAD"])).toMatch(new RegExp(`^${merged} ${target} ${head}$`));
		expect(calls.some((call) => call.includes("push") || call.includes("fetch") || call.includes("pull") || call.includes("rebase") || call.includes("reset"))).toBe(false);
	});

	it("reports a dirty target without invoking merge", async () => {
		const root = await mkdtemp(join(tmpdir(), "steward-t08-git-dirty-"));
		roots.push(root);
		await git(root, ["init", "-b", "main"]);
		await git(root, ["config", "user.email", "test@example.invalid"]);
		await git(root, ["config", "user.name", "Steward Test"]);
		await writeFile(join(root, "file.txt"), "base\n");
		await git(root, ["add", "file.txt"]);
		await git(root, ["commit", "-m", "base"]);
		const base = await git(root, ["rev-parse", "HEAD"]);
		const calls: string[][] = [];
		const adapter = createGitAdapter(runner(calls));
		await writeFile(join(root, "untracked.txt"), "dirty\n");
		const result = await adapter.inspectIntegrationCheckout!({ repositoryRoot: root, targetBranch: "main", targetRevision: base, approvedBaseRevision: base, approvedHeadRevision: base, approvedCommits: [base] });
		expect(result.kind).toBe("inspected");
		if (result.kind === "inspected") expect(result.observation.dirtyPaths).toContain("untracked.txt");
		expect(calls.some((call) => call.includes("merge"))).toBe(false);
	});

	it("rejects killed, stderr, and malformed read-only Git envelopes and preserves a nonzero merge acknowledgement", async () => {
		const root = await mkdtemp(join(tmpdir(), "steward-t08-git-envelope-"));
		roots.push(root);
		await git(root, ["init", "-b", "main"]);
		await git(root, ["config", "user.email", "test@example.invalid"]);
		await git(root, ["config", "user.name", "Steward Test"]);
		await writeFile(join(root, "file.txt"), "base\n");
		await git(root, ["add", "file.txt"]);
		await git(root, ["commit", "-m", "base"]);
		const base = await git(root, ["rev-parse", "HEAD"]);
		const input = { repositoryRoot: root, targetBranch: "main", targetRevision: base, approvedBaseRevision: base, approvedHeadRevision: base, approvedCommits: [base] };
		for (const mode of ["killed", "stderr", "malformed"] as const) {
			const calls: string[][] = [];
			const adapter = createGitAdapter(async (command, args, options) => {
				calls.push([command, ...args]);
				if (mode === "killed" && args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return { stdout: "true", stderr: "", code: 0, killed: true };
				if (mode === "stderr" && args[0] === "symbolic-ref") return { stdout: "main\n", stderr: "unexpected stderr", code: 0, killed: false };
				if (mode === "malformed" && args[0] === "rev-list") return { stdout: "not-a-full-sha\n", stderr: "", code: 0, killed: false };
				return runner([])(command, args, options);
			});
			const inspected = await adapter.inspectIntegrationCheckout!(input);
			expect(inspected.kind).toBe("unavailable");
			expect(calls.some((call) => call.includes("merge"))).toBe(false);
		}
		const mergeCalls: string[][] = [];
		const adapter = createGitAdapter(async (command, args) => {
			mergeCalls.push([command, ...args]);
			if (args[0] === "merge") return { stdout: "", stderr: "conflict", code: 1, killed: false };
			return runner([])(command, args);
		});
		const outcome = await adapter.integrateApprovedRange!({ ...input, action: { kind: "fast-forward", argv: ["merge", "--ff-only", "--no-edit", base] } });
		expect(outcome).toEqual({ kind: "completed", code: 1, stdout: "", stderr: "conflict", killed: false });
		expect(mergeCalls.filter((call) => call.includes("merge"))).toHaveLength(1);
	});
});
