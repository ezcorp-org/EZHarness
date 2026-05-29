/**
 * Phase 65 Plan 01 — message-grained Reciprocal Rank Fusion search.
 *
 * RED-first scaffold (Nyquist Wave-0): imports `searchMessages` + `RRF_K` from
 * `../db/queries/message-search`, which does NOT exist until Task 1. These tests
 * therefore fail to resolve the module until the GREEN implementation lands.
 *
 * The seed corpus (built test-local against real PGlite) exercises every
 * contract row the Phase-65 must_haves require:
 *   - cross-project + cross-user leak guards,
 *   - test=true conversation exclusion,
 *   - system/tool role exclusion,
 *   - lexical-only / semantic-only / both match types,
 *   - a long two-chunk message that DISTINCT ON (message_id) collapses to one hit,
 *   - honest asymmetric snippets (<mark> for lexical/both, plain slice for semantic).
 *
 * Deterministic vectors: a fixed 384-dim query vector Q (unit on axis 0), a
 * "near" chunk vector (also axis 0 → cosine distance ~0) and a "far" chunk
 * vector (axis 1 → orthogonal → cosine distance ~1). Lexical separation is done
 * with disjoint vocabularies so FTS overlap is controllable independently of the
 * vector geometry.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { searchMessages, RRF_K } = await import("../db/queries/message-search");
const { EMBEDDING_MODEL_ID } = await import("../memory/embeddings");
const { projects, users, conversations, messages } = await import("../db/schema");
const { sql } = await import("drizzle-orm");
const { toVectorLiteral } = await import("../memory/vector-utils");

const DIM = 384;

/** Unit vector pointing along a single axis — controls cosine distance to Q. */
function axisVector(axis: number): number[] {
  const v = new Array(DIM).fill(0);
  v[axis] = 1;
  return v;
}

// Query vector: along axis 0. "near" chunks share axis 0 (cosine dist ~0).
// Lexical-only rows are kept out of the semantic leg via a NULL embedding
// rather than a "far" vector — pgvector ANN returns nearest-K regardless of
// absolute distance, so a merely-distant vector would still surface in a tiny
// seed corpus.
const QUERY_VECTOR = axisVector(0);
const NEAR = axisVector(0);

/** Raw chunk insert — embedding column needs the ::vector literal, so go raw. */
async function insertChunk(
  messageId: string,
  conversationId: string,
  content: string,
  chunkIndex: number,
  embedding: number[] | null,
): Promise<void> {
  const db = getTestDb();
  // Raw SQL bypasses drizzle's $defaultFn for `id`, so supply one explicitly.
  const id = crypto.randomUUID();
  if (embedding === null) {
    await db.execute(sql`
      INSERT INTO message_chunks (id, message_id, conversation_id, content, chunk_index, embedding_model_id)
      VALUES (${id}, ${messageId}, ${conversationId}, ${content}, ${chunkIndex}, ${EMBEDDING_MODEL_ID})
    `);
    return;
  }
  const lit = toVectorLiteral(embedding);
  await db.execute(sql`
    INSERT INTO message_chunks (id, message_id, conversation_id, content, chunk_index, embedding, embedding_model_id)
    VALUES (${id}, ${messageId}, ${conversationId}, ${content}, ${chunkIndex}, ${sql.raw(lit)}, ${EMBEDDING_MODEL_ID})
  `);
}

interface Seed {
  projectA: string;
  userA: string;
  // message ids by role in the corpus
  lexicalOnly: string;
  semanticOnly: string;
  both: string;
  longTwoChunk: string;
  crossProject: string;
  crossUser: string;
  testConvMsg: string;
  systemMsg: string;
  toolMsg: string;
}

/**
 * Seed corpus. The query string used by the assertions is "lexicon hybrid
 * fusion" — shared lexical vocabulary. Semantic-only content uses a disjoint
 * vocabulary ("zebra umbrella kangaroo") so it has NO FTS overlap.
 */
