import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const connection = await import("../db/connection");
const { createUserCommand, listUserCommands } = await import(
  "../db/queries/user-commands"
);
const { createUser } = await import("../db/queries/users");

/**
 * Race-window coverage for `createUserCommand`. The happy-path
 * `findFreeName` pre-flight removes 23505s in the single-writer case,
 * but two concurrent POSTs for the same desired name compute the same
 * suffix and the loser's INSERT raises a unique violation. The query
 * layer catches that and retries with the now-bumped suffix.
 *
 * Strategy: monkey-patch `db.insert` to throw a synthetic 23505 on the
 * FIRST call, then restore the real method. The retry path then runs
 * against the real DB and the row lands with a bumped suffix.
 *
 * Asserts that:
 *   - createUserCommand does NOT propagate the 23505 to the caller
 *     (no 500 in production).
 *   - The returned row has a suffix-bumped name, not the originally-
 *     requested one.
 *   - Exactly one row is persisted (the retry didn't double-insert).
 *   - Non-23505 errors bubble (the retry loop is narrow, not blanket).
 */
describe("createUserCommand race-on-23505", () => {
  let userId: string;

  beforeEach(async () => {
    await setupTestDb();
    const u = await createUser({
      email: "race@test.com",
      passwordHash: "h",
      name: "Race",
    });
    userId = u.id;
  });
  afterAll(async () => await closeTestDb());

  function makeUniqueViolation(): Error & { code: string; constraint: string } {
    // Mirror the shape that `pg` (and PGlite's postgres-wire wrapper)
    // put on the thrown error. The query layer's `isUniqueViolation`
    // detector checks `code === "23505"` and `constraint` substring —
    // both are wired here so the test exercises both detection paths.
    const e = new Error(
      'duplicate key value violates unique constraint "uq_user_commands_user_name"',
    ) as Error & { code: string; constraint: string };
    e.code = "23505";
    e.constraint = "uq_user_commands_user_name";
    return e;
  }

  /**
   * Replace `db.insert` with a one-shot that throws `err` on first
   * invocation, then restores the real `insert` so subsequent retries
   * (and any cleanup) run against the real driver.
   */
  function armOneShotInsertFailure(err: Error): { fired: () => boolean } {
    const db = connection.getDb() as unknown as {
      insert: (...args: unknown[]) => unknown;
    };
    const realInsert = db.insert.bind(db);
    let fired = false;
    db.insert = ((...args: unknown[]) => {
      if (fired) {
        // Defensive: restore-on-first should have already swapped us
        // out, but keep this branch so a double-fire still degrades
        // to the real driver instead of looping.
        return realInsert(...args);
      }
      fired = true;
      db.insert = realInsert;
      return {
        values: () => Promise.reject(err),
      };
    }) as typeof db.insert;
    return { fired: () => fired };
  }

  test("retry-on-23505 surfaces the suffix-bumped name instead of 500", async () => {
    // Seed a `review` row so the racer scenario is realistic:
    // findFreeName resolves `review-2`, the intercept fires a 23505,
    // and retry's findFreeName must re-see the same taken-set and
    // resolve a different free name on the second pass.
    const seed = await createUserCommand({
      userId,
      name: "review",
      body: "seed",
    });
    expect(seed.name).toBe("review");

    const armed = armOneShotInsertFailure(makeUniqueViolation());

    const created = await createUserCommand({
      userId,
      name: "review",
      body: "racer wins on retry",
    });

    expect(armed.fired()).toBe(true);
    // First pass resolved `review-2` and failed; retry's findFreeName
    // still sees only `review` taken (the failed insert never landed)
    // so it resolves `review-2` again and the second attempt succeeds.
    expect(created.name).toBe("review-2");
    expect(created.body).toBe("racer wins on retry");

    // No double-insert from the retry — exactly seed + one new row.
    const list = await listUserCommands(userId);
    expect(list).toHaveLength(2);
    expect(list.map((r) => r.name).sort()).toEqual(["review", "review-2"]);
  });

  test("non-23505 errors are re-thrown, not silently retried", async () => {
    const db = connection.getDb() as unknown as {
      insert: (...args: unknown[]) => unknown;
    };
    const realInsert = db.insert.bind(db);
    // Permanent (not one-shot) failure with a non-unique code: the
    // detector must NOT classify it as 23505 and the caller must see
    // it bubble immediately.
    db.insert = (() => ({
      values: () => {
        const e = new Error("simulated FK violation") as Error & { code: string };
        e.code = "23503"; // foreign_key_violation
        return Promise.reject(e);
      },
    })) as typeof db.insert;

    let caught: unknown;
    try {
      await createUserCommand({ userId, name: "anything", body: "x" });
    } catch (e) {
      caught = e;
    } finally {
      db.insert = realInsert;
    }
    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe("23503");
  });
});
