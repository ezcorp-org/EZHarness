# SSE Event Taxonomy

All events are emitted on `GET /api/runtime-events` as Server-Sent Events. Each line has the form:

```
data: {"type":"<event-type>","data":{…}}
```

Heartbeat lines (`": heartbeat"`) are sent every 30 seconds and carry no payload.

The authoritative source list is in `/home/dev/work/ez-corp-ai/web/src/routes/api/runtime-events/+server.ts`. Event payload types are defined in `/home/dev/work/ez-corp-ai/src/types.ts` (`AgentEvents` interface).

---

## Run lifecycle

### `run:start`

Emitted when a run begins execution.

```json
{ "run": { "id": "uuid", "status": "running", "startedAt": 1234567890 } }
```

`run` is an `AgentRun` object. Filter by `data.run.id`.

---

### `run:status`

Progress string update during a run. Emitted at state transitions (loading history, preparing tools, generating response, etc.).

```json
{ "runId": "uuid", "status": "Generating response..." }
```

`status` is a human-readable string. Clients should display this in a progress indicator.

---

### `run:log`

Structured log entry from inside the run.

```json
{
  "runId": "uuid",
  "log": { "timestamp": 1234567890, "level": "info", "message": "..." }
}
```

`level` is one of `debug | info | warn | error`.

---

### `run:token`

Incremental text token from the LLM. Stream these to render the response in real-time.

```json
{ "runId": "uuid", "token": "Hello", "kind": "text" }
```

`kind`: `"text"` (visible output) or `"thinking"` (extended thinking, hidden by default).

---

### `run:turn_saved`

Emitted after each assistant turn is persisted as a message row. Provides the stable `messageId` for the saved turn.

```json
{
  "runId": "uuid",
  "conversationId": "uuid",
  "messageId": "uuid",
  "parentMessageId": "uuid | null",
  "content": "Full turn text"
}
```

---

### `run:turn_text_reset`

Emitted immediately after `run:turn_saved` to signal the client should reset its in-progress token buffer for the next turn.

```json
{ "runId": "uuid" }
```

---

### `run:usage`

Token usage and cost for the completed LLM call.

```json
{
  "runId": "uuid",
  "usage": {
    "input": 1200,
    "output": 340,
    "cacheRead": 800,
    "cacheWrite": 400,
    "totalTokens": 2740,
    "cost": {
      "input": 0.0036,
      "output": 0.0017,
      "cacheRead": 0.0008,
      "cacheWrite": 0.0020,
      "total": 0.0081
    }
  }
}
```

---

### `run:complete`

Run finished successfully.

```json
{ "run": { "id": "uuid", "status": "complete", … }, "conversationId": "uuid" }
```

---

### `run:error`

Run terminated with an error.

```json
{ "run": { … }, "error": "Provider unavailable", "conversationId": "uuid" }
```

---

### `run:cancel`

Run was cancelled (via `POST /api/conversations/:id/active-run` with `{ action: "cancel" }`).

```json
{ "run": { … }, "conversationId": "uuid" }
```

---

## Pipeline events

Pipelines are multi-step agent sequences defined in YAML. These events shadow run events when a pipeline is executing.

### `pipeline:start`

```json
{ "pipelineRun": { "id": "uuid", "name": "string", "steps": [], "startedAt": 123 } }
```

### `pipeline:step`

Emitted when a pipeline step begins.

```json
{ "pipelineRun": { … }, "step": { "id": "uuid", "agentName": "string", "status": "running" } }
```

### `pipeline:complete`

```json
{ "pipelineRun": { … } }
```

### `pipeline:error`

```json
{ "pipelineRun": { … }, "error": "Step 2 failed: …" }
```

---

## Tool events

### `tool:start`

Emitted when a built-in or extension tool begins executing.

```json
{
  "conversationId": "uuid",
  "extensionId": "string",
  "toolName": "readFile",
  "input": { "path": "src/app.ts" },
  "timestamp": 1234567890,
  "source": "agent-run",
  "invocationId": "uuid",
  "cardType": "file",
  "category": "filesystem"
}
```

`extensionId` is `""` for built-in tools.

---

### `tool:complete`

```json
{
  "conversationId": "uuid",
  "extensionId": "string",
  "toolName": "readFile",
  "output": "…file content…",
  "duration": 42,
  "success": true,
  "source": "agent-run",
  "invocationId": "uuid",
  "cardType": "file"
}
```

