# 04 — Dispatch one Builder durably

**What to build:** For one approved code-changing Task, the Steward creates an isolated worktree and named Pi Builder, writes a bounded Assignment, persists dispatch intent, submits the Assignment through Herdr, and displays the active Attempt.

**Blocked by:** 03 — Confirm and persist a new Run

**Status:** ready-for-agent

- [ ] The Assignment records Run, Task, and Attempt identity; required outcome; allowed scope; expected Artifacts; report location; verification criteria; actual model; and specification hash.
- [ ] Assignment and `prepared`/dispatch intent are durable before any Herdr prompt is sent.
- [ ] The Builder receives a Steward-owned isolated worktree based on the Run's selected revision.
- [ ] Existing Herdr resources are never adopted; name collisions produce a new unique Steward-owned name whose actual name and pane are recorded.
- [ ] `/steward status` shows the Builder Assignment and active Attempt without treating Herdr activity as Task completion.
- [ ] A targeted functional test proves persistence occurs before dispatch and that retrying the command does not create a second Assignment.
- [ ] A focused Herdr adapter contract test verifies start, prompt, and name-collision translation against real CLI-shaped responses.
