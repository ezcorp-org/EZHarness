/**
 * Bundled extension capability ceiling — Phase 5.
 *
 * Hardcoded max-grant table for every bundled extension. The table is the
 * SECURITY ceiling, not the declared shape: even if a compromised manifest
 * declares wider permissions, the install path intersects the user-requested
 * grant with this ceiling and the persisted runtime grant cannot exceed it.
 *
 * This protects against three concrete supply-chain failure modes:
 *
 *   1. Compromised maintainer credentials — a malicious PR is merged
 *      without an effective code-review gate.
 *   2. Malicious dependency upgrade inside a bundled extension's
 *      `node_modules` pulled at build time (the extension's manifest
 *      is unchanged but its code now requests wider-than-reviewed scope).
 *   3. Post-pull file modification by a local attacker with write access
 *      to the repo on a developer machine.
 *
 * Because the ceiling is a `code-review-time` artifact (sourced from this
 * file, NOT from `manifest.permissions`), a compromised manifest cannot
 * generate a self-matching ceiling. Every change to this file is a
 * security-relevant decision and MUST be reviewed by a maintainer.
 *
 * The ceiling COMPOSES with `manifest.lock.json` (which guards tool-list,
 * entrypoint, and version drift): manifest tamper is still caught even if
 * an attacker widens the ceiling.
 *
 * Scope: bundled extensions only — `getCeiling()` returns `null` for
 * unknown names; `clampToBundledCeiling()` becomes a passthrough on a
 * non-bundled name (callers should not normally invoke it for those).
 */

import type { ExtensionPermissions } from "./types";
import { intersectPermissions } from "./capability-types";
import { logger } from "../logger";

const log = logger.child("bundled-ceiling");

/**
 * Ceiling table — keys MUST match `BUNDLED_EXTENSIONS[*].name` in
 * `./bundled.ts`. The values mirror each bundled extension's CURRENT
 * declared `permissions` block in `docs/extensions/examples/<name>/
 * ezcorp.config.ts` (the source of "today's reality"). The bound is
 * "no widening allowed via compromise" — narrower-than-today is also
 * a behavior change and MUST be a separate, reviewed PR.
 *
 * Numeric ceilings (`spawnAgents.maxPerHour`, `maxConcurrent`) are
 * clamped via `Math.min` by `intersectPermissions`.
 *
 * `grantedAt: {}` because the ceiling is a grant-shape, not a real
 * grant — `intersectPermissions` only retains `grantedAt` keys whose
 * permission survived the intersection, so an empty map is the right
 * neutral element.
 */
