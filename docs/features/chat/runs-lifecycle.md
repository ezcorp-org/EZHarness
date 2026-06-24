# Runs Lifecycle & Active-Run Control

> _Every chat turn and agent invocation is an `AgentRun` with a tracked status (`idle`/`running`/`success`/`error`/`cancelled`), held in-memory and mirrored to two DB tables (`runs` + `active_runs`) so a run can be resumed after a reload, cancelled mid-flight, killed by a model-aware idle watchdog, and awaited to completion by an external harness._

## Intent

A "run" is the unit of execution behind every assistant response. `executor.streamChat` (chat turns) and `executor.runAgent` (code-based agents / pipelines / CLI) both mint an `AgentRun` and drive it through one status machine. The lifecycle layer exists to make that execution **durable and controllable**: the live partial response and any open permission/ask-user gates survive a page reload, a stuck or leaked run is killed by an activity watchdog (with a wider idle window for reasoning models), orphaned runs are reconciled at boot, and a harness can post a message then block on the terminal state in a single call. Run ownership is enforced per-user on `/api/runs/*` to close cross-tenant IDOR — but **not** on the conversation-scoped `active-run` route (see gotchas).

## How it works

### Status model & in-memory state

- `AgentStatus = "idle" | "running" | "success" | "error" | "cancelled"` (`src/types.ts`). The `AgentRun` object carries `id`, `agentName` (`"chat"` for chat turns), `projectId`, `status`, `startedAt`/`finishedAt`, `logs`, and `result` (`{ success, output, error }`, where `error` is `string | { code, message }`).
- `AgentExecutor` (`src/runtime/executor.ts`) owns the live maps: `runs` (capped at `MAX_RUNS = 100`, oldest evicted), `controllers` (one `AbortController` per run), `activeAgents` (the pi-agent-core `Agent`), `runConversations` (runId → conversationId), `pendingPermissions`, and `errorMessagePersisted` (the single-error-message idempotency guard).
- A cancel terminal state has shape `result.error = { code: "cancelled" | "swallowed_abort", message }`. `swallowed_abort` distinguishes an agent that resolved *despite* `ctx.signal` aborting from one that correctly threw on the signal.

### Two DB representations

A run is mirrored in **two** tables that the lifecycle code is careful to keep convergent (`src/db/schema.ts`):

- **`runs`** — the durable audit row: `id`, `agentName`, `projectId`, `conversationId`, `userId` (initiating principal; for chat runs this is the **root** conversation owner), `status`, `input`, `startedAt`/`finishedAt`, `result`. Written by `dbRuns.insertRun` at run start and `dbRuns.updateRun` on the normal finalize path. `run_logs` cascades off it.
- **`active_runs`** — the resilience/resume row (one per running conversation turn): `id`, `conversationId`, `status` (`running`/`interrupted`/`completed`), `startedAt`, `lastHeartbeat`, `partialResponse`. Written by `activeRunsDb.createActiveRun` at start; the watchdog refreshes `lastHeartbeat` + `partialResponse`.

`src/db/queries/runs.ts` and `src/db/queries/active-runs.ts` own these. The textbook divergence the design defends against: a wedged/leaked promise leaves `streamChat`'s `finally → finalizeCleanup` (the chat path's terminal `updateRun` — `finalizeSetupError` is its only-runs-instead setup-phase twin, and `runAgent` has its own `updateRun` for code-based runs) un-run, so without intervention the `runs` row stays `running` forever while `active_runs` is already interrupted. Every abnormal-termination path therefore also calls `dbRuns.finalizeRunRow(runId, status, error?)`, which is **idempotent + race-safe** — its `WHERE status='running'` clause is a no-op if the healthy path already terminalized.

### Run attribution (ownership)

`insertRun` attributes a run to a `userId`. For chat runs the immediate caller doesn't know the owner (sub-conversations carry `userId = null`), so when a `conversationId` is supplied without an explicit `userId`, `resolveRootConversationOwner` runs a recursive CTE up `parent_conversation_id` (depth-capped at 16) and stamps the **root** owner. A `NULL` result means unattributable ⇒ admin-only downstream (fail closed). Nested `ctx.run(...)` spawns inherit the parent's `userId`.

