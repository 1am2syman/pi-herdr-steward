import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { createConfigStore } from "../src/config-store.ts";
import { createRunJournalAdapter } from "../src/adapters.ts";
import { registerStewardExtension, type StewardCommandContext, type StewardCommandHandler } from "../src/extension.ts";
import { createSteward, type ManagedAgentIdentity, type MonitorDigest, type ResumeResult, type StewardDependencies, type StewardHerdrAdapter } from "../src/steward.ts";
import type { ProjectModelPlans, RecoveryDefaults } from "../src/config.ts";
import type { RunDraft, RunJournal } from "../src/run.ts";

const roots: string[] = [];
const baseRevision = "0123456789abcdef0123456789abcdef01234567";
const modelPlans: ProjectModelPlans = {
	builder: {
		primary: { model: "provider/primary", thinkingLevel: "high" },
		fallbacks: [{ model: "provider/unavailable", thinkingLevel: "medium" }, { model: "other/fallback", thinkingLevel: "low" }],
	},
	reviewer: { primary: { model: "reviewer/primary", thinkingLevel: "medium" }, fallbacks: [] },
};
const settings: RecoveryDefaults = {
	passiveInspectionIntervalSeconds: 10,
	secondInspectionAndNudgeIntervalSeconds: 20,
	nudgeGracePeriodSeconds: 5,
	externalCommandWarningThresholdSeconds: 30,
	maximumActiveTasks: 1,
	transientRetryLimit: 2,
	reworkCycleLimit: 2,
};
type FunctionalTransientKind = "provider-network-interruption" | "agent-startup-failure" | "herdr-command-failure" | "unexpected-process-exit";

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function digest(label: string): MonitorDigest {
	return { kind: "observed", byteCount: label.length, sha256: `sha256:${createHash("sha256").update(label, "utf8").digest("hex")}` };
}

function draft(): RunDraft {
	return {
		declaredOutcome: "Recover transient Builder execution without losing work",
		tasks: [{ requiredOutcome: "Keep the exact managed change", allowedScope: ["src"], expectedArtifacts: [{ kind: "git-commit" }], verification: { kind: "command", command: "npm test" }, reviewRequired: false }],
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
		sessionManager: { getSessionId: () => "retry-controller" } as StewardCommandContext["sessionManager"],
		ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined, notify() {}, setStatus() {} },
	};
}

type Fixture = {
	root: string;
	command: StewardCommandHandler;
	deps: StewardDependencies;
	steward: ReturnType<typeof createSteward>;
	load(): Promise<RunJournal>;
	resume(): Promise<RunJournal>;
	setHerdrUnavailable(value: boolean): void;
	setHerdrMissing(value: boolean): void;
	setPreservationUnavailable(value: boolean): void;
	effects: { panes: number; starts: number; prompts: number; stops: number; models: string[] };
	order: string[];
};

