import { removeFixture } from "./remove-fixture.ts";
import { strict as assert } from "node:assert";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { driveTicket08CompletionFlow, type Ticket08ExtensionRegistrar } from "./ticket08-archive-fixture.ts";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const finalHead = "2222222222222222222222222222222222222222";

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject {
	assert.equal(typeof value, "object");
	assert.notEqual(value, null);
	assert.equal(Array.isArray(value), false);
	return value as JsonObject;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function snapshot(path: string): Promise<Buffer | undefined> {
	return readFile(path).catch(() => undefined);
}

async function assertUnchanged(path: string, before: Buffer | undefined): Promise<void> {
	const after = await snapshot(path);
	assert.equal(after?.equals(before ?? Buffer.alloc(0)) ?? before === undefined, true, `Unexpected write outside the isolated smoke root: ${path}`);
}

async function listFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) files.push(...(await listFiles(path)).map((child) => join(entry.name, child)));
		else files.push(entry.name);
	}
	return files.sort();
}

async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
	const result = await execFile(command, args, { cwd, env, maxBuffer: 8 * 1024 * 1024 });
	return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

function packageEntry(value: unknown): string {
	assert.ok(Array.isArray(value), "npm pack did not return an array");
	const entry = objectValue(value[0]);
	assert.equal(typeof entry.filename, "string");
	return entry.filename as string;
}

function packageSourceMatches(value: unknown, packageRoot: string, projectRoot: string): boolean {
	const source = typeof value === "string" ? value : objectValue(value).source;
	if (typeof source !== "string") return false;
	if (source === packageRoot) return true;
	if (source.startsWith("file:")) {
		try { return fileURLToPath(source) === packageRoot; } catch { return false; }
	}
	return resolve(join(projectRoot, ".pi"), source) === packageRoot;
}

async function requestPiCommands(projectRoot: string, env: NodeJS.ProcessEnv): Promise<JsonObject> {
	const child = spawn("pi", ["--offline", "--mode", "rpc", "--no-session", "--no-tools", "--no-skills", "--no-context-files", "--approve"], {
		cwd: projectRoot,
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => { stderr += chunk; });
	child.stdout.setEncoding("utf8");

	const response = await new Promise<JsonObject>((resolveResponse, reject) => {
		const requestId = "ticket20-command-discovery";
		let buffer = "";
		let found: JsonObject | undefined;
		let closed = false;
		const timeout = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error(`Pi RPC command discovery timed out. stderr: ${stderr}`));
		}, 30_000);

		const finish = (error?: Error): void => {
			if (closed) return;
			closed = true;
			clearTimeout(timeout);
			if (error) reject(error);
			else if (found) resolveResponse(found);
			else reject(new Error(`Pi RPC exited before command discovery. stderr: ${stderr}`));
		};

		child.on("error", (error) => finish(error));
		child.on("close", (code, signal) => {
			if (!found && code !== 0) finish(new Error(`Pi RPC exited with code ${code ?? "null"}, signal ${signal ?? "none"}. stderr: ${stderr}`));
			else finish();
		});
		child.stdout.on("data", (chunk: string) => {
			buffer += chunk;
			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				if (line.length === 0) continue;
				let parsed: unknown;
				try { parsed = JSON.parse(line); } catch { continue; }
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					const value = parsed as JsonObject;
					if (value.id === requestId && value.type === "response" && value.command === "get_commands") {
						found = value;
						child.kill("SIGTERM");
					}
				}
			}
		});
		child.stdin.write(`${JSON.stringify({ id: requestId, type: "get_commands" })}\n`);
		child.stdin.end();
	});

	assert.equal(response.success, true, `Pi RPC command discovery failed: ${JSON.stringify(response)}`);
	return response;
}

async function assertMissing(path: string): Promise<void> {
	assert.equal(await exists(path), false, `Expected durable pointer to be removed: ${path}`);
}

