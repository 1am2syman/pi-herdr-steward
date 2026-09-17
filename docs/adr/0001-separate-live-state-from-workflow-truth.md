# Separate live state from workflow truth

Herdr is authoritative for live agent identity and process state, while the Run Journal and durable Artifacts are authoritative for workflow progress and proof. Pi's conversational context and agent claims are explanatory inputs only, because compaction, crashes, retries, and stale responses make them unsafe as the sole source of truth.