async function makeFixture(options: { transientFailure: boolean; transientKind?: FunctionalTransientKind; singleTransientFailure?: boolean; noFallback?: boolean; preservationUnavailable?: boolean; stopFailure?: "throw" | "killed" | "wrong-identity"; stopAcknowledgementCasFailure?: boolean }): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-retry-functional-"));
	roots.push(root);
	const config = createConfigStore();
	await config.saveRecoveryDefaults(settings);
	await config.saveModelPlans(root, modelPlans);
	let nowMs = Date.parse("2026-09-19T00:00:00.000Z");
	let herdrUnavailable = false;
	let herdrMissing = false;
	let preservationUnavailable = options.preservationUnavailable ?? false;
	let failureArmed = options.transientFailure;
	const transientKind = options.transientKind ?? "provider-network-interruption";
	let paneNumber = 1;
	const started = new Set<string>();
	const missing = new Set<string>();
	const effects = { panes: 0, starts: 0, prompts: 0, stops: 0, models: [] as string[] };
	const order: string[] = [];
	const builderPath = join(root, "managed-worktree");
	const runJournal = createRunJournalAdapter();
	const reservedAttemptIds = new Set<string>();
	let stopAcknowledgementCasFailed = false;
	const inspectPreservation = runJournal.inspectAttemptPreservation;
	if (!inspectPreservation) throw new Error("preservation adapter missing");
	runJournal.inspectAttemptPreservation = async (input) => {
		order.push("preserve");
		return inspectPreservation(input);
	};
	const replaceActive = runJournal.replaceActive.bind(runJournal);
	runJournal.replaceActive = async (repositoryRoot, candidate) => {
		const latest = candidate.run.tasks[0]?.attempts.at(-1);
		if (options.stopAcknowledgementCasFailure && !stopAcknowledgementCasFailed && latest?.recovery?.infrastructure?.stop.phase === "acknowledged") {
			stopAcknowledgementCasFailed = true;
			throw new Error("fixture stop acknowledgement CAS failure");
		}
		if (latest?.replacement && latest.state === "prepared" && !reservedAttemptIds.has(latest.id)) {
			reservedAttemptIds.add(latest.id);
			order.push("reserve");
		}
		return replaceActive(repositoryRoot, candidate);
	};
	const clock = {
		now: () => new Date(nowMs),
		randomUUID: () => "01234567-89ab-cdef-0123-456789abcdef",
		wait: async () => undefined,
	};
	const identityFor = (name: string, workspaceId = "workspace-1", paneId = "pane-1", terminalId = "terminal-1"): ManagedAgentIdentity => ({ name, workspaceId, paneId, terminalId });
	const observed = (identity: ManagedAgentIdentity): Extract<Awaited<ReturnType<NonNullable<StewardHerdrAdapter["inspectManagedAgent"]>>>, { kind: "observed" }> => ({ kind: "observed", identity, lifecycle: "working", stateChangeSequence: 1 });
	const herdr: StewardHerdrAdapter = {
		async checkAvailability() { return { kind: "available", status: "running", running: true, compatible: true, endpointCompatible: true }; },
		async createBuilderWorktree(input) { await mkdir(builderPath, { recursive: true }); return { kind: "created", branch: input.branch, path: builderPath, workspaceId: "workspace-1", tabId: "tab-1", paneId: "pane-1", terminalId: "terminal-1" }; },
		async startBuilder(input) {
			if (transientKind === "agent-startup-failure" && failureArmed) {
				if (options.singleTransientFailure) failureArmed = false;
				missing.add(input.name);
				return { kind: "failed", stage: "agent-start", code: "agent-startup-failure", message: "typed startup failure" };
			}
			started.add(input.name);
			effects.models.push(input.model.model);
			return { kind: "started", name: input.name, agentKind: "pi", workspaceId: "workspace-1", tabId: "tab-1", paneId: "pane-1", terminalId: "terminal-1" };
		},
		async promptBuilder(input) {
			effects.prompts += 1;
			if (transientKind === "unexpected-process-exit" && failureArmed) {
				if (options.singleTransientFailure) failureArmed = false;
				missing.add(input.name);
				return { kind: "prompted", name: input.name, workspaceId: "workspace-1", tabId: "tab-1", paneId: "pane-1", terminalId: "terminal-1" };
			}
			if (failureArmed && (transientKind === "provider-network-interruption" || transientKind === "herdr-command-failure")) {
				if (options.singleTransientFailure) failureArmed = false;
				return { kind: "failed", stage: "agent-prompt", code: transientKind, message: `typed ${transientKind}` };
			}
			return { kind: "prompted", name: input.name, workspaceId: "workspace-1", tabId: "tab-1", paneId: "pane-1", terminalId: "terminal-1" };
		},
		async inspectManagedAgent(identity) {
			if (herdrUnavailable) return { kind: "unclear", availability: "unavailable", diagnostic: "server temporarily unavailable" };
			if (herdrMissing) return { kind: "missing", diagnostic: "exact intended identity is absent", code: "agent_not_found" as const };
			if (missing.has(identity.name) || !started.has(identity.name)) return { kind: "missing", diagnostic: "exact intended identity is absent", ...(missing.has(identity.name) ? { code: "agent_not_found" as const } : {}) };
			return observed(identity);
		},
		async readManagedTerminal() { return digest("terminal"); },
		async createRecoveryPane(input) {
			effects.panes += 1;
			paneNumber += 1;
			return { kind: "created", workspaceId: "workspace-1", tabId: `tab-${paneNumber}`, paneId: `pane-${paneNumber}`, terminalId: `terminal-${paneNumber}`, sourcePaneId: input.sourcePaneId, worktreePath: input.worktreePath };
		},
		async startReplacementAgent(input) {
			effects.starts += 1;
			started.add(input.name);
			effects.models.push(input.model.model);
			return { kind: "started", name: input.name, agentKind: "pi", workspaceId: "workspace-1", tabId: `tab-${paneNumber}`, paneId: `pane-${paneNumber}`, terminalId: `terminal-${paneNumber}` };
		},
		async promptReplacementAgent(input) {
			effects.prompts += 1;
			if (failureArmed && (transientKind === "provider-network-interruption" || transientKind === "herdr-command-failure")) {
				if (options.singleTransientFailure) failureArmed = false;
				return { kind: "failed", stage: "agent-prompt", code: transientKind, message: `typed ${transientKind}` };
			}
			return { kind: "prompted", name: input.identity.name, workspaceId: input.identity.workspaceId, tabId: `tab-${paneNumber}`, paneId: input.identity.paneId, terminalId: input.identity.terminalId };
		},
		async stopAgentGracefully(input) {
			effects.stops += 1;
			order.push("stop");
			if (options.stopFailure === "throw") throw new Error("typed graceful stop failure");
			if (options.stopFailure === "killed") return { kind: "failed", message: "graceful stop was killed" };
			if (options.stopFailure === "wrong-identity") return { kind: "acknowledged", name: `${input.name}-wrong`, workspaceId: input.workspaceId, tabId: "tab-1", paneId: input.paneId, terminalId: input.terminalId };
			order.push("stop-ack");
			return { kind: "acknowledged", name: input.name, workspaceId: input.workspaceId, tabId: "tab-1", paneId: input.paneId, terminalId: input.terminalId };
		},
	};
	const git: StewardDependencies["git"] = {
		async inspectIntegrationBase() { return { kind: "ready", branch: "main", revision: baseRevision }; },
		async branchExists() { return false; },
		async inspectBuilderWorktree(_path, expectedRevision) { return { kind: "ready", head: expectedRevision, clean: true }; },
		async inspectManagedWorktreeProgress() { return preservationUnavailable ? { kind: "unavailable", diagnostic: "fixture Git preservation is temporarily unavailable" } : { kind: "observed", head: baseRevision, worktree: digest("worktree"), git: { head: baseRevision, digest: digest("git") } }; },
	};
	const ui: StewardDependencies["ui"] = {
		presentStatus() {},
		async editConfiguration() { return { kind: "cancelled" }; },
		async draftRun() { return { kind: "drafted" as const, draft: draft() }; },
		async confirmRun() { return true; },
		presentConfigurationResult() {},
		presentStartResult() {},
		presentResumeResult() {},
	};
	const deps: StewardDependencies = {
		runJournal,
		herdr,
		git,
		process: {},
		model: {
			listModelChoices: () => [],
			async validateModelPlans() { return []; },
		async inspectModelChoice(choice) {
				const available = choice.model === modelPlans.builder.primary.model || (!options.noFallback && choice.model !== "provider/unavailable");
				return { choice: { ...choice }, available, diagnostics: available ? [] : [{ code: "unavailable-model", role: "builder", index: 1, reference: choice.model, message: "fixture unavailable" }] };
			},
		},
		clock,
		ui,
	};
	let command: StewardCommandHandler | undefined;
	registerStewardExtension({ on() {}, registerCommand(_name, options) { command = options.handler; } }, () => deps);
	if (!command) throw new Error("Steward command was not registered");
	await command("start", context(root));
	const load = async (): Promise<RunJournal> => {
		const result = await runJournal.loadActive(root);
		if (result.kind !== "loaded") throw new Error(`Active Journal unavailable: ${result.kind}`);
		return result.journal;
	};
	const steward = createSteward(deps);
	return {
		root,
		command,
		deps,
		steward,
		load,
		async resume() {
			await command!("resume", context(root));
			return load();
		},
		setHerdrUnavailable(value) { herdrUnavailable = value; },
		setHerdrMissing(value) { herdrMissing = value; },
		setPreservationUnavailable(value) { preservationUnavailable = value; },
		effects,
		order,
	};
}

