/**
 * The Kilo catalog — parsing, free/paid classification, access projections.
 *
 *   T1  parsing a REAL gateway payload (fixture captured from the live
 *       endpoint) — units, modalities, free flag, chat filter
 *   T2  tolerance: every malformed shape degrades to "fewer models", never a throw
 *   T3  the free/paid split — the property the whole feature rests on
 *   T4  the routing fill that keeps a keyless deployment answerable at EVERY
 *       tier (without it the first tool-using turn is unroutable)
 *   T5  merge precedence: discovery refreshes the seed, seed is the floor
 *   T6  the PERSISTED round-trip — what refresh-models actually writes must
 *       read back unchanged (it did not; see the block for the measurements)
 */

import { test, expect, describe } from "bun:test";
import {
  emptyKiloTiers,
  isFreeKiloModelId,
  KILO_BASE_URL,
  KILO_DEFAULT_CONTEXT,
  KILO_DEFAULT_MAX_TOKENS,
  KILO_FREE_AUTO_MODEL,
  KILO_MODELS_URL,
  kiloAccessForKey,
  kiloModelsForAccess,
  kiloRoutingFill,
  mergeKiloCatalog,
  normalizeKiloModel,
  parseKiloCatalog,
  type KiloModel,
} from "../runtime/routing/kilo-catalog";

// Verbatim rows from `GET https://api.kilo.ai/api/gateway/models`, trimmed to
// the fields consumed. Kept as real captured JSON rather than hand-written
// shapes so the parser is tested against what the gateway actually sends.
const LIVE_ROWS = [
  {
    id: "kilo-auto/frontier",
    name: "Auto Frontier",
    architecture: { input_modalities: ["text", "image", "pdf"], output_modalities: ["text"] },
    top_provider: { context_length: 1000000, max_completion_tokens: 128000 },
    pricing: {
      prompt: "0.000005",
      completion: "0.000025",
      input_cache_read: "0.0000005",
      input_cache_write: "0.00000625",
    },
    context_length: 1000000,
    supported_parameters: ["max_tokens", "temperature", "tools", "reasoning", "include_reasoning"],
    isFree: false,
  },
  {
    id: "kilo-auto/free",
    name: "Auto Free",
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    top_provider: { context_length: 256000, max_completion_tokens: 10000 },
    pricing: { prompt: "0", completion: "0" },
    context_length: 256000,
    supported_parameters: ["max_tokens", "temperature", "tools", "reasoning"],
    isFree: true,
  },
  {
    id: "stepfun/step-3.7-flash:free",
    name: "StepFun: Step 3.7 Flash (free)",
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    top_provider: { context_length: 262144 },
    pricing: { prompt: "0.000000000000", completion: "0.000000000000" },
    context_length: 262144,
    supported_parameters: ["max_tokens", "tools"],
    isFree: true,
  },
  {
    id: "anthropic/claude-sonnet-5",
    name: "Anthropic: Claude Sonnet 5",
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    top_provider: { context_length: 1000000, max_completion_tokens: 64000 },
    pricing: { prompt: "0.000002", completion: "0.00001" },
    context_length: 1000000,
    supported_parameters: ["max_tokens", "tools", "reasoning"],
    isFree: false,
  },
  {
    // Free ROUTER whose id carries no `:free` suffix — the known false
    // negative that makes the payload's explicit flag authoritative.
    id: "openrouter/free",
    name: "OpenRouter Free Models Router",
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    top_provider: { context_length: 200000 },
    pricing: { prompt: "0", completion: "0" },
    context_length: 200000,
    supported_parameters: ["max_tokens"],
    isFree: true,
  },
  {
    // Non-chat: audio generation. Must be filtered out.
    id: "google/lyria-3-pro-preview",
    name: "Google: Lyria 3 Pro",
    architecture: { input_modalities: ["text"], output_modalities: ["audio"] },
    top_provider: { context_length: 8192 },
    pricing: { prompt: "0", completion: "0" },
    context_length: 8192,
    supported_parameters: [],
    isFree: false,
  },
];

