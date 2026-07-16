// loop-store.test.ts — Storage-backed run store, per-run keys + withLock.
//
// Proves the spec's substrate invariants WITHOUT a live channel by
// injecting an in-memory KV that mimics the `Storage` surface. Focus:
//   - ONE key per run + an index key (never a single packed blob)
//   - concurrency: two simultaneous claims don't clobber the index
//     (asserted via an interleaved/awaitable fake storage)
//   - idempotent claim (open-dupe = no-op)
//   - transition + retention eviction of oldest TERMINAL keys
//   - meta (failure bookkeeping)

import { describe, expect, test } from "bun:test";

import {
  createLoopRunStore,
  cursorKey,
  indexKey,
  metaKey,
  runKey,
} from "../src/runtime/loop-store";
import { resolveContract } from "../src/runtime/loop-core";
import type { StorageScope } from "../src/runtime/storage";

// ── In-memory KV mimicking the Storage subset the store uses ─────────

interface KvHooks {
  /** Called before each `set` resolves — lets a test interleave writes. */
  beforeSet?: (key: string) => Promise<void> | void;
}

function makeKv(hooks: KvHooks = {}) {
  const map = new Map<string, unknown>();
  const factory = (_scope: StorageScope) => ({
    async get<T>(key: string) {
      return map.has(key)
        ? { value: map.get(key) as T, exists: true }
        : { value: null, exists: false };
    },
    async set<T>(key: string, value: T) {
      if (hooks.beforeSet) await hooks.beforeSet(key);
      // Deep-copy so callers can't mutate stored state by reference (the
      // real Storage round-trips through JSON).
      map.set(key, JSON.parse(JSON.stringify(value)));
      return { ok: true as const, sizeBytes: 0 };
    },
    async delete(key: string) {
      const had = map.delete(key);
      return { deleted: had };
    },
    async list() {
      return { keys: [...map.keys()] };
    },
  });
  return { map, factory };
}

const CONTRACT = {
  states: ["dispatched", "running", "completed", "failed", "cancelled"],
  terminal: ["completed", "failed", "cancelled"],
  scope: "global" as StorageScope,
  idempotencyKey: (input: unknown) => (input as { key?: string }).key,
  retention: { maxRuns: 3, maxEventsPerRun: 5 },
};

describe("contract acceptance", () => {
  test("accepts an already-RESOLVED contract (loop.ts production path)", async () => {
    const kv = makeKv();
    const resolved = resolveContract(CONTRACT);
    const store = createLoopRunStore("ezc", resolved, kv.factory);
    const { run, created } = await store.claim({
      id: "r1",
      loopId: "ezc",
      status: "dispatched",
    });
    expect(created).toBe(true);
    expect(run.scope).toBe("global");
    expect(kv.map.get("loop:ezc:index")).toEqual(["r1"]);
  });

  test("defaults to the real Storage backend when no factory is given", () => {
    // Exercises the production default-param arrow `(scope) => new Storage(scope)`
    // — every other test injects an in-memory KV, so this is the only path
    // that constructs the real `Storage` (its constructor is channel-free; a
    // store method would talk to the host, which we don't invoke here). The
    // store object resolving with the full facade proves the default ran.
    const store = createLoopRunStore("ezc", CONTRACT);
    expect(typeof store.claim).toBe("function");
    expect(typeof store.transition).toBe("function");
    expect(typeof store.get).toBe("function");
  });
});

describe("key grammar", () => {
  test("per-run key + index + meta + cursor are distinct, namespaced", () => {
    expect(runKey("ezc", "r1")).toBe("loop:ezc:run:r1");
    expect(indexKey("ezc")).toBe("loop:ezc:index");
    expect(metaKey("ezc")).toBe("loop:ezc:meta");
    expect(cursorKey("ezc")).toBe("loop:ezc:cursor");
  });
});

describe("claim — per-run keys, not a packed blob", () => {
  test("each claim writes its own run key + appends to the index", async () => {
    const kv = makeKv();
    const store = createLoopRunStore("ezc", CONTRACT, kv.factory);
    await store.claim({ id: "r1", loopId: "ezc", status: "dispatched" });
    await store.claim({ id: "r2", loopId: "ezc", status: "dispatched" });

    expect(kv.map.has("loop:ezc:run:r1")).toBe(true);
    expect(kv.map.has("loop:ezc:run:r2")).toBe(true);
    // Index is newest-first.
    expect(kv.map.get("loop:ezc:index")).toEqual(["r2", "r1"]);
    // No single "runs" blob.
    expect(kv.map.has("loop:ezc:runs")).toBe(false);
  });

  test("list() reads runs in index (newest-first) order", async () => {
    const kv = makeKv();
    const store = createLoopRunStore("ezc", CONTRACT, kv.factory);
    await store.claim({ id: "r1", loopId: "ezc", status: "dispatched" });
    await store.claim({ id: "r2", loopId: "ezc", status: "running" });
    const runs = await store.list();
    expect(runs.map((r) => r.id)).toEqual(["r2", "r1"]);
  });
});