### Lifecycle of a chat run (`executor.streamChat`)

1. Mint the `AgentRun` (`status: "running"`), register the `AbortController`, `storeRun`, and set `runConversations[runId] = conversationId`.
2. `dbRuns.insertRun` (the `runs` row) + fire-and-forget `activeRunsDb.createActiveRun` (the `active_runs` row).
3. Emit `run:start` then `run:status` on the `EventBus`.
4. `startWatchdog(runId, conversationId, () => ctx.allTurnsText, persistError)` — the activity-based liveness loop (below). Its `getPartialResponse` closure reads `ctx.allTurnsText` lazily so each tick captures the latest streamed text.
5. Build the pi-agent (`buildPiAgent`), store it in `activeAgents`, wire `subscribeBridge` to translate pi-agent-core events into bus events + persist tool calls / per-turn assistant messages, then `piAgent.prompt(...)`.
6. Terminalize: `finalizeSuccess` / `finalizeError` / `finalizeCleanup` (inner try) or `finalizeSetupError` (outer try, catches pre-stream credential/model-resolution failures). `finalizeCleanup` calls `dbRuns.updateRun` and `watchdog.clearRun`.

### The watchdog (`src/runtime/executor-watchdog.ts`)

`WatchdogManager` is delegated all liveness state; it reads the executor's maps through a read-only `WatchdogHost` view (no state duplication).

- **Activity-based, not a dumb heartbeat.** `bumpActivity(runId)` is called on every real progress signal (token, tool start/complete/error, agent spawn/complete, turn boundaries). A tick (`WATCHDOG_TICK_MS = 15s`) compares `now - lastActivityAt` against a **model-aware idle threshold**:
  - non-reasoning: `WATCHDOG_IDLE_MS = 90s` (`EZCORP_WATCHDOG_IDLE_MS`).
  - reasoning (`model.reasoning` true, thinking level minimal/low/medium): `300s` (`EZCORP_WATCHDOG_IDLE_REASONING_MS`).
  - reasoning + high/xhigh thinking: `900s` (`EZCORP_WATCHDOG_IDLE_REASONING_HIGH_MS`).
  The flag comes from pi-ai's model registry (`Agent.state.model.reasoning`), resolved **every tick** so a mid-run model/thinking-level change takes effect immediately — never a hardcoded model list.
- **Deferral.** An idle kill is deferred while (a) a permission gate is open for the conversation, or (b) a tool call is in flight and still within its `callTimeoutMs` (`DEFAULT_BUILTIN_CALL_TIMEOUT_MS = WATCHDOG_IDLE_MS` for undeclared built-ins). `requiresUserInput` (human-in-the-loop) tools defer indefinitely. pi-agent-core emits no events while awaiting a tool result, so `noteToolStart`/`noteToolEnd` track in-flight calls explicitly.
- **On trip:** mark `active_runs` interrupted (`markInterrupted`) **and** `finalizeRunRow(runId, "error", reason)` together (both fire-and-forget so neither delays recovery); emit `tool:error` for each in-flight tool then `run:error`; set the in-memory run `error`; persist **exactly one** visible assistant error message (claiming the shared `errorMessagePersisted` slot synchronously so a later unblocked `finalizeError` skips — no duplicate bubble); abort the controller + agent.
- **Heartbeat throttle.** While healthy, `updateHeartbeat` + `updatePartialResponse` run at most once per `HEARTBEAT_REFRESH_MS = 30s` (tick is 15s).
- **Orphan cleanup.** `startOrphanCleanup` (persist-only) runs at boot + every 60s: `interruptAllRuns()` flips every still-`running` `active_runs` row (a fresh process owns zero in-memory runs, so all are orphaned), `terminalizeOrphanedRuns()` does the `runs`-table twin, and `cleanupOrphanedRuns(5min)` interrupts stale-heartbeat rows + aborts the matching in-memory controllers.

### Cancellation

