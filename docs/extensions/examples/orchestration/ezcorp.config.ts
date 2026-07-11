import { defineExtension } from "../../../../src/extensions/sdk/define";

// Static manifest schema for the `invoke_agent` tool. The per-turn
// `agentConfigId` enum is runtime-scoped (derived from the mentioned
// agents on each parent turn) and cannot live in a static manifest, so
// the host's `wireOrchestrationToolsForTurn` helper (commit 4) injects
// it via `extensionToAgentTool`'s `schemaOverride` seam at wire time.
// The manifest schema below is the unconstrained shape — valid on its
// own, tightened per-turn by the host.
const INVOKE_AGENT_SCHEMA = {
  type: "object",
  properties: {
    agentConfigId: {
      type: "string",
      description:
        "The ID of the agent to invoke. Must be one of the agents available for this turn.",
    },
    task: {
      type: "string",
      description: "A clear description of what the agent should do.",
    },
    autonomous: {
      type: "boolean",
      description:
        "When true, the sub-agent autonomously re-prompts itself toward the task until it self-reports completion or hits the cycle cap. Use for open-ended work; omit for a single bounded turn.",
    },
    maxCycles: {
      type: "number",
      description:
        "Cap on autonomous self-continuation cycles (only meaningful when `autonomous` is true). Defaults to 8.",
    },
    timeoutSeconds: {
      type: "integer",
      minimum: 30,
      maximum: 3600,
      description:
        "Max seconds to wait for this agent before giving up (child is cancelled on timeout).",
    },
    outputSchema: {
      type: "object",
      description:
        "Optional JSON Schema (object schemas only) that the agent's FINAL answer must satisfy. When provided, the sub-agent's final output is validated against this schema host-side; on failure the agent is automatically re-prompted (bounded) to emit corrected JSON, and you receive the validated JSON object instead of free text (or a clear schema-failure error). ONLY these keywords are ENFORCED: type (object/array/string/number/integer/boolean/null), properties, required, items, enum, additionalProperties. ALL OTHER keywords — including pattern, minimum, maximum, minLength, maxLength, minItems, maxItems, format, const, oneOf/anyOf/allOf, and $ref — are IGNORED (not validated); do not rely on them. `type` must be a single string; union type arrays are not supported.",
    },
    background: {
      type: "boolean",
      description:
        "When true, dispatch the agent and return IMMEDIATELY with a handle (assignmentId) instead of blocking until it finishes — the Claude-Code-style background sub-agent. Use it to fan out several long-running agents in parallel, then gather their results with collect_agent_result (using each assignmentId). Its progress/completion show in the task panel; you are NOT auto-notified in-conversation, so you must poll with collect_agent_result. A background agent holds a concurrent spawn slot until it reaches a terminal state, so many parallel background agents can exhaust the spawn quota. Omit (or false) for a normal blocking call that returns the agent's result inline.",
    },
  },
  required: ["agentConfigId", "task"],
} as const;

// Static manifest schema for `collect_agent_result` — fetch (or wait for)
// the result of a background invoke_agent. No per-turn runtime scoping, so
// this schema is used verbatim (unlike invoke_agent's per-turn enum override).
const COLLECT_AGENT_RESULT_SCHEMA = {
  type: "object",
  properties: {
    assignmentId: {
      type: "string",
      description:
        "The assignmentId returned by a background invoke_agent call (in the tool result and its _agentMeta).",
    },
    waitSeconds: {
      type: "integer",
      minimum: 0,
      maximum: 600,
      description:
        "How long (seconds) to block waiting for the agent to finish before returning. 0 (or omitted) returns instantly: the result if the agent is already done, else a non-error 'still running' status. A positive value waits up to that many seconds of inactivity — an actively-working agent resets the timer — and on expiry returns the same non-error 'still running' status (the agent is NOT cancelled). Max 600.",
    },
  },
  required: ["assignmentId"],
} as const;

