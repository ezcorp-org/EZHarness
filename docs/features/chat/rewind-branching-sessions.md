# Rewind, Checkpoint & A/B Retry (Session Tree)

> _A durable, pi-session-backed view of a conversation's message tree: rewind/checkpoint the branch to any past turn, retry an assistant turn as a same-role sibling (honest A/B), and have both survive a page reload — all layered on top of the `messages` tree without mutating a single `parentMessageId`._

## Intent

[[conversations]] already makes a thread a branching tree (`messages.parentMessageId` edges; edit/regenerate fork siblings). What it lacked was a **durable branch pointer**: which branch is "current" lived only in the client's in-memory `activeLeafId`, so a rewind never survived a reload and there was no server-side notion of a checkpoint. This feature adds a **pi session tree** mirror of the conversation — a second, append-only projection whose **leaf pointer** is persisted — and three capabilities built on it:

- **Rewind / checkpoint** — move the durable leaf back to an earlier turn; the abandoned tail stays as a switchable sibling branch.
- **A/B retry** — re-run an assistant turn as a **same-role sibling** (both assistant responses hang off the one user turn), the honest A/B that regenerate-via-`editOf` could not give (that path forks a *new user turn* too → mixed-role siblings).
- **Reload-restore** — on conversation (re)load the client re-seats its active branch on the durable leaf, so a rewind (or an A/B pick that moved the leaf) is what you see after a refresh.

## How it works

### The session tree is a mirror, not the source of truth for reads

The `messages` table remains the system of record. `src/db/session-sync.ts` maintains a **parallel** pi session (`agent_sessions` + `agent_session_entries`) per conversation, lazily backfilled from `messages` on first use and live-appended as new assistant turns save. It exists to give the conversation two things the flat `messages` walk can't cheaply express: an append-only topology with a **persisted leaf pointer** (pi `getLeafId`/`moveTo`), and an O(delta) catch-up cursor.

Crucially, **the session leaf pointer is NOT authoritative for producer reads.** The branch that becomes the LLM's context is still chosen by the **client-carried `parentMessageId`** on each send (`loadHistory` → `computeBranch` → `computeSessionBranch(conversationId, parentMessageId)`), exactly as the legacy CTE walk did. The durable leaf drives **display + reload-restore + external consumers**, not the prompt. Keep that separation: content/excluded state is read live via a join against `messages`, so the cursor only gates *topology* appends.

### History producer flag (kill-switch)

`sessions:historyProducer` (constant `SESSION_HISTORY_PRODUCER_SETTING`) gates whether the session tree produces the branch. As of Wave-6 it **defaults ON**: `isSessionHistoryProducerEnabled()` returns `true` unless the setting is the explicit boolean `false`. It is a pure kill-switch — only `false` reverts `loadHistory` to the legacy `getConversationPath` CTE walk byte-for-byte (the single-container escape hatch). This is orthogonal to the **runtime fail-open**: if the producer path throws mid-load, `computeBranch` still falls back to the legacy walk for that one turn (and bumps an observable fallback counter) regardless of the flag.

The flag is also how the **UI discovers the feature**: `GET .../tree` returns `200` when on and `409 session_producer_disabled` when off, and the client flips the rewind / A-B affordances on that 200-vs-409 (`treeEnabled`).

### Rewind / checkpoint

`POST /api/conversations/:id/rewind` → `rewindSession(conversationId, targetMessageId, summary?)` moves the session's durable leaf to `targetMessageId` (a pi `moveTo` **leaf pointer** entry, never a `messages` reparent) and optionally records a `branch_summary` annotation for the abandoned branch. The tail stays in `messages` as a recoverable sibling; the client re-parents its next send onto the new leaf. Guards, in order: ownership → **404**; flag off → **409** `session_producer_disabled`; a live run (in-memory controller **or** DB `active_run` row) → **409** `active_run` (no mid-stream tree mutation); target not a row of this conversation → **400**. On success it emits `conversation:tree-changed` (conversation-scoped) so other tabs refresh, and returns the refreshed tree.

