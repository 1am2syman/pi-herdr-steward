import { createHash } from "node:crypto";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { it } from "vitest";

import { createHerdrAdapter } from "../src/adapters.ts";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import type { ManagedAgentIdentity } from "../src/steward.ts";

const identity: ManagedAgentIdentity = {
	name: "steward-b-abcdef12-01-01",
	workspaceId: "workspace-1",
	paneId: "pane-1",
	terminalId: "terminal-1",
};

function result(stdout = "", stderr = "", code = 0, killed = false): ExecResult {
	return { stdout, stderr, code, killed } as ExecResult;
}

function agentEnvelope(status: string, overrides: Record<string, unknown> = {}, id = "cli:agent:get"): string {
	return JSON.stringify({
		id,
		result: {
			type: "agent_info",
			agent: {
				name: identity.name,
				agent: "pi",
				agent_status: status,
				workspace_id: identity.workspaceId,
				tab_id: "tab-1",
				pane_id: identity.paneId,
				terminal_id: identity.terminalId,
				state_change_seq: 41,
				...overrides,
			},
		},
	});
}

it.sequential("uses exact recorded identity and fixed Herdr monitor envelopes", async () => {
	const calls: Array<{ command: string; args: string[]; options?: { timeout?: number; signal?: AbortSignal } }> = [];
	const adapter = createHerdrAdapter(async (command, args, options) => {
		calls.push({ command, args, options });
		if (args[1] === "get") return result(agentEnvelope("working"));
		if (args[1] === "wait") return result(agentEnvelope("idle", {}, "cli:agent:wait"));
		return result("terminal line\n");
	});
	const signal = new AbortController().signal;
	deepStrictEqual(await adapter.inspectManagedAgent!(identity), { kind: "observed", identity, lifecycle: "working", stateChangeSequence: 41 });
	deepStrictEqual(await adapter.waitForManagedAgent!(identity, 7_000, signal), { kind: "settled", lifecycle: "idle", identity, stateChangeSequence: 41 });
	const terminal = await adapter.readManagedTerminal!(identity);
	deepStrictEqual(terminal, { kind: "observed", byteCount: 14, sha256: `sha256:${createHash("sha256").update("terminal line\n").digest("hex")}` });
	deepStrictEqual(calls, [
		{ command: "herdr", args: ["agent", "get", identity.name], options: { timeout: 5_000 } },
		{ command: "herdr", args: ["agent", "wait", identity.name, "--until", "idle", "--until", "done", "--until", "blocked", "--until", "unknown", "--timeout", "7000"], options: { timeout: 8_000, signal } },
		{ command: "herdr", args: ["agent", "read", identity.name, "--source", "recent-unwrapped", "--lines", "200"], options: { timeout: 5_000 } },
	]);
});

it.sequential("forwards AbortSignal and classifies timeout, malformed, and wrong-resource results without adoption", async () => {
	let observedSignal: AbortSignal | undefined;
	const timeout = createHerdrAdapter(async (_command, args) => {
		if (args[1] === "wait") return result("", JSON.stringify({ id: "cli:agent:wait", error: { code: "timeout", message: "wait timeout" } }), 1);
		return result("not-json");
	});
	deepStrictEqual(await timeout.waitForManagedAgent!(identity, 1_500, new AbortController().signal), { kind: "timeout" });
	deepStrictEqual(await timeout.inspectManagedAgent!(identity), { kind: "unavailable", diagnostic: "Herdr returned no valid same-identity agent_info envelope." });

	const wrong = createHerdrAdapter(async (_command, args) => {
		if (args[1] === "get") return result(agentEnvelope("idle", { terminal_id: "terminal-reused-by-other-agent" }));
		return result("", JSON.stringify({ id: "cli:agent:wait", error: { code: "server_unavailable", message: "server unavailable" } }), 1);
	});
	deepStrictEqual(await wrong.inspectManagedAgent!(identity), { kind: "unavailable", diagnostic: "Herdr returned no valid same-identity agent_info envelope." });
	deepStrictEqual(await wrong.waitForManagedAgent!(identity, 500, new AbortController().signal), { kind: "unavailable", diagnostic: "server unavailable" });

	const aborted = createHerdrAdapter(async (_command, _args, options) => {
		observedSignal = options?.signal;
		throw Object.assign(new Error("aborted"), { name: "AbortError" });
	});
	const controller = new AbortController();
	deepStrictEqual(await aborted.waitForManagedAgent!(identity, 500, controller.signal), { kind: "cancelled" });
	equal(observedSignal, controller.signal);
});

it.sequential("rejects non-Pi and still-working wait envelopes", async () => {
	const nonPi = createHerdrAdapter(async () => result(agentEnvelope("idle", { agent: "claude" })));
	ok((await nonPi.inspectManagedAgent!(identity)).kind === "unavailable");
	const stillWorking = createHerdrAdapter(async (_command, args) => args[1] === "wait" ? result(agentEnvelope("working", {}, "cli:agent:wait")) : result(agentEnvelope("working")));
	const value = await stillWorking.waitForManagedAgent!(identity, 500, new AbortController().signal);
	deepStrictEqual(value, { kind: "unavailable", diagnostic: "Herdr wait returned a still-working agent; no busy-loop was started." });
});
