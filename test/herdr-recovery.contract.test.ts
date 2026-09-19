import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { it } from "vitest";

import { createHerdrAdapter } from "../src/adapters.ts";
import type { ModelChoice } from "../src/config.ts";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import type { ManagedAgentIdentity } from "../src/steward.ts";

const identity: ManagedAgentIdentity = { name: "steward-b-abcdef12-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" };
const replacementIdentity: ManagedAgentIdentity = { name: "steward-b-abcdef12-01-02", workspaceId: "workspace-2", paneId: "pane-2", terminalId: "terminal-2" };
const model: ModelChoice = { model: "provider/model-id", thinkingLevel: "xhigh" };

function result(stdout: string, stderr = "", code = 0, killed = false): ExecResult {
	return { stdout, stderr, code, killed } as ExecResult;
}

function agent(type: "agent_info" | "agent_prompted" | "agent_keys_sent" | "agent_started", actual: ManagedAgentIdentity, status = "working"): string {
	return JSON.stringify({
		id: type === "agent_info" ? "cli:agent:get" : type === "agent_started" ? "cli:agent:start" : type === "agent_keys_sent" ? "cli:agent:send-keys" : "cli:agent:prompt",
		result: {
			type,
			agent: {
				name: actual.name,
				agent: "pi",
				agent_status: status,
				interactive_ready: true,
				workspace_id: actual.workspaceId,
				tab_id: actual.workspaceId === "workspace-2" ? "tab-2" : "tab-1",
				pane_id: actual.paneId,
				terminal_id: actual.terminalId,
				argv: ["pi", "--model", model.model, "--thinking", model.thinkingLevel],
			},
		},
	});
}

