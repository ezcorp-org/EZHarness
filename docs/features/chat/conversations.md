# Conversations & Threading

> _The chat substrate of EZCorp: project-scoped conversations whose messages form a branching tree (edit/regenerate forks), with sub-conversations for agent runs, recency-grouped fork families in the sidebar, and root-walk ownership._

## Intent

Conversations are the persistent containers for every chat in EZCorp. They are scoped to a project, own a message tree (not a flat list — edits and regenerations fork siblings), and can spawn sub-conversations for agent runs and team members. The threading model lets a user branch a conversation at any message, navigate between branches, fork a whole conversation, and exclude individual turns from the model's context — while a fail-closed ownership walk keeps each user's threads (and their `userId=null` sub-conversations) private.

## How it works

### Data model

- A conversation row (`conversations` table) carries `projectId`, `userId` (the owner; `null` for sub-conversations), `title`, `model`/`provider`, `agentConfigId`, `modeId`, `kind` (e.g. `"ez"` for the concierge), and a `metadata` JSONB blob. Two distinct self-references exist:
  - `parentConversationId` (`on delete cascade`) — chains a **sub-conversation** up to the conversation that spawned it.
  - `forkedFromConversationId` (`on delete set null`) — links a **fork** to the conversation it was cloned from. Drives the sidebar's fork families; SET NULL means a deleted parent leaves an orphaned-fork root.
- A message row (`messages` table) carries `role`, `content`, `parentMessageId` (the tree edge), and `excluded` (a boolean — exclude-from-context toggle). There is **no** `editOf` column: `editOf` is a request-only param the server resolves into a sibling `parentMessageId`.

### Message tree & branching

The thread is a tree, not a list. `messages.parentMessageId` is the only edge:

