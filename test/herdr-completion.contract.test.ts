import { describe, expect, it } from "vitest";

import { createHerdrAdapter } from "../src/adapters.ts";

function response(agent: Record<string, unknown>, type = "agent_prompted") {
	return { stdout: JSON.stringify({ result: { type, agent } }), stderr: "", code: 0, killed: false };
}

const input = { repositoryRoot: "/tmp/repository", name: "builder-01", workspaceId: "ws-1", paneId: "pane-1", terminalId: "term-1" };

describe("ticket-08 Herdr graceful stop envelope", () => {
	it("submits only the fixed /quit prompt and accepts the exact identity", async () => {
		const calls: unknown[] = [];
		const adapter = createHerdrAdapter(async (...args) => {
			calls.push(args);
			return response({ name: input.name, workspace_id: input.workspaceId, tab_id: "tab-1", pane_id: input.paneId, terminal_id: input.terminalId });
		});
		expect(await adapter.stopAgentGracefully!(input)).toEqual({ kind: "acknowledged", name: input.name, workspaceId: input.workspaceId, tabId: "tab-1", paneId: input.paneId, terminalId: input.terminalId });
		expect(calls).toEqual([["herdr", ["agent", "prompt", "builder-01", "/quit"], { cwd: "/tmp/repository", timeout: 30000 }]]);
	});

	it.each([
		["wrong name", { name: "reviewer-01", workspace_id: "ws-1", tab_id: "tab-1", pane_id: "pane-1", terminal_id: "term-1" }],
		["wrong pane", { name: "builder-01", workspace_id: "ws-1", tab_id: "tab-1", pane_id: "pane-2", terminal_id: "term-1" }],
		["wrong terminal", { name: "builder-01", workspace_id: "ws-1", tab_id: "tab-1", pane_id: "pane-1", terminal_id: "term-2" }],
		["malformed result", { name: "builder-01", workspace_id: "ws-1", tab_id: "tab-1", pane_id: "pane-1" }],
	] as const)("rejects %s acknowledgement without lifecycle inference", async (_label, agent) => {
		const adapter = createHerdrAdapter(async () => response(agent));
		expect((await adapter.stopAgentGracefully!(input)).kind).toBe("failed");
	});
});
