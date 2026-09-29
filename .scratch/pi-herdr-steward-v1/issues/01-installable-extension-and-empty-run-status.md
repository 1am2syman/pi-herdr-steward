# 01 — Installable extension and empty Run status

**What to build:** Package Pi Herdr Steward as an installable Pi extension. A user can invoke `/steward status` in a repository with no active Run and receive a compact, accurate empty-state response. This slice establishes only the smallest orchestration interface and replaceable external adapters needed by later slices.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] The package installs and loads as a Pi extension in interactive TUI mode.
- [ ] `/steward status` reports that no active Run exists without creating Run state.
- [ ] The extension exposes a compact footer state without introducing a custom dashboard.
- [ ] Herdr, storage, Git, process, model, clock, and UI interactions are replaceable at the orchestration seam without adding a framework or speculative adapter methods.
- [ ] A targeted functional test invokes the registered status command and verifies the empty-state output and absence of writes.
