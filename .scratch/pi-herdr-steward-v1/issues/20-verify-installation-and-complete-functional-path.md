# 20 — Verify installation and the complete functional path

**What to build:** A user can install the Pi package into a fresh project, understand the command surface and recovery guarantees, and verify one complete Steward-managed Run using focused smoke checks.

**Blocked by:** 12 — Apply transient retries and approved fallbacks; 15 — Recover interrupted or conflicted integration; 16 — Recover interrupted final verification; 17 — Revise an active Run explicitly; 18 — Cancel and clean up Steward-owned resources; 19 — Recover damaged or unfamiliar Run Journals

**Status:** ready-for-agent

- [ ] Package metadata and documentation provide the supported Git/npm installation flow and state the Pi, Herdr, Git, and interactive-TUI prerequisites.
- [ ] Documentation explains the command surface, authority model, Model Plan, evidence locations, non-authoritative activity log, recovery behavior, sensitive-log warning, and explicit safety limits.
- [ ] A fresh-project smoke test installs and loads the package, starts a confirmed Run with simulated Pi agents, completes Builder and Reviewer work, integrates, verifies, archives, and reports completion.
- [ ] A focused real-Herdr smoke check verifies status discovery and one owned agent lifecycle without invoking paid providers.
- [ ] The existing static flow-atlas coverage, state, static-document, and design-section checks remain green.
- [ ] No daemon, generic workflow engine, ticket-quality manager, mandatory Gate framework, database, custom dashboard, broad coverage campaign, or paid-provider CI dependency is introduced.
