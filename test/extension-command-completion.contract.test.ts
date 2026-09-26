import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { it } from "vitest";

import {
	STEWARD_SUBCOMMANDS,
	getStewardArgumentCompletions,
	registerStewardExtension,
	type StewardCommandContext,
	type StewardCommandOptions,
	type StewardRegistrationSurface,
} from "../src/extension.ts";
import type { DoctorReport } from "../src/doctor.ts";
import type { StewardDependencies, StewardUiSurface } from "../src/steward.ts";

function captureRegistration(): { surface: StewardRegistrationSurface; options(): StewardCommandOptions } {
	let command: StewardCommandOptions | undefined;
	return {
		surface: { on() {}, registerCommand(_name, options) { command = options; } },
		options() {
			if (!command) throw new Error("Steward command was not registered.");
			return command;
		},
	};
}

it("offers every Steward subcommand and its description from the shared catalogue", async () => {
	const capture = captureRegistration();
	registerStewardExtension(capture.surface, () => { throw new Error("registration must not construct adapters"); });
	const completions = await capture.options().getArgumentCompletions?.("");
	deepStrictEqual(completions?.map((item) => item.value), STEWARD_SUBCOMMANDS.map((item) => item.name));
	deepStrictEqual(completions?.map((item) => item.description), STEWARD_SUBCOMMANDS.map((item) => item.description));
	deepStrictEqual(getStewardArgumentCompletions("doc")?.map((item) => item.value), ["doctor"]);
});

it("offers nested resume and doctor flags", () => {
	deepStrictEqual(getStewardArgumentCompletions("resume ")?.map((item) => item.value), ["resume --takeover"]);
	deepStrictEqual(getStewardArgumentCompletions("doctor ")?.map((item) => item.value), ["doctor --probe"]);
	deepStrictEqual(getStewardArgumentCompletions("doctor --p")?.map((item) => item.value), ["doctor --probe"]);
});

it("keeps non-TUI status as a no-op before constructing adapters", async () => {
	let factoryCalls = 0;
	const capture = captureRegistration();
	registerStewardExtension(capture.surface, () => {
		factoryCalls += 1;
		throw new Error("status must not construct adapters outside TUI mode");
	});
	const context = {
		mode: "rpc", hasUI: false, cwd: "/repo", modelRegistry: {}, model: undefined, thinkingLevel: undefined, scopedModels: [],
		sessionManager: { getSessionId: () => "session" },
		ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined, notify() {}, setStatus() {} },
	} as unknown as StewardCommandContext;
	await capture.options().handler("status", context);
	equal(factoryCalls, 0);
});

it("opens a subcommand selector for bare /steward and dispatches its result", async () => {
	const selectedLabel = `${STEWARD_SUBCOMMANDS[0].name} — ${STEWARD_SUBCOMMANDS[0].description}`;
	let statusPresented = 0;
	const ui: StewardUiSurface = {
		async select(title, options) { equal(title, "Steward command"); ok(options.includes(selectedLabel)); return selectedLabel; },
		async confirm() { return false; },
		async input() { return undefined; },
		notify() {},
		setStatus() {},
	};
	const dependencies = {
		runJournal: { async loadActive() { return { kind: "missing" as const }; } },
		herdr: {}, git: {}, process: {}, model: {}, clock: { now: () => new Date(0), randomUUID: () => "uuid" },
		ui: { presentStatus() { statusPresented += 1; } },
	} as unknown as StewardDependencies;
	const capture = captureRegistration();
	registerStewardExtension(capture.surface, () => dependencies);
	const context = {
		mode: "tui", hasUI: true, cwd: "/repo", modelRegistry: {}, model: undefined, thinkingLevel: undefined, scopedModels: [],
		sessionManager: { getSessionId: () => "session" }, ui,
	} as unknown as StewardCommandContext;
	await capture.options().handler("", context);
	equal(statusPresented, 1);
});

it("dispatches static and explicitly probed doctor commands", async () => {
	let probeCalls = 0;
	const reports: DoctorReport[] = [];
	const modelChoice = { model: "provider/model", thinkingLevel: "high" as const };
	const dependencies = {
		runJournal: {
			async loadRecoveryDefaults() { return { value: { configured: true }, diagnostics: [], path: "/agent/steward/defaults.json" }; },
			async loadModelPlans() {
				return {
					value: {
						builder: { primary: modelChoice, fallbacks: [] },
						reviewer: { primary: modelChoice, fallbacks: [] },
					},
					diagnostics: [],
					path: "/repo/.pi/steward/defaults.json",
				};
			},
			async loadActive() { return { kind: "missing" as const }; },
		},
		herdr: { async checkAvailability() { return { kind: "available" as const, status: "ready" }; } },
		git: {},
		process: {},
		model: {
			async inspectModelChoice() { return { available: true, diagnostics: [] }; },
			async probeModelChoice() { probeCalls += 1; return { status: "healthy" as const }; },
		},
		clock: { now: () => new Date(0), randomUUID: () => "uuid" },
		ui: { presentDoctorResult(report: DoctorReport) { reports.push(report); } },
	} as unknown as StewardDependencies;
	const ui: StewardUiSurface = {
		async select() { return undefined; },
		async confirm() { return false; },
		async input() { return undefined; },
		notify() {},
		setStatus() {},
	};
	const context = {
		mode: "tui", hasUI: true, cwd: "/repo", modelRegistry: {}, model: undefined, thinkingLevel: undefined, scopedModels: [],
		sessionManager: { getSessionId: () => "session" }, ui,
	} as unknown as StewardCommandContext;
	const capture = captureRegistration();
	registerStewardExtension(capture.surface, () => dependencies);

	await capture.options().handler("doctor", context);
	equal(probeCalls, 0);
	equal(reports.at(-1)?.probeRequested, false);

	await capture.options().handler("doctor --probe", context);
	equal(probeCalls, 1);
	equal(reports.at(-1)?.probeRequested, true);
});
