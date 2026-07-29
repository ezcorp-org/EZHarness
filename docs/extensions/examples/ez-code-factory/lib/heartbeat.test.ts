import { test, expect, describe } from "bun:test";
import {
  makeHeartbeatKV,
  productionHeartbeatKV,
  makeRunHeartbeatKV,
  productionRunHeartbeatKV,
  runHeartbeatKey,
  isRunStale,
  withRunHeartbeat,
  STALL_AFTER_MS,
  RUN_HEARTBEAT_INTERVAL_MS,
} from "./heartbeat";
import { SWEEP_HEARTBEAT_KEY, type SweepHeartbeat } from "./sweep";

const hb: SweepHeartbeat = {
  ranAt: "2026-07-16T00:00:00.000Z",
  summary: { scanned: 2, advanced: 1, stillParked: 1, skipped: 0, stalled: 0 },
};

/** A fake storage-like recording set() calls. */
function fakeStorage(seed: SweepHeartbeat | null) {
  const writes: Array<{ key: string; value: unknown }> = [];
  return {
    writes,
    async get<T = unknown>(_key: string) {
      return seed !== null
        ? { value: seed as unknown as T, exists: true }
        : { value: null, exists: false };
    },
    async set(key: string, value: unknown) {
      writes.push({ key, value });
    },
  };
}

describe("makeHeartbeatKV", () => {
  test("read returns the stored heartbeat when present", async () => {
    const kv = makeHeartbeatKV(fakeStorage(hb));
    expect(await kv.read()).toEqual(hb);
  });

  test("read returns null when absent", async () => {
    const kv = makeHeartbeatKV(fakeStorage(null));
    expect(await kv.read()).toBeNull();
  });

  test("write persists under the heartbeat key", async () => {
    const storage = fakeStorage(null);
    const kv = makeHeartbeatKV(storage);
    await kv.write(hb);
    expect(storage.writes).toEqual([{ key: SWEEP_HEARTBEAT_KEY, value: hb }]);
  });
});

describe("productionHeartbeatKV", () => {
  test("constructs a KV backed by global Storage (no channel touch until used)", () => {
    const kv = productionHeartbeatKV();
    expect(typeof kv.read).toBe("function");
    expect(typeof kv.write).toBe("function");
  });
});

// ── Per-run liveness heartbeat (L3) ─────────────────────────────────

/** A fake storage-like recording set() calls, seeded with a string value. */
function fakeRunStorage(seed: string | null) {
  const writes: Array<{ key: string; value: unknown }> = [];
  return {
    writes,
    async get<T = unknown>(_key: string) {
      return seed !== null
        ? { value: seed as unknown as T, exists: true }
        : { value: null, exists: false };
    },
    async set(key: string, value: unknown) {
      writes.push({ key, value });
    },
  };
}

describe("runHeartbeatKey", () => {
  test("namespaces under heartbeats/", () => {
    expect(runHeartbeatKey("run_1")).toBe("heartbeats/run_1");
  });
});

describe("makeRunHeartbeatKV", () => {
  test("read returns the stored ISO string when present", async () => {
    const kv = makeRunHeartbeatKV(fakeRunStorage("2026-07-21T00:00:00.000Z"));
    expect(await kv.read("run_1")).toBe("2026-07-21T00:00:00.000Z");
  });

  test("read returns null when absent", async () => {
    const kv = makeRunHeartbeatKV(fakeRunStorage(null));
    expect(await kv.read("run_1")).toBeNull();
  });

  test("read returns null when the stored value is not a string (defensive)", async () => {
    const kv = makeRunHeartbeatKV({
      async get<T = unknown>(_key: string) {
        return { value: 42 as unknown as T, exists: true };
      },
      async set() {},
    });
    expect(await kv.read("run_1")).toBeNull();
  });

  test("write persists the ISO string under the run heartbeat key", async () => {
    const storage = fakeRunStorage(null);
    const kv = makeRunHeartbeatKV(storage);
    await kv.write("run_1", "2026-07-21T00:00:00.000Z");
    expect(storage.writes).toEqual([
      { key: "heartbeats/run_1", value: "2026-07-21T00:00:00.000Z" },
    ]);
  });
});

describe("productionRunHeartbeatKV", () => {
  test("constructs a KV backed by global Storage (no channel touch until used)", () => {
    const kv = productionRunHeartbeatKV();
    expect(typeof kv.read).toBe("function");
    expect(typeof kv.write).toBe("function");
  });
});

