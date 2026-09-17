import { existsSync } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { afterEach, it } from "vitest";

import { createRunJournalStore } from "../src/run-journal-store.ts";
import { resolveAssignmentPaths } from "../src/assignment-store.ts";
import { buildInitialRunJournal, deserializeRunJournal, serializeRunJournal, type RunJournal } from "../src/run.ts";
import { type ProjectModelPlans, type RecoveryDefaults } from "../src/config.ts";
import type { BuilderAssignmentDocument } from "../src/run.ts";

const roots: string[] = [];
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
		const result = await store.replaceActive(root, candidate as RunJournal);
		ok(result.kind === "invalid-candidate" || result.kind === "storage-error");
		equal(await readFile(paths.activePath, "utf8"), beforeActive);
	}
	await writeFile(paths.activePath, "{\"schemaVersion\":1}\n");
	const invalidCurrent = await store.replaceActive(root, journal(a.run.id, 2));
	equal(invalidCurrent.kind, "invalid-current");
	equal(await readFile(paths.activePath, "utf8"), "{\"schemaVersion\":1}\n");
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
