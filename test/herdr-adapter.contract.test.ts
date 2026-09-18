import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { it } from "vitest";

import { createHerdrAdapter } from "../src/adapters.ts";
import type { ModelChoice } from "../src/config.ts";
import type { ExecResult } from "@earendil-works/pi-coding-agent";

const model: ModelChoice = { model: "provider/model-id", thinkingLevel: "xhigh" };

function result(stdout = "", stderr = "", code = 0, killed = false): ExecResult {
	return { stdout, stderr, code, killed } as ExecResult;
}

function worktreeEnvelope() {
	return JSON.stringify({
		id: "cli:worktree:create",
		result: {
			type: "worktree_created",
			workspace: { workspace_id: "workspace-1" },
			tab: { tab_id: "tab-1" },
			root_pane: { pane_id: "pane-1", terminal_id: "terminal-1" },
			worktree: { branch: "steward/run/task/attempt-01", path: "/tmp/builder", is_linked_worktree: true, open_workspace_id: "workspace-1" },
		},
	});
}

function agentEnvelope(type: "agent_started" | "agent_prompted", name = "steward-b-abcdef12-01-01", overrides: Record<string, unknown> = {}) {
	return JSON.stringify({
		id: `cli:agent:${type === "agent_started" ? "start" : "prompt"}`,
		result: {
			type,
			agent: {
				name,
				agent: "pi",
				agent_status: "idle",
				interactive_ready: true,
				workspace_id: "workspace-1",
				tab_id: "tab-1",
				pane_id: "pane-1",
				terminal_id: "terminal-1",
				argv: ["pi", "--model", model.model, "--thinking", model.thinkingLevel],
				...overrides,
			},
		},
	});
}

function reviewerPaneEnvelope() {
	return JSON.stringify({ id: "cli:pane:split", result: { type: "pane_split", pane: { workspace_id: "workspace-1", tab_id: "tab-2", pane_id: "pane-reviewer", terminal_id: "terminal-reviewer", source_pane_id: "pane-1", cwd: "/tmp/builder" } } });
}

it.sequential("translates worktree create, exact Pi start, and one-argv prompt", async () => {
	const calls: Array<{ command: string; args: string[]; options?: { cwd?: string; timeout?: number } }> = [];
	const adapter = createHerdrAdapter(async (command, args, options) => {
		calls.push({ command, args, options });
		if (args[0] === "worktree") return result(worktreeEnvelope());
		if (args[1] === "start") return result(agentEnvelope("agent_started"));
		return result(agentEnvelope("agent_prompted"));
	});
	const created = await adapter.createBuilderWorktree!({ repositoryRoot: "/repo", branch: "steward/run/task/attempt-01", baseRevision: "0123456789abcdef0123456789abcdef01234567", label: "steward-b-abcdef12-01-01" });
	deepStrictEqual(created, { kind: "created", branch: "steward/run/task/attempt-01", path: "/tmp/builder", workspaceId: "workspace-1", tabId: "tab-1", paneId: "pane-1", terminalId: "terminal-1" });
	const started = await adapter.startBuilder!({ repositoryRoot: "/repo", name: "steward-b-abcdef12-01-01", paneId: "pane-1", model });
	deepStrictEqual(started, { kind: "started", name: "steward-b-abcdef12-01-01", agentKind: "pi", workspaceId: "workspace-1", tabId: "tab-1", paneId: "pane-1", terminalId: "terminal-1" });
	const prompt = "Assignment prompt with spaces and JSON {\"bounded\":true}";
	const prompted = await adapter.promptBuilder!({ repositoryRoot: "/repo", name: "steward-b-abcdef12-01-01", assignmentPrompt: prompt });
	deepStrictEqual(prompted, { kind: "prompted", name: "steward-b-abcdef12-01-01", workspaceId: "workspace-1", tabId: "tab-1", paneId: "pane-1", terminalId: "terminal-1" });
	deepStrictEqual(calls, [
		{ command: "herdr", args: ["worktree", "create", "--cwd", "/repo", "--branch", "steward/run/task/attempt-01", "--base", "0123456789abcdef0123456789abcdef01234567", "--label", "steward-b-abcdef12-01-01", "--no-focus"], options: { cwd: "/repo", timeout: 30000 } },
		{ command: "herdr", args: ["agent", "start", "steward-b-abcdef12-01-01", "--kind", "pi", "--pane", "pane-1", "--timeout", "30000", "--", "--model", "provider/model-id", "--thinking", "xhigh"], options: { cwd: "/repo", timeout: 30000 } },
		{ command: "herdr", args: ["agent", "prompt", "steward-b-abcdef12-01-01", prompt], options: { cwd: "/repo", timeout: 30000 } },
	]);
});

