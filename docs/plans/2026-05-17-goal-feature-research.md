# `/goal` Feature — EZCorp Harness Integration Research

> Research deliverable. Determines the best **100%-reliable** integration
> approach for replicating Claude Code's `/goal` (session-scoped
> completion-condition autopilot, wrapped around a prompt-based Stop hook)
> inside the EZCorp harness. Does **not** contain the PRD.

Date: 2026-05-16 · Branch: `main` · Researcher: codebase-explorer agent

---

## 1. Executive Summary

### Recommended integration approach: **server-side runtime module + thin bundled extension for command/UI**, NOT a pure user-extension

EZCorp **does** have a turn-completion interception point that is
100% reliable: the in-process `EventBus` `run:complete` event
(`src/runtime/stream-chat/finalize.ts:74`), and the harness already
ships **the exact autopilot loop primitive `/goal` needs** — the
`startAssignment()` re-prompt loop in
`src/runtime/start-assignment.ts:307-366`, which subscribes to
`bus.on("run:complete")` and re-enters `executor.streamChat()` with a
continuation prompt until a stop signal/cycle cap is hit.

There is **no Claude-Code-style "Stop hook" abstraction** and **no
generic hook system**. The closest substrates are: (a) the in-process
`EventBus` (`run:complete`), (b) the extension `LifecycleHookDispatcher`
/ `EventSubscriptionDispatcher` (which deliver a *sanitized*
`run:complete` notification to a subprocess), and (c) the
`startAssignment` autonomous-continuation loop (sub-conversation only,
today).

The single hard blocker for a **pure** user-authored extension: an
extension subprocess **cannot start a new turn on the main
conversation**. The three turn-authoring surfaces all fall short:

| Surface | Why it can't drive a `/goal` follow-up turn |
|---|---|
| `ezcorp/append-message` | Host **forces `role:"extension"` + `excluded:true`** (`src/extensions/append-message-handler.ts:112,289`); the row is filtered out of LLM history by `build-pi-agent.ts` and never triggers an assistant turn. |
| `ezcorp/spawn-assignment` | Spawns a **sub-conversation** sub-agent (`src/extensions/spawn-assignment-handler.ts:332`), not a continuation of the user's main conversation. Wrong transcript, wrong UX. |
| `runtime.*` invoke | The whitelist (`src/extensions/runtime-invoke-handler.ts:139-159`) has **no `runtime.chat.startTurn`**-style method. |

**Recommendation (confidence: HIGH for the mechanism, MEDIUM-HIGH for
the exact packaging):** Implement the goal loop as a **server-side
runtime controller** (a `goal-host.ts` sibling of
`start-assignment.ts`) that:
1. Subscribes once to the singleton bus `run:complete`
   (`getBus()` from `web/src/lib/server/context.ts:308`),
2. On completion of a goal-armed conversation's chat run, calls the
   small/fast model via the existing provider router
   (`src/providers/router.ts`'s `resolveModel` + `@mariozechner/pi-ai`'s
   `complete`, the same path `llm-handler.ts:320` uses),
3. On "no", re-enters `executor.streamChat(conversationId,
   continuationPrompt, …)` exactly as `startAssignment.startRun()` does
   (`src/runtime/start-assignment.ts:279`),
4. Persists goal state in a new lightweight table (or
   `conversations.metadata` JSONB, `src/db/schema.ts:60`) so it restores
   on resume but is cleared on achieve/clear.

The `/goal` **command parsing** and the **`◎ /goal active` UI
indicator** are best delivered by a **thin bundled extension or a
built-in EZ-Action-like dispatch**, because slash commands in EZCorp are
**literal prompt substitution** (cannot run server logic) and the
`messages` POST route is where a `/goal …` line must be intercepted
*before* `streamChat`.

A **pure user-installed extension is NOT viable for 100% reliability**
without one new host primitive: a `runtime.chat.continueConversation`
invoke method (or equivalent) that re-enters `executor.streamChat` on
the *caller's wired main conversation*. If the PRD author wants the
"feature extension" framing, the cleanest path is: ship the host
primitive + a **bundled** extension (`bootSpawn:true`, `persistent:true`,
`eventSubscriptions:["run:complete"]`, `llm` Haiku grant) modeled
1:1 on the existing **`memory-extractor`** bundled extension, which is
already a `run:complete`-subscribing + Haiku-`ctx.llm` extension.

---

## 2. The Critical Question: Is There a Turn-Completion Interception Point?

