/**
 * Phase 6 sub-plan 06-04 — schema column policy.
 *
 * After migrate() runs, two Phase 6-introduced columns MUST exist with
 * specific shape:
 *
 *   1. agent_configs.category — text, NULLABLE (no default).
 *      Powers the /agents page category-chip filter row.
 *
 *   2. conversations.agent_config_id — text, NULLABLE, with FK to
 *      agent_configs(id) ON DELETE SET NULL.
 *      Links agent-conversations to their persona; ON DELETE SET NULL
 *      means deleting the persona keeps the conversation history (the
 *      systemPrompt persists on the conversation row).
 *
 * The existing db-migrate-idempotent.test.ts catches non-idempotent DDL
 * but would NOT catch a regression that flipped ON DELETE SET NULL to
 * ON DELETE CASCADE (which would silently destroy user history when a
 * persona is removed). This suite pins both column shapes + FK action.
 */

import { test, expect, describe } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";

type ColumnInfo = {
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
};

type FkInfo = {
  constraint_name: string;
  table_name: string;
  column_name: string;
  foreign_table_name: string;
  foreign_column_name: string;
  delete_rule: string;
};

async function getColumn(db: any, table: string, column: string): Promise<ColumnInfo | null> {
  const rows = (await db.execute(sql.raw(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = '${table}'
      AND column_name = '${column}'
  `))).rows as ColumnInfo[];
  return rows[0] ?? null;
}

async function getFk(db: any, table: string, column: string): Promise<FkInfo | null> {
  const rows = (await db.execute(sql.raw(`
    SELECT
      tc.constraint_name,
      tc.table_name,
      kcu.column_name,
      ccu.table_name AS foreign_table_name,
      ccu.column_name AS foreign_column_name,
      rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_name = tc.constraint_name
      AND rc.constraint_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name = '${table}'
      AND kcu.column_name = '${column}'
  `))).rows as FkInfo[];
  return rows[0] ?? null;
}

describe("Phase 6 schema columns — agent_configs.category + conversations.agent_config_id", () => {
  test("agent_configs.category exists as text NULLABLE", async () => {
    const pglite = new PGlite({ extensions: { vector, pg_trgm } });
    await pglite.waitReady;
    const db = drizzle(pglite, { schema });

    try {
      await migrate(db);
      const col = await getColumn(db, "agent_configs", "category");
      expect(col).not.toBeNull();
      expect(col!.data_type).toBe("text");
      expect(col!.is_nullable).toBe("YES");
      expect(col!.column_default).toBeNull();
    } finally {
      await pglite.close();
    }
  });

  test("conversations.agent_config_id exists as text NULLABLE with FK ON DELETE SET NULL", async () => {
    const pglite = new PGlite({ extensions: { vector, pg_trgm } });
    await pglite.waitReady;
    const db = drizzle(pglite, { schema });

    try {
      await migrate(db);

      const col = await getColumn(db, "conversations", "agent_config_id");
      expect(col).not.toBeNull();
      expect(col!.data_type).toBe("text");
      expect(col!.is_nullable).toBe("YES");

      const fk = await getFk(db, "conversations", "agent_config_id");
      expect(fk).not.toBeNull();
      expect(fk!.foreign_table_name).toBe("agent_configs");
      expect(fk!.foreign_column_name).toBe("id");
      expect(fk!.delete_rule).toBe("SET NULL");
    } finally {
      await pglite.close();
    }
  });

  test("ON DELETE SET NULL behavior: deleting an agent_config nulls the conversation's agent_config_id", async () => {
    // End-to-end behavior test (not just schema introspection):
    // Insert a project (required for conversations.project_id FK, NOT NULL),
    // an agent_config, a conversation referencing it, delete the agent_config,
    // assert the conversation row's agent_config_id is now null.
    //
    // This is the highest-value of the three tests — schema-shape introspection
    // can be fooled by a flipped delete_rule that still serializes as text in
    // pg_catalog. A live DELETE forces the FK action to fire.
    const pglite = new PGlite({ extensions: { vector, pg_trgm } });
    await pglite.waitReady;
    const db = drizzle(pglite, { schema });

    try {
      await migrate(db);

      // Insert a project (conversations.project_id is NOT NULL with FK to projects.id)
      await db.execute(sql`
        INSERT INTO projects (id, name, path)
        VALUES ('p-1', 'test-project', '/tmp/test')
      `);

      // Insert a minimal agent_config (id, name, prompt are NOT NULL; rest have defaults)
      await db.execute(sql`
        INSERT INTO agent_configs (id, name, prompt)
        VALUES ('cfg-x', 'test-agent', 'sys')
      `);

      // Insert a minimal conversation referencing it.
      // (id, project_id, title — but title has default; created_at/updated_at have defaults.)
      await db.execute(sql`
        INSERT INTO conversations (id, project_id, title, agent_config_id)
        VALUES ('conv-x', 'p-1', 'Chat with test-agent', 'cfg-x')
      `);

      // Verify pre-delete: agent_config_id is 'cfg-x'
      const preRows = (await db.execute(sql`
        SELECT agent_config_id FROM conversations WHERE id = 'conv-x'
      `)).rows as Array<{ agent_config_id: string | null }>;
      expect(preRows).toHaveLength(1);
      expect(preRows[0]!.agent_config_id).toBe("cfg-x");

      // Delete the agent_config
      await db.execute(sql`DELETE FROM agent_configs WHERE id = 'cfg-x'`);

      // Assert the conversation row still exists (not cascaded away) and
      // its agent_config_id is now NULL
      const postRows = (await db.execute(sql`
        SELECT agent_config_id FROM conversations WHERE id = 'conv-x'
      `)).rows as Array<{ agent_config_id: string | null }>;
      expect(postRows).toHaveLength(1);
      expect(postRows[0]!.agent_config_id).toBeNull();
    } finally {
      await pglite.close();
    }
  });
});
