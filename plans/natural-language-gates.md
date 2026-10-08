# Gates: natural-language Steward

Scope: agent-driven intake using existing validated orchestration and explicit confirmation.

- [x] G1: types and full regression suite pass
  CHECK: npm run typecheck && npm test && echo STEWARD_CHECKS_OK
  EXPECT: STEWARD_CHECKS_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/acer_vps/GitHub/pi-herdr-steward; path=b684e0304df4/11 entries; output=Duration  74.66s (transform 1.96s, setup 0ms, import 38.45s, tests 30.28s, environment 6ms) | STEWARD_CHECKS_OK

- [x] G2: real interactive Pi TUI exercises natural-language handoff and tool confirmation cancellation
  EVIDENCE: Live Pi 1.1.0 with cliproxyapi/gpt-5.5 in an isolated Git repository generated a typed proposal and opened Confirm Steward Run; Escape cancelled with no active-run.json and no retry. Final source smoke repeated successfully. Accepted code-task smoke persisted/dispatched but exposed existing adapter and cancellation-checkpoint defects; see reports/natural-language-tui-smoke.md.

- [x] G3: branch pushed and pull request opened
  EVIDENCE: feat/natural-language-steward pushed to origin; open PR https://github.com/1am2syman/pi-herdr-steward/pull/2.
