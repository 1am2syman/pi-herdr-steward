import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { type ExecResult, type ExtensionContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import {
	formatModelChoice,
	formatModelPlans,
	formatRecoveryDefaults,
	parseCanonicalModelReference,
	THINKING_LEVELS,
	type ConfigDiagnostic,
	type ModelChoice,
	type ModelChoiceOption,
	type ModelRole,
	type ProjectModelPlans,
	type RecoveryDefaults,
	type ThinkingLevel,
} from "./config.ts";
import { createConfigStore, type ConfigStoreOptions } from "./config-store.ts";
import { createRunJournalStore } from "./run-journal-store.ts";
import type { ExpectedArtifact, RunDraft, RunDraftInput, RunDraftResult, Verification } from "./run.ts";
import type {
	ConfigurationEditResult,
	ConfigurationEditorInput,
	ConfigureResult,
	OpaqueAdapter,
	RunJournalAdapter,
	StatusTarget,
	StatusView,
	StewardDependencies,
	StewardGitAdapter,
	StewardHerdrAdapter,
	StewardClockAdapter,
	StewardModelAdapter,
	StewardUiAdapter,
	StewardUiSurface,
} from "./steward.ts";

const STATUS_KEY = "pi-herdr-steward";

type HostModel = NonNullable<ExtensionContext["model"]>;
type HostModelRegistry = Pick<ExtensionContext["modelRegistry"], "find" | "getAvailable" | "getApiKeyAndHeaders">;
type HostScopedModel = ExtensionContext["scopedModels"][number];
type PiStatusUi = Pick<ExtensionUIContext, "notify" | "setStatus">;
type PiConfigUi = Pick<ExtensionUIContext, "select" | "confirm" | "input">;

export interface StewardHostRequest {
	ui: StewardUiSurface;
	modelRegistry: HostModelRegistry;
	scopedModels: readonly HostScopedModel[];
	exec?: (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<ExecResult>;
}

function safeErrorText(error: unknown): string {
	return error instanceof Error && error.message.length > 0 ? error.message : "Authentication resolution failed.";
}

/** Probe only the Steward-owned active journal path, without creating its parents. */
export function createRunJournalAdapter(options?: ConfigStoreOptions): RunJournalAdapter {
	const configStore = createConfigStore(options);
	const runStore = createRunJournalStore({ configDirName: options?.configDirName });

	return {
		probeActive: (repositoryRoot) => runStore.probeActive(repositoryRoot),
		loadActive: runStore.loadActive,
		createActive: runStore.createActive,
		replaceActive: runStore.replaceActive,
		appendActivity: runStore.appendActivity,
		resolveAssignmentPaths: runStore.resolveAssignmentPaths,
		createAssignment: runStore.createAssignment,
		loadRecoveryDefaults: () => configStore.loadRecoveryDefaults(),
		loadModelPlans: (repositoryRoot) => configStore.loadModelPlans(repositoryRoot),
		saveRecoveryDefaults: (recovery) => configStore.saveRecoveryDefaults(recovery),
		saveModelPlans: (repositoryRoot, modelPlans) => configStore.saveModelPlans(repositoryRoot, modelPlans),
	};
}

function exactReference(model: HostModel): string {
	return `${model.provider}/${model.id}`;
}

function exactModelInList(models: readonly HostModel[], reference: string): boolean {
	return models.some((model) => exactReference(model) === reference);
}

function exactModelInScope(models: readonly HostScopedModel[], reference: string): boolean {
	return models.some((item) => exactReference(item.model) === reference);
}

function unsupportedThinking(model: HostModel, level: ThinkingLevel): boolean {
	if (!model.reasoning) return level !== "off";
	const mapped = model.thinkingLevelMap?.[level];
	if (mapped === null) return true;
	return (level === "xhigh" || level === "max") && (mapped === undefined || mapped === null);
}

function modelDiagnostic(
	code: ConfigDiagnostic["code"],
	role: ModelRole,
	index: number,
	reference: string,
	message: string,
): ConfigDiagnostic {
	return { code, role, index, reference, message };
}

/** Adapt Pi's catalogue/auth surface without exposing host model objects to Steward. */
export function createPiModelAdapter(
	modelRegistry: HostModelRegistry,
	scopedModels: readonly HostScopedModel[],
): StewardModelAdapter {
	function listModelChoices(): readonly ModelChoiceOption[] {
		return modelRegistry.getAvailable().map((model) => ({ reference: exactReference(model), name: model.name }));
	}

	async function validateModelPlans(modelPlans: ProjectModelPlans): Promise<ConfigDiagnostic[]> {
		const diagnostics: ConfigDiagnostic[] = [];
		const available = modelRegistry.getAvailable();
		for (const role of ["builder", "reviewer"] as const) {
			const choices = [modelPlans[role].primary, ...modelPlans[role].fallbacks];
			for (let index = 0; index < choices.length; index += 1) {
				const choice = choices[index];
				const parsed = parseCanonicalModelReference(choice.model);
				if (!parsed) {
					diagnostics.push(modelDiagnostic("invalid-model", role, index, choice.model, "Model reference is not an exact provider/model-id value."));
					continue;
				}

				const model = modelRegistry.find(parsed.provider, parsed.modelId);
				if (!model) {
					diagnostics.push(modelDiagnostic("invalid-model", role, index, choice.model, "Exact model reference was not found in the host registry."));
					continue;
				}

				let auth: Awaited<ReturnType<HostModelRegistry["getApiKeyAndHeaders"]>>;
				try {
					auth = await modelRegistry.getApiKeyAndHeaders(model);
				} catch (error: unknown) {
					diagnostics.push(modelDiagnostic("unauthenticated-model", role, index, choice.model, safeErrorText(error)));
					continue;
				}
				if (!auth.ok) {
					diagnostics.push(modelDiagnostic("unauthenticated-model", role, index, choice.model, auth.error));
					continue;
				}

				const availableToSession = exactModelInList(available, choice.model);
				const scopedToSession = scopedModels.length === 0 || exactModelInScope(scopedModels, choice.model);
				if (!availableToSession || !scopedToSession) {
					diagnostics.push(modelDiagnostic("unavailable-model", role, index, choice.model, "Model is not available in the current host catalogue or session scope."));
					continue;
				}

				if (unsupportedThinking(model, choice.thinkingLevel)) {
					diagnostics.push(
						modelDiagnostic(
							"unsupported-thinking-level",
							role,
							index,
							choice.model,
							`Thinking level ${choice.thinkingLevel} is not supported by the exact model.`,
						),
					);
				}
			}
		}
		return diagnostics;
	}

	return { listModelChoices, validateModelPlans };
}

function getDialogSurface(ui: PiStatusUi & Partial<PiConfigUi>): PiConfigUi {
	if (!ui.select || !ui.confirm || !ui.input) {
		throw new Error("Steward configuration requires the interactive dialog primitives.");
	}
	return {
		select: (title, options) => ui.select!(title, options),
		confirm: (title, message) => ui.confirm!(title, message),
		input: (title, placeholder) => ui.input!(title, placeholder),
	};
}

function formatProposal(input: ConfigurationEditorInput): string {
	if (!input.proposal) return "Controller Session proposal: unavailable.";
	if (!input.proposal.thinkingLevel) {
		return `Proposed Builder choice from Controller Session — not selected: ${input.proposal.reference} (thinking level incomplete; choose explicitly).`;
	}
	return `Proposed Builder choice from Controller Session — not selected: ${input.proposal.reference} [thinking=${input.proposal.thinkingLevel}].`;
}

function choiceLabel(choice: ModelChoice): string {
	return formatModelChoice(choice);
}

function roleLabel(role: ModelRole): string {
	return role[0].toUpperCase() + role.slice(1);
}

function exactOptions(input: ConfigurationEditorInput): string[] {
	return input.modelChoices.map((option) => `${option.reference}${option.name ? ` (${option.name})` : ""}`);
}

function referenceFromOption(selected: string, input: ConfigurationEditorInput): string | undefined {
	return input.modelChoices.find((option) => selected === `${option.reference}${option.name ? ` (${option.name})` : ""}`)?.reference;
}

async function selectThinking(ui: PiConfigUi, title: string, current?: ThinkingLevel): Promise<ThinkingLevel | undefined> {
	const selected = await ui.select(title, [...THINKING_LEVELS]);
	if (!selected || !(THINKING_LEVELS as readonly string[]).includes(selected)) return undefined;
	return selected as ThinkingLevel;
}

async function chooseModelChoice(
	ui: PiConfigUi,
	input: ConfigurationEditorInput,
	role: ModelRole,
	current: ModelChoice | undefined,
	allowProposal: boolean,
): Promise<ModelChoice | undefined> {
	const title = `${roleLabel(role)} primary model`;
	const options: string[] = [];
	if (allowProposal && input.proposal?.thinkingLevel) options.push("Use proposed Controller choice");
	options.push("Enter exact model choice");
	if (current) options.push(`Keep current: ${choiceLabel(current)}`);
	for (const option of exactOptions(input)) {
		if (!options.includes(option)) options.push(option);
	}
	options.push("Cancel");

	const selected = await ui.select(title, options);
	if (!selected || selected === "Cancel") return undefined;
	if (selected === "Use proposed Controller choice" && input.proposal?.thinkingLevel) {
		const confirmed = await ui.confirm(
			"Confirm proposed Builder choice",
			`Use ${input.proposal.reference} with thinking level ${input.proposal.thinkingLevel} as the Builder primary?`,
		);
		return confirmed
			? { model: input.proposal.reference, thinkingLevel: input.proposal.thinkingLevel }
			: chooseModelChoice(ui, input, role, current, false);
	}
	if (selected.startsWith("Keep current:") && current) return { ...current };

	const reference = selected === "Enter exact model choice" ? await ui.input(`Exact ${roleLabel(role)} model reference`, "provider/exact-model-id") : referenceFromOption(selected, input);
	if (reference === undefined) return undefined;
	const thinkingLevel = await selectThinking(ui, `${roleLabel(role)} thinking level`, current?.thinkingLevel);
	if (!thinkingLevel) return undefined;
	return { model: reference, thinkingLevel };
}

async function editFallbacks(
	ui: PiConfigUi,
	input: ConfigurationEditorInput,
	role: ModelRole,
	initial: ModelChoice[],
): Promise<ModelChoice[] | undefined> {
	const fallbacks = initial.map((choice) => ({ ...choice }));
	while (true) {
		const options = fallbacks.map((choice, index) => `Edit fallback ${index + 1}: ${choiceLabel(choice)}`);
		fallbacks.forEach((_choice, index) => {
			options.push(`Remove fallback ${index + 1}`);
			if (index > 0) options.push(`Move fallback ${index + 1} up`);
			if (index < fallbacks.length - 1) options.push(`Move fallback ${index + 1} down`);
		});
		options.push("Add fallback", "Done", "Cancel");
		const selected = await ui.select(`${roleLabel(role)} fallback models`, options);
		if (!selected || selected === "Cancel") return undefined;
		if (selected === "Done") return fallbacks;
		if (selected === "Add fallback") {
			const choice = await chooseModelChoice(ui, input, role, undefined, false);
			if (!choice) return undefined;
			fallbacks.push(choice);
			continue;
		}

		const editMatch = /^Edit fallback (\d+):/.exec(selected);
		if (editMatch) {
			const index = Number(editMatch[1]) - 1;
			const choice = await chooseModelChoice(ui, input, role, fallbacks[index], false);
			if (!choice) return undefined;
			fallbacks[index] = choice;
			continue;
		}
		const removeMatch = /^Remove fallback (\d+)$/.exec(selected);
		if (removeMatch) {
			fallbacks.splice(Number(removeMatch[1]) - 1, 1);
			continue;
		}
		const upMatch = /^Move fallback (\d+) up$/.exec(selected);
		if (upMatch) {
			const index = Number(upMatch[1]) - 1;
			[fallbacks[index - 1], fallbacks[index]] = [fallbacks[index], fallbacks[index - 1]];
			continue;
		}
		const downMatch = /^Move fallback (\d+) down$/.exec(selected);
		if (downMatch) {
			const index = Number(downMatch[1]) - 1;
			[fallbacks[index], fallbacks[index + 1]] = [fallbacks[index + 1], fallbacks[index]];
		}
	}
}

async function editModelPlans(ui: PiConfigUi, input: ConfigurationEditorInput): Promise<ProjectModelPlans | undefined> {
	const currentBuilder = input.modelPlans?.builder;
	const currentReviewer = input.modelPlans?.reviewer;
	const builderPrimary = await chooseModelChoice(ui, input, "builder", currentBuilder?.primary, true);
	if (!builderPrimary) return undefined;
	const builderFallbacks = await editFallbacks(ui, input, "builder", currentBuilder?.fallbacks ?? []);
	if (!builderFallbacks) return undefined;
	const reviewerPrimary = await chooseModelChoice(ui, input, "reviewer", currentReviewer?.primary, false);
	if (!reviewerPrimary) return undefined;
	const reviewerFallbacks = await editFallbacks(ui, input, "reviewer", currentReviewer?.fallbacks ?? []);
	if (!reviewerFallbacks) return undefined;
	return {
		builder: { primary: builderPrimary, fallbacks: builderFallbacks },
		reviewer: { primary: reviewerPrimary, fallbacks: reviewerFallbacks },
	};
}

async function editRecovery(ui: PiConfigUi, input: ConfigurationEditorInput): Promise<ConfigurationEditResult> {
	const recovery = { ...input.recovery };
	const fields: Array<keyof RecoveryDefaults> = [
		"passiveInspectionIntervalSeconds",
		"secondInspectionAndNudgeIntervalSeconds",
		"nudgeGracePeriodSeconds",
		"externalCommandWarningThresholdSeconds",
		"maximumActiveTasks",
		"transientRetryLimit",
		"reworkCycleLimit",
	];
	for (const field of fields) {
		const entered = await ui.input(`${field} (seconds unless noted; current ${recovery[field]}; empty keeps current)`, String(recovery[field]));
		if (entered === undefined) return { kind: "cancelled" };
		if (entered.trim() !== "") recovery[field] = Number(entered);
	}
	const confirmed = await ui.confirm("Save recovery defaults?", `${formatRecoveryDefaults(recovery)}\nPath: ${input.recoveryPath}`);
	return confirmed ? { kind: "save-recovery", recovery } : { kind: "cancelled" };
}

async function editConfiguration(ui: PiStatusUi & Partial<PiConfigUi>, input: ConfigurationEditorInput): Promise<ConfigurationEditResult> {
	const dialogs = getDialogSurface(ui);
	ui.notify(
		[
			`User-global recovery defaults (${input.recoveryPath}): ${formatRecoveryDefaults(input.recovery)}`,
			`Project-local Model Plans (${input.modelPlansPath}): ${formatModelPlans(input.modelPlans)}`,
			formatProposal(input),
		].join("\n"),
		"info",
	);
	const selected = await dialogs.select("Steward configuration", ["Edit recovery defaults", "Edit project Model Plans", "Cancel"]);
	if (!selected || selected === "Cancel") return { kind: "cancelled" };
	if (selected === "Edit recovery defaults") return editRecovery(dialogs, input);

	const modelPlans = await editModelPlans(dialogs, input);
	if (!modelPlans) return { kind: "cancelled" };
	const confirmed = await dialogs.confirm("Save project Model Plans?", `${formatModelPlans(modelPlans)}\nPath: ${input.modelPlansPath}`);
	return confirmed ? { kind: "save-model-plans", modelPlans } : { kind: "cancelled" };
}

type CommandRunner = NonNullable<StewardHostRequest["exec"]>;

function unavailable(message: string): { kind: "unavailable"; message: string } {
	return { kind: "unavailable", message };
}

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

function safeEnvelope(result: ExecResult): JsonObject | undefined {
	if (result.code !== 0 || result.killed || result.stderr.trim().length > 0) return undefined;
	try {
		const parsed = JSON.parse(result.stdout) as unknown;
		return objectValue(parsed);
	} catch {
		return undefined;
	}
}

function safeErrorEnvelope(result: ExecResult): { id: string | undefined; code: string; message: string } | undefined {
	if (result.code !== 1 || result.killed || result.stdout.trim().length > 0) return undefined;
	try {
		const parsed = objectValue(JSON.parse(result.stderr) as unknown);
		const error = objectValue(parsed?.error);
		return typeof error?.code === "string" && error.code.length > 0 && typeof error.message === "string" && error.message.trim().length > 0 && !error.code.includes("\u0000") && !error.message.includes("\u0000")
			? { id: typeof parsed?.id === "string" ? parsed.id : undefined, code: error.code, message: error.message }
			: undefined;
	} catch {
		return undefined;
	}
}

function resultObject(envelope: JsonObject | undefined): JsonObject | undefined {
	return objectValue(envelope?.result);
}

function safeIdentity(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value === value.trim() && !value.includes("\u0000");
}

function identityFields(value: JsonObject | undefined): { name: string; workspaceId: string; tabId: string; paneId: string; terminalId: string } | undefined {
	if (!value || !safeIdentity(value.name) || !safeIdentity(value.workspace_id) || !safeIdentity(value.tab_id) || !safeIdentity(value.pane_id) || !safeIdentity(value.terminal_id)) return undefined;
	return { name: value.name, workspaceId: value.workspace_id, tabId: value.tab_id, paneId: value.pane_id, terminalId: value.terminal_id };
}

function exactPiArgv(value: unknown, model: ModelChoice): boolean {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return false;
	const expected = ["--model", model.model, "--thinking", model.thinkingLevel];
	return JSON.stringify(value) === JSON.stringify(expected) || JSON.stringify(value) === JSON.stringify(["pi", ...expected]);
}

export function createHerdrAdapter(exec: CommandRunner | undefined): StewardHerdrAdapter {
	return {
		async checkAvailability(repositoryRoot) {
			if (!exec) return unavailable("The Pi command runner is unavailable.");
			let result: ExecResult;
			try {
				result = await exec("herdr", ["status", "server", "--json"], { cwd: repositoryRoot, timeout: 5000 });
			} catch (error: unknown) {
				return unavailable(error instanceof Error ? error.message : "herdr status server --json failed.");
			}
			if (result.code !== 0 || result.killed) return unavailable(result.stderr.trim() || "herdr status server --json exited unsuccessfully.");
			try {
				const parsed: unknown = JSON.parse(result.stdout);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return unavailable("Herdr returned malformed availability JSON.");
				const value = parsed as Record<string, unknown>;
				if (value.status !== "running" || value.running !== true || value.compatible !== true || value.endpoint_compatible !== true) return unavailable("Herdr server is stopped, incompatible, or has a stale endpoint.");
				return {
					kind: "available",
					status: "running",
					running: true,
					compatible: true,
					endpointCompatible: true,
					...(typeof value.protocol === "number" ? { protocol: value.protocol } : {}),
				};
			} catch {
				return unavailable("Herdr returned malformed availability JSON.");
			}
		},
		async createBuilderWorktree(input) {
			if (!exec) return { kind: "failed", stage: "worktree-create", code: "runner-unavailable", message: "The Pi command runner is unavailable." };
			let result: ExecResult;
			try {
				result = await exec("herdr", ["worktree", "create", "--cwd", input.repositoryRoot, "--branch", input.branch, "--base", input.baseRevision, "--label", input.label, "--no-focus"], { cwd: input.repositoryRoot, timeout: 30000 });
			} catch (error: unknown) {
				return { kind: "failed", stage: "worktree-create", code: "runner-error", message: error instanceof Error ? error.message : "Herdr worktree create failed." };
			}
			const envelope = safeEnvelope(result);
			const resultValue = resultObject(envelope);
			const workspace = objectValue(resultValue?.workspace);
			const tab = objectValue(resultValue?.tab);
			const pane = objectValue(resultValue?.root_pane);
			const worktree = objectValue(resultValue?.worktree);
			if (resultValue?.type === "worktree_created" && workspace && tab && pane && worktree && safeIdentity(workspace.workspace_id) && safeIdentity(tab.tab_id) && safeIdentity(pane.pane_id) && safeIdentity(pane.terminal_id) && typeof worktree.branch === "string" && typeof worktree.path === "string" && typeof worktree.is_linked_worktree === "boolean" && safeIdentity(worktree.open_workspace_id) && worktree.is_linked_worktree && worktree.open_workspace_id === workspace.workspace_id && worktree.branch === input.branch && isAbsolute(worktree.path) && worktree.path === worktree.path.trim()) {
				return { kind: "created", branch: worktree.branch, path: worktree.path, workspaceId: workspace.workspace_id, tabId: tab.tab_id, paneId: pane.pane_id, terminalId: pane.terminal_id };
			}
			const error = safeErrorEnvelope(result);
			return { kind: "failed", stage: "worktree-create", code: error?.code ?? (result.killed ? "killed" : "malformed-response"), message: error?.message ?? "Herdr returned no valid worktree_created envelope." };
		},
		async startBuilder(input) {
			if (!exec) return { kind: "failed", stage: "agent-start", code: "runner-unavailable", message: "The Pi command runner is unavailable." };
			let result: ExecResult;
			try {
				result = await exec("herdr", ["agent", "start", input.name, "--kind", "pi", "--pane", input.paneId, "--timeout", "30000", "--", "--model", input.model.model, "--thinking", input.model.thinkingLevel], { cwd: input.repositoryRoot, timeout: 30000 });
			} catch (error: unknown) {
				return { kind: "failed", stage: "agent-start", code: "runner-error", message: error instanceof Error ? error.message : "Herdr agent start failed." };
			}
			const collision = safeErrorEnvelope(result);
			if (collision?.id === "cli:agent:start" && collision.code === "agent_name_taken") return { kind: "name-collision", code: "agent_name_taken", message: collision.message };
			const envelope = safeEnvelope(result);
			const resultValue = resultObject(envelope);
			const agent = objectValue(resultValue?.agent);
			const identity = identityFields(agent);
			if (resultValue?.type === "agent_started" && identity && identity.name === input.name && identity.paneId === input.paneId && agent?.agent === "pi" && agent.agent_status === "idle" && agent.interactive_ready === true && exactPiArgv(agent.argv, input.model)) return { kind: "started", agentKind: "pi", name: identity.name, workspaceId: identity.workspaceId, tabId: identity.tabId, paneId: identity.paneId, terminalId: identity.terminalId };
			return { kind: "failed", stage: "agent-start", code: collision?.code ?? (result.killed ? "killed" : "malformed-response"), message: collision?.message ?? "Herdr returned no valid agent_started envelope." };
		},
		async promptBuilder(input) {
			if (!exec) return { kind: "failed", stage: "agent-prompt", code: "runner-unavailable", message: "The Pi command runner is unavailable." };
			let result: ExecResult;
			try {
				result = await exec("herdr", ["agent", "prompt", input.name, input.assignmentPrompt], { cwd: input.repositoryRoot, timeout: 30000 });
			} catch (error: unknown) {
				return { kind: "failed", stage: "agent-prompt", code: "runner-error", message: error instanceof Error ? error.message : "Herdr agent prompt failed." };
			}
			const envelope = safeEnvelope(result);
			const resultValue = resultObject(envelope);
			const agent = objectValue(resultValue?.agent);
			const identity = identityFields(agent);
			if (resultValue?.type === "agent_prompted" && identity && identity.name === input.name) return { kind: "prompted", name: identity.name, workspaceId: identity.workspaceId, tabId: identity.tabId, paneId: identity.paneId, terminalId: identity.terminalId };
			const error = safeErrorEnvelope(result);
			return { kind: "failed", stage: "agent-prompt", code: error?.code ?? (result.killed ? "killed" : "malformed-response"), message: error?.message ?? "Herdr returned no valid agent_prompted envelope." };
		},
	};
}

function createGitAdapter(exec: CommandRunner | undefined): StewardGitAdapter {
	function isMissing(error: unknown): boolean {
		return error instanceof Error && "code" in error && error.code === "ENOENT";
	}

	async function run(repositoryRoot: string, args: string[]): Promise<ExecResult> {
		if (!exec) throw new Error("The Pi command runner is unavailable.");
		return exec("git", args, { cwd: repositoryRoot, timeout: 5000 });
	}

	return {
		async inspectIntegrationBase(repositoryRoot) {
			try {
				const inside = await run(repositoryRoot, ["rev-parse", "--is-inside-work-tree"]);
				if (inside.code !== 0 || inside.stdout.trim() !== "true") return unavailable("The current directory is not a Git worktree.");
				const branch = await run(repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
				if (branch.code !== 0 || branch.stdout.trim() === "") return unavailable("Git is detached or has no attached branch.");
				const head = await run(repositoryRoot, ["rev-parse", "--verify", "HEAD"]);
				if (head.code !== 0 || !/^[0-9a-f]{40}$/.test(head.stdout.trim())) return unavailable("Git has no resolvable full HEAD revision.");
				const status = await run(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
				if (status.code !== 0) return unavailable("Git status could not be inspected.");
				if (status.stdout.length > 0) return unavailable("The Git checkout is dirty, including tracked or untracked files.");
				const gitDir = await run(repositoryRoot, ["rev-parse", "--git-dir"]);
				if (gitDir.code !== 0 || gitDir.stdout.trim() === "") return unavailable("Git metadata could not be located.");
				const markerRoot = resolve(repositoryRoot, gitDir.stdout.trim());
				const operationMarkers = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"];
				for (const marker of operationMarkers) {
					try {
						lstatSync(join(markerRoot, marker));
						return unavailable(`Git operation in progress (${marker}); finish or abort it before starting.`);
					} catch (error: unknown) {
						if (!isMissing(error)) return unavailable(`Git operation state could not be inspected (${marker}).`);
					}
				}
				return { kind: "ready", branch: branch.stdout.trim(), revision: head.stdout.trim() };
			} catch (error: unknown) {
				return unavailable(error instanceof Error ? error.message : "Git integration-base inspection failed.");
			}
		},
		async branchExists(repositoryRoot, branch) {
			const result = await run(repositoryRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
			if (result.code === 0 && !result.killed) return true;
			if (result.code === 1 && !result.killed) return false;
			throw new Error(result.stderr.trim() || "Git branch existence inspection failed.");
		},
		async inspectBuilderWorktree(worktreePath, expectedRevision) {
			try {
				const head = await exec!("git", ["rev-parse", "--verify", "HEAD"], { cwd: worktreePath, timeout: 5000 });
				if (head.code !== 0 || head.killed || head.stdout.trim() !== expectedRevision) return { kind: "unavailable", message: "Builder worktree HEAD does not equal the selected Run base revision." };
				const status = await exec!("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: worktreePath, timeout: 5000 });
				if (status.code !== 0 || status.killed) return { kind: "unavailable", message: "Builder worktree clean-state inspection failed." };
				if (status.stdout.length > 0) return { kind: "unavailable", message: "Builder worktree is not clean before dispatch." };
				return { kind: "ready", head: expectedRevision, clean: true };
			} catch (error: unknown) {
				return { kind: "unavailable", message: error instanceof Error ? error.message : "Builder worktree inspection failed." };
			}
		},
	};
}

function createClockAdapter(): StewardClockAdapter {
	return { now: () => new Date(), randomUUID: () => randomUUID() };
}

function lines(value: string): string[] {
	return value.split("\n").map((item) => item.trim()).filter((item) => item.length > 0);
}

function parseArtifacts(value: string): ExpectedArtifact[] | undefined {
	const artifacts: ExpectedArtifact[] = [];
	for (const entry of lines(value)) {
		if (entry === "git-commit") artifacts.push({ kind: "git-commit" });
		else if (entry.startsWith("file:")) artifacts.push({ kind: "file", path: entry.slice("file:".length).trim() });
		else if (entry.startsWith("evidence:")) artifacts.push({ kind: "evidence", description: entry.slice("evidence:".length).trim() });
		else return undefined;
	}
	return artifacts.length > 0 ? artifacts : undefined;
}

async function draftRun(ui: PiStatusUi & Partial<PiConfigUi>, input: RunDraftInput): Promise<RunDraftResult> {
	const dialogs = getDialogSurface(ui);
	const declaredOutcome = await dialogs.input("Run declared outcome", "What should this Run accomplish?");
	if (declaredOutcome === undefined) return { kind: "cancelled" };
	const tasks: RunDraft["tasks"] = [];
	while (true) {
		const requiredOutcome = await dialogs.input(`Task ${tasks.length + 1} required outcome`, "The concrete outcome for this Task");
		if (requiredOutcome === undefined) return { kind: "cancelled" };
		const allowedScopeText = await dialogs.input("Task allowed scope", "One relative path per line");
		if (allowedScopeText === undefined) return { kind: "cancelled" };
		const artifactText = await dialogs.input("Task expected Artifacts", "git-commit, file:reports/result.md, or evidence:description per line");
		if (artifactText === undefined) return { kind: "cancelled" };
		const expectedArtifacts = parseArtifacts(artifactText);
		if (!expectedArtifacts) {
			ui.notify("Expected Artifacts must use git-commit, file:path, or evidence:description.", "error");
			return { kind: "cancelled" };
		}
		const verificationKind = await dialogs.select("Task verification", ["Command", "Criteria", "Cancel"]);
		if (!verificationKind || verificationKind === "Cancel") return { kind: "cancelled" };
		const verificationText = await dialogs.input(verificationKind === "Command" ? "Verification command" : "Verification criteria", "Exact inert verification text");
		if (verificationText === undefined) return { kind: "cancelled" };
		let verification: Verification = verificationKind === "Command" ? { kind: "command", command: verificationText } : { kind: "criteria", criteria: verificationText };
		const codeChanging = expectedArtifacts.some((artifact) => artifact.kind === "git-commit");
		if (verification.kind === "criteria" && codeChanging) {
			const waiver = await dialogs.input("Deterministic command waiver", "Required for code-changing criteria verification");
			if (waiver === undefined) return { kind: "cancelled" };
			verification = { kind: "criteria", criteria: verification.criteria, deterministicCommandWaiver: waiver };
		}
		let reviewRequired = true;
		if (codeChanging) {
			reviewRequired = await dialogs.confirm("Require Review for this code-changing Task?", "Review is required by default. Choose no only if you explicitly accept the risk.");
			if (!reviewRequired && !(await dialogs.confirm("Confirm Review disabled", "This code-changing Task will proceed without Review."))) return { kind: "cancelled" };
		}
		const task = { requiredOutcome, allowedScope: lines(allowedScopeText), expectedArtifacts, verification, reviewRequired };
		ui.notify(
			[`Task ${tasks.length + 1} draft`, `requiredOutcome: ${task.requiredOutcome}`, `allowedScope: ${task.allowedScope.join(", ")}`, `expectedArtifacts: ${task.expectedArtifacts.map((artifact) => artifact.kind).join(", ")}`, `verification: ${task.verification.kind}`, `reviewRequired: ${task.reviewRequired}`].join("\n"),
			"info",
		);
		const taskAction = await dialogs.select(`Accept Task ${tasks.length + 1}?`, ["Accept Task", "Edit Task", "Cancel"]);
		if (!taskAction || taskAction === "Cancel") return { kind: "cancelled" };
		if (taskAction === "Edit Task") continue;
		tasks.push(task);
		const next = await dialogs.select("Run draft", ["Add another Task", "Review Run draft", "Cancel"]);
		if (!next || next === "Cancel") return { kind: "cancelled" };
		if (next === "Review Run draft") break;
	}
	const modelPlans = await editModelPlans(dialogs, {
		recovery: input.recovery,
		modelPlans: input.modelPlans,
		recoveryPath: "not saved by /steward start",
		modelPlansPath: "not saved by /steward start",
		modelChoices: input.modelChoices,
		proposal: undefined,
	});
	if (!modelPlans) return { kind: "cancelled" };
	const finalKind = await dialogs.select("Final verification", ["Command", "Criteria", "Cancel"]);
	if (!finalKind || finalKind === "Cancel") return { kind: "cancelled" };
	const finalText = await dialogs.input(finalKind === "Command" ? "Final verification command" : "Final verification criteria", "Exact inert verification text");
	if (finalText === undefined) return { kind: "cancelled" };
	let finalVerification: Verification = finalKind === "Command" ? { kind: "command", command: finalText } : { kind: "criteria", criteria: finalText };
	if (finalVerification.kind === "criteria" && tasks.some((task) => task.expectedArtifacts.some((artifact) => artifact.kind === "git-commit"))) {
		const waiver = await dialogs.input("Final deterministic command waiver", "Required for code-changing criteria verification");
		if (waiver === undefined) return { kind: "cancelled" };
		finalVerification = { kind: "criteria", criteria: finalVerification.criteria, deterministicCommandWaiver: waiver };
	}
	return { kind: "drafted", draft: { declaredOutcome, tasks, modelPlan: modelPlans, effectiveSettings: { ...input.recovery }, finalVerification } };
}

/** Present status and configuration through Pi's informational UI primitives. */
export function createPiUiAdapter(ui: PiStatusUi & Partial<PiConfigUi>): StewardUiAdapter {
	function presentStatus(statusView: StatusView, target: StatusTarget): void {
		if (target === "command") ui.notify(statusView.markdown, "info");
		ui.setStatus(STATUS_KEY, statusView.footer.text);
	}

	function presentConfigurationResult(result: ConfigureResult): void {
		if (result.kind === "saved" || result.kind === "cancelled") {
			ui.notify(result.message, "info");
			return;
		}
		const details = "diagnostics" in result ? result.diagnostics.map((item) => `${item.code}${item.role ? ` ${item.role}[${item.index ?? 0}]` : ""}: ${item.message}`).join("\n") : "";
		ui.notify(details ? `${result.message}\n${details}` : result.message, "error");
	}

	function presentStartResult(result: import("./steward.ts").StartResult): void {
		ui.notify(result.message, result.kind === "started" || result.kind === "started-and-dispatched" ? "info" : result.kind === "started-with-warning" || result.kind === "started-and-dispatched-with-warning" || result.kind === "started-dispatch-pending" ? "warning" : result.kind === "cancelled" ? "info" : "error");
	}

	return {
		presentStatus,
		editConfiguration: (input) => editConfiguration(ui, input),
		presentConfigurationResult,
		draftRun: (input) => draftRun(ui, input),
		confirmRun: (summary) => ui.confirm!("Confirm Steward Run", summary.markdown),
		presentStartResult,
	};
}

/** Assemble production adapters for one request without growing the seven-slot seam. */
export function createProductionAdapters(request: StewardHostRequest, options?: ConfigStoreOptions): StewardDependencies {
	const emptyProcess: OpaqueAdapter = {};
	return {
		runJournal: createRunJournalAdapter(options),
		herdr: createHerdrAdapter(request.exec),
		git: createGitAdapter(request.exec),
		process: emptyProcess,
		model: createPiModelAdapter(request.modelRegistry, request.scopedModels),
		clock: createClockAdapter(),
		ui: createPiUiAdapter(request.ui),
	};
}
