import { existsSync } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { afterEach, it, vi } from "vitest";

import { createRunJournalStore } from "../src/run-journal-store.ts";
import { createAttemptEvidenceStore, sha256Bytes } from "../src/attempt-evidence-store.ts";
import { resolveAssignmentPaths } from "../src/assignment-store.ts";
import { buildInitialRunJournal, COMPLETION_GATE_PREDICATES, deserializeRunJournal, serializeRunJournal, serializeRunJournalAtPath, validateRunJournal, type BuilderAttemptRecord, type ReviewerAttemptRecord, type ReviewWorktreeSnapshot, type RunJournal } from "../src/run.ts";
import type { ReviewSubject } from "../src/review.ts";
import { type ProjectModelPlans, type RecoveryDefaults } from "../src/config.ts";
import type { BuilderAssignmentDocument } from "../src/run.ts";

const roots: string[] = [];
vi.setConfig({ testTimeout: 60_000 });
const plans: ProjectModelPlans = {
	builder: { primary: { model: "builder/primary", thinkingLevel: "high" }, fallbacks: [] },
	reviewer: { primary: { model: "reviewer/primary", thinkingLevel: "medium" }, fallbacks: [] },
};
const settings: RecoveryDefaults = {
	passiveInspectionIntervalSeconds: 301,
	secondInspectionAndNudgeIntervalSeconds: 302,
	nudgeGracePeriodSeconds: 121,
	externalCommandWarningThresholdSeconds: 1801,
	maximumActiveTasks: 1,
	transientRetryLimit: 1,
	reworkCycleLimit: 4,
};

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function journal(runId: string, revision = 1, updatedAt = "2026-09-17T18:00:00.000Z"): RunJournal {
	const created = buildInitialRunJournal({
		identity: { runId, createdAt: "2026-09-17T18:00:00.000Z" },
		controllerSessionId: "storage-session",
		draft: {
			declaredOutcome: "Persist the requested outcome",
			tasks: [{ requiredOutcome: "Keep an evidence record", allowedScope: ["reports/result.md"], expectedArtifacts: [{ kind: "evidence", description: "A deterministic report" }], verification: { kind: "command", command: "npm test" }, reviewRequired: true }],
			modelPlan: plans,
			effectiveSettings: settings,
			finalVerification: { kind: "command", command: "npm test" },
		},
		modelPlan: plans,
		effectiveSettings: settings,
		integrationBase: { kind: "none" },
	});
	return { ...created, journalRevision: revision, run: { ...created.run, updatedAt } };
}

