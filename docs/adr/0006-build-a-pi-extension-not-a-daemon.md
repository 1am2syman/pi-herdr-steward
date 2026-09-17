# Build a Pi extension, not a daemon

Pi Herdr Steward begins as a Pi extension using Pi lifecycle hooks and Herdr's CLI, with orchestration logic kept in ordinary reusable TypeScript. This provides native compaction, session, command, and UI integration while accepting that new orchestration decisions pause when Pi is unavailable; a continuously running daemon is rejected because its supervision, IPC, concurrency, and ownership costs are not yet justified.