export const BUNDLED_CEILING: Record<string, ExtensionPermissions> = {
  // Ephemeral conversation-scoped KV store — only `storage`, no
  // network/fs/shell/env.
  "scratchpad": { storage: true, grantedAt: {} },

  // Multi-task planning + sub-agent coordination. `spawnAgents`
  // matches the manifest declaration verbatim.
  "task-tracking": {
    storage: true,
    taskEvents: true,
    agentConfig: "read",
    spawnAgents: { maxPerHour: 200, maxConcurrent: 10 },
    eventSubscriptions: ["task:assignment_update"],
    grantedAt: {},
  },

  // Multi-agent orchestration primitives — `invoke_agent` for
  // cross-conversation delegation.
  "orchestration": {
    agentConfig: "read",
    spawnAgents: { maxPerHour: 500, maxConcurrent: 25 },
    eventSubscriptions: ["task:assignment_update"],
    grantedAt: {},
  },

  // Bundled human-in-the-loop. Subscribes to `ask-user:answer` only.
  "ask-user": {
    eventSubscriptions: ["ask-user:answer"],
    grantedAt: {},
  },

  // Reads project files; the postinstall script may shell out.
  "project-analyzer": {
    filesystem: ["$CWD"],
    shell: true,
    grantedAt: {},
  },

  // Pure markdown helpers. Empty permissions block.
  "markdown-utils": { grantedAt: {} },

  // Dispatcher — relies on dependencies' permissions.
  "code-review-delegator": { grantedAt: {} },

  // GitHub stats — read-only API access.
  "github-stats": {
    network: ["api.github.com"],
    env: ["GITHUB_TOKEN"],
    grantedAt: {},
  },

  // Forward-looking orchestrator skeleton — no runtime perms.
  "multi-agent-orchestrator": { grantedAt: {} },

  // Pure-prompt research agent — no runtime perms.
  "research-agent": { grantedAt: {} },

  // File refactoring — local fs only, NO shell.
  "file-refactor": {
    filesystem: ["$CWD"],
    grantedAt: {},
  },

  // Log analysis — local fs only, NO shell.
  "log-analyzer": {
    filesystem: ["$CWD"],
    grantedAt: {},
  },

  // Todo tracker — local fs + shell allowed.
  "todo-tracker": {
    filesystem: ["$CWD"],
    shell: true,
    grantedAt: {},
  },

  // Task-stack — local fs only, NO shell.
  "task-stack": {
    filesystem: ["$CWD"],
    grantedAt: {},
  },

  // ai-kit — bundled deputy that calls the EZCorp HTTP API.
  // Manifest declares only `localhost`; the bundled grant in
  // `bundled.ts` widens to `["localhost", "127.0.0.1"]` because
  // both are addresses for the same loopback service. The ceiling
  // tracks the manifest declaration ∪ the bundled grant — clamp
  // semantics are MIN (intersection), so anything outside this
  // set is denied. Adding `127.0.0.1` here keeps the existing
  // bundled grant intact (no Day-1 break) without permitting any
  // remote network host.
  "ai-kit": {
    network: ["localhost", "127.0.0.1"],
    filesystem: ["$CWD"],
    env: ["EZCORP_BASE_URL", "EZCORP_API_KEY", "EZCORP_SESSION_COOKIE"],
    grantedAt: {},
  },

  // Web search — fixed allowlist of search providers + their secrets,
  // plus filesystem access so the disk-backed TTL/LRU cache in cache.ts
  // can persist under `<projectRoot>/.ezcorp/extension-data/web-search/`.
  // Keyless defaults: the SearXNG sidecar (internal hosts `searxng` /
  // `localhost` / `127.0.0.1` — routed through the network.internal PDP)
  // and the DuckDuckGo no-JS endpoints (`duckduckgo.com` covers the
  // `//duckduckgo.com/l/?uddg=` redirect shape).
  //
  // SECURITY NOTE: the loopback grants (`localhost` / `127.0.0.1`) are
  // HOSTNAME-scoped, not port-scoped — the host-side internal fetch can
  // reach ANY loopback port, not just the SearXNG sidecar's. That is
  // acceptable for bundled (first-party) code; port-scoped internal
  // grants are on the roadmap.
  "web-search": {
    network: [
      "r.jina.ai",
      "s.jina.ai",
      "api.tavily.com",
      "api.search.brave.com",
      "api.exa.ai",
      "serpapi.com",
      "lite.duckduckgo.com",
      "html.duckduckgo.com",
      "duckduckgo.com",
      "searxng",
      "localhost",
      "127.0.0.1",
    ],
    env: [
      "TAVILY_API_KEY",
      "BRAVE_API_KEY",
      "EXA_API_KEY",
      "SERPAPI_API_KEY",
      "JINA_API_KEY",
      // Not credential-shaped — base URL for the SearXNG sidecar.
      "SEARXNG_BASE_URL",
    ],
    filesystem: ["$CWD"],
    grantedAt: {},
  },

  // OpenAI image generation — single API host plus subscription path.
  "openai-image-gen-2": {
    network: ["api.openai.com", "chatgpt.com"],
    env: ["OPENAI_API_KEY", "OPENAI_ACCESS_TOKEN"],
    filesystem: ["$CWD"],
    grantedAt: {},
  },

  // Property intelligence — purely local, fs-only.
  "property-intelligence-agent": {
    filesystem: ["$CWD"],
    grantedAt: {},
  },

  // claude-design — fs + storage + dual event subscriptions + a
  // single jsdelivr host (for the design-system fetcher).
  "claude-design": {
    filesystem: ["$CWD"],
    storage: true,
    eventSubscriptions: [
      "claude-design:knob-change",
      "claude-design:brief-answer",
    ],
    network: ["cdn.jsdelivr.net"],
    grantedAt: {},
  },

  // excel — pure in-process xlsx parser. No runtime perms.
  "excel": { grantedAt: {} },

  // price-chart — Yahoo Finance / CoinGecko charts via iframeSrc custom-canvas.
  // Storage for the rendered HTML payload; fs for asset caching; network for
  // the data + icon hosts declared in bundled.ts.
  "price-chart": {
    filesystem: ["$CWD"],
    storage: true,
    network: [
      "query1.finance.yahoo.com",
      "api.coingecko.com",
      "logo.clearbit.com",
      "assets.coingecko.com",
      "coin-images.coingecko.com",
      "cdn.jsdelivr.net",
    ],
    grantedAt: {},
  },

  // kokoro-tts — speaker icon contribution + append-message reverse RPC.
  "kokoro-tts": {
    eventSubscriptions: ["kokoro-tts:speak", "kokoro-tts:save"],
    appendMessages: { excludedDefault: true },
    grantedAt: {},
  },

  // Phase 53 — lessons-distiller (bundled port). Mirrors the install
  // grant in `bundled.ts`. Ceiling matches today's reality verbatim;
  // any widening is a deliberate, reviewed PR.
  "lessons-distiller": {
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
    grantedAt: {},
  },

  // extension-author — bundled extension that scaffolds new extensions
  // on LLM request. Matches the install grant in `bundled.ts`. The
  // `custom.drafts.kinds` ceiling captures today's reality verbatim;
  // any widening (other kinds, broader filesystem) is a deliberate,
  // reviewed PR.
  "extension-author": {
    filesystem: ["$CWD/.ezcorp/extension-data/extension-author"],
    custom: { drafts: { kinds: ["extension"] } },
    grantedAt: {},
  },

  // Phase 53.4 — memory-extractor (bundled port). selfOnly: false is
  // the documented exception (cross-extension dedup); see
  // `extensions/memory-extractor/ezcorp.config.ts`. The ceiling
  // mirrors the install grant verbatim.
  "memory-extractor": {
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
    grantedAt: {},
  },

  // ez-code — Warren-style control plane for ephemeral coding-agent
  // runs. Mirrors the install grant in `bundled.ts` VERBATIM (the bound
  // is "no widening allowed via compromise"). spawnAgents numeric
  // ceiling matches the manifest declaration (30/hr, 6 concurrent);
  // open_pr's `shell` + `api.github.com` network + `$CWD` filesystem are
  // the headline branch→PR automation grants.
  //
  // SCHEDULE TRAP: `intersectPermissions` does `Math.min` on
  // `schedule.maxRunDurationMs` / `maxRetries` and reads
  // `missedRunPolicy`. The manifest validator defaults those to
  // `300_000` / `0` / `"fire-once"`. This ceiling MUST carry the full
  // five-field schedule (same values as the grant) so the intersection
  // is lossless — otherwise `Math.min(NaN, …)` silently breaks the cron
  // grant. crons + maxRunsPerDay (48) survive because both sides match.
  "ez-code": {
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
    schedule: {
      crons: ["0 * * * *", "0 9 * * *"],
      maxRunsPerDay: 48,
      maxRunDurationMs: 300_000,
      missedRunPolicy: "fire-once",
      maxRetries: 0,
    },
    grantedAt: {},
  },

  // substack-pilot — MCP-driven Substack draft pilot. Spawns
  // `npx -y substack-mcp@latest` (shell), summarizes user-pasted URLs
  // (broad network), and consumes BYOK LLM credentials within tight
  // per-hour/per-day caps. Mirrors install grant in `bundled.ts:676-694`.
  "substack-pilot": {
    storage: true,
    shell: true,
    network: ["*"],
    llm: {
      providers: ["anthropic", "openai"],
      maxCallsPerHour: 120,
      maxCallsPerDay: 600,
      maxTokensPerCall: 2048,
    },
    grantedAt: {},
  },

  // substack-pipeline — sibling to substack-pilot. LLM (WRITER +
  // ILLUSTRATOR stages) + storage (conversation-scoped scratch state
  // between the 3 tools). No network/shell: the URL fetch is delegated
  // to substack-pilot's subprocess; the cross-ext invoke targets are
  // manifest `dependencies`, not permissions. Mirrors the install grant
  // in `bundled.ts`.
  "substack-pipeline": {
    storage: true,
    llm: {
      providers: ["anthropic", "openai"],
      maxCallsPerHour: 120,
      maxCallsPerDay: 600,
      maxTokensPerCall: 4096,
    },
    grantedAt: {},
  },
};

