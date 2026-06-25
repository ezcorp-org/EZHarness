import { afterAll, afterEach, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotModules } from "./helpers/mock-cleanup";
import { __resetChannelForTests } from "@ezcorp/sdk/runtime";

// Isolate the test DB from the developer's persistent one. The real
// `db/connection.ts` captures `DB_PATH` into a module-level const at load
// (snapshotModules() imports it just below), and the unset default points at
// `~/ez-corp/.data/ez-corp-db` — the host dev DB. A test that runs the REAL
// init against that path is non-hermetic AND aborts outright when the dev DB
// is stale/corrupt (PGlite "Aborted()" on an unreadable data dir). Pin a fresh
// throwaway dir per test process BEFORE the snapshot freezes DB_PATH. Tests
// that mock db/connection (the common case, via test-pglite's mockDbConnection)
// ignore this; an explicit EZCORP_DB_PATH or external Postgres still wins.
if (!process.env.EZCORP_DB_PATH && !process.env.DATABASE_URL) {
  process.env.EZCORP_DB_PATH = join(mkdtempSync(join(tmpdir(), "ezcorp-test-db-")), "db");
}

// Snapshot real module exports BEFORE any test file can mock.module() them.
// This enables restoreModuleMocks() to undo mock leaks between files.
await snapshotModules();

// Workaround: `oauth-api.test.ts` registers `mock.module(alias, () =>
// require(relative))` at module load time for a handful of `$server/*`
// aliases, where `relative` is computed as `alias.replace("$server/",
// "../../")`. From that test file's location (`src/__tests__/`),
// `../../auth/oauth-callback-server` and `../../providers/encryption`
// both point two levels above `src/` — outside the repo. In isolation
// those requires still happen to work via Bun's loader cache (populated
// by this file's own `import(...)` calls in snapshotModules), but as
// soon as another test file's lifecycle runs first the cache state
// shifts and the require surfaces as "Cannot find module '../../X'
// from oauth-api.test.ts". Pre-registering the broken specifiers here
// as mocks whose factory returns the already-snapshotted real module
// gives Bun a STRING-keyed fallback so the resolve succeeds regardless
// of cache state, without modifying the problematic test file.
for (const rel of [
  "../../auth/oauth-callback-server",
  "../../providers/encryption",
  "../../auth/oauth",
]) {
  try {
    // Resolve the helper-relative path to an absolute one (this file is
    // in `src/__tests__/`, so `../../X` from helpers/ === `../X` from
    // here; we look it up from the helpers directory for consistency).
    const abs = require.resolve(rel, {
      paths: [import.meta.dir + "/helpers"],
    });
    mock.module(rel, () => require(abs));
  } catch {
    // If the real module doesn't exist (e.g. ../../auth/oauth in an
    // older checkout), skip — oauth-api.test.ts's own mock.module call
    // for that alias will take precedence.
  }
}

// Snapshot pristine globals before any test file can replace them.
// Some files replace globalThis.fetch / globalThis.WebSocket at module level
// and may fail to restore them, contaminating subsequent test files.
(globalThis as any).__pristineFetch = globalThis.fetch;
(globalThis as any).__pristineWebSocket = globalThis.WebSocket;

// Ensure every test file uses an in-memory DB
process.env.EZCORP_DB_PATH = ":memory:";

// Mock @sveltejs/kit — outside SvelteKit's vite build, these exports don't resolve.
// Provide all commonly used exports so every test file gets them automatically.
mock.module("@sveltejs/kit", () => ({
  json: (data: unknown, init?: { status?: number }) =>
    new Response(JSON.stringify(data), {
      status: init?.status ?? 200,
      headers: { "Content-Type": "application/json" },
    }),
  redirect: (status: number, location: string) => {
    throw { status, location, __isRedirect: true };
  },
  error: (status: number, message?: string) => {
    throw { status, body: { message: message ?? "" } };
  },
}));

// Reset the @ezcorp/sdk HostChannel singleton between tests so that any
// module-level `getChannel()` / `createToolDispatcher(...)` calls made
// by an imported extension entrypoint can't leak handler registrations,
// pending requests, or stdin-reader state into the next test.
// No-op if the singleton was never materialized. See the Phase 1 risk
// register ("Test isolation regression — HostChannel singleton leaks").
afterEach(() => {
  __resetChannelForTests();
});

// Clean up at the end of the entire test run
afterAll(async () => {
  const { closeDb } = await import("../db/connection");
  await closeDb().catch(() => {});
});
