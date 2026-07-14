/**
 * Unit tests for `src/contexts/model-support.ts` — the resource-aware local
 * model support gate. Every probe branch, the TTL/invalidation cache, the
 * peek (cached-only) read, and the boot warmup, all with injected deps (no
 * network, DB, or model).
 */
import { test, expect, describe, beforeEach } from "bun:test";
import {
  checkModelSupport,
  getModelSupport,
  peekModelSupport,
  invalidateModelSupport,
  resolveLocalModel,
  warmupModelSupport,
  _resetModelSupportForTests,
  SUPPORTED_TTL_MS,
  FAILURE_TTL_MS,
  MODEL_SUPPORT_LOAD_BUDGET_MS,
  type ModelSupportDeps,
} from "../contexts/model-support";

const BASE = "http://localhost:11434";
const MODEL = "qwen3.5:4b";

function deps(overrides: ModelSupportDeps = {}): ModelSupportDeps {
  return {
    checkReachability: async () => ({ reachable: true, endpointType: "ollama" }),
    checkAvailability: async () => ({ available: true }),
    runInference: async () => ({ success: true, latencyMs: 10 }),
    getSuggestConfig: async () => ({ baseUrl: BASE, model: MODEL }),
    nowFn: () => 1_000,
    ...overrides,
  };
}

beforeEach(() => {
  _resetModelSupportForTests();
});

describe("checkModelSupport branches", () => {
  test("endpoint unreachable → endpoint-down", async () => {
    const r = await checkModelSupport(BASE, MODEL, deps({
      checkReachability: async () => ({ reachable: false, endpointType: null, error: "refused" }),
    }));
    expect(r).toEqual({ supported: false, baseUrl: BASE, model: MODEL, reason: "endpoint-down", checkedAt: 1_000 });
  });

  test("reachable but no endpoint type → endpoint-down", async () => {
    const r = await checkModelSupport(BASE, MODEL, deps({
      checkReachability: async () => ({ reachable: true, endpointType: null }),
    }));
    expect(r.reason).toBe("endpoint-down");
  });

  test("model tag absent → model-missing", async () => {
    const r = await checkModelSupport(BASE, MODEL, deps({
      checkAvailability: async () => ({ available: false, error: "not found" }),
    }));
    expect(r).toMatchObject({ supported: false, reason: "model-missing" });
  });

  test("inference succeeds → supported (no reason)", async () => {
    const r = await checkModelSupport(BASE, MODEL, deps());
    expect(r).toEqual({ supported: true, baseUrl: BASE, model: MODEL, checkedAt: 1_000 });
    expect(r.reason).toBeUndefined();
  });

  test("inference passes the 30s cold-load budget to runInference", async () => {
    let seenTimeout: number | undefined;
    await checkModelSupport(BASE, MODEL, deps({
      runInference: async (_u, _m, _t, timeoutMs) => {
        seenTimeout = timeoutMs;
        return { success: true, latencyMs: 5 };
      },
    }));
    expect(seenTimeout).toBe(MODEL_SUPPORT_LOAD_BUDGET_MS);
  });

  test("inference times out/aborts → timeout", async () => {
    const r = await checkModelSupport(BASE, MODEL, deps({
      runInference: async () => ({ success: false, latencyMs: 30_000, error: "The operation was aborted due to timeout" }),
    }));
    expect(r.reason).toBe("timeout");
  });

  test("inference fails for another reason → load-failed", async () => {
    const r = await checkModelSupport(BASE, MODEL, deps({
      runInference: async () => ({ success: false, latencyMs: 200, error: "500 out of memory" }),
    }));
    expect(r.reason).toBe("load-failed");
  });

  test("inference fails with no error string → load-failed", async () => {
    const r = await checkModelSupport(BASE, MODEL, deps({
      runInference: async () => ({ success: false, latencyMs: 200 }),
    }));
    expect(r.reason).toBe("load-failed");
  });

  test("default nowFn (Date.now) stamps checkedAt when not injected", async () => {
    const before = Date.now();
    const r = await checkModelSupport(BASE, MODEL, {
      checkReachability: async () => ({ reachable: true, endpointType: "ollama" }),
      checkAvailability: async () => ({ available: true }),
      runInference: async () => ({ success: true, latencyMs: 1 }),
    });
    expect(r.checkedAt).toBeGreaterThanOrEqual(before);
  });
});

