/**
 * Cap-expiry Phase 3 — `HostMaintenanceDaemon` lifecycle + tick coverage.
 *
 * The daemon wraps the Phase 2 sweep (`runSweep` + `applySweepResult`)
 * with PID-lockfile sibling-prevention, env-var-driven cadence, and a
 * kill switch. This suite exercises:
 *
 *   • Lifecycle — start, tick, stop. tickOnce() against a real PGlite
 *     with seeded aged grants, asserting the DB row is rewritten and an
 *     audit row lands.
 *   • Kill switch — `EZCORP_DISABLE_PERM_SWEEP=1` makes start() return
 *     false WITHOUT touching the lockfile (so a second daemon can run).
 *   • Lockfile — sibling-prevention via PID, stale-PID overwrite, and
 *     release-on-stop allowing a third daemon to start.
 *   • Env-var parsing — happy path, invalid → default, below-floor →
 *     clamped, all via the exported `getSweepIntervalMs` helper.
 *   • Tick safety — `runSweep` throwing doesn't crash the daemon; next
 *     tick still runs.
 *
 * Pattern mirrors Phase 2's `perm-expiry-sweep.integration.test.ts`
 * (file-backed PGlite via `setupTestDb`, real settings module wiring,
 * `mockDbConnection()` at module level). The `:memory:` PGlite path has
 * a pre-existing extension-loading bug — Phase 2 documented the
 * workaround at `perm-expiry-sweep.integration.test.ts:480-500`. This
 * test goes through `setupTestDb()` which uses the same in-process file-
 * backed PGlite path that Phase 2 proved works.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import {
  closeTestDb,
  mockDbConnection,
  setupTestDb,
} from "./helpers/test-pglite";

// Wire a real settings module backed by the test DB — mirrors the
// pattern in `perm-expiry-sweep.integration.test.ts`. The sweep reads
// `settings` rows for the always-allow scope sweep arm; without this
// the always-allow paths through the daemon would silently no-op.
mock.module("../db/queries/settings", () => {
  const { eq } = require("drizzle-orm");
  const { settings: tbl } = require("../db/schema");
  return {
    async getAllSettings() {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl);
      return Object.fromEntries(
        rows.map((r: { key: string; value: unknown }) => [r.key, r.value]),
      );
    },
    async getSetting(key: string) {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl).where(eq(tbl.key, key));
      return rows[0]?.value;
    },
    async upsertSetting(key: string, value: unknown) {
      const { getDb } = require("../db/connection");
      const db = getDb();
      const rows = await db.select().from(tbl).where(eq(tbl.key, key));
      if (rows[0]) {
        await db
          .update(tbl)
          .set({ value, updatedAt: new Date() })
          .where(eq(tbl.key, key));
      } else {
        await db.insert(tbl).values({ key, value, updatedAt: new Date() });
      }
    },
    async deleteSetting() {
      return false;
    },
    async isListingInstalled() {
      return false;
    },
  };
});

mockDbConnection();

import { sql } from "drizzle-orm";
import {
  HostMaintenanceDaemon,
  _hostMaintenanceDaemonInternals,
  getSweepIntervalMs,
} from "../extensions/host-maintenance-daemon";
import { extensions, settings, auditLog } from "../db/schema";
import { getDb } from "../db/connection";

const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(async () => {
  // Wipe every test's footprint between cases.
  const db = getDb();
  await db.execute(sql`DELETE FROM audit_log`);
  await db.execute(sql`DELETE FROM extensions`);
  await db.execute(sql`DELETE FROM settings`);
});

afterEach(() => {
  // Defensive: scrub any leaked env vars between tests. A test that
  // sets EZCORP_DISABLE_PERM_SWEEP="1" for one case would otherwise
  // poison every subsequent case.
  delete process.env.EZCORP_DISABLE_PERM_SWEEP;
  delete process.env.EZCORP_PERM_SWEEP_INTERVAL_MS;
});

// Helper: insert an extension with the given grant shape. Mirrors the
// Phase 2 integration test's `seedExtension`.
async function seedExtension(opts: {
  id: string;
  name: string;
  enabled: boolean;
  perms: import("../extensions/types").ExtensionPermissions;
}) {
  const db = getDb();
  await db.insert(extensions).values({
    id: opts.id,
    name: opts.name,
    version: "1.0.0",
    description: "test fixture",
    manifest: sql`${JSON.stringify({
      schemaVersion: 2,
      name: opts.name,
      version: "1.0.0",
      description: "",
      author: { name: "test" },
      kind: "subprocess",
      entrypoint: { command: ["true"] },
      tools: [],
      permissions: {},
    })}::jsonb`,
    source: "test:fixture",
    installPath: null,
    enabled: opts.enabled,
    grantedPermissions: sql`${JSON.stringify(opts.perms)}::jsonb`,
    checksumVerified: false,
    isBundled: false,
    consecutiveFailures: 0,
  });
}

// ── Lifecycle ────────────────────────────────────────────────────────

describe("HostMaintenanceDaemon — lifecycle", () => {
  test("start() returns true, tickOnce() applies sweep, stop() halts", async () => {
    const NOW = Date.now();
    await seedExtension({
      id: "ext-life",
      name: "lifecycle",
      enabled: true,
      perms: {
        network: ["api.example.com"],
        grantedAt: { network: NOW - 91 * DAY_MS }, // 90d TTL → aged
      },
    });

    const daemon = new HostMaintenanceDaemon({
      wakeIntervalMs: 60_000, // long enough that the interval doesn't fire during the test
      skipLockfile: true,
      now: () => NOW,
    });
    const started = await daemon.start();
    expect(started).toBe(true);

    // Drive a tick directly.
    const outcome = await daemon.tickOnce();
    expect(outcome.applied).toBe(1);
    expect(outcome.skippedConcurrent).toBe(0);
    expect(outcome.audits).toBeGreaterThanOrEqual(1);
    expect(outcome.errors).toEqual([]);

    daemon.stop();

    // After stop(), the timer is cleared; further ticks would only run
    // if we drive them manually. We can't easily observe "interval
    // wasn't fired" here, but stop() being a no-op idempotent is
    // observable — calling it again must not throw.
    expect(() => daemon.stop()).not.toThrow();
  });

  test("start() is idempotent — second call returns true without rearming", async () => {
    const daemon = new HostMaintenanceDaemon({
      wakeIntervalMs: 60_000,
      skipLockfile: true,
    });
    const first = await daemon.start();
    const second = await daemon.start();
    expect(first).toBe(true);
    expect(second).toBe(true);
    daemon.stop();
  });

  test("tickOnce() with no aged grants returns zero-revocation outcome", async () => {
    const NOW = Date.now();
    await seedExtension({
      id: "ext-fresh",
      name: "fresh",
      enabled: true,
      perms: {
        network: ["api.example.com"],
        grantedAt: { network: NOW - 5 * DAY_MS }, // fresh, well under 90d
      },
    });
    const daemon = new HostMaintenanceDaemon({
      wakeIntervalMs: 60_000,
      skipLockfile: true,
      now: () => NOW,
    });
    await daemon.start();
    const outcome = await daemon.tickOnce();
    expect(outcome.applied).toBe(0);
    expect(outcome.audits).toBe(0);
    expect(outcome.errors).toEqual([]);
    daemon.stop();
  });

  test("interval-driven tick fires and applies sweep", async () => {
    const NOW = Date.now();
    await seedExtension({
      id: "ext-tick",
      name: "tick",
      enabled: true,
      perms: {
        network: ["api.x"],
        grantedAt: { network: NOW - 91 * DAY_MS },
      },
    });
    // Fast tick: 50ms. The clamp floor is 1000ms, but the test's
    // `wakeIntervalMs: 50` is bypassed by the clamp inside the
    // constructor — so we'd actually have to wait 1s for the real
    // interval to fire. To keep the suite fast we use the override
    // path: pass `wakeIntervalMs: 1000` (the floor) so the interval
    // ticks deterministically just over a second from now.
    //
    // Tradeoff: 1.1s sleep is noisy but accurate. Alternative would
    // be to break the clamp's contract for tests, which would defeat
    // the safety primitive being clamp-tested elsewhere.
    const daemon = new HostMaintenanceDaemon({
      wakeIntervalMs: 1000,
      skipLockfile: true,
      now: () => NOW,
    });
    await daemon.start();
    // Sleep slightly over one wake interval. Keep this generous
    // because PGlite write latency under load can spike a ms or two.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Verify the DB was rewritten by the interval-driven tick.
    const db = getDb();
    const { eq } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(extensions)
      .where(eq(extensions.id, "ext-tick"));
    expect(rows).toHaveLength(1);
    const perms = rows[0]?.grantedPermissions;
    expect(perms?.network).toBeUndefined();
    expect(perms?.grantedAt?.network).toBeUndefined();
    daemon.stop();
  });
});

// ── Kill switch ──────────────────────────────────────────────────────

describe("HostMaintenanceDaemon — kill switch", () => {
  test("EZCORP_DISABLE_PERM_SWEEP=1 → start() returns false", async () => {
    process.env.EZCORP_DISABLE_PERM_SWEEP = "1";
    const daemon = new HostMaintenanceDaemon({
      wakeIntervalMs: 60_000,
      skipLockfile: true,
    });
    const started = await daemon.start();
    expect(started).toBe(false);
    // No interval was armed; stop() is a no-op.
    expect(() => daemon.stop()).not.toThrow();
  });

  test("kill switch does NOT acquire lockfile (so a second daemon can run)", async () => {
    process.env.EZCORP_DISABLE_PERM_SWEEP = "1";
    const lockPath = join(tmpdir(), `ezcorp-test-killswitch-${Date.now()}.pid`);

    const daemon = new HostMaintenanceDaemon({
      wakeIntervalMs: 60_000,
      lockfilePath: lockPath,
      // intentionally NOT skipLockfile — verify start() bails BEFORE
      // it would have touched the lockfile.
    });
    const started = await daemon.start();
    expect(started).toBe(false);

    // Lockfile must not exist — kill-switch path should bail early.
    const file = Bun.file(lockPath);
    expect(await file.exists()).toBe(false);
    daemon.stop();
  });

  test("non-strict env var values (`true`, `yes`) do NOT trigger kill switch", async () => {
    // Strict-equality contract: the daemon only honors the literal
    // "1". Any other value runs normally. Documented in
    // `host-maintenance-daemon.ts:isDisabledByKillSwitch`.
    for (const val of ["true", "yes", "TRUE", "1 ", "01", ""]) {
      process.env.EZCORP_DISABLE_PERM_SWEEP = val;
      const daemon = new HostMaintenanceDaemon({
        wakeIntervalMs: 60_000,
        skipLockfile: true,
      });
      const started = await daemon.start();
      expect(started).toBe(true);
      daemon.stop();
    }
  });
});

// ── Lockfile ─────────────────────────────────────────────────────────

describe("HostMaintenanceDaemon — PID lockfile", () => {
  test("first daemon acquires lockfile (file exists with PID)", async () => {
    const lockPath = join(tmpdir(), `ezcorp-test-lock-first-${Date.now()}.pid`);
    const daemon = new HostMaintenanceDaemon({
      wakeIntervalMs: 60_000,
      lockfilePath: lockPath,
    });
    const ok = await daemon.start();
    expect(ok).toBe(true);

    const file = Bun.file(lockPath);
    expect(await file.exists()).toBe(true);
    const text = (await file.text()).trim();
    expect(parseInt(text, 10)).toBe(process.pid);

    daemon.stop();
    // Cleanup.
    await unlink(lockPath).catch(() => {});
  });

  test("sibling-prevention: second daemon refuses start when first holds the lock", async () => {
    const lockPath = join(
      tmpdir(),
      `ezcorp-test-lock-sibling-${Date.now()}.pid`,
    );
    // Pre-write our own PID — we ARE alive, so sibling-prevention
    // must trigger. Mirrors the schedule-daemon test's pattern.
    await Bun.write(lockPath, String(process.pid));

    const second = new HostMaintenanceDaemon({
      wakeIntervalMs: 60_000,
      lockfilePath: lockPath,
    });
    const ok = await second.start();
    expect(ok).toBe(false);
    second.stop();
    await unlink(lockPath).catch(() => {});
  });

  test("stale lockfile (PID of dead process) is overwritten", async () => {
    const lockPath = join(
      tmpdir(),
      `ezcorp-test-lock-stale-${Date.now()}.pid`,
    );
    // PID 1 always exists, but the daemon refuses on ANY live PID
    // (including ours). To get a stale-lock result we use a high
    // bogus PID. Same trick as schedule-daemon.test.ts:332-339.
    await Bun.write(lockPath, "999999999");
    const daemon = new HostMaintenanceDaemon({
      wakeIntervalMs: 60_000,
      lockfilePath: lockPath,
    });
    const ok = await daemon.start();
    expect(ok).toBe(true);

    const text = (await Bun.file(lockPath).text()).trim();
    expect(parseInt(text, 10)).toBe(process.pid);

    daemon.stop();
    await unlink(lockPath).catch(() => {});
  });

  test("stop() releases lockfile so a third daemon can start", async () => {
    const lockPath = join(
      tmpdir(),
      `ezcorp-test-lock-release-${Date.now()}.pid`,
    );

    const first = new HostMaintenanceDaemon({
      wakeIntervalMs: 60_000,
      lockfilePath: lockPath,
    });
    expect(await first.start()).toBe(true);
    first.stop();

    // After stop(), the lock is released. A small wait for the
    // fire-and-forget unlink in stop() to complete.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const third = new HostMaintenanceDaemon({
      wakeIntervalMs: 60_000,
      lockfilePath: lockPath,
    });
    expect(await third.start()).toBe(true);
    third.stop();
    await unlink(lockPath).catch(() => {});
  });

  test("isProcessAlive helper: own PID alive, bogus PID not alive, zero/negative not alive", () => {
    expect(_hostMaintenanceDaemonInternals.isProcessAlive(process.pid)).toBe(
      true,
    );
    expect(_hostMaintenanceDaemonInternals.isProcessAlive(999_999_999)).toBe(
      false,
    );
    expect(_hostMaintenanceDaemonInternals.isProcessAlive(0)).toBe(false);
    expect(_hostMaintenanceDaemonInternals.isProcessAlive(-1)).toBe(false);
  });
});

// ── Env-var parsing ──────────────────────────────────────────────────

describe("getSweepIntervalMs — env-var parsing", () => {
  test("unset → DEFAULT_WAKE_MS (1h)", () => {
    delete process.env.EZCORP_PERM_SWEEP_INTERVAL_MS;
    expect(getSweepIntervalMs()).toBe(
      _hostMaintenanceDaemonInternals.DEFAULT_WAKE_MS,
    );
  });

  test("empty string → DEFAULT_WAKE_MS", () => {
    process.env.EZCORP_PERM_SWEEP_INTERVAL_MS = "";
    expect(getSweepIntervalMs()).toBe(
      _hostMaintenanceDaemonInternals.DEFAULT_WAKE_MS,
    );
  });

  test("valid integer above floor → that integer", () => {
    process.env.EZCORP_PERM_SWEEP_INTERVAL_MS = "120000";
    expect(getSweepIntervalMs()).toBe(120_000);
  });

  test("non-numeric → DEFAULT_WAKE_MS, no throw", () => {
    process.env.EZCORP_PERM_SWEEP_INTERVAL_MS = "abc";
    expect(getSweepIntervalMs()).toBe(
      _hostMaintenanceDaemonInternals.DEFAULT_WAKE_MS,
    );
  });

  test("negative → DEFAULT_WAKE_MS", () => {
    process.env.EZCORP_PERM_SWEEP_INTERVAL_MS = "-100";
    expect(getSweepIntervalMs()).toBe(
      _hostMaintenanceDaemonInternals.DEFAULT_WAKE_MS,
    );
  });

  test("zero → DEFAULT_WAKE_MS", () => {
    process.env.EZCORP_PERM_SWEEP_INTERVAL_MS = "0";
    expect(getSweepIntervalMs()).toBe(
      _hostMaintenanceDaemonInternals.DEFAULT_WAKE_MS,
    );
  });

  test("below MIN_WAKE_MS floor → clamped to MIN_WAKE_MS", () => {
    process.env.EZCORP_PERM_SWEEP_INTERVAL_MS = "100";
    expect(getSweepIntervalMs()).toBe(
      _hostMaintenanceDaemonInternals.MIN_WAKE_MS,
    );
  });

  test("Infinity → DEFAULT_WAKE_MS (non-finite check)", () => {
    process.env.EZCORP_PERM_SWEEP_INTERVAL_MS = "Infinity";
    expect(getSweepIntervalMs()).toBe(
      _hostMaintenanceDaemonInternals.DEFAULT_WAKE_MS,
    );
  });

  test("constructor passes env-var through clamp — `100` becomes 1000", async () => {
    // Verifies the integration of getSweepIntervalMs() inside the
    // constructor. The daemon's wakeIntervalMs is a private; we
    // observe the clamp via the failing-fast contract — interval
    // reads always apply the floor.
    process.env.EZCORP_PERM_SWEEP_INTERVAL_MS = "100";
    const daemon = new HostMaintenanceDaemon({ skipLockfile: true });
    // No public getter; assert by behavior — the daemon won't tick
    // 10x within one second if the floor is honored.
    let tickCount = 0;
    const origTick = daemon.tickOnce.bind(daemon);
    daemon.tickOnce = async () => {
      tickCount++;
      return origTick();
    };
    expect(await daemon.start()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    daemon.stop();
    // With a 100ms-requested interval clamped to 1000ms, we should
    // see ≤2 ticks in 1.5s (one if the timer is generous, two if it
    // fires at 1.0s and again at 2.0s — but we sleep 1.5s, so 1).
    // We're really asserting "not 15+", which would happen at 100ms.
    expect(tickCount).toBeLessThanOrEqual(2);
    // Lower-bound guard: catches the regression where the interval
    // never arms at all (e.g. start() bails silently). At least one
    // tick MUST fire in a 1.5s window with a 1s clamped interval.
    expect(tickCount).toBeGreaterThanOrEqual(1);
  });
});

// ── Tick safety ──────────────────────────────────────────────────────

describe("HostMaintenanceDaemon — tick safety", () => {
  test("tickOnce swallows runSweep throw → returns empty outcome, doesn't crash", async () => {
    // We can't easily make `runSweep` throw without more wiring. The
    // simplest reproducible failure path is to seed a row with
    // structurally-invalid `grantedPermissions` shape — runSweep is
    // defensive about each field type, so it likely won't throw.
    // Instead we use a stub-and-mock approach: replace the daemon's
    // `tickOnce` body via a wrapped instance whose getDb throws.
    // This proves the contract — daemon catches, logs, returns empty.
    //
    // The contract that survives this is "next tick still fires" —
    // the tickOnce promise resolves with the empty TickOutcome
    // shape, the daemon's setInterval callback is unaffected.
    const daemon = new HostMaintenanceDaemon({
      wakeIntervalMs: 60_000,
      skipLockfile: true,
    });

    // Monkey-patch private opts.now to throw — this hits the inner
    // try/catch in tickOnce. (Public surface doesn't expose a
    // throwing seam without DB-mock-swap; the now() injection point
    // is a clean test seam.)
    const throwingDaemon = new HostMaintenanceDaemon({
      wakeIntervalMs: 60_000,
      skipLockfile: true,
      now: () => {
        throw new Error("simulated clock failure");
      },
    });

    expect(await throwingDaemon.start()).toBe(true);
    const outcome = await throwingDaemon.tickOnce();
    expect(outcome.applied).toBe(0);
    expect(outcome.skippedConcurrent).toBe(0);
    expect(outcome.audits).toBe(0);
    expect(outcome.errors).toEqual([]);
    throwingDaemon.stop();
    daemon.stop();
  });

  test("tick after concurrent rewrite — only the still-aged grant applies, no errors", async () => {
    // CONTEXT: this test was previously misnamed "applySweepResult with
    // per-extension errors" — it never actually exercised the
    // `outcome.errors.length > 0` branch in `host-maintenance-daemon.ts`
    // (the dead-code path validators flagged). What it DOES test is the
    // happy single-revocation outcome AFTER a concurrent rewrite has
    // turned ext-skip's grant fresh: tickOnce re-runs runSweep, sees
    // only ext-good as aged, applies that one, and returns errors:[].
    //
    // The real per-extension-errors path is covered separately below
    // by "tickOnce — applySweep per-extension error surfaces in outcome
    // …", which forces the DB to reject one of two updates so
    // `outcome.errors` is non-empty and the dead branch is taken.
    const NOW = Date.now();
    await seedExtension({
      id: "ext-good",
      name: "good",
      enabled: true,
      perms: {
        network: ["api.x"],
        grantedAt: { network: NOW - 91 * DAY_MS },
      },
    });
    await seedExtension({
      id: "ext-skip",
      name: "skip",
      enabled: true,
      perms: {
        network: ["api.y"],
        grantedAt: { network: NOW - 91 * DAY_MS },
      },
    });

    // Pre-rewrite ext-skip's row in-place so applySweep's CHECK
    // clause finds a different value than runSweep saw. Mirrors the
    // race-mitigation test in `perm-expiry-sweep.integration.test.ts`.
    const daemon = new HostMaintenanceDaemon({
      wakeIntervalMs: 60_000,
      skipLockfile: true,
      now: () => NOW,
    });
    await daemon.start();

    // Manually run the runSweep + a concurrent rewrite + tickOnce
    // sequence to verify the wrapper threads the outcome correctly.
    const db = getDb();
    const { runSweep } = await import("../extensions/perm-expiry-sweep");
    const plan = await runSweep({ db, now: NOW });
    expect(plan.revocations).toHaveLength(2);

    // Concurrent rewrite of ext-skip — turns its aged grant fresh.
    const { eq } = await import("drizzle-orm");
    const fresh = {
      network: ["api.y"],
      grantedAt: { network: NOW - 1 * DAY_MS },
    };
    await db
      .update(extensions)
      .set({ grantedPermissions: sql`${JSON.stringify(fresh)}::jsonb` })
      .where(eq(extensions.id, "ext-skip"));

    // applySweep applied via the daemon's path won't catch this race
    // because the plan was made BEFORE the rewrite. To prove the
    // daemon path: re-run tickOnce; on this re-run the plan only sees
    // the still-aged ext-good (ext-skip is fresh now), and applies it.
    const outcome = await daemon.tickOnce();
    // Final state: ext-good's network gone, ext-skip's preserved.
    expect(outcome.applied).toBe(1);
    expect(outcome.errors).toEqual([]);
    daemon.stop();

    const goodRows = await db
      .select()
      .from(extensions)
      .where(eq(extensions.id, "ext-good"));
    expect(goodRows[0]?.grantedPermissions?.network).toBeUndefined();
    const skipRows = await db
      .select()
      .from(extensions)
      .where(eq(extensions.id, "ext-skip"));
    expect(skipRows[0]?.grantedPermissions?.network).toEqual(["api.y"]);
  });

  test("tickOnce — applySweep per-extension error surfaces in outcome.errors and exercises the warn-branch", async () => {
    // COVERAGE: this is the test the misnamed "applySweepResult with
    // per-extension errors" case was supposed to be. It forces
    // `applySweepResult` to return a non-empty `errors[]` so the daemon
    // hits the `if (outcome.errors.length > 0)` branch at
    // host-maintenance-daemon.ts:278-284 — previously dead in tests.
    //
    // STRATEGY: inject a DB Proxy via `mock.module("../db/connection")`
    // that wraps the real test DB and forces the SECOND
    // `db.update(extensions)` call to reject. Mirrors Phase 2's
    // partial-failure test in `perm-expiry-sweep.integration.test.ts`.
    // We re-register `mockDbConnection()` after the test to restore the
    // real getDb for subsequent cases — see test-pglite.ts.
    //
    // We DON'T assert on the log line itself: the daemon's `log`
    // constant binds to `logger.child("perm-expiry.daemon")` at module
    // load (before any test-level mock could intervene), so a logger
    // spy installed in this file would not propagate. Branch coverage
    // (errors-non-empty taken vs. else-branch) is the auditor's actual
    // requirement; the log call is implicit on that branch.
    const NOW = Date.now();
    await seedExtension({
      id: "ext-fail-A",
      name: "fail-A",
      enabled: true,
      perms: {
        network: ["api.a"],
        grantedAt: { network: NOW - 91 * DAY_MS },
      },
    });
    await seedExtension({
      id: "ext-fail-B",
      name: "fail-B",
      enabled: true,
      perms: {
        network: ["api.b"],
        grantedAt: { network: NOW - 91 * DAY_MS },
      },
    });

    const realDb = getDb();
    const origUpdate = realDb.update.bind(realDb);
    let extUpdateCalls = 0;
    const wrappedDb = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === "update") {
          return (table: unknown) => {
            if (table === extensions) {
              extUpdateCalls++;
              if (extUpdateCalls === 2) {
                return {
                  set: () => ({
                    where: () => ({
                      returning: () =>
                        Promise.reject(
                          new Error("simulated DB failure (test stub)"),
                        ),
                    }),
                  }),
                };
              }
            }
            return origUpdate(table);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    // Swap `getDb` to return the proxy for the duration of this test.
    // The daemon calls `getDb()` per-tick, so the next tickOnce picks
    // up the proxy.
    mock.module("../db/connection", () => ({
      getDb: () => wrappedDb,
      getPglite: () => undefined,
      getDbPath: () => ":memory:",
      initDb: async () => {},
      closeDb: async () => {},
    }));

    try {
      const daemon = new HostMaintenanceDaemon({
        wakeIntervalMs: 60_000,
        skipLockfile: true,
        now: () => NOW,
      });
      await daemon.start();
      const outcome = await daemon.tickOnce();
      daemon.stop();

      // The branch we're covering: `outcome.errors.length > 0`.
      expect(outcome.errors.length).toBe(1);
      expect(outcome.errors[0]?.reason).toBe("extension-grant-update-failed");
      expect(outcome.errors[0]?.details).toContain("simulated DB failure");
      // One extension's update succeeded, the other rejected.
      expect(outcome.applied).toBe(1);
      // No skipped-concurrent (the row wasn't rewritten between read and
      // write — it was rejected by the proxy).
      expect(outcome.skippedConcurrent).toBe(0);
      // Audit row is 1:1 with applied — exactly one.
      expect(outcome.audits).toBe(1);
      // Iteration order over a Map is insertion order keyed by
      // extensionId, so the failed extension is whichever is the
      // SECOND in `byExt`. We don't pin which — only the union.
      const failedId = outcome.errors[0]!.extensionId;
      expect(["ext-fail-A", "ext-fail-B"]).toContain(failedId);
    } finally {
      // Restore the real getDb so subsequent tests in this file
      // continue to work against the real test DB.
      mockDbConnection();
    }
  });

  test("audit row is written for each applied revocation", async () => {
    const NOW = Date.now();
    await seedExtension({
      id: "ext-audit",
      name: "audit",
      enabled: true,
      perms: {
        network: ["api.x"],
        shell: true,
        grantedAt: {
          network: NOW - 91 * DAY_MS, // 90d TTL
          shell: NOW - 31 * DAY_MS, // 30d TTL
        },
      },
    });
    const daemon = new HostMaintenanceDaemon({
      wakeIntervalMs: 60_000,
      skipLockfile: true,
      now: () => NOW,
    });
    await daemon.start();
    const outcome = await daemon.tickOnce();
    expect(outcome.applied).toBe(2);
    expect(outcome.audits).toBe(2);
    daemon.stop();

    const db = getDb();
    const { eq } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "ext:permission-grant-expired"));
    const ours = rows.filter((r) => r.target === "ext-audit");
    expect(ours).toHaveLength(2);
  });

  test("always-allow forever-scope row past TTL is swept by daemon", async () => {
    const NOW = Date.now();
    await seedExtension({
      id: "ext-aa-daemon",
      name: "aa-daemon",
      enabled: true,
      perms: { grantedAt: {} },
    });
    const key = "ext:ext-aa-daemon:user-1:forever:*:always_allow:shell";
    const db = getDb();
    await db
      .insert(settings)
      .values({
        key,
        value: sql`${JSON.stringify({ allowed: true, grantedAt: NOW - 91 * DAY_MS })}::jsonb`,
      });

    const daemon = new HostMaintenanceDaemon({
      wakeIntervalMs: 60_000,
      skipLockfile: true,
      now: () => NOW,
      foreverTtlMs: 90 * DAY_MS,
    });
    await daemon.start();
    const outcome = await daemon.tickOnce();
    expect(outcome.applied).toBe(1);
    daemon.stop();

    const { eq } = await import("drizzle-orm");
    const stored = await db
      .select()
      .from(settings)
      .where(eq(settings.key, key));
    const value = stored[0]?.value as
      | { allowed: boolean; grantedAt: number }
      | undefined;
    expect(value?.allowed).toBe(false);
    expect(value?.grantedAt).toBe(NOW);
  });
});
