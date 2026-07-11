/**
 * Session-tree storage migration (Postgres SessionStorage — P1)
 *
 * Adds the durable substrate for `DbSessionStorage`
 * (src/db/session-storage.ts), a faithful port of pi-agent-core's
 * `JsonlSessionStorage` / `InMemorySessionStorage` onto Postgres/PGlite.
 * This is P1 of tasks/2026-07-11-postgres-session-storage-design.md §7 —
 * tables + migration ONLY. NOTHING in the runtime imports the storage
 * yet (zero product risk); wiring (history producer, append seams,
 * rewind API/UI) lands in later slices.
 *
 * NAMING: the design doc calls these `sessions`/`session_entries`, but
 * EZCorp already has an auth `sessions` table (Phase 43) — so these are
 * namespaced `agent_sessions` / `agent_session_entries` (the pi AGENT
 * session tree, distinct from auth sessions).
 *
 * Schema deltas (idempotent, additive — no destructive changes):
 *   - agent_sessions (id, conversation_id FK CASCADE, cwd,
 *     parent_session_id self-FK SET NULL, leaf_entry_id, metadata JSONB,
 *     created_at). A partial UNIQUE index
 *     `agent_sessions_conversation_unique(conversation_id) WHERE
 *     conversation_id IS NOT NULL` gives the 1:1 conversation↔session
 *     mapping once wired, while allowing many conversation-less sessions
 *     (unwired P1 rows). `leaf_entry_id` is an O(1) getLeafId cache; the
 *     leaf is still AUTHORITATIVELY recovered by replaying entries in
 *     seq order on open.
 *   - agent_session_entries (session_id FK CASCADE, entry_id,
 *     seq BIGSERIAL, type, parent_id, timestamp TEXT, payload JSONB,
 *     ez_message_id FK SET NULL) with composite PRIMARY KEY
 *     (session_id, entry_id). Indexes on (session_id, seq),
 *     (session_id, type), (session_id, parent_id).
 *
 * Load-bearing design invariants (see the design doc §1–§3 and the port
 * in src/db/session-storage.ts):
 *   - PK (session_id, entry_id): forked entries REUSE their source ids
 *     across sessions, so ids are unique only WITHIN a session. A
 *     duplicate append within one session rejects on the PK — the
 *     DB-level analog of the JSONL impl's id uniqueness.
 *   - seq BIGSERIAL is the INSERTION-order axis. pi entry ids are 8-char
 *     uuidv7 slices (NOT monotonic), so getEntries / findEntries /
 *     leaf-recovery order by seq, never by id. Tree order (parent_id
 *     chain) is a SEPARATE axis surfaced by getPathToRoot.
 *   - timestamp is TEXT (not timestamptz): pi's ISO string round-trips
 *     VERBATIM so entry payloads stay byte-faithful.
 *   - payload JSONB is written ONLY via column-mapped drizzle inserts
 *     (never `${JSON.stringify(x)}::jsonb` raw SQL) — that double-encodes
 *     under the Bun.sql driver. NOTE: jsonb normalises object KEY ORDER,
 *     so the serialized bytes of a payload can differ from the JSONL
 *     file's; the VALUES (unicode, nesting, numbers) round-trip exactly
 *     and pi reads entries by property, so this is semantically faithful.
 *
 * schema.ts vs this DDL: schema.ts carries column names/types for the
 * query builder and models parent_session_id as a SOFT ref (mirroring
 * messages.parentMessageId); this migration is the authoritative DDL and
 * declares the real self-referential FK + partial unique index.
 *
 * This migration is applied automatically via src/db/migrate.ts (the DDL
 * is inlined there, after the message_attachments block). This file
 * exists for documentation and parallels add-feature-index.ts /
 * add-lessons.ts. (src/db/migrations/** is coverage-excluded — see
 * scripts/coverage-config.ts.)
 */
import { sql } from "drizzle-orm";

export async function up(db: any): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      cwd TEXT,
      parent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
      leaf_entry_id TEXT,
      metadata JSONB,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_conversation_unique
      ON agent_sessions(conversation_id)
      WHERE conversation_id IS NOT NULL
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS agent_session_entries (
      session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      entry_id TEXT NOT NULL,
      seq BIGSERIAL,
      type TEXT NOT NULL,
      parent_id TEXT,
      timestamp TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}',
      ez_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      PRIMARY KEY (session_id, entry_id)
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_agent_session_entries_seq ON agent_session_entries(session_id, seq)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_agent_session_entries_type ON agent_session_entries(session_id, type)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_agent_session_entries_parent ON agent_session_entries(session_id, parent_id)`);
}
