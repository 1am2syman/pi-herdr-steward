import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { afterEach, it } from "vitest";

import { createGitAdapter } from "../src/adapters.ts";
import type { ExecResult } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await execFileAsync("git", args, { cwd, shell: false, maxBuffer: 2 * 1024 * 1024 });
	return result.stdout.toString().trim();
}

function runner(): (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<ExecResult> {
	return async (command, args, options) => {
		try {
			const result = await execFileAsync(command, args, { cwd: options?.cwd, timeout: options?.timeout, shell: false, maxBuffer: 4 * 1024 * 1024 });
			return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), code: 0, killed: false } as ExecResult;
		} catch (error: unknown) {
			const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string; code?: number; killed?: boolean };
			return { stdout: failure.stdout?.toString() ?? "", stderr: failure.stderr?.toString() ?? "", code: typeof failure.code === "number" ? failure.code : 1, killed: failure.killed ?? false } as ExecResult;
		}
	};
}

it.sequential("production Git evidence adapter reports exact range, rename paths, and clean worktree", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-git-evidence-"));
	roots.push(root);
	await git(root, ["init", "--initial-branch=main"]);
	await git(root, ["config", "user.email", "test@example.invalid"]);
	await git(root, ["config", "user.name", "Evidence Test"]);
	await writeFile(join(root, "old.txt"), "old\n");
	await git(root, ["add", "old.txt"]);
	await git(root, ["commit", "-m", "base"]);
	const base = await git(root, ["rev-parse", "HEAD"]);
	const worktree = join(root, "builder");
	await git(root, ["worktree", "add", "-b", "builder-branch", worktree, base]);
	await git(worktree, ["mv", "old.txt", "renamed.txt"]);
	await git(worktree, ["commit", "-am", "rename"]);
	const first = await git(worktree, ["rev-parse", "HEAD"]);
	await writeFile(join(worktree, "new.txt"), "second commit\n");
	await git(worktree, ["add", "new.txt"]);
	await git(worktree, ["commit", "-m", "update"]);
	const head = await git(worktree, ["rev-parse", "HEAD"]);
	const adapter = createGitAdapter(runner());
	const inspected = await adapter.inspectProducedCodeArtifact!({ worktreePath: worktree, approvedBase: base, producedHead: head });
	if (inspected.kind !== "inspected") throw new Error(`expected clean inspection: ${JSON.stringify(inspected)}`);
	deepStrictEqual(inspected, { kind: "inspected", base, head, commits: [first, head], changedPaths: [{ status: "A", paths: ["new.txt"] }, { status: "R100", paths: ["old.txt", "renamed.txt"] }], clean: true });
	const beforeHead = await readFile(join(worktree, "renamed.txt"));
	await writeFile(join(worktree, "renamed.txt"), "dirty tracked\n");
	await writeFile(join(worktree, "untracked.txt"), "dirty untracked\n");
	const dirty = await adapter.inspectProducedCodeArtifact!({ worktreePath: worktree, approvedBase: base, producedHead: head });
	if (dirty.kind !== "invalid") throw new Error("dirty worktree was accepted");
	equal(dirty.code, "dirty-worktree");
	ok(dirty.dirtyPaths?.includes("renamed.txt"));
	ok(dirty.dirtyPaths?.includes("untracked.txt"));
	equal(await git(worktree, ["rev-parse", "HEAD"]), head);
	deepStrictEqual(await readFile(join(worktree, "renamed.txt")), Buffer.from("dirty tracked\n"));
	deepStrictEqual(beforeHead, Buffer.from("old\n"));
});

it.sequential("production Git evidence adapter fails closed for wrong range and malformed output", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-git-invalid-"));
	roots.push(root);
	const adapter = createGitAdapter(async (_command, args) => {
		if (args[0] === "rev-parse" && args[1] === "--verify") return { stdout: "not-a-sha\n", stderr: "", code: 0, killed: false } as ExecResult;
		return { stdout: "", stderr: "", code: 0, killed: false } as ExecResult;
	});
	const malformed = await adapter.inspectProducedCodeArtifact!({ worktreePath: root, approvedBase: "0123456789abcdef0123456789abcdef01234567", producedHead: "1111111111111111111111111111111111111111" });
	if (malformed.kind !== "invalid") throw new Error("malformed Git output was accepted");
	equal(malformed.code, "missing-revision");
	const unrelated = createGitAdapter(async (_command, args) => {
		if (args[0] === "rev-parse" && args[1] === "--verify") return { stdout: `${args[2]?.includes("0123") ? "0123456789abcdef0123456789abcdef01234567" : "1111111111111111111111111111111111111111"}\n`, stderr: "", code: 0, killed: false } as ExecResult;
		if (args[0] === "merge-base") return { stdout: "", stderr: "", code: 1, killed: false } as ExecResult;
		return { stdout: "", stderr: "", code: 0, killed: false } as ExecResult;
	});
	const wrong = await unrelated.inspectProducedCodeArtifact!({ worktreePath: root, approvedBase: "0123456789abcdef0123456789abcdef01234567", producedHead: "1111111111111111111111111111111111111111" });
	if (wrong.kind !== "invalid") throw new Error("non-descendant range was accepted");
	equal(wrong.code, "base-not-ancestor");
});

