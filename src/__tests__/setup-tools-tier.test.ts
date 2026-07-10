/**
 * WS3 — effective-tier semantics of the stream-chat model-resolution phase
 * (`resolveModelTierAndCredential` in stream-chat/setup-tools.ts).
 *
 * Three contracts, all feeding the executor's failover loop:
 *   1. PINNED turn (`options.model` set) → effectiveTier is the pinned
 *      model's OWN tier (real `tierForModel` heuristic over the resolved
 *      pi-ai model) — so a pinned Opus fails over to a powerful-tier peer,
 *      never silently to "balanced".
 *   2. UNPINNED turn → effectiveTier is the classifier's routed tier, and
 *      that same tier is what `resolveModel` receives.
 *   3. Classifier BLOWS UP (registry manifest resolver throws) → the turn
 *      still completes and effectiveTier falls back to the configured
 *      default tier. Behaviorally proves the routing-must-never-abort-a-turn
 *      isolation (the 610b2682 try/catch), not just that a warn is logged.
 *
 * The router + credentials are mocked (recording spies); `tierForModel`,
 * the tier classifier, and the SUT itself are REAL.
 */
import { test, expect, describe, beforeEach, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { AgentRun } from "../types";

// ── recording knobs (closed over by the mocks) ─────────────────────────
let resolveModelArgs: Array<{ provider?: string; model?: string; tier?: string }> = [];
let defaultTier = "balanced";
let getManifestShouldThrow = false;
let manifestLookups: string[] = [];

function piModelFor(provider: string, id: string) {
  return {
    id,
    provider,
    api: "anthropic-messages",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 4096,
  };
}

mock.module("../providers/router", () => ({
  resolveModel: async (provider?: string, modelId?: string, tier?: string) => {
    resolveModelArgs.push({ provider, model: modelId, tier });
    const p = provider ?? "prov-default";
    const m = modelId ?? `${p}-model`;
    return { provider: p, model: m, piModel: piModelFor(p, m) };
  },
  getDefaultTier: async () => defaultTier,
}));

mock.module("../providers/credentials", () => ({
  getCredential: async () => ({ type: "apikey", token: "test-key" }),
}));

mock.module("../extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      getManifest: (extId: string) => {
        manifestLookups.push(extId);
        if (getManifestShouldThrow) throw new Error("registry not ready");
        return undefined;
      },
    }),
  },
}));

import { resolveModelTierAndCredential } from "../runtime/stream-chat/setup-tools";

afterAll(() => {
  restoreModuleMocks();
});

beforeEach(() => {
  resolveModelArgs = [];
  defaultTier = "balanced";
  getManifestShouldThrow = false;
  manifestLookups = [];
});

function makeRun(): AgentRun {
  return {
    id: "run-tier-test",
    agentName: "chat",
    status: "running",
    startedAt: Date.now(),
    logs: [],
  } as AgentRun;
}

describe("resolveModelTierAndCredential — effective tier", () => {
  test("pinned model → effectiveTier is the PINNED model's own tier (tierForModel), classifier skipped", async () => {
    const run = makeRun();
    const result = await resolveModelTierAndCredential(
      run,
      "hi",
      { provider: "anthropic", model: "my-opus-4" },
      null,
      "conv-1",
    );

    // Real tierForModel: "opus" in the id → powerful.
    expect(result.effectiveTier).toBe("powerful");
    expect(result.resolved.provider).toBe("anthropic");
    expect(result.resolved.model).toBe("my-opus-4");
    // Pinned → no tier was classified or passed to resolveModel (Level-1
    // passthrough), and the registry was never consulted.
    expect(resolveModelArgs).toEqual([{ provider: "anthropic", model: "my-opus-4", tier: undefined }]);
    expect(manifestLookups).toEqual([]);
    // run.provider mirrors the resolved provider (existing contract).
    expect(run.provider).toBe("anthropic");
  });

  test("pinned fast-class model → effectiveTier 'fast' (tier tracks the pin, not a constant)", async () => {
    const result = await resolveModelTierAndCredential(
      makeRun(),
      "hi",
      { provider: "anthropic", model: "some-haiku-4" },
      null,
      "conv-1",
    );
    expect(result.effectiveTier).toBe("fast");
  });

  test("unpinned turn → effectiveTier is the classifier's routed tier, and resolveModel receives it", async () => {
    // Short tool-less prompt, no project/agent tools → heuristic routes "fast".
    const result = await resolveModelTierAndCredential(
      makeRun(),
      "hi",
      {},
      null,
      "conv-1",
    );

    expect(result.effectiveTier).toBe("fast");
    expect(resolveModelArgs).toEqual([{ provider: undefined, model: undefined, tier: "fast" }]);
  });

  test("manifest resolver THROWS → turn still completes, effectiveTier falls back to the default tier", async () => {
    // A wired extension forces the classifier to consult the (throwing)
    // registry — the failure must be contained: model resolution proceeds
    // with NO routed tier and the effective tier is the configured default.
    getManifestShouldThrow = true;
    defaultTier = "powerful"; // distinctive — proves the value comes from getDefaultTier

    const result = await resolveModelTierAndCredential(
      makeRun(),
      "hi",
      {},
      { extensionTools: { "ext-broken": ["tool-a"] } },
      "conv-1",
    );

    // The registry WAS consulted (and threw) …
    expect(manifestLookups).toEqual(["ext-broken"]);
    // … yet the turn resolved a model with no routed tier …
    expect(resolveModelArgs).toEqual([{ provider: undefined, model: undefined, tier: undefined }]);
    // … and the effective tier fell back to the configured default.
    expect(result.effectiveTier).toBe("powerful");
    expect(result.initialCred).toEqual({ type: "apikey", token: "test-key" });
  });
});