const byId = (models: KiloModel[], id: string) => models.find((m) => m.id === id);

describe("T1 parsing a real payload", () => {
  const parsed = parseKiloCatalog({ data: LIVE_ROWS });

  test("keeps chat models and drops the audio-generation row", () => {
    expect(parsed.map((m) => m.id)).toEqual([
      "kilo-auto/frontier",
      "kilo-auto/free",
      "stepfun/step-3.7-flash:free",
      "anthropic/claude-sonnet-5",
      "openrouter/free",
    ]);
  });

  test("converts USD-per-token to the repo's USD-per-1M convention", () => {
    // Live values: $5 / $25 per 1M for frontier, $2 / $10 for Sonnet.
    expect(byId(parsed, "kilo-auto/frontier")!.cost).toEqual({
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
    });
    expect(byId(parsed, "anthropic/claude-sonnet-5")!.cost.input).toBe(2);
    expect(byId(parsed, "anthropic/claude-sonnet-5")!.cost.output).toBe(10);
  });

  test("reads modalities, reasoning support and limits", () => {
    const frontier = byId(parsed, "kilo-auto/frontier")!;
    expect(frontier.vision).toBe(true);
    expect(frontier.reasoning).toBe(true);
    expect(frontier.contextWindow).toBe(1_000_000);
    expect(frontier.maxTokens).toBe(128_000);

    const free = byId(parsed, KILO_FREE_AUTO_MODEL)!;
    expect(free.vision).toBe(false);
    expect(free.maxTokens).toBe(10_000);
  });

  test("a row with no max_completion_tokens takes the documented default, NOT the context window", () => {
    // Asking for a 262k output cap because that is the INPUT window is how a
    // request gets rejected for a limit the model never advertised.
    expect(byId(parsed, "stepfun/step-3.7-flash:free")!.maxTokens).toBe(KILO_DEFAULT_MAX_TOKENS);
    expect(byId(parsed, "stepfun/step-3.7-flash:free")!.contextWindow).toBe(262_144);
  });

  test("declares the tier of the kilo-auto routers and infers nothing for the rest", () => {
    expect(byId(parsed, "kilo-auto/frontier")!.declaredTier).toBe("powerful");
    expect(byId(parsed, KILO_FREE_AUTO_MODEL)!.declaredTier).toBe("balanced");
    expect(byId(parsed, "anthropic/claude-sonnet-5")!.declaredTier).toBeUndefined();
  });

  test("accepts a bare array as well as the {data} envelope", () => {
    expect(parseKiloCatalog(LIVE_ROWS).map((m) => m.id)).toEqual(parsed.map((m) => m.id));
  });

  test("endpoints are the gateway root and its models path", () => {
    expect(KILO_BASE_URL).toBe("https://api.kilo.ai/api/gateway");
    expect(KILO_MODELS_URL).toBe("https://api.kilo.ai/api/gateway/models");
  });
});

