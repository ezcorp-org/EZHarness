/**
 * The one provider table.
 *
 *   T1  the table itself — shape, derived projections, lookups
 *   T2  the DRY guarantee: every list this module replaced is now a PROJECTION
 *       of it, asserted by reading the consuming files, so re-inlining a
 *       hardcoded provider list fails a test instead of silently drifting
 *   T3  the keyless-free-tier property — the one fact that lets a deployment
 *       with nothing configured still route a turn
 */

import { test, expect, describe } from "bun:test";
import {
  BYOK_ONLY_PROVIDERS,
  hasKeylessFreeTier,
  isKnownLlmProvider,
  KILO_PROVIDER,
  LLM_PROVIDER_IDS,
  LLM_PROVIDERS,
  llmProviderSpec,
  OAUTH_SUPPORTED_PROVIDERS,
  PROVIDER_ENV_KEYS,
  providerListMessage,
} from "../runtime/routing/llm-providers";

describe("T1 the table", () => {
  test("lists every provider exactly once, in preference order", () => {
    expect(LLM_PROVIDER_IDS).toEqual(["anthropic", "openai", "google", "openrouter", "kilo"]);
    expect(new Set(LLM_PROVIDER_IDS).size).toBe(LLM_PROVIDER_IDS.length);
  });

  test("kilo is LAST — it may only ADD an answer, never re-route a configured deployment", () => {
    expect(LLM_PROVIDER_IDS[LLM_PROVIDER_IDS.length - 1]).toBe(KILO_PROVIDER);
  });

  test("every provider declares a distinct env key", () => {
    const keys = LLM_PROVIDERS.map((p) => p.envKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(PROVIDER_ENV_KEYS).toEqual({
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      google: "GOOGLE_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
      kilo: "KILO_API_KEY",
    });
  });

  test("oauth and byokOnly are complementary projections", () => {
    expect(OAUTH_SUPPORTED_PROVIDERS).toEqual(["openai", "google"]);
    expect(BYOK_ONLY_PROVIDERS).toEqual(["anthropic", "openrouter", "kilo"]);
    // Nothing may claim both a pi-managed OAuth flow and BYOK-only.
    for (const spec of LLM_PROVIDERS) {
      expect(spec.oauth && spec.byokOnly).toBe(false);
    }
  });

  test("llmProviderSpec resolves a known id and refuses an unknown one", () => {
    expect(llmProviderSpec("anthropic")?.envKey).toBe("ANTHROPIC_API_KEY");
    expect(llmProviderSpec("ollama")).toBeUndefined();
  });

  test("isKnownLlmProvider narrows to the table", () => {
    expect(isKnownLlmProvider("google")).toBe(true);
    expect(isKnownLlmProvider(KILO_PROVIDER)).toBe(true);
    expect(isKnownLlmProvider("ollama")).toBe(false);
    expect(isKnownLlmProvider("")).toBe(false);
  });

  test("providerListMessage renders the 400-message list", () => {
    expect(providerListMessage()).toBe("anthropic, openai, google, openrouter, kilo");
  });
});

describe("T3 keyless free tier", () => {
  test("kilo alone answers with no credential configured", () => {
    expect(hasKeylessFreeTier(KILO_PROVIDER)).toBe(true);
    for (const id of LLM_PROVIDER_IDS.filter((p) => p !== KILO_PROVIDER)) {
      expect(hasKeylessFreeTier(id)).toBe(false);
    }
  });

  test("an unknown provider is never keyless — the conservative answer", () => {
    expect(hasKeylessFreeTier("ollama")).toBe(false);
    expect(hasKeylessFreeTier("definitely-not-a-provider")).toBe(false);
  });
});

describe("T2 no consumer re-inlines the list", () => {
  // The bug this table exists to prevent is a provider added to some of the
  // copies and not the others — routable but invisible, or configurable but
  // unroutable. Assert by READING each consumer: a re-inlined literal is what
  // regresses, and it is textually detectable.
  const CONSUMERS = [
    "src/providers/router.ts",
    "src/providers/registry.ts",
    "src/providers/credentials.ts",
    "src/health.ts",
    "web/src/lib/server/provider-availability.ts",
    "web/src/routes/api/providers/+server.ts",
    "web/src/routes/api/providers/[provider]/test/+server.ts",
    "web/src/routes/api/providers/[provider]/refresh-models/+server.ts",
  ];

  test.each(CONSUMERS)("%s imports the table instead of hardcoding it", async (path) => {
    const source = await Bun.file(`${import.meta.dir}/../../${path}`).text();
    expect(source).toContain("routing/llm-providers");
    // The exact four-provider literal every one of these files used to carry.
    expect(source).not.toMatch(/\[\s*"anthropic",\s*"openai",\s*"google",\s*"openrouter"\s*\]/);
  });

  test("the web mirror of the preference order matches the table byte-for-byte", async () => {
    // Parsed, not imported: a `src/**` bun test that imports a web/src/lib
    // module poisons that module's merged coverage (root CLAUDE.md).
    const source = await Bun.file(`${import.meta.dir}/../../web/src/lib/settings-models.ts`).text();
    const match = source.match(/export const DEFAULT_PREFERENCE_ORDER = (\[[^\]]*\]);/);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1].replace(/'/g, '"'))).toEqual([...LLM_PROVIDER_IDS]);
  });
});
