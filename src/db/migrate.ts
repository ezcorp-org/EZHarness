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

  // ── Phase 2d: Conversation metadata (runtime-only flags) ────────
  // Nullable JSONB bag. Currently holds `spawnDepth` for the ezcorp/spawn-assignment
  // depth-limit enforcement; future phases may add UI / panel state.
  await db.execute(sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS metadata JSONB`);

  // ── Phase 40: Tool call cardType ──────────────────────────────
  await db.execute(sql`ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS card_type TEXT`);

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
      UNIQUE(extension_id, scope, scope_id, key)
    )
  `);
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
}