/**
 * Lookup a bundled extension's ceiling. Returns `null` for non-bundled
 * names so callers can detect "ceiling does not apply" without thrown
 * errors.
 */
export function getCeiling(extensionName: string): ExtensionPermissions | null {
  return BUNDLED_CEILING[extensionName] ?? null;
}

/**
 * Clamp a user-requested install grant to the bundled ceiling.
 *
 * Returns `{ effective, clamped }`:
 *   - `effective`: the grant after `intersectPermissions(requested, ceiling)`.
 *     This is what the caller MUST persist to the DB row.
 *   - `clamped`: `true` iff at least one field was narrowed. Caller is
 *     responsible for emitting `AUDIT_BUNDLED_CEILING_CLAMP` when this
 *     flag is set.
 *
 * For unknown (non-bundled) extension names the function passes through
 * the request unchanged with `clamped: false` — this is the safe default
 * (the ceiling does NOT apply to user-installed extensions; their checksum
 * + manifest re-approval gate is governed elsewhere).
 *
 * Reuses Phase 4's `intersectPermissions` so all permission tiers
 * (network, fs, shell, env, storage, taskEvents, agentConfig, spawnAgents,
 * eventSubscriptions, appendMessages) follow the same intersection
 * semantics as cross-extension cap intersection.
 */
