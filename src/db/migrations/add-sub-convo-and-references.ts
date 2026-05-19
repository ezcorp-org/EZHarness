/**
 * Phase 33: Sub-conversations & Agent References migration
 *
 * Adds:
 *   - conversations.parent_conversation_id (FK to conversations.id, cascade delete)
 *   - conversations.parent_message_id (nullable text)
 *   - agent_configs.references (JSONB, default { agents: [], extensions: [] })
 *
 * This migration is applied automatically via src/db/migrate.ts.
 * This file exists for documentation and can be run standalone if needed.
 */
import { sql } from "drizzle-orm";

export async function up(db: any): Promise<void> {
  await db.execute(sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS parent_conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE`);
  await db.execute(sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS parent_message_id TEXT`);
  await db.execute(sql`ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS "references" JSONB DEFAULT '{"agents":[],"extensions":[]}'`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_conversations_parent ON conversations(parent_conversation_id)`);
}
