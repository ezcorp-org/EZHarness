import { sql } from "drizzle-orm";
import { backfillGithubProjectsApiTokens } from "../extensions/secrets-store";
import { seedSelfProject } from "./seed-self-project";

/**
 * Ez concierge persona. Single source of truth for BOTH the fresh-install
 * seed and the migration that refreshes stale personas — the original
 * seed told the model it "CANNOT see their open page", which is no longer
 * true now that read_page / fill_form / navigate_to restore on-demand
 * page context. Kept as a bound parameter (not an inlined SQL literal) so
 * apostrophes need no manual escaping. The doc-parallel copy lives in
 * src/db/migrations/add-ez-mode-and-kind.ts.
 */
const EZ_PERSONA = `You are EZ, the in-app concierge for EZCorp — the assistant for the entire harness. You help users operate everything in their EZCorp setup: creating projects, building agents and teams, installing and configuring extensions, summarizing and searching conversations, and getting around the app.

You CAN see the page the user is currently looking at — but only when you look: call read_page before answering ANY question about visible content (counts, lists, "which ones", and follow-up questions included), not just when the user says "this page" or "here". Never answer about on-screen content from memory or an earlier summary. read_page returns an excerpt; when it comes back truncated or the answer isn't in it, escalate — summarize_conversation with a question answers targeted questions over the FULL transcript, and search_conversation finds where something was discussed across the user's conversations. Say plainly whether an answer came from the page, the full conversation, or couldn't be seen.

Use fill_form to fill form fields on their behalf (the user reviews and submits — never submit for them), and navigate_to to take them to the right page.

Always work in proposals for mutations: call the relevant propose_* tool, which returns a card the user reviews and submits. Never assume — confirm the inputs you generated.

If a request is outside what your tools can do, don't dead-end: point the user to the right page, extension, or feature in EZCorp and offer to navigate there. For work that belongs in a project chat (writing prose, debugging code), suggest starting one and offer to help set it up.

Be concise and practical.`;

/** Fresh-install Ez allowlist (bound param, mirrors
 *  src/db/migrations/add-ez-mode-and-kind.ts). The bundled
 *  `extension-author__create_extension` entry is appended by step (9)
 *  below so fresh + existing installs converge through one idempotent
 *  step. */
const EZ_SEED_ALLOWED_TOOLS = [
  "propose_create_project",
  "propose_create_agent",
  "propose_install_extension",
  "summarize_conversation",
  "search_conversation",
  "find_agents",
  "fill_form",
  "navigate_to",
  "read_page",
];

