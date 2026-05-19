---
name: ezcorp-chat
description: Use when starting a chat in EZCorp, sending a message (including with agent/file/command mentions), reading streamed output, or continuing an existing conversation.
---

# EZCorp Chat

Start a conversation, send messages with inline mentions, then stream the run's events until `run:complete`.

## When to use

- You want to open a new chat in a project (including `"global"`).
- You want to send a message, optionally mentioning agents, files, or slash commands.
- You want to read streamed token output or wait for a run to finish.

## Prereqs

```sh
export EZCORP_BASE_URL="http://localhost:5173"
export EZCORP_API_KEY="ezk_..."
```

MCP server registered: `bunx @ezcorp/ai-kit install claude-code`

For mention grammar details see the root [CLAUDE.md mention grammar table](../../../../CLAUDE.md).

## Recipes

### Start a chat

```json
{
  "tool": "start_chat",
  "arguments": {
    "projectId": "global"
  }
}
```

Optional fields: `agentConfigId` (UUID), `model`, `provider`, `title`, `parentConversationId`.

Returns `{ id, projectId, title, model, provider, agentConfigId }` — capture `id` as `conversationId`.

```sh
# curl fallback
curl -s -X POST \
  -H "Authorization: Bearer $EZCORP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"global"}' \
  "$EZCORP_BASE_URL/api/conversations" | jq '{id}'
```

### Send a message

```json
{
  "tool": "send_message",
  "arguments": {
    "conversationId": "<uuid>",
    "content": "Summarise the repo for me"
  }
}
```

Returns `{ userMessage: { id, role, content }, runId, attachments }`. Save `runId` for streaming.

With mentions (see mention grammar):

```json
{
  "tool": "send_message",
  "arguments": {
    "conversationId": "<uuid>",
    "content": "![agent:reviewer] please review this diff @[file:src/index.ts]"
  }
}
```

Optional: `model`, `provider`, `permissionMode` (`"ask"` | `"auto-edit"` | `"yolo"`), `thinkingLevel` (`"off"` … `"xhigh"`).

### Stream run output

```json
{
  "tool": "stream_run",
  "arguments": {
    "runId": "<runId from send_message>"
  }
}
```

The tool yields SSE events. Important event types:

| Event | Meaning |
|---|---|
| `run:token` | Incremental LLM output chunk |
| `run:turn_saved` | A full assistant turn is persisted |
| `run:complete` | The parent run is done |
| `agent:spawn` | A sub-agent was spawned (fan-out) |
| `agent:complete` | A specific sub-agent finished |
| `tool:permission_request` | Agent is waiting for user approval |
| `orchestrator:human_input` | Orchestrator needs human input |

**`run:complete` does not mean all sub-agents are done.** After `run:complete`, continue listening for `agent:complete` events per `runId` if you used fan-out mentions.

### Read historical messages

```json
{
  "tool": "get_messages",
  "arguments": {
    "conversationId": "<uuid>"
  }
}
```

Returns the full message thread in order.

### Pick a model

Before starting a chat you can enumerate available models:

```json
{ "tool": "list_models", "arguments": {} }
```

Then pass the chosen id via `model` in `start_chat` or `send_message`.

### Discover mentionable agents, files, or commands

Before composing a message, use `search_mentions` to find what's available to `!` / `@` / `/`:

```json
{ "tool": "search_mentions", "arguments": { "q": "review", "type": "agent", "projectId": "global" } }
```

`type` ∈ `agent | team | ext | path | cmd`. Omit `type` to search everything.

### Cancel a run

```json
{
  "tool": "cancel_run",
  "arguments": {
    "runId": "<runId>"
  }
}
```

## Gotchas

- Mention tokens (`![agent:name]`, `@[file:path]`, `/[cmd:name]`) are expanded server-side. Do not double-encode them or escape the brackets.
- `content` max length is 100,000 characters.
- A conversation started with `parentConversationId` becomes a sub-conversation; its events appear under both its own `runId` and the parent's stream.
- `permissionMode: "yolo"` skips all tool-permission prompts. Use with caution in production.
