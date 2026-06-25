/**
 * Bundled extensions — auto-installed on first startup.
 */

import type { ExtensionManifestV2, ExtensionPermissions } from "./types";
import type { ExtensionRegistry } from "./registry";
import type { ExtensionProcess } from "./subprocess";
import { getExtensionByName, updateExtension } from "../db/queries/extensions";
import { installFromLocal } from "./installer";
import { loadManifestFresh } from "./loader";
import { insertAuditEntry } from "../db/queries/audit-log";
import { EXT_AUDIT_ACTIONS, type ExtensionAuditMetadata } from "./audit-actions";
import { clampToBundledCeiling, getCeiling } from "./bundled-ceiling";
import { canonicalizeAndHash, verifyManifestAgainstLock } from "./bundled-lock";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { logger } from "../logger";
const log = logger.child("extensions");
import { fileURLToPath } from "node:url";

interface BundledExtension {
  name: string;
  path: string;
  permissions: ExtensionPermissions;
  /**
   * Phase 53 fix: when true, the host spawns this extension's subprocess
   * during boot (after `ensureBundledExtensions` + `registry.loadFromDb`
   * + `eventSubscriptionDispatcher.start`). Required for bundled
   * extensions whose ONLY entrypoint is event subscription — without a
   * running subprocess, `EventSubscriptionDispatcher.dispatch` silently
   * drops every wired event because `getProcessIfRunning` returns null
   * (it's documented as "Never starts a new process").
   *
   * Set this ONLY for extensions that:
   *   - declare `eventSubscriptions` AND
   *   - have no LLM-callable tools (so the tool-executor never spawns
   *     them) AND
   *   - have no manual trigger (no on-mention auto-wire, no extension
   *     command).
   *
   * Extensions that ship with tools, agent mentions, or on-first-use
   * wiring (most of the bundled list) MUST NOT set this — they spawn
   * lazily when invoked, which is the intended pattern.
   *
   * Boot-spawn failures are logged + swallowed by
   * `bootSpawnFlaggedBundledExtensions` so a flaky extension cannot
   * brick host startup; the next boot retries.
   */
  bootSpawn?: boolean;
  /**
   * v1.4 transitional opt-in for bundled extensions that legitimately
   * need credential-shaped env grants (`*_API_KEY|TOKEN|SECRET`)
   * before the v1.5+ `ctx.secrets` host-brokered cred surface lands.
   *
   * The hard `*_API_KEY` install gate at
   * `src/extensions/clamp-permissions.ts:checkEnvKeyLeakInstallGate`
   * fails closed for ANY install with credential-shaped env names,
   * with one carve-out: bundled extensions with this flag set to
   * `true`. Each escape-hatch install writes a
   * `ENV_KEY_LEAK_BUNDLED_ESCAPE_HATCH_USED` audit row for traceability,
   * separate from the existing `ENV_KEY_LEAK_WARNING` migration-soft
   * row.
   *
   * Set this ONLY for bundled extensions whose env grant is either:
   *   - A host-internal cred (`EZCORP_API_KEY`, `EZCORP_SESSION_COOKIE`)
   *     that the host injects via `bootstrapBundledCredentials` rather
   *     than expecting the user to populate. Different category from
   *     user-supplied API keys; will likely never need migration.
   *   - A third-party API cred that is BYOK + injected via a
   *     per-extension cred resolver (see e.g.
   *     `web/src/lib/server/security/openai-extension-creds.ts`).
   *     Pending the v1.5+ `ctx.secrets` migration.
   *
   * GREP `envEscapeHatch` to find every escape-hatch entry when the
   * migration lands. Removing this flag should remove `permissions.env`
   * entries that match `_API_KEY|TOKEN|SECRET` at the same time —
   * leaving the env grant without the flag will fail-closed at install.
   *
   * User-installed extensions never get this opt-in; the install-gate
   * caller hardcodes `isBundled` from the bundled-install path. The
   * flag is bundled-only by construction.
   */
  envEscapeHatch?: boolean;
  /**
   * Loop-safety floor. When `true`, this bundled extension is
   * load-bearing for the agent's ability to recover from a stuck
   * state — disabling it removes an escape hatch and can trap an
   * agent in a re-assertion loop (the exact `harness-smoke-test`
   * incident: `ask-user` was auto-disabled at boot by the S9
   * version-bump gate, so a blocked agent could not ask a clarifying
   * question).
   *
   * Effects (see the S9 gate + `assert-critical-extensions.ts`):
   *   - S9 version-bump gate: a `critical` entry whose new permission
   *     set is WITHIN the bundled ceiling is auto-accepted (record the
   *     new version, keep `enabled=true`, write an auto-reapproval
   *     audit row) instead of silently disabled. If it EXCEEDS the
   *     ceiling the disable stands (security floor) and the startup
   *     invariant escalates loudly.
   *   - Startup invariant: every `critical` ext must be `enabled=true`
   *     after `ensureBundledExtensions()`; a violation logs ERROR and
   *     (if on-disk perms are within ceiling) one-time re-enables it.
   *
   * Set this ONLY for extensions that are an agent loop-escape
   * primitive (`ask-user`, `task-tracking`). It is NOT a "this
   * extension is important" flag.
   */
  critical?: boolean;
}

/**
 * Resolve project root — works in both direct Bun execution and
 * SvelteKit bundled-server contexts (vite preview).
 *
 * Resolution order (first match wins):
 *
 *   1. `EZCORP_PROJECT_ROOT` env var — explicit override. Validated: the
 *      path must exist AND contain `docs/extensions/examples/`. An env
 *      var pointing at a non-existent dir or one missing the bundled
 *      tree is ignored (not fail-closed, just falls through) so a stale
 *      shell env doesn't brick startup.
 *   2. Substring match on `import.meta.dir` / `import.meta.url` — works
 *      under direct `bun src/...` execution where this file's path
 *      contains `src/extensions/`. Cheapest path; preserves existing
 *      behavior for unit tests and host scripts.
 *   3. Walk up from `import.meta.dir` (or `process.cwd()` if the meta
 *      lookup failed) looking for a `.git` directory. Required for
 *      Vite-bundled `vite preview` where step 2 fails because the
 *      bundler rewrites `import.meta.url` to point inside
 *      `web/build/server/`. Result must also contain
 *      `docs/extensions/examples/` to be accepted — bare `.git` in a
 *      vendor dir isn't enough.
 *   4. Fallback to `process.cwd()` with a WARN log so telemetry catches
 *      the "shouldn't happen in production" case.
 *
 * Cached after the first call (process-lifetime). Tests can reset via
 * the `__resetProjectRootCacheForTests` seam below.
 *
 * Exported so the test-only `__test/cleanup-extension` route in `web/`
 * can reuse the canonical implementation rather than re-deriving
 * project root with a separate `.git`-walk helper.
 */

interface ProjectRootOverrides {
  /** Override for the `EZCORP_PROJECT_ROOT` env var. */
  env?: NodeJS.ProcessEnv;
  /** Override for `import.meta.dir`. Pass an empty string to simulate "missing". */
  importMetaDir?: string;
  /** Override for the starting cwd in the `.git` walk-up. */
  cwd?: string;
  /** Override for the existsSync probe (used to fake bundled tree presence). */
  existsSync?: (p: string) => boolean;
}

let cachedProjectRoot: string | undefined;

/**
 * Test-only: drop the cached resolution so the next `getProjectRoot()`
 * call re-runs the full resolution order. Do NOT call from production
 * code — the cache is intentional (the answer is stable per process).
 */
export function __resetProjectRootCacheForTests(): void {
  cachedProjectRoot = undefined;
}

/**
 * Walk up from `from` looking for a directory containing `.git`.
 * Returns the first match, or `undefined` if the root is reached
 * without finding one. `.git` may be a directory (normal repo) or a
 * file (git worktree / submodule), so we accept either.
 */
