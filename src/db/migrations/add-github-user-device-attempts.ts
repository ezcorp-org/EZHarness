import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Preserve OAuth provenance on upgraded installations and journal device polling. */
export async function up(db: MigrationDb): Promise<void> {
  await db.execute(sql`ALTER TABLE github_user_connections ADD COLUMN IF NOT EXISTS auth_flow TEXT NOT NULL DEFAULT 'oauth'`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS github_user_device_attempts (
    attempt_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES github_user_authorities(user_id) ON DELETE CASCADE,
    session_digest TEXT NOT NULL,
    expected_generation INTEGER NOT NULL,
    app_id BIGINT NOT NULL,
    client_id TEXT NOT NULL,
    device_ciphertext TEXT NOT NULL,
    return_review_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','connected','expired','denied','cancelled')),
    interval_seconds INTEGER NOT NULL CHECK (interval_seconds >= 1),
    next_poll_at TIMESTAMP WITH TIME ZONE NOT NULL,
    poll_claim_token TEXT,
    poll_claim_expires_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_github_user_device_user ON github_user_device_attempts(user_id, expires_at)`);
}
