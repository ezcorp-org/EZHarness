# PRD — `/goal`: Session-Scoped Completion-Condition Autopilot for the EZCorp Harness

**Status:** Draft for review · **Date:** 2026-05-16 · **Branch:** `main`
**Author:** PRD agent · **Grounding doc:** [`tasks/goal-feature-research.md`](goal-feature-research.md)

---

## 1. Title & One-Line Summary

Add a `/goal <condition>` capability to the EZCorp harness that sets a
session-scoped completion condition, then keeps the main conversation
working turn-after-turn — re-prompting itself, judged by a small/fast
model after every turn — until the condition is met, cleared, or
interrupted. **Behaviorally matches Claude Code's `/goal`, with one
deliberate, documented deviation: interrupt → pause (not hard-stop)
— see decision D8.**

---

## 2. Background & Motivation

### 2.1 What `/goal` is

Claude Code's [`/goal`](https://code.claude.com/docs/en/goal) is a
session-scoped autopilot. The user states a completion *condition* in
natural language; the harness then drives the conversation forward
without the user prompting each step. After **every** turn finishes, a
small/fast model is shown the condition + the conversation so far and
returns **yes/no + a short reason** (it does not call tools or read
files — it judges only what the main model surfaced in the transcript).
"no" starts another turn with the reason fed back as guidance; "yes"
clears the goal and records an "achieved" entry in the transcript.
Claude Code implements it as a wrapper around a session-scoped,
prompt-based **Stop hook**.

### 2.2 Why EZCorp wants it

EZCorp is a self-hosted multi-model chat platform whose differentiators
are extensibility, security (RBAC + per-tool-call permissions), and
reliability (safe migrations, durable single-container deploy). A
long-running, self-driving "work until done" mode is a high-leverage
agentic capability — but only if it survives the harness's real failure
modes (turn errors, watchdog kills, server restarts, Ctrl+C). The user's
explicit bar is **"a solution that will work 100% of the time for our
situation."** This PRD's central job is to meet that bar, not to pick
the most superficially extension-shaped packaging.

### 2.3 The behavior we are matching (verbatim contract)

- `/goal <condition>` sets a session-scoped completion condition and
  **starts a turn immediately** with the condition as the directive.
- After each turn finishes, a small/fast model gets the condition +
  conversation; returns yes/no + short reason; **no tools, no file
  reads** — judges only the transcript.
- "no" → new turn auto-starts, reason fed back as guidance; "yes" →
  goal clears, "achieved" entry recorded in transcript.
- Subcommands: `/goal <cond>` = set (replaces active goal); `/goal`
  (no arg) = status; `/goal clear` = remove early. Clear aliases:
  `stop`, `off`, `reset`, `none`, `cancel`. New conversation clears it.
- One goal per session, session-scoped. Restored on resume/continue
  (condition carries; turn count, timer, token baseline reset).
  Achieved/cleared goals NOT restored.
- Condition ≤ 4000 chars. User may bound runtime in the condition
  ("or stop after 20 turns"); model self-reports, evaluator judges from
  the conversation.
- UI: `◎ /goal active` indicator with elapsed time; status view +
  transcript show the latest evaluator reason.
- Works interactive, non-interactive/headless (`-p`), desktop, remote.
  Ctrl+C / interrupt stops a non-interactive goal.

---

## 3. Goals / Non-Goals

### 3.1 Goals

- **G1.** Replicate the Claude Code `/goal` behavior contract in §2.3,
  including the set-starts-a-turn-immediately semantics. **One
  intentional deviation:** interrupt pauses (not hard-stops) the goal
  (decision D8) — every other behavior matches.
- **G2.** Meet the **100%-reliability bar**: no silent stall on turn
  failure, watchdog kill, server restart, or concurrency race.
- **G3.** Ship the inspect/clear surface (status card, `◎` indicator,
  achieved/cleared transcript entries) **in v1**, never deferred —
  per the "curation UI is v1 floor" project memory note.
- **G4.** Reuse the harness's already-shipped autopilot primitive
  (`startAssignment`'s `run:complete` re-prompt loop) rather than
  inventing a parallel mechanism.
- **G5.** 100% unit + integration + e2e (Playwright) coverage,
  CI-gated per-file on new paths — per the project test bar.
- **G6.** Mode-agnostic: interactive, headless `-p`, remote all work
  through the same path with no special-casing.

### 3.2 Non-Goals

- **NG1.** A generic Claude-Code-style hook framework. We build the
  one loop `/goal` needs, not a hook abstraction (research §3.7: no
  lighter substrate exists; building one duplicates `startAssignment`).
- **NG2.** Goals on sub-conversations / sub-agents. v1 is the user's
  **main** conversation only. (Sub-agents already have
  `autonomousContinuation`.)
- **NG3.** Multiple concurrent goals per conversation. Exactly one
  goal per conversation, set replaces.
- **NG4.** A user-authorable goal-evaluator-prompt customization
  surface in v1 (evaluator prompt is host-defined; revisit post-v1).
- **NG5.** Cross-conversation / project-wide goals.
- **NG6.** Letting the evaluator call tools or read files (explicit
  contract: judges transcript only).
- **NG7.** Unifying `/goal`'s loop with the shipped sub-agent
  `autonomousContinuation` loop (`cdf8422`). The two are *deliberately
  parallel* — sub-agent + working-model `<<TASK_DONE>>` sentinel vs.
  main-conversation + cheap-model evaluator. A shared
  `RunCompletionLoop` extraction is sound but explicitly **post-v1**
  (decision D12), to avoid destabilizing a just-shipped, 100%-gated
  `start-assignment.ts`.

---

## 4. Glossary

| Term | Definition |
|---|---|
| **Condition** | The natural-language completion criterion the user passes to `/goal`. ≤ 4000 chars. Persisted verbatim; carried across resume. |
| **Turn** | One `executor.streamChat()` invocation == one `runs` row (`src/runtime/executor.ts:355`; `src/db/schema.ts:23`). Begins with `run:start`, ends with exactly one of `run:complete` / `run:error` / `run:cancel`. |
| **Evaluator** | The small/fast model call made *after* a turn completes. Input: condition + transcript. Output: `{ achieved: boolean, reason: string }`. No tools, no file reads. |
| **Autopilot loop** | The host-side controller that subscribes to turn-completion, runs the evaluator, and on "no" re-enters `streamChat` with a continuation prompt. Modeled on `startAssignment` (`src/runtime/start-assignment.ts:307-366`). |
| **Armed conversation** | A conversation that satisfies the **canonical armed predicate** (defined once, referenced everywhere): `metadata.goal` is present (key exists, not deleted) **AND** the in-memory `GoalRecord` exists with `status === "active"`. The loop only acts on armed conversations. Clearing = **deleting** `metadata.goal` (deletion *is* the disarm — there is no separate `armed:false` flag). |
| **Slash-prefix interceptor** | The new code path (NOT the EZ-action registry) that detects a `/goal`-prefixed `body.content` in the messages POST handler and dispatches to the goal parser. Sits at the *same location* in the route as the EZ-action scan, but is a distinct, non-nullary mechanism (see §7.2.1). |
| **Continuation prompt** | The terse re-prompt injected as the next turn's user message when the evaluator returns "no", carrying the evaluator's reason as guidance. |
| **Session** | EZCorp has no separate session entity. The unit is the **conversation** (`conversations` table, `schema.ts:43`). "Session-scoped" == "conversation-scoped". "Resume/continue" == reopening a conversation + POSTing the next message. |
| **Goal-host** | The new server-side module (`src/runtime/goal-host.ts`), a sibling of `start-assignment.ts`, that owns the loop, the evaluator, state persistence, and boot rehydration. |

---

## 5. User Stories / UX

### 5.1 Set a goal — `/goal <condition>`

> As a user, I type `/goal keep refactoring the auth module until all
> tests pass and lint is clean, or stop after 20 turns`. The harness
> immediately starts a turn with that condition as the directive (no
> separate "ok, starting" turn). The `◎ /goal active` chip appears in
> the chat header with a live elapsed timer. I do nothing; the harness
> keeps working — turn, evaluate, turn, evaluate — until done.

- Setting a goal **replaces** any active goal on that conversation
  (silent supersede; old goal's in-flight loop is detached).
- The condition line is the first turn's directive verbatim.
- A condition > 4000 chars is rejected with an inline error card; no
  goal is armed, no turn starts.
- An empty condition (`/goal` with only whitespace) is treated as the
  **status** subcommand (§5.2), not an error.

### 5.2 Check status — `/goal` (no argument)

> As a user, I type `/goal` and get a card showing: the active
> condition, elapsed time since armed, turns evaluated, token spend
> since armed, and the evaluator's latest reason. If no goal is active,
> the card says so.

Status card fields (FR-9):

| Field | Source |
|---|---|
| Condition | `metadata.goal.condition` |
| Status | `active` / `none` (and `paused` if a turn failed — §8 R2) |
| Elapsed | `now − inMemory.armedAt` (timer resets on resume) |
| Turns evaluated | `inMemory.turnsEvaluated` (resets on resume) |
| Token spend (since armed) | `inMemory.tokenAccumSinceArmed` — **single source of truth** (FR-9): the SQL aggregation defined in FR-9 over `messages.usage` (`{inputTokens, outputTokens}` only — **no cost field**, `schema.ts:95`) for messages whose `runId` joins a `runs` row with `runs.createdAt ≥ armedAt` (`schema.ts:32`). **Resets to 0 on resume/restart**, consistent with the timer/turn reset. |
| Latest evaluator reason | `metadata.goal.lastReason` |

The status response is **persisted as a `role:"ez-action-result"`
message row** (FR-19 — the *row convention* is reused for transcript
fidelity) but is produced by the **slash-prefix interceptor's status
branch, NOT an `EzAction` handler**. The status/clear branches return a
card and **do NOT call `streamChat`** (no LLM turn). They do **not**
use the EZ-action short-circuit at `messages/+server.ts:328` — they are
a distinct return path in the new interceptor (see §7.2.1, §7.5).

### 5.3 Clear a goal — `/goal clear` and aliases

> As a user, I type `/goal clear` (or `stop` / `off` / `reset` /
> `none` / `cancel`) and the active goal is removed. A "cleared"
> entry is recorded in the transcript. No LLM turn fires.

- Clear aliases (case-insensitive, trimmed): `clear`, `stop`, `off`,
  `reset`, `none`, `cancel`.
- Clearing a non-existent goal is a silent no-op card ("No active
  goal").
- Clear is **immediate** and is **exactly one operation**: it
  **deletes `metadata.goal`** and removes the in-memory `GoalRecord`.
  Deletion *is* the disarm (canonical armed predicate, §4 Glossary) —
  there is no "set `armed:false` then delete" two-step. The
  goal-host's single consolidated subscription stays attached (it
  serves all conversations, FR-17); the next `run:complete` for this
  conversation simply fails the armed predicate and is ignored. A turn
  already in flight when clear is issued is allowed to finish but is
  **not** re-entered, because the loop's post-turn re-entry check
  re-evaluates the canonical armed predicate (FR-12.2, FR-18).

### 5.4 Goal achieved (automatic)

> The evaluator returns "yes". The goal clears, and an "achieved" entry
> with the evaluator's final reason is recorded in the transcript. The
> `◎` chip disappears. No further turns start.

The achieved entry is an `ez-action-result` card (`kind:"goal-achieved"`)
persisted as a message row, so it survives reload and renders in the
transcript like `/goal status`.

### 5.5 New conversation clears the goal

> Starting a new conversation has no goal (goal state is keyed by
> `conversationId`; a new conversation has no `metadata.goal`). Nothing
> to clear — the absence is the cleared state.

### 5.6 Resume / continue

> I reopen a conversation that had an active goal yesterday and post a
> message. The goal **condition carries over** and the loop re-arms.
> The turn count, elapsed timer, and token baseline **reset** (per
> spec). An achieved or cleared goal does NOT come back (its
> `metadata.goal` was deleted on achieve/clear).

**Rehydration has two distinct, independently-required parts** —
"re-attach the bus listener" and "rebuild the in-memory `GoalRecord`"
are NOT the same thing and both are mandatory:

- **Part 1 — bus subscription (process-global, one-time).** The
  goal-host owns a *single consolidated* subscription set
  (`run:complete`/`run:error`/`run:cancel`, FR-17). It is attached
  once at `goalHost.start()` (called from `ensureInitialized()`,
  decision D9) and stays attached for the process lifetime. There is
  **no per-conversation listener to re-attach** — the subscription is
  not lost per-conversation, only the *in-memory `GoalRecord`* is.
- **Part 2 — in-memory `GoalRecord` rebuild (per-conversation).** A
  `GoalRecord` is the thing lost on restart. It MUST be rebuilt from
  `metadata.goal` via two triggers (FR-13):
  1. **FR-13a Boot sweep:** on server start, after `goalHost.start()`,
     scan conversations with a present `metadata.goal` and rebuild
     each `GoalRecord` with `status:"active"`, `armedAt:now`,
     `turnsEvaluated:0`, `tokenAccumSinceArmed:0` (counters reset per
     spec; condition carries). Modeled on
     `executor-watchdog.startOrphanCleanup` (`src/runtime/
     executor-watchdog.ts:123`).
  2. **FR-13b Lazy on POST (the critical gap-closer):** a helper
     `ensureGoalRecordRehydrated(conversationId)` MUST be called
     **unconditionally near the top of the messages POST handler,
     before `streamChat` and before the slash-prefix interceptor**
     (so it covers a *normal user message* that resumes a conversation
     whose goal was armed before a restart but the boot sweep raced /
     the conversation was created after boot). If `metadata.goal` is
     present and no in-memory `GoalRecord` exists, rebuild it
     (same reset semantics as FR-13a). This guarantees that even if
     the user's first post-resume message is an ordinary turn (not
     `/goal …`), that turn's `run:complete` is evaluated, because the
     `GoalRecord` exists before the turn starts.

### 5.7 Interrupt (Ctrl+C / Stop button / headless abort)

> I press the Stop button (or Ctrl+C in headless). The in-flight turn
> cancels (`run:cancel`). The goal is **paused, not cleared** (decision
> D8): the `◎` chip shows a paused state, the loop does NOT auto-start
> another turn. My next manual message, or an explicit `/goal <same
> condition>`, resumes it. `/goal clear` removes it entirely.

**This is a deliberate, documented deviation from Claude Code parity.**
Claude Code's spec says Ctrl+C "stops" a non-interactive goal (a hard
stop). EZCorp instead **pauses** (condition retained). The loop itself
*does* stop immediately on interrupt (no auto-continue into a turn the
user just killed — research R5/R6, "steering wins"), so the
safety-critical behavior matches; the deviation is purely that the
condition is *retained* rather than *destroyed*, so resume is one
message instead of retyping a possibly-4000-char condition. This is
strictly safer (default-to-stop on uncertainty, S5) and better UX. A
second consecutive interrupt, or `/goal clear`, hard-clears.

