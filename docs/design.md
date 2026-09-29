# Steward Design

**Status:** Accepted

This document records the shared understanding reached during the design interview. It is not an implementation plan.

## Constraints

- Keep the Steward small, direct, and functional.
- Prefer Herdr's existing lifecycle features, ordinary files, and Git evidence.
- Do not introduce a daemon, database, event-sourcing system, distributed lock, generic workflow engine, or ticket-quality framework without a demonstrated need.

## Authority

- Herdr is authoritative for live agent and process state.
- The Run Journal is authoritative for intended workflow progress.
- Git and durable Artifacts are authoritative evidence of produced and reviewed work.
- Pi context, compaction summaries, transcripts, and agent claims are not authoritative by themselves.

## Initial Operating Model

- A repository has at most one active Run.
- A Run is started explicitly after the Steward drafts a small Task list and the user confirms it.
- A Run may contain multiple independent Builder/Reviewer pairs.
- The first version does not implement arbitrary task dependency graphs.
- The Steward controls only Herdr agents it creates for the Run.
- Existing agents may continue while the controller is unavailable, but new orchestration decisions pause until the controller returns and reconciles.
- Each code-changing Builder receives an isolated worktree.
- Its Reviewer evaluates the same frozen revision without modifying it.
- Every agent outcome is written to a durable Attempt Report. Each Attempt has a separate evidence directory; after finalization its report, logs, and evidence are preserved unchanged, and further work uses a linked Attempt.
- Review is configurable per Task and required by default for code-changing Tasks.

## Execution Policy

- The Steward may automatically retry a clearly transient execution failure up to two times.
- Review-requested rework may repeat for up to five cycles before user intervention is required.
- Once required Reviews approve, the Steward integrates approved revisions locally and sequentially.
- The Steward does not push without separate authorization.
- Per-Task checks and final post-integration verification must pass before completion.
- Cancellation interrupts active agents, preserves worktrees and reports, marks the Run cancelled, and prevents further dispatch or integration.
- Five review/rework cycles means the initial build and review followed by at most five rework-and-review repetitions.

## Task Contract

Every approved Task defines only:

- Task ID
- required outcome
- allowed scope
- expected Artifacts
- verification command or criteria
- whether Review is required

A code-changing Builder must produce a local commit SHA and an Attempt Report. Its Reviewer is a separate Herdr agent and should use a different model/provider family when available. Completed or cancelled Run Journals and reports are archived; worktree removal requires user confirmation.

## Recovery Invariant

Every workflow transition is persisted before its external side effect. Examples include recording `dispatching` before prompting an agent, `approved` before integration, and `cancelled` before interrupting agents. After interruption, restart, or compaction, the controller reconciles durable state with Herdr and Artifacts before taking another action.

A settled Herdr agent without an Attempt Report is asked once to produce the missing report; if it still does not, the Task blocks rather than being treated as successful. When an agent is `blocked`, the Steward may answer only when the approved Task already determines the answer. A wait timeout triggers inspection, not failure or interruption.

Pi compaction hooks improve continuity but are not required for correctness. Before compaction, the Steward verifies the journal and places the Run ID and pending action into the summary. Compaction failure produces diagnostics only. Every controller action reconciles before advancing work.

## Agent Health and Recovery

Task progress, Attempt lifecycle, and attention are tracked separately.

Task phases are `pending`, `building`, `reviewing`, `reworking`, `approved`, `integrating`, `completed`, and `cancelled`. Attempt states are `prepared`, `active`, `awaiting-report`, `reported`, `ended-error`, `superseded`, and `cancelled`. Attention is `none`, `blocked`, `waiting-external`, `suspected-stall`, `recovering`, or `needs-user`.

Silence never fails a Task automatically. The Steward first inspects Herdr, terminal output, the worktree, commits, Artifacts, and the Attempt Report. It then nudges the same agent, soft-interrupts a stuck generation if necessary, and asks the same agent to resume from durable state. If that cannot restore progress, a replacement agent receives a new linked Attempt in the preserved worktree. Inspection, nudging, and same-agent resume do not consume a retry; replacement consumes one of the two transient retries. Exhausted recovery marks the Task `needs-user` without discarding work.

## Durable Dispatch

Before dispatch, the Steward atomically writes an Assignment containing the Run, Task, and Attempt IDs; required outcome; allowed scope; report path; expected Artifacts; and verification criteria. It records the Attempt and intended dispatch before prompting a named Herdr agent to continue that Assignment.

After an interruption, reconciliation checks for a valid report, a working or blocked agent, settled state without a report, unclear live state, and a missing agent—in that order. The Steward never blindly repeats work, resets unexplained worktree changes, or deletes partial progress. A replacement agent must inspect and continue the preserved work.

## User Surface

The initial command surface is `/steward start`, `/steward status`, `/steward resume`, `/steward revise`, `/steward cancel`, `/steward cleanup`, and `/steward config`. The Steward does not intercept ordinary subagent activity automatically. `/steward revise` drafts and confirms an explicit delta, identifies affected Tasks and evidence, versions changed Task specifications, cancels obsolete Attempts, invalidates affected Reviews, and retains unaffected completed work. `/steward config` edits the small set of user-global operational defaults.

