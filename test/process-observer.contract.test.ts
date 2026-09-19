import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createProcessAdapter } from "../src/adapters.ts";
import type { ExecResult } from "@earendil-works/pi-coding-agent";

const identity = { name: "steward-b-abcdef12-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" };

function result(stdout: string, overrides: Partial<ExecResult> = {}): ExecResult {
	return { stdout, stderr: "", code: 0, killed: false, ...overrides } as ExecResult;
}

function processInfo(processes: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		id: "cli:pane:process_info",
		result: {
			type: "pane_process_info",
			pane_id: "pane-1",
			shell_pid: 101,
			foreground_process_group_id: 101,
			processes,
			...overrides,
		},
	});
}

function managedProcesses(): Array<Record<string, unknown>> {
	return [
		{ pid: 101, ppid: 1, process_group_id: 101, cwd: "/repo", argv: ["bash"], cmdline: "bash", executable_name: "bash" },
		{ pid: 102, ppid: 101, process_group_id: 101, cwd: "/repo", argv: ["pi", "--model", "builder/primary"], cmdline: "pi --model builder/primary", executable_name: "pi" },
	];
}

describe("ticket-11 process observer boundary", () => {
	it("uses the exact Herdr process-info command and classifies a managed pane as no external process", async () => {
		const calls: Array<{ command: string; args: string[]; options?: { cwd?: string; timeout?: number } }> = [];
		const adapter = createProcessAdapter(async (command, args, options) => {
			calls.push({ command, args, options });
			return result(processInfo(managedProcesses()));
		});

		expect(await adapter.inspectAttemptProcesses!({ repositoryRoot: "/repo", identity })).toMatchObject({
		kind: "none",
		paneId: "pane-1",
		shellPid: 101,
		foregroundProcessGroupId: 101,
		processCount: 2,
		digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
		});
		expect(calls).toEqual([{ command: "herdr", args: ["pane", "process-info", "--pane", "pane-1"], options: { cwd: "/repo", timeout: 5_000 } }]);
	});

	it.each([
		["vitest", "test"],
		["tsc", "build"],
		["node", "child"],
	] as const)("classifies the foreground external executable %s as %s", async (executableName, classification) => {
		const adapter = createProcessAdapter(async () => result(processInfo([
			...managedProcesses().slice(0, 1),
			{ pid: 202, ppid: 101, process_group_id: 101, cwd: "/repo", argv: [executableName], cmdline: executableName, executable_name: executableName },
		] )));
		const observed = await adapter.inspectAttemptProcesses!({ repositoryRoot: "/repo", identity });
		expect(observed).toMatchObject({ kind: "live-external", paneId: "pane-1", classification, executableName });
	});

	it("does not adopt malformed, mismatched, killed, or unsafe process observations", async () => {
		let calls = 0;
		const malformed = createProcessAdapter(async () => {
			calls += 1;
			return result(processInfo([{ ...managedProcesses()[0], unknown: true }]));
		});
		expect((await malformed.inspectAttemptProcesses!({ repositoryRoot: "/repo", identity })).kind).toBe("unavailable");

		const wrongPane = createProcessAdapter(async () => result(processInfo(managedProcesses(), { pane_id: "pane-other" })));
		expect((await wrongPane.inspectAttemptProcesses!({ repositoryRoot: "/repo", identity })).kind).toBe("unavailable");

		const killed = createProcessAdapter(async () => result(processInfo(managedProcesses()), { killed: true }));
		expect((await killed.inspectAttemptProcesses!({ repositoryRoot: "/repo", identity })).kind).toBe("unavailable");

		const unsafe = createProcessAdapter(async () => { calls += 1; return result(processInfo(managedProcesses())); });
		expect((await unsafe.inspectAttemptProcesses!({ repositoryRoot: "/repo/../repo", identity })).kind).toBe("unavailable");
		expect(calls).toBe(1);
	});

	it.each([
		"stderr",
		"nonzero-exit",
		"thrown",
		"bad-pid",
		"duplicate-pid",
		"negative-pid",
		"oversized-argv",
		"oversized-cmdline",
		"oversized-cwd",
		"oversized-process-list",
		"malformed-json",
	] as const)("fails closed for process-info %s", async (scenario) => {
		const processes = managedProcesses();
		if (scenario === "bad-pid" || scenario === "negative-pid") processes[0] = { ...processes[0], pid: scenario === "bad-pid" ? 0 : -1 };
		if (scenario === "duplicate-pid") processes[1] = { ...processes[1], pid: processes[0]?.pid };
		if (scenario === "oversized-argv") processes[1] = { ...processes[1], argv: ["x".repeat(4_097)] };
		if (scenario === "oversized-cmdline") processes[1] = { ...processes[1], cmdline: "x".repeat(32_769) };
		if (scenario === "oversized-cwd") processes[1] = { ...processes[1], cwd: `/repo/${"x".repeat(4_096)}` };
		if (scenario === "oversized-process-list") {
			processes.length = 0;
			for (let index = 0; index < 513; index += 1) processes.push({ pid: index + 1, ppid: 1, process_group_id: 1, cwd: "/repo", argv: ["bash"], cmdline: "bash", executable_name: "bash" });
		}
		const execute = async () => {
			if (scenario === "thrown") throw new Error("process observer threw");
			if (scenario === "malformed-json") return result("{");
			if (scenario === "stderr") return result(processInfo(processes), { stderr: "diagnostic" });
			if (scenario === "nonzero-exit") return result(processInfo(processes), { code: 1 });
			return result(processInfo(processes));
		};
		const observed = await createProcessAdapter(execute).inspectAttemptProcesses!({ repositoryRoot: "/repo", identity });
		expect(observed.kind).toBe("unavailable");
	});

	it("reports adapter absence as unavailable without invoking a command", async () => {
		const observed = await createProcessAdapter(undefined).inspectAttemptProcesses!({ repositoryRoot: "/repo", identity });
		expect(observed).toMatchObject({ kind: "unavailable" });
	});

	it("produces a stable bounded digest from normalized process facts", async () => {
		const adapter = createProcessAdapter(async () => result(processInfo(managedProcesses())));
		const observed = await adapter.inspectAttemptProcesses!({ repositoryRoot: "/repo", identity });
		if (observed.kind !== "none") throw new Error("managed process fixture was not classified as none");
		const normalized = managedProcesses().map((item) => ({
			pid: item.pid,
			ppid: item.ppid,
			processGroupId: item.process_group_id,
			cwd: item.cwd,
			argv: item.argv,
			cmdline: item.cmdline,
			executableName: item.executable_name,
		}));
		expect(observed.digest).toBe(`sha256:${createHash("sha256").update(JSON.stringify(normalized), "utf8").digest("hex")}`);
	});
});
