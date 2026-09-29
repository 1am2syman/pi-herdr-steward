# 09 — Monitor and advance without user reminders

**What to build:** While the Controller Session is open, a session-scoped monitor observes Herdr and durable evidence, updates user-visible status, and advances deterministic workflow steps at safe idle points without repeated user prompts.

**Blocked by:** 08 — Integrate and complete a single-Task Run

**Status:** ready-for-agent

- [ ] The monitor prefers Herdr lifecycle waits and uses slow reconciliation only as fallback.
- [ ] Herdr lifecycle, terminal output, worktree changes, Git changes, and Attempt Report updates count as observable progress.
- [ ] During an active Pi turn or compaction, the monitor records observations but performs no dispatch, replacement, Review launch, or integration.
- [ ] Significant lifecycle observations and decisions append concise entries to the activity log only after authoritative state is persisted; activity-log failure produces a diagnostic and cannot change Run state.
- [ ] When Pi settles, the monitor reconciles and performs at most the next deterministic action.
- [ ] Footer state and notifications cover blocked, degraded, approval-required, and completed conditions without a dashboard.
- [ ] The monitor starts on session start and stops cleanly on session shutdown.
- [ ] A targeted functional test proves a settled Builder automatically leads to evidence validation and Review dispatch after Pi becomes idle.
