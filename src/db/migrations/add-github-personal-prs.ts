import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Durable personal PR state. The host owns all identifiers and artifact bytes. */
export async function up(db: MigrationDb): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS github_personal_pr_imports (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      binding_id TEXT NOT NULL,
      workspace_revision INTEGER NOT NULL,
      provider_generation INTEGER NOT NULL,
      resource_id TEXT,
      repository_id BIGINT NOT NULL,
      repository_name TEXT NOT NULL,
      base_ref TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      base_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('importing','ready','failed','unknown')),
      operation_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL,
      artifact JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      UNIQUE (project_id)
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS github_personal_pr_imports_owner ON github_personal_pr_imports(owner_id, project_id)`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS github_personal_pr_snapshots (
      id TEXT PRIMARY KEY,
      import_id TEXT NOT NULL REFERENCES github_personal_pr_imports(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      binding_id TEXT NOT NULL,
      workspace_revision INTEGER NOT NULL,
      provider_generation INTEGER NOT NULL,
      resource_id TEXT NOT NULL,
      repository_id BIGINT NOT NULL,
      base_sha TEXT NOT NULL,
      tree_digest TEXT NOT NULL,
      artifact JSONB NOT NULL,
      checks JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (run_id)
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS github_personal_pr_snapshots_owner ON github_personal_pr_snapshots(owner_id, run_id)`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS github_personal_pr_proposals (
      id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL UNIQUE REFERENCES github_personal_pr_snapshots(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      github_account_id BIGINT NOT NULL,
      connection_generation INTEGER NOT NULL,
      repository_id BIGINT NOT NULL,
      base_sha TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('ready','reviewing','creating','created','stale','failed')),
      operation_id TEXT NOT NULL UNIQUE,
      branch TEXT NOT NULL UNIQUE,
      commit_sha TEXT,
      pr_url TEXT,
      failure_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      dispatched_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS github_personal_pr_proposals_owner ON github_personal_pr_proposals(owner_id, id)`);
}
