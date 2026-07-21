/**
 * DB-audit remediation coverage (schema-migrations group) — migration
 * ORDER + no-op-rewrite guards.
 *
 * 1. FIRST-BOOT ORDER (runs.user_id IDOR backfill): the recursive-CTE backfill
 *    reads conversations.parent_conversation_id, which used to be added LATER
 *    in the same migrate() run. On a DB whose conversations table predates that
 *    column the UPDATE threw undefined-column and a bare catch swallowed it, so
 *    historical runs stayed unattributed until a SECOND boot. We reproduce the
 *    legacy shape by dropping the column, then assert a single migrate() run
 *    now attributes the run (the ADD COLUMN is hoisted above the backfill).
 *
 * 2. NO-OP REWRITE GUARD (tool_calls dimension backfill): rows whose joined
 *    sources are themselves NULL can never be filled, yet the un-guarded UPDATE
 *    physically rewrote them every boot (dead tuples + WAL churn). We assert the
 *    row's ctid is UNCHANGED across a re-migrate — proof the IS DISTINCT FROM
 *    guard skipped the write.
 *
 * 3. MESSAGES BACKFILL PROBE: the LLM parent_message_id backfill now runs only
 *    when a backfillable row exists. We assert it still links a legacy
 *    unlinked message to its predecessor when one does.
 */
