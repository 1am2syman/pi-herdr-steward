export const CONFIG_SCHEMA_VERSION = 1 as const;

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface RecoveryDefaults {
	passiveInspectionIntervalSeconds: number;
	secondInspectionAndNudgeIntervalSeconds: number;
	nudgeGracePeriodSeconds: number;
	externalCommandWarningThresholdSeconds: number;
	maximumActiveTasks: number;
	transientRetryLimit: number;
	reworkCycleLimit: number;
}

export interface RecoveryDefaultsDocument {
	schemaVersion: typeof CONFIG_SCHEMA_VERSION;
	recovery: RecoveryDefaults;
}

export interface ModelChoice {
	model: string;
	thinkingLevel: ThinkingLevel;
}

export interface ModelPlan {
	primary: ModelChoice;
	fallbacks: ModelChoice[];
}

export interface ProjectModelPlans {
	builder: ModelPlan;
	reviewer: ModelPlan;
}

export interface ProjectModelPlansDocument {
	schemaVersion: typeof CONFIG_SCHEMA_VERSION;
	modelPlans: ProjectModelPlans;
}

export type ConfigurationScope = "recovery" | "model-plans";
export type ModelRole = "builder" | "reviewer";

export type ConfigDiagnosticCode =
	| "invalid-config"
	| "invalid-recovery"
	| "invalid-model"
	| "duplicate-model"
	| "invalid-thinking-level"
	| "unauthenticated-model"
	| "unavailable-model"
	| "unsupported-thinking-level"
	| "load-error"
	| "save-error";

export interface ConfigDiagnostic {
	code: ConfigDiagnosticCode;
	message: string;
	path?: string;
	role?: ModelRole;
	index?: number;
	reference?: string;
}

export interface ModelReference {
	provider: string;
	modelId: string;
}

export interface ModelChoiceOption {
	reference: string;
	name: string;
}

export const BUILTIN_RECOVERY_DEFAULTS: Readonly<RecoveryDefaults> = Object.freeze({
	passiveInspectionIntervalSeconds: 300,
	secondInspectionAndNudgeIntervalSeconds: 300,
	nudgeGracePeriodSeconds: 120,
	externalCommandWarningThresholdSeconds: 1800,
	maximumActiveTasks: 1,
	transientRetryLimit: 2,
	reworkCycleLimit: 5,
});

const RECOVERY_KEYS = [
	"passiveInspectionIntervalSeconds",
	"secondInspectionAndNudgeIntervalSeconds",
	"nudgeGracePeriodSeconds",
	"externalCommandWarningThresholdSeconds",
	"maximumActiveTasks",
	"transientRetryLimit",
	"reworkCycleLimit",
] as const;

const MODEL_PLAN_KEYS = ["primary", "fallbacks"] as const;
const MODEL_CHOICE_KEYS = ["model", "thinkingLevel"] as const;
const PROJECT_PLAN_KEYS = ["builder", "reviewer"] as const;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: RecordValue, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function diagnostic(
	code: ConfigDiagnosticCode,
	message: string,
	path: string | undefined,
	additional: Pick<ConfigDiagnostic, "role" | "index" | "reference"> = {},
): ConfigDiagnostic {
	return { code, message, ...(path ? { path } : {}), ...additional };
}

function cloneRecovery(recovery: RecoveryDefaults): RecoveryDefaults {
	return {
		passiveInspectionIntervalSeconds: recovery.passiveInspectionIntervalSeconds,
		secondInspectionAndNudgeIntervalSeconds: recovery.secondInspectionAndNudgeIntervalSeconds,
		nudgeGracePeriodSeconds: recovery.nudgeGracePeriodSeconds,
		externalCommandWarningThresholdSeconds: recovery.externalCommandWarningThresholdSeconds,
		maximumActiveTasks: recovery.maximumActiveTasks,
		transientRetryLimit: recovery.transientRetryLimit,
		reworkCycleLimit: recovery.reworkCycleLimit,
	};
}

export function cloneRecoveryDefaults(recovery: RecoveryDefaults): RecoveryDefaults {
	return cloneRecovery(recovery);
}

export function cloneModelChoice(choice: ModelChoice): ModelChoice {
	return { ...choice };
}

export function cloneModelPlans(modelPlans: ProjectModelPlans): ProjectModelPlans {
	return {
		builder: {
			primary: cloneModelChoice(modelPlans.builder.primary),
			fallbacks: modelPlans.builder.fallbacks.map(cloneModelChoice),
		},
		reviewer: {
			primary: cloneModelChoice(modelPlans.reviewer.primary),
			fallbacks: modelPlans.reviewer.fallbacks.map(cloneModelChoice),
		},
	};
}

export function createBuiltinRecoveryDocument(): RecoveryDefaultsDocument {
	return { schemaVersion: CONFIG_SCHEMA_VERSION, recovery: cloneRecovery(BUILTIN_RECOVERY_DEFAULTS) };
}

