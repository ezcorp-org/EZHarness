# Ask-User (Human-in-the-Loop)

> _Lets the LLM pause a run mid-stream to ask the user a question — multiple-choice or free-text — and resume with the answer, via the bundled `ask-user` extension that is auto-wired into every conversation turn._

## Intent

Some turns can't be completed without a human decision: a clarification, a yes/no, a choice between options. `ask_user_question` is the LLM-facing tool that surfaces that question as an inline card in the assistant bubble and **blocks the run** on a process-local promise gate until the user answers. It is provided by the bundled `ask-user` extension (replacing the old orchestration `ask_human`), and it is **critical** — the loop-safety floor that keeps an agent from getting trapped because it has no way to ask for help. Because the tool requires its own use to be useful, it can't be discovered lazily, so the host auto-wires it on **every** turn before tool-loading resolves.

## How it works

The flow is a two-hop bridge between the run subprocess (where the gate lives) and an HTTP POST (where the answer arrives), mediated by an in-memory registry because the `tool_calls` DB row does not exist yet while the gate is open.

1. **Auto-wire (every turn).** In `src/runtime/stream-chat/setup-tools.ts` (section 2c, before the generic `convExtIds` loop), `ensureAskUserWired(conversationId)` does an idempotent `onConflictDoNothing` insert into `conversation_extensions`, then `wireAskUserToolForTurn(...)` appends the namespaced `ask-user__ask_user_question` tool to `ctx.agentTools` with `invocationMetadata: { conversationId }`. A dedup guard skips if a tool of that name is already present, so the later generic loop can't double-wire it without the metadata.
2. **`execute` wrapper registers the pending call.** `wireAskUserToolForTurn` wraps the agent tool's `execute` so that, at invoke time, it calls `registerPendingAskUser(toolCallId, conversationId, userId, { question, options })` into the in-memory map in `src/runtime/ask-user-registry.ts`, runs the real handler, and `clearPendingAskUser(toolCallId)` in a `finally`. `toolCallId` is added to `invocationMetadata` by the per-call seam in `extensionToAgentTool` (`src/extensions/tool-executor.ts`); the handler receives both `toolCallId` and `conversationId` on `ctx.invocationMetadata`.
3. **LLM calls the tool.** The host emits `tool:start` carrying `cardType: "ask-user-question"`, `input.question`, `input.options`, and the host-minted `invocationId` (= `toolCallId`). The chat UI's tool-card renderer maps that cardType to `AskUserQuestionCard.svelte` (`web/src/lib/components/tool-cards/utils.ts:33`), which renders inline — one button per option when `options` is non-empty, a textarea otherwise.
4. **Extension handler opens the gate.** The extension (`docs/extensions/examples/ask-user/index.ts`) reads `toolCallId` + `conversationId` from `ctx.invocationMetadata`, registers a `{resolve, reject, conversationId}` record in its own process-local `pendingAskUser` map keyed on `toolCallId`, and `await`s a promise. There is **no server-side timer** — the wait is bounded by the user. The tool's `requiresUserInput: true` flag (manifest) opts the call out of both the subprocess JSON-RPC timeout (`tool-executor.ts:1192`) and the watchdog idle-kill (`executor-watchdog.ts:274` returns `"awaiting user input"` so the run never trips `callTimeoutMs`).
5. **User answers → POST.** Clicking an option (or submitting text) `POST`s `{ toolCallId, answer }` to `/api/ask-user/answer`. The endpoint (`web/src/routes/api/ask-user/answer/+server.ts`) looks up the pending entry via `getPendingAskUser(toolCallId)` — **from the in-memory registry, not a `tool_calls` SELECT** — checks `pending.userId === user.id`, and emits `ask-user:answer` on the host bus with `{ toolCallId, conversationId, answer }`.
6. **Gate resolves.** The host's event dispatcher delivers `ask-user:answer` to every extension subscribed and wired to the conversation. The `ask-user` handler matches `toolCallId` in its pending map, re-checks `conversationId` (defense-in-depth against a same-process UUID-guess), resolves the promise with `answer`, and `tools.ask_user_question` returns `toolResult(answer)`. The run continues; the `tool_calls` row is now written, the card flips to **Answered**.

### Why an in-memory registry (the core invariant)

`ToolExecutor.recordToolCall()` writes the `tool_calls` row **after** the subprocess returns. For `ask_user_question` the subprocess does not return until the user answers — so for the entire window the user can click an option, **no DB row exists**. A `SELECT`-by-id would silently miss every legitimate POST, the endpoint would no-op, and the card would hang at "Sending…". The registry in `ask-user-registry.ts` is populated by the wire wrapper's `execute` (step 2) and cleared in its `finally`, so the lookup is O(1) and race-free. Entries are impossible to leak in production: every entry is set+cleared by the same `try/finally`, which still runs on subprocess crash or abort.

### Refresh / reconnect re-hydration

