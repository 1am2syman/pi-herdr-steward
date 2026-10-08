import { expect, it } from "vitest";
import { fetchGitHubIssues, type GitHubIssueRequest, type GitHubIssueRunner } from "../src/github-issues.ts";

const issue = (number: number) => ({ number, html_url: "https://github.com/acme/project/issues/" + number, title: "Fix " + number, body: "Acceptance: preserve user data", state: "open", labels: [{ name: "bug" }], assignees: [{ login: "alice" }], updated_at: "2026-09-17T18:00:00Z" });
function runner(responses: unknown[]) {
 const calls: Array<{ command: string; args: string[]; options: Parameters<GitHubIssueRunner>[2] }> = [];
 const exec: GitHubIssueRunner = async (command, args, options) => {
  calls.push({ command, args, options });
  if (!responses.length) throw new Error("Unexpected extra call");
  return { code: 0, killed: false, stdout: JSON.stringify(responses.shift()), stderr: "" };
 };
 return { exec, calls };
}
it("detects repository, consumes every page, excludes PRs, and orders issues", async () => {
 const f = runner([{ nameWithOwner: "acme/project", url: "https://github.com/acme/project" }, [[issue(8), { pull_request: {} }], [issue(3)]]]);
 const signal = new AbortController().signal;
 const snapshot = await fetchGitHubIssues(f.exec, "/checkout", {}, signal);
 expect(snapshot.repository).toBe("acme/project");
 expect(snapshot.issues.map((i) => i.number)).toEqual([3, 8]);
 expect(snapshot.issues[0]).toMatchObject({ body: "Acceptance: preserve user data", labels: ["bug"], assignees: ["alice"] });
 expect(Number.isFinite(Date.parse(snapshot.fetchedAt))).toBe(true);
 expect(f.calls[1].args).toEqual(["api", "repos/acme/project/issues", "--hostname", "github.com", "--method", "GET", "--paginate", "--slurp", "-f", "state=open", "-f", "per_page=100", "-f", "sort=created", "-f", "direction=asc"]);
 expect(f.calls.every((c) => c.command === "gh" && c.options?.cwd === "/checkout" && c.options.signal === signal)).toBe(true);
});
it("passes listing filters as raw GET fields without shell interpolation", async () => {
 const f = runner([[]]);
 const selection = { repository: "acme/project", state: "closed" as const, labels: ["bug", "help wanted"], assignee: "alice" };
 expect((await fetchGitHubIssues(f.exec, "/checkout", selection)).issues).toEqual([]);
 expect(f.calls[0].args).toEqual(expect.arrayContaining(["state=closed", "labels=bug,help wanted", "assignee=alice", "GET"]));
});
it("fetches exact issues in user order including closed issues and null bodies", async () => {
 const f = runner([{ ...issue(8), body: null, state: "closed" }, issue(3)]);
 const snapshot = await fetchGitHubIssues(f.exec, "/checkout", { repository: "acme/project", numbers: [8, 3] });
 expect(snapshot.issues.map((i) => i.number)).toEqual([8, 3]);
 expect(snapshot.issues[0]).toMatchObject({ body: "", state: "closed" });
 expect(f.calls[0].args).toEqual(["api", "repos/acme/project/issues/8", "--hostname", "github.com", "--method", "GET"]);
});
it.each<GitHubIssueRequest>([
 { repository: "../project" }, { repository: "--help" }, { repository: "https://github.com/acme/project" },
 { repository: "acme/.." }, { numbers: [] }, { numbers: [1, 1] }, { numbers: [0] },
 { numbers: [1], state: "open" }, { labels: [] }, { labels: ["bug,feature"] }, { assignee: "a&b" },
])("rejects invalid or ambiguous requests before executing gh: %j", async (request) => {
 const f = runner([]);
 await expect(fetchGitHubIssues(f.exec, "/checkout", request)).rejects.toThrow();
 expect(f.calls).toHaveLength(0);
});
it.each([
 [[{ ...issue(1), html_url: "https://github.com/other/project/issues/1" }]],
 [[{ ...issue(1), labels: [null] }]], [[{ ...issue(1), number: 0 }]], [[{ ...issue(1), body: 42 }]],
 [[issue(1), issue(1)]], { issues: [] }, [issue(1)],
].map((pages) => ({ pages })))("refuses malformed or duplicate pages rather than returning partial data", async ({ pages }) => {
 const f = runner([pages]);
 await expect(fetchGitHubIssues(f.exec, "/checkout", { repository: "acme/project" })).rejects.toThrow();
});
it("refuses PRs and mismatched identities for exact numbers", async () => {
 for (const data of [{ ...issue(1), pull_request: {} }, issue(2)]) {
  const f = runner([data]);
  await expect(fetchGitHubIssues(f.exec, "/checkout", { repository: "acme/project", numbers: [1] })).rejects.toThrow();
 }
});
it("refuses enterprise or inconsistent detection rather than silently reading github.com", async () => {
 for (const data of [{ nameWithOwner: "acme/project", url: "https://enterprise.test/acme/project" }, { nameWithOwner: "acme/project", url: "https://github.com/other/project" }]) {
  await expect(fetchGitHubIssues(runner([data]).exec, "/checkout", {})).rejects.toThrow();
 }
});
it("handles missing runner, authentication, timeouts, invalid JSON, and cancellation", async () => {
 await expect(fetchGitHubIssues(undefined, "/checkout", {})).rejects.toThrow("gh auth login");
 for (const result of [{ code: 1, killed: false, stdout: "[]" }, { code: 0, killed: true, stdout: "[]" }, { code: 0, killed: false, stdout: "not JSON" }]) {
  await expect(fetchGitHubIssues(async () => ({ ...result, stderr: "secret must not leak" }), "/checkout", { repository: "acme/project" })).rejects.toThrow(/GitHub/);
 }
 await expect(fetchGitHubIssues(async () => { throw new Error("ENOENT secret"); }, "/checkout", { repository: "acme/project" })).rejects.toThrow("gh installation");
 const cancelled = new AbortController();
 await expect(fetchGitHubIssues(async () => { cancelled.abort(); throw new Error("aborted runner"); }, "/checkout", { repository: "acme/project" }, cancelled.signal)).rejects.toThrow("aborted");
 const controller = new AbortController(); controller.abort(); const f = runner([]);
 await expect(fetchGitHubIssues(f.exec, "/checkout", { repository: "acme/project" }, controller.signal)).rejects.toThrow("aborted");
 expect(f.calls).toHaveLength(0);
 const during = new AbortController();
 await expect(fetchGitHubIssues(async () => { during.abort(); return { code: 0, killed: false, stdout: "[]", stderr: "" }; }, "/checkout", { repository: "acme/project" }, during.signal)).rejects.toThrow("aborted");
});
it("does not return successful earlier exact issues when a later fetch fails", async () => {
 let calls = 0;
 await expect(fetchGitHubIssues(async () => ({ code: ++calls === 1 ? 0 : 1, killed: false, stdout: JSON.stringify(issue(1)), stderr: "" }), "/checkout", { repository: "acme/project", numbers: [1, 2] })).rejects.toThrow("No partial snapshot");
 expect(calls).toBe(2);
});
