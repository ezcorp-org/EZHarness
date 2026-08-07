# src/extensions/ — extension host

The authoring surface is `@ezcorp/sdk` (`defineExtension` + runtime helpers,
`packages/@ezcorp/sdk`). Bundled first-party extensions live in top-level
`extensions/` (registered in `bundled.ts`); reference extensions in
`docs/extensions/examples/*/`.

- **Sandbox & isolation** — tiered sandboxes (bwrap › landlock › advisory);
  the SDK poisons `node:fs`/`Bun.file` at load, so ALL extension IO goes
  through host-mediated reverse-RPC handlers (`*-handler.ts` in this dir).
  Invariant: `.ezcorp/data` (PGlite DB + JWT secret) is never reachable from a
  sandbox ·
  [sandbox-and-isolation.md](../../docs/features/extensions/sandbox-and-isolation.md)
- **Permissions & ceilings** — `clamp-permissions.ts`, `permission-engine.ts`,
  install-time grants; `bundled-ceiling.ts` hard-caps bundled extensions.
- **Scheduling, loops & webhooks** — cron/schedule daemons, `defineLoop`
  (approvals, provenance-checked registration, global kill switch),
  `WebhookDeliveryDaemon` behind public `POST /api/hooks/:extensionId/:slug` ·
  [scheduling-and-loops.md](../../docs/features/extensions/scheduling-and-loops.md)
- **Hub pages** — extensions push live dashboards (`pushPage` →
  `page-schema.ts` / `panel-validator.ts` / `page-cache.ts`,
  `web/src/lib/server/hub-extension-pages.ts`).
- **Install/registry/manifest** — `installer.ts`, `registry.ts`, `manifest.ts`,
  `bundled.ts` (the `BUNDLED_EXTENSIONS` registry + `ensureBundledExtensions()`
  reconcile engine), `dependency-resolver.ts`.
- **Project-root resolution** — `project-root.ts` owns `getProjectRoot()` /
  `resolveProjectRoot()` (env → `import.meta` → `.git` walk-up → cwd, cached
  per process). `bundled.ts` re-exports them so pre-existing importers needed
  no edit, but **new code imports `./project-root` directly**. Keep that
  module's dependencies to `../logger` + node builtins — pinned by the
  "static import closure" test in `__tests__/project-root.test.ts`. It sat
  inside `bundled.ts` until 2026-08, and because `bundled.ts` reaches
  `db/queries/extensions.ts → db/connection.ts → migrate.ts`, both
  `src/db/migrate.ts` and `src/startup/background-timers.ts` had to fetch
  `getProjectRoot` by dynamic `import()` to keep that cycle open. Adding a
  DB/registry import here brings the workaround back.
  Note for anyone reading the resolution order: **step 4 (the `process.cwd()`
  fallback) is the path the shipped container takes on every boot**, so its
  WARN is expected output, not an incident. Steps 1–3 are dev/test/vitest
  paths. Details + the image-level evidence:
  [platform/projects.md](../../docs/features/platform/projects.md).

## Extension data (binding)

Every extension — bundled (`extensions/*`) or example
(`docs/extensions/examples/*/`) — stores its persistent user-visible state
under `<projectRoot>/.ezcorp/extension-data/<extension-name>/`. When reading or
writing extension-managed files (task stores, note vaults, config json, etc.),
always use that path. The `.ezcorp/` directory is gitignored. See
[../../docs/extensions/data-storage.md](../../docs/extensions/data-storage.md).

## Storage read-modify-write (binding)

An extension that does `storage.get(key)` → mutate → `storage.set(key)` MUST
run that critical section inside `withLock(key, …)` (`@ezcorp/sdk/runtime`).
The subprocess channel dispatches inbound frames fire-and-forget
(`void handleIncoming(msg)` in `packages/@ezcorp/sdk/src/runtime/channel.ts`),
so two `tools/call` frames — or a `tools/call` racing an
`ezcorp/event/*` notification — interleave, and the second `set` silently
discards the first's mutation. Symptom: state that "lags behind" or reverts,
never an error. Precedents: `task-tracking`, `ez-code`, `ez-code-factory`.

> **`ez-code-factory` no longer ships.** That reference extension
> (`docs/extensions/examples/ez-code-factory/**` — a local `git push gate`
> pipeline) was **retired 2026-08-03** in phase 9, superseded by the bundled
> `extensions/ez-factory` job console, once every security invariant it carried
> had a mutation-proven home in `extensions/ez-factory/**` or `src/**`. It is
> readable in git history. Comments across `src/`, `web/src/`, `packages/` and
> the e2e suite still cite it by name as the **provenance of a control** —
> "ez-code-factory drive-3", "ez-code-factory's `init_gate`", "ez-code-factory's
> mutating-git spawn site", "ez-code-factory's gate repos". Those are historical
> anecdotes recording a real observed defect, deliberately kept: the bug is why
> the control exists. None of them names a path that still resolves, and none
> implies the extension is installed. Some test fixtures also use the string as
> an arbitrary extension id; those are fixtures, not references.
> See [../../docs/features/extensions/ez-factory.md](../../docs/features/extensions/ez-factory.md).
Host-side writers to the same row need their own lock —
`src/runtime/task-snapshot-lock.ts` is the pattern.

## Extension logging (binding)

Host-side extension code (integration daemons, reverse-RPC handlers, spawn
bridges) MUST get its logger from `extensionLogger(name, component?)` in
`src/logger.ts` (repo root, i.e. `../logger.ts`) — never `logger.child(...)`
directly — so every extension log
lands under the `ext.<name>[.<component>]` subsystem namespace. That lets an
operator raise debug for one extension via `EZCORP_DEBUG=ext.<name>` (or all
extensions via `EZCORP_DEBUG=ext`, everything via `EZCORP_DEBUG=1`) without the
global `LOG_LEVEL=debug` firehose. Default-visible `info` should carry
once-per-cycle summaries; `debug` carries per-item detail; never log
secret/token plaintext. See
[../../docs/extensions/logging.md](../../docs/extensions/logging.md).