it.sequential("maps only exact agent_name_taken to a collision", async () => {
	let calls = 0;
	const adapter = createHerdrAdapter(async () => calls++ === 0
		? result("", JSON.stringify({ id: "cli:agent:start", error: { code: "agent_name_taken", message: "candidate details" } }), 1)
		: result("", JSON.stringify({ id: "cli:agent:start", error: { code: "agent_pane_busy", message: "busy" } }), 1));
	const collision = await adapter.startBuilder!({ repositoryRoot: "/repo", name: "steward-b-abcdef12-01-01", paneId: "pane-1", model });
	deepStrictEqual(collision, { kind: "name-collision", code: "agent_name_taken", message: "candidate details" });
	const failed = await adapter.startBuilder!({ repositoryRoot: "/repo", name: "steward-b-abcdef12-01-01", paneId: "pane-1", model });
	deepStrictEqual(failed, { kind: "failed", stage: "agent-start", code: "agent_pane_busy", message: "busy" });
});

it.sequential("rejects malformed, wrong-type, killed, and contradictory Herdr envelopes", async () => {
	const worktreeInput = { repositoryRoot: "/repo", branch: "steward/run/task/attempt-01", baseRevision: "0123456789abcdef0123456789abcdef01234567", label: "steward-b-abcdef12-01-01" };
	const worktreeCases: Array<{ name: string; stdout?: string; stderr?: string; code?: number; killed?: boolean; thrown?: string; expected: string }> = [
		{ name: "wrong result type", stdout: JSON.stringify({ result: { type: "worktree_opened" } }), expected: "malformed-response" },
		{ name: "wrong branch", stdout: JSON.stringify({ result: { type: "worktree_created", worktree: { branch: "wrong" } } }), expected: "malformed-response" },
		{ name: "malformed JSON", stdout: "not-json", expected: "malformed-response" },
		{ name: "killed result", stdout: JSON.stringify({ result: { type: "worktree_created" } }), killed: true, expected: "killed" },
		{ name: "exit-2 syntax failure", stdout: "", stderr: "syntax error", code: 2, expected: "malformed-response" },
		{ name: "thrown command runner", thrown: "runner exploded", expected: "runner-error" },
		{ name: "contradictory workspace identity", stdout: worktreeEnvelope().replace('"open_workspace_id":"workspace-1"', '"open_workspace_id":"workspace-2"'), expected: "malformed-response" },
	];
	for (const item of worktreeCases) {
		const adapter = createHerdrAdapter(async () => {
			if (item.thrown) throw new Error(item.thrown);
			return result(item.stdout ?? "", item.stderr ?? "", item.code ?? 0, item.killed ?? false);
		});
		const value = await adapter.createBuilderWorktree!(worktreeInput);
		ok(value.kind === "failed");
		if (value.kind === "failed") equal(value.code, item.expected);
	}

	const agentCases: Array<{ name: string; stdout?: string; stderr?: string; code?: number; killed?: boolean; thrown?: string; expected: string }> = [
		{ name: "partial agent_started", stdout: JSON.stringify({ result: { type: "agent_started", agent: { name: "x", agent: "pi" } } }), expected: "malformed-response" },
		{ name: "killed agent start", stdout: JSON.stringify({ result: { type: "agent_started" } }), killed: true, expected: "killed" },
		{ name: "exit-2 agent syntax failure", stderr: "syntax error", code: 2, expected: "malformed-response" },
		{ name: "thrown agent runner", thrown: "runner exploded", expected: "runner-error" },
		{ name: "contradictory agent pane identity", stdout: agentEnvelope("agent_started", "steward-b-abcdef12-01-01", { pane_id: "pane-other" }), expected: "malformed-response" },
	];
	for (const item of agentCases) {
		const adapter = createHerdrAdapter(async () => {
			if (item.thrown) throw new Error(item.thrown);
			return result(item.stdout ?? "", item.stderr ?? "", item.code ?? 0, item.killed ?? false);
		});
		const value = await adapter.startBuilder!({ repositoryRoot: "/repo", name: "steward-b-abcdef12-01-01", paneId: "pane-1", model });
		ok(value.kind === "failed", item.name);
		if (value.kind === "failed") equal(value.code, item.expected, item.name);
	}

	const promptCases: Array<{ name: string; stdout?: string; stderr?: string; code?: number; killed?: boolean; thrown?: string; expected: string }> = [
		{ name: "partial agent_prompted", stdout: JSON.stringify({ result: { type: "agent_prompted", agent: { name: "x" } } }), expected: "malformed-response" },
		{ name: "killed prompt", stdout: JSON.stringify({ result: { type: "agent_prompted" } }), killed: true, expected: "killed" },
		{ name: "exit-2 prompt syntax failure", stderr: "syntax error", code: 2, expected: "malformed-response" },
		{ name: "thrown prompt runner", thrown: "runner exploded", expected: "runner-error" },
		{ name: "contradictory prompt name identity", stdout: agentEnvelope("agent_prompted", "other-agent"), expected: "malformed-response" },
	];
	for (const item of promptCases) {
		const adapter = createHerdrAdapter(async () => {
			if (item.thrown) throw new Error(item.thrown);
			return result(item.stdout ?? "", item.stderr ?? "", item.code ?? 0, item.killed ?? false);
		});
		const value = await adapter.promptBuilder!({ repositoryRoot: "/repo", name: "steward-b-abcdef12-01-01", assignmentPrompt: "p" });
		ok(value.kind === "failed", item.name);
		if (value.kind === "failed") equal(value.code, item.expected, item.name);
	}
});

