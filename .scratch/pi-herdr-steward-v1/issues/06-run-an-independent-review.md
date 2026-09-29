# 06 — Run an independent Review

**What to build:** Once Builder evidence is valid, the Steward launches a separate Pi Reviewer against the exact frozen Artifact and records whether Reviewer independence and read-only behavior were preserved.

**Blocked by:** 05 — Validate Builder evidence

**Status:** ready-for-agent

- [ ] The Reviewer uses the first available user-approved model from a different provider family than the actual Builder model.
- [ ] If no independent model is available, Review pauses until the user explicitly approves a same-family model or changes the Model Plan.
- [ ] The Reviewer Assignment identifies the exact Git revision or non-Git Artifact identity under Review, and the resulting report contains an explicit `approved` or `changes-required` verdict.
- [ ] The worktree head and dirty-state fingerprint are recorded before Review and compared afterward.
- [ ] Reviewer modifications are preserved, invalidate the Review, and set `needs-user`; the Steward never resets them, and provider failure, process exit, silence, or Herdr lifecycle state is never treated as a verdict.
- [ ] A targeted functional test verifies independent selection, same-family confirmation, and read-only violation handling.
