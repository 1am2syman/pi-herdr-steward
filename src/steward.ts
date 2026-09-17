import type { ConfigLoadResult, ConfigSaveResult } from "./config-store.ts";
import {
	formatModelPlans,
	formatRecoveryDefaults,
	cloneRecoveryDefaults,
	cloneModelPlans,
	validateProjectModelPlans,
	validateRecoveryDefaults,
	type ConfigDiagnostic,
	type ConfigurationScope,
	type ModelChoiceOption,
	type ProjectModelPlans,
	type RecoveryDefaults,
	type ThinkingLevel,
} from "./config.ts";
import type { ActiveRunLoadResult, ActivityAppendResult, CreateActiveResult } from "./run-journal-store.ts";
import {
	buildInitialRunJournal,
	buildRunConfirmationSummary,
	createRunIdentity,
	isCodeChanging,
	validateRunJournal,
	validateRunDraft,
	type IntegrationBase,
	type RunConfirmationSummary,
	type RunDraft,
	type RunDraftInput,
	type RunDraftResult,
	type RunJournal,
} from "./run.ts";

/** The two presentation contexts supported by this slice. */
export type StatusTarget = "command" | "footer";

/** The only journal fact needed to decide ticket-01 status. */
export type ActiveRunProbe = "missing" | "present";

/** The read-only and configuration operations owned by the Run Journal adapter. */
export interface RunJournalAdapter {
	probeActive(repositoryRoot: string): ActiveRunProbe;
	loadActive(repositoryRoot: string): Promise<ActiveRunLoadResult>;
	createActive(repositoryRoot: string, journal: RunJournal): Promise<CreateActiveResult>;
	appendActivity(repositoryRoot: string, entry: import("./run.ts").ActivityEntry): Promise<ActivityAppendResult>;
	loadRecoveryDefaults(): Promise<ConfigLoadResult<RecoveryDefaults>>;
	loadModelPlans(repositoryRoot: string): Promise<ConfigLoadResult<ProjectModelPlans>>;
	saveRecoveryDefaults(recovery: RecoveryDefaults): Promise<ConfigSaveResult>;
	saveModelPlans(repositoryRoot: string, modelPlans: ProjectModelPlans): Promise<ConfigSaveResult>;
}

/** Empty adapter slots reserved for later, demonstrated uses. */
export type OpaqueAdapter = Readonly<Record<never, never>>;

export interface StewardUiSurface {
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
}

export interface ControllerSessionProposal {
	reference: string;
	thinkingLevel?: ThinkingLevel;
}

export interface ConfigurationEditorInput {
	recovery: RecoveryDefaults;
	modelPlans: ProjectModelPlans | undefined;
	recoveryPath: string;
	modelPlansPath: string;
	modelChoices: readonly ModelChoiceOption[];
	proposal: ControllerSessionProposal | undefined;
}

export type ConfigurationEditResult =
	| { kind: "cancelled" }
	| { kind: "save-recovery"; recovery: RecoveryDefaults }
	| { kind: "save-model-plans"; modelPlans: ProjectModelPlans };

/** The request-scoped presentation operations owned by the UI adapter. */
export interface StewardUiAdapter {
	presentStatus(statusView: StatusView, target: StatusTarget): void;
	editConfiguration(input: ConfigurationEditorInput): Promise<ConfigurationEditResult>;
	presentConfigurationResult(result: ConfigureResult): void;
	draftRun(input: RunDraftInput): Promise<RunDraftResult>;
	confirmRun(summary: RunConfirmationSummary): Promise<boolean>;
	presentStartResult(result: StartResult): void;
}

export interface StewardModelAdapter {
	listModelChoices(): readonly ModelChoiceOption[];
	validateModelPlans(modelPlans: ProjectModelPlans): Promise<ConfigDiagnostic[]>;
}

/** The complete, deliberately fixed orchestration seam for this ticket. */
export interface StewardHerdrAdapter {
	checkAvailability(repositoryRoot: string): Promise<HerdrAvailability>;
}

export type HerdrAvailability =
	| { kind: "available"; status: string; running: true; compatible: true; endpointCompatible: true; protocol?: number }
	| { kind: "unavailable"; message: string };

export interface StewardGitAdapter {
	inspectIntegrationBase(repositoryRoot: string): Promise<IntegrationBaseInspection>;
}

export type IntegrationBaseInspection =
	| { kind: "ready"; branch: string; revision: string }
	| { kind: "unavailable"; message: string };

export interface StewardClockAdapter {
	now(): Date;
	randomUUID(): string;
}

