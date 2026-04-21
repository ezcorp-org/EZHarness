// Unit tests for src/extensions/spawn-quota.ts (Phase 2d).
//
// Covers the dual-tracker contract: rolling-hour quota + concurrent cap +
// bus-driven release on run:complete / run:error / run:cancel.
// Uses a real `EventBus` so the wiring between `release()` and the three
// termination events is exercised end-to-end.

import { test, expect, describe, beforeEach } from "bun:test";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import { createSpawnQuota } from "../extensions/spawn-quota";

const CFG_1 = { maxPerHour: 10, maxConcurrent: 1 };
const CFG_3 = { maxPerHour: 10, maxConcurrent: 3 };

function runPayload(id: string): AgentEvents["run:complete"] {
  // Minimal `AgentRun`-shaped object — the release path only reads
  // `data.run.id`, so the rest is `{} as any` to keep tests small.
  return { run: { id } } as AgentEvents["run:complete"];
}

// ── Basic reservation + release ─────────────────────────────────────

describe("SpawnQuota — basic reservation + release", () => {
  let bus: EventBus<AgentEvents>;
  beforeEach(() => { bus = new EventBus<AgentEvents>(); });

  test("check+reserve lets up to maxConcurrent through; the next rejects", () => {
    const q = createSpawnQuota(bus);
    const ext = "ext-a";

    expect(q.check(ext, CFG_3).ok).toBe(true);
    q.reserve(ext, "run-1");
    expect(q.check(ext, CFG_3).ok).toBe(true);
    q.reserve(ext, "run-2");
    expect(q.check(ext, CFG_3).ok).toBe(true);
    q.reserve(ext, "run-3");

    const r = q.check(ext, CFG_3);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("concurrent-exceeded");
    expect(r.details?.limit).toBe(3);
    expect(q._concurrentCount(ext)).toBe(3);

    q.dispose();
  });

  test("bus.emit(run:complete) releases the matching slot", () => {
    const q = createSpawnQuota(bus);
    const ext = "ext-a";
    q.reserve(ext, "run-1");
    expect(q._concurrentCount(ext)).toBe(1);

    bus.emit("run:complete", runPayload("run-1"));
    expect(q._concurrentCount(ext)).toBe(0);

    q.dispose();
  });

  test("run:error also releases", () => {
    const q = createSpawnQuota(bus);
    q.reserve("ext-a", "run-err");
    bus.emit("run:error", { run: { id: "run-err" }, error: "x" } as AgentEvents["run:error"]);
    expect(q._concurrentCount("ext-a")).toBe(0);
    q.dispose();
  });

  test("run:cancel also releases", () => {
    const q = createSpawnQuota(bus);
    q.reserve("ext-a", "run-cx");
    bus.emit("run:cancel", { run: { id: "run-cx" } } as AgentEvents["run:cancel"]);
    expect(q._concurrentCount("ext-a")).toBe(0);
    q.dispose();
  });

  test("unknown runId on bus is a no-op", () => {
    const q = createSpawnQuota(bus);
    bus.emit("run:complete", runPayload("never-reserved"));
    // No throw, no state change.
    expect(q._concurrentCount("ext-a")).toBe(0);
    q.dispose();
  });
});

// ── Cross-extension isolation ───────────────────────────────────────

describe("SpawnQuota — per-extension isolation", () => {
  test("reservations under one extension don't count against another's quota", () => {
    const bus = new EventBus<AgentEvents>();
    const q = createSpawnQuota(bus);
    q.reserve("ext-a", "a-1");
    // Different ext at the same cap — fresh budget.
    expect(q.check("ext-b", CFG_1).ok).toBe(true);
    q.reserve("ext-b", "b-1");
    expect(q.check("ext-b", CFG_1).ok).toBe(false);
    // ext-a still has one slot used; bus release for b-1 doesn't touch a-1.
    bus.emit("run:complete", runPayload("b-1"));
    expect(q._concurrentCount("ext-a")).toBe(1);
    expect(q._concurrentCount("ext-b")).toBe(0);
    q.dispose();
  });
});