describe("T2 tolerance — a bad payload costs models, never a turn", () => {
  test.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "nope"],
    ["a number", 42],
    ["an object with no data", { models: [] }],
    ["data that is not an array", { data: "nope" }],
  ])("%s parses to an empty list", (_label, payload) => {
    expect(parseKiloCatalog(payload)).toEqual([]);
  });

  test.each([
    ["not an object", "row"],
    ["null", null],
    ["an array", []],
    ["no id", { name: "x" }],
    ["a blank id", { id: "   " }],
    ["a non-string id", { id: 7 }],
  ])("normalizeKiloModel drops a row that is %s", (_label, raw) => {
    expect(normalizeKiloModel(raw)).toBeNull();
  });

  test("a row with nothing but an id takes every documented default", () => {
    const model = normalizeKiloModel({ id: "vendor/bare" })!;
    expect(model).toEqual({
      id: "vendor/bare",
      name: "vendor/bare",
      contextWindow: KILO_DEFAULT_CONTEXT,
      maxTokens: KILO_DEFAULT_MAX_TOKENS,
      vision: false,
      reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      free: false,
      declaredTier: undefined,
    });
  });

  test("garbage pricing reads as unpriced rather than throwing", () => {
    const model = normalizeKiloModel({
      id: "vendor/x",
      pricing: { prompt: "not-a-number", completion: -3, input_cache_read: null },
    })!;
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  test("numeric pricing is accepted alongside the string form", () => {
    expect(normalizeKiloModel({ id: "v/x", pricing: { prompt: 0.000001 } })!.cost.input).toBe(1);
  });

  test("a blank name falls back to the id", () => {
    expect(normalizeKiloModel({ id: "v/x", name: "  " })!.name).toBe("v/x");
    expect(normalizeKiloModel({ id: "v/x", name: 7 })!.name).toBe("v/x");
  });

  test("malformed nested objects are ignored field-by-field", () => {
    const model = normalizeKiloModel({
      id: "v/x",
      architecture: "nope",
      top_provider: null,
      pricing: [],
      supported_parameters: "nope",
      context_length: -5,
    })!;
    expect(model.contextWindow).toBe(KILO_DEFAULT_CONTEXT);
    expect(model.vision).toBe(false);
    expect(model.reasoning).toBe(false);
  });

  test("context_length falls back to top_provider.context_length", () => {
    expect(normalizeKiloModel({ id: "v/x", top_provider: { context_length: 999 } })!.contextWindow).toBe(999);
  });

  test("non-string entries in a modality array are ignored", () => {
    const model = normalizeKiloModel({
      id: "v/x",
      architecture: { input_modalities: ["image", 7, null], output_modalities: ["text"] },
    })!;
    expect(model.vision).toBe(true);
  });

  test("include_reasoning alone marks the model as reasoning-capable", () => {
    expect(normalizeKiloModel({ id: "v/x", supported_parameters: ["include_reasoning"] })!.reasoning).toBe(true);
  });

  test("a duplicate id is kept once, first occurrence winning", () => {
    const rows = [
      { id: "v/dup", name: "first" },
      { id: "v/dup", name: "second" },
    ];
    const parsed = parseKiloCatalog(rows);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("first");
  });

  test.each(["v/embedding-3", "openai/whisper-1", "x/tts-1", "x/dall-e-3", "x/text-moderation"])(
    "drops the non-chat model %s by id",
    (id) => {
      expect(normalizeKiloModel({ id })).toBeNull();
    },
  );

  test("a row with an empty output_modalities list is still treated as chat-capable", () => {
    // Kilo omits the field on some rows; refusing them would silently shrink
    // the catalog on a shape change upstream.
    expect(normalizeKiloModel({ id: "v/x", architecture: { output_modalities: [] } })).not.toBeNull();
  });
});