function walkUpForGit(
  from: string,
  exists: (p: string) => boolean,
): string | undefined {
  let dir = from;
  // Hard cap on iterations as a belt-and-braces guard against a
  // pathological filesystem where `dirname()` doesn't fixed-point.
  for (let i = 0; i < 64; i++) {
    if (exists(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

function isProjectRootCandidate(
  root: string,
  exists: (p: string) => boolean,
): boolean {
  return exists(join(root, "docs", "extensions", "examples"));
}

/**
 * Internal resolver used by both `getProjectRoot()` (the cached entry
 * point) and tests (via the overrides parameter). Pure — no
 * side-effects beyond the optional WARN log emitted by the caller when
 * step 4 (cwd fallback) fires.
 */
export function resolveProjectRoot(overrides: ProjectRootOverrides = {}): {
  root: string;
  source: "env" | "import-meta" | "git-walk" | "cwd-fallback";
} {
  const env = overrides.env ?? process.env;
  const exists = overrides.existsSync ?? existsSync;

  // 1) Env override.
  const envRoot = env.EZCORP_PROJECT_ROOT;
  if (typeof envRoot === "string" && envRoot.length > 0) {
    if (exists(envRoot) && isProjectRootCandidate(envRoot, exists)) {
      return { root: envRoot, source: "env" };
    }
    // Stale env var — log and fall through. Don't fail-closed: a real
    // operator with a typo in their shell rc should still get a server.
  }

  // 2) Substring match on import.meta.dir / import.meta.url.
  // `overrides.importMetaDir` distinguishes "test passed a value" from
  // "test didn't override" — `in` check so an empty string means
  // "simulate missing import.meta.dir" without falling back to the real
  // one.
  const hasMetaOverride = "importMetaDir" in overrides;
  const metaDir = hasMetaOverride
    ? (overrides.importMetaDir ?? "")
    : (typeof import.meta.dir === "string" ? import.meta.dir : "");
  if (metaDir && metaDir.includes(join("src", "extensions"))) {
    return { root: join(metaDir, "..", ".."), source: "import-meta" };
  }
  if (!hasMetaOverride) {
    // Try import.meta.url as a secondary signal — same substring match,
    // different source. Skipped when the test override is in play (the
    // test wants to drive resolution without bleed-through from this
    // file's actual path).
    try {
      const thisFile = fileURLToPath(import.meta.url);
      const thisDir = dirname(thisFile);
      if (thisDir.includes(join("src", "extensions"))) {
        return { root: join(thisDir, "..", ".."), source: "import-meta" };
      }
    } catch { /* not a file URL */ }
  }

  // 3) `.git` walk-up starting from metaDir (if present) then cwd.
  const cwd = overrides.cwd ?? process.cwd();
  const starts: string[] = [];
  if (metaDir) starts.push(metaDir);
  starts.push(cwd);
  for (const start of starts) {
    const gitRoot = walkUpForGit(start, exists);
    if (gitRoot && isProjectRootCandidate(gitRoot, exists)) {
      return { root: gitRoot, source: "git-walk" };
    }
  }

  // 4) Final fallback.
  return { root: cwd, source: "cwd-fallback" };
}

export function getProjectRoot(): string {
  if (cachedProjectRoot !== undefined) return cachedProjectRoot;
  const { root, source } = resolveProjectRoot();
  if (source === "cwd-fallback") {
    log.warn(
      "getProjectRoot() fell through to process.cwd() — bundled-extension lookups may fail. " +
        "Set EZCORP_PROJECT_ROOT, run from the repo root, or ensure docs/extensions/examples/ is present.",
      { cwd: root },
    );
  }
  cachedProjectRoot = root;
  return root;
}


const BUNDLED_EXTENSIONS: BundledExtension[] = [
  {
    // Ephemeral conversation-scoped KV store, converted from the built-in
    // tool formerly at src/runtime/tools/scratchpad.ts. Auto-wired into
    // a conversation by src/runtime/executor.ts when agents are mentioned
    // at depth 0 — see the S7 security gate in that call site.
    name: "scratchpad",
    path: "docs/extensions/examples/scratchpad",
    permissions: { storage: true, grantedAt: { storage: Date.now() } },
  },
  {
    // Multi-task planning and sub-agent coordination. Converted from the
    // built-in tool formerly at src/runtime/tools/task-tracking.ts in
    // Phase 3. Wire-on-first-use via task-tracking-host.ensureTaskTrackingWired —
    // no per-conversation wiring happens at install time.
    name: "task-tracking",
    path: "docs/extensions/examples/task-tracking",
    // Loop-safety floor — multi-task planning is how an agent
    // structures its own recovery from a stuck state.
    critical: true,
    permissions: {
      storage: true,
      taskEvents: true,
      agentConfig: "read",
      spawnAgents: { maxPerHour: 200, maxConcurrent: 10 },
      eventSubscriptions: ["task:assignment_update"],
      grantedAt: {
        storage: Date.now(),
        taskEvents: Date.now(),
        agentConfig: Date.now(),
        spawnAgents: Date.now(),
        eventSubscriptions: Date.now(),
      },
    },
  },
  {
    // Multi-agent orchestration primitives — provides `invoke_agent`
    // for delegating to a sub-agent within a conversation. Phase 4
    // ported `invoke_agent` from the legacy built-in; Phase 2 of the
    // ask-user migration removed the `ask_human` tool that briefly
    // shipped alongside it (the bundled `ask-user` extension owns
    // human-in-the-loop now).
    // Wire-on-first-use via orchestration-host.ensureOrchestrationWired
    // — no per-conversation wiring happens at install time. As of
    // commit 5 the executor invokes this extension exclusively; no
    // dual-wired path.
    //
    // Migration note: dropping `orchestrator:human_response` from the
    // declared `eventSubscriptions` is a SHRINK, not a widening — the
    // S9 re-approval gate in `detectVersionBumpRequiringReapproval`
    // only checks `[network, filesystem, shell, env, storage,
    // lifecycleHooks]`, so existing installs are NOT auto-disabled.
    // The DB-stored grant retains the old `orchestrator:human_response`
    // entry until the next clean re-install, which is harmless because
    // the extension's subprocess no longer subscribes to that event.
    name: "orchestration",
    path: "docs/extensions/examples/orchestration",
    permissions: {
      agentConfig: "read",
      spawnAgents: { maxPerHour: 500, maxConcurrent: 25 },
      // `task:assignment_update` — required by `invoke_agent`'s two-hop
      //   bridge (Phase 4).
      eventSubscriptions: ["task:assignment_update"],
      grantedAt: {
        agentConfig: Date.now(),
        spawnAgents: Date.now(),
        eventSubscriptions: Date.now(),
      },
    },
  },
  {
    // Bundled human-in-the-loop tool. Provides `ask_user_question` —
    // the LLM-facing surface for pausing a run to ask the user a
    // question (free-text or multiple-choice). Auto-wired on every
    // turn by `src/runtime/stream-chat/setup-tools.ts` so it's always
    // available (the LLM cannot bootstrap a tool that requires its
    // own use to be wired). Subscribes to `ask-user:answer` so the
    // POST endpoint at `/api/ask-user/answer` can resolve the
    // pending-answer gate.
    name: "ask-user",
    path: "docs/extensions/examples/ask-user",
    // Loop-safety floor — THE escape hatch. The harness-smoke-test
    // incident trapped an agent precisely because S9 auto-disabled
    // this at boot and the agent could not ask a clarifying question.
    critical: true,
    permissions: {
      eventSubscriptions: ["ask-user:answer"],
      grantedAt: { eventSubscriptions: Date.now() },
    },
  },
  {
    name: "project-analyzer",
    path: "docs/extensions/examples/project-analyzer",
    permissions: { filesystem: ["$CWD"], shell: true, grantedAt: {} },
  },
  {
    name: "markdown-utils",
    path: "docs/extensions/examples/markdown-utils",
    permissions: { grantedAt: {} },
  },
  {
    name: "code-review-delegator",
    path: "docs/extensions/examples/code-review-delegator",
    permissions: { grantedAt: {} },
  },
  {
    name: "github-stats",
    path: "docs/extensions/examples/github-stats",
    permissions: { grantedAt: {} },
  },
  {
    name: "multi-agent-orchestrator",
    path: "docs/extensions/examples/multi-agent-orchestrator",
    permissions: { grantedAt: {} },
  },
  {
    name: "research-agent",
    path: "docs/extensions/examples/research-agent",
    permissions: { grantedAt: {} },
  },
  {
    name: "file-refactor",
    path: "docs/extensions/examples/file-refactor",
    permissions: { filesystem: ["$CWD"], shell: false, grantedAt: {} },
  },
  {
    name: "log-analyzer",
    path: "docs/extensions/examples/log-analyzer",
    permissions: { filesystem: ["$CWD"], shell: false, grantedAt: {} },
  },
  {
    name: "todo-tracker",
    path: "docs/extensions/examples/todo-tracker",
    permissions: { filesystem: ["$CWD"], shell: true, grantedAt: {} },
  },
  {
    name: "ai-kit",
    path: "packages/@ezcorp/ai-kit",
    // v1.4 envEscapeHatch — `EZCORP_API_KEY` is a host-internal cred
    // injected by `bootstrapBundledCredentials` (NOT a user-supplied
    // third-party API key). Different category from web-search /
    // openai-image-gen-2 — this one will likely never migrate to
    // ctx.secrets because the cred is host-self-issued. Grep for
    // `envEscapeHatch` when the v1.5+ ctx.secrets migration lands.
    envEscapeHatch: true,
    permissions: {
      network: ["localhost", "127.0.0.1"],
      filesystem: ["$CWD"],
      env: ["EZCORP_BASE_URL", "EZCORP_API_KEY", "EZCORP_SESSION_COOKIE"],
      grantedAt: { network: Date.now(), filesystem: Date.now(), env: Date.now() },
    },
  },
  {
    name: "web-search",
    path: "docs/extensions/examples/web-search",
    // Shared-search Phase 1: web-search is now a THIN SHIM forwarding to
    // the host `ctx.search` capability. The provider chain (incl. BYOK
    // creds resolved host-side), the SSRF egress guard, and the shared
    // cache all live in src/search/ — so the extension owns NO network
    // hosts, NO provider-key env vars (the `envEscapeHatch` is gone with
    // them), and NO filesystem grant. `search: "inherit"` is the full
    // grant tracking the instance search defaults.
    permissions: {
      search: "inherit",
      grantedAt: { search: Date.now() },
    },
  },
  {
    // OpenAI-only image generation (gpt-image-* models). Returns base64
    // images as data:image/ URIs so the markdown pipeline renders them
    // inline. `api.openai.com` is the ONLY external host; no filesystem
    // or shell. Credentials come from OPENAI_API_KEY (sk-...) or
    // OPENAI_ACCESS_TOKEN (OAuth bearer) — the extension refuses to run
    // without one.
    name: "openai-image-gen-2",
    path: "docs/extensions/examples/openai-image-gen-2",
    // v1.4 envEscapeHatch — third-party API creds. `OPENAI_API_KEY`
    // is the BYOK fallback path (admin settings → decrypt → inject;
    // see `web/src/lib/server/security/openai-extension-creds.ts:40`),
    // and `OPENAI_ACCESS_TOKEN` is the OAuth-Codex path. Both are
    // resolved per-spawn by `wireOpenAIExtensionCredentials`. Pending
    // the v1.5+ `ctx.secrets` migration which will remove the direct
    // env grant. Grep for `envEscapeHatch` when migrating.
    envEscapeHatch: true,
    permissions: {
      network: ["api.openai.com", "chatgpt.com"],
      env: ["OPENAI_API_KEY", "OPENAI_ACCESS_TOKEN"],
      // Grant $CWD so the extension can write generated images under
      // <projectRoot>/.ezcorp/extension-data/openai-image-gen-2/. The
      // bytes are served back to the UI via /api/ext-files/... so the
      // tool result stays small (URL, not base64).
      filesystem: ["$CWD"],
      grantedAt: { network: Date.now(), env: Date.now(), filesystem: Date.now() },
    },
  },
  {
    // claude-design — first consumer of the @ezcorp/sdk canvas primitives
    // (Phase B of the design-extension SDK initiative). Reads the project
    // codebase to extract a design system, generates HTML drafts honoring
    // it, and supports knob-based refinement via the canvas card.
    //
    // Subscribes to `claude-design:knob-change` so the canvas's knob
    // sliders can round-trip back into `tweak-design`. The grant MUST
    // be present for the generic `/api/extensions/claude-design/events/
    // knob-change` route to clear the manifest-clamp gate at boot
    // (Phase A2: pattern-matched event allowlist).
    name: "claude-design",
    path: "docs/extensions/examples/claude-design",
    permissions: {
      filesystem: ["$CWD"],
      storage: true,
      eventSubscriptions: [
        "claude-design:knob-change",
        "claude-design:brief-answer",
      ],
      network: ["cdn.jsdelivr.net"],
      grantedAt: {
        filesystem: Date.now(),
        storage: Date.now(),
        eventSubscriptions: Date.now(),
        network: Date.now(),
      },
    },
  },
  {
    // price-chart — demonstrates a fully client-rendered custom card.
    // Tool returns a JSON price-series payload; the host's
    // PriceChartCard.svelte renders inline SVG with range switching.
    // No filesystem permission — chart is never written to disk, so
    // the `fs.write` sensitive-cap prompt never fires. Stocks via
    // Yahoo Finance, crypto via CoinGecko. Logos render as <img> in
    // the browser (not extension network), so no Clearbit/CoinGecko
    // image-CDN host grants required for the extension subprocess.
    name: "price-chart",
    path: "docs/extensions/examples/price-chart",
    permissions: {
      network: [
        "query1.finance.yahoo.com",
        "api.coingecko.com",
      ],
      grantedAt: {
        network: Date.now(),
      },
    },
  },
  {
    // In-browser Kokoro-TTS. Adds a speaker icon to the per-message
    // action toolbar via the `messageToolbar` extension point. Click
    // sends a `kokoro-tts:speak` event; the subprocess responds with
    // an `ezcorp/append-message` reverse-RPC call to insert an
    // excluded turn whose `kokoro-tts-player` card runs kokoro-js in
    // the browser to synthesize WAV. Persists the audio via a
    // `kokoro-tts:save` callback that finalises the tool call.
    name: "kokoro-tts",
    path: "docs/extensions/examples/kokoro-tts",
    permissions: {
      eventSubscriptions: ["kokoro-tts:speak", "kokoro-tts:save"],
      appendMessages: { excludedDefault: true },
      grantedAt: {
        eventSubscriptions: Date.now(),
        appendMessages: Date.now(),
      },
    },
  },
  {
    // Phase 53 Stage 1 — bundled port of the legacy lessons distiller
    // (src/runtime/lessons/distiller.ts). Lives at the milestone-spec'd
    // path `extensions/<name>/` rather than the docs/examples or
    // packages/@ezcorp paths used by older bundled extensions. The
    // `getProjectRoot()`-relative join handles any in-repo path.
    //
    // Shipped alongside the legacy implementation; Stage 2 (a separate
    // commit gated on UAT signoff) deletes the legacy code. The parity
    // test at `src/__tests__/distiller-port-parity.test.ts` proves both
    // pipelines produce identical outcomes during Stage 1.
    name: "lessons-distiller",
    path: "extensions/lessons-distiller",
    // Event-only extension (no tools, no manual triggers post-53.3).
    // Without bootSpawn, `run:complete` is silently dropped by
    // `EventSubscriptionDispatcher.dispatch` because the subprocess
    // never starts — see `bootSpawnFlaggedBundledExtensions`.
    bootSpawn: true,
    permissions: {
      llm: {
        providers: ["google", "openai", "anthropic", "ollama"],
        maxCallsPerHour: 30,
        maxCallsPerDay: 200,
        maxTokensPerCall: 1024,
        allowedModels: {
          google: ["gemini-2.0-flash-lite"],
          openai: ["gpt-4o-mini"],
          anthropic: ["claude-haiku-4-5-20250514"],
          ollama: ["gemma4:e2b", "gemma4:latest", "qwen3.6:35b"],
        },
      },
      lessons: {
        access: "write",
        maxWritesPerDay: 50,
        maxVisibility: "user",
      },
      eventSubscriptions: ["run:complete"],
      storage: true,
      grantedAt: {
        llm: Date.now(),
        lessons: Date.now(),
        eventSubscriptions: Date.now(),
        storage: Date.now(),
      },
    },
  },
  {
    // extension-author — bundled extension that lets the in-app LLM
    // scaffold new extensions on user request. The matching
    // reverse-RPC `ezcorp/drafts` (host-side:
    // `src/extensions/drafts-handler.ts`) is bundled-only via the
    // `BUNDLED_DRAFTS_ALLOWLIST` set in that file.
    //
    // No bootSpawn — the extension has tools, so it spawns lazily on
    // first invocation through the tool-executor (the standard
    // bundled-extension pattern).
    name: "extension-author",
    path: "docs/extensions/examples/extension-author",
    // Loop-safety floor (same rationale as ask-user/task-tracking):
    // a tool-list/version change to a bundled extension normally
    // disables it "pending re-approval" — but silently disabling the
    // extension-AUTHORING tool on every manifest tweak is exactly the
    // stuck-chat trap. `critical` auto-reapproves on bump ONLY when
    // the on-disk permissions stay within the bundled ceiling (the
    // ceiling is still the hard security bound: a perms bump that
    // EXCEEDS it still disables + escalates). This extension's declared
    // permissions are unchanged here — adding `install_draft` only
    // changed the tool list — so it auto-reapproves and stays enabled.
    critical: true,
    permissions: {
      filesystem: ["$CWD/.ezcorp/extension-data/extension-author"],
      custom: { drafts: { kinds: ["extension"] } },
      grantedAt: { filesystem: Date.now(), custom: Date.now() },
    },
  },
  {
    // Phase 53 Stage 2 — bundled port of the legacy memory pipeline.
    // The legacy `src/memory/extraction.ts` was deleted alongside this
    // extension's promotion to sole `run:complete` consumer; this
    // bundled extension now owns the entire extraction path.
    // `src/memory/compaction.ts` survives host-side because it's the
    // implementation behind the `runtime.memory.compact` invoke
    // handler. `src/memory/dedup.ts` also survives — cross-extension
    // dedup must mediate every memory write, regardless of which
    // extension authored it. Mirrors the lessons-distiller layout:
    // `extensions/<name>/` with ezcorp.config.ts manifest, package.json,
    // and an event-handler entrypoint.
    //
    // `permissions.memory.selfOnly = false` is intentional: see the
    // file-leading comment in `extensions/memory-extractor/ezcorp.config.ts`
    // for the cross-extension dedup rationale. Bundled-trust is the
    // approval gate; this exception is reviewed at code-review time.
    name: "memory-extractor",
    path: "extensions/memory-extractor",
    // Event-only extension (no tools, no manual triggers). The cron
    // schedule fires periodically but the run:complete handler is the
    // primary auto-extraction path. Without bootSpawn, `run:complete`
    // is silently dropped because the subprocess never starts — see
    // `bootSpawnFlaggedBundledExtensions`.
    bootSpawn: true,
    permissions: {
      llm: {
        providers: ["google", "openai", "anthropic", "ollama"],
        maxCallsPerHour: 30,
        maxCallsPerDay: 200,
        maxTokensPerCall: 2048,
        allowedModels: {
          google: ["gemini-2.0-flash-lite"],
          openai: ["gpt-4o-mini"],
          anthropic: ["claude-haiku-4-5-20250514"],
          ollama: ["gemma4:e2b", "gemma4:latest", "qwen3.6:35b"],
        },
      },
      memory: {
        access: "write",
        categories: ["preferences", "biographical", "technical", "decisions_goals"],
        maxWritesPerDay: 100,
        selfOnly: false,
      },
      eventSubscriptions: ["run:complete"],
      schedule: {
        crons: ["0 */6 * * *"],
        maxRunsPerDay: 4,
        missedRunPolicy: "fire-once",
        maxRunDurationMs: 5 * 60 * 1000,
        maxRetries: 0,
      },
      storage: true,
      grantedAt: {
        llm: Date.now(),
        memory: Date.now(),
        eventSubscriptions: Date.now(),
        schedule: Date.now(),
        storage: Date.now(),
      },
    },
  },
  {
    // ez-code — Warren-style control plane for ephemeral coding-agent
    // runs. Declares an Extension Pages Hub dashboard plus five
    // LLM-callable tools (dispatch/list/steer/cancel/open_pr) and a
    // per-run action surface wired to its `ez-code:*` event allowlist.
    //
    // No bootSpawn: the extension ships tools AND on-action wiring, so
    // it spawns lazily on first tool invocation / event dispatch — the
    // standard bundled-extension pattern (only event-ONLY extensions
    // with no tools/triggers need the boot-spawn flag).
    //
    // Not `critical`: it is NOT an agent loop-escape primitive
    // (ask-user / task-tracking), so a version bump should follow the
    // normal re-approval gate, not auto-reapprove.
    //
    // No `envEscapeHatch`: the only credential it touches is the user's
    // `gh` CLI auth on the host — there is no credential-shaped env
    // grant in its manifest (`*_API_KEY|TOKEN|SECRET`), so the install
    // gate is not engaged.
    name: "ez-code",
    path: "docs/extensions/examples/ez-code",
    permissions: {
      spawnAgents: { maxPerHour: 30, maxConcurrent: 6 },
      eventSubscriptions: [
        "task:assignment_update",
        "ez-code:steer",
        "ez-code:cancel",
        "ez-code:open-pr",
      ],
      appendMessages: { excludedDefault: true },
      storage: true,
      filesystem: ["$CWD"],
      shell: true,
      network: ["api.github.com"],
      // Cron triggers. The manifest declares only `crons` /
      // `maxRunsPerDay` / `purpose`; the manifest validator
      // (`clampSchedulePermission`) fills the remaining grant fields
      // with its DEFAULTS — `maxRunDurationMs: 300_000`,
      // `missedRunPolicy: "fire-once"`, `maxRetries: 0`. The bundled
      // grant + ceiling must BOTH carry the FULL schedule shape (all
      // five fields), because `intersectPermissions` does
      // `Math.min(a.schedule.maxRunDurationMs, b…)` etc. — an omitted
      // field on either side yields `NaN`/undefined and the cron grant
      // silently breaks. Mirroring the validator defaults keeps the
      // intersection lossless (crons + maxRunsPerDay survive verbatim).
      schedule: {
        crons: ["0 * * * *", "0 9 * * *"],
        maxRunsPerDay: 48,
        maxRunDurationMs: 300_000,
        missedRunPolicy: "fire-once",
        maxRetries: 0,
      },
      grantedAt: {
        spawnAgents: Date.now(),
        eventSubscriptions: Date.now(),
        appendMessages: Date.now(),
        storage: Date.now(),
        filesystem: Date.now(),
        shell: Date.now(),
        network: Date.now(),
        schedule: Date.now(),
      },
    },
  },
  {
    // file-organizer — 100%-local, secure file organization. The
    // background watcher is a HOST-SIDE daemon
    // (src/extensions/file-organizer-daemon.ts, raw node:fs) wired into
    // background-timers.ts, and Accept/Reject apply HOST-SIDE in the
    // events route. The subprocess only renders the 3 Hub pages + serves
    // the chat agent/tools, so its grant is intentionally minimal:
    // filesystem `$CWD` (its own data dir) + the full Hub page-action
    // eventSubscriptions list.
    //
    // NO `network` (enforces "no calls home" by construction), NO
    // `shell`, NO `schedule` grant (the daemon is host-wired, not
    // cron-driven), `storage:false` (file-based state so the host daemon,
    // which has no per-user context, can read/write proposals.json).
    //
    // No `bootSpawn`: the extension has Hub pages + tools, so it spawns
    // lazily on first render / tool invocation (the standard pattern).
    // The host daemon does the background work without a live subprocess.
    name: "file-organizer",
    path: "docs/extensions/examples/file-organizer",
    permissions: {
      filesystem: ["$CWD"],
      eventSubscriptions: [
        "file-organizer:select-segment",
        "file-organizer:page-window",
        "file-organizer:focus",
        "file-organizer:accept",
        "file-organizer:reject",
        "file-organizer:confirm-deletes",
        "file-organizer:reject-segment",
        "file-organizer:undo-batch",
        "file-organizer:dismiss-stale",
        "file-organizer:retry-failed",
        "file-organizer:scan-now",
        "file-organizer:organize-backlog",
        "file-organizer:enable-daemon",
        "file-organizer:set-mode",
        "file-organizer:toggle-preset",
        "file-organizer:add-folder",
        "file-organizer:set-backlog-policy",
        "file-organizer:remove-folder",
        "file-organizer:add-ignore",
        "file-organizer:add-rule",
        "file-organizer:classify-move",
        "file-organizer:teach-rule",
        "file-organizer:ignore-file",
        "file-organizer:restore",
        "file-organizer:purge",
        "file-organizer:empty-quarantine",
        "file-organizer:purge-expired",
        "file-organizer:reload-config",
      ],
      grantedAt: {
        filesystem: Date.now(),
        eventSubscriptions: Date.now(),
      },
    },
  },
  {
    // ping-loop — a watchable, LLM-free Loop SDK demo. A MANUAL-trigger +
    // dashboard loop: a human clicks "Ping now" on the Hub page and a fresh
    // "done" run row appears (`pong #0`, `pong #1`, …). Every fire is
    // deterministic (seq + injected fire timestamp), so the demo is flake-free.
    //
    // The manifest is `persistent` and the "Ping now" button fires the
    // `ping-loop:run` page-action EVENT — so the subprocess must be RESIDENT
    // to receive the click. The extension also registers a manual `ping_run`
    // tool, but the live UX path is the page-action event, which
    // `EventSubscriptionDispatcher.dispatch` silently drops unless a
    // subprocess is already running. So `bootSpawn: true` keeps it resident.
    //
    // Grant is exactly what the manifest declares: `storage` (the run store),
    // `filesystem: ["$CWD"]` (the artifact mirror under
    // .ezcorp/extension-data/ping/), and the `ping-loop:run` eventSubscription
    // (Hub page-action events MUST be extension-name-prefixed — `hub.ts`
    // drops any event not starting with `<extensionName>:`). The dashboard
    // page is declared in the manifest (`pages[]`) — declaring it IS the
    // grant. NO llm / network / shell.
    name: "ping-loop",
    path: "docs/extensions/examples/ping-loop",
    bootSpawn: true,
    permissions: {
      storage: true,
      filesystem: ["$CWD"],
      eventSubscriptions: ["ping-loop:run"],
      grantedAt: {
        storage: Date.now(),
        filesystem: Date.now(),
        eventSubscriptions: Date.now(),
      },
    },
  },
];

/** Opt-OUT switches: each maps a bundled-extension name to the env var that
 *  disables it. Present to let operators turn off a bundled extension without
 *  editing code. Names not in this map are always installed. */
const DISABLE_FLAGS: Readonly<Record<string, string>> = {
  "ai-kit": "EZCORP_DISABLE_AI_KIT",
};

/** Returns the list of bundled extensions to install on this startup —
 *  BUNDLED_EXTENSIONS minus any entry whose opt-out env flag is set to "1".
 *  Exported for testing the opt-out gate without touching the DB. */
export function resolveBundledExtensions(
  env: NodeJS.ProcessEnv = process.env,
): BundledExtension[] {
  return BUNDLED_EXTENSIONS.filter((entry) => {
    const flag = DISABLE_FLAGS[entry.name];
    return !flag || env[flag] !== "1";
  });
}

/**
 * The loop-safety floor: every bundled entry flagged `critical: true`
 * (`ask-user`, `task-tracking`). Returns a narrow `{name, path}` view —
 * the full `BundledExtension` array stays module-private. Consumed by
 * the startup invariant (`src/startup/assert-critical-extensions.ts`)
 * which must NOT depend on the internal array shape.
 *
 * Opt-out flags are intentionally IGNORED here: a critical extension is
 * a loop-escape primitive; an operator disabling it via env is exactly
 * the trap we're guarding against, so the invariant still checks it.
 */
export function getCriticalBundledExtensions(): Array<{
  name: string;
  path: string;
}> {
  return BUNDLED_EXTENSIONS.filter((e) => e.critical === true).map((e) => ({
    name: e.name,
    path: e.path,
  }));
}

/**
 * Path (relative to the project root) of a bundled extension's on-disk
 * source, or `null` for non-bundled names. Consumed by the admin
 * drift-reapproval heal (`bundled-drift-reapprove.ts`) so it loads the
 * SAME on-disk manifest the boot path uses. Opt-out env flags are
 * intentionally ignored — an existing row can be healed regardless of
 * whether fresh installs are currently suppressed.
 */
export function getBundledExtensionPath(name: string): string | null {
  return BUNDLED_EXTENSIONS.find((e) => e.name === name)?.path ?? null;
}

/** Names of every extension that ships WITH the EZCorp codebase (bundled),
 *  regardless of opt-out flags. Consulted by ExtensionRegistry at spawn
 *  time to skip the runtime integrity check — bundled extensions live in
 *  the same repository as the server itself, so their files legitimately
 *  change whenever the repo does (dev edits, pulls, upgrades). Gating
 *  them on checksum parity would brick every subsequent spawn after any
 *  commit that touches the extension's directory.
 *
 *  User-installed (non-bundled) extensions still get the full integrity
 *  check — a file changing under a git-cloned or marketplace-installed
 *  extension is almost always tampering.
 *
 *  This list is computed once at module load. Opt-out flags intentionally
 *  do NOT remove a name here — if the operator sets
 *  `EZCORP_DISABLE_AI_KIT=1` AFTER an install, the extension still has
 *  integrity-skip semantics until it's uninstalled; the flag only
 *  governs fresh installs. */
const BUNDLED_EXTENSION_NAMES: ReadonlySet<string> = new Set(
  BUNDLED_EXTENSIONS.map((e) => e.name),
);

export function isBundledExtensionName(name: string): boolean {
  return BUNDLED_EXTENSION_NAMES.has(name);
}

export async function ensureBundledExtensions(): Promise<void> {
  for (const entry of resolveBundledExtensions()) {
    try {
      const existing = await getExtensionByName(entry.name);
      if (existing) {
        // Backfill: rows created before the is_bundled column existed
        // report `isBundled=false` even though they were installed via
        // this path. Flip the flag so the registry's integrity-skip
        // check (which now reads the DB flag rather than matching on
        // name) keeps working across the upgrade. Idempotent — no-op
        // once set. The (existing as any) cast covers the narrow window
        // where a DB row predates the column; new rows always carry it.
        if ((existing as { isBundled?: boolean }).isBundled !== true) {
          try {
            await updateExtension(existing.id, { isBundled: true });
          } catch (backfillErr) {
            log.warn("isBundled backfill failed", {
              name: entry.name,
              error: String(backfillErr),
            });
          }
        }
        // Drift detection (S6): if the on-disk manifest's declared
        // permissions differ from the DB-stored manifest permissions,
        // emit a WARN and DO NOT mutate the grant. Fail-closed — the
        // operator (or future CI check) must resolve the divergence.
        // This catches two scenarios:
        //   (1) a dev changed the extension's `permissions:` block in
        //       `ezcorp.config.ts` without re-approving at install time
        //       — the fix is to re-install (or let the update-gate in
        //       installer.ts:S9 handle it on version bump);
        //   (2) tampering under a git-cloned bundled path where the
        //       integrity check is (intentionally) skipped for bundled
        //       exts — this is our only structural signal.
        try {
          await detectAndLogManifestDrift(
            entry,
            existing.id,
            existing.manifest as ExtensionManifestV2,
            (existing as { grantedPermissions?: ExtensionPermissions }).grantedPermissions,
            // D4 — a row that's ALREADY disabled-pending-reapproval has
            // already had its drift warned + audited on the transition
            // boot. Pass that signal so the redundant fail-closed WARN +
            // audit re-write is demoted to a single info line on every
            // subsequent boot instead of re-spamming.
            existing.enabled === false,
          );
        } catch (driftErr) {
          // Drift detection must never block startup — log and continue.
          log.warn("Manifest-drift check failed", { name: entry.name, error: String(driftErr) });
        }

        // Re-approval gate (S9): when a bundled extension's on-disk
        // version differs from the DB-recorded version AND its
        // permissions also changed, we flip `enabled=false` and write
        // an UPDATE_BLOCKED audit row. The operator must re-approve
        // via the admin UI before the tools become available again.
        // This closes the attack window where a malicious dependency
        // bump could quietly widen permissions under an existing grant.
        let versionBlockedUpdate = false;
        try {
          versionBlockedUpdate = await detectVersionBumpRequiringReapproval(
            entry,
            existing.id,
            existing.manifest as ExtensionManifestV2,
          );
        } catch (versionErr) {
          log.warn("Version-bump check failed", { name: entry.name, error: String(versionErr) });
        }
        if (versionBlockedUpdate) {
          // CRITICAL loop-safety floor: silently disabling `ask-user`
          // / `task-tracking` on a version bump is exactly the trap
          // the harness-smoke-test incident sprang. For a `critical`
          // entry, do NOT disable IF the new on-disk permission set is
          // within the bundled ceiling — auto-accept (record the new
          // version, keep enabled, write an auto-reapproval audit
          // row). The ceiling is still the hard security bound: a
          // critical bump that EXCEEDS the ceiling keeps the disable
          // (security floor) and the startup invariant escalates it
          // loudly. Reuse `clampToBundledCeiling` — `clamped === false`
          // is precisely "within ceiling" (there is no standalone
          // within-ceiling helper in bundled-ceiling.ts; open question
          // resolved).
          if (entry.critical) {
            let diskManifest: ExtensionManifestV2 | null = null;
            try {
              diskManifest = await loadManifestFresh(
                join(getProjectRoot(), entry.path),
              );
            } catch (e) {
              log.warn("critical S9: disk manifest reload failed", {
                name: entry.name,
                error: String(e),
              });
            }
            if (diskManifest) {
              // Normalize `grantedAt` BEFORE the ceiling check:
              // `clampToBundledCeiling`'s equality comparator treats a
              // perms object with no `grantedAt` key as different from
              // the intersection result (which always carries
              // `grantedAt`), producing a false `clamped:true`. The
              // real bundled-install path always passes perms WITH
              // `grantedAt`; mirror that here so "within ceiling" is
              // computed on the same shape.
              const rawPerms = (diskManifest.permissions ??
                {}) as ExtensionPermissions;
              const diskPerms: ExtensionPermissions = {
                ...rawPerms,
                grantedAt: rawPerms.grantedAt ?? {},
              };
              const { clamped } = clampToBundledCeiling(
                entry.name,
                diskPerms,
              );
              if (!clamped) {
                // Within ceiling → auto-accept. Keep enabled, record
                // the new version so S9 doesn't re-fire next boot, AND
                // refresh the stored manifest from disk so a tool-list
                // change (e.g. extension-author gaining `install_draft`)
                // actually reaches the registry/LLM. Without this the
                // `continue` below skips the normal disk-refresh block,
                // leaving the DB on the STALE manifest — the extension
                // stays "enabled" but the new tool is invisible. Mirror
                // the normal refresh's permission-preservation (the
                // stored `permissions` block stays the S6/S9 escalation
                // path); the lockfile tamper gate is intentionally NOT
                // applied on the critical path — same loop-safety
                // trade-off as ask-user/task-tracking (bundled source
                // is the trust root).
                const refreshed: ExtensionManifestV2 = {
                  ...diskManifest,
                  permissions:
                    (existing.manifest as ExtensionManifestV2).permissions ??
                    diskManifest.permissions,
                };
                await updateExtension(existing.id, {
                  enabled: true,
                  version: diskManifest.version,
                  // Sync the denormalized description column too — same
                  // gap as the normal refresh path (the UI reads the
                  // column, not the manifest jsonb).
                  description: diskManifest.description ?? "",
                  manifest: refreshed,
                });
                await writeCriticalAutoReapprovalAudit(
                  existing.id,
                  entry.name,
                  (existing.manifest as ExtensionManifestV2).version,
                  diskManifest.version,
                );
                log.warn(
                  "CRITICAL bundled extension version-bumped with permission changes — auto-reapproved (within ceiling), staying enabled",
                  { name: entry.name },
                );
                // Grant self-heal on the critical auto-reapprove exit.
                // This `continue` skips the normal reconcile site below,
                // so a `critical` row whose tool list changes EVERY boot
                // (extension-author is the canonical case — its tools
                // churn as the feature is built) would otherwise NEVER
                // have a stale grant healed: it returns
                // "custom.drafts.kinds not granted" on every scaffold
                // forever. Safe here because the row STAYS ENABLED and
                // is trusted-bundled; the reconcile is ceiling-clamped
                // (hard bound) so it can only backfill toward the
                // declared-within-ceiling set, never widen. Distinct
                // from the fail-closed disable exits (non-critical S9 /
                // tamper), which intentionally do NOT reconcile.
                await reconcileBundledGrant(entry, existing);
                continue;
              }
            }
            // Critical but exceeds ceiling (or disk unreadable): the
            // disable stands as the security floor; the startup
            // invariant logs ERROR + (if within ceiling on its own
            // re-check) one-time re-enables. Fall through to disable.
            log.error(
              "CRITICAL bundled extension disabled — perms exceed ceiling on version bump; agents may be unable to ask the user",
              { name: entry.name },
            );
          }
          // Skip the re-enable branch below: a version bump with
          // permission changes must fail-closed until re-approved.
          //
          // D4 — idempotent on already-disabled rows. The FIRST boot that
          // detects the drift warns + disables (the transition). On every
          // SUBSEQUENT boot the row is ALREADY `enabled=false` and still
          // drifted; re-warning + re-writing `enabled:false` is pure spam
          // (the live host re-logged this for ~10 extensions on every
          // boot). When already disabled, demote to a single info-level
          // line (same diff payload, so admins can still find it) and skip
          // the redundant write. The first transition's behavior is
          // unchanged.
          if (existing.enabled) {
            log.warn("Bundled extension version bumped with permission changes — disabled pending re-approval", {
              name: entry.name,
            });
            await updateExtension(existing.id, { enabled: false });
          } else {
            log.info("Bundled extension still drifted — already disabled pending re-approval (no change)", {
              name: entry.name,
              extensionId: existing.id,
            });
          }
          continue;
        }

        // Refresh the stored manifest from on-disk for bundled extensions.
        // The DB copy of a bundled extension's manifest can go stale after
        // an ezcorp.config.ts edit (e.g. fixing a tool schema) because
        // `ensureBundledExtensions` used to just log drift + skip. Net
        // effect: the LLM saw the old broken schema until the row was
        // manually reinstalled. Source-of-truth for bundled extensions is
        // the repo, so pull the on-disk manifest and write it back —
        // EXCEPT preserve the stored `permissions` block. That keeps the
        // S6 drift check (§detectAndLogManifestDrift) and S9 version gate
        // (§detectVersionBumpRequiringReapproval) as the sole escalation
        // paths for permission changes. Non-permission fields (tools,
        // description, version-unless-gated, entrypoint) track source.
        //
        // Phase 5: gate the refresh on `manifest.lock.json`. A
        // mismatch on tool-list / entrypoint / version means either
        // a maintainer forgot to regenerate the lockfile or the file
        // was tampered with. Either way, fail-closed: disable the
        // extension, write an audit row, do NOT proceed with refresh.
        try {
          const diskDir = join(getProjectRoot(), entry.path);
          const diskManifest = await loadManifestFresh(diskDir);

          const lockResult = await verifyManifestAgainstLock(entry.name, diskManifest);
          if (!lockResult.ok) {
            log.error("Manifest tamper detected for bundled extension", {
              name: entry.name,
              extensionId: existing.id,
              reason: lockResult.reason,
              expected: lockResult.expected,
              actual: lockResult.actual,
            });
            await writeBundledManifestTamperAudit(
              existing.id,
              entry.name,
              lockResult.reason,
              lockResult.expected,
              lockResult.actual,
            );
            // Disable the extension. The DB-stored manifest + grant
            // remain intact so a future re-approval can re-enable
            // without losing user state.
            await updateExtension(existing.id, { enabled: false });
            continue;
          }

          const refreshed: ExtensionManifestV2 = {
            ...diskManifest,
            permissions: (existing.manifest as ExtensionManifestV2).permissions ?? diskManifest.permissions,
          };
          const currentJson = JSON.stringify(existing.manifest);
          const refreshedJson = JSON.stringify(refreshed);
          // Sync the DENORMALIZED row columns (`description`, `version`)
          // from the disk manifest too. The UI + extension list read the
          // top-level `description`/`version` columns, NOT the manifest
          // jsonb — without this, a manifest description edit (e.g.
          // web-search "Keyless by default (Jina AI)" → SearXNG) refreshed
          // the jsonb but left the column stale forever. `version` is
          // gated upstream by S9 for permission/tool changes; a pure
          // cosmetic version bump reaches here and must also sync.
          const diskDescription = diskManifest.description ?? "";
          const diskVersion = diskManifest.version;
          const descStale = existing.description !== diskDescription;
          const versionStale = existing.version !== diskVersion;
          if (currentJson !== refreshedJson || descStale || versionStale) {
            await updateExtension(existing.id, {
              manifest: refreshed,
              description: diskDescription,
              version: diskVersion,
            });
            log.info("Refreshed bundled extension manifest from disk", {
              name: entry.name,
              extensionId: existing.id,
              ...(descStale ? { descriptionSynced: true } : {}),
              ...(versionStale ? { versionSynced: true } : {}),
            });
          }
        } catch (refreshErr) {
          // Non-fatal: drift check already ran. Next boot retries.
          log.warn("Bundled manifest refresh failed", {
            name: entry.name,
            error: String(refreshErr),
          });
        }

        // Grant self-heal (S6 companion). The S6 drift check and the
        // manifest-refresh block above DELIBERATELY never touch the
        // `grantedPermissions` DB column — they treat it as the runtime
        // security boundary. But a row seeded BEFORE a within-ceiling
        // declared grant existed (or one previously clamped/stripped)
        // is otherwise NEVER reconciled: it stays broken across every
        // restart with no escalation path (e.g. extension-author rows
        // missing `custom.drafts.kinds` → "custom.drafts.kinds not
        // granted" on every scaffold). Backfill the stored grant toward
        // the bundled entry's DECLARED-WITHIN-CEILING permission set.
        //
        // Security invariants (do not relax):
        //   - The reconciled grant is `clampToBundledCeiling(name, …)`
        //     of (stored-grant ⊕ declared) — the final ceiling clamp is
        //     the hard bound, so the result is provably ⊆ ceiling even
        //     if the stored row somehow carried perms beyond it. This is
        //     a backfill toward the declared-within-ceiling grant, NOT a
        //     widening and NOT an unbounded union.
        //   - This is the NORMAL (no-gate) exit. The fail-closed
        //     disable exits (non-critical S9 version-bump, manifest
        //     tamper) `continue` BEFORE this and are intentionally NOT
        //     reconciled — a row pending re-approval must not have its
        //     grant silently healed. The ONE other reconcile site is the
        //     critical-S9 auto-reapprove branch above, which `continue`s
        //     before this point but keeps the row ENABLED, so its stale
        //     grant must still be healed there (extension-author's tool
        //     list churns every boot → it always takes that path).
        //   - Idempotent: a structural compare gates the DB write +
        //     audit, so a satisfied grant produces no boot-time spam.
        await reconcileBundledGrant(entry, existing);

        // If a bundled extension was disabled by a prior runtime check
        // (e.g. the now-removed integrity gate) or by an operator toggling
        // it off outside the opt-out env flag, re-enable it on the next
        // startup — we're the source of truth for "bundled default on".
        // Operators who genuinely want it off should set the disable flag,
        // which keeps the extension out of this loop entirely.
        if (!existing.enabled) {
          await updateExtension(existing.id, {
            enabled: true,
            consecutiveFailures: 0,
          });
          log.info("Re-enabled bundled extension", { name: entry.name });
          await writeBundledRegrantAudit(existing.id, entry.permissions);
        } else {
          log.info("Already installed, skipping", { name: entry.name });
        }
        continue;
      }

      const resolvedPath = join(getProjectRoot(), entry.path);

      // Phase 5: clamp the bundled install request to the hardcoded
      // capability ceiling. The ceiling is independent of the manifest
      // — a compromised `BUNDLED_EXTENSIONS` entry that requests wider
      // perms cannot exceed `bundled-ceiling.ts`. Persist the CLAMPED
      // grant; audit when narrowing occurred.
      const { effective: clampedPerms, clamped } = clampToBundledCeiling(
        entry.name,
        entry.permissions,
      );
      if (clamped) {
        log.warn("Bundled install grant clamped to ceiling", {
          name: entry.name,
          requested: entry.permissions,
          effective: clampedPerms,
        });
      }

      // v1.4 — install-gate symmetry. `installFromLocal` runs the
      // `*_API_KEY` install gate; pass `isBundled: true` + the entry's
      // `envEscapeHatch` flag so the gate can allow credential-shaped
      // env grants on the small set of bundled extensions that opt in
      // (`ai-kit`, `web-search`, `openai-image-gen-2`). Bundled
      // extensions WITHOUT `envEscapeHatch` still fail closed — the
      // catch in `ensureBundledExtensions` swallows the throw and the
      // next boot retries (matching the existing
      // `versionBlockedUpdate`/refresh-failure semantics).
      // Phase 7 — substack-pilot port. Pass the legacy-namespace
      // mapping so its `post-type:<slug>` keys get renamed to the
      // managed `__entity:post-type:<slug>` namespace on this install.
      // The renamer is idempotent + safe on extensions with no legacy
      // rows (every other bundled extension), so the cost is a single
      // SELECT-WHERE-no-match on each boot.
      const legacyEntityMappings =
        entry.name === "substack-pilot"
          ? ([
              {
                entityType: "post-type",
                legacyKeyPrefix: "post-type:",
                legacyIndexKey: "post-type-index",
              },
            ] as const)
          : undefined;
      const installed = await installFromLocal(resolvedPath, clampedPerms, true, {
        isBundled: true,
        envEscapeHatch: entry.envEscapeHatch === true,
        ...(legacyEntityMappings
          ? { legacyEntityMappings: [...legacyEntityMappings] }
          : {}),
      });
      // Mark provenance AFTER the row exists. installFromLocal is shared
      // with the user install path (which must default isBundled=false),
      // so bundled trust is granted here, in the one place that knows.
      // v1.3 security review HIGH 2 — also persist `installedPermissions`
      // so the reapprove handler clamps against the bundled-ceiling-clamped
      // shape, not the (potentially wider) raw manifest. See
      // `tasks/v1.3-security-review.md` HIGH 2.
      try {
        await updateExtension(installed.id, {
          isBundled: true,
          installedPermissions: clampedPerms,
        });
      } catch (flagErr) {
        log.warn("Failed to set isBundled on fresh bundled install", {
          name: entry.name,
          error: String(flagErr),
        });
      }
      log.info("Installed extension", { name: entry.name });
      await writeBundledInstallAudit(installed.id, clampedPerms);
      if (clamped) {
        await writeBundledCeilingClampAudit(installed.id, entry.name, entry.permissions, clampedPerms);
      }
    } catch (error) {
      log.error("Failed to install extension", { name: entry.name, error: String(error) });
    }
  }

  // Phase 3 commit-5: rehome `extensionId="builtin"` task-tracking
  // storage rows under the real bundled extension id so users' existing
  // tasks survive the cutover. Runs exactly once per install via the
  // migration's own sentinel; safe to call on every boot.
  try {
    const taskTrackingRow = await getExtensionByName("task-tracking");
    if (taskTrackingRow) {
      const { migrateBuiltinTaskStorage } = await import("./migrations/task-tracking-storage");
      await migrateBuiltinTaskStorage(taskTrackingRow.id);
    }
  } catch (migrationErr) {
    log.warn("task-tracking storage migration threw during ensureBundledExtensions", {
      error: String(migrationErr),
    });
  }

  // Phase 53 Stage 1: migrate `global:lessonDistillerEnabled` into the
  // bundled lessons-distiller extension's per-extension `enabled`
  // setting. Idempotent via a `migrated_at` sentinel; safe on every boot.
  try {
    const lessonsDistillerRow = await getExtensionByName("lessons-distiller");
    if (lessonsDistillerRow) {
      const { migrateDistillerEnabledSetting } = await import("./migrations/distiller-enabled");
      await migrateDistillerEnabledSetting(lessonsDistillerRow.id);
    }
  } catch (migrationErr) {
    log.warn("lessons-distiller settings migration threw during ensureBundledExtensions", {
      error: String(migrationErr),
    });
  }

  // Phase 53 Stage 2: backfill `conversation_extensions` rows for the
  // bundled lessons-distiller extension across every existing
  // conversation. Without this, the dispatcher's wired-set gate would
  // silently drop `run:complete` for legacy conversations after the
  // host-side listener is removed. Idempotent via a `migrated_at`
  // sentinel; honours user-driven unwirings (sentinel = no replay).
  try {
    const lessonsDistillerRow = await getExtensionByName("lessons-distiller");
    if (lessonsDistillerRow) {
      const { migrateLessonsDistillerConversationWiring } = await import(
        "./migrations/lessons-distiller-conversation-wiring"
      );
      await migrateLessonsDistillerConversationWiring(lessonsDistillerRow.id);
    }
  } catch (migrationErr) {
    log.warn(
      "lessons-distiller wiring migration threw during ensureBundledExtensions",
      { error: String(migrationErr) },
    );
  }

  // Phase 53.4 Stage 1: migrate `global:memoryEnabled` into the
  // bundled memory-extractor's per-extension `enabled` setting.
  // Idempotent via a sibling sentinel
  // (`global:memoryEnabled.migrated_at`). Mirrors the distiller
  // settings migration; safe on every boot.
  try {
    const memoryExtractorRow = await getExtensionByName("memory-extractor");
    if (memoryExtractorRow) {
      const { migrateMemoryExtractorEnabledSetting } = await import(
        "./migrations/memory-extractor-enabled"
      );
      await migrateMemoryExtractorEnabledSetting(memoryExtractorRow.id);
    }
  } catch (migrationErr) {
    log.warn(
      "memory-extractor settings migration threw during ensureBundledExtensions",
      { error: String(migrationErr) },
    );
  }

  // Phase 53.4 Stage 1: backfill `conversation_extensions` rows for
  // the bundled memory-extractor across every existing conversation.
  // Sibling of the lessons-distiller wiring backfill; sentinel-gated
  // so user-driven unwirings stick. Without this, the dispatcher's
  // wired-set gate would silently drop `run:complete` for legacy
  // conversations once Stage 2 deletes the host-side
  // `registerExtractionListener`.
  try {
    const memoryExtractorRow = await getExtensionByName("memory-extractor");
    if (memoryExtractorRow) {
      const { migrateMemoryExtractorConversationWiring } = await import(
        "./migrations/memory-extractor-conversation-wiring"
      );
      await migrateMemoryExtractorConversationWiring(memoryExtractorRow.id);
    }
  } catch (migrationErr) {
    log.warn(
      "memory-extractor wiring migration threw during ensureBundledExtensions",
      { error: String(migrationErr) },
    );
  }

  // ez-code default coding agent. The extension's `dispatch_run` tool
  // dispatches to a pre-existing `agent_configs` row via the spawn path
  // (`resolveAgentConfigForUser`), which only resolves DB rows — a
  // manifest `agent:` block is NOT spawnable by name. So ship a single
  // well-known SYSTEM coder row (`userId: null`, name `ez-code coder`)
  // and let the resolver fall back to it by name for every user. Gated
  // on the ez-code extension row existing; idempotent (no-op on the name
  // match). Safe on every boot.
  try {
    const ezCodeRow = await getExtensionByName("ez-code");
    if (ezCodeRow) {
      const { ensureEzCodeCoderAgent } = await import("./ez-code-coder-agent");
      await ensureEzCodeCoderAgent();
    }
  } catch (coderErr) {
    log.warn("ez-code coder agent ensure threw during ensureBundledExtensions", {
      error: String(coderErr),
    });
  }
}

/**
 * Compare an on-disk manifest's `permissions` block against the
 * DB-stored manifest's permissions AND the runtime `granted_permissions`
 * column. Emits one WARN per differing safety-boundary field
 * (network/filesystem/shell/env/storage/lifecycleHooks) and DOES NOT
 * mutate them — those are privacy/safety boundaries; the operator's job
 * is to either re-install (via admin UI or a future CI step) or revert
 * the on-disk change. Fail-closed guarantees that runtime enforcement
 * continues to use the DB grant, not the (possibly tampered) on-disk
 * declaration.
 *
 * Exception: `eventSubscriptions`. This field is infrastructure
 * plumbing (which canvas-style POST routes the extension can receive),
 * NOT a privacy/safety boundary. Failing closed here would brick the
 * canvas knob round-trip for any bundled extension that adds a new
 * event after its first install — exactly the 400 captured in the
 * test suite for this code path. The chosen policy:
 *
 *   - eventSubscriptions: AUTO-HEAL. If the on-disk manifest declares
 *     subscriptions that are missing from `granted_permissions.eventSubscriptions`
 *     OR the DB-stored manifest's `permissions.eventSubscriptions`, the
 *     host UNION-merges the disk additions in (never removes — removal
 *     is the operator's job via re-install) and writes a
 *     `BUNDLED_EVENT_SUBSCRIPTIONS_BACKFILLED` audit row.
 *   - everything else: WARN-AND-FAIL-CLOSED (legacy behavior).
 *
 * Tradeoff: auto-heal sacrifices the strict drift signal for
 * eventSubscriptions specifically, in exchange for avoiding the
 * "bundled extension declares a new event but the runtime can't
 * deliver it" footgun. Anyone who can edit the bundled extension's
 * source can already widen its event surface — the bundled-trust model
 * is "code review is the approval gate" — so auto-heal here is
 * equivalent in security posture to the existing BUNDLED_REGRANTED
 * audit behavior.
 *
 * This is the S6 invariant in the security plan — see
 * .claude/plans/mellow-floating-prism.md for the full security model.
 */
async function detectAndLogManifestDrift(
  entry: BundledExtension,
  extensionId: string,
  dbManifest: ExtensionManifestV2,
  dbGranted?: ExtensionPermissions,
  /**
   * D4 — when the row is ALREADY disabled-pending-reapproval, its drift
   * was warned + audited on the transition boot. On subsequent boots we
   * demote the fail-closed WARN to a single info line and skip the
   * redundant per-field audit re-write so ~10 disabled bundled rows stop
   * re-spamming the log every boot. The auto-heal branches
   * (eventSubscriptions / appendMessages) still run unconditionally —
   * those are healing, not spam.
   */
  alreadyDisabled = false,
): Promise<void> {
  const diskDir = join(getProjectRoot(), entry.path);
  let diskManifest: ExtensionManifestV2;
  try {
    diskManifest = await loadManifestFresh(diskDir);
  } catch (e) {
    log.warn("Could not load on-disk manifest for drift check", {
      name: entry.name,
      error: e instanceof Error ? e.message : String(e),
    });
    return;
  }

  const diskPerms = diskManifest.permissions ?? {};
  const dbPerms = dbManifest.permissions ?? {};
  const diffs: string[] = [];

  // Permission-typed fields we care about for the FAIL-CLOSED branch.
  // Anything else declared in the manifest (description, version, tools
  // list) does not affect the runtime security boundary and so is not
  // surfaced here. eventSubscriptions is handled separately below
  // because we auto-heal that field.
  const fields = ["network", "filesystem", "shell", "env", "storage", "lifecycleHooks"] as const;
  for (const f of fields) {
    if (JSON.stringify(diskPerms[f]) !== JSON.stringify(dbPerms[f])) {
      diffs.push(
        `${f}: disk=${JSON.stringify(diskPerms[f])} vs db=${JSON.stringify(dbPerms[f])}`,
      );
    }
  }

  if (diffs.length > 0) {
    if (alreadyDisabled) {
      // D4 — subsequent boot of an already-disabled, still-drifted row.
      // Same diff payload so an admin can still find it, but at info
      // level and with no audit re-write (the transition boot already
      // wrote the MANIFEST_DRIFTED rows).
      log.info("Bundled extension still drifted — already disabled, DB grant unchanged (no re-audit)", {
        name: entry.name,
        extensionId,
        diffs,
      });
    } else {
      log.warn("Bundled extension manifest permissions drifted — DB grant unchanged (fail-closed)", {
        name: entry.name,
        extensionId,
        diffs,
      });
      // Best-effort audit log — a durable record for post-hoc review.
      try {
        for (const f of fields) {
          const oldValue = dbPerms[f];
          const newValue = diskPerms[f];
          if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
          const meta: ExtensionAuditMetadata = {
            permission: f,
            oldValue,
            newValue,
            actor: "system",
            reason: "bundled-manifest-drifted: on-disk declaration diverges from DB",
          };
          await insertAuditEntry(null, EXT_AUDIT_ACTIONS.MANIFEST_DRIFTED, extensionId, meta);
        }
      } catch { /* audit write failure is non-fatal — the WARN is the primary signal */ }
    }
  }

  // ── eventSubscriptions auto-heal branch ──────────────────────────
  //
  // Compare the on-disk declaration against BOTH the DB manifest's
  // permissions block AND the runtime grant. If the disk declares any
  // subscription not present in either, union-merge it into
  // `granted_permissions.eventSubscriptions` and the DB manifest's
  // `permissions.eventSubscriptions`, then audit. Pure additions only
  // — disk-only removals are not propagated (operator's job at
  // re-install time, mirroring the network/filesystem fail-closed
  // policy).
  const diskEvents = Array.isArray(diskPerms.eventSubscriptions)
    ? diskPerms.eventSubscriptions
    : [];
  const dbManifestEvents = Array.isArray(dbPerms.eventSubscriptions)
    ? dbPerms.eventSubscriptions
    : [];
  const dbGrantedEvents = Array.isArray(dbGranted?.eventSubscriptions)
    ? (dbGranted!.eventSubscriptions as string[])
    : [];

  // Compute the per-column gap independently. Earlier versions used the
  // UNION of (manifest events ∪ grant events) and bailed when the disk
  // declarations were already covered there — but that masked an
  // intra-row drift case: a row whose `manifest.permissions.eventSubscriptions`
  // already lists the events while `granted_permissions.eventSubscriptions`
  // is empty (kokoro-tts under the original install path was the canonical
  // example). The dispatcher reads from the GRANT column at
  // `web/src/lib/server/context.ts:114`, so a manifest-only declaration
  // never reaches the SSE filter — and `/api/extensions/<n>/events/<e>`
  // returns 404 because `isRegisteredExtensionEvent` is false.
  //
  // Treating the columns independently fixes this. We still UNION-merge
  // when writing back so duplicates don't accumulate.
  const grantGap = diskEvents.filter((e) => !dbGrantedEvents.includes(e));
  const manifestGap = diskEvents.filter((e) => !dbManifestEvents.includes(e));

  // The eventSubscriptions branch may bail early when both columns
  // already cover disk; in that case fall through to the
  // appendMessages branch, which has its own per-field gap detection.
  if (grantGap.length === 0 && manifestGap.length === 0) {
    await healBundledAppendMessages(
      entry,
      extensionId,
      dbManifest,
      dbGranted,
      diskPerms as Record<string, unknown>,
      dbPerms as Record<string, unknown>,
    );
    return;
  }

  // Compose the new grant + manifest. Idempotent — once both columns
  // contain `diskEvents`, both gaps are empty and the function returns
  // early on the next boot.
  const newGrantedEvents = Array.from(new Set<string>([...dbGrantedEvents, ...grantGap]));
  const newManifestEvents = Array.from(new Set<string>([...dbManifestEvents, ...manifestGap]));

  try {
    const updates: Partial<{
      grantedPermissions: ExtensionPermissions;
      manifest: ExtensionManifestV2;
    }> = {};
    if (dbGranted) {
      updates.grantedPermissions = {
        ...dbGranted,
        eventSubscriptions: newGrantedEvents,
        grantedAt: {
          ...(dbGranted.grantedAt ?? {}),
          eventSubscriptions: Date.now(),
        },
      };
    }
    const newManifest: ExtensionManifestV2 = {
      ...dbManifest,
      permissions: {
        ...dbPerms,
        eventSubscriptions: newManifestEvents,
      },
    };
    updates.manifest = newManifest;
    await updateExtension(extensionId, updates);
    // ALSO mutate the in-memory snapshot the caller is holding so the
    // downstream "refresh manifest from disk" branch in
    // `ensureBundledExtensions` (which reads `existing.manifest.permissions`
    // and would otherwise overwrite our backfill with the pre-backfill
    // snapshot) sees the merged state. Without this, the manifest column
    // would oscillate every boot; the grant column survives because the
    // refresh only touches `manifest`, but cosmetic drift would re-fire.
    if (dbManifest.permissions == null) {
      (dbManifest as { permissions: Record<string, unknown> }).permissions = {
        eventSubscriptions: newManifestEvents,
      };
    } else {
      (dbManifest.permissions as { eventSubscriptions?: string[] }).eventSubscriptions =
        newManifestEvents;
    }
  } catch (writeErr) {
    log.warn("eventSubscriptions backfill write failed", {
      name: entry.name,
      extensionId,
      error: String(writeErr),
    });
    return;
  }

  log.info("Backfilled bundled extension eventSubscriptions from disk manifest", {
    name: entry.name,
    extensionId,
    grantGap,
    manifestGap,
  });

  try {
    const meta: ExtensionAuditMetadata = {
      permission: "eventSubscriptions",
      oldValue: dbGrantedEvents,
      newValue: newGrantedEvents,
      actor: "system",
      reason:
        "bundled-event-subscriptions-backfilled: on-disk manifest declared additions not " +
        "present in the DB grant. Auto-heal — eventSubscriptions are infrastructure plumbing, " +
        "not a privacy/safety boundary.",
    };
    await insertAuditEntry(
      null,
      EXT_AUDIT_ACTIONS.BUNDLED_EVENT_SUBSCRIPTIONS_BACKFILLED,
      extensionId,
      meta,
    );
  } catch { /* non-fatal — the info log is the primary signal */ }

  // ── appendMessages auto-heal branch ──────────────────────────────
  //
  // Same intra-row drift shape as eventSubscriptions: kokoro-tts (and
  // any future bundled extension that grows an `appendMessages` config
  // post-install) ships the field in `bundled.ts`'s manifest blob, but
  // rows installed before that change have `granted_permissions.appendMessages`
  // unset. The route at
  // `web/src/routes/api/extensions/[name]/events/[event]/+server.ts:295`
  // checks `granted?.appendMessages` and returns 403 when undefined,
  // even though the on-disk manifest declares the config.
  //
  // appendMessages is bundled-trust infrastructure plumbing — same
  // rationale as eventSubscriptions. The on-disk manifest is the
  // source of truth for bundled extensions (code review is the
  // approval gate, S6 model). Auto-heal copies the disk value into
  // BOTH the grant and the DB manifest column when either is
  // missing. Idempotent.
  await healBundledAppendMessages(
    entry,
    extensionId,
    dbManifest,
    dbGranted,
    diskPerms as Record<string, unknown>,
    dbPerms as Record<string, unknown>,
  );
}

async function healBundledAppendMessages(
  entry: BundledExtension,
  extensionId: string,
  dbManifest: ExtensionManifestV2,
  dbGranted: ExtensionPermissions | undefined,
  diskPerms: Record<string, unknown>,
  dbPerms: Record<string, unknown>,
): Promise<void> {
  const diskValue = diskPerms.appendMessages as
    | { excludedDefault: boolean }
    | undefined;
  if (diskValue === undefined) return;

  const dbManifestValue = dbPerms.appendMessages as
    | { excludedDefault: boolean }
    | undefined;
  const dbGrantedValue = dbGranted?.appendMessages;

  const grantNeedsHeal = JSON.stringify(dbGrantedValue) !== JSON.stringify(diskValue);
  const manifestNeedsHeal = JSON.stringify(dbManifestValue) !== JSON.stringify(diskValue);

  if (!grantNeedsHeal && !manifestNeedsHeal) return;

  try {
    const updates: Partial<{
      grantedPermissions: ExtensionPermissions;
      manifest: ExtensionManifestV2;
    }> = {};
    if (dbGranted && grantNeedsHeal) {
      updates.grantedPermissions = {
        ...dbGranted,
        appendMessages: diskValue,
        grantedAt: {
          ...(dbGranted.grantedAt ?? {}),
          appendMessages: Date.now(),
        },
      };
    }
    if (manifestNeedsHeal) {
      const newManifest: ExtensionManifestV2 = {
        ...dbManifest,
        permissions: {
          ...(dbManifest.permissions ?? {}),
          appendMessages: diskValue,
        },
      };
      updates.manifest = newManifest;
      // Mirror the eventSubscriptions branch: keep the in-memory snapshot
      // in sync so the downstream manifest-refresh path doesn't undo
      // this write on the same boot.
      if (dbManifest.permissions == null) {
        (dbManifest as { permissions: Record<string, unknown> }).permissions = {
          appendMessages: diskValue,
        };
      } else {
        (dbManifest.permissions as { appendMessages?: { excludedDefault: boolean } })
          .appendMessages = diskValue;
      }
    }
    if (Object.keys(updates).length === 0) return;
    await updateExtension(extensionId, updates);
  } catch (writeErr) {
    log.warn("appendMessages backfill write failed", {
      name: entry.name,
      extensionId,
      error: String(writeErr),
    });
    return;
  }

  log.info("Backfilled bundled extension appendMessages from disk manifest", {
    name: entry.name,
    extensionId,
    grantNeedsHeal,
    manifestNeedsHeal,
  });

  try {
    const meta: ExtensionAuditMetadata = {
      permission: "appendMessages",
      oldValue: dbGrantedValue ?? null,
      newValue: diskValue,
      actor: "system",
      reason:
        "bundled-append-messages-backfilled: on-disk manifest declared appendMessages config " +
        "not present in the DB grant. Auto-heal — appendMessages is infrastructure plumbing " +
        "for the ezcorp/append-message reverse-RPC, not a privacy/safety boundary.",
    };
    await insertAuditEntry(
      null,
      EXT_AUDIT_ACTIONS.BUNDLED_EVENT_SUBSCRIPTIONS_BACKFILLED,
      extensionId,
      meta,
    );
  } catch { /* non-fatal — the info log is the primary signal */ }
}

/**
 * Re-approval gate (S9). Compares on-disk manifest `version`,
 * `permissions`, and tool-list signature against the DB-stored copy.
 * Returns `true` if the gate engaged, meaning the caller should
 * disable the extension and leave it disabled until an admin
 * re-approves. Also writes an `UPDATE_BLOCKED` audit row per
 * differing field so the admin UI can show exactly what changed.
 *
 * Trigger conditions (any one suffices):
 *   1. Version changed AND permissions changed (the original S9
 *      gate — catches a dependency release that quietly widens
 *      its permission surface under a new version number).
 *   2. Tool-list signature changed (Phase 5, regardless of version
 *      or permissions). Adding, removing, renaming, or modifying
 *      a tool's `inputSchema` requires explicit re-approval — a
 *      new tool that exercises existing grants in unforeseen ways
 *      is exactly the supply-chain attack Phase 5 closes.
 *
 * A pure version bump with no permission AND no tool change is a
 * normal upgrade and does NOT engage the gate. A pure permissions
 * change with no version bump is caught by drift detection (S6).
 * Tool-list signature drift is caught here.
 */
async function detectVersionBumpRequiringReapproval(
  entry: BundledExtension,
  extensionId: string,
  dbManifest: ExtensionManifestV2,
): Promise<boolean> {
  const diskDir = join(getProjectRoot(), entry.path);
  let diskManifest: ExtensionManifestV2;
  try {
    diskManifest = await loadManifestFresh(diskDir);
  } catch {
    // Can't read disk → don't block. The drift check already warned.
    return false;
  }

  // Tool-list signature: canonical-JSON SHA-256. Drift on this signal
  // is independent of the version-vs-permissions trigger and ALWAYS
  // requires re-approval (Phase 5).
  const dbToolHash = canonicalizeAndHash(dbManifest.tools ?? []);
  const diskToolHash = canonicalizeAndHash(diskManifest.tools ?? []);
  const toolListChanged = dbToolHash !== diskToolHash;

  // Version + permissions trigger (legacy S9).
  const versionChanged = diskManifest.version !== dbManifest.version;

  const diskPerms = diskManifest.permissions ?? {};
  const dbPerms = dbManifest.permissions ?? {};
  const fields = ["network", "filesystem", "shell", "env", "storage", "lifecycleHooks"] as const;
  const diffs: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
  for (const f of fields) {
    const a = dbPerms[f];
    const b = diskPerms[f];
    if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push({ field: f, oldValue: a, newValue: b });
  }

  // No trigger: pure version bump, pure cosmetic refresh, or a
  // permission-only change that's already caught by drift detection.
  if (!toolListChanged && (!versionChanged || diffs.length === 0)) {
    return false;
  }

  // Tool-list change adds a synthetic diff entry so the admin UI
  // surfaces it next to the permissions diffs.
  if (toolListChanged) {
    diffs.push({
      field: "tools",
      oldValue: dbToolHash,
      newValue: diskToolHash,
    });
  }
  if (diffs.length === 0) return false;

  // Audit each differing field so the admin UI can render a readable diff.
  try {
    for (const d of diffs) {
      const meta: ExtensionAuditMetadata = {
        permission: d.field,
        oldValue: d.oldValue,
        newValue: d.newValue,
        actor: "system",
        reason: `version-bump-blocked: ${dbManifest.version} → ${diskManifest.version} changed permissions`,
      };
      await insertAuditEntry(null, EXT_AUDIT_ACTIONS.UPDATE_BLOCKED, extensionId, meta);
    }
  } catch { /* non-fatal */ }

  return true;
}

/**
 * One audit row when the S9 gate auto-reapproves a `critical` bundled
 * extension whose version bumped + permissions changed but stayed
 * within the bundled ceiling. The forensic trail records the version
 * delta so an operator can see the loop-safety floor kept `ask-user` /
 * `task-tracking` enabled (and that the ceiling was still enforced).
 */
async function writeCriticalAutoReapprovalAudit(
  extensionId: string,
  extensionName: string,
  oldVersion: string | undefined,
  newVersion: string,
): Promise<void> {
  try {
    const meta: ExtensionAuditMetadata = {
      permission: undefined,
      oldValue: oldVersion,
      newValue: newVersion,
      actor: "system",
      extensionName,
      reason:
        `critical-auto-reapproved: ${oldVersion ?? "?"} → ${newVersion} ` +
        "permission change stayed within bundled ceiling — kept enabled " +
        "(loop-safety floor)",
    };
    await insertAuditEntry(
      null,
      EXT_AUDIT_ACTIONS.BUNDLED_CRITICAL_AUTO_REAPPROVED,
      extensionId,
      meta,
    );
  } catch {
    /* audit write failure is non-fatal */
  }
}

async function writeBundledInstallAudit(
  extensionId: string,
  permissions: ExtensionPermissions,
): Promise<void> {
  const fields = ["network", "filesystem", "shell", "env", "storage"] as const;
  try {
    for (const f of fields) {
      const v = permissions[f];
      if (v === undefined || v === false || (Array.isArray(v) && v.length === 0)) continue;
      const meta: ExtensionAuditMetadata = {
        permission: f,
        oldValue: undefined,
        newValue: v,
        actor: "system",
        reason: "bundled-install: code-review is the approval gate",
      };
      await insertAuditEntry(null, EXT_AUDIT_ACTIONS.BUNDLED_INSTALLED, extensionId, meta);
    }
    // Phase 51: governance — emit `ext:env-key-leak-warning` for any
    // env names that match `*_API_KEY|TOKEN|SECRET`. Migration path:
    // ctx.llm (host-brokered). Soft today; hard in v1.4.
    const { emitEnvKeyLeakWarnings } = await import("./clamp-permissions");
    await emitEnvKeyLeakWarnings(extensionId, permissions.env);
  } catch { /* audit write failure is non-fatal */ }
}

async function writeBundledRegrantAudit(
  extensionId: string,
  permissions: ExtensionPermissions,
): Promise<void> {
  const fields = ["network", "filesystem", "shell", "env", "storage"] as const;
  try {
    for (const f of fields) {
      const v = permissions[f];
      if (v === undefined || v === false || (Array.isArray(v) && v.length === 0)) continue;
      const meta: ExtensionAuditMetadata = {
        permission: f,
        oldValue: undefined,
        newValue: v,
        actor: "system",
        reason: "bundled-regrant: operator-disabled bundled ext re-enabled on startup",
      };
      await insertAuditEntry(null, EXT_AUDIT_ACTIONS.BUNDLED_REGRANTED, extensionId, meta);
    }
  } catch { /* audit write failure is non-fatal */ }
}

/**
 * Stable, order-independent canonical string for an `ExtensionPermissions`
 * shape — mirrors `bundled-ceiling.ts`'s `canonicalizePerms` intent
 * (sort keys, sort string arrays, drop `undefined`/`false`/empty so a
 * semantic no-op shape difference doesn't trip the idempotency gate).
 * Recursive so nested bags (`custom.drafts.kinds`, `grantedAt`, …) are
 * also order-stable. Used ONLY for the reconciliation idempotency
 * compare; `clampToBundledCeiling` keeps its own private comparator.
 */
function canonicalGrant(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      const mapped = v.map(walk);
      const allStrings = mapped.every((x) => typeof x === "string");
      return allStrings ? [...(mapped as string[])].sort() : mapped;
    }
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        const inner = (v as Record<string, unknown>)[k];
        if (inner === undefined) continue;
        if (inner === false) continue; // not-granted ≡ omitted
        if (Array.isArray(inner) && inner.length === 0) continue;
        if (
          inner !== null &&
          typeof inner === "object" &&
          !Array.isArray(inner) &&
          Object.keys(inner as Record<string, unknown>).length === 0
        ) {
          continue; // empty bag ({} grantedAt) ≡ omitted
        }
        out[k] = walk(inner);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

/**
 * Self-heal the stored `grantedPermissions` of an EXISTING bundled row
 * toward the bundled entry's DECLARED-WITHIN-CEILING grant.
 *
 * Why this exists: `ensureBundledExtensions`'s existing-row branch runs
 * S6 drift + S9 version gate + manifest refresh, but ALL of those
 * deliberately preserve the stored `permissions` block and NEVER touch
 * the `grantedPermissions` DB column. A row seeded before a within-
 * ceiling declared grant existed (or one previously clamped/stripped)
 * therefore stays broken across every restart — e.g. an enabled
 * `extension-author` row whose grant lacks `custom.drafts.kinds`
 * returns "custom.drafts.kinds not granted" on every scaffold.
 *
 * Reconciliation contract (security-load-bearing — see the call-site
 * comment for the invariant list):
 *   1. target = stored-grant deep-merged with the bundled entry's
 *      declared `permissions` (declared keys win, so missing declared
 *      fields are BACKFILLED; existing stored values are preserved).
 *   2. reconciled = `clampToBundledCeiling(name, target).effective` —
 *      the ceiling clamp is the hard bound, so `reconciled ⊆ ceiling`
 *      ALWAYS, even if the stored row carried perms beyond ceiling
 *      (those are dropped, never preserved).
 *   3. `grantedAt` is normalized to a present map before clamping so
 *      `intersectPermissions`/`clampToBundledCeiling` retain timestamps
 *      for surviving fields — mirrors the critical-S9 path at
 *      `bundled.ts:851-864` and the fresh-install grant shape.
 *   4. Idempotent: a structural (order-independent) compare against the
 *      stored grant gates the DB write + audit, so a satisfied grant
 *      writes nothing and emits no audit on subsequent boots.
 *
 * Generic across ALL bundled entries — there is no extension-author
 * special-case. Called from the two ENABLED exits of the existing-row
 * branch: the normal no-gate fall-through, and the critical-S9
 * auto-reapprove `continue` (which keeps the row enabled but skips the
 * normal site). NOT called from the fail-closed disable exits
 * (non-critical S9 / tamper) — a row pending re-approval keeps its
 * stored grant until a human re-approves.
 */
async function reconcileBundledGrant(
  entry: BundledExtension,
  existing: { id: string; grantedPermissions?: ExtensionPermissions },
): Promise<void> {
  try {
    const stored: ExtensionPermissions =
      (existing.grantedPermissions as ExtensionPermissions | undefined) ?? {
        grantedAt: {},
      };
    const declared = entry.permissions ?? ({} as ExtensionPermissions);

    // Deep-merge: declared keys backfill missing fields; stored values
    // are otherwise preserved. `custom`/`grantedAt` merge one level
    // deep so a stored `custom.foo` survives alongside a backfilled
    // `custom.drafts`. The subsequent ceiling clamp is the hard bound,
    // so this merge can NEVER widen past the ceiling regardless of what
    // the stored row carried.
    const mergedCustom =
      declared.custom || stored.custom
        ? { ...(stored.custom ?? {}), ...(declared.custom ?? {}) }
        : undefined;
    const merged: ExtensionPermissions = {
      ...stored,
      ...declared,
      ...(mergedCustom ? { custom: mergedCustom } : {}),
      // Normalize grantedAt to a present map BEFORE the clamp (mirrors
      // bundled.ts:851-864). `grantedAt` SEMANTICS: a field's timestamp
      // is the moment it was first granted, so the STORED timestamp
      // wins for any field that already carried one; the declared
      // timestamp only backfills keys the stored grant lacked (the
      // genuinely-new fields). Spread declared first, stored last, so
      // pre-existing grant history is never rewritten — this also keeps
      // the idempotency compare stable across boots (a satisfied grant
      // produces an identical `grantedAt`).
      grantedAt: {
        ...(declared.grantedAt ?? {}),
        ...(stored.grantedAt ?? {}),
      },
    };

    const { effective: reconciled } = clampToBundledCeiling(
      entry.name,
      merged,
    );

    // Idempotency gate: structural compare. No write, no audit when the
    // stored grant already satisfies the within-ceiling declared set.
    const storedNorm: ExtensionPermissions = {
      ...stored,
      grantedAt: stored.grantedAt ?? {},
    };
    if (canonicalGrant(reconciled) === canonicalGrant(storedNorm)) {
      return;
    }

    await updateExtension(existing.id, { grantedPermissions: reconciled });
    log.info("Reconciled bundled extension grant toward declared ceiling", {
      name: entry.name,
      extensionId: existing.id,
    });
    // Reuse the existing field-level regrant audit for the standard
    // primary-permission tiers, then add one row covering the namespaced
    // `custom` bag (extension-author's `custom.drafts.kinds` lives here
    // and `writeBundledRegrantAudit` does not enumerate it) so the
    // backfill is actually auditable for the bug this fixes.
    await writeBundledRegrantAudit(existing.id, reconciled);
    await writeBundledGrantReconciledAudit(existing.id, storedNorm, reconciled);
  } catch (reconcileErr) {
    // Non-fatal: drift/refresh already ran; next boot retries. NEVER
    // throw out of the ensureBundledExtensions iteration.
    log.warn("Bundled grant reconciliation failed", {
      name: entry.name,
      error: String(reconcileErr),
    });
  }
}

/**
 * Audit a grant reconciliation. Captures the FULL before/after grant
 * under the existing `BUNDLED_REGRANTED` action so an admin sees the
 * exact backfill (including the namespaced `custom` bag, which the
 * field-enumerating `writeBundledRegrantAudit` skips). Only emitted
 * when the grant actually changed (the caller's idempotency gate).
 */
async function writeBundledGrantReconciledAudit(
  extensionId: string,
  oldGrant: ExtensionPermissions,
  newGrant: ExtensionPermissions,
): Promise<void> {
  try {
    const meta: ExtensionAuditMetadata = {
      permission: "grant-reconcile",
      oldValue: oldGrant,
      newValue: newGrant,
      actor: "system",
      reason:
        "bundled-grant-reconciled: stored grant backfilled toward the " +
        "declared-within-ceiling bundled permission set (S6 companion). " +
        "Result is clamped to the bundled ceiling.",
    };
    await insertAuditEntry(
      null,
      EXT_AUDIT_ACTIONS.BUNDLED_REGRANTED,
      extensionId,
      meta,
    );
  } catch { /* audit write failure is non-fatal */ }
}

/**
 * Phase 5: write an audit row for a bundled-install grant clamped to
 * the hardcoded ceiling. The metadata captures the FULL requested vs.
 * effective grant so an admin reviewing the audit log can reconstruct
 * exactly which fields were narrowed without consulting `bundled.ts`
 * source.
 */
async function writeBundledCeilingClampAudit(
  extensionId: string,
  extensionName: string,
  requested: ExtensionPermissions,
  effective: ExtensionPermissions,
): Promise<void> {
  const ceiling = getCeiling(extensionName);
  const meta: ExtensionAuditMetadata = {
    permission: "ceiling-clamp",
    oldValue: requested,
    newValue: effective,
    actor: "system",
    reason: `bundled-ceiling-clamp: bundled '${extensionName}' install request narrowed by hardcoded ceiling`,
    extensionName,
    requested,
    effective,
    ceiling,
  };
  try {
    await insertAuditEntry(null, EXT_AUDIT_ACTIONS.BUNDLED_CEILING_CLAMP, extensionId, meta);
  } catch { /* audit write failure is non-fatal */ }
}

/**
 * Phase 5: write an audit row when `verifyManifestAgainstLock` returns
 * `ok: false`. Captures the lockfile-vs-disk diff so an admin can
 * confirm whether the mismatch was a maintainer's missed lockfile
 * regenerate or a tampering signal.
 */
async function writeBundledManifestTamperAudit(
  extensionId: string,
  extensionName: string,
  reason: string,
  expected: unknown,
  actual: unknown,
): Promise<void> {
  const meta: ExtensionAuditMetadata = {
    permission: "manifest-tamper",
    oldValue: expected,
    newValue: actual,
    actor: "system",
    reason: `bundled-manifest-tamper: ${reason}`,
    extensionName,
    expected,
    actual,
  };
  try {
    await insertAuditEntry(null, EXT_AUDIT_ACTIONS.BUNDLED_MANIFEST_TAMPER, extensionId, meta);
  } catch { /* audit write failure is non-fatal */ }
}

/**
 * Phase 53 fix — boot-spawn bundled extensions whose only entrypoint is
 * event subscription.
 *
 * `EventSubscriptionDispatcher.dispatch` calls
 * `registry.getProcessIfRunning(extId)` and silently drops the event
 * when the process isn't already running (the docstring on
 * `getProcessIfRunning` reads "Never starts a new process"). Bundled
 * extensions that ONLY subscribe to events (no LLM-callable tools, no
 * manual triggers, no on-mention auto-wire) therefore never receive any
 * events — UAT for Phase 53.5 caught this for memory-extractor (100%
 * broken since cf189b2) and lessons-distiller (auto-distill broken
 * post-3aa48e6).
 *
 * This helper iterates `BUNDLED_EXTENSIONS`, picks every entry with
 * `bootSpawn: true`, and:
 *   1. Looks up the DB row by manifest name (to get the assigned extId).
 *   2. Skips when the row is missing (install failed earlier in
 *      `ensureBundledExtensions`) or disabled (operator opt-out).
 *   3. Calls `registry.getProcess(extId)` — the registry's only spawn
 *      API; this is the same call path used by `tool-executor.ts:592`
 *      for tool dispatch, so the subprocess gets the same env / sandbox
 *      / rate-limit setup. Note: `getProcess` only constructs the
 *      `ExtensionProcess` wrapper — the actual `Bun.spawn(...)` is
 *      deferred to `proc.ensureRunning()`, which is normally called
 *      lazily inside `proc.call(...)` on first tool invocation.
 *      Event-only extensions never `call`, so this helper MUST drive
 *      the spawn explicitly via `ensureRunning()`.
 *   4. Calls `proc.ensureRunning()` — actually spawns the subprocess.
 *      Synchronous and idempotent (`subprocess.ts:174-176`). Without
 *      this step the wrapper exists but `proc.proc` stays `null`, so
 *      `proc.isRunning` returns `false` and the dispatcher's
 *      `getProcessIfRunning` silently drops every event. This was the
 *      Phase 53.6 bug — UAT for Phase 53.5 caught it; the two
 *      pre-existing unit tests for this helper happened to stub
 *      `isRunning: true` on the proc and missed the gap entirely.
 *   5. Calls the supplied `wireRpc(extId, proc)` callback to install
 *      the JSON-RPC handlers (ezcorp/invoke, ezcorp/storage,
 *      ezcorp/memory, ezcorp/lessons, etc.) — without this, any
 *      reverse-RPC the extension issues (e.g. `ctx.memory.write` from
 *      memory-extractor's `run:complete` handler) would error with
 *      "Method not found". Spawn-then-wire is intentional: handlers
 *      are stored in `pendingRequestHandler`/`pendingNotificationHandler`
 *      and re-wired into the live transport on the next
 *      `setRequestHandler`/`setNotificationHandler` call, so wiring
 *      after spawn is correctly idempotent. Spawn-after-wire would
 *      lose handlers if the subprocess crashes between the two calls.
 *
 * `wireRpc` is injected (rather than imported directly) for two reasons:
 *   - Avoid the circular-import hazard between `bundled.ts` and
 *     `tool-executor.ts` (the latter imports `ExtensionRegistry` and a
 *     dozen other extension internals).
 *   - Tests can inject a no-op stub or a mock that asserts the call.
 *
 * Failure semantics: per-entry try/catch. A spawn or RPC-wiring failure
 * is logged and swallowed; the next entry still attempts to boot. The
 * host startup MUST NOT abort because one extension is broken — the
 * dispatcher's event-drop is preferable to an unbootable server.
 *
 * Idempotent: subsequent calls to `getProcess` on an already-running
 * extension return the same `ExtensionProcess`; `ensureRunning()` is a
 * no-op when `proc.proc` is already set; `ensureSubprocessRpcWired`
 * (the typical implementation behind `wireRpc`) is also idempotent via
 * its internal `wiredExtensions` Set. The whole helper is safe to call
 * twice (same boot path with no observable side effect on the second
 * call).
 */
export async function bootSpawnFlaggedBundledExtensions(
  registry: ExtensionRegistry,
  wireRpc: (extensionId: string, proc: ExtensionProcess) => Promise<void>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ spawned: string[]; failed: string[] }> {
  const spawned: string[] = [];
  const failed: string[] = [];

  for (const entry of resolveBundledExtensions(env)) {
    if (entry.bootSpawn !== true) continue;

    let row: Awaited<ReturnType<typeof getExtensionByName>> | null = null;
    try {
      row = await getExtensionByName(entry.name);
    } catch (lookupErr) {
      log.warn(
        "boot-spawn lookup failed; event-only handlers will not fire until next boot",
        { name: entry.name, error: String(lookupErr) },
      );
      failed.push(entry.name);
      continue;
    }
    if (!row) {
      log.warn(
        "boot-spawn skipped: bundled extension row missing — install must have failed earlier",
        { name: entry.name },
      );
      failed.push(entry.name);
      continue;
    }
    if (!row.enabled) {
      // Operator-disabled (or fail-closed via tamper / version gate).
      // Don't auto-spawn a disabled extension — re-enable goes through
      // the normal admin path. This matches `EventSubscriptionDispatcher`
      // which would also skip a disabled extension's events because the
      // subscription registration only runs on enabled rows.
      log.info("boot-spawn skipped: bundled extension disabled", { name: entry.name });
      continue;
    }

    try {
      const proc = await registry.getProcess(row.id);
      // Phase 53.6 fix: actually spawn the subprocess. `getProcess`
      // only constructs the `ExtensionProcess` wrapper; the real
      // `Bun.spawn` is deferred to `ensureRunning()` (normally called
      // lazily by `proc.call()`). Event-only extensions never `call`,
      // so without this line `proc.isRunning` stays false and the
      // dispatcher's `getProcessIfRunning` returns null on every
      // emitted `run:complete`, silently dropping the event.
      // `ensureRunning()` is synchronous + idempotent.
      proc.ensureRunning();
      await wireRpc(row.id, proc);
      log.info("boot-spawned bundled extension", {
        name: entry.name,
        extensionId: row.id,
      });
      spawned.push(entry.name);
    } catch (err) {
      log.warn(
        "boot-spawn failed; event-only handlers will not fire until next boot",
        { name: entry.name, extensionId: row.id, error: String(err) },
      );
      failed.push(entry.name);
    }
  }

  return { spawned, failed };
}