it.sequential("production Git Builder preflight accepts the clean prior reviewed head and rejects moved or dirty state read-only", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-git-rework-preflight-"));
	roots.push(root);
	await git(root, ["init", "--initial-branch=main"]);
	await git(root, ["config", "user.email", "test@example.invalid"]);
	await git(root, ["config", "user.name", "Rework Preflight Test"]);
	await writeFile(join(root, "change.txt"), "reviewed artifact\n");
	await git(root, ["add", "change.txt"]);
	await git(root, ["commit", "-m", "reviewed artifact"]);
	const reviewedHead = await git(root, ["rev-parse", "HEAD"]);
	const adapter = createGitAdapter(runner());
	const clean = await adapter.inspectBuilderWorktree!(root, reviewedHead);
	deepStrictEqual(clean, { kind: "ready", head: reviewedHead, clean: true });
	const wrong = await adapter.inspectBuilderWorktree!(root, "0".repeat(40));
	if (wrong.kind !== "unavailable") throw new Error("wrong prior reviewed head was accepted");
	await writeFile(join(root, "change.txt"), "moved after Review\n");
	const dirty = await adapter.inspectBuilderWorktree!(root, reviewedHead);
	if (dirty.kind !== "unavailable") throw new Error("dirty rework worktree was accepted");
	equal(await git(root, ["rev-parse", "HEAD"]), reviewedHead);
	deepStrictEqual(await readFile(join(root, "change.txt")), Buffer.from("moved after Review\n"));
	await writeFile(join(root, "change.txt"), "reviewed artifact\n");
	await writeFile(join(root, "untracked.txt"), "untracked mutation\n");
	const untracked = await adapter.inspectBuilderWorktree!(root, reviewedHead);
	if (untracked.kind !== "unavailable") throw new Error("untracked rework worktree was accepted");
	equal(await git(root, ["rev-parse", "HEAD"]), reviewedHead);
});

it.sequential("Review snapshots fingerprint clean, tracked, staged, untracked, operation, and HEAD changes without mutation", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-git-review-snapshot-"));
	roots.push(root);
	await git(root, ["init", "--initial-branch=main"]);
	await git(root, ["config", "user.email", "test@example.invalid"]);
	await git(root, ["config", "user.name", "Snapshot Test"]);
	await writeFile(join(root, "tracked.txt"), "one\n");
	await git(root, ["add", "tracked.txt"]);
	await git(root, ["commit", "-m", "base"]);
	const adapter = createGitAdapter(runner());
	const clean = await adapter.inspectReviewWorktree!(root);
	if ("kind" in clean) throw new Error(clean.message);
	const cleanAgain = await adapter.inspectReviewWorktree!(root);
	deepStrictEqual(cleanAgain, clean);
	await writeFile(join(root, "tracked.txt"), "tracked dirty\n");
	const tracked = await adapter.inspectReviewWorktree!(root);
	if ("kind" in tracked) throw new Error(tracked.message);
	equal(tracked.head, clean.head);
	ok(tracked.dirtyPaths.includes("tracked.txt"));
	ok(tracked.dirtyStateFingerprint !== clean.dirtyStateFingerprint);
	await git(root, ["restore", "tracked.txt"]);
	await writeFile(join(root, "tracked.txt"), "staged dirty\n");
	await git(root, ["add", "tracked.txt"]);
	const staged = await adapter.inspectReviewWorktree!(root);
	if ("kind" in staged) throw new Error(staged.message);
	ok(staged.dirtyPaths.includes("tracked.txt"));
	ok(staged.dirtyStateFingerprint !== clean.dirtyStateFingerprint);
	await git(root, ["restore", "--staged", "tracked.txt"]);
	await git(root, ["restore", "tracked.txt"]);
	await writeFile(join(root, "untracked.txt"), "untracked\n");
	const untracked = await adapter.inspectReviewWorktree!(root);
	if ("kind" in untracked) throw new Error(untracked.message);
	ok(untracked.dirtyPaths.includes("untracked.txt"));
	ok(untracked.dirtyStateFingerprint !== clean.dirtyStateFingerprint);
	await rm(join(root, "untracked.txt"));
	await writeFile(join(root, ".git", "MERGE_HEAD"), clean.head);
	const operation = await adapter.inspectReviewWorktree!(root);
	if ("kind" in operation) throw new Error(operation.message);
	deepStrictEqual(operation.operationMarkers, ["MERGE_HEAD"]);
	ok(operation.dirtyStateFingerprint !== clean.dirtyStateFingerprint);
	await rm(join(root, ".git", "MERGE_HEAD"));
	await writeFile(join(root, "head.txt"), "new head\n");
	await git(root, ["add", "head.txt"]);
	await git(root, ["commit", "-m", "reviewer commit"]);
	const changedHead = await adapter.inspectReviewWorktree!(root);
	if ("kind" in changedHead) throw new Error(changedHead.message);
	ok(changedHead.head !== clean.head);
	deepStrictEqual(await readFile(join(root, "tracked.txt")), Buffer.from("one\n"));
});
