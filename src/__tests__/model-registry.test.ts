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
} from "../providers/registry";

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
