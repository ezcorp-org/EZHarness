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
  "../../db/queries/extension-storage",
  "../../db/queries/memories",
  "../../db/queries/password-resets",
  "../../db/queries/users",
  "../../db/queries/attachments",
  "../../db/queries/modes",
  "../../db/schema",
  "../../extensions/registry",
  "../../extensions/tool-executor",
  "../../extensions/permissions",
  "../../extensions/installer",
  "../../extensions/manifest",
  "../../extensions/checksum",
  "../../extensions/bundled",
  "../../extensions/loader",
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
  "../../memory/extraction",
  "../../memory/lifecycle",
  "../../memory/compaction",
  "../../chat/attachments/content-builder",
  "../../chat/attachments/storage",
  "../../chat/attachments/validator",
  "../../lib/cache-utils",
  "../../mcp/client",
  "../../runtime/task-tracking-host",
  "../../runtime/start-assignment",
  "../../extensions/migrations/task-tracking-storage",
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
  "../../../web/src/lib/stores/connection",
  "../../../web/src/lib/api",
  "@mariozechner/pi-ai",
  "@mariozechner/pi-ai/oauth",
  "@mariozechner/pi-agent-core",
];

const snapshots = new Map<string, Record<string, unknown>>();

/**
 * Snapshot all commonly-mocked modules BEFORE any test file runs.
 * Must be called from preload.ts at module level (with await).
 * Uses spread to capture real exports as plain values (not live bindings).
 * Uses dynamic import() so ESM-only packages (e.g. @mariozechner/pi-ai) are captured.
 */
export async function snapshotModules() {
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

export function restoreModuleMocks() {
  for (const [path, exports] of snapshots) {
    try {
      mock.module(path, () => exports);
    } catch {
      // Ignore errors
    }

    // `$server/*` aliases are intentionally NOT re-registered here —
    // doing so cross-contaminates `oauth-api.test.ts`'s load (see the
    // comment on SERVER_ALIAS_PREFIXES above). Every test file that
    // needs a `$server/*` alias calls `mockServerAlias()` (or a sibling
    // helper) at its own module load, so the leak-prevention story is
    // still intact.
    void SERVER_ALIAS_PREFIXES;

    // Restore `$lib/*` aliases too. Those resolve to `web/src/lib/*`
    // at runtime; in MODULE_PATHS they're listed with the
    // `../../../web/src/lib/` prefix form. Strip it to rebuild the
    // `$lib/` alias key for re-registration.
    const WEB_LIB_PREFIX = "../../../web/src/lib/";
    if (path.startsWith(WEB_LIB_PREFIX)) {
      const rel = path.slice(WEB_LIB_PREFIX.length);
      try {
        mock.module(`$lib/${rel}`, () => exports);
      } catch {
        // Ignore errors
      }
    }
  }
}
