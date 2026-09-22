import type { ConfigDiagnostic, ModelChoice, ModelRole, ProjectModelPlans } from "./config.ts";
import type { ActiveRunLoadResult } from "./run-journal-store.ts";

export type ModelProbeStatus =
	| "healthy"
	| "rate-limited"
	| "quota-exhausted"
	| "auth-failed"
	| "temporarily-unavailable"
	| "incompatible-request"
	| "unknown-error";

export interface ModelProbeResult {
	status: ModelProbeStatus;
	httpStatus?: number;
	retryAfter?: string;
	diagnostic?: string;
}

function boundedDiagnostic(value: string | undefined): string | undefined {
	if (!value) return undefined;
	return value
		.replace(/(["']?(?:authorization|api[-_ ]?key|token|secret)["']?\s*[:=]\s*)["']?[^"',;\s}]+["']?/gi, "$1[redacted]")
		.replace(/bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
		.replace(/[\u0000\r\n]+/g, " ")
		.trim()
		.slice(0, 500) || undefined;
}

/** Normalize provider-specific HTTP and message failures into Steward's stable health categories. */
export function classifyModelProbe(input: {
	httpStatus?: number;
	retryAfter?: string;
	stopReason?: string;
	errorMessage?: string;
	thrownMessage?: string;
}): ModelProbeResult {
	const diagnostic = boundedDiagnostic(input.errorMessage ?? input.thrownMessage);
	const text = (diagnostic ?? "").toLowerCase();
	const retryAfter = input.retryAfter?.replace(/[\u0000\r\n]+/g, " ").trim().slice(0, 100) || undefined;
	const common = {
		...(input.httpStatus ? { httpStatus: input.httpStatus } : {}),
		...(retryAfter ? { retryAfter } : {}),
		...(diagnostic ? { diagnostic } : {}),
	};
	if (/insufficient[_ -]?quota|quota (?:exceeded|exhausted)|billing|credit(?:s)? exhausted|hard limit|\b402\b/.test(text) || input.httpStatus === 402) return { status: "quota-exhausted", ...common };
	if (input.httpStatus === 429 || /rate[_ -]?limit|too many requests|\b429\b/.test(text)) return { status: "rate-limited", ...common };
	if (input.httpStatus === 401 || input.httpStatus === 403 || /unauth|forbidden|invalid api key|authentication|\b(?:401|403)\b/.test(text)) return { status: "auth-failed", ...common };
	if (input.httpStatus !== undefined && input.httpStatus >= 500 || /timeout|timed out|temporar(?:y|ily)|overloaded|unavailable|\b5\d\d\b/.test(text)) return { status: "temporarily-unavailable", ...common };
	if (input.httpStatus === 400 || input.httpStatus === 404 || input.httpStatus === 405 || input.httpStatus === 422 || /unsupported|incompatible|invalid request|not found|\b(?:400|404|405|422)\b/.test(text)) return { status: "incompatible-request", ...common };
	if (input.stopReason === "error" || input.thrownMessage || input.httpStatus !== undefined && input.httpStatus >= 400) return { status: "unknown-error", ...common };
	return { status: "healthy", ...common };
}

export interface DoctorModelUse {
	role: ModelRole;
	index: number;
	position: "primary" | "fallback";
}

export interface DoctorModelResult {
	reference: string;
	thinkingLevel: ModelChoice["thinkingLevel"];
	uses: DoctorModelUse[];
	staticStatus: "healthy" | "invalid";
	diagnostics: ConfigDiagnostic[];
	probe?: ModelProbeResult;
}

export interface DoctorCheck {
	name: "configuration" | "journal" | "herdr";
	status: "healthy" | "warning" | "error";
	message: string;
}

export interface DoctorReport {
	checkedAt: string;
	probeRequested: boolean;
	checks: DoctorCheck[];
	models: DoctorModelResult[];
	summary: "healthy" | "issues-found";
}

export interface DoctorRunJournalAdapter {
	loadRecoveryDefaults(): Promise<{ value?: unknown; diagnostics: ConfigDiagnostic[]; path: string }>;
	loadModelPlans(repositoryRoot: string): Promise<{ value?: ProjectModelPlans; diagnostics: ConfigDiagnostic[]; path: string }>;
	loadActive(repositoryRoot: string): Promise<ActiveRunLoadResult>;
}

export interface DoctorModelAdapter {
	inspectModelChoice?(choice: ModelChoice, role: ModelRole, index: number): Promise<{ available: boolean; diagnostics: ConfigDiagnostic[] }>;
	probeModelChoice?(choice: ModelChoice): Promise<ModelProbeResult>;
}

export interface DoctorHerdrAdapter {
	checkAvailability(repositoryRoot: string): Promise<{ kind: "available"; status: string } | { kind: "unavailable"; message: string }>;
}

function selectedModels(plans: ProjectModelPlans): Array<{ choice: ModelChoice; use: DoctorModelUse }> {
	const selected: Array<{ choice: ModelChoice; use: DoctorModelUse }> = [];
	for (const role of ["builder", "reviewer"] as const) {
		selected.push({ choice: plans[role].primary, use: { role, index: 0, position: "primary" } });
		plans[role].fallbacks.forEach((choice, index) => selected.push({ choice, use: { role, index: index + 1, position: "fallback" } }));
	}
	return selected;
}

function journalCheck(load: ActiveRunLoadResult): DoctorCheck {
	if (load.kind === "missing") return { name: "journal", status: "healthy", message: "No active Run Journal exists." };
	if (load.kind === "loaded") return { name: "journal", status: "healthy", message: `Active Run ${load.journal.run.id} loaded at Journal revision ${load.journal.journalRevision}.` };
	if (load.kind === "migration-ready") return { name: "journal", status: "warning", message: "The active Run Journal requires an explicit schema migration before workflow continuation." };
	if (load.kind === "recovered") return { name: "journal", status: "warning", message: "The active Run Journal was recovered and remains read-only pending repair." };
	return { name: "journal", status: "error", message: "The active Run Journal is invalid and remains read-only." };
}

/** Run non-mutating Steward diagnostics; live model calls happen only when probe is explicitly true. */
export async function runStewardDoctor(input: {
	repositoryRoot: string;
	probe: boolean;
	runJournal: DoctorRunJournalAdapter;
	model: DoctorModelAdapter;
	herdr: DoctorHerdrAdapter;
	now: () => Date;
}): Promise<DoctorReport> {
	const checks: DoctorCheck[] = [];
	const models: DoctorModelResult[] = [];
	const [recovery, plansLoad, active, herdr] = await Promise.all([
		input.runJournal.loadRecoveryDefaults().catch((error: unknown) => ({ value: undefined, diagnostics: [{ code: "load-error", message: error instanceof Error ? error.message : "Recovery configuration could not be loaded." } as ConfigDiagnostic], path: "recovery defaults" })),
		input.runJournal.loadModelPlans(input.repositoryRoot).catch((error: unknown) => ({ value: undefined, diagnostics: [{ code: "load-error", message: error instanceof Error ? error.message : "Model Plans could not be loaded." } as ConfigDiagnostic], path: "project Model Plans" })),
		input.runJournal.loadActive(input.repositoryRoot).catch(() => undefined),
		input.herdr.checkAvailability(input.repositoryRoot).catch((error: unknown) => ({ kind: "unavailable" as const, message: error instanceof Error ? error.message : "Herdr availability check failed." })),
	]);

	const configurationDiagnostics = [...recovery.diagnostics, ...plansLoad.diagnostics];
	if (!recovery.value) configurationDiagnostics.push({ code: "load-error", message: `Recovery defaults are unavailable at ${recovery.path}.`, path: recovery.path });
	if (!plansLoad.value) configurationDiagnostics.push({ code: "load-error", message: `Project Model Plans are unavailable at ${plansLoad.path}.`, path: plansLoad.path });
	checks.push({
		name: "configuration",
		status: configurationDiagnostics.length === 0 ? "healthy" : "error",
		message: configurationDiagnostics.length === 0 ? "Recovery defaults and project Model Plans loaded successfully." : configurationDiagnostics.map((item) => `${item.code}: ${item.message}`).join(" "),
	});

	checks.push(active ? journalCheck(active) : { name: "journal", status: "error", message: "The active Run Journal could not be inspected." });
	checks.push(herdr.kind === "available"
		? { name: "herdr", status: "healthy", message: `Herdr is available (${herdr.status}).` }
		: { name: "herdr", status: "error", message: herdr.message });

	if (plansLoad.value) {
		const grouped = new Map<string, { choice: ModelChoice; uses: DoctorModelUse[] }>();
		const probes = new Map<string, Promise<ModelProbeResult>>();
		for (const item of selectedModels(plansLoad.value)) {
			const key = `${item.choice.model}\u0000${item.choice.thinkingLevel}`;
			const current = grouped.get(key);
			if (current) current.uses.push(item.use);
			else grouped.set(key, { choice: item.choice, uses: [item.use] });
		}
		for (const { choice, uses } of grouped.values()) {
			const diagnostics: ConfigDiagnostic[] = [];
			if (!input.model.inspectModelChoice) {
				diagnostics.push({ code: "unavailable-model", message: "Model inspection is unavailable.", reference: choice.model });
			} else {
				for (const use of uses) {
					const inspection = await input.model.inspectModelChoice(choice, use.role, use.index);
					diagnostics.push(...inspection.diagnostics);
					if (!inspection.available && inspection.diagnostics.length === 0) {
						diagnostics.push({ code: "unavailable-model", message: "Model inspection reported the exact model as unavailable.", role: use.role, index: use.index, reference: choice.model });
					}
				}
			}
			const result: DoctorModelResult = {
				reference: choice.model,
				thinkingLevel: choice.thinkingLevel,
				uses,
				staticStatus: diagnostics.length === 0 ? "healthy" : "invalid",
				diagnostics,
			};
			if (input.probe && diagnostics.length === 0) {
				if (!probes.has(choice.model)) {
					probes.set(choice.model, input.model.probeModelChoice
						? input.model.probeModelChoice(choice)
						: Promise.resolve({ status: "unknown-error", diagnostic: "Live model probing is unavailable." }));
				}
				const probe = probes.get(choice.model);
				if (probe) result.probe = await probe;
			}
			models.push(result);
		}
	}

	const issues = checks.some((check) => check.status !== "healthy")
		|| models.some((model) => model.staticStatus !== "healthy" || model.probe?.status !== undefined && model.probe.status !== "healthy");
	return { checkedAt: input.now().toISOString(), probeRequested: input.probe, checks, models, summary: issues ? "issues-found" : "healthy" };
}

export function formatDoctorReport(report: DoctorReport): string {
	const lines = [
		`Steward doctor: ${report.summary === "healthy" ? "healthy" : "issues found"}`,
		`Checked: ${report.checkedAt}`,
		`Live provider probes: ${report.probeRequested ? "enabled" : "disabled (use /steward doctor --probe)"}`,
	];
	for (const check of report.checks) lines.push(`${check.status === "healthy" ? "✓" : check.status === "warning" ? "!" : "✗"} ${check.name}: ${check.message}`);
	for (const model of report.models) {
		const uses = model.uses.map((use) => `${use.role} ${use.position}${use.position === "fallback" ? ` ${use.index}` : ""}`).join(", ");
		const staticText = model.staticStatus === "healthy" ? "static healthy" : model.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; ");
		const probeText = model.probe ? `; probe ${model.probe.status}${model.probe.httpStatus ? ` HTTP ${model.probe.httpStatus}` : ""}${model.probe.retryAfter ? ` retry-after=${model.probe.retryAfter}` : ""}${model.probe.diagnostic ? ` — ${model.probe.diagnostic}` : ""}` : "";
		lines.push(`${model.staticStatus === "healthy" && (!model.probe || model.probe.status === "healthy") ? "✓" : "✗"} ${model.reference} [thinking=${model.thinkingLevel}; ${uses}]: ${staticText}${probeText}`);
	}
	lines.push("Probe results are point-in-time reachability checks, not a guarantee of future quota or capacity.");
	return lines.join("\n");
}
