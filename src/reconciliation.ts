import { createHash } from "node:crypto";
import { parseCanonicalModelReference, type ModelChoice, type ModelPlan } from "./config.ts";

export const TASK_FACT_REQUEST_PREFIX = "STEWARD_TASK_FACT_REQUEST" as const;
export const TASK_FACT_ANSWER_PREFIX = "STEWARD_TASK_FACT_ANSWER" as const;
export const TASK_FACT_SCHEMA_VERSION = 1 as const;

export const TASK_FACT_KEYS = [
	"requiredOutcome",
	"allowedScope",
	"expectedArtifacts",
	"verification",
	"reportPath",
	"evidenceDirectory",
	"reviewSubject",
] as const;

export type TaskFactKey = (typeof TASK_FACT_KEYS)[number];
export type TaskFactRole = "builder" | "reviewer";

export type ReconciliationLiveKind = "working" | "blocked" | "settled" | "unclear" | "missing";

export interface ReconciliationLiveFact {
	kind: ReconciliationLiveKind;
	lifecycle?: "working" | "blocked" | "idle" | "done" | "unknown";
}

export interface ReconciliationFacts {
	report: "valid" | "invalid" | "missing" | "unclear";
	live?: ReconciliationLiveFact;
}

export type ReconciliationDecision =
	| { kind: "report" }
	| { kind: "working-or-blocked"; lifecycle: "working" | "blocked" }
	| { kind: "settled"; lifecycle: "idle" | "done" }
	| { kind: "unclear" }
	| { kind: "missing" }
	| { kind: "none" };

/**
 * The ticket-10 precedence ladder. The controller supplies already-normalized
 * facts; this function deliberately has no authority to inspect or mutate
 * anything.
 */
export function decideReconciliation(facts: ReconciliationFacts): ReconciliationDecision {
	if (facts.report === "valid") return { kind: "report" };
	if ((facts.live?.kind === "working" && facts.live.lifecycle === "working") || (facts.live?.kind === "blocked" && facts.live.lifecycle === "blocked")) {
		return { kind: "working-or-blocked", lifecycle: facts.live.lifecycle };
	}
	if (facts.live?.kind === "settled" && (facts.live.lifecycle === "idle" || facts.live.lifecycle === "done")) {
		return { kind: "settled", lifecycle: facts.live.lifecycle };
	}
	if (facts.live?.kind === "unclear") return { kind: "unclear" };
	if (facts.live?.kind === "missing") return { kind: "missing" };
	return { kind: "none" };
}

export const TRANSIENT_INFRASTRUCTURE_KINDS = [
	"provider-network-interruption",
	"agent-startup-failure",
	"herdr-command-failure",
	"unexpected-process-exit",
] as const;

export type TransientInfrastructureKind = (typeof TRANSIENT_INFRASTRUCTURE_KINDS)[number];
export type TransientInfrastructureStage = "worktree-create" | "pane-split" | "agent-start" | "agent-prompt" | "agent-runtime";

export interface TypedInfrastructureFact {
	stage: TransientInfrastructureStage;
	code: string;
	diagnostic: string;
	source?: "typed-herdr-result" | "exact-agent-missing";
}

export interface ClassifiedInfrastructureFact extends TypedInfrastructureFact {
	kind: TransientInfrastructureKind;
}

const providerNetworkCodes = new Set([
	"provider-network-interruption",
	"provider_network_interruption",
	"provider-network",
	"provider_network",
	"provider-network-error",
	"provider_network_error",
	"network-interruption",
	"network_interruption",
	"network-error",
	"network_error",
	"network-timeout",
	"network_timeout",
	"econnreset",
	"econnrefused",
	"etimedout",
]);
const startupCodes = new Set(["agent-startup-failure", "agent_startup_failure", "agent-start-failed", "agent_start_failed", "agent-startup-error", "agent_startup_error", "startup-failure", "startup_failure", "startup-failed", "startup_failed"]);
const herdrCommandCodes = new Set(["herdr-command-failure", "herdr_command_failure", "herdr-command-failed", "herdr_command_failed", "command-failure", "command_failure", "command-failed", "command_failed", "dispatch-failure", "dispatch_failure"]);

/**
 * Normalize only structured adapter facts. Terminal prose and generic
 * malformed/killed results intentionally do not enter this classifier.
 */
