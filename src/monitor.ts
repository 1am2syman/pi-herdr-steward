import type {
	MonitorPassResult,
	MonitorTrigger,
	MonitorWaitResult,
	Steward,
} from "./steward.ts";

export interface StewardSessionMonitorInput {
	repositoryRoot: string;
	controllerSessionId: string;
	steward: Steward;
}

export interface StewardSessionMonitor {
	start(): void;
	markAgentBusy(): void;
	markAgentSettled(): void;
	markCompactionStarted(): void;
	markCompactionSucceeded(): void;
	markCompactionFailed(): void;
	markCompactionEnded(): void;
	markUiPromptStarted(): void;
	markUiPromptEnded(): void;
	wake(trigger?: MonitorTrigger): void;
	runExclusive<T>(work: () => Promise<T>): Promise<T>;
	stop(): Promise<void>;
}

/**
 * Owns only the lifetime of one interactive Controller Session. Workflow
 * policy remains in Steward; this module serializes observation and calls the
 * controller only after Pi reports a settled, non-compacting, non-prompting
 * idle boundary.
 */
export function createStewardSessionMonitor(input: StewardSessionMonitorInput): StewardSessionMonitor {
	let closed = false;
	let started = false;
	let generation = 0;
	let agentBusy = false;
	let agentSettled = false;
	let compacting = false;
	let uiPromptBusy = false;
	let pending = false;
	let activePass: Promise<void> | undefined;
	let waiter: Promise<void> | undefined;
	let waiterAbort: AbortController | undefined;
	let waiterRestartRequested = false;
	let lastNotificationKey: string | undefined;
	let exclusiveBusy = false;
	let exclusiveTail = Promise.resolve();
	let completedDormant = false;
	let compactionFailurePending = false;

	function currentGeneration(): number {
		return generation;
	}

	function isCurrent(value: number): boolean {
		return !closed && value === currentGeneration();
	}

	function safeIdle(): boolean {
		return agentSettled && !agentBusy && !compacting && !uiPromptBusy;
	}

	function passWithNotification(result: MonitorPassResult): MonitorPassResult {
		if (result.condition === "ordinary" || result.condition === "completed") return result;
		const journalId = result.journal?.run.id ?? "none";
		const revision = result.journal?.journalRevision ?? 0;
		const key = `${journalId}:${result.condition}:${revision}:${result.diagnostic ?? result.note}`;
		if (key === lastNotificationKey) return { ...result, notification: false };
		lastNotificationKey = key;
		return result;
	}

	async function present(result: MonitorPassResult, value: number): Promise<void> {
		if (!isCurrent(value)) return;
		input.steward.presentMonitor(passWithNotification(result), "footer");
	}

	function startWaiter(value: number): void {
		if (!isCurrent(value) || waiter) return;
		const abort = new AbortController();
		waiterAbort = abort;
		let restartWaiterAfter = true;
		const task = (async () => {
			let result;
			let removeAbortListener: (() => void) | undefined;
			try {
				const abortPromise = new Promise<MonitorWaitResult>((resolve) => {
					const onAbort = () => {
						abort.signal.removeEventListener("abort", onAbort);
						resolve({ kind: "cancelled" });
					};
					removeAbortListener = () => abort.signal.removeEventListener("abort", onAbort);
					if (abort.signal.aborted) onAbort();
					else abort.signal.addEventListener("abort", onAbort, { once: true });
				});
				result = await Promise.race([
					input.steward.waitForMonitorSignal(input.repositoryRoot, input.controllerSessionId, abort.signal),
					abortPromise,
				]);
			} catch {
				result = { kind: "unavailable" as const, diagnostic: "Monitor lifecycle wait failed." };
			} finally {
				removeAbortListener?.();
			}
			if (!isCurrent(value) || result.kind === "cancelled") return;
			if (result.kind === "unavailable") restartWaiterAfter = false;
			if (result.kind === "unavailable") return;
			if (result.kind === "settled") {
				requestPass("lifecycle");
			} else {
				requestPass(result.kind === "timeout" ? "fallback" : "lifecycle");
			}
		})();
		waiter = task;
		const finish = (): void => {
			if (waiter !== task) return;
		waiter = undefined;
		waiterAbort = undefined;
		const restart = waiterRestartRequested;
		waiterRestartRequested = false;
		if (isCurrent(value) && (restart || restartWaiterAfter)) {
				// Only timeout/settled fallback cycles restart. An unavailable current
				// Journal is intentionally dormant until the next lifecycle wake.
				startWaiter(value);
			}
		};
		task.then(finish, finish);
	}

	async function runPass(value: number, trigger: MonitorTrigger): Promise<void> {
		if (!isCurrent(value) || exclusiveBusy) return;
		const skipWorkflow = compactionFailurePending;
		compactionFailurePending = false;
		if (skipWorkflow) return;
		const observed = await input.steward.observeMonitorProgress(input.repositoryRoot, input.controllerSessionId, trigger);
		if (!isCurrent(value)) return;
		await present(observed, value);
		if (skipWorkflow || compactionFailurePending) {
			compactionFailurePending = false;
			return;
		}
		if (!isCurrent(value) || !safeIdle() || observed.condition === "degraded" || observed.action === "approval-required" || observed.action === "blocked") return;
		const advanced = await input.steward.advanceNext(input.repositoryRoot, input.controllerSessionId, { interactive: false, maximumActions: 1 });
		if (!isCurrent(value)) return;
		const hasDurableProgress = observed.journal?.journalRevision !== undefined
			&& advanced.journal?.journalRevision !== undefined
			&& advanced.journal.journalRevision > observed.journal.journalRevision;
		const noProgressAction = !hasDurableProgress && !["none", "record-observation", "approval-required", "blocked", "degraded"].includes(advanced.action);
		let bounded: MonitorPassResult = advanced;
		if (noProgressAction) {
			const { completed: _completed, ...withoutCompletion } = advanced;
			bounded = { ...withoutCompletion, action: "none", note: `${advanced.note} No durable Journal progress was recorded; waiting for a later lifecycle or fallback signal.` };
		}
		await present(bounded, value);
		if (bounded.completed || bounded.condition === "completed") {
			completedDormant = true;
			closed = true;
			generation += 1;
			waiterAbort?.abort();
			return;
		}
		if (!hasDurableProgress || bounded.condition !== "ordinary" || ["none", "record-observation", "approval-required", "blocked", "degraded"].includes(bounded.action)) return;
		requestPass("manual");
	}

	function requestPass(trigger: MonitorTrigger): void {
		if (closed || !started) return;
		pending = true;
		if (activePass) return;
		const value = currentGeneration();
		activePass = (async () => {
			while (pending && isCurrent(value)) {
				pending = false;
				await runPass(value, trigger);
			}
		})().catch((error: unknown) => {
			if (isCurrent(value)) {
				const diagnostic = error instanceof Error ? error.message.slice(0, 2_000) : "Monitor pass failed.";
				try { input.steward.presentMonitor({ action: "degraded", note: "Monitor pass failed; authoritative workflow state was not inferred from the diagnostic.", condition: "degraded", diagnostic }, "footer"); } catch { /* Presentation failure cannot alter durable state. */ }
			}
		}).finally(() => {
			activePass = undefined;
			if (pending && !closed) requestPass(trigger);
			if (!closed && started && !waiter) startWaiter(currentGeneration());
		});
	}

	function restartWaiter(): void {
		if (!started || closed) return;
		waiterRestartRequested = true;
		waiterAbort?.abort();
		if (!waiter) {
			waiterRestartRequested = false;
			startWaiter(currentGeneration());
		}
	}

	function start(): void {
		if (started || closed) return;
		started = true;
		generation += 1;
		requestPass("start");
		startWaiter(currentGeneration());
	}

	function markAgentBusy(): void {
		if (closed) return;
		agentBusy = true;
		agentSettled = false;
		restartWaiter();
		requestPass("turn");
	}

	function markAgentSettled(): void {
		if (closed) return;
		agentBusy = false;
		agentSettled = true;
		requestPass("settled");
	}

	function markCompactionStarted(): void {
		if (closed) return;
		compacting = true;
		compactionFailurePending = false;
		requestPass("compaction");
	}

	function markCompactionSucceeded(): void {
		if (closed) return;
		compacting = false;
		compactionFailurePending = false;
		requestPass("compaction-success");
	}

	function markCompactionFailed(): void {
		if (closed) return;
		compacting = false;
		compactionFailurePending = true;
		pending = false;
		restartWaiter();
	}

	function markCompactionEnded(): void {
		markCompactionSucceeded();
	}

	function markUiPromptStarted(): void {
		if (closed) return;
		uiPromptBusy = true;
	}

	function markUiPromptEnded(): void {
		if (closed) return;
		uiPromptBusy = false;
		requestPass("prompt");
	}

	function wake(trigger: MonitorTrigger = "manual"): void {
		requestPass(trigger);
	}

	function runExclusive<T>(work: () => Promise<T>): Promise<T> {
		const operation = exclusiveTail.then(async () => {
			if (closed && !completedDormant) throw new Error("Steward session monitor is stopped.");
			exclusiveBusy = true;
			markUiPromptStarted();
			try {
				while (activePass) await activePass;
				return await work();
			} finally {
				exclusiveBusy = false;
				markUiPromptEnded();
			}
		});
		exclusiveTail = operation.then(() => undefined, () => undefined);
		return operation;
	}

	async function stop(): Promise<void> {
		if (closed) {
			await activePass;
			await waiter;
			await exclusiveTail;
			return;
		}
		closed = true;
		generation += 1;
		pending = false;
		waiterAbort?.abort();
		await activePass;
		await waiter;
		await exclusiveTail;
		activePass = undefined;
		waiter = undefined;
	}

	return { start, markAgentBusy, markAgentSettled, markCompactionStarted, markCompactionSucceeded, markCompactionFailed, markCompactionEnded, markUiPromptStarted, markUiPromptEnded, wake, runExclusive, stop };
}
