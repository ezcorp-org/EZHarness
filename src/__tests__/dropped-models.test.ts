/**
 * Catalog-gap detection — the mechanism that stops a pi-ai model-catalog
 * retirement from silently degrading a pinned conversation.
 *
 * The pure logic is asserted here against THE ACTUAL SET of 18 ids the
 * 0.80.6 → 0.83.0 bump retired across the four providers EZCorp ships, so
 * this is a real regression guard and not a demonstration on invented data.
 */
import { test, expect, describe } from "bun:test";
import {
  CATALOG_PROVIDERS,
  describeCatalogGap,
  findCatalogGaps,
  isCatalogGap,
  reportCatalogGapOnce,
  type PinnedModelRef,
} from "../runtime/routing/dropped-models";

/**
 * The ids pi-ai 0.83.0 dropped, measured by diffing `getModels(provider)`
 * between 0.80.6 and 0.83.0 for each of EZCorp's four shipped providers.
 * openai 45→38, openrouter 270→303 (a NET gain that still retires 10),
 * anthropic 14→15 and google 16→24 lose nothing.
 */
const DROPPED_OPENAI = [
  "gpt-5-codex",
  "gpt-5.1-chat-latest",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2-codex",
  "o3-deep-research",
  "o4-mini-deep-research",
];
const DROPPED_OPENROUTER = [
  "arcee-ai/trinity-mini",
  "liquid/lfm-2.5-1.2b-thinking:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "nvidia/llama-3.3-nemotron-super-49b-v1.5",
  "openai/gpt-oss-120b:free",
  "poolside/laguna-m.1",
  "poolside/laguna-m.1:free",
  "qwen/qwen3-coder:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "tencent/hy3:free",
];

/** A catalog that knows everything except the retired ids. */
const LIVE_IDS = new Set(["gpt-5.5", "claude-sonnet-4-5", "claude-opus-5", "openrouter/auto"]);
const isKnown = (_provider: string, modelId: string) => LIVE_IDS.has(modelId);

describe("isCatalogGap", () => {
  test("every one of the 18 retired ids is detected as a gap", () => {
    const refs: PinnedModelRef[] = [
      ...DROPPED_OPENAI.map((modelId) => ({ provider: "openai", modelId })),
      ...DROPPED_OPENROUTER.map((modelId) => ({ provider: "openrouter", modelId })),
    ];
    expect(refs).toHaveLength(18);
    for (const ref of refs) {
      expect(isCatalogGap(ref, isKnown)).toBe(true);
    }
  });

  test("a model still in the catalog is not a gap", () => {
    expect(isCatalogGap({ provider: "anthropic", modelId: "claude-opus-5" }, isKnown)).toBe(false);
    expect(isCatalogGap({ provider: "openai", modelId: "gpt-5.5" }, isKnown)).toBe(false);
  });

  test("a CUSTOM/local model is never a gap — it is absent from the catalog by design", () => {
    // Two independent reasons, both load-bearing: a non-catalog provider,
    // and an explicit baseUrl. Either one alone must suppress the report, or
    // every local-model deployment reports its whole model list as broken.
    expect(isCatalogGap({ provider: "ollama", modelId: "qwen3:1.7b" }, isKnown)).toBe(false);
    expect(isCatalogGap({ provider: "openai", modelId: "my-proxy-model" }, isKnown, true)).toBe(false);
  });

  test("CATALOG_PROVIDERS is exactly the four EZCorp ships", () => {
    expect([...CATALOG_PROVIDERS].sort()).toEqual(["anthropic", "google", "openai", "openrouter"]);
  });
});

describe("findCatalogGaps", () => {
  test("returns only the gaps, in order, and collapses duplicates", () => {
    // The realistic shape: thousands of conversations pinned to a handful of
    // retired ids. The operator wants the handful, not the thousands.
    const refs: PinnedModelRef[] = [
      { provider: "openai", modelId: "gpt-5.5" },
      { provider: "openai", modelId: "gpt-5.1-codex", source: "conversations.model" },
      { provider: "anthropic", modelId: "claude-opus-5" },
      { provider: "openai", modelId: "gpt-5.1-codex", source: "agent_configs.model" },
      { provider: "openrouter", modelId: "poolside/laguna-m.1" },
      { provider: "ollama", modelId: "qwen3:1.7b" },
    ];
    expect(findCatalogGaps(refs, isKnown)).toEqual([
      { provider: "openai", modelId: "gpt-5.1-codex", source: "conversations.model", reason: "not-in-catalog" },
      { provider: "openrouter", modelId: "poolside/laguna-m.1", reason: "not-in-catalog" },
    ]);
  });

  test("the same id under two DIFFERENT providers is two gaps, not one", () => {
    const refs: PinnedModelRef[] = [
      { provider: "openai", modelId: "shared-id" },
      { provider: "openrouter", modelId: "shared-id" },
    ];
    expect(findCatalogGaps(refs, isKnown).map((g) => g.provider)).toEqual(["openai", "openrouter"]);
  });

  test("no pins, or all-live pins, yields nothing", () => {
    expect(findCatalogGaps([], isKnown)).toEqual([]);
    expect(findCatalogGaps([{ provider: "openai", modelId: "gpt-5.5" }], isKnown)).toEqual([]);
  });
});

