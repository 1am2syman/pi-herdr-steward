import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
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
	StewardProcessAdapter,
	StewardClockAdapter,
	StewardModelAdapter,
	StewardUiAdapter,
	StewardUiSurface,
	ManagedAgentIdentity,
	ManagedAgentInspection,
	MonitorDigest,
	MonitorLifecycle,
	MonitorWaitResult,
	ManagedWorktreeProgress,
	HerdrTaskFactAnswerResult,
} from "./steward.ts";
import type { ReviewerChoiceInspection } from "./review.ts";
import { parseTaskFactRequest, type TaskFactRequestResult } from "./reconciliation.ts";
import { createHash } from "node:crypto";

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
	exec?: (command: string, args: string[], options?: { cwd?: string; timeout?: number; signal?: AbortSignal }) => Promise<ExecResult>;
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
		inspectAttemptReport: runStore.inspectAttemptReport,
		inspectAttemptAssignment: runStore.inspectAttemptAssignment,
		inspectAttemptPreservation: runStore.inspectAttemptPreservation,
		resolveAssignmentPaths: runStore.resolveAssignmentPaths,
		createAssignment: runStore.createAssignment,
		loadBuilderEvidenceInputs: runStore.loadBuilderEvidenceInputs,
		loadReviewerEvidenceInputs: runStore.loadReviewerEvidenceInputs,
		loadFinalizedEvidenceManifest: runStore.loadFinalizedEvidenceManifest,
		inspectReferencedEvidence: runStore.inspectReferencedEvidence,
		inspectReferencedReviewerEvidence: runStore.inspectReferencedReviewerEvidence,
		finalizeBuilderEvidence: runStore.finalizeBuilderEvidence,
		finalizeReviewerEvidence: runStore.finalizeReviewerEvidence,
		resolveCompletionPaths: runStore.resolveCompletionPaths,
		finalizeVerificationResult: runStore.finalizeVerificationResult,
		archiveCompletedRun: runStore.archiveCompletedRun,
		loadCompletionJournalPointers: runStore.loadCompletionJournalPointers,
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

	async function inspectModelChoice(choice: ModelChoice, role: ModelRole, index: number): Promise<ReviewerChoiceInspection> {
		const parsed = parseCanonicalModelReference(choice.model);
		if (!parsed) return { choice: { ...choice }, available: false, diagnostics: [modelDiagnostic("invalid-model", role, index, choice.model, "Model reference is not an exact provider/model-id value.")] };
		const model = modelRegistry.find(parsed.provider, parsed.modelId);
		if (!model) return { choice: { ...choice }, available: false, diagnostics: [modelDiagnostic("invalid-model", role, index, choice.model, "Exact model reference was not found in the host registry.")] };
		let auth: Awaited<ReturnType<HostModelRegistry["getApiKeyAndHeaders"]>>;
		try { auth = await modelRegistry.getApiKeyAndHeaders(model); } catch (error: unknown) { return { choice: { ...choice }, available: false, diagnostics: [modelDiagnostic("unauthenticated-model", role, index, choice.model, safeErrorText(error))] }; }
		if (!auth.ok) return { choice: { ...choice }, available: false, diagnostics: [modelDiagnostic("unauthenticated-model", role, index, choice.model, auth.error)] };
		const availableToSession = exactModelInList(modelRegistry.getAvailable(), choice.model);
		const scopedToSession = scopedModels.length === 0 || exactModelInScope(scopedModels, choice.model);
		if (!availableToSession || !scopedToSession) return { choice: { ...choice }, available: false, diagnostics: [modelDiagnostic("unavailable-model", role, index, choice.model, "Model is not available in the current host catalogue or session scope.")] };
		if (unsupportedThinking(model, choice.thinkingLevel)) return { choice: { ...choice }, available: false, diagnostics: [modelDiagnostic("unsupported-thinking-level", role, index, choice.model, `Thinking level ${choice.thinkingLevel} is not supported by the exact model.`)] };
		return { choice: { ...choice }, available: true, diagnostics: [] };
	}

	async function validateModelPlans(modelPlans: ProjectModelPlans): Promise<ConfigDiagnostic[]> {
		const diagnostics: ConfigDiagnostic[] = [];
		for (const role of ["builder", "reviewer"] as const) {
			const choices = [modelPlans[role].primary, ...modelPlans[role].fallbacks];
			for (let index = 0; index < choices.length; index += 1) {
				const inspection = await inspectModelChoice(choices[index]!, role, index);
				if (!inspection.available) diagnostics.push(...inspection.diagnostics);
			}
		}
		return diagnostics;
	}

	return { listModelChoices, validateModelPlans, inspectModelChoice };
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

function lifecycleValue(value: unknown): MonitorLifecycle | undefined {
	if (value === "working") return "working";
	if (value === "blocked") return "blocked";
	if (value === "idle") return "idle";
	if (value === "done" || value === "completed") return "done";
	if (value === "unknown") return "unknown";
	return undefined;
}