**Resuming a paused goal:**
- **Interactive / desktop / remote:** the user's next manual message,
  or an explicit `/goal <same condition>` (re-set), flips the
  `GoalRecord` back to `status:"active"`; the loop resumes evaluating
  from the next `run:complete`.
- **Pure headless `-p` (no interactive session to "resume"):** there
  is no live session to type into. A paused goal in `-p` is resumed by
  the **next `-p` invocation that targets the same conversation** —
  whether it carries a `/goal <same condition>` (explicit re-set) or
  an ordinary prompt. For an *ordinary* (non-`/goal`) prompt the
  FR-13b lazy rehydrate transitions `paused → active` because
  `metadata.goal` is still present. For a prompt that **is** a
  `/goal …` command, FR-13b deliberately does **not** auto-flip:
  `/goal <same condition>` re-activates via the interceptor (explicit
  re-set), `/goal status` reports the paused state *without* resuming,
  and `/goal clear` hard-clears — the resume/clear decision is owned
  by the parsed subcommand, never by the rehydrate helper. If the
  operator wants the goal gone in headless, they issue a `-p` message
  containing `/goal clear`.
  Documented limitation: there is no Ctrl+C-then-auto-resume in a
  single `-p` process — `-p` is one-shot by nature; resume is always
  "the next invocation against that conversation".

### 5.8 Headless / non-interactive (`-p`) and remote

