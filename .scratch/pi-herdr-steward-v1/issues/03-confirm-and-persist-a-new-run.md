# 03 — Confirm and persist a new Run

**What to build:** `/steward start` drafts a small Run, presents its Tasks, Model Plan, base revision, effective settings, and verification criteria for confirmation, then persists one active Run safely.

**Blocked by:** 01 — Installable extension and empty Run status; 02 — Configure recovery defaults and Model Plans

**Status:** ready-for-agent

- [ ] Starting a Run requires explicit confirmation of the ordered Task list and each Task's minimal contract.
- [ ] The confirmed Model Plan, maximum active Task count, and effective settings are frozen into the Run.
- [ ] Start refuses when Herdr is unavailable, another active Run exists, required models are unavailable, or a code-changing Run has no clean selected integration base.
- [ ] The Run Journal is schema-versioned, validated before replacement, written atomically, and preserves one previous valid snapshot.
- [ ] Project-local Steward state is ignored by Git and uses user-only permissions where supported; start also initializes a concise append-only activity log that is explicitly non-authoritative.
- [ ] A targeted functional test covers successful confirmation and each start refusal without launching an agent.
- [ ] A focused storage contract test verifies atomic replacement and previous-snapshot preservation on the real filesystem.
