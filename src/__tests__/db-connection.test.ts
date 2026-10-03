/**
 * Behavior tests for the REAL `src/db/connection.ts` module.
 *
 * This file used to `mock.module("../db/connection")` with a hand-rolled
 * PGlite reimplementation and then test THAT copy, plus assert source-code
 * strings ("if (DATABASE_URL) return \"external\"") and carry an unconditional
 * `describe.skip`. None of that exercised production code. It now drives the
 * real module directly:
 *   - the driver-agnostic lifecycle (`getDbPath`, `closeDb`),
 *   - `closeDb()` draining the Bun.sql pool (external-Postgres branch),
 *   - `recoverInterruptedRollback()` (crash-window recovery),
 *   - `withPostgresMigrateLock()` (concurrent-boot advisory lock ordering),
 *   - and external-mode detection via a real subprocess boot with DATABASE_URL.
 *
 * The PGlite init path proper (open/migrate/holder) is covered by
 * `db-connection-real-init.test.ts`; raw-param binding by
 * `db-connection-raw-query.test.ts`.
 */
import { test, expect, describe, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { getReadiness, setReadiness } from "../readiness";
import { getBackupDir } from "../db/backup";
import { closeStaleProcessHolder } from "../db/live-holder-guard";

restoreModuleMocks();
const conn = await import("../db/connection");

afterEach(() => {
  conn.__test.setState(null, null);
});

describe("getDbPath — real module (no DATABASE_URL in this process)", () => {
  test("returns the configured on-disk path, never 'external'", () => {
    const p = conn.getDbPath();
    expect(typeof p).toBe("string");
    expect(p).not.toBe("external");
  });
});

describe("bunSqlClass — the pool class comes from the runtime, not import(\"bun\") (W09g)", () => {
  test("under Bun it is the SQL class the \"bun\" module exports", async () => {
    const { SQL } = await import("bun");
    expect(conn.bunSqlClass()).toBe(SQL);
  });

  test("a runtime without a SQL class is refused by name", () => {
    const refusal = "the external PostgreSQL pool needs the Bun runtime (Bun.SQL is unavailable)";
    expect(() => conn.bunSqlClass(null)).toThrow(refusal);
    expect(() => conn.bunSqlClass({ SQL: "not a class" })).toThrow(refusal);
  });
});

describe("closeDb — Bun.sql pool drain (external-Postgres branch)", () => {
  test("awaits $client.close() then clears module state", async () => {
    let closed = 0;
    const fakeDb = { $client: { close: async () => { closed++; } } };
    // pglite = null simulates external-Postgres mode.
    conn.__test.setState(fakeDb, null);

    await conn.closeDb();

    expect(closed).toBe(1);
    // State cleared: getDb() now throws.
    expect(() => conn.getDb()).toThrow("Database not initialized");
  });

  test("falls back to $client.end() when close() is absent", async () => {
    let ended = 0;
    const fakeDb = { $client: { end: async () => { ended++; } } };
    conn.__test.setState(fakeDb, null);

    await conn.closeDb();

    expect(ended).toBe(1);
  });

  test("a pool close that throws is swallowed (teardown never blocks)", async () => {
    const fakeDb = { $client: { close: async () => { throw new Error("reset"); } } };
    conn.__test.setState(fakeDb, null);

    // Must not reject.
    await conn.closeDb();
    expect(() => conn.getDb()).toThrow("Database not initialized");
  });
});

describe("recoverInterruptedRollback — crash-window recovery", () => {
  const dirs: string[] = [];
  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), "conn-rollback-"));
    dirs.push(d);
    return d;
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    setReadiness({ state: "ready" });
  });

  function writeMarker(dbPath: string, marker: Record<string, unknown>) {
    writeFileSync(join(dirname(dbPath), ".ezcorp-rollback-in-progress.json"), JSON.stringify(marker));
  }

  test("no marker → no-op (datadir untouched)", () => {
    const base = tmp();
    const dbPath = join(base, "db");
    mkdirSync(dbPath, { recursive: true });
    writeFileSync(join(dbPath, "PG_VERSION"), "16");

    conn.__test.recoverInterruptedRollback(dbPath);

    expect(existsSync(join(dbPath, "PG_VERSION"))).toBe(true);
  });

  test("marker + snapshot present → completes the restore and clears the marker", () => {
    const base = tmp();
    const dbPath = join(base, "db");
    const snapshot = join(base, "snap");
    // A clean snapshot with its own sentinel file.
    mkdirSync(snapshot, { recursive: true });
    writeFileSync(join(snapshot, "clean.txt"), "restored");
    // A partial DB_PATH left behind by the interrupted rollback.
    mkdirSync(dbPath, { recursive: true });
    writeFileSync(join(dbPath, "partial.txt"), "half");
    writeMarker(dbPath, { ts: new Date().toISOString(), snapshot });

    conn.__test.recoverInterruptedRollback(dbPath);

    // Snapshot's file now lives at DB_PATH; the partial is moved aside.
    expect(existsSync(join(dbPath, "clean.txt"))).toBe(true);
    expect(existsSync(join(dbPath, "partial.txt"))).toBe(false);
    expect(readdirSync(base).some((n) => n.startsWith("db.rollback-partial."))).toBe(true);
    // Marker cleared.
    expect(existsSync(join(base, ".ezcorp-rollback-in-progress.json"))).toBe(false);
  });

  test("marker but snapshot missing → refuses to boot (throws + degraded readiness)", () => {
    const base = tmp();
    const dbPath = join(base, "db");
    mkdirSync(dbPath, { recursive: true });
    writeMarker(dbPath, { ts: new Date().toISOString(), snapshot: join(base, "does-not-exist") });

    expect(() => conn.__test.recoverInterruptedRollback(dbPath)).toThrow(/refusing to boot/i);
    const r = getReadiness();
    expect(r.state).toBe("degraded");
    expect(r.reason).toBe("rollback-interrupted");
  });
});