async function smoke(): Promise<void> {
		const root = await mkdtemp(join("/tmp", "pi-herdr-steward-t20-"));
		const packDirectory = join(root, "pack");
		const packageDirectory = join(root, "package");
		const projectDirectory = join(root, "project");
		const agentDirectory = join(root, "agent");
		const npmCacheDirectory = join(root, "npm-cache");
		const globalSettingsPath = join(process.env.HOME ?? "/root", ".pi", "agent", "settings.json");
		const globalTrustPath = join(process.env.HOME ?? "/root", ".pi", "agent", "trust.json");
		const globalSettings = await snapshot(globalSettingsPath);
		const globalTrust = await snapshot(globalTrustPath);
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PI_CODING_AGENT_DIR: agentDirectory,
			PI_OFFLINE: "1",
			PI_TELEMETRY: "0",
			PI_SKIP_VERSION_CHECK: "1",
			NPM_CONFIG_OFFLINE: "true",
			NPM_CONFIG_CACHE: npmCacheDirectory,
			GIT_TERMINAL_PROMPT: "0",
		};

		try {
			await Promise.all([packDirectory, packageDirectory, projectDirectory, agentDirectory, npmCacheDirectory].map((path) => mkdir(path, { recursive: true })));

			const packed = await run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory], repositoryRoot, env);
			const tarballName = packageEntry(JSON.parse(packed.stdout) as unknown);
			const tarballPath = isAbsolute(tarballName) ? tarballName : join(packDirectory, tarballName);
			assert.equal(await exists(tarballPath), true);
			const listing = (await run("tar", ["-tzf", tarballPath], repositoryRoot, env)).stdout.split("\n").map((entry) => entry.trim()).filter(Boolean);
			for (const required of ["package/package.json", "package/README.md", "package/src/extension.ts"]) assert.equal(listing.includes(required), true, `Packed artifact omitted ${required}`);
			for (const prefix of ["package/test/", "package/scripts/", "package/plans/", "package/reports/", "package/logs/", "package/.scratch/", "package/.pi/"]) {
				assert.equal(listing.some((entry) => entry.startsWith(prefix)), false, `Packed artifact leaked ${prefix}`);
			}
			await run("tar", ["-xzf", tarballPath, "-C", packageDirectory, "--strip-components=1"], repositoryRoot, env);

			await run("pi", ["install", packageDirectory, "-l", "--approve"], projectDirectory, env);
			const settingsPath = join(projectDirectory, ".pi", "settings.json");
			const settings = objectValue(JSON.parse(await readFile(settingsPath, "utf8")) as unknown);
			const packages = settings.packages;
			assert.ok(Array.isArray(packages), "Project-local Pi settings did not record packages");
			assert.equal(packages.some((value) => packageSourceMatches(value, packageDirectory, projectDirectory)), true, "Project-local Pi settings did not name the unpacked package");
			await assertUnchanged(globalSettingsPath, globalSettings);
			await assertUnchanged(globalTrustPath, globalTrust);

			const response = await requestPiCommands(projectDirectory, env);
			const data = objectValue(response.data);
			const commands = data.commands;
			assert.ok(Array.isArray(commands), "Pi RPC returned no command list");
			const stewardCommands = commands.filter((value) => {
				if (!value || typeof value !== "object" || Array.isArray(value)) return false;
				const command = value as JsonObject;
				return command.name === "steward" && command.source === "extension";
			});
			assert.equal(stewardCommands.length, 1, "Installed Pi package did not register exactly one steward command");
			const sourceInfo = objectValue(objectValue(stewardCommands[0]).sourceInfo);
			assert.equal(sourceInfo.path, join(packageDirectory, "src", "extension.ts"), "Pi loaded a different extension path than the unpacked artifact");

			const repositoryNodeModules = join(repositoryRoot, "node_modules");
			assert.equal(await exists(repositoryNodeModules), true, "Repository dependencies are required for the installed extension import probe");
			await symlink(repositoryNodeModules, join(packageDirectory, "node_modules"), "dir");
			const installedModule = await import(`${pathToFileURL(join(packageDirectory, "src", "extension.ts")).href}?ticket20=${Date.now()}`);
			assert.equal(typeof installedModule.registerStewardExtension, "function", "Unpacked extension did not expose the registration seam");

			const originalFetch = globalThis.fetch;
			let networkCalls = 0;
			globalThis.fetch = (async () => {
				networkCalls += 1;
				throw new Error("Network access is forbidden in the deterministic install smoke.");
			}) as typeof globalThis.fetch;
			let flow;
			try {
				flow = await driveTicket08CompletionFlow(projectDirectory, installedModule.registerStewardExtension as Ticket08ExtensionRegistrar);
			} finally {
				globalThis.fetch = originalFetch;
			}
			assert.equal(networkCalls, 0, "The fake-adapter full-Run path made a network request");

			assert.equal(flow.effects.confirmations, 1);
			const confirmation = flow.effects.confirmationSummaries?.[0];
			assert.ok(confirmation, "The full Run was not explicitly confirmed");
			assert.equal(confirmation.modelPlan.builder.primary.model, "builder/model");
			assert.equal(confirmation.modelPlan.reviewer.primary.model, "reviewer/model");
			assert.equal(flow.effects.merges, 1);
			assert.equal(flow.effects.processes, 1);
			assert.equal(flow.effects.stops.length, 2);
			assert.equal(new Set(flow.effects.stops).size, 2);
			assert.equal(flow.effects.notifications, 1);
			assert.equal(flow.effects.archives, 1);

			const archiveRunPath = join(flow.archiveDirectory, "run.json");
			const archived = objectValue(JSON.parse(await readFile(archiveRunPath, "utf8")) as unknown);
			const archivedRun = objectValue(archived.run);
			assert.equal(archivedRun.status, "completed");
			assert.equal(objectValue(archivedRun.completion).phase, "archived");
			const task = objectValue((archivedRun.tasks as unknown[])[0]);
			const attempts = task.attempts as unknown[];
			assert.deepEqual(attempts.map((value) => objectValue(value).role), ["builder", "reviewer"]);
			const builder = objectValue(attempts[0]);
			const reviewer = objectValue(attempts[1]);
			assert.equal(objectValue(reviewer.subject).kind, "git");
			assert.equal(objectValue(reviewer.subject).headRevision, finalHead);
			assert.equal(objectValue(objectValue(task.approval).subject).headRevision, finalHead);
			for (const attempt of [builder, reviewer]) {
				const evidence = objectValue(objectValue(attempt.evidence));
				assert.equal(evidence.phase, "finalized");
				const manifestPath = evidence.manifestPath;
				assert.equal(typeof manifestPath, "string");
				assert.equal(isAbsolute(manifestPath as string), true);
				assert.equal(await exists(manifestPath as string), true, `Finalized evidence was not retained: ${manifestPath as string}`);
			}
			const completion = objectValue(archivedRun.completion);
			const archive = objectValue(completion.archive);
			const verification = objectValue(archive.verification);
			for (const hash of [verification.logSha256, verification.resultSha256]) assert.match(String(hash), /^sha256:[0-9a-f]{64}$/);
			for (const path of [verification.logPath, verification.resultPath]) {
				assert.equal(typeof path, "string");
				assert.equal(await exists(path as string), true, `Final-verification evidence was not retained: ${path as string}`);
			}
			const execution = objectValue(archivedRun.finalVerificationExecution);
			assert.equal(execution.phase, "passed");
			assert.match(String(execution.logSha256), /^sha256:[0-9a-f]{64}$/);
			assert.match(String(execution.resultSha256), /^sha256:[0-9a-f]{64}$/);
			assert.equal(await exists(join(flow.archiveDirectory, "previous-run.json")), true);
			assert.equal(await exists(join(flow.archiveDirectory, "manifest.json")), true);
			assert.equal(await exists(join(flow.archiveDirectory, "reports", "task-01", "attempt-01-builder.md")), true);
			assert.equal(await exists(join(flow.archiveDirectory, "reports", "task-01", "attempt-02-reviewer.md")), true);
			assert.equal((await listFiles(flow.archiveDirectory)).some((path) => path.endsWith("attempt-01-builder.md")), true);
			assert.equal((await listFiles(flow.archiveDirectory)).some((path) => path.endsWith("attempt-02-reviewer.md")), true);
			await assertMissing(join(projectDirectory, ".pi", "steward", "active-run.json"));
			await assertMissing(join(projectDirectory, ".pi", "steward", "active-run.previous.json"));
			assert.equal(relative(root, projectDirectory).startsWith(".."), false);
			assert.equal(relative(root, packageDirectory).startsWith(".."), false);
			assert.equal(relative(root, agentDirectory).startsWith(".."), false);
		} finally {
			await removeFixture(root);
		}
}

smoke().catch((error: unknown) => {
	console.error(`ticket-20 install smoke failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
	process.exitCode = 1;
});