it.sequential("registered transient recovery classifies infrastructure, retries same-model first, follows approved fallback, and stops at two links", async () => {
	const fixture = await makeFixture({ transientFailure: true });
	let journal = await fixture.load();
	let task = journal.run.tasks[0]!;
	const initial = task.attempts[0]!;
	const firstReplacement = task.attempts[1]!;
	expect(initial.recovery?.infrastructure?.kind).toBe("provider-network-interruption");
	expect(initial.recovery?.infrastructure?.stop.phase).toBe("acknowledged");
	expect(initial.state).toBe("superseded");
	expect(firstReplacement.replacement).toMatchObject({ kind: "transient-recovery", retryOrdinal: 1, modelSelection: { kind: "same-model-first", planIndex: 0 } });
	expect(firstReplacement.actualModel).toEqual(modelPlans.builder.primary);
	expect(fixture.effects.panes + fixture.effects.starts + fixture.effects.prompts).toBe(1);
	const preservedIndex = fixture.order.indexOf("preserve");
	const stopAcknowledgedIndex = fixture.order.indexOf("stop-ack");
	const reservationIndex = fixture.order.indexOf("reserve");
	expect(preservedIndex).toBeGreaterThanOrEqual(0);
	expect(stopAcknowledgedIndex).toBeGreaterThan(preservedIndex);
	expect(reservationIndex).toBeGreaterThan(stopAcknowledgedIndex);

	await fixture.resume(); // replacement pane
	await fixture.resume(); // replacement agent start
	await fixture.resume(); // Assignment and prompt intent
	journal = await fixture.resume(); // typed failure on replacement 1 reserves replacement 2
	task = journal.run.tasks[0]!;
	const secondReplacement = task.attempts[2]!;
	expect(secondReplacement.replacement).toMatchObject({ kind: "transient-recovery", retryOrdinal: 2, modelSelection: { kind: "approved-fallback", planIndex: 2, reason: "same-model-retry-failed" } });
	expect(secondReplacement.actualModel).toEqual(modelPlans.builder.fallbacks[1]);
	expect(task.attempts[1]?.recovery?.infrastructure?.kind).toBe("provider-network-interruption");
	expect(task.attempts[1]?.state).toBe("superseded");

	await fixture.resume();
	await fixture.resume();
	await fixture.resume();
	journal = await fixture.resume(); // final transient failure, no third successor
	task = journal.run.tasks[0]!;
	expect(task.attention).toBe("needs-user");
	expect(task.attentionReason).toBe("transient-retries-exhausted");
	expect(task.attempts).toHaveLength(3);
	expect(task.attempts.filter((attempt) => attempt.replacement).map((attempt) => attempt.replacement?.retryOrdinal)).toEqual([1, 2]);
	expect(task.attempts.at(-1)?.state).toBe("ended-error");
	expect(task.attempts.at(-1)?.recovery?.infrastructure?.kind).toBe("provider-network-interruption");
	expect(fixture.effects.panes).toBe(2);
	expect(fixture.effects.starts).toBe(2);
	expect(fixture.effects.prompts).toBe(3);
	expect(fixture.effects.models).toEqual(["provider/primary", "provider/primary", "other/fallback"]);
	expect(fixture.effects.stops).toBe(3);
	for (const attempt of task.attempts) {
		expect(existsSync(attempt.assignmentPath)).toBe(true);
		expect(existsSync(attempt.evidenceDirectory)).toBe(true);
	}
	const effectCounts = { ...fixture.effects };
	await fixture.resume();
	expect(fixture.effects).toEqual(effectCounts);
});