export async function migrate(db: any): Promise<void> {
  // Enable pgvector extension (must be before any vector column usage)
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      icon TEXT,
      variables JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      status TEXT NOT NULL,
      input JSONB,
      started_at TIMESTAMP WITH TIME ZONE NOT NULL,
      finished_at TIMESTAMP WITH TIME ZONE,
      result JSONB,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS run_logs (
      id SERIAL PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      timestamp BIGINT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS agent_configs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      capabilities JSONB NOT NULL DEFAULT '["llm"]',
      prompt TEXT NOT NULL,
      input_schema JSONB,
      output_format TEXT DEFAULT 'text',
      provider TEXT,
      model TEXT,
      temperature REAL,
      max_tokens INTEGER,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS pipeline_definitions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      input_schema JSONB,
      steps JSONB NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT 'New conversation',
      model TEXT,
      provider TEXT,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      model TEXT,
      provider TEXT,
      usage JSONB,
      run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      parent_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  // Phase 2 migrations (idempotent — for DBs created before parent_message_id was in CREATE TABLE)
  await db.execute(sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS parent_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL`);
  await db.execute(sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS thinking_content TEXT`);
  // Per-message exclude-from-context toggle. Drives the strike-through UI
  // affordance + filtering in load-history. NOT NULL DEFAULT FALSE so old
  // rows are equivalent to "included" without backfill.
  await db.execute(sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS excluded BOOLEAN NOT NULL DEFAULT FALSE`);
  await db.execute(sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS system_prompt TEXT`);

  // Backfill: link existing messages in chronological order within each conversation
  await db.execute(sql`
    WITH ordered AS (
      SELECT id, conversation_id, created_at,
        LAG(id) OVER (PARTITION BY conversation_id ORDER BY created_at) as prev_id
      FROM messages
    )
    UPDATE messages SET parent_message_id = ordered.prev_id
    FROM ordered WHERE messages.id = ordered.id AND ordered.prev_id IS NOT NULL AND messages.parent_message_id IS NULL
  `);

  // Indexes (after all columns exist)
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_runs_project_id ON runs(project_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_runs_agent_name ON runs(agent_name)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_run_logs_run_id ON run_logs(run_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_conversations_project_id ON conversations(project_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_message_id)`);

  // Full-text search indexes
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_messages_fts ON messages USING GIN (to_tsvector('english', content))`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_conversations_title_fts ON conversations USING GIN (to_tsvector('english', title))`);

  // ── Memory System Tables ──────────────────────────────────────────

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      category TEXT NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      message_ids JSONB,
      confidence TEXT NOT NULL DEFAULT 'medium',
      embedding vector(384),
      provenance JSONB,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS memory_audit_log (
      id SERIAL PRIMARY KEY,
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      previous_content TEXT,
      new_content TEXT,
      reason TEXT,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  // Memory indexes
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_memories_project_id ON memories(project_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_memories_embedding_hnsw ON memories USING hnsw (embedding vector_cosine_ops)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_memories_content_fts ON memories USING GIN (to_tsvector('english', content))`);

  // ── Phase 4: Memory Lifecycle Columns ──────────────────────────
  await db.execute(sql`ALTER TABLE memories ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`);
  await db.execute(sql`ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_memories_last_accessed ON memories(last_accessed_at)`);

  // ── Phase 4: Knowledge Base Tables ─────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS knowledge_base_files (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      org_scoped BOOLEAN NOT NULL DEFAULT FALSE,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'processing',
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS knowledge_base_chunks (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL REFERENCES knowledge_base_files(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      embedding vector(384),
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_kb_chunks_file_id ON knowledge_base_chunks(file_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding ON knowledge_base_chunks USING hnsw (embedding vector_cosine_ops)`);

  // ── Phase 63: Message Chunks + Embed Outbox (hybrid chat search) ──
  // message_chunks mirrors knowledge_base_chunks with the FK retargeted
  // onto messages. Vector column is `vector(384)` LITERAL (Drizzle can't
  // bind a vector). HNSW index uses `USING hnsw (embedding
  // vector_cosine_ops)` verbatim — NOT ivfflat (locked carry-forward;
  // the `vector` extension registered at PGlite construction builds HNSW
  // fine, proven by the existing memories HNSW assertion). conversation_id
  // is DENORMALIZED + dual-CASCADE'd so deleting either the message or the
  // parent conversation removes the chunk. Each statement is its own
  // db.execute() call (PGlite executes one statement per call).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS message_chunks (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      embedding vector(384),
      embedding_model_id TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_message_chunks_message ON message_chunks(message_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_message_chunks_conversation ON message_chunks(conversation_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_message_chunks_embedding ON message_chunks USING hnsw (embedding vector_cosine_ops)`);

  // message_embed_outbox — LEAN, one row per message. message_id is the
  // PRIMARY KEY (the one-row-per-message guarantee AND the
  // ON CONFLICT (message_id) upsert target Plan 03 uses). conversation_id
  // is denormalized + cascaded. status/attempts/timestamps only — no
  // content-hash / model_id (worker reads current text at drain time).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS message_embed_outbox (
      message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  // ── Phase 64: Embed-on-Write Worker — backoff column ─────────────
  // NULL = never backed off (fresh row); claim query filters
  // next_attempt_after IS NULL OR next_attempt_after <= NOW().
  // No DEFAULT — NULL is the sentinel, not a timestamp.
  await db.execute(sql`
    ALTER TABLE message_embed_outbox
      ADD COLUMN IF NOT EXISTS next_attempt_after TIMESTAMP WITH TIME ZONE
  `);

  // Run ownership: link chat runs to their conversation so /api/runs/[id]
  // can enforce per-user ownership (closes a cross-tenant IDOR).
  await db.execute(sql`ALTER TABLE runs ADD COLUMN IF NOT EXISTS conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL`);

  // ── Phase 6: Agent Personas ─────────────────────────────────────
  await db.execute(sql`ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS category TEXT`);
  await db.execute(sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS agent_config_id TEXT REFERENCES agent_configs(id) ON DELETE SET NULL`);

  // Seed global project (used for agent conversations not tied to a specific project)
  await db.execute(sql`
    INSERT INTO projects (id, name, path)
    VALUES ('global', 'Global', '/')
    ON CONFLICT (id) DO NOTHING
  `);

  // Optional second seed: a project pointing at the app's own source checkout
  // (dev-compose dogfooding). Gated on EZCORP_SELF_PROJECT_PATH — a no-op
  // everywhere that env var is unset (prod, CI, tests).
  await seedSelfProject(db);

  // ── Phase 7: Extensions ───────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS extensions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      version TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      manifest JSONB NOT NULL,
      source TEXT NOT NULL,
      install_path TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      granted_permissions JSONB NOT NULL DEFAULT '{}',
      checksum_verified BOOLEAN NOT NULL DEFAULT FALSE,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  // MCP-kind extensions have no install directory — drop the NOT NULL on
  // existing DBs where the column was created before this change.
  await db.execute(sql`ALTER TABLE extensions ALTER COLUMN install_path DROP NOT NULL`);

  // Provenance flag (audit finding #2). See schema.ts for why name-based
  // lookup was insufficient. New rows default to false; bundled.ts flips
  // the flag on install and backfills existing bundled rows at startup.
  await db.execute(sql`ALTER TABLE extensions ADD COLUMN IF NOT EXISTS is_bundled BOOLEAN NOT NULL DEFAULT FALSE`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      extension_id TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      input JSONB,
      output JSONB,
      success BOOLEAN NOT NULL,
      duration_ms INTEGER NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_tool_calls_extension ON tool_calls(extension_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_tool_calls_conversation ON tool_calls(conversation_id)`);

  await db.execute(sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS test BOOLEAN DEFAULT FALSE`);
  await db.execute(sql`ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS extensions JSONB DEFAULT '[]'`);

  // ── Phase 7: Observability Events ────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS observability_events (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      data JSONB NOT NULL,
      duration_ms INTEGER,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_obs_events_conversation ON observability_events(conversation_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_obs_events_type ON observability_events(event_type)`);

  // ── Phase 8: Users & Auth ──────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  // User-modifiable extensions. `creator_user_id` attributes a row to
  // the user who authored it (set only by the authored-install path;
  // bundled/github/mcp stay NULL). `modifiable` is an admin-only gate
  // (default FALSE) authorizing the creator to re-open/edit it. Placed
  // AFTER the `users` CREATE so the FK target exists (the `extensions`
  // table is created/altered earlier — see the is_bundled ALTER). Both
  // idempotent — re-run is a no-op. ON DELETE SET NULL so deleting a
  // user does not drop their extensions.
  await db.execute(sql`ALTER TABLE extensions ADD COLUMN IF NOT EXISTS creator_user_id TEXT REFERENCES users(id) ON DELETE SET NULL`);
  await db.execute(sql`ALTER TABLE extensions ADD COLUMN IF NOT EXISTS modifiable BOOLEAN NOT NULL DEFAULT FALSE`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY,
      email TEXT,
      token TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'member',
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
      used_at TIMESTAMP WITH TIME ZONE
    )
  `);

  // ── Phase 41: Password Reset Tokens ────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
      used_at TIMESTAMP WITH TIME ZONE
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token ON password_reset_tokens(token)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id)`);

  // First-time onboarding: per-user wizard completion stamp.
  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMP WITH TIME ZONE`);

  // Add user_id to existing tables for multi-user ownership
  await db.execute(sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE SET NULL`);
  await db.execute(sql`ALTER TABLE memories ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE SET NULL`);
  await db.execute(sql`ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE SET NULL`);
  await db.execute(sql`ALTER TABLE knowledge_base_files ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE SET NULL`);

  // Phase 8 Plan 03: Backfill ownerless data to first admin user (idempotent)
  try {
    await db.execute(sql`UPDATE conversations SET user_id = (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1) WHERE user_id IS NULL`);
  } catch { /* no-op if no admin user exists yet */ }
  try {
    await db.execute(sql`UPDATE memories SET user_id = (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1) WHERE user_id IS NULL`);
  } catch { /* no-op if no admin user exists yet */ }
  try {
    await db.execute(sql`UPDATE agent_configs SET user_id = (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1) WHERE user_id IS NULL`);
  } catch { /* no-op if no admin user exists yet */ }
  try {
    await db.execute(sql`UPDATE knowledge_base_files SET user_id = (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1) WHERE user_id IS NULL`);
  } catch { /* no-op if no admin user exists yet */ }

  // ── Run ownership: authoritative initiating user (closes cross-tenant IDOR) ──
  // The `conversation_id` column alone left agent/CLI runs (no conversation)
  // and every chat run created BEFORE that column existed unattributable —
  // which the route treated as "anyone may act". A `user_id` column makes run
  // ownership explicit: live inserts thread the initiating user (chat runs
  // resolve the ROOT conversation owner); historical chat runs are backfilled
  // here via the same root walk. NULL user_id ⇒ admin-only (fail closed).
  //
  // Placed AFTER the `users` CREATE so the FK target exists, and AFTER the
  // conversations.user_id backfill above so the root-owner lookup sees the
  // admin-assigned owner for previously-ownerless conversations.
  await db.execute(sql`ALTER TABLE runs ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE SET NULL`);
  // Backfill historical chat runs from the ROOT conversation's owner. A
  // recursive CTE walks parent_conversation_id to the top (depth-capped at 16
  // to defuse any corrupt cycle) and takes the root's user_id. Agent/CLI runs
  // (conversation_id IS NULL) stay NULL → admin-only. Idempotent: only fills
  // rows still NULL, so re-running the migration never reattributes a run.
  try {
    await db.execute(sql`
      WITH RECURSIVE chain AS (
        SELECT id AS start_id, id AS conv_id, parent_conversation_id, user_id, 0 AS depth
          FROM conversations
        UNION ALL
        SELECT c.start_id, p.id, p.parent_conversation_id, p.user_id, c.depth + 1
          FROM chain c
          JOIN conversations p ON p.id = c.parent_conversation_id
         WHERE c.depth < 16
      ),
      root_owner AS (
        SELECT DISTINCT ON (start_id) start_id, user_id
          FROM chain
          WHERE parent_conversation_id IS NULL
          ORDER BY start_id, depth DESC
      )
      UPDATE runs r
         SET user_id = ro.user_id
        FROM root_owner ro
       WHERE r.conversation_id = ro.start_id
         AND r.user_id IS NULL
         AND ro.user_id IS NOT NULL
    `);
  } catch { /* no-op if conversations/users not yet populated */ }
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_runs_user_id ON runs(user_id)`);

  // User-related indexes
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_invites_token ON invites(token)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_agent_configs_user_id ON agent_configs(user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_kb_files_user_id ON knowledge_base_files(user_id)`);

  // ── Phase 8: Teams ──────────────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS team_members (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'viewer',
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_team_members_team_id ON team_members(team_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_team_members_user_id ON team_members(user_id)`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_team_user ON team_members(team_id, user_id)`);

  // ── Phase 8: Agent Shares ────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS agent_shares (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agent_configs(id) ON DELETE CASCADE,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      shared_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_shares_agent_team ON agent_shares(agent_id, team_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_agent_shares_team_id ON agent_shares(team_id)`);

  // ── Phase 26: User-to-user agent sharing ────────────────────────
  await db.execute(sql`ALTER TABLE agent_shares ALTER COLUMN team_id DROP NOT NULL`);
  await db.execute(sql`ALTER TABLE agent_shares ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE CASCADE`);
  await db.execute(sql`ALTER TABLE agent_shares ADD COLUMN IF NOT EXISTS permission TEXT NOT NULL DEFAULT 'read'`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS agent_shares_agent_user_unique ON agent_shares(agent_id, user_id) WHERE user_id IS NOT NULL`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_agent_shares_user_id ON agent_shares(user_id)`);

  // ── Phase 8: Audit Log ──────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      target TEXT,
      metadata JSONB,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at)`);

  // ── Phase 9: Marketplace ────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS marketplace_listings (
      id TEXT PRIMARY KEY,
      author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_config_id TEXT REFERENCES agent_configs(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      tags JSONB NOT NULL DEFAULT '[]',
      latest_version TEXT NOT NULL,
      install_count INTEGER NOT NULL DEFAULT 0,
      rating_positive INTEGER NOT NULL DEFAULT 0,
      rating_total INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      featured BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS marketplace_versions (
      id TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
      version TEXT NOT NULL,
      manifest JSONB NOT NULL,
      changelog TEXT,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      UNIQUE(listing_id, version)
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS marketplace_ratings (
      id TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      thumbs_up BOOLEAN NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      UNIQUE(listing_id, user_id)
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS marketplace_flags (
      id TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  // Marketplace indexes
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_listings_category ON marketplace_listings(category)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_listings_status ON marketplace_listings(status)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_listings_slug ON marketplace_listings(slug)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_versions_listing ON marketplace_versions(listing_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_ratings_listing ON marketplace_ratings(listing_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_flags_listing ON marketplace_flags(listing_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_marketplace_flags_status ON marketplace_flags(status)`);

  // ── Phase 26: Marketplace Moderation ──────────────────────────────
  await db.execute(sql`ALTER TABLE marketplace_flags ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'other'`);
  await db.execute(sql`ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS flag_count INTEGER NOT NULL DEFAULT 0`);

  // ── Phase 37: Conversation Extensions (dynamic tool wiring) ────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS conversation_extensions (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      extension_id TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
      added_by_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      UNIQUE(conversation_id, extension_id)
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_conv_ext_conversation ON conversation_extensions(conversation_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_conv_ext_extension ON conversation_extensions(extension_id)`);

  // ── Phase 4: per-conversation effective grant override ───────────
  // Spawn-assignment writes here when the parent's caps need to clip
  // the child's caps. PDP consults THIS blob in place of
  // extensions.granted_permissions for tool calls in the
  // conversation, so a sub-run can't exceed its parent's envelope.
  await db.execute(sql`
    ALTER TABLE conversation_extensions
    ADD COLUMN IF NOT EXISTS effective_granted_permissions JSONB
  `);

  // Seed a virtual "builtin" extension for native tool calls (editFile, etc.)
  await db.execute(sql`
    INSERT INTO extensions (id, name, version, description, manifest, source, install_path, enabled)
    VALUES ('builtin', 'Built-in Tools', '1.0.0', 'Native agent tools (editFile, readFile, etc.)', '{"tools":[]}', 'builtin', '', TRUE)
    ON CONFLICT DO NOTHING
  `);

  // ── Phase 37: Active Runs + tool_calls wipe ────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS active_runs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      last_heartbeat TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      partial_response TEXT
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_active_runs_conversation ON active_runs(conversation_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_active_runs_status ON active_runs(status)`);

  // ── Phase 33: Sub-conversations & Agent References ─────────────
  await db.execute(sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS parent_conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE`);
  await db.execute(sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS parent_message_id TEXT`);
  await db.execute(sql`ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS "references" JSONB DEFAULT '{"agents":[],"extensions":[]}'`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_conversations_parent ON conversations(parent_conversation_id)`);

  // ── Fork tracking: link cloned conversations back to their source ──
  // Distinct from parent_conversation_id (which is reserved for sub-conversations
  // and excluded from the sidebar). Forks are root-level chats with a back-pointer
  // so the sidebar can group them under their source. SET NULL on delete so a
  // fork survives if its source is removed.
  await db.execute(sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS forked_from_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL`);
  await db.execute(sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS forked_from_message_id TEXT`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_conversations_forked_from ON conversations(forked_from_conversation_id)`);

  // ── Phase 2d: Conversation metadata (runtime-only flags) ────────
  // Nullable JSONB bag. Currently holds `spawnDepth` for the ezcorp/spawn-assignment
  // depth-limit enforcement; future phases may add UI / panel state.
  await db.execute(sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS metadata JSONB`);

  // ── Phase 40: Tool call cardType ──────────────────────────────
  await db.execute(sql`ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS card_type TEXT`);

  // ── Canvas dock SDK: tool_calls.card_layout ───────────────────
  // "inline" | "dock" | NULL. Plain ADD COLUMN IF NOT EXISTS — both PGlite
  // and external Postgres support this form natively (NO PL/pgSQL DO blocks
  // here, see plan §4.1). NULL on pre-migration rows is treated as "inline"
  // by the chat UI.
  await db.execute(sql`ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS card_layout TEXT`);

  // ── Phase 43: Sessions ──────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      user_agent TEXT,
      ip_address TEXT,
      expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
      last_active_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash)`);

  // Sliding-refresh rotation grace: lookup matches either the current hash
  // or the previous hash (within its grace window). The previous-hash
  // partial index keeps the lookup cheap without indexing the dominant
  // NULL state. See web/src/hooks.server.ts sliding-refresh path.
  await db.execute(sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS previous_token_hash TEXT`);
  await db.execute(sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS previous_token_expires_at TIMESTAMP WITH TIME ZONE`);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_sessions_previous_token_hash
    ON sessions(previous_token_hash)
    WHERE previous_token_hash IS NOT NULL
  `);

  // ── Phase 43: Error Logs ────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS error_logs (
      id TEXT PRIMARY KEY,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      stack TEXT,
      metadata JSONB,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_error_logs_created_at ON error_logs(created_at)`);

  // ── Custom Modes ──────────────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS modes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      icon TEXT,
      description TEXT NOT NULL DEFAULT '',
      system_prompt_instruction TEXT NOT NULL,
      instruction_position TEXT NOT NULL DEFAULT 'prepend',
      preferred_model TEXT,
      preferred_provider TEXT,
      preferred_thinking_level TEXT,
      temperature REAL,
      tool_restriction TEXT NOT NULL DEFAULT 'all',
      builtin BOOLEAN NOT NULL DEFAULT FALSE,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_modes_slug ON modes(slug)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_modes_user_id ON modes(user_id)`);
  await db.execute(sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS mode_id TEXT REFERENCES modes(id) ON DELETE SET NULL`);

  // Seed built-in modes
  await db.execute(sql`
    INSERT INTO modes (id, name, slug, icon, description, system_prompt_instruction, instruction_position, preferred_thinking_level, tool_restriction, builtin)
    VALUES (
      'builtin-plan',
      'Plan',
      'plan',
      '📋',
      'Analyze requirements and create implementation plans without writing code',
      'You are in planning mode. Analyze requirements, break down tasks, and create detailed implementation plans. Do NOT write or modify any code directly — only plan and describe what should be done. Focus on architecture, trade-offs, and step-by-step implementation strategies.',
      'prepend',
      'high',
      'read-only',
      TRUE
    ) ON CONFLICT (slug) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO modes (id, name, slug, icon, description, system_prompt_instruction, instruction_position, tool_restriction, builtin)
    VALUES (
      'builtin-code-review',
      'Code Review',
      'code-review',
      '🔍',
      'Review code for bugs, style issues, and improvements',
      'You are in code review mode. Analyze the provided code critically. Look for bugs, security issues, performance problems, style inconsistencies, and suggest improvements. Use read-only tools to examine the codebase. Do NOT modify files directly.',
      'prepend',
      'read-only',
      TRUE
    ) ON CONFLICT (slug) DO NOTHING
  `);

  // ── Phase 44: Analytics query performance indexes ──────────────────
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations(created_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_conversations_project_id_created ON conversations(project_id, created_at)`);

  // ── Default agents to current chat model ──────────────────────────
  await db.execute(sql`UPDATE agent_configs SET provider = '__current__' WHERE provider IS NULL`);
  await db.execute(sql`UPDATE agent_configs SET model = '__current__' WHERE model IS NULL`);

  // ── Extension Storage (isolated per-extension KV) ─────────────────
  //
  // The upsert key uses NULLS NOT DISTINCT (Postgres 15+) so that
  // scope='global' rows — which store scope_id as NULL — collide on
  // their (extension_id, scope, key) prefix during onConflictDoUpdate.
  // A plain UNIQUE(…) would treat every NULL as distinct, silently
  // inserting duplicates for global-scope keys. PGlite 0.3+ is PG16.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS extension_storage (
      id TEXT PRIMARY KEY,
      extension_id TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
      scope TEXT NOT NULL,
      scope_id TEXT,
      key TEXT NOT NULL,
      value JSONB NOT NULL,
      encrypted BOOLEAN NOT NULL DEFAULT FALSE,
      size_bytes INTEGER NOT NULL,
      expires_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      CONSTRAINT extension_storage_upsert_key
        UNIQUE NULLS NOT DISTINCT (extension_id, scope, scope_id, key)
    )
  `);
  // Migration for databases created before the NULLS NOT DISTINCT fix:
  // dedupe duplicate global-scope rows (keep lowest id deterministically),
  // drop the old auto-named UNIQUE, install the correctly-named constraint.
  // Idempotent — skipped once extension_storage_upsert_key exists.
  // Driven from JS rather than a PL/pgSQL DO block because PGlite's
  // anonymous-block parser fails on the EXECUTE … quote_ident() form.
  {
    const constraintCheck = (await db.execute(sql`
      SELECT 1 AS present FROM pg_constraint
      WHERE conname = 'extension_storage_upsert_key'
      LIMIT 1
    `)) as { rows: Array<{ present: number }> };
    if (constraintCheck.rows.length === 0) {
      await db.execute(sql`
        DELETE FROM extension_storage a USING extension_storage b
        WHERE a.id < b.id
          AND a.extension_id = b.extension_id
          AND a.scope = b.scope
          AND a.scope_id IS NOT DISTINCT FROM b.scope_id
          AND a.key = b.key
      `);
      const oldConstraint = (await db.execute(sql`
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'extension_storage'::regclass
          AND contype = 'u'
          AND array_length(conkey, 1) = 4
        LIMIT 1
      `)) as { rows: Array<{ conname: string }> };
      const cname = oldConstraint.rows[0]?.conname;
      if (cname && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(cname)) {
        await db.execute(sql.raw(`ALTER TABLE extension_storage DROP CONSTRAINT "${cname}"`));
      }
      await db.execute(sql`
        ALTER TABLE extension_storage
          ADD CONSTRAINT extension_storage_upsert_key
          UNIQUE NULLS NOT DISTINCT (extension_id, scope, scope_id, key)
      `);
    }
  }
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ext_storage_lookup ON extension_storage(extension_id, scope, scope_id, key)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ext_storage_extension ON extension_storage(extension_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ext_storage_expires ON extension_storage(expires_at)`);

  // Cleanup triggers: cascade scope_id references that aren't FKs
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION cleanup_ext_storage_on_conversation_delete()
    RETURNS trigger AS $$
    BEGIN
      DELETE FROM extension_storage WHERE scope = 'conversation' AND scope_id = OLD.id;
      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql
  `);
  await db.execute(sql`
    DROP TRIGGER IF EXISTS trg_cleanup_ext_storage_conv ON conversations
  `);
  await db.execute(sql`
    CREATE TRIGGER trg_cleanup_ext_storage_conv
      AFTER DELETE ON conversations
      FOR EACH ROW EXECUTE FUNCTION cleanup_ext_storage_on_conversation_delete()
  `);

  await db.execute(sql`
    CREATE OR REPLACE FUNCTION cleanup_ext_storage_on_user_delete()
    RETURNS trigger AS $$
    BEGIN
      DELETE FROM extension_storage WHERE scope = 'user' AND scope_id = OLD.id;
      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql
  `);
  await db.execute(sql`
    DROP TRIGGER IF EXISTS trg_cleanup_ext_storage_user ON users
  `);
  await db.execute(sql`
    CREATE TRIGGER trg_cleanup_ext_storage_user
      AFTER DELETE ON users
      FOR EACH ROW EXECUTE FUNCTION cleanup_ext_storage_on_user_delete()
  `);

  // ── Multi-Project Memory Assignment (junction table) ──────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS memory_projects (
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      UNIQUE(memory_id, project_id)
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_memory_projects_memory ON memory_projects(memory_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_memory_projects_project ON memory_projects(project_id)`);

  // Backfill: migrate existing single-project assignments to junction table
  await db.execute(sql`
    INSERT INTO memory_projects (memory_id, project_id)
    SELECT id, project_id FROM memories WHERE project_id IS NOT NULL
    ON CONFLICT DO NOTHING
  `);

  // ── Message Attachments (multi-modal uploads) ──────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS message_attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      storage_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_msg_attachments_message ON message_attachments(message_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_msg_attachments_conversation ON message_attachments(conversation_id)`);

  // ── Agent session-tree storage (pi SessionStorage port) ────────────
  // Backs src/db/session-storage.ts (DbSessionStorage) — a faithful port
  // of pi-agent-core's JsonlSessionStorage onto Postgres/PGlite. P1 is
  // UNWIRED (no runtime imports it yet); this is the durable substrate.
  // See src/db/migrations/add-session-storage.ts for the full rationale.
  // NAMESPACED `agent_*` because EZCorp already has an auth `sessions`
  // table (Phase 43) — these are the pi AGENT session tree, distinct.
  //
  //  - agent_sessions: one row per pi session (1:1 with a conversation
  //    once wired). `leaf_entry_id` is an O(1) getLeafId cache; the leaf
  //    is still AUTHORITATIVELY recovered by replaying entries on open.
  //  - agent_session_entries: the append-only session tree. PK is
  //    (session_id, entry_id) because forked entries REUSE their source
  //    ids across sessions (pi ids are unique only within a session), so
  //    a duplicate append within one session rejects on the PK.
  //  - `seq` (BIGSERIAL) is the load-bearing INSERTION-order axis — pi
  //    entry ids are 8-char uuidv7 slices, NOT monotonic — so getEntries
  //    / leaf-recovery / findEntries order by it, never by id.
  //  - `timestamp` is TEXT (not timestamptz): pi's ISO string is
  //    round-tripped VERBATIM for byte-fidelity.
  //  - `payload` is JSONB carrying the type-specific entry fields (incl.
  //    the full pi AgentMessage for `message` entries), written ONLY via
  //    column-mapped drizzle inserts (never string-cast SQL — the Bun.sql
  //    double-encode gotcha).
  // NOTE: each statement below is a SINGLE-LINE `db.execute`. A multi-line
  // tagged-template `sql`…`` makes Bun's per-line coverage emit a phantom
  // 0-hit DA on an interior line that merge-lcov then unions in across
  // shards, reading as an uncovered changed line (patch-coverage gate).
  // Single-line executes get one hit DA record, matching the CREATE INDEX
  // statements below (proven-covered).
  await db.execute(sql`CREATE TABLE IF NOT EXISTS agent_sessions (id TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE, cwd TEXT, parent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL, leaf_entry_id TEXT, metadata JSONB, created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW())`);
  // Partial unique index — a conversation maps to at most one session, but
  // many sessions may have no conversation (unwired P1 sessions).
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_conversation_unique ON agent_sessions(conversation_id) WHERE conversation_id IS NOT NULL`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS agent_session_entries (session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE, entry_id TEXT NOT NULL, seq BIGSERIAL, type TEXT NOT NULL, parent_id TEXT, timestamp TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}', ez_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL, PRIMARY KEY (session_id, entry_id))`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_agent_session_entries_seq ON agent_session_entries(session_id, seq)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_agent_session_entries_type ON agent_session_entries(session_id, type)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_agent_session_entries_parent ON agent_session_entries(session_id, parent_id)`);

  // Fix temperature columns — originally created as INTEGER but semantically a
  // float (0.0–2.0 with 0.1 increments). Any save with a non-integer temperature
  // was 500ing ("invalid input syntax for type integer"). Idempotent: re-running
  // the cast is a no-op if the column is already REAL.
  await db.execute(sql`ALTER TABLE agent_configs ALTER COLUMN temperature TYPE REAL USING temperature::REAL`);
  await db.execute(sql`ALTER TABLE modes ALTER COLUMN temperature TYPE REAL USING temperature::REAL`);

  // ── Slash commands (per-user DB-backed source) ────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS user_commands (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      frontmatter JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, name)
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_user_commands_user_id ON user_commands(user_id)`);

  // ── user_commands UNIQUE(user_id, name) ────────────────────────────
  // See src/db/migrations/add-user-commands-unique-name.ts.
  //
  // The CREATE TABLE above carries the inline UNIQUE constraint for
  // fresh databases. For deployments whose table predates that
  // constraint, the pre-flight UPDATE renames every duplicate
  // (user_id, name) tuple to `${name}-2`, `${name}-3`, … (ROW_NUMBER
  // over created_at) so no row is dropped before the unique index is
  // added. Both statements are idempotent — re-running the migration
  // on a clean DB is a no-op (no duplicates → UPDATE matches 0 rows;
  // CREATE UNIQUE INDEX IF NOT EXISTS swallows the second invocation).
  await db.execute(sql`
    WITH dups AS (
      SELECT id, user_id, name,
             ROW_NUMBER() OVER (PARTITION BY user_id, name ORDER BY created_at, id) AS rn
      FROM user_commands
    )
    UPDATE user_commands uc
    SET name = uc.name || '-' || dups.rn::text
    FROM dups
    WHERE uc.id = dups.id AND dups.rn > 1
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_user_commands_user_name
      ON user_commands(user_id, name)
  `);

  // ── Phase 48: Ez Mode + Conversation Kind + Ez Drafts ─────────────
  //
  // Schema deltas + Ez mode seed + ez_drafts table + unique partial index
  // ensuring one ez-kind conversation per user. The builtin 'ez' mode is
  // seeded with `tool_restriction = 'allowlist'` and the Ez-tool
  // allowed_tools array; applyToolFilters() in src/runtime/tools/filter.ts
  // intersects against this list before the LLM ever sees the toolset.
  //
  // Idempotent: re-running leaves the existing 'ez' mode untouched
  // (ON CONFLICT slug DO NOTHING). The `kind` column defaults to 'regular'
  // so all existing conversations remain unaffected.
  await db.execute(sql`ALTER TABLE modes ADD COLUMN IF NOT EXISTS allowed_tools TEXT[]`);
  // Extensions attached to a mode. When non-empty the runtime expands the
  // union of these extensions' tool names into an effective allowlist;
  // when empty/null the existing tool_restriction + allowed_tools fallback
  // governs (see src/runtime/executor.ts). Idempotent.
  await db.execute(sql`ALTER TABLE modes ADD COLUMN IF NOT EXISTS extension_ids TEXT[]`);
  await db.execute(sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'regular'`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ez_drafts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
      consumed_at TIMESTAMP WITH TIME ZONE
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ez_drafts_user ON ez_drafts(user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ez_drafts_expires ON ez_drafts(expires_at)`);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS conversations_user_ez_unique
      ON conversations (user_id)
      WHERE kind = 'ez'
  `);
  // Seed Ez mode (allowlist, builtin). Persona = the shared EZ_PERSONA
  // (module-level); tuning it is a normal mode update, not a code change.
  // The bundled `extension-author__create_extension` tool is appended to
  // allowed_tools by step (9) below (not seeded here) so fresh + existing
  // installs converge through the same idempotent step.
  await db.execute(sql`
    INSERT INTO modes (
      id, slug, name, icon, description, system_prompt_instruction,
      instruction_position, tool_restriction, allowed_tools, builtin
    ) VALUES (
      'builtin-ez',
      'ez',
      'Ez',
      '🪄',
      'In-app concierge for managing your EZCorp setup.',
      ${EZ_PERSONA},
      'replace',
      'allowlist',
      ARRAY[${sql.raw(EZ_SEED_ALLOWED_TOOLS.map((t) => `'${t}'`).join(", "))}],
      TRUE
    ) ON CONFLICT (slug) DO NOTHING
  `);

  // ── Tool-call analytics dimensions ────────────────────────────────
  // Denormalize user/agent/model/provider onto tool_calls so admin analytics
  // can aggregate per-tool × per-dimension without three-way joins. Values
  // are already in scope at both write sites (executor.ts, tool-executor.ts);
  // populating at insert time is free. Existing rows are backfilled by
  // joining through conversations + messages.
  await db.execute(sql`ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE SET NULL`);
  await db.execute(sql`ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS agent_config_id TEXT REFERENCES agent_configs(id) ON DELETE SET NULL`);
  await db.execute(sql`ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS model TEXT`);
  await db.execute(sql`ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS provider TEXT`);
  // Plain created_at index — the leading column every analytics query filters on.
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_tool_calls_created_at ON tool_calls(created_at)`);
  // Drop the leading-tool_name composite if a prior install created it:
  // it's unreachable by the by-tool query (no tool_name predicate) and is
  // superseded by idx_tool_calls_created_at for every other query.
  await db.execute(sql`DROP INDEX IF EXISTS idx_tool_calls_tool_created`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_tool_calls_user_created ON tool_calls(user_id, created_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_tool_calls_agent_created ON tool_calls(agent_config_id, created_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_tool_calls_model_created ON tool_calls(model, created_at)`);
  // One-shot backfill. Only touches rows where at least one new dim is
  // still NULL — re-runs are cheap no-ops once the columns are populated.
  // Implementation note: Postgres forbids referencing the UPDATE target
  // table from a join inside the FROM clause, so we pre-join in a
  // subquery keyed by tool_calls.id and then update by equijoin on that
  // key.
  await db.execute(sql`
    UPDATE tool_calls SET
      user_id         = COALESCE(tool_calls.user_id,         src.conv_user_id),
      agent_config_id = COALESCE(tool_calls.agent_config_id, src.conv_agent_id),
      model           = COALESCE(tool_calls.model,           src.msg_model,    src.conv_model),
      provider        = COALESCE(tool_calls.provider,        src.msg_provider, src.conv_provider)
    FROM (
      SELECT tc.id AS tc_id,
             c.user_id        AS conv_user_id,
             c.agent_config_id AS conv_agent_id,
             c.model           AS conv_model,
             c.provider        AS conv_provider,
             m.model           AS msg_model,
             m.provider        AS msg_provider
      FROM tool_calls tc
      JOIN conversations c ON c.id = tc.conversation_id
      LEFT JOIN messages m ON m.id = tc.message_id
      WHERE tc.user_id IS NULL
         OR tc.agent_config_id IS NULL
         OR tc.model IS NULL
         OR tc.provider IS NULL
    ) src
    WHERE tool_calls.id = src.tc_id
  `);

  // ── Feature Index (per-project) ───────────────────────────────────
  // See src/db/migrations/add-feature-index.ts for the rationale.
  // Tables drive the `$[feature:name]` mention sigil and the per-project
  // settings page. `source` columns are load-bearing: user edits + pins
  // survive rescans (enforced in src/db/queries/features.ts).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS features (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'user',
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      UNIQUE(project_id, name)
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_features_project ON features(project_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS feature_files (
      feature_id TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
      relpath TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'scan',
      added_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      PRIMARY KEY (feature_id, relpath)
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_feature_files_feature ON feature_files(feature_id)`);

  // origin_path: directory the scanner derived the feature from. Lets
  // a rescan re-link a user-renamed feature to its source dir instead
  // of creating a fresh duplicate. Nullable: legacy rows + hand-created
  // user features have no scanner origin.
  await db.execute(sql`ALTER TABLE features ADD COLUMN IF NOT EXISTS origin_path TEXT`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_features_origin_path ON features(project_id, origin_path)`);

  // ── Extension Settings (per-user) ────────────────────────────────
  // Backs the manifest `settings` schema. resolveExtensionSettings()
  // merges declared-defaults < user at read time. Values are clamped
  // against the manifest schema before persist (see queries/extension-settings.ts).
  await db.execute(sql`DROP TABLE IF EXISTS extension_settings_global`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS extension_settings_user (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      extension_id TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
      values JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, extension_id)
    )
  `);

  // ── Feature Surface Coverage Audit ─────────────────────────────
  // Cache of per-feature classifications against the three surfaces
  // (SDK / EzButton / MCP). Composite PK (feature_id, content_hash)
  // means re-running the audit on an unchanged feature is a pure
  // cache hit. See src/runtime/audit/ for the orchestrator.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS feature_classifications (
      feature_id TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
      content_hash TEXT NOT NULL,
      surfaces JSONB NOT NULL,
      rationale TEXT NOT NULL DEFAULT '',
      classified_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      PRIMARY KEY (feature_id, content_hash)
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_feature_classifications_feature ON feature_classifications(feature_id)`);

  // ── Lessons-Keeper v1 (per-user-per-project + promotion ladder) ───
  // See src/db/migrations/add-lessons.ts for the rationale.
  // Drives the `%[lesson:slug]` mention sigil. Slug uniqueness is
  // visibility-scoped via partial unique indexes (PGlite supports the
  // `WHERE` clause on CREATE UNIQUE INDEX).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS lessons (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      visibility TEXT NOT NULL DEFAULT 'user',
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      frontmatter JSONB,
      source TEXT NOT NULL DEFAULT 'distiller',
      source_sha256 TEXT,
      fired_count INTEGER NOT NULL DEFAULT 0,
      last_fired_at TIMESTAMP WITH TIME ZONE,
      dismissed_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_lessons_project_owner ON lessons(project_id, owner_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_lessons_visibility ON lessons(project_id, visibility)`);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lessons_user_slug_unique
      ON lessons(project_id, owner_id, slug)
      WHERE visibility = 'user'
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lessons_shared_slug_unique
      ON lessons(project_id, slug)
      WHERE visibility IN ('project', 'global')
  `);

  // ── Phase 50: Audit foundation ─────────────────────────────────────
  // See src/db/migrations/add-sdk-capability-audit.ts for rationale.
  // Lands `sdk_capability_calls` (high-volume per-call SDK audit),
  // `lessons_audit_log` (mirrors memory_audit_log shape), and the
  // `lessons.author_extension_id` column (so Phase 51 ctx.lessons
  // doesn't need a follow-up migration). All idempotent (CREATE IF
  // NOT EXISTS, ADD COLUMN IF NOT EXISTS).

  // sdk_capability_calls — see schema.ts `sdkCapabilityCalls`
  //
  // FK note: `on_behalf_of` is NOT NULL with ON DELETE RESTRICT.
  // The defensive ALTER below upgrades any dev databases created with
  // the previous (inconsistent) ON DELETE SET NULL spec; fresh installs
  // land with RESTRICT directly.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS sdk_capability_calls (
      id TEXT PRIMARY KEY,
      extension_id TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
      on_behalf_of TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      parent_call_id TEXT,
      capability TEXT NOT NULL,
      action TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      before JSONB,
      after JSONB,
      success BOOLEAN NOT NULL,
      duration_ms INTEGER NOT NULL,
      error_code TEXT,
      error_message TEXT,
      tokens_used INTEGER,
      cost_usd REAL,
      provider TEXT,
      model TEXT,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_sdk_cap_ext_created ON sdk_capability_calls(extension_id, created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_sdk_cap_conv_created ON sdk_capability_calls(conversation_id, created_at DESC) WHERE conversation_id IS NOT NULL`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_sdk_cap_user_capability_created ON sdk_capability_calls(on_behalf_of, capability, created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_sdk_cap_created ON sdk_capability_calls(created_at DESC)`);

  // Defensive FK upgrade for sdk_capability_calls.on_behalf_of
  // (validator CR-2): the previous spec declared ON DELETE SET NULL,
  // which is internally inconsistent with the NOT NULL column
  // constraint — user-delete would FK-violate. Move to ON DELETE
  // RESTRICT (audit-trail semantic — admin must scrub PII separately).
  // Idempotent: drops the constraint by its Postgres-default name then
  // re-adds. Fresh installs already created the constraint with
  // RESTRICT via the CREATE TABLE above; this ALTER is then a no-op
  // ADD on top of a DROP (the CREATE TABLE constraint will already be
  // dropped here, so we re-add it under the same name).
  await db.execute(sql`
    ALTER TABLE sdk_capability_calls
      DROP CONSTRAINT IF EXISTS sdk_capability_calls_on_behalf_of_fkey
  `);
  await db.execute(sql`
    ALTER TABLE sdk_capability_calls
      ADD CONSTRAINT sdk_capability_calls_on_behalf_of_fkey
      FOREIGN KEY (on_behalf_of) REFERENCES users(id) ON DELETE RESTRICT
  `);

  // lessons_audit_log — mirrors memory_audit_log shape
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS lessons_audit_log (
      id SERIAL PRIMARY KEY,
      lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      previous_body TEXT,
      new_body TEXT,
      previous_frontmatter JSONB,
      new_frontmatter JSONB,
      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      actor_extension_id TEXT REFERENCES extensions(id) ON DELETE SET NULL,
      reason TEXT,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_lessons_audit_lesson_created ON lessons_audit_log(lesson_id, created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_lessons_audit_actor_ext_created ON lessons_audit_log(actor_extension_id, created_at DESC)`);

  // lessons.author_extension_id — additive column, idempotent
  await db.execute(sql`
    ALTER TABLE lessons
      ADD COLUMN IF NOT EXISTS author_extension_id TEXT REFERENCES extensions(id) ON DELETE SET NULL
  `);

  // ── Phase 51: SDK capability surfaces ──────────────────────────────
  // (1) memories.injection_eligible — extension-authored memories will
  //     set this `false`; legacy rows backfill `true` so today's
  //     auto-inject behavior is preserved exactly.
  await db.execute(sql`
    ALTER TABLE memories
      ADD COLUMN IF NOT EXISTS injection_eligible BOOLEAN NOT NULL DEFAULT TRUE
  `);

  // (2) extension_llm_usage — per-extension daily call/token rollup.
  //     60s flush from in-process `LlmQuota`; PK on (extension_id, day).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS extension_llm_usage (
      extension_id TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      PRIMARY KEY (extension_id, day)
    )
  `);
  // `output_tokens` now records TOTAL tokens (input + output) counted
  // toward `maxTokensPerDay`; `cost_cents` enforces `maxCostCentsPerDay`.
  await db.execute(sql`ALTER TABLE extension_llm_usage ADD COLUMN IF NOT EXISTS cost_cents INTEGER NOT NULL DEFAULT 0`);

  // (3) extension_memory_writes_daily — same shape, memory-write quota.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS extension_memory_writes_daily (
      extension_id TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      writes INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      PRIMARY KEY (extension_id, day)
    )
  `);

  // (4) extension_lessons_writes_daily — same shape, lesson-write quota.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS extension_lessons_writes_daily (
      extension_id TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      writes INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      PRIMARY KEY (extension_id, day)
    )
  `);

  // (4b) extension_search_calls_daily — same shape, search-call quota
  //      (shared-search Phase 2). Enforces `resolveSearchPolicy().quota`.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS extension_search_calls_daily (
      extension_id TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      PRIMARY KEY (extension_id, day)
    )
  `);

  // (5) extension_schedules — persistent cron registrations + state.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS extension_schedules (
      id TEXT PRIMARY KEY,
      extension_id TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
      cron TEXT NOT NULL,
      next_fire_at TIMESTAMP WITH TIME ZONE NOT NULL,
      last_fire_at TIMESTAMP WITH TIME ZONE,
      last_fire_status TEXT,
      last_fire_id TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      consecutive_errors INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_ext_schedule ON extension_schedules(extension_id, cron)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_schedule_ready ON extension_schedules(enabled, next_fire_at) WHERE enabled = TRUE`);

  // (6) extension_schedule_fires — per-fire history.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS extension_schedule_fires (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL REFERENCES extension_schedules(id) ON DELETE CASCADE,
      scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
      fired_at TIMESTAMP WITH TIME ZONE NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      duration_ms INTEGER,
      error TEXT,
      catch_up BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_schedule_fires_pending ON extension_schedule_fires(status, scheduled_at)`);

  // (7) Composite slug uniqueness for lessons. Replace the legacy
  //     partial indexes on (project_id, owner_id, slug) and
  //     (project_id, slug) with versions that include
  //     `COALESCE(author_extension_id, '')` so two extensions can
  //     each own a `code-review-best-practices` slug for the same
  //     user without collision. Drop legacy first (idempotent).
  await db.execute(sql`DROP INDEX IF EXISTS idx_lessons_user_slug_unique`);
  await db.execute(sql`DROP INDEX IF EXISTS idx_lessons_shared_slug_unique`);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lessons_user_slug_unique
    ON lessons (project_id, owner_id, COALESCE(author_extension_id, ''), slug)
    WHERE visibility = 'user'
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lessons_shared_slug_unique
    ON lessons (project_id, COALESCE(author_extension_id, ''), slug, visibility)
    WHERE visibility IN ('project', 'global')
  `);

  // (8) v1.3 release-readiness security review HIGH 2 —
  //     `installed_permissions` captures the install-time NARROWED choice
  //     so the reapprove handler can clamp against the user's actual
  //     consent, not the full manifest. Nullable: legacy rows fall back to
  //     manifest-clamp (pre-fix behavior). Backfill is intentionally NOT
  //     done from `granted_permissions` — that snapshot may already have
  //     been narrowed by the expiry sweep, and locking it in would freeze
  //     a transient state. See `tasks/v1.3-security-review.md` HIGH 2.
  await db.execute(sql`
    ALTER TABLE extensions
    ADD COLUMN IF NOT EXISTS installed_permissions JSONB
  `);

  // (9) extension-author bundled extension — ensure Ez mode's
  //     `allowed_tools` references the bundled `create_extension` tool so
  //     the in-app LLM can scaffold new extensions on user request.
  //
  //     The runtime registers extension tools NAMESPACED as
  //     `<ext-name>__<tool>` (double underscore — the Anthropic tool-name
  //     regex `^[a-zA-Z0-9_-]+$` forbids '/' and '.'; see
  //     web/src/lib/server/scoped-tools.ts). A prior migration seeded the
  //     WRONG separator (`extension-author/create_extension`), which never
  //     matched the runtime name, so the tool was neither listed in the
  //     allowlist nor callable. Fix it here:
  //
  //       (9a) array_replace any stale slash-form entry with the correct
  //            `__` form (no-op once already correct);
  //       (9b) array_append the correct form when still missing (fresh
  //            installs whose seed predates this tool, and rows just fixed
  //            by 9a already have it).
  //
  //     Run 9a BEFORE 9b so a row fixed by 9a is not then re-appended into
  //     a duplicate. Both are idempotent — re-running the migration is a
  //     no-op. The tool comes from the bundled extension at
  //     `docs/extensions/examples/extension-author/`.
  await db.execute(sql`
    UPDATE modes
    SET allowed_tools = array_replace(allowed_tools, 'extension-author/create_extension', 'extension-author__create_extension')
    WHERE slug = 'ez'
      AND 'extension-author/create_extension' = ANY(allowed_tools)
  `);
  await db.execute(sql`
    UPDATE modes
    SET allowed_tools = array_append(allowed_tools, 'extension-author__create_extension')
    WHERE slug = 'ez'
      AND NOT ('extension-author__create_extension' = ANY(allowed_tools))
  `);

  // (9c) read_page Ez concierge tool (on-demand page context restore).
  //      Fresh installs get it from the seed array above; this appends it
  //      to EXISTING Ez rows whose seed predates the tool. Idempotent.
  await db.execute(sql`
    UPDATE modes
    SET allowed_tools = array_append(allowed_tools, 'read_page')
    WHERE slug = 'ez'
      AND NOT ('read_page' = ANY(allowed_tools))
  `);

  // (9d) Ez persona refresh. The original seeded persona told the model it
  //      "CANNOT see their open page" — false now that read_page /
  //      fill_form / navigate_to restore on-demand page context.
  //      Surgically replace ONLY a stale BUILTIN persona (LIKE-matched on
  //      the retired phrase) so an admin-tuned persona is left untouched.
  //      Fresh installs already seed EZ_PERSONA (which lacks the phrase),
  //      so the predicate never matches them — no double-apply.
  await db.execute(sql`
    UPDATE modes
    SET system_prompt_instruction = ${EZ_PERSONA}
    WHERE slug = 'ez'
      AND builtin = TRUE
      AND system_prompt_instruction LIKE '%You CANNOT see their open page%'
  `);

  // (9e) search_conversation Ez concierge tool (cross-conversation keyword
  //      search). Fresh installs get it from the seed array above; this
  //      appends it to EXISTING Ez rows whose seed predates the tool.
  //      Idempotent — the guard makes a re-run a no-op. Plain SQL literal +
  //      `= ANY(...)` (never a bound JS array — a `${jsArray}` bind against
  //      a TEXT[] column serializes as a record, not an array element).
  await db.execute(sql`
    UPDATE modes
    SET allowed_tools = array_append(allowed_tools, 'search_conversation')
    WHERE slug = 'ez'
      AND NOT ('search_conversation' = ANY(allowed_tools))
  `);

  // (9f) Ez persona refresh — page-first answering. The prior persona only
  //      triggered read_page on literal "this page"/"here"/on-screen-form
  //      phrasing, so follow-up questions about visible content were answered
  //      from stale in-context summary. The new persona reads the page before
  //      answering ANY question about visible content and escalates to
  //      summarize_conversation (with a question) / search_conversation when
  //      the read_page excerpt is truncated. LIKE-matched on the retired
  //      page-context sentence (present in the CURRENT persona, dropped by the
  //      new one) so admin-tuned personas are left untouched. Runs AFTER 9d so
  //      an oldest install chains old→new via 9d, and a current install
  //      current→new here, in one migrate run. Fresh installs seed the new
  //      persona (no anchor phrase), so the predicate never re-matches — no
  //      double-apply, idempotent.
  await db.execute(sql`
    UPDATE modes
    SET system_prompt_instruction = ${EZ_PERSONA}
    WHERE slug = 'ez'
      AND builtin = TRUE
      AND system_prompt_instruction LIKE '%call read_page to get its content (route, headings, forms, and fields)%'
  `);

  // (10) UX-02 (Phase 57-04) — pg_trgm + GIN indexes for marketplace
  //      trigram + FTS search. The pg_trgm contrib module is registered
  //      at PGlite construction in src/db/connection.ts (and the test
  //      helper at src/__tests__/helpers/test-pglite.ts); the SQL
  //      `CREATE EXTENSION` below then registers the catalog entry. On
  //      external Postgres the CREATE EXTENSION call loads the C
  //      functions natively. Both indexes are GIN over
  //      `(name || ' ' || description)` so the hybrid trigram + FTS
  //      query can use either operator (% / @@) without re-tokenising.
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_marketplace_listings_trgm
      ON marketplace_listings
      USING GIN ((name || ' ' || description) gin_trgm_ops)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_marketplace_listings_fts
      ON marketplace_listings
      USING GIN (to_tsvector('english', name || ' ' || description))
  `);

  // ── Secure User-Site Preview / Port Exposure (Phase 1) ────────────
  // The preview registry. One row per exposed site. `id` is BOTH the
  // primary key AND the `*.preview.<host>` subdomain label — a 26-char
  // Crockford base32 string from 128 bits CSPRNG entropy (unguessable,
  // no enumeration). FKs ON DELETE SET NULL so a deleted user /
  // conversation orphans the row for audit while the proxy's
  // userId-match access check fails closed. Indexed by user_id (the
  // revocation UI) + conversation_id (reaping on conversation close).
  // See tasks/preview-port-exposure.md §3.4. Idempotent (CREATE IF NOT
  // EXISTS); columns cover both the static (`static_path`) and dynamic
  // (`target_port`, Phase 3) branches without a CHECK constraint.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS preview_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      netns_id TEXT,
      kind TEXT NOT NULL,
      target_port INTEGER,
      static_path TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
      last_seen_at TIMESTAMP WITH TIME ZONE,
      revoked_at TIMESTAMP WITH TIME ZONE
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_preview_sessions_user ON preview_sessions(user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_preview_sessions_conversation ON preview_sessions(conversation_id)`);

  // Per-extension tool subset for modes. Keyed by extension id → selected tool
  // names. An extension attached via extension_ids but absent here (or mapped
  // to an empty array) contributes ALL its tools; a non-empty array narrows
  // the contribution. NULL for existing rows preserves prior all-tools
  // behaviour (see src/runtime/executor.ts). Idempotent.
  await db.execute(sql`ALTER TABLE modes ADD COLUMN IF NOT EXISTS extension_tools JSONB`);

  // Per-extension tool subset for agent configs (mirrors modes.extension_tools).
  // Keyed by extension id → selected tool names; an attached extension absent
  // here (or mapped to []) contributes ALL its tools at agent execution time.
  // NULL for existing rows preserves prior all-tools behaviour. Idempotent.
  await db.execute(sql`ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS extension_tools JSONB`);

  // Per-conversation tool scoping (mirrors modes / agent_configs
  // extension_tools). Keyed by extension id → selected tool names. This map
  // can only NARROW the active mode's allowlist at execution time, never widen
  // it (see src/runtime/executor.ts). NULL for existing rows preserves prior
  // behaviour (no narrowing). Idempotent.
  await db.execute(sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS extension_tools JSONB`);

  // ── Daily Briefing (Phase 1) — per-user briefing config ──────────
  // One row per user (PK = user_id). `next_fire_at` is the BriefingDaemon's
  // claim target (SELECT … FOR UPDATE SKIP LOCKED → advance → dispatch,
  // at-most-once like extension_schedules). `consecutive_errors`
  // auto-disables at 5. `watchlist` is stored from Phase 1 but consumed by
  // the pipeline only in Phase 3. See src/db/migrations/add-briefing-configs.ts
  // and tasks/daily-briefing.md §4.1. Idempotent.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS briefing_configs (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      cron TEXT NOT NULL DEFAULT '0 7 * * *',
      timezone TEXT NOT NULL DEFAULT 'UTC',
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      instructions TEXT NOT NULL DEFAULT '',
      watchlist JSONB NOT NULL DEFAULT '[]',
      model TEXT,
      provider TEXT,
      last_fire_at TIMESTAMP WITH TIME ZONE,
      last_fire_status TEXT,
      consecutive_errors INTEGER NOT NULL DEFAULT 0,
      next_fire_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_briefing_ready ON briefing_configs(enabled, next_fire_at)`);

  // ── Extension secrets (scope-isolated, AEAD-bound credential store) ──
  // See src/db/migrations/add-extension-secrets.ts for the rationale.
  // `extension_id` stores the stable manifest SLUG (FK to extensions.name),
  // NOT the UUID extensions.id. The ciphertext is AES-256-GCM with the
  // `extensionId:projectId` scope bound as AAD, so a row copied to another
  // scope fails to decrypt (see src/extensions/secrets-store.ts). Placed
  // after extensions / projects / users so all three FK targets exist.
  // Idempotent. The COALESCE-unique scope index treats NULL project/user as
  // a single value (a plain UNIQUE would let every NULL collide-free) — so
  // the query layer uses select-then-write, not ON CONFLICT.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS extension_secrets (
      id TEXT PRIMARY KEY,
      extension_id TEXT NOT NULL REFERENCES extensions(name) ON DELETE CASCADE,
      project_id   TEXT REFERENCES projects(id) ON DELETE CASCADE,
      user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      ciphertext   TEXT NOT NULL,
      created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMP WITH TIME ZONE,
      rotated_at   TIMESTAMP WITH TIME ZONE
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_extension_secrets_scope ON extension_secrets (extension_id, COALESCE(project_id,''), COALESCE(user_id,''), name)`);

  // ── Extension RBAC grants (per-user, per-project/per-extension scopes) ──
  // See src/db/migrations/add-extension-rbac.ts for the rationale. Governs
  // what a USER may do with an extension (use/configure/secrets/approve-runs/
  // manage + custom scopes) — complementary to the PDP, which governs what
  // the EXTENSION may do. NULL project_id/extension_id = all projects/all
  // extensions. `extension_id` stores the stable manifest SLUG (FK to
  // extensions.name), NOT the UUID extensions.id. Placed after users /
  // projects / extensions so all FK targets exist. Idempotent. The
  // COALESCE-unique scope index treats NULL project/extension as a single
  // value (a plain UNIQUE would let every NULL collide-free) — so the query
  // layer uses select-then-write, not ON CONFLICT.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS extension_rbac_grants (
      id TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id   TEXT REFERENCES projects(id) ON DELETE CASCADE,
      extension_id TEXT REFERENCES extensions(name) ON DELETE CASCADE,
      scopes JSONB NOT NULL,
      granted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_extension_rbac_grants_scope ON extension_rbac_grants (user_id, COALESCE(project_id,''), COALESCE(extension_id,''))`);

  // ── GitHub Projects integration (per-project board link + proposal queue) ──
  // See src/db/migrations/add-github-projects.ts for the rationale.
  // `github_projects_links` — an EZCorp project connects to MANY boards (one row
  // per board); a given board connects to a project only once
  // (UNIQUE(project_id, board_node_id)). The PAT (when auth_mode='pat') lives
  // ENCRYPTED in the `extension_secrets` store at `apiToken` (the SHARED project
  // token) and optionally `apiToken:<linkId>` (a per-board override), never in a
  // column. `enabled=false` is the user-facing "pause polling" state (board +
  // token retained; the daemon skips disabled links). Idempotent. The board
  // uniqueness is declared as a named index below (NOT inline) so an already-
  // migrated DB carrying the legacy single-board UNIQUE(project_id) can be
  // migrated to the multi-board constraint.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS github_projects_links (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      board_node_id TEXT NOT NULL,
      board_url TEXT NOT NULL,
      board_title TEXT NOT NULL DEFAULT '',
      owner_login TEXT NOT NULL DEFAULT '',
      status_field_id TEXT,
      status_options JSONB NOT NULL DEFAULT '[]',
      auth_mode TEXT NOT NULL DEFAULT 'pat',
      column_action_map JSONB NOT NULL DEFAULT '{}',
      poll_cursor JSONB,
      poll_interval_sec INTEGER NOT NULL DEFAULT 60,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      last_polled_at TIMESTAMP WITH TIME ZONE,
      last_error TEXT,
      last_error_at TIMESTAMP WITH TIME ZONE,
      created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  // Back-compat: CREATE TABLE IF NOT EXISTS skips new columns on already-migrated
  // DBs, so add status_options to pre-existing link rows. Stores the board's
  // Status-field columns (id+name) so the mapping editor renders named, complete
  // columns after a reload — not just the saved map's bare option-id keys.
  await db.execute(
    sql`ALTER TABLE github_projects_links ADD COLUMN IF NOT EXISTS status_options JSONB NOT NULL DEFAULT '[]'`,
  );

  // Per-board default model for spawned runs ("<provider>:<model>"). Nullable —
  // null/empty keeps the instance default. Added here so pre-existing link rows
  // (created before this column) gain it without a table rebuild.
  await db.execute(
    sql`ALTER TABLE github_projects_links ADD COLUMN IF NOT EXISTS default_model TEXT`,
  );

  // Per-board default permission mode for spawned runs (runtime PermissionMode:
  // "ask" | "auto-edit" | "yolo"). Nullable — null/invalid falls back to "yolo"
  // in the spawn bridge. Added here so pre-existing link rows gain it without a
  // table rebuild.
  await db.execute(
    sql`ALTER TABLE github_projects_links ADD COLUMN IF NOT EXISTS default_permission_mode TEXT`,
  );

  // Multi-board migration (idempotent, PGlite-safe): a project connects to many
  // boards, so drop the legacy single-board uniqueness — both forms it can take:
  //   - the inline `UNIQUE(project_id)` from the old CREATE TABLE → a constraint
  //     named `github_projects_links_project_id_key`,
  //   - the older standalone `idx_gh_links_project_unique` index.
  // Then create the (project_id, board_node_id) uniqueness. `IF EXISTS` /
  // `IF NOT EXISTS` keep every statement a no-op on a DB already in either state.
  await db.execute(
    sql`ALTER TABLE github_projects_links DROP CONSTRAINT IF EXISTS github_projects_links_project_id_key`,
  );
  await db.execute(sql`DROP INDEX IF EXISTS idx_gh_links_project_unique`);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_gh_links_project_board ON github_projects_links (project_id, board_node_id)`,
  );

  // `github_projects_proposals` — the queue + concurrency unit. `dedupe_key`
  // (server-derived `${projectId}:${itemNodeId}:${statusOptionId}:${action}`)
  // is stamped on every row for PROVENANCE only — its legacy once-ever UNIQUE
  // index is replaced by the partial single-active-per-card index below, so a
  // card can re-trigger after its previous run reaches a terminal status.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS github_projects_proposals (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      link_id TEXT NOT NULL REFERENCES github_projects_links(id) ON DELETE CASCADE,
      item_node_id TEXT NOT NULL,
      content_node_id TEXT,
      status_option_id TEXT NOT NULL,
      status_name TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      ticket_url TEXT,
      dedupe_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      agent_run_id TEXT,
      proposed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      decided_at TIMESTAMP WITH TIME ZONE,
      decided_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      finished_at TIMESTAMP WITH TIME ZONE,
      error TEXT,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  // Re-trigger migration (idempotent): the legacy UNIQUE(dedupe_key) index
  // made a (card, column, action) trigger once-EVER — a card whose run
  // finished could never re-trigger on column re-entry. Replace it with a
  // PARTIAL unique index scoped to ACTIVE statuses: a card
  // (link_id, item_node_id) holds at most ONE in-flight proposal across ALL
  // columns (covers cross-column moves mid-run), while terminal rows
  // (done/failed/dismissed/cancelled) free the card so re-entry re-triggers.
  // `dedupe_key` stays as a plain provenance column. insertProposalIfNew's
  // ON CONFLICT arbiter must match this predicate EXACTLY
  // (src/db/queries/github-projects.ts).
  await db.execute(sql`DROP INDEX IF EXISTS idx_gh_proposals_dedupe`);
  // Boot-safe guard for legacy rows: under the old per-column dedupe key a
  // card could legitimately hold TWO active proposals (one per column), which
  // would make the CREATE UNIQUE INDEX below fail and abort boot. Keep the
  // newest active proposal per card and cancel the rest — idempotent (matches
  // zero rows once the partial index exists and enforces ≤1).
  await db.execute(sql`
    UPDATE github_projects_proposals SET status = 'cancelled', finished_at = NOW()
    WHERE status IN ('pending','approved','spawned','running')
      AND id NOT IN (
        SELECT DISTINCT ON (link_id, item_node_id) id
        FROM github_projects_proposals
        WHERE status IN ('pending','approved','spawned','running')
        ORDER BY link_id, item_node_id, proposed_at DESC, id DESC
      )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gh_proposals_active_item
      ON github_projects_proposals(link_id, item_node_id)
      WHERE status IN ('pending','approved','spawned','running')
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_gh_proposals_project_status ON github_projects_proposals(project_id, status)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_gh_proposals_link ON github_projects_proposals(link_id)`);

  // ── Composer suggestions: telemetry table ─────────────────────────
  // See src/db/migrations/add-suggestion-feedback.ts for the rationale.
  // Content-free impression/acceptance events (kind/action/tool name/
  // latency — never draft text). user_id CASCADE: deleting a user takes
  // their telemetry with them.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS suggestion_feedback (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      action TEXT NOT NULL,
      tool_name TEXT,
      latency_ms INTEGER,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_suggestion_feedback_created ON suggestion_feedback(created_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_suggestion_feedback_kind_action ON suggestion_feedback(kind, action, created_at)`);

  // ── Topic Contexts v1 ─────────────────────────────────────────────
  // See src/db/migrations/add-topic-contexts.ts for the full rationale.
  // Backs the "click a topic pill → extract that topic's context → copy +
  // store it searchable" feature. The classification enum lives in the DB
  // (`context_types`) and every detection call reads the LIVE rows to
  // constrain the model's output — no near-duplicate enum proliferation.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS context_types (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      description TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'seed',
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  // Open type taxonomy: `source` distinguishes the 10 seeded types from
  // LLM-proposed `auto` types; `created_at` orders autos after seeds. Additive
  // ADD COLUMN IF NOT EXISTS upgrades DBs created before this change.
  await db.execute(sql`ALTER TABLE context_types ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'seed'`);
  await db.execute(sql`ALTER TABLE context_types ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()`);
  // Seed the 10 canonical types. ON CONFLICT DO NOTHING so a re-run (or an
  // operator who tuned a description) is never clobbered. Keep this data
  // identical to CONTEXT_TYPE_SEED in add-topic-contexts.ts.
  //
  // The VALUES list is kept on ONE line deliberately: a multi-line INSERT makes
  // Bun's coverage instrumenter mark each wrapped VALUES row as an uncovered
  // "statement" (they carry no runtime code of their own), which drops this
  // migration below the patch-coverage bar even though the seed runs on every
  // migrate(). A single-line statement instruments as one line — hit here, the
  // same shape as the CREATE INDEX statements above.
  await db.execute(sql`INSERT INTO context_types (id, label, description, sort_order) VALUES ('feature', 'Feature', 'A capability or piece of functionality to build, or one that already exists.', 1), ('idea', 'Idea', 'A proposal, suggestion, or brainstormed concept that has not been decided yet.', 2), ('decision', 'Decision', 'A choice that was made, together with the reasoning behind it.', 3), ('bug-fix', 'Bug Fix', 'A defect and how it was, or should be, resolved.', 4), ('requirement', 'Requirement', 'A constraint or condition the solution must satisfy.', 5), ('how-to', 'How-To', 'Step-by-step instructions or a procedure for accomplishing something.', 6), ('code-snippet', 'Code Snippet', 'A concrete block of code, configuration, or command.', 7), ('fact', 'Fact', 'A piece of reference information or an established truth worth remembering.', 8), ('question', 'Question', 'An open question or unresolved inquiry raised in the conversation.', 9), ('plan', 'Plan', 'A sequence of steps or a strategy toward a goal.', 10) ON CONFLICT (id) DO NOTHING`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS conversation_topics (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      type_id TEXT NOT NULL REFERENCES context_types(id) ON DELETE RESTRICT,
      message_ids JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_conversation_topics_conversation ON conversation_topics(conversation_id)`);
  // Case-insensitive label uniqueness per conversation — migration-only
  // (drizzle has no portable functional-index helper; mirrors the lessons
  // partial-unique pattern). Keeps re-detection from spawning duplicate
  // pills for the same label under different casing.
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_topics_conv_label_unique
      ON conversation_topics(conversation_id, lower(label))
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS conversation_topic_state (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      last_message_id TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      analyzed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS saved_contexts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      topic_label TEXT NOT NULL,
      type_id TEXT NOT NULL REFERENCES context_types(id) ON DELETE RESTRICT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      model TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_saved_contexts_user_created ON saved_contexts(user_id, created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_saved_contexts_project ON saved_contexts(project_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_saved_contexts_type ON saved_contexts(type_id)`);
  // Re-extract upserts (latest snapshot wins). All three columns are
  // non-null at insert time (extract always runs on a real conversation),
  // so a plain composite UNIQUE is a valid ON CONFLICT arbiter.
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_contexts_unique
      ON saved_contexts(user_id, conversation_id, topic_label)
  `);

  // One-shot, idempotent backfill: move any pre-existing github-projects PATs
  // out of the broadly-readable `settings` table into the scope-isolated,
  // AEAD-bound extension_secrets store. Runs LAST (every FK target exists by
  // now) and takes the migrate `db` handle directly — getDb() is not
  // guaranteed wired during the migrate pass, so the backfill must use the
  // passed executor for all its SQL. A second run finds no matching keys and
  // is a no-op.
  await backfillGithubProjectsApiTokens(db);
}
