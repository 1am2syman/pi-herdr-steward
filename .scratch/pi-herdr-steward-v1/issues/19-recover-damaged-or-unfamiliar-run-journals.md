# 19 — Recover damaged or unfamiliar Run Journals

**What to build:** `/steward status` and resume startup recover conservatively when the active Run Journal write was interrupted, both snapshots are invalid, or the schema is unsupported.

**Blocked by:** 03 — Confirm and persist a new Run; 10 — Resume and reconcile interrupted work

**Status:** ready-for-agent

- [ ] A corrupt active snapshot falls back to the previous valid snapshot and reports degraded recovery.
- [ ] Two invalid snapshots enter read-only recovery and never attempt a workflow mutation.
- [ ] A newer unsupported schema opens read-only and explains that the Steward must be updated.
- [ ] A known older schema migrates only when an explicit migration exists; otherwise it remains read-only.
- [ ] Status clearly distinguishes a normal active Run, recovered snapshot, and read-only recovery state.
- [ ] A targeted functional test exercises all snapshot and schema outcomes using real temporary files.
