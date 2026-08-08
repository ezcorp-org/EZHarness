/**
 * Custom (BYOK / local) models as tier-routing candidates.
 *
 * ── The bug this pins ──
 * `getModels("ollama")` is `[]` — ollama is not a pi-ai provider at all
 * (verified below against the real catalog, not mocked). `getModelRegistry()`
 * appended `provider:customModels` so a local model APPEARED in the picker,
 * but `findModelForProviderInTier` answered only out of the pi-ai catalog and
 * so returned null for every tier. A workflow `agent` step carries the
 * `__current__` inherit sentinel, which `resolveModel` collapses to "no pin"
 * → tier routing → null → unroutable. A local-only install therefore could
 * not serve a single workflow agent step.
 *
 * ── What must NOT change ──
 * Custom models are consulted strictly AFTER the pi-ai catalog at every step,
 * so a custom model can never displace or shadow a built-in one. Both
 * directions are asserted: the model becomes reachable AND a built-in still
 * wins wherever it used to.
 *
 * Two layers here: pure unit tests on `src/runtime/routing/custom-models.ts`
 * (100% gate), then registry/router integration against the REAL pi-ai
 * catalog with only the settings row mocked.
 */

import { describe, test, expect, beforeEach, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

const mockGetSetting = mock((_key?: string) => Promise.resolve(undefined) as Promise<unknown>);
mock.module("../db/queries/settings", () => ({
  getSetting: mockGetSetting,
  getAllSettings: mock(() => Promise.resolve({})),
  upsertSetting: mock(() => Promise.resolve()),
  deleteSetting: mock(() => Promise.resolve(false)),
  isListingInstalled: mock(() => Promise.resolve(false)),
}));

mock.module("../providers/encryption", () => ({
  encrypt: (text: string) => `encrypted:${text}`,
  decrypt: (text: string) => {
    if (text.startsWith("encrypted:")) return text.slice("encrypted:".length);
    throw new Error("Decryption failed");
  },
  _resetKeyCache: () => {},
}));

afterAll(() => restoreModuleMocks());

import {
  normalizeCustomModel,
  parseCustomModelEntries,
  customModelsForProvider,
  providersWithCustomModels,
  DEFAULT_CUSTOM_MODEL_TIER,
  DEFAULT_CUSTOM_MODEL_PROVIDER,
  type CustomModelEntry,
} from "../runtime/routing/custom-models";
import {
  findModelForProviderInTier,
  findRunnableModelForProviderInTier,
  getModelRegistry,
} from "../providers/registry";
import { resolveModel } from "../providers/router";
import { getCircuitBreaker } from "../providers/circuit-breaker";
import { getModels } from "@earendil-works/pi-ai/compat";
import { emptyTierLadder } from "../runtime/routing/tier-ladder";

const OLLAMA_ROW = {
  modelId: "qwen3:1.7b",
  provider: "ollama",
  tier: "balanced",
  baseUrl: "http://localhost:11434",
};

/** Route every settings key to undefined except the ones given. */
function settings(overrides: Record<string, unknown>): void {
  mockGetSetting.mockImplementation(((key: string) =>
    Promise.resolve(overrides[key])) as never);
}

beforeEach(() => {
  mockGetSetting.mockImplementation((() => Promise.resolve(undefined)) as never);
});

// ── The premise, proven against the real catalog ────────────────────
describe("premise: the pi-ai catalog has nothing for a local provider", () => {
  test("getModels('ollama') is empty, so a catalog-only tier lookup cannot answer", () => {
    expect(getModels("ollama" as never).length).toBe(0);
  });

  test("with no custom models, every tier for 'ollama' is still null (unchanged)", () => {
    for (const tier of ["fast", "balanced", "powerful"] as const) {
      expect(findModelForProviderInTier("ollama", tier)).toBeNull();
    }
  });
});

// ── Pure module ─────────────────────────────────────────────────────
describe("normalizeCustomModel()", () => {
  test("a full row round-trips every field", () => {
    const entry = normalizeCustomModel({
      id: "m1",
      provider: "ollama",
      tier: "fast",
      contextWindow: 8192,
      vision: true,
      reasoning: true,
      costTier: "high",
      displayName: "My Model",
      baseUrl: "http://localhost:11434",
    });
    expect(entry).toEqual({
      id: "m1",
      provider: "ollama",
      tier: "fast",
      contextWindow: 8192,
      vision: true,
      reasoning: true,
      costTier: "high",
      displayName: "My Model",
      baseUrl: "http://localhost:11434",
    });
  });

  test("the UI's `modelId` spelling is accepted as the id", () => {
    expect(normalizeCustomModel(OLLAMA_ROW)?.id).toBe("qwen3:1.7b");
  });

  test("`id` wins over `modelId` when both are present", () => {
    expect(normalizeCustomModel({ id: "a", modelId: "b", provider: "ollama" })?.id).toBe("a");
  });

  test("a row with no usable id is dropped (nothing to call)", () => {
    expect(normalizeCustomModel({ provider: "ollama" })).toBeNull();
    expect(normalizeCustomModel({ id: "", modelId: "  ", provider: "ollama" })).toBeNull();
    expect(normalizeCustomModel({ id: 42, provider: "ollama" })).toBeNull();
  });

  test("non-objects are dropped", () => {
    expect(normalizeCustomModel(null)).toBeNull();
    expect(normalizeCustomModel("qwen")).toBeNull();
    expect(normalizeCustomModel(["qwen"])).toBeNull();
    expect(normalizeCustomModel(undefined)).toBeNull();
  });

  test("a missing provider takes the picker's shipped default, not a drop", () => {
    expect(normalizeCustomModel({ id: "m" })?.provider).toBe(DEFAULT_CUSTOM_MODEL_PROVIDER);
    expect(DEFAULT_CUSTOM_MODEL_PROVIDER).toBe("ollama");
  });

  test("a missing or invalid tier takes the picker's shipped default, not a drop", () => {
    expect(normalizeCustomModel({ id: "m", provider: "ollama" })?.tier).toBe(
      DEFAULT_CUSTOM_MODEL_TIER,
    );
    expect(normalizeCustomModel({ id: "m", provider: "ollama", tier: "turbo" })?.tier).toBe(
      "balanced",
    );
    expect(normalizeCustomModel({ id: "m", provider: "ollama", tier: 3 })?.tier).toBe("balanced");
  });

  test("each valid tier is honoured verbatim (no inference from the model name)", () => {
    for (const tier of ["fast", "balanced", "powerful"] as const) {
      // "opus" would be tiered `powerful` by the catalog name heuristic; a
      // custom row's stored tier must win over any such guess.
      expect(normalizeCustomModel({ id: "opus-lookalike", provider: "ollama", tier })?.tier).toBe(
        tier,
      );
    }
  });

  test("an invalid costTier falls back to low; valid ones are kept", () => {
    expect(normalizeCustomModel({ id: "m", provider: "p", costTier: "free" })?.costTier).toBe("low");
    expect(normalizeCustomModel({ id: "m", provider: "p", costTier: "medium" })?.costTier).toBe(
      "medium",
    );
    expect(normalizeCustomModel({ id: "m", provider: "p", costTier: "high" })?.costTier).toBe(
      "high",
    );
    expect(normalizeCustomModel({ id: "m", provider: "p", costTier: "low" })?.costTier).toBe("low");
  });

  test("non-boolean vision/reasoning are treated as false", () => {
    const entry = normalizeCustomModel({ id: "m", provider: "p", vision: "yes", reasoning: 1 });
    expect(entry?.vision).toBe(false);
    expect(entry?.reasoning).toBe(false);
  });

  test("a non-numeric contextWindow falls back to 128k", () => {
    expect(normalizeCustomModel({ id: "m", provider: "p", contextWindow: "big" })?.contextWindow)
      .toBe(128_000);
  });

  test("displayName defaults to the id; a blank baseUrl becomes undefined", () => {
    const entry = normalizeCustomModel({ id: "m", provider: "p", displayName: "  ", baseUrl: "" });
    expect(entry?.displayName).toBe("m");
    expect(entry?.baseUrl).toBeUndefined();
  });
});

describe("parseCustomModelEntries()", () => {
  test("a non-array setting yields an empty list (unset / hand-edited row)", () => {
    expect(parseCustomModelEntries(undefined)).toEqual([]);
    expect(parseCustomModelEntries(null)).toEqual([]);
    expect(parseCustomModelEntries({ modelId: "m" })).toEqual([]);
    expect(parseCustomModelEntries("nope")).toEqual([]);
  });

  test("unroutable rows are skipped without discarding the routable ones", () => {
    const parsed = parseCustomModelEntries([OLLAMA_ROW, null, { provider: "ollama" }, "junk"]);
    expect(parsed.length).toBe(1);
    expect(parsed[0]!.id).toBe("qwen3:1.7b");
  });
});

describe("customModelsForProvider()", () => {
  const entries = parseCustomModelEntries([
    { modelId: "a", provider: "ollama", tier: "fast" },
    { modelId: "b", provider: "lmstudio", tier: "fast" },
    { modelId: "c", provider: "ollama", tier: "powerful" },
  ]);

  test("filters to the provider, preserving stored order", () => {
    expect(customModelsForProvider(entries, "ollama").map((e) => e.id)).toEqual(["a", "c"]);
  });

  test("an unknown provider yields nothing", () => {
    expect(customModelsForProvider(entries, "anthropic")).toEqual([]);
  });
});

describe("providersWithCustomModels()", () => {
  test("first-appearance order, deduplicated", () => {
    const entries = parseCustomModelEntries([
      { modelId: "a", provider: "ollama" },
      { modelId: "b", provider: "lmstudio" },
      { modelId: "c", provider: "ollama" },
    ]);
    expect(providersWithCustomModels(entries)).toEqual(["ollama", "lmstudio"]);
  });

  test("no entries yields no providers", () => {
    expect(providersWithCustomModels([])).toEqual([]);
  });
});

// ── Registry integration (real pi-ai catalog) ───────────────────────
describe("findModelForProviderInTier() with custom models", () => {
  const ollamaFast = parseCustomModelEntries([
    { modelId: "qwen3:1.7b", provider: "ollama", tier: "fast", baseUrl: "http://localhost:11434" },
  ]);

  test("THE FIX: a custom model in a tier is now reachable for a catalog-less provider", () => {
    const entry = findModelForProviderInTier("ollama", "fast", undefined, ollamaFast);
    expect(entry?.id).toBe("qwen3:1.7b");
    expect(entry?.baseUrl).toBe("http://localhost:11434");
  });

  test("only the tier the operator STORED — the other two stay null", () => {
    expect(findModelForProviderInTier("ollama", "balanced", undefined, ollamaFast)).toBeNull();
    expect(findModelForProviderInTier("ollama", "powerful", undefined, ollamaFast)).toBeNull();
  });

  test("a custom model registered under another provider is not borrowed", () => {
    const elsewhere = parseCustomModelEntries([
      { modelId: "mine", provider: "lmstudio", tier: "fast" },
    ]);
    expect(findModelForProviderInTier("ollama", "fast", undefined, elsewhere)).toBeNull();
  });

  test("NO DISPLACEMENT: a built-in still wins its tier when a custom model shares the provider", () => {
    const baseline = findModelForProviderInTier("anthropic", "fast");
    expect(baseline).not.toBeNull();
    const shadowed = parseCustomModelEntries([
      { modelId: "sneaky-fast", provider: "anthropic", tier: "fast" },
    ]);
    const withCustom = findModelForProviderInTier("anthropic", "fast", undefined, shadowed);
    expect(withCustom?.id).toBe(baseline!.id);
    expect(withCustom?.id).not.toBe("sneaky-fast");
  });

  test("NO SHADOWING: a custom row reusing a built-in id does not replace it", () => {
    const baseline = findModelForProviderInTier("anthropic", "fast");
    const clone = parseCustomModelEntries([
      {
        modelId: baseline!.id,
        provider: "anthropic",
        tier: "fast",
        baseUrl: "http://localhost:11434",
      },
    ]);
    const resolved = findModelForProviderInTier("anthropic", "fast", undefined, clone);
    expect(resolved?.id).toBe(baseline!.id);
    // The give-away that the built-in answered: catalog entries carry no baseUrl.
    expect(resolved?.baseUrl).toBeUndefined();
  });

  test("a CONFIGURED ladder rung naming a custom model resolves it (explicit request)", () => {
    const ladder = emptyTierLadder();
    ladder.fast = [{ provider: "ollama", model: "qwen3:1.7b" }];
    expect(findModelForProviderInTier("ollama", "fast", ladder, ollamaFast)?.id).toBe("qwen3:1.7b");
  });

  test("a ladder rung naming a BUILT-IN still outranks a custom model on the same provider", () => {
    const baseline = findModelForProviderInTier("anthropic", "fast");
    const ladder = emptyTierLadder();
    // Built-in named first, custom second — the built-in must win.
    ladder.fast = [
      { provider: "anthropic", model: baseline!.id },
      { provider: "anthropic", model: "sneaky-fast" },
    ];
    const custom = parseCustomModelEntries([
      { modelId: "sneaky-fast", provider: "anthropic", tier: "fast" },
    ]);
    expect(findModelForProviderInTier("anthropic", "fast", ladder, custom)?.id).toBe(baseline!.id);
  });

  test("an empty/absent custom list routes byte-identically to before", () => {
    for (const provider of ["anthropic", "openai", "google", "openrouter"]) {
      for (const tier of ["fast", "balanced", "powerful"] as const) {
        expect(findModelForProviderInTier(provider, tier, undefined, [])).toEqual(
          findModelForProviderInTier(provider, tier),
        );
      }
    }
  });

  test("findRunnableModelForProviderInTier threads custom models through the apikey path", () => {
    const entry = findRunnableModelForProviderInTier("ollama", "fast", "apikey", undefined, ollamaFast);
    expect(entry?.id).toBe("qwen3:1.7b");
  });

  test("findRunnableModelForProviderInTier without custom models is still null for ollama", () => {
    expect(findRunnableModelForProviderInTier("ollama", "fast", "apikey")).toBeNull();
  });
});

// ── Router integration ──────────────────────────────────────────────
describe("resolveModel() on a local-only install", () => {
  const LOCAL_ONLY = {
    "provider:customModels": [OLLAMA_ROW],
    "provider:defaultTier": "balanced",
  };

  /** Env API keys would satisfy the credential probe and mask the case. */
  function withoutCloudKeys<T>(fn: () => Promise<T>): Promise<T> {
    const vars = [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "OPENROUTER_API_KEY",
    ];
    const saved: Record<string, string | undefined> = {};
    for (const v of vars) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
    return fn().finally(() => {
      for (const [v, val] of Object.entries(saved)) {
        if (val !== undefined) process.env[v] = val;
      }
    });
  }

  test("THE CONSEQUENCE, fixed: an unpinned (tier-routed) turn resolves to the local model", async () => {
    settings(LOCAL_ONLY);
    const result = await withoutCloudKeys(() => resolveModel());
    expect(result.provider).toBe("ollama");
    expect(result.model).toBe("qwen3:1.7b");
  });

  test("the tier-routed pick dials the local endpoint, not api.openai.com", async () => {
    settings(LOCAL_ONLY);
    const result = await withoutCloudKeys(() => resolveModel());
    expect(result.piModel.baseUrl).toBe("http://localhost:11434/v1");
  });

  test("provider-only routing (Level 2) also finds it", async () => {
    settings(LOCAL_ONLY);
    const result = await withoutCloudKeys(() => resolveModel("ollama"));
    expect(result.model).toBe("qwen3:1.7b");
    expect(result.piModel.baseUrl).toBe("http://localhost:11434/v1");
  });

  test("with NO custom models the install falls back to Kilo's keyless free tier", async () => {
    // Was: this threw "No available providers with credentials". Kilo
    // authenticates with nothing configured, so an install with neither a
    // cloud key nor a local model now has an answer instead of an error.
    settings({ "provider:defaultTier": "balanced" });
    const result = await withoutCloudKeys(() => resolveModel());
    expect(result.provider).toBe("kilo");
    expect(result.model).toBe("kilo-auto/free");
  });

  test("…and still names the real constraint when even Kilo cannot answer", async () => {
    // The original assertion, with its premise restored: the message must
    // survive for the case where genuinely nothing is reachable.
    settings({ "provider:defaultTier": "balanced" });
    const breaker = getCircuitBreaker("kilo");
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    try {
      await withoutCloudKeys(async () => {
        await expect(resolveModel()).rejects.toThrow(/No available providers with credentials/);
      });
    } finally {
      breaker.recordSuccess();
    }
  });

  test("the LOCAL model still beats Kilo — a keyless gateway must not silently displace it", async () => {
    // Kilo is keyless, so without an explicit demotion it would outrank the
    // operator's own endpoint on every local-only install and quietly ship
    // prompts to a third party that may train on them.
    settings(LOCAL_ONLY);
    const result = await withoutCloudKeys(() => resolveModel());
    expect(result.provider).toBe("ollama");
  });

  test("a local provider is appended LAST — a cloud key still wins the same turn", async () => {
    settings(LOCAL_ONLY);
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    try {
      const result = await resolveModel();
      expect(result.provider).toBe("anthropic");
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

// ── Picker/router agreement ─────────────────────────────────────────
describe("getModelRegistry() and routing agree on a custom row", () => {
  test("the picker's tier for a row is the tier routing answers on", async () => {
    settings({ "provider:customModels": [{ modelId: "solo", provider: "ollama", tier: "powerful" }] });
    const registry = await getModelRegistry();
    const shown = registry.find((m) => m.id === "solo");
    expect(shown?.tier).toBe("powerful");

    const entries: CustomModelEntry[] = parseCustomModelEntries([
      { modelId: "solo", provider: "ollama", tier: "powerful" },
    ]);
    expect(findModelForProviderInTier("ollama", shown!.tier, undefined, entries)?.id).toBe("solo");
  });

  test("a row with neither provider nor tier shows AND routes as ollama/balanced", async () => {
    settings({ "provider:customModels": [{ modelId: "bare" }] });
    const registry = await getModelRegistry();
    const shown = registry.find((m) => m.id === "bare");
    expect(shown?.provider).toBe("ollama");
    expect(shown?.tier).toBe("balanced");

    const entries = parseCustomModelEntries([{ modelId: "bare" }]);
    expect(findModelForProviderInTier("ollama", "balanced", undefined, entries)?.id).toBe("bare");
  });
});
