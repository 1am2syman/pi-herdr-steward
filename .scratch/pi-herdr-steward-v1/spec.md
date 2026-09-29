# Pi Herdr Steward v1

Status: ready-for-agent

## Problem Statement

Users can launch Builders and Reviewers through Herdr, but the controlling Pi session does not reliably retain or advance the workflow when context is compacted, the controller restarts, an agent silently stops, a long-running command produces no output, or a side effect is interrupted. Herdr accurately describes live agent and pane state, but `idle`, `done`, or a model's final message do not prove that a Task produced valid Artifacts, passed Review, or was integrated correctly.

Today the user must repeatedly ask the controller to check agents, reconstruct what happened from transcripts, and decide whether work should be resumed, retried, reviewed, or integrated. This is especially fragile when multiple Builder/Reviewer pairs run concurrently. Conversational memory and terminal output can be compacted, truncated, unavailable, or stale, causing missed completions, duplicate dispatch, discarded partial work, unreviewed integration, or false claims that a Run is complete.

The project needs a small, Herdr-native Steward that continuously observes the agents it creates while Pi is open, records durable workflow truth outside conversational context, preserves partial work, and advances only when concrete evidence permits the next action. It must remain direct and functional: no daemon, database, event-sourcing system, distributed locking system, generic workflow engine, or custom dashboard.

## Solution

Provide a reusable Pi package containing a Pi extension and a small orchestration core. The Steward explicitly starts one user-approved Run per repository, creates Pi Builders and Reviewers through Herdr, gives each code-changing Builder an isolated worktree, and records workflow state in an ignored project-local Run Journal. Assignments, Attempt Reports, verification logs, Git revisions, and non-Git Artifact hashes provide durable evidence. A concise append-only activity log gives humans a chronological account of observations and decisions, but it is never replayed or treated as workflow truth.

Herdr remains authoritative for live agent identity and process state. The Run Journal remains authoritative for intended workflow progress. Git and durable Artifacts remain authoritative for what was produced and reviewed. Pi context, compaction summaries, transcripts, and agent claims remain explanatory rather than authoritative.

The controlling Pi session runs a session-scoped monitor. It waits for Herdr lifecycle changes, records observations, updates status, and advances deterministic workflow steps only while Pi is at a safe idle point. Every transition is persisted before its external side effect. After compaction, restart, takeover, or interruption, the Steward reconciles the Run Journal, Herdr state, Git, worktrees, Attempt Reports, and Artifacts before doing anything else.

Agent silence is recoverable uncertainty rather than Task failure. The Steward inspects evidence, nudges and resumes the same agent, protects live long-running commands from interruption, and creates a linked replacement Attempt only when same-agent recovery fails. Reviews bind to exact immutable revisions. Approved revisions integrate locally in the user's approved order, followed by deterministic final verification. Completion is reported only when the Completion Gate passes.

## User Stories