export function parseCanonicalModelReference(reference: string): ModelReference | undefined {
	if (
		reference.length === 0 ||
		reference !== reference.trim() ||
		/\s/.test(reference) ||
		/[*!?\[\]{}()|+\\]/.test(reference)
	) {
		return undefined;
	}

	const separator = reference.indexOf("/");
	if (separator <= 0 || separator === reference.length - 1) return undefined;

	const provider = reference.slice(0, separator);
	const modelId = reference.slice(separator + 1);
	if (provider.length === 0 || modelId.length === 0) return undefined;
	return { provider, modelId };
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function validateRecoveryValueShape(value: unknown, path: string | undefined, code: ConfigDiagnosticCode): {
	value: RecoveryDefaults | undefined;
	diagnostics: ConfigDiagnostic[];
} {
	if (!isRecord(value) || !hasExactKeys(value, RECOVERY_KEYS)) {
		return {
			value: undefined,
			diagnostics: [diagnostic(code, "Recovery defaults must contain exactly the documented seven fields.", path)],
		};
	}

	const diagnostics: ConfigDiagnostic[] = [];
	for (const key of RECOVERY_KEYS) {
		const field = value[key];
		const isInteger = typeof field === "number" && Number.isSafeInteger(field);
		const minimum = key === "transientRetryLimit" || key === "reworkCycleLimit" ? 0 : 1;
		const maximum = key === "transientRetryLimit" ? 2 : key === "reworkCycleLimit" ? 5 : Number.MAX_SAFE_INTEGER;
		if (!isInteger || (field as number) < minimum || (field as number) > maximum) {
			diagnostics.push(
				diagnostic(
					code,
					`${key} must be a safe integer from ${minimum} through ${maximum === Number.MAX_SAFE_INTEGER ? "Number.MAX_SAFE_INTEGER" : maximum}.`,
					path,
				),
			);
		}
	}

	if (diagnostics.length > 0) return { value: undefined, diagnostics };
	return { value: cloneRecovery(value as unknown as RecoveryDefaults), diagnostics: [] };
}

export function validateRecoveryDefaults(value: unknown, path?: string): {
	value: RecoveryDefaults | undefined;
	diagnostics: ConfigDiagnostic[];
} {
	return validateRecoveryValueShape(value, path, "invalid-recovery");
}

export function decodeRecoveryDocument(value: unknown, path: string): {
	value: RecoveryDefaultsDocument | undefined;
	diagnostics: ConfigDiagnostic[];
} {
	if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "recovery"])) {
		return {
			value: undefined,
			diagnostics: [diagnostic("invalid-config", "Recovery defaults must contain exactly schemaVersion and recovery.", path)],
		};
	}
	if (value.schemaVersion !== CONFIG_SCHEMA_VERSION) {
		return {
			value: undefined,
			diagnostics: [diagnostic("invalid-config", `Unsupported recovery schemaVersion at ${path}; expected 1.`, path)],
		};
	}

	const result = validateRecoveryValueShape(value.recovery, path, "invalid-config");
	return result.value
		? { value: { schemaVersion: CONFIG_SCHEMA_VERSION, recovery: result.value }, diagnostics: [] }
		: { value: undefined, diagnostics: result.diagnostics };
}

function validateModelChoiceShape(
	value: unknown,
	path: string | undefined,
	role: ModelRole,
	index: number,
	code: ConfigDiagnosticCode,
): { value: ModelChoice | undefined; diagnostics: ConfigDiagnostic[] } {
	if (!isRecord(value) || !hasExactKeys(value, MODEL_CHOICE_KEYS)) {
		return {
			value: undefined,
			diagnostics: [diagnostic(code, "A model choice must contain exactly model and thinkingLevel.", path, { role, index })],
		};
	}

	const diagnostics: ConfigDiagnostic[] = [];
	const reference = typeof value.model === "string" ? value.model : undefined;
	if (reference === undefined || parseCanonicalModelReference(reference) === undefined) {
		diagnostics.push(
			diagnostic(code === "invalid-config" ? "invalid-config" : "invalid-model", "Model choices require an exact provider/model-id reference.", path, {
			role,
			index,
			...(reference !== undefined ? { reference } : {}),
		}),
		);
	}
	if (!isThinkingLevel(value.thinkingLevel)) {
		diagnostics.push(
			diagnostic(code === "invalid-config" ? "invalid-config" : "invalid-thinking-level", "Model choices require an explicit supported thinking level.", path, {
			role,
			index,
			...(reference !== undefined ? { reference } : {}),
		}),
		);
	}
	if (diagnostics.length > 0) return { value: undefined, diagnostics };
	return {
		value: { model: reference as string, thinkingLevel: value.thinkingLevel as ThinkingLevel },
		diagnostics: [],
	};
}

