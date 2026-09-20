import { describe, expect, it } from "vitest";

import {
	allowedScopesOverlap,
	allRequiredTasksIntegrated,
	countActiveTasks,
	selectIntegrationQueueHead,
	selectTaskAdmission,
} from "../src/coordination.ts";
import type { RunRecord, TaskRecord } from "../src/run.ts";

const sha = (digit: string) => digit.repeat(40);

function task(id: string, scope: string, phase: TaskRecord["phase"] = "pending", extra: Partial<TaskRecord> = {}): TaskRecord {
	return {
		specificationVersion: 1,
		specificationHash: `sha256:${"a".repeat(64)}`,
		contract: { id, requiredOutcome: id, allowedScope: [scope], expectedArtifacts: [{ kind: "git-commit" }], verification: { kind: "command", command: "true" }, reviewRequired: true },
		phase,
		attention: "none",
		attempts: [],
		reworkCycles: 0,
		...extra,
	} as TaskRecord;
}

function run(tasks: TaskRecord[], maximumActiveTasks = 2): RunRecord {
	return { tasks, integrationBase: { kind: "git", branch: "main", revision: sha("0") }, effectiveSettings: { maximumActiveTasks } } as RunRecord;
}

describe("ticket-13 pure coordination policy", () => {
	it("uses path segments and containment, not textual prefixes", () => {
		expect(allowedScopesOverlap(["src/app"], ["src/app"])).toBe(true);
		expect(allowedScopesOverlap(["src/app"], ["src/app/nested"])).toBe(true);
		expect(allowedScopesOverlap(["src/app/nested"], ["src/app"])).toBe(true);
		expect(allowedScopesOverlap(["src/app"], ["src/apple"])).toBe(false);
	});

	it("admits ordered disjoint work under the frozen cap and keeps overlap blocked", () => {
		const first = task("task-01", "src/a", "building");
		const second = task("task-02", "src/b");
		const third = task("task-03", "src/a/nested");
		expect(countActiveTasks(run([first, second, third]))).toBe(1);
		expect(selectTaskAdmission(run([first, second, third]))).toEqual({ kind: "admit", taskId: "task-02", index: 1, baseRevision: sha("0") });
		expect(selectTaskAdmission(run([first, second, third], 1)).kind).toBe("at-cap");
		const noSlot = run([first, task("task-02", "src/b", "building"), third]);
		expect(selectTaskAdmission(run(noSlot.tasks, 3))).toMatchObject({ kind: "blocked-by-overlap", taskId: "task-03", blockedBy: ["task-01"] });
	});

	it("accepts zero only at the config boundary and accepts the maximum safe cap policy input", () => {
		const pending = task("task-01", "src/a");
		expect(selectTaskAdmission(run([pending], 0)).kind).toBe("at-cap");
		expect(selectTaskAdmission(run([pending], Number.MAX_SAFE_INTEGER))).toMatchObject({ kind: "admit", taskId: "task-01" });
	});

	it("selects only the first non-integrated approved queue slot", () => {
		const first = task("task-01", "src/a", "integrating", { integration: { phase: "integrated", targetBranch: "main", targetRevision: sha("0"), approvedBaseRevision: sha("0"), approvedHeadRevision: sha("1"), approvedCommits: [sha("1")], builderAttemptId: "attempt-01", reviewerAttemptId: "attempt-02", builderManifestSha256: `sha256:${"b".repeat(64)}`, reviewerManifestSha256: `sha256:${"c".repeat(64)}`, action: { kind: "fast-forward", argv: ["merge", "--ff-only", "--no-edit", sha("1")] }, intendedAt: "2026-09-19T00:00:00.000Z", integratedAt: "2026-09-19T00:00:01.000Z", observedHead: sha("1") } });
		const builder = { id: "attempt-01", role: "builder", state: "reported", preparedAt: "2026-09-19T00:00:00.000Z", actualModel: { model: "builder/primary", thinkingLevel: "high" }, specificationHash: "", baseRevision: sha("0"), assignmentPath: "/a", reportPath: "/r", evidenceDirectory: "/e", dispatch: { phase: "prompted", branch: "b", agentName: "builder", worktreePath: "/w", workspaceId: "ws", paneId: "p", terminalId: "t", assignmentSha256: `sha256:${"1".repeat(64)}`, promptedAt: "2026-09-19T00:00:00.000Z" }, evidence: { phase: "finalized", finalizedAt: "2026-09-19T00:00:01.000Z", status: "completed", reportSha256: `sha256:${"2".repeat(64)}`, manifestPath: "/m", manifestSha256: `sha256:${"3".repeat(64)}`, producedRevision: sha("2") } };
		const second = task("task-02", "src/b", "approved", { approval: { phase: "valid", subject: { kind: "git", baseRevision: sha("0"), headRevision: sha("2"), commits: [sha("2")], builderManifestSha256: `sha256:${"3".repeat(64)}` }, builderAttemptId: "attempt-01", reviewerAttemptId: "attempt-02", approvedAt: "2026-09-19T00:00:00.000Z", reviewerManifestPath: "/reviewer.json", reviewerManifestSha256: `sha256:${"4".repeat(64)}`, worktreeSnapshot: { head: sha("2"), dirtyStateFingerprint: `sha256:${"5".repeat(64)}`, dirtyPaths: [], operationMarkers: [] }, verdict: "approved" }, attempts: [builder] as unknown as TaskRecord["attempts"] });
		const selected = selectIntegrationQueueHead(run([first, second]));
		expect(selected).toMatchObject({ kind: "ready", taskId: "task-02", targetRevision: sha("1"), action: "merge-commit" });
		expect(allRequiredTasksIntegrated(run([first, second]))).toBe(false);
	});
});
