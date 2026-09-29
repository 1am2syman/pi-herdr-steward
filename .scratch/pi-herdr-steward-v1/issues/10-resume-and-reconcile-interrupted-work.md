# 10 — Resume and reconcile interrupted work

**What to build:** `/steward resume` reconstructs the next safe action from durable workflow truth and live Herdr state instead of continuing from conversational memory.

**Blocked by:** 09 — Monitor and advance without user reminders

**Status:** ready-for-agent

- [ ] Reconciliation checks, in order: valid Attempt Report; working or blocked agent; settled agent without report; unclear live state; missing agent.
- [ ] A valid report is consumed only after all referenced evidence validates.
- [ ] A blocked agent is answered automatically only when the approved Task already determines the answer.
- [ ] A settled agent without a report receives one report request before the Task blocks.
- [ ] Interrupted dispatch with an active matching Attempt waits instead of resending; an undispatched prepared Attempt reuses the same Attempt identity.
- [ ] Missing agents preserve the worktree and evidence before any replacement decision.
- [ ] Recovery derives state only from the Run Journal, Herdr, Git, reports, and Artifacts; a missing, truncated, or contradictory activity log is diagnostic context only.
- [ ] A targeted functional test covers every reconciliation branch and proves no duplicate dispatch or false success.