/** What a fake connection answers: the try-lock query takes the lock; everything else returns no rows. */
const answer = (strings: TemplateStringsArray) => Promise.resolve(strings.join("").includes("pg_try_advisory_lock") ? [{ locked: true }] : []);

describe("withPostgresMigrateLock — advisory lock ordering", () => {
  test("reserves a connection, locks, runs migrate, unlocks, releases", async () => {
    const order: string[] = [];
    const reserved = Object.assign(
      (strings: TemplateStringsArray) => {
        order.push(`reserved:${strings.join("?")}`);
        return answer(strings);
      },
      { release: () => order.push("release") },
    );
    const client = Object.assign(
      (strings: TemplateStringsArray) => {
        order.push(`pool:${strings.join("?")}`);
        return Promise.resolve([]);
      },
      { reserve: () => { order.push("reserve"); return Promise.resolve(reserved); } },
    );
    conn.__test.setState({ $client: client }, null);

    await conn.__test.withPostgresMigrateLock(async () => { order.push("migrate"); });

    // reserve → lock (on the reserved conn) → migrate → unlock → release.
    expect(order[0]).toBe("reserve");
    expect(order[1]).toContain("pg_try_advisory_lock");
    expect(order[1]).toContain("reserved:");
    expect(order[2]).toBe("migrate");
    expect(order[3]).toContain("pg_advisory_unlock");
    expect(order[4]).toBe("release");
    // The lock was NEVER taken on a bare pool connection.
    expect(order.some((o) => o.startsWith("pool:"))).toBe(false);
  });

  test("still unlocks + releases when migrate throws", async () => {
    const order: string[] = [];
    const reserved = Object.assign(
      (strings: TemplateStringsArray) => { order.push(`sql:${strings.join("?")}`); return answer(strings); },
      { release: () => order.push("release") },
    );
    const client = Object.assign(
      (_s: TemplateStringsArray) => Promise.resolve([]),
      { reserve: () => Promise.resolve(reserved) },
    );
    conn.__test.setState({ $client: client }, null);

    await expect(
      conn.__test.withPostgresMigrateLock(async () => { throw new Error("migrate boom"); }),
    ).rejects.toThrow("migrate boom");

    expect(order.some((o) => o.includes("pg_advisory_unlock"))).toBe(true);
    expect(order.at(-1)).toBe("release");
  });

  test("swallows an advisory-unlock failure (best-effort)", async () => {
    const client = (strings: TemplateStringsArray) => {
      // Fail only the unlock; lock + migrate succeed.
      if (strings.join("").includes("unlock")) return Promise.reject(new Error("unlock boom"));
      return answer(strings);
    };
    conn.__test.setState({ $client: client }, null);
    // Must resolve despite unlock rejecting.
    await expect(conn.__test.withPostgresMigrateLock(async () => "ok")).resolves.toBe("ok");
  });

  test("falls back to the pool connection when reserve() is unavailable", async () => {
    const order: string[] = [];
    const client = (strings: TemplateStringsArray) => {
      order.push(strings.join("?"));
      return answer(strings);
    };
    conn.__test.setState({ $client: client }, null);

    await conn.__test.withPostgresMigrateLock(async () => { order.push("migrate"); });

    expect(order.some((o) => o.includes("pg_try_advisory_lock"))).toBe(true);
    expect(order).toContain("migrate");
    expect(order.some((o) => o.includes("pg_advisory_unlock"))).toBe(true);
  });

  /** A connection whose lock is held by `holders[i]` for the first attempts, then free. */
  function contended(holders: Array<number | null>) {
    const order: string[] = [];
    let attempt = 0;
    const reserved = Object.assign(
      (strings: TemplateStringsArray) => {
        const text = strings.join("?");
        order.push(text);
        if (text.includes("pg_try_advisory_lock")) return Promise.resolve([{ locked: attempt >= holders.length }]);
        if (text.includes("FROM pg_locks")) { const pid = holders[attempt++]; return Promise.resolve(pid === null ? [] : [{ pid }]); }
        return Promise.resolve([]);
      },
      { release: () => order.push("release") },
    );
    conn.__test.setState({ $client: Object.assign(() => Promise.resolve([]), { reserve: () => Promise.resolve(reserved) }) }, null);
    return order;
  }

  test("waits a bounded time for a held lock, naming the holder once per holder, then migrates", async () => {
    const order = contended([4242, 4242, 5151]);
    const slept: number[] = [];
    const warn = spyOn(conn.__test.log, "warn");
    await conn.__test.withPostgresMigrateLock(async () => { order.push("migrate"); }, { waitMs: 60_000, pollMs: 250, now: () => 0, sleep: async (ms) => { slept.push(ms); } });
    expect(slept).toEqual([250, 250, 250]);
    expect(warn.mock.calls.map((call) => call[0])).toEqual(["waiting for migrate lock held by pid 4242", "waiting for migrate lock held by pid 5151"]);
    expect(order.filter((o) => o === "migrate" || o === "release" || o.includes("pg_advisory_unlock")).map((o) => (o.includes("unlock") ? "unlock" : o))).toEqual(["migrate", "unlock", "release"]);
    warn.mockRestore();
  });

  test("past the deadline, boot fails by name with the holder's pid, and the connection goes back", async () => {
    const order = contended([4242, 4242, 4242, 4242]);
    let clock = 0;
    const error = await conn.__test.withPostgresMigrateLock(async () => { order.push("migrate"); }, { waitMs: 1_000, pollMs: 500, now: () => clock, sleep: async (ms) => { clock += ms; } }).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(conn.MigrateLockTimeoutError);
    expect(error).toMatchObject({ code: "migrate_lock_timeout", holderPid: 4242, message: "Gave up after 1000 ms waiting for the migrate lock held by pid 4242." });
    expect(order).not.toContain("migrate");
    expect(order.some((o) => o.includes("pg_advisory_unlock"))).toBe(false);
    expect(order.at(-1)).toBe("release");
  });

  test("a holder PostgreSQL cannot name is reported as unknown", async () => {
    contended([null, null]);
    let clock = 0;
    await expect(conn.__test.withPostgresMigrateLock(async () => undefined, { waitMs: 100, pollMs: 100, now: () => clock, sleep: async (ms) => { clock += ms; } }))
      .rejects.toMatchObject({ code: "migrate_lock_timeout", holderPid: null, message: "Gave up after 100 ms waiting for the migrate lock held by pid unknown." });
  });

  test("defaults to the two-minute bound and a real sleep", async () => {
    expect(conn.MIGRATE_LOCK_WAIT_MS).toBe(120_000);
    // Held once, then free: the default sleep really waits one poll.
    const order = contended([7]);
    await conn.__test.withPostgresMigrateLock(async () => { order.push("migrate"); });
    expect(order).toContain("migrate");
  });
});

