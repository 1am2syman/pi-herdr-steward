# Pi Herdr Steward

Pi Herdr Steward is a reusable Pi extension that coordinates one explicitly
confirmed, project-local Run through Herdr. Run state and evidence stay in the
repository so the controller can reconcile durable facts after interruption.

## Prerequisites

The tested minimum host is Node `>=22.19.0` with `@earendil-works/pi-coding-agent`
(Pi) compatible with `^0.84.4`. `pi`, `herdr`, and `git` must be on `PATH`.
Herdr must have a running endpoint-compatible server with the `pi` agent kind.
All mutating and confirming commands require an interactive Pi TUI.

A code-changing Run also requires an existing Git repository, a selected branch
and HEAD, a clean integration checkout, and a locally configured Git identity
where commits will be produced. A real Run needs authenticated, available
models selected in its confirmed Model Plan. The repository smoke is offline,
uses fake adapters, and makes no provider request.

## Installation

After publication, the pinned npm source is:

```bash
pi install npm:pi-herdr-steward@0.1.0 -l
```

The version must exist in the npm registry. The supported immutable Git source
shape is:

```bash
pi install git:<host>/<owner>/pi-herdr-steward@<immutable-ref> -l
```

Replace `<host>/<owner>` with the eventual canonical remote and use a release
tag or full commit SHA; an unpinned branch is not reproducible. This checkout
has no configured Git remote, so the example is intentionally parameterized and
is not claimed to resolve here.

For local validation, install the current checkout by absolute path:

```bash
pi install /absolute/path/to/pi-herdr-steward -l
```

This local-checkout form is the only end-to-end install source available before publication. `-l` writes project-local Pi package configuration in `.pi`; omit
it only when a user-global installation is intended.

## Command surface

Version one is fully supported in interactive TUI mode. It does not provide a
separate CLI, daemon, dashboard, or automatic interception of ordinary agents.

- `/steward status` — read current or archived facts and advance deterministic
  Controller-owned work when the caller is authorized.
- `/steward config` — edit the small operational defaults and project Model Plan
  defaults.
- `/steward start` — draft, display, and explicitly confirm one Run before
  persistence and dispatch.
- `/steward revise` — draft and confirm an explicit delta while retaining
  unaffected work.
- `/steward resume` and `/steward resume --takeover` — reconcile before
  continuing, with explicit ownership transfer for another Controller Session.
- `/steward cancel` — persist cancellation before gracefully stopping
  Steward-owned agents and archive the cancelled Run.
- `/steward cleanup` — show exact retained Steward-owned panes and worktrees,
  require confirmation, and remove only those live resources while retaining
  historical evidence.

## Authority and Model Plan

Authority is ordered by durable responsibility: the Run Journal owns intended
workflow progress; Herdr owns live agent and process state; Git plus durable
Artifacts own produced and reviewed work. Pi context, transcripts, compaction
summaries, agent claims, and the activity log do not independently advance a
Run.

Every Run displays and confirms exact `provider/model-id`, thinking level, and
ordered fallbacks for Builder and Reviewer. That choice is frozen into the Run;
actual models are recorded. Reviewer independence prefers a different provider
family, and any same-family exception is explicit.

## Evidence and recovery

Under `.pi/steward/`, the authoritative locations are:

```text
active-run.json
active-run.previous.json
runs/<run-id>/activity.log
runs/<run-id>/tasks/<task-id>/attempts/<attempt-id>/{assignment.json,report.md,evidence/}
runs/<run-id>/completion/final-verification/<verification-id>/{output.log,result.json}
archives/<run-id>/
```

The directory self-ignores, is user-only where supported, and remains until
the user explicitly deletes history. The activity log is chronological human
audit only: append failure degrades diagnostics, and recovery never replays it
or treats it as workflow truth.

Recovery reconciles the Journal, Herdr, Git, reports, and Artifacts before
acting. It persists intent before side effects, inspects silence and live
external processes, preserves conflicts, unknown files, partial work, dirty
verification output, and unfamiliar or corrupt snapshots, and requires explicit
takeover, migration, rework, or user decisions where the design calls for them.

Assignments, prompts, reports, terminal output, diffs, model identifiers, and
verification logs can contain source or secrets. Keep `.pi/steward/` private,
inspect it before sharing, and do not export full logs casually.

## Safety limits

The Steward may create its own Herdr panes and worktrees, start only its own Pi
agents, make local commits, integrate approved ranges locally, run approved
deterministic checks, and gracefully stop its own agents.

It never pushes or deploys, force-resets, stashes or incorporates unrelated
changes, discards or reverts unexplained work, deletes or adopts foreign
resources, substitutes a provider or model outside the confirmed plan, or
changes accounts, credentials, or security settings without separate explicit
authorization. Cleanup retains archives, reports, Assignments, verification
evidence, branches, commits, and Pi sessions as described by the implementation.
