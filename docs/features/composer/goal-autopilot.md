# /goal Autopilot

> _A conversation-scoped self-continuation loop: `/goal <condition>` arms a completion condition, and after every turn a cheap/fast model judges the transcript — "no" re-prompts the main conversation, "yes" clears the goal._

## Intent

`/goal` lets a user state a natural-language completion condition once and have the main conversation keep working — turn, evaluate, turn, evaluate — until the condition is met, cleared, or interrupted, with no per-step prompting. It replicates Claude Code's `/goal` behavior with one deliberate deviation: **interrupt pauses rather than hard-stops** (the condition is retained so resume is one message instead of retyping a possibly-4000-char condition). It is built as a host-side runtime controller plus an inline slash-prefix interceptor in the messages POST route — deliberately **not** an EZ-action, slash-command-registry entry, or extension, because none of those can carry a condition, re-enter `streamChat` on the main conversation, or survive subprocess idle-out and server restarts.

## How it works

The whole feature is one singleton host controller (`src/runtime/goal-host.ts`, class `GoalHost`) plus a few lines of interception in the send pipeline. There is no dedicated route.

### State model

- **Persisted (`conversations.metadata.goal` JSONB, no migration):** `PersistedGoal = { condition, lastReason, createdAt }`. **Key presence == armed; key deletion == disarm.** There is no `armed` boolean.
- **In-memory (`Map<conversationId, GoalRecord>`, never persisted):** `armedAt`, `turnsEvaluated`, `tokenAccumSinceArmed`, `evaluatorFailureCount`, `lastReason`, `status` (`"active" | "paused"`), `inFlightRunId`. Counters reset on resume/restart.
- **Canonical armed predicate** (`isGoalArmed`, the single definition): `metadata.goal` present **AND** a `GoalRecord` exists **AND** `record.status === "active"`. Pausedness lives only in the in-memory `status`, so a paused goal still has `metadata.goal` present and can be resumed.

### Command path (in the messages POST handler)

In `web/src/routes/api/conversations/[id]/messages/+server.ts`, in this order:

1. **FR-13b lazy rehydrate** — `goalHost.ensureGoalRecordRehydrated(conversationId, isGoalCmd)` runs unconditionally near the top, before the interceptor and before `streamChat`. It rebuilds a lost `GoalRecord` from `metadata.goal` (record lost on restart / created post-boot) and conditionally flips `paused → active` — but **suppresses that flip when the post is itself a `/goal …` command** (the parsed subcommand owns resume/clear/replace).
2. **User message row persisted** (with attachments if any).
3. **`/goal` interceptor** — gated on `isGoalCommand(body.content)` (the `/goal` token followed by EOS or whitespace; `/goalpost` does **not** match). `parseGoalCommand` dispatches to `goalHost.handleGoalCommand(...)`:
   - **`set`** (`/goal <cond>`) → validates ≤ 4000 chars, writes `metadata.goal`, creates the `GoalRecord` (`status:"active"`), emits `goal:update {state:"active"}`, returns `kind:"start-turn"`. The route **does not return** — it falls through to the normal `streamChat` call so a set behaves exactly like a normal user turn (same `runId`, same streaming response shape). The persisted user row keeps the literal `/goal <condition>` text for history fidelity.
   - **`status`** (`/goal` with empty rest) / **`clear`** (single-token alias) / **>4000-char reject** / **disabled** → returns `kind:"card"`; the route persists a `role:"ez-action-result"` row and returns `runId: null` (no LLM turn). This is a distinct early return, **not** the `![EZ:]` short-circuit.

### The autopilot loop (bus-driven)

`GoalHost.start()` (called once from `ensureInitialized()`) attaches **one consolidated subscription set** — `run:complete` / `run:error` / `run:cancel` — for the whole process, then runs a boot sweep (`bootSweep`, FR-13a) that rebuilds `GoalRecord`s for every conversation whose `metadata.goal` is present.

