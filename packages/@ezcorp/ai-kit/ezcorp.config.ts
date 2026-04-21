import { defineExtension } from "@ezcorp/sdk";

export default defineExtension({
  schemaVersion: 2,
  name: "ai-kit",
  version: "0.1.0",
  description:
    "In-EZCorp orchestration extension — lets agents start chats, fan out to sibling conversations, spawn teams, assign tasks, and drive the full EZCorp API surface from inside the app.",
  author: { name: "EzCorp" },
  entrypoint: "./src/mcp/server.ts",
  persistent: false,
  category: "Orchestration",
  tags: ["orchestration", "agents", "teams", "tasks", "chat", "fan-out"],

  // ── Orchestration tools ────────────────────────────────────────────────────
  // These share the same JSON-RPC request/response contract as the MCP server
  // tools in src/mcp/tools/. The entrypoint above dispatches every `tools/call`
  // to the same handlers, so there is one implementation, not two.
  tools: [
    // ── Discovery ──────────────────────────────────────────────────────────
    {
      name: "list_projects",
      description: "List all EZCorp projects the current user can access.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_agents",
      description: "List all agent configs registered in EZCorp.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_models",
      description: "List available LLM providers and models.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_extensions",
      description: "List all installed EZCorp extensions.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "search_mentions",
      description:
        "Autocomplete-search for mentionable entities: agents, teams, extensions, files, dirs, or slash-commands.",
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string", description: "Search query" },
          type: {
            type: "string",
            enum: ["agent", "team", "ext", "path", "cmd"],
            description: "Restrict to one mention kind",
          },
          projectId: {
            type: "string",
            description: 'Project UUID or the literal "global"',
          },
        },
        required: ["q"],
      },
    },
    {
      name: "get_agent",
      description: "Fetch a single agent config by its UUID.",
      inputSchema: {
        type: "object",
        properties: {
          agentConfigId: { type: "string", description: "Agent config UUID" },
        },
        required: ["agentConfigId"],
      },
    },

    // ── Chat ───────────────────────────────────────────────────────────────
    {
      name: "start_chat",
      description:
        "Create a new conversation. Pass parentConversationId + parentMessageId to register as a sub-conversation (required for the executor's orchestration-depth guard).",
      inputSchema: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: 'Project UUID or the literal "global"',
          },
          title: { type: "string" },
          agentConfigId: { type: "string" },
          model: { type: "string" },
          provider: { type: "string" },
          parentConversationId: {
            type: "string",
            description: "UUID of the calling conversation — enables depth tracking",
          },
          parentMessageId: {
            type: "string",
            description: "UUID of the message that triggered this chat",
          },
        },
        required: ["projectId"],
      },
    },
    {
      name: "send_message",
      description:
        "Post a message to an existing conversation. Returns a runId for streaming. Supports mention tokens: ![agent:name], ![team:name], ![ext:name], @[file:path], /[cmd:name].",
      inputSchema: {
        type: "object",
        properties: {
          conversationId: { type: "string" },
          content: { type: "string", description: "Message body with optional mention tokens" },
          model: { type: "string" },
          provider: { type: "string" },
          parentMessageId: { type: "string" },
        },
        required: ["conversationId", "content"],
      },
    },
    {
      name: "get_messages",
      description: "Retrieve the message history for a conversation.",
      inputSchema: {
        type: "object",
        properties: {
          conversationId: { type: "string" },
          leafMessageId: { type: "string" },
          all: { type: "boolean" },
          withToolCalls: { type: "boolean" },
        },
        required: ["conversationId"],
      },
    },
    {
      name: "stream_run",
      description:
        "Consume SSE events for a run until run:complete or run:error. Returns accumulated token text and final status.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
          conversationId: {
            type: "string",
            description: "Filter events to this conversation (recommended)",
          },
          timeoutMs: {
            type: "number",
            description: "Abort after this many milliseconds (default 120 000)",
          },
        },
        required: ["runId"],
      },
    },
    {
      name: "cancel_run",
      description: "Cancel the active run on a conversation.",
      inputSchema: {
        type: "object",
        properties: {
          conversationId: { type: "string" },
          force: { type: "boolean", description: "Force-cancel without graceful drain" },
        },
        required: ["conversationId"],
      },
    },

    // ── Orchestration / fan-out ────────────────────────────────────────────
    {
      name: "spawn_chats",
      description:
        "Start N independent root-level conversations in a single call. Returns [{conversationId, runId}] in order. Use for batch fan-out where the new chats are NOT sub-conversations of the caller.",
      inputSchema: {
        type: "object",
        properties: {
          chats: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                projectId: { type: "string" },
                initialMessage: { type: "string" },
                agentConfigId: { type: "string" },
                model: { type: "string" },
                provider: { type: "string" },
                title: { type: "string" },
              },
              required: ["projectId", "initialMessage"],
            },
          },
        },
        required: ["chats"],
      },
    },
    {
      name: "spawn_agents",
      description:
        "Fan out to multiple agents in a single message by composing parallel ![agent:name] mention tokens and sending them to the given conversation. Each agent runs concurrently in its own sub-conversation.",
      inputSchema: {
        type: "object",
        properties: {
          conversationId: { type: "string" },
          agents: {
            type: "array",
            minItems: 1,
            items: { type: "string", description: "Agent name (for ![agent:name] token)" },
          },
          content: {
            type: "string",
            description:
              "Prompt body appended after the agent mention tokens. If omitted, only the mention tokens are sent.",
          },
        },
        required: ["conversationId", "agents"],
      },
    },
    {
      name: "spawn_team",
      description:
        "Mention a team in a conversation, optionally forcing autoSpinUp so all team members are pre-spawned in parallel before the orchestrator's first LLM turn.",
      inputSchema: {
        type: "object",
        properties: {
          conversationId: { type: "string" },
          teamName: { type: "string" },
          content: { type: "string", description: "Prompt body after the team mention token" },
          autoSpinUp: {
            type: "boolean",
            description: "Pre-spawn all team members in parallel (default true)",
          },
        },
        required: ["conversationId", "teamName"],
      },
    },
    {
      name: "list_sub_conversations",
      description: "List all sub-conversations spawned under a given parent conversation.",
      inputSchema: {
        type: "object",
        properties: {
          conversationId: { type: "string" },
        },
        required: ["conversationId"],
      },
    },
    {
      name: "assign_task",
      description:
        "Assign a task (or subtask) from a conversation to an agent config, creating an assignment record.",
      inputSchema: {
        type: "object",
        properties: {
          conversationId: { type: "string" },
          taskId: { type: "string" },
          agentConfigId: { type: "string" },
          subtaskId: { type: "string" },
        },
        required: ["conversationId", "taskId", "agentConfigId"],
      },
    },
    {
      name: "start_assignment",
      description:
        "Start a previously created task assignment, spawning an independent sub-conversation for the agent to execute it.",
      inputSchema: {
        type: "object",
        properties: {
          conversationId: { type: "string" },
          taskId: { type: "string" },
          assignmentId: { type: "string" },
          model: { type: "string" },
          provider: { type: "string" },
        },
        required: ["conversationId", "taskId", "assignmentId"],
      },
    },

    // ── Agent authoring ────────────────────────────────────────────────────
    {
      name: "create_agent",
      description: "Create a new agent config directly from a structured spec.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          prompt: { type: "string" },
          description: { type: "string" },
          capabilities: { type: "array", items: { type: "string" } },
          category: { type: "string" },
          provider: { type: "string" },
          model: { type: "string" },
          temperature: { type: "number" },
          maxTokens: { type: "number" },
          outputFormat: { type: "string", enum: ["text", "json"] },
        },
        required: ["name", "prompt"],
      },
    },
    {
      name: "generate_agent",
      description:
        "Use EZCorp's multi-turn wizard to iteratively draft an agent config. Pass a messages array; the server returns a text response and, when ready, a parsed config object.",
      inputSchema: {
        type: "object",
        properties: {
          messages: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                role: { type: "string" },
                content: { type: "string" },
              },
              required: ["role", "content"],
            },
          },
          provider: { type: "string" },
          model: { type: "string" },
        },
        required: ["messages"],
      },
    },
  ],

  // ── Skills ─────────────────────────────────────────────────────────────────
  // Reference Tier 1 docs so in-EZCorp agents get the same conceptual context
  // as external harnesses. The files are generated by the Documenter agent in
  // parallel — stubs will be replaced as they land.
  skills: [
    {
      name: "ezcorp-overview",
      description:
        "Conceptual overview of EZCorp: projects, conversations, agents, teams, tasks, mentions, and runs.",
      files: ["docs/OVERVIEW.md"],
    },
    {
      name: "ezcorp-mentions",
      description:
        "Normative mention grammar for all three sigils (!, @, /) and their token formats.",
      files: ["docs/mentions.md"],
    },
    {
      name: "ezcorp-events",
      description:
        "SSE runtime-event taxonomy with payload shapes for run:token, agent:spawn, task:snapshot, and all other event types.",
      files: ["docs/events.md"],
    },
  ],

  scripts: {
    postinstall: "scripts/postinstall.ts",
  },

  permissions: {
    // The extension calls the local EZCorp HTTP API — localhost only.
    // When EZCorp is hosted remotely the user must declare the host
    // explicitly in their project-level permissions override.
    network: ["localhost"],
    filesystem: ["$CWD"],
    env: ["EZCORP_BASE_URL", "EZCORP_API_KEY", "EZCORP_SESSION_COOKIE"],
    storage: false,
  },
});
