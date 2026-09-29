# 15 — Recover interrupted or conflicted integration

**What to build:** After controller interruption or target movement, the Steward determines what Git operation actually happened and preserves any ambiguous or conflicted state instead of repeating or undoing it blindly.

**Blocked by:** 10 — Resume and reconcile interrupted work; 13 — Coordinate multiple Tasks

**Status:** ready-for-agent

- [ ] Recovery recognizes when the exact approved range is already integrated and records completion without reapplying it.
- [ ] If the target remains at the recorded revision and the range is absent, the same intended integration can be retried safely.
- [ ] Partial or conflicted Git operations are preserved, displayed, and set `needs-user`; no automatic abort, reset, or revert occurs.
- [ ] Unexpected target changes stop mutation and show the difference.
- [ ] An advanced target that requires Artifact modification returns the Task to its Builder for a new revision and fresh Review, consuming a rework cycle.
- [ ] A targeted functional test uses temporary real repositories for already-applied, retryable, conflicted, and advanced-target cases.
