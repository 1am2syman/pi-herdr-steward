import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHerdrAdapter } from "../src/adapters.ts";

function objectValue(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Herdr returned a non-object response.");
	return value;
}

function exactIdentity(value, label) {
	const object = objectValue(value);
	const fields = ["name", "workspace_id", "pane_id", "terminal_id"];
	for (const field of fields) {
		if (typeof object[field] !== "string" || object[field].length === 0 || object[field].trim() !== object[field]) throw new Error(`${label} did not return an exact ${field}.`);
	}
	return { name: object.name, workspaceId: object.workspace_id, paneId: object.pane_id, terminalId: object.terminal_id };
}

function sameIdentity(left, right) {
	return left.name === right.name && left.workspaceId === right.workspaceId && left.paneId === right.paneId && left.terminalId === right.terminalId;
}

function resultObject(envelope) {
	return objectValue(envelope.result);
}

function boundedDiagnostic(value) {
	return String(value ?? "").trim().slice(0, 500);
}

function commandRunner() {
	return (command, args, options = {}) => {
		if (command === "herdr" && args[0] === "agent" && args[1] === "prompt" && args[3] !== "/quit") {
			throw new Error("The real-Herdr smoke permits only the exact /quit prompt payload.");
		}
		return new Promise((resolve, reject) => {
			const child = spawn(command, args, {
				cwd: options.cwd,
				env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" },
				stdio: ["ignore", "pipe", "pipe"],
				signal: options.signal,
			});
			let stdout = "";
			let stderr = "";
			let killed = false;
			let timer;
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk) => { stdout += chunk; });
			child.stderr.on("data", (chunk) => { stderr += chunk; });
			if (options.timeout !== undefined) timer = setTimeout(() => { killed = true; child.kill("SIGTERM"); }, options.timeout);
			child.once("error", (error) => {
				if (timer) clearTimeout(timer);
				reject(error);
			});
			child.once("close", (code) => {
				if (timer) clearTimeout(timer);
				resolve({ code: code ?? 1, killed, stdout, stderr });
			});
		});
	};
}

async function runJson(command, args, cwd) {
	const result = await new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" }, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("error", reject);
		child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});
	if (result.code !== 0 || result.stderr.trim().length > 0) throw new Error(`${command} ${args.slice(0, 3).join(" ")} failed (${result.code}): ${boundedDiagnostic(result.stderr)}`);
	try { return objectValue(JSON.parse(result.stdout)); } catch { throw new Error(`${command} returned malformed JSON.`); }
}

