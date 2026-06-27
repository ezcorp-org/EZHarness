/**
 * GitHub Projects integration migration.
 *
 * Adds the per-project board link + the proposal queue that powers the
 * `github-projects` bundled extension (connect a GitHub Projects v2 board to an
 * EZCorp project; a card moving into a triggering column proposes — or, when a
 * column is opted in, auto-spawns — a harness run).
 *
 * Schema deltas (idempotent, additive — no destructive changes):
 *   - github_projects_links (id, project_id FK CASCADE, board_node_id,
 *     board_url, board_title, owner_login, status_field_id,
 *     auth_mode ∈ {'pat','gh'}, column_action_map jsonb, poll_cursor jsonb,
 *     poll_interval_sec, enabled, last_polled_at, last_error, last_error_at,
 *     created_by_user_id FK SET NULL, timestamps) with UNIQUE(project_id) —
 *     one connected board per project. `enabled=false` is the user-facing
 *     "pause polling" state (board + token retained).
 *   - github_projects_proposals (id, project_id FK CASCADE, link_id FK CASCADE,
 *     item_node_id, content_node_id, status_option_id, status_name, action,
 *     title, ticket_url, dedupe_key, status, conversation_id FK SET NULL,
 *     agent_run_id, proposed_at, decided_at, decided_by_user_id FK SET NULL,
 *     finished_at, error, created_at).
 *   - UNIQUE INDEX on github_projects_proposals(dedupe_key) — the server-derived
 *     hash of (project_id, item_node_id, status_option_id, action). This is the
 *     anti-double-spawn guarantee: poll re-detection / card churn upsert ON
 *     CONFLICT DO NOTHING and never create a second proposal for the same state.
 *   - Indexes on (project_id, status) and (link_id) for the Hub queries.
 *
 * Security invariants (enforced at the query/host layer, NOT the DB):
 *   - The GitHub PAT (auth_mode='pat') is stored ENCRYPTED in the `settings`
 *     table at `githubProjects:<projectId>:apiToken` — never in a column here,
 *     never in the plaintext .ezcorp/ extension-data dir.
 *   - projectId / board_node_id are always derived server-side; sandbox tool
 *     args never carry a board id (confused-deputy fix).
 *
 * This migration is applied automatically via src/db/migrate.ts. This file
 * exists for documentation and parallels add-feature-index.ts /
 * add-briefing-configs.ts.
 */
import { sql } from "drizzle-orm";

export async function up(db: any): Promise<void> {
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
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      UNIQUE(project_id)
    )
  `);
  // Additive back-compat for DBs created before status_options existed.
  await db.execute(
    sql`ALTER TABLE github_projects_links ADD COLUMN IF NOT EXISTS status_options JSONB NOT NULL DEFAULT '[]'`,
  );

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
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_gh_proposals_dedupe ON github_projects_proposals(dedupe_key)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS idx_gh_proposals_project_status ON github_projects_proposals(project_id, status)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS idx_gh_proposals_link ON github_projects_proposals(link_id)`,
  );
}