function exactManagedAgent(identity: ManagedAgentIdentity, result: ExecResult, envelopeId: "cli:agent:get" | "cli:agent:wait"): ManagedAgentInspection | undefined {
	const envelope = safeEnvelope(result);
	const value = resultObject(envelope);
	const agent = objectValue(value?.agent);
	const actual = identityFields(agent);
	const lifecycle = lifecycleValue(agent?.agent_status);
	const sequence = agent?.state_change_seq;
	if (envelope?.id !== envelopeId || value?.type !== "agent_info" || agent?.agent !== "pi" || !actual || actual.name !== identity.name || actual.workspaceId !== identity.workspaceId || actual.paneId !== identity.paneId || actual.terminalId !== identity.terminalId || !lifecycle || (sequence !== undefined && sequence !== null && (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0))) return undefined;
	return { kind: "observed", identity: { ...identity }, lifecycle, stateChangeSequence: sequence === undefined || sequence === null ? null : sequence };
}

function monitorDigest(bytes: Buffer): Extract<MonitorDigest, { kind: "observed" }> {
	return { kind: "observed", byteCount: bytes.length, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
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
		async createReviewerPane(input) {
			if (!exec) return { kind: "failed", stage: "pane-split", code: "runner-unavailable", message: "The Pi command runner is unavailable." };
			let result: ExecResult;
			try {
				result = await exec("herdr", ["pane", "split", "--pane", input.sourcePaneId, "--direction", "right", "--cwd", input.worktreePath, "--no-focus"], { cwd: input.repositoryRoot, timeout: 30000 });
			} catch (error: unknown) {
				return { kind: "failed", stage: "pane-split", code: "runner-error", message: error instanceof Error ? error.message : "Herdr pane split failed." };
			}
			const envelope = safeEnvelope(result);
			const resultValue = resultObject(envelope);
			const pane = objectValue(resultValue?.pane);
			if (resultValue?.type === "pane_split" && pane && safeIdentity(pane.workspace_id) && safeIdentity(pane.tab_id) && safeIdentity(pane.pane_id) && safeIdentity(pane.terminal_id) && pane.workspace_id === input.workspaceId && pane.source_pane_id === input.sourcePaneId && pane.cwd === input.worktreePath) return { kind: "created", workspaceId: pane.workspace_id, tabId: pane.tab_id, paneId: pane.pane_id, terminalId: pane.terminal_id, sourcePaneId: input.sourcePaneId, worktreePath: input.worktreePath };
			const error = safeErrorEnvelope(result);
			return { kind: "failed", stage: "pane-split", code: error?.code ?? (result.killed ? "killed" : "malformed-response"), message: error?.message ?? "Herdr returned no valid pane_split envelope." };
		},
		async startReviewer(input) {
			if (!exec) return { kind: "failed", stage: "agent-start", code: "runner-unavailable", message: "The Pi command runner is unavailable." };
			let result: ExecResult;
			try { result = await exec("herdr", ["agent", "start", input.name, "--kind", "pi", "--pane", input.paneId, "--timeout", "30000", "--", "--model", input.model.model, "--thinking", input.model.thinkingLevel], { cwd: input.repositoryRoot, timeout: 30000 }); }
			catch (error: unknown) { return { kind: "failed", stage: "agent-start", code: "runner-error", message: error instanceof Error ? error.message : "Herdr Reviewer start failed." }; }
			const collision = safeErrorEnvelope(result);
			if (collision?.id === "cli:agent:start" && collision.code === "agent_name_taken") return { kind: "name-collision", code: "agent_name_taken", message: collision.message };
			const value = resultObject(safeEnvelope(result));
			const agent = objectValue(value?.agent);
			const identity = identityFields(agent);
			if (value?.type === "agent_started" && identity && identity.name === input.name && identity.paneId === input.paneId && agent?.agent === "pi" && agent.agent_status === "idle" && agent.interactive_ready === true && exactPiArgv(agent.argv, input.model)) return { kind: "started", agentKind: "pi", name: identity.name, workspaceId: identity.workspaceId, tabId: identity.tabId, paneId: identity.paneId, terminalId: identity.terminalId };
			return { kind: "failed", stage: "agent-start", code: collision?.code ?? (result.killed ? "killed" : "malformed-response"), message: collision?.message ?? "Herdr returned no valid Reviewer agent_started envelope." };
		},
		async promptReviewer(input) {
			if (!exec) return { kind: "failed", stage: "agent-prompt", code: "runner-unavailable", message: "The Pi command runner is unavailable." };
			let result: ExecResult;
			try { result = await exec("herdr", ["agent", "prompt", input.name, input.assignmentPrompt], { cwd: input.repositoryRoot, timeout: 30000 }); }
			catch (error: unknown) { return { kind: "failed", stage: "agent-prompt", code: "runner-error", message: error instanceof Error ? error.message : "Herdr Reviewer prompt failed." }; }
			const value = resultObject(safeEnvelope(result));
			const identity = identityFields(objectValue(value?.agent));
			if (value?.type === "agent_prompted" && identity && identity.name === input.name) return { kind: "prompted", name: identity.name, workspaceId: identity.workspaceId, tabId: identity.tabId, paneId: identity.paneId, terminalId: identity.terminalId };
			const error = safeErrorEnvelope(result);
			return { kind: "failed", stage: "agent-prompt", code: error?.code ?? (result.killed ? "killed" : "malformed-response"), message: error?.message ?? "Herdr returned no valid Reviewer agent_prompted envelope." };
		},
		async readBlockedTaskFactRequest(identity, role): Promise<TaskFactRequestResult> {
			if (!exec) return { kind: "unclear", diagnostic: "The Pi command runner is unavailable." };
			let preflight: ManagedAgentInspection;
			try { preflight = await this.inspectManagedAgent!(identity); } catch (error: unknown) { return { kind: "unclear", diagnostic: error instanceof Error ? error.message : "Blocked-agent preflight failed." }; }
			if (preflight.kind !== "observed" || preflight.identity.name !== identity.name || preflight.identity.workspaceId !== identity.workspaceId || preflight.identity.paneId !== identity.paneId || preflight.identity.terminalId !== identity.terminalId || preflight.lifecycle !== "blocked") return { kind: "unclear", diagnostic: "The recorded agent was not observed as the exact blocked resource." };
			try {
				const result = await exec("herdr", ["agent", "read", identity.name, "--source", "detection", "--lines", "200"], { timeout: 5_000 });
				if (result.code !== 0 || result.killed || result.stderr.length > 0 || result.stdout.length > 16 * 1024) return { kind: "unclear", diagnostic: result.stderr.trim() || "Herdr blocked-agent detection was unavailable." };
				return parseTaskFactRequest(result.stdout, role);
			} catch (error: unknown) { return { kind: "unclear", diagnostic: error instanceof Error ? error.message : "Herdr blocked-agent detection failed." }; }
		},
		async answerBlockedTaskFact(input): Promise<HerdrTaskFactAnswerResult> {
			if (!exec || input.answer.length === 0 || input.answer.length > 16 * 1024 || !/^STEWARD_TASK_FACT_ANSWER [A-Za-z0-9_-]+$/.test(input.answer)) return { kind: "failed", message: "Task-fact answer is not a bounded canonical payload." };
			let preflight: ManagedAgentInspection;
			try { preflight = await this.inspectManagedAgent!(input.identity); } catch (error: unknown) { return { kind: "ambiguous", message: error instanceof Error ? error.message : "Blocked-agent preflight failed." }; }
			if (preflight.kind !== "observed" || preflight.identity.name !== input.identity.name || preflight.identity.workspaceId !== input.identity.workspaceId || preflight.identity.paneId !== input.identity.paneId || preflight.identity.terminalId !== input.identity.terminalId || preflight.lifecycle !== "blocked") return { kind: "ambiguous", message: "The exact recorded blocked agent could not be preflighted." };
			try {
				const result = await exec("herdr", ["agent", "send-keys", input.identity.name, input.answer, "enter"], { timeout: 5_000 });
				const envelope = safeEnvelope(result);
				const value = resultObject(envelope);
				const actual = objectValue(value?.agent);
				if (envelope?.id === "cli:agent:send-keys" && value?.type === "agent_keys_sent" && actual && safeIdentity(actual.name) && safeIdentity(actual.workspace_id) && safeIdentity(actual.pane_id) && safeIdentity(actual.terminal_id) && actual.name === input.identity.name && actual.workspace_id === input.identity.workspaceId && actual.pane_id === input.identity.paneId && actual.terminal_id === input.identity.terminalId) return { kind: "acknowledged", identity: { ...input.identity } };
				return { kind: result.killed ? "ambiguous" : "failed", message: "Herdr returned no exact same-identity Task-fact acknowledgement." };
			} catch (error: unknown) { return { kind: "ambiguous", message: error instanceof Error ? error.message : "Task-fact input delivery failed." }; }
		},
		async requestAttemptReport(input) {
			if (!exec || !safeIdentity(input.identity.name) || !safeIdentity(input.identity.workspaceId) || !safeIdentity(input.identity.paneId) || !safeIdentity(input.identity.terminalId) || !isAbsolute(input.reportPath) || !isAbsolute(input.assignmentPath) || !isAbsolute(input.evidenceDirectory)) return { kind: "failed", stage: "agent-prompt", code: "invalid-input", message: "Attempt report request identity or paths are not exact." };
			const prompt = `Steward ${input.role} report request: write exactly one valid Attempt Report to ${input.reportPath}. Use the existing Assignment at ${input.assignmentPath} and evidence directory ${input.evidenceDirectory}; do not restart the Task, change scope, or dispatch another agent.`;
			try {
				const result = await exec("herdr", ["agent", "prompt", input.identity.name, prompt], { timeout: 30_000 });
				const envelope = safeEnvelope(result);
				const value = resultObject(envelope);
				const actual = identityFields(objectValue(value?.agent));
				if (envelope?.id === "cli:agent:prompt" && value?.type === "agent_prompted" && actual && actual.name === input.identity.name && actual.workspaceId === input.identity.workspaceId && actual.paneId === input.identity.paneId && actual.terminalId === input.identity.terminalId) return { kind: "prompted", name: actual.name, workspaceId: actual.workspaceId, tabId: actual.tabId, paneId: actual.paneId, terminalId: actual.terminalId };
				return { kind: "failed", stage: "agent-prompt", code: result.killed ? "killed" : "ambiguous-response", message: "Herdr returned no exact same-identity report-request acknowledgement." };
			} catch (error: unknown) { return { kind: "failed", stage: "agent-prompt", code: "runner-error", message: error instanceof Error ? error.message : "Attempt report request failed." }; }
		},
		async stopAgentGracefully(input) {
			if (!exec) return { kind: "failed", message: "The Pi command runner is unavailable." };
			let result: ExecResult;
			try {
				result = await exec("herdr", ["agent", "prompt", input.name, "/quit"], { cwd: input.repositoryRoot, timeout: 30000 });
			} catch (error: unknown) {
				return { kind: "ambiguous", message: error instanceof Error ? error.message : "Herdr /quit prompt failed." };
			}
			const value = resultObject(safeEnvelope(result));
			const identity = identityFields(objectValue(value?.agent));
			if (value?.type === "agent_prompted" && identity && identity.name === input.name && identity.workspaceId === input.workspaceId && identity.paneId === input.paneId && identity.terminalId === input.terminalId) return { kind: "acknowledged", name: identity.name, workspaceId: identity.workspaceId, tabId: identity.tabId, paneId: identity.paneId, terminalId: identity.terminalId };
			const error = safeErrorEnvelope(result);
			return { kind: result.killed ? "ambiguous" : "failed", message: error?.message ?? "Herdr returned no valid same-identity /quit acknowledgement." };
		},
		async inspectManagedAgent(identity) {
			if (!exec) return { kind: "unclear", diagnostic: "The Pi command runner is unavailable." };
			try {
				const result = await exec("herdr", ["agent", "get", identity.name], { timeout: 5000 });
				const observed = exactManagedAgent(identity, result, "cli:agent:get");
				if (observed) return observed;
				const error = safeErrorEnvelope(result);
				if (error?.id === "cli:agent:get" && error.code === "agent_not_found" && result.stdout.trim() === "") return { kind: "missing", diagnostic: error.message };
				return { kind: "unclear", diagnostic: result.killed ? "Herdr agent get was killed." : error?.message ?? "Herdr returned no valid same-identity agent_info envelope." };
			} catch (error: unknown) {
				return { kind: "unclear", diagnostic: error instanceof Error ? error.message : "Herdr agent get failed." };
			}
		},
		async waitForManagedAgent(identity, timeoutMs, signal): Promise<MonitorWaitResult> {
			if (!exec) return { kind: "unavailable", diagnostic: "The Pi command runner is unavailable." };
			try {
				const result = await exec("herdr", ["agent", "wait", identity.name, "--until", "idle", "--until", "done", "--until", "blocked", "--until", "unknown", "--timeout", String(timeoutMs)], { timeout: timeoutMs + 1000, signal });
				if (result.killed || signal.aborted) return { kind: "cancelled" };
				const observed = exactManagedAgent(identity, result, "cli:agent:wait");
				if (observed) {
					if (observed.kind === "observed" && observed.lifecycle === "working") return { kind: "unavailable", diagnostic: "Herdr wait returned a still-working agent; no busy-loop was started." };
					if (observed.kind !== "observed") return { kind: "unavailable", diagnostic: observed.diagnostic };
					return { kind: "settled", lifecycle: observed.lifecycle as Extract<MonitorLifecycle, "idle" | "done" | "blocked" | "unknown">, identity: observed.identity, stateChangeSequence: observed.stateChangeSequence };
				}
				const error = safeErrorEnvelope(result);
				if (error?.id !== "cli:agent:wait") return { kind: "unavailable", diagnostic: error?.message ?? "Herdr returned no valid same-identity wait envelope." };
				if (error.code.toLowerCase().includes("timeout") || error.message.toLowerCase().includes("timeout")) return { kind: "timeout" };
				return { kind: "unavailable", diagnostic: error?.message ?? "Herdr returned no valid same-identity wait envelope." };
			} catch (error: unknown) {
				return signal.aborted || (error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("abort"))) ? { kind: "cancelled" } : { kind: "unavailable", diagnostic: error instanceof Error ? error.message : "Herdr agent wait failed." };
			}
		},
		async readManagedTerminal(identity) {
			if (!exec) return { kind: "unavailable", diagnostic: "The Pi command runner is unavailable." };
			try {
				const result = await exec("herdr", ["agent", "read", identity.name, "--source", "recent-unwrapped", "--lines", "200"], { timeout: 5000 });
					if (result.code !== 0 || result.killed || result.stderr.length > 0 || result.stdout.length > 256 * 1024) return { kind: "unavailable", diagnostic: result.stderr.trim() || "Herdr terminal read was unavailable." };
				return monitorDigest(Buffer.from(result.stdout, "utf8"));
			} catch (error: unknown) {
				return { kind: "unavailable", diagnostic: error instanceof Error ? error.message : "Herdr terminal read failed." };
			}
		},
	};
}

