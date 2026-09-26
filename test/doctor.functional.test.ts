import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { it } from "vitest";

import {
	classifyModelProbe,
	formatDoctorReport,
	runStewardDoctor,
	type ModelProbeResult,
} from "../src/doctor.ts";
import type { ModelChoice, ProjectModelPlans } from "../src/config.ts";
import type { ActiveRunLoadResult } from "../src/run-journal-store.ts";

const plans: ProjectModelPlans = {
	builder: {
		primary: { model: "provider/shared", thinkingLevel: "high" },
		fallbacks: [{ model: "provider/fallback", thinkingLevel: "medium" }],
	},
	reviewer: {
		primary: { model: "provider/shared", thinkingLevel: "low" },
		fallbacks: [{ model: "provider/quota", thinkingLevel: "high" }],
	},
};

function baseInput() {
	return {
		repositoryRoot: "/repo",
		runJournal: {
			async loadRecoveryDefaults() { return { value: { valid: true }, diagnostics: [], path: "/agent/steward/defaults.json" }; },
			async loadModelPlans() { return { value: plans, diagnostics: [], path: "/repo/.pi/steward/defaults.json" }; },
			async loadActive() { return { kind: "missing" } as ActiveRunLoadResult; },
		},
		herdr: { async checkAvailability() { return { kind: "available" as const, status: "running" }; } },
		now: () => new Date("2026-01-02T03:04:05.000Z"),
	};
}

it("runs static doctor checks without making live provider requests", async () => {
	let probes = 0;
	const report = await runStewardDoctor({
		...baseInput(),
		probe: false,
		model: {
			async inspectModelChoice() { return { available: true, diagnostics: [] }; },
			async probeModelChoice() { probes += 1; return { status: "healthy" as const }; },
		},
	});
	equal(probes, 0);
	equal(report.probeRequested, false);
	equal(report.summary, "healthy");
	ok(report.models.every((model) => model.probe === undefined));
	match(formatDoctorReport(report), /use \/steward doctor --probe/);
});

it("does not probe a model that static inspection reports unavailable", async () => {
	let probes = 0;
	const report = await runStewardDoctor({
		...baseInput(),
		probe: true,
		model: {
			async inspectModelChoice(choice) {
				return choice.model === "provider/fallback" ? { available: false, diagnostics: [] } : { available: true, diagnostics: [] };
			},
			async probeModelChoice() { probes += 1; return { status: "healthy" as const }; },
		},
	});
	equal(report.summary, "issues-found");
	ok(report.models.some((model) => model.staticStatus === "invalid"));
	equal(probes, 2);
});

it("probes each unique selected model once and strictly sequentially", async () => {
	const calls: string[] = [];
	let active = 0;
	let maximumActive = 0;
	const outcomes = new Map<string, ModelProbeResult>([
		["provider/shared", { status: "healthy" }],
		["provider/fallback", { status: "rate-limited", httpStatus: 429, retryAfter: "12" }],
		["provider/quota", { status: "quota-exhausted", httpStatus: 402 }],
	]);
	const report = await runStewardDoctor({
		...baseInput(),
		probe: true,
		model: {
			async inspectModelChoice() { return { available: true, diagnostics: [] }; },
			async probeModelChoice(choice: ModelChoice) {
				calls.push(choice.model);
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				await Promise.resolve();
				active -= 1;
				return outcomes.get(choice.model)!;
			},
		},
	});
	deepStrictEqual(calls, ["provider/shared", "provider/fallback", "provider/quota"]);
	equal(maximumActive, 1);
	equal(report.summary, "issues-found");
	equal(report.models.filter((model) => model.reference === "provider/shared").length, 2);
	ok(report.models.filter((model) => model.reference === "provider/shared").every((model) => model.probe?.status === "healthy"));
	match(formatDoctorReport(report), /rate-limited HTTP 429 retry-after=12/);
});

it("classifies provider health failures and redacts credential-like diagnostics", () => {
	equal(classifyModelProbe({ httpStatus: 429, retryAfter: "30" }).status, "rate-limited");
	equal(classifyModelProbe({ httpStatus: 429, retryAfter: "30\r\nsecret: value" }).retryAfter, "30 secret: value");
	equal(classifyModelProbe({ thrownMessage: "Provider request failed with HTTP 429" }).status, "rate-limited");
	equal(classifyModelProbe({ httpStatus: 402, errorMessage: "billing hard limit" }).status, "quota-exhausted");
	equal(classifyModelProbe({ httpStatus: 401 }).status, "auth-failed");
	equal(classifyModelProbe({ httpStatus: 503 }).status, "temporarily-unavailable");
	equal(classifyModelProbe({ httpStatus: 400 }).status, "incompatible-request");
	const classified = classifyModelProbe({ stopReason: "error", errorMessage: "apiKey=supersecret Bearer also-secret unexpected provider failure" });
	equal(classified.status, "unknown-error");
	ok(!JSON.stringify(classified).includes("supersecret"));
	ok(!JSON.stringify(classified).includes("also-secret"));
	const jsonCredential = classifyModelProbe({ stopReason: "error", errorMessage: "{\"api_key\":\"secret-json-value\",\"error\":\"failed\"}" });
	ok(!JSON.stringify(jsonCredential).includes("secret-json-value"));
});
