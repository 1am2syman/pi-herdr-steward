import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { it } from "vitest";

import { createHerdrAdapter } from "../src/adapters.ts";
import { parseTaskFactRequest, resolveTaskFactAnswer } from "../src/reconciliation.ts";
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

function errorEnvelope(code: string, message = code, id = "cli:agent:get"): string {
	return JSON.stringify({ id, error: { code, message } });
}

function sentEnvelope(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		id: "cli:agent:send-keys",
		result: {
			type: "agent_keys_sent",
			agent: {
				name: identity.name,
				workspace_id: identity.workspaceId,
				pane_id: identity.paneId,
				terminal_id: identity.terminalId,
				...overrides,
			},
		},
	});
}

function promptEnvelope(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		id: "cli:agent:prompt",
		result: {
			type: "agent_prompted",
			agent: {
				name: identity.name,
				workspace_id: identity.workspaceId,
				tab_id: "tab-1",
				pane_id: identity.paneId,
				terminal_id: identity.terminalId,
				...overrides,
			},
		},
	});
}

it.sequential("normalizes only exact recorded Pi lifecycle envelopes", async () => {
	for (const lifecycle of ["working", "blocked", "idle", "done", "unknown"] as const) {
		const adapter = createHerdrAdapter(async (_command, args) => args[1] === "get" ? result(agentEnvelope(lifecycle)) : result());
		deepStrictEqual(await adapter.inspectManagedAgent!(identity), { kind: "observed", identity, lifecycle, stateChangeSequence: 41 });
	}
});

it.sequential("distinguishes exact agent_not_found from every other unclear response", async () => {
	const missing = createHerdrAdapter(async () => result("", errorEnvelope("agent_not_found", "recorded agent is gone"), 1));
	deepStrictEqual(await missing.inspectManagedAgent!(identity), { kind: "missing", diagnostic: "recorded agent is gone" });
	for (const run of [
		async () => result("", errorEnvelope("server_unavailable", "server unavailable"), 1),
		async () => result("", errorEnvelope("agent_not_found", "wrong exit"), 2),
		async () => { throw new Error("runner failed"); },
		async () => result("", "", 1, true),
		async () => result("not-json"),
		async () => result(agentEnvelope("idle", { agent: "claude" })),
		async () => result(agentEnvelope("idle", { terminal_id: "other-terminal" })),
	]) {
		const adapter = createHerdrAdapter(async () => run());
		equal((await adapter.inspectManagedAgent!(identity)).kind, "unclear");
	}
});

it.sequential("parses one canonical bounded Task-fact request and rejects prose or ambiguity", async () => {
	const canonical = 'STEWARD_TASK_FACT_REQUEST {"schemaVersion":1,"field":"reportPath"}';
	const parsed = parseTaskFactRequest(canonical, "builder");
	ok(parsed.kind === "fact-request");
	if (parsed.kind === "fact-request") match(parsed.request.questionSha256, /^sha256:[0-9a-f]{64}$/);
	equal(parseTaskFactRequest(`before\n${canonical}`, "builder").kind, "unstructured");
	equal(parseTaskFactRequest(`${canonical}\n${canonical}`, "builder").kind, "unstructured");
	equal(parseTaskFactRequest('STEWARD_TASK_FACT_REQUEST {"field":"reviewSubject","schemaVersion":1}', "builder").kind, "unstructured");
	equal(parseTaskFactRequest("plain question", "builder").kind, "unstructured");
	equal(parseTaskFactRequest("x".repeat(16 * 1024 + 1), "builder").kind, "unclear");
	const answer = resolveTaskFactAnswer("reportPath", "/tmp/report.md");
	ok(answer.kind === "answer");
	if (answer.kind === "answer") match(answer.answer.answer, /^STEWARD_TASK_FACT_ANSWER [A-Za-z0-9_-]+$/);
});

it.sequential("uses bounded detection, exact identity preflight, and fixed answer keys", async () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	const request = 'STEWARD_TASK_FACT_REQUEST {"schemaVersion":1,"field":"reportPath"}';
	const adapter = createHerdrAdapter(async (command, args) => {
		calls.push({ command, args });
		if (args[1] === "get") return result(agentEnvelope("blocked"));
		if (args[1] === "read") return result(request);
		if (args[1] === "send-keys") return result(sentEnvelope());
		return result();
	});
	deepStrictEqual(await adapter.readBlockedTaskFactRequest!(identity, "builder"), {
		kind: "fact-request",
		request: {
			schemaVersion: 1,
			field: "reportPath",
			canonical: request,
			questionSha256: "sha256:685bb41c8079a9e428d7418246d74c01a609f2a0fb3d9cf39b34af2ab3f4b3dd",
		},
	});
	const resolved = resolveTaskFactAnswer("reportPath", "/tmp/report.md");
	if (resolved.kind !== "answer") throw new Error("missing answer fixture");
	deepStrictEqual(await adapter.answerBlockedTaskFact!({ repositoryRoot: "/tmp/repo", identity, answer: resolved.answer.answer }), { kind: "acknowledged", identity });
	deepStrictEqual(calls, [
		{ command: "herdr", args: ["agent", "get", identity.name] },
		{ command: "herdr", args: ["agent", "read", identity.name, "--source", "detection", "--lines", "200"] },
		{ command: "herdr", args: ["agent", "get", identity.name] },
		{ command: "herdr", args: ["agent", "send-keys", identity.name, resolved.answer.answer, "enter"] },
	]);
	const invalidCalls: string[][] = [];
	const invalid = createHerdrAdapter(async (_command, args) => { invalidCalls.push(args); return result(); });
	deepStrictEqual(await invalid.answerBlockedTaskFact!({ repositoryRoot: "/tmp/repo", identity, answer: "raw shell command" }), { kind: "failed", message: "Task-fact answer is not a bounded canonical payload." });
	deepStrictEqual(invalidCalls, []);
});

it.sequential("requests one fixed report prompt and rejects wrong resources", async () => {
	const calls: string[][] = [];
	const adapter = createHerdrAdapter(async (_command, args) => { calls.push(args); return result(promptEnvelope()); });
	const value = await adapter.requestAttemptReport!({ repositoryRoot: "/tmp/repo", identity, role: "builder", reportPath: "/tmp/report.md", assignmentPath: "/tmp/assignment.json", evidenceDirectory: "/tmp/evidence" });
	deepStrictEqual(value, { kind: "prompted", name: identity.name, workspaceId: identity.workspaceId, tabId: "tab-1", paneId: identity.paneId, terminalId: identity.terminalId });
	deepStrictEqual(calls[0]?.slice(0, 3), ["agent", "prompt", identity.name]);
	ok(calls[0]?.[3]?.includes("/tmp/report.md"));
	const wrong = createHerdrAdapter(async () => result(promptEnvelope({ pane_id: "other-pane" })));
	equal((await wrong.requestAttemptReport!({ repositoryRoot: "/tmp/repo", identity, role: "builder", reportPath: "/tmp/report.md", assignmentPath: "/tmp/assignment.json", evidenceDirectory: "/tmp/evidence" })).kind, "failed");
	ok(calls.every((call) => !["list", "focus", "attach", "rename", "interrupt", "stop"].includes(call[1] ?? "")));
});