describe("reportCatalogGapOnce", () => {
  test("reports a gap once, then stays silent for the same pin", () => {
    // A pinned conversation resolves its model on EVERY turn. Without the
    // memo this becomes a warning per turn, forever, for one stale pin.
    const seen = new Set<string>();
    const ref = { provider: "openai", modelId: "gpt-5.1-codex" };
    const first = reportCatalogGapOnce(ref, isKnown, seen);
    expect(first).toContain("gpt-5.1-codex");
    expect(reportCatalogGapOnce(ref, isKnown, seen)).toBeNull();
    expect(reportCatalogGapOnce(ref, isKnown, seen)).toBeNull();
  });

  test("a DIFFERENT retired pin still gets its own report", () => {
    const seen = new Set<string>();
    expect(reportCatalogGapOnce({ provider: "openai", modelId: "gpt-5-codex" }, isKnown, seen)).not.toBeNull();
    expect(
      reportCatalogGapOnce({ provider: "openrouter", modelId: "poolside/laguna-m.1" }, isKnown, seen),
    ).not.toBeNull();
  });

  test("null for a live model, a custom baseUrl pin, and a non-catalog provider", () => {
    const seen = new Set<string>();
    expect(reportCatalogGapOnce({ provider: "openai", modelId: "gpt-5.5" }, isKnown, seen)).toBeNull();
    expect(reportCatalogGapOnce({ provider: "openai", modelId: "proxied" }, isKnown, seen, true)).toBeNull();
    expect(reportCatalogGapOnce({ provider: "ollama", modelId: "qwen3:1.7b" }, isKnown, seen)).toBeNull();
    // Nothing was memoised, so a later genuine gap on those keys still reports.
    expect(seen.size).toBe(0);
  });
});

describe("against the REAL installed catalog", () => {
  test("all 18 retired ids are gaps, and live ids are not", async () => {
    // The tests above use a fake catalog to pin the LOGIC. This one runs the
    // production predicate against the actually-installed pi-ai, so the pair
    // proves both "the rule is right" and "the rule fires on real data".
    const { isKnownCatalogModel } = await import("../providers/registry");

    for (const modelId of DROPPED_OPENAI) {
      expect(isCatalogGap({ provider: "openai", modelId }, isKnownCatalogModel)).toBe(true);
    }
    for (const modelId of DROPPED_OPENROUTER) {
      expect(isCatalogGap({ provider: "openrouter", modelId }, isKnownCatalogModel)).toBe(true);
    }

    // Controls: models 0.83.0 DOES list, including the one it added.
    expect(isKnownCatalogModel("anthropic", "claude-opus-5")).toBe(true);
    expect(isKnownCatalogModel("anthropic", "claude-sonnet-4-5")).toBe(true);
    // The OAuth-only override is reachable through the same predicate.
    expect(isKnownCatalogModel("openai", "gpt-5.5")).toBe(true);
    // A malformed provider id is "not known", never a throw.
    expect(isKnownCatalogModel("nonsense-provider", "x")).toBe(false);
  });
});

describe("describeCatalogGap", () => {
  test("names the id and the provider, and states the actual consequence", () => {
    const msg = describeCatalogGap({ provider: "openai", modelId: "gpt-5.1-codex" });
    // The requirement is that a degraded pin is never anonymous.
    expect(msg).toContain("gpt-5.1-codex");
    expect(msg).toContain("openai");
    // …and that the message explains the silent part: window + pricing are
    // estimates, which is why a long thread starts forgetting things.
    expect(msg).toContain("ESTIMATES");
    expect(msg).toContain("128k");
    expect(msg).not.toContain("(pinned by");
  });

  test("includes the pin's source when known", () => {
    const msg = describeCatalogGap({
      provider: "openrouter",
      modelId: "poolside/laguna-m.1",
      source: "conversations.model",
    });
    expect(msg).toContain("(pinned by conversations.model)");
  });
});
