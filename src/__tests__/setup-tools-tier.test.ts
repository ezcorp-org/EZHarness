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
 * WS5 adds two more (second describe block): the widened turn context
 * (history / system size / attachment count) reaches the classifier, and the
 * `routingSignals` / `routingConfig` provenance is stamped on routed turns
 * only — each behind its OWN fail-open envelope.
 *
 * The router, credentials, and settings are mocked (recording spies);
 * `tierForModel`, the tier classifier, and the SUT itself are REAL.
 */
import { test, expect, describe, beforeEach, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { AgentRun } from "../types";

// ── recording knobs (closed over by the mocks) ─────────────────────────
let resolveModelArgs: Array<{ provider?: string; model?: string; tier?: string }> = [];
let defaultTier = "balanced";
let getManifestShouldThrow = false;
let manifestLookups: string[] = [];
// WS5 provenance knobs: what the settings read returns, whether it blows up,
// and which keys were actually read (proves the pinned path reads nothing).
let preferenceOrder: unknown = ["anthropic", "openai"];
let getSettingShouldThrow = false;
let settingReads: string[] = [];
let getDefaultTierCalls = 0;

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
  getDefaultTier: async () => {
    getDefaultTierCalls++;
    return defaultTier;
  },
}));

mock.module("../providers/credentials", () => ({
  getCredential: async () => ({ type: "apikey", token: "test-key" }),
}));