Observable progress includes a Herdr lifecycle change, new terminal output, a worktree file change, a Git diff or commit change, or an Attempt Report update.

Attempt Reports use plain Markdown with small machine-readable frontmatter. All reports contain Run, Task, and Attempt IDs; status; a concise summary; and blockers. Builder reports additionally contain produced Artifacts, the produced commit SHA, and checks. Reviewer reports contain the reviewed SHA, an explicit `approved` or `changes-required` verdict, actionable findings, and checks. Provider failure, process exit, silence, or Herdr lifecycle state is never a Review verdict.

If an approved revision conflicts during integration, the Task returns to its Builder against the updated target and requires a fresh Review of the new SHA. This consumes one of the five rework cycles.

## Controller and Monitoring

The Run Journal identifies one Controller Session. Other Pi sessions may inspect status but must explicitly run `/steward resume --takeover` before advancing the Run; takeover reconciles first and then replaces the controller identity.

While the Controller Session is open, a session-scoped monitor waits for Herdr lifecycle changes, records observations and reports, and updates Pi status or notifications. When Pi is handling a user turn or compacting, the monitor observes but does not dispatch, replace agents, or integrate. Once Pi is idle or compaction completes, it reconciles and may perform the next deterministic workflow action. The monitor stops on `session_shutdown` and is reconstructed on `session_start`; Herdr waits are preferred over frequent polling.

## Journal and Repository Safety

The Journal is one atomically replaced `.pi/steward/active-run.json`, archived as a final snapshot after completion or cancellation. Assignments and Attempt Reports are separate durable files. A concise append-only activity log records significant observations and decisions for human inspection, but it is not replayed and cannot advance the Run. The design does not use an append-only event store.

A code-changing Run requires a selected base commit and clean integration checkout. The Steward never stashes or incorporates existing uncommitted work automatically.

Before Review, the Steward records the worktree's HEAD and dirty-state fingerprint. After Review it verifies both are unchanged. Reviewer modifications are preserved, the Review is invalidated, and the Task becomes `needs-user`; the Steward never resets unexplained changes automatically.

## Failure Boundaries

`/steward start` refuses to replace an existing active Run and directs the user to inspect, resume, cancel, or clean it up.

Provider or network interruption, agent startup failure, Herdr command failure, and unexpected agent-process exit consume the two-retry transient failure budget. Test failures, review findings, incorrect implementation, scope violations, and missing Artifacts are handled as rework or blocking correctness problems rather than transient retries.

If final integrated verification fails and ownership is clear, the responsible Task returns to its Builder and requires a new SHA and fresh Review, consuming a rework cycle. If ownership is unclear or several Tasks interact, the Steward preserves the integrated state and asks the user; it never automatically resets or reverts integrated work.

Journal writes use a validated temporary snapshot, preserve the previous valid snapshot as `active-run.previous.json`, and atomically replace the active snapshot. If both snapshots are invalid, the Steward enters read-only recovery and asks the user.

Herdr unavailability degrades monitoring but does not fail Attempts. The Steward retains state and reconciles when Herdr returns. A malformed Attempt Report is returned once to the same agent for correction and then blocks if still invalid.

External modifications to a managed worktree are preserved. The Steward invalidates affected Review or verification evidence, stops mutating that Task, shows the detected difference, and requires user confirmation before continuing.

## Compatibility and User Experience

The first version creates Pi agents only. If Herdr is unavailable, the Steward refuses to start and explains how to restore it; it never silently falls back to a different subagent mechanism.

The initial interface consists of a compact Markdown `/steward status` view, a Pi footer showing Run phase and attention count, and notifications for blocked, degraded, approval-required, and completed conditions. There is no custom dashboard in the first version.

After final verification, the Steward marks the Run completed, archives its Journal and reports, notifies the user, and retains managed worktrees until `/steward cleanup` receives confirmation.

The Steward is distributed as a reusable Pi package installed from Git or npm while keeping Run state and evidence project-local.

## Model Plan

Every Run requires an explicitly confirmed Model Plan. The Controller Session's current model may be presented as a suggested Builder model but is never inherited silently. The user confirms exact `provider/model-id` references, thinking levels, and ordered fallback lists for Builder and Reviewer roles.

The confirmed Model Plan is frozen into the Run Journal. The user may also save it as a project-local default, but future Runs still display it for confirmation. Every Assignment and Attempt Report records the actual model used.

## Parallelism and Integration

Only Tasks with clearly disjoint allowed scopes run concurrently, and the Run's confirmed maximum active Task count is never exceeded. Tasks with overlapping scopes are serialized in the user-approved order rather than being represented through a general dependency graph. Approved Tasks integrate in that same order, never in completion order.

If the integration target advances, the Steward compares it with each Task's base revision. A revision that requires modification returns to its Builder against the new target and requires a new SHA and fresh Review. Non-Git Artifacts are identified by path, size, and SHA-256 hash.

