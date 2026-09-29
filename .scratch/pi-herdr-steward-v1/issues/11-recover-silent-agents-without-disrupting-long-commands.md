# 11 — Recover silent agents without disrupting long commands

**What to build:** The Steward treats agent silence as recoverable uncertainty, protects known live external commands, and escalates through a preservation-first recovery ladder.

**Blocked by:** 10 — Resume and reconcile interrupted work

**Status:** ready-for-agent

- [ ] An Attempt with no observable progress becomes `suspected-stall`, not failed.
- [ ] Recovery inspects Herdr, terminal output, worktree, Git, Artifacts, and Attempt Report before sending input.
- [ ] The ladder is status nudge, soft interruption of a stuck generation, same-agent resume, then linked replacement in the preserved worktree.
- [ ] Inspection, nudging, and same-agent resume consume no transient retry.
- [ ] A known live test, build, or child process sets `waiting-external`; thresholds notify but never nudge, interrupt, or replace it.
- [ ] After external-process exit, the agent receives a grace period before stall recovery begins.
- [ ] A targeted functional test uses a controllable clock and process observer to exercise both the silence ladder and quiet long-running command path.
