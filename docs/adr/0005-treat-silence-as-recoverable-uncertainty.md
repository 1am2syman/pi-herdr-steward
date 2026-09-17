# Treat agent silence as recoverable uncertainty

An agent that stops producing observable progress does not fail its Task. The Steward separates Task phase, Attempt lifecycle, and attention; it inspects existing evidence, nudges and resumes the same agent, and only then creates a linked replacement Attempt in the preserved worktree. This favors recovery of valuable partial work over destructive retries or false failure conclusions.
