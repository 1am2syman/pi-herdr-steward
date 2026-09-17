# Ticket 04 Attempt Report

Date: 2026-09-17
Worker branch: `steward/t04-dispatch-builder`
Scope: dispatch exactly one initial Builder Attempt from the existing TUI-only `/steward start` flow.

## Implementation

- Added strict Assignment, Attempt, dispatch-intent, serialization, hashing, prompt, and journal-transition domain logic.
- Added deterministic protected Assignment storage with `0600` bytes, `0700` Steward-owned directories, fsync, temporary-file cleanup, hard-link no-clobber creation, byte-identical reuse, and conflict detection.
- Extended the existing `runJournal` slot with Assignment and replacement operations; retained exactly seven top-level production adapter slots.
- Added Herdr command-array adapters for linked worktree creation, named Pi start with exact model/thinking arguments, and one-value prompt submission. Malformed, wrong, killed, and contradictory envelopes are rejected; only the exact normalized `cli:agent:start` plus `agent_name_taken` error is a name collision.
- Added isolated branch/name collision handling, clean selected-base verification, durable intent-before-effect transitions, failure preservation, active Attempt projection, and explicit no-completion-inference status text.
- Added registered functional coverage through `registerStewardExtension` and real durable stores, Herdr command-contract coverage, Assignment storage coverage, and failure-phase coverage.
- The accepted plan file remains unchanged and untracked: `plans/04-dispatch-one-builder-durably.md`.

## Sequential verification

Commands were run from `/root/.herdr/worktrees/pi-herdr-steward/steward-t04-dispatch-builder` in order. Full command output is preserved in the listed ticket-specific logs.

| Command | Result |
| --- | --- |
| `npm ci` | PASS; 183 packages added, 0 vulnerabilities. npm reported existing deprecation/allow-scripts warnings. `logs/04-final-npm-ci.log` |
| `npm run typecheck` | PASS. `logs/04-final-typecheck.log` |
| `npm run test:dispatch` | PASS; 5 tests. The suite is registered-handler based and uses real durable stores. `logs/04-final-test-dispatch.log`, `logs/04-final-dispatch-failure-coverage.log` |
| `npm run test:herdr` | PASS; 3 tests. `logs/04-final-test-herdr.log` |
| `npm run test:start` | Earlier final attempt PASS; 10 tests. A later standalone attempt hit broader host filesystem contention (6 configured tests timed out); bounded retry PASS, all 10 tests. Outputs are preserved in `logs/04-final-test-start.log`, `logs/04-final3-test-start.log`, and `logs/04-final3-test-start-retry.log`. |
| `npm run test:storage` | PASS; 6 tests. `logs/04-final-test-storage.log` |
| `npm run test:config` | First run hit the known filesystem-heavy host-contention timeout in 2 configured 15-second tests; bounded retry PASS, 4 tests. Fail and retry are preserved in `logs/04-final-test-config.log` and `logs/04-final-test-config-retry.log`. |
| `npm test` | PASS in the first final sequential set; 6 files, 29 tests, using the package script's serialized `vitest run --maxWorkers=1`. The initial parallel invocation timed out under host contention; the failed parallel run and an intermediate unsupported-option attempt are preserved in `logs/04-npm-test.log` and `logs/04-npm-test-retry.log`. Passing serialized output: `logs/04-final-npm-test.log`. Later standalone/grouped retries were also run to satisfy the final rerun after evidence edits; they encountered broader host contention and are preserved in `logs/04-final4-npm-test.log` and `logs/04-final-rerun-retry.log`. |
| `git diff --check` | PASS. `logs/04-final-diff-check.log` |
| `git diff --stat`, `git status --short --branch`, `git diff -- plans/04-dispatch-one-builder-durably.md` | Scope audit shows only ticket-04 runtime/tests/package scripts/evidence plus the unchanged untracked plan. Plan diff is empty. `logs/04-final-scope-status.log` |
| `npm pack --dry-run --json` | PASS; exactly 10 runtime package files, including `src/assignment-store.ts`; no tests, plans, reports, logs, journals, or credentials. `logs/04-final2-pack.log` |

The serialized full-suite script is a test-runner scheduling adjustment only; it does not weaken assertions or omit suites. The initial parallel timeout evidence is retained.