it.sequential("uses exact same-identity recovery inputs and the no-focus linked replacement ladder", async () => {
	const calls: Array<{ command: string; args: string[]; options?: Record<string, unknown> }> = [];
	const adapter = createHerdrAdapter(async (command, args, options) => {
		calls.push({ command, args, options });
		if (args[0] === "agent" && args[1] === "get") return result(agent("agent_info", args[2] === replacementIdentity.name ? replacementIdentity : identity));
		if (args[0] === "agent" && args[1] === "send-keys") return result(agent("agent_keys_sent", identity));
		if (args[0] === "agent" && args[1] === "start") return result(agent("agent_started", replacementIdentity, "idle"));
		if (args[0] === "agent" && args[1] === "prompt") return result(agent("agent_prompted", args[2] === replacementIdentity.name ? replacementIdentity : identity));
		if (args[0] === "pane") return result(JSON.stringify({ id: "cli:pane:split", result: { type: "pane_split", pane: { workspace_id: "workspace-2", tab_id: "tab-2", pane_id: "pane-2", terminal_id: "terminal-2", source_pane_id: "pane-1", cwd: "/repo/worktree" } } }));
		throw new Error(`unexpected command: ${args.join(" ")}`);
	});

	deepStrictEqual(await adapter.nudgeAgent!({ repositoryRoot: "/repo", identity, prompt: "STEWARD_SILENCE_NUDGE attempt-01: continue" }), { kind: "prompted", name: identity.name, workspaceId: identity.workspaceId, tabId: "tab-1", paneId: identity.paneId, terminalId: identity.terminalId });
	deepStrictEqual(await adapter.interruptAgent!({ repositoryRoot: "/repo", identity }), { kind: "acknowledged", identity });
	deepStrictEqual(await adapter.resumeAgent!({ repositoryRoot: "/repo", identity, prompt: "STEWARD_SILENCE_RESUME attempt-01: continue" }), { kind: "prompted", name: identity.name, workspaceId: identity.workspaceId, tabId: "tab-1", paneId: identity.paneId, terminalId: identity.terminalId });
	deepStrictEqual(await adapter.createRecoveryPane!({ repositoryRoot: "/repo", sourcePaneId: identity.paneId, workspaceId: replacementIdentity.workspaceId, worktreePath: "/repo/worktree", branch: "steward/run/task/attempt-02", agentName: replacementIdentity.name }), { kind: "created", workspaceId: "workspace-2", tabId: "tab-2", paneId: "pane-2", terminalId: "terminal-2", sourcePaneId: identity.paneId, worktreePath: "/repo/worktree" });
	deepStrictEqual(await adapter.startReplacementAgent!({ repositoryRoot: "/repo", name: replacementIdentity.name, paneId: replacementIdentity.paneId, model }), { kind: "started", name: replacementIdentity.name, agentKind: "pi", workspaceId: replacementIdentity.workspaceId, tabId: "tab-2", paneId: replacementIdentity.paneId, terminalId: replacementIdentity.terminalId });
	deepStrictEqual(await adapter.promptReplacementAgent!({ repositoryRoot: "/repo", identity: replacementIdentity, assignmentPrompt: "Immutable replacement Assignment" }), { kind: "prompted", name: replacementIdentity.name, workspaceId: replacementIdentity.workspaceId, tabId: "tab-2", paneId: replacementIdentity.paneId, terminalId: replacementIdentity.terminalId });

	deepStrictEqual(calls, [
		{ command: "herdr", args: ["agent", "get", identity.name], options: { timeout: 5_000 } },
		{ command: "herdr", args: ["agent", "prompt", identity.name, "STEWARD_SILENCE_NUDGE attempt-01: continue"], options: { cwd: "/repo", timeout: 30_000 } },
		{ command: "herdr", args: ["agent", "get", identity.name], options: { timeout: 5_000 } },
		{ command: "herdr", args: ["agent", "send-keys", identity.name, "esc"], options: { cwd: "/repo", timeout: 5_000 } },
		{ command: "herdr", args: ["agent", "get", identity.name], options: { timeout: 5_000 } },
		{ command: "herdr", args: ["agent", "prompt", identity.name, "STEWARD_SILENCE_RESUME attempt-01: continue"], options: { cwd: "/repo", timeout: 30_000 } },
		{ command: "herdr", args: ["pane", "split", "--pane", identity.paneId, "--direction", "right", "--cwd", "/repo/worktree", "--no-focus"], options: { cwd: "/repo", timeout: 30_000 } },
		{ command: "herdr", args: ["agent", "start", replacementIdentity.name, "--kind", "pi", "--pane", replacementIdentity.paneId, "--timeout", "30000", "--", "--model", model.model, "--thinking", model.thinkingLevel], options: { cwd: "/repo", timeout: 30_000 } },
		{ command: "herdr", args: ["agent", "get", replacementIdentity.name], options: { timeout: 5_000 } },
		{ command: "herdr", args: ["agent", "prompt", replacementIdentity.name, "Immutable replacement Assignment"], options: { cwd: "/repo", timeout: 30_000 } },
	]);
});

it.sequential("does not turn malformed or wrong-identity recovery acknowledgements into proof", async () => {
	const wrong = createHerdrAdapter(async (_command, args) => {
		if (args[1] === "get") return result(agent("agent_info", { ...identity, terminalId: "terminal-reused" }));
		return result(agent(args[1] === "send-keys" ? "agent_keys_sent" : "agent_prompted", { ...identity, terminalId: "terminal-reused" }));
	});
	const nudge = await wrong.nudgeAgent!({ repositoryRoot: "/repo", identity, prompt: "nudge" });
	ok(nudge.kind === "failed");
	equal(nudge.kind === "failed" ? nudge.code : "", "identity-mismatch");
	const interrupt = await wrong.interruptAgent!({ repositoryRoot: "/repo", identity });
	equal(interrupt.kind, "failed");

	const malformed = createHerdrAdapter(async () => result(JSON.stringify({ id: "cli:agent:send-keys", result: { type: "agent_keys_sent" } })));
	const value = await malformed.interruptAgent!({ repositoryRoot: "/repo", identity });
	equal(value.kind, "failed");
});
