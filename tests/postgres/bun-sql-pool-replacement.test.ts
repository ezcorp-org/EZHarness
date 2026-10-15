/**
 * W09f: the external pool can be discarded under a live Drizzle handle.
 *
 * Bun cannot evict one poisoned pooled connection, so after a driver statement
 * desync the process replaces the whole pool behind Drizzle's client
 * (`src/db/swappable-bun-sql.ts`, `recoverFromDriverDesync`). These cases pin
 * what that promises on a real server: new work reaches the fresh pool at once,
 * a transaction already running on the old pool finishes and commits there,
 * and the old pool is closed afterwards.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { swappableBunSql, type BunSqlLike } from "../../src/db/swappable-bun-sql";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

let fixture: Awaited<ReturnType<typeof setupFactoryPostgres>>;
beforeAll(async () => { fixture = await setupFactoryPostgres(); });
afterAll(async () => { await fixture?.close(); });

describe("a replaced Bun.sql pool under one Drizzle handle", () => {
  test("new work reaches the fresh pool while a running transaction commits on the old one", async () => {
    const opened: SQL[] = [];
    const closeErrors: unknown[] = [];
    const pool = swappableBunSql<BunSqlLike>(() => { const sql = new SQL({ url: fixture.databaseUrl, max: 2 }); opened.push(sql); return sql as unknown as BunSqlLike; }, {
      drainSeconds: 10,
      onCloseError: (error) => { closeErrors.push(error); },
    });
    const db = drizzle({ client: pool.client as unknown as SQL, schema });
    try {
      await db.insert(schema.agentConfigs).values({ name: "before-replacement", prompt: "p" });

      let releaseTransaction!: () => void;
      const gate = new Promise<void>((resolve) => { releaseTransaction = resolve; });
      let transactionStarted!: () => void;
      const started = new Promise<void>((resolve) => { transactionStarted = resolve; });
      const running = db.transaction(async (tx) => {
        await tx.select().from(schema.agentConfigs).where(eq(schema.agentConfigs.name, "before-replacement"));
        transactionStarted();
        await gate;
        await tx.insert(schema.agentConfigs).values({ name: "committed-on-old-pool", prompt: "p" });
      });
      await started;

      const replaced = pool.replace();
      expect(pool.generation).toBe(2);
      expect(opened).toHaveLength(2);
      // The fresh pool answers while the old one still holds the open transaction.
      expect(await db.select().from(schema.agentConfigs).where(eq(schema.agentConfigs.name, "before-replacement"))).toHaveLength(1);

      releaseTransaction();
      await running;
      await replaced;
      expect(closeErrors).toEqual([]);
      expect(await db.select().from(schema.agentConfigs).where(eq(schema.agentConfigs.name, "committed-on-old-pool"))).toHaveLength(1);
      // The old pool is closed once its work drained; the handle keeps working.
      // Settled through `.then`: a Bun.sql query is lazy and starts only when
      // it is awaited or `.then` is called on it.
      expect(await opened[0]!.unsafe("SELECT 1").then(() => "answered", (error: Error) => error.message)).toBe("Connection closed");
      expect(await db.execute("SELECT 1 AS alive" as never)).toEqual([{ alive: 1 }] as never);
    } finally {
      await pool.client.close();
    }
  });
});
