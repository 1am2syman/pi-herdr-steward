import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const stewardGitHubIssuesParameters = Type.Object({
 repository: Type.Optional(Type.String({ minLength: 1, description: "owner/repo on github.com; omit to detect the checkout repository via gh." })),
 state: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("all")])),
 labels: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Require all labels; listing only." })),
 assignee: Type.Optional(Type.String({ minLength: 1, description: "GitHub login, * (assigned), or none; listing only." })),
 numbers: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, description: "Exact numbers in supplied order, regardless of state. Cannot combine with listing filters." })),
});
export interface GitHubIssueRequest {
 repository?: string;
 state?: "open" | "closed" | "all";
 labels?: string[];
 assignee?: string;
 numbers?: number[];
}
export interface GitHubIssue {
 number: number;
 url: string;
 title: string;
 body: string;
 state: "open" | "closed";
 labels: string[];
 assignees: string[];
 updatedAt: string;
}
export interface GitHubIssueSnapshot {
 repository: string;
 fetchedAt: string;
 selection: GitHubIssueRequest;
 issues: GitHubIssue[];
}
export type GitHubIssueRunner = (command: string, args: string[], options?: { cwd?: string; timeout?: number; signal?: AbortSignal }) => Promise<ExecResult>;

function object(value: unknown): value is Record<string, unknown> {
 return typeof value === "object" && value !== null && !Array.isArray(value);
}
function repositoryName(value: unknown): string {
 if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(value) || value.endsWith("/.") || value.endsWith("/..")) throw new Error("GitHub repository must be owner/repo on github.com.");
 return value;
}
function parseIssue(value: unknown, repository: string): GitHubIssue {
 if (!object(value) || "pull_request" in value) throw new Error("Expected a GitHub issue, not a pull request.");
 if (!Number.isSafeInteger(value.number) || (value.number as number) < 1 || typeof value.title !== "string" || (value.body !== null && typeof value.body !== "string") || (value.state !== "open" && value.state !== "closed") || typeof value.updated_at !== "string" || !Number.isFinite(Date.parse(value.updated_at))) throw new Error("GitHub returned malformed issue data.");
 const url = `https://github.com/${repository}/issues/${value.number}`;
 if (typeof value.html_url !== "string" || value.html_url.toLowerCase() !== url.toLowerCase()) throw new Error("GitHub returned an issue from an unexpected repository.");
 if (!Array.isArray(value.labels) || !value.labels.every((label) => object(label) && typeof label.name === "string") || !Array.isArray(value.assignees) || !value.assignees.every((assignee) => object(assignee) && typeof assignee.login === "string")) throw new Error("GitHub returned malformed issue labels or assignees.");
 return { number: value.number as number, url: value.html_url, title: value.title, body: value.body ?? "", state: value.state, labels: value.labels.map((label) => label.name as string), assignees: value.assignees.map((assignee) => assignee.login as string), updatedAt: value.updated_at };
}

/** Read only. Failed pages, malformed responses, and cancellation never return a partial snapshot. */
export async function fetchGitHubIssues(exec: GitHubIssueRunner | undefined, cwd: string, request: GitHubIssueRequest, signal?: AbortSignal): Promise<GitHubIssueSnapshot> {
 if (!exec) throw new Error("GitHub discovery requires the Pi command runner and authenticated gh CLI (gh auth login).");
 if (request.state !== undefined && !["open", "closed", "all"].includes(request.state)) throw new Error("Invalid GitHub issue state.");
 if (request.labels !== undefined && (!Array.isArray(request.labels) || !request.labels.length || request.labels.some((label) => typeof label !== "string" || !label.trim() || label.includes(",")))) throw new Error("Labels must be non-empty names without commas.");
 if (request.assignee !== undefined && !/^(?:[A-Za-z0-9][A-Za-z0-9-]*|\*|none)$/.test(request.assignee)) throw new Error("Invalid GitHub assignee.");
 if (request.numbers !== undefined && (!Array.isArray(request.numbers) || !request.numbers.length || request.numbers.some((n) => !Number.isSafeInteger(n) || n < 1) || new Set(request.numbers).size !== request.numbers.length)) throw new Error("Issue numbers must be distinct positive integers.");
 if (request.numbers && (request.state !== undefined || request.labels !== undefined || request.assignee !== undefined)) throw new Error("Exact issue numbers cannot be combined with listing filters.");
 const runner = exec;
 const selection = { ...request, ...(request.labels ? { labels: [...request.labels] } : {}), ...(request.numbers ? { numbers: [...request.numbers] } : {}) };
 async function run(args: string[]): Promise<unknown> {
  if (signal?.aborted) throw new Error("GitHub issue discovery aborted.");
  let result: ExecResult;
  try { result = await runner("gh", args, { cwd, timeout: 120_000, signal }); }
  catch {
   if (signal?.aborted) throw new Error("GitHub issue discovery aborted.");
   throw new Error("GitHub discovery failed. Check gh installation, gh auth status, repository access, and network connectivity.");
  }
  if (signal?.aborted) throw new Error("GitHub issue discovery aborted.");
  if (result.code !== 0 || result.killed) throw new Error("GitHub discovery failed or timed out. Check gh auth status, repository access, rate limits, and network connectivity. No partial snapshot was accepted.");
  try { return JSON.parse(result.stdout) as unknown; }
  catch { throw new Error("GitHub returned invalid JSON; no snapshot was accepted."); }
 }
 let repository: string;
 if (request.repository === undefined) {
  const detected = await run(["repo", "view", "--json", "nameWithOwner,url"]);
  if (!object(detected) || typeof detected.url !== "string" || !detected.url.startsWith("https://github.com/")) throw new Error("Could not detect a github.com repository. Specify owner/repo explicitly.");
  repository = repositoryName(detected.nameWithOwner);
  if (detected.url.toLowerCase() !== `https://github.com/${repository}`.toLowerCase()) throw new Error("Detected GitHub repository identity is inconsistent.");
 }
 else repository = repositoryName(request.repository);
 const endpoint = `repos/${repository}/issues`;
 const issues: GitHubIssue[] = [];
 if (request.numbers) {
  for (const number of request.numbers) {
   const issue = parseIssue(await run(["api", `${endpoint}/${number}`, "--hostname", "github.com", "--method", "GET"]), repository);
   if (issue.number !== number) throw new Error("GitHub returned an unexpected issue number.");
   issues.push(issue);
  }
 } else {
  const args = ["api", endpoint, "--hostname", "github.com", "--method", "GET", "--paginate", "--slurp", "-f", `state=${request.state ?? "open"}`, "-f", "per_page=100", "-f", "sort=created", "-f", "direction=asc"];
  if (request.labels) args.push("-f", `labels=${request.labels.join(",")}`);
  if (request.assignee) args.push("-f", `assignee=${request.assignee}`);
  const pages = await run(args);
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error("GitHub returned malformed issue pages.");
  for (const value of pages.flat()) {
   if (object(value) && "pull_request" in value) continue;
   issues.push(parseIssue(value, repository));
  }
  issues.sort((a, b) => a.number - b.number);
 }
 if (new Set(issues.map((issue) => issue.number)).size !== issues.length) throw new Error("GitHub returned duplicate issues; fetch a fresh snapshot.");
 return { repository, fetchedAt: new Date().toISOString(), selection, issues };
}
