# Caller-Executed Tools

> _An external application holding an API key declares tool definitions on a conversation. When the LLM calls one, the run pauses behind a permission gate, the call is emitted over SSE, the app executes it on its OWN machine, POSTs the result back, and the run resumes._

## Intent

Everything the LLM can do today runs on the EZCorp host: built-in file and shell tools, sandboxed extensions, MCP servers. That is the wrong place for anything whose value is being *where the user is* — opening an app on a laptop, reading a sensor on a phone, driving a desktop automation. Those need to run on the client, and the client is the one thing the host cannot reach.

Caller-executed tools invert the direction. A connected application declares what it can do, the host advertises those tools to the model like any other, and when one is called the host suspends the run and hands the call back out to whoever is holding the key. It is the same suspend-and-resume shape as [Ask-User](ask-user.md) — an in-memory gate, an SSE delivery, an HTTP POST that wakes it — with a machine on the far end instead of a human.

## How it works

```
app ──PUT  /api/conversations/:id/caller-tools──────────────► metadata.callerTools
                                                                    │
                                        (next turn) wired as _caller__<name>
                                                                    ▼
                                                             LLM calls it
                                                                    │
                                          permission gate opens ────┤ tool:permission_request
                                                                    │
app ──POST /api/tool-calls/:id/permission──────────────────────────►┤
                                                                    │
app ◄─────────────────────────── SSE caller:tool-call ──────────────┤
   executes locally                                                 │
app ──POST /api/conversations/:id/tool-results─────────────────────►┤
                                                              run resumes
```