function maxHistoryJournal(): RunJournal {
	const maxSettings = { ...settings, reworkCycleLimit: 5 };
	const base = buildInitialRunJournal({
		identity: { runId: "run-20260917T180000000Z-maxhistory", createdAt: "2026-09-17T18:00:00.000Z" },
		controllerSessionId: "storage-session",
		draft: {
			declaredOutcome: "Persist a maximum Review history",
			tasks: [{ requiredOutcome: "Keep the code change reviewable", allowedScope: ["src/change.ts"], expectedArtifacts: [{ kind: "git-commit" }], verification: { kind: "command", command: "npm test" }, reviewRequired: true }],
			modelPlan: plans,
			effectiveSettings: maxSettings,
			finalVerification: { kind: "command", command: "npm test" },
		},
		modelPlan: plans,
		effectiveSettings: maxSettings,
		integrationBase: { kind: "git", branch: "main", revision: "0".repeat(40) },
	});
	const task = base.run.tasks[0]!;
	const timestamp = "2026-09-17T18:00:00.000Z";
	const sha = (prefix: string, index: number) => `sha256:${prefix.repeat(63)}${index.toString(16)}`;
	const revision = (index: number) => index.toString(16).padStart(40, "0");
	const snapshot = (index: number): ReviewWorktreeSnapshot => ({ head: revision(index), dirtyStateFingerprint: sha("c", index), dirtyPaths: [], operationMarkers: [] });
	const builderPaths = (attempt: number) => ({ assignmentPath: `/tmp/max-history/attempt-${String(attempt).padStart(2, "0")}/assignment.json`, reportPath: `/tmp/max-history/attempt-${String(attempt).padStart(2, "0")}/report.md`, evidenceDirectory: `/tmp/max-history/attempt-${String(attempt).padStart(2, "0")}/evidence` });
	const attempts: Array<BuilderAttemptRecord | ReviewerAttemptRecord> = [];
	const builderIdentity = { branch: "steward/run/task/attempt-01", agentName: "steward-b-abcdef12-01-01", worktreePath: "/tmp/max-history/builder", workspaceId: "workspace-1", paneId: "builder-pane", terminalId: "builder-terminal" };
	for (let cycle = 0; cycle <= 5; cycle += 1) {
		const builderNumber = cycle * 2 + 1;
		const builderPath = builderPaths(builderNumber);
		const builderManifest = sha("a", builderNumber);
		const builder: BuilderAttemptRecord = {
			id: `attempt-${String(builderNumber).padStart(2, "0")}`, role: "builder", state: "reported", preparedAt: timestamp, activatedAt: timestamp, actualModel: { ...plans.builder.primary }, specificationHash: task.specificationHash, baseRevision: "0".repeat(40), ...builderPath,
			dispatch: cycle === 0 ? { phase: "prompted", ...builderIdentity, assignmentSha256: sha("d", builderNumber), promptedAt: timestamp } : { phase: "prompted", ...builderIdentity, cycle, priorBuilderAttemptId: `attempt-${String(builderNumber - 2).padStart(2, "0")}`, priorReviewerAttemptId: `attempt-${String(builderNumber - 1).padStart(2, "0")}`, reviewedSubject: (attempts[attempts.length - 1] as ReviewerAttemptRecord).subject, reviewerManifestPath: `/tmp/max-history/attempt-${String(builderNumber - 1).padStart(2, "0")}/finalized/manifest.json`, reviewerManifestSha256: (attempts[attempts.length - 1] as ReviewerAttemptRecord).evidence!.phase === "finalized" ? (attempts[attempts.length - 1] as ReviewerAttemptRecord).evidence!.manifestSha256 : sha("b", builderNumber - 1), findings: [{ id: `finding-${cycle}`, severity: "major", summary: "Fix the protected finding.", detail: "Fix the protected finding before the next Review." }], assignmentSha256: sha("d", builderNumber), promptedAt: timestamp },
			evidence: { phase: "finalized", finalizedAt: timestamp, status: "completed", reportSha256: sha("e", builderNumber), manifestPath: `/tmp/max-history/attempt-${String(builderNumber).padStart(2, "0")}/finalized/manifest.json`, manifestSha256: builderManifest, producedRevision: revision(builderNumber) },
		};
		attempts.push(builder);
		const reviewerNumber = builderNumber + 1;
		const subject: ReviewSubject = { kind: "git", baseRevision: "0".repeat(40), headRevision: revision(builderNumber), commits: ["1".repeat(40), revision(builderNumber)], builderManifestSha256: builderManifest };
		const reviewerPath = builderPaths(reviewerNumber);
		const reviewer: ReviewerAttemptRecord = {
			id: `attempt-${String(reviewerNumber).padStart(2, "0")}`, role: "reviewer", state: "reported", preparedAt: timestamp, activatedAt: timestamp, actualModel: { ...plans.reviewer.primary }, specificationHash: task.specificationHash, ...reviewerPath, subject, independence: { kind: "different-provider-family", builderProvider: "builder", reviewerProvider: "reviewer" }, worktree: { path: "/tmp/max-history/builder", baseline: snapshot(builderNumber) }, dispatch: { phase: "prompted", agentName: `steward-r-abcdef12-01-${String(reviewerNumber).padStart(2, "0")}`, worktreePath: "/tmp/max-history/builder", workspaceId: "workspace-1", paneId: `reviewer-pane-${reviewerNumber}`, terminalId: `reviewer-terminal-${reviewerNumber}`, assignmentSha256: sha("f", reviewerNumber), promptedAt: timestamp } as ReviewerAttemptRecord["dispatch"], integrity: { kind: "preserved", after: snapshot(builderNumber) }, evidence: { phase: "finalized", finalizedAt: timestamp, verdict: cycle === 5 ? "approved" : "changes-required", reportSha256: sha("b", reviewerNumber), manifestPath: `/tmp/max-history/attempt-${String(reviewerNumber).padStart(2, "0")}/finalized/manifest.json`, manifestSha256: sha("b", reviewerNumber), subject },
		};
		attempts.push(reviewer);
	}
	const finalBuilder = attempts[10] as BuilderAttemptRecord;
	const finalReviewer = attempts[11] as ReviewerAttemptRecord;
	const finalSubject = finalReviewer.subject;
	const finalEvidence = finalReviewer.evidence;
	if (!finalEvidence || finalEvidence.phase !== "finalized") throw new Error("fixture final Reviewer evidence missing");
	const result: RunJournal = { ...base, journalRevision: 2, run: { ...base.run, updatedAt: "2026-09-17T18:12:00.000Z", tasks: [{ ...task, phase: "approved", attention: "none", attempts, reworkCycles: 5, approval: { phase: "valid", approvedAt: timestamp, builderAttemptId: finalBuilder.id, reviewerAttemptId: finalReviewer.id, subject: finalSubject, reviewerManifestPath: finalEvidence.manifestPath, reviewerManifestSha256: finalEvidence.manifestSha256, worktreeSnapshot: snapshot(11), verdict: "approved" } }] } };
	const validated = validateRunJournal(result);
	if (!validated.value) throw new Error(validated.diagnostics.map((item) => item.message).join("; "));
	return validated.value;
}

