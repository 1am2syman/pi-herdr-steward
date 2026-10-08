# Natural-language Steward: real-TUI smoke

Environment: Pi 1.1.0, live Herdr, active cliproxyapi/gpt-5.5 controller, isolated temporary Git repositories. The local source extension was loaded explicitly with discovery disabled; no mock UI or fake provider was used. Automated regression checks target the package minimum Pi 0.84.4.

## Intake checks

- `/steward start prepare a read-only repository inventory as one evidence-only task scoped to reports, with criteria verification and required review. Use configured models and defaults. Show confirmation; do not carry out the task yourself.`
- The active agent called `steward_context`, discovered repository facts, generated a typed `steward_start` proposal, and opened **Confirm Steward Run** without the manual field wizard.
- Escape cancelled the proposal. The agent reported cancellation rather than retrying; no active-run.json was created. This was repeated against the final TypeBox-based source build.
- An ordinary conversational request to use Steward for a code-changing smoke.txt task also reached confirmation. The displayed proposal included configured models, git-commit/file artifacts, required review, and verification commands.
- Accepting persisted the Run and launched a real Builder in a Steward-owned worktree. The Builder produced smoke.txt and a local commit.

## Existing orchestration limitations observed

The accepted code-task smoke did **not** complete the full build/review/integration cycle. The installed Herdr start response did not satisfy the existing adapter strict acknowledgement contract; dispatch reported a malformed/contradictory Builder start envelope and entered the existing recovery path. Recovery observed the live Builder and requested its report, but the Run remained awaiting evidence.

A subsequent natural-language `steward_control` cancel request reached the existing explicit cancellation dialog. After approval, journal validation refused cancellation with: `Monitor checkpoint must identify the current proven Attempt and its exact recorded Herdr resource.` No destructive fallback was used. These are existing engine/adapter integration defects, not bypassed by the new intake layer.

The test Controller and Builder were gracefully stopped with `/quit`, and the exact smoke-created Herdr workspace/pane were closed. Evidence, the temporary repository, worktree, and local commit were retained for inspection. No project branch was pushed by Steward, and no deployment was attempted.

This smoke proves natural-language handoff, typed tool invocation, confirmation/cancellation, and persistence into existing orchestration. It is not evidence of successful end-to-end orchestration on this installed Herdr version.