1. **Declare.** `PUT /api/conversations/:id/caller-tools` stores the declarations in `conversations.metadata.callerTools`. The write goes through `mergeConversationMetadata` (`src/db/queries/conversation-metadata.ts`), which merges the key inside ONE `UPDATE` — `metadata` is a shared jsonb bag whose other owners (`goal`, `spawnDepth`, `spawnParentAuditId`) write concurrently, and a JS read-modify-write here would silently destroy one side.
2. **Wire.** On the NEXT turn the runtime reads the declarations back and wires each one as `_caller__<name>`. Declarations bind at turn setup, so a write during a live run cannot affect it — the PUT response says so explicitly (`appliedFrom: "next-turn"`, plus the `activeRunId` it will not affect).
3. **Gate.** The call opens a permission gate. Always — see [Security posture](#security-posture).
4. **Deliver.** After approval the host emits `caller:tool-call` with `{ conversationId, runId, toolCallId, toolName, input, userId }`. The event is a member of `SCOPED_RUNTIME_EVENT_TYPES` (`src/runtime/sse-conversation-filter.ts`), which means it is filtered **fail-closed** and is **not** extension-subscribable — its `input` is the LLM's raw arguments for something that will execute on a user's own machine.
5. **Execute + return.** The app runs the call and POSTs `{ toolCallId, result }` to `/api/conversations/:id/tool-results`, which resolves the suspended promise. The run resumes with the result rendered as fenced JSON into the LLM-visible content.

### Naming, and why the rules are strict

A declared name must match `/^[a-z](?!.*__)[a-z0-9_]{2,47}$/` — lowercase, 3–48 characters, and **no consecutive underscores anywhere**.

The `__` ban is the load-bearing one. The runtime namespaces a declaration as `_caller__<name>`, and every consumer of a namespaced tool name splits on the FIRST `__`. A name containing its own `__` would strip to something other than what was declared, which is how a revocation toggle silently stops matching the tool it is meant to revoke.

For the same reason a name may not collide with a built-in tool, nor land in `CALLER_TOOL_RESERVED_NAMES` — the orchestration set plus `run_workflow`, `task_add`, `task_resume`, `dispatch_run`. `_caller__invoke_agent` strips to `invoke_agent`, so it would answer namespace-stripping deny rules meant for the real spawn primitive, in both directions.

### Why `parameters` is validated at declare time

`BuiltinToolDef.parameters` is `Type.Unsafe(...)`, so TypeBox validates nothing on the way to the provider, and pi-agent-core does not validate tool arguments at runtime either. A malformed JSON Schema is accepted silently and then 400s the conversation's **next** turn — and every turn after that — as an opaque provider error. The declaration call is the last moment the caller can be told which of its own fields is wrong, so that is where the structural rules run (`src/runtime/caller-tool-declarations.ts`):

| Rule | Value |
|---|---|
| `parameters.type` | exactly `"object"` |
| `parameters.properties` | absent, or a plain object (may be empty) |
| Forbidden anywhere in the tree | `$ref`, `$defs`, `definitions`, `$schema`, `$id` |
| Max nesting depth | 5 |
| Max `properties` entries (recursive) | 64 |
| `JSON.stringify(parameters).length` | ≤ 8 192 |
| Tools per conversation | ≤ 16 |
| Declare body | ≤ 64 KiB |

## Security posture

**A caller tool ALWAYS opens a permission gate.** The `caller` category appears in no `AUTO_APPROVE` set, so `needsApproval(category, mode)` returns `true` for `ask`, `auto-edit` **and** `yolo`. That is not belt-and-braces: `permissionMode` is client-supplied, threaded verbatim into the top-precedence slot, and its default is `yolo`. Without the category exclusion a caller could disable its own gate with a field in the message body.

**Self-approval by the declaring key is permitted, and documented.** The key holder wrote the code the tool runs, so approving its own call grants nothing it did not already have. What the gate buys is a recorded, per-call, deniable, bounded decision — an audit trail, plus live visibility and a veto for the human owner watching the conversation.

**Results are untrusted input.** A tool result comes from an external machine and lands in the prompt. It is the same trust class as a web-fetch result, and it is bounded the same way: 256 KiB on the wire, 64 KiB of rendered text, and a tool description that tells the model so in as many words.

**A result is accepted only from the client the call was addressed to.** Ownership is not attribution: scope, the URL-vs-registry conversation match, the registry's `userId` and conversation ownership are all satisfied by *any* credential of the same user, and both families' call events ride SSE to every connection that user holds. So `POST …/tool-results` applies two further rules (`maySettleRemoteTool`):

1. **Family.** The pending entry's `origin` names the client the call went to. `ez` is the in-page panel — only ever a cookie session; `caller` is an external application — only ever an API key. Neither can *execute* the other's call, so neither may answer it. This is what stops a leaked companion key forging a `read_page` result, and a caller-tools client answering an Ez call.
2. **Key.** Within the caller family, a key may not settle a call raised by a run some *other* key started. The initiator is read at registration time from the same ambient store `createPermissionGate` uses (`src/auth/gate-initiator.ts`), never from the answering request.

Rule 2 is deliberately narrower than the identical-looking confinement on `POST /api/tool-calls/:id/permission`. That route can demand the initiator outright, because a gate is a *decision* and an unattributed one stays answerable by the owner's session. A tool result is not: it is the only way the run can proceed, and the topology above has a person send the message and approve the gate while the **app** — a different principal — executes and returns the call. A call attributable to a session, or to nothing, therefore rests on rule 1, which already excludes every principal that could not have run the tool.

Refusals are 404 like every other refusal here: a 403 would confirm the `toolCallId` names a real suspended call.

**The gate card's arguments are not extension-subscribable.** `caller:tool-call` is in `SCOPED_RUNTIME_EVENT_TYPES` precisely so no extension receives the LLM's raw arguments for a call about to run on a user's machine — but `tool:permission_request` carries the same arguments a moment earlier and *is* a direct carrier. It is therefore in the dispatcher's `HEAVY_PAYLOAD_EVENTS`, so `input` is stripped unless an extension opts in with `includeFullPayload`, and the emit carries the conversation owner's `userId` so the SSE filter narrows it to that subscriber instead of falling through to its fail-**open** conversation check.

> **Operator rule.** A mode handed to a constrained key must not contain `shell` or `edit_file`. A tool-surface policy constrains WHICH tools a key can reach; it does not constrain what those tools do once reached. Two credentials that differ only in their caller-tool allowlist are not meaningfully different if both modes carry a shell.

**Known, and not closed here:** `POST /api/tool-calls/:id/permission` is `chat`-scoped and ownership-gated, so a key that can answer its own caller-tool gates can also answer a gate raised by the owner's own cookie-driven run — including a `shell` gate. The caller wire-filter does not close that; it only touches `_caller__*`.

## Revocation and the UI

Caller tools are modelled as a pseudo-extension under the literal key `"caller"`, so they ride the machinery that already exists for narrowing a conversation's tool surface. A real extension NAMED `caller` cannot collide: every real extension's registry and toggle key is a UUID.

- **`/api/tools`** lists them as `extension: "caller"`. `resolveScopedTools` reads `conv.metadata.callerTools` and injects synthetic `BuiltInToolMeta` rows with `category: "caller"` — `extension` is derived downstream as `t.category`, which is what makes the listing key and the toggle key the same string. The rows are spread onto a copy: `getBuiltInToolMetadata()` returns the process-wide cache **by reference**, and a `.push()` would graft one user's declarations onto every subsequent response for the life of the process.
- **The composer's 🔧 Tools popover** grows a "Caller tools" section (`ConversationToolsSelector.svelte`), fed by `GET /api/conversations/:id/caller-tools`. Its toggles flow through the unmodified `tool-scope-logic.ts` path — plain `map[extId]` access, no UUID assumption anywhere.
- **The toggle is a real revocation.** `computeModeToolScope` compiles the `caller` key into `forceDeniedTools`, the one filter layer that is not preservation-exempt. Absent key = all pass; `[]` = all denied; a non-empty subset denies what it omits. Denials are emitted in BOTH the bare and namespaced forms, because the executor filters `_caller__*` `AgentTool`s while `/api/tools` filters bare metadata rows and `forceDeniedTools` is exact-match — one form alone would revoke in one surface and not the other.

## Usage

### REST API

| Method & path | Scope | Notes |
|---|---|---|
| `PUT /api/conversations/:id/caller-tools` | `chat` | Declare the set (replaces). **Root conversations only** — 400 on a sub-conversation. 1/s per user, body ≤ 64 KiB. → `{ tools, appliedFrom: "next-turn", activeRunId }` |
| `GET /api/conversations/:id/caller-tools` | `read` | Read back what is stored. → `{ tools }` |
| `DELETE /api/conversations/:id/caller-tools` | `chat` | Drop the key. Idempotent. → `{ ok: true, cleared }` |
| `POST /api/conversations/:id/tool-results` | `chat` | Return a result. 20/s per user, body ≤ 256 KiB. → `{ ok, resolved, reason? }` |
| `GET /api/conversations/:id/active-run` | `read` | Recovery drain — what is still awaiting a result. |

Ownership denial is **404 everywhere**, never 403, so none of these is a conversation-id oracle. Root-only is a WRITE rule: a sub-conversation inherits no declarations, so accepting one there would look like it worked and do nothing — the 400 names the root id to use instead.

**`ok` and `resolved` answer different questions.** `ok` means the request was accepted; `resolved` means THIS result reached the waiting tool. Two devices on one key both receive the event and both POST — the first wins, and the second gets `{ ok: true, resolved: false, reason: "already-resolved" }`. Nothing it did was wrong, and it needs to know its bytes were discarded before it reports success to its user.

### Harness client

`@ezcorp/harness-client` ships the whole loop:

```ts
const ez = new HarnessClient({ baseUrl, apiKey });

await ez.declareCallerTools(conversationId, [{
  name: "open_app",
  description: "Open an application on the connected device",
  parameters: { type: "object", properties: { app: { type: "string" } }, required: ["app"] },
}]);

const device = new AbortController();
await ez.serveCallerTools(conversationId, {
  open_app: async ({ app }) => ({ opened: await openApplication(app) }),
}, { signal: device.signal });
```

`serveCallerTools` approves each `_caller__*` gate (`autoApprove`, default true — a client that did not answer its own gates would park every call until it timed out), runs the handler keyed by the BARE name, and POSTs the result. A handler that throws reports a tool-level failure without ending the loop. **A tool with no registered handler is answered immediately** rather than ignored: parking the gate for its full timeout reaches the same outcome minutes later with less information in it.

### Recovery after a disconnect

Recovery is a **drain**, not a replay. `serveCallerTools` re-reads `GET …/active-run` on every connect and reconnect, before the event loop starts, and dispatches anything it reports as pending. The field is `pendingCallerTools`, present on **every** response shape that route returns — a client draining on reconnect asks without first knowing whether a run is live, so a field on only some shapes would make recovery depend on which branch answered. It is narrowed twice (`getPendingCallerToolCallsForUser`): to the `caller` origin, so an external application is never handed the Ez panel's pending DOM operations; and to the requesting user, because the ownership walk admits an **admin** on someone else's conversation and the payload is the raw arguments for a call about to run on the owner's own machine. Each entry is the `caller:tool-call` event minus its `userId` — re-dispatchable, and carrying no principal ids.

**Revoking ends the calls in flight.** `DELETE …/caller-tools` clears the declarations and then rejects anything still suspended on that conversation (`caller` origin only). Revoking is the client saying it has stopped serving, so a call already on the wire has nobody left to answer it; parking it for the rest of its 120 s gate reaches the same failure minutes later with less information in it. The rejection carries a sentence the model can read, and the teardown is not conditional on `cleared` — DELETE is idempotent, so the bag can already be empty while a call opened by the turn that read the *first* declaration is still outstanding. `Last-Event-ID` replay is best-effort and cannot be relied on: the server's SSE resume ring holds 500 GLOBAL entries including every `run:token`, so a busy instance turns it over in seconds and a `caller:tool-call` from before a five-second blip is simply gone. Both halves feed one `toolCallId` dedupe set, so a call delivered by replay AND by drain executes exactly once.

## Limits and known gaps

- **A restart loses in-flight calls.** The gate registry is in memory, and boot terminalizes every prior run. This is structural and shared with all three existing gates (permissions, ask-user, Ez client tools). Declarations survive; recovery is one re-sent message.
- **In-memory registries assume one process.** True by construction today (PGlite is single-writer). A multi-replica deploy breaks this, permission gates, ask-user, and Ez client tools identically.
- **The human owner is never constrained.** These controls bind the key, not the owner's cookie session. This is not tenant isolation.

## Key files

| Area | File |
|---|---|
| Declaration validation + reserved set | `src/runtime/caller-tool-declarations.ts` |
| Atomic metadata writes | `src/db/queries/conversation-metadata.ts` |
| Declare / read / clear routes | `web/src/routes/api/conversations/[id]/caller-tools/{+server,schema}.ts` |
| Result submission | `web/src/routes/api/conversations/[id]/tool-results/+server.ts` |
| SSE scoping (fail-closed, not extension-subscribable) | `src/runtime/sse-conversation-filter.ts` |
| Event-name contract | `web/src/lib/runtime-event-names.ts` (+ the harness-client mirror) |
| `/api/tools` parity | `web/src/lib/server/scoped-tools.ts`, `src/runtime/tools/builtin-registry.ts` |
| Revocation | `src/runtime/tools/mode-tool-scope.ts` |
| Composer UI | `web/src/lib/components/ConversationToolsSelector.svelte` |
| Consent prompt | `web/src/lib/components/tool-cards/PermissionGate.svelte` |
| Client | `packages/@ezcorp/harness-client/src/index.ts` |
| E2E | `web/e2e/caller-tools-ui.spec.ts`, `web/e2e/real-auth/caller-tool-flow.spec.ts` |
