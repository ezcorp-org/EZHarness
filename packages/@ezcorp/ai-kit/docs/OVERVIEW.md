# EZCorp Backend — Conceptual Model

This document describes the core primitives an LLM harness needs to drive the EZCorp backend. Read this before consulting the OpenAPI spec or quickstart recipe.

---

## Project

A **project** scopes conversations, agents, and file-system access. Every conversation belongs to exactly one project.

- `projectId` is either a UUID or the literal string `"global"`.
- `"global"` is a first-class built-in project that always exists; it requires no setup.
- Projects can have a `path` on disk; file and directory mentions (`@[file:…]`, `@[dir:…]`) are resolved against that path.

---

## Conversation

A **conversation** is the top-level container for a thread of messages and runs.

Key fields:

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key |
| `projectId` | UUID \| `"global"` | Owning project |
| `parentConversationId` | UUID? | Set when this is a sub-conversation spawned by an agent |
| `parentMessageId` | UUID? | The message in the parent that triggered this sub-conversation |
| `agentConfigId` | UUID? | Agent driving this conversation, if any |
| `title` | string? | Display name |
| `model` | string? | Model override |
| `provider` | string? | Provider override |

### Sub-conversation DAG

Conversations form a directed acyclic graph via `parentConversationId`. When an orchestrator invokes a sub-agent, a new conversation is created with `parentConversationId` pointing at the orchestrator's conversation. The result flows back as a tool result in the parent's message tree.

Retrieve the children of a conversation: `GET /api/conversations/:id/sub-conversations`.

---

## Message

Messages form a **tree**, not a list. Branching happens via `parentMessageId`.

- Each message has a `parentMessageId` (null for the root).
- When the user or an agent edits a message or starts a new branch, a new message is created with the same parent — the two siblings are parallel branches.
- The canonical **leaf path** (the path from root to the current leaf) is what the LLM context window sees.

Retrieve messages: `GET /api/conversations/:id/messages?leafMessageId=<id>` returns the ancestor chain from root to that leaf. Omit `leafMessageId` to get the default leaf path.

---

## Mention Grammar

See [`docs/mentions.md`](./mentions.md) for the normative specification.

Quick reference:

| Sigil | Token form | Resolves to |
|---|---|---|
| `!` | `![agent:Name]` | Agent sub-conversation |
| `!` | `![team:Name]` | Team with all its members |
| `!` | `![ext:Name]` | Extension tools wired into the conversation |
| `@` | `@[file:rel/path.ts]` | File reference (read by agent) |
| `@` | `@[dir:rel/path]` | Directory reference |
| `/` | `/[cmd:name]` | Slash-command expanded server-side before LLM sees it |

Tokens are persisted verbatim in the message content. The LLM receives the expanded form.

---

## Runs and SSE Streaming

A **run** is one agent-execution cycle triggered by a message. It has an `id`, a `status`, and maps to a conversation.

Starting a run: `POST /api/conversations/:id/messages` returns `{ runId, messageId, ... }`.

Streaming: open `GET /api/runtime-events` (SSE) before or after posting the message. Every event is a JSON line:

```
data: {"type":"run:token","data":{"runId":"…","token":"Hello","kind":"text"}}
```

Filter client-side on `data.runId` or `data.conversationId` — the stream is a bus carrying all runs for the authenticated session.

See [`docs/events.md`](./events.md) for the full event taxonomy.

---

## Agent vs Team

Both are stored as `agentConfig` rows. The distinction is in `category` and `references`.

### Agent

`category: "agent"` (or unset). Has a `prompt`, optional `model`/`provider`, optional list of `extensions`.

Invoke in a message: `![agent:Name]`

### Team

`category: "team"`. `references.members` is an array of agent config IDs. Optional `references.autoSpinUp: true`.

Invoke in a message: `![team:Name]`

When `autoSpinUp` is `true`, the executor pre-spawns **all** member agents in parallel before the orchestrator's first LLM turn, so every member is already running when the orchestrator begins reasoning.

Multiple team mentions in one message stack — all referenced teams are activated.

---

## Task and Assignment Fan-out

The **task system** lets an orchestrator decompose work into tracked tasks and assign each to an agent or team. Assignments spawn independent sub-conversations.

Key types:

- `TrackedTask` — `{ id, title, description, status, assignments, subtasks, dependsOn?, priority }`
- `TaskAssignment` — `{ id, agentConfigId, agentName, isTeam, status, subConversationId?, agentRunId? }`
- `status` on Task: `pending | active | completed | failed`
- `status` on Assignment: `assigned | running | completed | failed`

Tasks support `dependsOn`: a list of prerequisite task IDs. Dependent assignments auto-start when the last prerequisite completes.

API surface: `GET/POST /api/conversations/:id/tasks` (list), `POST /api/conversations/:id/tasks/:taskId/assign`, `POST /api/conversations/:id/tasks/:taskId/assignments/:assignmentId/start`.

---

## Four Fan-out Mechanisms

All four can be triggered from a single parent conversation. They differ in how the sub-conversations are related to the parent and to each other.

### (a) Parallel agent mentions

Include multiple `![agent:…]` tokens in one message. The executor calls `invoke_agent` for each concurrently. Each spawns its own sub-conversation with `parentConversationId` pointing at the orchestrator. Events: `agent:spawn` then `agent:complete` per agent, keyed by `runId`.

```
POST /api/conversations/:id/messages
{ "content": "![agent:Researcher] find X  ![agent:Writer] draft Y" }
```

### (b) Team mention with autoSpinUp

A single `![team:Name]` token where the team has `autoSpinUp: true` in its config pre-spawns every member before the orchestrator begins. Members share the same parent conversation.

```
POST /api/conversations/:id/messages
{ "content": "![team:ProductTeam] build the feature" }
```

### (c) Task assignment API

Use the task API to programmatically assign agents to tasks. Each `start` call spawns an independent sub-conversation. Useful when the fan-out is decided by code, not by message content.

```
POST /api/conversations/:id/tasks/:taskId/assign      { agentConfigId }
POST /api/conversations/:id/tasks/:taskId/assignments/:assignmentId/start
```

### (d) spawn_chats — batch root-level independent chats

When N conversations should be **peers** (no shared parent), loop `POST /api/conversations` + `POST /api/conversations/:id/messages`. The `spawn_chats` MCP tool wraps this into one call:

```json
{
  "tool": "spawn_chats",
  "input": [
    { "projectId": "global", "initialMessage": "Do X", "agentConfigId": "…" },
    { "projectId": "global", "initialMessage": "Do Y" }
  ]
}
```

Returns `[{ conversationId, runId }, …]`.
