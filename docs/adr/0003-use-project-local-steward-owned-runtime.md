# Use a project-local, Steward-owned runtime

A repository has at most one active Run, persisted in an ignored project-local Run Journal. The Steward controls only agents it creates, gives each code-changing Builder an isolated worktree, assigns its Reviewer to the same frozen revision without write ownership, and requires every agent outcome to be captured in a durable Attempt Report rather than relying on terminal transcripts.
