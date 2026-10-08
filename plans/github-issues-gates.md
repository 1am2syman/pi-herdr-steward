# Gates: built-in GitHub issue discovery

Scope: Add read-only authenticated GitHub issue snapshots to Steward intake without changing local issue or Run confirmation behavior.

- [x] G1: GitHub adapter and registered intake tool handle pagination, selection, filters, and failures
  CHECK: npx vitest run test/github-issues.contract.test.ts test/intake.functional.test.ts --maxWorkers=1 && echo GITHUB_TESTS_OK
  EXPECT: GITHUB_TESTS_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/acer_vps/GitHub/pi-herdr-steward; path=b684e0304df4/11 entries; output=Duration  2.99s (transform 1.08s, setup 0ms, import 2.57s, tests 91ms, environment 0ms) | GITHUB_TESTS_OK

- [x] G2: all TypeScript contracts compile
  CHECK: npm run typecheck && echo GITHUB_TYPES_OK
  EXPECT: GITHUB_TYPES_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/acer_vps/GitHub/pi-herdr-steward; path=b684e0304df4/11 entries; output=> tsc --noEmit -p tsconfig.json | GITHUB_TYPES_OK

- [x] G3: existing repository tests remain passing
  CHECK: npm test && echo GITHUB_REGRESSION_OK
  EXPECT: GITHUB_REGRESSION_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/acer_vps/GitHub/pi-herdr-steward; path=b684e0304df4/11 entries; output=Duration  82.68s (transform 1.72s, setup 0ms, import 43.98s, tests 31.06s, environment 7ms) | GITHUB_REGRESSION_OK