1. As a Steward user, I want to start a Run explicitly, so that ordinary subagent work is never captured unexpectedly.
2. As a Steward user, I want the Steward to draft a small Task list for confirmation, so that agent work begins from an approved contract.
3. As a Steward user, I want every Task to state its required outcome, allowed scope, expected Artifacts, verification criteria, and Review requirement, so that completion is objectively assessable.
4. As a Steward user, I want one active Run per repository, so that two independent orchestration flows cannot mutate the same project accidentally.
5. As a Steward user, I want an existing active Run to block a new start, so that durable state is never overwritten implicitly.
6. As a Steward user, I want a code-changing Run to require a selected base revision and clean integration checkout, so that my unrelated local work is never hidden or absorbed.
7. As a Steward user, I want Herdr availability checked before launch, so that the Run never silently falls back to different lifecycle semantics.
8. As a Steward user, I want the Steward to create only the agents it controls, so that unrelated Herdr agents and panes remain untouched.
9. As a Steward user, I want agent-name collisions resolved with new Steward-owned names, so that existing resources are never adopted accidentally.
10. As a Steward user, I want model choices displayed before launch, so that the Controller Session's current model is never inherited silently.
11. As a Steward user, I want exact Builder and Reviewer models, thinking levels, and ordered fallbacks recorded, so that execution remains reproducible.
12. As a Steward user, I want unavailable or unauthenticated models detected before dispatch, so that Tasks pause before avoidable failures.
13. As a Steward user, I want project model defaults to remain editable but require confirmation for each Run, so that convenience does not remove control.
14. As a Steward user, I want every Run to freeze its effective configuration, so that later setting changes cannot alter active work unexpectedly.
15. As a Steward user, I want clearly disjoint Tasks to run concurrently, so that independent work completes efficiently.
16. As a Steward user, I want overlapping Task scopes serialized in approved order, so that the Steward does not require a general workflow engine or create predictable conflicts.
17. As a Steward user, I want each code-changing Builder to work in an isolated worktree, so that concurrent Builders cannot overwrite each other.
18. As a Steward user, I want a durable Assignment written before an agent is prompted, so that interrupted dispatch can be reconstructed safely.
19. As a Steward user, I want each Assignment tied to Run, Task, and Attempt identifiers, so that responses cannot be mistaken for another execution.
20. As a Steward user, I want each approved Assignment hashed, so that unexpected specification changes are detected before accepting results.
21. As a Steward user, I want agent outcomes written as durable Attempt Reports, so that transcripts are not the only record of work.
22. As a Steward user, I want Builder reports to identify produced revisions, Artifacts, checks, logs, and blockers, so that claims can be validated.
23. As a Steward user, I want Reviewer reports to identify the exact reviewed revision, verdict, findings, checks, and blockers, so that Approval cannot drift to other code.
24. As a Steward user, I want missing or malformed reports returned once to the same agent for repair, so that completed work is not repeated unnecessarily.
25. As a Steward user, I want a report with missing logs, commits, or Artifacts rejected, so that claims never outrank durable evidence.
26. As a Steward user, I want out-of-scope Builder changes preserved and shown, so that they can be corrected without deleting unexplained work.
27. As a Steward user, I want code Artifacts identified by base revision, head revision, commit range, and clean worktree state, so that Review covers exactly what may be integrated.
28. As a Steward user, I want non-Git Artifacts identified by path, size, and content hash, so that Review can bind to an immutable result.
29. As a Steward user, I want full command output retained in durable logs while reports remain concise, so that evidence survives without flooding Pi context.
30. As a Steward user, I want the Reviewer to use a separate Herdr agent, so that Review is independent from the Builder's conversation.
31. As a Steward user, I want the Reviewer to use a different provider family when an approved option is available, so that Review is meaningfully independent.
32. As a Steward user, I want same-family Review to require explicit authorization, so that independence is never weakened silently.
33. As a Steward user, I want Reviewer access treated as read-only and verified before and after Review, so that Review cannot mutate its own subject unnoticed.
34. As a Steward user, I want Reviewer modifications preserved but to invalidate the Review, so that the Steward never resets unexplained work.
35. As a Steward user, I want Review findings returned to the same Builder for a new revision, so that ownership remains clear.
36. As a Steward user, I want up to five review/rework cycles, so that ordinary corrections can complete without creating an endless loop.
37. As a Steward user, I want exhausted rework to require my attention, so that the system does not continue consuming resources without progress.
38. As a Steward user, I want transient provider, startup, Herdr, and process failures retried up to two times, so that temporary infrastructure problems do not derail the Run.
39. As a Steward user, I want tests, review findings, scope violations, and incorrect implementations treated as rework rather than transient retries, so that the Steward does not repeat bad work blindly.
40. As a Steward user, I want a silent agent inspected before it is disturbed, so that slow or partially completed work is preserved.
41. As a Steward user, I want silence to set `suspected-stall` rather than fail the Task, so that uncertain health does not become a false workflow conclusion.
42. As a Steward user, I want the same agent nudged and resumed before replacement, so that its context and partial progress remain useful.
43. As a Steward user, I want replacement agents to continue from the preserved worktree through linked Attempts, so that recovery does not restart from zero.
44. As a Steward user, I want same-agent inspection, nudging, and resume not to consume a retry, so that the retry budget measures actual replacement Attempts.
45. As a Steward user, I want a live test or build process marked `waiting-external`, so that quiet long-running commands are not mistaken for frozen models.
46. As a Steward user, I want the Steward to observe a live external process without sending prompts or interrupts, so that long-running verification is not disrupted.
47. As a Steward user, I want elapsed-time thresholds to notify rather than terminate, so that only explicit deadlines or cancellation can stop valid long-running work.
48. As a Steward user, I want a grace period after an external command exits, so that the agent can interpret results and write its report.
49. As a Steward user, I want temporary Herdr unavailability treated as degraded observability, so that active Attempts are not failed without evidence.
50. As a Steward user, I want the Steward to reconcile after compaction, restart, session takeover, and interrupted operations, so that it never continues from conversational memory alone.
51. As a Steward user, I want compaction hooks to improve continuity without being correctness-critical, so that a failed compaction hook cannot corrupt the Run.
52. As a Steward user, I want one Controller Session authorized to advance the Run, so that two sessions cannot dispatch or integrate concurrently.
53. As a Steward user, I want other sessions to view status without mutation authority, so that Run progress remains observable.
54. As a Steward user, I want explicit takeover to reconcile before replacing the Controller Session, so that recovery cannot duplicate side effects.
55. As a Steward user, I want continuous monitoring while the Controller Session is open, so that I do not need to repeatedly ask for worker and reviewer status.
56. As a Steward user, I want monitoring to observe only while Pi is handling a user turn or compaction, so that background activity cannot compete with the active controller turn.
57. As a Steward user, I want deterministic workflow actions to advance automatically when Pi reaches a safe idle point, so that completed Builders lead to Reviews without manual reminders.
58. As a Steward user, I want every intended transition persisted before dispatch, integration, interruption, or another side effect, so that crashes leave reconcilable intent.
59. As a Steward user, I want an interrupted dispatch reconciled against the assigned agent, report, and worktree before resending, so that the same Task is not executed twice accidentally.
60. As a Steward user, I want approved revisions integrated locally in the order I confirmed, so that finishing time cannot silently change project semantics.
61. As a Steward user, I want integration intent to record the target and approved revision range before Git mutation, so that interrupted integration can be reconciled.
62. As a Steward user, I want an already-integrated revision recognized after restart, so that it is never applied twice.
63. As a Steward user, I want partial or conflicted Git operations preserved and surfaced, so that the Steward never blindly aborts or resets them.
64. As a Steward user, I want an advanced target branch to trigger a new Builder revision and fresh Review when required, so that Review evidence remains valid.
65. As a Steward user, I want integration conflicts returned to the responsible Builder, so that semantic conflict resolution remains with the Task owner.
66. As a Steward user, I want deterministic final verification executed directly by the Steward, so that completion does not depend on a model's interpretation of its own checks.
67. As a Steward user, I want final verification logs and exit results stored durably, so that interrupted verification can be resumed or rerun safely.
68. As a Steward user, I want a code-changing Task without deterministic checks to require a recorded waiver, so that reduced assurance remains explicit.
69. As a Steward user, I want final verification failures returned to a clear Task owner for a new revision and Review, so that defects are corrected with provenance.
70. As a Steward user, I want multi-Task failures with unclear ownership preserved for my decision, so that the Steward does not guess or revert integrated work.
71. As a Steward user, I want verification-generated checkout changes preserved and shown, so that potentially important output is never deleted automatically.
72. As a Steward user, I want the Completion Gate to require valid Artifacts, required Approvals, exact integrated revisions, final verification, and no unresolved attention, so that `completed` has a dependable meaning.
73. As a Steward user, I want `/steward revise` to show and confirm an explicit delta, so that normal conversation cannot silently mutate the Run.
74. As a Steward user, I want Run revision to preserve unaffected completed Tasks while cancelling obsolete Attempts and invalidating affected evidence, so that requirement changes do not waste valid work.
75. As a Steward user, I want cancellation persisted before agents are interrupted, so that no further dispatch or integration can occur after cancellation.
76. As a Steward user, I want cancellation to preserve panes, sessions, worktrees, reports, and logs, so that interrupted work remains inspectable.
77. As a Steward user, I want completed and cancelled agents stopped gracefully, so that they stop consuming resources without losing evidence.
78. As a Steward user, I want cleanup to list only Steward-owned panes and worktrees and require confirmation, so that unrelated resources cannot be deleted.
79. As a Steward user, I want ordinary cleanup to retain archived Journals, Assignments, Attempt Reports, and logs, so that the Run remains auditable.
80. As a Steward user, I want project-local state excluded from Git and protected with user-only permissions where supported, so that sensitive orchestration data is not committed accidentally.
81. As a Steward user, I want warnings before full logs are displayed or exported, so that potentially sensitive content is not exposed casually.
82. As a Steward user, I want atomic Journal replacement with one previous valid snapshot, so that an interrupted write does not destroy the only workflow record.
83. As a Steward user, I want corrupt or unsupported Journal versions opened read-only, so that unfamiliar state is never guessed or mutated.
84. As a Steward user, I want `/steward status` to reconcile and show a compact Run summary, so that I can understand progress without reading agent transcripts.
85. As a Steward user, I want footer status and focused notifications for blocked, degraded, approval-required, and completed conditions, so that important changes are visible without a custom dashboard.
86. As a Steward user, I want `/steward config` to manage a small set of global timing and retry defaults, so that recovery behavior is adjustable without editing every Task.
87. As a Steward user, I want interactive approval and mutation commands limited to Pi's TUI in version one, so that unsupported host modes do not provide misleading partial behavior.
88. As a Steward user, I want Git push, deployment, force reset, discarded work, unrecognized resource deletion, and account or security changes to require separate authorization, so that the Steward remains a local orchestration tool.
89. As a Steward user, I want a concise chronological activity log, so that I can understand dispatches, lifecycle observations, failures, recoveries, and decisions without reconstructing them from transcripts.
90. As a Steward user, I want recovery to ignore the activity log and reconcile authoritative state instead, so that an incomplete audit entry cannot corrupt workflow progress.
91. As a Steward user, I want finalized Attempt evidence to remain unchanged, so that failed, interrupted, superseded, and successful Attempts cannot be rewritten into a different history.
92. As a Steward user, I want a confirmed maximum number of simultaneously active Tasks, so that disjoint work does not exhaust machine or provider resources.

