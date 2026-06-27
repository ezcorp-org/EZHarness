/**
 * Mock cleanup helper for Bun test.
 *
 * PROBLEM: Bun's mock.module() permanently replaces modules in the loader cache.
 * mock.restore() does NOT undo mock.module() calls — they leak across test files.
 *
 * SOLUTION: Snapshot real module exports in preload (before any test file mocks),
 * then re-register the real modules in afterAll of polluter test files.
 *
 * Usage:
 *   // In preload.ts — call once at startup
 *   import { snapshotModules } from "./helpers/mock-cleanup";
 *   snapshotModules();
 *
 *   // In heavy-mocking test files — restore in afterAll
 *   import { restoreModuleMocks } from "./helpers/mock-cleanup";
 *   afterAll(() => restoreModuleMocks());
 */
import { mock } from "bun:test";

// Paths relative to THIS file (src/__tests__/helpers/mock-cleanup.ts).
// ../../ goes up from helpers/ → __tests__/ → src/
// mock.module() resolves relative to the calling file, so we use ../../
// which from helpers/ resolves to the same absolute paths as ../ from __tests__/.
// db/connection IS included — restoring the real (uninitialized) module is safe
// because files that need it call mockDbConnection() at module level. NOT restoring
// it causes minimal stubs (like { insert: ... }) to leak across files.
const MODULE_PATHS = [
  "../../db/connection",
  "../../auth/middleware",
  "../../auth/jwt",
  "../../auth/password",
  "../../auth/oauth-callback-server",
  "../../db/queries/settings",
  "../../db/queries/conversations",
  // Phase 63 Plan 03: message-embed-outbox.test.ts mocks this to inject a
  // throw seam into createMessage's transaction (atomicity test). Snapshot
  // so restoreModuleMocks() re-registers the real upsert helper in afterAll
  // and the throwing stub never leaks into subsequent test files.
  "../../db/queries/message-embed-outbox",
  "../../db/queries/runs",
  "../../db/queries/projects",
  "../../db/queries/extensions",
  "../../db/queries/agent-configs",
  "../../db/queries/observability",
  "../../db/queries/active-runs",
  "../../db/queries/analytics",
  "../../db/queries/error-logs",
  "../../db/queries/marketplace",
  "../../db/queries/marketplace-versions",
  "../../db/queries/conversation-extensions",
  "../../db/queries/sessions",
  "../../db/queries/audit-log",
  "../../db/queries/extension-settings",
  "../../db/queries/extension-storage",
  "../../db/queries/memories",
  "../../db/queries/password-resets",
  "../../db/queries/users",
  "../../db/queries/attachments",
  "../../db/queries/modes",
  "../../db/queries/features",
  "../../db/queries/ez-drafts",
  "../../db/queries/lessons",
  "../../db/queries/tool-calls",
  "../../db/schema",
  "../../extensions/registry",
  "../../extensions/tool-executor",
  "../../extensions/permissions",
  "../../extensions/installer",
  "../../extensions/manifest",
  "../../extensions/checksum",
  "../../extensions/bundled",
  "../../extensions/bundled-ceiling",
  "../../extensions/bundled-lock",
  "../../extensions/loader",
  "../../extensions/sdk/verify",
  "../../extensions/entities/migrate",
  "../../extensions/audit-actions",
  "../../extensions/storage-handler",
  "../../extensions/security",
  "../../extensions/subprocess",
  "../../observability/collector",
  "../../providers/router",
  "../../providers/registry",
  "../../providers/credentials",
  "../../providers/encryption",
  "../../providers/shell",
  "../../providers/file",
  "../../providers/local-model-check",
  "../../providers/model-capabilities",
  "../../memory/injection",
  "../../memory/retrieval",
  "../../memory/embeddings",
  "../../memory/lifecycle",
  // Phase 64: embed-worker.test.ts mocks message-chunker to return predictable
  // single-chunk output without needing the real tokenizer loaded.
  "../../memory/message-chunker",
  "../../runtime/lessons/distiller",
  "../../runtime/lessons/triggers",
  "../../memory/compaction",
  "../../chat/attachments/content-builder",
  "../../chat/attachments/storage",
  "../../chat/attachments/validator",
  "../../lib/cache-utils",
  "../../mcp/client",
  "../../runtime/task-tracking-host",
  "../../runtime/orchestration-host",
  "../../runtime/ask-user-host",
  "../../runtime/mention-wiring",
  "../../runtime/start-assignment",
  "../../runtime/tools/permissions",
  "../../extensions/migrations/task-tracking-storage",
  // Phase 55-58 MCP work added new mock.module targets across these
  // paths. Each was discovered by mock-cleanup-coverage.test.ts (the
  // meta-test that walks every src/__tests__/*.test.ts for unsnapshot
  // mock.module() targets) and added here so restoreModuleMocks() can
  // re-register them and stop their stubs from leaking into subsequent
  // test files (a pollution that surfaces as full-suite failures on
  // agent-configs-handler, agent-input-form, api-tool-invoke.server).
  "../../extensions/runtime/dns",
  "../../extensions/runtime/internal-host",
  "../../extensions/runtime/seccomp-loader",
  "../../extensions/schedule-daemon",
  // Daily Briefing Phase 1: background-timers.test.ts stubs the
  // BriefingDaemon class (start()/stop()) during the bootstrap-wiring
  // suite so the real daemon (boot tick + setInterval) never runs
  // there. Snapshot so restoreModuleMocks() re-registers the real
  // class and the stub never leaks into briefing-daemon.test.ts.
  "../../runtime/briefing/daemon",
  // briefing-tools-wired-into-setup.test.ts mocks the agent-config
  // lookup (fixed briefing-agent id, no DB) and the tools wire (throw
  // seam for the fail-soft gate test). Snapshot both so the stubs
  // never leak into briefing-run / briefing-api / setup-tools suites.
  "../../runtime/briefing/agent-config",
  "../../runtime/briefing/tools",
  // Daily Briefing Phase 3: briefing-chat-tools-wired-into-setup.test.ts
  // mocks the chat-tools wire (throw seam for the fail-soft gate test).
  // Snapshot so the stub never leaks into the chat-tools' own suite.
  "../../runtime/briefing/chat-tools",
  "../../extensions/host-maintenance-daemon",
  // file-organizer: background-timers.test.ts stubs the FileOrganizerDaemon
  // class (start()/stop()) during the bootstrap-wiring suite so the real
  // host watcher (PID-lockfile + setInterval + fs walk) never runs there.
  // Snapshot so restoreModuleMocks() re-registers the real class in afterAll
  // and the stub never leaks into file-organizer-daemon.test.ts.
  "../../extensions/file-organizer-daemon",
  // github-projects: background-timers.test.ts stubs the GithubProjectsDaemon
  // class (start()/stop()) during the bootstrap-wiring suite so the real
  // poller (setInterval) never runs there. Snapshot so restoreModuleMocks()
  // re-registers the real class+factory in afterAll and the stub never leaks
  // into integrations/github-projects/__tests__/daemon.test.ts.
  "../../integrations/github-projects/daemon",
  // background-timers.test.ts also stubs the page cache (invalidate seam) so
  // the daemon-tick wiring assertions don't touch the real in-memory cache.
  // Snapshot so the stub never leaks into extension-events / hub suites.
  "../../extensions/page-cache",
  // Phase 64: background-timers.test.ts mocks this module to stub the
  // EmbedWorker class (start()/stop()) during the bootstrap-wiring suite, so
  // the real daemon (lockfile + getDb + setInterval) never runs there.
  // Snapshot so restoreModuleMocks() re-registers the real class in afterAll
  // and the stub never leaks into subsequent test files (e.g. embed-worker.test.ts,
  // which imports the REAL EmbedWorker).
  "../../extensions/embed-worker",
  "../../extensions/mcp-sandbox",
  // mcp-sandbox-require-sandbox.test.ts (EZCORP_MCP_REQUIRE_SANDBOX
  // fail-closed gate) and preview-netns.test.ts mock the kernel-probe
  // module to drive capability branches deterministically. Snapshot so
  // restoreModuleMocks() re-registers the real probes in afterAll.
  "../../extensions/mcp-netns",
  "../../extensions/permission-engine",
  "../../db/queries/sdk-capability-calls",
  "../../providers/llm",
  // drizzle-orm: mentions-search-symlink-integration.test.ts mocks
  // this third-party module's helpers (`like`, `eq`, …) to control
  // SQL composition without spinning up PGlite. Snapshot so the real
  // module re-binds in afterAll.
  "drizzle-orm",
  "../../logger",
  // `$lib/*` aliases resolve to `web/src/lib/*` at SvelteKit build
  // time; list the resolved web paths so preload can snapshot them. The
  // `$lib/...` form is also restored below via `LIB_ALIAS_PREFIXES`.
  "../../../web/src/lib/server/security/api-keys",
  "../../../web/src/lib/server/security/validation",
  "../../../web/src/lib/server/security/resource-quotas",
  "../../../web/src/lib/server/security/rate-limiter",
  "../../../web/src/lib/server/security/payload",
  "../../../web/src/lib/server/context",
  "../../../web/src/lib/server/oauth-config",
  "../../../web/src/lib/server/http-errors",
  "../../../web/src/lib/stores/connection",
  "../../../web/src/lib/api",
  "@mariozechner/pi-ai",
  "@mariozechner/pi-ai/oauth",
  "@mariozechner/pi-agent-core",
  // Extension SDK exports. Bundled-extension test files in
  // `docs/extensions/examples/*/` `mock.module("@ezcorp/sdk/runtime",
  // () => ({ getChannel: () => stripped, ... }))` to intercept
  // `fetchPermitted` or similar — the stripped channels are missing
  // methods (notably `request`) that other extensions' tests need at
  // load time. Snapshot the real module so `restoreModuleMocks()` can
  // re-register it in afterAll.
  "@ezcorp/sdk",
  "@ezcorp/sdk/runtime",
];

