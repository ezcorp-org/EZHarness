---
name: ezcorp-orchestrate
description: Use when running multiple agents in parallel, spawning chats in parallel, assigning tasks to agents, having a team work on something, or fan-out orchestration from a single chat.
---

# EZCorp Orchestrate

Four mechanisms for fan-out. Pick the one that matches your coordination model.

## When to use

- You need two or more agents to work concurrently in one turn.
- You want to spin up a pre-configured team with one mention.
- You are assigning tasks programmatically rather than via inline mentions.
- You need N independent root-level chats started in one call.

## Prereqs

```sh
export EZCORP_BASE_URL="http://localhost:5173"
export EZCORP_API_KEY="ezk_..."   # chat or admin scope
```

MCP server registered: `bunx @ezcorp/ai-kit install claude-code`

---

## Mode A — parallel agent mentions

**When to use:** you know at prompt-authoring time exactly which agents should run; all agents share the same parent conversation context.

Each `![agent:name]` in a single message starts an independent sub-conversation. The runtime runs them concurrently. Correlate results by listening for `agent:complete` events keyed by `runId`.

```json
{
  "tool": "send_message",
  "arguments": {
    "conversationId": "<uuid>",
    "content": "![agent:security-reviewer] check for hardcoded secrets. ![agent:style-reviewer] check naming conventions. Report back."
  }
}
```

Or use the `spawn_agents` helper to build the mention string programmatically:

```json
{
  "tool": "spawn_agents",
  "arguments": {
    "conversationId": "<uuid>",
    "agentNames": ["security-reviewer", "style-reviewer"],
    "message": "check for hardcoded secrets and naming conventions respectively"
  }
}
```

**Streaming:** listen for `agent:spawn` (one per agent) then `agent:complete` (one per agent). `run:complete` on the parent fires when the orchestrator itself is done — sub-agents may still be running at that point.

---

## Mode B — team mention with autoSpinUp

**When to use:** you have a standing team agent configured with `references.members` + `autoSpinUp: true`. The team is reusable and you don't want to re-list members at call time.

```json
{
  "tool": "spawn_team",
  "arguments": {
    "conversationId": "<uuid>",
    "teamName": "review-team",
    "message": "Review the attached diff for correctness, security, and style."
  }
}
```

Equivalent inline mention:

```json
{
  "tool": "send_message",
  "arguments": {
    "conversationId": "<uuid>",
    "content": "![team:review-team] Review the attached diff for correctness, security, and style."
  }
}
```

`autoSpinUp: true` pre-spawns all members before the orchestrator's first LLM turn, so every member gets the full context immediately. Multiple `![team:…]` mentions in one message are supported and their member lists merge.

For team agent creation, see the `ezcorp-agents` skill.

---

## Mode C — programmatic task assignment

**When to use:** fan-out is decided at runtime (e.g., after parsing a list of files or issues), not by hard-coding mentions. Each assignment is an independent sub-conversation.

**Step 1 — assign the task:**

```json
{
  "tool": "assign_task",
  "arguments": {
    "conversationId": "<parent-conv-uuid>",
    "taskId": "task-abc",
    "agentConfigId": "<agent-uuid>"
  }
}
```

Returns `{ assignmentId }`.

**Step 2 — start the assignment (spawns the sub-conversation):**

```json
{
  "tool": "start_assignment",
  "arguments": {
    "conversationId": "<parent-conv-uuid>",
    "taskId": "task-abc",
    "assignmentId": "<from step 1>"
  }
}
```

Returns `{ conversationId, runId }` for the spawned sub-conversation.

Repeat steps 1-2 for each parallel task. Stream each `runId` independently. Track progress via `task:snapshot` and `task:assignment_update` events.

**List sub-conversations:**

```json
{
  "tool": "list_sub_conversations",
  "arguments": {
    "conversationId": "<parent-conv-uuid>"
  }
}
```

---

## Mode D — batch root-level chats (spawn_chats)

**When to use:** you want N truly independent conversations (not sub-conversations of a parent), each possibly in different projects or with different agents. This is the "start multiple chats from one chat" pattern.

```json
{
  "tool": "spawn_chats",
  "arguments": {
    "chats": [
      {
        "projectId": "global",
        "initialMessage": "Summarise the authentication flow.",
        "agentConfigId": "<architect-uuid>"
      },
      {
        "projectId": "<project-uuid>",
        "initialMessage": "List all TODO comments in the codebase.",
        "model": "claude-haiku-4-5"
      },
      {
        "projectId": "global",
        "initialMessage": "Draft a changelog entry for v2.1.",
        "title": "Changelog draft"
      }
    ]
  }
}
```

Returns `{ chats: [{ conversationId, runId }, ...] }` — one entry per input chat. Max 20 chats per call. Stream each `runId` independently.

```sh
# curl fallback (one conversation — loop this for N)
curl -s -X POST \
  -H "Authorization: Bearer $EZCORP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"global"}' \
  "$EZCORP_BASE_URL/api/conversations" | jq -r '.id' | \
xargs -I{} curl -s -X POST \
  -H "Authorization: Bearer $EZCORP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content":"Summarise the authentication flow."}' \
  "$EZCORP_BASE_URL/api/conversations/{}/messages"
```

---

## Choosing the right mode

| Situation | Mode |
|---|---|
| Fixed set of agents, shared context, one turn | A — parallel mentions |
| Reusable team config, pre-warm all members | B — team + autoSpinUp |
| Fan-out list decided at runtime, need task tracking | C — assign_task + start_assignment |
| Independent conversations, possibly different projects | D — spawn_chats |

---

## Gotchas

- `run:complete` on the parent signals the orchestrator is done, but sub-agents spawned via mentions may still be running. Wait for `agent:complete` events (one per sub-agent `runId`) before concluding all work is finished.
- Mention tokens are expanded server-side. Do not double-encode `![agent:name]` — pass it as literal text in `content`.
- `spawn_chats` creates root-level conversations (no `parentConversationId`). Use mode A/B/C if you need the sub-conversations linked to a parent.
- `autoSpinUp: true` is a property of the team agent config, not of the mention. If the team agent does not have `references.autoSpinUp: true`, members will not pre-warm.
- Task `taskId` is caller-defined (a string). Use a stable, unique identifier (e.g., a file path or issue number) so `list_sub_conversations` results are correlatable.
- `spawn_chats` accepts 1–20 items. For larger batches, paginate in groups of 20.
