import { getDb } from "../connection";
import { conversationExtensions } from "../schema";
import { eq } from "drizzle-orm";

export async function getConversationExtensionIds(conversationId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ extensionId: conversationExtensions.extensionId })
    .from(conversationExtensions)
    .where(eq(conversationExtensions.conversationId, conversationId));
  return rows.map((r: { extensionId: string }) => r.extensionId);
}

export async function addConversationExtensions(
  conversationId: string,
  entries: { extensionId: string; messageId?: string }[],
): Promise<void> {
  if (entries.length === 0) return;
  const db = getDb();
  await db.insert(conversationExtensions)
    .values(entries.map(e => ({
      conversationId,
      extensionId: e.extensionId,
      addedByMessageId: e.messageId,
    })))
    .onConflictDoNothing();
}

/**
 * Copy the `conversation_extensions` rows from one conversation to
 * another. Used by Phase 2d's `ezcorp/spawn-assignment` so a freshly
 * created sub-conversation inherits the parent's extension set — the
 * spawning extension (and its wired siblings) are automatically
 * observable on the child with no per-spawn opt-in. Idempotent via
 * the existing UNIQUE(conversation_id, extension_id) constraint.
 */
export async function copyConversationExtensions(
  fromConversationId: string,
  toConversationId: string,
): Promise<void> {
  const ids = await getConversationExtensionIds(fromConversationId);
  if (ids.length === 0) return;
  await addConversationExtensions(
    toConversationId,
    ids.map((extensionId) => ({ extensionId })),
  );
}
