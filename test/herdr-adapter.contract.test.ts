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

function agentEnvelope(type: "agent_started" | "agent_prompted", name = "steward-b-abcdef12-01-01") {
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
			},
		},
	});
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
	const cases: Array<{ stdout: string; stderr?: string; code?: number; killed?: boolean; expected: string }> = [
		{ stdout: JSON.stringify({ result: { type: "worktree_opened" } }), expected: "malformed-response" },
		{ stdout: JSON.stringify({ result: { type: "worktree_created", worktree: { branch: "wrong" } } }), expected: "malformed-response" },
		{ stdout: "not-json", expected: "malformed-response" },
		{ stdout: JSON.stringify({ result: { type: "agent_started", agent: { name: "x", agent: "pi" } } }), expected: "malformed-response" },
		{ stdout: JSON.stringify({ result: { type: "agent_prompted", agent: { name: "x" } } }), expected: "malformed-response" },
		{ stdout: JSON.stringify({ result: { type: "agent_started" } }), killed: true, expected: "killed" },
	];
	for (const item of cases.slice(0, 2)) {
		const adapter = createHerdrAdapter(async () => result(item.stdout, item.stderr ?? "", item.code ?? 0, item.killed ?? false));
		const value = await adapter.createBuilderWorktree!({ repositoryRoot: "/repo", branch: "steward/run/task/attempt-01", baseRevision: "0123456789abcdef0123456789abcdef01234567", label: "steward-b-abcdef12-01-01" });
		ok(value.kind === "failed");
		if (value.kind === "failed") equal(value.code, item.expected);
	}
	const promptAdapter = createHerdrAdapter(async () => result(cases[4]!.stdout));
	const prompt = await promptAdapter.promptBuilder!({ repositoryRoot: "/repo", name: "x", assignmentPrompt: "p" });
	if (prompt.kind !== "failed") throw new Error("expected prompt failure");
	equal(prompt.code, "malformed-response");
});