**YES.** Three layers, in increasing distance from the turn:

### 2.1 Layer A — in-process EventBus `run:complete` (BEST; 100% reliable)

`finalizeSuccess()` emits it on every clean turn completion:

```ts
// src/runtime/stream-chat/finalize.ts:74-81
host.bus.emit("run:complete", { run, conversationId });
host.bus.emit("obs:turn", {
  conversationId,
  llmDurationMs: Date.now() - ctx.turnStart,
  toolDurationMs: 0,
  totalDurationMs: Date.now() - ctx.turnStart,
  tokenUsage: { input: ctx.totalUsage.input, output: ctx.totalUsage.output },
});
```

Event payload type (`src/types.ts:228`):
`"run:complete": { run: AgentRun; conversationId?: string }`.
`AgentRun` (`src/types.ts:126`) carries `id`, `status`, `result`
(`{success, output:{fullText}}`), `startedAt`, `finishedAt`.

Error/cancel paths emit siblings: `run:error`
(`finalize.ts:153,168,231`), `run:cancel` (`finalize.ts:131`). The
watchdog also terminalizes + emits `run:error` on a wedged run
(`src/runtime/executor-watchdog.ts:300,325`). **A goal loop MUST
subscribe to all three** (`run:complete`/`run:error`/`run:cancel`) to
avoid a stuck-goal hang — see Risks.

The bus is a process-global singleton exposed via `getBus()`
(`web/src/lib/server/context.ts:308`). The harness's own
`startAssignment` proves the pattern: it does
`bus.on("run:complete", (data) => { if (data.run.id !== runId) return; … startRun(newRunId, CONTINUATION_PROMPT) })`
(`src/runtime/start-assignment.ts:307-366`). **This is exactly the
`/goal` re-prompt loop**, already production-tested for sub-agents.

### 2.2 Layer B — extension lifecycle/event delivery of `run:complete`

Two dispatchers forward `run:complete` to extension **subprocesses**:

- `LifecycleHookDispatcher` (`src/extensions/lifecycle-dispatcher.ts`):
  `ALLOWED_LIFECYCLE_HOOKS` includes `"run:complete"` (line 7-12);
  sanitizer ships only `{runId, agentName, status, timestamp}`
  (line 50-58). Gated on `permissions.lifecycleHooks: true`.
- `EventSubscriptionDispatcher`
  (`src/extensions/event-subscription-dispatcher.ts`): `run:complete`
  is a `DIRECT_CARRIER_EVENT_TYPE`
  (`src/runtime/sse-conversation-filter.ts:47`); gated on
  `permissions.eventSubscriptions: ["run:complete"]` **and** on
  `conversation_extensions` wiring for the event's `conversationId`
  (`event-subscription-dispatcher.ts:296-303`).

**Both are fire-and-forget and only deliver if the subprocess is
ALREADY running** (`lifecycle-dispatcher.ts:142` /
`event-subscription-dispatcher.ts:352`: `getProcessIfRunning` → null ⇒
silent drop). This is why the existing `run:complete`-consuming
extensions (`memory-extractor`, `lessons-keeper`) are flagged
`bootSpawn: true` + `persistent: true`
(`src/extensions/bundled.ts:600-603,670-674`): without that, the 5-min
idle-out kills the subprocess and **`run:complete` is silently
dropped**. This is a reliability cliff for any extension-based design.

### 2.3 Layer C — `startAssignment` autonomous continuation (the loop primitive)

`src/runtime/start-assignment.ts:331-366` is a working, shipped
autopilot: opt-in `autonomousContinuation`, re-prompts toward a
"Pinned Objective" on every `run:complete` until a `<<TASK_DONE>>` /
`<<TASK_BLOCKED>>` sentinel or `maxCycles` cap. **This is structurally
identical to `/goal`** — only differences: (a) it loops a
sub-conversation, not the main one; (b) the "done" check is a regex on
the agent's own output, not a separate small-model judge. The `/goal`
host controller should be modeled directly on this file.

**Answer:** The interception point exists and is battle-tested
(`start-assignment.ts`). The *gap* is that no **extension-facing** API
re-enters `streamChat` on the **main** conversation; only host-side code
(`messages/+server.ts:354`, `start-assignment.ts:279`) calls
`executor.streamChat()`.

---

## 3. Per-Area Findings

### 3.1 Turn / stream-chat lifecycle

`executor.streamChat(conversationId, userMessage, options)` is THE turn
entry point (`src/runtime/executor.ts:348-352`). A "turn" == one `run`
row. Lifecycle:

