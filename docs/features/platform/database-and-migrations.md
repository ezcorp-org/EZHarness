# Database & Migrations

> _EZCorp's durable storage layer: a dual-driver (embedded PGlite / external Postgres) Drizzle stack fronting a single boot-time idempotent `migrate()`, wrapped in non-destructive failure handling — pre-boot snapshots, a migration circuit breaker, and a recovery-needed readiness state._

## Intent

Every persistent entity in EZCorp — users, conversations, messages, memories, extensions, audit rows, ~50 tables in all — lives in one Postgres-compatible database. EZCorp ships zero-config: the default backend is **embedded PGlite** (a WASM Postgres) so a single container needs no external DB, but the same code transparently targets **external Postgres** when `DATABASE_URL` is set. Schema evolution is deliberately simple: there is no migration-version table and no `drizzle-kit` diff at boot — instead one hand-written, fully idempotent `migrate()` (all `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … ADD COLUMN IF NOT EXISTS` + CTE backfills) runs on every boot. The hard part is reliability: the open/migrate path is engineered so a failed boot **never destroys user data** by default.

## How it works

### Driver selection (`src/db/connection.ts`)

`initDb()` is the single, idempotent (`_initPromise`-cached) entry point. It branches on `DATABASE_URL`:

- **External Postgres** (`initPostgres`): `drizzle-orm/bun-sql` over `Bun.sql`, pool size `DB_POOL_MAX` (default 20, clamped 1–100). Two driver quirks are patched here:
  - drizzle's default `jsonb`/`json` `mapToDriverValue = JSON.stringify` is replaced with identity, because Bun.sql already serializes JS objects to jsonb — leaving the default double-encodes (`{"x":1}` → the jsonb string scalar `"{\"x\":1}"`), which broke every `col->>'key'` access. `repairDoubleEncodedJsonb()` then unwraps any historical double-encoded rows (idempotent, object/array-only).
  - `db.execute()` is wrapped so raw SQL always returns `{ rows: [...] }` (bun-sql returns bare arrays; PGlite returns `{ rows }`).
- **Embedded PGlite** (`initPglite`): `drizzle-orm/pglite`. The `vector` and `pg_trgm` contrib extensions are registered **at PGlite construction** (not via late `CREATE EXTENSION` SQL — the contrib C functions must load alongside the engine, or `similarity()` fails). DB path comes from `EZCORP_DB_PATH` (default `$HOME/ez-corp/.data/ez-corp-db`; prod sets `/app/data/ezcorp` in the Dockerfile). The literal `:memory:` is the test sentinel (`IS_MEMORY`) but is handed to PGlite as the URI form `memory://`.

`getDb()` returns the Drizzle handle (typed `any` by design — the two drivers report incompatible HKT result types for `execute()`); `rawQuery(sql, params)` runs positional `$1`/`$2` queries against either driver (PGlite `.query()` or Bun.sql `$client.unsafe()` — never string-inlined, the old quote-doubling rewrite was injectable).

### The migration: one idempotent function (`src/db/migrate.ts`)

`migrate(db)` is a single ~1500-line async function. There is **no version ledger** — idempotency is the whole strategy:

