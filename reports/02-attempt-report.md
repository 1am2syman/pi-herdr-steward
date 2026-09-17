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

## Failed attempts preserved

- Initial `npm ci` failed in the sandbox with registry DNS `EAI_AGAIN`; the successful escalated install is recorded above.
- Initial pack dry-run could not write npm’s root log under the sandbox; the successful escalated pack evidence is recorded above.
- One evidence command launched targeted and full Vitest concurrently; the resulting worker contention caused timeouts in two config tests. The failed logs remain as `logs/test-config-t02.log` and `logs/test-t02.log`. Sequential reruns are green as listed above.

## Review handoff

Worker status must be advanced to `review_ready` only after the implementation commit is created. The independent reviewer is responsible for the pass/changes-required verdict.
