import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { it } from "vitest";

import { createHerdrAdapter } from "../src/adapters.ts";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import type { ManagedAgentIdentity } from "../src/steward.ts";

const identity: ManagedAgentIdentity = { name: "steward-b-abcdef12-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" };

function result(stdout = "", stderr = "", code = 0, killed = false): ExecResult {
	return { stdout, stderr, code, killed } as ExecResult;
}

function errorEnvelope(id: string, code: string, message = code): string {
	return JSON.stringify({ id, error: { code, message } });
}

function agentEnvelope(type: "agent_started" | "agent_prompted", actual = identity, model = "provider/primary"): string {
	return JSON.stringify({
		id: type === "agent_started" ? "cli:agent:start" : "cli:agent:prompt",
		result: {
			type,
			agent: {
				name: actual.name,
				agent: "pi",
				agent_status: type === "agent_started" ? "idle" : "working",
				interactive_ready: true,
				workspace_id: actual.workspaceId,
				tab_id: "tab-1",
				pane_id: actual.paneId,
				terminal_id: actual.terminalId,
				argv: ["pi", "--model", model, "--thinking", "high"],
			},
		},
	});
}

it.sequential.each([
	["provider-network-interruption", "agent-prompt", "provider-network-interruption"],
	["agent-startup-failure", "agent-start", "agent-startup-failure"],
	["herdr-command-failure", "pane-split", "herdr-command-failure"],
] as const)("normalizes typed %s without reading terminal prose", async (_label, stage, code) => {
	const adapter = createHerdrAdapter(async (_command, args) => result("", errorEnvelope(args[1] === "start" ? "cli:agent:start" : args[0] === "pane" ? "cli:pane:split" : "cli:agent:prompt", code, "typed infrastructure failure"), 1));
	const value = stage === "agent-start"
		? await adapter.startBuilder!({ repositoryRoot: "/repo", name: identity.name, paneId: identity.paneId, model: { model: "provider/primary", thinkingLevel: "high" } })
		: stage === "pane-split"
			? await adapter.createRecoveryPane!({ repositoryRoot: "/repo", sourcePaneId: identity.paneId, workspaceId: identity.workspaceId, worktreePath: "/repo/worktree", branch: "steward/run/task/attempt-02", agentName: "steward-b-abcdef12-01-02" })
			: await adapter.promptBuilder!({ repositoryRoot: "/repo", name: identity.name, assignmentPrompt: "bounded Assignment" });
	equal(value.kind, "failed");
	if (value.kind === "failed") {
		equal(value.stage, stage);
		equal(value.code, code);
	}
});

it.sequential("separates exact missing, unavailable observation, malformed output, and wrong identity", async () => {
	const missing = createHerdrAdapter(async () => result("", errorEnvelope("cli:agent:get", "agent_not_found", "exact agent is gone"), 1));
	const missingValue = await missing.inspectManagedAgent!(identity);
	deepStrictEqual(missingValue, { kind: "missing", diagnostic: "exact agent is gone" });
	equal((missingValue as { code?: string }).code, "agent_not_found");

	const unavailable = createHerdrAdapter(async () => result("", errorEnvelope("cli:agent:get", "server_unavailable", "server is down"), 1));
	const unavailableValue = await unavailable.inspectManagedAgent!(identity);
	equal(unavailableValue.kind, "unclear");
	equal((unavailableValue as { availability?: string }).availability, "unavailable");

	const malformed = createHerdrAdapter(async () => result("not-json"));
	equal((await malformed.inspectManagedAgent!(identity)).kind, "unclear");
	const wrong = createHerdrAdapter(async () => result(agentEnvelope("agent_prompted", { ...identity, terminalId: "terminal-other" })));
	equal((await wrong.inspectManagedAgent!(identity)).kind, "unclear");
});

it.sequential("uses only the exact same-identity /quit prompt and never a destructive command", async () => {
	const calls: string[][] = [];
	const adapter = createHerdrAdapter(async (_command, args) => {
		calls.push(args);
		return result(agentEnvelope("agent_prompted"));
	});
	const stopped = await adapter.stopAgentGracefully!({ repositoryRoot: "/repo", ...identity });
	ok(stopped.kind === "acknowledged");
	deepStrictEqual(calls, [["agent", "prompt", identity.name, "/quit"]]);
	ok(calls.every((args) => !args.some((arg) => /ctrl\+c|signal|kill|close|remove|reset|clean/i.test(arg))));

	const wrong = createHerdrAdapter(async () => result(agentEnvelope("agent_prompted", { ...identity, paneId: "pane-other" })));
	equal((await wrong.stopAgentGracefully!({ repositoryRoot: "/repo", ...identity })).kind, "failed");
});