function completedHistoryJournal(): RunJournal {
	const raw = JSON.parse(JSON.stringify(maxHistoryJournal())) as Record<string, unknown>;
	const run = raw.run as Record<string, unknown>;
	const tasks = run.tasks as Array<Record<string, unknown>>;
	const task = tasks[0]!;
	const attempts = task.attempts as Array<Record<string, unknown>>;
	const builder = attempts[10]!;
	const reviewer = attempts[11]!;
	const builderEvidence = builder.evidence as Record<string, unknown>;
	const reviewerEvidence = reviewer.evidence as Record<string, unknown>;
	const subject = reviewerEvidence.subject as Record<string, unknown>;
	const head = String(subject.headRevision);
	const commits = [...(subject.commits as string[])];
	const builderManifest = String(builderEvidence.manifestSha256);
	const reviewerManifest = String(reviewerEvidence.manifestSha256);
	const checkout = { branch: "main", head, dirtyPaths: [], operationMarkers: [], rangeExact: true };
	const completionRoot = "/tmp/max-history";
	const runId = String(run.id);
	const verificationRoot = `${completionRoot}/runs/${runId}/completion/final-verification/verification-01`;
	const verification = {
		phase: "passed",
		id: "verification-01",
		command: "npm test",
		cwd: `${completionRoot}/repository`,
		logPath: `${verificationRoot}/output.log`,
		resultPath: `${verificationRoot}/result.json`,
		intendedAt: "2026-09-17T18:06:00.000Z",
		startedAt: "2026-09-17T18:06:01.000Z",
		completedAt: "2026-09-17T18:06:02.000Z",
		exitCode: 0,
		killed: false,
		logSha256: `sha256:${"d".repeat(64)}`,
		resultSha256: `sha256:${"e".repeat(64)}`,
		checkout,
	};
	task.phase = "completed";
	task.attention = "none";
	task.integration = {
		phase: "integrated",
		targetBranch: "main",
		targetRevision: "0".repeat(40),
		approvedBaseRevision: "0".repeat(40),
		approvedHeadRevision: head,
		approvedCommits: commits,
		builderAttemptId: String(builder.id),
		reviewerAttemptId: String(reviewer.id),
		builderManifestSha256: builderManifest,
		reviewerManifestSha256: reviewerManifest,
		action: { kind: "fast-forward", argv: ["merge", "--ff-only", "--no-edit", head] },
		intendedAt: "2026-09-17T18:05:00.000Z",
		integratedAt: "2026-09-17T18:05:01.000Z",
		observedHead: head,
	};
	run.finalVerificationExecution = verification;
	const reports = attempts.map((attempt) => {
		const evidence = attempt.evidence as Record<string, unknown>;
		return {
			taskId: String(task.contract && (task.contract as Record<string, unknown>).id),
			attemptId: String(attempt.id),
			role: String(attempt.role),
			sourcePath: String(attempt.reportPath),
			destinationPath: `reports/task-01/${String(attempt.id)}-${String(attempt.role)}.md`,
			size: 1,
			sha256: String(evidence.reportSha256),
		};
	});
	const prompted = new Set<string>();
	const resources: Array<Record<string, unknown>> = [];
	for (const attempt of attempts) {
		const dispatch = attempt.dispatch as Record<string, unknown>;
		const identity = `${String(attempt.role)}/${String(dispatch.agentName)}/${String(dispatch.workspaceId)}/${String(dispatch.paneId)}/${String(dispatch.terminalId)}`;
		if (prompted.has(identity)) continue;
		prompted.add(identity);
		const intendedAt = "2026-09-17T18:08:00.000Z";
		resources.push({
			role: attempt.role,
			agentName: dispatch.agentName,
			workspaceId: dispatch.workspaceId,
			paneId: dispatch.paneId,
			terminalId: dispatch.terminalId,
			state: "acknowledged",
			intendedAt,
			acknowledgedAt: "2026-09-17T18:09:00.000Z",
			acknowledgement: { name: dispatch.agentName, workspaceId: dispatch.workspaceId, tabId: `tab-${String(resources.length + 1)}`, paneId: dispatch.paneId, terminalId: dispatch.terminalId },
		});
	}
	const gate = {
		evaluatedAt: "2026-09-17T18:07:00.000Z",
		taskId: "task-01",
		integratedHead: head,
		verificationResultSha256: verification.resultSha256,
		verificationLogSha256: verification.logSha256,
		checkout,
		predicates: [...COMPLETION_GATE_PREDICATES],
	};
	run.status = "completed";
	run.updatedAt = "2026-09-17T18:12:00.000Z";
	run.completion = {
		phase: "archived",
		gate,
		resources,
		archive: {
			intendedAt: "2026-09-17T18:10:00.000Z",
			archiveDirectory: `${completionRoot}/archive`,
			runPath: `${completionRoot}/archive/run.json`,
			previousRunPath: `${completionRoot}/archive/previous-run.json`,
			manifestPath: `${completionRoot}/archive/manifest.json`,
			activeJournalSha256: `sha256:${"f".repeat(64)}`,
			previousJournalSha256: `sha256:${"0".repeat(64)}`,
			verification: { logPath: verification.logPath, resultPath: verification.resultPath, logSha256: verification.logSha256, resultSha256: verification.resultSha256 },
			reports,
		},
		archivedAt: "2026-09-17T18:12:00.000Z",
	};
	raw.journalRevision = 4;
	const validated = validateRunJournal(raw, `${completionRoot}/archive/run.json`);
	if (!validated.value) throw new Error(validated.diagnostics.map((item) => item.message).join("; "));
	return validated.value;
}

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-steward-storage-"));
	roots.push(root);
	return root;
}

