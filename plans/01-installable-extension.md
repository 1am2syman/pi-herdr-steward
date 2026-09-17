# Ticket 01 plan — installable extension and empty Run status

## 1. Package identity and install wiring

- Use the new npm identity `pi-herdr-steward`, versioned initially as `0.1.0`. This name comes only from this product and must not be copied or adapted from any installed extension.
- Declare exactly one Pi resource in `package.json`: `"pi": { "extensions": ["./src/extension.ts"] }`. Add the `pi-package` keyword, ESM package mode, and no third-party runtime dependencies. The only host contract is the official `@earendil-works/pi-coding-agent` peer dependency; TypeScript and Node types may be development-only dependencies.
- The canonical user install command is `pi install npm:pi-herdr-steward`. Before publication, the worker verifies the same package locally with `pi -e .`; neither command requires copying another package's manifest or settings entry.
- `src/extension.ts` default-exports the Pi extension factory and also exports a named `registerStewardExtension` function for the functional test. The default export delegates directly to that named function.
- Register one command name, `steward`; `/steward status` is represented by the registered handler receiving the exact argument `status`. Do not register tools, aliases, shortcuts, additional command prefixes, or future subcommands in this slice.
- Registration itself is safe in every Pi mode, but ticket-01 activation is gated at the first line of each handler/event path by `ctx.mode === "tui"`. Only an interactive TUI invocation may inspect repository state or publish the footer. A `session_start` handler uses the same gate to publish the initial compact footer; the command handler repeats the gate so direct test invocation and reloads cannot bypass it.

## 2. File-by-file map

- `.gitignore` — exclude only local dependency/install output needed by this package, beginning with `node_modules/`.
- `package.json` — define the novel package identity, exact Pi extension entry, ESM mode, peer/development dependencies, and focused `test` and `typecheck` scripts.
- `package-lock.json` — lock only the package's declared development/peer-resolution graph; generate it from this fresh manifest rather than copying another package's lockfile.
- `tsconfig.json` — enable strict, no-emit TypeScript checking for `src/` and `test/` using Node ESM semantics.
- `src/steward.ts` — own the seven-slot orchestration seam, the read-only status operation, and the small discriminated status/footer result values.
- `src/adapters.ts` — implement the production read-only Run Journal probe and request-scoped Pi UI presentation; supply empty opaque values for the five adapter slots unused by this ticket, without speculative methods.
- `src/extension.ts` — export the default factory and named registration function, register `steward`, parse only `status`, enforce the TUI gate, and connect `session_start` plus the command handler to the orchestration module.
- `test/status.empty-run.functional.test.ts` — invoke the handler captured through `registerStewardExtension`, assert exact empty output/footer state, and prove the repository tree is unchanged.

No README, dashboard files, schemas, migrations, activity logs, Run fixtures, framework configuration, or future command modules are part of ticket 01.

## 3. Orchestration seam signature

Use one plain function-shaped constructor. Its dependency object has exactly these seven top-level keys and no extras:

```ts
createSteward({
  runJournal,
  herdr,
  git,
  process,
  model,
  clock,
  ui,
})
```

The ticket-01 interface of those slots is intentionally narrow:

- `runJournal` exposes one read-only operation, `probeActive(repositoryRoot)`, returning only `missing` or `present`.
- `ui` exposes one operation, `presentStatus(statusView, target)`, where `target` is `command` or `footer`.
- `herdr`, `git`, `process`, `model`, and `clock` are opaque empty records in this slice. They are required constructor slots so every accepted external category has a replaceable location, but they receive no methods until a later ticket has an actual use for one.

`createSteward` returns one ticket-01 operation, `status(repositoryRoot, target)`. Use structural TypeScript types and plain objects/functions only: no classes, inheritance, abstract base adapters, service locator, registry, decorators, IoC container, or adapter framework. The named extension registration function may accept a small adapter factory for tests, but that factory must still produce the exact seven-key object above.

## 4. Empty-Run `/steward status` handler