- **`onRunComplete`** is the core loop. For an armed conversation it: increments `turnsEvaluated`; checks for a pending user message (`dequeuePending` → steering supersedes the goal continuation); enforces the hard `maxGoalTurns` cap (default 50 → clear + "turn cap" card); then evaluates.
  - **Sentinel fast-path** (`detectSentinel`): if the last assistant message contains `<<TASK_DONE>>` → `achieved:true` for free; `<<TASK_BLOCKED:…>>` → `achieved:false` with the reason surfaced. Shares the regexes in `src/runtime/sentinels.ts` with `start-assignment.ts`.
  - Otherwise the **evaluator** runs: `resolveEvaluatorModel` picks a cheap model (`CHEAP_MODEL_BY_PROVIDER` in `src/lib/cheap-models.ts`, provider-matched with a fallback chain `anthropic → openai → google → ollama`; no model → pause "No evaluator model available"). `invokeEvaluator` builds a strict-JSON `{achieved, reason}` call via the shared `piComplete` wrapper (`src/lib/pi-complete.ts`), `temperature:0`, `maxTokens:512`, 30 s timeout, **no tools**, over the last 20 transcript messages (`buildEvaluatorTranscript`).
  - **Defensive parse** (`parseEvaluatorResponse`): any malformed/empty/non-conforming response collapses to `achieved:false, parseFailed:true` — the host never trusts a non-conforming response to clear a goal. Three consecutive parse/timeout failures → pause.
  - **`achieved:true`** → delete `metadata.goal`, drop the record, persist an "achieved" card row, emit `goal:update {off}`.
  - **`achieved:false`** + still armed + under cap → mint a fresh `runId`, re-enter `executor.streamChat(conversationId, buildContinuationPrompt(reason), { runId })`, emit `goal:update {active}`. Back to the top on the next `run:complete`.
- **`onRunTerminal`** (`run:error` / `run:cancel`): **always pauses without evaluating** (`status="paused"`, persist a "paused" card, emit `goal:update {paused}`). A watchdog kill is a plain `run:error` — there is deliberately **no substring match**. `metadata.goal` stays present so a later post can resume it.

### Transcript fidelity & indicator

Status / achieved / cleared / paused / reject / disabled outcomes are persisted as `role:"ez-action-result"` rows (the row *convention* is reused, not the EZ handler/registry). `web/src/lib/components/goal-row-logic.ts` (`inferGoalKind`) classifies each row from its host-defined English **title prefix** into `status | achieved | cleared | paused | rejected`, and `ChatMessage.svelte` stamps `data-goal-row` / `data-goal-kind` on the rendered card for styling + deterministic e2e selectors. The `goal:update` bus event is allowlisted for SSE delivery (`RUNTIME_EVENT_NAMES` / `BUS_EVENTS`) and conversation-filtered (`DIRECT_CARRIER_EVENT_TYPES`).

## Usage

- **Set:** post `/goal <condition>` to `POST /api/conversations/[id]/messages` (scope `chat`). Starts a turn immediately; replaces any active goal (silent supersede). Condition ≤ 4000 chars (post-trim) or rejected with an inline error card.
- **Status:** post `/goal` (no argument, or only whitespace) → status card (condition, status, elapsed, turns evaluated, token spend since armed, latest evaluator reason). No LLM turn.
- **Clear:** post `/goal <alias>` where alias ∈ `{clear, stop, off, reset, none, cancel}` (case-insensitive, single token) → removes the goal. No LLM turn. `/goal CLEAR something` (multi-token) parses as **set**, not clear.
- **Interrupt:** Stop / Ctrl-C cancels the in-flight turn (`run:cancel`) → goal **pauses** (not cleared). The next ordinary user message (or `/goal <same condition>`) resumes it; `/goal clear` drops it.
- **Resume:** any non-`/goal` user turn against a conversation with a present `metadata.goal` flips `paused → active` via the lazy rehydrate. A `/goal status` / `/goal clear` POST never auto-resumes (the subcommand decides).
- **Env var:** `EZCORP_GOAL_ENABLED` (default ON; only `0`/`false`/`off`/`no` disables). When off, `GoalHost.start()` no-ops, no subscriptions/sweep attach, and `/goal` returns a "disabled" card.
- **Host constants (tunable in code):** `DEFAULT_MAX_GOAL_TURNS` (50), `EVALUATOR_TRANSCRIPT_WINDOW` (20), `EVALUATOR_TIMEOUT_MS` (30 000), `EVALUATOR_MAX_OUTPUT_TOKENS` (512), `EVALUATOR_FAILURE_THRESHOLD` (3), `MAX_GOAL_CONDITION_LENGTH` (4000).

