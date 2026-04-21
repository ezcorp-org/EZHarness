# Quickstart — curl

End-to-end recipe against `http://localhost:5173`. Run steps in order; steps 3 and 4 use separate terminals.

---

## Prerequisites

1. EZCorp running locally: `cd /home/dev/work/ez-corp-ai && bun run dev`
2. An API key: EZCorp UI → Settings → Developer → Create API key. Copy the `ez_…` value.

```bash
export EZCORP_KEY="ez_your_key_here"
export BASE="http://localhost:5173"
```

---

## Step 1 — Create a conversation

```bash
CONV=$(curl -s -X POST "$BASE/api/conversations" \
  -H "Authorization: Bearer $EZCORP_KEY" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"global"}' | bun -e "process.stdin | c => JSON.parse(c).id")

echo "Conversation: $CONV"
```

Or use `jq` if preferred: `... | jq -r '.id'`

---

## Step 2 — Open the SSE stream (Terminal 2)

Open a second terminal before sending a message so you catch the full event sequence:

```bash
curl -N -H "Authorization: Bearer $EZCORP_KEY" \
  "$BASE/api/runtime-events"
```

Leave this running. Events stream as:

```
data: {"type":"run:start","data":{…}}
data: {"type":"run:token","data":{"runId":"…","token":"Hi","kind":"text"}}
data: {"type":"run:turn_saved","data":{…}}
data: {"type":"run:complete","data":{…}}
```

---

## Step 3 — Send a message (Terminal 1)

```bash
RESULT=$(curl -s -X POST "$BASE/api/conversations/$CONV/messages" \
  -H "Authorization: Bearer $EZCORP_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content":"Hello! What can you do?"}')

echo "$RESULT" | bun -e "const d=JSON.parse(process.env.RESULT||'{}');console.log('runId:',d.runId)"
# Or: echo "$RESULT" | jq '{runId, messageId}'
```

---

## Step 4 — Expected event sequence

In Terminal 2 you should see, in order:

| Event | Meaning |
|---|---|
| `run:start` | Execution started |
| `run:status` | Progress updates ("Generating response…") |
| `run:token` | Incremental text chunks |
| `run:usage` | Token count + cost |
| `run:turn_saved` | Turn persisted; `messageId` available |
| `run:turn_text_reset` | Buffer reset for next turn |
| `run:complete` | Run finished |

---

## Step 5 — Read the reply

```bash
curl -s "$BASE/api/conversations/$CONV/messages" \
  -H "Authorization: Bearer $EZCORP_KEY" | bun -e "
const msgs = JSON.parse(await new Response(process.stdin).text());
const last = msgs.at(-1);
console.log(last?.role, ':', last?.content?.slice(0,200));
"
```

---

## Fan out four ways

### (a) Parallel agent mentions

Requires at least two agents configured. Replace names as needed.

```bash
curl -s -X POST "$BASE/api/conversations/$CONV/messages" \
  -H "Authorization: Bearer $EZCORP_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content":"![agent:Researcher] find the top 5 cloud providers  ![agent:Writer] draft a comparison table"}'
```

Watch Terminal 2 for interleaved `agent:spawn` / `agent:status` / `agent:complete` events.

---

### (b) Team mention with autoSpinUp

Requires a team agent config with `autoSpinUp: true` in its settings.

```bash
curl -s -X POST "$BASE/api/conversations/$CONV/messages" \
  -H "Authorization: Bearer $EZCORP_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content":"![team:ProductTeam] build the MVP feature list"}'
```

---

### (c) Task assignment API

```bash
# List tasks for the conversation (created by the agent during a run, or pre-seeded)
curl -s "$BASE/api/conversations/$CONV/tasks" \
  -H "Authorization: Bearer $EZCORP_KEY" | bun -e "
const t = JSON.parse(await new Response(process.stdin).text());
t.forEach(x => console.log(x.id, x.title));
"

TASK_ID="<taskId from above>"
AGENT_ID="<agentConfigId>"

# Assign
ASSIGN=$(curl -s -X POST "$BASE/api/conversations/$CONV/tasks/$TASK_ID/assign" \
  -H "Authorization: Bearer $EZCORP_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"agentConfigId\":\"$AGENT_ID\"}" | bun -e "console.log(JSON.parse(await new Response(process.stdin).text()).id)")

# Start
curl -s -X POST "$BASE/api/conversations/$CONV/tasks/$TASK_ID/assignments/$ASSIGN/start" \
  -H "Authorization: Bearer $EZCORP_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

---

### (d) Batch independent chats (spawn_chats)

No shared parent — each conversation is a peer.

```bash
# Create conversation A
CONV_A=$(curl -s -X POST "$BASE/api/conversations" \
  -H "Authorization: Bearer $EZCORP_KEY" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"global","title":"Task A"}' | bun -e "console.log(JSON.parse(await new Response(process.stdin).text()).id)")

# Create conversation B
CONV_B=$(curl -s -X POST "$BASE/api/conversations" \
  -H "Authorization: Bearer $EZCORP_KEY" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"global","title":"Task B"}' | bun -e "console.log(JSON.parse(await new Response(process.stdin).text()).id)")

# Send messages concurrently
curl -s -X POST "$BASE/api/conversations/$CONV_A/messages" \
  -H "Authorization: Bearer $EZCORP_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content":"Research cloud storage pricing"}' &

curl -s -X POST "$BASE/api/conversations/$CONV_B/messages" \
  -H "Authorization: Bearer $EZCORP_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content":"Research edge computing options"}' &

wait
echo "Both chats started: $CONV_A  $CONV_B"
```

Via the `spawn_chats` MCP tool this is one call:

```json
{
  "tool": "spawn_chats",
  "input": [
    { "projectId": "global", "initialMessage": "Research cloud storage pricing" },
    { "projectId": "global", "initialMessage": "Research edge computing options" }
  ]
}
```

---

## Authentication reference

Two schemes are accepted on all routes except `GET /api/health`:

| Scheme | Header |
|---|---|
| Session cookie | `Cookie: ezcorp_session=<value>` (set after `POST /api/auth/login`) |
| API key | `Authorization: Bearer ez_<key>` |

API keys are scoped (`read`, `write`, `admin`). The examples above use a `write`-scoped key.
