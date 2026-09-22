import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function readRepositoryFile(path: string): Promise<string> {
	return readFile(join(repositoryRoot, path), "utf8");
}

describe("ticket-20 install and documentation contract", () => {
	it("keeps the package manifest, registration surface, and operator guide truthful", async () => {
		const manifest = JSON.parse(await readRepositoryFile("package.json")) as Record<string, unknown>;
		const readme = await readRepositoryFile("README.md");
		const extension = await readRepositoryFile("src/extension.ts");
		const scripts = manifest.scripts as Record<string, string>;

		expect(manifest).toMatchObject({
			name: "pi-herdr-steward",
			version: "0.1.0",
			type: "module",
			files: ["src"],
			engines: { node: ">=22.19.0" },
			pi: { extensions: ["./src/extension.ts"] },
			peerDependencies: { "@earendil-works/pi-coding-agent": "^0.84.4" },
		});
		expect(manifest.dependencies).toBeUndefined();
		expect(manifest.bin).toBeUndefined();
		expect(manifest.installConfig).toBeUndefined();
		expect(scripts.preinstall).toBeUndefined();
		expect(scripts.install).toBeUndefined();
		expect(scripts.postinstall).toBeUndefined();
		expect(scripts["test:install-docs"]).toBe("vitest run test/install-functional-path.static.test.ts --maxWorkers=1");
		expect(scripts["test:install-functional"]).toBe("node --experimental-strip-types test/install-functional-path.smoke.ts");
		expect(scripts["smoke:herdr-real"]).toBe("node --experimental-strip-types scripts/smoke-real-herdr.mjs");

		expect(extension.match(/registerCommand\("steward"/g) ?? []).toHaveLength(1);
		for (const command of ["status", "config", "start", "revise", "resume", "doctor", "cancel", "cleanup"]) {
			expect(extension).toContain(`name: "${command}"`);
		}
		for (const flag of ["--takeover", "--probe"]) expect(extension).toContain(`value: "${flag}"`);

		for (const heading of ["## Prerequisites", "## Installation", "## Command surface", "## Authority and Model Plan", "## Evidence and recovery", "## Safety limits"]) {
			expect(readme).toContain(heading);
		}
		for (const command of [
			"pi install npm:pi-herdr-steward@0.1.0 -l",
			"pi install git:github.com/1am2syman/pi-herdr-steward@<tag-or-full-commit-sha> -l",
			"pi install /absolute/path/to/pi-herdr-steward -l",
			"/steward status",
			"/steward config",
			"/steward start",
			"/steward revise",
			"/steward resume",
			"/steward resume --takeover",
			"/steward doctor",
			"/steward doctor --probe",
			"/steward cancel",
			"/steward cleanup",
		]) {
			expect(readme).toContain(command);
		}

		for (const phrase of [
			"Node `>=22.19.0`",
			"@earendil-works/pi-coding-agent",
			"`pi`, `herdr`, and `git`",
			"interactive Pi TUI",
			"must exist in the npm registry",
			"canonical public remote",
			"Source-checkout verification",
			"Run Journal owns intended",
			"Herdr owns live agent and process state",
			"Git plus durable",
			"provider/model-id",
			"ordered fallbacks",
			"active-run.json",
			"active-run.previous.json",
			"runs/<run-id>/activity.log",
			"runs/<run-id>/tasks/<task-id>/attempts/<attempt-id>/{assignment.json,report.md,evidence/}",
			"runs/<run-id>/completion/final-verification/<verification-id>/{output.log,result.json}",
			"archives/<run-id>/",
			"activity log is chronological human",
			"recovery never replays it",
			"persists intent before side effects",
			"preserves conflicts",
			"can contain source or secrets",
			"automatic interception",
			"never pushes or deploys",
			"force-resets",
			"stashes or incorporates unrelated",
			"adopts foreign",
		]) {
			expect(readme).toContain(phrase);
		}

		expect(readme).toContain("The repository smoke is offline");
		expect(readme).toContain("`-l` writes project-local Pi package configuration");
		expect(readme).toContain("Reviewer independence prefers a different provider");
		expect(readme).toContain("do not export full logs casually");
	});
});
