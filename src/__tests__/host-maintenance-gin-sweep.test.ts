/**
 * Phase 57 — UX-02 Wave 0 RED scaffold for the every-6th-tick GIN sweep.
 *
 * Locks the daemon-level cadence from CONTEXT.md UX-02:
 *   "gin_clean_pending_list runs every 6h via the existing
 *    HostMaintenanceDaemon (not a new daemon)."
 *
 * Five cases:
 *   1. tickCount increments on each tickOnce.
 *   2. tick 6 fires gin_clean_pending_list('idx_marketplace_listings_trgm').
 *   3. ticks 1–5 do NOT fire the sweep.
 *   4. tick 12 fires the sweep a second time (sub-tick cadence holds).
 *   5. PGlite error tolerated — daemon swallows + logs (per locked
 *      "Tick errors are swallowed" invariant at host-maintenance-daemon.ts
 *      line 31).
 *
 * RED reason: tickCount + GIN sub-tick block not yet added to tickOnce
 * (host-maintenance-daemon.ts line 253). Wave 2 Track B (Plan 57-04
 * Task 3) wires:
 *   - private tickCount field
 *   - `if (++this.tickCount % 6 === 0) try { db.execute(sql\`SELECT
 *      gin_clean_pending_list('idx_marketplace_listings_trgm')\`); } catch (e) { log.warn(...) }`
 *
 * Runner: bun test. Spy pattern lifted from existing
 * host-maintenance-daemon.test.ts — mockDbConnection + spy on db.execute.
 */

import {
  test,
  expect,
  describe,
  beforeAll,
  beforeEach,
  afterAll,
  spyOn,
} from "bun:test";
import {
  setupTestDb,
  closeTestDb,
  mockDbConnection,
} from "./helpers/test-pglite";

mockDbConnection();

import { sql } from "drizzle-orm";
import { getDb } from "../db/connection";
import { HostMaintenanceDaemon } from "../extensions/host-maintenance-daemon";

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  // Wipe any state the runSweep call might query/write so each tick is
  // a clean cadence test (no audit-row noise, no extension sweep work).
  const db = getDb();
  await db.execute(sql`DELETE FROM audit_log`);
  await db.execute(sql`DELETE FROM extensions`);
  await db.execute(sql`DELETE FROM settings`);
});

/**
 * Count gin_clean_pending_list invocations in a spy's argument log.
 * The execute() seam accepts Drizzle SQL fragments — neither
 * `sql\`...\`` template tags nor `sql.raw(...)` expose a public `.sql`
 * property in current drizzle-orm; instead the rendered chunks live
 * under the private `queryChunks` array. We walk that recursively and
 * concatenate every string value so the matcher catches the literal
 * `gin_clean_pending_list` regardless of whether the impl uses sql
 * template tags, sql.raw, or a plain string.
 *
 * Fixed by Phase 57-04 Task 3 (Rule 1 — the original helper relied on
 * `.sql` which is undefined in drizzle-orm 0.x, so every spy call
 * stringified to `[object Object]` and the matcher never fired).
 */
function renderDrizzleChunks(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(renderDrizzleChunks).join(" ");
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.sql === "string") return obj.sql;
    if (Array.isArray(obj.queryChunks)) return renderDrizzleChunks(obj.queryChunks);
    if (Array.isArray(obj.value)) return renderDrizzleChunks(obj.value);
    return "";
  }
  return String(value);
}

function countGinSweepCalls(
  spy: ReturnType<typeof spyOn<unknown, "execute">>,
): number {
  let n = 0;
  for (const call of spy.mock.calls) {
    const rendered = renderDrizzleChunks(call?.[0]);
    if (rendered.includes("gin_clean_pending_list")) n++;
  }
  return n;
}

describe("HostMaintenanceDaemon GIN sub-tick", () => {
  test("tickCount increments on each tickOnce (private counter visible via sweep cadence)", async () => {
    const daemon = new HostMaintenanceDaemon({ skipLockfile: true });
    const db = getDb();
    const spy = spyOn(db, "execute");
    try {
      await daemon.tickOnce();
      await daemon.tickOnce();
      await daemon.tickOnce();
      // Cadence proof — after 3 ticks no sweep yet; on tick 6 it fires.
      expect(countGinSweepCalls(spy as never)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("tick 6 fires gin_clean_pending_list('idx_marketplace_listings_trgm')", async () => {
    const daemon = new HostMaintenanceDaemon({ skipLockfile: true });
    const db = getDb();
    const spy = spyOn(db, "execute");
    try {
      for (let i = 0; i < 6; i++) {
        await daemon.tickOnce();
      }
      expect(countGinSweepCalls(spy as never)).toBeGreaterThanOrEqual(1);
      // The impl must target the trigram index specifically.
      const renderedCalls = spy.mock.calls
        .map((c) => renderDrizzleChunks(c?.[0]))
        .join("\n");
      expect(renderedCalls).toContain("idx_marketplace_listings_trgm");
    } finally {
      spy.mockRestore();
    }
  });

  test("ticks 1-5 do NOT fire gin sweep", async () => {
    const daemon = new HostMaintenanceDaemon({ skipLockfile: true });
    const db = getDb();
    const spy = spyOn(db, "execute");
    try {
      for (let i = 0; i < 5; i++) {
        await daemon.tickOnce();
      }
      expect(countGinSweepCalls(spy as never)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("tick 12 fires the GIN sweep a second time", async () => {
    const daemon = new HostMaintenanceDaemon({ skipLockfile: true });
    const db = getDb();
    const spy = spyOn(db, "execute");
    try {
      for (let i = 0; i < 12; i++) {
        await daemon.tickOnce();
      }
      expect(countGinSweepCalls(spy as never)).toBeGreaterThanOrEqual(2);
    } finally {
      spy.mockRestore();
    }
  });

  test("PGlite error tolerated — daemon tick continues without throwing", async () => {
    const daemon = new HostMaintenanceDaemon({ skipLockfile: true });
    const db = getDb();
    // Hijack execute to throw whenever it sees the sweep call. Other
    // sweep work (runSweep's internal queries) must still run unimpeded.
    const realExecute = db.execute.bind(db);
    const spy = spyOn(db, "execute").mockImplementation(((q: unknown) => {
      const rendered = renderDrizzleChunks(q);
      if (rendered.includes("gin_clean_pending_list")) {
        throw new Error("simulated: gin_clean_pending_list not registered");
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return realExecute(q as any);
    }) as never);
    try {
      // Six ticks → one attempted sweep that throws; the daemon must NOT
      // propagate the throw upward (per locked invariant — tick errors
      // swallowed).
      let threw = false;
      try {
        for (let i = 0; i < 6; i++) {
          await daemon.tickOnce();
        }
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
