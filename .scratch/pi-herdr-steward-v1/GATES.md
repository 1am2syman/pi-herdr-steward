# Gates: Pi Herdr Steward ticket breakdown

OWNS: .scratch/pi-herdr-steward-v1/issues/**, .scratch/pi-herdr-steward-v1/GATES.md, .scratch/pi-herdr-steward-v1/verify-tickets.mjs

Scope: publish a small-grained, dependency-correct set of vertical implementation tickets that covers the accepted spec without adding architecture or unnecessary tests

- [x] G1: every ticket delivers a complete user-visible or independently verifiable behavior rather than a horizontal layer
  EVIDENCE: manually reviewed all 20 What-to-build statements and acceptance lists; each ends in a runnable command flow, recovery outcome, evidence decision, or installable user result, with tests included inside the slice rather than separated by layer

- [x] G2: the published tickets collectively cover the accepted command surface, recovery paths, evidence rules, Review and integration flow, and Completion Gate
  CHECK: node .scratch/pi-herdr-steward-v1/verify-tickets.mjs coverage
  EXPECT: ticket coverage verification passed
  CWD: .
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/root/GitHub/pi-herdr-steward; path=5d5ccab780f1/18 entries; output=ticket coverage verification passed

- [x] G3: ticket blocking edges are acyclic and every blocker is numbered before the ticket it blocks
  CHECK: node .scratch/pi-herdr-steward-v1/verify-tickets.mjs dependencies
  EXPECT: ticket dependency verification passed
  CWD: .
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/root/GitHub/pi-herdr-steward; path=5d5ccab780f1/18 entries; output=ticket dependency verification passed

- [x] G4: tickets require only targeted functional tests and focused adapter contracts, with no standalone broad unit-test or infrastructure ticket
  CHECK: node .scratch/pi-herdr-steward-v1/verify-tickets.mjs testing
  EXPECT: ticket testing verification passed
  CWD: .
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/root/GitHub/pi-herdr-steward; path=5d5ccab780f1/18 entries; output=ticket testing verification passed

- [x] G5: each ticket is small enough for one fresh worker context and contains no deferred implementation remainder
  EVIDENCE: remeasured all 20 amended tickets at 151–227 words with focused acceptance criteria; scan found no TODO, TBD, placeholder, follow-up-ticket, or deferred-implementation markers