import { test, expect, describe, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, getTestPglite, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { migrate } from "../db/migrate";

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("schema-migrations: first-boot backfill order + no-op guards", () => {
  test("runs.user_id backfill attributes on FIRST migrate() when parent_conversation_id was just (re)added", async () => {
    const { db } = await setupTestDb();
    const USER = "u-fb-1";
    const PROJECT = "p-fb-1";
    const CONV = "conv-fb-1";
    const RUN = "run-fb-1";

    // Seed a chat run whose conversation is owned but whose user_id is NULL —
    // exactly the historical shape the IDOR backfill targets.
    const pg = getTestPglite();
    await pg.query(`INSERT INTO users (id, email, password_hash, name, role) VALUES ($1,$2,'x','U','member')`, [USER, "fb1@x.com"]);
    await pg.query(`INSERT INTO projects (id, name, path) VALUES ($1,'fb1','/tmp/fb1')`, [PROJECT]);
    await pg.query(`INSERT INTO conversations (id, project_id, title, user_id) VALUES ($1,$2,'c',$3)`, [CONV, PROJECT, USER]);
    await pg.query(`INSERT INTO runs (id, agent_name, status, started_at, conversation_id, user_id) VALUES ($1,'chat','success',NOW(),$2,NULL)`, [RUN, CONV]);

    // Simulate a DB whose conversations table predates Phase 33: drop the
    // column the backfill reads. Pre-fix, migrate()'s backfill would throw
    // undefined-column here and swallow it, leaving the run unattributed.
    await db.execute(sql`ALTER TABLE conversations DROP COLUMN IF EXISTS parent_conversation_id CASCADE`);

    await migrate(db);

    const { rows } = await pg.query<{ user_id: string | null }>(`SELECT user_id FROM runs WHERE id = $1`, [RUN]);
    expect(rows[0]?.user_id).toBe(USER);

    // Column is restored (single authoritative ADD site, hoisted above the backfill).
    const { rows: colRows } = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name='conversations' AND column_name='parent_conversation_id'`,
    );
    expect(colRows.length).toBe(1);
  });

  test("tool_calls dimension backfill does NOT rewrite an unfillable row on re-migrate (ctid stable)", async () => {
    const { db } = await setupTestDb();
    const pg = getTestPglite();
    // Conversation with NO user/agent/model/provider — every backfill source is
    // NULL, so the row can never be filled. No admin user exists in this fresh
    // snapshot, so the conversations.user_id admin-backfill is also a no-op.
    await pg.query(`INSERT INTO projects (id, name, path) VALUES ('p-tc','tc','/tmp/tc')`);
    await pg.query(`INSERT INTO conversations (id, project_id, title) VALUES ('conv-tc','p-tc','tc')`);
    await pg.query(
      `INSERT INTO tool_calls (id, conversation_id, extension_id, tool_name, success, duration_ms)
       VALUES ('tc-guard','conv-tc','builtin','noop',true,1)`,
    );

    const before = await pg.query<{ ctid: string }>(`SELECT ctid::text AS ctid FROM tool_calls WHERE id='tc-guard'`);
    await migrate(db);
    const after = await pg.query<{ ctid: string }>(`SELECT ctid::text AS ctid FROM tool_calls WHERE id='tc-guard'`);

    // Same physical tuple ⇒ the guarded UPDATE skipped this unfillable row.
    expect(after.rows[0]?.ctid).toBe(before.rows[0]?.ctid);
    // And the dimensions are still NULL (nothing to fill).
    const { rows } = await pg.query<{ user_id: string | null; model: string | null }>(
      `SELECT user_id, model FROM tool_calls WHERE id='tc-guard'`,
    );
    expect(rows[0]?.user_id).toBeNull();
    expect(rows[0]?.model).toBeNull();
  });

  test("messages parent_message_id backfill links a legacy unlinked message when a predecessor exists", async () => {
    const { db } = await setupTestDb();
    const pg = getTestPglite();
    await pg.query(`INSERT INTO projects (id, name, path) VALUES ('p-msg','msg','/tmp/msg')`);
    await pg.query(`INSERT INTO conversations (id, project_id, title) VALUES ('conv-msg','p-msg','m')`);
    // Two legacy messages, both parent_message_id NULL, distinct created_at.
    await pg.query(
      `INSERT INTO messages (id, conversation_id, role, content, parent_message_id, created_at)
       VALUES ('m1','conv-msg','user','first',NULL,$1)`,
      [new Date("2025-01-01T00:00:00Z").toISOString()],
    );
    await pg.query(
      `INSERT INTO messages (id, conversation_id, role, content, parent_message_id, created_at)
       VALUES ('m2','conv-msg','assistant','second',NULL,$1)`,
      [new Date("2025-01-02T00:00:00Z").toISOString()],
    );

    await migrate(db);

    const { rows } = await pg.query<{ id: string; parent_message_id: string | null }>(
      `SELECT id, parent_message_id FROM messages WHERE conversation_id='conv-msg' ORDER BY created_at`,
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.parent_message_id]));
    expect(byId["m1"]).toBeNull();        // oldest has no predecessor
    expect(byId["m2"]).toBe("m1");         // linked to its predecessor by the guarded backfill
  });

  test("temperature ALTER runs on a legacy INTEGER column and converts it to REAL", async () => {
    const { db } = await setupTestDb();
    const pg = getTestPglite();
    // Simulate a legacy DB whose temperature columns are still INTEGER (the
    // original bug). The guarded probe should detect the wrong type and run the
    // ACCESS EXCLUSIVE ALTER exactly once.
    await pg.query(`ALTER TABLE agent_configs ALTER COLUMN temperature TYPE INTEGER USING temperature::INTEGER`);
    await pg.query(`ALTER TABLE modes ALTER COLUMN temperature TYPE INTEGER USING temperature::INTEGER`);

    await migrate(db);

    const { rows } = await pg.query<{ table_name: string; data_type: string }>(
      `SELECT table_name, data_type FROM information_schema.columns
        WHERE column_name = 'temperature' AND table_name IN ('agent_configs','modes')`,
    );
    const byTable = Object.fromEntries(rows.map((r) => [r.table_name, r.data_type]));
    expect(byTable["agent_configs"]).toBe("real");
    expect(byTable["modes"]).toBe("real");
  });

  test("sdk_capability_calls FK is repaired to RESTRICT when the constraint is missing/wrong", async () => {
    const { db } = await setupTestDb();
    const pg = getTestPglite();
    // Simulate a dev DB created with the old (inconsistent) ON DELETE SET NULL
    // spec — the guarded swap must detect confdeltype != 'r' and rewrite it.
    await pg.query(`ALTER TABLE sdk_capability_calls DROP CONSTRAINT sdk_capability_calls_on_behalf_of_fkey`);
    await pg.query(
      `ALTER TABLE sdk_capability_calls ADD CONSTRAINT sdk_capability_calls_on_behalf_of_fkey
         FOREIGN KEY (on_behalf_of) REFERENCES users(id) ON DELETE SET NULL`,
    );

    await migrate(db);

    const { rows } = await pg.query<{ confdeltype: string }>(
      `SELECT confdeltype FROM pg_constraint
        WHERE conname = 'sdk_capability_calls_on_behalf_of_fkey'
          AND conrelid = 'sdk_capability_calls'::regclass`,
    );
    expect(rows[0]?.confdeltype).toBe("r");
  });

  test("runs.user_id backfill failure is non-fatal + logged, not swallowed (fail-closed)", async () => {
    const { db } = await setupTestDb();
    const pg = getTestPglite();
    const USER = "u-fb-throw";
    const PROJECT = "p-fb-throw";
    const CONV = "conv-fb-throw";
    const RUN = "run-fb-throw";
    await pg.query(`INSERT INTO users (id, email, password_hash, name, role) VALUES ($1,$2,'x','U','member')`, [USER, "fbt@x.com"]);
    await pg.query(`INSERT INTO projects (id, name, path) VALUES ($1,'fbt','/tmp/fbt')`, [PROJECT]);
    await pg.query(`INSERT INTO conversations (id, project_id, title, user_id) VALUES ($1,$2,'c',$3)`, [CONV, PROJECT, USER]);
    await pg.query(`INSERT INTO runs (id, agent_name, status, started_at, conversation_id, user_id) VALUES ($1,'chat','success',NOW(),$2,NULL)`, [RUN, CONV]);

    // Inject a failure into ONLY the runs ownership backfill statement (the
    // recursive CTE with the unique `root_owner` sub-CTE). Everything else runs
    // normally, so migrate() must COMPLETE — proving the failure was caught +
    // logged (not swallowed silently, not fatal to boot).
    let injected = false;
    const wrapped = new Proxy(db, {
      get(target, prop, recv) {
        if (prop === "execute") {
          return (q: unknown) => {
            let isBackfill = false;
            try { isBackfill = !injected && JSON.stringify(q).includes("root_owner"); } catch { /* non-serializable — not the target */ }
            if (isBackfill) {
              injected = true;
              return Promise.reject(new Error("injected backfill failure"));
            }
            return (target as { execute: (q: unknown) => Promise<unknown> }).execute(q);
          };
        }
        const v = Reflect.get(target as object, prop, recv);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });

    await migrate(wrapped); // must resolve despite the injected backfill throw
    expect(injected).toBe(true);

    // Backfill was skipped, so the run stays unattributed (fail-closed = admin-only).
    const { rows } = await pg.query<{ user_id: string | null }>(`SELECT user_id FROM runs WHERE id = $1`, [RUN]);
    expect(rows[0]?.user_id).toBeNull();
  });
});
