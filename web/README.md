# sv

Everything you need to build a Svelte project, powered by [`sv`](https://github.com/sveltejs/cli).

## Creating a project

If you're seeing this, you've probably already done this step. Congrats!

```sh
# create a new project
npx sv create my-app
```

To recreate this project with the same configuration:

```sh
# recreate this project
npx sv@0.12.5 create --template minimal --types ts --no-install web
```

## Developing

Once you've created a project and installed dependencies with `npm install` (or `pnpm install` or `yarn`), start a development server:

```sh
npm run dev

# or start the server and open the app in a new browser tab
npm run dev -- --open
```

## Building

To create a production version of your app:

```sh
npm run build
```

You can preview the production build with `npm run preview`.

> To deploy your app, you may need to install an [adapter](https://svelte.dev/docs/kit/adapters) for your target environment.

## End-to-end tests

Two Playwright modes are wired:

| Script              | Config                       | DB        | Auth                       | When to use                                                                 |
| ------------------- | ---------------------------- | --------- | -------------------------- | --------------------------------------------------------------------------- |
| `test:e2e`          | `playwright.config.ts`       | none      | `PI_SKIP_INIT=1` (bypass)  | Fast. Every spec under `e2e/` mocks `fetch` via `e2e/fixtures/test-base`.   |
| `test:e2e:real`     | `playwright.real.config.ts`  | PGlite    | real cookie session        | Slow. Specs under `e2e/real-auth/` drive the full stack end-to-end.         |

### Real-auth mode

```sh
cd web
bun run test:e2e:real
```

What happens:

1. Playwright `webServer` runs `bun run build && bun run preview` with
   `EZCORP_DB_PATH` pointing to a fresh `mkdtemp` directory and **no**
   `PI_SKIP_INIT`. The DB layer initialises, migrates, and auth gates
   start enforcing.
2. `globalSetup` (`e2e/real-auth-setup.ts`) POSTs to `/api/auth/setup`
   to create the first-boot admin (the project has no
   `/api/auth/register` — `setup` is the canonical bootstrap path,
   gated on `getUserCount() === 0`). On success it logs in and saves
   the cookie to `e2e/.real-auth.json` (gitignored).
3. Every spec under `e2e/real-auth/*.spec.ts` reuses that storage
   state via `use.storageState`.
4. `globalTeardown` removes the per-run PGlite dir and the storage
   state file.

**Test user credentials** (see `e2e/real-auth-setup.ts`):

- email: `e2e-real@test.local`
- password: `GoodPass1!`
- role: `admin` (first-boot bootstrap path always creates admin)

**Workers**: forced to 1. PGlite is a single-writer embedded engine;
parallel workers writing to the same DB deadlock.

**Test-only HTTP endpoints**: two routes under `/api/__test/*` are
inert unless `PI_E2E_REAL=1` is set (they return 404 in production
deploys). Specs use them to seed `ez_drafts` rows + scaffold files
on disk and to clean up installed extensions — the running webServer
holds the PGlite lock so the seed fixture cannot open the DB
directly.

**DB lifecycle**: `EZCORP_DB_PATH` defaults to a unique `mkdtemp`
under `$TMPDIR/ezcorp-e2e-XXXXXX` per invocation. Override with
`PI_E2E_REAL_DB_PATH` to keep state across runs (the setup
endpoint then returns 403 "setup already completed" — the harness
falls back to login).

**Inner-loop dev**: keep a `bun run dev` or `bun run preview` running
locally and pass `--reuse-existing-server` to `playwright test`. The
30s+ `build` step in the webServer command is the slowest part of a
cold run.
