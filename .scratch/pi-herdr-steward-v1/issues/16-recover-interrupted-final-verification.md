# 16 — Recover interrupted final verification

**What to build:** Final verification remains safe and conclusive across controller interruption, live commands, durable results, reruns, dirty checkouts, and failures whose ownership is unclear.

**Blocked by:** 10 — Resume and reconcile interrupted work; 13 — Coordinate multiple Tasks

**Status:** ready-for-agent

- [ ] Recovery waits without interference when the recorded verification process is still alive.
- [ ] A complete durable log and exit result are consumed without rerunning the command.
- [ ] When no conclusive result exists, the deterministic command is rerun and the recovery rerun is recorded.
- [ ] A failure with a clear Task owner returns that Task for a new revision and fresh Review, consuming a rework cycle.
- [ ] A failure with unclear or multi-Task ownership preserves integrated state and sets `needs-user`.
- [ ] Verification-created modifications or untracked files preserve the checkout and block completion.
- [ ] A targeted functional test covers live wait, durable-result consumption, recorded rerun, clear ownership, unclear ownership, and dirty checkout.