it.sequential("translates and rejects the exact Reviewer pane/start/prompt contract", async () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	const adapter = createHerdrAdapter(async (command, args) => {
		calls.push({ command, args });
		if (args[0] === "pane") return result(reviewerPaneEnvelope());
		if (args[1] === "start") return result(agentEnvelope("agent_started", "steward-r-abcdef12-01-02", { workspace_id: "workspace-1", tab_id: "tab-2", pane_id: "pane-reviewer", terminal_id: "terminal-reviewer" }));
		return result(agentEnvelope("agent_prompted", "steward-r-abcdef12-01-02", { workspace_id: "workspace-1", tab_id: "tab-2", pane_id: "pane-reviewer", terminal_id: "terminal-reviewer" }));
	});
	const pane = await adapter.createReviewerPane!({ repositoryRoot: "/repo", sourcePaneId: "pane-1", worktreePath: "/tmp/builder", branch: "branch", agentName: "steward-r-abcdef12-01-02", workspaceId: "workspace-1" });
	deepStrictEqual(pane, { kind: "created", workspaceId: "workspace-1", tabId: "tab-2", paneId: "pane-reviewer", terminalId: "terminal-reviewer", sourcePaneId: "pane-1", worktreePath: "/tmp/builder" });
	const started = await adapter.startReviewer!({ repositoryRoot: "/repo", name: "steward-r-abcdef12-01-02", paneId: "pane-reviewer", model });
	deepStrictEqual(started, { kind: "started", name: "steward-r-abcdef12-01-02", agentKind: "pi", workspaceId: "workspace-1", tabId: "tab-2", paneId: "pane-reviewer", terminalId: "terminal-reviewer" });
	const prompt = await adapter.promptReviewer!({ repositoryRoot: "/repo", name: "steward-r-abcdef12-01-02", assignmentPrompt: "review assignment" });
	deepStrictEqual(prompt, { kind: "prompted", name: "steward-r-abcdef12-01-02", workspaceId: "workspace-1", tabId: "tab-2", paneId: "pane-reviewer", terminalId: "terminal-reviewer" });
	deepStrictEqual(calls, [
		{ command: "herdr", args: ["pane", "split", "--pane", "pane-1", "--direction", "right", "--cwd", "/tmp/builder", "--no-focus"] },
		{ command: "herdr", args: ["agent", "start", "steward-r-abcdef12-01-02", "--kind", "pi", "--pane", "pane-reviewer", "--timeout", "30000", "--", "--model", model.model, "--thinking", model.thinkingLevel] },
		{ command: "herdr", args: ["agent", "prompt", "steward-r-abcdef12-01-02", "review assignment"] },
	]);
	const rejectedPane = createHerdrAdapter(async () => result(JSON.stringify({ result: { type: "pane_split", pane: { workspace_id: "workspace-2", tab_id: "tab-2", pane_id: "pane-reviewer", terminal_id: "terminal-reviewer", source_pane_id: "pane-1", cwd: "/tmp/builder" } } })));
	const rejected = await rejectedPane.createReviewerPane!({ repositoryRoot: "/repo", sourcePaneId: "pane-1", worktreePath: "/tmp/builder", branch: "branch", agentName: "steward-r-abcdef12-01-02", workspaceId: "workspace-1" });
	deepStrictEqual(rejected, { kind: "failed", stage: "pane-split", code: "malformed-response", message: "Herdr returned no valid pane_split envelope." });
});
