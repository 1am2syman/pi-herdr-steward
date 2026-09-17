# Use one session-scoped controller

One Pi session is authorized to advance an active Run, while other sessions may inspect it and explicitly take over only after reconciliation. The controller maintains a session-scoped monitor that observes Herdr continuously while Pi is open, but mutating orchestration steps occur only at safe idle points; this prevents duplicate control without introducing a daemon, distributed lease, or hidden cross-session coordination.
