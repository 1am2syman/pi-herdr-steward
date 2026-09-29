# 08 — Integrate and complete a single-Task Run

**What to build:** A fully approved single-Task Run integrates its exact revision locally, runs deterministic final verification, passes the Completion Gate, archives evidence, and stops its agents gracefully.

**Blocked by:** 07 — Complete Review and rework cycles

**Status:** ready-for-agent

- [ ] Integration intent records the target branch, target revision, approved base/head range, and intended action before Git mutation.
- [ ] Only the exact approved range is integrated, without push or remote mutation.
- [ ] The Steward directly runs the approved final-verification commands and writes durable logs and exit results.
- [ ] Completion requires valid Task evidence, current Approval, exact integration, passing verification, a clean integration checkout, and no unresolved attention.
- [ ] Completion archives the Run and reports, notifies the user, and gracefully stops Steward-created agents while retaining panes and worktrees.
- [ ] A targeted functional test runs the complete one-Task path from confirmed Run through archived completion.
- [ ] A focused real-Git contract test proves exact local integration and clean-checkout evaluation.