describe("T3 the free/paid split", () => {
  test("kiloAccessForKey maps 'has a key' to 'may call paid models'", () => {
    expect(kiloAccessForKey(true)).toBe("full");
    expect(kiloAccessForKey(false)).toBe("free");
  });

  test("free access keeps ONLY what the gateway serves anonymously", () => {
    const parsed = parseKiloCatalog({ data: LIVE_ROWS });
    expect(kiloModelsForAccess(parsed, "free").map((m) => m.id)).toEqual([
      "kilo-auto/free",
      "stepfun/step-3.7-flash:free",
      "openrouter/free",
    ]);
  });

  test("full access keeps everything", () => {
    const parsed = parseKiloCatalog({ data: LIVE_ROWS });
    expect(kiloModelsForAccess(parsed, "full")).toHaveLength(parsed.length);
  });

  test("the explicit isFree flag beats the id shape in BOTH directions", () => {
    // `openrouter/free` is free with no `:free` suffix …
    expect(byId(parseKiloCatalog(LIVE_ROWS), "openrouter/free")!.free).toBe(true);
    expect(isFreeKiloModelId("openrouter/free")).toBe(false);
    // … and a `:free`-suffixed id the gateway marks paid stays paid.
    expect(normalizeKiloModel({ id: "vendor/x:free", isFree: false })!.free).toBe(false);
  });

  test("with no flag, the id shape is the fallback and unknown reads as PAID", () => {
    expect(normalizeKiloModel({ id: "vendor/x:free" })!.free).toBe(true);
    expect(normalizeKiloModel({ id: KILO_FREE_AUTO_MODEL })!.free).toBe(true);
    expect(normalizeKiloModel({ id: "vendor/x" })!.free).toBe(false);
  });

  test("isFreeKiloModelId recognises the free router and the suffix only", () => {
    expect(isFreeKiloModelId(KILO_FREE_AUTO_MODEL)).toBe(true);
    expect(isFreeKiloModelId("nvidia/nemotron-3-super-120b-a12b:free")).toBe(true);
    expect(isFreeKiloModelId("anthropic/claude-sonnet-5")).toBe(false);
    expect(isFreeKiloModelId("kilo-auto/frontier")).toBe(false);
  });
});

describe("T4 the routing fill", () => {
  const freeOnly = kiloModelsForAccess(parseKiloCatalog(LIVE_ROWS), "free");

  test("emptyKiloTiers names the tiers nothing covers", () => {
    expect(emptyKiloTiers(["balanced"])).toEqual(["fast", "powerful"]);
    expect(emptyKiloTiers(["fast", "balanced", "powerful"])).toEqual([]);
    expect(emptyKiloTiers([])).toEqual(["fast", "balanced", "powerful"]);
  });

  test("repeats the free router into every uncovered tier", () => {
    const fill = kiloRoutingFill(freeOnly, ["balanced"]);
    expect(fill.map((m) => m.declaredTier)).toEqual(["fast", "powerful"]);
    expect(fill.every((m) => m.id === KILO_FREE_AUTO_MODEL)).toBe(true);
    // Same model, only the declared tier differs — nothing else is invented.
    expect(fill[0].contextWindow).toBe(byId(freeOnly, KILO_FREE_AUTO_MODEL)!.contextWindow);
  });

  test("adds nothing when every tier is already covered", () => {
    expect(kiloRoutingFill(freeOnly, ["fast", "balanced", "powerful"])).toEqual([]);
  });

  test("adds nothing when the free router is not in the catalog", () => {
    const withoutRouter = freeOnly.filter((m) => m.id !== KILO_FREE_AUTO_MODEL);
    expect(kiloRoutingFill(withoutRouter, [])).toEqual([]);
  });
});

describe("T5 merge precedence", () => {
  const seed: KiloModel[] = [
    { ...byId(parseKiloCatalog(LIVE_ROWS), KILO_FREE_AUTO_MODEL)!, name: "stale seed name" },
  ];

  test("discovery refreshes a seeded id in place", () => {
    const discovered = parseKiloCatalog(LIVE_ROWS);
    const merged = mergeKiloCatalog(seed, discovered);
    expect(merged[0].id).toBe(KILO_FREE_AUTO_MODEL);
    expect(merged[0].name).toBe("Auto Free");
  });

  test("seed order is preserved and new discovered ids are appended", () => {
    const merged = mergeKiloCatalog(seed, parseKiloCatalog(LIVE_ROWS));
    expect(merged[0].id).toBe(KILO_FREE_AUTO_MODEL);
    expect(merged.map((m) => m.id)).toContain("anthropic/claude-sonnet-5");
    expect(new Set(merged.map((m) => m.id)).size).toBe(merged.length);
  });

  test("the seed is the floor when discovery has never run", () => {
    expect(mergeKiloCatalog(seed, [])).toEqual(seed);
  });
});

