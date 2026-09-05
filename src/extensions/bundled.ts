import type { ExtensionRegistry } from "./registry";
import type { ExtensionPermissions } from "./types";
import type { ExtensionProcess } from "./subprocess";
import { getExtensionByName } from "../db/queries/extensions";
import { logger } from "../logger";
const log = logger.child("extensions");

export {
  __resetProjectRootCacheForTests,
  getProjectRoot,
  resolveProjectRoot,
} from "./project-root";

export type {
  ProjectRootOverrides,
  ProjectRootResolution,
  ProjectRootSource,
} from "./project-root";

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
    // city-conditions — current time + weather + pollen for a city,
    // rendered by the `city-conditions` card, plus a shipped
    // `conditions.workflow.yaml` that performs the same aggregation as a
    // declarative graph (its `weather` / `air` steps share one parallel
    // batch).
    //
    // I/O is network plus per-user Storage. Network covers Open-Meteo,
    // Google Pollen, and the Atlanta NAB-certified station. Storage contains
    // only the Google key written encrypted by the manifest secret setting.
    // No filesystem, env, or shell; no credential-shaped env escape hatch.
    //
    // `workflows` is what makes the shipped asset TRIGGERABLE — shipping
    // a `*.workflow.yaml` is only an asset; firing it is the privileged
    // act. `maxRunsPerHour` is REQUIRED on the granted shape (unlike the
    // manifest declaration where it is optional) because
    // `intersectPermissions` takes `Math.min` over it; the matching
    // ceiling row carries the same 12 so the intersection is lossless.
    name: "city-conditions",
    path: "docs/extensions/examples/city-conditions",
    permissions: {
      storage: true,
      network: [
        "geocoding-api.open-meteo.com",
        "api.open-meteo.com",
        "air-quality-api.open-meteo.com",
        "pollen.googleapis.com",
        "www.atlantaallergy.com",
      ],
      workflows: { names: ["conditions"], maxRunsPerHour: 12 },
      grantedAt: {
        network: Date.now(),
        workflows: Date.now(),
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
    // The lessons distiller. Lives at the milestone-spec'd path
    // `extensions/<name>/` rather than the docs/examples or
    // packages/@ezcorp paths used by older bundled extensions. The
    // `getProjectRoot()`-relative join handles any in-repo path.
    //
    // This is the SOLE auto-distill path. Phase 53 Stage 1 briefly ran
    // it alongside a legacy host-side distiller under a parity test;
    // Stage 2 deleted both (`src/runtime/lessons/distiller.ts` and
    // `src/__tests__/distiller-port-parity.test.ts` no longer exist —
    // `src/runtime/lessons/` now holds only the shared `triggers.ts`
    // heuristics, called host-side via `runtime.lessons.triggerGate`).
    name: "lessons-distiller",
    path: "extensions/lessons-distiller",
    // Event-driven extension: the auto-distill path is a `run:complete`
    // subscription (it also ships one tool, `distill_now`, backing the
    // manual `!EZ:distill` action).
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
          google: ["gemini-2.5-flash-lite"],
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
      // `$USER` expands to the id of the user the call acts on behalf of
      // (`permissions.ts:expandGrantPrefix`). ONE subprocess serves every
      // user, and drafts live at `drafts/<userId>/<draftId>/` — granting
      // the whole `extension-author` tree left cross-user isolation
      // resting entirely on the extension VOLUNTARILY routing through the
      // host's owner-scoped `ezcorp/drafts.resolveDir`. Scoped to
      // `drafts/$USER`, the host denies a guessed path into another
      // user's drafts no matter what the extension does.
      grantedAt: {},
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
          google: ["gemini-2.5-flash-lite"],
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
  {
    // github-projects — connect a GitHub Projects v2 board to the active
    // project and plan/execute its tickets from a live Hub dashboard. All
    // GitHub I/O is HOST-SIDE (`src/extensions/github-projects-handler.ts`,
    // bundled-only via `BUNDLED_GITHUB_PROJECTS_ALLOWLIST`); the subprocess
    // only emits reverse-RPC intents + renders the Hub page, so its grant is
    // intentionally tiny: NO network / shell / env.
    //
    // `bootSpawn: true` keeps it resident so the daemon's
    // `github-projects:proposal-update` event + the Hub page-action buttons
    // reach the subprocess (same rationale as ping-loop). The 6 tools also
    // spawn it lazily on first chat use.
    //
    // The manifest declares `custom.githubProjects` as the reverse-RPC marker,
    // but the INSTALL grant intentionally OMITS it: `intersectPermissions`
    // (used by the ceiling clamp) only carries `custom.drafts` through, so a
    // `custom.githubProjects` grant would be silently dropped → a spurious
    // ceiling-clamp on every boot. The REAL gate is the bundled-only
    // `BUNDLED_GITHUB_PROJECTS_ALLOWLIST` (by name) in
    // `github-projects-handler.ts` — exactly like the bundled `ezcorp/drafts`
    // handler, whose allowlist (not the custom grant) is the gate. The
    // dashboard page is a manifest declaration, not a permission.
    //
    // Likewise `permissions.rbacScopes` (the `write-tickets` custom RBAC
    // scope) is a manifest DECLARATION, not a permission: grants live in
    // `extension_rbac_grants` and the `ezcorp/rbac-check` handler reads the
    // declaration from the REGISTRY manifest, never from this grant.
    // `intersectPermissions` drops it and `bundled-ceiling.ts`'s comparator
    // ignores it (inert pass-through), so mirroring it here would be dead
    // weight — same reasoning as `custom.githubProjects` above.
    name: "github-projects",
    path: "docs/extensions/examples/github-projects",
    bootSpawn: true,
    permissions: {
      eventSubscriptions: [
        "github-projects:approve",
        "github-projects:dismiss",
        "github-projects:rerun",
        "github-projects:pause",
        "github-projects:resume",
        "github-projects:refresh",
        "github-projects:poll-now",
        "github-projects:proposal-update",
        "task:assignment_update",
        "run:complete",
      ],
      storage: true,
      grantedAt: {
        eventSubscriptions: Date.now(),
        storage: Date.now(),
      },
    },
  },
  {
    // ez-factory — job console over the three workflow templates it ships
    // (Phase 8). Lives at `extensions/<name>/` like the other first-party
    // bundled extensions.
    //
    // BUNDLED SITING IS LOAD-BEARING, NOT A PREFERENCE. Its `write_file` /
    // `emit_artifact` tools (8.4) only authorize inside a workflow because
    // the sensitive-capability gate in `permission-engine.ts`
    // short-circuits to allow on `registry.isBundled(...) === true`
    // (`bundled-ceiling-auto-allow`). `fs.write` IS sensitive; for a
    // non-bundled extension the PDP returns `prompt`, and a workflow's
    // non-interactive scope rejects a prompt synchronously →
    // `WorkflowApprovalRequiredError` → the run terminalizes
    // `awaiting_approval`. Shipped under `docs/extensions/examples/` those
    // tools would be structurally unusable inside a workflow.
    //
    // Registering here is ALSO what activates `ensureEzFactoryAgents()` at
    // the bottom of this file: that seeder is gated on the `ez-factory`
    // extension row existing, so until this entry landed it was inert.
    //
    // `triggers` is the first such grant on any bundled extension. All
    // four fields are REQUIRED on the granted shape (`Math.min(NaN, …)`
    // otherwise) and `webhookPrefix` must match BOTH the manifest and the
    // `bundled-ceiling.ts` row byte for byte —
    // `intersectPermissions` DROPS the whole grant when a namespace claim
    // disagrees, silently, at boot.
    //
    // `workflows` is what makes the shipped `*.workflow.yaml` assets
    // TRIGGERABLE; `maxRunsPerHour` is required on the granted shape and
    // is this extension's only real spend bound.
    //
    // `workflows.allowDelegated` (phase 9) is what makes the `triggers`
    // grant above ACTIONABLE. A cron/webhook fire is ownerless, and
    // `ctx.workflows.run()` refuses an ownerless call at rung 7
    // (`WORKFLOWS_NO_OWNER`, -32106) — deliberately, because
    // `runWorkflow` scopes `workflow:*` SSE on `userId`. `runFor` is the
    // sanctioned route and this boolean is its opt-in; it authorizes no
    // job by itself (a `workflow_delegations` row a named human consented
    // to in a session-only route does that, and carries its own
    // `max_runs_per_day` / `max_tokens_per_run`).
    //
    // It fails in the SILENT direction if any of the three sides forgets
    // it: `intersectPermissions` folds it with `&&`, so an omitting
    // ceiling row makes `undefined && true` falsy and delegation is
    // quietly denied. Manifest, this grant, and the `bundled-ceiling.ts`
    // row must all say `allowDelegated: true`.
    //
    // No `bootSpawn`: the entrypoint arrives in 8.6, and even then the
    // console is user-driven (page render + page actions), not
    // event-subscription-only — the case `bootSpawn` exists for.
    name: "ez-factory",
    path: "extensions/ez-factory",
    permissions: {
      storage: true,
      triggers: {
        maxCron: 25,
        maxWebhooks: 25,
        webhookPrefix: "factory-",
        maxRunsPerDay: 500,
      },
      workflows: {
        names: ["docs-factory", "etl-factory", "draft-and-verify"],
        maxRunsPerHour: 60,
        allowDelegated: true,
      },
      filesystem: ["$CWD"],
      // The console's TWO Hub page actions — `job-save` (write a job) and
      // `job-run` (fire one). NOT platform-event subscriptions: a
      // `workflow:*` event can never reach an extension (no
      // `conversationId` on `WorkflowRun`), which is why none is declared.
      // These names travel a different path entirely, and this is the
      // grant `hub-render-pull.ts` reads as `allowedEvents`: a name
      // missing here means `validatePageTree` DELETES that control from
      // the tree and the events route 404s the click. Must stay byte-equal
      // to the manifest and the `bundled-ceiling.ts` row.
      //
      // `job-run` widens NOTHING. Firing is authorized by the `workflows`
      // grant above, unchanged; this only lets the console dispatch an
      // action the host then puts through the same ladder as every other
      // trigger.
      eventSubscriptions: ["ez-factory:job-save", "ez-factory:job-run"],
      grantedAt: {
        storage: Date.now(),
        triggers: Date.now(),
        workflows: Date.now(),
        filesystem: Date.now(),
        eventSubscriptions: Date.now(),
      },
    },
  },
];

const DISABLE_FLAGS: Readonly<Record<string, string>> = {
  "ai-kit": "EZCORP_DISABLE_AI_KIT",
};

export function resolveBundledExtensions(
  env: NodeJS.ProcessEnv = process.env,
): BundledExtension[] {
  return BUNDLED_EXTENSIONS.filter((entry) => {
    const flag = DISABLE_FLAGS[entry.name];
    return !flag || env[flag] !== "1";
  });
}

export function getCriticalBundledExtensions(): Array<{
  name: string;
  path: string;
}> {
  return BUNDLED_EXTENSIONS.filter((e) => e.critical === true).map((e) => ({
    name: e.name,
    path: e.path,
  }));
}

export function isCriticalBundledExtensionName(name: string): boolean {
  return BUNDLED_EXTENSIONS.some((e) => e.name === name && e.critical === true);
}

export function getBundledExtensionPath(name: string): string | null {
  return BUNDLED_EXTENSIONS.find((e) => e.name === name)?.path ?? null;
}

const BUNDLED_EXTENSION_NAMES: ReadonlySet<string> = new Set(
  BUNDLED_EXTENSIONS.map((e) => e.name),
);

export function isBundledExtensionName(name: string): boolean {
  return BUNDLED_EXTENSION_NAMES.has(name);
}

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

export async function ensureBundledExtensions(): Promise<void> {
  const { stageBundledExtensionSources } = await import("./bundled-bootstrap");
  await stageBundledExtensionSources(resolveBundledExtensions());
}
