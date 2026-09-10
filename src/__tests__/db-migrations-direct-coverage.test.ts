/**
 * Direct real-PGlite coverage for the standalone migration producers.
 *
 * `migrate()` also contains consolidated copies of much of this DDL. These
 * checks deliberately call each exported producer against a pre-migration
 * database so its upgrade and replay behavior cannot become dead code.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { up as addBriefingConfigs } from "../db/migrations/add-briefing-configs";
import { up as addExtensionRbac } from "../db/migrations/add-extension-rbac";
import { up as addExtensionSecrets } from "../db/migrations/add-extension-secrets";
import { up as addEzModeAndKind } from "../db/migrations/add-ez-mode-and-kind";
import { up as addFeatureIndex } from "../db/migrations/add-feature-index";
import { up as addForkTracking } from "../db/migrations/add-fork-tracking";
import { up as addGithubProjects } from "../db/migrations/add-github-projects";
import { up as addLessons } from "../db/migrations/add-lessons";
import { up as addSdkCapabilityAudit } from "../db/migrations/add-sdk-capability-audit";
import { up as addSessionStorage } from "../db/migrations/add-session-storage";
import { up as addSubConvoAndReferences } from "../db/migrations/add-sub-convo-and-references";
import { addSuggestionFeedback } from "../db/migrations/add-suggestion-feedback";
import { CONTEXT_TYPE_SEED, up as addTopicContexts } from "../db/migrations/add-topic-contexts";

let pglite: PGlite;
let db: ReturnType<typeof drizzle>;

async function query<T extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) {
  return pglite.query<T>(text, params);
}

async function expectRejected(action: () => Promise<unknown>): Promise<void> {
  let rejected = false;
  try {
    await action();
  } catch {
    rejected = true;
  }
  expect(rejected).toBe(true);
}

async function createPreMigrationSchema(): Promise<void> {
  await db.execute(sql`CREATE TABLE users (id TEXT PRIMARY KEY)`);
  await db.execute(sql`CREATE TABLE projects (id TEXT PRIMARY KEY)`);
  await db.execute(sql`CREATE TABLE extensions (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE)`);
  await db.execute(sql`
    CREATE TABLE modes (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      icon TEXT,
      description TEXT,
      system_prompt_instruction TEXT,
      instruction_position TEXT,
      tool_restriction TEXT,
      builtin BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
  await db.execute(sql`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      project_id TEXT REFERENCES projects(id),
      title TEXT
    )
  `);
  await db.execute(sql`CREATE TABLE agent_configs (id TEXT PRIMARY KEY)`);
  await db.execute(sql`CREATE TABLE messages (id TEXT PRIMARY KEY)`);

  // The old single-board shape is intentional: addGithubProjects must remove
  // this uniqueness before a project can connect a second board.
  await db.execute(sql`
    CREATE TABLE github_projects_links (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
      board_node_id TEXT NOT NULL,
      board_url TEXT NOT NULL,
      board_title TEXT NOT NULL DEFAULT '',
      owner_login TEXT NOT NULL DEFAULT '',
      status_field_id TEXT,
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
}

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  db = drizzle(pglite);
  await createPreMigrationSchema();
  await query("INSERT INTO users (id) VALUES ($1), ($2)", ["user-1", "user-2"]);
  await query("INSERT INTO projects (id) VALUES ($1)", ["project-1"]);
  await query("INSERT INTO extensions (id, name) VALUES ($1, $2)", ["extension-1", "github-projects"]);
  await query("INSERT INTO agent_configs (id) VALUES ($1)", ["agent-config-1"]);
  await query("INSERT INTO conversations (id, user_id, project_id, title) VALUES ($1, $2, $3, $4)", [
    "conversation-1",
    "user-1",
    "project-1",
    "root",
  ]);
  await query("INSERT INTO messages (id) VALUES ($1)", ["message-1"]);
});

afterAll(async () => {
  await pglite.close();
});

describe("standalone migration producers", () => {
  test("add-briefing-configs creates a user-owned queue and preserves replay safety", async () => {
    await addBriefingConfigs(db);
    await query("INSERT INTO briefing_configs (user_id, enabled, watchlist) VALUES ($1, TRUE, $2::jsonb)", ["user-1", '["release"]']);
    const { rows } = await query<{ enabled: boolean; watchlist: string }>("SELECT enabled, watchlist::text AS watchlist FROM briefing_configs WHERE user_id = $1", ["user-1"]);
    expect(rows[0]).toEqual({ enabled: true, watchlist: '["release"]' });
    await expectRejected(() => query("INSERT INTO briefing_configs (user_id) VALUES ($1)", ["user-1"]));
    await addBriefingConfigs(db);
  });

  test("add-extension-rbac and add-extension-secrets enforce nullable scope uniqueness", async () => {
    await addExtensionRbac(db);
    await addExtensionSecrets(db);
    await query("INSERT INTO extension_rbac_grants (id, user_id, scopes) VALUES ($1, $2, $3::jsonb)", ["grant-1", "user-1", '["invoke"]']);
    await expectRejected(() => query("INSERT INTO extension_rbac_grants (id, user_id, scopes) VALUES ($1, $2, $3::jsonb)", ["grant-2", "user-1", '["manage"]']));
    await query("INSERT INTO extension_secrets (id, extension_id, name, ciphertext) VALUES ($1, $2, $3, $4)", ["secret-1", "github-projects", "apiToken", "ciphertext"]);
    await expectRejected(() => query("INSERT INTO extension_secrets (id, extension_id, name, ciphertext) VALUES ($1, $2, $3, $4)", ["secret-2", "github-projects", "apiToken", "other"]));
    await addExtensionRbac(db);
    await addExtensionSecrets(db);
  });

  test("add-ez-mode-and-kind seeds Ez and permits only one Ez conversation per user", async () => {
    await addEzModeAndKind(db);
    const { rows } = await query<{ allowed_tools: string[]; tool_restriction: string; builtin: boolean }>(
      "SELECT allowed_tools, tool_restriction, builtin FROM modes WHERE slug = 'ez'",
    );
    expect(rows[0]?.tool_restriction).toBe("allowlist");
    expect(rows[0]?.builtin).toBe(true);
    expect(rows[0]?.allowed_tools).toContain("read_page");
    await query("INSERT INTO conversations (id, user_id, project_id, title, kind) VALUES ($1, $2, $3, $4, 'ez')", ["conversation-ez-1", "user-1", "project-1", "Ez"]);
    await expectRejected(() => query("INSERT INTO conversations (id, user_id, project_id, title, kind) VALUES ($1, $2, $3, $4, 'ez')", ["conversation-ez-2", "user-1", "project-1", "duplicate"]));
    await addEzModeAndKind(db);
  });

  test("add-feature-index keeps files project-scoped and rejects duplicate pins", async () => {
    await addFeatureIndex(db);
    await query("INSERT INTO features (id, project_id, name) VALUES ($1, $2, $3)", ["feature-1", "project-1", "attachments"]);
    await query("INSERT INTO feature_files (feature_id, relpath) VALUES ($1, $2)", ["feature-1", "src/file.ts"]);
    await expectRejected(() => query("INSERT INTO feature_files (feature_id, relpath) VALUES ($1, $2)", ["feature-1", "src/file.ts"]));
    await addFeatureIndex(db);
  });

  test("fork and sub-conversation migrations retain the distinct delete contracts", async () => {
    await addForkTracking(db);
    await addSubConvoAndReferences(db);
    await query("INSERT INTO conversations (id, user_id, project_id, title, forked_from_conversation_id) VALUES ($1, $2, $3, $4, $5)", ["fork-1", "user-2", "project-1", "fork", "conversation-1"]);
    await query("INSERT INTO conversations (id, user_id, project_id, title, parent_conversation_id) VALUES ($1, $2, $3, $4, $5)", ["child-1", "user-2", "project-1", "child", "conversation-1"]);
    await query("DELETE FROM conversations WHERE id = $1", ["conversation-1"]);
    const { rows } = await query<{ id: string; forked_from_conversation_id: string | null }>("SELECT id, forked_from_conversation_id FROM conversations WHERE id = 'fork-1'");
    expect(rows[0]).toEqual({ id: "fork-1", forked_from_conversation_id: null });
    const children = await query("SELECT id FROM conversations WHERE id = 'child-1'");
    expect(children.rows).toHaveLength(0);
    await addForkTracking(db);
    await addSubConvoAndReferences(db);
  });

  test("add-github-projects upgrades a single-board table and deduplicates active work", async () => {
    await addGithubProjects(db);
    await query("INSERT INTO github_projects_links (id, project_id, board_node_id, board_url) VALUES ($1, $2, $3, $4)", ["link-1", "project-1", "board-1", "https://github.test/1"]);
    await query("INSERT INTO github_projects_links (id, project_id, board_node_id, board_url, default_model, default_permission_mode) VALUES ($1, $2, $3, $4, $5, $6)", ["link-2", "project-1", "board-2", "https://github.test/2", "openai:gpt", "ask"]);
    // Recreate the historical pre-index state that allowed two active rows.
    await query("DROP INDEX idx_gh_proposals_active_item");
    await query("INSERT INTO github_projects_proposals (id, project_id, link_id, item_node_id, status_option_id, action, dedupe_key, status, proposed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW() - INTERVAL '1 minute')", ["proposal-old", "project-1", "link-1", "item-1", "status-a", "run", "old"]);
    await query("INSERT INTO github_projects_proposals (id, project_id, link_id, item_node_id, status_option_id, action, dedupe_key, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')", ["proposal-new", "project-1", "link-1", "item-1", "status-b", "run", "new"]);
    // Simulate the old database's pre-index state, then prove the upgrade
    // retains only the newest active proposal before installing its guard.
    await addGithubProjects(db);
    const proposals = await query<{ id: string; status: string }>("SELECT id, status FROM github_projects_proposals WHERE item_node_id = 'item-1' ORDER BY id");
    expect(proposals.rows).toEqual([{ id: "proposal-new", status: "pending" }, { id: "proposal-old", status: "cancelled" }]);
    await expectRejected(() => query("INSERT INTO github_projects_proposals (id, project_id, link_id, item_node_id, status_option_id, action, dedupe_key, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'running')", ["proposal-duplicate", "project-1", "link-1", "item-1", "status-c", "run", "duplicate"]));
  });

  test("lessons and SDK audit migrations enforce scoped slugs, provenance, and restrict deletes", async () => {
    await addLessons(db);
    await addSdkCapabilityAudit(db);
    await query("INSERT INTO lessons (id, project_id, owner_id, slug, title, body) VALUES ($1, $2, $3, $4, $5, $6)", ["lesson-user-1", "project-1", "user-1", "deploy", "Deploy", "body"]);
    await query("INSERT INTO lessons (id, project_id, owner_id, visibility, slug, title, body) VALUES ($1, $2, $3, 'project', $4, $5, $6)", ["lesson-project-1", "project-1", "user-2", "deploy", "Shared", "body"]);
    await expectRejected(() => query("INSERT INTO lessons (id, project_id, owner_id, slug, title, body) VALUES ($1, $2, $3, $4, $5, $6)", ["lesson-user-2", "project-1", "user-1", "deploy", "Duplicate", "body"]));
    await query("INSERT INTO sdk_capability_calls (id, extension_id, on_behalf_of, capability, action, success, duration_ms) VALUES ($1, $2, $3, $4, $5, TRUE, 1)", ["audit-1", "extension-1", "user-1", "memory", "read"]);
    await expectRejected(() => query("DELETE FROM users WHERE id = $1", ["user-1"]));
    await addLessons(db);
    await addSdkCapabilityAudit(db);
  });

  test("session storage preserves entry identity per session and cascades session deletion", async () => {
    await addSessionStorage(db);
    await query("INSERT INTO agent_sessions (id, cwd) VALUES ($1, $2), ($3, $4)", ["session-1", "/repo", "session-2", "/repo"]);
    await query("INSERT INTO agent_session_entries (session_id, entry_id, type, timestamp, payload) VALUES ($1, $2, $3, $4, $5::jsonb)", ["session-1", "entry-shared", "message", "2026-01-01T00:00:00.000Z", '{"text":"one"}']);
    await query("INSERT INTO agent_session_entries (session_id, entry_id, type, timestamp) VALUES ($1, $2, $3, $4)", ["session-2", "entry-shared", "message", "2026-01-01T00:00:01.000Z"]);
    await expectRejected(() => query("INSERT INTO agent_session_entries (session_id, entry_id, type, timestamp) VALUES ($1, $2, $3, $4)", ["session-1", "entry-shared", "message", "2026-01-01T00:00:02.000Z"]));
    await query("DELETE FROM agent_sessions WHERE id = $1", ["session-1"]);
    const entries = await query("SELECT entry_id FROM agent_session_entries WHERE session_id = 'session-1'");
    expect(entries.rows).toHaveLength(0);
    await addSessionStorage(db);
  });

  test("suggestion feedback and topic contexts protect retained telemetry and live classification data", async () => {
    await addSuggestionFeedback(db);
    await addTopicContexts(db);
    await query("INSERT INTO suggestion_feedback (id, user_id, conversation_id, kind, action) VALUES ($1, $2, $3, $4, $5)", ["feedback-1", "user-2", "fork-1", "tool", "accepted"]);
    await query("DELETE FROM conversations WHERE id = $1", ["fork-1"]);
    const feedback = await query<{ conversation_id: string | null }>("SELECT conversation_id FROM suggestion_feedback WHERE id = 'feedback-1'");
    expect(feedback.rows[0]?.conversation_id).toBeNull();
    const types = await query<{ id: string }>("SELECT id FROM context_types ORDER BY sort_order");
    expect(types.rows.map((row) => row.id)).toEqual(CONTEXT_TYPE_SEED.map((type) => type.id));
    await query("INSERT INTO conversations (id, user_id, project_id, title) VALUES ($1, $2, $3, $4)", ["conversation-topic", "user-2", "project-1", "topic"]);
    await query("INSERT INTO conversation_topics (id, conversation_id, label, type_id) VALUES ($1, $2, $3, $4)", ["topic-1", "conversation-topic", "Release plan", "plan"]);
    await expectRejected(() => query("INSERT INTO conversation_topics (id, conversation_id, label, type_id) VALUES ($1, $2, $3, $4)", ["topic-2", "conversation-topic", "release PLAN", "plan"]));
    await addSuggestionFeedback(db);
    await addTopicContexts(db);
  });
});