function validateModelPlansShape(
	value: unknown,
	path: string | undefined,
	code: ConfigDiagnosticCode,
): { value: ProjectModelPlans | undefined; diagnostics: ConfigDiagnostic[] } {
	if (!isRecord(value) || !hasExactKeys(value, PROJECT_PLAN_KEYS)) {
		return {
			value: undefined,
			diagnostics: [diagnostic(code, "Model plans must contain exactly builder and reviewer.", path)],
		};
	}

	const diagnostics: ConfigDiagnostic[] = [];
	const plans: Partial<Record<ModelRole, ModelPlan>> = {};
	for (const role of PROJECT_PLAN_KEYS) {
		const plan = value[role];
		if (!isRecord(plan) || !hasExactKeys(plan, MODEL_PLAN_KEYS) || !Array.isArray(plan.fallbacks)) {
			diagnostics.push(diagnostic(code, `${role} must contain exactly primary and fallbacks.`, path, { role, index: 0 }));
			continue;
		}

		const primaryResult = validateModelChoiceShape(plan.primary, path, role, 0, code);
		const fallbackValues: ModelChoice[] = [];
		const choiceDiagnostics = [...primaryResult.diagnostics];
		for (let index = 0; index < plan.fallbacks.length; index += 1) {
			const result = validateModelChoiceShape(plan.fallbacks[index], path, role, index + 1, code);
			choiceDiagnostics.push(...result.diagnostics);
			if (result.value) fallbackValues.push(result.value);
		}

		const choices = primaryResult.value ? [primaryResult.value, ...fallbackValues] : fallbackValues;
		const seen = new Set<string>();
		for (let index = 0; index < choices.length; index += 1) {
			const choice = choices[index];
			if (seen.has(choice.model)) {
				choiceDiagnostics.push(
					diagnostic(code === "invalid-config" ? "invalid-config" : "duplicate-model", "A role cannot repeat a model reference in its primary and fallback order.", path, {
						role,
						index,
						reference: choice.model,
					}),
				);
			} else {
				seen.add(choice.model);
			}
		}
		diagnostics.push(...choiceDiagnostics);
		if (primaryResult.value && choiceDiagnostics.length === 0) {
			plans[role] = { primary: primaryResult.value, fallbacks: fallbackValues };
		}
	}

	if (diagnostics.length > 0 || !plans.builder || !plans.reviewer) {
		return { value: undefined, diagnostics };
	}
	return { value: plans as ProjectModelPlans, diagnostics: [] };
}

export function validateProjectModelPlans(value: unknown, path?: string): {
	value: ProjectModelPlans | undefined;
	diagnostics: ConfigDiagnostic[];
} {
	return validateModelPlansShape(value, path, "invalid-model");
}

export function decodeProjectModelPlansDocument(value: unknown, path: string): {
	value: ProjectModelPlansDocument | undefined;
	diagnostics: ConfigDiagnostic[];
} {
	if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "modelPlans"])) {
		return {
			value: undefined,
			diagnostics: [diagnostic("invalid-config", "Model defaults must contain exactly schemaVersion and modelPlans.", path)],
		};
	}
	if (value.schemaVersion !== CONFIG_SCHEMA_VERSION) {
		return {
			value: undefined,
			diagnostics: [diagnostic("invalid-config", `Unsupported model-plan schemaVersion at ${path}; expected 1.`, path)],
		};
	}

	const result = validateModelPlansShape(value.modelPlans, path, "invalid-config");
	return result.value
		? { value: { schemaVersion: CONFIG_SCHEMA_VERSION, modelPlans: result.value }, diagnostics: [] }
		: { value: undefined, diagnostics: result.diagnostics };
}

export function serializeRecoveryDefaults(recovery: RecoveryDefaults): string {
	return `${JSON.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, recovery: cloneRecovery(recovery) }, null, 2)}\n`;
}

export function serializeModelPlans(modelPlans: ProjectModelPlans): string {
	return `${JSON.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, modelPlans: cloneModelPlans(modelPlans) }, null, 2)}\n`;
}

export function formatRecoveryDefaults(recovery: RecoveryDefaults): string {
	return [
		`passiveInspectionIntervalSeconds=${recovery.passiveInspectionIntervalSeconds}s`,
		`secondInspectionAndNudgeIntervalSeconds=${recovery.secondInspectionAndNudgeIntervalSeconds}s`,
		`nudgeGracePeriodSeconds=${recovery.nudgeGracePeriodSeconds}s`,
		`externalCommandWarningThresholdSeconds=${recovery.externalCommandWarningThresholdSeconds}s`,
		`maximumActiveTasks=${recovery.maximumActiveTasks}`,
		`transientRetryLimit=${recovery.transientRetryLimit}`,
		`reworkCycleLimit=${recovery.reworkCycleLimit}`,
	].join(", ");
}

export function formatModelChoice(choice: ModelChoice): string {
	return `${choice.model} [thinking=${choice.thinkingLevel}]`;
}

export function formatModelPlans(modelPlans: ProjectModelPlans | undefined): string {
	if (!modelPlans) return "not configured";
	const formatRole = (role: ModelRole): string => {
		const plan = modelPlans[role];
		const ordered = [plan.primary, ...plan.fallbacks].map(formatModelChoice);
		return `${role}: ${ordered.map((choice, index) => `${index + 1}. ${choice}`).join("; ")}`;
	};
	return `${formatRole("builder")} | ${formatRole("reviewer")}`;
}
