# Revise Runs explicitly

Mid-Run requirement changes use `/steward revise`, which drafts and confirms a versioned delta, preserves unaffected completed work, cancels obsolete Attempts, and invalidates only affected evidence. Ordinary conversation never silently changes an active Run, because implicit scope mutation would make recovery and Review provenance ambiguous.
