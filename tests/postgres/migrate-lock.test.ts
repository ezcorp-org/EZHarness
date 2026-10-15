import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { __test, MigrateLockTimeoutError } from "../../src/db/connection";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

/**
 * The boot migrate lock against a real server: a lock another session holds is
 * waited on for a bounded time, the wait names that session's backend pid, and
 * once the holder lets go the next migrate takes the lock and runs.
 */
let fixture: Awaited<ReturnType<typeof setupFactoryPostgres>>;
let holder: SQL;
beforeAll(async () => {
  fixture = await setupFactoryPostgres();
  holder = new SQL(fixture.databaseUrl, { max: 1 });
}, 120_000);
afterAll(async () => {
  await holder?.close();
  await fixture?.close();
});

test("a migrate lock held by another session is waited on by name and bounded; released, the next migrate runs", async () => {
  const session = await holder.reserve();
  try {
    const [row] = await session`SELECT pg_backend_pid() AS pid` as Array<{ pid: number }>;
    await session`SELECT pg_advisory_lock(${__test.MIGRATE_ADVISORY_LOCK_KEY})`;
    let ran = false;
    const refused = await __test.withPostgresMigrateLock(async () => { ran = true; }, { waitMs: 300, pollMs: 100 }).then(() => undefined, (error: unknown) => error);
    expect(refused).toBeInstanceOf(MigrateLockTimeoutError);
    expect(refused).toMatchObject({ code: "migrate_lock_timeout", holderPid: row!.pid });
    expect(ran).toBe(false);

    await session`SELECT pg_advisory_unlock(${__test.MIGRATE_ADVISORY_LOCK_KEY})`;
    await __test.withPostgresMigrateLock(async () => { ran = true; }, { waitMs: 5_000, pollMs: 100 });
    expect(ran).toBe(true);
  } finally {
    session.release();
  }
}, 60_000);
