# Persist transitions before external side effects

The Steward records each workflow transition atomically before prompting agents, integrating revisions, interrupting work, or performing another external side effect. This permits recovery after crashes or compaction by reconciling an explicit pending transition against Herdr and durable Artifacts instead of guessing from conversational context.
