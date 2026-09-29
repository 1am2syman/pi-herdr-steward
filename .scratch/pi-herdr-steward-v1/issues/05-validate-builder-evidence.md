# 05 — Validate Builder evidence

**What to build:** The Steward accepts a Builder outcome only when its Attempt Report and referenced evidence match the approved Assignment and immutable Artifact identity.

**Blocked by:** 04 — Dispatch one Builder durably

**Status:** ready-for-agent

- [ ] Builder reports validate common identity, status, summary, blockers, produced Artifacts, actual model, checks, log references, and produced revision.
- [ ] Code Artifacts validate the approved base, produced head, exact commit range, clean worktree, and allowed changed paths.
- [ ] Non-Git Artifacts validate path, size, and SHA-256 content hash.
- [ ] Changed Assignments, out-of-scope changes, missing evidence, or unexplained worktree changes are preserved and prevent Review.
- [ ] Full check output remains in durable logs while the Attempt Report stays concise; after an Attempt is finalized, its report, logs, and evidence are never overwritten by recovery or later Attempts.
- [ ] A targeted functional test covers valid evidence and the four rejection classes without testing report-parser helpers in isolation.
- [ ] A focused real-Git contract test verifies commit-range and dirty-worktree evidence.
