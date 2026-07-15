# @ezcorp/harness-client

Remote-control client for an [EZCorp](https://github.com/ezcorp-org/ezcorp)
instance. Lets an external runner — a Playwright suite, a CI script, or
another agent — **configure**, **drive**, **observe**, and (against a
test-mode instance) **deterministically test** the harness over HTTP + SSE.

## Auth

Mint a key on the instance (cold-start, no UI needed):

```sh
ezcorp key mint --scopes read,chat
```

With the embedded PGlite database, run this while the server is **stopped**
(or use external Postgres via `DATABASE_URL`): the datadir is single-writer,
and the CLI refuses to open it while a live server holds it. Against a
running server, mint through it instead — Settings → Developer → API keys,
or `POST /api/settings/developer/api-keys` with an admin session.

Pass it to the client as a bearer token. Scopes: `read` (observe), `chat`
(drive + approve), `extensions`, `admin`.

## Quick start

```ts
import { HarnessClient } from "@ezcorp/harness-client";

const ez = new HarnessClient({
  baseUrl: "http://localhost:3000",
  apiKey: process.env.EZCORP_API_KEY, // an ezk_* key
});

// Configure
await ez.setSetting("provider:defaultTier", "balanced");

// Drive a real conversation and block for the result
// (`projectId` defaults to "global"; the server requires one)
const convo = await ez.createConversation({ title: "smoke" });
const result = await ez.runToCompletion(convo.id, "What is 2 + 2?", {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
});
console.log(result.outcome, result.run.result?.output);

// Observe the live event stream (run correlation by runId in event.data)
const ac = new AbortController();
for await (const evt of ez.streamEvents({ conversationId: convo.id, signal: ac.signal })) {
  if (evt.type === "run:complete") ac.abort();
}
```

## Deterministic testing (test-mode instances)

When the instance runs with `PI_E2E_REAL=1` (non-production), script the LLM
and the entire turn — including tool calls — replays deterministically:

```ts
const r = await ez.runScripted(
  convo.id,
  "read the config",
  [
    { toolCalls: [{ name: "readFile", arguments: { path: "README.md" } }] },
    { text: "Here is what I found." },
  ],
);
// permissionMode defaults to "yolo" so tool turns auto-approve; pass
// permissionMode: "ask" and use resolveToolPermission() to test the gate.
```

`runScripted` seeds the mock LLM under a key and drives the message with
`provider: "ezcorp-mock", model: "mock:<key>"`. Only the LLM's HTTP boundary
is faked — the real tool loop, permission gates, persistence, and runtime
SSE all execute.

## Extensions

Wire installed extensions to a conversation and invoke their tools directly —
the typed path a harness uses to drive an extension without the `!ext:name`
chat mention. The `extensions` scope is required to wire or invoke; `read`
lists.

```ts
// Discover what's installed (bare array; scratchpad, task-tracking, …)
const installed = await ez.listExtensions();

// Wire one (or several) to a conversation. All-or-nothing on unknown names;
// idempotent, so re-wiring is a safe no-op.
const { wired, extensionIds } = await ez.wireExtensions(convo.id, ["scratchpad"]);
console.log(await ez.listWiredExtensions(convo.id)); // [{ id, name: "scratchpad" }]

// Invoke a wired tool. `invocationId` is auto-generated when omitted; a
// tool-level failure resolves with { success: false, error } (it does NOT
// throw — only transport/scope/ownership errors throw HarnessApiError).
const write = await ez.invokeExtensionTool(convo.id, "scratchpad", "scratchpad_write", {
  key: "greeting",
  value: "hello",
});
const read = await ez.invokeExtensionTool(convo.id, "scratchpad", "scratchpad_read", {
  key: "greeting",
});
console.log(write.success, read.output);
```

An extension must be **wired** to the conversation before its storage-scoped
tools succeed (unwired → `{ success: false, error: "Extension not wired to
this conversation" }`). `GET /api/extensions/:name/tools` reads the LIVE
registry and 404s until the extension is loaded — expected in v1, not a bug.

## API

- `createConversation`, `sendMessage`, `runToCompletion`, `awaitRun`, `getRun`
- `listExtensions`, `wireExtensions`, `listWiredExtensions`, `invokeExtensionTool`
- `streamEvents` (async iterator over SSE), `SseDataBuffer`
- `resolveToolPermission(toolCallId, approved, { scope, ttlOverrideMs })`
- `getSetting`, `setSetting`
- `scriptLlm`, `clearLlmScripts`, `runScripted`
- `RUNTIME_EVENT_NAMES`, `RuntimeEventName`, `RuntimeEvent`

All non-2xx responses throw `HarnessApiError` with `status`, `method`,
`path`, and the parsed `body`.
