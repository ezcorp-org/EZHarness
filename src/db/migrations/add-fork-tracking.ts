/**
 * Fork tracking migration
 *
 * Adds:
 *   - conversations.forked_from_conversation_id (FK to conversations.id, ON DELETE SET NULL)
 *   - conversations.forked_from_message_id (nullable text)
 *   - idx_conversations_forked_from index
 *
 * Distinct from parent_conversation_id (reserved for sub-conversations).
 * Forks are root-level chats with a back-pointer so the sidebar can group
 * them under their source. SET NULL on delete so a fork survives if its
 * source is removed.
 *
 * This migration is applied automatically via src/db/migrate.ts.
 * This file exists for documentation and can be run standalone if needed.
 */
import { sql } from "drizzle-orm";

export async function up(db: any): Promise<void> {
  await db.execute(sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS forked_from_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL`);
  await db.execute(sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS forked_from_message_id TEXT`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_conversations_forked_from ON conversations(forked_from_conversation_id)`);
}
