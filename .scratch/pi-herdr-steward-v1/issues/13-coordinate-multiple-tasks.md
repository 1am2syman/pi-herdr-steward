# 13 — Coordinate multiple Tasks

**What to build:** A Run can operate several Builder/Reviewer pairs while keeping concurrency limited to clearly disjoint scopes and integration ordered exactly as the user approved.

**Blocked by:** 08 — Integrate and complete a single-Task Run; 09 — Monitor and advance without user reminders

**Status:** ready-for-agent

- [ ] Tasks with clearly disjoint allowed scopes dispatch concurrently without exceeding the maximum active Task count frozen into the Run.
- [ ] Tasks with overlapping scopes are serialized in approved order without constructing a generic dependency graph.
- [ ] Each code-changing Builder owns a separate worktree and Assignment.
- [ ] Approved revisions wait and integrate in user-approved order rather than completion order.
- [ ] Progress and attention are reported per Task while the Run summary remains compact.
- [ ] Final verification and the Completion Gate run only after all required revisions are integrated.
- [ ] A targeted functional test uses disjoint and overlapping Tasks to prove the concurrency cap, scope serialization, and integration order.
