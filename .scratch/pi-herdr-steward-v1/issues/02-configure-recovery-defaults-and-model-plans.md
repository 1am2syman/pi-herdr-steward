# 02 — Configure recovery defaults and Model Plans

**What to build:** A user can run `/steward config` to inspect and save the small set of recovery defaults and project Model Plan defaults. Exact Builder and Reviewer models, thinking levels, and ordered fallbacks are visible and never inferred silently.

**Blocked by:** 01 — Installable extension and empty Run status

**Status:** ready-for-agent

- [ ] `/steward config` edits the accepted liveness intervals, external-command warning threshold, maximum active Task count, two-retry limit, and five-cycle rework limit.
- [ ] Project defaults store exact Builder and Reviewer model references, thinking levels, and ordered fallbacks.
- [ ] The Controller Session model is displayed only as a proposed Builder choice requiring confirmation.
- [ ] Invalid, unavailable, or unauthenticated model choices are reported without silently substituting another model.
- [ ] A targeted functional test confirms saved defaults reload correctly and that cancellation leaves configuration unchanged.
