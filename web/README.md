# EZCorp web

This SvelteKit application has its own Bun install. From the repository root,
use the Bun version in `.bun-version` and run:

```sh
bun install --frozen-lockfile
bun install --cwd web --frozen-lockfile
```

Browser lanes also need Playwright Chromium. Install it once per machine, and
again after a Playwright browser update:

```sh
(cd web && bunx playwright install chromium)
```

For local development, start the compose PostgreSQL service, then use the root
`bun run dev:stack` command. It starts the web server with that database and
avoids a separate embedded database that looks like an empty installation. For a production-shape web build:

```sh
cd web
bun run build
bun run preview
```

## End-to-end tests

Three Playwright modes are wired:

| Script              | Config                       | DB        | Auth                       | When to use                                                                 |
| ------------------- | ---------------------------- | --------- | -------------------------- | --------------------------------------------------------------------------- |
| `test:e2e`          | `playwright.config.ts`       | none      | `PI_SKIP_INIT=1` (bypass)  | Fast. The explicit mock lane uses `e2e/fixtures/test-base`.                 |
| `test:e2e:fresh`     | `playwright.fresh-setup.config.ts` | PGlite | no session | Blocking first-user `/setup` journey. |
| `test:e2e:real`     | `playwright.real.config.ts`  | PGlite    | real cookie session        | Slow. Specs under `e2e/real-auth/` drive the full stack end-to-end.         |

### Real-auth mode

```sh
cd web
bun run test:e2e:real
```

From the repository root, use the shared runner directly to choose a lane or
pass Playwright filters:

```sh
bun scripts/run-real-e2e.ts fresh-setup
bun scripts/run-real-e2e.ts real-auth
bun scripts/run-real-e2e.ts real-auth caller-tool-flow.spec.ts
```

What happens:

1. The runner creates a temporary database directory, then starts Playwright.
   Its `webServer` runs `bun run build && bun run preview` with
   `EZCORP_DB_PATH` pointing to that directory and **no**
   `PI_SKIP_INIT`. The DB layer initialises, migrates, and auth gates
   start enforcing.
2. `globalSetup` (`e2e/real-auth-setup.ts`) POSTs to `/api/auth/setup`
   to create the first-boot admin (the project has no
   `/api/auth/register` — `setup` is the canonical bootstrap path,
   gated on `getUserCount() === 0`). On success it logs in and saves
   the cookie to `e2e/.real-auth.json` (gitignored).
3. Every spec under `e2e/real-auth/*.spec.ts` reuses that storage
   state via `use.storageState`.
4. `globalTeardown` removes the storage-state file. After Playwright exits and
   its preview server has stopped, the runner removes its database directory
   and PID sidecar. A caller-supplied `PI_E2E_REAL_DB_PATH` remains intact.

**Test user credentials** (see `e2e/real-auth-setup.ts`):

- email: `e2e-real@test.local`
- password: `GoodPass1!`
- role: `admin` (first-boot bootstrap path always creates admin)

**Workers**: forced to 1. PGlite is a single-writer embedded engine;
parallel workers writing to the same DB deadlock.

**Test-only HTTP endpoints**: routes under `/api/__test/*` require
`PI_E2E_REAL=1`, `EZCORP_ALLOW_TEST_SURFACE=1`, and a non-production
`NODE_ENV`. The real preview config sets these flags. Specs use them to seed `ez_drafts` rows + scaffold files
on disk and to clean up installed extensions — the running webServer
holds the PGlite lock so the seed fixture cannot open the DB
directly.

**DB lifecycle**: the runner creates a unique `mkdtemp`
under `$TMPDIR/ezcorp-e2e-XXXXXX` per invocation. Override with
`PI_E2E_REAL_DB_PATH` to keep state across runs (the setup
endpoint then returns 403 "setup already completed" — the harness
falls back to login).
Direct Playwright calls with the real or fresh setup config must supply
`PI_E2E_REAL_DB_PATH`; the shared runner manages this by default.

**Port isolation**: the mock and real configs start a strict preview server.
Set `PI_E2E_MOCK_BASE_URL` or `PI_E2E_REAL_BASE_URL` to a free explicit port
when another browser lane is active. The server uses that exact port and fails
if it is occupied; it never attaches to another checkout's preview.