describe("claim — idempotency (open dupe = no-op)", () => {
  test("second claim with the same key on an OPEN run returns the existing run", async () => {
    const kv = makeKv();
    const store = createLoopRunStore("ezc", CONTRACT, kv.factory);
    const a = await store.claim({
      id: "r1",
      loopId: "ezc",
      status: "running",
      input: { key: "dup" },
      idempotencyKey: "dup",
    });
    expect(a.created).toBe(true);
    const b = await store.claim({
      id: "r2",
      loopId: "ezc",
      status: "running",
      input: { key: "dup" },
      idempotencyKey: "dup",
    });
    expect(b.created).toBe(false);
    expect(b.run.id).toBe("r1");
    // r2 was NOT written.
    expect(kv.map.has("loop:ezc:run:r2")).toBe(false);
    expect(kv.map.get("loop:ezc:index")).toEqual(["r1"]);
  });

  test("same key after the prior run went terminal → a fresh run is created", async () => {
    const kv = makeKv();
    const store = createLoopRunStore("ezc", CONTRACT, kv.factory);
    await store.claim({
      id: "r1",
      loopId: "ezc",
      status: "completed",
      idempotencyKey: "dup",
    });
    const b = await store.claim({
      id: "r2",
      loopId: "ezc",
      status: "running",
      idempotencyKey: "dup",
    });
    expect(b.created).toBe(true);
    expect(b.run.id).toBe("r2");
  });
});

describe("transition + get", () => {
  test("advances status + appends a capped event; unknown run → null", async () => {
    const kv = makeKv();
    const store = createLoopRunStore("ezc", CONTRACT, kv.factory);
    await store.claim({ id: "r1", loopId: "ezc", status: "dispatched" });
    const updated = await store.transition("r1", {
      status: "completed",
      outcome: { ok: true },
    });
    expect(updated?.status).toBe("completed");
    expect(updated?.outcome).toEqual({ ok: true });
    expect(updated?.events[0]?.status).toBe("completed");

    expect(await store.transition("nope", { status: "completed" })).toBeNull();
  });

  test("get() reads one run by id, or null when absent", async () => {
    const kv = makeKv();
    const store = createLoopRunStore("ezc", CONTRACT, kv.factory);
    await store.claim({ id: "r1", loopId: "ezc", status: "running" });
    expect((await store.get("r1"))?.id).toBe("r1");
    expect(await store.get("missing")).toBeNull();
  });

  test("an OMITTED status keeps the run's CURRENT status (resolved under lock)", async () => {
    const kv = makeKv();
    const store = createLoopRunStore("ezc", CONTRACT, kv.factory);
    await store.claim({ id: "r1", loopId: "ezc", status: "running" });
    // Event-only update (no status) — records a "steered" event but keeps
    // the run "running". No caller pre-read; transition resolves it.
    const updated = await store.transition("r1", { eventStatus: "steered", note: "go" });
    expect(updated?.status).toBe("running"); // unchanged
    expect(updated?.events[0]).toMatchObject({ status: "steered", note: "go" });
  });

  test("TOCTOU: an event-only update does NOT revert a concurrent status flip", async () => {
    // Interleave a status flip (running→completed) with an event-only
    // "steered" update. withLock serializes them; because the event-only
    // update resolves its status UNDER the lock (not from a stale pre-read),
    // the run lands at "completed" — the steered event never reverts it.
    const kv = makeKv();
    const store = createLoopRunStore("ezc", CONTRACT, kv.factory);
    await store.claim({ id: "r1", loopId: "ezc", status: "running" });
    await Promise.all([
      store.transition("r1", { status: "completed" }),
      store.transition("r1", { eventStatus: "steered", note: "mid" }),
    ]);
    const run = await store.get("r1");
    expect(run?.status).toBe("completed"); // the flip survives — no revert
    // Both the flip + the steered event are present (+ the initial claim
    // event), in whatever order the lock serialized them.
    const statuses = run!.events.map((e) => e.status);
    expect(statuses).toContain("completed");
    expect(statuses).toContain("steered");
  });
});