---

### `tool:error`

```json
{
  "conversationId": "uuid",
  "extensionId": "string",
  "toolName": "shell",
  "error": "Permission denied",
  "duration": 5,
  "source": "agent-run",
  "invocationId": "uuid"
}
```

---

### `tool:permission_request`

Emitted when a tool call requires user approval (permission mode `ask`). The run is paused waiting for `POST /api/tool-calls/:id/permission`.

```json
{
  "conversationId": "uuid",
  "toolCallId": "uuid",
  "toolName": "shell",
  "input": { "command": "rm -rf /" },
  "cardType": "shell",
  "category": "filesystem"
}
```

---

## Agent orchestration events

These events are emitted by `invoke_agent` (in `src/runtime/tools/invoke-agent.ts`) and are keyed to the **parent** run's `runId`.

### `agent:spawn`

A sub-agent has been started.

```json
{
  "runId": "parent-run-uuid",
  "agentRunId": "sub-run-uuid",
  "subConversationId": "uuid",
  "agentName": "Researcher",
  "agentConfigId": "uuid",
  "task": "Find competitors",
  "parentConversationId": "uuid"
}
```

---

### `agent:status`

Status update from a running sub-agent, bridged from the sub-agent's `run:status`.

```json
{
  "runId": "parent-run-uuid",
  "subConversationId": "uuid",
  "agentName": "Researcher",
  "status": "Generating response..."
}
```

---

### `agent:complete`

Sub-agent finished (success, timeout, or error — check `success`).

```json
{
  "runId": "parent-run-uuid",
  "agentRunId": "sub-run-uuid",
  "subConversationId": "uuid",
  "agentName": "Researcher",
  "agentConfigId": "uuid",
  "success": true,
  "resultPreview": "Found 12 competitors: …",
  "parentConversationId": "uuid"
}
```

---

## Task tracking events

### `task:snapshot`

Full task list for a conversation, emitted after every mutation.

```json
{
  "conversationId": "uuid",
  "activeTaskId": "uuid | undefined",
  "tasks": [
    {
      "id": "uuid",
      "title": "Research competitors",
      "description": "…",
      "status": "active",
      "agentId": "uuid",
      "agentName": "Researcher",
      "assignments": [
        {
          "id": "uuid",
          "agentConfigId": "uuid",
          "agentName": "Researcher",
          "isTeam": false,
          "status": "running",
          "assignedAt": "2026-01-01T00:00:00Z",
          "startedAt": "2026-01-01T00:00:01Z",
          "subConversationId": "uuid",
          "agentRunId": "uuid"
        }
      ],
      "subtasks": [
        { "id": "uuid", "title": "Check pricing", "completed": false, "position": 0 }
      ],
      "priority": 0,
      "createdAt": "2026-01-01T00:00:00Z"
    }
  ]
}
```

---

### `task:assignment_update`

Emitted when a single assignment's status changes (assigned → running → completed/failed).

```json
{
  "conversationId": "uuid",
  "taskId": "uuid",
  "assignment": {
    "id": "uuid",
    "agentConfigId": "uuid",
    "agentName": "Writer",
    "isTeam": false,
    "status": "completed",
    "assignedAt": "…",
    "startedAt": "…",
    "completedAt": "…",
    "subConversationId": "uuid",
    "agentRunId": "uuid",
    "resultPreview": "Draft complete: …"
  }
}
```

---

## Human-in-the-loop events

### `orchestrator:human_input`

Emitted by the `ask_human` built-in tool when the agent needs a human response. The run is paused.

```json
{
  "runId": "uuid",
  "conversationId": "uuid",
  "question": "Should I proceed with option A or B?",
  "requestId": "uuid"
}
```

Respond via `POST /api/orchestrator/human-input` with `{ requestId, response }`.

---

### `orchestrator:human_response`

Emitted after the human response has been submitted and the run is resuming.

```json
{
  "requestId": "uuid",
  "response": "Go with option A"
}
```

---

## Extension state events

### `ext:state`

Emitted by an extension via `notify_state` to push UI state to connected clients.

```json
{
  "extensionId": "uuid",
  "extensionName": "my-extension",
  "state": { "count": 42, "status": "ready" },
  "timestamp": 1234567890
}
```

`state` is extension-defined. HTML tags are stripped from string values before emission.
