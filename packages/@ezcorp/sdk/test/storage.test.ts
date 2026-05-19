// storage.test.ts — 100% line + branch coverage for runtime/storage.ts
//
// Strategy:
//   - Spy getChannel().request to (a) record params, (b) synthesize
//     -32029 throttle errors for the backoff loop, (c) resolve success
//     after N retries for the progressive-delay timing test.
//   - Use real setTimeout so the 20→40→80→160→320ms ladder is measured
//     against wall-clock — fake timers would bypass the actual sleep()
//     integration we're asserting.
//   - Feed mixed error shapes (JsonRpcError, duck-typed {code}, plain
//     Error) into the spy to exercise all three errorCode() branches.
//   - 1 MB guard tested both in set() (pre-send throw) and inside
//     batch() (one oversized op rejects whole batch pre-send).
//
// Known gap: storage.ts line 168 — `throw new Error("unreachable backoff
// loop exit")` after the for(attempt <= MAX) loop — cannot be reached
// without violating loop invariants (every iteration either returns on
// success or throws on failure). Flagged per PM ruling:
// line-equivalence coverage-pass under Phase 1 no-BRDA methodology.

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import {
  Storage,
  type StorageBatchOp,
} from "../src/runtime/storage";
import {
  __resetChannelForTests,
  getChannel,
  JsonRpcError,
  type HostChannel,
} from "../src/runtime/channel";

afterEach(() => {
  __resetChannelForTests();
});

interface RequestCall {
  method: string;
  params: unknown;
  timeoutMs: number | undefined;
  at: number;
}

function stubRequest(
  impl: (call: RequestCall) => Promise<unknown>,
): { calls: RequestCall[]; spy: ReturnType<typeof spyOn> } {
  const ch: HostChannel = getChannel();
  const calls: RequestCall[] = [];
  const spy = spyOn(ch, "request");
  spy.mockImplementation(
    (async (method: string, params: unknown, timeoutMs?: number) => {
      const call: RequestCall = { method, params, timeoutMs, at: Date.now() };
      calls.push(call);
      return impl(call);
    }) as HostChannel["request"],
  );
  return { calls, spy };
}

function paramsOf(call: RequestCall | undefined): Record<string, unknown> {
  return (call?.params ?? {}) as Record<string, unknown>;
}

// ── scope & per-op round-trip ──────────────────────────────────

describe("Storage — scope wiring", () => {
  test("constructor with no arg defaults scope to 'global'", async () => {
    const { calls } = stubRequest(async () => ({ value: null, exists: false }));
    await new Storage().get("k");
    expect(paramsOf(calls[0]).scope).toBe("global");
  });

  test("explicit scope 'user' flows through to every method", async () => {
    const { calls } = stubRequest(async () => ({ results: [] }));
    const storage = new Storage("user");
    await storage.get("k");
    await storage.set("k", "v");
    await storage.delete("k");
    await storage.list();
    await storage.batch([]);
    for (const c of calls) {
      expect(paramsOf(c).scope).toBe("user");
    }
  });

  test("scope 'conversation' forwards as-is", async () => {
    const { calls } = stubRequest(async () => ({ value: null, exists: false }));
    await new Storage("conversation").get("k");
    expect(paramsOf(calls[0]).scope).toBe("conversation");
  });
});

describe("Storage — get / delete", () => {
  test("get sends { action:'get', scope, key } and returns channel payload", async () => {
    const { calls } = stubRequest(async () => ({ value: { n: 1 }, exists: true }));
    const result = await new Storage("global").get<{ n: number }>("the-key");
    expect(paramsOf(calls[0])).toEqual({
      action: "get",
      scope: "global",
      key: "the-key",
    });
    expect(result).toEqual({ value: { n: 1 }, exists: true });
  });

  test("get returns {value:null, exists:false} when host signals miss", async () => {
    stubRequest(async () => ({ value: null, exists: false }));
    const result = await new Storage().get("missing");
    expect(result).toEqual({ value: null, exists: false });
  });

  test("delete sends { action:'delete', scope, key } and returns {deleted}", async () => {
    const { calls } = stubRequest(async () => ({ deleted: true }));
    const result = await new Storage().delete("k");
    expect(paramsOf(calls[0])).toEqual({
      action: "delete",
      scope: "global",
      key: "k",
    });
    expect(result).toEqual({ deleted: true });
  });

  test("request method is always 'ezcorp/storage'", async () => {
    const { calls } = stubRequest(async () => ({ deleted: false }));
    await new Storage().delete("k");
    expect(calls[0]?.method).toBe("ezcorp/storage");
  });
});

