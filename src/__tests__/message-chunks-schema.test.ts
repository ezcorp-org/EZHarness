/**
 * Phase 63 Plan 02 — message_chunks + message_embed_outbox schema policy.
 *
 * Pins the durable storage shape the Phase 63/64/65 hybrid-search stack
 * builds on. After migrate() runs against PGlite:
 *
 *   1. message_chunks carries a vector(384) embedding on an HNSW index
 *      (indexdef ILIKE '%hnsw%' AND vector_cosine_ops) — NEVER ivfflat
 *      (locked carry-forward; the index type is the load-bearing choice).
 *   2. message_chunks.embedding_model_id — text, NOT NULL (records which
 *      model produced each chunk so a model swap is detectable).
 *   3. An `embedding` column of vector type round-trips a 384-element
 *      literal.
 *   4. ON DELETE CASCADE via the message: deleting a message removes its
 *      message_chunks rows.
 *   5. ON DELETE CASCADE via the conversation (chained through messages):
 *      deleting the parent conversation removes its message_chunks rows.
 *   6. message_embed_outbox: message_id PRIMARY KEY (one row per message)
 *      + status/attempts/timestamps; the PK is the ON CONFLICT target.
 *
 * The idempotency suite catches non-idempotent DDL but would NOT catch a
 * regression that flipped HNSW→ivfflat or CASCADE→SET NULL. This suite
 * pins the index type + FK actions behaviorally.
 *
 * Note: embedding_model_id is stamped with the literal "Xenova/all-MiniLM-L6-v2"
 * (the model embeddings.ts loads) rather than importing a shared constant —
 * the column only requires a NOT NULL text value and this keeps the test
 * self-contained.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb, getTestDb, closeTestDb } from "./helpers/test-pglite";
import { toVectorLiteral } from "../memory/vector-utils";
import { EMBEDDING_DIMENSIONS } from "../memory/types";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

function makeEmbedding(): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i % 7) * 0.001);
}

// Insert project → conversation → message → message_chunks; return the ids.
async function seedChunk(db: any): Promise<{ projectId: string; conversationId: string; messageId: string; chunkId: string }> {
  const projectId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const chunkId = crypto.randomUUID();
  const vecLit = toVectorLiteral(makeEmbedding());

  await db.execute(sql`INSERT INTO projects (id, name, path) VALUES (${projectId}, 'p', '/p')`);
  await db.execute(sql`INSERT INTO conversations (id, project_id, title) VALUES (${conversationId}, ${projectId}, 'c')`);
  await db.execute(sql`INSERT INTO messages (id, conversation_id, role, content) VALUES (${messageId}, ${conversationId}, 'user', 'hello world')`);
  await db.execute(sql.raw(
    `INSERT INTO message_chunks (id, message_id, conversation_id, content, chunk_index, embedding, embedding_model_id) ` +
    `VALUES ('${chunkId}', '${messageId}', '${conversationId}', 'hello world', 0, ${vecLit}, '${MODEL_ID}')`,
  ));

  return { projectId, conversationId, messageId, chunkId };
}

async function chunkCount(db: any, messageId: string): Promise<number> {
  const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM message_chunks WHERE message_id = ${messageId}`)).rows as Array<{ n: number }>;
  return rows[0]?.n ?? -1;
}

describe("message_chunks + message_embed_outbox schema", () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  test("message_chunks.embedding has an HNSW index (vector_cosine_ops), NOT ivfflat", async () => {
    const db = getTestDb();
    const rows = (await db.execute(sql`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'message_chunks'
    `)).rows as Array<{ indexname: string; indexdef: string }>;

    const hnsw = rows.filter((r) => /hnsw/i.test(r.indexdef));
    expect(hnsw.length).toBeGreaterThanOrEqual(1);
    expect(hnsw.some((r) => r.indexdef.includes("vector_cosine_ops"))).toBe(true);
    // Locked carry-forward: ivfflat must never appear.
    expect(rows.some((r) => /ivfflat/i.test(r.indexdef))).toBe(false);
  });

  test("message_chunks.embedding_model_id is text NOT NULL", async () => {
    const db = getTestDb();
    const rows = (await db.execute(sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'message_chunks'
        AND column_name = 'embedding_model_id'
    `)).rows as Array<{ column_name: string; data_type: string; is_nullable: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("text");
    expect(rows[0].is_nullable).toBe("NO");
  });

  test("message_chunks.embedding is a vector column that round-trips a 384-element literal", async () => {
    const db = getTestDb();
    const colRows = (await db.execute(sql`
      SELECT udt_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'message_chunks'
        AND column_name = 'embedding'
    `)).rows as Array<{ udt_name: string }>;
    expect(colRows).toHaveLength(1);
    expect(colRows[0].udt_name).toBe("vector");

    const { messageId, chunkId } = await seedChunk(db);
    const read = (await db.execute(sql`SELECT embedding FROM message_chunks WHERE id = ${chunkId}`)).rows as Array<{ embedding: unknown }>;
    expect(read).toHaveLength(1);
    expect(read[0].embedding).toBeTruthy();
    // Clean up so later CASCADE probes start from a known state.
    await db.execute(sql`DELETE FROM messages WHERE id = ${messageId}`);
  });

  test("ON DELETE CASCADE via message: deleting a message removes its message_chunks", async () => {
    const db = getTestDb();
    const { messageId } = await seedChunk(db);

    expect(await chunkCount(db, messageId)).toBe(1);
    await db.execute(sql`DELETE FROM messages WHERE id = ${messageId}`);
    expect(await chunkCount(db, messageId)).toBe(0);
  });

  test("ON DELETE CASCADE via conversation (chained): deleting the conversation removes its message_chunks", async () => {
    const db = getTestDb();
    const { conversationId, messageId } = await seedChunk(db);

    expect(await chunkCount(db, messageId)).toBe(1);
    await db.execute(sql`DELETE FROM conversations WHERE id = ${conversationId}`);
    expect(await chunkCount(db, messageId)).toBe(0);
  });

  test("message_embed_outbox has message_id as PRIMARY KEY (one row per message)", async () => {
    const db = getTestDb();
    const pkRows = (await db.execute(sql`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = 'public'
        AND tc.table_name = 'message_embed_outbox'
        AND tc.constraint_type = 'PRIMARY KEY'
    `)).rows as Array<{ column_name: string }>;
    expect(pkRows.map((r) => r.column_name)).toEqual(["message_id"]);

    // Behavioral: a second insert for the same message_id must collide.
    const projectId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    await db.execute(sql`INSERT INTO projects (id, name, path) VALUES (${projectId}, 'p', '/p')`);
    await db.execute(sql`INSERT INTO conversations (id, project_id, title) VALUES (${conversationId}, ${projectId}, 'c')`);
    await db.execute(sql`INSERT INTO messages (id, conversation_id, role, content) VALUES (${messageId}, ${conversationId}, 'user', 'x')`);
    await db.execute(sql`INSERT INTO message_embed_outbox (message_id, conversation_id) VALUES (${messageId}, ${conversationId})`);

    let collided = false;
    try {
      await db.execute(sql`INSERT INTO message_embed_outbox (message_id, conversation_id) VALUES (${messageId}, ${conversationId})`);
    } catch {
      collided = true;
    }
    expect(collided).toBe(true);

    // Defaults: status 'pending', attempts 0.
    const row = (await db.execute(sql`SELECT status, attempts FROM message_embed_outbox WHERE message_id = ${messageId}`)).rows as Array<{ status: string; attempts: number }>;
    expect(row[0].status).toBe("pending");
    expect(Number(row[0].attempts)).toBe(0);
  });

  test("message_embed_outbox row is cascaded away with its message", async () => {
    const db = getTestDb();
    const projectId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    await db.execute(sql`INSERT INTO projects (id, name, path) VALUES (${projectId}, 'p', '/p')`);
    await db.execute(sql`INSERT INTO conversations (id, project_id, title) VALUES (${conversationId}, ${projectId}, 'c')`);
    await db.execute(sql`INSERT INTO messages (id, conversation_id, role, content) VALUES (${messageId}, ${conversationId}, 'user', 'x')`);
    await db.execute(sql`INSERT INTO message_embed_outbox (message_id, conversation_id) VALUES (${messageId}, ${conversationId})`);

    await db.execute(sql`DELETE FROM messages WHERE id = ${messageId}`);
    const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM message_embed_outbox WHERE message_id = ${messageId}`)).rows as Array<{ n: number }>;
    expect(rows[0].n).toBe(0);
  });
});