export function classifyInfrastructureFact(fact: TypedInfrastructureFact): ClassifiedInfrastructureFact | undefined {
	if (typeof fact.code !== "string" || fact.code.length === 0 || typeof fact.diagnostic !== "string") return undefined;
	if (fact.source === "exact-agent-missing" && fact.code === "agent_not_found") return { ...fact, kind: "unexpected-process-exit" };
	if ((fact.stage === "agent-start" || fact.stage === "agent-prompt") && providerNetworkCodes.has(fact.code)) return { ...fact, kind: "provider-network-interruption" };
	if (fact.stage === "agent-start" && startupCodes.has(fact.code)) return { ...fact, kind: "agent-startup-failure" };
	if (herdrCommandCodes.has(fact.code)) return { ...fact, kind: "herdr-command-failure" };
	return undefined;
}

export type RetryLinkFact = {
	kind: "silent-agent-recovery" | "transient-recovery";
	retryOrdinal: 1 | 2;
	replacesAttemptId: string;
	actualModel?: ModelChoice;
};

export function replacementRetryOrdinal(links: readonly RetryLinkFact[], retryLimit: number): 1 | 2 | undefined {
	const used = links.length;
	if (!Number.isSafeInteger(retryLimit) || retryLimit <= used || used >= 2) return undefined;
	return (used + 1) as 1 | 2;
}

export function replacementRetryCount(links: readonly RetryLinkFact[]): 0 | 1 | 2 {
	return Math.min(2, links.length) as 0 | 1 | 2;
}

export interface RetryModelInspection {
	choice: ModelChoice;
	available: boolean;
	diagnostics: readonly { code: string }[];
}

export type TransientModelSelection =
	| { kind: "same-model-first"; planIndex: number; choice: ModelChoice }
	| { kind: "approved-fallback"; planIndex: number; choice: ModelChoice; reason: "same-model-unavailable" | "same-model-retry-failed"; skipped: Array<{ planIndex: number; model: string; codes: string[] }> }
	| { kind: "unavailable"; skipped: Array<{ planIndex: number; model: string; codes: string[] }> };

function inspectionCodes(inspection: RetryModelInspection): string[] {
	return inspection.diagnostics.map((item) => item.code).filter((code) => typeof code === "string" && code.length > 0).slice(0, 8);
}

/** Selects a lineage-aware same-model-first, strictly-forward fallback. */
export function selectTransientModel(input: {
	actualModel: ModelChoice;
	plan: ModelPlan;
	inspections: readonly RetryModelInspection[];
	reason: "same-model-unavailable" | "same-model-retry-failed";
	requireProviderDifferentFrom?: string;
	allowSameProvider?: boolean;
}): TransientModelSelection {
	const choices = [input.plan.primary, ...input.plan.fallbacks];
	const inspected = choices.map((choice, planIndex) => {
		const direct = input.inspections[planIndex];
		if (direct?.choice.model === choice.model && direct.choice.thinkingLevel === choice.thinkingLevel) return direct;
		return input.inspections.find((item) => item.choice.model === choice.model && item.choice.thinkingLevel === choice.thinkingLevel) ?? { choice, available: false, diagnostics: [{ code: "uninspected" }] };
	});
	const currentIndex = choices.findIndex((choice) => choice.model === input.actualModel.model && choice.thinkingLevel === input.actualModel.thinkingLevel);
	if (currentIndex < 0) return { kind: "unavailable", skipped: [] };
	const current = inspected[currentIndex]!;
	const acceptable = (inspection: RetryModelInspection): boolean => {
		if (!inspection.available) return false;
		if (input.requireProviderDifferentFrom && !input.allowSameProvider && parseCanonicalModelReference(inspection.choice.model)?.provider === input.requireProviderDifferentFrom) return false;
		return true;
	};
	if (acceptable(current) && input.reason === "same-model-unavailable") return { kind: "same-model-first", planIndex: currentIndex, choice: { ...current.choice } };
	const skipped: Array<{ planIndex: number; model: string; codes: string[] }> = [];
	if (input.reason === "same-model-retry-failed" || !current.available || !acceptable(current)) skipped.push({ planIndex: currentIndex, model: current.choice.model, codes: inspectionCodes(current).concat(input.reason === "same-model-retry-failed" ? ["same-model-retry-failed"] : []).slice(0, 8) });
	for (let index = currentIndex + 1; index < choices.length; index += 1) {
		const candidate = inspected[index]!;
		if (acceptable(candidate)) return { kind: "approved-fallback", planIndex: index, choice: { ...candidate.choice }, reason: input.reason, skipped };
		skipped.push({ planIndex: index, model: candidate.choice.model, codes: inspectionCodes(candidate) });
	}
	return { kind: "unavailable", skipped };
}

