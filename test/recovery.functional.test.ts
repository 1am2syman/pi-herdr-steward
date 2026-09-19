import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { createConfigStore } from "../src/config-store.ts";
import { createRunJournalAdapter } from "../src/adapters.ts";
import { registerStewardExtension, type StewardCommandContext, type StewardCommandHandler } from "../src/extension.ts";
import type { ProjectModelPlans, RecoveryDefaults } from "../src/config.ts";
import type { RunDraft, RunJournal } from "../src/run.ts";
import type { ManagedAgentInspection, MonitorDigest, ResumeResult, SilenceProcessObservation, StewardDependencies, StewardHerdrAdapter, StewardUiAdapter } from "../src/steward.ts";

vi.setConfig({ testTimeout: 60_000 });

const roots: string[] = [];
const baseRevision = "0123456789abcdef0123456789abcdef01234567";
const identity = { name: "steward-b-01234567-01-01", workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1" };
const modelPlans: ProjectModelPlans = {
	builder: { primary: { model: "builder/primary", thinkingLevel: "max" }, fallbacks: [] },
	reviewer: { primary: { model: "reviewer/primary", thinkingLevel: "high" }, fallbacks: [] },
};
const settings: RecoveryDefaults = {
	passiveInspectionIntervalSeconds: 10,
	secondInspectionAndNudgeIntervalSeconds: 20,
	nudgeGracePeriodSeconds: 5,
	externalCommandWarningThresholdSeconds: 30,
	maximumActiveTasks: 1,
	transientRetryLimit: 1,
	reworkCycleLimit: 2,
};

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type Effects = {
	nudge: number;
	interrupt: number;
	resume: number;
	recoveryPanes: number;
	replacementStarts: number;
	replacementPrompts: number;
	gitMutations: number;
};

function digest(value: string): string {
	return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function draft(): RunDraft {
	return {
		declaredOutcome: "Recover a quiet managed change without losing work",
		tasks: [{
			requiredOutcome: "Keep the exact change in the managed worktree",
			allowedScope: ["src"],
			expectedArtifacts: [{ kind: "git-commit" }],
			verification: { kind: "command", command: "npm test" },
			reviewRequired: false,
		}],
		modelPlan: modelPlans,
		effectiveSettings: settings,
		finalVerification: { kind: "command", command: "npm test" },
	};
}

function context(root: string): StewardCommandContext {
	return {
		mode: "tui",
		hasUI: true,
		cwd: root,
		modelRegistry: {} as StewardCommandContext["modelRegistry"],
		model: undefined,
		thinkingLevel: undefined,
		scopedModels: [],
		sessionManager: { getSessionId: () => "controller-11" } as StewardCommandContext["sessionManager"],
		ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined, notify() {}, setStatus() {} },
	};
}

function observedAgent(lifecycle: ManagedAgentInspection["kind"] = "observed"): ManagedAgentInspection {
	return lifecycle === "observed"
		? { kind: "observed", identity: { ...identity }, lifecycle: "working", stateChangeSequence: 7 }
		: { kind: lifecycle, diagnostic: "fixture" };
}

function observedDigest(label: string): MonitorDigest {
	return { kind: "observed", byteCount: label.length, sha256: digest(label) };
}

function noneProcess(): SilenceProcessObservation {
	return { kind: "none", paneId: identity.paneId, shellPid: 101, foregroundProcessGroupId: 101, processCount: 2, digest: digest("managed-pi") };
}

function externalProcess(): SilenceProcessObservation {
	return { kind: "live-external", paneId: identity.paneId, shellPid: 101, foregroundProcessGroupId: 202, processCount: 3, digest: digest("vitest-child"), classification: "test", executableName: "vitest" };
}

async function makeFixture(initialProcess: SilenceProcessObservation): Promise<{
	root: string;
	command: StewardCommandHandler;
	deps: StewardDependencies;
	clock: { nowMs: number; setAfter(iso: string, milliseconds: number): void };
	effects: Effects;
	order: string[];
	setProcess(value: SilenceProcessObservation): void;
	lastResume(): ResumeResult | undefined;
	load(): Promise<RunJournal>;
}> {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-recovery-"));
	roots.push(root);
	const config = createConfigStore();
	await config.saveRecoveryDefaults(settings);
	await config.saveModelPlans(root, modelPlans);

	let nowMs = Date.parse("2026-09-19T00:00:00.000Z");
	const clock = {
		now: () => new Date(nowMs),
		randomUUID: () => "01234567-89ab-cdef-0123-456789abcdef",
		wait: async (_milliseconds: number, signal: AbortSignal) => { if (signal.aborted) throw new Error("aborted"); },
	};
	const clockView = {
		nowMs,
		setAfter(iso: string, milliseconds: number) {
			nowMs = Math.max(nowMs, Date.parse(iso) + milliseconds);
			this.nowMs = nowMs;
		},
	};
	const effects: Effects = { nudge: 0, interrupt: 0, resume: 0, recoveryPanes: 0, replacementStarts: 0, replacementPrompts: 0, gitMutations: 0 };
	const order: string[] = [];
	let processObservation = initialProcess;
	let resumeResult: ResumeResult | undefined;
	const builderPath = join(root, "builder-worktree");
	const replacementPane = { workspaceId: "workspace-2", tabId: "tab-2", paneId: "pane-2", terminalId: "terminal-2" };
	const runJournal = createRunJournalAdapter();
	const replaceActive = runJournal.replaceActive.bind(runJournal);
	runJournal.replaceActive = async (repositoryRoot, candidate) => {
		const result = await replaceActive(repositoryRoot, candidate);
		return result;
	};
	const inspectPreservation = runJournal.inspectAttemptPreservation;
	if (!inspectPreservation) throw new Error("preservation adapter missing");
	runJournal.inspectAttemptPreservation = async (input) => {
		order.push("assignment-report-evidence");
		return inspectPreservation(input);
	};

	const ui: StewardUiAdapter = {
		presentStatus() {},
		async editConfiguration() { return { kind: "cancelled" }; },
		presentConfigurationResult() {},
		async draftRun() { return { kind: "drafted" as const, draft: draft() }; },
		async confirmRun() { return true; },
		presentStartResult() {},
		presentResumeResult(result) { resumeResult = result; },
	};

	const herdr: StewardHerdrAdapter = {
		async checkAvailability() { return { kind: "available", status: "running", running: true, compatible: true, endpointCompatible: true }; },
		async createBuilderWorktree(input) { await mkdir(builderPath, { recursive: true }); return { kind: "created", branch: input.branch, path: builderPath, workspaceId: identity.workspaceId, tabId: "tab-1", paneId: identity.paneId, terminalId: identity.terminalId }; },
		async startBuilder(input) { return { kind: "started", name: input.name, agentKind: "pi", workspaceId: identity.workspaceId, tabId: "tab-1", paneId: identity.paneId, terminalId: identity.terminalId }; },
		async promptBuilder(input) { return { kind: "prompted", name: input.name, workspaceId: identity.workspaceId, tabId: "tab-1", paneId: identity.paneId, terminalId: identity.terminalId }; },
		async inspectManagedAgent() { order.push("herdr"); return observedAgent(); },
		async readManagedTerminal() { order.push("terminal"); return observedDigest("terminal-unchanged"); },
		async nudgeAgent(input) { effects.nudge += 1; return { kind: "prompted", name: input.identity.name, workspaceId: input.identity.workspaceId, tabId: "tab-1", paneId: input.identity.paneId, terminalId: input.identity.terminalId }; },
		async interruptAgent(input) { effects.interrupt += 1; return { kind: "acknowledged", identity: { ...input.identity } }; },
		async resumeAgent(input) { effects.resume += 1; return { kind: "prompted", name: input.identity.name, workspaceId: input.identity.workspaceId, tabId: "tab-1", paneId: input.identity.paneId, terminalId: input.identity.terminalId }; },
		async createRecoveryPane(input) { effects.recoveryPanes += 1; return { kind: "created", ...replacementPane, sourcePaneId: input.sourcePaneId, worktreePath: input.worktreePath }; },
		async startReplacementAgent(input) { effects.replacementStarts += 1; return { kind: "started", name: input.name, agentKind: "pi", workspaceId: replacementPane.workspaceId, tabId: replacementPane.tabId, paneId: replacementPane.paneId, terminalId: replacementPane.terminalId }; },
		async promptReplacementAgent(input) { effects.replacementPrompts += 1; return { kind: "prompted", name: input.identity.name, workspaceId: input.identity.workspaceId, tabId: replacementPane.tabId, paneId: replacementPane.paneId, terminalId: replacementPane.terminalId }; },
	};
	const git: StewardDependencies["git"] = {
		async inspectIntegrationBase() { return { kind: "ready", branch: "main", revision: baseRevision }; },
		async branchExists() { return false; },
		async inspectBuilderWorktree(_path, expectedRevision) { return { kind: "ready", head: expectedRevision, clean: true }; },
		async inspectManagedWorktreeProgress() { order.push("worktree-git"); return { kind: "observed", head: baseRevision, worktree: observedDigest("worktree-unchanged"), git: { head: baseRevision, digest: observedDigest("git-unchanged") } }; },
		async integrateApprovedRange() { effects.gitMutations += 1; return { kind: "completed", code: 0, stdout: "", stderr: "", killed: false }; },
	};
	const process: StewardDependencies["process"] = {
		inspectAttemptProcesses: async () => { order.push("process"); return processObservation; },
	};
	const deps: StewardDependencies = {
		runJournal,
		herdr,
		git,
		process,
		model: { listModelChoices: () => [], async validateModelPlans() { return []; } },
		clock,
		ui,
	};
	let command: StewardCommandHandler | undefined;
	registerStewardExtension({
		on() {},
		registerCommand(_name, options) { command = options.handler; },
	}, () => deps);
	if (!command) throw new Error("Steward command was not registered");
	await command("start", context(root));
	const load = async (): Promise<RunJournal> => {
		const result = await runJournal.loadActive(root);
		if (result.kind !== "loaded") throw new Error(`Active Journal unavailable: ${result.kind}`);
		return result.journal;
	};
	await load();
	return {
		root,
		command,
		deps,
		clock: clockView,
		effects,
		order,
		setProcess(value) { processObservation = value; },
		lastResume: () => resumeResult,
		load,
	};
}

async function resume(fixture: Awaited<ReturnType<typeof makeFixture>>): Promise<RunJournal> {
	await fixture.command("resume", context(fixture.root));
	return fixture.load();
}

it.sequential("registered silence recovery uses a controllable clock to inspect, nudge, Escape, resume the same agent, then reserve one linked replacement", async () => {
	const fixture = await makeFixture(noneProcess());
	let journal = await fixture.load();
	await resume(fixture); // ticket-10 reconciliation records the exact working resource first.
	journal = await fixture.load();
	let attempt = journal.run.tasks[0]?.attempts[0];
	if (!attempt || attempt.role !== "builder" || !attempt.activatedAt) throw new Error("active Builder fixture is missing");
	fixture.order.length = 0;

	fixture.clock.setAfter(attempt.recovery?.live.observedAt ?? attempt.activatedAt, settings.passiveInspectionIntervalSeconds * 1_000);
	journal = await resume(fixture);
	let task = journal.run.tasks[0]!;
	attempt = task.attempts[0]!;
	expect(task.attention).toBe("suspected-stall");
	expect(attempt.state).toBe("active");
	expect(attempt.recovery?.silence?.phase).toBe("suspected");
	expect(fixture.effects.nudge + fixture.effects.interrupt + fixture.effects.resume).toBe(0);
	expect(task.attempts.filter((item) => item.replacement).length).toBe(0);
	expect(fixture.order.slice(-5)).toEqual(["herdr", "terminal", "worktree-git", "assignment-report-evidence", "process"]);

	const suspectedAt = attempt.recovery?.silence?.phaseAt;
	if (!suspectedAt) throw new Error("suspected phase timestamp is missing");
	fixture.order.length = 0;
	fixture.clock.setAfter(suspectedAt, settings.secondInspectionAndNudgeIntervalSeconds * 1_000);
	journal = await resume(fixture);
	attempt = journal.run.tasks[0]?.attempts[0];
	expect(attempt?.recovery?.silence?.phase).toBe("nudged");
	expect(fixture.effects.nudge).toBe(1);
	expect(fixture.effects.interrupt + fixture.effects.resume).toBe(0);
	expect(fixture.order.slice(-5)).toEqual(["herdr", "terminal", "worktree-git", "assignment-report-evidence", "process"]);

	const nudgedAt = attempt?.recovery?.silence?.phaseAt;
	if (!nudgedAt) throw new Error("nudged phase timestamp is missing");
	fixture.clock.setAfter(nudgedAt, settings.nudgeGracePeriodSeconds * 1_000);
	journal = await resume(fixture);
	attempt = journal.run.tasks[0]?.attempts[0];
	expect(attempt?.recovery?.silence?.phase).toBe("interrupted");
	expect(fixture.effects.interrupt).toBe(1);
	expect(fixture.effects.resume).toBe(0);

	await resume(fixture); // logical Escape is followed by exactly one same-agent resume pass.
	journal = await fixture.load();
	attempt = journal.run.tasks[0]?.attempts[0];
	expect(attempt?.recovery?.silence?.phase).toBe("resumed");
	expect(fixture.effects.resume).toBe(1);
	expect(journal.run.tasks[0]?.attempts.filter((item) => item.replacement).length).toBe(0);

	const resumedAt = attempt?.recovery?.silence?.phaseAt;
	if (!resumedAt) throw new Error("resumed phase timestamp is missing");
	fixture.clock.setAfter(resumedAt, settings.nudgeGracePeriodSeconds * 1_000);
	journal = await resume(fixture);
	task = journal.run.tasks[0]!;
	const predecessor = task.attempts[0]!;
	const replacement = task.attempts[1]!;
	expect(predecessor.state).toBe("superseded");
	expect(predecessor.recovery?.silence?.phase).toBe("replacement-intended");
	expect(replacement.state).toBe("prepared");
	expect(replacement.replacement).toMatchObject({ kind: "silent-agent-recovery", replacesAttemptId: predecessor.id, retryOrdinal: 1 });
	expect(replacement.role).toBe(predecessor.role);
	expect(replacement.actualModel).toEqual(predecessor.actualModel);
	expect(replacement.specificationHash).toBe(predecessor.specificationHash);
	expect("worktreePath" in replacement.dispatch && "worktreePath" in predecessor.dispatch && replacement.dispatch.worktreePath).toBe("worktreePath" in predecessor.dispatch ? predecessor.dispatch.worktreePath : undefined);
	expect(fixture.effects.nudge).toBe(1);
	expect(fixture.effects.interrupt).toBe(1);
	expect(fixture.effects.resume).toBe(1);
	expect(fixture.effects.recoveryPanes).toBe(0);
	expect(fixture.effects.replacementStarts).toBe(0);
	expect(fixture.effects.replacementPrompts).toBe(0);
	expect(fixture.effects.gitMutations).toBe(0);
	expect(task.attempts.filter((item) => item.replacement).length).toBe(1);

	await resume(fixture);
	journal = await fixture.load();
	expect(journal.run.tasks[0]?.attempts.filter((item) => item.replacement).length).toBe(1);
	expect(fixture.effects.recoveryPanes).toBe(1);
}, 60_000);

it.sequential("registered quiet long-running command stays waiting-external through warning and receives exit grace before suspected-stall", async () => {
	const fixture = await makeFixture(externalProcess());
	await resume(fixture); // ticket-10 reconciliation first.
	let journal = await fixture.load();
	fixture.clock.setAfter(journal.run.tasks[0]!.attempts[0]!.recovery!.live.observedAt, 0);
	journal = await resume(fixture);
	let silence = journal.run.tasks[0]!.attempts[0]!.recovery?.silence;
	expect(silence?.phase).toBe("waiting-external");
	expect(journal.run.tasks[0]?.attention).toBe("waiting-external");
	expect(fixture.effects.nudge + fixture.effects.interrupt + fixture.effects.resume).toBe(0);
	const firstObservedAt = silence && "firstObservedAt" in silence ? silence.firstObservedAt : undefined;
	if (!firstObservedAt) throw new Error("external first-observed timestamp is missing");

	fixture.clock.setAfter(firstObservedAt, settings.externalCommandWarningThresholdSeconds * 1_000 - 1);
	await resume(fixture);
	journal = await fixture.load();
	expect(journal.run.tasks[0]?.attempts[0]?.recovery?.silence?.phase).toBe("waiting-external");
	expect(journal.run.tasks[0]?.attempts[0]?.recovery?.silence && "warnedAt" in journal.run.tasks[0]!.attempts[0]!.recovery!.silence! ? journal.run.tasks[0]!.attempts[0]!.recovery!.silence!.warnedAt : undefined).toBeUndefined();

	fixture.clock.setAfter(firstObservedAt, settings.externalCommandWarningThresholdSeconds * 1_000);
	await resume(fixture);
	journal = await fixture.load();
	silence = journal.run.tasks[0]!.attempts[0]!.recovery?.silence;
	expect(silence?.phase).toBe("waiting-external");
	expect("warnedAt" in silence! && silence.warnedAt).toBeTruthy();
	const warnedResume = fixture.lastResume();
	expect(warnedResume?.kind).toBe("reconciled");
	if (warnedResume?.kind === "reconciled") expect(warnedResume.result.notification).toBe(true);

	await resume(fixture);
	const repeatedWarningResume = fixture.lastResume();
	if (repeatedWarningResume?.kind === "reconciled") expect(repeatedWarningResume.result.notification).toBeUndefined();
	expect(fixture.effects.nudge + fixture.effects.interrupt + fixture.effects.resume).toBe(0);

	fixture.setProcess(noneProcess());
	journal = await resume(fixture);
	silence = journal.run.tasks[0]!.attempts[0]!.recovery?.silence;
	expect(silence?.phase).toBe("external-grace");
	expect(journal.run.tasks[0]?.attention).toBe("waiting-external");
	const exitedAt = silence && "exitedAt" in silence ? silence.exitedAt : undefined;
	if (!exitedAt) throw new Error("external exit timestamp is missing");

	fixture.clock.setAfter(exitedAt, settings.nudgeGracePeriodSeconds * 1_000 - 1);
	await resume(fixture);
	expect((await fixture.load()).run.tasks[0]?.attempts[0]?.recovery?.silence?.phase).toBe("external-grace");
	fixture.clock.setAfter(exitedAt, settings.nudgeGracePeriodSeconds * 1_000);
	journal = await resume(fixture);
	expect(journal.run.tasks[0]?.attention).toBe("suspected-stall");
	expect(journal.run.tasks[0]?.attempts[0]?.recovery?.silence?.phase).toBe("suspected");
	expect(fixture.effects.nudge + fixture.effects.interrupt + fixture.effects.resume).toBe(0);
}, 60_000);
