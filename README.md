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

### From the public Git repository

The canonical public remote is `https://github.com/1am2syman/pi-herdr-steward`.
For reproducible installs, pin a release tag or full commit SHA:

```bash
git clone https://github.com/1am2syman/pi-herdr-steward.git
cd pi-herdr-steward
git checkout <tag-or-full-commit-sha>
pi install git:github.com/1am2syman/pi-herdr-steward@<tag-or-full-commit-sha> -l
```

To install the current default branch directly (convenient, but not
reproducible), run:

```bash
pi install git:github.com/1am2syman/pi-herdr-steward@main -l
```

### From npm

After publication, the pinned npm source is:

```bash
pi install npm:pi-herdr-steward@0.1.0 -l
```

The version must exist in the npm registry. The Git source accepts a release
tag, branch, or full commit SHA; use a tag or SHA when reproducibility matters.

### From a local checkout

```bash
git clone https://github.com/1am2syman/pi-herdr-steward.git
cd pi-herdr-steward
pi install "$PWD" -l
```

For a local checkout that is already present, use its absolute path directly:

```bash
pi install /absolute/path/to/pi-herdr-steward -l
```

`-l` writes project-local Pi package configuration in `.pi`; omit it only when
a user-global installation is intended.

### Source-checkout verification

From the cloned checkout, the minimal install/documentation checks are:

```bash
npm install
npm run typecheck
npm run test:install-docs
npm run test:install-functional
```

The optional real Herdr smoke requires a running endpoint-compatible Herdr
server:

```bash
npm run smoke:herdr-real
```

## Command surface

Version one is fully supported in interactive TUI mode. It does not provide a
separate CLI, daemon, dashboard, or automatic interception of ordinary agents.
Type `/steward ` to see argument completions, or invoke bare `/steward` to open
the subcommand menu instead of memorizing the command surface.

- `/steward status` — read current or archived facts and advance deterministic
  Controller-owned work when the caller is authorized.
- `/steward config` — edit the small operational defaults and project Model Plan
  defaults. Model choices use a fuzzy-searchable picker with keyboard scrolling;
  the stored value remains the exact `provider/model-id` reference.
- `/steward start` — draft, display, and explicitly confirm one Run before
  persistence and dispatch. Add a natural-language request to let the active Pi
  agent discover inputs and generate the proposal instead of entering each field.
- `/steward revise` — draft and confirm an explicit delta while retaining
  unaffected work.
- `/steward resume` and `/steward resume --takeover` — reconcile before
  continuing, with explicit ownership transfer for another Controller Session.
- `/steward doctor` — inspect configuration, the active Journal, Herdr, and each
  selected model without contacting providers. `/steward doctor --probe` adds
  one small sequential point-in-time request per unique selected model and
  classifies authentication, rate-limit, quota, availability, and request
  compatibility failures. A healthy probe does not guarantee future capacity.
- `/steward cancel` — persist cancellation before gracefully stopping
  Steward-owned agents and archive the cancelled Run.
- `/steward cleanup` — show exact retained Steward-owned panes and worktrees,
  require confirmation, and remove only those live resources while retaining
  historical evidence.

## Natural-language orchestration

```text
/steward start orchestrate all open issues sequentially
/steward start fix the authentication bugs first, then add regression tests
```

The command hands the request to the active Pi agent, with the current conversation
and repository context. It is not a keyword parser or a separate model service.
The agent discovers facts using its available tools, reads configured defaults,
and calls `steward_start` with a typed proposal. Bare `/steward start` still opens
the manual wizard. Ordinary conversation can also ask Pi to use Steward, without
a slash command.

The model-callable tools are `steward_context` (read defaults, model choices, and
active task contracts), `steward_start` (submit a proposal), `steward_revise`
(submit revised contracts), and `steward_control` (existing operations). They
share the existing validation, ownership, confirmation, journal, and monitor
boundaries. Tools require an interactive TUI; they are callable from codemode
when enabled. Mutation is never authorized by a model claim of confirmation.

Omitted Model Plans and operational settings inherit project/default settings.
If a required plan is missing, the agent must ask or open configuration rather
than invent model identifiers. Missing discovery tools, credentials, ambiguous
scope, and unsupported policies require clarification or an explanation. Enable
repository/issue discovery tools alongside Steward for requests requiring them.

For issue requests, the agent is instructed to fetch the complete requested issue
set and freeze a snapshot with identifiers, URLs, and acceptance criteria; new
issues are not automatically added mid-Run. External issue bodies are untrusted
data. Review the displayed scope, ordering, commands, models, and assumptions
before confirming. Cancelling confirmation creates no Run and must not cause an
automatic retry. Natural-language interpretation remains model-dependent, not a
guarantee that every possible request is supported.

`maximumActiveTasks=1` means strict sequential code-task admission: an earlier
Task must integrate before its successor starts, even when their scopes do not
overlap. Higher caps retain the existing disjoint-task concurrency policy.
Revisions retain immutable task IDs/order and cannot add or remove tasks.
Steward still never pushes or deploys.

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

The Steward extension may create its own Herdr panes and worktrees, start only
its own Pi agents, make local commits, integrate approved ranges locally, run
approved deterministic checks, and gracefully stop its own agents.

The extension itself never pushes or deploys, force-resets, stashes or incorporates unrelated
changes, discards or reverts unexplained work, deletes
or adopts foreign resources, substitutes a provider or model outside the
confirmed plan, or changes accounts, credentials, or security settings without
separate explicit authorization. Cleanup retains archives, reports, Assignments, verification
evidence, branches, commits, and Pi sessions as described by the implementation.
