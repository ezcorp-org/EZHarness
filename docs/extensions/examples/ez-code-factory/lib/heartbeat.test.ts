import { test, expect, describe } from "bun:test";
import { makeHeartbeatKV, productionHeartbeatKV } from "./heartbeat";
import { SWEEP_HEARTBEAT_KEY, type SweepHeartbeat } from "./sweep";

const hb: SweepHeartbeat = {
  ranAt: "2026-07-16T00:00:00.000Z",
  summary: { scanned: 2, advanced: 1, stillParked: 1, skipped: 0 },
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