async function listTemporaryFiles(directory: string): Promise<string[]> {
	return (await readdir(directory)).filter((name) => name.endsWith(".tmp"));
}

it.sequential("creates an exact protected journal and reloads it", async () => {
	const root = await makeRoot();
	const store = createRunJournalStore();
	const input = journal("run-20260917T180000000Z-storagea");
	const result = await store.createActive(root, input);
	equal(result.kind, "created");
	if (result.kind !== "created") return;
	const bytes = await readFile(result.paths.activePath, "utf8");
	equal(bytes, serializeRunJournal(input));
	ok(!existsSync(result.paths.previousPath));
	equal(await readFile(join(result.paths.stewardDirectory, ".gitignore"), "utf8"), "*\n");
	equal((await stat(result.paths.stewardDirectory)).mode & 0o777, 0o700);
	equal((await stat(result.paths.activePath)).mode & 0o777, 0o600);
	deepStrictEqual((await store.loadActive(root)).kind, "loaded");
	deepStrictEqual(await listTemporaryFiles(result.paths.stewardDirectory), []);
});

it.sequential("two initial creates race without clobbering either complete input", async () => {
	const root = await makeRoot();
	const store = createRunJournalStore();
	const first = journal("run-20260917T180000000Z-raceone");
	const second = journal("run-20260917T180000000Z-racetwo");
	const results = await Promise.all([store.createActive(root, first), store.createActive(root, second)]);
	equal(results.filter((result) => result.kind === "created").length, 1);
	equal(results.filter((result) => result.kind === "active-exists").length, 1);
	const paths = store.resolvePaths(root);
	const active = await readFile(paths.activePath, "utf8");
	ok(active === serializeRunJournal(first) || active === serializeRunJournal(second));
	ok(!existsSync(paths.previousPath));
	deepStrictEqual(await listTemporaryFiles(paths.stewardDirectory), []);
});

