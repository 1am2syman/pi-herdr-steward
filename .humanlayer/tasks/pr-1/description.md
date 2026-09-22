## Why the change

Steward users need discoverable commands, a model picker that remains usable with large catalogues, and a way to diagnose selected-model and orchestration health without guessing whether provider limits are responsible.

## Special things to note

- `/steward doctor` is static and makes no provider requests; live checks happen only with `/steward doctor --probe` and run one minimal request per unique selected model sequentially.
- The searchable picker stores the exact `provider/model-id` and keeps the existing simple selector as a compatibility fallback when Pi's custom TUI surface is unavailable.
- The repository test command now uses a 45-second per-test timeout because existing filesystem-heavy integration tests exceeded Vitest's five-second default during full-suite verification.

## Change outline

The extension now exposes one command catalogue to completion, bare-command selection, parsing, and dispatch.

```diff
 /steward
+  bare invocation -> subcommand selector
+  argument completion -> status | config | start | revise | resume | doctor | cancel | cleanup
+  nested completion -> resume --takeover | doctor --probe
   dispatch
+    doctor -> static checks
+    doctor --probe -> static checks + sequential live probes
```

Model selection moves from an unbounded list to a focused TUI component while preserving exact configuration values.

```text
SearchableModelPickerState
  pinned actions
    proposed Controller choice
    exact entry
    current choice
    cancel
  fuzzy-filtered models
    search: provider + model ID + display name
    viewport: 12 rows
    navigation: arrows + Page Up/Page Down
  result
    exact provider/model-id
    explicit thinking-level selection
```

Doctor owns the non-mutating diagnostic flow and normalizes provider-specific failures into stable report categories.

```text
runStewardDoctor
  load recovery defaults + Model Plans + active Journal + Herdr availability
  inspect each selected model
    registry identity
    authentication
    session availability/scope
    thinking-level support
  if --probe
    call each unique model once, sequentially
    classify healthy | rate-limited | quota-exhausted | auth-failed
             | temporarily-unavailable | incompatible-request | unknown-error
    redact credential-like diagnostics
  present point-in-time report
```

```diff
 src/
+├── doctor.ts          # static diagnostics, live probe classification, report formatting
+├── model-picker.ts    # fuzzy search, scrolling state, custom Pi TUI component
 ├── adapters.ts        # Pi model probing, picker integration, doctor presentation
 ├── extension.ts       # shared command catalogue, completions, selector, doctor dispatch
 └── steward.ts         # doctor orchestration entry point

test/
+├── doctor.functional.test.ts
+├── extension-command-completion.contract.test.ts
+└── model-picker.contract.test.ts
```
