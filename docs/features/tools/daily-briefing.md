# Daily Briefing

> _An autonomous per-user agent that, on a cron schedule, mines the user's own recent conversations, memory, and open tasks — plus an optional web watchlist — into a short, actionable morning briefing conversation they can talk back to._

## Intent

Daily Briefing turns EZCorp from a reactive chat tool into a proactive one. Each morning (default 7am, per-user schedule + timezone) a system agent composes a short briefing — *unfinished business* from recent conversations, *open tasks*, and an optional *watchlist* of topics it researches with web search — and posts it as a normal conversation the user can reply to and resume work from. It exists so the user starts the day with context already gathered, and the briefing thread keeps full tool access for follow-up turns. Configuration is reachable everywhere it makes sense: a settings page, the `core:briefing` Hub page, an on-demand "Run now", and conversational tools (`configure_briefing`, `briefing_watch`, …) so "keep an eye on the Bun 2.0 release for me" lands in the watchlist mid-chat.

## How it works

### Scheduling — `BriefingDaemon` (claim-before-dispatch)

`src/runtime/briefing/daemon.ts` is a sibling of `ScheduleDaemon` (it borrows the patterns without touching that daemon's locked invariants):

1. Constructed once from `startBackgroundTimers()` (`src/startup/background-timers.ts`) — the module's `started` flag is the single-process guard, so there is **no PID lockfile**. Gated off by `EZCORP_DISABLE_BRIEFING_DAEMON=1` (strict literal `"1"`).
2. `start()` fires one **immediate boot tick** (offline catch-up — a host that slept through 7am fires once now), then a 60s wake interval (`unref`'d).
3. Each `tick()` calls `claimDueBriefingConfigs(now, capacity)` (`src/db/queries/briefing-configs.ts`): one transaction does `SELECT … FOR UPDATE SKIP LOCKED` over `enabled = true AND next_fire_at <= now`, then **advances `next_fire_at` to the next slot computed from `now`** before returning the rows. Advancing from `now` (not enumerating missed slots) *is* the hardcoded **fire-once** missed-run policy — three missed slots fire exactly once. A crash between commit and dispatch loses at most one fire and never double-fires.
4. **Concurrency cap: 3 host-wide.** The per-tick claim limit is `maxConcurrent - inFlight`, and dispatches are tracked (not awaited) so overlapping ticks see the live gauge — the cap bites across ticks. A `guardTimeoutMs` (per-fire timeout + 30s grace) releases a wedged slot; the pipeline's own per-fire timeout is the primary cancel path.
5. **Fail-safe:** when no briefing runtime is registered (backend-only boot, or a boot-ordering race) the tick is a logged no-op that does **not** claim — so nothing is consumed and no consecutive-errors accrue for an operational condition.
6. **Catch-up flag:** a claimed slot more than 60s in the past is flagged `catchUp`, threaded into the synthetic prompt so the agent can say "while you were away".

### The run pipeline — `runBriefingForUser`

`src/runtime/briefing/run.ts` orchestrates one user's briefing end-to-end and **never throws** (every failure folds into a `{ status }` so the caller's bookkeeping stays one code path):

1. **Resolve the target project** (`resolveBriefingProject`): configured `projectId` if it still exists → project of the user's most recently active conversation (excluding prior briefings) → `null` ⇒ `skipped`.
2. `ensureBriefingAgentConfig()` returns the **shared** "Daily Briefing" `agent_configs` row (one row serves every user; per-user steering rides on the conversation's `systemPrompt`).
3. **Phase 3 watchlist wiring:** `resolveBriefingWebSearch()` + `syncBriefingAgentWebSearch()` (`web-search.ts`) detect the `web-search` extension and keep the shared agent's extension references in sync so setup-tools loads its tools for this run. Both are fail-soft.
4. **Create the briefing conversation** with a per-run system prompt (`buildBriefingSystemPrompt`: base contract + date/tz + verbatim user instructions + a watchlist section, or a one-line "watchlist skipped" note when web search is unavailable). Title is `Daily Briefing — Wednesday, Jun 10` in the user's tz.
5. Persist a **synthetic user message** (`buildSyntheticPrompt`, prefixed `[Scheduled briefing — <ISO>]`) that re-embeds the section contract + watchlist so the agent doesn't depend on config-table access.
6. `executor.streamChat(...)` with **`toolRestriction: "read-only"`** (unattended runs get no edit/shell). When there are watchlist topics *and* web search is available, the run additionally vouches `webSearch.toolNames` via `readOnlyAllowedTools` so the read-safe search/fetch tools survive the filter.
7. `Promise.race` the run against a **5-min timeout**; on timeout `cancelRun(runId)`.
8. **Empty-failure hygiene (locked decision):** on error/timeout, or a "success" with no assistant content, the conversation is DELETE'd *only if* it has no preservable content — a mid-run real user reply is never deleted (`hasPreservableContent` ignores the synthetic message but keeps real user turns).
9. On success: emit `conversation:created` (`source: "briefing"`) + `briefing:delivered` on the bus (per-user, fail-closed SSE fan-out).

State bookkeeping (`recordBriefingFireResult`) is the **caller's** job (daemon tick / run-now), not the pipeline's.

### Completion bookkeeping & auto-disable

`recordBriefingFireResult` (`src/db/queries/briefing-configs.ts`) is one atomic UPDATE per status:

- `ok` → `last_fire_status='ok'`, `consecutive_errors` reset to 0.
- `skipped` → `last_fire_status='skipped'` (no resolvable project — not an error; counter unchanged).
- `error` → `consecutive_errors + 1`; at `BRIEFING_AUTO_DISABLE_AFTER = 5` consecutive errors the row auto-disables (`enabled=false`, `next_fire_at=NULL`) **in the same statement** (the CASE reads the pre-update value, so the increment and the disable agree under concurrent writers). On the disable transition the daemon (or run-now) posts a one-time "Daily Briefing disabled" conversation (`notifyBriefingAutoDisabled`) explaining how to re-enable. Re-enabling via the API resets the counter.

### Config + cron mapping

- `briefing_configs` (`src/db/schema.ts`) is keyed by `user_id` (PK, cascade): `enabled`, `cron` (default `0 7 * * *`), `timezone` (default `UTC`), nullable `projectId`/`model`/`provider`, `instructions`, `watchlist` (jsonb), and the daemon-owned fire bookkeeping + `next_fire_at` (THE claim target, NULL while disabled). Indexed `(enabled, next_fire_at)`.
- The settings UI never exposes raw cron: `web/src/lib/briefing-cron.ts` maps a time-of-day + weekday preset (`daily`/`weekdays`/`weekends`) to/from a 5-field cron. `parseBriefingCron` is **strict** — it only round-trips the exact `M H * * <preset>` shapes it writes; a hand-edited cron supplied through the API returns `null` and the UI shows the raw string read-only.
- `validateBriefingConfigInput` (`config-validation.ts`) is the shared validator (cron via `validateCron`, IANA tz via `Intl`, watchlist caps **≤25 topics / ≤200 chars**, instructions ≤10 000 chars, silent case-insensitive dedupe). `upsertBriefingConfig` recomputes `next_fire_at` from the merged cron/tz.

### The two tool groups (don't conflate them)

Both are wired per-turn from `src/runtime/stream-chat/setup-tools.ts`, but for disjoint conversations:

- **Briefing read tools** (`src/runtime/briefing/tools.ts`) — `list_recent_conversations`, `get_conversation_summary`, `get_task_snapshots` — wired for any conversation attached to the **Daily Briefing agent** (the scheduled run *and* the user's follow-up turns). Every read is ownership-gated to the briefing user (no existence oracle); `get_task_snapshots` degrades to "unavailable" if the task-tracking extension is absent.
- **Subscribe/config tools** (`src/runtime/briefing/chat-tools.ts`) — `briefing_watch`, `briefing_unwatch`, `configure_briefing`, `briefing_status` — wired into **normal** conversations only (`wireBriefingChatToolsIfEligible` explicitly returns early when the conversation *is* the briefing agent). The three config writers (`briefing_watch`/`briefing_unwatch`/`configure_briefing`) are category `write` (`briefing_status` is read-only); the gate already excludes the whole group from the scheduled run, and the read-only filter would strip the `write` ones besides.

The shared watchlist mutation primitive (`watchlist.ts` — `addWatchlistTopic` / `removeWatchlistTopic`) is the single framework-free write path; both the chat tools and the Hub page actions call it.

## Usage

### REST API

| Method & path | Scope | Purpose |
|---|---|---|
| `GET /api/briefing/config` | `read` | Current user's config; returns `BRIEFING_CONFIG_DEFAULTS` (no row minted) when never configured. Own-config only — no id param to traverse. |
| `PUT /api/briefing/config` | `chat` | Validate (`validateBriefingConfigInput`) + upsert. 400 on bad cron/tz/watchlist; 400 `"unknown project"` on a dangling `projectId` FK. |
| `POST /api/briefing/run-now` | `chat` | Trigger an immediate run for the session user. **202** `{ started: true }` (fire-and-forget); **503** if the runtime isn't registered yet; **429** (with `Retry-After`) when rate-limited. |

`POST /api/briefing/run-now` is rate-limited to **1 run / 5 minutes / user**, and the route + the Hub "Run now" action share **one** `RateLimiter` bucket (`web/src/lib/server/briefing-run-now.ts`) so a user can't double-dip by alternating surfaces. The `unavailable` check runs *before* the limiter so a 503 never burns the slot.

### UI entry points

- **Settings → Briefing** (`web/src/routes/(app)/settings/briefing/+page.svelte` → `BriefingSettings.svelte`): the canonical config surface (enable, time + days preset, timezone, project, instructions, watchlist, "Run now").
- **`core:briefing` Hub page** (`src/runtime/briefing/hub-page.ts`): status/kv/stats summary, watchlist table with confirm-gated per-row remove + an "Add to watchlist" prompt, recent briefings deep-linked into chat (`/project/<projectId>/chat/<conversationId>`), and a "Run now" button. Registered at boot next to the runtime.
- **`BriefingNudge.svelte`**: a one-time dismissible sidebar card linking to settings, fail-closed (only shown when the briefing is confirmed `enabled === false` and no config row exists yet).

### Conversational tools (in any normal chat)

- `configure_briefing(enabled?, time?, days?, timezone?, instructions?)` — plain-field config mapped to cron via the same `briefing-cron.ts` module the UI uses.
- `briefing_watch(topic)` / `briefing_unwatch(topic)` — add/remove a watchlist topic (case-insensitive; friendly no-ops).
- `briefing_status()` — read-only summary (schedule, last/next fire, watchlist, recent briefings).

### Env vars / settings

- `EZCORP_DISABLE_BRIEFING_DAEMON=1` — kill switch; the daemon is never constructed.

## Key files

- `src/runtime/briefing/daemon.ts` — `BriefingDaemon`: claim-before-dispatch, fire-once catch-up, 3-run cap, guard timeout, runtime fail-safe.
- `src/runtime/briefing/run.ts` — `runBriefingForUser` pipeline: project resolution, conversation + synthetic message creation, read-only `streamChat`, timeout + empty-failure hygiene, success events; `notifyBriefingAutoDisabled`.
- `src/runtime/briefing/watchlist.ts` — shared `addWatchlistTopic` / `removeWatchlistTopic` (the single framework-free mutation path).
- `src/runtime/briefing/web-search.ts` — `resolveBriefingWebSearch` (read-safe vouch via `READ_SAFE_TOOL_NAMES = {search-web, read-url}`) + `syncBriefingAgentWebSearch`.
- `src/runtime/briefing/config-validation.ts` — `validateBriefingConfigInput` (cron/tz/watchlist caps; normalizes + dedupes).
- `src/runtime/briefing/tools.ts` — the briefing agent's read tools (`list_recent_conversations`, `get_conversation_summary`, `get_task_snapshots`).
- `src/runtime/briefing/chat-tools.ts` — the subscribe/config tools wired into normal conversations.
- `src/runtime/briefing/agent-config.ts` — the shared "Daily Briefing" `agent_configs` row (`ensureBriefingAgentConfig`, `getBriefingAgentConfigId`).
- `src/runtime/briefing/hub-page.ts` — the `core:briefing` Hub page provider + its run-now/add/remove actions.
- `src/runtime/briefing/runtime-registry.ts` — register/read indirection so backend briefing code reaches the web-layer executor + SSE bus.
- `src/db/queries/briefing-configs.ts` — `upsertBriefingConfig`, `claimDueBriefingConfigs`, `recordBriefingFireResult`, `BRIEFING_AUTO_DISABLE_AFTER`, `BRIEFING_CONFIG_DEFAULTS`.
- `src/db/schema.ts` — `briefing_configs` table + `BriefingConfig` type.
- `web/src/lib/briefing-cron.ts` — pure cron ↔ (time, weekday-preset) mapping (`buildBriefingCron`, `parseBriefingCron`, `describeBriefingCron`, `formatRetrySeconds`).
- `web/src/lib/server/briefing-run-now.ts` — the shared run-now trigger + the single rate-limiter bucket.
- `web/src/routes/api/briefing/config/+server.ts` — GET/PUT config.
- `web/src/routes/api/briefing/run-now/+server.ts` — POST run-now (HTTP mapping over the shared trigger).
- `web/src/routes/(app)/settings/briefing/+page.svelte` — settings page route; `web/src/lib/components/settings/BriefingSettings.svelte` — the form.
- `web/src/lib/components/BriefingNudge.svelte` — one-time discoverability nudge.
- `src/startup/background-timers.ts` — boots/stops the daemon (`EZCORP_DISABLE_BRIEFING_DAEMON` gate).
- `web/src/lib/server/context.ts` — `registerBriefingRuntime` + `registerBriefingHubPage` + injects the run-now trigger at `ensureInitialized()`.
- `src/runtime/stream-chat/setup-tools.ts` — per-turn wiring of both tool groups (`wireBriefingChatToolsIfEligible`).

## Features it touches

- [[scheduling-and-loops]] — `BriefingDaemon` mirrors `ScheduleDaemon`'s claim-before-dispatch and reuses `parseCron`/`validateCron` from the cron module.
- [[conversations]] — a briefing is a normal owned conversation; delivery emits `conversation:created` (`source: "briefing"`) and follow-up turns go through the standard messages route.
- [[streaming-runtime]] — the pipeline drives `executor.streamChat` and awaits its terminal state with a timeout.
- [[runs-lifecycle]] — each run mints a `runId`; the 5-min timeout path calls `cancelRun`.
- [[web-search]] — the watchlist section is gated to an installed+enabled `web-search` extension via a read-safe vouch.
- [[permissions-and-grants]] — unattended runs are forced `toolRestriction: "read-only"`; only the read-safe search tools are vouched into the filter.
- [[builtin-file-tools]] — the read-only restriction is the same `tools/filter.ts` mechanism that gates the built-in file tools.
- [[agents]] — one shared "Daily Briefing" `agent_configs` row drives every user's run; per-user steering is the conversation `systemPrompt`.
- [[persistent-memory]] — the briefing system prompt instructs the agent to mine the user's memory context alongside conversations.
- [[hub-pages]] — `core:briefing` is a registered Hub page provider with run-now + watchlist actions.
- [[settings]] — Settings → Briefing is the canonical config surface.
- [[projects]] — briefings land in a configured project, falling back to the most recently active one.
- [[providers-and-models]] — per-config `model`/`provider` overrides ride on the conversation; NULL → instance default resolution.
- [[api-security]] — config + run-now routes are gated by `requireAuth` + `requireScope`; own-config only by construction (keyed on session user).
- [[audit-and-observability]] — delivery + auto-disable emit per-user SSE events and structured logs.

## Related docs

None yet — this is the primary reference. The design spec lives at `tasks/daily-briefing.md` (gitignored) and the Hub-watchlist follow-up at `tasks/briefing-watchlist-from-hub.md`.

## Notes & gotchas

- **Fire-once missed-run policy is hardcoded.** A host offline through several slots fires exactly once (the boot tick catches up). There is no backfill/enumeration of missed slots — by design (locked decision).
- **Single shared agent row, not per-user.** `ensureBriefingAgentConfig` creates one `agent_configs` row named "Daily Briefing" for all users; per-user content is the conversation `systemPrompt`. Deleting/recreating that row is handled (`getBriefingAgentConfigId` re-verifies its cache against the DB).
- **Web-search vouch is allowlist-narrowed.** Only manifest tools intersected with `READ_SAFE_TOOL_NAMES = {search-web, read-url}` are ever forwarded to `readOnlyAllowedTools`. A future write-capable tool added to the manifest (e.g. `save-page`), or a third-party extension occupying the `web-search` row name, is silently skipped — widening the vouch requires a deliberate edit to the allowlist. The vouch only applies when there are watchlist topics to research; empty otherwise (fail-closed).
- **Run-now & scheduled fires share one rate bucket and one bookkeeping path.** Both record completion via `recordBriefingFireResult` (including the consecutive-errors auto-disable), and both surfaces share the 1-per-5-min `RateLimiter` — you cannot double-dip by alternating settings ↔ Hub.
- **Empty failures are cleaned up — but never a real reply.** A failed/empty run DELETE's its conversation only when it has no preservable content; a `[Scheduled briefing — …]`-prefixed synthetic message doesn't count, but a real mid-run user reply does and is preserved.
- **`PUT` never echoes raw driver/parser text.** Cron/tz are validated up front; a throw at the query layer is mapped to fixed 400 strings (`"unknown project"` / `"invalid briefing config"`) — driver error text is never returned to the client.
- **PGlite single-connection caveat.** `FOR UPDATE SKIP LOCKED` is a true at-most-once guard only on external Postgres (`Bun.sql`); under PGlite there's a single connection so it never contends (correctness still holds — there is only one process).
- **No briefing runtime ⇒ silent degrade, not error.** Before the web layer registers the executor+bus, the daemon ticks as a no-op and run-now returns 503 — neither path manufactures a consecutive-error increment for what is a boot-ordering condition.
