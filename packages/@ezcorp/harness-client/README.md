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
    { toolCalls: [{ name: "read_file", arguments: { path: "/etc/hosts" } }] },
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

## API

- `createConversation`, `sendMessage`, `runToCompletion`, `awaitRun`, `getRun`
- `streamEvents` (async iterator over SSE), `SseDataBuffer`
- `resolveToolPermission(toolCallId, approved, { scope, ttlOverrideMs })`
- `getSetting`, `setSetting`
- `scriptLlm`, `clearLlmScripts`, `runScripted`
- `RUNTIME_EVENT_NAMES`, `RuntimeEventName`, `RuntimeEvent`

All non-2xx responses throw `HarnessApiError` with `status`, `method`,
`path`, and the parsed `body`.
