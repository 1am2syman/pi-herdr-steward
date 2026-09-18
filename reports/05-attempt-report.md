# Ticket 05 — Builder Attempt Report

Status: completed

This revision implements the accepted ticket-05 plan narrowly on the ticket-04 controller-session/status path. It adds strict canonical Builder Attempt Report parsing and immutable Assignment/Task/Attempt/model/specification cross-validation; read-only Git commit-range, rename/copy, cleanliness, and allowed-scope checks; bounded safe evidence reads with stable size/SHA-256 checks; atomic protected finalized snapshots; durable rejection, finalization-intended, and finalized Journal states; and registered functional/real-Git/storage coverage.

The implementation does not add commands, flags, tools, monitors, daemons, hidden callbacks, Reviewer launch/parsing, approval, integration, final verification, resume/rework/retry policy, or cleanup. It does not launch a live Builder, mutate Herdr, or run provider tests. The production adapter still has exactly seven top-level slots; evidence methods remain nested in the existing Run Journal adapter seam.

## Verification gates

| Gate | Command | Result |
| --- | --- | --- |
| Dependencies | `npm ci` | PASS; 183 packages added, 0 vulnerabilities |
| Typecheck | `npm run typecheck` | PASS |
| Evidence suite | `npm run test:evidence` | PASS; 1 file, 4 tests |
| Git contract | `npm run test:git` | PASS; 1 file, 2 tests |
| Dispatch regression | `npm run test:dispatch` | PASS; 1 file, 5 tests |
| Herdr adapter regression | `npm run test:herdr` | PASS; 1 file, 3 tests |
| Start regression | `npm run test:start` | PASS; 1 file, 10 tests |
| Storage regression | `npm run test:storage` | PASS; 1 file, 7 tests |
| Config regression | `npm run test:config` | PASS on immediate retry; 1 file, 4 tests |
| Empty status | `npm exec -- vitest run test/status.empty-run.functional.test.ts --maxWorkers=1` | PASS; 1 test |
| Full suite | `npm test` | PASS; 8 files, 36 tests |
| Diff check | `git diff --check` | PASS |
| Package check | `npm pack --dry-run --json` | PASS; 12 package entries, including the new runtime modules |

The required final rerun was executed as:

```bash
npm run typecheck && npm run test:evidence && npm run test:git && npm run test:dispatch && npm run test:herdr && npm run test:storage && npm test && git diff --check
```

The successful complete capture is `logs/05-final-rerun.log`. It reports typecheck PASS, evidence 4/4, Git 2/2, dispatch 5/5, Herdr 3/3, storage 7/7, and full suite 8 files/36 tests.

## Host checks

Read-only host checks passed:

```bash
pi --version                         # 0.84.4
herdr --version                      # herdr 0.9.0
git --version                        # git version 2.43.0
herdr status server --json           # running, compatible, endpoint_compatible=true
herdr worktree --help
herdr agent --help
```

The extension imported successfully. RPC `get_commands` exposed the registered `steward` command and `/steward status` returned successfully. A bounded interactive TUI smoke rendered `steward: no active Run` and exited with code 0. The earlier TUI input/exit timing attempt was interrupted and is retained in `logs/05-tui-smoke.log`; the successful rerun is `logs/05-tui-smoke-rerun.log`.

## Honest verification notes

- The first `npm run test:config` executor attempt failed before the command launched with `Failed to create unified exec process: No such file or directory`; the immediate command retry passed. This was an execution-environment failure, not a test result.
- One later read-only staged-scope assertion also had a single executor launch failure with the same `No such file or directory` message; the identical assertion passed on immediate retry.
- The first normal `npm test` run hit the default five-second watchdog in the new filesystem-heavy evidence tests: 4 evidence tests failed by timeout and 32 existing tests passed. The test file initially used a global 15-second setting while isolating the cause; that leaked into the full worker and was removed. The final test file uses 60-second timeouts only on its four explicit durable-filesystem tests, preserving prior suite timeouts and assertions. The subsequent normal `npm test` passed 36/36.
- Two intermediate final-chain attempts also recorded host-contention watchdog failures: one in the evidence tests before the timeout isolation was corrected, and one in unchanged dispatch tests after the evidence suite passed. The final successful chain is recorded above; the first normal-suite failure is retained in `logs/05-npm-test.log`.
- `npm ci` emitted the existing deprecation and pending install-script approval warnings but reported zero vulnerabilities.

## Scope audit

Only ticket-05 implementation, package scripts, focused/regression tests, verification logs, and this report are included for handoff. The accepted plan `plans/05-validate-builder-evidence.md` remains unchanged, uncommitted, and outside the revision. No prior plan or prior report was modified. No merge, push, workspace close, or pass marking was performed.
