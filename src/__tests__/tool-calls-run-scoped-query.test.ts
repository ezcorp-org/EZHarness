/**
 * `listToolCallsByConversation` — the lessons trigger gate's tool-call
 * feed, pinned against a real PGlite DB (FKs enforced).
 *
 * The gate reads two signals off these rows (`toolCallCount`,
 * `errorRecoveryObserved`). Both are sticky when the scan covers the
 * conversation's whole lifetime: once a conversation has ever made 5
 * tool calls, every later turn fires the distiller — a paid LLM call and
 * a lesson write per turn. The optional `sinceMs` argument narrows the
 * scan to the run that just finished. Contract pinned here:
 *
 *   - no `sinceMs` → every row in the conversation, `created_at` ASC
 *     (row ORDER is load-bearing for the error-recovery detector),
 *   - `sinceMs` → only rows at or after that instant (boundary
 *     INCLUSIVE — a run's first tool call must not be dropped),
 *   - other conversations' rows never leak in under either mode,
 *   - empty conversationId → [] without touching the DB.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, getTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { listToolCallsByConversation } from "../db/queries/tool-calls";
import { users, projects, conversations, extensions, toolCalls } from "../db/schema";

const CONV_ID = "conv-run-scope";
const OTHER_CONV_ID = "conv-run-scope-other";
const EXT_ID = "ext-run-scope";

/** The finished run's `startedAt`. Rows straddle it on both sides. */
const RUN_STARTED_MS = Date.UTC(2026, 6, 31, 12, 0, 0);

beforeAll(async () => {
  await setupTestDb();
  const db = getTestDb();
  await db.insert(users).values({
    id: "user-run-scope", email: "run-scope@t.local", passwordHash: "x", name: "r",
  } as never);
  await db.insert(projects).values({
    id: "proj-run-scope", name: "proj-run-scope", path: "/tmp/proj-run-scope",
  } as never);
  for (const id of [CONV_ID, OTHER_CONV_ID]) {
    await db.insert(conversations).values({
      id, projectId: "proj-run-scope", title: id,
    } as never);
  }
  await db.insert(extensions).values({
    id: EXT_ID, name: EXT_ID, version: "1.0.0", description: "t",
    manifest: {
      schemaVersion: 2, name: EXT_ID, version: "1.0.0", description: "",
      author: { name: "t" }, permissions: {},
    } as never,
    source: `test:${EXT_ID}`, installPath: `/tmp/${EXT_ID}`, enabled: true,
    grantedPermissions: { grantedAt: {} } as never,
  } as never);

  // Inserted out of chronological order on purpose so the ORDER BY is
  // doing real work. `persistToolCall` can't set `created_at`, so these
  // go in directly.
  const rows: Array<{ id: string; conv: string; success: boolean; atMs: number }> = [
    // Previous runs in the same conversation.
    { id: "tc-old-1", conv: CONV_ID, success: false, atMs: RUN_STARTED_MS - 120_000 },
    { id: "tc-old-2", conv: CONV_ID, success: true, atMs: RUN_STARTED_MS - 60_000 },
    // Exactly at the boundary — the run's FIRST tool call.
    { id: "tc-run-1", conv: CONV_ID, success: false, atMs: RUN_STARTED_MS },
    { id: "tc-run-2", conv: CONV_ID, success: true, atMs: RUN_STARTED_MS + 5_000 },
    // A different conversation, in the same window.
    { id: "tc-other", conv: OTHER_CONV_ID, success: true, atMs: RUN_STARTED_MS + 1_000 },
  ];
  for (const r of [rows[3], rows[0], rows[4], rows[2], rows[1]]) {
    await getTestDb().insert(toolCalls).values({
      id: r!.id,
      conversationId: r!.conv,
      messageId: null,
      extensionId: EXT_ID,
      toolName: "t",
      input: {},
      output: { content: [] },
      success: r!.success,
      durationMs: 1,
      createdAt: new Date(r!.atMs),
    } as never);
  }
});

afterAll(async () => {
  await closeTestDb();
});

describe("listToolCallsByConversation", () => {
  test("without sinceMs returns every row for the conversation, created_at ASC", async () => {
    const rows = await listToolCallsByConversation(CONV_ID);
    // 4 rows, oldest first — the other conversation's row is excluded.
    expect(rows).toEqual([
      { success: false },
      { success: true },
      { success: false },
      { success: true },
    ]);
  });

  test("with sinceMs returns only rows at or after that instant (boundary inclusive)", async () => {
    const rows = await listToolCallsByConversation(CONV_ID, RUN_STARTED_MS);
    // Just the two run rows — `tc-run-1` sits exactly on the boundary
    // and must survive, or a run's first tool call vanishes.
    expect(rows).toEqual([{ success: false }, { success: true }]);
  });

  test("sinceMs after the last row returns an empty scan", async () => {
    const rows = await listToolCallsByConversation(CONV_ID, RUN_STARTED_MS + 60_000);
    expect(rows).toEqual([]);
  });

  test("sinceMs does not admit another conversation's rows", async () => {
    const rows = await listToolCallsByConversation(OTHER_CONV_ID, RUN_STARTED_MS);
    expect(rows).toEqual([{ success: true }]);
  });

  test("empty conversationId short-circuits to []", async () => {
    expect(await listToolCallsByConversation("")).toEqual([]);
    expect(await listToolCallsByConversation("", RUN_STARTED_MS)).toEqual([]);
  });
});
