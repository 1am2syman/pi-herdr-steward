# 17 — Revise an active Run explicitly

**What to build:** `/steward revise` turns a changed requirement into a visible, versioned, user-confirmed delta while preserving unaffected valid work.

**Blocked by:** 13 — Coordinate multiple Tasks; 14 — Enforce Controller Session ownership and compaction continuity

**Status:** ready-for-agent

- [ ] Ordinary conversation never changes the active Run automatically.
- [ ] The command drafts and displays the proposed Task and Model Plan delta before confirmation.
- [ ] Changed Task specifications receive new versions and specification hashes.
- [ ] Obsolete Attempts are cancelled and affected Review, Approval, integration, and verification evidence is invalidated.
- [ ] Unaffected completed Tasks and valid evidence remain intact.
- [ ] Revision is unavailable to a non-controller session and remains unchanged when confirmation is cancelled.
- [ ] A targeted functional test revises one Task in a multi-Task Run and verifies selective preservation and invalidation.