export function clampToBundledCeiling(
  extensionName: string,
  requested: ExtensionPermissions,
): { effective: ExtensionPermissions; clamped: boolean } {
  const ceiling = getCeiling(extensionName);
  if (!ceiling) {
    // Forensic chain: callers (e.g. installer paths) should NEVER drive
    // a non-bundled extension through this helper, but if they do we
    // log a debug line instead of silently nooping. No audit row —
    // the passthrough isn't a security event.
    log.debug("clampToBundledCeiling called for non-bundled name — passthrough", {
      extensionName,
    });
    return { effective: requested, clamped: false };
  }
  const effective = intersectPermissions(requested, ceiling);
  const clamped = !equalPermissions(effective, requested);
  return { effective, clamped };
}

/**
 * Deep-equal comparison for two `ExtensionPermissions` shapes.
 *
 * Used by `clampToBundledCeiling` to detect whether the intersection
 * narrowed the request. `JSON.stringify` is sufficient because the
 * field set is enumerable and small (no class instances, no functions,
 * no Date objects beyond the already-numeric `grantedAt`).
 *
 * Canonicalization sorts top-level keys and any string-array fields so
 * the comparator is robust to key-ordering and array-ordering churn.
 * Without sort, `{network: ["a","b"]} ≡ {network: ["b","a"]}` would
 * return `false` despite being semantically equal.
 */
function equalPermissions(
  a: ExtensionPermissions,
  b: ExtensionPermissions,
): boolean {
  return canonicalizePerms(a) === canonicalizePerms(b);
}

function canonicalizePerms(p: ExtensionPermissions): string {
  const ordered: Record<string, unknown> = {};
  // `as unknown` first because `ExtensionPermissions` has typed fields
  // that don't structurally overlap with `Record<string, unknown>`.
  const asRecord = p as unknown as Record<string, unknown>;
  const keys = Object.keys(asRecord).sort();

  // Boolean tiers are "granted" only when literally `true`. A grant
  // shape declaring `shell: false` is semantically identical to one
  // that omits `shell` entirely — both mean "not granted". Drop
  // false-valued booleans during canonicalization so the
  // post-intersect comparator doesn't flip the `clamped` flag for a
  // semantically-no-op shape difference. (Real bundled manifests
  // like file-refactor / log-analyzer / property-intelligence-agent
  // declare `shell: false` explicitly; their ceiling doesn't list
  // shell at all, and `intersectPermissions` returns
  // `shell: undefined`. Those two shapes ARE equal for ceiling
  // purposes.)
  const BOOL_FIELDS = new Set([
    "shell",
    "storage",
    "taskEvents",
    "acceptsCallerCaps",
    "escalateChildCaps",
  ]);

  for (const k of keys) {
    const v = asRecord[k];
    if (v === undefined) continue;
    if (BOOL_FIELDS.has(k) && v === false) continue;
    if (Array.isArray(v)) {
      // Empty arrays are treated as "not granted" — same equivalence
      // as empty object {} for grantedAt below.
      if (v.length === 0) continue;
      // Sort string arrays for order-independence; non-string arrays
      // (none exist on ExtensionPermissions today) pass through.
      const allStrings = v.every((x) => typeof x === "string");
      ordered[k] = allStrings ? [...v].sort() : v;
    } else if (v !== null && typeof v === "object") {
      // Sort nested object keys (spawnAgents, appendMessages, grantedAt).
      const inner: Record<string, unknown> = {};
      const innerKeys = Object.keys(v as Record<string, unknown>).sort();
      for (const ik of innerKeys) inner[ik] = (v as Record<string, unknown>)[ik];
      ordered[k] = inner;
    } else {
      ordered[k] = v;
    }
  }
  return JSON.stringify(ordered);
}
