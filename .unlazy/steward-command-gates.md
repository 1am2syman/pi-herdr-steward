# Gates: Steward command discovery, model search, and doctor

OWNS: README.md, src/extension.ts, src/adapters.ts, src/model-picker.ts, src/doctor.ts, src/steward.ts, test/extension-command-completion.contract.test.ts, test/model-picker.contract.test.ts, test/doctor.functional.test.ts, test/config.functional.test.ts, test/controller-ownership.contract.test.ts, test/install-functional-path.static.test.ts, package.json, package-lock.json, .unlazy/steward-command-gates.md

Scope: Make Steward subcommands discoverable, make model selection fuzzy-searchable and scrollable, and add static plus explicit live model health diagnostics.

- [x] G1: `/steward` command discovery is driven by one catalogue, bare invocation opens a selector, and argument completion exposes subcommands and nested flags
  CHECK: npx vitest run test/extension-command-completion.contract.test.ts test/controller-ownership.contract.test.ts --maxWorkers=1 && echo __STEWARD_COMMAND_GATE_OK__
  EXPECT: __STEWARD_COMMAND_GATE_OK__
  CWD: ..
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/root/GitHub/pi-herdr-steward; path=f12184ff318a/17 entries; output=Duration  5.56s (transform 1.45s, setup 0ms, import 5.06s, tests 24ms, environment 0ms) | __STEWARD_COMMAND_GATE_OK__

- [x] G2: model selection performs fuzzy matching, maintains a bounded scrollable viewport, preserves exact references, and integrates with configuration cancellation semantics
  CHECK: npx vitest run test/model-picker.contract.test.ts test/config.functional.test.ts --maxWorkers=1 && echo __STEWARD_PICKER_GATE_OK__
  EXPECT: __STEWARD_PICKER_GATE_OK__
  CWD: ..
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/root/GitHub/pi-herdr-steward; path=f12184ff318a/17 entries; output=Duration  4.00s (transform 1.44s, setup 0ms, import 3.20s, tests 352ms, environment 0ms) | __STEWARD_PICKER_GATE_OK__

- [x] G3: `/steward doctor` performs static checks without provider requests and `--probe` sequentially classifies live model health without leaking secrets
  CHECK: npx vitest run test/doctor.functional.test.ts --maxWorkers=1 && echo __STEWARD_DOCTOR_GATE_OK__
  EXPECT: __STEWARD_DOCTOR_GATE_OK__
  CWD: ..
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/root/GitHub/pi-herdr-steward; path=f12184ff318a/17 entries; output=Duration  345ms (transform 63ms, setup 0ms, import 95ms, tests 15ms, environment 0ms) | __STEWARD_DOCTOR_GATE_OK__

- [x] G4: changed TypeScript sources satisfy the project type contract
  CHECK: npm run typecheck && echo __STEWARD_TYPECHECK_GATE_OK__
  EXPECT: __STEWARD_TYPECHECK_GATE_OK__
  CWD: ..
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/root/GitHub/pi-herdr-steward; path=f12184ff318a/17 entries; output=> tsc --noEmit -p tsconfig.json | __STEWARD_TYPECHECK_GATE_OK__

- [x] G5: the complete repository test suite passes after all three features are integrated
  CHECK: npm test && echo __STEWARD_REGRESSION_GATE_OK__
  EXPECT: __STEWARD_REGRESSION_GATE_OK__
  CWD: ..
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/root/GitHub/pi-herdr-steward; path=f12184ff318a/17 entries; output=Duration  522.27s (transform 2.80s, setup 0ms, import 61.02s, tests 451.54s, environment 9ms) | __STEWARD_REGRESSION_GATE_OK__