## Implementation Decisions

- The product is a reusable Pi package whose initial runtime is a Pi extension. It creates Pi agents through Herdr and does not provide a daemon, standalone orchestration service, database, or alternate subagent fallback.
- The orchestration logic is a deep module with one small interface used by extension commands, Pi lifecycle handlers, and the session-scoped monitor. Pi UI behavior, Herdr command execution, durable storage, Git operations, filesystem inspection, process observation, model discovery, and time are injected adapters rather than hidden globals.
- The extension registers `/steward start`, `/steward status`, `/steward resume`, `/steward revise`, `/steward cancel`, `/steward cleanup`, and `/steward config`. Ordinary subagent activity is not intercepted.
- Full mutation behavior is available in interactive Pi TUI mode. Status may render plain output in other modes when possible, but approval, takeover, revision, cancellation, configuration, and cleanup require interactive confirmation.
- One repository may have at most one active Run. A Run has one Controller Session; other sessions are read-only until an explicit takeover reconciles and replaces controller identity.
- A Run contains a user-approved ordered Task list. Version one permits concurrency only for Tasks with clearly disjoint allowed scopes. Overlapping Tasks are serialized in approved order; there is no arbitrary dependency-graph engine.
- The accepted prototype establishes the state vocabulary:

  ```text
  Task phase: pending | building | reviewing | reworking | approved | integrating | completed | cancelled
  Attempt state: prepared | active | awaiting-report | reported | ended-error | superseded | cancelled
  Attention: none | blocked | waiting-external | suspected-stall | recovering | needs-user
  ```

