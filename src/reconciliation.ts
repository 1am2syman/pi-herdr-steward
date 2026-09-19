import { createHash } from "node:crypto";

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
