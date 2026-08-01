/**
 * WS3b — the mode → model/tier binding AT THE ROUTING SEAM
 * (`resolveModelTierAndCredential` in stream-chat/setup-tools.ts).
 *
 * `mode-binding.test.ts` pins the pure precedence logic. This file pins the
 * WIRING: that the seam reads the right columns for the turn's `modeId`,
 * threads the result into `resolveModel` and the classifier, and — the part a
 * pure test cannot reach — that every failure mode degrades to the next
 * precedence level instead of breaking the turn.
 *
 * ── BEHAVIOUR CHANGE this file documents ──
 * `modes.preferred_model` / `preferred_provider` have existed, been typed,
 * validated and persisted since modes shipped, and NOTHING read them. Anyone
 * who set a preferred model on a mode has been getting no effect at all. From
 * this commit that mode pins its model on every new conversation. The
 * "…now takes effect" tests below are the explicit regression record of that
 * fix; the old no-op behaviour must not come back.
 *
 * Availability is declared through the REAL `getModelRegistry`, via the
 * `provider:customModels` setting — the same surface an operator uses — so the
 * test never has to guess which ids pi-ai's catalog ships this week. The
 * router, credentials, settings and the modes query are mocked; the tier
 * classifier, `tierForModel`, `getModelRegistry`, the binding module and the
 * SUT itself are REAL.
 */
import { test, expect, describe, beforeEach, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { AgentRun } from "../types";
import type { DbMode } from "../db/queries/modes";

// ── recording knobs (closed over by the mocks) ─────────────────────────
let resolveModelArgs: Array<{ provider?: string; model?: string; tier?: string }> = [];
let defaultTier = "balanced";
let getManifestShouldThrow = false;
/** What the mocked `getMode` returns; `undefined` = no such mode row. */
let modeRow: Partial<DbMode> | undefined;
let getModeShouldThrow = false;
let getModeCalls: string[] = [];
let getSettingShouldThrow = false;
/** Declares which models the deployment can run, through the real registry. */
let customModels: unknown[] = [];

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

mock.module("../db/queries/settings", () => ({
  getSetting: async (key: string) => {
    if (getSettingShouldThrow) throw new Error("settings table unavailable");
    if (key === "provider:preferenceOrder") return ["anthropic", "openai"];
    if (key === "provider:customModels") return customModels;
    return undefined;
  },
}));

mock.module("../db/queries/modes", () => ({
  getMode: async (id: string) => {
    getModeCalls.push(id);
    if (getModeShouldThrow) throw new Error("modes table unavailable");
    return modeRow;
  },
}));

mock.module("../extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      getManifest: () => {
        if (getManifestShouldThrow) throw new Error("registry not ready");
        // A wired extension that DECLARES a tier need — the one signal that
        // outranks a mode preference (correctness, not preference).
        return declaredManifestTier ? { routing: { tier: declaredManifestTier } } : undefined;
      },
    }),
  },
}));
let declaredManifestTier: string | undefined;

import { resolveModelTierAndCredential } from "../runtime/stream-chat/setup-tools";

afterAll(() => {
  restoreModuleMocks();
});

/** The catalog every test starts from: one powerful-class and one fast-class
 *  model on distinct providers, declared as custom models so the ids are
 *  stable regardless of what pi-ai's built-in catalog happens to list. */
const CUSTOM_MODELS = [
  { id: "mode-opus-4", provider: "anthropic", baseUrl: "http://localhost:1/v1" },
  { id: "mode-haiku-4", provider: "openai", baseUrl: "http://localhost:2/v1" },
];

beforeEach(() => {
  resolveModelArgs = [];
  defaultTier = "balanced";
  getManifestShouldThrow = false;
  declaredManifestTier = undefined;
  modeRow = undefined;
  getModeShouldThrow = false;
  getModeCalls = [];
  getSettingShouldThrow = false;
  customModels = [...CUSTOM_MODELS];
});

function makeRun(): AgentRun {
  return {
    id: "run-mode-binding",
    agentName: "chat",
    status: "running",
    startedAt: Date.now(),
    logs: [],
  } as AgentRun;
}

/** A `modes` row carrying only the routing columns under test. */
function mode(overrides: Partial<DbMode> = {}): Partial<DbMode> {
  return {
    id: "mode-1",
    preferredModel: null,
    preferredProvider: null,
    preferredTier: null,
    ...overrides,
  };
}

const MODE_TURN = { modeId: "mode-1" } as const;