const snapshots = new Map<string, Record<string, unknown>>();

/**
 * Snapshot all commonly-mocked modules BEFORE any test file runs.
 * Must be called from preload.ts at module level (with await).
 * Uses spread to capture real exports as plain values (not live bindings).
 * Uses dynamic import() so ESM-only packages (e.g. @mariozechner/pi-ai) are captured.
 *
 * Set `EZCORP_FAST_TEST=1` to skip the eager imports. When skipped,
 * `restoreModuleMocks()` falls back to lazy `require()`-based factories
 * that re-resolve at mock-registration time. Safe for single-file local
 * runs where there are no prior test files to contaminate the loader
 * cache; NOT safe for the full suite where mock.module calls from one
 * file would leak into subsequent files without a real snapshot. CI
 * should leave this unset.
 */
export async function snapshotModules() {
  if (process.env.EZCORP_FAST_TEST === "1") {
    // Seed the keys so `restoreModuleMocks()` can still iterate, but
    // don't pay the import cost. Values stay null; the lazy branch in
    // restoreModuleMocks picks them up.
    for (const path of MODULE_PATHS) snapshots.set(path, null as unknown as Record<string, unknown>);
    return;
  }
  for (const path of MODULE_PATHS) {
    try {
      const mod = await import(path);
      snapshots.set(path, { ...mod });
    } catch {
      // Module may not exist or fail to load — skip it
    }
  }
}