it.sequential.each(["provider-network-interruption", "agent-startup-failure", "herdr-command-failure", "unexpected-process-exit"] as const)("registered controller flow retains the %s infrastructure kind before reserving one successor", async (transientKind) => {
	const fixture = await makeFixture({ transientFailure: true, transientKind, singleTransientFailure: true });
	let journal = await fixture.load();
	for (let pass = 0; pass < 6; pass += 1) journal = await fixture.resume();
	const task = journal.run.tasks[0]!;
	expect(task.attempts[0]?.recovery?.infrastructure?.kind).toBe(transientKind);
	expect(task.attempts.filter((attempt) => attempt.replacement).length).toBe(1);
	expect(task.attempts[1]?.actualModel).toEqual(modelPlans.builder.primary);
	expect(task.attempts[0]?.state).toBe("superseded");
});

it.sequential("registered no approved fallback pauses without mutating the active model or reserving a third Attempt", async () => {
	const fixture = await makeFixture({ transientFailure: true, noFallback: true });
	let journal = await fixture.load();
	await fixture.resume();
	await fixture.resume();
	await fixture.resume();
	journal = await fixture.resume();
	const task = journal.run.tasks[0]!;
	expect(task.attention).toBe("needs-user");
	expect(task.attentionReason).toBe("transient-fallback-unavailable");
	expect(task.attempts).toHaveLength(2);
	expect(task.attempts[1]?.actualModel).toEqual(modelPlans.builder.primary);
	expect(fixture.effects.panes).toBe(1);
	expect(fixture.effects.starts).toBe(1);
});