## Key files

- `src/runtime/goal-host.ts` — the whole controller: `GoalHost` class (loop, evaluator, persistence, boot/lazy rehydrate), `isGoalCommand` / `parseGoalCommand`, `isGoalArmed`, `parseEvaluatorResponse`, `detectSentinel`, `resolveEvaluatorModel`, `computeTokenSpendSinceArmed`, card builders, `parseGoalEnabled`, `initGoalHost` / `getGoalHost` singleton.
- `web/src/routes/api/conversations/[id]/messages/+server.ts` — inline `/goal` rehydrate hook + slash-prefix interceptor (no dedicated route).
- `web/src/lib/server/context.ts` — `initGoalHost({ bus, executor, enabled: parseGoalEnabled(...) })` + `goalHost.start()` in `ensureInitialized()`; `getGoalHost()` returns `GoalHost | null`.
- `web/src/lib/components/goal-row-logic.ts` — `inferGoalKind` title-prefix → kind classifier for persisted goal rows.
- `web/src/lib/components/ChatMessage.svelte` — renders goal `ez-action-result` rows with `data-goal-row` / `data-goal-kind`.
- `src/lib/cheap-models.ts` — `CHEAP_MODEL_BY_PROVIDER` (Haiku / flash-lite / gpt-4o-mini / gemma — one model per provider family), shared with the memory compaction merge (`src/memory/compaction.ts`).
- `src/lib/pi-complete.ts` — shared host-side pi-ai `complete()` wrapper used by the evaluator.
- `src/runtime/sentinels.ts` — `TASK_DONE_RE` / `TASK_BLOCKED_RE`, shared with the sub-agent autopilot loop.
- `src/types.ts` — `AgentEvents["goal:update"]` payload (`{ conversationId, state, condition?, armedAt?, turnsEvaluated?, lastReason? }`).
- `web/src/lib/runtime-event-names.ts` — `goal:update` in `RUNTIME_EVENT_NAMES` (re-exported as `BUS_EVENTS`).
- `src/runtime/sse-conversation-filter.ts` — `goal:update` in `DIRECT_CARRIER_EVENT_TYPES` (per-subscriber conversation filtering).
- `docs/plans/2026-05-17-goal-feature-prd.md` — the full PRD (FR/decision/reliability tables).

## Features it touches

- [[conversations]] — `/goal` is intercepted inline in the conversation send pipeline; state rides in `conversations.metadata.goal`.
- [[streaming-runtime]] — a `set` and every continuation re-enter `executor.streamChat`; the evaluator runs after each `run:complete`.
- [[runs-lifecycle]] — the loop subscribes to `run:complete` / `run:error` / `run:cancel`; `run:error`/`run:cancel` always pause.
- [[providers-and-models]] — the evaluator resolves a cheap model + credential per the conversation's provider, with a fallback chain.
- [[ez-concierge-and-actions]] — `/goal` deliberately reuses only the `ez-action-result` *row persistence* convention, not the EZ-action handler/registry; it sits beside the `![EZ:]` scan in the route.
- [[mention-grammar]] — `/goal` is a line-leading command, distinct from the five composer mention sigils (`! @ / $ %`); it owns the entire message.
- [[slash-commands]] — `/goal` is **not** a registry slash command (those are literal prompt substitution); it is a host-side interceptor that runs server logic.
- [[message-toolbar]] — goal outcome cards render in the transcript like other `ez-action-result` rows.
- [[api-security]] — the interceptor inherits the messages route's `requireAuth` + root-walk ownership gate before it runs.
- [[context-compaction]] — the evaluator's transcript window (`messages.slice(-20)`) is independent of the main turn's per-model context trimming.