describe("T6 the persisted round-trip (regression: refresh-models degraded the catalog)", () => {
  // `POST /api/providers/kilo/refresh-models` persists `kiloModelToAnyModel`
  // output, NOT the gateway wire shape. Reading that back with the wire parser
  // silently defaulted every field. Measured before the fix, for a 1M-context
  // vision reasoning model: ctx 1000000 -> 128000, vision true -> false,
  // reasoning true -> false — and `openrouter/free` free true -> FALSE, which
  // hides a genuinely free model from a keyless deployment.
  const PERSISTED = [
    {
      id: "nvidia/nemotron-3-ultra-550b-a55b:free",
      name: "NVIDIA: Nemotron 3 Ultra (free)",
      api: "openai-completions",
      provider: "kilo",
      baseUrl: KILO_BASE_URL,
      free: true,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 32_768,
    },
    {
      // The false-negative id: free, with no `:free` suffix.
      id: "openrouter/free",
      name: "OpenRouter Free Models Router",
      api: "openai-completions",
      provider: "kilo",
      baseUrl: KILO_BASE_URL,
      free: true,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    },
    {
      id: "anthropic/claude-sonnet-5",
      name: "Anthropic: Claude Sonnet 5",
      api: "openai-completions",
      provider: "kilo",
      baseUrl: KILO_BASE_URL,
      free: false,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 64_000,
    },
  ];

  const parsed = parseKiloCatalog(PERSISTED);

  test("every field survives — no silent defaulting", () => {
    const ultra = byId(parsed, "nvidia/nemotron-3-ultra-550b-a55b:free")!;
    expect(ultra.contextWindow).toBe(1_000_000);
    expect(ultra.maxTokens).toBe(32_768);
    expect(ultra.vision).toBe(true);
    expect(ultra.reasoning).toBe(true);
    expect(ultra.free).toBe(true);
  });

  test("a persisted `free` flag beats the id shape — openrouter/free stays FREE", () => {
    expect(byId(parsed, "openrouter/free")!.free).toBe(true);
    expect(kiloModelsForAccess(parsed, "free").map((m) => m.id)).toContain("openrouter/free");
  });

  test("persisted per-1M costs are NOT multiplied a second time", () => {
    // The wire branch multiplies by 1e6; applying it to an already-converted
    // row would price Sonnet at $2,000,000 per 1M and tier it "high".
    expect(byId(parsed, "anthropic/claude-sonnet-5")!.cost).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  test("paid persisted rows are still filtered out for free access", () => {
    expect(kiloModelsForAccess(parsed, "free").map((m) => m.id)).not.toContain(
      "anthropic/claude-sonnet-5",
    );
  });

  test("a persisted non-chat row is still dropped", () => {
    expect(normalizeKiloModel({ id: "x/text-embedding-3", contextWindow: 8192 })).toBeNull();
  });

  test("a persisted row missing `free` falls back to the id shape", () => {
    expect(normalizeKiloModel({ id: "v/x:free", contextWindow: 1000 })!.free).toBe(true);
    expect(normalizeKiloModel({ id: "v/x", contextWindow: 1000 })!.free).toBe(false);
  });

  test("garbage in a persisted row degrades to defaults rather than throwing", () => {
    const m = normalizeKiloModel({
      id: "v/x",
      contextWindow: "big",
      cost: { input: "free", output: -2 },
      input: "text",
      maxTokens: 0,
    })!;
    expect(m.contextWindow).toBe(KILO_DEFAULT_CONTEXT);
    expect(m.maxTokens).toBe(KILO_DEFAULT_MAX_TOKENS);
    expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(m.vision).toBe(false);
  });

  test("the wire shape still parses — both shapes coexist", () => {
    expect(byId(parseKiloCatalog({ data: LIVE_ROWS }), "kilo-auto/frontier")!.cost.input).toBe(5);
  });
});
