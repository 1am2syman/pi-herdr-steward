# 14 — Enforce Controller Session ownership and compaction continuity

**What to build:** One Controller Session may advance an active Run; other sessions can inspect it and take over only through reconciliation. Pi session replacement and compaction preserve continuity without making hooks the source of truth.

**Blocked by:** 09 — Monitor and advance without user reminders; 10 — Resume and reconcile interrupted work

**Status:** ready-for-agent

- [ ] The Run Journal records the Controller Session and rejects mutation from another session.
- [ ] `/steward status` remains available read-only from a non-controller session.
- [ ] `/steward resume --takeover` reconciles before replacing controller identity.
- [ ] Session shutdown stops the monitor, and session start or reload reconstructs it from durable state.
- [ ] Before compaction, the Steward verifies the Journal and contributes the Run identity and pending action to continuity context.
- [ ] Compaction success triggers reconciliation; compaction failure records diagnostics without changing Task state.
- [ ] A targeted functional test covers read-only access, takeover, session replacement, successful compaction, and failed compaction.
