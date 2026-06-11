import { sql } from "drizzle-orm";

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

  // ── Phase 6: Agent Personas ─────────────────────────────────────
  await db.execute(sql`ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS category TEXT`);
  await db.execute(sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS agent_config_id TEXT REFERENCES agent_configs(id) ON DELETE SET NULL`);

  // Seed global project (used for agent conversations not tied to a specific project)
  await db.execute(sql`
    INSERT INTO projects (id, name, path)
    VALUES ('global', 'Global', '/')
    ON CONFLICT (id) DO NOTHING
  `);

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
  // seeded with `tool_restriction = 'allowlist'` and the seven-tool
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
  // Seed Ez mode (allowlist, builtin). Persona text matches Appendix A of
  // 48-DESIGN.md; tuning it is a normal mode update, not a code change.
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
      'You are EZ, the in-app concierge for EZCorp. You help users manage and operate their EZCorp setup — creating projects, building agents, installing extensions, and summarizing their conversations.

You are not a general-purpose assistant. If a user asks for help that isn''t about EZCorp itself (e.g., writing prose, debugging unrelated code), gently redirect them to start a regular project chat.

Always work in proposals: when the user asks for a mutation, call the relevant propose_* tool, which returns a card with a button that opens the prefilled form. The user reviews and submits. Never assume — confirm the inputs you generated.

You have limited awareness of what the user is currently looking at. You CANNOT see their open page, the conversation they have on screen, or the form they are filling. If a request needs a specific id or path (e.g. "summarize this conversation"), ask the user for it or look it up via an available tool — do not guess.

Be terse. The user is doing real work and you are a tool, not a friend.',
      'replace',
      'allowlist',
      ARRAY['propose_create_project', 'propose_create_agent', 'propose_install_extension', 'summarize_conversation', 'find_agents', 'fill_form', 'navigate_to'],
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

  // (9) extension-author bundled extension — append
  //     `extension-author/create_extension` to Ez mode's `allowed_tools`
  //     so the in-app LLM can scaffold new extensions on user request.
  //
  //     Idempotent: only inserts the tool when missing. Uses
  //     `array_append` + a uniqueness predicate so re-running the
  //     migration is a no-op. Does NOT edit the original seed; the
  //     seed runs (8) above for fresh installs and the array doesn't
  //     contain the new tool yet — this migration's `ALL`/`ANY`
  //     predicate adds it post-seed in lockstep.
  //
  //     The `extension-author/create_extension` tool itself comes from
  //     the bundled extension at
  //     `docs/extensions/examples/extension-author/`. The `<name>/<tool>`
  //     namespace shape mirrors how `tool-executor.ts` resolves
  //     extension-provided tools at runtime.
  await db.execute(sql`
    UPDATE modes
    SET allowed_tools = array_append(allowed_tools, 'extension-author/create_extension')
    WHERE slug = 'ez'
      AND NOT ('extension-author/create_extension' = ANY(allowed_tools))
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
}