it.sequential("registered unavailable preservation stays retryable and resumes before stop or reservation", async () => {
	const fixture = await makeFixture({ transientFailure: true, singleTransientFailure: true, preservationUnavailable: true });
	let journal = await fixture.load();
	let task = journal.run.tasks[0]!;
	const degradedAttempt = task.attempts[0]!;
	expect(task.attention).toBe("recovering");
	expect(task.attentionReason).toBe("transient-infrastructure-recovery");
	expect(degradedAttempt.state).toBe("ended-error");
	expect(degradedAttempt.recovery?.infrastructure?.stop).toEqual({ phase: "not-required", reason: "preservation-unavailable" });
	expect(degradedAttempt.recovery?.preservation?.git.head).toBeNull();
	expect(fixture.effects.panes + fixture.effects.starts + fixture.effects.stops).toBe(0);
	expect(task.attempts.filter((attempt) => attempt.replacement)).toHaveLength(0);

	fixture.setPreservationUnavailable(false);
	journal = await fixture.resume();
	task = journal.run.tasks[0]!;
	expect(task.attempts.filter((attempt) => attempt.replacement)).toHaveLength(1);
	expect(task.attempts[0]?.recovery?.infrastructure?.stop.phase).toBe("acknowledged");
	expect(fixture.effects.stops).toBe(1);
	expect(fixture.effects.panes).toBe(0);
	await fixture.resume();
	expect(fixture.effects.panes).toBe(1);
});

