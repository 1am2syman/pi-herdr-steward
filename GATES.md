# Gates: complete Steward flow atlas

OWNS: docs/prototypes/run-recovery.logic-prototype.html, docs/prototypes/verify-flow-atlas.mjs, GATES.md

Scope: Replace the simplified diagram with a static visual atlas that covers every accepted version-one process and recovery case in docs/design.md.

- [x] G1: every accepted case in the visual coverage inventory is present exactly once
  CHECK: node docs/prototypes/verify-flow-atlas.mjs coverage
  EXPECT: coverage verification passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/root/GitHub/pi-herdr-steward; path=5d5ccab780f1/18 entries; output=coverage verification passed

- [x] G2: all Task, Attempt, and Attention states plus required lifecycle transitions are represented
  CHECK: node docs/prototypes/verify-flow-atlas.mjs states
  EXPECT: state verification passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/root/GitHub/pi-herdr-steward; path=5d5ccab780f1/18 entries; output=state verification passed

- [x] G3: the artifact is a static diagram document without application-style controls or executable page logic
  CHECK: node docs/prototypes/verify-flow-atlas.mjs static
  EXPECT: static artifact verification passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/root/GitHub/pi-herdr-steward; path=5d5ccab780f1/18 entries; output=static artifact verification passed

- [x] G4: every accepted design section is mapped to at least one diagram or guardrail panel
  CHECK: node docs/prototypes/verify-flow-atlas.mjs sections
  EXPECT: design section verification passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/root/GitHub/pi-herdr-steward; path=5d5ccab780f1/18 entries; output=design section verification passed

- [x] G5: the full atlas is visually readable in a browser at desktop width and browser diagnostics are clean
  EVIDENCE: Browser QA passed with expected text, network, console, and page-error checks; desktop screenshots reviewed for the master flow and plates 04, 06, and 10.
