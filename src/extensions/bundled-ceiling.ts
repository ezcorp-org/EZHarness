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
 *
 * ── THE FULL-FIELD-SET RULE (read before adding a row) ──
 *
 * `intersectPermissions` takes `Math.min` over every numeric on a
 * structured permission. A ceiling row that lists a structured permission
 * but OMITS one of its numerics produces `Math.min(NaN, …) === NaN` and
 * silently kills the grant at boot. The two structured permissions this
 * bites on today:
 *
 *   • `schedule` — see the SCHEDULE TRAP note on the `ez-code` row below.
 *     All five fields (`crons`, `maxRunsPerDay`, `maxRunDurationMs`,
 *     `missedRunPolicy`, `maxRetries`) are required by the granted type.
 *   • `workflows` (W2) — `{names, maxRunsPerHour, allowDelegated?}`.
 *     `maxRunsPerHour` is REQUIRED on `ExtensionPermissions["workflows"]`
 *     (deliberately, unlike the manifest declaration where it is optional),
 *     so TypeScript refuses a half-written row here. The runtime invariant
 *     is asserted too, in case the type is ever loosened — see
 *     `describe("bundled ceiling — the full-field-set invariant")` in
 *     `src/__tests__/workflows-permission.test.ts`.
 *
 *     `allowDelegated` (C3) is the ONE field on a structured permission
 *     that is deliberately OPTIONAL here, and it is safe to omit for a
 *     reason that does not generalize: `intersectPermissions` folds it
 *     with `&&`, not `Math.min`. `undefined && x` is falsy, not `NaN`, so
 *     an omitted ceiling field DENIES delegation rather than nuking the
 *     whole grant — the correct failure direction, and the opposite of
 *     what omitting a numeric does. The cost is that omission is SILENT:
 *     a row that should permit delegation must say `allowDelegated: true`
 *     explicitly, and TypeScript will not remind you. Same class of trap
 *     as `webhookPrefix` below. `ez-factory` is the FIRST and only
 *     bundled row to declare it — see that row for the security argument,
 *     and `src/__tests__/ez-factory-bundled-install.test.ts` for the
 *     negative control that proves an omitting ceiling denies.
 *   • `triggers` (C2) — `{maxCron, maxWebhooks, webhookPrefix,
 *     maxRunsPerDay}`. All four are REQUIRED on
 *     `ExtensionPermissions["triggers"]` for exactly this reason. Note the
 *     extra rule beyond the numerics: `intersectPermissions` DROPS the
 *     grant when the two sides' `webhookPrefix` disagree, because a
 *     namespace claim has no meaningful "narrower of the two". A ceiling
 *     row must therefore repeat the extension's own manifest prefix
 *     verbatim, or the extension silently loses dynamic triggers at boot.
 *     `ez-factory` is the FIRST and only bundled extension to declare
 *     `triggers`; `src/__tests__/ez-factory-bundled-install.test.ts`
 *     proves its grant actually survives `intersectPermissions` (a test
 *     that only checked the row exists would pass on a mismatched prefix).
 *
 * `permissions.rbacScopes` (extension-RBAC custom-scope DECLARATIONS) is
 * deliberately ABSENT from every ceiling row AND ignored by the clamp
 * comparator: declarations are inert — they only name per-extension
 * scopes an admin can grant (`extension_rbac_grants`) and extension code
 * can query via `ctx.rbac.check`; holding one always requires an
 * explicit grant row. `intersectPermissions` drops them from every
 * intersection (grants never carry declarations), so without the
 * comparator exclusion a manifest-shaped request (e.g. the
 * drift-reapprove heal, which clamps the raw disk `permissions` block)
 * would read as `clamped: true` on every call — spurious
 * ceiling-clamp audit noise for a field that grants no privilege.
 *
 * That exclusion is a CEILING-comparator rule, not a property of the
 * canonicalizer: a DIFF comparator (`diffGrants` in
 * `bundled-drift-reapprove.ts`) renders an admin-facing "what changed in
 * this release" screen, where a renamed or newly declared scope is
 * information the reviewer must see. Those callers pass
 * `canonicalizePerms(…, { includeRbacScopes: true })` — see that option's
 * doc below.
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

  // Web search — now a THIN SHIM over the host `ctx.search` capability
  // (shared-search Phase 1). The provider chain, the SSRF egress guard,
  // and the shared cache all moved HOST-SIDE (src/search/), so the
  // extension no longer owns any network hosts, provider-key env vars, or
  // filesystem grant — the ceiling is just `search: "inherit"` (the full
  // grant). `"inherit"` tracks the instance search defaults; the ceiling
  // entry keeps the `search` grant from being dropped by the install-time
  // `intersectPermissions` clamp.
  "web-search": {
    search: "inherit",
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

  // city-conditions — Open-Meteo weather/fallback pollen, optional Google
  // Pollen UPI, and the Atlanta NAB station behind one chat tool and three
  // granular tools, plus a shipped `conditions` workflow. Mirrors the install
  // grant in `bundled.ts` VERBATIM. Network is restricted to those five hosts;
  // Storage holds the encrypted per-user Google key. NO filesystem/env/shell.
  //
  // FULL-FIELD-SET RULE (see the module header): `workflows` is a
  // structured permission and `intersectPermissions` does
  // `Math.min(a.maxRunsPerHour, b.maxRunsPerHour)`. Omitting
  // `maxRunsPerHour` here would produce `Math.min(NaN, …)` and silently
  // kill the grant at boot, so it carries the same 12 as the grant.
  "city-conditions": {
    storage: true,
    network: [
      "geocoding-api.open-meteo.com",
      "api.open-meteo.com",
      "air-quality-api.open-meteo.com",
      "pollen.googleapis.com",
      "www.atlantaallergy.com",
    ],
    workflows: { names: ["conditions"], maxRunsPerHour: 12 },
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
    filesystem: ["$CWD/.ezcorp/extension-data/extension-author/drafts/$USER"],
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

  // file-organizer — 100%-local file organization. The watcher is a
  // HOST-SIDE daemon (src/extensions/file-organizer-daemon.ts) and
  // Accept/Reject apply HOST-SIDE in the events route, so the SUBPROCESS
  // grant is intentionally tiny: filesystem `$CWD` (its own data dir)
  // plus the full Hub page-action eventSubscriptions list. NO `network`
  // (enforces "no calls home" by construction), NO `shell`, NO
  // `schedule` grant (the daemon is host-wired, not cron-driven), and
  // `storage:false` (state is file-based so the host daemon can read it).
  // Mirrors the install grant in `bundled.ts` VERBATIM. Any widening is
  // a deliberate, reviewed PR.
  "file-organizer": {
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
    grantedAt: {},
  },

  // ping-loop — watchable, LLM-free Loop SDK demo. Mirrors the minimal
  // install grant in `bundled.ts`: storage (the run store), filesystem
  // `$CWD` (the artifact mirror under .ezcorp/extension-data/ping/), and
  // the single `ping-loop:run` page-action eventSubscription (Hub
  // page-action events are extension-name-prefixed). The dashboard page
  // is a manifest declaration, not a permission, so it has no ceiling
  // row. No network/shell/llm by construction.
  "ping-loop": {
    storage: true,
    filesystem: ["$CWD"],
    eventSubscriptions: ["ping-loop:run"],
    grantedAt: {},
  },

  // github-projects — board control plane. Mirrors the install grant in
  // `bundled.ts` VERBATIM: storage + the `github-projects:*` page-action +
  // proposal-update events plus `task:assignment_update` / `run:complete` for
  // live refresh. NO network / shell / env (all GitHub I/O is host-side). The
  // manifest's `custom.githubProjects` marker is intentionally NOT mirrored
  // here (nor in the install grant) — `intersectPermissions` only carries
  // `custom.drafts` through the clamp, so listing it would force a spurious
  // ceiling-clamp every boot. The reverse-RPC gate is the bundled-only
  // `BUNDLED_GITHUB_PROJECTS_ALLOWLIST` (by name) in
  // `github-projects-handler.ts`, exactly like the bundled `ezcorp/drafts`
  // handler. The dashboard page is a manifest declaration, not a permission.
  "github-projects": {
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

  // ez-factory — job console over the three workflow templates it ships.
  // Mirrors the install grant in `bundled.ts` VERBATIM.
  //
  // FIRST BUNDLED ROW TO CARRY `triggers` — the path documented in the
  // module header but never exercised until now. Two ways this row kills
  // the grant SILENTLY at boot if edited carelessly:
  //
  //   1. Drop any one of the four numerics and `intersectPermissions`
  //      computes `Math.min(NaN, …) === NaN`. The granted type makes all
  //      four required, so TypeScript catches this one.
  //   2. Change `webhookPrefix` by a single byte and `intersectPermissions`
  //      DROPS the entire `triggers` grant — a namespace claim has no
  //      "narrower of the two", so disagreement means no grant rather than
  //      a winner. TypeScript cannot catch this; `factory-` must match
  //      `extensions/ez-factory/ezcorp.config.ts` exactly, and
  //      `src/__tests__/ez-factory-bundled-install.test.ts` asserts the byte match
  //      AND that the grant survives the intersection.
  //
  // `workflows` follows the same FULL-FIELD-SET RULE as city-conditions:
  // `maxRunsPerHour` carries the same 60 as the grant so the intersection
  // is lossless. It is also the extension's only real spend bound — the
  // `llm` permission does NOT bound workflow agent-step spend (those go
  // `runAgent` → `createPiLlmAdapter` and never consult the grant), which
  // is why there is no `llm` row here and none in the manifest.
  //
  // ── RAISING THE CEILING: `workflows.allowDelegated` (phase 9) ───────
  //
  // FIRST BUNDLED ROW TO PERMIT DELEGATION, and it is a deliberate raise
  // of this extension's bound, not bookkeeping. What it admits is
  // `ctx.workflows.runFor(jobRef)` — firing on behalf of a human who
  // minted a `workflow_delegations` row.
  //
  // Why this is the NARROW option rather than the wide one. The
  // extension declares `triggers` (dynamic cron + webhook) two fields up.
  // A trigger fire is ownerless by construction, and `ctx.workflows
  // .run()` is refused for an ownerless call at rung 7
  // (`WORKFLOWS_NO_OWNER`, -32106) because `WorkflowExecutor.runWorkflow`
  // scopes `workflow:*` SSE on `userId` and is fail-closed without one.
  // That refusal stands and must not be weakened. So the ceiling's real
  // choice was never "delegation or nothing"; it was "delegation, or a
  // `triggers` grant that can never act". A permitted-but-unactionable
  // capability is the worse bound: it looks enforced and is untested.
  //
  // What the raise actually buys an attacker who compromises the
  // manifest — the threat this whole file is shaped against — is
  // NOTHING on its own:
  //
  //   · The boolean mints exactly one capability,
  //     `{kind:"ezcorp:workflows:run-delegated"}` (`capability-types.ts`),
  //     and authorizes no job. Firing still needs a `workflow_delegations`
  //     row, which only a SESSION-authenticated human can mint
  //     (`web/src/routes/api/workflows/delegations/+server.ts` —
  //     `requireSessionAuth`, no API key), which is per-workflow, pinned
  //     to a re-derived capability-set hash, revocable, and carries its
  //     own `max_tokens_per_run` + `max_runs_per_day`.
  //   · Reach is fail-closed independently of this row:
  //     `delegationPrincipal` carries `NO_PROJECT_MEMBERSHIPS`
  //     (`src/runtime/workflow-scope.ts`), so a delegated fire resolves
  //     `system`-visibility workflows ONLY. A fork of a shipped template
  //     is `project`-visibility and stays unreachable.
  //   · The extension's own `workflows.names` list is UNCHANGED, and the
  //     hourly bound is UNCHANGED at 60.
  //
  // THE TRAP, and it is the silent-denial direction rather than the
  // silent-widening one: `intersectPermissions` folds this field with
  // `&&`, not `Math.min`. Deleting it HERE while the manifest and install
  // grant keep it yields `undefined && true` → falsy → the flag is
  // dropped, `runFor` refuses, and every unattended job stops firing with
  // no error anywhere. TypeScript will not catch it (optional field).
  // `src/__tests__/ez-factory-bundled-install.test.ts` does, with a
  // negative control that deletes it from a copy of this row.
  //
  // NO `shell` / `network` / `env` / `llm`. The filesystem grant is `$CWD`
  // only — never `$USER`, which collapses to a NUL-bearing sentinel
  // matching nothing when there is no acting user to partition by, and
  // workflow tool steps run under a synthetic `workflow-run:<uuid>` key
  // that has none.
  //
  // `eventSubscriptions` carries exactly TWO names, and both are HUB PAGE
  // ACTIONS, not platform events: the ceiling for the console's Save and
  // its Run. `intersectPermissions` intersects this list with the install
  // grant, so a name missing HERE is dropped from the grant,
  // `allowedEvents` loses it, and `validatePageTree` deletes that control
  // from the rendered tree — a console that looks finished and cannot be
  // written to, or one whose Run button silently is not there. No
  // `workflow:*` name appears here or in the manifest: those are accepted
  // at registration and then never fire, because `WorkflowRun` has no
  // `conversationId` for the dispatcher to route on.
  //
  // `job-run` raises no ceiling. What it permits is DISPATCHING an action
  // whose effect is `ctx.workflows.run()`, and the ceiling for THAT is the
  // `workflows` row above — three named workflows, 60 runs an hour —
  // which is unchanged.
  //
  // `permissions.rbacScopes` (manage-jobs / run-job / approve-gate) is
  // deliberately absent, like every other row: declarations are inert and
  // the clamp comparator ignores them (see the module header).
  "ez-factory": {
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
    eventSubscriptions: ["ez-factory:job-save", "ez-factory:job-run"],
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

/** Per-caller knobs for `canonicalizePerms`. Type-only: erased at
 *  runtime, so it carries no instrumentable lines. */
export interface CanonicalizePermsOptions {
  /**
   * Keep `permissions.rbacScopes` in the canonical form instead of
   * dropping it. Default (unset/false) is the CEILING-comparator
   * behavior — see the module header for why an inert declaration must
   * not flip `clamped`. DIFF comparators opt IN so a renamed or newly
   * declared scope still reaches the admin's re-approval screen.
   */
  includeRbacScopes?: boolean;
}

/**
 * Canonical string form of a grant shape. Exported so every permission
 * comparator canonicalizes identically and none of them can drift apart:
 * `equalPermissions` below, and `diffGrants` in
 * `bundled-drift-reapprove.ts` — see that module's `diffGrants` doc for
 * the bug a second, diverging canonicalizer caused (an array-order-only
 * manifest change reported as a phantom permission diff).
 *
 * ORDER NEVER MEANS ANYTHING here. Top-level keys are sorted, nested
 * object keys are sorted, string arrays are sorted, and arrays that
 * aren't all strings are sorted by a stable serialization of each
 * element (whose own keys are sorted first). So a release that only
 * reshuffles a list is byte-identical to its predecessor.
 *
 * `rbacScopes` is the ONE field whose treatment depends on the caller,
 * via `opts.includeRbacScopes`:
 *
 *   • CEILING callers (the default) SKIP it. `intersectPermissions`
 *     never carries declarations into a grant, so counting them would
 *     flip `clamped` to `true` for every manifest-shaped request that
 *     declares scopes — audit noise for a field that grants nothing.
 *   • DIFF callers OPT IN. Suppressing the field there hides a
 *     security-review fact (a scope renamed `read` → `admin`, or added
 *     from nothing) on the screen an admin reads before re-approving.
 */
export function canonicalizePerms(
  p: ExtensionPermissions,
  opts?: CanonicalizePermsOptions,
): string {
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
    "loopEvents",
    "acceptsCallerCaps",
    "escalateChildCaps",
  ]);

  for (const k of keys) {
    const v = asRecord[k];
    if (v === undefined) continue;
    // `rbacScopes` — inert manifest DECLARATIONS (custom RBAC scope names
    // + descriptions for the grant UI / ctx.rbac.check), NOT privileges.
    // `intersectPermissions` never carries them into the intersection, so
    // counting them here would flip `clamped` to true for every
    // manifest-shaped request that declares scopes (see module doc). Diff
    // comparators opt back in — the field is information, just not a
    // privilege.
    if (k === "rbacScopes" && !opts?.includeRbacScopes) continue;
    if (BOOL_FIELDS.has(k) && v === false) continue;
    if (Array.isArray(v)) {
      // Empty arrays are treated as "not granted" — same equivalence
      // as empty object {} for grantedAt below.
      if (v.length === 0) continue;
      // Sort string arrays for order-independence. Arrays that aren't
      // all strings (today only `rbacScopes`, an array of objects) get
      // the same order-independence from a stable serialization sort —
      // otherwise re-listing the same scopes in a new order would read
      // as a change, which is the exact phantom-diff bug the shared
      // canonicalizer exists to prevent, just on another field.
      const allStrings = v.every((x) => typeof x === "string");
      ordered[k] = allStrings ? [...v].sort() : canonicalizeUnsortedArray(v);
    } else if (v !== null && typeof v === "object") {
      // Sort nested object keys (spawnAgents, appendMessages, grantedAt).
      ordered[k] = sortObjectKeys(v as Record<string, unknown>);
    } else {
      ordered[k] = v;
    }
  }
  return JSON.stringify(ordered);
}

/** One plain object with its keys in sorted order. Shared by the nested
 *  object branch and the object-array branch above so both canonicalize
 *  a `{…}` identically. */
function sortObjectKeys(o: Record<string, unknown>): Record<string, unknown> {
  const inner: Record<string, unknown> = {};
  for (const ik of Object.keys(o).sort()) inner[ik] = o[ik];
  return inner;
}

/** Canonicalize ONE element of a non-string array: objects get their keys
 *  sorted (so per-key order is not a difference either); anything else —
 *  a primitive, `null`, a nested array from an unvalidated stored jsonb
 *  blob — is left alone. */
function canonicalizeArrayElement(el: unknown): unknown {
  if (el !== null && typeof el === "object" && !Array.isArray(el)) {
    return sortObjectKeys(el as Record<string, unknown>);
  }
  return el;
}

/** Order-independent form of an array whose elements aren't all strings
 *  (today only `rbacScopes`: `Array<{name, description}>`). Elements are
 *  canonicalized, then sorted by their own serialization — the object
 *  analogue of the `[...v].sort()` string arrays already get. */
function canonicalizeUnsortedArray(v: unknown[]): unknown[] {
  const keyed = v.map((el) => {
    const norm = canonicalizeArrayElement(el);
    // Wrapped in a one-element array because `JSON.stringify(undefined)`
    // is `undefined`, not a string — this keeps every sort key comparable.
    return { key: JSON.stringify([norm]), norm };
  });
  keyed.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  return keyed.map((e) => e.norm);
}
