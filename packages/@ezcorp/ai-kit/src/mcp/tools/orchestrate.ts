import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EzcorpClient } from "../../client.js";
import { assignTaskInput, startAssignmentInput, spawnChatsInput } from "../../types.js";
import { withLink, withLinks } from "./_response.js";

export const TOOLS = [
  { name: "list_sub_conversations", description: "List all sub-conversations spawned from a parent conversation. Use this to track fan-out progress after sending a multi-agent message." },
  { name: "assign_task", description: "Assign a task to an agent within a conversation. Use this to programmatically fan out work via the task-assignment mechanism." },
  { name: "start_assignment", description: "Start a previously created task assignment, spawning a sub-conversation. Use this after assign_task to kick off the agent's execution." },
  { name: "spawn_chats", description: "Use when you need N independent root-level chats in parallel — NOT for fan-out within a single chat (use spawn_agents/spawn_team/assign_task for that)." },
  { name: "spawn_agents", description: "Fan out within a single conversation by composing multiple ![agent:name] mentions into one message. Use this when you want parallel sub-conversations under the current chat." },
  { name: "spawn_team", description: "Fan out within a single conversation by sending a ![team:name] mention to invoke an entire team. Use this to invoke a named team with autoSpinUp semantics." },
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];

export function register(server: McpServer, client: EzcorpClient): void {
  server.tool(
    "list_sub_conversations",
    "List all sub-conversations spawned from a parent conversation. Use this to track fan-out progress after sending a multi-agent message.",
    {
      conversationId: z.string().describe("UUID of the parent conversation"),
    },
    async (args) => {
      // Preserve the array shape (tests + consumers expect a list), but
      // attach a `url` field to each entry so the caller gets a
      // per-sub-conversation deep link without changing the outer shape.
      const subs = await client.getSubConversations(args.conversationId);
      const withUrls = subs.map((s) => ({
        ...s,
        url: client.entityUrl({ kind: "conversation", id: s.id, projectId: s.projectId }),
      }));
      return { content: [{ type: "text" as const, text: JSON.stringify(withUrls) }] };
    },
  );

  server.tool(
    "assign_task",
    "Assign a task to an agent within a conversation. Use this to programmatically fan out work via the task-assignment mechanism.",
    {
      conversationId: assignTaskInput.shape.conversationId.describe("UUID of the conversation containing the task"),
      taskId: assignTaskInput.shape.taskId.describe("ID of the task to assign"),
      agentConfigId: assignTaskInput.shape.agentConfigId.describe("UUID of the agent to assign the task to"),
      subtaskId: assignTaskInput.shape.subtaskId.describe("Optional subtask ID within the task"),
    },
    async (args) => {
      const result = await client.assignTask(args);
      const convUrl = await conversationUrlFor(client, args.conversationId);
      return withLink(result, convUrl, "Open chat");
    },
  );

  server.tool(
    "start_assignment",
    "Start a previously created task assignment, spawning a sub-conversation. Use this after assign_task to kick off the agent's execution.",
    {
      conversationId: startAssignmentInput.shape.conversationId.describe("UUID of the parent conversation"),
      taskId: startAssignmentInput.shape.taskId.describe("ID of the task"),
      assignmentId: startAssignmentInput.shape.assignmentId.describe("ID of the assignment to start"),
      model: startAssignmentInput.shape.model.describe("Optional model override for this assignment"),
      provider: startAssignmentInput.shape.provider.describe("Optional provider override"),
    },
    async (args) => {
      const result = await client.startAssignment(args);
      // Sub-conversation inherits the parent's project — look it up so
      // the link lands on the same project route as the parent chat.
      const subUrl = await conversationUrlFor(
        client,
        result.subConversationId,
        args.conversationId,
      );
      const runUrl = client.entityUrl({ kind: "run", id: result.runId });
      return withLinks(result, [
        { url: subUrl, label: "Open sub-chat", field: "subConversationUrl" },
        { url: runUrl, label: "View run", field: "runUrl" },
      ]);
    },
  );

  server.tool(
    "spawn_chats",
    "Use when you need N independent root-level chats in parallel — NOT for fan-out within a single chat (use spawn_agents/spawn_team/assign_task for that).",
    {
      chats: spawnChatsInput.shape.chats.describe("Array of chat specs to spawn (max 20). Each needs projectId and initialMessage."),
    },
    async (args) => {
      const result = await client.spawnChats(args);
      // `spec.projectId` is 1:1 with `result.chats[i]`, so we can build
      // per-chat URLs without any extra fetch.
      const chatsWithUrls = result.chats.map((c, i) => {
        const spec = args.chats[i];
        const projectId = spec?.projectId ?? "unknown";
        return {
          ...c,
          url: client.entityUrl({ kind: "conversation", id: c.conversationId, projectId }),
          runUrl: client.entityUrl({ kind: "run", id: c.runId }),
        };
      });
      return { content: [{ type: "text" as const, text: JSON.stringify({ chats: chatsWithUrls }) }] };
    },
  );

  server.tool(
    "spawn_agents",
    "Fan out within a single conversation by composing multiple ![agent:name] mentions into one message. Use this when you want parallel sub-conversations under the current chat.",
    {
      conversationId: z.string().describe("UUID of the parent conversation to fan out from"),
      agents: z.array(z.string().min(1)).min(1).describe("Agent names to mention; each becomes ![agent:name] in the composed message"),
      task: z.string().min(1).describe("The task/prompt to give all agents"),
      model: z.string().optional().describe("Optional model override"),
      provider: z.string().optional().describe("Optional provider override"),
    },
    async (args) => {
      const mentions = args.agents.map((a) => `![agent:${a}]`).join(" ");
      const content = `${mentions} ${args.task}`;
      const result = await client.sendMessage(args.conversationId, {
        content,
        model: args.model,
        provider: args.provider,
      });
      const convUrl = await conversationUrlFor(client, args.conversationId);
      const runUrl = client.entityUrl({ kind: "run", id: result.runId });
      return withLinks(result, [
        { url: convUrl, label: "Open chat", field: "conversationUrl" },
        { url: runUrl, label: "View run", field: "runUrl" },
      ]);
    },
  );

  server.tool(
    "spawn_team",
    "Fan out within a single conversation by sending a ![team:name] mention to invoke an entire team. Use this to invoke a named team with autoSpinUp semantics.",
    {
      conversationId: z.string().describe("UUID of the parent conversation"),
      teamName: z.string().min(1).describe("Team name to mention as ![team:name]"),
      task: z.string().min(1).describe("The task/prompt to give the team"),
      model: z.string().optional().describe("Optional model override"),
      provider: z.string().optional().describe("Optional provider override"),
    },
    async (args) => {
      const content = `![team:${args.teamName}] ${args.task}`;
      const result = await client.sendMessage(args.conversationId, {
        content,
        model: args.model,
        provider: args.provider,
      });
      const convUrl = await conversationUrlFor(client, args.conversationId);
      const runUrl = client.entityUrl({ kind: "run", id: result.runId });
      return withLinks(result, [
        { url: convUrl, label: "Open chat", field: "conversationUrl" },
        { url: runUrl, label: "View run", field: "runUrl" },
      ]);
    },
  );
}

/** Resolve a clickable conversation URL from an id. `projectHintFromId`
 *  is an optional sibling conversation id whose `projectId` we can
 *  inherit (used for sub-conversations that share the parent's project
 *  — avoids an extra fetch on `startAssignment`). Falls back to a direct
 *  lookup, and finally to a best-effort `project/unknown` URL so the
 *  tool never fails solely because linking failed. */
async function conversationUrlFor(
  client: EzcorpClient,
  conversationId: string,
  projectHintFromId?: string,
): Promise<string> {
  try {
    if (projectHintFromId) {
      const parent = await client.getConversation(projectHintFromId);
      return client.entityUrl({
        kind: "conversation",
        id: conversationId,
        projectId: parent.projectId,
      });
    }
    const conv = await client.getConversation(conversationId);
    return client.entityUrl({
      kind: "conversation",
      id: conv.id,
      projectId: conv.projectId,
    });
  } catch {
    return client.entityUrl({
      kind: "conversation",
      id: conversationId,
      projectId: "unknown",
    });
  }
}