// ── Rolling hourly window ───────────────────────────────────────────

describe("SpawnQuota — rolling hourly window", () => {
  test("maxPerHour exceeded returns hourly-exceeded with windowMs", () => {
    const bus = new EventBus<AgentEvents>();
    const q = createSpawnQuota(bus);
    const cfg = { maxPerHour: 2, maxConcurrent: 10 };

    q.reserve("ext-a", "r1");
    q.reserve("ext-a", "r2");
    // Even after releasing the concurrent slots, the hourly counter
    // keeps the timestamps.
    bus.emit("run:complete", runPayload("r1"));
    bus.emit("run:complete", runPayload("r2"));

    const r = q.check("ext-a", cfg);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("hourly-exceeded");
    expect(r.details?.limit).toBe(2);
    expect(r.details?.windowMs).toBe(3_600_000);
    q.dispose();
  });

  test("entries outside the 1-hour window are pruned on check", () => {
    const bus = new EventBus<AgentEvents>();
    const q = createSpawnQuota(bus);
    const cfg = { maxPerHour: 1, maxConcurrent: 10 };

    // Shim Date.now to a fixed past-time for the first reserve, then advance.
    const realNow = Date.now;
    let fakeNow = 1_000_000_000_000;
    (Date as unknown as { now: () => number }).now = () => fakeNow;
    try {
      q.reserve("ext-a", "r-old");
      // 61 minutes later — old entry is outside the 1-hour window.
      fakeNow += 61 * 60 * 1000;
      // Release the concurrent slot manually (bus release is sync — but we
      // never emitted run:complete for r-old).
      q.release("r-old");
      expect(q.check("ext-a", cfg).ok).toBe(true);
    } finally {
      (Date as unknown as { now: () => number }).now = realNow;
    }
    q.dispose();
  });
});

// ── swapReservation ─────────────────────────────────────────────────

describe("SpawnQuota — swapReservation", () => {
  test("re-keying preserves the concurrent count; bus release on new token frees it", () => {
    const bus = new EventBus<AgentEvents>();
    const q = createSpawnQuota(bus);
    q.reserve("ext-a", "speculative-tok");
    expect(q._concurrentCount("ext-a")).toBe(1);

    q.swapReservation("ext-a", "speculative-tok", "real-run-id");
    expect(q._concurrentCount("ext-a")).toBe(1); // unchanged

    // Old token no longer a release vehicle.
    bus.emit("run:complete", runPayload("speculative-tok"));
    expect(q._concurrentCount("ext-a")).toBe(1);

    // New token is.
    bus.emit("run:complete", runPayload("real-run-id"));
    expect(q._concurrentCount("ext-a")).toBe(0);
    q.dispose();
  });

  test("swap under wrong extension is a no-op (defense-in-depth)", () => {
    const bus = new EventBus<AgentEvents>();
    const q = createSpawnQuota(bus);
    q.reserve("ext-a", "tok");
    q.swapReservation("ext-b", "tok", "new");    // wrong ext
    // Swap ignored — old token still under ext-a.
    expect(q._concurrentCount("ext-a")).toBe(1);
    expect(q._concurrentCount("ext-b")).toBe(0);
    // Original token still frees correctly.
    bus.emit("run:complete", runPayload("tok"));
    expect(q._concurrentCount("ext-a")).toBe(0);
    q.dispose();
  });
});

// ── dispose ─────────────────────────────────────────────────────────

describe("SpawnQuota — dispose", () => {
  test("after dispose, bus events no longer release reservations", () => {
    const bus = new EventBus<AgentEvents>();
    const q = createSpawnQuota(bus);
    q.reserve("ext-a", "r1");
    q.dispose();
    bus.emit("run:complete", runPayload("r1"));
    // Dispose removed the bus listener, so the release never ran.
    // Manual release still works (defensive contract).
    expect(q._concurrentCount("ext-a")).toBe(1);
    q.release("r1");
    expect(q._concurrentCount("ext-a")).toBe(0);
  });
});
