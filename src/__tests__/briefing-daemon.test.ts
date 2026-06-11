/**
 * BriefingDaemon unit tests (PGlite + injected pipeline + clock).
 *
 * Spec §10 floor: claim-before-dispatch (no double-fire under
 * concurrent ticks), fire-once catch-up, auto-disable at 5, timeout
 * (guard) path, disable-mid-run, injectable clock — plus the
 * concurrency cap (3) and the runtime-not-registered fail-safe.
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { BriefingDaemon } from "../runtime/briefing/daemon";
import {
  getBriefingConfig,
  BRIEFING_AUTO_DISABLE_AFTER,
  type BriefingConfig,
} from "../db/queries/briefing-configs";
import type { BriefingRunResult } from "../runtime/briefing/run";
import {
  registerBriefingRuntime,
  _resetBriefingRuntimeForTests,
} from "../runtime/briefing/runtime-registry";
import { users, briefingConfigs } from "../db/schema";
import { eq } from "drizzle-orm";

const NOW = new Date("2026-06-10T12:00:00.000Z");

let userIds: string[] = [];

interface PipelineCall {
  config: BriefingConfig;
  catchUp: boolean;
}

beforeAll(async () => {
  await setupTestDb();
}, 30_000);

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(async () => {
  _resetBriefingRuntimeForTests();
  const db = getTestDb();
  await db.delete(briefingConfigs);
  await db.delete(users);
  userIds = [];
  for (let i = 0; i < 6; i++) {
    const [u] = await db.insert(users).values({
      email: `u${i}@t.local`,
      passwordHash: "x",
      name: `U${i}`,
    }).returning();
    userIds.push(u!.id);
  }
});

async function seedConfig(opts: {
  userId: string;
  nextFireAt: Date | null;
  enabled?: boolean;
  consecutiveErrors?: number;
}): Promise<void> {
  await getTestDb().insert(briefingConfigs).values({
    userId: opts.userId,
    enabled: opts.enabled ?? true,
    cron: "0 7 * * *",
    timezone: "UTC",
    nextFireAt: opts.nextFireAt,
    consecutiveErrors: opts.consecutiveErrors ?? 0,
  });
}

function makeDaemon(opts: {
  result?: BriefingRunResult | ((config: BriefingConfig) => BriefingRunResult);
  pending?: boolean;
  reject?: boolean;
  guardTimeoutMs?: number;
  maxConcurrent?: number;
  wakeIntervalMs?: number;
  now?: () => Date;
  onAutoDisable?: (config: BriefingConfig, count: number) => Promise<void>;
}): { daemon: BriefingDaemon; calls: PipelineCall[]; resolvers: Array<(r: BriefingRunResult) => void> } {
  const calls: PipelineCall[] = [];
  const resolvers: Array<(r: BriefingRunResult) => void> = [];
  const daemon = new BriefingDaemon({
    wakeIntervalMs: opts.wakeIntervalMs ?? 60_000,
    maxConcurrent: opts.maxConcurrent ?? 3,
    guardTimeoutMs: opts.guardTimeoutMs ?? 10_000,
    now: opts.now ?? (() => NOW),
    runPipeline: async (config, { catchUp }) => {
      calls.push({ config, catchUp });
      if (opts.reject) throw new Error("pipeline exploded");
      if (opts.pending) {
        return new Promise<BriefingRunResult>((resolve) => resolvers.push(resolve));
      }
      const r = opts.result ?? { status: "ok" as const, conversationId: "c-1" };
      return typeof r === "function" ? r(config) : r;
    },
    onAutoDisable: opts.onAutoDisable ?? (async () => {}),
  });
  return { daemon, calls, resolvers };
}

describe("tick — claim and dispatch", () => {
  test("claims a due config and dispatches the pipeline with the injected clock", async () => {
    await seedConfig({ userId: userIds[0]!, nextFireAt: new Date("2026-06-10T11:59:30.000Z") });
    const { daemon, calls } = makeDaemon({});

    const tick = await daemon.tick();
    expect(tick.claimed).toBe(1);
    await tick.settled;

    expect(calls).toHaveLength(1);
    expect(calls[0]!.config.userId).toBe(userIds[0]!);
    // Slot was only 30s past — NOT a catch-up.
    expect(calls[0]!.catchUp).toBe(false);

    const row = await getBriefingConfig(userIds[0]!);
    expect(row!.lastFireStatus).toBe("ok");
    // Fire-once advancement: next slot computed from NOW.
    expect(row!.nextFireAt).toEqual(new Date("2026-06-11T07:00:00.000Z"));
  });

  test("not-due and disabled configs are never dispatched", async () => {
    await seedConfig({ userId: userIds[0]!, nextFireAt: new Date("2026-06-11T07:00:00.000Z") }); // future
    await seedConfig({ userId: userIds[1]!, nextFireAt: new Date("2026-06-10T07:00:00.000Z"), enabled: false });
    const { daemon, calls } = makeDaemon({});
    const tick = await daemon.tick();
    expect(tick.claimed).toBe(0);
    await tick.settled;
    expect(calls).toHaveLength(0);
  });

  test("fire-once catch-up: a slot missed by hours fires ONCE with catchUp=true", async () => {
    // Host slept through three 7am slots; nextFireAt is 3 days stale.
    await seedConfig({ userId: userIds[0]!, nextFireAt: new Date("2026-06-07T07:00:00.000Z") });
    const { daemon, calls } = makeDaemon({});

    const first = await daemon.tick();
    expect(first.claimed).toBe(1);
    await first.settled;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.catchUp).toBe(true);

    // No fire-all: the next tick has nothing to claim.
    const second = await daemon.tick();
    expect(second.claimed).toBe(0);
    expect(calls).toHaveLength(1);
  });

  test("no double-fire under concurrent ticks", async () => {
    await seedConfig({ userId: userIds[0]!, nextFireAt: new Date("2026-06-10T07:00:00.000Z") });
    const { daemon, calls } = makeDaemon({});
    const [a, b] = await Promise.all([daemon.tick(), daemon.tick()]);
    await Promise.all([a.settled, b.settled]);
    expect(a.claimed + b.claimed).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

describe("concurrency cap", () => {
  test("claims at most maxConcurrent (3) and refuses further claims while in flight", async () => {
    for (let i = 0; i < 5; i++) {
      await seedConfig({ userId: userIds[i]!, nextFireAt: new Date("2026-06-10T07:00:00.000Z") });
    }
    const { daemon, calls, resolvers } = makeDaemon({ pending: true });

    const first = await daemon.tick();
    expect(first.claimed).toBe(3);
    expect(calls).toHaveLength(3);
    expect(daemon._getInFlightForTests()).toBe(3);

    // Capacity exhausted — the second tick claims nothing even though
    // two configs are still due.
    const second = await daemon.tick();
    expect(second.claimed).toBe(0);

    // Free the slots → the remaining two get claimed.
    for (const resolve of resolvers.splice(0)) resolve({ status: "ok" });
    await first.settled;
    expect(daemon._getInFlightForTests()).toBe(0);

    const third = await daemon.tick();
    expect(third.claimed).toBe(2);
    for (const resolve of resolvers.splice(0)) resolve({ status: "ok" });
    await third.settled;
    expect(calls).toHaveLength(5);
  });
});

describe("fire-result bookkeeping", () => {
  test("pipeline error increments consecutiveErrors", async () => {
    await seedConfig({ userId: userIds[0]!, nextFireAt: new Date("2026-06-10T07:00:00.000Z") });
    const { daemon } = makeDaemon({ result: { status: "error", error: "no creds" } });
    const tick = await daemon.tick();
    await tick.settled;
    const row = await getBriefingConfig(userIds[0]!);
    expect(row!.lastFireStatus).toBe("error");
    expect(row!.consecutiveErrors).toBe(1);
    expect(row!.enabled).toBe(true);
  });

  test("a throwing pipeline is folded into an error result", async () => {
    await seedConfig({ userId: userIds[0]!, nextFireAt: new Date("2026-06-10T07:00:00.000Z") });
    const { daemon } = makeDaemon({ reject: true });
    const tick = await daemon.tick();
    await tick.settled;
    const row = await getBriefingConfig(userIds[0]!);
    expect(row!.lastFireStatus).toBe("error");
    expect(row!.consecutiveErrors).toBe(1);
  });

  test("'skipped' is recorded without touching the error counter", async () => {
    await seedConfig({ userId: userIds[0]!, nextFireAt: new Date("2026-06-10T07:00:00.000Z"), consecutiveErrors: 2 });
    const { daemon } = makeDaemon({ result: { status: "skipped" } });
    const tick = await daemon.tick();
    await tick.settled;
    const row = await getBriefingConfig(userIds[0]!);
    expect(row!.lastFireStatus).toBe("skipped");
    expect(row!.consecutiveErrors).toBe(2);
  });

  test("auto-disables at 5 consecutive errors and posts the one-time notification", async () => {
    await seedConfig({
      userId: userIds[0]!,
      nextFireAt: new Date("2026-06-10T07:00:00.000Z"),
      consecutiveErrors: BRIEFING_AUTO_DISABLE_AFTER - 1,
    });
    const notified: Array<{ userId: string; count: number }> = [];
    const { daemon } = makeDaemon({
      result: { status: "error", error: "still broken" },
      onAutoDisable: async (config, count) => {
        notified.push({ userId: config.userId, count });
      },
    });
    const tick = await daemon.tick();
    await tick.settled;

    const row = await getBriefingConfig(userIds[0]!);
    expect(row!.enabled).toBe(false);
    expect(row!.consecutiveErrors).toBe(BRIEFING_AUTO_DISABLE_AFTER);
    expect(row!.nextFireAt).toBeNull();
    expect(notified).toEqual([{ userId: userIds[0]!, count: BRIEFING_AUTO_DISABLE_AFTER }]);

    // Disabled — never claimed again.
    const next = await daemon.tick();
    expect(next.claimed).toBe(0);
  });

  test("the default onAutoDisable path (lazy notify import) is wired and fail-soft", async () => {
    // No injected onAutoDisable → the daemon lazily imports
    // notifyBriefingAutoDisabled. The config has no resolvable project
    // (no projects exist), so the real notify logs + no-ops — proving
    // the default wiring without an LLM.
    await seedConfig({
      userId: userIds[0]!,
      nextFireAt: new Date("2026-06-10T07:00:00.000Z"),
      consecutiveErrors: BRIEFING_AUTO_DISABLE_AFTER - 1,
    });
    const daemon = new BriefingDaemon({
      now: () => NOW,
      guardTimeoutMs: 5_000,
      runPipeline: async () => ({ status: "error", error: "boom" }),
    });
    const tick = await daemon.tick();
    await tick.settled; // must not reject
    const row = await getBriefingConfig(userIds[0]!);
    expect(row!.enabled).toBe(false);
  });

  test("a throwing onAutoDisable is swallowed (disable already persisted)", async () => {
    await seedConfig({
      userId: userIds[0]!,
      nextFireAt: new Date("2026-06-10T07:00:00.000Z"),
      consecutiveErrors: BRIEFING_AUTO_DISABLE_AFTER - 1,
    });
    const { daemon } = makeDaemon({
      result: { status: "error" },
      onAutoDisable: async () => {
        throw new Error("notify failed");
      },
    });
    const tick = await daemon.tick();
    await tick.settled; // must not reject
    const row = await getBriefingConfig(userIds[0]!);
    expect(row!.enabled).toBe(false);
  });
});

describe("guard timeout (slot-release safety net)", () => {
  test("a hung pipeline is recorded as an error and releases its slot", async () => {
    await seedConfig({ userId: userIds[0]!, nextFireAt: new Date("2026-06-10T07:00:00.000Z") });
    const { daemon } = makeDaemon({ pending: true, guardTimeoutMs: 20 });
    const tick = await daemon.tick();
    expect(tick.claimed).toBe(1);
    await tick.settled;
    expect(daemon._getInFlightForTests()).toBe(0);
    const row = await getBriefingConfig(userIds[0]!);
    expect(row!.lastFireStatus).toBe("error");
    expect(row!.consecutiveErrors).toBe(1);
  });
});

describe("disable-mid-run", () => {
  test("a run already claimed completes; the disabled config is not claimed again", async () => {
    await seedConfig({ userId: userIds[0]!, nextFireAt: new Date("2026-06-10T07:00:00.000Z") });
    const { daemon, resolvers } = makeDaemon({ pending: true });

    const tick = await daemon.tick();
    expect(tick.claimed).toBe(1);

    // User disables while the run is in flight.
    await getTestDb()
      .update(briefingConfigs)
      .set({ enabled: false, nextFireAt: null })
      .where(eq(briefingConfigs.userId, userIds[0]!));

    resolvers[0]!({ status: "ok", conversationId: "c-1" });
    await tick.settled;

    const row = await getBriefingConfig(userIds[0]!);
    // Run completed + recorded, but the disable stands.
    expect(row!.lastFireStatus).toBe("ok");
    expect(row!.enabled).toBe(false);

    const next = await daemon.tick();
    expect(next.claimed).toBe(0);
  });
});

describe("runtime-not-registered fail-safe", () => {
  test("without an injected pipeline AND without a registered runtime, the tick claims NOTHING", async () => {
    await seedConfig({ userId: userIds[0]!, nextFireAt: new Date("2026-06-10T07:00:00.000Z") });
    const daemon = new BriefingDaemon({ now: () => NOW });
    const tick = await daemon.tick();
    expect(tick.claimed).toBe(0);
    // The config is still due — nothing was consumed.
    const row = await getBriefingConfig(userIds[0]!);
    expect(row!.nextFireAt).toEqual(new Date("2026-06-10T07:00:00.000Z"));
    expect(row!.lastFireStatus).toBeNull();
  });

  test("a registered runtime un-gates the default pipeline path", async () => {
    await seedConfig({ userId: userIds[0]!, nextFireAt: new Date("2026-06-10T07:00:00.000Z") });
    // Register a runtime whose streamChat never gets reached: the
    // pipeline will 'skip' because the config has no resolvable
    // project (no projects exist) — which proves the claim + default
    // pipeline + bookkeeping path end-to-end without an LLM.
    registerBriefingRuntime({
      executor: {
        streamChat: async () => { throw new Error("unreachable"); },
        cancelRun: () => true,
      } as never,
      bus: { emit() {}, on() { return () => {}; }, off() {}, clear() {} } as never,
    });
    const daemon = new BriefingDaemon({ now: () => NOW, guardTimeoutMs: 5_000 });
    const tick = await daemon.tick();
    expect(tick.claimed).toBe(1);
    await tick.settled;
    const row = await getBriefingConfig(userIds[0]!);
    expect(row!.lastFireStatus).toBe("skipped");
  });
});

describe("start/stop lifecycle", () => {
  test("start() runs a boot catch-up tick, is idempotent, and stop() halts the wake loop", async () => {
    await seedConfig({ userId: userIds[0]!, nextFireAt: new Date("2026-06-10T07:00:00.000Z") });
    const { daemon, calls } = makeDaemon({ wakeIntervalMs: 3_600_000 });

    expect(await daemon.start()).toBe(true);
    // Boot tick claimed + dispatched the overdue config (fire-once).
    expect(calls).toHaveLength(1);
    expect(calls[0]!.catchUp).toBe(true);

    // Idempotent start.
    expect(await daemon.start()).toBe(true);
    expect(calls).toHaveLength(1);

    daemon.stop();
    daemon.stop(); // idempotent
  });

  test("the wake loop ticks on its interval", async () => {
    const { daemon, calls } = makeDaemon({ wakeIntervalMs: 25 });
    await seedConfig({ userId: userIds[0]!, nextFireAt: new Date("2026-06-10T07:00:00.000Z") });
    // No due rows at start (seed happened after? no — seeded above).
    await daemon.start();
    // Boot tick already claimed it; seed another due config and wait
    // for the interval to pick it up.
    await seedConfig({ userId: userIds[1]!, nextFireAt: new Date("2026-06-10T07:00:00.000Z") });
    await new Promise((resolve) => setTimeout(resolve, 120));
    daemon.stop();
    const claimedUsers = calls.map((c) => c.config.userId);
    expect(claimedUsers).toContain(userIds[0]!);
    expect(claimedUsers).toContain(userIds[1]!);
  });
});
