interface ConversationExport {
  id: string;
  title: string;
  model: string | null;
  provider: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MessageExport {
  role: string;
  content: string;
  model: string | null;
  provider: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  createdAt: Date;
}

export function exportToMarkdown(conversation: ConversationExport, messages: MessageExport[]): string {
  const lines: string[] = [
    `# ${conversation.title}`,
    "",
    `**Created:** ${conversation.createdAt.toISOString()}`,
    `**Model:** ${conversation.model ?? "default"}`,
    "",
    "---",
    "",
  ];

  for (const msg of messages) {
    const label = msg.role === "user"
      ? "**You**"
      : `**Assistant** (${msg.model ?? "unknown"})`;
    lines.push(`### ${label}`);
    lines.push("");
    lines.push(msg.content);
    lines.push("");
  }

  return lines.join("\n");
}

export function exportToJson(conversation: ConversationExport, messages: MessageExport[]): string {
  return JSON.stringify(
    {
      conversation: {
        id: conversation.id,
        title: conversation.title,
        model: conversation.model,
        provider: conversation.provider,
        createdAt: conversation.createdAt.toISOString(),
        updatedAt: conversation.updatedAt.toISOString(),
      },
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        model: m.model,
        provider: m.provider,
        usage: m.usage,
        createdAt: m.createdAt.toISOString(),
      })),
      exportedAt: new Date().toISOString(),
    },
    null,
    2,
  );
}