/**
 * Re-register all snapshotted modules via mock.module().
 * This overrides any mock.module() calls from the current test file,
 * preventing mock leaks to subsequent files.
 *
 * Call in afterAll() of any test file that uses mock.module().
 */
// `$server/<top>/<…>` top-level namespaces the SvelteKit build actually
// serves. Previously the file kept a `SERVER_ALIAS_PREFIXES` list that
// drove an automatic "re-register every snapshotted module under its
// `$server/*` alias" block inside `restoreModuleMocks()`. That proved
// ACTIVELY HARMFUL: once one test file's `afterAll` pre-registered
// `$server/X/Y`, a subsequent test file that itself tried to register
// a `mock.module("$server/X/Y", () => require("<relative>"))` triggered
// a Bun module-resolution failure attributed to the subsequent file —
// the relative specifier inside the factory only happened to resolve
// cleanly when no prior registration was in place. `oauth-api.test.ts`
// uses exactly that pattern (a literal `require("../../...")` from
// `src/__tests__/`, where the specifier points outside the repo), so
// every batch that ran a `restoreModuleMocks()` polluter before
// `oauth-api.test.ts` produced
//   "Cannot find module '../../auth/oauth-callback-server' from
//    oauth-api.test.ts".
// The set is still exported (indirectly, via its name) so the
// mock-cleanup coverage meta-test can recognise a `$server/*` path as
// legitimate when scanning test files; the array is no longer consumed
// by restoration.
const SERVER_ALIAS_PREFIXES = [
  "db/",
  "auth/",
  "extensions/",
  "providers/",
  "memory/",
  "chat/",
  "lib/",
  "mcp/",
  "routes/",
  "runtime/",
  "observability/",
];

