import { lstatSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";

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
import type {
	ActiveRunProbe,
	ConfigurationEditResult,
	ConfigurationEditorInput,
	ConfigureResult,
	OpaqueAdapter,
	RunJournalAdapter,
	StatusTarget,
	StatusView,
	StewardDependencies,
	StewardModelAdapter,
	StewardUiAdapter,
	StewardUiSurface,
} from "./steward.ts";

const STEWARD_DIRECTORY_NAME = "steward";
const ACTIVE_RUN_FILE_NAME = "active-run.json";
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
}

function activeRunPath(repositoryRoot: string): string {
	return join(repositoryRoot, CONFIG_DIR_NAME, STEWARD_DIRECTORY_NAME, ACTIVE_RUN_FILE_NAME);
}

function isMissingPath(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function safeErrorText(error: unknown): string {
	return error instanceof Error && error.message.length > 0 ? error.message : "Authentication resolution failed.";
}

/** Probe only the Steward-owned active journal path, without creating its parents. */
export function createRunJournalAdapter(options?: ConfigStoreOptions): RunJournalAdapter {
	const configStore = createConfigStore(options);

	function probeActive(repositoryRoot: string): ActiveRunProbe {
		try {
			lstatSync(activeRunPath(repositoryRoot));
			return "present";
		} catch (error: unknown) {
			if (isMissingPath(error)) return "missing";
			return "present";
		}
	}

	return {
		probeActive,
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

	return {
		presentStatus,
		editConfiguration: (input) => editConfiguration(ui, input),
		presentConfigurationResult,
	};
}

/** Assemble production adapters for one request without growing the seven-slot seam. */
export function createProductionAdapters(request: StewardHostRequest, options?: ConfigStoreOptions): StewardDependencies {
	const emptyHerdr: OpaqueAdapter = {};
	const emptyGit: OpaqueAdapter = {};
	const emptyProcess: OpaqueAdapter = {};
	const emptyClock: OpaqueAdapter = {};
	return {
		runJournal: createRunJournalAdapter(options),
		herdr: emptyHerdr,
		git: emptyGit,
		process: emptyProcess,
		model: createPiModelAdapter(request.modelRegistry, request.scopedModels),
		clock: emptyClock,
		ui: createPiUiAdapter(request.ui),
	};
}
