import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Personal GitHub authority survives disconnect so stale callbacks cannot revive it. */
export async function up(db: MigrationDb): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS github_user_authorities (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS github_user_connections (
    user_id TEXT PRIMARY KEY REFERENCES github_user_authorities(user_id) ON DELETE CASCADE,
    connection_id TEXT NOT NULL UNIQUE,
    github_account_id BIGINT NOT NULL,
    github_login TEXT NOT NULL,
    app_id BIGINT NOT NULL,
    access_ciphertext TEXT NOT NULL,
    refresh_ciphertext TEXT NOT NULL,
    access_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    refresh_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    token_revision INTEGER NOT NULL DEFAULT 0 CHECK (token_revision >= 0),
    state TEXT NOT NULL DEFAULT 'connected' CHECK (state IN ('connected', 'reconnect_required')),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS github_user_oauth_attempts (
    state_digest TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES github_user_authorities(user_id) ON DELETE CASCADE,
    session_digest TEXT NOT NULL,
    expected_generation INTEGER NOT NULL,
    verifier_ciphertext TEXT NOT NULL,
    return_review_id TEXT,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    consumed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_github_user_oauth_user ON github_user_oauth_attempts(user_id, expires_at)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS github_user_effect_claims (
    operation_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES github_user_authorities(user_id) ON DELETE RESTRICT,
    connection_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    repository_id BIGINT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('import', 'publish')),
    state TEXT NOT NULL CHECK (state IN ('dispatched', 'unknown', 'completed')),
    dispatched_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_github_user_effect_user ON github_user_effect_claims(user_id, generation)`);
}