describe("retention", () => {
  test("evicts the oldest TERMINAL run key + index entry beyond maxRuns", async () => {
    const kv = makeKv();
    const store = createLoopRunStore("ezc", CONTRACT, kv.factory); // maxRuns 3
    // Four terminal runs; the 4th claim must evict the oldest (r1).
    await store.claim({ id: "r1", loopId: "ezc", status: "completed" });
    await store.claim({ id: "r2", loopId: "ezc", status: "completed" });
    await store.claim({ id: "r3", loopId: "ezc", status: "completed" });
    await store.claim({ id: "r4", loopId: "ezc", status: "completed" });

    const ids = (await store.list()).map((r) => r.id);
    expect(ids).toEqual(["r4", "r3", "r2"]);
    expect(kv.map.has("loop:ezc:run:r1")).toBe(false);
    expect(kv.map.get("loop:ezc:index")).toEqual(["r4", "r3", "r2"]);
  });

  test("never evicts an OPEN run even when over budget", async () => {
    const kv = makeKv();
    const store = createLoopRunStore("ezc", CONTRACT, kv.factory);
    await store.claim({ id: "open1", loopId: "ezc", status: "running" });
    await store.claim({ id: "open2", loopId: "ezc", status: "running" });
    await store.claim({ id: "open3", loopId: "ezc", status: "running" });
    await store.claim({ id: "open4", loopId: "ezc", status: "running" });
    const ids = (await store.list()).map((r) => r.id).sort();
    expect(ids).toEqual(["open1", "open2", "open3", "open4"]);
  });
});

describe("meta — failure bookkeeping", () => {
  test("defaults then round-trips", async () => {
    const kv = makeKv();
    const store = createLoopRunStore("ezc", CONTRACT, kv.factory);
    expect(await store.getMeta()).toEqual({ consecutiveErrors: 0, disabled: false });
    await store.setMeta({ consecutiveErrors: 2, disabled: true });
    expect(await store.getMeta()).toEqual({ consecutiveErrors: 2, disabled: true });
  });
});

describe("cursor — durable check marker", () => {
  test("unset cursor reads undefined", async () => {
    const kv = makeKv();
    const store = createLoopRunStore("ezc", CONTRACT, kv.factory);
    expect(await store.getCursor()).toBeUndefined();
  });

  test("set → get round-trips, persisted under loop:<id>:cursor", async () => {
    const kv = makeKv();
    const store = createLoopRunStore("ezc", CONTRACT, kv.factory);
    await store.setCursor("abc123");
    expect(await store.getCursor<string>()).toBe("abc123");
    // Written to the dedicated cursor key — never mixed into runs/meta.
    expect(kv.map.get("loop:ezc:cursor")).toBe("abc123");
    expect(kv.map.has("loop:ezc:index")).toBe(false);
  });

  test("a later set overwrites the prior cursor", async () => {
    const kv = makeKv();
    const store = createLoopRunStore("ezc", CONTRACT, kv.factory);
    await store.setCursor("first");
    await store.setCursor("second");
    expect(await store.getCursor<string>()).toBe("second");
  });

  test("falsy cursor values round-trip (presence keyed on existence)", async () => {
    const kv = makeKv();
    const store = createLoopRunStore("ezc", CONTRACT, kv.factory);
    await store.setCursor(0);
    expect(await store.getCursor<number>()).toBe(0);
    await store.setCursor("");
    expect(await store.getCursor<string>()).toBe("");
    await store.setCursor(false);
    expect(await store.getCursor<boolean>()).toBe(false);
  });

  test("structured cursor value survives the JSON round-trip", async () => {
    const kv = makeKv();
    const store = createLoopRunStore("ezc", CONTRACT, kv.factory);
    await store.setCursor({ hash: "deadbeef", at: "2026-07-16T00:00:00Z" });
    expect(await store.getCursor<{ hash: string; at: string }>()).toEqual({
      hash: "deadbeef",
      at: "2026-07-16T00:00:00Z",
    });
  });
});

describe("concurrency — withLock serializes interleaved claims", () => {
  test("two simultaneous claims both land; the index keeps BOTH ids", async () => {
    // Gate the FIRST set so we can start the second claim while the first
    // is mid-flight. Without withLock the second claim would read the
    // empty index and overwrite the first's index entry (the ez-code
    // race). withLock forces them to run end-to-end in order.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let gatedOnce = false;
    const kv = makeKv({
      beforeSet: async (key) => {
        if (!gatedOnce && key === "loop:ezc:run:r1") {
          gatedOnce = true;
          await gate;
        }
      },
    });
    const store = createLoopRunStore("ezc", CONTRACT, kv.factory);

    const p1 = store.claim({ id: "r1", loopId: "ezc", status: "running" });
    const p2 = store.claim({ id: "r2", loopId: "ezc", status: "running" });
    // Let the second claim try to run; withLock must hold it behind p1.
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all([p1, p2]);

    const ids = (await store.list()).map((r) => r.id);
    // BOTH ids present — no clobber.
    expect(ids.sort()).toEqual(["r1", "r2"]);
    expect((kv.map.get("loop:ezc:index") as string[]).sort()).toEqual([
      "r1",
      "r2",
    ]);
  });
});
