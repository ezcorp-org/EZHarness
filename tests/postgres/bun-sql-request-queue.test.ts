/**
 * W12e acceptance test: Bun.sql's Postgres request queue under the product's
 * own queries. It was red on Bun 1.3.14 in five of five runs (W09f,
 * tasks/factory/w09f-GATES.md) and green on Bun 1.4.2 in five of five, which
 * is the runtime this branch pins.
 *
 * The field failure (W16, 2026-09-26): three tenants logged
 * `bind message supplies 2 parameters, but prepared statement
 * "Pselect "id", "managed_by_extension_id", $5" requires 1` (08P01,
 * exec_bind_message) against the run-projection query and the briefing
 * bootstrap: one query's Bind reached another query's statement on the same
 * pooled connection. On this host the same component fails two ways, and this
 * suite pins both:
 *
 *   1. A STALL. On one connection, a new named statement queued behind
 *      in-flight statements is never written: every server session sits idle
 *      in ClientRead while the client waits (the defect class of Bun #32004 /
 *      #32005; W16's tenant-07 boot stall has the same signature).
 *   2. CONTAMINATION. Under pooled queries mixed with transactions, a failing
 *      pooled query runs inside another caller's open transaction, whose next
 *      query then reports "current transaction is aborted".
 *
 * Each trial opens a fresh pool on a migrated database and runs the real
 * `FactoryRecords.pendingProjectionRuns` beside the exact Drizzle
 * `agent_configs` queries of src/db/queries/agent-configs.ts. A trial that does
 * not settle within its deadline is a stall; it is never retried.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/bun-sql";
import { eq, inArray, sql } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { FactoryRecords } from "../../src/factory/records";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

type Handle = ReturnType<typeof drizzle<typeof schema>>;

let fixture: Awaited<ReturnType<typeof setupFactoryPostgres>>;
beforeAll(async () => {
  fixture = await setupFactoryPostgres();
  await fixture.db.insert(schema.agentConfigs).values([{ name: "Daily Briefing", prompt: "p" }, { name: "Second", prompt: "p" }]);
});
afterAll(async () => { await fixture?.close(); });

/** The product's result shape: execute() returns { rows } (src/db/connection.ts). */
function productHandle(poolMax: number): { db: Handle; close(stalled: boolean): Promise<void> } {
  const client = new SQL({ url: fixture.databaseUrl, max: poolMax });
  const db = drizzle({ client, schema });
  const normalize = (handle: { execute: (...a: unknown[]) => Promise<unknown> }) => {
    const execute = handle.execute.bind(handle);
    handle.execute = async (...a: unknown[]) => { const result = await execute(...a); return Array.isArray(result) ? { rows: result } : result; };
  };
  normalize(db as never);
  type TxRunner = (fn: (tx: unknown) => Promise<unknown>, config?: unknown) => Promise<unknown>;
  const transaction = db.transaction.bind(db) as unknown as TxRunner;
  (db as { transaction: unknown }).transaction = (fn: (tx: never) => Promise<unknown>, config?: unknown) => transaction(async (tx) => { normalize(tx as never); return fn(tx as never); }, config);
  return {
    db,
    // A settled trial's pool is closed completely before the next one opens:
    // leftover pools would exhaust the server's connections and look like a
    // stall. Only a stalled pool, which may never drain, is closed bounded.
    close: async (stalled: boolean) => {
      if (!stalled) { await client.close(); return; }
      await Promise.race([client.close({ timeout: 1 }), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    },
  };
}

const t = schema.agentConfigs;
const queries = {
  byName: (h: Handle) => h.select().from(t).where(eq(t.name, "Daily Briefing")),
  byNames: (h: Handle) => h.select().from(t).where(inArray(t.name, ["Daily Briefing", "Second"])),
  byIds: (h: Handle) => h.select().from(t).where(inArray(t.id, [randomUUID(), randomUUID()])),
  byUser: (h: Handle) => h.select().from(t).where(eq(t.userId, "user-1")),
  byThree: (h: Handle) => h.select().from(t).where(inArray(t.name, ["a", "b", "c"])),
  pending: (h: Handle) => new FactoryRecords(h as never, "tenant-01").pendingProjectionRuns("factory-run-status.v1", 8),
};

/** Runs every worker against one fresh pool; "stall" if they do not settle in time. */
async function trial(poolMax: number, workers: ReadonlyArray<(db: Handle) => Promise<void>>, deadlineMs: number): Promise<"stall" | readonly string[]> {
  const pool = productHandle(poolMax);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    Promise.allSettled(workers.map((worker) => worker(pool.db))),
    new Promise<"stall">((resolve) => { timer = setTimeout(() => resolve("stall"), deadlineMs); }),
  ]);
  clearTimeout(timer);
  await pool.close(outcome === "stall");
  if (outcome === "stall") return "stall";
  return outcome.flatMap((settled) => settled.status === "fulfilled" ? [] : [String((settled.reason as { cause?: Error })?.cause?.message ?? settled.reason)]);
}

