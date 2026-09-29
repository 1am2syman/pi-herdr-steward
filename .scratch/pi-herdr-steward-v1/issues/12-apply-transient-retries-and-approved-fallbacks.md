# 12 — Apply transient retries and approved fallbacks

**What to build:** The Steward recovers from transient execution failures with at most two replacement Attempts and only user-approved model fallbacks, while treating correctness failures and lost Herdr observability differently.

**Blocked by:** 02 — Configure recovery defaults and Model Plans; 10 — Resume and reconcile interrupted work; 11 — Recover silent agents without disrupting long commands

**Status:** ready-for-agent

- [ ] Provider/network interruption, agent startup failure, Herdr command failure, and unexpected process exit consume the transient replacement budget and are recorded as infrastructure outcomes rather than Builder or Reviewer verdicts.
- [ ] Tests, Review findings, incorrect work, scope violations, and missing Artifacts do not consume transient retries.
- [ ] The same model is retried first; a replacement uses only the next available approved fallback and records why it changed.
- [ ] No model changes within an active Attempt, and absence of an approved fallback pauses for user input.
- [ ] Temporary Herdr unavailability marks monitoring degraded and reconciles on return without failing active Attempts.
- [ ] Two failed replacement Attempts set `needs-user` while preserving all partial work; superseded or failed agents are stopped only after their state and available evidence are retained.
- [ ] A targeted functional test covers failure classification, retry accounting, fallback order, and Herdr recovery.