1. Build `run` (`executor.ts:353`, `id = options.runId ?? uuid`),
   `controllers.set(run.id, controller)`, `storeRun`,
   `runConversations.set(run.id, conversationId)` (`executor.ts:362-365`).
2. `dbRuns.insertRun` (persist), `bus.emit("run:start")`,
   `activeRunsDb.createActiveRun` (`executor.ts:400-412`).
3. `loadHistory` → `setupTools` → watchdog start → `applyAutoSpinUp` →
   mode tool filters (`executor.ts:418-467`).
4. LLM stream loop, then `finalizeSuccess` / `finalizeError` /
   `finalizeCleanup` (`finalize.ts`).

**Runs table / state machine** (the recent commit *"terminalize runs
row on abnormal run termination"*, `57f82fe`):
- `runs` table: `src/db/schema.ts:23-33` —
  `{id, agentName, projectId, status, input, startedAt, finishedAt,
  result, createdAt}`. `status ∈ {idle|running|success|error|cancelled}`
  (`AgentStatus`, `src/types.ts:31`).
- `active_runs` table (`schema.ts:432`) — crash-recovery mirror, with
  `last_heartbeat`. `finalizeCleanup` writes the terminal `runs` row +
  deletes/`markInterrupted`s `active_runs`
  (`finalize.ts:194-206`).
- Orphan/abnormal terminalization: `WatchdogManager` does
  `dbRuns.finalizeRunRow(runId, "error", reason)` +
  `activeRunsDb.markInterrupted` on a wedged run
  (`executor-watchdog.ts:297-302`); `startOrphanCleanup` runs
  `terminalizeOrphanedRuns()` + `interruptAllRuns()` on boot
  (`executor-watchdog.ts:123,109`). **Implication for `/goal`:** an
  abnormally terminated run still ends with a bus emission
  (`run:error`), so a goal loop keyed on `run:error` won't hang on a
  watchdog kill — but it MUST treat watchdog `run:error` as
  "turn failed", not "evaluate goal" (a wedged turn produced no useful
  transcript to judge).

**Can anything inject a new turn programmatically?** Yes, but only
host-side: `messages/+server.ts:354` (user path) and
`start-assignment.ts:279` (sub-agent loop) both call
`executor.streamChat(...)`. A `/goal` host module would do the same on
the main `conversationId`. There is **no** in-conversation
re-entrancy hazard because each `streamChat` call creates a fresh
`run.id` and the prior run's `finalizeCleanup` has already detached its
subscriptions (`finalize.ts:179-207`).

### 3.2 Extension system capabilities

What an extension **can** do (from `docs/extensions/api-reference.md`,
`manifest-schema.md`, and code):

- **Register tools** (JSON-RPC `tools/call`), **skills** (prompt-only),
  **agent personas**, **MCP servers**, **named `scripts.commands`**
  (CLI maintenance commands — NOT chat slash commands)
  (`api-reference.md:328-448`).
- **Subscribe to events**: `permissions.eventSubscriptions`
  (`manifest-schema.md:598-622`) — platform direct-carrier events incl.
  `run:complete`/`tool:complete`/`task:snapshot`, OR own-namespace
  custom events. Delivered as `ezcorp/event/<name>` JSON-RPC
  notifications. `permissions.lifecycleHooks: true` for the 4 sanitized
  lifecycle hooks (`manifest-schema.md:546-564`).
- **Call a (small/fast) LLM**: `ctx.llm.complete()` →
  `ezcorp/llm-complete` reverse RPC (`src/extensions/llm-handler.ts`).
  Provider+model allowlist enforced host-side; **token never crosses
  the boundary** (handler resolves credentials and calls
  `@mariozechner/pi-ai` directly, `llm-handler.ts:316-364`). Quota +
  abuse graduation enforced. **Haiku-class is a first-class grantable
  model** — see §3.4.
- **Author a turn**: `ezcorp/append-message`
  (`api-reference.md:867`, `append-message-handler.ts`) — but FORCED
  `role:"extension"` + `excluded:true` ⇒ **does not trigger an LLM
  turn**.
- **Spawn a sub-agent**: `ezcorp/spawn-assignment` (`spawnAgents`
  perm) — sub-conversation only.
- **Push UI state**: `ExtensionStateMediator` → `ext:state` bus event
  (`src/extensions/state-mediator.ts:90`), gated on `manifest.panel`.
  Renders via `web/src/lib/components/ExtensionPanel.svelte`.
- **Persist state**: `ezcorp/storage` (`permissions.storage:true`),
  scopes `global|conversation|user`
  (`api-reference.md:664-812`). Conversation scope is the natural home
  for goal state — but see §3.5 for the resume nuance.

Example extensions worth mirroring:
- **`memory-extractor`** (`extensions/memory-extractor/`,
  `bundled.ts:667-694`) — **the closest analog.**
  `persistent:true`, `bootSpawn:true`,
  `eventSubscriptions:["run:complete"]`, `llm` Haiku grant. Its
  `index.ts` does: `registerEventHandler("run:complete", …)` (line 555)
  → `invoke("runtime.conversations.getMessages", {conversationId})`
  (line 182) → `ctx.llm.complete({provider, model, …})` (line 189) →
  `runtime.*` write. **`/goal` evaluator step is byte-for-byte this
  pattern.**
- **`orchestration`** (`docs/extensions/examples/orchestration/`) —
  `spawnAgents` + `task:assignment_update`; drives
  `startAssignment` with `autonomous`. Pattern reference for the loop.
- **`auto-note`** — auto-capture + delete/promote UI (relevant to the
  "curation UI is v1 floor" memory note; goal status/history needs a
  clear/inspect surface, not deferred).
- `test-event-subscriber` / `test-task-events` — minimal
  `eventSubscriptions` integration-test fixtures; templates for the
  100%-coverage event-subscription test the PRD will need.

### 3.3 Slash-command system

`/goal` **cannot be a normal slash command.** Slash commands are
**markdown files** discovered from `.claude/commands` etc.
(`src/runtime/commands/discovery.ts:68-80`) + the `user_commands` DB
table, and they are **literal prompt substitution** done server-side in
`applyCommandExpansion` (`src/runtime/mention-wiring.ts:139-156`,
called from `build-prompt.ts`): the `/[cmd:name]` token's body replaces
the token in the prompt the LLM sees; **no server logic runs**. CLAUDE.md
confirms: *"Expansion is literal — never re-parse expanded text."*

Extensions **cannot register chat slash commands** — `scripts.commands`
(`api-reference.md:435`) are CLI maintenance commands, unrelated.

**Cleanest path to make `/goal` invokable:** intercept it in the
**messages POST route** (`web/src/routes/api/conversations/[id]/
messages/+server.ts`) *before* `executor.streamChat`, exactly like the
existing **EZ-Actions** pattern: `messages/+server.ts:280-342` already
scans the incoming message for `![EZ:name]` tokens, runs a server-side
handler, persists a result card, and **can short-circuit the LLM call
entirely** (line 328-342). `/goal …` should be parsed the same way (a
new sigil/prefix or an EZ-action-style handler), giving server-side
control over: set (start a turn with the condition), status (return a
card), clear (no-op the LLM, clear state). The EZ-Actions registry
(`src/runtime/ez-actions/registry.ts`) is "code-defined, not
user-extensible in v1" — so a built-in `goal` action (or a new
`/goal`-prefix branch in the POST handler) is the idiomatic fit, not a
user extension.

