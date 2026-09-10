import { createMessage } from "$server/db/queries/conversations";
import { persistToolCall } from "$server/db/queries/tool-calls";
import { seedInactiveExtension } from "./test-agent-config";

/** Fixed persisted regression data, reachable only through the gated seed route. */
export async function seedBlankToolHistory(conversationId: string, userId: string) {
  const extension = await seedInactiveExtension(userId, "blank-history");
  const ids: Record<string, string> = {};
  let parentMessageId: string | undefined;
  const turns = [
    { key: "user", role: "user", content: "Create a design system for my app." },
    { key: "thinking", role: "assistant", content: "", thinkingContent: "I will inspect the design requirements." },
    { key: "generic", role: "assistant", content: "", toolName: "generate-design" },
    { key: "dock", role: "assistant", content: "", toolName: "open-canvas", cardType: "design-canvas", cardLayout: "dock" },
    { key: "empty", role: "assistant", content: "" },
    { key: "final", role: "assistant", content: "Done — I created the design." },
  ];
  for (const turn of turns) {
    const message = await createMessage(conversationId, {
      role: turn.role, content: turn.content, thinkingContent: turn.thinkingContent, parentMessageId,
    });
    ids[turn.key] = message.id;
    parentMessageId = message.id;
    if (turn.toolName) {
      await persistToolCall({
        conversationId, messageId: message.id, extensionId: extension.id, toolName: turn.toolName,
        input: {}, output: { content: [{ type: "text", text: "Design ready" }] },
        success: true, durationMs: 25, userId, cardType: turn.cardType, cardLayout: turn.cardLayout,
      });
    }
  }
  return ids;
}
