# 18 — Cancel and clean up Steward-owned resources

**What to build:** A user can cancel an active Run without losing evidence and later remove only the panes and worktrees the Steward owns through an explicit cleanup confirmation.

**Blocked by:** 13 — Coordinate multiple Tasks; 14 — Enforce Controller Session ownership and compaction continuity

**Status:** ready-for-agent

- [ ] Cancellation is persisted before any agent interruption.
- [ ] A cancelled Run permits no further dispatch, replacement, Review launch, integration, or final verification.
- [ ] Steward-created agents are interrupted or stopped gracefully while Pi sessions, panes, worktrees, reports, and logs remain inspectable.
- [ ] `/steward cleanup` lists the exact recorded panes and worktrees and requires confirmation.
- [ ] Cleanup closes and removes only recognized Steward-owned resources; archives, Assignments, Attempt Reports, and logs remain.
- [ ] Push, reset, discarded work, deployment, and deletion of unrecognized resources are never part of cancellation or cleanup.
- [ ] A targeted functional test verifies persistence-before-interrupt, blocked post-cancel actions, cancelled confirmation, and owned-resource-only cleanup.