The same registry feeds the active-run poll so a reloaded client can re-surface an in-flight question:

- `GET /api/conversations/[id]/active-run` (`web/src/routes/api/conversations/[id]/active-run/+server.ts`) calls `getPendingAskUserForConversation(id)` and returns the open gates as `pendingAskUser: [{ toolCallId, question, options, userId }]`.
- The client (`web/src/lib/chat/page-handlers/stream-resume.svelte.ts`, ~L276) pushes a synthetic `running` tool-call card per entry into `store.streamingToolCalls` (toolName `ask-user__ask_user_question`, `cardType: "ask-user-question"`), deduped by `toolCallId`. The live `tool:complete` later updates it in place. This is the **only** way a refreshed client learns about a question whose `tool_calls` row doesn't exist yet.

## Usage

### LLM tool

The model calls `ask_user_question` (exposed namespaced as `ask-user__ask_user_question`):

```jsonc
// inputSchema (ask_user_question)
{
  "question": "string (required)",
  "options": ["string", ...]   // optional; buttons when present, free-text textarea when omitted
}
```

It is auto-wired on every turn — no `!ext:` mention, no agent-config reference, and no mode declaration is required to make it available. The tool returns the user's answer verbatim as the tool result.

### REST API

| Method & path | Scope | Purpose |
|---|---|---|
| `POST /api/ask-user/answer` | `chat` | Resolve a pending gate. Strict body `{ toolCallId, answer }` (both non-empty). Emits `ask-user:answer`. |
| `GET /api/conversations/[id]/active-run` | `read` | Poll; returns `pendingAskUser[]` for any open gates in the conversation (used for refresh re-hydration). |

`POST /api/ask-user/answer` auth chain: `requireScope(locals, "chat")` → `requireAuth(locals)` → ownership (the gate's recorded owner `userId` must equal the acting user; mismatch → **404**, not 403, so existence isn't disclosed). When no pending entry exists (gate already collapsed via answer, abort, or restart) it returns `{ ok: true }` **without** emitting — the optimistic late-POST contract, mirroring the legacy human-input endpoint.

### UI

`AskUserQuestionCard.svelte` renders inline in the assistant message. States: `running` (buttons / textarea active) → `submitting` ("Sending…", controls disabled, no local optimistic complete) → `complete` ("Answered: …") or `error`. Enter submits a textarea answer, Shift+Enter inserts a newline. A missing `toolCall.id` renders an inert error block instead of POSTing.

### Manifest / wiring facts

- `docs/extensions/examples/ask-user/ezcorp.config.ts` — `schemaVersion: 2`, `persistent: true`, `permissions.eventSubscriptions: ["ask-user:answer"]`, no storage/spawn/network. The tool declares `cardType: "ask-user-question"` and `requiresUserInput: true`.
- Registered as **bundled + `critical: true`** in `src/extensions/bundled.ts` (path `docs/extensions/examples/ask-user`). The loop-safety floor in that file refuses to leave it disabled at boot; `src/startup/assert-critical-extensions.ts` lists it with the rationale "agents cannot ask the user for clarification".

## Key files

- `docs/extensions/examples/ask-user/index.ts` — the bundled extension: `ask_user_question` handler (promise gate keyed on `toolCallId`), `ask-user:answer` subscription handler, `start()` wiring via `createCanvas`.
- `docs/extensions/examples/ask-user/ezcorp.config.ts` — manifest: schema, `persistent`, `cardType`, `requiresUserInput`, `eventSubscriptions`.
- `src/runtime/ask-user-host.ts` — `ensureAskUserWired` (idempotent `conversation_extensions` insert) + `wireAskUserToolForTurn` (per-turn append with `invocationMetadata`, wraps `execute` to register/clear the registry entry).
- `src/runtime/ask-user-registry.ts` — in-memory `toolCallId → { conversationId, userId, question?, options? }` map; `registerPendingAskUser` / `getPendingAskUser` / `getPendingAskUserForConversation` / `clearPendingAskUser`.
- `web/src/routes/api/ask-user/answer/+server.ts` — `POST` handler: scope+auth+owner check, registry lookup, emits `ask-user:answer`, optimistic late-POST `{ ok: true }`.
- `web/src/routes/api/conversations/[id]/active-run/+server.ts` — `GET` returns `pendingAskUser[]` from the registry for refresh re-hydration (and the IDOR caveat below).
- `web/src/lib/components/tool-cards/AskUserQuestionCard.svelte` — inline question card (options grid / textarea, submit → `POST /api/ask-user/answer`).
- `web/src/lib/components/tool-cards/utils.ts` — maps `cardType: "ask-user-question"` → `AskUserQuestionCard`.
- `web/src/lib/chat/page-handlers/stream-resume.svelte.ts` — pushes synthetic `running` cards for `pendingAskUser` entries on refresh / reconnect (deduped by `toolCallId`).
- `src/runtime/stream-chat/setup-tools.ts` — section 2c auto-wire call site (`ensureAskUserWired` + `wireAskUserToolForTurn`, fail-soft).
- `src/extensions/bundled.ts` — registers `ask-user` as bundled + `critical: true` with the loop-safety floor.
- `src/startup/assert-critical-extensions.ts` — boot assertion that `ask-user` is installed.
- `src/runtime/executor-watchdog.ts` — `requiresUserInput` tools defer the idle-kill indefinitely (`"awaiting user input"`).
- `src/extensions/tool-executor.ts` — per-call `invocationMetadata` seam adds `toolCallId`; `requiresUserInput` skips the JSON-RPC timeout race.
- `src/types.ts` — `AgentEvents["ask-user:answer"]` payload type (`{ toolCallId, conversationId, answer }`).
- `web/src/lib/runtime-event-names.ts` / `src/runtime/sse-conversation-filter.ts` — `ask-user:answer` registered as a known conversation-scoped event.

