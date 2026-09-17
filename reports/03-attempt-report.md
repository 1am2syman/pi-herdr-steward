# Ticket 03 attempt report

## Scope

Implemented `/steward start` on the ticket-01/02 seams. The change keeps one registered `steward` command and seven top-level adapter slots (`runJournal`, `herdr`, `git`, `process`, `model`, `clock`, `ui`). Start only creates a confirmed schema-version-1 Run Journal and its non-authoritative activity entry; it does not launch agents or create Herdr resources.

The authoritative plan remains unchanged and untracked at `plans/03-confirm-and-persist-a-new-run.md`.

## Implementation evidence

- `src/run.ts` owns the exact Run/Task/Model Plan/effective-settings contracts, strict validation, deterministic serialization, specification hashes, deep copies, identity generation, and confirmation summary.
- `src/project-state.ts` owns the protected project-local Steward directory and exact `*\n` sentinel.
- `src/run-journal-store.ts` owns strict loading, exclusive initial creation, validated replacement with immediate previous snapshots, temporary-file cleanup, and append-only JSONL activity.
- `src/steward.ts`, `src/adapters.ts`, and `src/extension.ts` enforce the TUI-only phase order, repeated read-only preflights, explicit confirmation/cancellation, and result presentation.
- `test/start.functional.test.ts` covers success, drafting/final cancellation, non-TUI refusal before factory construction, active-run and Herdr refusal, Model Plan and Git refusal, post-confirmation active/Herdr/model/Git changes, activity degradation, and the exclusive creation race.
- `test/run-journal.storage.test.ts` covers exact protected creation, concurrent no-clobber creation, A→B→C immediate previous semantics, malformed/hash/identity/revision/current-invalid candidates, and sampled large atomic reads.

## Sequential verification

Commands were run sequentially from this worktree; Vitest processes were not run concurrently.

| Command | Result | Evidence |
| --- | --- | --- |
| `npm ci` | First restricted attempt failed with transient `EAI_AGAIN`; retry succeeded, 183 packages audited, 0 vulnerabilities | `logs/npm-ci-t03-first-failure.log`, `logs/npm-ci-t03-final.log`, `logs/npm-ci-t03-final-retry-2.log` |
| `npm run typecheck` | Passed | `logs/typecheck-t03-final.log` |
| `npm run test:start` | 1 file, 10 tests passed | `logs/test-start-t03-final.log` |
| `npm run test:storage` | 1 file, 5 tests passed | `logs/test-storage-t03-final.log` |
| `npm run test:config` | 1 file, 4 tests passed | `logs/test-config-t03-final.log` |
| `npm test` | 4 files, 20 tests passed | `logs/test-full-t03-final.log` |
| `npm pack --dry-run --json` | Passed; exactly 9 intended package/runtime files, no tests/plans/reports/logs/journals | `logs/pack-dry-run-t03-final.log` |
| direct extension import | `extension-import-ok` | `logs/host-import-t03-final.log` |
| RPC host load and `/steward start` | Updated Steward command was registered; exact TUI-only error returned; project Steward state remained absent | `logs/rpc-start-t03-final.log`, `logs/rpc-start-tree-t03-final.log` |
| interactive TUI smoke | Production `/steward start` reached the Herdr refusal; no project Steward state was created | `logs/tui-smoke-t03.log` |
| `herdr status server --json` | Read-only healthy response: running, compatible, endpoint-compatible, protocol 22 | `logs/herdr-status-t03-final.log` |
| `git diff --check` | Passed for the staged diff and worktree | terminal verification |

The TUI smoke's `pi.exec` call received `PermissionDenied` for the Herdr socket in the host sandbox, so it correctly stopped before the draft UI. The registered functional tests exercise the successful fake-adapter flow and both cancellation paths without launching an agent. No Herdr agent, pane, tab, workspace, worktree, or controller resource was created by this implementation or verification.

## Handoff

Package identity and runtime dependency policy are unchanged. No design/ADR/context/earlier-plan file was edited. The worktree should contain only the unchanged untracked authoritative plan after the focused commit; the independent Pi/ZAI reviewer must verify the committed revision against the plan and certify the gates.