1. `CREATE EXTENSION IF NOT EXISTS vector` first (vector columns depend on it).
2. ~53 `CREATE TABLE IF NOT EXISTS` blocks, interleaved with `ALTER TABLE … ADD COLUMN IF NOT EXISTS` / `ALTER COLUMN … TYPE` / `DROP NOT NULL` for tables that predate a column.
3. `CREATE INDEX IF NOT EXISTS` (b-tree, GIN FTS via `to_tsvector`, HNSW over `vector(384)` for memories / KB chunks / message chunks, trigram GIN for marketplace).
4. **CTE backfills** for new columns, all guarded to only touch still-`NULL` rows so re-runs never reattribute data: e.g. `messages.parent_message_id` chained by a `LAG()` window; ownerless `conversations`/`memories`/`agent_configs`/`knowledge_base_files` assigned to the first admin; `runs.user_id` backfilled from the **root** conversation's owner via a depth-capped (16) recursive CTE.
5. **Seeds** with `ON CONFLICT DO NOTHING`: the `global` project, the virtual `builtin` extension (native tool calls), and the built-in modes `plan` / `code-review` / `ez`.
6. A handful of one-off data-shape repairs driven from JS rather than PL/pgSQL `DO` blocks (PGlite's anonymous-block parser is limited) — e.g. the `extension_storage` `UNIQUE NULLS NOT DISTINCT` constraint rename + dedupe, and the `user_commands(user_id, name)` duplicate-rename before the unique index.

The DDL is intentionally driver-agnostic so the exact same statements run on PGlite (PG16) and external Postgres.

> `src/db/migrations/*.ts` (e.g. `add-feature-index.ts`, `add-lessons.ts`) each export an `up(db)` with the same DDL plus a rationale header. They are **not** sequenced at boot — `migrate()` inlines all DDL. The standalone modules exist for documentation, focused tests, and (a few) reuse by query modules. The boot path is `migrate()` only.

### Boot sequence (`web/src/lib/server/context.ts#ensureInitialized`)

1. `validateEnv()` → `await initDb()` (opens driver + runs `migrate()`).
2. `installShutdownHandlers()` and register `pglite-close` teardown **first**, so LIFO shutdown closes PGlite **last** (every daemon releases its handle before the engine closes — the invariant the 2026-05-10 stale-`postmaster.pid` incident demanded).
3. `startBackups()` → 30-minute interval backups; `stopBackups()` (which also takes a final backup) registered as teardown.

### Failure handling & durability (`src/db/connection.ts` + `src/db/backup.ts`)

Three distinct non-destructive failure paths, all surfacing through the `readiness` module (`src/readiness.ts` → `GET /api/ready`, 200 ready / 503 otherwise):

- **Open failure (data-recovery-needed).** If `openPglite()` throws (partial WAL, FS issue), the default is *fail loud, touch nothing*: write a `.ezcorp-recovery-needed.json` marker, set readiness `degraded / data-recovery-needed` with recovery hints, and re-throw so Docker's restart loop + healthcheck surface it. A pre-flight first removes stale `postmaster.pid` / `postmaster.opts` lockfiles (the common false-positive). The legacy destructive auto-rename-and-start-fresh path is opt-in only via `EZCORP_AUTO_DESTROY_ON_OPEN_FAILURE=1`. (Two 2026-05-10 prod incidents lost data when the old default renamed the dir aside.)
- **Migration failure (rollback + circuit breaker).** Before open+migrate, `snapshotPreBoot()` copies the DB dir to `backups/pre-boot-<sha>-<iso>/` (keep 3). If `migrate()` throws, `rollbackMigration()` closes PGlite, renames the failed dir to `.failed.<ts>` (atomic, kept for forensics), `cpSync`-restores the latest pre-boot snapshot, writes a `.migration-failed` marker keyed on `EZCORP_IMAGE_SHA`, sets readiness `degraded / migration-failed`, and `process.exit(1)`. On the **next** boot of that same image SHA, the circuit breaker reads the marker and **skips `migrate()`** entirely — booting on the restored snapshot so pre-failure features still work while `/api/ready` reports 503. A clean boot calls `clearMarker()`. (On external Postgres there is no snapshot/rollback — a failed migrate just sets `degraded` and re-throws; manual intervention.)
- **Interval backups.** `startBackups()` copies the live DB dir to `backups/ezcorp-db-<iso>/` every 30 min (keep 5), pruned by mtime. No-ops for `:memory:`, external Postgres, or while readiness is `degraded` (don't overwrite the trusted snapshot). `stopBackups()` takes a final backup on graceful shutdown.

### MCP-sandbox masking

`getDbMaskDirs()` returns the DB dir + backups dir so the MCP sandbox can mask (tmpfs) them — untrusted MCP processes must not read the platform DB off disk (it holds the encrypted JWT secret in the `settings` table). Empty for external Postgres / in-memory.

## Usage

Operators and code interact with the DB mostly indirectly; the surface area is:

- **Env vars**
  - `DATABASE_URL` — set ⇒ external Postgres (Bun.sql); unset ⇒ embedded PGlite.
  - `EZCORP_DB_PATH` — PGlite data dir (default `$HOME/ez-corp/.data/ez-corp-db`; prod `/app/data/ezcorp`; `:memory:` for tests).
  - `EZCORP_BACKUP_DIR` — override backup location (default: sibling `backups/` of the DB dir, so one `/app/data` mount covers both).
  - `DB_POOL_MAX` — Bun.sql pool size (default 20, clamped 1–100).
  - `EZCORP_IMAGE_SHA` — enables the migration circuit breaker + names snapshots (`"dev"` when unbuilt → breaker disabled).
  - `EZCORP_AUTO_DESTROY_ON_OPEN_FAILURE=1` — opt back into the legacy destructive open-failure recovery.
  - `EZCORP_NO_EXIT=1` / `NODE_ENV=test` — make `rollbackMigration()` throw instead of `process.exit(1)` (for tests).
- **HTTP**
  - `GET /api/ready` — 200 when migrate succeeded and the image is safe to route to; 503 (`degraded`) when blocked/recovery-needed. Orchestrators (Watchtower/K8s) gate rollouts on this.
  - `GET /api/health` — liveness (can the process answer HTTP?), orthogonal to readiness.
- **Code (`src/db/`)**
  - `initDb()` / `closeDb()` — boot/teardown, wired in `web/src/lib/server/context.ts`.
  - `getDb()` — typed Drizzle handle; the ~45 query modules in `src/db/queries/*.ts` are the real call sites.
  - `rawQuery(sql, params)` — positional-param raw SQL across both drivers.
  - `getDbMaskDirs()` / `getDbPath()` / `getPglite()` — sandbox + introspection helpers.
- **Schema source of truth**: `src/db/schema.ts` (Drizzle table definitions). Adding a table/column means editing both `schema.ts` (typed access) and `migrate.ts` (idempotent DDL) — they are kept in lockstep (53 tables each).

## Key files

- `src/db/connection.ts` — driver selection, `initDb`/`getDb`/`rawQuery`/`closeDb`, jsonb double-encode patch + repair, open-failure & migration-failure handling, `getDbMaskDirs`.
- `src/db/migrate.ts` — the single idempotent `migrate(db)`: all `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` DDL, indexes, CTE backfills, and seeds.
- `src/db/schema.ts` — Drizzle table definitions (53 `pgTable`s) — the typed API the query layer consumes.
- `src/db/backup.ts` — pre-boot snapshots, 30-min interval backups, pruning, and the `.migration-failed` / `.ezcorp-recovery-needed.json` markers.
- `src/db/migrations/*.ts` — per-feature `up(db)` modules (rationale headers + focused-test targets); **not** boot-sequenced.
- `src/db/queries/*.ts` — ~45 entity query modules built on `getDb()` (the actual read/write call sites).
- `src/readiness.ts` — `getReadiness`/`setReadiness`; backs `/api/ready`.
- `web/src/lib/server/context.ts` — boot wiring: `initDb()` → shutdown handlers (PGlite closed last, LIFO) → `startBackups()`.
- `web/src/routes/api/ready/+server.ts` — readiness endpoint (200/503).
- `web/src/routes/api/health/+server.ts` — liveness endpoint.

## Features it touches

Storage underpins nearly everything; the most direct relationships:

- [[data-and-entities]] — the entity model (`src/db/queries/*`) sits directly on this schema.
- [[deployment-and-releases]] — circuit breaker keys on `EZCORP_IMAGE_SHA`; `/api/ready` gates rollouts; backups live on the `/app/data` mount.
- [[audit-and-observability]] — `audit_log`, `observability_events`, `sdk_capability_calls`, `error_logs` are all tables here.
- [[persistent-memory]] — `memories` (+ HNSW `vector(384)` index, `memory_audit_log`, `memory_projects`) live in this schema.
- [[knowledge-base]] — `knowledge_base_files` / `_chunks` with HNSW embeddings.
- [[conversations]] — `conversations` / `messages` / `message_attachments` and their tree edges.
- [[runs-lifecycle]] — `runs` / `run_logs` / `active_runs`, including the root-walk `user_id` ownership backfill.
- [[sandbox-and-isolation]] — `getDbMaskDirs()` tells the MCP sandbox which dirs to mask off untrusted processes.
- [[settings-system]] — the `settings` table holds the encrypted JWT secret; the jsonb double-encode fix kept scalar settings intact.
- [[marketplace]] — `marketplace_*` tables + the pg_trgm/FTS GIN search indexes.
- [[scheduling-and-loops]] — `extension_schedules` / `extension_schedule_fires` / `briefing_configs` claim rows here.

## Related docs

- [production-guide](../../production-guide.md) — the boot sequence + migration-safety walkthrough, "Recovering from a failed migration" / "Recovering from data-recovery-needed state", snapshot/restore recipes, the `EZCORP_IMAGE_SHA` circuit breaker, Watchtower auto-update, and the §7 "Health vs readiness" (`/api/ready`) rollout gate.
- [deployment](../../deployment.md) — container networking + MCP sandbox isolation (the consumer of `getDbMaskDirs()`); does **not** cover the DB/migration lifecycle — that's in production-guide.md.

## Notes & gotchas

- **No migration version table — idempotency is the contract.** Every statement is `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` / `ON CONFLICT DO NOTHING`, and every backfill only touches still-`NULL` rows. Adding schema means appending idempotent DDL to `migrate.ts`; never assume ordering relative to a "last applied version."
- **`schema.ts` and `migrate.ts` must stay in lockstep.** `schema.ts` is the typed access layer; `migrate.ts` is the DDL that actually creates the structure. A column added to one but not the other is a silent runtime mismatch (both currently define 53 tables).
- **`src/db/migrations/*.ts` are NOT run at boot.** They're rationale + focused-test modules; the authoritative boot migration is `migrate()` in `migrate.ts`. Don't add a table there expecting it to apply.
- **Fail-loud is the default on open failure.** The destructive rename-and-start-fresh path only runs under `EZCORP_AUTO_DESTROY_ON_OPEN_FAILURE=1`. Two 2026-05-10 prod incidents destroyed data when the old default auto-renamed the data dir; the current default touches nothing and surfaces `data-recovery-needed` via `/api/ready`.
- **Migration circuit breaker needs `EZCORP_IMAGE_SHA`.** Without a built image SHA the breaker is disabled (and snapshots are named `pre-boot-dev-…`). The breaker keys the `.migration-failed` marker on the exact SHA, so a new image automatically re-attempts `migrate()`.
- **jsonb double-encoding is bun-sql-only.** PGlite is unaffected. The `PgJsonb`/`PgJson` `mapToDriverValue` monkey-patch + `repairDoubleEncodedJsonb()` run only on the external-Postgres path; the repair deliberately leaves scalar JSON strings (e.g. encrypted blobs in `settings.value`, ISO timestamps) untouched.
- **`vector` + `pg_trgm` register at construction, not via SQL alone.** Late `CREATE EXTENSION` succeeds against a stub but the C functions (`similarity()`, HNSW) won't exist. The SQL `CREATE EXTENSION` in `migrate.ts` only registers the catalog entry; the engine load happens in `connection.ts` / the test PGlite helper.
- **`rawQuery` is parameterized on both drivers.** It uses PGlite `.query(sql, params)` or Bun.sql `$client.unsafe(sql, params)` — server-side bind, never string interpolation. The historical quote-doubling rewrite was injectable; do not reintroduce inline value substitution.
- **PGlite is single-process.** Backups are `cpSync` of the data dir while the live engine is open; the stale-lockfile pre-flight (`postmaster.pid`/`postmaster.opts`) exists because a SIGKILL before `pglite.close()` leaves them behind and would otherwise look like corruption.
- **Backups skip degraded mode.** While readiness is `degraded` (circuit-breaker boot) the live DB *is* the restored pre-failure snapshot — the interval backup no-ops so it can't overwrite the trusted series.
