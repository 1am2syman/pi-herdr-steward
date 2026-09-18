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
		const outcome = await adapter.integrateApprovedRange!({ ...input, action: { kind: "fast-forward", argv: ["merge", "--ff-only", "--no-edit", head] } });
		expect(outcome.kind).toBe("completed");
		expect(calls.some((call) => JSON.stringify(call) === JSON.stringify(["git", "merge", "--ff-only", "--no-edit", head]))).toBe(true);
		const after = await adapter.inspectIntegrationCheckout!({ ...input, targetRevision: base });
		expect(after.kind).toBe("inspected");
		if (after.kind === "inspected") expect({ ...after.observation, head: after.observation.head, dirtyPaths: after.observation.dirtyPaths }).toMatchObject({ branch: "main", head, dirtyPaths: [], operationMarkers: [], rangeExact: true });
		expect(calls.some((call) => call.includes("push") || call.includes("fetch") || call.includes("pull"))).toBe(false);
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
});