export interface StewardDependencies {
	runJournal: RunJournalAdapter;
	herdr: StewardHerdrAdapter;
	git: StewardGitAdapter;
	process: OpaqueAdapter;
	model: StewardModelAdapter;
	clock: StewardClockAdapter;
	ui: StewardUiAdapter;
}

export interface EmptyFooterView {
	run: "none";
	attentionCount: 0;
	text: "steward: no active Run";
}

export interface ActiveFooterView {
	run: "active";
	attentionCount: 0;
	text: "steward: active Run detected";
}

export interface EmptyStatusView {
	kind: "empty";
	markdown: "No active Steward Run exists in this repository.";
	footer: EmptyFooterView;
}

export interface ActiveStatusView {
	kind: "present";
	markdown: "An active Steward Run was detected. Detailed active status is outside ticket 01.";
	footer: ActiveFooterView;
}

export type StatusView = EmptyStatusView | ActiveStatusView;

export type ConfigureResult =
	| { kind: "cancelled"; scope?: ConfigurationScope; path?: string; message: string }
	| { kind: "saved"; scope: ConfigurationScope; path: string; message: string }
	| { kind: "invalid"; scope: ConfigurationScope; path: string; diagnostics: ConfigDiagnostic[]; message: string }
	| { kind: "load-error"; diagnostics: ConfigDiagnostic[]; message: string }
	| { kind: "save-error"; scope: ConfigurationScope; path: string; diagnostics: ConfigDiagnostic[]; message: string };

export type StartResult =
	| { kind: "cancelled"; message: string }
	| { kind: "refused"; message: string }
	| { kind: "started"; journal: RunJournal; message: string }
	| { kind: "started-with-warning"; journal: RunJournal; message: string }
	| { kind: "storage-error"; message: string };

/** The ticket-01 and ticket-02 orchestration operations. */
export interface Steward {
	status(repositoryRoot: string, target: StatusTarget): StatusView;
	configure(repositoryRoot: string, proposal?: ControllerSessionProposal): Promise<ConfigureResult>;
	start(repositoryRoot: string, controllerSessionId: string): Promise<StartResult>;
}

const EMPTY_STATUS: EmptyStatusView = {
	kind: "empty",
	markdown: "No active Steward Run exists in this repository.",
	footer: {
		run: "none",
		attentionCount: 0,
		text: "steward: no active Run",
	},
};

const PRESENT_STATUS: ActiveStatusView = {
	kind: "present",
	markdown: "An active Steward Run was detected. Detailed active status is outside ticket 01.",
	footer: {
		run: "active",
		attentionCount: 0,
		text: "steward: active Run detected",
	},
};

function buildStatusView(probe: ActiveRunProbe): StatusView {
	return probe === "missing" ? EMPTY_STATUS : PRESENT_STATUS;
}

function resultForSaveFailure(scope: ConfigurationScope, save: ConfigSaveResult): ConfigureResult {
	return {
		kind: "save-error",
		scope,
		path: save.path,
		diagnostics: save.diagnostics,
		message: `Could not save ${scope} configuration; configuration unchanged at ${save.path}.`,
	};
}