## Host checks

- `node --experimental-strip-types -e 'import("./src/extension.ts")...'`: PASS, `extension-import-ok`; `logs/04-final-host-import.log`.
- Fresh offline RPC host load: registered exactly one `steward` command, `/steward start` returned the exact interactive-TUI refusal, and the fresh project had no `.pi/steward` state. `logs/04-rpc-host.log`.
- Interactive TUI smoke in an isolated temporary directory: `/steward status` rendered `steward: no active Run`; no paid/live Builder was launched. `logs/04-final-tui-smoke.log` and `logs/04-final-tui-state.log`. The host emitted the existing offline `fd not found` warning.
- Read-only host checks: `pi --version` `0.84.4`, `herdr --version` `0.9.0`, healthy `herdr status server --json`, and `herdr worktree --help`/`herdr agent --help`. Logs: `logs/04-final-pi-version.log`, `logs/04-final-herdr-version.log`, `logs/04-final-herdr-status.log`, `logs/04-final-herdr-worktree-help.log`, `logs/04-final-herdr-agent-help.log`.

No live Herdr worktree or agent was created for acceptance. No POSIX permission limitation occurred: protected Assignment mode and Steward-owned directory modes were asserted by tests.

Final required rerun, exactly as specified: `npm run typecheck && npm run test:dispatch && npm run test:herdr && npm run test:storage && npm test && git diff --check`. The first final sequential set passed with 5 dispatch tests, 3 Herdr tests, 6 storage tests, 29 full-suite tests, and diff check; the subsequent grouped retry was blocked by transient host filesystem contention (dispatch/storage/start timeouts), while separately retried dispatch and storage passed. All results are preserved in `logs/04-final-rerun.log`, `logs/04-final-rerun-retry.log`, `logs/04-final4-test-dispatch.log`, `logs/04-final4-test-storage.log`, and `logs/04-final4-npm-test.log`.

After the final strictness hardening (Task-hash cross-check and Assignment mode check), typecheck, dispatch (5), Herdr (3), and storage (6) passed. The subsequent serialized full-suite attempt again had only the two known config filesystem tests time out (27/29 completed); the immediate standalone config retry passed all 4. These outputs are in `logs/04-final5-typecheck.log`, `logs/04-final5-storage-dispatch.log`, `logs/04-final5-herdr.log`, `logs/04-final5-npm-test.log`, and `logs/04-final5-config-retry.log`.

## Reviewer rework

Independent review identified two test-only coverage gaps in revision `72ba33d8cbe6a0e6eabe3033b2e8837bb7125a0f`:

- The existing ticket-03 confirmed-start assertions were guarded only for the old `started`/`started-with-warning` outcomes. `test/start.functional.test.ts` now accepts the legitimate minimal-fake `started-dispatch-pending` result and asserts its pending-dispatch message before running every existing summary, hash, revision-1, call-count, activity, and `0600` assertion.
- The Herdr rejection test no longer slices its table. Every prior rejection row is exercised, and explicit killed, exit-2 syntax, thrown-runner, and contradictory success-shaped identity rows cover worktree, agent-start, and prompt translations as applicable. Exact command-array assertions remain unchanged.

Rework verification, run sequentially from this worktree:

| Command | Result |
| --- | --- |
| `npm run test:start` | PASS; 10 tests. `logs/04-rework-test-start.log` |
| `npm run test:herdr` | PASS; 3 tests with all nested rejection rows executed. `logs/04-rework-test-herdr.log` |
| `npm run test:dispatch` | PASS; 5 tests. `logs/04-rework-test-dispatch.log` |
| `npm run typecheck` | PASS. `logs/04-rework-typecheck.log` |
| `npm test` | First attempt: 28/29 completed, one registered dispatch test timed out under host contention. Bounded retry PASS; 6 files, 29 tests. Logs: `logs/04-rework-npm-test.log`, `logs/04-rework-npm-test-retry.log`. |
| `git diff --check` | PASS after final staged scope audit. |

No production files were changed in this rework. The only implementation diff is the two requested test files; this report and the `04-rework-*` logs are the only evidence additions. The reviewer report and accepted plan remain untracked and were not committed.