it.sequential.each(["throw", "killed", "wrong-identity"] as const)("registered %s graceful-stop ambiguity pauses the controller without a successor or resend", async (stopFailure) => {
	const fixture = await makeFixture({ transientFailure: true, stopFailure });
	let journal = await fixture.load();
	let task = journal.run.tasks[0]!;
	const beforeResume = { panes: fixture.effects.panes, starts: fixture.effects.starts, prompts: fixture.effects.prompts, stops: fixture.effects.stops, models: [...fixture.effects.models] };
	expect(task.attention).toBe("needs-user");
	expect(task.attentionReason).toBe("transient-stop-ambiguous");
	expect(task.attempts).toHaveLength(1);
	expect(task.attempts[0]?.recovery?.infrastructure?.stop.phase).toBe("ambiguous");
	expect(task.attempts[0]?.state).toBe("ended-error");

	journal = await fixture.resume();
	task = journal.run.tasks[0]!;
	expect(task.attempts).toHaveLength(1);
	expect(task.attempts.filter((attempt) => attempt.replacement)).toHaveLength(0);
	expect(fixture.effects).toEqual(beforeResume);
});

it.sequential("registered stop-acknowledgement CAS loss retains intent, then records ambiguity without a successor", async () => {
	const fixture = await makeFixture({ transientFailure: true, stopAcknowledgementCasFailure: true });
	let journal = await fixture.load();
	let task = journal.run.tasks[0]!;
	expect(task.attention).toBe("recovering");
	expect(task.attempts[0]?.recovery?.infrastructure?.stop.phase).toBe("intended");
	expect(task.attempts).toHaveLength(1);
	expect(fixture.effects.stops).toBe(1);

	journal = await fixture.resume();
	task = journal.run.tasks[0]!;
	expect(task.attention).toBe("needs-user");
	expect(task.attentionReason).toBe("transient-stop-ambiguous");
	expect(task.attempts[0]?.recovery?.infrastructure?.stop.phase).toBe("ambiguous");
	expect(task.attempts.filter((attempt) => attempt.replacement)).toHaveLength(0);
	const effects = { ...fixture.effects, models: [...fixture.effects.models] };
	await fixture.resume();
	expect(fixture.effects).toEqual(effects);
});

it.sequential("registered Herdr observation loss degrades monitoring and resumes exact reconciliation without a retry", async () => {
	const fixture = await makeFixture({ transientFailure: false });
	let journal = await fixture.load();
	const before = journal.run.tasks[0]!;
	fixture.setHerdrUnavailable(true);
	const degraded = await fixture.steward.observeMonitorProgress(fixture.root, "retry-controller", "manual");
	expect(degraded.condition).toBe("degraded");
	journal = await fixture.load();
	expect(journal.run.tasks[0]?.attempts).toHaveLength(1);
	expect(journal.run.tasks[0]?.attempts[0]?.id).toBe(before.attempts[0]?.id);
	expect(journal.run.tasks[0]?.attention).toBe("none");
	fixture.setHerdrUnavailable(false);
	const restored = await fixture.steward.observeMonitorProgress(fixture.root, "retry-controller", "manual");
	expect(restored.condition).toBe("ordinary");
	journal = await fixture.resume();
	expect(journal.run.tasks[0]?.attempts).toHaveLength(1);
	expect(fixture.effects.panes + fixture.effects.starts + fixture.effects.prompts).toBe(1);
});

it.sequential("registered correctness evidence wins over exact agent absence and consumes no transient budget", async () => {
	const fixture = await makeFixture({ transientFailure: false });
	let journal = await fixture.load();
	const attempt = journal.run.tasks[0]!.attempts[0]!;
	await writeFile(attempt.reportPath, "not a canonical Attempt Report\n", "utf8");
	fixture.setHerdrMissing(true);
	await fixture.resume(); // persist the malformed-report rejection first.
	await rm(attempt.reportPath, { force: true });
	journal = await fixture.resume(); // exact absence is now lower priority than the retained correctness fact.
	const task = journal.run.tasks[0]!;
	expect(task.attempts.filter((candidate) => candidate.replacement).length).toBe(0);
	expect(task.attempts[0]?.recovery?.infrastructure).toBeUndefined();
	expect(task.attempts[0]?.evidence?.phase).toBe("rejected");
	expect(task.attentionReason).toBe("reconciliation-agent-missing");
	expect(fixture.effects.panes + fixture.effects.starts + fixture.effects.prompts).toBe(1);
});