it.sequential("replacement preserves the immediate previous valid snapshot", async () => {
	const root = await makeRoot();
	const store = createRunJournalStore();
	const a = journal("run-20260917T180000000Z-replacea");
	await store.createActive(root, a);
	const paths = store.resolvePaths(root);
	const b = journal(a.run.id, 2, "2026-09-17T18:01:00.000Z");
	const replacedB = await store.replaceActive(root, b);
	equal(replacedB.kind, "replaced");
	equal(await readFile(paths.activePath, "utf8"), serializeRunJournal(b));
	equal(await readFile(paths.previousPath, "utf8"), serializeRunJournal(a));
	const c = journal(a.run.id, 3, "2026-09-17T18:02:00.000Z");
	await store.replaceActive(root, c);
	equal(await readFile(paths.activePath, "utf8"), serializeRunJournal(c));
	equal(await readFile(paths.previousPath, "utf8"), serializeRunJournal(b));
	ok(!existsSync(join(paths.activityRoot, a.run.id, "activity.log")));
});

it.sequential("rejects malformed and invalid candidates without changing snapshots", async () => {
	const root = await makeRoot();
	const store = createRunJournalStore();
	const a = journal("run-20260917T180000000Z-invalids");
	await store.createActive(root, a);
	const paths = store.resolvePaths(root);
	const beforeActive = await readFile(paths.activePath, "utf8");
	const candidates: unknown[] = [
		{ schemaVersion: 1 },
		{ ...journal(a.run.id, 2), run: { ...journal(a.run.id, 2).run, tasks: [{ ...journal(a.run.id, 2).run.tasks[0], specificationHash: "sha256:" + "0".repeat(64) }] } },
		journal("run-20260917T180000000Z-other", 2),
		journal(a.run.id, 4),
	];
	for (const candidate of candidates) {
		const result = await store.replaceActive(root, candidate as unknown as RunJournal);
		ok(result.kind === "invalid-candidate" || result.kind === "storage-error");
		equal(await readFile(paths.activePath, "utf8"), beforeActive);
	}
	await writeFile(paths.activePath, "{\"schemaVersion\":1}\n");
	const invalidCurrent = await store.replaceActive(root, journal(a.run.id, 2));
	equal(invalidCurrent.kind, "invalid-current");
	equal(await readFile(paths.activePath, "utf8"), "{\"schemaVersion\":1}\n");
});

