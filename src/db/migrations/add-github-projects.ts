/**
 * GitHub Projects integration migration.
 *
 * Adds the per-board project links + the proposal queue that power the
 * `github-projects` bundled extension (connect one or more GitHub Projects v2
 * boards to an EZCorp project; a card moving into a triggering column
 * proposes — or, when a column is opted in, auto-spawns — a harness run).
 *
 * Schema deltas (idempotent, additive — no destructive changes):
 *   - github_projects_links (id, project_id FK CASCADE, board_node_id,
 *     board_url, board_title, owner_login, status_field_id, status_options
 *     jsonb, auth_mode ∈ {'pat','gh'}, column_action_map jsonb, poll_cursor
 *     jsonb, poll_interval_sec, enabled, last_polled_at, last_error,
 *     last_error_at, created_by_user_id FK SET NULL, default_model,
 *     default_permission_mode, timestamps). A project connects to MANY
 *     boards (one row per board); a given board connects to a project only
 *     once — UNIQUE INDEX idx_gh_links_project_board(project_id,
 *     board_node_id). The legacy single-board UNIQUE(project_id) (inline
 *     constraint or the older idx_gh_links_project_unique index) is DROPPED
 *     by the multi-board migration. `enabled=false` is the user-facing
 *     "pause polling" state (board + token retained).
 *   - default_model — per-board default "<provider>:<model>" for spawned
 *     runs; null/empty keeps the instance default.
 *   - default_permission_mode — per-board default runtime PermissionMode
 *     ("ask" | "auto-edit" | "yolo") for spawned runs; null/invalid falls
 *     back to "yolo" in the spawn bridge.
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
 *   - The GitHub PAT (auth_mode='pat') is stored ENCRYPTED in the
 *     `extension_secrets` store (see add-extension-secrets.ts) at name
 *     `apiToken` (the SHARED project token) and optionally
 *     `apiToken:<linkId>` (a per-board override) — never in a column here,
 *     never in the plaintext .ezcorp/ extension-data dir. (Legacy
 *     `settings`-table blobs at `githubProjects:<projectId>:apiToken` are
 *     backfilled into the store at migrate time — see
 *     src/extensions/secrets-store.ts `backfillGithubProjectsApiTokens`.)
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
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  // Additive back-compat for DBs created before status_options existed.
  await db.execute(
    sql`ALTER TABLE github_projects_links ADD COLUMN IF NOT EXISTS status_options JSONB NOT NULL DEFAULT '[]'`,
  );
  // Per-board default model for spawned runs ("<provider>:<model>"). Nullable —
  // null/empty keeps the instance default.
  await db.execute(
    sql`ALTER TABLE github_projects_links ADD COLUMN IF NOT EXISTS default_model TEXT`,
  );
  // Per-board default permission mode for spawned runs (runtime PermissionMode:
  // "ask" | "auto-edit" | "yolo"). Nullable — null/invalid falls back to "yolo"
  // in the spawn bridge.
  await db.execute(
    sql`ALTER TABLE github_projects_links ADD COLUMN IF NOT EXISTS default_permission_mode TEXT`,
  );
  // Multi-board migration (idempotent, PGlite-safe): a project connects to many
  // boards, so drop the legacy single-board uniqueness — both forms it can take
  // (the inline UNIQUE(project_id) constraint from the old CREATE TABLE, and the
  // older standalone idx_gh_links_project_unique index) — then create the
  // (project_id, board_node_id) uniqueness as a NAMED index (NOT inline) so an
  // already-migrated DB can converge from either legacy state.
  await db.execute(
    sql`ALTER TABLE github_projects_links DROP CONSTRAINT IF EXISTS github_projects_links_project_id_key`,
  );
  await db.execute(sql`DROP INDEX IF EXISTS idx_gh_links_project_unique`);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_gh_links_project_board ON github_projects_links (project_id, board_node_id)`,
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