## Related docs

- [docs/features/chat/conversations.md](../chat/conversations.md) — the send pipeline that hosts the `/goal` interceptor (step ordering, ownership, `![EZ:]`).
- [docs/plans/2026-05-17-goal-feature-prd.md](../../plans/2026-05-17-goal-feature-prd.md) — the primary design reference (functional requirements, reliability matrix, decisions D1–D12).

## Notes & gotchas

- **No `/goal-state` route.** All `/goal` handling is inline in `messages/+server.ts`; state lives in `metadata.goal` JSONB + the in-memory `Map` + a `goal:update` SSE event. Don't look for a dedicated endpoint.
- **Active-run IDOR is OPEN and relevant.** A goal self-drives turns whose runs are pollable/cancellable via `GET`/`POST /api/conversations/[id]/active-run`, which call only `requireAuth` + `requireScope` with **no** conversation-ownership check (SvelteKit does not wrap a child `+server.ts` in a parent guard). Any authenticated user can poll or cancel another user's live goal run cross-tenant. Treat as a known open finding, not fixed.
- **Counters reset on resume/restart by design.** `armedAt`, `turnsEvaluated`, and `tokenAccumSinceArmed` live only in the rebuilt `GoalRecord`, so elapsed time, turn count, and "token spend since armed" all reset to ~0 after a restart — the condition (and `lastReason`) carry. Token spend is **token counts** (`messages.usage.inputTokens + outputTokens`), not currency; there is no cost field.
- **Watchdog kill = plain `run:error`.** Detection is purely "any `run:error`/`run:cancel` → pause without evaluating" — there is intentionally no `"Watchdog"` substring match (brittle, removed in design).
- **Set falls through, it does not early-return.** `kind:"start-turn"` returns the standard streaming JSON (`runId` non-null); only `kind:"card"` returns `runId:null`. A reviewer expecting a card-only response for every `/goal` post would be wrong.
- **No shipped `◎` chip / live SSE consumer yet.** Phase 1 is host-only; the `goal:update` event is wired through the SSE allowlist and the `data-goal-kind` row markup exists, but there is no header chip component or chat-page `goal:update` listener in the tree. The status card (`/goal`) is the user-facing inspection surface.
- **Disabled-card has two producers (by different paths).** When the flag is OFF the host still constructs (`initGoalHost` is called unconditionally in `context.ts`), so `getGoalHost()` returns a non-`null` *disabled* host and `handleGoalCommand` returns the disabled card via its `kind:"card"` branch. `getGoalHost()` returns `null` only on an **init race** (server not yet initialized) — and only then does the route build the disabled card itself via `buildDisabledCard()` rather than crashing the chat path. Both producers call the same `buildDisabledCard()` — one source of truth for the message body. (Note: the `context.ts` doc-comment claims `getGoalHost()` returns `null` "when EZCORP_GOAL_ENABLED was off" — that comment is stale; the code path above is authoritative.)
- **Transcript source is `getMessages`, not `getConversationPath`.** The shipped `onRunComplete` fetches the conversation's messages via the injectable `getMessagesFn` (default `convQueries.getMessages`); the PRD's earlier `getConversationPath` note describes intent, not the final code.
- **Not unified with the sub-agent loop.** `start-assignment.ts`'s `autonomousContinuation` (sub-conversation + `<<TASK_DONE>>` sentinel, `maxCycles=8`) is a deliberately separate, 100%-gated module. `/goal` is the main conversation + cheap-model evaluator with `maxGoalTurns=50`. A shared `RunCompletionLoop` extraction is explicitly post-v1.
- **Continuation turns inherit full identity.** A goal continuation runs with the same user, project, `agentConfigId`, `modeId`, and per-tool-call permission scope as a normal turn — no privilege escalation, and permission prompts still apply each turn.