- The Run Journal is a schema-versioned, project-local JSON snapshot. Writes validate a temporary snapshot, retain the previous valid snapshot, and atomically replace the active snapshot. Unsupported schemas or two invalid snapshots permit read-only status only.
- Assignments, Attempt Reports, logs, the activity log, and archived Run snapshots are separate durable files. The project-local Steward directory is ignored by Git, uses user-only permissions where supported, and is treated as potentially sensitive.
- The activity log is a concise append-only human audit of dispatches, lifecycle observations, evidence decisions, retries, replacements, Reviews, integrations, and completion. It is not replayed, cannot advance a Run, and never outranks the Run Journal, Herdr, Git, or Artifacts.
- Every Run freezes its effective configuration, target/base revision, ordered Task list, Controller Session, Model Plan, maximum active Task count, retry and rework budgets, and current workflow state.
- User-global configuration contains liveness intervals, external-command warning threshold, maximum active Tasks, two transient replacement retries, and five review/rework cycles. Project defaults contain Builder and Reviewer Model Plans and optional verification defaults. Active Runs do not change when defaults change.
- The Model Plan contains exact Builder and Reviewer provider/model references, thinking levels, and ordered fallbacks. The Controller Session's model is only a proposed value. Every Run requires confirmation, and every Assignment and Attempt Report records the actual model.
- Replacement Attempts may use only pre-approved model fallbacks. Review chooses the first available approved model from a provider family different from the model actually used by the Builder. Same-family Review requires explicit user authorization.
- Each code-changing Builder receives a Steward-owned isolated worktree. Reviewers inspect the same frozen revision and may run checks, but the Steward records and compares the worktree's head and dirty-state fingerprint before and after Review.
- Every Task defines only its identifier, required outcome, allowed scope, expected Artifacts, verification command or criteria, and whether Review is required. A missing deterministic verification command on a code-changing Task requires a durable user waiver.
- Every Assignment contains Run, Task, and Attempt identifiers, required outcome, allowed scope, report location, expected Artifacts, verification criteria, and specification hash. It is persisted before agent dispatch.
- Each Attempt owns a separate evidence directory. Files may be repaired while the Attempt is awaiting a valid report, but after the Steward finalizes the Attempt its report, referenced logs, and evidence are not overwritten; further work uses a linked replacement or rework Attempt.
- Every transition that precedes an external side effect is stored first. Reconciliation must run before any subsequent action after startup, reload, resume, takeover, compaction, interrupted dispatch, interrupted integration, interrupted verification, or degraded Herdr availability.
- Reconciliation follows a fixed evidence order: valid Attempt Report; working or blocked agent; settled agent without report; unclear live state; missing agent. Conversation text alone cannot advance the Run.
- The session-scoped monitor prefers Herdr lifecycle waits and uses slow reconciliation only as fallback. During a user turn or compaction it records observations only. At safe idle points it may reconcile and perform deterministic next actions. Significant observations and decisions are appended to the activity log after authoritative state is persisted; failure to append produces a diagnostic rather than changing workflow state.
- A settled agent without a report receives one request to produce it. A malformed report or report with missing referenced evidence receives one repair request. Continued absence or invalidity blocks the Task.
- Silence is not a Task failure. The recovery ladder is inspection, status nudge, soft interruption of a stuck generation, same-agent resume, then a linked replacement Attempt in the preserved worktree. Only replacement consumes the transient retry budget.
- A known live external process sets `waiting-external`. While it lives, the Steward does not nudge, interrupt, replace, or require output. Time thresholds notify only. After process exit, the agent receives a grace period before silence recovery begins.
- A Builder's code Artifact is the exact base-to-head commit range with a clean worktree. Non-Git Artifacts are identified by path, size, and SHA-256. Reports reference durable full logs rather than embedding large output.
- Scope verification occurs before Review. Out-of-scope changes, changed Assignments, Reviewer mutations, missing Artifacts, or unexplained external worktree changes are preserved and block or return the Task for correction; the Steward never resets them automatically.
- Review applies only to the exact immutable revision or Artifact identity recorded in the Reviewer report. The Reviewer report must contain an explicit `approved` or `changes-required` verdict; provider failure, process exit, silence, or Herdr lifecycle state is never a verdict. Approval is invalidated by any later revision change.
- Review-requested rework may repeat five times after the initial build and Review. Integration conflicts and attributable final-verification repairs consume the same rework budget.
- Approved revisions integrate locally and sequentially in the user's approved order. Before Git mutation, the target branch, target revision, exact approved range, and intended action are stored.
- Interrupted integration is reconciled by determining whether the exact range is already integrated, the target remains unchanged and the action is safe to retry, a partial/conflicted operation exists, or the target changed unexpectedly. Partial or unexplained states are preserved for user action.
- Final verification commands are executed directly by the Steward. Complete logs and exit results are durable. An interrupted verification waits on an identifiable live process, consumes a conclusive durable result, or reruns the deterministic command and records the recovery rerun.
- Completion requires every required Task to have valid evidence, every required Review to approve the exact current revision, approved revisions to be integrated, final verification to pass, the integration checkout to remain clean, and no unresolved cancellation, block, or attention condition.
- `/steward revise` creates a confirmed, versioned delta; cancels obsolete Attempts; invalidates affected evidence; and preserves unaffected completed Tasks. Ordinary conversation never modifies an active Run.
- Cancellation is persisted before active agents are interrupted. It prevents further dispatch and integration while preserving all evidence.
- On completion or cancellation, Steward-created agents stop gracefully, while their Pi sessions, panes, worktrees, and evidence remain available. Cleanup confirms and removes only recorded Steward-owned panes and worktrees. Archives and logs remain until explicitly deleted.
- The Steward may create and control its own local resources, commit locally, integrate locally, and execute approved verification. Push, deployment, force reset, discarded work, deletion of unrecognized resources, and account or security changes remain outside automatic authority.
- Verification remains part of safe orchestration rather than a separate ticket-quality product. The Steward executes Task-defined checks, validates referenced evidence, and runs final verification, but does not require or recreate Unlazy, a generic gate framework, or another work-quality manager.

