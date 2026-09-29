# 07 — Complete Review and rework cycles

**What to build:** Reviewer Approval advances only the exact reviewed Artifact, while actionable findings return the Task to its Builder for a new revision and fresh Review through a bounded rework loop.

**Blocked by:** 06 — Run an independent Review

**Status:** ready-for-agent

- [ ] Approval records the exact reviewed revision or Artifact identity and becomes invalid after any change.
- [ ] Changes requested return to the same Builder with preserved context and require a new Artifact and Review.
- [ ] A missing, malformed, or evidence-incomplete Reviewer report receives one repair request before the Task blocks.
- [ ] The initial build/Review may be followed by at most five rework-and-Review cycles.
- [ ] Exhausted rework sets `needs-user` without discarding any work.
- [ ] A targeted functional test exercises Approval, one successful rework, report repair, and rework exhaustion as complete Task flows.
