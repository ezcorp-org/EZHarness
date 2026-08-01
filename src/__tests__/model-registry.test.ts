import { test, expect, mock, afterAll } from "bun:test";

import { restoreModuleMocks } from "./helpers/mock-cleanup";
// registry.ts imports getSetting from ../db/queries/settings which needs drizzle-orm.
// Mock it here before the registry import so the test is self-contained.
mock.module("../db/queries/settings", () => ({
  getSetting: mock(() => Promise.resolve(undefined)),
  getAllSettings: mock(() => Promise.resolve({})),
  upsertSetting: mock(() => Promise.resolve()),
  deleteSetting: mock(() => Promise.resolve(false)),
  isListingInstalled: mock(() => Promise.resolve(false)),
}));

afterAll(() => restoreModuleMocks());

import {
  getModelRegistry,
  getModelsForTier,
  findModelForProviderInTier,
  modelPrices,
} from "../providers/registry";
import { priceSegment } from "../runtime/usage/cache-stats";

test("getModelRegistry returns models from pi-ai (>= 9 entries)", async () => {
  const models = await getModelRegistry();
  expect(models.length).toBeGreaterThanOrEqual(9);
});

test("each model has required fields", async () => {
  const models = await getModelRegistry();
  for (const model of models) {
    expect(model.id).toBeTruthy();
    expect(model.provider).toBeTruthy();
    expect(["fast", "balanced", "powerful"]).toContain(model.tier);
    expect(model.contextWindow).toBeGreaterThan(0);
    expect(typeof model.vision).toBe("boolean");
    expect(["low", "medium", "high"]).toContain(model.costTier);
  }
});

test("registry contains anthropic, openai, and google providers", async () => {
  const models = await getModelRegistry();
  const providers = new Set(models.map((m) => m.provider));
  expect(providers.has("anthropic")).toBe(true);
  expect(providers.has("openai")).toBe(true);
  expect(providers.has("google")).toBe(true);
});

test("all three tiers are populated", async () => {
  const models = await getModelRegistry();
  const tiers = new Set(models.map((m) => m.tier));
  expect(tiers.has("fast")).toBe(true);
  expect(tiers.has("balanced")).toBe(true);
  expect(tiers.has("powerful")).toBe(true);
});

test("getModelsForTier filters correctly", () => {
  const fast = getModelsForTier("fast");
  expect(fast.length).toBeGreaterThanOrEqual(1);
  for (const m of fast) {
    expect(m.tier).toBe("fast");
  }
});

test("findModelForProviderInTier returns match", () => {
  const result = findModelForProviderInTier("anthropic", "balanced");
  expect(result).not.toBeNull();
  expect(result!.provider).toBe("anthropic");
  expect(result!.tier).toBe("balanced");
});

test("findModelForProviderInTier returns null for missing combo", () => {
  const result = findModelForProviderInTier("anthropic" as any, "nonexistent" as any);
  expect(result).toBeNull();
});

test("modelPrices reads the catalog rates in USD per 1M tokens", () => {
  const p = modelPrices("anthropic", "claude-sonnet-4-5");
  // Anthropic's published sonnet-4.5 list price. If this ever changes, it is a
  // pi-ai catalog update, not a bug — but the UNITS must stay per-1M dollars.
  expect(p.input).toBe(3);
  expect(p.output).toBe(15);
  expect(p.cacheRead).toBe(0.3);
  // 5m cache writes are 1.25x base input.
  expect(p.cacheWrite).toBeCloseTo(3.75, 10);
});

test("modelPrices + priceSegment turn a real model into a real dollar figure", () => {
  const c = priceSegment(
    { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
    modelPrices("anthropic", "claude-sonnet-4-5"),
  );
  expect(c).not.toBeNull();
  expect(c!.total).toBeCloseTo(18, 10);
});

test("an unknown model resolves to all-zero rates, which price as UNPRICED not $0.00", () => {
  const p = modelPrices("definitely-not-a-provider", "definitely-not-a-model");
  expect(p.input).toBe(0);
  expect(p.output).toBe(0);
  // priceSegment must refuse to fabricate a dollar figure for it.
  expect(priceSegment({ input: 500_000, output: 500_000, cacheRead: 0, cacheWrite: 0 }, p)).toBeNull();
});

test("findModelForProviderInTier prefers openrouter/auto over the alphabetical scan", () => {
  // pi-ai lists openrouter's ~259 models alphabetically, so the plain scan
  // would pick e.g. `ai21/jamba-large-1.7` (balanced). The preferred-model
  // override returns openrouter's own auto-router for every tier instead.
  for (const tier of ["fast", "balanced", "powerful"] as const) {
    const result = findModelForProviderInTier("openrouter", tier);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("openrouter");
    expect(result!.id).toBe("openrouter/auto");
  }
});