describe("resolveModelTierAndCredential — mode binding precedence at the seam", () => {
  test("BEHAVIOUR CHANGE: a mode's preferred model now PINS the turn (was dead config)", async () => {
    // Before this commit these two columns were read by nothing: this exact
    // turn routed by the heuristic ("hi" → fast) and ignored the mode.
    modeRow = mode({ preferredProvider: "anthropic", preferredModel: "mode-opus-4" });

    const result = await resolveModelTierAndCredential(
      makeRun(),
      "hi",
      { ...MODE_TURN },
      null,
      "conv-1",
    );

    expect(result.resolved.provider).toBe("anthropic");
    expect(result.resolved.model).toBe("mode-opus-4");
    // Pinned by the mode ⇒ the classifier never ran, so no tier reached
    // resolveModel and no classifier provenance is stamped.
    expect(resolveModelArgs).toEqual([
      { provider: "anthropic", model: "mode-opus-4", tier: undefined },
    ]);
    expect(result.routingSignals).toBeUndefined();
    expect(result.routingConfig).toBeUndefined();
    // The mode pin is a pin like any other: failover looks for a peer of the
    // model actually serving the turn ("opus" → powerful).
    expect(result.effectiveTier).toBe("powerful");
  });

  test("a per-turn / conversation model pin beats the mode, and the mode row is never read", async () => {
    modeRow = mode({ preferredProvider: "anthropic", preferredModel: "mode-opus-4" });

    const result = await resolveModelTierAndCredential(
      makeRun(),
      "hi",
      { ...MODE_TURN, provider: "openai", model: "user-picked-haiku" },
      null,
      "conv-1",
    );

    expect(result.resolved.model).toBe("user-picked-haiku");
    // The cache anchor: an established thread costs no added read at all.
    expect(getModeCalls).toEqual([]);
    expect(result.effectiveTier).toBe("fast");
  });

  test("a mode's preferred model beats its preferred tier", async () => {
    modeRow = mode({
      preferredProvider: "anthropic",
      preferredModel: "mode-opus-4",
      preferredTier: "fast",
    });

    const result = await resolveModelTierAndCredential(
      makeRun(),
      "hi",
      { ...MODE_TURN },
      null,
      "conv-1",
    );

    expect(result.resolved.model).toBe("mode-opus-4");
    expect(resolveModelArgs[0]!.tier).toBeUndefined();
  });

  test("a mode's preferred TIER reaches the classifier as tierHint and beats the heuristic", async () => {
    // "hi" with no tools is the heuristic's canonical `fast` turn; the mode
    // moves it to `powerful` and the verdict records WHY.
    modeRow = mode({ preferredTier: "powerful" });

    const result = await resolveModelTierAndCredential(
      makeRun(),
      "hi",
      { ...MODE_TURN },
      null,
      "conv-1",
    );

    expect(result.effectiveTier).toBe("powerful");
    expect(resolveModelArgs).toEqual([
      { provider: undefined, model: undefined, tier: "powerful" },
    ]);
    expect(result.routingSignals?.reason).toBe("hint");
    // Still a routed (unpinned) turn, so provenance IS stamped.
    expect(result.routingConfig?.defaultTier).toBe("balanced");
  });

  test("an explicit per-turn tier hint beats the mode's preferred tier", async () => {
    modeRow = mode({ preferredTier: "powerful" });

    const result = await resolveModelTierAndCredential(
      makeRun(),
      "hi",
      { ...MODE_TURN, tier: "fast" },
      null,
      "conv-1",
    );

    expect(result.effectiveTier).toBe("fast");
    expect(result.routingSignals?.reason).toBe("hint");
  });

  test("an extension's DECLARED tier need beats the mode's preferred tier", async () => {
    // A declared tier is a correctness requirement, not a preference.
    declaredManifestTier = "powerful";
    modeRow = mode({ preferredTier: "fast" });

    const result = await resolveModelTierAndCredential(
      makeRun(),
      "hi",
      { ...MODE_TURN },
      { extensionTools: { "ext-a": ["tool-a"] } },
      "conv-1",
    );

    expect(result.effectiveTier).toBe("powerful");
    expect(result.routingSignals?.reason).toBe("declared");
  });

  test("a mode that names only a PROVIDER routes that provider at the classified tier", async () => {
    modeRow = mode({ preferredProvider: "openai" });

    const result = await resolveModelTierAndCredential(
      makeRun(),
      "hi",
      { ...MODE_TURN },
      null,
      "conv-1",
    );

    expect(resolveModelArgs).toEqual([{ provider: "openai", model: undefined, tier: "fast" }]);
    expect(result.effectiveTier).toBe("fast");
  });

  test("no modeId → the mode read never happens (unchanged cost on the common path)", async () => {
    const result = await resolveModelTierAndCredential(makeRun(), "hi", {}, null, "conv-1");
    expect(getModeCalls).toEqual([]);
    expect(result.effectiveTier).toBe("fast");
  });
});