// Static manifest schema for `send_to_agent` — Claude-Code SendMessage parity.
// Steer a running child (enqueue a message onto its sub-conversation) or
// continue a terminal one (a fresh run on the reused sub-conversation). No
// per-turn runtime scoping — `agentConfigId` targets a PREVIOUSLY-invoked agent
// (validated against the extension's own tracking maps + host ownership), so it
// is used verbatim (unlike invoke_agent's per-turn enum override).
const SEND_TO_AGENT_SCHEMA = {
  type: "object",
  properties: {
    assignmentId: {
      type: "string",
      description:
        "The assignmentId of a child started earlier this conversation (from an invoke_agent result / its _agentMeta). Targets that specific child. Provide EITHER this OR agentConfigId, not both.",
    },
    agentConfigId: {
      type: "string",
      description:
        "The agentConfigId of an agent you already invoked this conversation. Targets that agent's (reused) sub-conversation so it continues with full prior context. Provide EITHER this OR assignmentId, not both.",
    },
    message: {
      type: "string",
      minLength: 1,
      maxLength: 8000,
      description:
        "The message / follow-up instruction to deliver to the child agent (1–8000 chars).",
    },
  },
  required: ["message"],
} as const;

export default defineExtension({
  schemaVersion: 2,
  name: "orchestration",
  // Phase 2 of the ask-user migration: the legacy `ask_human` tool
  // and its `orchestrator:human_response` subscription have been
  // removed. The new `ask-user` bundled extension owns the
  // human-in-the-loop surface. This is a permission-shrinking
  // change — the S9 re-approval gate keys on
  // `[network, filesystem, shell, env, storage, lifecycleHooks]`,
  // NOT `eventSubscriptions`, so dropping the subscription does
  // not auto-disable existing installs.
  version: "1.2.0",
  description:
    "Multi-agent orchestration primitives. Provides `invoke_agent` for delegating to a sub-agent within a conversation.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  persistent: true,
  tools: [
    {
      name: "invoke_agent",
      description:
        "Invoke a specialized agent to handle a task. The agent runs as an independent sub-conversation and returns its response. You can call this tool multiple times in parallel for independent tasks. Pass background: true to dispatch it without blocking and collect the result later via collect_agent_result.",
      inputSchema: INVOKE_AGENT_SCHEMA as Record<string, unknown>,
    },
    {
      name: "collect_agent_result",
      description:
        "Fetch (or wait for) the result of an agent started with invoke_agent's background: true. Pass the assignmentId from that call. Returns the agent's full result once it has finished (structured output included when a schema was set), or a non-error 'still running' status if it hasn't — optionally block up to waitSeconds. A collect timeout never cancels the agent; keep calling to keep waiting.",
      inputSchema: COLLECT_AGENT_RESULT_SCHEMA as Record<string, unknown>,
    },
    {
      name: "send_to_agent",
      description:
        "Send a message to a sub-agent you already invoked this conversation. If the target is STILL RUNNING, the message is queued and delivered as its next turn (steering — course-correct an in-flight agent). If the target has already FINISHED, a fresh run is started on its same (reused) sub-conversation so it continues with full prior context, and you collect the new result later with collect_agent_result. Choose send_to_agent over a new invoke_agent when you want to continue/steer an EXISTING agent thread (keeping its context) rather than start a fresh one; choose collect_agent_result (not this) when you only want to READ a background agent's result without sending it anything. Target with exactly one of assignmentId or agentConfigId.",
      inputSchema: SEND_TO_AGENT_SCHEMA as Record<string, unknown>,
    },
  ],
  permissions: {
    agentConfig: "read",
    spawnAgents: { maxPerHour: 500, maxConcurrent: 25 },
    // `task:assignment_update` — required by `invoke_agent`'s two-hop
    //   bridge (Phase 4).
    eventSubscriptions: ["task:assignment_update"],
  },
});
