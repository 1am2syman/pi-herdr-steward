# Ticket 02 Attempt Report

## Outcome

Implemented `/steward config` narrowly against the ticket-01 package. The command now loads and presents user-global recovery defaults and project-local Builder/Reviewer Model Plans, edits one scope per confirmed action, validates exact model/auth/availability/scope/thinking choices, atomically persists schema-versioned JSON, and reloads the saved scope for confirmation.

## Changed files

- `package.json`
- `src/config.ts`
- `src/config-store.ts`
- `src/steward.ts`
- `src/adapters.ts`
- `src/extension.ts`
- `test/config.functional.test.ts`
- `test/status.empty-run.functional.test.ts` (harness/type adjustments only)

The authoritative plan was not modified. No ticket-03+ behavior was added.

## Implemented invariants

- User file: `<getAgentDir()>/steward/defaults.json`.
- Project file: `<ctx.cwd>/<CONFIG_DIR_NAME>/steward/defaults.json`.
- Seven recovery values are integer seconds/limits with built-ins `300/300/120/1800`, active-task baseline `1`, retry ceiling `2`, and rework ceiling `5`.
- Project saves create `.gitignore` with exact `*\n`; config and sentinel writes use unique same-directory `0600` temporary files, sync, close, and rename.
- Missing files produce built-in recovery or visibly `not configured` project state. Unknown keys, malformed JSON, and unsupported schema versions diagnose with paths and do not auto-repair.
- Model validation uses exact first-slash parsing, exact registry lookup, auth resolution without persistence, exact available/scoped membership, and explicit thinking support checks. It does not clamp, fuzzy-match, substitute, reorder, or promote fallbacks.
- Controller Session model is shown separately as a Builder proposal and requires explicit confirmation before copying.
- Configuration dispatch refuses `rpc`, `json`, and `print` before adapter construction/I/O with `Steward configuration requires interactive TUI mode.`

## Rework diagnosis and fix

The parent gate failure is preserved in `logs/test-config-t02.log` and `logs/test-t02.log`: the concurrent targeted/full Vitest launch timed out the same first two registered-command filesystem tests at the default 5,000 ms, while the model-diagnostic and non-TUI tests passed. The test bodies are not stuck in production code: isolated runs are fast, and the failure was reproduced when Vitest workers competed for host CPU/filesystem time. Before the fix, four concurrent full invocations also stretched the config file's measured test time to about 6.5 seconds, confirming sensitivity to host contention even when the run completed.

The rework changes only `test/config.functional.test.ts`. The two tests that cover registered save/reload, atomic writes, recursive filesystem snapshots, and cancellation no-ops now have an explicit 15,000 ms per-test timeout. All assertions, fixtures, registered-handler calls, and production behavior are unchanged. This keeps the failure visible if the legitimate filesystem flow exceeds the expanded budget while preventing the host's contention from turning a passing acceptance test into a false timeout.

Rework evidence is retained in `logs/npm-test-rework-concurrent-*.log`, `logs/npm-test-config-rework-concurrent.log`, and `logs/npm-test-full-rework-concurrent.log`.

## Verification evidence

All final commands below were run sequentially from the package root; complete output is retained in `logs/`:

- `npm ci` — pass; `logs/npm-ci-t02-final.log`
- `npm run typecheck` — pass; `logs/typecheck-t02-final.log`
- `npm run test:config` — 4 tests passed; `logs/test-config-t02-final.log`
- `npm test` — 2 files / 5 tests passed; `logs/test-t02-final.log`
- `git diff --check` — pass; `logs/diff-check-t02-final.log`
- `npm pack --dry-run --json` — pass; `logs/pack-dry-run-t02-final.json`
- Package contents inspected in `logs/pack-contents-t02-final.log`: exactly `package.json` and the five runtime `src/*.ts` files; no tests, plans, temp config, or credentials.
- Direct extension import — pass; `logs/host-import-t02.log`
- RPC `get_commands` registration — pass; `logs/rpc-get-commands-t02-final.log`
- RPC `/steward config` rejection — exact TUI-only diagnostic; `logs/rpc-config-rejection-t02-final.log`
- Interactive Pi TUI load/cancel — initial summary showed exact paths, all seven defaults, `not configured`, and a separate Controller proposal; Escape produced `Cancelled; configuration unchanged.`; `logs/manual-tui-t02.log`
- Rework `npm run typecheck` — pass; `logs/typecheck-t02-rework-final.log`
- Rework `npm run test:config` — 4 tests passed; `logs/test-config-t02-rework-final.log`
- Rework normal `npm test` — 2 files / 5 tests passed; `logs/test-t02-rework-final.log`
- Rework `git diff --check` — pass; `logs/diff-check-t02-rework-final.log`
- Rework `npm pack --dry-run --json` — pass; `logs/pack-dry-run-t02-rework-final.json`; inspected contents are exactly the six listed package files and no tests/plans/logs/temp config/credentials.

## Failed attempts preserved

- Initial `npm ci` failed in the sandbox with registry DNS `EAI_AGAIN`; the successful escalated install is recorded above.
- Initial pack dry-run could not write npm’s root log under the sandbox; the successful escalated pack evidence is recorded above.
- One evidence command launched targeted and full Vitest concurrently; the resulting worker contention caused timeouts in two config tests. The failed logs remain as `logs/test-config-t02.log` and `logs/test-t02.log`. Sequential reruns are green as listed above.

## Review handoff

Worker status must be advanced to `review_ready` only after the implementation commit is created. The independent reviewer is responsible for the pass/changes-required verdict.