Full test and verification output is written to durable log files under the Run directory. Attempt Reports contain the command, exit result, concise summary, and full log path rather than embedding large output.

## Verification and Cleanup

The Steward directly executes approved deterministic final-verification commands and records logs and exit codes. A code-changing Task without deterministic verification requires an explicit, durable user waiver. Verification exists only to support safe orchestration; version one does not require or recreate Unlazy, a `GATES.md` workflow, or another ticket-quality manager.

Before Review, the Steward compares changed paths with the Task's allowed scope. Out-of-scope changes are preserved and shown to the user, and the Task returns to its Builder for correction rather than proceeding to Review.

If verification dirties the integration checkout, the Steward preserves the changes, blocks completion, and displays the exact difference. It never automatically deletes generated or unexplained files.

When a Run completes or is cancelled, the Steward gracefully stops the agents it created while retaining their Pi session files, panes, worktrees, reports, and other evidence. `/steward cleanup` shows the exact Steward-owned resources it will remove, requires confirmation, then closes those retained panes and removes those worktrees.

The Steward may create its own panes and worktrees, make local commits, integrate locally, run approved checks, and gracefully interrupt its own agents. Git push, deployment, force reset, discarding work, deleting unrecognized resources, and account, credential, or security changes always require separate explicit authorization.

## Artifact Integrity and Interrupted Side Effects

A code Artifact is identified by its base commit SHA, produced head SHA, the exact commit range between them, and confirmation that the Builder worktree is clean. Review and integration apply to that exact range; Builders are not required to squash their commits.

Every approved Assignment has a specification hash stored in the Run Journal. Before accepting an Attempt Report, the Steward verifies that hash. Unexpected Assignment changes are preserved and require user confirmation.

Before integration, the Steward persists the target branch, target SHA, approved base/head range, and intended action. Recovery checks whether the exact range is already integrated, the target is unchanged and the action can be retried, a partial/conflicted Git operation exists, or the target changed unexpectedly. Partial, conflicted, or unexplained states are preserved and shown to the user; the Steward never blindly repeats or aborts them.

If the controller is interrupted during final verification, it waits on an identifiable live process, consumes a complete durable result when present, or reruns the deterministic command when no conclusive result exists. Recovery reruns are recorded explicitly.

Attempt Reports whose referenced logs, commits, or Artifacts cannot be validated are invalid. The same agent receives one opportunity to repair the report before the Task blocks.

Planned Herdr names that collide with existing resources are replaced with unique Steward-owned names. Existing resources are never adopted automatically, and actual names and pane IDs are persisted.

## Configuration and Stored Data

User-global defaults contain the five-minute passive inspection interval, five-minute second inspection and nudge interval, two-minute nudge grace period, external-command warning threshold, maximum active Task count, two-attempt transient retry limit, and five-cycle review/rework limit. Project-local defaults contain Builder and Reviewer Model Plans and optional project verification defaults. Every Run freezes its effective configuration into the Run Journal, so later configuration changes do not alter active work.

Version one provides full behavior only in interactive Pi TUI mode. `/steward status` may provide plain output in other modes when possible, but Run approval, takeover, revision, cancellation, configuration, and cleanup require interactive confirmation.

`.pi/steward/` is automatically excluded from Git, uses user-only filesystem permissions where supported, and is treated as potentially sensitive. Agents receive only the Assignment data required for their work. Full logs are not displayed or exported without warning.

Every Journal contains a `schemaVersion`. Unsupported newer versions and older versions without an explicit migration open in read-only status mode; the Steward never guesses how to mutate unfamiliar state.

Ordinary cleanup closes Steward-created panes and removes managed worktrees but retains archived Journals, Assignments, Attempt Reports, and verification logs. Historical evidence remains until the user deletes an archive explicitly.

Transient provider failures first retry the same model within the agreed budget. Replacement Attempts may use only the next pre-approved fallback, and model changes never occur silently within an active Attempt. Model availability and authentication are checked at Run approval and again before dispatch; absent approved fallbacks pause the Task for user input.

At Review time, the Steward chooses the first available approved Reviewer model from a different provider family than the model actually used by the Builder. If none is available, it explains the lost independence and requires the user to add a model, choose another model, or explicitly authorize same-family Review.

## Product Form

The initial product is a Pi extension that uses Pi lifecycle hooks and Herdr's CLI. It contains a small orchestration module, Run Journal storage, and a Herdr adapter. The orchestration module remains ordinary TypeScript so it can be reused by a standalone CLI later if a demonstrated need appears. There is no daemon.

## Long-Running External Commands

An Attempt waiting on a known live test, build, or other child process has attention `waiting-external`, not `suspected-stall`. Process liveness is evidence that the agent is legitimately waiting even when the command produces no output.

While the external process remains alive, the Steward does not nudge, interrupt, replace the agent, or require log output. Crossing a configured warning threshold produces only a non-disruptive notification. After the process exits, the agent receives a grace period to interpret the result and update its Attempt Report; only then may the normal silent-agent recovery ladder begin. If liveness cannot be established, the Steward performs passive inspection and avoids destructive recovery.
