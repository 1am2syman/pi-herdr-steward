import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";
import { afterEach, it } from "vitest";

import {
	createPiModelAdapter,
	createRunJournalAdapter,
	type StewardHostRequest,
} from "../src/adapters.ts";
import {
	BUILTIN_RECOVERY_DEFAULTS,
	serializeModelPlans,
	serializeRecoveryDefaults,
	type ConfigDiagnostic,
	type ModelChoice,
	type ProjectModelPlans,
	type RecoveryDefaults,
} from "../src/config.ts";
import {
	resolveProjectModelPlansPath,
	resolveRecoveryDefaultsPath,
	createConfigStore,
} from "../src/config-store.ts";
import {
	registerStewardExtension,
	type StewardCommandContext,
	type StewardCommandHandler,
	type StewardRegistrationSurface,
} from "../src/extension.ts";
import type {
	ConfigurationEditResult,
	ConfigureResult,
	RunJournalAdapter,
	StewardDependencies,
	StewardModelAdapter,
	StewardUiAdapter,
	StewardUiSurface,
} from "../src/steward.ts";

interface TreeEntry {
	path: string;
	kind: "directory" | "file" | "symlink" | "other";
	mode: number;
	contents?: string;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function snapshotTree(root: string): Promise<TreeEntry[]> {
	const entries: TreeEntry[] = [];
	async function visit(directory: string): Promise<void> {
		for (const child of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, child.name);
			const relativePath = relative(root, path);
			const info = await lstat(path);
			const entry: TreeEntry = {
				path: relativePath,
				kind: info.isDirectory() ? "directory" : info.isFile() ? "file" : info.isSymbolicLink() ? "symlink" : "other",
				mode: info.mode & 0o7777,
			};
			if (info.isFile()) entry.contents = (await readFile(path)).toString("base64");
			entries.push(entry);
			if (info.isDirectory()) await visit(path);
		}
	}
	await visit(root);
	return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function makeRoots(): Promise<{ repositoryRoot: string; userRoot: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-config-"));
	temporaryDirectories.push(root);
	const repositoryRoot = join(root, "repo");
	const userRoot = join(root, "agent");
	await mkdir(repositoryRoot);
	await mkdir(userRoot);
	return { repositoryRoot, userRoot };
}

function makeChoice(model: string, thinkingLevel: ModelChoice["thinkingLevel"]): ModelChoice {
	return { model, thinkingLevel };
}

const validPlans: ProjectModelPlans = {
	builder: {
		primary: makeChoice("builder/provider-primary", "high"),
		fallbacks: [makeChoice("builder/provider-fallback", "medium")],
	},
	reviewer: {
		primary: makeChoice("reviewer/provider-primary", "high"),
		fallbacks: [makeChoice("reviewer/provider-fallback", "low")],
	},
};

const savedRecovery: RecoveryDefaults = {
	passiveInspectionIntervalSeconds: 301,
	secondInspectionAndNudgeIntervalSeconds: 302,
	nudgeGracePeriodSeconds: 121,
	externalCommandWarningThresholdSeconds: 1801,
	maximumActiveTasks: 1,
	transientRetryLimit: 1,
	reworkCycleLimit: 4,
};

interface FakeModel {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: Record<string, string | null>;
}

function fakeModel(
	provider: string,
	id: string,
	reasoning = true,
	thinkingLevelMap: Record<string, string | null> = { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
): FakeModel {
	return { provider, id, name: `${provider} ${id}`, reasoning, thinkingLevelMap };
}

function fakeRegistry(models: FakeModel[], available: FakeModel[], unauthenticated = new Set<string>()) {
	return {
		find(provider: string, id: string) {
			return models.find((model) => model.provider === provider && model.id === id);
		},
		getAvailable() {
			return available;
		},
		async getApiKeyAndHeaders(model: FakeModel) {
			return unauthenticated.has(`${model.provider}/${model.id}`)
				? { ok: false as const, error: "No configured authentication for this model." }
				: { ok: true as const, apiKey: "secret-that-must-not-escape" };
		},
	};
}

function makeContext(repositoryRoot: string, registry: unknown, ui: StewardUiAdapter | StewardUiSurface, model?: FakeModel): StewardCommandContext {
	const contextUi: StewardUiSurface = "select" in ui
		? ui
		: {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			notify: () => {},
			setStatus: () => {},
		};
	return {
		mode: "tui",
		hasUI: true,
		cwd: repositoryRoot,
		modelRegistry: registry as StewardCommandContext["modelRegistry"],
		model: model as StewardCommandContext["model"],
		thinkingLevel: model ? "high" : undefined,
		scopedModels: [],
		ui: contextUi,
	};
}

function captureCommand(): { surface: StewardRegistrationSurface; getHandler(): StewardCommandHandler } {
	let handler: StewardCommandHandler | undefined;
	return {
		surface: {
			on() {},
			registerCommand(_name, options) {
				handler = options.handler;
			},
		},
		getHandler() {
			if (!handler) throw new Error("command was not registered");
			return handler;
		},
	};
}

function makeUi(edit: (input: Parameters<StewardUiAdapter["editConfiguration"]>[0]) => Promise<ConfigurationEditResult> | ConfigurationEditResult, results: ConfigureResult[]): StewardUiAdapter {
	return {
		presentStatus() {},
		async editConfiguration(input) {
			return edit(input);
		},
		presentConfigurationResult(result) {
			results.push(result);
		},
	};
}

function makeDependencies(
	repositoryRoot: string,
	userRoot: string,
	model: StewardModelAdapter,
	ui: StewardUiAdapter,
	saveCalls?: { recovery: number; modelPlans: number },
): StewardDependencies {
	const production = createRunJournalAdapter({ agentDir: userRoot });
	const runJournal: RunJournalAdapter = {
		...production,
		async saveRecoveryDefaults(recovery) {
			if (saveCalls) saveCalls.recovery += 1;
			return production.saveRecoveryDefaults(recovery);
		},
		async saveModelPlans(root, plans) {
			if (saveCalls) saveCalls.modelPlans += 1;
			return production.saveModelPlans(root, plans);
		},
	};
	void repositoryRoot;
	return { runJournal, herdr: {}, git: {}, process: {}, model, clock: {}, ui };
}

function modelAdapterThatAccepts(): StewardModelAdapter {
	return { listModelChoices: () => [], validateModelPlans: async () => [] };
}

const noopRegistry = fakeRegistry([], []);

it.sequential("registered /steward config saves and reloads exact defaults", async () => {
	const { repositoryRoot, userRoot } = await makeRoots();
	const builderPrimary = fakeModel("builder", "provider-primary");
	const builderFallback = fakeModel("builder", "provider-fallback");
	const reviewerPrimary = fakeModel("reviewer", "provider-primary");
	const reviewerFallback = fakeModel("reviewer", "provider-fallback");
	const registry = fakeRegistry([builderPrimary, builderFallback, reviewerPrimary, reviewerFallback], [builderPrimary, builderFallback, reviewerPrimary, reviewerFallback]);
	const model = createPiModelAdapter(registry as StewardCommandContext["modelRegistry"], []);
	const results: ConfigureResult[] = [];
	let proposal: string | undefined;
	const recoveryUi = makeUi(() => ({ kind: "save-recovery", recovery: savedRecovery }), results);
	const recoveryCapture = captureCommand();
	registerStewardExtension(recoveryCapture.surface, () => makeDependencies(repositoryRoot, userRoot, modelAdapterThatAccepts(), recoveryUi));
	await recoveryCapture.getHandler()("config", makeContext(repositoryRoot, noopRegistry, recoveryUi, builderPrimary));

	const projectUi = makeUi((input) => {
		proposal = input.proposal?.reference;
		return { kind: "save-model-plans", modelPlans: validPlans };
	}, results);
	const projectCapture = captureCommand();
	registerStewardExtension(projectCapture.surface, () => makeDependencies(repositoryRoot, userRoot, model, projectUi));
	await projectCapture.getHandler()("config", makeContext(repositoryRoot, registry, projectUi, builderPrimary));

	const recoveryPath = resolveRecoveryDefaultsPath(userRoot);
	const modelPlansPath = resolveProjectModelPlansPath(repositoryRoot);
	equal(await readFile(recoveryPath, "utf8"), serializeRecoveryDefaults(savedRecovery));
	equal(await readFile(modelPlansPath, "utf8"), serializeModelPlans(validPlans));
	equal(await readFile(join(repositoryRoot, ".pi", "steward", ".gitignore"), "utf8"), "*\n");
	equal((await stat(join(userRoot, "steward"))).mode & 0o777, 0o700);
	equal((await stat(join(userRoot, "steward", "defaults.json"))).mode & 0o777, 0o600);
	equal((await stat(join(repositoryRoot, ".pi", "steward"))).mode & 0o777, 0o700);
	equal((await stat(join(repositoryRoot, ".pi", "steward", "defaults.json"))).mode & 0o777, 0o600);
	equal((await stat(join(repositoryRoot, ".pi", "steward", ".gitignore"))).mode & 0o777, 0o600);
	equal(proposal, "builder/provider-primary");
	match(results[0]?.message ?? "", /Saved and reloaded recovery defaults/);
	match(results[1]?.message ?? "", /Saved and reloaded project Model Plans/);

	const beforeRepository = await snapshotTree(repositoryRoot);
	const beforeUser = await snapshotTree(userRoot);
	let loadedRecovery: RecoveryDefaults | undefined;
	let loadedPlans: ProjectModelPlans | undefined;
	const cancelUi = makeUi((input) => {
		loadedRecovery = input.recovery;
		loadedPlans = input.modelPlans;
		return { kind: "cancelled" };
	}, results);
	const reloadCapture = captureCommand();
	registerStewardExtension(reloadCapture.surface, () => makeDependencies(repositoryRoot, userRoot, modelAdapterThatAccepts(), cancelUi));
	await reloadCapture.getHandler()("config", makeContext(repositoryRoot, noopRegistry, cancelUi));
	deepStrictEqual(loadedRecovery, savedRecovery);
	deepStrictEqual(loadedPlans, validPlans);
	deepStrictEqual(await snapshotTree(repositoryRoot), beforeRepository);
	deepStrictEqual(await snapshotTree(userRoot), beforeUser);
});

it.sequential("configuration cancellation is a filesystem no-op", async () => {
	const empty = await makeRoots();
	const results: ConfigureResult[] = [];
	const cancelUi = makeUi(() => ({ kind: "cancelled" }), results);
	let factoryCalls = 0;
	const emptyCapture = captureCommand();
	registerStewardExtension(emptyCapture.surface, () => {
		factoryCalls += 1;
		return makeDependencies(empty.repositoryRoot, empty.userRoot, modelAdapterThatAccepts(), cancelUi);
	});
	const beforeRepo = await snapshotTree(empty.repositoryRoot);
	const beforeUser = await snapshotTree(empty.userRoot);
	await emptyCapture.getHandler()("config", makeContext(empty.repositoryRoot, noopRegistry, cancelUi));
	deepStrictEqual(await snapshotTree(empty.repositoryRoot), beforeRepo);
	deepStrictEqual(await snapshotTree(empty.userRoot), beforeUser);
	ok(!existsSync(join(empty.userRoot, "steward")));
	equal(factoryCalls, 1);

	const populated = await makeRoots();
	const store = createConfigStore({ agentDir: populated.userRoot });
	await store.saveRecoveryDefaults(BUILTIN_RECOVERY_DEFAULTS);
	await store.saveModelPlans(populated.repositoryRoot, validPlans);
	const populatedBeforeRepo = await snapshotTree(populated.repositoryRoot);
	const populatedBeforeUser = await snapshotTree(populated.userRoot);
	const populatedCapture = captureCommand();
	registerStewardExtension(populatedCapture.surface, () => makeDependencies(populated.repositoryRoot, populated.userRoot, modelAdapterThatAccepts(), cancelUi));
	await populatedCapture.getHandler()("config", makeContext(populated.repositoryRoot, noopRegistry, cancelUi, fakeModel("controller", "model")));
	deepStrictEqual(await snapshotTree(populated.repositoryRoot), populatedBeforeRepo);
	deepStrictEqual(await snapshotTree(populated.userRoot), populatedBeforeUser);
});

it.sequential("invalid unavailable and unauthenticated models are diagnosed without substitution", async () => {
	const { repositoryRoot, userRoot } = await makeRoots();
	const unavailable = fakeModel("provider", "unavailable");
	const unauthenticated = fakeModel("provider", "unauthenticated");
	const unsupported = fakeModel("provider", "unsupported", true, { off: "off", high: null });
	const registry = fakeRegistry([unavailable, unauthenticated, unsupported], [unauthenticated, unsupported], new Set(["provider/unauthenticated"]));
	const model = createPiModelAdapter(registry as StewardCommandContext["modelRegistry"], []);
	const invalidPlans: ProjectModelPlans = {
		builder: {
			primary: makeChoice("provider/missing", "high"),
			fallbacks: [makeChoice("provider/unavailable", "medium")],
		},
		reviewer: {
			primary: makeChoice("provider/unauthenticated", "high"),
			fallbacks: [makeChoice("provider/unsupported", "high")],
		},
	};
	const saveCalls = { recovery: 0, modelPlans: 0 };
	const results: ConfigureResult[] = [];
	const ui = makeUi(() => ({ kind: "save-model-plans", modelPlans: invalidPlans }), results);
	const capture = captureCommand();
	registerStewardExtension(capture.surface, () => makeDependencies(repositoryRoot, userRoot, model, ui, saveCalls));
	const beforeRepo = await snapshotTree(repositoryRoot);
	const beforeUser = await snapshotTree(userRoot);
	await capture.getHandler()("config", makeContext(repositoryRoot, registry, ui));
	const invalid = results.at(-1);
	ok(invalid?.kind === "invalid");
	if (!invalid || invalid.kind !== "invalid") return;
	deepStrictEqual(
		invalid.diagnostics.map((item: ConfigDiagnostic) => [item.code, item.role, item.index, item.reference]),
		[
			["invalid-model", "builder", 0, "provider/missing"],
			["unavailable-model", "builder", 1, "provider/unavailable"],
			["unauthenticated-model", "reviewer", 0, "provider/unauthenticated"],
			["unsupported-thinking-level", "reviewer", 1, "provider/unsupported"],
		],
	);
	equal(saveCalls.modelPlans, 0);
	deepStrictEqual(await snapshotTree(repositoryRoot), beforeRepo);
	deepStrictEqual(await snapshotTree(userRoot), beforeUser);
	const rendered = JSON.stringify(invalid);
	ok(!rendered.includes("secret-that-must-not-escape"));
});

it.sequential("non-TUI config refuses before reading or writing", async () => {
	const { repositoryRoot, userRoot } = await makeRoots();
	const results: ConfigureResult[] = [];
	const ui = makeUi(() => ({ kind: "cancelled" }), results);
	let factoryCalls = 0;
	const capture = captureCommand();
	registerStewardExtension(capture.surface, () => {
		factoryCalls += 1;
		return makeDependencies(repositoryRoot, userRoot, modelAdapterThatAccepts(), ui);
	});
	const modes = ["rpc", "json", "print"] as const;
	for (const mode of modes) {
		const context = { ...makeContext(repositoryRoot, noopRegistry, ui), mode } as StewardCommandContext;
		await rejects(capture.getHandler()("config", context), /Steward configuration requires interactive TUI mode\./);
	}
	equal(factoryCalls, 0);
	deepStrictEqual(await snapshotTree(repositoryRoot), []);
	deepStrictEqual(await snapshotTree(userRoot), []);
});
