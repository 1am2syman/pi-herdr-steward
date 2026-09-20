import type { RunRecord, TaskRecord } from "./run.ts";

/**
 * Scope comparison is intentionally lexical and segment-aware.  Contracts are
 * already validated as safe relative paths, so this function does not resolve
 * the filesystem or interpret globs.
 */
export function allowedScopesOverlap(left: readonly string[], right: readonly string[]): boolean {
	return left.some((a) => right.some((b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

export function isCodeTask(task: TaskRecord): boolean {
	return task.contract.expectedArtifacts.some((artifact) => artifact.kind === "git-commit");
}

export function taskScopesOverlap(left: TaskRecord, right: TaskRecord): boolean {
	return allowedScopesOverlap(left.contract.allowedScope, right.contract.allowedScope);
}

function occupiesActiveSlot(task: TaskRecord): boolean {
	return task.phase === "building" || task.phase === "reviewing" || task.phase === "reworking";
}

export function countActiveTasks(run: Pick<RunRecord, "tasks">): number {
	return run.tasks.filter(occupiesActiveSlot).length;
}

export type TaskAdmissionDecision =
	| { kind: "none"; reason: "no-pending-code-task" | "all-tasks-non-code" }
	| { kind: "at-cap"; activeCount: number; maximumActiveTasks: number }
	| { kind: "blocked-by-overlap"; taskId: string; blockedBy: string[] }
	| { kind: "admit"; taskId: string; index: number; baseRevision: string };

function currentIntegrationHead(run: Pick<RunRecord, "integrationBase" | "tasks">): string | undefined {
	if (run.integrationBase.kind !== "git") return undefined;
	let head = run.integrationBase.revision;
	for (const task of run.tasks) {
		if (!isCodeTask(task)) continue;
		if (task.integration?.phase !== "integrated") break;
		head = task.integration.observedHead;
	}
	return head;
}

function earlierOverlappingTasks(run: Pick<RunRecord, "tasks">, index: number): TaskRecord[] {
	const candidate = run.tasks[index];
	if (!candidate) return [];
	return run.tasks.slice(0, index).filter((task) => isCodeTask(task) && taskScopesOverlap(task, candidate));
}

/**
 * Selects one admission or one closed reason.  The array order remains the
 * only priority/order source; disjoint later Tasks may use a free slot.
 */
export function selectTaskAdmission(run: Pick<RunRecord, "tasks" | "integrationBase" | "effectiveSettings">): TaskAdmissionDecision {
	const pending = run.tasks.filter((task) => task.phase === "pending" && isCodeTask(task));
	if (pending.length === 0) return { kind: "none", reason: run.tasks.some(isCodeTask) ? "no-pending-code-task" : "all-tasks-non-code" };
	const activeCount = countActiveTasks(run);
	const maximumActiveTasks = run.effectiveSettings.maximumActiveTasks;
	if (activeCount >= maximumActiveTasks) return { kind: "at-cap", activeCount, maximumActiveTasks };
	const head = currentIntegrationHead(run);
	if (!head) return { kind: "none", reason: "no-pending-code-task" };
	let blocked: { taskId: string; blockedBy: string[] } | undefined;
	for (let index = 0; index < run.tasks.length; index += 1) {
		const task = run.tasks[index];
		if (!task || task.phase !== "pending" || !isCodeTask(task)) continue;
		const occupied = run.tasks.filter((other) => other !== task && occupiesActiveSlot(other));
		const occupiedOverlap = occupied.filter((other) => taskScopesOverlap(task, other));
		if (occupiedOverlap.length > 0) {
			if (!blocked) blocked = { taskId: task.contract.id, blockedBy: occupiedOverlap.map((other) => other.contract.id) };
			continue;
		}
		const earlier = earlierOverlappingTasks(run, index).filter((other) => other.integration?.phase !== "integrated");
		if (earlier.length > 0) {
			if (!blocked) blocked = { taskId: task.contract.id, blockedBy: earlier.map((other) => other.contract.id) };
			continue;
		}
		return { kind: "admit", taskId: task.contract.id, index, baseRevision: head };
	}
	return blocked ? { kind: "blocked-by-overlap", ...blocked } : { kind: "none", reason: "no-pending-code-task" };
}

export type IntegrationQueueDecision =
	| { kind: "none"; reason: "all-integrated" | "no-code-task" }
	| { kind: "waiting"; taskId: string; index: number; reason: "predecessor" | "approval" | "source" | "attention" | "integration" }
	| {
			kind: "ready";
			taskId: string;
			index: number;
			targetRevision: string;
			approvedBaseRevision: string;
			approvedHeadRevision: string;
			action: "fast-forward" | "merge-commit";
	  };

/** Returns the first non-integrated code Task in immutable Run array order. */
export function selectIntegrationQueueHead(run: Pick<RunRecord, "tasks" | "integrationBase">): IntegrationQueueDecision {
	if (run.integrationBase.kind !== "git") return { kind: "none", reason: "no-code-task" };
	const codeTasks = run.tasks.flatMap((task, index) => (isCodeTask(task) ? [{ task, index }] : []));
	if (codeTasks.length === 0) return { kind: "none", reason: "no-code-task" };
	let previousHead = run.integrationBase.revision;
	for (let queueIndex = 0; queueIndex < codeTasks.length; queueIndex += 1) {
		const entry = codeTasks[queueIndex]!;
		const task = entry.task;
		if (task.integration?.phase === "integrated") {
			previousHead = task.integration.observedHead;
			continue;
		}
		if (queueIndex > 0 && codeTasks[queueIndex - 1]!.task.integration?.phase !== "integrated") return { kind: "waiting", taskId: task.contract.id, index: entry.index, reason: "predecessor" };
		if (task.attention !== "none") return { kind: "waiting", taskId: task.contract.id, index: entry.index, reason: "attention" };
		if (task.integration?.phase === "intended" || task.integration?.phase === "failed" || task.integration?.phase === "ambiguous") return { kind: "waiting", taskId: task.contract.id, index: entry.index, reason: task.integration.phase === "intended" ? "integration" : "attention" };
		if (task.phase !== "approved" && task.phase !== "integrating") return { kind: "waiting", taskId: task.contract.id, index: entry.index, reason: "approval" };
		if (!task.approval || task.approval.phase !== "valid" || task.approval.subject.kind !== "git") return { kind: "waiting", taskId: task.contract.id, index: entry.index, reason: "approval" };
		const subject = task.approval.subject;
		const builder = task.attempts.find((attempt) => attempt.role === "builder" && attempt.id === task.approval?.builderAttemptId);
		if (!builder || builder.evidence?.phase !== "finalized" || builder.evidence.producedRevision !== subject.headRevision) return { kind: "waiting", taskId: task.contract.id, index: entry.index, reason: "source" };
		return {
			kind: "ready",
			taskId: task.contract.id,
			index: entry.index,
			targetRevision: previousHead,
			approvedBaseRevision: subject.baseRevision,
			approvedHeadRevision: subject.headRevision,
			action: previousHead === subject.baseRevision ? "fast-forward" : "merge-commit",
		};
	}
	return { kind: "none", reason: "all-integrated" };
}

export interface IntegratedHeadEntry {
	taskId: string;
	index: number;
	targetRevision: string;
	observedHead: string;
}

export function orderedIntegratedHeadChain(run: Pick<RunRecord, "tasks" | "integrationBase">): IntegratedHeadEntry[] {
	if (run.integrationBase.kind !== "git") return [];
	const chain: IntegratedHeadEntry[] = [];
	let targetRevision = run.integrationBase.revision;
	for (let index = 0; index < run.tasks.length; index += 1) {
		const task = run.tasks[index];
		if (!task || !isCodeTask(task)) continue;
		if (task.integration?.phase !== "integrated") break;
		chain.push({ taskId: task.contract.id, index, targetRevision, observedHead: task.integration.observedHead });
		targetRevision = task.integration.observedHead;
	}
	return chain;
}

export function allRequiredTasksIntegrated(run: Pick<RunRecord, "tasks" | "integrationBase">): boolean {
	return run.tasks.every((task) => !isCodeTask(task) ? task.phase === "completed" : task.integration?.phase === "integrated");
}

export function currentIntegratedHead(run: Pick<RunRecord, "tasks" | "integrationBase">): string | undefined {
	return currentIntegrationHead(run);
}