## Testing Decisions

- Most tests exercise the orchestration module through the same commands and lifecycle actions used by the Pi extension, with simulated Herdr agents, repositories, processes, models, filesystem, and clock. Tests assert externally visible Run state, durable evidence, requested side effects, notifications, and blocked conditions rather than private helper behavior.
- A small number of focused contract tests exercise real Herdr command translation and parsing, plus real atomic Run Journal writes. Full real-agent end-to-end tests are not the primary suite because they are slow, nondeterministic, provider-dependent, and difficult to diagnose.
- Use a real temporary Git repository for the few behaviors where Git's actual state machine is the contract: exact commit ranges, integration replay detection, conflict preservation, dirty-state fingerprints, and advanced target revisions.
- Keep the primary behavior suite targeted to these scenarios:
  1. Start a confirmed Run, freeze its Model Plan and configuration, dispatch two disjoint Builders concurrently, Review exact revisions, integrate in approved order, run final checks, and pass the Completion Gate.
  2. Detect overlapping scopes and serialize those Tasks without constructing an arbitrary dependency graph.
  3. Interrupt after persisting dispatch intent but before confirmation; reconcile without creating duplicate work or consuming a retry.
  4. Drive a silent Attempt through inspection, nudge, same-agent resume, linked replacement, and `needs-user`, verifying that partial work survives and only replacements consume retries.
  5. Observe a quiet long-running test process, verifying that warnings never interrupt it and that normal stall recovery starts only after exit and grace.
  6. Reject out-of-scope changes, changed Assignments, missing referenced evidence, and Reviewer mutations while preserving every unexplained change.
  7. Enforce the confirmed Model Plan, approved fallback order, actual-model recording, and explicit same-family Review authorization.
  8. Interrupt integration at each reconcilable point: already applied, safely retryable, conflicted/partial, and unexplained target change.
  9. Interrupt final verification with a live process, a complete durable result, and no conclusive result; verify wait, consume, and recorded rerun behavior respectively.
  10. Enforce Controller Session ownership, read-only status from another session, reconciliation-before-takeover, monitor observe-only behavior during active Pi turns and compaction, and confirm that recovery remains correct with a missing or truncated activity log.
  11. Validate atomic Journal replacement, previous-snapshot recovery, unsupported-schema read-only mode, and two-invalid-snapshots read-only recovery.
  12. Revise, cancel, complete, and clean up a Run, verifying preservation of unaffected Tasks and removal of only recorded Steward-owned resources.
  13. Finalize an interrupted and a successful Attempt, verifying that later recovery or replacement preserves the original reports, logs, and evidence unchanged.