- `executor.cancelRun(id)` (sync): aborts the controller + agent, sets `status="cancelled"` with `result.error = { code: "cancelled" }`, emits `run:cancel`, and fire-and-forget `finalizeRunRow(id, "cancelled")` as a safety net for the leaked-promise case where `finalizeCleanup` never runs.
- The chat UI cancels via `POST /api/conversations/[id]/active-run` `{ action: "cancel" }` (`handleStop` in `ChatThread.svelte`), **not** `DELETE /api/runs/[id]`. If there's an in-memory run, that path calls `cancelRun`; if only a DB row survives (process died / leaked sub-agent), the `db-fallback` path `markInterrupted`s it and synthesizes a `run:error` on the bus so every connected client unsticks on next poll.

### Active-run resume after reload (`active-run` route + `stream-resume.svelte.ts`)

`GET /api/conversations/[id]/active-run` is the resume oracle. It checks the in-memory run first, cross-checks `active_runs` (an in-memory run whose DB row is no longer `running` is cancelled as orphaned), and returns a `{ runId, status, partialResponse, startedAt, stalenessMs }` envelope. The shape is **path-dependent**: a *live in-memory* run returns `status: "running"`, `partialResponse: null` (the live text streams over SSE, not this poll), plus `pendingPermissions` + `pendingAskUser`; a run that survived only in the DB (process restart, or the in-memory-orphaned branch) returns the persisted `partialResponse` and the DB `status` but **no** pending-gate fields. `pendingAskUser` comes from the in-memory `ask-user-registry` because the `tool_calls` row isn't written until the gate resolves.

Client-side, `attachStreamResume(host)` (`web/src/lib/chat/page-handlers/stream-resume.svelte.ts`) wires three concerns:
1. **`checkActiveRun`** — on convId change + manual fire: attaches the page's streaming state to a live run, restores `pendingPermissions`/`pendingAskUser` as synthetic tool-call cards (deduped by id against live SSE), and pushes a `streaming-<runId>` placeholder seeded with `partialResponse`.
2. **WS-reconnect resume** — re-runs `checkActiveRun` on every EventSource reconnect, throttled by `RECONNECT_CHECK_COOLDOWN_MS = 10s` (module-scoped, keyed by convId) to avoid `loadMessages()` storms on flaky networks.
3. **Zombie/staleness watchdog** — a 10s `setInterval` polls `/active-run` to refresh `serverStalenessMs` (feeds `StuckRunBanner`), plus a `resumedRun ? 5s : 30s` `setTimeout` that re-checks server status when the streamed text hasn't moved.

All three call sites share one `backgroundFetch` key (`active-run:<convId>`) so concurrent polls collapse to a single in-flight GET.

### Stream reconciliation after completion (`reconcile-stream.ts`)