### 3.4 Model configuration (the evaluator's small/fast model)

**A Haiku-class small/fast model is already a standard grantable
concept.** The bundled `memory-extractor` and `lessons-keeper`/distiller
ceilings pin exactly this set
(`src/extensions/bundled-ceiling.ts:235-244`,
`extensions/memory-extractor/ezcorp.config.ts`):

```
allowedModels: {
  google:    ["gemini-2.0-flash-lite"],
  openai:    ["gpt-4o-mini"],
  anthropic: ["claude-haiku-4-5-20250514"],
  ollama:    ["gemma4:e2b", "gemma4:latest", "qwen3.6:35b"],
}
```

How a one-shot cheap-model call is made:
- **Extension path:** `ctx.llm.complete({provider, model, systemPrompt,
  messages, maxTokens, temperature})` → `ezcorp/llm-complete`
  (`llm-handler.ts:160`). Host resolves via `resolveModel(provider,
  model)` from `src/providers/router.ts` + `getCredential` from
  `src/providers/credentials.ts`, then `@mariozechner/pi-ai`'s
  `complete()` (`llm-handler.ts:316-364`). Quota + audit automatic.
- **Host path (recommended for `/goal`):** call `resolveModel` +
  `getCredential` + `pi-ai.complete` directly, mirroring
  `llm-handler.ts:320-323` and `src/memory/extraction.ts` /
  `src/runtime/audit/llm-classify.ts` (existing host-side cheap-model
  callers). No subprocess hop, no idle-out risk.