> Headless and remote turns flow through the same
> `executor.streamChat` + `EventBus` path (research §3.8 #6). The
> goal-host is a server-side bus subscriber, so it is **mode-agnostic**
> with zero special-casing. Ctrl+C in `-p` emits `run:cancel` for the
> armed conversation → loop pauses (§5.7).

### 5.9 The `◎ /goal active` indicator

A chip in the chat header (`◎ /goal active · 4m12s`) with a live
elapsed timer, plus a paused variant (`◎ /goal paused`). Clicking it
opens the status card. Reason latest text is shown in the status card
and the transcript entries — not crammed into the chip.

> **Distinct from the sub-agent autopilot indicator.** The shipped
> `autonomousContinuation` feature (`cdf8422`) renders a `↻ n/m`
> cycle counter on `AssignmentPill.svelte` (testid
> `autonomous-cycle`) for **sub-agent** runs. `/goal`'s `◎` chip is
> a separate component on a separate surface (the main chat header)
> and intentionally shows elapsed time, not an n/m counter. The two
> autopilot indicators must remain visually and structurally
> distinct so users/QA never conflate a sub-agent loop with a
> main-conversation goal.

---

## 6. Functional Requirements

Numbered, testable. Each maps to a test scenario in §11.

### Command parsing & interception

- **FR-1.** `/goal` is **NOT** an EZ-action and is **NOT** a
  slash-command-registry entry. The EZ-action machinery cannot carry
  it: `stripEzActionTokens` (`src/runtime/mention-wiring.ts:321-345`)
  matches **only** `![EZ:name]` tokens (regex `EZ_ACTION_TOKEN_RE`),
  there is no `/goal`-prefix path; `EzAction.handler` is **nullary** —
  `(ctx: EzActionContext) => Promise<EzActionResult>`
  (`src/runtime/ez-actions/types.ts:34-95`), so it has **no channel
  for the ≤4000-char condition** and **cannot call `streamChat`**; and
  the action-only short-circuit (`messages/+server.ts:328`) returns
  *without* `streamChat`, the **opposite** of set-starts-a-turn.

  Implementation: a **new slash-prefix interceptor** — a dedicated
  check + parser placed in the messages POST handler at the **same
  location as, but immediately BEFORE, the EZ-action scan** (the
  EZ-action scan begins at `web/src/routes/api/conversations/[id]/
  messages/+server.ts:265`, after the user message is persisted at
  `:257-263`, before `streamChat` at `:354`). The interceptor:
  1. Tests `body.content.trimStart()` for the literal prefix `/goal`
     followed by end-of-string or whitespace (so `/goalish` does NOT
     match — the prefix must be the token `/goal`).
  2. If matched, parses (FR-2), dispatches to a **new non-nullary
     goal handler** whose signature is `(input: { subcommand:
     "set"|"status"|"clear"; condition?: string; conversationId:
     string; userId: string; projectId: string }) => Promise<Goal
     DispatchResult>` — explicitly **unlike** `EzAction` (carries the
     condition; returns a result that can request a streaming turn).
  3. Branches by subcommand (FR-2): **set** falls through to the
     normal `streamChat` path (FR-2-SET / B2, see §7.2.1 + §7.5);
     **status** and **clear** return a card and short-circuit
     **without** `streamChat` via a *new* return path in the
     interceptor (NOT the EZ short-circuit at `:328`).

  See §7.2 for why this is a host code path and not a user extension
  or the slash-command registry.
- **FR-2.** Parse grammar, applied to `rest = body.content.trim()`
  with the leading `/goal` token removed and the remainder trimmed:
  - `rest` empty → **status**.
  - `rest` is exactly one token (no internal whitespace) and that
    token lowercased ∈ {`clear`,`stop`,`off`,`reset`,`none`,`cancel`}
    → **clear**.
  - any other non-empty `rest` → **set**, `rest` (already trimmed) is
    the condition (may be multi-line / a paragraph).
- **FR-2-SET (set falls through to streaming).** On **set**: the
  interceptor (a) validates ≤4000 chars (FR-3), (b) writes
  `metadata.goal` + creates the in-memory `GoalRecord`, (c) emits
  `goal:update {state:"active"}`, then (d) **does NOT return early** —
  it lets control fall through to the existing normal `streamChat`
  invocation at `messages/+server.ts:354`, passing the condition
  text as the turn's user message. The route returns the **normal
  streaming response shape** (FR-2-RET). This is the only way
  set-starts-a-turn-immediately is achievable (B2).
- **FR-2-RET (return shape for set).** On **set**, the route MUST
  return the **identical JSON shape a normal turn returns**
  (`messages/+server.ts:376-384`): `{ userMessage, runId (NON-null),
  attachments, ezActionResults: [] }`. It MUST NOT return an
  `ezActionResults`-card-only / `runId:null` payload. The SSE client
  learns the turn started exactly as for any normal message: it
  receives the non-null `runId` in the POST response and then consumes
  `run:*` SSE frames for that `runId` (the standard streaming-turn
  client path — unchanged). The persisted `user` message row for the
  set turn is the existing user-message row created at
  `messages/+server.ts:257-263` (its `content` is the original
  `/goal <condition>` text, for history fidelity), exactly as a
  normal message.
- **FR-3.** A set condition > 4000 chars (post-trim, by JS string
  `.length`) MUST be rejected by the interceptor: an
  `ez-action-result` error-card row is persisted (row convention
  reuse, FR-19), **no `metadata.goal` written, no `GoalRecord`
  created, no `streamChat`** (status/clear-style early return,
  `runId:null`).
- **FR-4.** `/goal` always owns the **entire** message: a message
  whose trimmed content starts with the `/goal` token is treated
  wholly as a goal directive (set/status/clear). There is no
  "mixed mode" and no EZ-style token embedding. A `/goal …` whose
  remainder is a paragraph is **set** with the full remainder as the
  condition. (Distinct from EZ-actions, which are embedded tokens
  inside otherwise-normal prose — `/goal` is a line-leading command.)

### The evaluator

- **FR-5.** After every turn of an armed conversation completes
  (`run:complete` for that conversation's run), the goal-host MUST
  invoke the evaluator: a single small/fast-model call, host-side,
  via `resolveModel` (`src/providers/router.ts`) + `getCredential`
  (`src/providers/credentials.ts`) + `@mariozechner/pi-ai`'s
  `complete()` — the exact host-side cheap-model path used by
  `src/extensions/llm-handler.ts:316-364` and `src/memory/extraction.ts`.
  **No subprocess hop** (avoids the idle-out cliff — §8 R1).
- **FR-6.** The evaluator model defaults to the pinned Haiku/flash-lite
  triple, provider-matched to the conversation's provider (decision
  D5):
  ```
  anthropic → claude-haiku-4-5-20250514
  google    → gemini-2.0-flash-lite
  openai    → gpt-4o-mini
  ollama    → gemma4:e2b   (first available)
  ```
  (Same set as `memory-extractor`, `bundled.ts:681-686`.) If the
  conversation's provider has no cheap-model credential, fall back in
  order: conversation provider's cheap model → anthropic Haiku →
  any provider with a credential + a cheap model. If **none**
  available, the goal is **paused** with reason "No evaluator model
  available" surfaced in the status card (never silently stalls).
- **FR-7.** Evaluator input: a system prompt defining the contract +
  the condition + the **last N messages** of the conversation
  transcript (N defaults to 20, mirroring `memory-extractor`'s
  `messages.slice(-20)`; configurable host constant). Transcript
  fetched host-side by calling `convQueries.getConversationPath`
  (`src/db/queries/conversations.ts:468`) directly from `goal-host.ts`
  — this is a reusable query function, not coupled to any HTTP
  handler. (It happens to be called from the messages **GET** handler
  at `messages/+server.ts:57,69`; the **POST** handler does not use
  it. The goal-host calls the query function itself.) Tool-call blocks
  are stripped (text-only, matching `llm-handler.ts` tool-block drop).
- **FR-8.** Evaluator output contract: the model is instructed to
  return strict JSON `{"achieved": <true|false>, "reason": "<≤280
  chars>"}`. The host parses defensively: a non-parseable / malformed
  response is treated as `achieved:false` with
  `reason:"evaluator returned an unparseable response; continuing"` AND
  increments a per-goal `evaluatorFailureCount`; **3 consecutive
  evaluator failures pause the goal** (anti-garbage-loop, §8 R6).
  The evaluator never calls tools (the call passes no tools — matches
  `llm-handler.ts:407-413`).

### Status accounting

- **FR-9. Token spend — single source of truth (B4).** `messages.usage`
  is `jsonb().$type<{ inputTokens: number; outputTokens: number }>()`
  (`src/db/schema.ts:95`) — **there is NO cost field**; spend is
  reported as **input+output token counts**, not currency. The
  canonical computation (NOT "either/or") is:

  > **`tokenSpendSinceArmed` = the SQL aggregation:** sum
  > `(messages.usage->>'inputTokens')::int +
  > (messages.usage->>'outputTokens')::int` over all `messages` rows
  > where `messages.conversationId = :conversationId` AND
  > `messages.runId` joins a `runs` row whose `runs.createdAt ≥
  > :armedAt` (`runs.createdAt`, `src/db/schema.ts:32`).

  This SQL is the authoritative value the status card shows. The
  in-memory `GoalRecord.tokenAccumSinceArmed` is an optimization
  cache, reconciled to the SQL value whenever `/goal` status is
  requested (so a missed `run:usage` event can never make the
  displayed number wrong). **Because `armedAt` resets on resume/
  restart (it lives only in the rebuilt `GoalRecord`, never
  persisted), `tokenSpendSinceArmed` deterministically resets to ~0
  after a restart** — consistent with the timer/turn-count reset
  (spec). `/goal` status returns the §5.2 fields with **no LLM turn**.
  This is testable: I12 asserts the SQL value; a B4 test asserts
  post-restart spend == 0.

### The autopilot re-entry loop

- **FR-10.** On evaluator `achieved:false` AND the goal still armed
  AND no superseding user message queued: the goal-host MUST re-enter
  `executor.streamChat(conversationId, continuationPrompt, …)` exactly
  as `startAssignment.startRun` does (`start-assignment.ts:279`), on
  the **main** conversation, with a fresh `runId`. The continuation
  prompt is terse and carries the evaluator's reason as guidance (the
  condition is re-pinned via the turn's system context, mirroring
  `start-assignment`'s `resolveSystem()` pin pattern, not re-sent in
  full each turn).
- **FR-11.** On evaluator `achieved:true`: clear the goal — **delete
  `metadata.goal`** (deletion *is* the disarm) and remove the
  in-memory `GoalRecord`. The single consolidated bus subscription
  stays attached (FR-17, it serves all conversations). Persist a
  `goal-achieved` `ez-action-result` row into the transcript (FR-19),
  emit `goal:update {state:"off"}` (FR-20). No further turns.
- **FR-12. Loop-stop conditions (the loop MUST terminate / pause on
  ANY of). The single re-entry gate is the canonical armed predicate
  (§4 Glossary): the loop re-enters `streamChat` *only if* `metadata.
  goal` is present AND the `GoalRecord` exists with
  `status === "active"`. Every condition below either deletes
  `metadata.goal` or sets `status="paused"`, which makes the predicate
  false and stops re-entry — there is no separate stop flag:**
  1. Evaluator `achieved:true` → **achieved** (delete `metadata.goal`).
  2. `/goal clear` / alias → **cleared** (delete `metadata.goal`).
  3. **Any `run:error` for the armed conversation's run** → **paused**
     (`status="paused"`), error surfaced; do NOT auto-continue
     (research R2).
  4. **Any `run:cancel` for the armed conversation's run** →
     **paused**; user pressed Stop / Ctrl+C — §5.7.
  5. **Watchdog kill is just case 3.** The watchdog emits a plain
     `run:error` with `error: <reason>`
     (`src/runtime/executor-watchdog.ts:323-325`) — **there is no
     reliable "Watchdog" substring to match and we MUST NOT
     string-match the reason** (brittle, reviewer B5). Detection is
     therefore simply: *any* `run:error` for the armed conversation's
     run → pause and do **NOT** run the evaluator (a failed/wedged
     turn has no useful transcript to judge — research §3.8 #2). i.e.
     the evaluator runs **only** on `run:complete`; `run:error` and
     `run:cancel` *always* pause without evaluating. This collapses
     R6 into R2 and removes the brittle check entirely.
  6. A self-bound clause in the condition ("or stop after N turns"):
     the model self-reports; the evaluator is told to return
     `achieved:true` when a user-stated bound is reached. As a hard
     backstop the host also enforces an absolute **`maxGoalTurns` cap
     (default 50, configurable)** — on cap, delete `metadata.goal`
     and persist a "reached turn cap" stopped entry (decision D6).
     Runaway-cost guardrail.
  7. The goal-host's own evaluator call has a hard timeout (default
     30s); on timeout it counts as an evaluator failure (FR-8) —
     3 consecutive → pause.

### State persistence & resume

- **FR-13.** Goal **condition** persists in
  `conversations.metadata.goal` JSONB (`schema.ts:60`, decision D3) —
  presence of the key *is* the persisted "armed" state (no separate
  boolean; deletion is disarm). Rehydration has **two independently-
  required, distinct parts** (B3):
  - **FR-13a — Boot sweep (rebuild records, not listeners).** On
    server start, after `goalHost.start()` attaches the *single*
    consolidated subscription (FR-17), scan conversations with a
    present `metadata.goal` and **rebuild each in-memory `GoalRecord`**
    (`status:"active"`, `armedAt:now`, `turnsEvaluated:0`,
    `tokenAccumSinceArmed:0` — counters reset per spec; condition
    carries). Modeled on `executor-watchdog.startOrphanCleanup`
    (`src/runtime/executor-watchdog.ts:123`). Note: there is **no
    per-conversation listener** to re-attach — the subscription is
    process-global and attached once (FR-17).
  - **FR-13b — Lazy rebuild on POST (the gap-closer, mandatory).** A
    helper `ensureGoalRecordRehydrated(conversationId)` MUST be invoked
    **unconditionally, near the top of the messages POST handler,
    before the slash-prefix interceptor AND before `streamChat`**
    (after ownership resolution, around `messages/+server.ts:123`).
    If `metadata.goal` is present and **no** in-memory `GoalRecord`
    exists for the conversation, it rebuilds the record (same reset
    semantics as FR-13a). It then conditionally flips a `paused`
    record back to `active`, **but the helper MUST NOT perform the
    `paused → active` flip when `body.content` is itself a `/goal …`
    command** (i.e. when it would be consumed by the slash-prefix
    interceptor). The flip happens only for a genuine, non-`/goal`
    user turn; for a `/goal` POST the helper rebuilds the record in
    its persisted state (`paused` stays `paused`) and the
    flip/clear/replace decision is **deferred to the interceptor and
    the parsed subcommand** (FR-12). This prevents `/goal status` from
    silently un-pausing a paused goal and prevents `/goal clear` from
    racing an implicit resume — `ensureGoalRecordRehydrated` therefore
    receives `body.content` (or a precomputed "is this a `/goal`
    command" boolean) so it can suppress the flip. Test I5b covers the
    non-`/goal` resume path; add test **I5d** asserting a `/goal
    status` / `/goal clear` POST against a `paused` conversation does
    NOT auto-resume it via the helper. **This is required precisely so
    that a
    resumed conversation whose first post-resume message is an
    ordinary user turn (NOT `/goal …`) still gets that turn's
    `run:complete` evaluated** — the `GoalRecord` must exist *before*
    the turn's `run:start`, which only FR-13b (running before
    `streamChat`) guarantees when the boot sweep raced or the
    conversation was created after boot. "Re-attach bus listener"
    (none — FR-17) and "rebuild in-memory `GoalRecord`" (FR-13a/b)
    are explicitly different operations; only the record rebuild is
    per-conversation.
  - Turn count / elapsed timer / token baseline are **NOT** persisted —
    in-memory `Map<conversationId, GoalRecord>`, reset on resume
    (spec).
