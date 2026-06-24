# Bundled Extension Catalog

> _The 24 first-party extensions EZCorp auto-installs on first boot — the default tool/agent/canvas surface that ships in-repo, gated by a hardcoded per-extension capability ceiling._

## Intent

EZCorp's extension ecosystem is the primary way the platform grows new tools, agents, Hub pages, and canvas cards. A fixed set of **first-party** extensions ships inside the repository and is auto-installed the first time the host boots, so a fresh install already has scratchpad memory, task planning, human-in-the-loop, web search, image generation, memory/lessons extraction, the ez-code coding control plane, and more — without a user manually installing anything. The catalog is the authoritative wired list (`BUNDLED_EXTENSIONS` in `src/extensions/bundled.ts`), distinct from the larger set of **example** extensions that merely live on disk under `docs/extensions/examples/` and from **test fixtures**. Each bundled entry is install-clamped to a hardcoded capability ceiling so a compromised manifest cannot widen its own grant beyond what was code-reviewed.

## How it works

### Boot sequence (`web/src/lib/server/context.ts`)

1. On host context init, `ensureBundledExtensions()` (`src/extensions/bundled.ts`) iterates `resolveBundledExtensions()` — `BUNDLED_EXTENSIONS` minus any entry whose opt-out env flag is set (only `ai-kit` has one today).
2. For each entry: if no DB row exists, it resolves the on-disk path (`getProjectRoot()` + `entry.path`), **clamps the requested grant to the bundled ceiling** (`clampToBundledCeiling`, `src/extensions/bundled-ceiling.ts`), and `installFromLocal(...)` with `isBundled: true` (+ the entry's `envEscapeHatch` flag for the `*_API_KEY` install gate). The clamped grant is what's persisted; a clamp writes an audit row.
3. If a row already exists, it runs the upgrade/heal pipeline: **S6 manifest-drift** detection (fail-closed on `network`/`filesystem`/`shell`/`env`/`storage`/`lifecycleHooks`; **auto-heal** for `eventSubscriptions` + `appendMessages`), **S9 version-bump re-approval** gate (disable-pending-reapproval unless `critical` and within ceiling), `manifest.lock.json` **tamper** verification, manifest refresh from disk (preserving the stored permissions block), and a **grant self-heal** that backfills the stored grant toward the declared-within-ceiling set.
4. `registry.loadFromDb()` then makes the installed extensions live.
5. Later in the same init, `bootSpawnFlaggedBundledExtensions(registry, wireRpc)` spawns the subprocess for every `bootSpawn: true` entry. This is required for **event-only** extensions (`lessons-distiller`, `memory-extractor`) whose only entrypoint is an event subscription — without a running subprocess, `EventSubscriptionDispatcher.dispatch` silently drops `run:complete` because `getProcessIfRunning` never starts one. Boot-spawn failures are logged + swallowed so a flaky extension cannot brick startup.
6. The seed/admin path (`src/db/seed-marketplace.ts`) additionally calls `assertCriticalExtensions()` (`src/startup/assert-critical-extensions.ts`), the startup invariant that every `critical` bundled extension is `enabled=true`.

### Entry flags (`BundledExtension` interface)

- **`critical`** — loop-safety floor. The entry is an agent loop-escape primitive; a version bump that stays within ceiling **auto-reapproves** (stays enabled) instead of disabling pending re-approval. Set on **`task-tracking`**, **`ask-user`**, **`extension-author`**. (The harness-smoke-test incident trapped an agent precisely because `ask-user` was auto-disabled at boot.)
- **`bootSpawn`** — host spawns the subprocess at boot. Set on **`lessons-distiller`**, **`memory-extractor`** (event-only, no tools / no manual triggers). Most bundled extensions spawn **lazily** on first tool invocation / event dispatch and must NOT set this.
- **`envEscapeHatch`** — v1.4 transitional opt-in allowing credential-shaped env grants (`*_API_KEY|TOKEN|SECRET`) past the hard install gate. Set on **`ai-kit`** (host-internal `EZCORP_API_KEY`) and **`openai-image-gen-2`** (BYOK `OPENAI_API_KEY` / `OPENAI_ACCESS_TOKEN`). Grep `envEscapeHatch` when the v1.5+ `ctx.secrets` migration lands. (`web-search` previously had it; it is now a thin shim with no env grant.)

### The capability ceiling (`src/extensions/bundled-ceiling.ts`)

`BUNDLED_CEILING` is a hardcoded max-grant table keyed by extension name. It is a **code-review-time** artifact, NOT derived from `manifest.permissions`, so a compromised manifest cannot generate a self-matching ceiling. `clampToBundledCeiling(name, requested)` returns `intersectPermissions(requested, ceiling)` — install grants can only ever be **narrowed**. Numeric caps (`spawnAgents.maxPerHour/maxConcurrent`, schedule fields) clamp via `Math.min`; the `schedule` shape must carry all five fields on both sides or the `Math.min` intersection yields `NaN` and silently breaks the cron grant (the documented "schedule trap"). The ceiling composes with `manifest.lock.json` (tool-list / entrypoint / version drift). For non-bundled names `getCeiling` returns `null` and the clamp is a passthrough.

### The 24 bundled extensions

| Name | Path | One-line purpose | Flags / notable grant |
|---|---|---|---|
| `scratchpad` | `docs/extensions/examples/scratchpad` | Ephemeral conversation-scoped KV store (ex-builtin tool); auto-wired at depth-0 agent mention | `storage` only |
| `task-tracking` | `docs/extensions/examples/task-tracking` | Multi-task planning + sub-agent coordination; wire-on-first-use | `critical`; `storage`, `taskEvents`, `spawnAgents` 200/10 |
| `orchestration` | `docs/extensions/examples/orchestration` | `invoke_agent` cross-conversation delegation primitives | `spawnAgents` 500/25 |
| `ask-user` | `docs/extensions/examples/ask-user` | Human-in-the-loop `ask_user_question`; auto-wired every turn | `critical` (THE escape hatch); `ask-user:answer` sub |
| `project-analyzer` | `docs/extensions/examples/project-analyzer` | Reads project files; postinstall may shell out | `filesystem:$CWD`, `shell` |
| `markdown-utils` | `docs/extensions/examples/markdown-utils` | Pure markdown helper tools + skill + agent | no runtime perms |
| `code-review-delegator` | `docs/extensions/examples/code-review-delegator` | Delegator that fans out to dependency extensions | no runtime perms |
| `github-stats` | `docs/extensions/examples/github-stats` | Read-only GitHub API stats | `network:api.github.com`, `env:GITHUB_TOKEN` |
| `multi-agent-orchestrator` | `docs/extensions/examples/multi-agent-orchestrator` | Forward-looking sub-agent orchestrator skeleton | no runtime perms |
| `research-agent` | `docs/extensions/examples/research-agent` | Pure-prompt research agent (agent-only manifest) | no runtime perms |
| `file-refactor` | `docs/extensions/examples/file-refactor` | File-rename previews with convention selection | `filesystem:$CWD`, **no shell** |
| `log-analyzer` | `docs/extensions/examples/log-analyzer` | Log search with level + date filters | `filesystem:$CWD`, **no shell** |
| `todo-tracker` | `docs/extensions/examples/todo-tracker` | Scan source for TODO/FIXME/HACK comments | `filesystem:$CWD`, `shell` |
| `ai-kit` | `packages/@ezcorp/ai-kit` | Bundled deputy that calls the EZCorp HTTP API (loopback) | `envEscapeHatch`; `network:localhost/127.0.0.1`, `env:EZCORP_*` |
| `web-search` | `docs/extensions/examples/web-search` | Thin shim over the host `ctx.search` capability | `search:"inherit"` only (provider chain is host-side) |
| `openai-image-gen-2` | `docs/extensions/examples/openai-image-gen-2` | OpenAI-only image generation (`gpt-image-*`) | `envEscapeHatch`; `network:api.openai.com`+`chatgpt.com`, `env:OPENAI_*`, `filesystem:$CWD` |
| `claude-design` | `docs/extensions/examples/claude-design` | Extracts a design system + generates HTML drafts; canvas knob round-trip | `filesystem:$CWD`, `storage`, knob-change subs, `cdn.jsdelivr.net` |
| `price-chart` | `docs/extensions/examples/price-chart` | Client-rendered price chart (Yahoo Finance / CoinGecko) | `network` data hosts; no fs in `bundled.ts` |
| `kokoro-tts` | `docs/extensions/examples/kokoro-tts` | In-browser Kokoro-TTS via `messageToolbar` + append-message reverse-RPC | `appendMessages` (excluded), `kokoro-tts:*` subs |
| `lessons-distiller` | `extensions/lessons-distiller` | Distills lessons from completed runs (bundled port) | `bootSpawn`; `llm`, `lessons:write`, `run:complete` sub |
| `extension-author` | `docs/extensions/examples/extension-author` | LLM scaffolds new extensions on request (drafts reverse-RPC) | `critical`; `custom.drafts`, `filesystem` (own data dir) |
| `memory-extractor` | `extensions/memory-extractor` | Auto-extracts persistent memory from runs (bundled port) | `bootSpawn`; `llm`, `memory:write` (`selfOnly:false`), cron `0 */6 * * *` |
| `ez-code` | `docs/extensions/examples/ez-code` | Warren-style control plane for ephemeral coding-agent runs (dispatch/list/steer/cancel/open_pr) + Hub dashboard | `spawnAgents` 30/6, `shell`, `filesystem:$CWD`, `network:api.github.com`, cron |
| `file-organizer` | `docs/extensions/examples/file-organizer` | 100%-local file organization; host-side watcher daemon + Hub pages | `filesystem:$CWD`, large event-sub list; **no network/shell/schedule** |

> `critical`: task-tracking, ask-user, extension-author. `bootSpawn`: lessons-distiller, memory-extractor. `envEscapeHatch`: ai-kit, openai-image-gen-2.

### Examples on disk but NOT bundled (example-only)

These live under `docs/extensions/examples/` (or are referenced by the ceiling/legacy paths) but are **not** in `BUNDLED_EXTENSIONS`, so they are not installed at boot. Don't conflate "example on disk" with "bundled":

- `auto-note` — quick-note → auto-organized linked vault
- `cash-recovery-agent`, `property-intelligence-agent` — domain demo agents (local, fs-only)
- `code-quality` — static quality analysis; cross-extension composition + preuninstall demo
- `cron-dashboard` — scheduled-run history demo for a heartbeat cron
- `excel` — in-process xlsx parser
- `sample-loop` — `defineLoop()` SDK reference loop
- `substack-pilot`, `substack-pipeline`, `substack-engagement` — Substack draft/pipeline demos (note: `substack-pilot` and `substack-pipeline` both appear in `BUNDLED_CEILING`, and only `substack-pilot` is named in the `legacyEntityMappings` branch — but all three are absent from the boot array)
- `task-stack` — 25-tool stack-based task manager
- `weather` — network-only API fetch + custom web-component card
- `harness-smoke-test`, `_harness` — smallest install/invoke smoke test + harness helpers

### Test fixtures (not features)

`test-agent-configs`, `test-event-subscriber`, `test-spawn-assignment`, `test-task-events` — integration-test extensions only.

## Usage

The catalog is a host concern, not a user-facing API surface — there is no "install bundled" route. It is exercised by:

- **Boot:** `ensureBundledExtensions()` + `bootSpawnFlaggedBundledExtensions()` run automatically in `web/src/lib/server/context.ts`; `assertCriticalExtensions()` runs in the seed/admin path.
- **Opt-out env var:** `EZCORP_DISABLE_AI_KIT=1` — the only entry in `DISABLE_FLAGS`. A disabled flag suppresses *fresh installs* only; it does not uninstall an existing row, and is ignored for `critical` checks, integrity-skip, and grant-healing.
- **Per-extension settings:** event-only ports map to a per-extension `enabled` setting (e.g. `global:lessonDistillerEnabled` and `global:memoryEnabled` are migrated into the bundled rows' settings on boot).
- **Admin drift heal:** `getBundledExtensionPath(name)` feeds the admin drift-reapproval flow so it loads the same on-disk manifest the boot path uses.
- **Manual local install** (for examples / dev): `ezcorp ext install ./docs/extensions/examples/<name>`.
- **Bundled credential injection:** `bootstrapBundledCredentials` (host-internal creds) and `wireOpenAIExtensionCredentials` (BYOK OpenAI) populate the subprocess env for the `envEscapeHatch` extensions.

Exported helpers from `src/extensions/bundled.ts`: `isBundledExtensionName(name)` (registry skips the integrity check for bundled names), `getCriticalBundledExtensions()`, `getBundledExtensionPath(name)`, `resolveBundledExtensions(env)`, `getProjectRoot()`.

## Key files

- `src/extensions/bundled.ts` — `BUNDLED_EXTENSIONS` array, `ensureBundledExtensions()`, drift/version/tamper/heal pipeline, `bootSpawnFlaggedBundledExtensions()`, `DISABLE_FLAGS`, `getProjectRoot()`.
- `src/extensions/bundled-ceiling.ts` — `BUNDLED_CEILING` table, `clampToBundledCeiling()`, `getCeiling()`, permission canonicalization.
- `src/extensions/bundled-lock.ts` — `manifest.lock.json` verification (`verifyManifestAgainstLock`, `canonicalizeAndHash`).
- `src/extensions/clamp-permissions.ts` — `checkEnvKeyLeakInstallGate` (`*_API_KEY` install gate; honors `envEscapeHatch` for bundled).
- `src/extensions/installer.ts` — `installFromLocal` (shared bundled + user install path).
- `src/startup/assert-critical-extensions.ts` — startup invariant: every `critical` extension stays `enabled=true`.
- `web/src/lib/server/context.ts` — boot wiring: `ensureBundledExtensions()` then `bootSpawnFlaggedBundledExtensions()`.
- `src/db/seed-marketplace.ts` — seed/admin path that also calls `assertCriticalExtensions()`.
- `src/extensions/ez-code-coder-agent.ts` — `ensureEzCodeCoderAgent()` seeds the system `ez-code` coder agent row.
- `src/extensions/file-organizer-daemon.ts` — host-side watcher daemon backing the `file-organizer` extension.
- `web/src/lib/server/security/bundled-creds.ts` — `bootstrapBundledCredentials` (host-internal loopback creds for `ai-kit`); called in `context.ts` before `ensureBundledExtensions`.
- `web/src/lib/server/security/openai-extension-creds.ts` — `wireOpenAIExtensionCredentials`, the per-spawn BYOK cred resolver for `openai-image-gen-2`.
- `docs/extensions/examples/` — on-disk source for most bundled + example extensions; `packages/@ezcorp/ai-kit`, `extensions/lessons-distiller`, `extensions/memory-extractor` hold the off-`examples` bundled entries.

## Features it touches

- [[marketplace]] — bundled install reuses `installFromLocal`/registry; `isBundledExtensionName` exempts these from the marketplace integrity check.
- [[permissions-and-grants]] — every bundled grant is install-clamped to `BUNDLED_CEILING`; drift/version/tamper gates govern upgrades.
- [[sandbox-and-isolation]] — each bundled extension runs in a sandboxed subprocess; `$CWD` filesystem grants are jailed.
- [[runtime-and-rpc]] — lazy vs `bootSpawn` subprocess lifecycle; reverse-RPC (`ezcorp/append-message`, `ezcorp/drafts`) for kokoro-tts / extension-author.
- [[scheduling-and-loops]] — `memory-extractor` and `ez-code` declare cron schedules; `lessons-distiller`/`memory-extractor` subscribe to `run:complete`.
- [[persistent-memory]] — `memory-extractor` is the bundled `run:complete` consumer that writes memories.
- [[lessons]] — `lessons-distiller` is the bundled lessons writer.
- [[web-search]] — `web-search` is the bundled thin shim over the host `ctx.search` capability.
- [[hub-pages]] — `ez-code` and `file-organizer` ship Extension Pages Hub dashboards.
- [[canvas-cards]] — `claude-design`, `price-chart`, `kokoro-tts` render custom canvas cards.
- [[message-toolbar]] — `kokoro-tts` contributes a speaker icon via the `messageToolbar` extension point.
- [[ask-user]] — the `ask-user` bundled extension owns the human-in-the-loop pause primitive.
- [[agents]] — `ez-code` seeds a system coder agent row; orchestration/task-tracking spawn sub-agents.
- [[audit-and-observability]] — install/clamp/drift/tamper/regrant events write extension audit rows.
- [[admin-surfaces]] — admin drift-reapproval re-enables disabled bundled rows via `getBundledExtensionPath`.
- [[overview-and-authoring]] — bundled extensions are the worked examples for authoring conventions.

## Related docs

- [Example Extensions README](../../extensions/examples/README.md) — learning path + feature matrix for the example set.
- [extensions/security.md](../../extensions/security.md) — the permission/ceiling/drift security model.
- [extensions/data-storage.md](../../extensions/data-storage.md) — the `.ezcorp/extension-data/<name>/` convention bundled extensions use.
- [extensions/manifest-schema.md](../../extensions/manifest-schema.md) — `ezcorp.config.ts` manifest shape.
- [extensions/loops.md](../../extensions/loops.md) — the `defineLoop()` SDK (`sample-loop` reference).

## Notes & gotchas

- **24 bundled, ~38 on disk.** `BUNDLED_EXTENSIONS` wires exactly 24 extensions at boot; `docs/extensions/examples/` holds many more example-only dirs plus `test-*`/`harness-smoke-test` fixtures. Read `bundled.ts` for the authoritative list — never infer it from the directory listing.
- **`substack-pilot` / `substack-pipeline` are NOT bundled.** Both appear in `BUNDLED_CEILING`, but only `substack-pilot` triggers the `legacyEntityMappings` rename branch in the install loop (`entry.name === "substack-pilot"`). Neither is in the boot array, so neither is installed — the ceiling entries are dormant.
- **Path roots differ.** Most entries are under `docs/extensions/examples/<name>`, but `ai-kit` lives at `packages/@ezcorp/ai-kit` and `lessons-distiller` / `memory-extractor` at `extensions/<name>`. `getProjectRoot()` joins whatever relative `entry.path` is declared — don't assume the examples dir.
- **`bootSpawn` is mandatory for event-only extensions.** Without it, `EventSubscriptionDispatcher.dispatch` silently drops every wired event because the subprocess never starts. Only set it for extensions with no tools, no agent mentions, and no manual trigger (currently just the two port extensions).
- **`critical` auto-reapproval can mask a tool-list change.** A `critical` entry whose tool list churns every boot (e.g. `extension-author` gaining `install_draft`) auto-reapproves within ceiling and `continue`s past the normal refresh — the critical branch must itself refresh the manifest + reconcile the grant, or the new tool stays invisible / the grant stays stale.
- **`memory-extractor` runs `selfOnly: false` intentionally** — cross-extension memory dedup must mediate every write regardless of authoring extension. Bundled-trust (code review) is the approval gate; this is the documented exception.
- **Bundled integrity-skip is name-based and sticky.** `isBundledExtensionName` skips the spawn-time checksum check for every bundled name because the files legitimately change with the repo. The opt-out flag does NOT remove a name from this set — disabling `ai-kit` after install keeps its integrity-skip semantics until it's uninstalled.
- **`eventSubscriptions` + `appendMessages` auto-heal; everything else fails closed.** On drift, network/fs/shell/env/storage/lifecycleHooks WARN and leave the DB grant untouched (fail-closed), but missing event subs / append-message config are union-merged in and audited — they're infrastructure plumbing, not safety boundaries.
- **The ceiling, not the manifest, is the security bound.** Even a compromised `ezcorp.config.ts` declaring wider permissions cannot exceed `BUNDLED_CEILING`. Every edit to `bundled-ceiling.ts` is a security-relevant, maintainer-reviewed change.
- **Default permission mode is `yolo`** (`src/runtime/tools/permissions.ts`) by intentional, permanent product decision — bundled-extension tool calls inherit it. This is not a finding.
