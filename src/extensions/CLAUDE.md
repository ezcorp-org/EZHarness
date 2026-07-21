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
  `bundled.ts`, `dependency-resolver.ts`.

## Extension data (binding)

Every extension — bundled (`extensions/*`) or example
(`docs/extensions/examples/*/`) — stores its persistent user-visible state
under `<projectRoot>/.ezcorp/extension-data/<extension-name>/`. When reading or
writing extension-managed files (task stores, note vaults, config json, etc.),
always use that path. The `.ezcorp/` directory is gitignored. See
[../../docs/extensions/data-storage.md](../../docs/extensions/data-storage.md).

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
