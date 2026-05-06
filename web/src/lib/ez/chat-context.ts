/**
 * Phase 48 Wave 4 — chat-page context shape for the Ez panel.
 *
 * Pure logic: turn the chat page's `messages` + `currentConversation` +
 * `convId` into the JSON payload `<EzContext data={...}>` registers.
 * Living in `$lib/ez/` (rather than inline in the page) keeps the
 * truncation rule + last-N selection unit-testable without spinning up
 * the chat route's full dependency graph.
 *
 * Contract (matches the wave-4 plan):
 *   - `conversationId` always populated (the page passes its current
 *     convId; we don't infer it)
 *   - `conversationTitle` is the conversation's title or `null`
 *   - `messageCount` is the *active branch* length (the page already
 *     resolves the displayed branch; we just count what we're given)
 *   - `recentMessages`: last 5 of the supplied list, each with `text`
 *     truncated to 120 chars (with an ellipsis if cut). Non-string
 *     content (e.g. tool-only assistant messages) becomes empty string.
 */
export interface ChatMessageLike {
  id: string;
  role: string;
  content: unknown;
}

export interface ChatRecentMessage {
  id: string;
  role: string;
  text: string;
}

export interface ChatEzContextData {
  conversationId: string;
  conversationTitle: string | null;
  messageCount: number;
  recentMessages: ChatRecentMessage[];
  [key: string]: unknown;
}

export const RECENT_MESSAGE_LIMIT = 5;
export const RECENT_MESSAGE_CHAR_LIMIT = 120;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  // Reserve one char for the ellipsis so the *total* string still fits
  // the limit when treated as a contract on the LLM-side.
  return text.slice(0, max - 1) + "…";
}

export function buildChatEzContextData(opts: {
  conversationId: string;
  conversationTitle?: string | null;
  messages: ChatMessageLike[];
}): ChatEzContextData {
  const recent = opts.messages
    .slice(-RECENT_MESSAGE_LIMIT)
    .map((m) => ({
      id: m.id,
      role: m.role,
      text: typeof m.content === "string" ? truncate(m.content, RECENT_MESSAGE_CHAR_LIMIT) : "",
    }));
  return {
    conversationId: opts.conversationId,
    conversationTitle: opts.conversationTitle ?? null,
    messageCount: opts.messages.length,
    recentMessages: recent,
  };
}