/** Execute only the Controller-owned frozen verification envelope. */
export function createProcessAdapter(exec: CommandRunner | undefined): StewardProcessAdapter {
	return {
		async runApprovedVerification(input) {
			if (!exec) return { kind: "thrown", message: "The Pi command runner is unavailable." };
			if (input.command.length === 0 || input.command !== input.command.trim() || !isAbsolute(input.cwd) || input.cwd !== resolve(input.cwd)) return { kind: "thrown", message: "Verification command or cwd is not an exact safe value." };
			try {
				const result = await exec("/bin/sh", ["-c", input.command], { cwd: input.cwd });
				return { kind: "completed", code: result.code, stdout: result.stdout, stderr: result.stderr, killed: result.killed };
			} catch (error: unknown) {
				return { kind: "thrown", message: error instanceof Error ? error.message : "Verification process failed before a result was returned." };
			}
		},
	};
}

export function createGitAdapter(exec: CommandRunner | undefined): StewardGitAdapter {
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
				if (head.code !== 0 || head.killed || head.stdout.trim() !== expectedRevision) return { kind: "unavailable", message: "Builder worktree HEAD does not equal the expected reviewed revision." };
				const status = await exec!("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: worktreePath, timeout: 5000 });
				if (status.code !== 0 || status.killed) return { kind: "unavailable", message: "Builder worktree clean-state inspection failed." };
				if (status.stdout.length > 0) return { kind: "unavailable", message: "Builder worktree is not clean before dispatch." };
				return { kind: "ready", head: expectedRevision, clean: true };
			} catch (error: unknown) {
				return { kind: "unavailable", message: error instanceof Error ? error.message : "Builder worktree inspection failed." };
			}
		},
		async inspectReviewWorktree(worktreePath) {
			try {
				const head = await execCommand(worktreePath, ["rev-parse", "--verify", "HEAD"]);
				if (head.code !== 0 || head.killed || !/^[0-9a-f]{40}\n?$/.test(head.stdout)) return { kind: "unavailable", message: "Review worktree HEAD could not be inspected." };
				const status = await execCommand(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
				const dirtyPaths = parsePorcelainPaths(status.stdout, status.code, status.killed, status.stderr);
				if (!dirtyPaths) return { kind: "unavailable", message: "Review worktree dirty-state inspection returned malformed output." };
				const markerRoot = await operationMarkerRoot(worktreePath);
				const operationMarkers: string[] = [];
				for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
					try { lstatSync(join(markerRoot, marker)); operationMarkers.push(marker); } catch (error: unknown) { if (!isMissing(error)) return { kind: "unavailable", message: `Git operation state could not be inspected (${marker}).` }; }
				}
				operationMarkers.sort();
				const statusBytes = Buffer.from(status.stdout, "utf8");
				const framing = Buffer.concat([Buffer.from("steward-review-worktree-v1\0", "utf8"), Buffer.from(`${statusBytes.length}\0`, "utf8"), statusBytes, Buffer.from("\0", "utf8"), Buffer.from(operationMarkers.join("\0"), "utf8")]);
				return { head: head.stdout.trim(), dirtyStateFingerprint: `sha256:${createHash("sha256").update(framing).digest("hex")}`, dirtyPaths, operationMarkers };
			} catch (error: unknown) { return { kind: "unavailable", message: error instanceof Error ? error.message : "Review worktree inspection failed." }; }
		},
		async inspectProducedCodeArtifact(input) {
			if (!/^[0-9a-f]{40}$/.test(input.approvedBase) || !/^[0-9a-f]{40}$/.test(input.producedHead)) return { kind: "invalid", code: "missing-revision", message: "Git Artifact requires full lowercase base and head revisions." };
			try {
				const base = await execCommand(input.worktreePath, ["rev-parse", "--verify", `${input.approvedBase}^{commit}`]);
				const head = await execCommand(input.worktreePath, ["rev-parse", "--verify", `${input.producedHead}^{commit}`]);
				if (base.code !== 0 || head.code !== 0 || base.killed || head.killed || !/^[0-9a-f]{40}\n?$/.test(base.stdout) || !/^[0-9a-f]{40}\n?$/.test(head.stdout)) return { kind: "invalid", code: "missing-revision", message: "Git base or produced head is not a resolvable full revision." };
				const ancestor = await execCommand(input.worktreePath, ["merge-base", "--is-ancestor", input.approvedBase, input.producedHead]);
				if (ancestor.code !== 0 || ancestor.killed) return { kind: "invalid", code: "base-not-ancestor", message: "Approved Git base is not an ancestor of the produced head." };
				const currentHead = await execCommand(input.worktreePath, ["rev-parse", "--verify", "HEAD"]);
				if (currentHead.code !== 0 || currentHead.killed || currentHead.stdout.trim() !== input.producedHead) return { kind: "invalid", code: "head-mismatch", message: "Builder worktree HEAD does not equal the reported produced head." };
				const commitsResult = await execCommand(input.worktreePath, ["rev-list", "--reverse", `${input.approvedBase}..${input.producedHead}`]);
				if (commitsResult.code !== 0 || commitsResult.killed || commitsResult.stderr.length > 0) return { kind: "invalid", code: "git-inspection-failed", message: "Git commit range could not be inspected." };
				const commits = commitsResult.stdout.endsWith("\n") ? commitsResult.stdout.slice(0, -1).split("\n") : commitsResult.stdout.length === 0 ? [] : commitsResult.stdout.split("\n");
				if (commits.length === 0) return { kind: "invalid", code: "empty-range", message: "Produced Git Artifact has an empty base..head range." };
				if (commits.some((commit) => !/^[0-9a-f]{40}$/.test(commit)) || new Set(commits).size !== commits.length || commits[commits.length - 1] !== input.producedHead) return { kind: "invalid", code: "malformed-git-output", message: "Git returned a malformed or contradictory full commit range." };
				const changesResult = await execCommand(input.worktreePath, ["diff", "--name-status", "-z", "--find-renames", "--find-copies", input.approvedBase, input.producedHead]);
				const changedPaths = parseNameStatus(changesResult.stdout, changesResult.code, changesResult.killed, changesResult.stderr);
				if (!changedPaths) return { kind: "invalid", code: "malformed-git-output", message: "Git returned malformed name-status output." };
				const markerRoot = await operationMarkerRoot(input.worktreePath);
				for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
					try {
						await lstatSync(join(markerRoot, marker));
						return { kind: "invalid", code: "git-operation-in-progress", message: `Git operation is in progress (${marker}).` };
					} catch (error: unknown) {
						if (!isMissing(error)) return { kind: "invalid", code: "git-inspection-failed", message: `Git operation state could not be inspected (${marker}).` };
					}
				}
				const dirtyResult = await execCommand(input.worktreePath, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
				const dirtyPaths = parsePorcelainPaths(dirtyResult.stdout, dirtyResult.code, dirtyResult.killed, dirtyResult.stderr);
				if (!dirtyPaths) return { kind: "invalid", code: "git-inspection-failed", message: "Git dirty-state inspection failed." };
				if (dirtyPaths.length > 0) return { kind: "invalid", code: "dirty-worktree", message: "Builder worktree contains tracked, staged, or untracked changes.", dirtyPaths };
				return { kind: "inspected", base: input.approvedBase, head: input.producedHead, commits, changedPaths, clean: true };
			} catch (error: unknown) {
				return { kind: "invalid", code: "git-inspection-failed", message: error instanceof Error ? error.message : "Git Artifact inspection failed." };
			}
		},
		async inspectIntegrationCheckout(input) {
			if (!/^[0-9a-f]{40}$/.test(input.targetRevision) || !/^[0-9a-f]{40}$/.test(input.approvedBaseRevision) || !/^[0-9a-f]{40}$/.test(input.approvedHeadRevision) || input.approvedCommits.length === 0 || input.approvedCommits.some((commit) => !/^[0-9a-f]{40}$/.test(commit))) return unavailable("Integration checkout inspection requires full immutable revisions.");
			try {
				const inside = await run(input.repositoryRoot, ["rev-parse", "--is-inside-work-tree"]);
				if (inside.code !== 0 || inside.killed || inside.stderr.length > 0 || inside.stdout.trim() !== "true") return unavailable("Integration checkout is not a Git worktree.");
				const branch = await run(input.repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
				const head = await run(input.repositoryRoot, ["rev-parse", "--verify", "HEAD"]);
				if (branch.code !== 0 || branch.killed || branch.stderr.length > 0 || head.code !== 0 || head.killed || head.stderr.length > 0 || !/^[0-9A-Za-z._/-]+\n?$/.test(branch.stdout) || !/^[0-9a-f]{40}\n?$/.test(head.stdout)) return unavailable("Integration checkout branch or HEAD is not a strict attached full revision.");
				const status = await run(input.repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
				const dirtyPaths = parsePorcelainPaths(status.stdout, status.code, status.killed, status.stderr);
				if (!dirtyPaths) return unavailable("Integration checkout dirty-state output was malformed.");
				const markerRoot = await operationMarkerRoot(input.repositoryRoot);
				const operationMarkers: string[] = [];
				for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
					try { lstatSync(join(markerRoot, marker)); operationMarkers.push(marker); } catch (error: unknown) { if (!isMissing(error)) return unavailable(`Git operation state could not be inspected (${marker}).`); }
				}
				operationMarkers.sort();
				const resolvedBase = await run(input.repositoryRoot, ["rev-parse", "--verify", `${input.approvedBaseRevision}^{commit}`]);
				const resolvedHead = await run(input.repositoryRoot, ["rev-parse", "--verify", `${input.approvedHeadRevision}^{commit}`]);
				if (resolvedBase.code !== 0 || resolvedBase.killed || resolvedBase.stderr.length > 0 || resolvedHead.code !== 0 || resolvedHead.killed || resolvedHead.stderr.length > 0 || !/^[0-9a-f]{40}\n?$/.test(resolvedBase.stdout) || !/^[0-9a-f]{40}\n?$/.test(resolvedHead.stdout)) return unavailable("Approved integration revisions could not be resolved exactly.");
				const ancestor = await run(input.repositoryRoot, ["merge-base", "--is-ancestor", input.approvedBaseRevision, input.approvedHeadRevision]);
				const range = await run(input.repositoryRoot, ["rev-list", "--reverse", `${input.approvedBaseRevision}..${input.approvedHeadRevision}`]);
				if (range.code !== 0 || range.killed || range.stderr.length > 0 || (range.stdout.length > 0 && !range.stdout.endsWith("\n"))) return unavailable("Approved Git range output was malformed.");
				const commits = range.stdout.length === 0 ? [] : range.stdout.trimEnd().split("\n");
				if (commits.some((commit) => !/^[0-9a-f]{40}$/.test(commit)) || new Set(commits).size !== commits.length) return unavailable("Approved Git range contained malformed or duplicate revisions.");
				const observation = { branch: branch.stdout.trim(), head: head.stdout.trim(), dirtyPaths, operationMarkers, rangeExact: resolvedBase.stdout.trim() === input.approvedBaseRevision && resolvedHead.stdout.trim() === input.approvedHeadRevision && ancestor.code === 0 && !ancestor.killed && ancestor.stderr.length === 0 && JSON.stringify(commits) === JSON.stringify(input.approvedCommits) };
				return { kind: "inspected", observation, resolvedBaseRevision: resolvedBase.stdout.trim(), resolvedHeadRevision: resolvedHead.stdout.trim(), commits };
			} catch (error: unknown) {
				return unavailable(error instanceof Error ? error.message : "Integration checkout inspection failed.");
			}
		},
		async inspectManagedWorktreeProgress(worktreePath): Promise<ManagedWorktreeProgress> {
			if (!isAbsolute(worktreePath) || worktreePath !== resolve(worktreePath)) return { kind: "unavailable", diagnostic: "Managed worktree path is not an exact absolute path." };
			try {
				if (await realpath(worktreePath) !== worktreePath) return { kind: "unavailable", diagnostic: "Managed worktree path resolves through a symlink." };
				const headResult = await execCommand(worktreePath, ["rev-parse", "--verify", "HEAD"]);
				if (headResult.code !== 0 || headResult.killed || headResult.stderr.length > 0 || !/^[0-9a-f]{40}\n?$/.test(headResult.stdout)) return { kind: "unavailable", diagnostic: "Managed worktree HEAD inspection was unavailable." };
				const status = await execCommand(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
				if (status.stdout.length > 16 * 1024 * 1024) return { kind: "unavailable", diagnostic: "Managed worktree status output exceeded the read bound." };
				const statusPaths = parsePorcelainPaths(status.stdout, status.code, status.killed, status.stderr);
				if (!statusPaths) return { kind: "unavailable", diagnostic: "Managed worktree status output was malformed." };
				const trackedDiff = await execCommand(worktreePath, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD"]);
				const stagedDiff = await execCommand(worktreePath, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv"]);
				if ([trackedDiff, stagedDiff].some((result) => result.code !== 0 || result.killed || result.stderr.length > 0 || result.stdout.length > 16 * 1024 * 1024)) return { kind: "unavailable", diagnostic: "Managed worktree Git diff inspection was unavailable or exceeded the read bound." };
				const untrackedFacts: string[] = [];
				const statusEntries = status.stdout.length === 0 ? [] : status.stdout.slice(0, -1).split("\u0000");
				for (const entry of statusEntries) {
					if (!entry.startsWith("?? ")) continue;
					const path = entry.slice(3);
					const absolute = resolve(worktreePath, path);
					if (!validGitPath(path) || !absolute.startsWith(`${resolve(worktreePath)}/`)) return { kind: "unavailable", diagnostic: "Managed worktree contained an unsafe untracked path." };
					const info = await lstat(absolute);
					if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024 || (await realpath(absolute)) !== absolute) return { kind: "unavailable", diagnostic: `Untracked path is not a bounded regular file: ${path}` };
					const bytes = await readFile(absolute);
					if (bytes.length !== info.size || bytes.length > 16 * 1024 * 1024) return { kind: "unavailable", diagnostic: `Untracked path changed while being observed: ${path}` };
					untrackedFacts.push(`${path}\0${monitorDigest(bytes).sha256}`);
				}
				untrackedFacts.sort();
				const statusBytes = Buffer.from(status.stdout, "utf8");
				const worktreeBytes = Buffer.concat([Buffer.from("steward-monitor-worktree-v1\0", "utf8"), statusBytes, Buffer.from(untrackedFacts.join("\0"), "utf8")]);
				const gitBytes = Buffer.concat([Buffer.from("steward-monitor-git-v1\0", "utf8"), Buffer.from(trackedDiff.stdout, "utf8"), Buffer.from("\0", "utf8"), Buffer.from(stagedDiff.stdout, "utf8")]);
				const gitDigest = monitorDigest(gitBytes);
				return { kind: "observed", head: headResult.stdout.trim(), worktree: monitorDigest(worktreeBytes), git: { head: headResult.stdout.trim(), digest: gitDigest } };
			} catch (error: unknown) {
				return { kind: "unavailable", diagnostic: error instanceof Error ? error.message : "Managed worktree progress inspection failed." };
			}
		},
		async integrateApprovedRange(input) {
			if (input.action.kind !== "fast-forward" || JSON.stringify(input.action.argv) !== JSON.stringify(["merge", "--ff-only", "--no-edit", input.approvedHeadRevision])) return { kind: "thrown", message: "Integration action is not the fixed fast-forward envelope." };
			try {
				const result = await run(input.repositoryRoot, ["merge", "--ff-only", "--no-edit", input.approvedHeadRevision]);
				return { kind: "completed", code: result.code, stdout: result.stdout, stderr: result.stderr, killed: result.killed };
			} catch (error: unknown) {
				return { kind: "thrown", message: error instanceof Error ? error.message : "Git fast-forward integration failed before a result was returned." };
			}
		},
	};

	async function execCommand(cwd: string, args: string[]): Promise<ExecResult> {
		if (!exec) throw new Error("The Pi command runner is unavailable.");
		return exec("git", args, { cwd, timeout: 5000 });
	}

	async function operationMarkerRoot(cwd: string): Promise<string> {
		const result = await execCommand(cwd, ["rev-parse", "--git-dir"]);
		if (result.code !== 0 || result.killed || result.stderr.length > 0 || result.stdout.trim() === "") throw new Error("Git metadata could not be located.");
		return resolve(cwd, result.stdout.trim());
	}
}

function validGitPath(path: string): boolean {
	if (path.length === 0 || path.includes("\\") || path.startsWith("/") || path.includes("\u0000")) return false;
	const parts = path.split("/");
	return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function parseNameStatus(stdout: string, code: number, killed: boolean, stderr: string): Array<{ status: string; paths: string[] }> | undefined {
	if (code !== 0 || killed || stderr.length > 0 || (stdout.length > 0 && !stdout.endsWith("\u0000"))) return undefined;
	if (stdout.length === 0) return [];
	const values = stdout.slice(0, -1).split("\u0000");
	const changes: Array<{ status: string; paths: string[] }> = [];
	for (let index = 0; index < values.length;) {
		const status = values[index++];
		if (!status || !/^[A-Z][0-9]{0,3}$/.test(status)) return undefined;
		const count = status[0] === "R" || status[0] === "C" ? 2 : 1;
		const paths = values.slice(index, index + count);
		if (paths.length !== count || paths.some((path) => !validGitPath(path))) return undefined;
		index += count;
		changes.push({ status, paths });
	}
	return changes;
}

function parsePorcelainPaths(stdout: string, code: number, killed: boolean, stderr: string): string[] | undefined {
	if (code !== 0 || killed || stderr.length > 0 || (stdout.length > 0 && !stdout.endsWith("\u0000"))) return undefined;
	if (stdout.length === 0) return [];
	const values = stdout.slice(0, -1).split("\u0000");
	const paths: string[] = [];
	for (let index = 0; index < values.length;) {
		const entry = values[index++];
		if (!entry || entry.length < 4 || entry[2] !== " ") return undefined;
		const status = entry.slice(0, 2);
		if (!/^[ MADRCU?!]{2}$/.test(status)) return undefined;
		if (!validGitPath(entry.slice(3))) return undefined;
		paths.push(entry.slice(3));
		if (status[0] === "R" || status[0] === "C") {
			const next = values[index++];
			if (!next || !validGitPath(next)) return undefined;
			paths.push(next);
		}
	}
	return paths;
}

function createClockAdapter(): StewardClockAdapter {
	return {
		now: () => new Date(),
		randomUUID: () => randomUUID(),
		wait: (milliseconds, signal) => new Promise<void>((resolvePromise, reject) => {
			if (signal.aborted) {
				reject(Object.assign(new Error("The monitor wait was aborted."), { name: "AbortError" }));
				return;
			}
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				resolvePromise();
			}, Math.max(0, milliseconds));
			const onAbort = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				reject(Object.assign(new Error("The monitor wait was aborted."), { name: "AbortError" }));
			};
			signal.addEventListener("abort", onAbort, { once: true });
		}),
	};
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

	function presentResumeResult(result: import("./steward.ts").ResumeResult): void {
		const message = result.kind === "reconciled" ? result.result.note : result.message;
		ui.notify(message, result.kind === "reconciled" && result.result.condition === "ordinary" ? "info" : "warning");
	}

	function notifyCompletion(input: { runId: string; targetBranch: string; integratedHead: string; verificationResultPath: string; verificationLogPath: string; archivePath: string }): void {
		ui.notify(`Steward Run ${input.runId} completed on ${input.targetBranch} at ${input.integratedHead}. Final verification: ${input.verificationResultPath} (output: ${input.verificationLogPath}). Archive: ${input.archivePath}`, "info");
	}

	function presentMonitorCondition(input: import("./steward.ts").MonitorConditionInput): void {
		ui.setStatus(STATUS_KEY, input.condition === "completed" ? undefined : input.footerText);
		if (input.notification) ui.notify(input.notification.message, input.notification.type);
	}

	async function confirmSameFamilyReview(input: { builderModel: ModelChoice; reviewerModel: ModelChoice; subject: import("./review.ts").ReviewSubject; provider: string }): Promise<boolean> {
		const dialogs = getDialogSurface(ui);
		const subject = input.subject.kind === "git" ? `Git ${input.subject.baseRevision}..${input.subject.headRevision} (${input.subject.commits.length} commit(s))` : `non-Git artifacts: ${input.subject.artifacts.map((artifact) => artifact.identity).join(", ")}`;
		return dialogs.confirm("Confirm same-provider Review", `Independent provider-family Review is unavailable. Builder: ${input.builderModel.model} [thinking=${input.builderModel.thinkingLevel}]\nReviewer: ${input.reviewerModel.model} [thinking=${input.reviewerModel.thinkingLevel}]\nProvider: ${input.provider}\nSubject: ${subject}\nConfirm this exact Reviewer for this exact subject?`);
	}

	return {
		presentStatus,
		editConfiguration: (input) => editConfiguration(ui, input),
		presentConfigurationResult,
		draftRun: (input) => draftRun(ui, input),
		confirmRun: (summary) => ui.confirm!("Confirm Steward Run", summary.markdown),
		confirmSameFamilyReview,
			presentStartResult,
			presentResumeResult,
		notifyCompletion,
		presentMonitorCondition,
	};
}

/** Assemble production adapters for one request without growing the seven-slot seam. */
export function createProductionAdapters(request: StewardHostRequest, options?: ConfigStoreOptions): StewardDependencies {
	return {
		runJournal: createRunJournalAdapter(options),
		herdr: createHerdrAdapter(request.exec),
		git: createGitAdapter(request.exec),
		process: createProcessAdapter(request.exec),
		model: createPiModelAdapter(request.modelRegistry, request.scopedModels),
		clock: createClockAdapter(),
		ui: createPiUiAdapter(request.ui),
	};
}