describe("registerProcessHolder — same-process guard wiring", () => {
  afterEach(async () => {
    await closeStaleProcessHolder(conn.getDbPath());
  });

  test("records a close callback that tears down the current PGlite instance", async () => {
    let closed = 0;
    // Simulate a live embedded instance; registerProcessHolder captures it.
    conn.__test.setState({}, { close: async () => { closed++; } } as never);
    conn.__test.registerProcessHolder();

    // A re-instantiated module (vite restart) would call closeStaleProcessHolder
    // for the same datadir — which must invoke the recorded close.
    const found = await closeStaleProcessHolder(conn.getDbPath());
    expect(found).toBe(true);
    expect(closed).toBe(1);
  });
});

describe("writeRollbackMarker — best-effort", () => {
  test("swallows a write failure instead of throwing", () => {
    const base = mkdtempSync(join(tmpdir(), "conn-marker-"));
    // Make the marker's parent dir actually a FILE so writeFileSync throws
    // ENOTDIR — the catch must swallow it.
    const notADir = join(base, "afile");
    writeFileSync(notADir, "x");
    const dbPath = join(notADir, "db");
    expect(() => conn.__test.writeRollbackMarker(dbPath, { ts: "t" })).not.toThrow();
    rmSync(base, { recursive: true, force: true });
  });
});