Client-side (`send-message.ts#handleRewind`) simply POSTs and sets `activeLeafId = msg.id`; `handleSend` derives the next send's `parentMessageId` from `activeLeafId`, so the turn continues from the rewound point. Rewind changes no `messages` rows, so there is no reload — the thread re-derives root→msg locally.

### A/B retry (clean sibling)

`POST /api/conversations/:id/messages/:mid/retry` re-runs the turn that produced the target **assistant** message, anchored at that message's **parent user turn**, WITHOUT creating a new user row. The mechanism is the ordinary turn contract: `streamChat(conversationId, content, { parentMessageId })` never creates the user row itself (the messages POST does), and the assistant save parents on `ctx.lastSavedMessageId` (seeded from `parentMessageId`). Passing the **existing** user message id as `parentMessageId` therefore lands the new assistant as a **sibling** of the original — and because that user row already exists in `messages`, the session backfill/branch read reproduces it with no duplicate. Guards mirror rewind (ownership 404 → flag 409 → active-run 409 → 400 target validation → 429 budget). Optional body `provider`/`model`/`thinkingLevel` retries against a different model without touching the conversation's pin.

This is wired to the labeled **"Retry"** A/B affordance (`onabretry` → `handleAbRetry` → `retryMessage`), which adds **only** an assistant placeholder optimistically (no new user bubble). The toolbar **regenerate** (and edit/rerun) flows are unchanged — they still use `editOf` and fork a new user turn.

### Reload-restore

On conversation load the client re-seats the active branch on the durable leaf. `ChatThread#restoreDurableLeaf` runs **once per load**, chained AFTER `loadMessages` has populated `allMessages` and set the default `computeLatestLeaf`, so it is the last writer (no wrong-branch flicker). It reads `GET .../tree`, and when the producer is on and `currentLeaf` is a **live row** among the loaded messages, sets `activeLeafId = currentLeaf`; a pointer that is off/absent/stale fails open to the latest leaf. It lives in the async (non-seeded) load path, so a component's `seedMessages`/`seedLeafId` (the seeded embed used by tests/panels) is never clobbered — that seam is why the restore avoids the `__seeded` collision. With restore in place, a rewind's durable leaf finally drives reload behaviour: **a rewind now survives a refresh.**

## Usage

### REST API

| Method & path | Scope | Purpose |
|---|---|---|
| `GET /api/conversations/:id/tree` | `read` | Session-backed tree + durable leaf. `{ conversationId, currentLeaf, nodes: [{ id, parentId, role, excluded, createdAt }] }`. **409** `session_producer_disabled` when the flag is off (also how the UI learns the feature is enabled). |
| `POST /api/conversations/:id/rewind` | `chat` | Move the durable leaf to `targetMessageId` (+ optional `summary`). 409 (flag off / active run), 400 (bad target). Returns the refreshed tree. |
| `POST /api/conversations/:id/messages/:mid/retry` | `chat` | Clean A/B: re-run the target assistant turn as a same-role sibling (no new user row). Optional `provider`/`model`/`thinkingLevel`. 409 (flag off / active run), 400 (target not an assistant with a user parent), 429 (budget). Returns `{ userMessage, retriedMessageId, runId }` — `userMessage` is the EXISTING anchor turn. |

All three are registered in `src/api-registry.ts` and mirrored in `@ezcorp/harness-client` (`getConversationTree`, `rewindConversation`, `retryMessage`).

### UI

- **Branch switcher** — `BranchNavigator` (‹n/m›) renders on any turn with siblings; `handleBranchNavigate` moves `activeLeafId` to the chosen branch's leaf.
- **Rewind affordance** — a per-message toolbar button (`onrewind`), shown only when `treeEnabled`.
- **A/B Retry** — the labeled `data-testid="ab-retry-btn"` on assistant rows, shown when `treeEnabled && !activeRunId`.

### Settings

- `sessions:historyProducer` — the kill-switch. **Absent = ON** (default). Set to the boolean `false` to revert to the legacy CTE history path (also hides the rewind/A-B affordances via the tree 409).

## Key files