1. A normal send anchors the new user message to the current **latest leaf** (`getLatestLeaf`, with `excludeCapabilityEvents: true` so a trailing auto-allowed tool annotation doesn't become the leaf), keeping the main thread linear.
2. An **edit** (`editOf` set to a user message) resolves the edited message's `parentMessageId` and parents the new turn there — forking a sibling branch.
3. **Regenerate** / **rerun** send `editOf` pointing at the assistant (regenerate) or user (rerun) message, again forking a sibling under the same parent.
4. The active path is reconstructed by `getConversationPath(leafMessageId, conversationId)`, walking parent edges from a chosen leaf up to the root. The client tracks `activeLeafId` and navigates branches with `handleBranchNavigate` (find the leaf containing a given message id).

These flows live client-side in `web/src/lib/chat/page-handlers/send-message.ts` (`handleSend`, `handleEditConfirm`, `handleRegenerate`, `handleRerun`, `handleBranchNavigate`, plus `handleRetry`/`handleFallback` which drop a failed assistant turn and re-send the preceding user message).

### Send pipeline (`POST /api/conversations/[id]/messages`)

The server handler is the interception point for several side-channels, in this fixed order:

1. **Ownership** via `resolveRootConversationForOwnership` (root-walk, below) → 404 on failure.
2. **Token budget** check (`checkTokenBudget`) → 429 if exceeded.
3. **Body parse** — multipart (`multipart/form-data`, for attachments) or JSON. Content is 1–100 000 chars.
4. **`/goal` rehydrate** — `goalHost.ensureGoalRecordRehydrated` always runs first, rebuilding the in-memory `GoalRecord` from `conversations.metadata.goal` after a restart.
5. **Parent resolution** — `editOf` → edited message's parent; else explicit `parentMessageId`; else anchor to latest real leaf.
6. **Attachment pipeline** — pre-validate every file against the resolved model's capabilities (including MIME types contributed by wired + pending `!ext:` extensions), then persist the user message row and write files to disk + `attachments` rows, with best-effort rollback on failure.
7. **`/goal` interceptor** — if the content is a `/goal …` command (`isGoalCommand`), dispatch through `goalHost.handleGoalCommand`. `card` results (status/clear/reject/disabled) persist an `ez-action-result` row and return `runId: null`; a `start-turn` result falls through to `streamChat` so a `/goal <condition>` set behaves like a normal turn. **This is inline — there is no `/goal-state` route.**
8. **EZ-action interceptor** — scan `![EZ:name]` tokens via `stripEzActionTokens`, fire each registered action's nullary handler, persist one `ez-action-result` row per outcome. An **action-only** message (everything stripped) short-circuits the LLM and returns `runId: null`.
9. Otherwise mint a `runId` and call `executor.streamChat(...)`, returning `{ userMessage, runId, attachments, ezActionResults }`.

### Sub-conversations (agent runs)

When `handleSend` detects an `@agent` mention (parsed from the **literal** typed text — never re-parsed from expanded text), it calls `startSubConvo`, which `POST`s the base `/api/conversations` create endpoint with `parentConversationId` + `parentMessageId` set (there is **no** dedicated sub-conversation *creation* route — `/[id]/sub-conversations` is GET-only and merely enumerates them).

Sub-conversations all carry a `parentConversationId` pointing back to the parent. Their `userId` is **path-dependent**: server-spawned sub-conversations (team members / agent assignments via `start-assignment.ts → createSubConversation`) carry `userId = null` (unowned), whereas this client `@agent` path routes through the base POST handler, which stamps the caller's `userId: user.id`. Because *some* sub-conversations are unowned, the root-walked per-message endpoints (`messages`, `messages/[mid]`) resolve ownership by **walking up `parentConversationId` to the root** and checking the root's `userId` — which works uniformly for both cases.

### Ownership: root-walk, fail-closed

`web/src/lib/server/conversation-ownership.ts#resolveRootConversationForOwnership` is the single extraction of this walk:

- Seeds at the conversation itself (hop 0) and climbs `parentConversationId` up to `MAX_PARENT_DEPTH` (= `LEGACY_PARENT_WALK_HOPS + 1` = 9) hops; a dangling parent or cycle stops the walk and authorizes against the furthest resolvable ancestor.
- Returns `{ conv, root }` — `conv` is self (drives provider/model/projectId reads), `root` gates access. For a top-level conversation `root === conv`.
- Returns `null` (caller → **404**, never 403) in every fail-closed case: missing conversation, missing parent, or root not owned by a non-admin (`root.userId !== user.id && user.role !== "admin"`). Existence is never leaked.

The simpler endpoints (`/[id]` GET/PUT/DELETE, `export`, `clone-turns`, `sub-conversations`) inline the equivalent direct check `conv.userId !== user.id && user.role !== "admin"` since they operate on a single conversation.

### Sidebar grouping (`web/src/lib/conversation-grouping.ts`)

Pure, rune-free helpers:

- `groupConversations` builds **fork families**: each conversation is attributed to its `ultimateRoot` (climb `forkedFromConversationId` until an unloaded/absent parent), flattening forks-of-forks one level up. A root that is itself a fork of something not loaded is flagged `rootIsOrphanedFork`.
- Each family's `familyUpdatedAt = max(updatedAt)` across root + forks, so a stale parent with a fresh fork still surfaces in "Today".
- Families are bucketed by recency into `Today` / `Previous 7 Days` / `Previous 30 Days` / `Older` (24h / 7d / 30d thresholds) and sorted newest-first within each bucket. `unreadForkCount` counts unread forks per family.

## Usage

### REST API

| Method & path | Scope | Purpose |
|---|---|---|
| `GET /api/conversations?projectId=…` | `read` | List for a project (`search=`, or `limit`/`offset` pagination, clamped 1–200). `projectId` required. |
| `POST /api/conversations` | `chat` | Create. Body: `projectId`, optional `title`/`model`/`provider`/`agentConfigId`/`modeId`/`parentConversationId`/`parentMessageId`/`test`. `modeId` pointing at the `ez` mode → 403. |
| `GET /api/conversations/[id]` | `read` | Fetch one (ownership-gated). |
| `PUT /api/conversations/[id]` | `chat` | Update title/model/provider/systemPrompt/modeId/extensionTools. Changing the mode of an `ez` conversation → 403. |
| `DELETE /api/conversations/[id]` | `chat` | Delete (cascades rows; GCs attachment files on disk + reaps any preview process). 204. |
| `GET /api/conversations/[id]/messages` | `read` | Active path by default; `?all=true` (flat), `?leafMessageId=` (path from a leaf), `?withToolCalls=true` (+ sub-conversation tool calls). |
| `POST /api/conversations/[id]/messages` | `chat` | Send. JSON or `multipart/form-data` (attachments). Fields: `content`, `provider`, `model`, `parentMessageId`, `editOf`, `permissionMode`, `thinkingLevel`, `files`. Intercepts `/goal` + `![EZ:]`. |
| `PATCH /api/conversations/[id]/messages/[mid]` | `chat` | Edit content **or** toggle `excluded` (exactly one; XOR-refined). **409** if a run is active. |
| `POST /api/conversations/[id]/clone-turns` | `chat` | Bulk-select turns → new conversation (`messageIds` 1–500, optional `title`). 201. |
| `GET /api/conversations/[id]/sub-conversations` | `read` | Enumerate sub-conversations (ownership-gated). |
| `GET /api/conversations/[id]/export?format=…` | `read` | Download `markdown` (default) or `json`; `?leafMessageId=` picks the branch. |
| `GET / POST /api/conversations/[id]/active-run` | `read` / `chat` | Poll / cancel the active run. **No ownership check — see gotchas.** |

### UI entry points

- The chat page (`web/src/routes/(app)/project/[id]/chat/[convId]/+page.svelte`) is the primary surface; send/edit/regenerate/retry/fallback/branch-navigation all run through `makeSendMessage(host)`.
- The sidebar conversation list renders the `groupConversations` output (recency buckets + collapsible fork families).
- Multi-select bulk actions (e.g. clone-turns, bulk save-to-memory) operate over selected turns.

### Composer mention sigils

The composer recognizes **five** sigils (`web/src/lib/mention-logic.ts`), all sharing one pure module and the `/api/mentions/search?type=` endpoint:

| Sigil | Kinds | Token |
|---|---|---|
| `!` | `agent`, `ext`, `team`, **`EZ`** (runtime action) | `![kind:name]` |
| `@` | `file`, `dir` | `@[kind:relpath]` |
| `/` | `cmd` | `/[cmd:name]` |
| `$` | `feature` | `$[feature:name]` |
| `%` | `lesson` | `%[lesson:name]` |

`parseMentions` runs only on literal typed text; expanded command/feature bodies are never re-parsed.

### Env vars / settings

- `EZCORP_GOAL_ENABLED` (default on) — master kill-switch for the `/goal` interceptor. When off, `/goal` returns a disabled card.

## Key files

- `web/src/routes/api/conversations/+server.ts` — list (GET) + create (POST); `ez`-mode rejection on create.
- `web/src/routes/api/conversations/[id]/+server.ts` — GET/PUT/DELETE one; inline ownership; attachment + preview-process cleanup on delete.
- `web/src/routes/api/conversations/[id]/messages/+server.ts` — send pipeline: multipart parse, `/goal` + `![EZ:]` interception, attachment validation, `streamChat`.
- `web/src/routes/api/conversations/[id]/messages/[mid]/+server.ts` — PATCH message: content edit XOR `excluded` toggle; 409 when a run is active.
- `web/src/routes/api/conversations/[id]/clone-turns/+server.ts` — bulk-clone selected turns into a new conversation.
- `web/src/routes/api/conversations/[id]/sub-conversations/+server.ts` — enumerate sub-conversations (ownership-gated).
- `web/src/routes/api/conversations/[id]/export/+server.ts` — markdown/json export, branch-aware.
- `web/src/routes/api/conversations/[id]/active-run/+server.ts` — poll/cancel active run (IDOR — see gotchas).
- `web/src/routes/api/conversations/schema.ts` — Zod schemas: create/update conversation + clone-turns.
- `web/src/lib/server/conversation-ownership.ts` — `resolveRootConversationForOwnership` root-walk, fail-closed 404.
- `web/src/lib/conversation-grouping.ts` — pure sidebar fork-family + recency-bucket helpers.
- `web/src/lib/chat/page-handlers/send-message.ts` — client send/edit/regenerate/retry/fallback/branch + sub-convo handler family.
- `web/src/lib/mention-logic.ts` — the five-sigil mention trigger/tokenize logic.
- `src/db/queries/conversations.ts` — `createConversation`, `createSubConversation`, `listConversations`, `searchConversations`, `getConversationPath`, `getLatestLeaf`, `cloneTurnsIntoNewConversation`, `setMessageExcluded`, `updateMessageContent`, etc.
- `src/db/schema.ts` — `conversations` / `messages` tables (`parentConversationId`, `forkedFromConversationId`, `parentMessageId`, `excluded`).
- `src/runtime/goal-host.ts` — `/goal` parsing/dispatch, `metadata.goal` persistence, in-memory `GoalRecord` map, `goal:update` SSE.

## Features it touches

- [[streaming-runtime]] — the send pipeline hands off to `executor.streamChat`; the assistant turn streams back over SSE.
- [[runs-lifecycle]] — each send mints a `runId`; the active-run route polls/cancels it; PATCH is blocked while a run is active.
- [[attachments]] — multipart sends validate + persist files; delete GCs them from disk.
- [[goal-autopilot]] — `/goal` is intercepted inline in the messages route; state rides in `metadata.goal`.
- [[ez-concierge-and-actions]] — `![EZ:]` action tokens fire in the send pipeline; `ez`-mode conversations are locked.
- [[mention-grammar]] — the five-sigil composer grammar feeds `@agent` sub-convo spawning and `!ext` MIME wiring.
- [[agents]] — `@agent` mentions spawn sub-conversations bound to an agent config.
- [[teams]] — team members run as sub-conversations under the parent root.
- [[persistent-memory]] — single-message and bulk save-to-memory from the message toolbar.
- [[context-compaction]] — the active-path messages (minus `excluded`) form the model's input window.
- [[projects]] — conversations are project-scoped; `projectId` is required to list/create.
- [[providers-and-models]] — per-conversation `provider`/`model` and `/model` slash-command switching.
- [[message-toolbar]] — edit / regenerate / retry / save-memory actions originate from per-message UI.
- [[api-security]] — every route is gated by `requireScope` + `requireAuth`; ownership is fail-closed 404.
- [[preview-port-exposure]] — deleting a conversation reaps its per-conversation preview process + uid.

## Related docs

- [[rewind-branching-sessions]] — the durable session-tree layer on top of this `messages` tree: rewind/checkpoint, clean A/B retry, and reload-restore of the active branch.

(See [slash-commands](../../slash-commands.md) for `/`-command expansion and [context-compaction](../../context-compaction.md) for how the active path becomes the input window.)

## Notes & gotchas

- **Active-run IDOR (OPEN).** `GET`/`POST /api/conversations/[id]/active-run` only call `requireAuth` + `requireScope` — there is **no** conversation-ownership check. SvelteKit does not wrap child `+server.ts` handlers in a parent guard, so this child route is unprotected: any authenticated user can poll another user's live run (leaking `partialResponse`) or cancel it cross-tenant. Every other per-message route (`messages`, `messages/[mid]`, `sub-conversations`, `clone-turns`, `export`) does gate ownership. Treat this as a known open finding, not fixed.
- **No `/goal-state` route.** `/goal` is intercepted inline in `messages/+server.ts`; state lives in `conversations.metadata.goal` JSONB + an in-memory `Map` in `goal-host.ts` + a `goal:update` SSE event. Don't look for a dedicated route.
- **`editOf` is request-only.** There is no `editOf` column on `messages`. The server resolves `editOf` to a sibling `parentMessageId`; the branch tree is purely `parentMessageId` edges.
- **`excluded` toggles are run-gated.** `PATCH /messages/[mid]` returns **409** while a run is active — a mid-flight context swap would change the window pi-ai already snapshotted. The PATCH schema is a single object with an XOR refine (`content` XOR `excluded`), not a `z.union`, to avoid silently dropping a field.
- **Sub-conversation ownership is path-dependent.** Server-spawned sub-conversations (team/agent assignments) carry `userId = null` (unowned); the client `@agent` path mints them through the base `/api/conversations` POST, which stamps the caller's `userId`. The root-walk gate (capped at 9 hops to defend against a corrupt `parentConversationId` cycle) authorizes both uniformly by checking the root's `userId`.
- **`ez`-mode is locked.** A regular `POST` cannot adopt `slug='ez'` (403), and `PUT` cannot change an `ez` conversation's mode (403) — the Ez concierge harness is the sole producer of `ez`-kind conversations via `getOrCreateEzConversation`.
- **Fork vs. sub-conversation are different edges.** Forks use `forkedFromConversationId` (SET NULL on delete → orphaned-fork roots in the sidebar); sub-conversations use `parentConversationId` (CASCADE). Don't conflate them.
- **Leaf resolution skips capability events.** `getLatestLeaf(..., { excludeCapabilityEvents: true })` ignores trailing root-level `capability-event` rows; without it the bare `/messages` endpoint could return only an orphan annotation and drop the whole thread.
- **Delete is multi-resource.** `DELETE /[id]` cascades DB rows but also manually GCs attachment files on disk and reaps any per-conversation preview process/uid before the cascade — both have side effects outside the DB transaction.