There is no single global "smallFastModel" setting today; the
convention is the per-extension `allowedModels` Haiku triple above. The
PRD must decide whether `/goal`'s evaluator model is configurable
(extension `settings` / a `global:` setting) or pinned to that triple
with a sensible default per the conversation's provider.

### 3.5 Session / conversation persistence

**There is no separate "session" entity** — EZCorp's unit is the
**conversation** (`conversations` table, `src/db/schema.ts:43-68`).
"Resume/continue" == reopening a conversation and POSTing the next
message; history is reloaded via `loadHistory` /
`convQueries.getConversationPath` (`messages/+server.ts:57,69`). There
is **no explicit resume hook** — so "restore the goal on resume" means
"the goal state is keyed by `conversationId` and read on the next
message POST / on bus subscription rehydration".

Where goal state should live (must restore on resume, clear on
achieve/clear):
- **Option A (recommended): `conversations.metadata` JSONB**
  (`schema.ts:58-60`, already used for `spawnDepth`). A
  `metadata.goal = {condition, armed:true, …}` survives restart, is
  trivially clearable (delete the key), and is naturally
  conversation-scoped. Turn count / timer / token baseline are
  **reset** on resume (per spec) so they live in an in-memory map keyed
  by `conversationId` (rebuilt lazily), not in `metadata`.
- **Option B: `extension_storage` conversation scope**
  (`schema.ts:329`, `scope:"conversation"`). Works if `/goal` is a
  bundled extension; clears via `ezcorp/storage delete`. Slightly more
  indirection; conversation-scope storage requires the extension be
  wired to the conversation (`api-reference.md:676`).
- **Option C: new `conversation_goals` table.** Cleanest schema, but a
  migration; only worth it if status/history needs first-class queries.

**Token spend per turn/run** for status reporting: per-run usage is on
the bus as `run:usage` (`src/types.ts:233`,
`{input,output,cacheRead,cacheWrite,totalTokens,cost}`) and per-turn as
`obs:turn` (`types.ts:294`) + `finalize.ts:75`. Per-message usage is
persisted on `messages.usage` JSONB (`schema.ts:95`). `/goal` status
("token spend since armed") = sum `messages.usage` for runs created
after the arm timestamp, OR accumulate from `obs:turn`/`run:usage` in
the in-memory goal record.

### 3.6 UI surfaces (`◎ /goal active` indicator + latest reason)

Server→client transport is **SSE** (memory note confirmed:
`web/src/routes/api/runtime-events/+server.ts`). The SSE endpoint
subscribes to a **fixed `BUS_EVENTS` allowlist**
(`runtime-events/+server.ts:32-47`) and forwards each as
`{type, data}` frames, filtered per-subscriber by `conversationId` via
`shouldDeliverEvent` (`sse-conversation-filter.ts`). `ext:state` is
already in that allowlist (line 46).

Two viable indicator transports:
1. **Reuse `ext:state`** (if `/goal` is a bundled extension with a
   `panel`): push `{armed, condition, elapsedMs, turns, lastReason}` via
   `ExtensionStateMediator` → `ext:state` → `ExtensionPanel.svelte`.
   Zero new SSE plumbing.
2. **Add a `goal:active` / `goal:update` bus event**: add to the
   `AgentEvents` interface (`src/types.ts:224`), the SSE `BUS_EVENTS`
   allowlist (`runtime-events/+server.ts:32`), `DIRECT_CARRIER_EVENT_TYPES`
   if extensions need it, and render in the chat header. More plumbing
   but a cleaner first-class surface for the `◎` chip + elapsed timer.

Render locations:
- The `◎ /goal active` chip + elapsed timer: chat header area near
  `web/src/lib/components/MessageToolbar.svelte` /
  `ChatThread.svelte` / the conversation page
  `web/src/routes/(app)/project/[id]/chat/[convId]/+page.svelte`
  (all currently dirty in `git status` — coordinate).
- Latest evaluator reason in transcript + status view: an inline card.
  The **EZ-Action result card** pattern (`role:"ez-action-result"`
  message rows rendered as cards, `ez-actions/types.ts:46-81`) is the
  precedent for `/goal status` and the "achieved"/"cleared" transcript
  entries. Tool-card routing:
  `web/src/lib/components/tool-cards/ToolCardRouter.svelte` +
  `utils.ts`.

### 3.7 Hooks — is there a Stop-hook analog?