`run:complete` synchronously calls `stopStreaming`, wiping `store.streamingMessages[runId]` **before** the post-stream reconcile effect runs. To survive that, `recordSnapshot` mirrors live streaming text/thinking into a page-local `streamedSnapshot` map. After the run ends, `runReconcileAfterStream` (`reconcile-after-stream.ts`) refetches persisted messages and `patchAssistantContentFromStream` back-fills **only the last** assistant row of the run when the persisted content came back empty (intermediate tool-only turns are legitimately empty and must not be clobbered with the final turn's text). `run:turn_text_reset` sets `""` between turns; `recordSnapshot` never overwrites a non-empty snapshot with `""`.

### Run-to-completion long-poll (`await-run-completion.ts`)

`GET /api/runs/[id]?wait=1` blocks until the run reaches a terminal state, for external harnesses. `awaitRunCompletion` subscribes to `run:complete`/`run:error`/`run:cancel` **before** reading current state (no missed-event race), with bounds `WAIT_MIN_MS=1s` / `WAIT_DEFAULT_MS=2min` / `WAIT_MAX_MS=10min` (`?timeoutMs=`). A process-local admission cap (`EZCORP_MAX_RUN_WAITS`, default 200) prevents a single `read` key from pinning thousands of 10-minute waits; `request.signal` abort-on-disconnect releases the slot + listeners immediately. Resolutions map to HTTP `200`/`408` (timeout)/`499` (client closed)/`404`.

## Usage

### REST API

| Method & path | Scope | Purpose |
|---|---|---|
| `GET /api/runs?projectId=…` | `read` | List runs. Non-admins are scoped to their own `userId` (admins see all); unscoped list capped at 100. |
| `GET /api/runs/[id]` | `read` | Fetch one run (ownership-gated → 404 on non-owner). |
| `GET /api/runs/[id]?wait=1&timeoutMs=…` | `read` | Block until terminal. `200` (done), `408` (timeout), `499` (client closed), `429` (wait cap), `404`. |
| `DELETE /api/runs/[id]` | `chat` | Cancel a run (ownership-gated). 404 if not found/not running. |
| `GET /api/conversations/[id]/active-run` | `read` | Poll the conversation's active run (runId, status, `partialResponse`, pending gates, `stalenessMs`). **No ownership check — see gotchas.** |
| `POST /api/conversations/[id]/active-run` | `chat` | `{ action: "cancel" \| "force-cancel" }` — cancel in-memory (`path: "memory"`) or DB-fallback force-cancel (`path: "db-fallback"`). **No ownership check — see gotchas.** |

### UI entry points

- The chat page streams a run live; `StuckRunBanner.svelte` appears above the composer when `stalenessMs` crosses `30s` (amber "slow") / `60s` (red "stuck"), with elapsed counter + Cancel + "View details" (opens `ObservabilityPanel`).
- `handleStop` in `ChatThread.svelte` cancels via the `active-run` POST route.

### Env vars

- `EZCORP_WATCHDOG_IDLE_MS` (90s) — non-reasoning idle-kill window.
- `EZCORP_WATCHDOG_IDLE_REASONING_MS` (300s) / `EZCORP_WATCHDOG_IDLE_REASONING_HIGH_MS` (900s) — widened windows for reasoning models.
- `EZCORP_MAX_RUN_WAITS` (200) — concurrent `?wait=1` long-poll admission cap.

## Key files

- `src/runtime/executor.ts` — `AgentExecutor`: in-memory run maps, `streamChat`, `runAgent`, `cancelRun`, `getRunOwnership`, `getActiveRunForConversation`, `listRuns`.
- `src/runtime/executor-watchdog.ts` — `WatchdogManager`: activity-based idle detection, model-aware thresholds, in-flight-tool deferral, orphan cleanup, single-error-message persist.
- `src/runtime/executor-helpers.ts` — `persistErrorMessage` (the watchdog/finalize shared error-bubble writer) + pi-llm adapter.
- `src/runtime/await-run-completion.ts` — `awaitRunCompletion` long-poll primitive (event subscribe + terminal-state short-circuit + abort/timeout teardown).
- `src/db/queries/runs.ts` — `runs` table: `insertRun`, `updateRun`, `finalizeRunRow`, `terminalizeOrphanedRuns`, `getRunOwnership`, `resolveRootConversationOwner`, `listRuns`.
- `src/db/queries/active-runs.ts` — `active_runs` table: `createActiveRun`, `getActiveRun`, `updateHeartbeat`, `updatePartialResponse`, `markInterrupted`, `interruptAllRuns`, `cleanupOrphanedRuns`.
- `src/db/schema.ts` — `runs`, `run_logs`, `active_runs` table definitions.
- `src/types.ts` — `AgentStatus`, `AgentRun`, `AgentEvents` (`run:start`/`complete`/`error`/`cancel`/`status`/`token`/`usage`).
- `web/src/routes/api/runs/+server.ts` — `GET` list (per-user IDOR scope).
- `web/src/routes/api/runs/[id]/+server.ts` — `GET` (fetch / `?wait=1`) + `DELETE` (cancel); `callerOwnsRun` ownership.
- `web/src/routes/api/conversations/[id]/active-run/+server.ts` — `GET` poll + `POST` cancel/force-cancel (no ownership check).
- `web/src/lib/chat/page-handlers/stream-resume.svelte.ts` — `attachStreamResume`: resume, WS-reconnect re-check, zombie/staleness timers.
- `web/src/lib/chat/reconcile-stream.ts` — pure snapshot helpers (`recordSnapshot`, `patchAssistantContentFromStream`, `snapshotToMaps`, `clearSnapshot`).
- `web/src/lib/chat/reconcile-after-stream.ts` — `runReconcileAfterStream`: refetch + back-fill the last empty assistant row.
- `web/src/lib/components/StuckRunBanner.svelte` — slow/stuck nudge banner (30s/60s thresholds).

## Features it touches

- [[conversations]] — each `POST .../messages` send mints the `runId`; the `active-run` route lives under the conversation path; `runConversations` maps run→conversation.
- [[streaming-runtime]] — `streamChat` drives the SSE token stream; `subscribeBridge` translates pi-agent-core events into the `run:*` bus events this lifecycle depends on.
- [[ask-user]] — open `ask_user_question` gates are surfaced through `pendingAskUser` on the active-run response and restored on resume.
- [[permissions-and-grants]] — open permission gates defer the watchdog idle kill and are restored as synthetic cards on reload.
- [[builtin-file-tools]] — in-flight tool calls (and their `callTimeoutMs`) drive the watchdog deferral / per-tool timeout-kill reason.
- [[remote-testability]] — `GET /api/runs/[id]?wait=1` is the run-to-completion primitive harnesses use to drive a turn and read its result in one call.
- [[api-security]] — `/api/runs/*` enforces per-user run ownership (the IDOR guard); the `active-run` route is the documented exception.
- [[agents]] — `runAgent` mints the same `AgentRun` shape for code-based agents; nested `ctx.run` spawns inherit the parent's `userId`.
- [[teams]] — team members run as sub-conversation runs whose root-owner attribution flows through `resolveRootConversationOwner`.
- [[providers-and-models]] — `model.reasoning` + thinking level select the watchdog idle window.
- [[audit-and-observability]] — `run_logs` + the `runs` audit row + the `ObservabilityPanel` "View details" surface.
- [[goal-autopilot]] — a `/goal <condition>` turn falls through to `streamChat` and runs as a normal run.

## Related docs

None yet — this is the primary reference. (See [harness-contract](../../harness-contract.md) for `GET /api/runs/:id?wait=1` in the control-plane contract, and [conversations](./conversations.md) for the send pipeline that mints each run.)

## Notes & gotchas

- **Active-run IDOR (OPEN).** `GET`/`POST /api/conversations/[id]/active-run` only call `requireScope` + `requireAuth` — there is **no** conversation-ownership check. SvelteKit does not wrap a child `+server.ts` in a parent guard, so any authenticated user can poll another tenant's live run (leaking `partialResponse` + pending gates) or cancel/force-cancel it cross-tenant. Contrast `/api/runs/[id]`, which **does** gate ownership via `callerOwnsRun`. Treat this as a known open finding, not fixed.
- **Two tables can diverge; `finalizeRunRow` is the convergence point.** A wedged/leaked promise skips `finalizeCleanup` (the chat path's terminal `updateRun` caller), so without `finalizeRunRow` the `runs` row stays `running` forever while `active_runs` is interrupted. Every kill path (watchdog, `cancelRun`, setup error, boot reconciliation) funnels through it; it's idempotent (`WHERE status='running'`).
- **One error bubble per run.** The `errorMessagePersisted` set is shared between the watchdog trip and the `finalizeError`/`finalizeSetupError` paths. The first writer claims the runId synchronously; the others skip — without it a watchdog kill whose await later unblocks renders two error bubbles.
- **Idle window is model-aware and tick-resolved.** Never assume 90s. Reasoning models silently think far longer; the threshold is resolved from `Agent.state.model.reasoning` + thinking level on **every tick**, so a mid-run model switch is honored. There is no hardcoded model list — new reasoning models inherit the wide window automatically.
- **`runs` map is capped at 100.** `storeRun` evicts the oldest in-memory run past `MAX_RUNS`; `getRun` then falls back to the persisted `runs` row. Don't rely on a long-finished run still being in memory.
- **`stopStreaming` races the reconcile.** `run:complete` wipes the live streaming cache before the post-stream effect runs — that's why `streamedSnapshot` (`recordSnapshot`) exists. Only the **last** assistant row of a run is back-filled; intermediate tool-only turns are intentionally left empty.
- **Resume is best-effort.** Every `stream-resume` path swallows its own errors (the page works without resume) and bails when the `loadGeneration` token has advanced (user switched conversations) — async continuations from a previous conversation are discarded.
- **`force-cancel` ≡ `cancel` server-side.** Both POST actions take the in-memory path when a controller exists and the DB-fallback path otherwise; the distinction is only a client signal that the user wants the DB row flipped even with no live run.