/** Assemble the plain-function orchestration seam without adding lifecycle machinery. */
export function createSteward({ runJournal, herdr, git, model, clock, ui }: StewardDependencies): Steward {
	function status(repositoryRoot: string, target: StatusTarget): StatusView {
		const statusView = buildStatusView(runJournal.probeActive(repositoryRoot));
		ui.presentStatus(statusView, target);
		return statusView;
	}

	async function configure(repositoryRoot: string, proposal?: ControllerSessionProposal): Promise<ConfigureResult> {
		const [recoveryLoad, modelPlansLoad] = await Promise.all([
			runJournal.loadRecoveryDefaults(),
			runJournal.loadModelPlans(repositoryRoot),
		]);
		const loadDiagnostics = [...recoveryLoad.diagnostics, ...modelPlansLoad.diagnostics];
		if (loadDiagnostics.length > 0 || recoveryLoad.value === undefined) {
			const result: ConfigureResult = {
				kind: "load-error",
				diagnostics:
					loadDiagnostics.length > 0
						? loadDiagnostics
						: [{ code: "load-error", message: `Could not load ${recoveryLoad.path}.`, path: recoveryLoad.path }],
				message: "Configuration could not be loaded; no changes were made.",
			};
			ui.presentConfigurationResult(result);
			return result;
		}

		const edit = await ui.editConfiguration({
			recovery: recoveryLoad.value,
			modelPlans: modelPlansLoad.value,
			recoveryPath: recoveryLoad.path,
			modelPlansPath: modelPlansLoad.path,
			modelChoices: model.listModelChoices(),
			proposal,
		});
		if (edit.kind === "cancelled") {
			const result: ConfigureResult = { kind: "cancelled", message: "Cancelled; configuration unchanged." };
			ui.presentConfigurationResult(result);
			return result;
		}

		if (edit.kind === "save-recovery") {
			const validation = validateRecoveryDefaults(edit.recovery, recoveryLoad.path);
			if (!validation.value || validation.diagnostics.length > 0) {
				const result: ConfigureResult = {
					kind: "invalid",
					scope: "recovery",
					path: recoveryLoad.path,
					diagnostics: validation.diagnostics,
					message: "Recovery defaults are invalid; configuration unchanged.",
				};
				ui.presentConfigurationResult(result);
				return result;
			}

			const save = await runJournal.saveRecoveryDefaults(validation.value);
			if (save.kind === "error") {
				const result = resultForSaveFailure("recovery", save);
				ui.presentConfigurationResult(result);
				return result;
			}
			const reloaded = await runJournal.loadRecoveryDefaults();
			if (reloaded.kind === "error" || !reloaded.value) {
				const result: ConfigureResult = {
					kind: "load-error",
					diagnostics:
						reloaded.diagnostics.length > 0
							? reloaded.diagnostics
							: [{ code: "load-error", message: `Could not reload ${reloaded.path}.`, path: reloaded.path }],
					message: `Saved ${save.path}, but could not reload it for confirmation.`,
				};
				ui.presentConfigurationResult(result);
				return result;
			}
			const result: ConfigureResult = {
				kind: "saved",
				scope: "recovery",
				path: reloaded.path,
				message: `Saved and reloaded recovery defaults at ${reloaded.path}: ${formatRecoveryDefaults(reloaded.value)}.`,
			};
			ui.presentConfigurationResult(result);
			return result;
		}

		const structural = validateProjectModelPlans(edit.modelPlans, modelPlansLoad.path);
		const diagnostics = structural.value ? await model.validateModelPlans(structural.value) : structural.diagnostics;
		if (!structural.value || diagnostics.length > 0) {
			const result: ConfigureResult = {
				kind: "invalid",
				scope: "model-plans",
				path: modelPlansLoad.path,
				diagnostics,
				message: "Model Plans are invalid; configuration unchanged.",
			};
			ui.presentConfigurationResult(result);
			return result;
		}

		const save = await runJournal.saveModelPlans(repositoryRoot, structural.value);
		if (save.kind === "error") {
			const result = resultForSaveFailure("model-plans", save);
			ui.presentConfigurationResult(result);
			return result;
		}
		const reloaded = await runJournal.loadModelPlans(repositoryRoot);
		if (reloaded.kind === "error" || !reloaded.value) {
			const result: ConfigureResult = {
				kind: "load-error",
				diagnostics:
					reloaded.diagnostics.length > 0
						? reloaded.diagnostics
						: [{ code: "load-error", message: `Could not reload ${reloaded.path}.`, path: reloaded.path }],
				message: `Saved ${save.path}, but could not reload it for confirmation.`,
			};
			ui.presentConfigurationResult(result);
			return result;
		}
		const result: ConfigureResult = {
			kind: "saved",
			scope: "model-plans",
			path: reloaded.path,
			message: `Saved and reloaded project Model Plans at ${reloaded.path}: ${formatModelPlans(reloaded.value)}.`,
		};
		ui.presentConfigurationResult(result);
		return result;
	}

	function presentStart(result: StartResult): StartResult {
		ui.presentStartResult(result);
		return result;
	}

	function refuse(message: string): StartResult {
		return presentStart({ kind: "refused", message });
	}

	async function start(repositoryRoot: string, controllerSessionId: string): Promise<StartResult> {
		let initialActive: ActiveRunLoadResult;
		try {
			initialActive = await runJournal.loadActive(repositoryRoot);
		} catch (error: unknown) {
			return refuse(`Run Journal could not be inspected; no Run was started. ${error instanceof Error ? error.message : "Read-only inspection failed."}`);
		}
		if (initialActive.kind === "loaded") return refuse(`An active Steward Run already exists at ${initialActive.paths.activePath}; use status, resume, cancel, or cleanup.`);
		if (initialActive.kind === "invalid") return refuse(`Run start is disabled because the active Run Journal is invalid at ${initialActive.paths.activePath}. Recovery snapshots: ${initialActive.paths.activePath} and ${initialActive.paths.previousPath}.`);

		let availability: HerdrAvailability;
		try {
			availability = await herdr.checkAvailability(repositoryRoot);
		} catch (error: unknown) {
			return refuse(`Herdr is unavailable; restore the running compatible server before starting a Run. ${error instanceof Error ? error.message : "Availability check failed."}`);
		}
		if (availability.kind !== "available") return refuse(`Herdr is unavailable; restore the running compatible server before starting a Run. ${availability.message}`);

		let recoveryLoad: ConfigLoadResult<RecoveryDefaults>;
		let modelPlansLoad: ConfigLoadResult<ProjectModelPlans>;
		try {
			[recoveryLoad, modelPlansLoad] = await Promise.all([runJournal.loadRecoveryDefaults(), runJournal.loadModelPlans(repositoryRoot)]);
		} catch (error: unknown) {
			return refuse(`Run start configuration could not be loaded; no changes were made. ${error instanceof Error ? error.message : "Configuration load failed."}`);
		}
		if (recoveryLoad.kind === "error" || !recoveryLoad.value || modelPlansLoad.kind === "error") {
			const diagnostics = [...recoveryLoad.diagnostics, ...modelPlansLoad.diagnostics];
			return refuse(`Run start configuration is invalid; no changes were made. ${diagnostics.map((item) => item.message).join(" ")}`);
		}
		const draftInput: RunDraftInput = {
			recovery: cloneRecoveryDefaults(recoveryLoad.value),
			modelPlans: modelPlansLoad.value ? cloneModelPlans(modelPlansLoad.value) : undefined,
			modelChoices: model.listModelChoices(),
			activeJournalPath: initialActive.paths.activePath,
			activityLogDirectory: initialActive.paths.activityRoot,
		};
		let draftResult: RunDraftResult;
		try {
			draftResult = await ui.draftRun(draftInput);
		} catch (error: unknown) {
			return refuse(`Run draft could not be collected; no changes were made. ${error instanceof Error ? error.message : "Interactive draft failed."}`);
		}
		if (draftResult.kind === "cancelled") return presentStart({ kind: "cancelled", message: "Cancelled; no Run was started." });
		const draftValidation = validateRunDraft(draftResult.draft, recoveryLoad.value);
		if (!draftValidation.value || draftValidation.diagnostics.length > 0) return refuse(`The Run draft is invalid; no Run was started. ${draftValidation.diagnostics.map((item) => item.message).join(" ")}`);
		const draft = draftValidation.value;
		const identity = createRunIdentity(clock.now(), clock.randomUUID());
		const effectiveSettings = cloneRecoveryDefaults(draft.effectiveSettings ?? recoveryLoad.value);
		const settingsValidation = validateRecoveryDefaults(effectiveSettings, "run.effectiveSettings");
		if (!settingsValidation.value || settingsValidation.diagnostics.length > 0) return refuse("Effective settings are invalid; no Run was started.");

		let modelDiagnostics: ConfigDiagnostic[];
		try {
			modelDiagnostics = await model.validateModelPlans(draft.modelPlan);
		} catch (error: unknown) {
			return refuse(`Required Model Plans could not be validated; no Run was started. ${error instanceof Error ? error.message : "Model validation failed."}`);
		}
		if (modelDiagnostics.length > 0) return refuse(`Required Model Plans are unavailable; no substitution was made. ${modelDiagnostics.map((item) => `${item.code}${item.role ? ` ${item.role}[${item.index ?? 0}]` : ""} ${item.reference ?? ""}: ${item.message}`).join(" ")}`);

		let integrationBase: IntegrationBase = { kind: "none" };
		if (isCodeChanging(draft.tasks)) {
			let inspection: IntegrationBaseInspection;
			try {
				inspection = await git.inspectIntegrationBase(repositoryRoot);
			} catch (error: unknown) {
				return refuse(`Git integration base is unavailable; no Run was started. ${error instanceof Error ? error.message : "Git inspection failed."}`);
			}
			if (inspection.kind !== "ready") return refuse(`Git integration base is unavailable; no Run was started. ${inspection.message}`);
			integrationBase = { kind: "git", branch: inspection.branch, revision: inspection.revision };
		}
		let journal: RunJournal;
		try {
			journal = buildInitialRunJournal({ identity, controllerSessionId, draft, modelPlan: draft.modelPlan, effectiveSettings: settingsValidation.value, integrationBase });
		} catch (error: unknown) {
			return refuse(`Run draft is invalid; no Run was started. ${error instanceof Error ? error.message : "Run validation failed."}`);
		}
		const summary = buildRunConfirmationSummary({ journal, activeJournalPath: initialActive.paths.activePath, activityLogPath: `${initialActive.paths.activityRoot}/${journal.run.id}/activity.log` });
		let confirmed: boolean;
		try {
			confirmed = await ui.confirmRun(summary);
		} catch (error: unknown) {
			return refuse(`Run confirmation failed; no Run was started. ${error instanceof Error ? error.message : "Interactive confirmation failed."}`);
		}
		if (!confirmed) return presentStart({ kind: "cancelled", message: "Cancelled; no Run was started." });

		let confirmedActive: ActiveRunLoadResult;
		try {
			confirmedActive = await runJournal.loadActive(repositoryRoot);
		} catch (error: unknown) {
			return refuse(`The active Run state could not be rechecked after confirmation; start again. ${error instanceof Error ? error.message : "Read-only inspection failed."}`);
		}
		if (confirmedActive.kind !== "missing") return refuse("The active Run state changed during confirmation; start again without changing the confirmed draft.");
		let confirmedHerdr: HerdrAvailability;
		try {
			confirmedHerdr = await herdr.checkAvailability(repositoryRoot);
		} catch (error: unknown) {
			return refuse(`Herdr changed during confirmation; start again. ${error instanceof Error ? error.message : "Availability recheck failed."}`);
		}
		if (confirmedHerdr.kind !== "available") return refuse(`Herdr changed during confirmation; start again. ${confirmedHerdr.message}`);
		let confirmedModelDiagnostics: ConfigDiagnostic[];
		try {
			confirmedModelDiagnostics = await model.validateModelPlans(journal.run.modelPlan);
		} catch (error: unknown) {
			return refuse(`Required Model Plans changed during confirmation; start again. ${error instanceof Error ? error.message : "Model validation failed."}`);
		}
		if (confirmedModelDiagnostics.length > 0) return refuse(`Required Model Plans changed during confirmation; start again. ${confirmedModelDiagnostics.map((item) => item.message).join(" ")}`);
		if (journal.run.integrationBase.kind === "git") {
			let confirmedGit: IntegrationBaseInspection;
			try {
				confirmedGit = await git.inspectIntegrationBase(repositoryRoot);
			} catch (error: unknown) {
				return refuse(`Git branch, revision, or clean-base state changed during confirmation; start again. ${error instanceof Error ? error.message : "Git recheck failed."}`);
			}
			if (confirmedGit.kind !== "ready" || confirmedGit.branch !== journal.run.integrationBase.branch || confirmedGit.revision !== journal.run.integrationBase.revision) return refuse("Git branch, revision, or clean-base state changed during confirmation; start again.");
		}
		const validated = validateRunJournal(journal, initialActive.paths.activePath);
		if (!validated.value || validated.diagnostics.length > 0) return refuse("The confirmed Run Journal failed strict validation; no Run was started.");
		let created: CreateActiveResult;
		try {
			created = await runJournal.createActive(repositoryRoot, validated.value);
		} catch (error: unknown) {
			return presentStart({ kind: "storage-error", message: `Run Journal could not be created; no Run was started. ${error instanceof Error ? error.message : "Storage failed."}` });
		}
		if (created.kind === "active-exists") return refuse("Another active Run won the start race; no Run was overwritten.");
		if (created.kind !== "created") return presentStart({ kind: "storage-error", message: `Run Journal could not be created at ${created.paths.activePath}; no Run was started. ${created.diagnostics.map((item) => item.message).join(" ")}` });
		let activity: ActivityAppendResult;
		try {
			activity = await runJournal.appendActivity(repositoryRoot, { timestamp: validated.value.run.createdAt, runId: validated.value.run.id, event: "run-started", message: "Run Journal created; all Tasks are pending." });
		} catch (error: unknown) {
			return presentStart({ kind: "started-with-warning", journal: validated.value, message: `Run started as ${validated.value.run.id}; non-authoritative activity logging is degraded. The active-run.json Journal remains authoritative. ${error instanceof Error ? error.message : "Activity append failed."}` });
		}
		if (activity.kind !== "appended") return presentStart({ kind: "started-with-warning", journal: validated.value, message: `Run started as ${validated.value.run.id}; non-authoritative activity logging is degraded at ${activity.path}. The active-run.json Journal remains authoritative.` });
		return presentStart({ kind: "started", journal: validated.value, message: `Run ${validated.value.run.id} started. Journal: ${created.paths.activePath}. Activity log is non-authoritative; active-run.json is the Run Journal.` });
	}

	return { status, configure, start };
}
