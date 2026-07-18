/**
 * DB-audit remediation coverage (schema-migrations group).
 *
 * Asserts, against a fully-migrated PGlite, that:
 *   - every index added to close the "unindexed FK / hot-path filter" findings
 *     actually exists (conversation-delete O(N), claim scans, audit reads,
 *     point lookups, admin audit-global trigram search);
 *   - the sdk_capability_calls.on_behalf_of FK is ON DELETE RESTRICT and the
 *     guarded swap left it enforced (user-delete is blocked);
 *   - the drizzle-mirrored composite UNIQUE constraints are enforced at the DB
 *     (conversation_extensions, marketplace_ratings);
 *   - the temperature columns are REAL;
 *   - the user_commands unique index exists (proving migrate() ran the shared
 *     add-user-commands-unique-name module — the single source of truth).
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, getTestDb, getTestPglite, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { migrate } from "../db/migrate";

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

async function indexNames(): Promise<Set<string>> {
  const { rows } = await getTestPglite().query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
  );
  return new Set(rows.map((r) => r.indexname));
}

describe("schema-migrations: audit-remediation indexes exist", () => {
  const EXPECTED = [
    // Unindexed FK columns that made conversation/message/agent/mode deletes O(N).
    "idx_tool_calls_message",
    "idx_obs_events_message",
    "idx_agent_session_entries_ez_message",
    "idx_conv_ext_added_by_message",
    "idx_runs_conversation_id",
    "idx_memories_conversation_id",
    "idx_suggestion_feedback_conversation",
    "idx_conversations_agent_config_id",
    "idx_conversations_mode_id",
    // memory_audit_log — previously had ZERO indexes.
    "idx_memory_audit_memory_created",
    "idx_memory_audit_reason_created",
    // Per-target audit reads.
    "idx_audit_log_target",
    // Embed-outbox claim scan.
    "idx_message_embed_outbox_claim",
    // GitHub proposal point lookups.
    "idx_gh_proposals_agent_run",
    "idx_gh_proposals_conversation",
    // Admin audit-global LIKE '%..%' trigram indexes.
    "idx_sdk_cap_resource_id_trgm",
    "idx_sdk_cap_error_message_trgm",
    "idx_sdk_cap_model_trgm",
  ];

  test("all remediation indexes are present after migrate()", async () => {
    const present = await indexNames();
    for (const name of EXPECTED) {
      expect(present.has(name)).toBe(true);
    }
  });

  test("user_commands unique index exists (proves the shared module ran in migrate())", async () => {
    const present = await indexNames();
    expect(present.has("uq_user_commands_user_name")).toBe(true);
  });

  test("the sdk trigram indexes are GIN (usable by word/LIKE search)", async () => {
    const { rows } = await getTestPglite().query<{ indexname: string; am: string }>(
      `SELECT i.indexname, a.amname AS am
         FROM pg_indexes i
         JOIN pg_class c ON c.relname = i.indexname
         JOIN pg_am a ON a.oid = c.relam
        WHERE i.indexname = 'idx_sdk_cap_resource_id_trgm'`,
    );
    expect(rows[0]?.am).toBe("gin");
  });
});

describe("schema-migrations: FK + UNIQUE invariants", () => {
  test("sdk_capability_calls.on_behalf_of FK is ON DELETE RESTRICT (guarded swap)", async () => {
    const { rows } = await getTestPglite().query<{ confdeltype: string }>(
      `SELECT confdeltype FROM pg_constraint
        WHERE conname = 'sdk_capability_calls_on_behalf_of_fkey'
          AND conrelid = 'sdk_capability_calls'::regclass`,
    );
    // 'r' = RESTRICT.
    expect(rows[0]?.confdeltype).toBe("r");
  });

  test("RESTRICT actually blocks deleting a user that has audit rows", async () => {
    const pg = getTestPglite();
    await pg.query(
      `INSERT INTO users (id, email, password_hash, name, role) VALUES ($1,$2,'x','U','member')`,
      ["u-sdk-restrict", "sdk-restrict@x.com"],
    );
    await pg.query(
      `INSERT INTO sdk_capability_calls (id, extension_id, on_behalf_of, capability, action, success, duration_ms)
       VALUES ($1, 'builtin', $2, 'llm', 'complete', true, 1)`,
      ["scc-restrict-1", "u-sdk-restrict"],
    );
    let blocked = false;
    try {
      await pg.query(`DELETE FROM users WHERE id = $1`, ["u-sdk-restrict"]);
    } catch (e) {
      blocked = true;
      const text = [String((e as { message?: string }).message ?? ""), String((e as { cause?: unknown }).cause ?? "")].join(" | ");
      expect(text).toMatch(/violates foreign key|restrict|still referenced/i);
    }
    expect(blocked).toBe(true);
  });

  test("re-running migrate() keeps the RESTRICT FK (guard is idempotent, no re-validate error)", async () => {
    const db = getTestDb();
    await migrate(db); // must not throw; the guarded probe short-circuits the drop/add
    const { rows } = await getTestPglite().query<{ confdeltype: string }>(
      `SELECT confdeltype FROM pg_constraint
        WHERE conname = 'sdk_capability_calls_on_behalf_of_fkey'
          AND conrelid = 'sdk_capability_calls'::regclass`,
    );
    expect(rows[0]?.confdeltype).toBe("r");
  });

  test("conversation_extensions enforces UNIQUE(conversation_id, extension_id)", async () => {
    const pg = getTestPglite();
    await pg.query(
      `INSERT INTO conversations (id, project_id, title) VALUES ($1, 'global', 'ce-dup')`,
      ["conv-ce-dup"],
    );
    await pg.query(
      `INSERT INTO conversation_extensions (id, conversation_id, extension_id) VALUES ($1, $2, 'builtin')`,
      ["ce-1", "conv-ce-dup"],
    );
    let failed = false;
    try {
      await pg.query(
        `INSERT INTO conversation_extensions (id, conversation_id, extension_id) VALUES ($1, $2, 'builtin')`,
        ["ce-2", "conv-ce-dup"],
      );
    } catch (e) {
      failed = true;
      const text = [String((e as { message?: string }).message ?? ""), String((e as { cause?: unknown }).cause ?? "")].join(" | ");
      expect(text).toMatch(/unique|duplicate/i);
    }
    expect(failed).toBe(true);
  });

  test("marketplace_ratings enforces UNIQUE(listing_id, user_id)", async () => {
    const pg = getTestPglite();
    await pg.query(
      `INSERT INTO users (id, email, password_hash, name, role) VALUES ($1,$2,'x','A','member')`,
      ["u-rating", "rating@x.com"],
    );
    await pg.query(
      `INSERT INTO marketplace_listings (id, author_id, name, description, slug, category, latest_version)
       VALUES ($1, $2, 'L', 'd', 'slug-rating', 'cat', '1.0.0')`,
      ["listing-rating", "u-rating"],
    );
    await pg.query(
      `INSERT INTO marketplace_ratings (id, listing_id, user_id, thumbs_up) VALUES ($1, $2, $3, true)`,
      ["rate-1", "listing-rating", "u-rating"],
    );
    let failed = false;
    try {
      await pg.query(
        `INSERT INTO marketplace_ratings (id, listing_id, user_id, thumbs_up) VALUES ($1, $2, $3, false)`,
        ["rate-2", "listing-rating", "u-rating"],
      );
    } catch (e) {
      failed = true;
      const text = [String((e as { message?: string }).message ?? ""), String((e as { cause?: unknown }).cause ?? "")].join(" | ");
      expect(text).toMatch(/unique|duplicate/i);
    }
    expect(failed).toBe(true);
  });

  test("temperature columns are REAL (guarded ALTER left the correct type)", async () => {
    const { rows } = await getTestPglite().query<{ table_name: string; data_type: string }>(
      `SELECT table_name, data_type FROM information_schema.columns
        WHERE column_name = 'temperature' AND table_name IN ('agent_configs','modes')`,
    );
    const byTable = Object.fromEntries(rows.map((r) => [r.table_name, r.data_type]));
    expect(byTable["agent_configs"]).toBe("real");
    expect(byTable["modes"]).toBe("real");
  });
});