1. The registered `steward` handler trims its arguments. Only exact `status` dispatches; anything else emits a one-line `/steward status` usage message and performs no repository inspection.
2. After confirming `ctx.mode === "tui"`, construct the seven adapters for that invocation and call `status(ctx.cwd, "command")`. The `session_start` path calls the same operation with `"footer"` so it does not emit a command notification.
3. The Run Journal adapter probes only `<repository>/.pi/steward/active-run.json` (using Pi's official configurable project-directory constant rather than baking in a rebranded directory name). It may use read-only filesystem operations only. Missing `.pi`, missing `.pi/steward`, and missing `active-run.json` all normalize to `missing`; no directory is created to perform the check.
4. Treat an existing `.herdr/orchestration` directory as unrelated controller-ledger data, never as a Steward Run. The ledger script's schema is `manifest.json` with `schema_version: 1`, plus optional `states/*.json`, `events.log`, `signals/`, `.ledger.lock`, and rendered `LEDGER.md`. Status must tolerate that directory being absent or present, must not read it to infer a Run, and must never execute `ledger.py status` because that command locks and rewrites ledger files.
5. On `missing`, return exactly:

   ```text
   kind: "empty"
   markdown: "No active Steward Run exists in this repository."
   footer: { run: "none", attentionCount: 0, text: "steward: no active Run" }
   ```

6. The UI adapter presents command output as one informational TUI notification and always maps `footer.text` to `ctx.ui.setStatus("pi-herdr-steward", footer.text)`. `setStatus` augments Pi's existing footer; do not call `setFooter`, `setWidget`, or `custom`.
7. If `active-run.json` is present, fail closed and remain read-only: report only that an active Steward Run was detected and detailed active status is outside ticket 01. Do not parse, migrate, repair, or rewrite a schema that ticket 03 has not defined yet, and never misreport the repository as empty.
8. The empty path performs no Git call because journal absence is already conclusive. It also makes no Herdr, process, model, or clock call. It must not create Run state, `.pi/steward`, `.herdr/orchestration`, logs, lockfiles, session entries, or any other file, and it must not open a Run.

## 5. Targeted functional test

Implement `test/status.empty-run.functional.test.ts` with the behavior-level test signature:

```text
registered /steward status reports an empty Run and performs no writes
```

The test must:

- Call the exported `registerStewardExtension` with a fake Pi registration surface, capture the handler registered under `steward`, and invoke that handler with argument `status` and a TUI context. Do not call the orchestration helper directly as the primary assertion path.
- Use the production read-only Run Journal adapter against a fresh temporary repository and an in-memory UI adapter. Parameterize the assertion for both (a) no `.herdr/orchestration` directory and (b) a pre-existing controller ledger containing a schema-version-1 manifest and representative state/event/signal files.
- Snapshot the temporary repository's relative paths, file contents, modes, and symlink targets after fixture setup and before invocation; assert the same snapshot after invocation. Separately assert that `.pi/steward` and `active-run.json` remain absent.
- Assert the exact markdown string and exact footer object from section 4, assert that the UI adapter received one informational command presentation plus the `pi-herdr-steward` status update, and assert zero calls to the `herdr`, `git`, `process`, `model`, and `clock` slots.
- Keep fixture creation outside the handler-observation window so test setup cannot be mistaken for a Steward side effect. The test must fail if the handler creates a directory, lock, journal, activity log, or any other disk content.

## 6. Boundaries the worker MUST honor

- Author this package from a blank shape. Do not borrow any package name, dependency set, hook arrangement, command prefix, tool name, manifest shape, source layout, or implementation from another installed extension. The mandated `/steward` name and the official Pi host interfaces are the only preselected identity/interface elements.
- Keep the orchestration seam at exactly seven replaceable adapters: `runJournal`, `herdr`, `git`, `process`, `model`, `clock`, and `ui`. Do not add configuration, filesystem, logger, repository, environment, controller, or generic services as an eighth dependency; the Run Journal adapter owns its read-only filesystem detail for this slice.
- Do not add methods merely because later tickets may need them. In particular, ticket 01 has no Herdr launch/status operations, Git commands, process observation, model lookup, clock reads, journal writes, migration behavior, or monitor loop.
- `/steward status` in an empty repository is strictly read-only. It may inspect the active-journal path and nothing needs a Git call; it must not create files, directories, logs, ignore entries, locks, reports, config, or Run state.
- Use the domain terms `Steward`, `Run`, and `Run Journal` exactly as defined in `CONTEXT.md`; do not rename them to supervisor, job, session, or transcript.
- Preserve Pi's built-in TUI. The only persistent visual surface is the compact `setStatus` footer item; a custom footer, widget, panel, dashboard, alternate TUI, or transcript renderer is forbidden.
- Keep the target functional test in `test/` and test through registered command behavior. Do not replace it with private-helper unit tests, snapshots of a custom UI, a paid-provider test, or a real-agent end-to-end suite.
- Do not introduce a daemon, database, event store, lock manager, workflow framework, class hierarchy, generic adapter library, background monitor, configuration subsystem, or compatibility/migration layer.

## 7. Risk notes

- Confirm the packed artifact actually contains `src/extension.ts` and that Pi resolves it: run the focused tests and typecheck, inspect `npm pack --dry-run`, then launch `pi -e .` in an interactive TUI and invoke `/steward status` before declaring `review_ready`.
- Guard against accidental confusion between Steward state and Herdr's controller ledger. In particular, never shell out to `ledger.py status`; despite its name, it can create a lock and rewrite `LEDGER.md`.
- Keep the no-write proof meaningful across both empty directory layouts. A passing UI assertion is insufficient if path discovery quietly creates `.pi`, a lockfile, or an activity log.
- Keep the package dependency-light and publishable. Production loading must rely only on Pi's official host peer and Node built-ins; development dependencies must not leak into the runtime contract.
- Resist filling the five unused adapter slots with guessed methods. Their emptiness is deliberate evidence that this slice established a seam without prematurely designing later tickets.