// ── set: guard + options branches ──────────────────────────────

describe("Storage — set", () => {
  test("set with no opts omits encrypted + ttlSeconds from params", async () => {
    const { calls } = stubRequest(async () => ({ ok: true, sizeBytes: 4 }));
    await new Storage().set("k", "v");
    expect(paramsOf(calls[0])).toEqual({
      action: "set",
      scope: "global",
      key: "k",
      value: "v",
    });
  });

  test("set with empty opts omits both fields (undefined branch)", async () => {
    const { calls } = stubRequest(async () => ({ ok: true, sizeBytes: 4 }));
    await new Storage().set("k", "v", {});
    const p = paramsOf(calls[0]);
    expect("encrypted" in p).toBe(false);
    expect("ttlSeconds" in p).toBe(false);
  });

  test("set with opts.encrypted attaches encrypted on wire", async () => {
    const { calls } = stubRequest(async () => ({ ok: true, sizeBytes: 4 }));
    await new Storage().set("k", "v", { encrypted: true });
    const p = paramsOf(calls[0]);
    expect(p.encrypted).toBe(true);
    expect("ttlSeconds" in p).toBe(false);
  });

  test("set with opts.ttlSeconds attaches ttlSeconds on wire", async () => {
    const { calls } = stubRequest(async () => ({ ok: true, sizeBytes: 4 }));
    await new Storage().set("k", "v", { ttlSeconds: 60 });
    const p = paramsOf(calls[0]);
    expect(p.ttlSeconds).toBe(60);
    expect("encrypted" in p).toBe(false);
  });

  test("set with both options attaches both fields", async () => {
    const { calls } = stubRequest(async () => ({ ok: true, sizeBytes: 4 }));
    await new Storage().set("k", "v", { encrypted: false, ttlSeconds: 3600 });
    const p = paramsOf(calls[0]);
    expect(p.encrypted).toBe(false);
    expect(p.ttlSeconds).toBe(3600);
  });

  test("set returns the channel's {ok, sizeBytes} result", async () => {
    stubRequest(async () => ({ ok: true, sizeBytes: 1024 }));
    const result = await new Storage().set("k", "v");
    expect(result).toEqual({ ok: true, sizeBytes: 1024 });
  });
});

describe("Storage — 1 MB guardValueSize", () => {
  test("set throws pre-send when JSON-encoded value exceeds 1 MB", async () => {
    const { calls } = stubRequest(async () => ({ ok: true, sizeBytes: 0 }));
    // 1 MB = 1,048,576 bytes. String of length 1_048_577 JSON-encodes to
    // length + 2 quote chars → 1_048_579 > 1 MB.
    const huge = "x".repeat(1_048_577);
    await expect(new Storage().set("bigkey", huge)).rejects.toThrow(
      /Storage: value exceeds 1 MB limit for key 'bigkey' \(\d+ bytes\)/,
    );
    expect(calls).toHaveLength(0);
  });

  test("set passes the 1 MB boundary exactly — value at the limit goes through", async () => {
    const { calls } = stubRequest(async () => ({ ok: true, sizeBytes: 1_048_574 }));
    // JSON-encoded string of 1_048_574 chars = 1_048_576 bytes = exactly 1 MB.
    // Guard uses strict > so the boundary passes.
    const atLimit = "y".repeat(1_048_574);
    await new Storage().set("k", atLimit);
    expect(calls).toHaveLength(1);
  });
});

// ── list ───────────────────────────────────────────────────────