async function seed(): Promise<Seed> {
  const db = getTestDb();

  const [pa] = await db.insert(projects).values({ name: "A", path: "/tmp/a" }).returning();
  const [pb] = await db.insert(projects).values({ name: "B", path: "/tmp/b" }).returning();
  const [ua] = await db
    .insert(users)
    .values({ email: "ua@x.com", passwordHash: "h", name: "ua" })
    .returning();
  const [ub] = await db
    .insert(users)
    .values({ email: "ub@x.com", passwordHash: "h", name: "ub" })
    .returning();

  const projectA = pa!.id;
  const projectB = pb!.id;
  const userA = ua!.id;
  const userB = ub!.id;

  // ── Target conversation (Project A / userA) ──
  const [convA] = await db
    .insert(conversations)
    .values({ projectId: projectA, userId: userA, title: "Target", test: false })
    .returning();
  const convAId = convA!.id;

  // lexical-only: shares query terms, but has NO embedded chunk (NULL embedding),
  // so the `embedding IS NOT NULL` filter keeps it out of the semantic leg
  // entirely — the honest lexical-only signal.
  const [lex] = await db
    .insert(messages)
    .values({ conversationId: convAId, role: "user", content: "lexicon hybrid fusion ranking discussion" })
    .returning();
  await insertChunk(lex!.id, convAId, "lexicon hybrid fusion ranking discussion", 0, null);

  // semantic-only: chunk vector NEAR Q, but NO FTS term overlap with the query.
  const [sem] = await db
    .insert(messages)
    .values({ conversationId: convAId, role: "assistant", content: "zebra umbrella kangaroo orbit melody" })
    .returning();
  await insertChunk(sem!.id, convAId, "zebra umbrella kangaroo orbit melody", 0, NEAR);

  // both: lexical overlap AND a near chunk vector.
  const [both] = await db
    .insert(messages)
    .values({ conversationId: convAId, role: "user", content: "hybrid fusion lexicon combined approach" })
    .returning();
  await insertChunk(both!.id, convAId, "hybrid fusion lexicon combined approach", 0, NEAR);

  // long two-chunk message: both chunks near Q, no lexical overlap → semantic.
  // DISTINCT ON (message_id) must collapse it to exactly one hit.
  const [long] = await db
    .insert(messages)
    .values({ conversationId: convAId, role: "assistant", content: "saxophone glacier velvet tundra" })
    .returning();
  await insertChunk(long!.id, convAId, "saxophone glacier velvet first-chunk", 0, NEAR);
  await insertChunk(long!.id, convAId, "tundra velvet second-chunk", 1, NEAR);

  // ── Cross-project leak guard (Project B / userB) — must NOT appear ──
  const [convB] = await db
    .insert(conversations)
    .values({ projectId: projectB, userId: userB, title: "OtherProject", test: false })
    .returning();
  const [xProj] = await db
    .insert(messages)
    .values({ conversationId: convB!.id, role: "user", content: "lexicon hybrid fusion in project B" })
    .returning();
  await insertChunk(xProj!.id, convB!.id, "lexicon hybrid fusion in project B", 0, NEAR);

  // ── Cross-user leak guard (Project A but userB) — must NOT appear for userA ──
  const [convAU] = await db
    .insert(conversations)
    .values({ projectId: projectA, userId: userB, title: "OtherUser", test: false })
    .returning();
  const [xUser] = await db
    .insert(messages)
    .values({ conversationId: convAU!.id, role: "user", content: "lexicon hybrid fusion by another user" })
    .returning();
  await insertChunk(xUser!.id, convAU!.id, "lexicon hybrid fusion by another user", 0, NEAR);

  // ── test=true conversation (Project A / userA) — must NOT appear ──
  const [convTest] = await db
    .insert(conversations)
    .values({ projectId: projectA, userId: userA, title: "Scratch", test: true })
    .returning();
  const [testMsg] = await db
    .insert(messages)
    .values({ conversationId: convTest!.id, role: "user", content: "lexicon hybrid fusion in a test conversation" })
    .returning();
  await insertChunk(testMsg!.id, convTest!.id, "lexicon hybrid fusion in a test conversation", 0, NEAR);

  // ── system + tool role messages (Project A / userA) — must NOT appear ──
  const [convSys] = await db
    .insert(conversations)
    .values({ projectId: projectA, userId: userA, title: "WithSystem", test: false })
    .returning();
  const [sysMsg] = await db
    .insert(messages)
    .values({ conversationId: convSys!.id, role: "system", content: "lexicon hybrid fusion system prompt" })
    .returning();
  await insertChunk(sysMsg!.id, convSys!.id, "lexicon hybrid fusion system prompt", 0, NEAR);
  const [toolMsg] = await db
    .insert(messages)
    .values({ conversationId: convSys!.id, role: "tool", content: "lexicon hybrid fusion tool output" })
    .returning();
  await insertChunk(toolMsg!.id, convSys!.id, "lexicon hybrid fusion tool output", 0, NEAR);

  return {
    projectA,
    userA,
    lexicalOnly: lex!.id,
    semanticOnly: sem!.id,
    both: both!.id,
    longTwoChunk: long!.id,
    crossProject: xProj!.id,
    crossUser: xUser!.id,
    testConvMsg: testMsg!.id,
    systemMsg: sysMsg!.id,
    toolMsg: toolMsg!.id,
  };
}

