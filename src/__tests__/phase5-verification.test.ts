/**
 * Phase 5: Model Routing Verification Tests
 *
 * Covers MOD-01 through MOD-06 requirements.
 * Evidence file for v1.0 milestone audit closure.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mock } from "bun:test";

// Mock settings DB before importing modules that depend on it
const mockGetSetting = mock((_key?: string) => Promise.resolve(undefined));
mock.module("../db/queries/settings", () => ({
  getSetting: mockGetSetting,
  getAllSettings: mock(() => Promise.resolve({})),
  upsertSetting: mock(() => Promise.resolve()),
  deleteSetting: mock(() => Promise.resolve(false)),
  isListingInstalled: mock(() => Promise.resolve(false)),
}));

afterAll(() => restoreModuleMocks());

import { encrypt, decrypt, _resetKeyCache } from "../providers/encryption";
import { resolveModel, suggestFallback } from "../providers/router";
import { getCircuitBreaker, resetAllCircuitBreakers } from "../providers/circuit-breaker";
import { getModelRegistry, getModelsForTier } from "../providers/registry";

// ── MOD-01: BYOK Key Management ──────────────────────────────────────

describe("MOD-01: BYOK key management", () => {
  beforeEach(() => {
    _resetKeyCache();
  });

  test("encrypt then decrypt round-trips correctly", () => {
    const plaintext = "sk-test-api-key-12345";
    const ciphertext = encrypt(plaintext);
    const recovered = decrypt(ciphertext);
    expect(recovered).toBe(plaintext);
  });

  test("encrypt produces different output than plaintext", () => {
    const plaintext = "sk-test-api-key-12345";
    const ciphertext = encrypt(plaintext);
    expect(ciphertext).not.toBe(plaintext);
    // sec-L4: new format is v1:iv:tag:encrypted (4 parts, tagged for NIST
    // 12-byte IV). Legacy untagged 3-part ciphertexts still decrypt.
    const parts = ciphertext.split(":");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
  });
});

// ── MOD-02: Per-conversation/agent model selection ───────────────────

describe("MOD-02: Per-conversation model selection", () => {
  beforeEach(() => {
    resetAllCircuitBreakers();
  });

  test("explicit provider+model selection is honored without routing override", async () => {
    const result = await resolveModel("openai", "gpt-4o");
    expect(result).toEqual(expect.objectContaining({ provider: "openai", model: "gpt-4o" }));
  });
});

// ── MOD-03: Tier-based auto-routing ──────────────────────────────────

describe("MOD-03: Tier-based auto-routing", () => {
  beforeEach(() => {
    resetAllCircuitBreakers();
  });

  test("resolveModel with no explicit provider returns a model from balanced tier", async () => {
    const result = await resolveModel();
    const balancedModels = getModelsForTier("balanced");
    const matchingModel = balancedModels.find((m) => m.id === result.model);
    expect(matchingModel).toBeDefined();
    expect(matchingModel!.tier).toBe("balanced");
  });
});

// ── MOD-04: Fallback chains ──────────────────────────────────────────

describe("MOD-04: Fallback chains", () => {
  beforeEach(() => {
    resetAllCircuitBreakers();
  });

  test("suggestFallback returns alternative provider after circuit breaker opens", async () => {
    const failedProvider = "anthropic";
    // Open the circuit breaker for anthropic
    const cb = getCircuitBreaker(failedProvider);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);

    const suggestion = await suggestFallback(failedProvider, "balanced");
    expect(suggestion).not.toBeNull();
    expect(suggestion!.provider).not.toBe(failedProvider);
    expect(suggestion!.model).toBeTruthy();
  });
});

// ── MOD-05: Circuit breaker ──────────────────────────────────────────

describe("MOD-05: Circuit breaker", () => {
  beforeEach(() => {
    resetAllCircuitBreakers();
  });

  test("new circuit breaker starts closed", () => {
    const cb = getCircuitBreaker("test-provider");
    expect(cb.isOpen()).toBe(false);
  });

  test("circuit breaker opens after 3 failures", () => {
    const cb = getCircuitBreaker("test-provider-2");
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(false);
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
  });
});

// ── MOD-06: Registry capabilities ────────────────────────────────────

describe("MOD-06: Registry capabilities", () => {
  test("getModelRegistry returns entries with provider, model (id), and tier fields", async () => {
    const registry = await getModelRegistry();
    expect(registry.length).toBeGreaterThan(0);
    for (const entry of registry) {
      expect(entry).toHaveProperty("provider");
      expect(entry).toHaveProperty("id");
      expect(entry).toHaveProperty("tier");
    }
  });

  test("getModelsForTier('fast') returns only fast-tier entries", () => {
    const fastModels = getModelsForTier("fast");
    expect(fastModels.length).toBeGreaterThan(0);
    for (const model of fastModels) {
      expect(model.tier).toBe("fast");
    }
  });
});