**No Claude-Code-style hook system exists.** Grep for "hook" across
`src/` returns: `LifecycleHookDispatcher`
(`src/extensions/lifecycle-dispatcher.ts`),
`EventSubscriptionDispatcher`, MCP client hooks, the watchdog, and the
SDK `registerLifecycleHook` (install/enable/disable/uninstall events
only — `api-reference.md:642`). None of these is a *prompt-based,
session-scoped, turn-boundary Stop hook*.

**The functional equivalent that already exists is
`startAssignment`'s `run:complete` re-prompt loop**
(`src/runtime/start-assignment.ts:307-366`). This IS EZCorp's
"after-every-turn, decide-then-continue" mechanism. `/goal` should be
implemented as a **generalization of this loop to the main
conversation**, with the regex done-detector replaced by a small-model
judge. There is no lighter-weight substrate to wrap; building one would
duplicate `startAssignment`.

### 3.8 Gotchas / constraints (the "100% of the time" bar)

1. **Subprocess idle-out drops `run:complete`.** Extension event
   delivery is fire-and-forget *only if the subprocess is running*
   (`event-subscription-dispatcher.ts:352`,
   `lifecycle-dispatcher.ts:142`). `memory-extractor` works around this
   with `bootSpawn:true` + `persistent:true`
   (`bundled.ts:600,670`). A user-installed (non-bundled) extension
   **cannot** set `bootSpawn`, so it WILL miss `run:complete` after 5
   min idle → goal silently stalls. **This alone disqualifies a pure
   user extension for the 100% bar.** Host-side (in-process bus
   subscription) has no such cliff.
2. **Watchdog race at the turn boundary.** Idle kill fires after 90s of
   no activity (`executor-watchdog.ts:15`). The goal loop runs
   *between* runs (after `run:complete`, no run active), so the
   evaluator Haiku call + `streamChat` re-entry must be fast and must
   NOT depend on the dead run's watchdog. Treat watchdog-origin
   `run:error` (`executor-watchdog.ts:325`, reason contains "Watchdog")
   as "turn failed — do not evaluate, surface error", not as a normal
   completion.
3. **Must subscribe to `run:complete` AND `run:error` AND `run:cancel`.**
   Only `finalizeSuccess` emits `run:complete`; cancel emits
   `run:cancel` (`finalize.ts:131`), errors emit `run:error`
   (`finalize.ts:153,168,231`; watchdog `:325`). A loop keyed only on
   `run:complete` hangs forever on any failed/cancelled turn — exactly
   the bug `start-assignment.ts:401-439` documents and fixes for
   sub-agents ("agent is stuck" bug). Mirror that triad of listeners
   verbatim.
4. **`run.id` filtering is mandatory.** The bus is global; every
   `run:complete` for every conversation fires on the one listener.
   `startAssignment` guards `if (data.run.id !== runId) return`
   (`start-assignment.ts:308`). The `/goal` host must resolve
   `conversationId` from the run (via `host.runConversations` /
   `run:complete` payload's `conversationId`) and only act on
   goal-armed conversations.
5. **Re-entrancy / double-fire.** If the goal loop and a user message
   both POST a turn, two `streamChat` calls race. Need a per-conversation
   "goal turn in flight" guard (in-memory, like
   `pending-messages.ts`'s queue / `start-assignment`'s
   `assignment.status === "running"` guard at line 341).
6. **Abort/interrupt (Ctrl+C / headless).** Cancellation emits
   `run:cancel`; non-interactive (`-p`) and remote modes go through the
   same `executor.streamChat` + bus, so the host loop is mode-agnostic.
   But the loop MUST stop on `run:cancel` for the armed conversation
   (user pressed stop) — clearing or pausing the goal — otherwise Ctrl+C
   can't interrupt a goal (a spec requirement).
7. **Headless persistence.** Goal state in `conversations.metadata`
   (DB) survives process restart; the in-memory loop subscription must
   be **rehydrated on boot** (a `startOrphanCleanup`-style sweep that
   re-arms listeners for conversations with `metadata.goal.armed`),
   else a server restart silently disarms every active goal.
8. **Condition ≤ 4000 chars / evaluator sees only transcript.** The
   evaluator must NOT call tools (matches `ctx.llm.complete` which is
   text-only — `llm-handler.ts:407-413` deliberately drops tool
   blocks). Fetch transcript via
   `runtime.conversations.getMessages` (extension) or
   `convQueries.getConversationPath` (host).
9. **`obs:turn`/`run:usage` are emitted AFTER `run:complete`** in
   `finalizeSuccess` (`finalize.ts:74` then `:75`). If the goal status
   needs token spend, read it from persisted `messages.usage` or
   accumulate `run:usage`, don't assume `obs:turn` arrived before the
   loop's `run:complete` handler runs (same emit tick, ordering by
   listener registration).