describe("getModelSupport cache + TTL", () => {
  test("cold → probes and caches", async () => {
    let calls = 0;
    const d = deps({ runInference: async () => { calls++; return { success: true, latencyMs: 1 }; } });
    const r1 = await getModelSupport(BASE, MODEL, d);
    expect(r1.supported).toBe(true);
    expect(calls).toBe(1);
    // second call within TTL → cached, no re-probe
    const r2 = await getModelSupport(BASE, MODEL, d);
    expect(r2).toBe(r1);
    expect(calls).toBe(1);
  });

  test("supported entry re-probes after SUPPORTED_TTL_MS", async () => {
    let calls = 0;
    const run = async () => { calls++; return { success: true as const, latencyMs: 1 }; };
    await getModelSupport(BASE, MODEL, deps({ runInference: run, nowFn: () => 1_000 }));
    // just inside the TTL → cached
    await getModelSupport(BASE, MODEL, deps({ runInference: run, nowFn: () => 1_000 + SUPPORTED_TTL_MS - 1 }));
    expect(calls).toBe(1);
    // past the TTL → re-probe
    await getModelSupport(BASE, MODEL, deps({ runInference: run, nowFn: () => 1_000 + SUPPORTED_TTL_MS + 1 }));
    expect(calls).toBe(2);
  });

  test("failure entry uses the SHORTER FAILURE_TTL_MS", async () => {
    let calls = 0;
    const run = async () => { calls++; return { success: false as const, latencyMs: 1, error: "oom" }; };
    await getModelSupport(BASE, MODEL, deps({ runInference: run, nowFn: () => 1_000 }));
    // still within the supported TTL but PAST the failure TTL → must re-probe
    await getModelSupport(BASE, MODEL, deps({ runInference: run, nowFn: () => 1_000 + FAILURE_TTL_MS + 1 }));
    expect(calls).toBe(2);
  });

  test("different baseUrl/model → distinct cache keys (auto re-probe on settings change)", async () => {
    let calls = 0;
    const run = async () => { calls++; return { success: true as const, latencyMs: 1 }; };
    await getModelSupport(BASE, MODEL, deps({ runInference: run }));
    await getModelSupport(BASE, "qwen3:1.7b", deps({ runInference: run }));
    await getModelSupport("http://other:11434", MODEL, deps({ runInference: run }));
    expect(calls).toBe(3);
  });
});

describe("peekModelSupport (cached-only, never probes)", () => {
  test("returns null when cold", () => {
    expect(peekModelSupport(BASE, MODEL, 1_000)).toBeNull();
  });

  test("returns a fresh cached entry", async () => {
    await getModelSupport(BASE, MODEL, deps({ nowFn: () => 1_000 }));
    expect(peekModelSupport(BASE, MODEL, 1_000)?.supported).toBe(true);
  });

  test("returns null once the cached entry is stale", async () => {
    await getModelSupport(BASE, MODEL, deps({ nowFn: () => 1_000 }));
    expect(peekModelSupport(BASE, MODEL, 1_000 + SUPPORTED_TTL_MS + 1)).toBeNull();
  });

  test("default now argument", async () => {
    await getModelSupport(BASE, MODEL, deps({ nowFn: () => Date.now() }));
    expect(peekModelSupport(BASE, MODEL)?.supported).toBe(true);
  });
});

describe("invalidateModelSupport", () => {
  test("clears every entry → next peek is cold", async () => {
    await getModelSupport(BASE, MODEL, deps({ nowFn: () => 1_000 }));
    invalidateModelSupport();
    expect(peekModelSupport(BASE, MODEL, 1_000)).toBeNull();
  });
});

describe("resolveLocalModel", () => {
  test("returns the suggest config endpoint + model", async () => {
    const r = await resolveLocalModel(deps());
    expect(r).toEqual({ baseUrl: BASE, model: MODEL });
  });

  test("null baseUrl when no endpoint configured", async () => {
    const r = await resolveLocalModel(deps({ getSuggestConfig: async () => ({ baseUrl: null, model: MODEL }) }));
    expect(r.baseUrl).toBeNull();
  });
});

describe("warmupModelSupport", () => {
  test("primes the default-local entry", async () => {
    let calls = 0;
    await warmupModelSupport(deps({ runInference: async () => { calls++; return { success: true, latencyMs: 1 }; } }));
    expect(calls).toBe(1);
    expect(peekModelSupport(BASE, MODEL, 1_000)?.supported).toBe(true);
  });

  test("no local endpoint → no-op (nothing cached)", async () => {
    let calls = 0;
    await warmupModelSupport(deps({
      getSuggestConfig: async () => ({ baseUrl: null, model: MODEL }),
      runInference: async () => { calls++; return { success: true, latencyMs: 1 }; },
    }));
    expect(calls).toBe(0);
    expect(peekModelSupport(BASE, MODEL, 1_000)).toBeNull();
  });

  test("swallows a probe/config failure (never blocks boot)", async () => {
    await expect(
      warmupModelSupport(deps({ getSuggestConfig: async () => { throw new Error("db down"); } })),
    ).resolves.toBeUndefined();
  });
});