/** `$server/*` alias paths skipped by restoreModuleMocks' auto-
 *  restoration. phase-2b-e2e.test.ts registers an async factory for
 *  `$server/db/connection` whose promise-resolution interacts badly
 *  with this function's lazy `() => require(...)` form, causing
 *  bun-test to hang at process exit after scratchpad-bundled-install's
 *  afterAll runs this function. We skip those aliases — each test file
 *  that needs them registers them itself via its own mock.module call.
 *  (scratchpad-e2e.test.ts used to hit the same hang; it now uses a
 *  sync factory and documents the pitfall inline.) */
const SKIP_SERVER_ALIAS_RESTORE = new Set<string>([
  "db/connection",
]);

export function restoreModuleMocks() {
  for (const [path, exports] of snapshots) {
    try {
      // Fast-test mode: snapshot was skipped, fall back to a lazy
      // `require()` factory. Bun supports this pattern (see preload.ts's
      // oauth-api workaround). It re-resolves at mock-registration time,
      // which is safe for single-file runs.
      if (exports === null) {
        mock.module(path, () => require(path));
      } else {
        mock.module(path, () => exports);
      }
    } catch {
      // Ignore errors
    }

    // Restore `$server/*` aliases so a prior test file's
    // `mockServerAlias()` registrations don't leak into subsequent
    // files (which would shadow their own mocks). The lazy
    // `require(path)` factory form is critical: with a baked-in
    // `exports` snapshot, Bun's mock.module quirk prevents later test
    // files from re-mocking the underlying relative path. The lazy
    // factory re-dispatches at each resolution, letting the next test
    // file's own `mock.module("../../X", ...)` override the alias.
    //
    // $server/db/connection is skipped because phase-2b-e2e registers
    // an async factory there whose promise-resolution interacts badly
    // with the lazy require pattern and hangs bun-test at exit.
    //
    // oauth-api.test.ts's `mock.module(alias, () => require("../../X"))`
    // pattern is handled by preload.ts's string-keyed fallback for the
    // specific broken specifiers it consumes.
    if (path.startsWith("../../")) {
      const rel = path.slice("../../".length);
      if (
        SERVER_ALIAS_PREFIXES.some((p) => rel.startsWith(p)) &&
        !SKIP_SERVER_ALIAS_RESTORE.has(rel)
      ) {
        try {
          mock.module(`$server/${rel}`, () => require(path));
        } catch {
          // Ignore errors
        }
      }
    }
  }
}