mock.module("../db/queries/settings", () => ({
  getSetting: async (key: string) => {
    settingReads.push(key);
    if (getSettingShouldThrow) throw new Error("settings table unavailable");
    return key === "provider:preferenceOrder" ? preferenceOrder : undefined;
  },
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
import { preferenceOrderHash, TOOL_RESULT_ROLE } from "../runtime/tier-classifier";

afterAll(() => {
  restoreModuleMocks();
});

beforeEach(() => {
  resolveModelArgs = [];
  defaultTier = "balanced";
  getManifestShouldThrow = false;
  manifestLookups = [];
  preferenceOrder = ["anthropic", "openai"];
  getSettingShouldThrow = false;
  settingReads = [];
  getDefaultTierCalls = 0;
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

/**
 * WS5 — the widened classifier at the seam + routing provenance.
 *
 * Two contracts:
 *   1. The turn context (history / system size / attachment count) threaded
 *      in here actually reaches the classifier, so a short follow-up inside
 *      a tool loop routes as the context-heavy turn it is.
 *   2. `routingSignals` + `routingConfig` are stamped on ROUTED turns only,
 *      and each is independently fail-open — provenance can never change or
 *      break the routing decision.
 */
describe("resolveModelTierAndCredential — WS5 turn context + provenance", () => {
  const toolLoopHistory = [
    { role: "user", content: "run the tests" },
    { role: "assistant", content: "calling the shell tool" },
    { role: TOOL_RESULT_ROLE, content: "3 failures" },
  ];

  test("THE motivating turn: four-word follow-up + tool-loop history → powerful", async () => {
    const result = await resolveModelTierAndCredential(
      makeRun(),
      "now fix it",
      {},
      null,
      "conv-1",
      { history: toolLoopHistory },
    );

    // Pre-WS5 this scored on "now fix it".length alone and routed "fast".
    expect(result.effectiveTier).toBe("powerful");
    expect(resolveModelArgs).toEqual([{ provider: undefined, model: undefined, tier: "powerful" }]);
    expect(result.routingSignals?.reason).toBe("tool-messages");
    expect(result.routingSignals?.hasToolMessages).toBe(true);
    expect(result.routingSignals?.historyMessageCount).toBe(3);
  });

  test("the same message WITHOUT the tool-loop history still routes fast", async () => {
    // Isolates the cause: the tier moved because of the history, not the text.
    const result = await resolveModelTierAndCredential(
      makeRun(),
      "now fix it",
      {},
      null,
      "conv-1",
      { history: [] },
    );
    expect(result.effectiveTier).toBe("fast");
    expect(result.routingSignals?.reason).toBe("short-turn");
  });

  test("system size and attachment count reach the classifier and the signals", async () => {
    const result = await resolveModelTierAndCredential(
      makeRun(),
      "hi",
      {},
      null,
      "conv-1",
      { history: [{ role: "user", content: "prior turn" }], systemChars: 800, attachmentCount: 3 },
    );
    expect(result.routingSignals?.systemChars).toBe(800);
    expect(result.routingSignals?.attachmentCount).toBe(3);
    expect(result.routingSignals?.historyChars).toBe("prior turn".length);
    expect(result.routingSignals?.promptChars).toBe(2);
    // 3 attachments × 750 tokens dominates → over FAST_MAX, under POWERFUL_MIN.
    expect(result.effectiveTier).toBe("balanced");
  });

  test("routed turn stamps routingConfig: effective default tier + preference-order hash", async () => {
    defaultTier = "powerful";
    preferenceOrder = ["openai", "anthropic", "google"];

    const result = await resolveModelTierAndCredential(makeRun(), "hi", {}, null, "conv-1");

    expect(result.routingConfig).toEqual({
      defaultTier: "powerful",
      preferenceOrderHash: preferenceOrderHash(["openai", "anthropic", "google"]),
    });
    expect(settingReads).toEqual(["provider:preferenceOrder"]);
    // The classifier's tier still won — routingConfig is provenance only.
    expect(result.effectiveTier).toBe("fast");
  });

  test("a non-array preference-order setting hashes as the empty order (no throw)", async () => {
    preferenceOrder = "not-an-array";
    const result = await resolveModelTierAndCredential(makeRun(), "hi", {}, null, "conv-1");
    expect(result.routingConfig?.preferenceOrderHash).toBe(preferenceOrderHash([]));
  });

  test("non-string entries in the preference order are dropped before hashing", async () => {
    preferenceOrder = ["anthropic", 7, null, "openai"];
    const result = await resolveModelTierAndCredential(makeRun(), "hi", {}, null, "conv-1");
    expect(result.routingConfig?.preferenceOrderHash).toBe(
      preferenceOrderHash(["anthropic", "openai"]),
    );
  });

  test("PINNED turn stamps NO provenance and reads NO settings (zero added I/O)", async () => {
    const result = await resolveModelTierAndCredential(
      makeRun(),
      "hi",
      { provider: "anthropic", model: "my-opus-4" },
      null,
      "conv-1",
      { history: toolLoopHistory, systemChars: 99_999, attachmentCount: 9 },
    );

    // A pinned turn is never re-routed, so there is no verdict to report …
    expect(result.routingSignals).toBeUndefined();
    expect(result.routingConfig).toBeUndefined();
    // … and the provenance reads never happen on the pinned path.
    expect(settingReads).toEqual([]);
    expect(getDefaultTierCalls).toBe(0);
    // The pin still wins over the (screaming-powerful) turn context.
    expect(result.resolved.model).toBe("my-opus-4");
    expect(result.effectiveTier).toBe("powerful");
  });

  test("settings read THROWS → tier verdict survives; only routingConfig is dropped", async () => {
    // The two provenance reads live in SEPARATE fail-open envelopes, so a
    // settings blip must not discard a tier we already classified.
    getSettingShouldThrow = true;

    const result = await resolveModelTierAndCredential(
      makeRun(),
      "now fix it",
      {},
      null,
      "conv-1",
      { history: toolLoopHistory },
    );

    expect(result.routingConfig).toBeUndefined();
    // The classifier's work was NOT thrown away.
    expect(result.effectiveTier).toBe("powerful");
    expect(result.routingSignals?.reason).toBe("tool-messages");
    expect(resolveModelArgs).toEqual([{ provider: undefined, model: undefined, tier: "powerful" }]);
  });

  test("classifier THROWS → no routingSignals, but routingConfig still lands", async () => {
    // Mirror image of the test above: the envelopes are independent in both
    // directions. The default tier is read ONCE and reused for effectiveTier.
    getManifestShouldThrow = true;
    defaultTier = "balanced";

    const result = await resolveModelTierAndCredential(
      makeRun(),
      "hi",
      {},
      { extensionTools: { "ext-broken": ["tool-a"] } },
      "conv-1",
    );

    expect(result.routingSignals).toBeUndefined();
    expect(result.routingConfig).toEqual({
      defaultTier: "balanced",
      preferenceOrderHash: preferenceOrderHash(["anthropic", "openai"]),
    });
    expect(result.effectiveTier).toBe("balanced");
    // Reused, not read twice: the config read already fetched the default.
    expect(getDefaultTierCalls).toBe(1);
  });

  test("BOTH envelopes fail → turn still completes on the default tier", async () => {
    // Total provenance blackout: the registry throws AND the settings read
    // throws. No provenance is stamped, and the turn falls back to the
    // configured default tier exactly as it did pre-WS5 — routing is
    // best-effort and must never abort a turn.
    getManifestShouldThrow = true;
    getSettingShouldThrow = true;
    defaultTier = "powerful";

    const result = await resolveModelTierAndCredential(
      makeRun(),
      "hi",
      {},
      { extensionTools: { "ext-broken": ["tool-a"] } },
      "conv-1",
    );

    expect(result.routingSignals).toBeUndefined();
    expect(result.routingConfig).toBeUndefined();
    expect(result.effectiveTier).toBe("powerful");
    expect(resolveModelArgs).toEqual([{ provider: undefined, model: undefined, tier: undefined }]);
  });

  test("legacy caller (no turnContext) classifies exactly as before WS5", async () => {
    // The regression guard at the seam: omitting the new parameter must not
    // move the tier for any existing caller.
    const withContext = await resolveModelTierAndCredential(
      makeRun(),
      "hi",
      {},
      null,
      "conv-1",
      { history: [], systemChars: 0, attachmentCount: 0 },
    );
    const legacy = await resolveModelTierAndCredential(makeRun(), "hi", {}, null, "conv-1");

    expect(legacy.effectiveTier).toBe("fast");
    expect(legacy.effectiveTier).toBe(withContext.effectiveTier);
    expect(legacy.routingSignals).toEqual(withContext.routingSignals);
  });
});
