import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EzcorpClient } from "../../client.js";
import { createConversationInput, sendMessageInput } from "../../types.js";
import { withLink, withLinks } from "./_response.js";

export const TOOLS = [
  { name: "start_chat", description: "Create a new EZCorp conversation. Use this to open a fresh chat before sending any messages." },
  { name: "send_message", description: "Send a message to an existing conversation and get back a runId. Use this after start_chat to drive the conversation forward." },
  { name: "get_messages", description: "Fetch the message history of a conversation. Use this to read what was said or check assistant replies." },
  { name: "stream_run", description: "Stream runtime events for a run until completion or error. Use this after send_message to wait for the assistant response and collect all events." },
  { name: "cancel_run", description: "Cancel the active run in a conversation. Use this to abort an in-progress assistant turn." },
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];

/** Default stream timeout in seconds */
const DEFAULT_STREAM_TIMEOUT_SECONDS = 60;

export function register(server: McpServer, client: EzcorpClient): void {
  server.tool(
    "start_chat",
    "Create a new EZCorp conversation. Use this to open a fresh chat before sending any messages.",
    {
      projectId: createConversationInput.shape.projectId.describe("'global' or a project UUID"),
      title: createConversationInput.shape.title.describe("Optional conversation title"),
      model: createConversationInput.shape.model.describe("Override model identifier"),
      provider: createConversationInput.shape.provider.describe("Override provider identifier"),
      agentConfigId: createConversationInput.shape.agentConfigId.describe("Agent config UUID to use"),
      parentConversationId: createConversationInput.shape.parentConversationId.describe("Parent conversation UUID for sub-conversations"),
      parentMessageId: createConversationInput.shape.parentMessageId.describe("Parent message UUID"),
    },
    async (args) => {
      const conversation = await client.createConversation(args);
      const url = client.entityUrl({
        kind: "conversation",
        id: conversation.id,
        projectId: conversation.projectId,
      });
      return withLink(conversation, url, conversation.title ?? "Open chat");
    },
  );

  server.tool(
    "send_message",
    "Send a message to an existing conversation and get back a runId. Use this after start_chat to drive the conversation forward.",
    {
      conversationId: z.string().describe("UUID of the conversation to send to"),
      content: sendMessageInput.shape.content.describe("Message text; may include ![agent:name], ![team:name], @[file:path], /[cmd:name] tokens"),
      model: sendMessageInput.shape.model.describe("Override model for this turn"),
      provider: sendMessageInput.shape.provider.describe("Override provider for this turn"),
      parentMessageId: sendMessageInput.shape.parentMessageId.describe("Branch from this message UUID"),
      permissionMode: sendMessageInput.shape.permissionMode.describe("Tool permission mode: ask | auto-edit | yolo"),
      thinkingLevel: sendMessageInput.shape.thinkingLevel.describe("Reasoning depth: off | minimal | low | medium | high | xhigh"),
    },
    async (args) => {
      const { conversationId, ...body } = args;
      const result = await client.sendMessage(conversationId, body);
      const runUrl = client.entityUrl({ kind: "run", id: result.runId });
      const convUrl = await conversationUrlFor(client, conversationId);
      return withLinks(result, [
        { url: convUrl, label: "Open chat", field: "conversationUrl" },
        { url: runUrl, label: "View run", field: "runUrl" },
      ]);
    },
  );

  server.tool(
    "get_messages",
    "Fetch the message history of a conversation. Use this to read what was said or check assistant replies.",
    {
      conversationId: z.string().describe("UUID of the conversation"),
      all: z.boolean().optional().describe("Return all messages, not just the active branch"),
      withToolCalls: z.boolean().optional().describe("Include tool call messages"),
    },
    async (args) => {
      // get_messages is a bulk read — returning the raw array preserves
      // the pre-existing shape (tests + downstream consumers rely on
      // it). We don't own the messages or produce them; linking happens
      // elsewhere in the flow (send_message returns a conversationUrl).
      const { conversationId, ...opts } = args;
      const messages = await client.getMessages(conversationId, opts);
      return { content: [{ type: "text" as const, text: JSON.stringify(messages) }] };
    },
  );

  server.tool(
    "stream_run",
    "Stream runtime events for a run until completion or error. Use this after send_message to wait for the assistant response and collect all events.",
    {
      runId: z.string().describe("The runId returned by send_message or start_assignment"),
      conversationId: z.string().optional().describe("Optional conversationId for additional event filtering"),
      timeoutSeconds: z.number().optional().describe(`Seconds to wait before giving up (default ${DEFAULT_STREAM_TIMEOUT_SECONDS})`),
    },
    async (args) => {
      const timeout = (args.timeoutSeconds ?? DEFAULT_STREAM_TIMEOUT_SECONDS) * 1000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const events: unknown[] = [];
      try {
        for await (const event of client.streamEvents({ signal: controller.signal })) {
          // Filter by runId; optionally also filter by conversationId
          const data = event.data as Record<string, unknown>;
          const eventRunId = data["runId"] as string | undefined;
          if (eventRunId !== args.runId) continue;
          if (args.conversationId) {
            const eventConvId = data["conversationId"] as string | undefined;
            if (eventConvId && eventConvId !== args.conversationId) continue;
          }
          events.push(event);
          if (event.type === "run:complete" || event.type === "run:error") break;
        }
      } catch (err) {
        if (controller.signal.aborted) {
          events.push({ type: "stream_run:timeout", data: { runId: args.runId, timeoutSeconds: args.timeoutSeconds ?? DEFAULT_STREAM_TIMEOUT_SECONDS } });
        } else {
          throw err;
        }
      } finally {
        clearTimeout(timer);
      }

      // stream_run returns a raw event array — tests + consumers
      // expect an array, not a wrapped object. The URL affordance for
      // this run is returned by send_message (which produced the run).
      return { content: [{ type: "text" as const, text: JSON.stringify(events) }] };
    },
  );

  server.tool(
    "cancel_run",
    "Cancel the active run in a conversation. Use this to abort an in-progress assistant turn.",
    {
      conversationId: z.string().describe("UUID of the conversation whose active run to cancel"),
      force: z.boolean().optional().describe("Force-cancel even if a graceful cancel is in progress"),
    },
    async (args) => {
      const result = await client.cancelRun(args.conversationId, args.force ?? false);
      const convUrl = await conversationUrlFor(client, args.conversationId);
      return withLink(result, convUrl, "Open chat");
    },
  );
}

/** Resolve a clickable conversation URL from an id. Calls
 *  `getConversation` to pick up the `projectId` (required by the
 *  route). Any API error becomes a `project/unknown` URL so the tool
 *  response still includes a best-effort link rather than failing the
 *  whole call — the link can be wrong but the tool remains useful. */
async function conversationUrlFor(
  client: EzcorpClient,
  conversationId: string,
): Promise<string> {
  try {
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
