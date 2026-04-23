import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const {
  persistError,
  countErrors,
  listErrors,
  cleanupOldErrors,
} = await import("../db/queries/error-logs");

describe("error-logs queries", () => {
  beforeEach(async () => await setupTestDb());
  afterAll(async () => await closeTestDb());

  test("persistError writes a row", async () => {
    await persistError({ level: "error", message: "boom" });
    expect(await countErrors()).toBe(1);
    const rows = await listErrors();
    expect(rows[0]!.message).toBe("boom");
    expect(rows[0]!.level).toBe("error");
    expect(rows[0]!.stack).toBeNull();
    expect(rows[0]!.metadata).toBeNull();
  });

  test("persistError stores stack and metadata", async () => {
    await persistError({
      level: "warn",
      message: "with details",
      stack: "Error: x\n  at y",
      metadata: { kind: "test", n: 42 },
    });
    const [row] = await listErrors();
    expect(row!.stack).toBe("Error: x\n  at y");
    expect(row!.metadata).toEqual({ kind: "test", n: 42 });
  });

  test("countErrors returns 0 on empty", async () => {
    expect(await countErrors()).toBe(0);
  });

  test("listErrors orders most-recent-first and respects limit/offset", async () => {
    for (let i = 0; i < 5; i++) {
      await persistError({ level: "info", message: `msg-${i}` });
      // small delay to ensure ordering by createdAt
      await new Promise((r) => setTimeout(r, 2));
    }
    const all = await listErrors();
    expect(all.length).toBe(5);
    // Most recent first: msg-4 should come first
    expect(all[0]!.message).toBe("msg-4");
    expect(all[4]!.message).toBe("msg-0");

    const limited = await listErrors({ limit: 2 });
    expect(limited.length).toBe(2);

    const offset = await listErrors({ limit: 2, offset: 2 });
    expect(offset.length).toBe(2);
    expect(offset[0]!.message).toBe("msg-2");
  });

  test("persistError swallows DB errors silently", async () => {
    // Pass an invalid level type via cast to a non-string — exercises the
    // try/catch in persistError. We just want it to NOT throw.
    expect(
      persistError({ level: null as unknown as string, message: "x" }),
    ).resolves.toBeUndefined();
  });

  test("cleanupOldErrors removes rows older than retention period", async () => {
    await persistError({ level: "info", message: "stays" });
    // 0-day retention means everything older than NOW is purged. Since
    // createdAt defaults to NOW(), we need a tiny pause for the row's
    // timestamp to be < NOW() during the delete.
    await new Promise((r) => setTimeout(r, 50));

    const deleted = await cleanupOldErrors(0);
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(await countErrors()).toBe(0);
  });

  test("cleanupOldErrors with long retention removes nothing", async () => {
    await persistError({ level: "info", message: "fresh" });
    const deleted = await cleanupOldErrors(365);
    expect(deleted).toBe(0);
    expect(await countErrors()).toBe(1);
  });
});