async function runSuccessful(command, args, cwd) {
	const result = await new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" }, stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("error", reject);
		child.once("close", (code) => resolve({ code: code ?? 1, stderr }));
	});
	if (result.code !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.code}): ${boundedDiagnostic(result.stderr)}`);
}

function workspaceIdentity(envelope) {
	if (envelope.id !== "cli:workspace:create") throw new Error("Herdr workspace create returned the wrong response id.");
	const result = resultObject(envelope);
	if (result.type !== "workspace_created") throw new Error("Herdr workspace create did not acknowledge workspace_created.");
	const workspace = objectValue(result.workspace);
	const tab = objectValue(result.tab);
	const pane = objectValue(result.root_pane);
	if (typeof workspace.workspace_id !== "string" || typeof tab.tab_id !== "string") throw new Error("Herdr workspace create omitted workspace or tab identity.");
	if (typeof pane.pane_id !== "string" || typeof pane.terminal_id !== "string") throw new Error("Herdr workspace create omitted root pane or terminal identity.");
	return { workspaceId: workspace.workspace_id, tabId: tab.tab_id, paneId: pane.pane_id, terminalId: pane.terminal_id };
}

function startedIdentity(envelope, expected) {
	if (envelope.id !== "cli:agent:start") throw new Error("Herdr agent start returned the wrong response id.");
	const result = resultObject(envelope);
	if (result.type !== "agent_started") throw new Error("Herdr agent start did not acknowledge agent_started.");
	const agent = objectValue(result.agent);
	if (agent.agent !== "pi") throw new Error("Herdr started a non-Pi agent.");
	const actual = exactIdentity({ name: agent.name, workspace_id: agent.workspace_id, pane_id: agent.pane_id, terminal_id: agent.terminal_id }, "agent start");
	if (!sameIdentity(actual, expected)) throw new Error("Herdr agent start returned an identity outside the owned workspace/pane.");
	return actual;
}

function closedWorkspace(envelope, workspaceId) {
	if (envelope.id !== "cli:workspace:close") throw new Error("Herdr workspace close returned the wrong response id.");
	const result = resultObject(envelope);
	if (result.type === "ok") return;
	if (result.type !== "workspace_closed") throw new Error("Herdr workspace close did not acknowledge workspace_closed.");
	const actual = typeof result.closed_workspace_id === "string" ? result.closed_workspace_id : typeof result.workspace_id === "string" ? result.workspace_id : objectValue(result.workspace).workspace_id;
	if (actual !== workspaceId) throw new Error("Herdr closed a workspace other than the one created by this smoke.");
}

async function waitForMissing(adapter, identity) {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const inspection = await adapter.inspectManagedAgent(identity);
		if (inspection.kind === "missing") return;
		if (inspection.kind === "unclear" && inspection.availability === "unavailable") throw new Error(`Herdr agent disappearance became unavailable: ${inspection.diagnostic}`);
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error("Owned Herdr agent did not disappear after the exact /quit lifecycle command.");
}

async function main() {
	if (process.env.HERDR_ENV !== "1") throw new Error("Set HERDR_ENV=1 to run the real-Herdr acceptance smoke.");
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-real-"));
	await mkdir(root, { recursive: true });
	const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
	const workspaceLabel = `ticket20-real-${suffix}`;
	const agentName = `ticket20-real-agent-${suffix}`;
	const adapter = createHerdrAdapter(commandRunner());
	let workspace;
	let agent;
	let stopAttempted = false;
	try {
		const availability = await adapter.checkAvailability(root);
		if (availability.kind !== "available" || availability.status !== "running" || availability.compatible !== true || availability.endpointCompatible !== true) throw new Error("Herdr server is not endpoint-compatible.");
		await runSuccessful("pi", ["--version"], root);

		const created = await runJson("herdr", ["workspace", "create", "--cwd", root, "--label", workspaceLabel, "--no-focus"], root);
		workspace = workspaceIdentity(created);
		const expected = { name: agentName, workspaceId: workspace.workspaceId, paneId: workspace.paneId, terminalId: workspace.terminalId };
		const started = await runJson("herdr", ["agent", "start", agentName, "--kind", "pi", "--pane", workspace.paneId, "--timeout", "30000", "--", "--offline", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files"], root);
		agent = startedIdentity(started, expected);
		const observed = await adapter.inspectManagedAgent(agent);
		if (observed.kind !== "observed" || !sameIdentity(observed.identity, agent)) throw new Error("Production Herdr inspection did not return the exact owned identity.");
		const settled = await adapter.waitForManagedAgent(agent, 30_000, new AbortController().signal);
		if (settled.kind !== "settled" || !sameIdentity(settled.identity, agent) || !["idle", "done", "blocked", "unknown"].includes(settled.lifecycle)) throw new Error("Production Herdr wait did not return the exact agent in a settled lifecycle.");

		stopAttempted = true;
		const stopped = await adapter.stopAgentGracefully({ repositoryRoot: root, ...agent });
		if (stopped.kind !== "acknowledged" || !sameIdentity(stopped, agent)) throw new Error("The exact owned agent did not acknowledge the local /quit lifecycle command.");
		await waitForMissing(adapter, agent);
		console.log(`smoke-real-herdr: passed (${workspaceLabel}; agent ${agentName} stopped, workspace closed in finally)`);
	} finally {
		if (workspace && !stopAttempted && agent) {
			try { await adapter.stopAgentGracefully({ repositoryRoot: root, ...agent }); } catch { /* workspace close remains the bounded cleanup action */ }
		}
		if (workspace) {
			const closed = await runJson("herdr", ["workspace", "close", workspace.workspaceId], root);
			closedWorkspace(closed, workspace.workspaceId);
		}
		await rm(root, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(`smoke-real-herdr: failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