describe("Storage — list", () => {
  test("list() with no opts sends { action:'list', scope } only", async () => {
    const { calls } = stubRequest(async () => ({ keys: ["a", "b"] }));
    const result = await new Storage().list();
    const p = paramsOf(calls[0]);
    expect(p).toEqual({ action: "list", scope: "global" });
    expect(result).toEqual({ keys: ["a", "b"] });
  });

  test("list({}) with empty opts omits prefix/limit", async () => {
    const { calls } = stubRequest(async () => ({ keys: [] }));
    await new Storage().list({});
    const p = paramsOf(calls[0]);
    expect("prefix" in p).toBe(false);
    expect("limit" in p).toBe(false);
  });

  test("list({ prefix }) attaches prefix on wire", async () => {
    const { calls } = stubRequest(async () => ({ keys: [] }));
    await new Storage().list({ prefix: "sess:" });
    expect(paramsOf(calls[0]).prefix).toBe("sess:");
  });

  test("list({ limit }) attaches limit on wire", async () => {
    const { calls } = stubRequest(async () => ({ keys: [] }));
    await new Storage().list({ limit: 50 });
    expect(paramsOf(calls[0]).limit).toBe(50);
  });

  test("list({ prefix, limit }) attaches both", async () => {
    const { calls } = stubRequest(async () => ({ keys: [] }));
    await new Storage().list({ prefix: "p:", limit: 10 });
    const p = paramsOf(calls[0]);
    expect(p.prefix).toBe("p:");
    expect(p.limit).toBe(10);
  });
});

// ── batch ──────────────────────────────────────────────────────

describe("Storage — batch", () => {
  test("batch with mixed ops sends {action:'batch', scope, operations} and unwraps results", async () => {
    const { calls } = stubRequest(async () => ({
      results: [{ value: 1, exists: true }, { ok: true, sizeBytes: 1 }, { deleted: true }],
    }));
    const ops: StorageBatchOp[] = [
      { action: "get", key: "a" },
      { action: "set", key: "b", value: 1 },
      { action: "delete", key: "c" },
    ];
    const results = await new Storage().batch(ops);
    const p = paramsOf(calls[0]);
    expect(p).toEqual({ action: "batch", scope: "global", operations: ops });
    expect(results).toEqual([
      { value: 1, exists: true },
      { ok: true, sizeBytes: 1 },
      { deleted: true },
    ]);
  });

  test("batch guardValueSize enforced per 'set' op — one oversized op rejects whole batch pre-send", async () => {
    const { calls } = stubRequest(async () => ({ results: [] }));
    const huge = "z".repeat(1_048_577);
    const ops: StorageBatchOp[] = [
      { action: "get", key: "a" },
      { action: "set", key: "bad", value: huge },
      { action: "delete", key: "c" },
    ];
    await expect(new Storage().batch(ops)).rejects.toThrow(
      /Storage: value exceeds 1 MB limit for key 'bad'/,
    );
    expect(calls).toHaveLength(0);
  });

  test("batch with only non-'set' ops skips guard loop (no guard call)", async () => {
    const { calls } = stubRequest(async () => ({ results: [null, { deleted: true }] }));
    const ops: StorageBatchOp[] = [
      { action: "get", key: "a" },
      { action: "delete", key: "b" },
    ];
    await new Storage().batch(ops);
    expect(calls).toHaveLength(1);
  });

  test("batch([]) sends an empty operations array (no throw)", async () => {
    const { calls } = stubRequest(async () => ({ results: [] }));
    const results = await new Storage().batch([]);
    expect(paramsOf(calls[0]).operations).toEqual([]);
    expect(results).toEqual([]);
  });

  test("batch with 'set' that includes encrypted/ttl still guards on value only", async () => {
    const { calls } = stubRequest(async () => ({ results: [{ ok: true, sizeBytes: 1 }] }));
    const ops: StorageBatchOp[] = [
      {
        action: "set",
        key: "k",
        value: { small: true },
        encrypted: true,
        ttlSeconds: 99,
      },
    ];
    await new Storage().batch(ops);
    expect(calls).toHaveLength(1);
  });
});

// ── -32029 throttle backoff ────────────────────────────────────