- **FR-14.** Achieved or cleared goals: `metadata.goal` is **deleted**
  (the deletion is the disarm — there is no `armed:false` flag), so
  they are never rehydrated by FR-13a/b (matches spec: "achieved/
  cleared goals NOT restored"). A *paused* goal keeps `metadata.goal`
  present (so FR-13b can resume it).

### Token / turn / elapsed accounting

- **FR-15.** The in-memory per-conversation `GoalRecord` tracks:
  `armedAt`, `turnsEvaluated`, `tokenAccumSinceArmed`,
  `evaluatorFailureCount`, `lastReason`, `status` (`"active"` |
  `"paused"`), `inFlightRunId | null`. `lastReason` is also mirrored
  into `metadata.goal.lastReason` (so the status card is correct after
  a restart, before the timer/turn fields rebuild). The canonical
  armed predicate (§4) is: `metadata.goal` present **AND**
  `GoalRecord` exists **AND** `GoalRecord.status === "active"`.

### Multi-conversation isolation

- **FR-16.** The bus is a process-global singleton (`getBus()`,
  `context.ts:308`); every `run:complete` for every conversation fires
  on every listener. The goal-host MUST resolve the run's
  `conversationId` (from the `run:complete` payload's `conversationId`
  field, `finalize.ts:74`; fall back to `host.runConversations`) and
  **act only on armed conversations**, exactly like
  `start-assignment.ts:308`'s `if (data.run.id !== runId) return`
  guard generalized to "is this conversation armed?".
- **FR-17.** A single goal-host instance owns ONE consolidated
  subscription set (`run:complete`/`run:error`/`run:cancel`) and an
  internal `Map<conversationId, GoalRecord>`. It does **not** attach
  one listener per conversation (avoids listener leak; one dispatch
  point, O(1) armed-conversation lookup).

### Concurrency / re-entrancy

- **FR-18.** Per-conversation in-flight guard. Before the loop
  re-enters `streamChat` it MUST check, in this exact order:
  (1) the **canonical armed predicate** (§4 Glossary — the *single*
  predicate, identical to the one in FR-12/§5.3/R11; if false, stop —
  goal was cleared/achieved/paused mid-turn, R11), then
  (2) `GoalRecord.inFlightRunId === null` (no turn already running for
  this conversation). A fresh **user** message POSTed while the loop
  would otherwise re-enter **supersedes** the goal continuation
  (steering wins — mirrors `start-assignment.ts:312-331` pending-
  message precedence): the user's turn runs; on its `run:complete`
  the evaluator runs against the *new* transcript and the loop
  continues. There is exactly ONE armed-predicate definition used by
  FR-12.2, FR-18, §5.3, and R11 — no divergent inline predicates.

### Transcript & indicator

- **FR-19.** Status, "achieved", "cleared", "paused (reason)", and the
  >4000-char rejection are persisted as `role:"ez-action-result"`
  message **rows** (`content` = JSON of an `EzActionResult`-shaped
  card, persisted exactly like `messages/+server.ts:311-315` does for
  EZ-action results) so they survive reload and render via
  `ToolCardRouter`. **Only the row/card *persistence convention* is
  reused — NOT the `EzAction` handler dispatch or registry** (FR-1,
  §7.2.1). The goal interceptor writes these rows itself; it does not
  go through `getEzAction()` / the EZ scan loop.
- **FR-20.** The `◎ /goal active|paused` indicator + elapsed timer is
  delivered over SSE via a new first-class `goal:update` bus event
  (decision D7), added to: the `AgentEvents` interface
  (`src/types.ts:224`), the SSE `BUS_EVENTS` allowlist
  (`runtime-events/+server.ts:32`), and `DIRECT_CARRIER_EVENT_TYPES`
  (`src/runtime/sse-conversation-filter.ts`) so it is conversation-
  filtered per subscriber. Payload:
  `{conversationId, state:"active"|"paused"|"off", condition?,
  armedAt?, turnsEvaluated?, lastReason?}`.

---

## 7. Technical Design / Architecture

### 7.1 Why a pure user-installed extension cannot meet the 100% bar

The user asked for a "feature extension." We must be honest: a **pure
user-installed extension cannot meet the 100%-reliability bar**, for
four independently-fatal reasons grounded in the research:

1. **Subprocess idle-out drops `run:complete` (BLOCKER, research R1).**
   Extension event delivery is fire-and-forget *only if the subprocess
   is already running* (`event-subscription-dispatcher.ts:352`,
   `lifecycle-dispatcher.ts:142`: `getProcessIfRunning → null ⇒ silent
   drop`). The bundled `memory-extractor`/`lessons-distiller` work
   around this with `bootSpawn:true` + `persistent:true`
   (`bundled.ts:603,674`). **A user-installed (non-bundled) extension
   cannot set `bootSpawn`** → after 5 min idle its subprocess is
   killed and `run:complete` is silently dropped → the goal stalls
   forever with no error. This alone disqualifies a pure user
   extension.
2. **No extension API can start a main-conversation turn (BLOCKER,
   research R4).** All three turn-authoring surfaces fall short:
   `ezcorp/append-message` forces `role:"extension"` + `excluded:true`
   (`append-message-handler.ts:112,289`) so it never triggers an
   assistant turn; `ezcorp/spawn-assignment` spawns a *sub*-conversation
   (`spawn-assignment-handler.ts:332`), wrong transcript/UX; the
   `runtime.*` invoke whitelist (`runtime-invoke-handler.ts:139-159`,
   verified) has **no** `runtime.chat.*` method. Only host-side code
   (`messages/+server.ts:354`, `start-assignment.ts:279`) can re-enter
   `executor.streamChat` on the main conversation.
3. **Server-restart disarm (research R3).** An in-memory subscription
   in a subprocess is lost on restart with no rehydration hook.
4. **Slash commands are literal prompt substitution (research R9,
   §3.3).** `applyCommandExpansion` (`mention-wiring.ts:139-156`)
   substitutes text into the prompt; **no server logic runs**.
   Extensions cannot register chat slash commands at all.

### 7.2 Recommended architecture: server-side `goal-host` runtime controller

**Decision (D1): implement the loop as a host-side runtime controller
(`src/runtime/goal-host.ts`), a sibling of `start-assignment.ts`.** The
`/goal` command is a **new slash-prefix interceptor** in the messages
POST route — **NOT an EZ-action, NOT the EZ-action registry/contract,
NOT the slash-command registry, NOT a user extension.** It is
positioned *where* the EZ-action scan sits in the route, but is a
distinct mechanism (see §7.2.1).

If the "feature extension" *packaging* is still desired for
marketplace/discoverability reasons, the **only** viable hybrid is a
**bundled** extension (`bootSpawn:true` + `persistent:true`, modeled
1:1 on `memory-extractor`) **plus a new host primitive**
`runtime.chat.continueConversation`. That hybrid still requires the new
host primitive and still requires bundled trust — it does **not** turn
this into a user-installable extension. We therefore recommend the pure
host controller as v1, and treat "expose as a bundled extension shell"
as an optional, post-v1 packaging veneer (decision D1, D2). The §13
table records this explicitly.

### 7.2.1 The slash-prefix interceptor (NOT an EZ-action) — exact spec

**Why the EZ-action machinery cannot be reused (verified):**
`stripEzActionTokens` (`src/runtime/mention-wiring.ts:321-345`) only
matches the `EZ_ACTION_TOKEN_RE` `![EZ:name]` pattern — there is no
`/goal`-prefix branch and no way to add one without forking that pure
function's contract. `EzAction.handler` is **nullary**:
`(ctx: EzActionContext) => Promise<EzActionResult>`
(`src/runtime/ez-actions/types.ts:34,91-95`) — `EzActionContext` is
`{conversationId, userId, projectId}` only, so there is **no parameter
to carry the ≤4000-char condition**, and the return type is a card
only (no way to start a turn). The action-only branch returns
**without** `streamChat` (`messages/+server.ts:328`, `runId:null`),
which is the opposite of set-starts-a-turn.

**The new mechanism (placement, signature, control flow):**

1. **Placement.** In the messages POST handler
   (`web/src/routes/api/conversations/[id]/messages/+server.ts`),
   add the interceptor **after the user message is persisted**
   (`:257-263`) and **immediately before the EZ-action scan begins**
   (`:265`). FR-13b's `ensureGoalRecordRehydrated(conversationId)`
   runs earlier still, right after ownership resolution (~`:123`).
2. **Detection.** `const trimmed = body.content.trimStart(); if
   (trimmed === "/goal" || trimmed.startsWith("/goal ") ||
   trimmed.startsWith("/goal\n") || trimmed.startsWith("/goal\t"))`
   — i.e. the `/goal` token followed by EOS or whitespace (so
   `/goalpost` does not match).
3. **Parse (FR-2)** → `{ subcommand: "set"|"status"|"clear",
   condition?: string }`.
4. **Dispatch to a NEW non-nullary handler** in `goal-host.ts`:
   ```ts
   handleGoalCommand(input: {
     subcommand: "set" | "status" | "clear";
     condition?: string;        // present only for "set"
     conversationId: string;    // from route (authoritative)
     userId: string;            // from auth (authoritative)
     projectId: string;
     userMessageId: string;     // the persisted user row id
   }): Promise<
     | { kind: "card"; result: EzActionResult }      // status/clear/reject
     | { kind: "start-turn"; turnMessage: string }   // set
   >
   ```
   This signature is **deliberately unlike `EzAction`** — it carries
   the condition and can request a streaming turn.
5. **Control flow by `kind`:**
   - `kind: "card"` (status, clear, >4000 reject): persist a
     `role:"ez-action-result"` row (FR-19; same `convQueries.create
     Message` shape as `messages/+server.ts:311-315`, but called by
     the interceptor, NOT via the EZ scan loop), then **return**
     `json({ userMessage, runId: null, attachments: [],
     ezActionResults: [<the persisted row>] })`. No `streamChat`.
     This is a *new early return* in the interceptor — it does **not**
     reuse the EZ short-circuit at `:328`.
   - `kind: "start-turn"` (set): the handler has already written
     `metadata.goal`, created the `GoalRecord` (`status:"active"`),
     and emitted `goal:update {state:"active"}`. The interceptor then
     **does NOT return** — it **falls through** to the existing normal
     code path so that `executor.streamChat(...)` at
     `messages/+server.ts:354` runs with `body.content` (the
     `/goal <condition>` text) as the turn input. The route returns
     the **standard streaming shape** (`messages/+server.ts:376-384`):
     `{ userMessage, runId: <non-null>, attachments, ezActionResults:
     [] }` (FR-2-RET). The SSE client treats it as any normal turn
     (non-null `runId` → consume `run:*` frames).

**Net:** status/clear behave like a no-LLM card; **set behaves
exactly like a normal user turn** (same return shape, same `runId`,
same SSE path) — which is the only mechanism that satisfies
set-starts-a-turn-immediately (B2). The condition text is the first
turn's user message; the goal-host's `run:complete` subscription then
drives the loop from there (§7.5).

### 7.3 Component map (concrete anchors, all verified)

| Component | Where | Anchor |
|---|---|---|
| Command interception | **New slash-prefix interceptor** (NOT the EZ scan) placed after user-message persist (`:257-263`), before the EZ scan (`:265`); set falls through to `streamChat` at `:354`; status/clear use a new early return (`runId:null`), NOT the EZ short-circuit at `:328` | `web/src/routes/api/conversations/[id]/messages/+server.ts:257-263, 265, 354, 376-384`; §7.2.1 |
| FR-13b lazy rehydrate hook | `ensureGoalRecordRehydrated()` called unconditionally after ownership resolution, before interceptor + `streamChat` | `messages/+server.ts:~123` (post-`resolveRootConversationForOwnership`) |
| Goal-host controller | New `src/runtime/goal-host.ts` | Modeled on `src/runtime/start-assignment.ts:279,307-366` |
| Turn-completion subscription | `getBus()` singleton, ONE consolidated `run:complete`+`run:error`+`run:cancel` set; evaluator runs ONLY on `run:complete` | `web/src/lib/server/context.ts:308`; emits at `finalize.ts:74` (`run:complete`), `:131` (`run:cancel`), `:153,168,231` (`run:error`); watchdog emits plain `run:error` at `executor-watchdog.ts:323-325` (NO substring match — FR-12.5) |
| Re-enter a turn | `executor.streamChat(conversationId, prompt, …)` | `src/runtime/executor.ts:355`; same call site shape as `start-assignment.ts:279` |
| Evaluator model call | `resolveModel` + `getCredential` + `pi-ai.complete`, host-side | mirrors `src/extensions/llm-handler.ts:316-364`, `src/memory/extraction.ts` |
| Evaluator model set | Haiku/flash-lite triple | `src/extensions/bundled.ts:681-686` (memory-extractor precedent), ceiling `bundled-ceiling.ts:235-244` |
| Transcript fetch | `convQueries.getConversationPath` called **directly from goal-host** (reusable query fn; the POST handler does NOT call it — the GET handler does) | `src/db/queries/conversations.ts:468` (defn); GET usage `messages/+server.ts:57,69` |
| Token spend | SQL aggregate over `messages.usage` (`{inputTokens,outputTokens}`, NO cost field) joined to `runs.createdAt ≥ armedAt` | `src/db/schema.ts:95` (usage), `:32` (runs.createdAt); FR-9 |
| Goal state store | `conversations.metadata.goal` JSONB (key presence = armed; deletion = disarm) | `src/db/schema.ts:60` (precedent: `spawnDepth`) |
| Boot rehydration (records, not listeners) | `goalHost.start()` called from `ensureInitialized()` alongside `watchdog.startOrphanCleanup()`; rebuilds `GoalRecord`s, subscription attached once | `web/src/lib/server/context.ts` init; pattern from `executor-watchdog.ts:123` |
| Indicator + cards | new `goal:update` bus event → SSE | `src/types.ts:224`, `runtime-events/+server.ts:32`, `sse-conversation-filter.ts`; cards via `ToolCardRouter.svelte` |
| Status / achieved / cleared / reject rows | `role:"ez-action-result"` message **rows** (persistence convention only — NOT the `EzAction` handler/registry) | persisted like `messages/+server.ts:311-315`; card shape `src/runtime/ez-actions/types.ts:46-81` |

### 7.4 The host primitive (only if the bundled-extension hybrid is chosen)

Per research open-decision #2: if and only if the optional bundled-
extension veneer is pursued post-v1, add
`runtime.chat.continueConversation(conversationId?, prompt,
{systemNote?})` to the `runtime.*` invoke switch
(`runtime-invoke-handler.ts:139`). Contract:

- **conversationId is host-forced** to the caller's wired conversation
  (mirrors `ezcorp/append-message`'s forced-conversation posture,
  `manifest-schema.md` "Conversation scope is forced by the host").
  An extension can never drive a turn on another conversation.
- **Permission gate:** a new `permissions.chatContinuation:
  { maxTurnsPerHour: number }` quota, modeled on
  `spawnAgents: { maxPerHour }` (`api-reference.md`). Bundled-only in
  v1 (the host primitive is sensitive — it self-drives the LLM).
- Re-enters `executor.streamChat` on the forced conversation with a
  fresh `runId`, identical to `start-assignment.ts:279`.

**v1 does not ship this** (decision D2): the pure host controller has
no extension boundary, so the primitive is unnecessary for v1. It is
specified here so the bundled-veneer option is fully designed and not
punted.

### 7.5 End-to-end flow: one full set→evaluate→re-enter→achieve cycle

```
1. User POSTs "/goal <cond>" to the messages route. After
   ownership resolution (~:123), ensureGoalRecordRehydrated()
   runs (FR-13b — no-op here, no prior goal). User message row
   persisted (:257-263).
2. The NEW slash-prefix interceptor (placed at :265, BEFORE the
   EZ scan — NOT an EZ-action) detects "/goal "; parser → "set".
3. handleGoalCommand({subcommand:"set", condition, ...}):
   validate ≤4000 chars → write conversations.metadata.goal =
   { condition, lastReason:null, createdAt } (key PRESENCE =
   armed); create in-memory GoalRecord { armedAt:now,
   turnsEvaluated:0, tokenAccumSinceArmed:0, status:"active",
   inFlightRunId:null }. Emit goal:update {state:"active"}.
   Return kind:"start-turn".
4. The interceptor does NOT early-return — control FALLS THROUGH
   to the existing normal path; executor.streamChat(
   conversationId, body.content, {runId, ...}) runs at
   messages/+server.ts:354. GoalRecord.inFlightRunId = runId.
   The route returns the STANDARD streaming JSON shape
   ({userMessage, runId:<non-null>, attachments,
   ezActionResults:[]}, :376-384) — set-starts-a-turn-
   immediately, identical to a normal user turn. The SSE client
   consumes run:* frames for runId as usual.
5. The main model runs the turn (tools, etc.). finalizeSuccess
   emits run:complete {run, conversationId} (finalize.ts:74).
6. goal-host's SINGLE consolidated run:complete listener fires.
   Guard: canonical armed predicate (§4) true? run.id ===
   GoalRecord.inFlightRunId? Yes → proceed; clear inFlightRunId;
   turnsEvaluated++.
7. Supersede check: a pending user message? → steering wins,
   skip evaluation, let the user turn run (FR-18).
8. Evaluator (run ONLY on run:complete — never on run:error/
   run:cancel): resolveModel(provider, cheapFor(provider)) +
   getCredential + pi-ai.complete({ system:<contract>, messages:
   [condition + last-20 transcript via getConversationPath],
   maxTokens, temp:0 }). No tools.
9. Parse {achieved, reason}. Store reason in GoalRecord.lastReason
   & metadata.goal.lastReason. Emit goal:update {lastReason}.
10a. achieved:false & armed-predicate true & turnsEvaluated <
     maxGoalTurns: re-enter executor.streamChat(conversationId,
     <terse continuation carrying reason>, {newRunId});
     inFlightRunId = newRunId. → back to step 5.
10b. achieved:true: DELETE metadata.goal (deletion = disarm);
     remove the GoalRecord from the map; persist a
     role:"ez-action-result" {kind:"goal-achieved", reason} row
     (row convention only); emit goal:update {state:"off"}. DONE.
```

Failure branches at step 5/6: **any** `run:error` (watchdog kill
included — it is a plain `run:error`, NO substring match, FR-12.5)
or `run:cancel` for the armed conversation's run → set
`GoalRecord.status="paused"`, persist a paused
`role:"ez-action-result"` row, emit `goal:update {state:"paused"}`,
**evaluator is NOT run** and the loop does **not** re-enter (FR-12).
`metadata.goal` stays present so FR-13b can resume the paused goal.

---

## 8. Reliability & Failure Modes (the "100% of the time" section)

Each research risk becomes a hard requirement + mitigation. This
section is normative.

| ID | Failure mode | Requirement | Mitigation (verified anchor) |
|---|---|---|---|
| **R1** | Subprocess idle-out drops `run:complete` after 5 min → goal silently stalls. | The loop MUST run as an in-process host bus subscriber, never a subprocess event subscription. | Host-side `getBus()` subscription has no idle-out cliff (`context.ts:308`). Disqualifies pure user extension (§7.1). |
| **R2** | Loop hangs forever on a failed/cancelled turn if only `run:complete` is observed. | The loop MUST subscribe to `run:complete` **and** `run:error` **and** `run:cancel`; the evaluator runs ONLY on `run:complete`; any `run:error`/`run:cancel` → pause + surface, never auto-continue, never evaluate. | Mirror the verified `start-assignment.ts:307/401/427` triad exactly (the documented "agent is stuck" fix). |
| **R3** | Server restart loses every in-memory `GoalRecord` → goal silently stalls. | The **bus subscription** is process-global, attached once at `goalHost.start()` (NOT per-conversation, FR-17). The lost thing is the in-memory `GoalRecord`; it MUST be rebuilt by **both** FR-13a (boot sweep) **and** FR-13b (unconditional lazy rebuild before `streamChat` on every POST). "Re-attach listener" and "rebuild record" are distinct; only the record rebuild is per-conversation. | Persist condition to `schema.ts:60`; sweep modeled on `executor-watchdog.startOrphanCleanup` (`:123`), called from `ensureInitialized()`; FR-13b hook at `messages/+server.ts:~123`. |
| **R4** | No extension can start a main-conversation turn. | The loop MUST live where `executor.streamChat` is directly reachable (host). | Host controller calls `streamChat` directly (`executor.ts:355`), like `start-assignment.ts:279`. |
| **R5** | Turn-boundary race: user message + goal continuation both POST a turn. | Per-conversation in-flight guard; a fresh user message **supersedes** the goal continuation. | `inFlightRunId` guard + pending-message precedence, mirroring `start-assignment.ts:312-331` (FR-18). |
| **R6** | A failed/wedged turn produces no useful transcript; evaluating it would loop on garbage. | **Collapsed into R2.** The evaluator runs **only** on `run:complete`. `run:error` (including watchdog kill, which is a *plain* `run:error` — `executor-watchdog.ts:323-325`, **NO "Watchdog" substring match**, brittle) and `run:cancel` always pause WITHOUT evaluating. Additionally: 3 consecutive evaluator parse/timeout failures → pause (FR-8). | FR-12.3/.5; FR-8 evaluator-failure counter. The brittle substring check is removed entirely (reviewer B5). |
| **R7** | Evaluator cost/latency inflates token spend unexpectedly. | Pinned Haiku/flash-lite triple; running token spend (input+output counts, no cost field) surfaced in `/goal` status via the FR-9 SQL; absolute `maxGoalTurns` cap (default 50); evaluator `maxTokens` clamp. | Triple from `bundled.ts:681-686`; cap is FR-12.6; SQL status is FR-9 (`schema.ts:95` has no cost field). |
| **R8** | SSE indicator not delivered (custom event not allowlisted). | `goal:update` MUST be added to `BUS_EVENTS` (`runtime-events/+server.ts:32`), `AgentEvents`, and `DIRECT_CARRIER_EVENT_TYPES`. | Verified allowlist at `runtime-events/+server.ts:32-47`; precedent `ext:state` at line 46. |
| **R9** | Slash-command framing can't run logic; EZ-action machinery can't carry a condition or start a turn. | `/goal` MUST be a **new slash-prefix interceptor** in the messages POST route (§7.2.1) — NOT the command registry, NOT an `EzAction` (nullary, card-only), NOT `stripEzActionTokens` (matches only `![EZ:]`). | Verified: `mention-wiring.ts:321-345` (token regex), `ez-actions/types.ts:34,91-95` (nullary handler). New interceptor at `messages/+server.ts:265`. |
| **R10** | Concurrency: two goal-host instances / double subscription. | Exactly ONE goal-host singleton with ONE consolidated subscription set; idempotent arm (re-`/goal <same>` on an active conversation just replaces the condition, no double subscription). | FR-17; singleton owned by `context.ts` init alongside the executor/bus. |
| **R11** | Goal loop survives `/goal clear` issued mid-turn (clear races an in-flight turn). | Clear is **one operation**: delete `metadata.goal` + remove `GoalRecord`. Deletion *is* the disarm — there is **no** "set `armed:false` then delete" two-step (that contradictory phrasing is removed). The loop's post-turn re-entry gate is the **canonical armed predicate** (§4) used identically by FR-12.2 / FR-18 / §5.3 — one predicate, no divergent inline checks. In-flight turn finishes, is not re-entered (predicate now false). | FR-11, FR-12.2, FR-18; canonical predicate §4 Glossary. |
| **R12** | Runaway cost: a condition the evaluator never marks done. | Hard `maxGoalTurns` cap (default 50, configurable) independent of the model's self-report; on cap → delete `metadata.goal` + persist a "reached turn cap" entry. | FR-12.6. |

**Reliability acceptance criterion:** for every entry in this table
there MUST be an integration test (§11) that injects the failure and
asserts the goal **never silently stalls** — it always reaches a
terminal/paused state with a user-visible reason.

---

## 9. Data Model & Migrations

**Decision (D3): use `conversations.metadata.goal` JSONB. No new
table. No migration.**

Rationale: `conversations.metadata` already exists
(`schema.ts:60`, typed `jsonb().$type<Record<string, unknown>>()`,
precedent `spawnDepth`). Adding a `goal` key requires **zero schema
change and zero migration** — the safest possible option, directly
honoring the project's "safe migrations" reliability goal. A dedicated
`conversation_goals` table (research Option C) buys first-class queries
we do not need in v1 (one goal per conversation, looked up by id) and
costs a migration; rejected for v1. `extension_storage` conversation
scope (Option B) only applies if `/goal` is an extension, which §7.1
rejects.

Persisted shape (`conversations.metadata.goal`):

```ts
type PersistedGoal = {
  condition: string;        // ≤ 4000 chars, verbatim
  // NO `armed` boolean. KEY PRESENCE == armed; key DELETION == disarm
  // (achieve / clear / cap). This is the canonical disarm — there is
  // no boolean to toggle (reviewer B5 / R11). A paused goal keeps the
  // key present (so FR-13b can resume it); paused-ness lives ONLY in
  // the in-memory GoalRecord.status, never persisted.
  lastReason: string | null;// mirror of GoalRecord for post-restart status card
  createdAt: string;        // ISO; informational only (timer resets on resume per spec)
};
```

In-memory only (NOT persisted; rebuilt/reset on resume — FR-13a/b):

```ts
type GoalRecord = {
  conversationId: string;
  armedAt: number;          // epoch ms; resets on resume (spec)
  turnsEvaluated: number;   // resets on resume (spec)
  tokenAccumSinceArmed: number; // cache of the FR-9 SQL; resets to 0 on resume
  evaluatorFailureCount: number;
  lastReason: string | null;
  status: "active" | "paused"; // the ONLY place paused-ness exists
  inFlightRunId: string | null;
};
```

**Canonical armed predicate** (§4 Glossary; the single predicate used
by FR-12 / FR-18 / §5.3 / R11): `metadata.goal` present **AND**
`GoalRecord` exists **AND** `GoalRecord.status === "active"`.

**Migration safety:** none required. Reading `metadata.goal` when
absent yields `undefined` → "no goal" (the natural cleared state, also
satisfies §5.5). Deleting the key on achieve/clear is a plain JSONB
update, transactionally consistent with the conversation row. A schema
type addition to the `metadata` `$type<>` union (adding an optional
`goal?: PersistedGoal`) is a compile-time-only change (no DB DDL).

---

## 10. Security & Permissions

- **S1. Autonomous-loop authorization.** The goal loop self-drives the
  LLM on the user's main conversation. It MUST only ever be armed by an
  explicit `/goal` command from an authenticated user on a conversation
  they own. The messages POST route enforces auth (`requireAuth`) +
  conversation ownership (`resolveRootConversationForOwnership`,
  `messages/+server.ts:121-122`) **before** the slash-prefix
  interceptor runs (`:265`), so the interceptor inherits that gate. No
  tool/extension can arm a goal in v1 (no
  `runtime.chat.continueConversation` shipped — decision D2).
- **S2. RBAC.** Goal continuation turns run with the **same**
  identity, project, `agentConfigId`, `modeId`, and tool/permission
  scope as the conversation's normal turns — they are ordinary
  `streamChat` calls (FR-10). No privilege escalation: a goal cannot
  do anything the user couldn't do by typing the next message
  themselves. Per-tool-call permission prompts still apply on every
  continuation turn (the loop does not bypass the permission system).
- **S3. Runaway-cost guardrails (default bounds, all configurable via
  host constants):**
  - Absolute `maxGoalTurns` cap = **50** (FR-12.6) — independent of the
    model's self-report; hard stop. **Intentionally higher than the
    shipped sub-agent `autonomousContinuation` `maxCycles=8`
    (`cdf8422`):** a user-initiated, observable main-conversation goal
    warrants a larger budget than an opt-in background sub-agent loop —
    the divergence is by design (D6/D12), not an oversight.
  - Evaluator model pinned to the cheap triple (FR-6); evaluator
    `maxTokens` clamp (default 512) and 30s timeout (FR-12.7).
  - One evaluator call per turn (no fan-out).
  - Status card surfaces running token spend so cost is always
    user-visible (FR-9) — directly addresses research R7.
- **S4. Evaluator isolation.** The evaluator call passes **no tools**
  and reads **no files** (FR-5, FR-8) — it cannot take actions, only
  judge text. Matches the verbatim spec ("does NOT call tools or read
  files").
- **S5. Pause-on-failure is fail-safe.** Every abnormal terminal state
  (turn error, watchdog kill, cancel, evaluator-failure threshold,
  no-model) **pauses** rather than blindly continuing (FR-12, §8). The
  default posture on uncertainty is "stop and surface," never "keep
  spending tokens."
- **S6. Interrupt honored immediately.** `run:cancel` for an armed
  conversation pauses the loop synchronously (§5.7) so Ctrl+C / Stop
  is never defeated by an auto-continue. This is a security property
  (user can always halt an autonomous loop), not just UX.

---

## 11. Test Plan

Per the project bar (memory note): new features ship with **100% unit
+ integration + e2e (Playwright) coverage, CI-gated per-file on new
paths**. No layer deferred.

### 11.1 Unit (`bun test`)

- **U1.** **Slash-prefix interceptor parser** (the parser specified in
  §7.2.1 / FR-2, NOT an `EzAction`, NOT `stripEzActionTokens`):
  `/goal` → status; `/goal   ` → status; `/goalpost x` → **not
  matched** (prefix must be the `/goal` token); `/goal
  clear|stop|off|reset|none|cancel` (each + case variants) → clear;
  `/goal CLEAR something` → set (only an exact single-token alias
  clears); `/goal <4001-char>` → reject; `/goal <4000-char>` → set;
  `/goal <multi-line condition>` → set with full remainder. Assert
  dispatch returns `kind:"start-turn"` for set and `kind:"card"` for
  status/clear/reject.
- **U2.** Evaluator response parser: valid JSON yes / no;
  malformed/garbage → `achieved:false` + failure-count increment;
  3rd consecutive failure → pause signal; non-JSON-with-yes-text →
  defensive false; evaluator timeout → counts as a failure.
- **U3.** Evaluator model resolver: each provider → correct cheap
  model; missing-credential fallback chain; no-model → pause.
- **U4.** State machine on the **canonical armed predicate**:
  active→achieved (delete `metadata.goal`), active→cleared (delete
  key), active→paused (any `run:error` / any `run:cancel` /
  eval-fail×3 / cap), paused→active (resume), set replaces active
  goal. Assert there is exactly one predicate (no `armed` boolean on
  `PersistedGoal`).
- **U5.** Token/turn accounting math: `turnsEvaluated` increments;
  cap at `maxGoalTurns`; the FR-9 SQL aggregate over `messages.usage`
  (`inputTokens+outputTokens`, no cost) joined to `runs.createdAt ≥
  armedAt` returns the expected sum; in-memory cache reconciles to it.
- **U6.** `metadata.goal` read/write/**delete** (deletion = disarm,
  no boolean); absent key → "no goal"; resume rebuild resets
  `armedAt`/`turnsEvaluated`/`tokenAccumSinceArmed` to fresh/0 but
  keeps `condition`.
- **U7. (B2 return shape, unit-level).** Given a set dispatch, the
  route helper builds the **streaming** response object
  `{userMessage, runId:<non-null>, attachments, ezActionResults:[]}`
  (shape-identical to `messages/+server.ts:376-384`), NOT a
  `runId:null` card payload. Status/clear build the `runId:null`
  card payload (shape of `:336-341`).

### 11.2 Integration (`bun test`)

Model the event-subscription harness on
`src/__tests__/event-subscription.integration.test.ts` and the
`test-event-subscriber` fixture (research §5.10).

- **I1.** Full loop: arm → first turn fires immediately → evaluator
  "no" → continuation turn fires → evaluator "yes" → goal cleared
  (`metadata.goal` deleted), achieved row persisted, `goal:update
  {off}` emitted.
- **I1b. (B2) Set returns the streaming shape.** POST `/goal <cond>`;
  assert the HTTP response JSON is `{userMessage, runId:<non-null>,
  attachments, ezActionResults:[]}` (NOT a card-only/`runId:null`
  payload) AND that `executor.streamChat` was invoked (a turn
  started) — i.e. set fell through to `:354`, not the `:328`
  short-circuit. Assert `metadata.goal` written before the turn.
- **I2.** R2: turn ends `run:error` → goal **paused**, paused row
  persisted, NO continuation turn, evaluator NOT called, never stalls.
- **I3.** R2/§5.7: turn ends `run:cancel` → goal **paused**, no
  continuation, evaluator NOT called.
- **I4.** R6 (collapsed into R2): a **plain** watchdog `run:error`
  (no "Watchdog" substring anywhere) → paused, evaluator **not**
  called (assert zero cheap-model calls). Asserts detection is
  "any `run:error`", not a string match.
- **I5.** R3 boot sweep (FR-13a): simulate restart with
  `metadata.goal` present and NO in-memory record → boot sweep
  rebuilds the `GoalRecord` (counters reset), next `run:complete`
  is evaluated.
- **I5b. (B3) Lazy rebuild on a NORMAL user turn (FR-13b).**
  Simulate restart, `metadata.goal` present, in-memory map EMPTY,
  boot sweep NOT yet run (or conv created post-boot). POST an
  **ordinary** (non-`/goal`) user message. Assert
  `ensureGoalRecordRehydrated` rebuilt the `GoalRecord` *before*
  `streamChat`, so that turn's `run:complete` IS evaluated.
  Distinguish from I5 (record rebuild, not listener re-attach — the
  subscription was never per-conversation).
- **I5c. (B4) Post-restart token spend resets to 0.** Arm, run a
  turn (token usage persisted), simulate restart (record rebuilt,
  `armedAt:now`). `/goal` status → `tokenSpendSinceArmed == 0`
  (no runs with `createdAt ≥ new armedAt` yet); after one more turn,
  spend == that turn's `inputTokens+outputTokens` only.
- **I5d. (B3 ordering hazard) `/goal` POST must not auto-resume via
  the rehydrate helper (FR-13b).** Paused goal, `metadata.goal`
  present, in-memory map EMPTY. POST `/goal` (status) — assert the
  helper rebuilt the record as `paused` and did NOT flip it to
  `active`; status reports the paused state. Repeat with `/goal
  clear` — assert the goal hard-clears and is NOT transiently
  resumed first. Contrast with I5b (a non-`/goal` POST DOES resume).
- **I6.** R5/FR-18: user message arrives while loop would re-enter →
  user turn supersedes; evaluator runs on the post-user transcript.
- **I7.** R10: re-`/goal <same>` on an active conversation replaces
  the condition with no double subscription / double turn.
- **I8.** R12/FR-12.6: condition the evaluator never passes → stops at
  `maxGoalTurns`, `metadata.goal` deleted, "reached turn cap" row.
- **I9.** FR-8: 3 consecutive unparseable evaluator responses → pause.
- **I10.** Multi-conversation isolation (FR-16): two armed
  conversations; `run:complete` for A does not drive B (one
  consolidated subscription, per-conversation predicate).
- **I11.** Headless/`-p` path: a turn driven via the non-interactive
  path still fires the loop (mode-agnostic); a `-p` message containing
  `/goal clear` against a paused conv hard-clears it.
- **I12.** Status accounting (FR-9): `/goal` returns correct
  condition/elapsed/turns/**SQL token spend**/lastReason as a
  `runId:null` card response, NO LLM turn (assert `streamChat` not
  called).
- **I13. (B5/R11) Clear-vs-disarm single predicate.** `/goal clear`
  mid-turn: assert it performs exactly one op (delete `metadata.goal`
  + drop `GoalRecord`), no `armed:false` write occurs, and the
  in-flight turn's `run:complete` does NOT re-enter (canonical
  predicate now false).

### 11.3 E2E (Playwright, from `web/`, SSE-based)

Per memory note: streaming specs MUST use SSE (`emitSse`), run from
the `web/` subdir.

- **E1.** Type `/goal <cond>` → `◎ /goal active` chip + elapsed timer
  appears via SSE; first turn streams immediately.
- **E2.** Loop auto-continues across ≥2 turns without user input;
  evaluator reason visible in status card.
- **E3.** Evaluator "yes" → chip disappears, "achieved" card in
  transcript.
- **E4.** `/goal` (no arg) → status card with all fields; no
  "Thinking…" skeleton (no LLM turn).
- **E5.** `/goal clear` (and one alias) → "cleared" card, chip gone.
- **E6.** Stop button mid-goal → `◎ /goal paused`, no auto-continue;
  subsequent manual message resumes.
- **E7.** Reload the page on an armed conversation → chip restored
  from `metadata.goal` via FR-13b rebuild, timer reset to 0.
- **E8. (B2)** Typing `/goal <cond>` produces a normal streaming
  assistant turn immediately (a "Thinking…" skeleton appears — unlike
  `/goal` status/clear which show only a card and no skeleton),
  confirming the set path returned the streaming shape.

### 11.4 CI gating

New files (`src/runtime/goal-host.ts`, the new slash-prefix
interceptor + parser + `handleGoalCommand` dispatch, the `goal:update`
plumbing, UI chip/card components) and the modified
`messages/+server.ts` lines added to the per-file coverage threshold
list (`scripts/coverage-thresholds.json`) at 100%, consistent with the
existing per-file CI gate. The §8 reliability table + B1–B5 tests
(I1b, I4, I5b, I5c, I5d, I13, U1, U7) are the integration checklist.

**Do-not-regress constraint (shipped `cdf8422`):** `goal-host.ts`
MUST be a new, parallel module and MUST NOT modify
`src/runtime/start-assignment.ts` — that file is now on the 100%
per-file coverage gate and carries the shipped autonomous-continuation
suites. This PR must keep green: `start-assignment.ts`'s existing
gate, `src/__tests__/autonomous-continuation.integration.test.ts`,
`src/__tests__/start-assignment-plumbing.test.ts`, and
`web/e2e/autonomous-continuation.spec.ts`. Goal-loop tests I6/I10
(user-message-supersedes / multi-conversation) MUST NOT perturb the
shared `pending-messages.ts` `dequeue` path the sub-agent loop also
consumes. Any future shared-primitive extraction (D12/NG7) is owned
by a separate refactor PR, which then re-satisfies the
`start-assignment.ts` gate — not this one.

---

## 12. Rollout / Phasing

All phases land behind a single host feature flag
`EZCORP_GOAL_ENABLED` (default **on**; the project ships features
complete, but the flag gives a kill-switch for the autonomous loop —
a prudent guardrail for a self-driving feature). The chip and command
are inert when off (the `/goal` handler returns a "goal feature
disabled" card).

- **Phase 1 — Core loop (host-only, no UI):** `goal-host.ts`,
  `run:complete/error/cancel` subscription, evaluator, re-entry,
  `metadata.goal` persistence, boot sweep, the EZ-action command
  handler (set/clear/status returning text cards). All §11.1/§11.2
  tests green. This phase alone is functionally complete (works in
  headless).
- **Phase 2 — UI surface:** `goal:update` bus event + SSE plumbing,
  the `◎` chip + elapsed timer in the chat header, the rich status/
  achieved/cleared/paused cards via `ToolCardRouter`. §11.3 e2e green.
- **Phase 3 (optional, post-v1) — Bundled-extension veneer:** only if
  marketplace packaging is desired — add
  `runtime.chat.continueConversation` (§7.4) + a bundled `goal`
  extension shell delegating to the same `goal-host`. Not required for
  functional parity; explicitly out of v1 scope.

Phases 1+2 == v1 (full Claude-Code parity). Phase 3 is a packaging
veneer, not a functional gap.

---

## 13. Open Questions / Explicit Decisions Made

Every research "open decision" (research §5) is resolved here.

| # | Research open decision | **Decision** | Rationale / tradeoff |
|---|---|---|---|
| D1 | Packaging: host controller vs bundled-ext+primitive vs pure user ext | **Host-side `goal-host.ts` controller + a NEW slash-prefix interceptor (NOT an EZ-action, NOT the slash registry).** | Only design satisfying all four §7.1 blockers. Pure user ext fails R1/R4 (cannot meet 100% bar). Trade-off: not literally a "user extension" — but the user's overriding constraint was *100% reliability*; we honor the intent, not the packaging word, and document it openly (§7.1-7.2). |
| D2 | The missing host primitive `runtime.chat.continueConversation` + permission model | **Specified but NOT shipped in v1** (host controller has no extension boundary). If the bundled veneer is later pursued: host-forced conversation + new `permissions.chatContinuation:{maxTurnsPerHour}` (spawn-quota-modeled), bundled-only. | Avoids adding a sensitive self-LLM-driving extension API before it's needed. Trade-off: Phase 3 needs this work later; fully designed (§7.4) so it's not a surprise. |
| D3 | Goal state store: metadata JSONB vs extension_storage vs new table | **`conversations.metadata.goal` JSONB.** | Zero migration (safest; honors "safe migrations" goal), precedent `spawnDepth` (`schema.ts:60`), naturally conversation-scoped, trivially clearable (delete key). Trade-off: no first-class SQL query over goals — not needed (one goal/conversation, looked up by id). |
| D4 | Command surface: new prefix vs EZ-action vs new sigil | **A NEW `/goal`-prefix interceptor with its own parser + non-nullary `handleGoalCommand` dispatch, placed in the messages POST route at the same point as (but before) the EZ scan (§7.2.1). Explicitly NOT an EZ-action: `stripEzActionTokens` matches only `![EZ:]` (`mention-wiring.ts:321-345`), `EzAction.handler` is nullary + card-only (`ez-actions/types.ts:34,91-95`), and the EZ short-circuit returns WITHOUT `streamChat` (`:328`) — none of which can carry a 4000-char condition or start a turn.** | The EZ-action *registry/contract* genuinely cannot express `/goal` (verified — reviewer B1). What we reuse is only (a) the route *position* (intercept after user-msg persist, before `streamChat`) and (b) the `role:"ez-action-result"` *row persistence convention* for status/achieved/cleared cards. Set falls through to the normal streaming path so it returns the standard `{userMessage,runId,…}` shape (B2). New sigil = grammar churn for one feature; slash registry can't run logic. Trade-off: `/goal` isn't user-extensible — acceptable (registry is code-defined per research §3.3). |
| D5 | Evaluator model: pinned triple vs configurable | **Pinned Haiku/flash-lite triple, provider-matched, with credential-fallback chain; no v1 config knob.** | Matches `memory-extractor` precedent (`bundled.ts:681-686`); predictable cost; no new settings surface. No-credential case → pause with visible reason (never silent stall). Trade-off: power users can't pick the judge model in v1 — revisit post-v1 (NG4). |
| D6 | Evaluator prompt contract; how the "stop after N turns" self-bound is honored | **Strict-JSON `{achieved,reason}` contract, last-20-message transcript (memory-extractor precedent), temp 0; user self-bound is model-self-reported AND backed by a hard host `maxGoalTurns=50` cap.** | Matches the verbatim spec ("model self-reports progress, evaluator judges from the conversation") while the host cap is the non-negotiable runaway-cost backstop (R12). Trade-off: a user wanting >50 turns must restate; a safe default, configurable host constant. |
| D7 | Indicator transport: reuse `ext:state` vs first-class `goal:update` | **First-class `goal:update` bus event** added to `AgentEvents` + `BUS_EVENTS` + `DIRECT_CARRIER_EVENT_TYPES`. **Prerequisite/coordination note:** `web/src/lib/components/ChatThread.svelte`, `MessageToolbar.svelte`, and the conversation page `web/src/routes/(app)/project/[id]/chat/[convId]/+page.svelte` are **currently dirty in `git status`** — the `◎` chip + `goal:update` SSE wiring touches these files and MUST be rebase-coordinated with that in-flight work (do not land the UI plumbing on a stale tree; sync before Phase 2). | `ext:state` only works if `/goal` is a paneled extension — it isn't (D1). A first-class event is the clean surface for the `◎` chip and is conversation-filtered for free (`sse-conversation-filter.ts`). Trade-off: more web plumbing than reusing `ext:state` — justified, ext:state is unavailable to a host controller. |
| D8 | Interrupt: pause vs clear on `run:cancel` | **Pause** (condition retained; `◎ /goal paused`) — a **deliberate, documented deviation from Claude Code parity**: Claude Code's spec says Ctrl+C "stops" (hard stop); EZCorp retains the condition. A second consecutive interrupt or explicit `/goal clear` hard-clears. | The *loop* still stops immediately (no auto-continue — the safety-critical behavior matches); only the *condition retention* deviates. Pause (not destroy) preserves a possibly-4000-char condition so resume is one message, not a retype. Strictly safer + better UX; clear is always one explicit command away. Headless `-p`: a paused goal resumes on the next `-p` invocation against that conversation; `-p` is one-shot so there is no in-process Ctrl+C-then-resume (documented limitation, §5.7). Framing corrected in §1/G1 (removed "functionally identical"). |
| D9 | Where the boot rehydration sweep lives | **`goalHost.start()` invoked from `ensureInitialized()` in `web/src/lib/server/context.ts`, alongside `watchdog.startOrphanCleanup()`.** | Same lifecycle slot as the existing orphan-cleanup sweep (`executor-watchdog.ts:123`); the bus + executor are already constructed there (`context.ts:298,308`). Trade-off: none — this is the established pattern. |
| D10 | Test plan for 100% coverage | **Full matrix in §11**, integration tests modeled on `event-subscription.integration.test.ts` + `test-event-subscriber` fixture; every §8 failure mode has a "never silently stalls" assertion; per-file CI gate updated. | Directly satisfies the project's 100%-coverage bar; the reliability table (§8) is the integration-test checklist. |
| D11 | Stop-condition: cheap-model evaluator vs. the shipped working-model sentinel | **Per-turn cheap-model evaluator (Claude Code parity) — AND `/goal` ALSO honors the shipped `<<TASK_DONE>>` / `<<TASK_BLOCKED>>` sentinel as a free fast-path short-circuit *before* the evaluator call.** | The shipped `cdf8422` autonomous loop stops on a working-model sentinel + `maxCycles`: zero extra cost, but it is the *working model judging its own success* — exactly what the verbatim `/goal` spec rejects (a separate fresh model must judge the transcript), so the evaluator is non-optional for fidelity. Honoring the existing sentinel as a fast-path is free, matches the shipped convention, and lets a cooperative main model end a goal in zero evaluator calls. Trade-off reviewers must consciously accept: one per-turn evaluator call (bounded by the D5 triple + S3 `maxTokens`/timeout clamps) over the already-shipped free mechanism — accepted for spec fidelity. |
| D12 | Reuse vs. parallel-build of the run-completion loop | **`goal-host.ts` is a deliberate *parallel* module to `start-assignment.ts`'s autonomous loop — NOT a unification; no shared primitive extracted in v1 (NG7).** | The shipped loop is irreducibly sub-agent-only (`start-assignment.ts:279` always calls `streamChat(subConversationId,…)`; sentinel detection, `TaskAssignment` mutation, and `agent:spawn`/`task:*` emits are hard-wired). Parameterizing it for the main conversation would destabilize a just-shipped, 100%-gated file with active autonomous-continuation suites. A shared `RunCompletionLoop` extraction is sound but **post-v1**, owned by a separate refactor PR (which then re-owns the `start-assignment.ts` gate). Trade-off: ~one loop's worth of structurally-similar code duplicated — acceptable vs. the regression risk. |

---

## 14. Appendix — File:Line Reference Map (verified against source)

Every anchor below was opened and confirmed during PRD authoring
(not merely copied from the research).

| Concern | File:Line | Verified |
|---|---|---|
| Turn entry point (`streamChat`) | `src/runtime/executor.ts:355` | via research; call-site shape confirmed at `start-assignment.ts:279` |
| `run:complete` emit (+ `obs:turn`) | `src/runtime/stream-chat/finalize.ts:74-81` | ✅ read |
| `run:cancel` emit (AbortError) | `src/runtime/stream-chat/finalize.ts:131` | ✅ read |
| `run:error` emit (provider/general/setup) | `finalize.ts:153,168,231` | ✅ read |
| Watchdog emits a **plain** `run:error` `{run, error:<reason>, conversationId}` (NO reliable "Watchdog" substring — detection is "any run:error", FR-12.5) | `src/runtime/executor-watchdog.ts:323-325` | ✅ read |
| Autopilot loop primitive (`startRun` + triad) | `src/runtime/start-assignment.ts:279,307,401,427` | ✅ read |
| `finalizeCleanup` detaches subscriptions | `finalize.ts:179-207` | ✅ read |
| `runs` table schema | `src/db/schema.ts:23-33` | ✅ read |
| `conversations` table + `metadata` JSONB (precedent `spawnDepth`) | `src/db/schema.ts:43-68` (metadata `:60`) | ✅ read |
| `messages.usage` (token accounting) | `src/db/schema.ts:95` | via research |
| Singleton bus / executor accessors | `web/src/lib/server/context.ts:298,308` | ✅ read |
| Slash-prefix interceptor placement (after user-msg persist, before EZ scan); set falls through to `streamChat`; status/clear new early return; normal streaming return shape | `web/src/routes/api/conversations/[id]/messages/+server.ts:257-263, 265, 311-315, 328, 354, 376-384` | ✅ read |
| EZ-action machinery CANNOT carry `/goal` (token regex only `![EZ:]`; nullary handler; card-only) | `src/runtime/mention-wiring.ts:321-345`; `src/runtime/ez-actions/types.ts:34,91-95` | ✅ read |
| EZ-action result card *row* convention (reused for persistence ONLY) | `src/runtime/ez-actions/types.ts:46-81`; persisted like `messages/+server.ts:311-315` | ✅ read |
| `getConversationPath` is a reusable query fn (called by GET handler, NOT POST; goal-host calls it directly) | defn `src/db/queries/conversations.ts:468`; GET usage `messages/+server.ts:57,69` | ✅ read |
| `messages.usage` shape = `{inputTokens,outputTokens}` only — NO cost field | `src/db/schema.ts:95` | ✅ read |
| `runs.createdAt` (token-spend join key, FR-9 SQL) | `src/db/schema.ts:32` | ✅ read |
| `runtime.*` invoke whitelist (no `runtime.chat.*`) | `src/extensions/runtime-invoke-handler.ts:139-159` | ✅ read |
| Extension event-subscription idle-out drop | `src/extensions/event-subscription-dispatcher.ts:352`; `lifecycle-dispatcher.ts:142` | via research |
| `append-message` forced excluded/extension | `src/extensions/append-message-handler.ts:112,289` | via research |
| `spawn-assignment` sub-conversation | `src/extensions/spawn-assignment-handler.ts:332` | via research |
| Host-side cheap-model call path | `src/extensions/llm-handler.ts:316-364`; `src/memory/extraction.ts` | via research |
| Evaluator model triple (memory-extractor) | `src/extensions/bundled.ts:681-686`; ceiling `bundled-ceiling.ts:235-244` | ✅ read |
| Bundled `bootSpawn:true`+`persistent:true` precedent | `src/extensions/bundled.ts:603` (distiller), `:674` (memory-extractor) | ✅ read |
| SSE `BUS_EVENTS` allowlist (`ext:state` precedent line 46) | `web/src/routes/api/runtime-events/+server.ts:32-47` | ✅ read |
| SSE per-conversation filter / direct carriers | `src/runtime/sse-conversation-filter.ts` (`DIRECT_CARRIER_EVENT_TYPES`) | via research |
| Boot-sweep pattern (orphan cleanup) | `src/runtime/executor-watchdog.ts:123` | via research |
| Slash-command literal expansion (why not a command) | `src/runtime/mention-wiring.ts:139-156` | via research |
| Event-subscription integration test model | `src/__tests__/event-subscription.integration.test.ts`; fixture `test-event-subscriber` | via research |

---

*End of PRD.*