describe("isRunStale", () => {
  const now = 2_000_000_000_000;

  test("only a running run can be stale", () => {
    const old = new Date(now - STALL_AFTER_MS - 1).toISOString();
    for (const status of ["created", "awaiting_approval", "checks_passed", "completed", "stalled"] as const) {
      expect(isRunStale({ status, updatedAt: old }, old, now)).toBe(false);
    }
    expect(isRunStale({ status: "running", updatedAt: old }, old, now)).toBe(true);
  });

  test("uses the MAX of updatedAt and heartbeat — a fresh heartbeat keeps it alive", () => {
    const oldUpdated = new Date(now - STALL_AFTER_MS - 60_000).toISOString();
    const freshHb = new Date(now - 1_000).toISOString();
    expect(isRunStale({ status: "running", updatedAt: oldUpdated }, freshHb, now)).toBe(false);
    // and a fresh updatedAt keeps it alive even with an old heartbeat
    const freshUpdated = new Date(now - 1_000).toISOString();
    const oldHb = new Date(now - STALL_AFTER_MS - 60_000).toISOString();
    expect(isRunStale({ status: "running", updatedAt: freshUpdated }, oldHb, now)).toBe(false);
  });

  test("null heartbeat + frozen updatedAt → stale", () => {
    const frozen = new Date(now - STALL_AFTER_MS - 1).toISOString();
    expect(isRunStale({ status: "running", updatedAt: frozen }, null, now)).toBe(true);
  });

  test("exactly at the threshold is NOT stale (strictly greater trips)", () => {
    const atThreshold = new Date(now - STALL_AFTER_MS).toISOString();
    expect(isRunStale({ status: "running", updatedAt: atThreshold }, null, now)).toBe(false);
    const oneMsPast = new Date(now - STALL_AFTER_MS - 1).toISOString();
    expect(isRunStale({ status: "running", updatedAt: oneMsPast }, null, now)).toBe(true);
  });

  test("unparseable timestamps degrade to 0 (never a throw) → stale for a positive now", () => {
    expect(isRunStale({ status: "running", updatedAt: "not-a-date" }, "also-garbage", now)).toBe(true);
  });
});

describe("withRunHeartbeat", () => {
  /** A manual scheduler: captures the interval callback so a test drives ticks. */
  function manualSchedule() {
    let captured: (() => void) | null = null;
    let stopped = false;
    const schedule = (fn: () => void, _ms: number) => {
      captured = fn;
      return () => {
        stopped = true;
      };
    };
    return {
      schedule,
      tick: () => captured?.(),
      wasStopped: () => stopped,
    };
  }

  test("beats immediately, on each interval tick, and clears the interval on settle", async () => {
    const writes: Array<{ runId: string; at: string }> = [];
    const sched = manualSchedule();
    let clock = 1_000;
    const result = await withRunHeartbeat(
      {
        write: async (runId, at) => {
          writes.push({ runId, at });
        },
        now: () => clock,
        schedule: sched.schedule,
        intervalMs: 60_000,
      },
      "run_1",
      async () => {
        sched.tick(); // one interval fires mid-execute
        clock = 2_000;
        sched.tick();
        return "done";
      },
    );
    // Let the swallowed async writes flush.
    await Promise.resolve();
    await Promise.resolve();
    expect(result).toBe("done");
    expect(sched.wasStopped()).toBe(true);
    // immediate + two ticks = 3 beats, all for run_1
    expect(writes).toHaveLength(3);
    expect(writes.every((w) => w.runId === "run_1")).toBe(true);
    expect(writes[0]!.at).toBe(new Date(1_000).toISOString());
    expect(writes[2]!.at).toBe(new Date(2_000).toISOString());
  });

  test("a heartbeat write failure is swallowed — the run still completes", async () => {
    const sched = manualSchedule();
    const result = await withRunHeartbeat(
      {
        write: async () => {
          throw new Error("storage down");
        },
        now: () => 0,
        schedule: sched.schedule,
      },
      "run_1",
      async () => "ok",
    );
    await Promise.resolve();
    expect(result).toBe("ok");
    expect(sched.wasStopped()).toBe(true);
  });

  test("clears the interval even when fn rejects (and rethrows)", async () => {
    const sched = manualSchedule();
    await expect(
      withRunHeartbeat(
        { write: async () => {}, now: () => 0, schedule: sched.schedule },
        "run_1",
        async () => {
          throw new Error("step exploded");
        },
      ),
    ).rejects.toThrow("step exploded");
    expect(sched.wasStopped()).toBe(true);
  });

  test("exposes a sane default cadence", () => {
    expect(RUN_HEARTBEAT_INTERVAL_MS).toBe(60_000);
    expect(STALL_AFTER_MS).toBe(10 * 60 * 1000);
  });
});