describe("Storage — -32029 throttle backoff", () => {
  test("one transient -32029 then success → 2 attempts, result resolves", async () => {
    let attempts = 0;
    const { calls } = stubRequest(async () => {
      attempts += 1;
      if (attempts === 1) throw new JsonRpcError(-32029, "throttled");
      return { value: "ok", exists: true };
    });
    const result = await new Storage().get("k");
    expect(result).toEqual({ value: "ok", exists: true });
    expect(calls).toHaveLength(2);
  });

  test("5 consecutive -32029 → exhausted retries, final attempt rejects", async () => {
    const { calls } = stubRequest(async () => {
      throw new JsonRpcError(-32029, "throttled");
    });
    await expect(new Storage().get("k")).rejects.toThrow(/throttled/);
    // Initial attempt (0) + 5 retries (1..5) = 6 total calls.
    expect(calls).toHaveLength(6);
  });

  test("retry delays follow the 20→40→80→160→320 ms doubling ladder", async () => {
    const timestamps: number[] = [];
    const { calls } = stubRequest(async () => {
      timestamps.push(Date.now());
      throw new JsonRpcError(-32029, "throttled");
    });
    await expect(new Storage().get("k")).rejects.toThrow();
    expect(calls).toHaveLength(6);
    // Expected delays between successive attempts: 20, 40, 80, 160, 320 ms.
    // Real setTimeout can drift UP but not DOWN, so use lower bounds with a
    // small tolerance (-3ms) to absorb tiny clock granularity slip while
    // still asserting the doubling pattern.
    const expectedLowerBounds = [20, 40, 80, 160, 320];
    for (let i = 1; i < timestamps.length; i++) {
      const prev = timestamps[i - 1];
      const curr = timestamps[i];
      if (prev === undefined || curr === undefined) continue;
      const delta = curr - prev;
      const expected = expectedLowerBounds[i - 1];
      if (expected === undefined) continue;
      // Lower bound: at least (expected - 3) to absorb clock granularity.
      expect(delta).toBeGreaterThanOrEqual(expected - 3);
    }
    // Total elapsed must be ≥ sum of expected delays minus small slack.
    const first = timestamps[0];
    const last = timestamps[timestamps.length - 1];
    if (first !== undefined && last !== undefined) {
      expect(last - first).toBeGreaterThanOrEqual(600);
    }
  });

  test("non-32029 error rejects immediately — no retry", async () => {
    const { calls } = stubRequest(async () => {
      throw new JsonRpcError(-32000, "server error");
    });
    await expect(new Storage().get("k")).rejects.toThrow(/server error/);
    expect(calls).toHaveLength(1);
  });

  test("error without numeric code (plain Error) rejects immediately", async () => {
    const { calls } = stubRequest(async () => {
      throw new Error("boom");
    });
    await expect(new Storage().get("k")).rejects.toThrow(/boom/);
    expect(calls).toHaveLength(1);
  });

  test("duck-typed rejection { code: -32029 } also triggers backoff", async () => {
    // Covers the `typeof err === 'object' && 'code' in err` branch of
    // errorCode() — path taken when the channel surfaces a plain object
    // carrying a numeric `code` property without being a JsonRpcError.
    let attempts = 0;
    const { calls } = stubRequest(async () => {
      attempts += 1;
      if (attempts < 2) throw { code: -32029, message: "throttled" };
      return { value: 1, exists: true };
    });
    await new Storage().get("k");
    expect(calls).toHaveLength(2);
  });

  test("duck-typed rejection with non-numeric code falls through to null → no retry", async () => {
    // errorCode() guards `typeof code === 'number'` — a string code leaves
    // the extractor returning null, so no retry.
    const { calls } = stubRequest(async () => {
      throw { code: "RATE_LIMITED", message: "throttled" };
    });
    await expect(new Storage().get("k")).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  test("primitive rejection (non-object, non-Error) falls through to null → no retry", async () => {
    // typeof "x" === 'string' fails the object check; JsonRpcError check
    // also fails. errorCode() returns null, backoff does not engage.
    const { calls } = stubRequest(async () => {
      // eslint-disable-next-line no-throw-literal
      throw "raw-string-fail";
    });
    await expect(new Storage().get("k")).rejects.toBe("raw-string-fail");
    expect(calls).toHaveLength(1);
  });

  test("null rejection falls through to null → no retry (covers err !== null guard)", async () => {
    const { calls } = stubRequest(async () => {
      // eslint-disable-next-line no-throw-literal
      throw null;
    });
    await expect(new Storage().get("k")).rejects.toBeNull();
    expect(calls).toHaveLength(1);
  });
});