- Herdr adapter contract tests cover parsing and normalization of `working`, `blocked`, `idle`, `done`, and `unknown`; agent start/prompt/wait/read failures; name collisions; disappeared agents; pane moves; and temporary server unavailability.
- Run Journal storage contract tests cover schema validation, temporary-file validation, previous-snapshot preservation, atomic replacement, restrictive permissions where supported, and recovery after an interrupted write.
- Attempt Report validation tests cover required common and role-specific fields, specification hashes, exact Git revisions, non-Git hashes, referenced logs, malformed reports, and one repair opportunity.
- UI tests remain minimal: command routing, confirmation cancellation, compact status rendering, footer phase/attention counts, and the four notification classes. No snapshot-heavy custom dashboard testing is required.
- The existing static flow atlas remains a documentation consistency check rather than a product behavior test. Its current coverage, state-vocabulary, static-document, and accepted-design-section checks should continue to pass when the accepted design changes.

## Out of Scope

- A continuously running daemon or orchestration service.
- New orchestration decisions while Pi is not running.
- More than one active Run per repository.
- Arbitrary Task dependency graphs, generic workflow definitions, priorities, estimates, or project-management features.
- Automatic interception or adoption of ordinary subagents, existing Herdr agents, panes, or worktrees.
- Non-Pi Builder or Reviewer agent kinds in version one.
- Automatic fallback to Pi subagents or another execution system when Herdr is unavailable.
- Full behavior in Pi RPC, JSON, or print modes; only plain status output may be offered where practical.
- A custom dashboard, complex TUI application, web interface, or remote service.
- Exactly-once distributed execution guarantees. Recovery uses durable intent, idempotent reconciliation, and linked Attempts.
- Automatic Git push, deployment, remote branch mutation, force reset, force cleanup, discarded work, credential changes, or account/security administration.
- Automatic conflict resolution, automatic reset or revert of partial Git operations, or deletion of unexplained files.
- Silent inheritance of models, unapproved model fallbacks, or silent weakening of Reviewer independence.
- A persistent archive-retention or log-pruning subsystem in version one.
- A ticket-quality manager, mandatory `GATES.md` format, required Unlazy integration, or generic acceptance-gate framework.
- Event sourcing, a database, distributed locks, controller leases, or multi-controller consensus. The human-readable activity log is an audit trail, not an event source.
- Comprehensive end-to-end tests that depend on paid model providers for ordinary CI.

## Further Notes

- The domain glossary defines Run, Task, Attempt, Assignment, Builder, Reviewer, Run Journal, Controller Session, Artifact, Attempt Report, Review, Approval, Reconciliation, and Completion Gate. Implementation and tests should use those terms consistently.
- The accepted ADRs require separation of live state from workflow truth, controller-owned decisions, project-local Steward-owned runtime state, persistence before side effects, recoverable treatment of silence, a Pi extension rather than daemon, one session-scoped Controller Session, Pi agents in version one, an explicit Model Plan, and explicit Run revision.
- The static flow atlas enumerates 70 accepted behavior and recovery cases. It is useful for implementation wayfinding, but the automated suite should stay focused on the risk-concentrated scenarios listed above rather than creating one test per diagram case.
- GitHub publishing is currently unavailable because this repository has no remote and the configured GitHub CLI credential is invalid. This spec is therefore published to the local Markdown issue tracker with `ready-for-agent` status.