export type SilenceRecoveryDecision =
	| { kind: "wait"; deadline: number }
	| { kind: "suspect" }
	| { kind: "warn-external" }
	| { kind: "external-grace" }
	| { kind: "nudge" }
	| { kind: "interrupt" }
	| { kind: "resume" }
	| { kind: "replace"; retryOrdinal: 1 | 2 }
	| { kind: "exhausted"; retryOrdinal: 0 | 1 | 2 }
	| { kind: "inspection-incomplete" };

export interface SilenceRecoveryTiming {
	now: number;
	passiveInspectionMs: number;
	secondInspectionMs: number;
	nudgeGraceMs: number;
	externalWarningMs: number;
	lastProgressAt: number;
	phaseAt: number;
	phase: "none" | "suspected" | "nudged" | "interrupted" | "resumed" | "waiting-external" | "external-grace" | "incomplete";
	externalFirstObservedAt?: number;
	externalExitedAt?: number;
	warnedExternal?: boolean;
	retryOrdinal?: number;
	retryLimit: number;
	process: "none" | "live" | "unavailable";
	unchanged: boolean;
}

function boundedRetryOrdinal(value: number | undefined): 0 | 1 | 2 {
	if (value === undefined || !Number.isSafeInteger(value) || value <= 0) return 0;
	return value >= 2 ? 2 : 1;
}

function boundedRetryLimit(value: number): 0 | 1 | 2 {
	if (!Number.isSafeInteger(value) || value <= 0) return 0;
	return value >= 2 ? 2 : 1;
}

/** Pure deadline/rung selection for ticket-11. No adapter or mutation authority. */
export function decideSilenceRecovery(input: SilenceRecoveryTiming): SilenceRecoveryDecision {
	if (input.process === "live") {
		if (input.externalFirstObservedAt !== undefined && !input.warnedExternal && input.now >= input.externalFirstObservedAt + input.externalWarningMs) return { kind: "warn-external" };
		return { kind: "wait", deadline: (input.externalFirstObservedAt ?? input.now) + input.externalWarningMs };
	}
	if (input.process === "unavailable") return { kind: "inspection-incomplete" };
	if (!input.unchanged) return { kind: "wait", deadline: input.now + input.passiveInspectionMs };
	if (input.phase === "external-grace") {
		const deadline = (input.externalExitedAt ?? input.now) + input.nudgeGraceMs;
		return input.now < deadline ? { kind: "wait", deadline } : { kind: "suspect" };
	}
	if (input.phase === "none") {
		const deadline = input.lastProgressAt + input.passiveInspectionMs;
		return input.now < deadline ? { kind: "wait", deadline } : { kind: "suspect" };
	}
	if (input.phase === "suspected" || input.phase === "incomplete") {
		const deadline = input.phaseAt + input.secondInspectionMs;
		return input.now < deadline ? { kind: "wait", deadline } : { kind: "nudge" };
	}
	if (input.phase === "nudged") {
		const deadline = input.phaseAt + input.nudgeGraceMs;
		return input.now < deadline ? { kind: "wait", deadline } : { kind: "interrupt" };
	}
	if (input.phase === "interrupted") return { kind: "resume" };
	if (input.phase === "resumed") {
		const deadline = input.phaseAt + input.nudgeGraceMs;
		if (input.now < deadline) return { kind: "wait", deadline };
		const consumed = boundedRetryOrdinal(input.retryOrdinal);
		const limit = boundedRetryLimit(input.retryLimit);
		if (limit === 0 || consumed >= limit || consumed >= 2) return { kind: "exhausted", retryOrdinal: consumed };
		const ordinal = (consumed + 1) as 1 | 2;
		return { kind: "replace", retryOrdinal: ordinal };
	}
	return { kind: "wait", deadline: input.now + input.passiveInspectionMs };
}

export interface TaskFactRequest {
	schemaVersion: 1;
	field: TaskFactKey;
	canonical: string;
	questionSha256: string;
}

export type TaskFactRequestResult =
	| { kind: "fact-request"; request: TaskFactRequest }
	| { kind: "unstructured"; diagnostic: string }
	| { kind: "unclear"; diagnostic: string };

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
	return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	return JSON.stringify(value);
}

