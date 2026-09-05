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
  "../../extensions/cli-control",
  "../../db/queries/extension-releases",
  "../../../scripts/migrate-extension-v4",
  "../../extensions/extension-lifecycle-service",
  "../../extensions/source-import",
  "../../extensions/project-open-pr",
  "../../search/egress",
  "@ezcorp/extension-runner",
  "../../db/connection",
  "../../auth/middleware",
  "../../auth/jwt",
  "../../auth/password",
  "../../auth/oauth-callback-server",
  // extension-wire-authz.test.ts stubs `hasExtensionScope` to drive the wire
  // gate's grant branch without a DB. Snapshot it: a leaked stub would answer
  // the RBAC scope question for every later file, which is a silent ALLOW.
  "../../auth/extension-rbac",
  // The wire gate itself. `conversation-extensions-route.test.ts` stubs
  // `partitionWirableExtensions` with an ALLOW-BIASED fake (it allows every
  // candidate the test did not explicitly deny). A leaked stub would answer
  // "may this user attach this MCP extension" for every later file — the
  // exact silent-ALLOW class this helper exists to prevent. Snapshotting it
  // is also what makes the `$server/auth/extension-wire-authz` ALIAS
  // restorable: the restore loop below derives the alias from this list.
  "../../auth/extension-wire-authz",
  "../../db/queries/settings",
  "../../db/queries/conversations",
  // goal-host-db-helpers.test.ts stubs the atomic metadata writers to assert
  // the delegation without a DB. A leaked stub would make every later file's
  // `conversations.metadata` write a silent no-op — the writes would look
  // like they landed and nothing would be stored.
  "../../db/queries/conversation-metadata",
  // Phase 63 Plan 03: message-embed-outbox.test.ts mocks this to inject a
  // throw seam into createMessage's transaction (atomicity test). Snapshot
  // so restoreModuleMocks() re-registers the real upsert helper in afterAll
  // and the throwing stub never leaks into subsequent test files.
  "../../db/queries/message-embed-outbox",
  // setup-tools-memory-tail.test.ts stubs KB search to drive the memory/KB
  // injection success path; snapshot so the stub never leaks.
  "../../db/queries/knowledge-base",
  "../../db/queries/runs",
  "../../db/queries/projects",
  // The project-membership reads the projects API and the workflow read/run
  // ladder authorize against. Stubbed by the two security suites; snapshot
  // so an in-memory membership store never leaks into a later file and
  // silently authorizes something.
  "../../db/queries/project-members",
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
  "../../db/queries/workflows",
  "../../db/queries/workflow-runs",
  "../../db/queries/workflow-approvals",
  // C3 phase 6: the shared consent-record assembly resolves a definition's
  // version identity through this module, and its suite stubs it.
  "../../db/queries/workflow-versions",
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
  // Loops EZ Mode: event-subscription-dispatcher.test.ts mock.module's the
  // kill-switch gate; snapshot so the stub never leaks past the file.
  "../../extensions/loops-kill-switch",
  // tool-executor-legacy-handler-provenance.test.ts mock.module's the six
  // LEGACY singleton-reading reverse-RPC handlers to capture the ctx the
  // executor builds (token-wins-over-singleton provenance suite). Snapshot
  // so restoreModuleMocks() re-registers the real handlers in afterAll and
  // the capture stubs never leak into subsequent test files.
  "../../extensions/task-events-handler",
  "../../extensions/spawn-assignment-handler",
  "../../extensions/cancel-run-handler",
  "../../extensions/network-handler",
  "../../extensions/finalize-tool-call-handler",
  // The last reverse-RPC handler that was missing from this block (issue
  // #208). TWO suites stub it and both are real polluters:
  // extension-events-hub-branch.test.ts fakes `handleAppendMessageRpc`
  // behind the `$server/*` alias, and tool-executor-rpc-delegates
  // .unit.test.ts stubs the relative path. A leaked stub answers "append
  // this message to the conversation" with a canned success for every later
  // file, so a suite asserting a real persist would pass on nothing.
  // Cheap to preload: its only runtime imports are drizzle-orm, db/connection,
  // db/schema, db/queries/{conversation-extensions,conversations,tool-calls}
  // — every one of them already snapshotted above — plus three leaf modules
  // in extensions/ (rate-limit, capability-flags, json-rpc). No daemon, no
  // preview graph, nothing that hangs phase-2b-e2e.
  "../../extensions/append-message-handler",
  "../../extensions/agent-configs-handler",
  "../../extensions/permissions",
  "../../extensions/installer",
  "../../extensions/author-gate",
  "../../extensions/manifest",
  "../../extensions/checksum",
  // "../../extensions/bundled" stays TRIMMED (wave 3): its eager preload
  // import pulled in the whole bundled-extension graph per spawn. The one
  // suite that still stubs it (assert-bundled-not-stranded.test.ts) mocks it
  // at module top level and never imports the real one, so the residual leak
  // is inert under scripts/test.sh's one-process-per-file pool. That suite is
  // held by an explicit EXEMPT_PATTERNS entry in mock-cleanup-coverage.test.ts,
  // not by this comment: loadModulePaths() strips `//` lines before scraping,
  // so quoting a path here documents it without snapshotting it (issue #138).
  //
  // `project-root` IS snapshotted, and cheaply: the resolver was split out
  // of bundled.ts and imports only `../../logger` + node builtins, so the
  // preload import costs nothing like the bundled graph did. It's the seam
  // migrate-extension-state-root-resolve-failure.test.ts stubs to make
  // getProjectRoot() throw, and getProjectRoot() is process-cached — a
  // throwing stub leaking into a later file would fail it far from the
  // cause.
  "../../extensions/project-root",
  "../../extensions/bundled-ceiling",
  "../../extensions/bundled-lock",
  "../../extensions/loader",
  "../../extensions/sdk/verify",
  "../../extensions/entities/migrate",
  "../../extensions/audit-actions",
  // The MCP audit-metadata projection. Two suites stub it to assert the
  // routes' call shape; it is a pure module with no heavy import graph, so
  // snapshotting it is free.
  "../../extensions/mcp-audit",
  "../../extensions/secrets-store",
  // "../../extensions/storage-handler" trimmed (wave 3): zero mockers.
  "../../extensions/security",
  // Loops Phase 2: event-subscription-dispatcher.test.ts mock.module's the
  // loops kill-switch (global suspend gate) to drive its allow/deny branches
  // without touching real settings. Snapshot so restoreModuleMocks()
  // re-registers the real module in afterAll and the stub never leaks.
  "../../extensions/loops-kill-switch",
  "../../extensions/subprocess",
  "../../observability/collector",
  "../../providers/router",
  "../../providers/registry",
  "../../providers/credentials",
  // The CredentialStore + getAuth wrapper (pi-ai 0.83.0's replacement for
  // the removed getOAuthApiKey). openai-extension-creds.test.ts stubs
  // `resolveOAuthAuth` here; snapshot so the stub never leaks.
  "../../providers/credential-store",
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
  // "../../runtime/lessons/distiller" trimmed (wave 3): zero mockers
  // (triggers below IS mocked and stays).
  "../../runtime/lessons/triggers",
  "../../memory/compaction",
  "../../chat/attachments/content-builder",
  "../../chat/attachments/storage",
  "../../chat/attachments/validator",
  "../../lib/cache-utils",
  // lessons-distiller-host-integration.test.ts mocks the shared pi-ai
  // `complete()` wrapper — the ONE LLM seam in an otherwise fully-real
  // subprocess↔host run. Snapshot so restoreModuleMocks() re-registers
  // the real wrapper in afterAll and the fake model never leaks into
  // llm-handler / goal-host suites.
  "../../lib/pi-complete",
  "../../mcp/client",
  "../../runtime/task-tracking-host",
  // watchdog-runs-terminalize.integration.test.ts mocks the C2 boot
  // reconciliation pass to exercise the watchdog's wiring (call +
  // self-catch) without a DB. Snapshot so restoreModuleMocks()
  // re-registers the real function and the stub never leaks.
  "../../runtime/boot-reconcile-assignments",
  "../../runtime/orchestration-host",
  "../../runtime/ask-user-host",
  "../../runtime/mention-wiring",
  "../../runtime/workflow-loader",
  "../../runtime/workflow-runner",
  "../../extensions/triggers-handler",
  // The dynamic cron/webhook store behind triggers-handler (issue #208).
  // web/src/routes/api/extensions/__tests__/triggers-route.test.ts stubs
  // `listDynamicCrons` / `listDynamicWebhooks` with call-recording fakes and
  // calls restoreModuleMocks() in afterAll, so the snapshot is what makes that
  // restore real rather than a no-op. Cheap to preload: node:crypto,
  // db/connection, db/schema, drizzle-orm and extensions/manifest — all
  // already imported above.
  "../../extensions/triggers-store",
  "../../runtime/executor-helpers",
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
  // tool-executor-schedule-daemon.test.ts mock.module's the schedule
  // reverse-RPC handler to capture the ctx the executor threads into it
  // (setScheduleDaemon wiring suite). Snapshot so restoreModuleMocks()
  // re-registers the real handler in afterAll and the capture stub never
  // leaks into subsequent test files. Safe to eagerly preload: its only
  // runtime imports are logger + db/queries/* (already snapshotted) — it
  // does NOT pull the preview-daemon / activate-extension graphs that
  // hang phase-2b-e2e.
  "../../extensions/schedule-handler",
  // Loops EZ Mode Phase 2: event-subscription-dispatcher.test.ts mocks the
  // global loops kill switch to drive its suspend/resume branches. Snapshot so
  // restoreModuleMocks() re-registers the real reader and the stub never leaks
  // into loops-kill-switch.test.ts / the webhook + schedule daemon suites.
  "../../extensions/loops-kill-switch",
  // Loops EZ Mode Phase 4: background-timers.test.ts stubs the
  // WebhookDeliveryDaemon class (start()/stop()) during the bootstrap-wiring
  // suite so the real daemon (getDb reap + setInterval) never runs there.
  // Snapshot so restoreModuleMocks() re-registers the real module (class +
  // drainDelivery / buildFireContext / tryParseWebhookJson) in afterAll and the
  // stub never leaks into webhook-delivery-daemon.test.ts (which imports the
  // REAL exports).
  "../../extensions/webhook-delivery-daemon",
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
  // conversation-extensions-route.test.ts (web route __tests__) mocks
  // `$lib/server/conversation-ownership`; snapshot it here so
  // restoreModuleMocks() re-registers the real ownership walk.
  "../../../web/src/lib/server/conversation-ownership",
  "../../../web/src/lib/stores/connection",
  "../../../web/src/lib/api",
  // Bare "@earendil-works/pi-ai" trimmed (wave 3): every pi-ai mock in the
  // population targets /compat, /oauth or /providers/all — the bare
  // specifier had zero.
  "@earendil-works/pi-ai/compat",
  "@earendil-works/pi-ai/oauth",
  // credentials.test.ts stubs `builtinModels` here — the network boundary for
  // OAuth refresh since pi-ai 0.83.0 removed `getOAuthApiKey`. Snapshot so the
  // stub never leaks into a later file and silently answers a real getAuth.
  "@earendil-works/pi-ai/providers/all",
  "@earendil-works/pi-agent-core",
  // Extension SDK exports. Bundled-extension test files in
  // `docs/extensions/examples/*/` `mock.module("@ezcorp/sdk/runtime",
  // () => ({ getChannel: () => stripped, ... }))` to intercept
  // `fetchPermitted` or similar — the stripped channels are missing
  // methods (notably `request`) that other extensions' tests need at
  // load time. Snapshot the real module so `restoreModuleMocks()` can
  // re-register it in afterAll. (Bare "@ezcorp/sdk" trimmed in wave 3:
  // only the /runtime subpath is ever mocked.)
  "@ezcorp/sdk/runtime",
];

const snapshots = new Map<string, Record<string, unknown>>();

/**
 * Snapshot all commonly-mocked modules BEFORE any test file runs.
 * Must be called from preload.ts at module level (with await).
 *
 * TRAP — a module that FAILS TO LOAD here becomes unmockable for the whole
 * run. The `catch` below swallows the error, but bun has already cached the
 * failed module record, and a later `mock.module("<same path>", …)` does NOT
 * displace it: every test file whose import graph reaches that module dies on
 * the original load error, and no amount of mocking around it helps. Measured
 * during the pi-ai 0.83.0 upgrade — `providers/credentials` imported a
 * `@earendil-works/pi-ai/oauth` export the new version had removed, and 114
 * test files went red with `SyntaxError: Export named 'getOAuthApiKey' not
 * found`, including files that explicitly mocked `providers/credentials`.
 * If a broad, unexplained sweep of failures all names one missing export,
 * fix the import — do not try to mock past it. (`EZCORP_FAST_TEST=1` skips
 * these eager imports, which is a useful way to confirm that diagnosis.)
 * Uses spread to capture real exports as plain values (not live bindings).
 * Uses dynamic import() so ESM-only packages (e.g. @earendil-works/pi-ai) are captured.
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