10. **Curation-UI floor (project memory note).** `/goal status`,
    clear, and the achieved/cleared transcript entries are **v1 floor,
    not v1.5** — the auto-capture-needs-delete/promote-UI lesson
    applies. Ship the inspect/clear surface in v1.

---

## 4. Risks to 100% Reliability (ranked)

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | **Pure user-extension misses `run:complete` after 5-min subprocess idle-out** (`event-subscription-dispatcher.ts:352`). No `bootSpawn` for user extensions. | **Blocker** | Implement as host-side bus subscription (no subprocess) OR a **bundled** extension with `bootSpawn:true`+`persistent:true` (the `memory-extractor` precedent). |
| R2 | **Loop hangs on failed/cancelled/watchdog-killed turn** if only `run:complete` is observed. | High | Subscribe to `run:complete`+`run:error`+`run:cancel`; on failure, surface + pause goal (don't auto-continue into a broken state). Mirror `start-assignment.ts:401-439`. |
| R3 | **Server restart silently disarms every active goal** (in-memory subscription lost). | High | Persist `metadata.goal.armed`; boot-time rehydration sweep re-arms listeners (mirror `executor-watchdog.startOrphanCleanup`). |
| R4 | **No extension API starts a main-conversation turn** — `append-message` is excluded, `spawn-assignment` is a sub-conv. | **Blocker for pure ext** | Add a host primitive (`runtime.chat.continueConversation` invoke, or host-side `streamChat` re-entry) — the loop MUST run where `executor.streamChat` is reachable. |
| R5 | **Turn-boundary race**: user message + goal continuation both POST a turn. | Medium | Per-conversation in-flight guard + treat a fresh user message as superseding the goal continuation (steering wins, like `pending-messages` dequeue precedence at `start-assignment.ts:312`). |
| R6 | **Watchdog `run:error` mistaken for a normal turn end** → evaluator judges an empty/wedged transcript, loops on garbage. | Medium | Detect watchdog-origin errors (reason string / `run.status==="error"` with no `result.output`); treat as failure, not evaluation. |
| R7 | **Evaluator cost/latency** on every turn (extra Haiku call per turn) inflates token spend the user didn't expect; spec wants user-visible token accounting. | Low-Med | Use the pinned Haiku/flash-lite triple; surface running token cost in `/goal` status; honor `maxTokensPerCall` clamp (`llm-handler.ts:282`). |
| R8 | **SSE indicator not delivered**: custom `goal:*` event not in the `BUS_EVENTS` allowlist (`runtime-events/+server.ts:32`). | Low | Either reuse `ext:state` (already allowlisted, line 46) or add `goal:update` to the allowlist + `AgentEvents` + filter set. |
| R9 | **Slash-command framing is wrong** — `/goal` is literal prompt substitution, can't run logic. | Low (design) | Intercept in messages POST route like EZ-Actions (`messages/+server.ts:280-342`), not via the command registry. |

---

## 5. Open Questions / Decisions for the PRD Author

1. **Packaging:** host-side runtime controller (most reliable, but not
   a "feature extension") vs. bundled extension + new host primitive
   (matches the "extension" framing, `memory-extractor` precedent) vs.
   pure user extension (NOT viable at the 100% bar — R1/R4). Recommend
   bundled-extension + `runtime.chat.continueConversation` host
   primitive if the extension framing is required; otherwise pure
   host module.
2. **The missing host primitive:** define
   `runtime.chat.continueConversation(conversationId, prompt,
   {systemNote?})` (added to `runtime-invoke-handler.ts:139` switch)
   that re-enters `executor.streamChat` on the caller's wired main
   conversation. Scope/permission model? (Spawn-quota-style gate? New
   `permissions.chatContinuation`?) This is the single biggest design
   decision.
3. **Goal state store:** `conversations.metadata` JSONB (Option A,
   recommended) vs. `extension_storage` conversation scope (Option B)
   vs. new `conversation_goals` table (Option C). Drives the
   resume/clear semantics and the status query.
4. **Command surface:** new `/goal` prefix branch in the messages POST
   route, vs. a built-in EZ-Action (`![EZ:goal …]`), vs. a new sigil.
   How are args (`<condition>`, `clear`/`stop`/`off`/`reset`/`none`/
   `cancel`, no-arg status) parsed? (≤4000-char cap, alias list.)
5. **Evaluator model selection:** pin the Haiku/flash-lite triple with
   provider-matched default, vs. expose a configurable
   `evaluatorModel` setting (extension `settings` or `global:` key).
   What happens if the conversation's provider has no cheap model
   credential?
6. **Evaluator prompt contract:** exact yes/no + reason schema; how
   much transcript to feed (memory-extractor uses
   `messages.slice(-20)` — `extractor index.ts:333-334`); how the
   "or stop after N turns" self-bound clause is honored (model
   self-reports vs. host hard-counts turns).
7. **Indicator transport:** reuse `ext:state`/`ExtensionPanel` vs. a
   first-class `goal:update` bus event + chat-header chip. Affects how
   much new web plumbing is in scope.
8. **Interrupt semantics:** does `run:cancel` (user pressed stop)
   *pause* or *clear* the goal? Spec says Ctrl+C interrupts a
   non-interactive goal — define pause vs. clear precisely.
9. **Boot rehydration:** where does the re-arm sweep live (a
   `goal-host.ts` `start()` called from `ensureInitialized()` in
   `web/src/lib/server/context.ts`, alongside
   `watchdog.startOrphanCleanup()`)?
10. **Test plan for 100% coverage** (project bar): unit (evaluator
    decision, state machine, alias parsing), integration
    (`run:complete`→evaluate→continue loop, failure-path no-hang,
    resume rehydration), e2e Playwright (arm goal, see `◎` chip via
    SSE, auto-continue, achieve clears it) — model the
    event-subscription integration test on
    `src/__tests__/event-subscription.integration.test.ts` and the
    `test-event-subscriber` fixture.

---

## Appendix — Key File:Line Index

| Concern | File:Line |
|---|---|
| Turn entry point | `src/runtime/executor.ts:348` (`streamChat`) |
| `run:complete` emit | `src/runtime/stream-chat/finalize.ts:74` |
| `run:error`/`run:cancel` emit | `finalize.ts:131,153,168,231`; watchdog `executor-watchdog.ts:325` |
| Autopilot loop primitive | `src/runtime/start-assignment.ts:279,307-366` |
| Runs table / state machine | `src/db/schema.ts:23-33`, `active_runs` `:432`; terminalize `executor-watchdog.ts:297-302,123` |
| EventBus | `src/runtime/events.ts`; types `src/types.ts:224-296` |
| Singleton bus / executor | `web/src/lib/server/context.ts:308,298` |
| Extension lifecycle hooks | `src/extensions/lifecycle-dispatcher.ts:7-12,50-58,142` |
| Extension event subscriptions | `src/extensions/event-subscription-dispatcher.ts:289-381,352`; carriers `src/runtime/sse-conversation-filter.ts:46` |
| Extension LLM (Haiku) | `src/extensions/llm-handler.ts:160,316-364`; ceiling `src/extensions/bundled-ceiling.ts:235-244` |
| append-message (excluded!) | `src/extensions/append-message-handler.ts:112,289` |
| spawn-assignment (sub-conv) | `src/extensions/spawn-assignment-handler.ts:332` |
| runtime.* invoke registry | `src/extensions/runtime-invoke-handler.ts:139-159` |
| Slash-command expansion (literal) | `src/runtime/mention-wiring.ts:139-156`; discovery `commands/discovery.ts` |
| EZ-Actions pre-streamChat hook | `web/src/routes/api/conversations/[id]/messages/+server.ts:280-342,354` |
| EZ-Action registry / card type | `src/runtime/ez-actions/registry.ts`, `ez-actions/types.ts:46-81` |
| Goal-state store option (metadata) | `src/db/schema.ts:58-60` (`conversations.metadata`) |
| Token usage | `messages.usage` `schema.ts:95`; `obs:turn` `types.ts:294`; `run:usage` `types.ts:233` |
| SSE delivery (UI) | `web/src/routes/api/runtime-events/+server.ts:32-47,90-114` |
| State→UI (`ext:state`) | `src/extensions/state-mediator.ts:90`; `web/src/lib/components/ExtensionPanel.svelte` |
| Closest analog extension | `extensions/memory-extractor/` (`ezcorp.config.ts`, `index.ts:182,189,555`); bundled `src/extensions/bundled.ts:667-694,600-603` |