function allowedField(field: unknown, role: TaskFactRole): field is TaskFactKey {
	return typeof field === "string" && TASK_FACT_KEYS.includes(field as TaskFactKey) && (field !== "reviewSubject" || role === "reviewer");
}

/** Parse one bounded canonical marker from a Herdr detection snapshot. */
export function parseTaskFactRequest(snapshot: string, role: TaskFactRole): TaskFactRequestResult {
	if (typeof snapshot !== "string" || Buffer.byteLength(snapshot, "utf8") > 16 * 1024 || snapshot.includes("\u0000")) return { kind: "unclear", diagnostic: "Task-fact detection exceeded the bounded input." };
	const marker = `${TASK_FACT_REQUEST_PREFIX} `;
	const occurrences = snapshot.split(marker).length - 1;
	if (occurrences === 0) return { kind: "unstructured", diagnostic: "No canonical Steward Task-fact request was detected." };
	if (occurrences !== 1) return { kind: "unstructured", diagnostic: "Multiple Task-fact request markers are not answerable." };
	const line = snapshot.trim();
	if (!line.startsWith(marker) || line.includes("\n") || line.length > 256) return { kind: "unstructured", diagnostic: "Task-fact request must be one canonical bounded line." };
	const payload = line.slice(marker.length);
	let parsed: unknown;
	try { parsed = JSON.parse(payload); } catch { return { kind: "unstructured", diagnostic: "Task-fact request JSON is malformed." }; }
	if (!isObject(parsed) || Object.keys(parsed).length !== 2 || parsed.schemaVersion !== TASK_FACT_SCHEMA_VERSION || !allowedField(parsed.field, role) || JSON.stringify(parsed) !== payload) {
		return { kind: "unstructured", diagnostic: "Task-fact request is not the exact allowlisted canonical JSON form." };
	}
	const canonical = `${TASK_FACT_REQUEST_PREFIX} ${payload}`;
	return { kind: "fact-request", request: { schemaVersion: 1, field: parsed.field, canonical, questionSha256: sha256(canonical) } };
}

export interface TaskFactAnswer {
	field: TaskFactKey;
	value: unknown;
	canonicalValue: string;
	payload: string;
	answer: string;
	answerSha256: string;
}

export type TaskFactAnswerResult =
	| { kind: "answer"; answer: TaskFactAnswer }
	| { kind: "not-derivable"; diagnostic: string };

/**
 * Encode only a value already frozen in the caller's validated Assignment and
 * Task contract. The prefix/payload is intentionally shell-agnostic.
 */
export function resolveTaskFactAnswer(field: TaskFactKey, value: unknown): TaskFactAnswerResult {
	if (!TASK_FACT_KEYS.includes(field)) return { kind: "not-derivable", diagnostic: "Task-fact field is not allowlisted." };
	let canonicalValue: string;
	try { canonicalValue = canonicalJson(value); } catch { return { kind: "not-derivable", diagnostic: "Task-fact value is not serializable." }; }
	if (canonicalValue === undefined || Buffer.byteLength(canonicalValue, "utf8") > 16 * 1024) return { kind: "not-derivable", diagnostic: "Task-fact value exceeds the bounded answer size." };
	const payload = Buffer.from(canonicalValue, "utf8").toString("base64url");
	const answer = `${TASK_FACT_ANSWER_PREFIX} ${payload}`;
	return { kind: "answer", answer: { field, value, canonicalValue, payload, answer, answerSha256: sha256(answer) } };
}

export function taskFactValue(input: {
	field: TaskFactKey;
	task: { requiredOutcome: string; allowedScope: string[]; expectedArtifacts: unknown[]; verification: unknown };
	attempt: { reportPath: string; evidenceDirectory: string; subject?: unknown };
}): unknown {
	switch (input.field) {
		case "requiredOutcome": return input.task.requiredOutcome;
		case "allowedScope": return input.task.allowedScope;
		case "expectedArtifacts": return input.task.expectedArtifacts;
		case "verification": return input.task.verification;
		case "reportPath": return input.attempt.reportPath;
		case "evidenceDirectory": return input.attempt.evidenceDirectory;
		case "reviewSubject": return input.attempt.subject;
	}
}

export function formatTaskFactInstruction(): string {
	return `If you need one frozen Task fact, ask exactly: ${TASK_FACT_REQUEST_PREFIX} {"schemaVersion":1,"field":"reportPath"}. Only the allowlisted Assignment/Task facts may be requested; do not ask for credentials, scope changes, model choices, approvals, or Git authority.`;
}