describe("resolveModelTierAndCredential — mode binding degrades, never throws", () => {
  test("a mode naming an UNAVAILABLE model falls through to its tier (not an error)", async () => {
    // The retired-snapshot case. resolveModelObject would synthesize a model
    // object for this id, so the fall-through has to be decided here.
    modeRow = mode({
      preferredProvider: "anthropic",
      preferredModel: "claude-3-5-sonnet-20241022",
      preferredTier: "balanced",
    });

    const result = await resolveModelTierAndCredential(
      makeRun(),
      "hi",
      { ...MODE_TURN },
      null,
      "conv-1",
    );

    // Not pinned to the missing model …
    expect(resolveModelArgs).toEqual([
      { provider: "anthropic", model: undefined, tier: "balanced" },
    ]);
    // … and the next precedence level (its tier) decided instead.
    expect(result.effectiveTier).toBe("balanced");
    expect(result.routingSignals?.reason).toBe("hint");
  });

  test("an unavailable model with no tier falls all the way to the heuristic", async () => {
    modeRow = mode({ preferredProvider: "anthropic", preferredModel: "gone-4" });

    const result = await resolveModelTierAndCredential(
      makeRun(),
      "hi",
      { ...MODE_TURN },
      null,
      "conv-1",
    );

    expect(result.effectiveTier).toBe("fast");
    expect(result.routingSignals?.reason).toBe("short-turn");
  });

  test("a DELETED mode (no row) degrades to the classifier", async () => {
    modeRow = undefined;

    const result = await resolveModelTierAndCredential(
      makeRun(),
      "hi",
      { modeId: "mode-that-was-deleted" },
      null,
      "conv-1",
    );

    expect(getModeCalls).toEqual(["mode-that-was-deleted"]);
    expect(result.effectiveTier).toBe("fast");
    expect(result.routingSignals?.reason).toBe("short-turn");
  });

  test("the mode READ throwing does not break the turn", async () => {
    getModeShouldThrow = true;

    const result = await resolveModelTierAndCredential(
      makeRun(),
      "hi",
      { ...MODE_TURN },
      null,
      "conv-1",
    );

    expect(result.effectiveTier).toBe("fast");
    expect(result.initialCred).toEqual({ type: "apikey", token: "test-key" });
  });

  test("the availability CATALOG read throwing does not break the turn", async () => {
    // getModelRegistry reads settings; a settings blackout must degrade the
    // mode's model preference, not abort routing. (routingConfig, which reads
    // the same failing surface, is dropped too — it is provenance only.)
    modeRow = mode({ preferredProvider: "anthropic", preferredModel: "mode-opus-4" });
    getSettingShouldThrow = true;

    const result = await resolveModelTierAndCredential(
      makeRun(),
      "hi",
      { ...MODE_TURN },
      null,
      "conv-1",
    );

    expect(resolveModelArgs).toEqual([{ provider: undefined, model: undefined, tier: "fast" }]);
    expect(result.effectiveTier).toBe("fast");
    expect(result.routingConfig).toBeUndefined();
  });

  test("a mode-pinned turn survives a classifier blow-up (it never consults it)", async () => {
    getManifestShouldThrow = true;
    modeRow = mode({ preferredProvider: "anthropic", preferredModel: "mode-opus-4" });

    const result = await resolveModelTierAndCredential(
      makeRun(),
      "hi",
      { ...MODE_TURN },
      { extensionTools: { "ext-broken": ["tool-a"] } },
      "conv-1",
    );

    expect(result.resolved.model).toBe("mode-opus-4");
    expect(result.effectiveTier).toBe("powerful");
  });

  test("an unrecognized stored preferred_tier degrades to the heuristic", async () => {
    // Plain TEXT column: the legacy onboarding vocabulary ("quality") and any
    // hand-edited value must not route on garbage.
    modeRow = mode({ preferredTier: "quality" as never });

    const result = await resolveModelTierAndCredential(
      makeRun(),
      "hi",
      { ...MODE_TURN },
      null,
      "conv-1",
    );

    expect(result.effectiveTier).toBe("fast");
    expect(result.routingSignals?.reason).toBe("short-turn");
  });
});