const QUERY = "lexicon hybrid fusion";

describe("searchMessages — RRF / mode / scoping / snippet / match-type", () => {
  let s: Seed;
  beforeEach(async () => {
    await setupTestDb();
    s = await seed();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  test("RRF_K is the documented k=60 tune point", () => {
    expect(RRF_K).toBe(60);
  });

  test("SRCH-02: hybrid fuses both legs — the BOTH message tags 'both' and outranks single-leg rows", async () => {
    const hits = await searchMessages({
      projectId: s.projectA,
      userId: s.userA,
      query: QUERY,
      mode: "hybrid",
      queryEmbedding: QUERY_VECTOR,
    });

    // one fused set, no duplicate message ids
    const ids = hits.map((h) => h.messageId);
    expect(new Set(ids).size).toBe(ids.length);

    const both = hits.find((h) => h.messageId === s.both);
    const lex = hits.find((h) => h.messageId === s.lexicalOnly);
    const sem = hits.find((h) => h.messageId === s.semanticOnly);
    expect(both).toBeDefined();
    expect(both!.matchType).toBe("both");

    // 'both' fuses two legs → strictly higher than either single-leg hit.
    if (lex) expect(both!.score).toBeGreaterThan(lex.score);
    if (sem) expect(both!.score).toBeGreaterThan(sem.score);
  });

  test("Q1: hybrid fused score equals 1/(K+rank_v) + 1/(K+rank_k) per row", async () => {
    const hits = await searchMessages({
      projectId: s.projectA,
      userId: s.userA,
      query: QUERY,
      mode: "hybrid",
      queryEmbedding: QUERY_VECTOR,
    });
    for (const h of hits) {
      const expected =
        (h.rankSemantic != null ? 1 / (RRF_K + h.rankSemantic) : 0) +
        (h.rankLexical != null ? 1 / (RRF_K + h.rankLexical) : 0);
      expect(h.score).toBeCloseTo(expected, 6);
    }
  });

  test("SRCH-03: mode=keyword returns only lexical/both rows", async () => {
    const hits = await searchMessages({
      projectId: s.projectA,
      userId: s.userA,
      query: QUERY,
      mode: "keyword",
      queryEmbedding: QUERY_VECTOR,
    });
    const ids = hits.map((h) => h.messageId);
    expect(ids).toContain(s.lexicalOnly);
    expect(ids).toContain(s.both);
    expect(ids).not.toContain(s.semanticOnly);
    expect(ids).not.toContain(s.longTwoChunk);
    for (const h of hits) expect(h.matchType).toBe("lexical");
  });

  test("SRCH-03: mode=semantic returns only semantic/both rows", async () => {
    const hits = await searchMessages({
      projectId: s.projectA,
      userId: s.userA,
      query: QUERY,
      mode: "semantic",
      queryEmbedding: QUERY_VECTOR,
    });
    const ids = hits.map((h) => h.messageId);
    expect(ids).toContain(s.semanticOnly);
    expect(ids).toContain(s.both);
    expect(ids).toContain(s.longTwoChunk);
    expect(ids).not.toContain(s.lexicalOnly);
    for (const h of hits) expect(h.matchType).toBe("semantic");
  });

  test("SRCH-03: hybrid is the default behaviour (both legs present)", async () => {
    const hits = await searchMessages({
      projectId: s.projectA,
      userId: s.userA,
      query: QUERY,
      mode: "hybrid",
      queryEmbedding: QUERY_VECTOR,
    });
    const ids = hits.map((h) => h.messageId);
    // hybrid sees lexical-only AND semantic-only AND both
    expect(ids).toContain(s.lexicalOnly);
    expect(ids).toContain(s.semanticOnly);
    expect(ids).toContain(s.both);
  });

  test("SRCH-04: hits are scoped to Project A + userA; leaks and excluded roles never appear", async () => {
    const hits = await searchMessages({
      projectId: s.projectA,
      userId: s.userA,
      query: QUERY,
      mode: "hybrid",
      queryEmbedding: QUERY_VECTOR,
    });
    const ids = hits.map((h) => h.messageId);
    expect(ids).not.toContain(s.crossProject);
    expect(ids).not.toContain(s.crossUser);
    expect(ids).not.toContain(s.testConvMsg);
    expect(ids).not.toContain(s.systemMsg);
    expect(ids).not.toContain(s.toolMsg);
  });

  test("SRCH-06: lexical/both snippet contains <mark>; semantic-only snippet is a plain slice", async () => {
    const hits = await searchMessages({
      projectId: s.projectA,
      userId: s.userA,
      query: QUERY,
      mode: "hybrid",
      queryEmbedding: QUERY_VECTOR,
    });
    const both = hits.find((h) => h.messageId === s.both)!;
    const lex = hits.find((h) => h.messageId === s.lexicalOnly)!;
    const sem = hits.find((h) => h.messageId === s.semanticOnly)!;

    expect(both.snippet).toContain("<mark>");
    expect(lex.snippet).toContain("<mark>");
    // semantic-only: no highlight, plain leading slice of the matched chunk.
    expect(sem.snippet).not.toContain("<mark>");
    expect(sem.snippet.length).toBeGreaterThan(0);
    expect("zebra umbrella kangaroo orbit melody").toContain(sem.snippet.split(" ")[0]!);
  });

  test("SRCH-07: matchType is lexical / semantic / both per the seeded rows", async () => {
    const hits = await searchMessages({
      projectId: s.projectA,
      userId: s.userA,
      query: QUERY,
      mode: "hybrid",
      queryEmbedding: QUERY_VECTOR,
    });
    expect(hits.find((h) => h.messageId === s.lexicalOnly)!.matchType).toBe("lexical");
    expect(hits.find((h) => h.messageId === s.semanticOnly)!.matchType).toBe("semantic");
    expect(hits.find((h) => h.messageId === s.both)!.matchType).toBe("both");
  });

  test("DISTINCT-ON: the long two-chunk message appears exactly once", async () => {
    const hits = await searchMessages({
      projectId: s.projectA,
      userId: s.userA,
      query: QUERY,
      mode: "semantic",
      queryEmbedding: QUERY_VECTOR,
    });
    const occurrences = hits.filter((h) => h.messageId === s.longTwoChunk);
    expect(occurrences.length).toBe(1);
  });

  test("<2-char guard: a one-char query returns [] without touching SQL", async () => {
    const hits = await searchMessages({
      projectId: s.projectA,
      userId: s.userA,
      query: "a",
      mode: "hybrid",
      queryEmbedding: QUERY_VECTOR,
    });
    expect(hits).toEqual([]);

    const blank = await searchMessages({
      projectId: s.projectA,
      userId: s.userA,
      query: "   ",
      mode: "hybrid",
      queryEmbedding: QUERY_VECTOR,
    });
    expect(blank).toEqual([]);
  });

  test("hit shape carries conversation + message metadata for Wave 2", async () => {
    const hits = await searchMessages({
      projectId: s.projectA,
      userId: s.userA,
      query: QUERY,
      mode: "hybrid",
      queryEmbedding: QUERY_VECTOR,
    });
    const both = hits.find((h) => h.messageId === s.both)!;
    expect(typeof both.conversationId).toBe("string");
    expect(both.conversationTitle).toBe("Target");
    expect(both.role).toBe("user");
    expect(both.createdAt instanceof Date).toBe(true);
    expect(typeof both.score).toBe("number");
  });

  test("omitting userId widens scope to the whole project (still no cross-project / test / role leaks)", async () => {
    const hits = await searchMessages({
      projectId: s.projectA,
      query: QUERY,
      mode: "hybrid",
      queryEmbedding: QUERY_VECTOR,
    });
    const ids = hits.map((h) => h.messageId);
    // userB's Project-A conversation now visible (no userId filter)…
    expect(ids).toContain(s.crossUser);
    // …but cross-project, test=true, and system/tool stay excluded.
    expect(ids).not.toContain(s.crossProject);
    expect(ids).not.toContain(s.testConvMsg);
    expect(ids).not.toContain(s.systemMsg);
    expect(ids).not.toContain(s.toolMsg);
  });
});