it.sequential("round-trips the valid 12-Attempt history and rejects impossible mutations without clobbering", async () => {
	const root = await makeRoot();
	const store = createRunJournalStore();
	const maximum = maxHistoryJournal();
	const initial = { ...maximum, journalRevision: 1, run: { ...maximum.run, updatedAt: maximum.run.createdAt, tasks: maximum.run.tasks.map(({ approval: _approval, ...task }) => ({ ...task, phase: "pending" as const, attention: "none" as const, attempts: [], reworkCycles: 0 })) } };
	const created = await store.createActive(root, initial);
	if (created.kind !== "created") throw new Error(`maximum journal seed failed: ${JSON.stringify(created)}`);
	const replaced = await store.replaceActive(root, maximum);
	if (replaced.kind !== "replaced") throw new Error(`maximum journal replace failed: ${JSON.stringify(replaced)}`);
	const paths = store.resolvePaths(root);
	const bytes = await readFile(paths.activePath, "utf8");
	equal(bytes, serializeRunJournal(maximum));
	const decoded = deserializeRunJournal(bytes, paths.activePath);
	ok(decoded.value);
	deepStrictEqual(decoded.value, maximum);
	const mutations: Array<[string, (candidate: Record<string, unknown>) => void]> = [
		["gap", (candidate) => { const attempts = ((candidate.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!.attempts as Array<Record<string, unknown>>; attempts[3]!.id = "attempt-99"; }],
		["role-order", (candidate) => { const attempts = ((candidate.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!.attempts as Array<Record<string, unknown>>; attempts[1]!.role = "builder"; }],
		["counter", (candidate) => { (((candidate.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!).reworkCycles = 4; }],
		["cycle-limit", (candidate) => { const attempts = ((candidate.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!.attempts as Array<Record<string, unknown>>; (attempts[2]!.dispatch as Record<string, unknown>).cycle = 6; }],
		["backlink", (candidate) => { const attempts = ((candidate.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!.attempts as Array<Record<string, unknown>>; (attempts[2]!.dispatch as Record<string, unknown>).priorReviewerAttemptId = "attempt-12"; }],
		["approval-subject", (candidate) => { const task = ((candidate.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!; ((task.approval as Record<string, unknown>).subject as Record<string, unknown>).builderManifestSha256 = `sha256:${"f".repeat(64)}`; }],
		["later-attempt", (candidate) => { const task = ((candidate.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!; const attempts = task.attempts as Array<Record<string, unknown>>; attempts.push({ ...attempts[0], id: "attempt-13" }); }],
		["phase", (candidate) => { (((candidate.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!).phase = "reworking"; }],
		["repair", (candidate) => { const attempts = ((candidate.run as Record<string, unknown>).tasks as Array<Record<string, unknown>>)[0]!.attempts as Array<Record<string, unknown>>; attempts[11]!.reportRepair = { phase: "requested" }; }],
	];
	for (const [name, mutate] of mutations) {
		const candidate = JSON.parse(bytes) as Record<string, unknown>;
		candidate.journalRevision = 3;
		mutate(candidate);
		const result = await store.replaceActive(root, candidate as unknown as RunJournal);
		ok(result.kind === "invalid-candidate" || result.kind === "storage-error", `${name} mutation was accepted`);
		equal(await readFile(paths.activePath, "utf8"), bytes, `${name} mutation clobbered the active journal`);
	}
});

it.sequential("rejects completed bytes at the active path while accepting the immutable archive snapshot", async () => {
	const root = await makeRoot();
	const store = createRunJournalStore();
	const initial = journal("run-20260917T180000000Z-completed-active");
	const created = await store.createActive(root, initial);
	if (created.kind !== "created") throw new Error("active seed was not created");
	const paths = store.resolvePaths(root);
	const completed = completedHistoryJournal();
	const archivePath = join(root, "archive", "run.json");
	const archiveBytes = Buffer.from(serializeRunJournalAtPath(completed, archivePath));
	const archiveDecoded = deserializeRunJournal(archiveBytes.toString("utf8"), archivePath);
	ok(archiveDecoded.value, "completed archive snapshot must remain valid at run.json");
	const before = await readFile(paths.activePath);
	const replacement = await store.replaceActive(root, completed);
	equal(replacement.kind, "invalid-candidate");
	deepStrictEqual(await readFile(paths.activePath), before);
	const createAgain = await store.createActive(root, completed);
	equal(createAgain.kind, "storage-error");
	deepStrictEqual(await readFile(paths.activePath), before);
	await writeFile(paths.activePath, archiveBytes);
	const direct = deserializeRunJournal(archiveBytes.toString("utf8"), paths.activePath);
	ok(!direct.value);
	match(direct.diagnostics.map((item) => item.message).join("; "), /active-run/);
	const loaded = await store.loadActive(root);
	equal(loaded.kind, "invalid");
	deepStrictEqual(await readFile(paths.activePath), archiveBytes);
	const rejectedCurrent = await store.replaceActive(root, initial);
	equal(rejectedCurrent.kind, "invalid-current");
	deepStrictEqual(await readFile(paths.activePath), archiveBytes);
	const invalidArchiveCases: Array<[string, (candidate: Record<string, unknown>) => void]> = [
		["altered command", (candidate) => { (candidate.run as Record<string, unknown>).finalVerification = { kind: "command", command: "npm run altered" }; }],
		["second verification id", (candidate) => { ((candidate.run as Record<string, unknown>).finalVerificationExecution as Record<string, unknown>).id = "verification-02"; }],
		["gate predicate mutation", (candidate) => { (((candidate.run as Record<string, unknown>).completion as Record<string, unknown>).gate as Record<string, unknown>).predicates = [...COMPLETION_GATE_PREDICATES].reverse(); }],
	];
	for (const [name, mutate] of invalidArchiveCases) {
		const candidate = JSON.parse(archiveBytes.toString("utf8")) as Record<string, unknown>;
		mutate(candidate);
		ok(!deserializeRunJournal(JSON.stringify(candidate), archivePath).value, `${name} unexpectedly decoded as an archive`);
		const result = await store.replaceActive(root, candidate as unknown as RunJournal);
		equal(result.kind, "invalid-candidate", `${name} replacement was accepted`);
		deepStrictEqual(await readFile(paths.activePath), archiveBytes, `${name} clobbered active bytes`);
	}
});

it.sequential("atomic reads observe only complete old or new snapshots", async () => {
	const root = await makeRoot();
	const store = createRunJournalStore();
	const a = journal("run-20260917T180000000Z-sampled");
	a.run.declaredOutcome = "A".repeat(50_000);
	await store.createActive(root, a);
	const paths = store.resolvePaths(root);
	const b = { ...a, journalRevision: 2, run: { ...a.run, updatedAt: "2026-09-17T18:01:00.000Z", declaredOutcome: "B".repeat(50_000) } };
	const versions = [2, 3, 4, 5, 6].map((revision) => ({ ...a, journalRevision: revision, run: { ...a.run, updatedAt: `2026-09-17T18:0${revision - 1}:00.000Z`, declaredOutcome: String.fromCharCode(64 + revision).repeat(50_000) } }));
	const expected = new Set([serializeRunJournal(a), ...versions.map(serializeRunJournal)]);
	const reads: Promise<void>[] = [];
	for (let index = 0; index < 50; index += 1) {
		reads.push((async () => {
			const bytes = await readFile(paths.activePath, "utf8");
			ok(expected.has(bytes), `unexpected partial bytes at sample ${index}`);
			ok(deserializeRunJournal(bytes, paths.activePath).value);
		})());
		await store.replaceActive(root, versions[index % versions.length]);
	}
	await Promise.all(reads);
});

it.sequential("Assignment creation is deterministic, protected, no-clobber, and byte-identity reusable", async () => {
	const root = await makeRoot();
	const store = createRunJournalStore();
	const runId = "run-20260917T180000000Z-assignment";
	const paths = resolveAssignmentPaths(root, runId, "task-01", "attempt-01");
	const document: BuilderAssignmentDocument = {
		schemaVersion: 1,
		assignment: {
			runId,
			taskId: "task-01",
			attemptId: "attempt-01",
			role: "builder",
			requiredOutcome: "Implement the bounded change",
			allowedScope: ["src/change.ts"],
			expectedArtifacts: [{ kind: "git-commit" }],
			reportPath: paths.reportPath,
			evidenceDirectory: paths.evidenceDirectory,
			verification: { kind: "command", command: "npm test" },
			actualModel: { model: "builder/primary", thinkingLevel: "high" },
			specificationHash: "sha256:" + "a".repeat(64),
			baseRevision: "0123456789abcdef0123456789abcdef01234567",
			worktree: { path: "/tmp/builder-worktree", branch: "steward/run/task/attempt-01" },
			herdr: { workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1", agentName: "steward-b-abcdef12-01-01" },
		},
	};
	const first = await store.createAssignment(root, document);
	equal(first.kind, "created");
	const bytes = await readFile(paths.assignmentPath, "utf8");
	equal(await stat(paths.assignmentPath).then((value) => value.mode & 0o777), 0o600);
	const second = await store.createAssignment(root, document);
	equal(second.kind, "existing-match");
	equal(await readFile(paths.assignmentPath, "utf8"), bytes);
	const conflict = await store.createAssignment(root, { ...document, assignment: { ...document.assignment, requiredOutcome: "A different bounded change" } });
	equal(conflict.kind, "conflict");
	equal(await readFile(paths.assignmentPath, "utf8"), bytes);
	deepStrictEqual(await listTemporaryFiles(paths.attemptDirectory), []);
});

it.sequential("finalized evidence is an exact protected no-clobber snapshot", async () => {
	const root = await makeRoot();
	const store = createRunJournalStore();
	const runId = "run-20260917T180000000Z-finalize";
	const paths = resolveAssignmentPaths(root, runId, "task-01", "attempt-01");
	const document: BuilderAssignmentDocument = {
		schemaVersion: 1,
		assignment: {
			runId,
			taskId: "task-01",
			attemptId: "attempt-01",
			role: "builder",
			requiredOutcome: "Persist exact evidence",
			allowedScope: ["reports/result.md"],
			expectedArtifacts: [{ kind: "evidence", description: "A deterministic report" }],
			reportPath: paths.reportPath,
			evidenceDirectory: paths.evidenceDirectory,
			verification: { kind: "command", command: "npm test" },
			actualModel: { model: "builder/primary", thinkingLevel: "high" },
			specificationHash: "sha256:" + "a".repeat(64),
			baseRevision: "0123456789abcdef0123456789abcdef01234567",
			worktree: { path: "/tmp/builder-worktree", branch: "steward/run/task/attempt-01" },
			herdr: { workspaceId: "workspace-1", paneId: "pane-1", terminalId: "terminal-1", agentName: "steward-b-abcdef12-01-01" },
		},
	};
	const assignmentBytes = Buffer.from("assignment\n");
	const reportBytes = Buffer.from("report\n");
	const manifestBytes = Buffer.from("manifest-v1\n");
	const copyBytes = Buffer.from("npm test output\n");
	await store.createAssignment(root, document);
	await writeFile(paths.reportPath, reportBytes, { mode: 0o600 });
	const finalizedDirectory = join(paths.attemptDirectory, "finalized");
	const evidenceStore = createAttemptEvidenceStore();
	const input = {
		paths: { attemptDirectory: paths.attemptDirectory, assignmentPath: paths.assignmentPath, reportPath: paths.reportPath, evidenceDirectory: paths.evidenceDirectory, finalizedDirectory },
		assignmentBytes,
		reportBytes,
		manifestBytes,
		manifestSha256: sha256Bytes(manifestBytes),
		copies: [{ relativePath: "logs/check.log", bytes: copyBytes, size: copyBytes.length, sha256: sha256Bytes(copyBytes) }],
		originalPaths: [paths.reportPath],
	};
	const created = await evidenceStore.finalizeBuilderEvidence(input);
	equal(created.kind, "created");
	deepStrictEqual(await readFile(join(finalizedDirectory, "manifest.json")), manifestBytes);
	deepStrictEqual(await readFile(join(finalizedDirectory, "logs/check.log")), copyBytes);
	equal((await stat(join(finalizedDirectory, "manifest.json"))).mode & 0o777, 0o400);
	equal((await stat(finalizedDirectory)).mode & 0o777, 0o500);
	equal((await stat(paths.reportPath)).mode & 0o777, 0o400);
	const reused = await evidenceStore.finalizeBuilderEvidence(input);
	equal(reused.kind, "existing-match");
	const conflictingManifest = Buffer.from("manifest-v2\n");
	const conflict = await evidenceStore.finalizeBuilderEvidence({ ...input, manifestBytes: conflictingManifest, manifestSha256: sha256Bytes(conflictingManifest) });
	equal(conflict.kind, "conflict");
	deepStrictEqual(await readFile(join(finalizedDirectory, "manifest.json")), manifestBytes);
	deepStrictEqual(await listTemporaryFiles(paths.attemptDirectory), []);
});