## Features it touches

- [[streaming-runtime]] — the question rides the normal `tool:start` / `tool:complete` lifecycle; the gate blocks the streaming run until resolved.
- [[runs-lifecycle]] — `requiresUserInput: true` keeps the run alive past `callTimeoutMs` and past the watchdog idle-kill; abort still tears the gate down.
- [[conversations]] — auto-wired per conversation turn; the gate's owner check rides the conversation's owning `userId`; the active-run poll re-hydrates the card.
- [[bundled-catalog]] — `ask-user` is a bundled, `critical` extension auto-installed at boot.
- [[runtime-and-rpc]] — the gate lives in the persistent extension subprocess; the answer crosses back over the JSON-RPC/event bridge.
- [[permissions-and-grants]] — the extension declares only `eventSubscriptions: ["ask-user:answer"]` (no storage/spawn/network); the POST route is `requireScope("chat")` + owner-gated.
- [[canvas-cards]] — the inline card uses the SDK `createCanvas` surface (`cardType: "ask-user-question"`), shared with `claude-design`.
- [[message-toolbar]] — the question card renders inline in the assistant message bubble.
- [[ez-concierge-and-actions]] — the Ez concierge wires its own client-side tools in the same `setup-tools.ts` section right after the ask-user block.

## Related docs

None yet — this is the primary reference. (See [canvas-cards](../../extensions/canvas-cards.md) for the `createCanvas` card surface this tool registers on, and [data-storage](../../extensions/data-storage.md) for the extension data convention generally — ask-user itself stores nothing.)

## Notes & gotchas

- **The registry — NOT a `tool_calls` SELECT — is authoritative.** Both `index.ts` and `ezcorp.config.ts` comments still claim the POST endpoint "looks up `conversationId` from the `tool_calls` DB table." That is stale: the live `+server.ts` reads `getPendingAskUser` from the in-memory `ask-user-registry`. Trust the registry path — a DB SELECT would miss every in-flight gate because the row isn't written until the gate resolves.
- **Active-run IDOR is OPEN.** `GET`/`POST /api/conversations/[id]/active-run` only call `requireAuth` + `requireScope` — there is **no** conversation-ownership check (SvelteKit does not wrap a child `+server.ts` in a parent guard). So a `GET` leaks another user's `pendingAskUser` questions (and `partialResponse`); a `POST` can cross-tenant cancel. The `POST /api/ask-user/answer` endpoint **is** owner-gated, so an attacker can read the question text but cannot answer someone else's gate. Treat the active-run leak as a known open finding, not fixed.
- **No server-side timeout.** The wait is unbounded by design; only a user answer, a run abort, or a subprocess crash collapses the gate. Don't add a timer expecting `callTimeoutMs` to fire — `requiresUserInput` deliberately defeats both the JSON-RPC timeout race and the watchdog idle-kill.
- **Late POST is a silent no-op.** A POST after the gate has collapsed (answered elsewhere, aborted, server restarted) returns `{ ok: true }` without emitting `ask-user:answer`. The UI has usually already locally dismissed the card; surfacing an error here would just be noise.
- **Owner mismatch returns 404, not 403.** So a caller can't probe for the existence of another user's pending tool call.
- **Namespaced name matters.** The tool must be wired by its registry namespaced name `ask-user__ask_user_question`; passing the bare `originalName` makes the wrapper call `executeToolCall("ask_user_question", …)`, the registry lookup returns null, and the LLM sees "Unknown tool: ask_user_question".
- **`critical: true` is the loop-safety floor.** The harness-smoke-test incident trapped an agent precisely because S9 auto-disabled `ask-user` at boot and the agent had no way to ask a clarifying question. The bundled floor and the boot assertion now refuse to leave it disabled.
- **Defense-in-depth `conversationId` re-check.** Even though the host's event dispatcher already clamps `ask-user:answer` delivery to wired extensions in the matching conversation, the extension handler still re-checks `pending.conversationId === conversationId` before resolving — closing a same-process UUID-guess surface from a colluding extension.