- `src/db/session-sync.ts` — the session mirror: `isSessionHistoryProducerEnabled`, `computeSessionBranch` (producer read), `computeSessionTree` / `buildTreeView` (the tree + `currentLeaf`), `rewindSession` (moveTo + branch_summary), `appendSavedMessageEntry` (live append), `withConvSessionLock` (per-conversation write serialization), and the O(delta) catch-up cursor.
- `src/runtime/stream-chat/load-history.ts` — `computeBranch`: producer read with fail-open to the legacy CTE walk + the observable fallback counter.
- `web/src/routes/api/conversations/[id]/tree/+server.ts` — GET tree; 409 gate.
- `web/src/routes/api/conversations/[id]/rewind/+server.ts` + `rewind/schema.ts` — rewind/checkpoint.
- `web/src/routes/api/conversations/[id]/messages/[mid]/retry/+server.ts` + `retry/schema.ts` — clean A/B retry.
- `web/src/lib/api.ts` — `fetchConversationTree` (409→`{enabled:false}`), `rewindConversation`, `retryMessage`.
- `web/src/lib/chat/page-handlers/send-message.ts` — `handleRewind`, `handleAbRetry` (+ the unchanged `handleRegenerate`/`handleEditConfirm`/`handleRetry`).
- `web/src/lib/components/ChatThread.svelte` — `treeEnabled` discovery (`refreshTree`), `restoreDurableLeaf` (reload-restore), branch/rewind/A-B wiring.
- `web/src/lib/components/ChatMessage.svelte` / `BranchNavigator.svelte` / `MessageToolbar.svelte` — the switcher + rewind + A-B affordances.
- `packages/@ezcorp/harness-client/src/index.ts` + `routes.ts` — `getConversationTree`, `rewindConversation`, `retryMessage`.

## Features it touches

- [[conversations]] — the `messages` tree + `parentMessageId` edges this mirrors; edit/regenerate/rerun forks live there.
- [[streaming-runtime]] — `streamChat`'s `(content, parentMessageId)` contract is what the A/B retry reuses to land a sibling; the live append hooks the subscribe-bridge `turn_end`.
- [[runs-lifecycle]] — rewind + retry both 409 on an active run (in-memory controller or DB `active_run` row); retry mints a `runId` that streams over SSE.
- [[context-compaction]] — the producer's branch (minus `excluded`) is the model's input window; the session tree never adds its own compaction entries (trim/summarize stays the sole shrinker).
- [[remote-testability]] — all three routes are `harness.controllable` and extend `@ezcorp/harness-client`; `conversation:tree-changed` is a client-facing runtime event.

## Related docs

- [[conversations]] — the primary threading reference (tree, ownership root-walk, send pipeline).
- `docs/context-compaction.md` — the input-only compaction invariant the producer path must respect.

## Notes & gotchas

- **The session leaf is NOT the read authority.** Producer reads follow the client-carried `parentMessageId`; the durable leaf drives display + reload-restore only. Don't "fix" `computeSessionBranch` to read the leaf — that would make branch navigation server-authoritative and break sibling reads.
- **Default ON is a pure kill-switch.** `isSessionHistoryProducerEnabled()` is `!== false`, so unset/garbage read ON; only the explicit boolean `false` reverts to legacy. This is separate from the runtime fail-open (producer throws → legacy walk for that turn).
- **A/B retry needs the existing user row.** The whole point is *no new user turn*: it anchors `parentMessageId` at the target assistant's parent user message. If you route it through the `editOf` path you get the old mixed-role siblings back.
- **Rewind is blocked under a live run.** Both rewind and retry refuse (409 `active_run`) while a run is active — no mid-stream tree mutation. The client cancels first, then rewinds/retries.
- **Reload-restore is non-seeded only + last-writer.** `restoreDurableLeaf` runs inside the async load (not seeded mode) and AFTER `computeLatestLeaf`, guarded by the load `gen` so a conversation switched out mid-fetch can't restore onto the wrong thread. A stale/off/absent pointer keeps the latest leaf — it never strands the view on a vanished row.
- **Rewind changes no `messages` rows.** It writes a session leaf-pointer entry only. That's why the abandoned tail stays switchable and why rewind needs no message reload.