describe("rollbackMigration — snapshot restore brackets a rollback marker", () => {
  const created: string[] = [];
  const prevNoExit = process.env.EZCORP_NO_EXIT;

  afterEach(() => {
    for (const p of created.splice(0)) rmSync(p, { recursive: true, force: true });
    if (prevNoExit === undefined) delete process.env.EZCORP_NO_EXIT;
    else process.env.EZCORP_NO_EXIT = prevNoExit;
    setReadiness({ state: "ready" });
  });

  test("writes the rollback marker before rename and clears it after cpSync succeeds", async () => {
    // EZCORP_NO_EXIT makes rollbackMigration throw instead of process.exit(1).
    process.env.EZCORP_NO_EXIT = "1";

    const dbPath = conn.getDbPath();
    const markerFile = join(dirname(dbPath), ".ezcorp-rollback-in-progress.json");
    // A live datadir with a doomed file.
    mkdirSync(dbPath, { recursive: true });
    writeFileSync(join(dbPath, "doomed.txt"), "gone");
    created.push(dbPath);

    // A pre-boot snapshot for latestPreBootSnapshot() to find + restore from.
    const backupDir = getBackupDir();
    const snapshot = join(backupDir, "pre-boot-2026-01-01T00-00-00-000Z");
    mkdirSync(snapshot, { recursive: true });
    writeFileSync(join(snapshot, "restored.txt"), "clean");
    created.push(backupDir, markerFile);

    // A fake live PGlite so rollback's close() runs; no real db needed.
    conn.__test.setState({}, { close: async () => {} } as never);

    await expect(conn.__test.rollbackMigration(new Error("bad migration"))).rejects.toThrow("bad migration");

    // The snapshot was restored into DB_PATH and the marker was cleared after
    // the copy completed.
    expect(existsSync(join(dbPath, "restored.txt"))).toBe(true);
    expect(existsSync(markerFile)).toBe(false);
    // The failed datadir was renamed aside for forensics (never deleted).
    expect(readdirSync(dirname(dbPath)).some((n) => n.includes(".failed."))).toBe(true);
    // Readiness reflects the failed migration.
    expect(getReadiness().state).toBe("degraded");
  });
});

describe("external-mode detection — real subprocess boot with DATABASE_URL", () => {
  test("getDbPath() returns 'external' when DATABASE_URL is set at module load", async () => {
    const connPath = new URL("../db/connection.ts", import.meta.url).pathname;
    // getDbPath() reads the DATABASE_URL const captured at module load — a
    // bogus DSN is fine because we never call initDb() (no connection made).
    const proc = Bun.spawn(
      ["bun", "-e", `const m = await import(${JSON.stringify(connPath)}); console.log(m.getDbPath());`],
      {
        env: { ...process.env, DATABASE_URL: "postgres://user:pw@127.0.0.1:5432/nope" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    expect(out.split("\n").at(-1)).toBe("external");
  });
});