describe("Bun.sql request queue under the product's queries", () => {
  test("a new statement queued behind in-flight statements on one connection is written and answered", async () => {
    const plain = async (db: Handle) => {
      for (let step = 0; step < 3; step++) {
        await queries.byName(db); await queries.pending(db); await queries.byIds(db); await queries.byNames(db);
      }
    };
    const mixed = async (db: Handle) => {
      for (const first of [queries.byUser, queries.byThree, queries.byUser]) {
        await first(db); await queries.byName(db); await queries.byNames(db);
      }
    };
    // Timing decides whether a trial hits the window, so twenty are run. On
    // Bun 1.3.14 this case was red in three of five suite runs; the second
    // case below was red in all five, so the suite as a whole is red there.
    const failures: Array<{ trial: number; outcome: "stall" | readonly string[] }> = [];
    for (let run = 1; run <= 20; run++) {
      const outcome = await trial(1, [plain, plain, mixed], 10_000);
      if (outcome === "stall" || outcome.length > 0) failures.push({ trial: run, outcome });
      if (outcome === "stall") break;
    }
    expect(failures).toEqual([]);
  }, 120_000);

  test("a failing pooled query never runs inside another caller's transaction, and nothing stalls", async () => {
    const worker = (index: number) => async (db: Handle) => {
      for (let step = 0; step < 3; step++) {
        if (index % 3 === 2) {
          // Expected server errors from pooled work: a duplicate name (the
          // name is unique; boot-time bootstraps race on it) and a runtime
          // error on a prepared statement.
          const failing = (index + step) % 2 === 0
            ? db.insert(t).values({ name: "Daily Briefing", prompt: "p" })
            : db.execute(sql`SELECT 1 / ${0}::int AS boom`);
          const reason = await failing.then(() => "no error", (error: { cause?: Error; message?: string }) => String(error?.cause?.message ?? error?.message));
          if (!/duplicate key|division by zero/.test(reason)) throw new Error(`unexpected outcome of a failing pooled query: ${reason}`);
          await queries.byName(db); await queries.byNames(db);
        } else if (index % 2 === 0) {
          await db.transaction(async (tx) => {
            await queries.byName(tx as never); await queries.pending(tx as never); await queries.byNames(tx as never);
          });
        } else {
          await queries.byName(db); await queries.pending(db); await queries.byIds(db); await queries.byNames(db);
        }
      }
    };
    const workers = Array.from({ length: 24 }, (_, index) => worker(index));
    const failures: Array<{ trial: number; outcome: "stall" | readonly string[] }> = [];
    for (let run = 1; run <= 30; run++) {
      const outcome = await trial(8, workers, 15_000);
      if (outcome === "stall" || outcome.length > 0) failures.push({ trial: run, outcome });
      if (outcome === "stall") break;
    }
    expect(failures).toEqual([]);
  }, 300_000);
});
