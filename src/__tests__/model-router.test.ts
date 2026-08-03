import { describe, test, expect, beforeEach, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { resetAllCircuitBreakers, getCircuitBreaker } from "../providers/circuit-breaker";

// Mock getSetting before importing router
const mockGetSetting = mock((_key?: string) => Promise.resolve(undefined));
mock.module("../db/queries/settings", () => ({
  getSetting: mockGetSetting,
  getAllSettings: mock(() => Promise.resolve({})),
  upsertSetting: mock(() => Promise.resolve()),
  deleteSetting: mock(() => Promise.resolve(false)),
  isListingInstalled: mock(() => Promise.resolve(false)),
}));

// Mock encryption
mock.module("../providers/encryption", () => ({
  encrypt: (text: string) => `encrypted:${text}`,
  decrypt: (text: string) => {
    if (text.startsWith("encrypted:")) return text.slice("encrypted:".length);
    throw new Error("Decryption failed");
  },
  _resetKeyCache: () => {},
}));

afterAll(() => restoreModuleMocks());

// Import after mocks
import {
  resolveModel,
  suggestFallback,
  mergePreferenceOrder,
  getDefaultTier,
  ProviderUnavailableError,
} from "../providers/router";
import { getApiKey } from "../providers/credentials";
import { resolveModelForCredential } from "../providers/registry";
import { CURRENT_MODEL_SENTINEL } from "../types";

describe("getDefaultTier", () => {
  // The onboarding wizard historically stored quality/budget — the router
  // must honor the stored INTENT, not silently coerce to "balanced".
  test.each([
    ["quality", "powerful"],
    ["budget", "fast"],
    ["powerful", "powerful"],
    ["fast", "fast"],
    ["balanced", "balanced"],
  ] as const)("stored %s resolves to %s", async (stored, expected) => {
    mockGetSetting.mockImplementation(((key: string) =>
      Promise.resolve(key === "provider:defaultTier" ? stored : undefined)) as any);
    expect(await getDefaultTier()).toBe(expected);
  });

  test("unknown or missing values fall back to balanced", async () => {
    mockGetSetting.mockImplementation(((key: string) =>
      Promise.resolve(key === "provider:defaultTier" ? "turbo" : undefined)) as any);
    expect(await getDefaultTier()).toBe("balanced");
    mockGetSetting.mockImplementation((() => Promise.resolve(undefined)) as any);
    expect(await getDefaultTier()).toBe("balanced");
  });
});

describe("mergePreferenceOrder", () => {
  const DEFAULTS = ["anthropic", "openai", "google", "openrouter"];

  test("appends known defaults missing from a stored order", () => {
    expect(mergePreferenceOrder(["anthropic", "openai", "google"], DEFAULTS)).toEqual([
      "anthropic",
      "openai",
      "google",
      "openrouter",
    ]);
  });

  test("preserves a full stored order unchanged (no duplicates)", () => {
    const full = ["google", "anthropic", "openai", "openrouter"];
    expect(mergePreferenceOrder(full, DEFAULTS)).toEqual(full);
  });

  test("empty stored order yields all defaults", () => {
    expect(mergePreferenceOrder([], DEFAULTS)).toEqual(DEFAULTS);
  });

  test("keeps unknown stored providers and still appends missing defaults", () => {
    expect(mergePreferenceOrder(["ollama", "anthropic"], DEFAULTS)).toEqual([
      "ollama",
      "anthropic",
      "openai",
      "google",
      "openrouter",
    ]);
  });

  test("defaults to DEFAULT_PREFERENCE_ORDER when no defaults arg is passed", () => {
    // Exercises the default-parameter branch; a stored subset gains the rest.
    expect(mergePreferenceOrder(["openai"])).toEqual(["openai", "anthropic", "google", "openrouter"]);
  });
});

/**
 * `resolveModel`'s Level 3 and `suggestFallback` now require a provider to
 * be AUTHENTICABLE, not merely to own a catalog model in the tier — a
 * deployment with only OpenAI connected used to resolve every unpinned turn
 * to `anthropic` and die with "No credentials available for anthropic".
 *
 * The suites below are about ORDER and BREAKER behaviour, so they grant
 * every provider a stored BYOK key and layer their own settings on top.
 * `extra` wins for the keys it answers; anything else falls through to the
 * credential grant. Tests that care about the credential rule state it
 * explicitly instead of relying on this default.
 */
const credentialedSettings =
  (extra: (key: string) => unknown = () => undefined) =>
  ((key: string) => {
    const override = extra(key);
    if (override !== undefined) return Promise.resolve(override);
    if (key.startsWith("provider:apiKey:")) return Promise.resolve("encrypted:sk-test");
    return Promise.resolve(undefined);
  }) as any;

describe("resolveModel", () => {
  beforeEach(() => {
    resetAllCircuitBreakers();
    mockGetSetting.mockReset();
    mockGetSetting.mockImplementation(credentialedSettings());
  });

  test("explicit provider+model passes through unchanged", async () => {
    const result = await resolveModel("anthropic", "claude-sonnet-4-20250514");
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-sonnet-4-20250514");
  });

  test("provider only resolves to best model in default tier", async () => {
    const result = await resolveModel("anthropic");
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBeDefined();
  });

  test("no provider resolves using preference order, skipping open circuit breakers", async () => {
    // Open anthropic's circuit breaker
    const cb = getCircuitBreaker("anthropic");
    for (let i = 0; i < 3; i++) cb.recordFailure();

    const result = await resolveModel();
    // anthropic skipped, should fall to openai
    expect(result.provider).toBe("openai");
    expect(result.model).toBeDefined();
  });

  test("no provider with all circuit breakers open throws", async () => {
    // openrouter is now part of DEFAULT_PREFERENCE_ORDER, so it must also be
    // opened for the "no available providers" path to trigger.
    for (const p of ["anthropic", "openai", "google", "openrouter"]) {
      const cb = getCircuitBreaker(p);
      for (let i = 0; i < 3; i++) cb.recordFailure();
    }

    await expect(resolveModel()).rejects.toThrow("No available providers");
  });

  test("falls through to openrouter when anthropic/openai/google are all open", async () => {
    // Proves openrouter is now in DEFAULT_PREFERENCE_ORDER (last), reachable
    // once the three preceding providers' circuit breakers are open.
    for (const p of ["anthropic", "openai", "google"]) {
      const cb = getCircuitBreaker(p);
      for (let i = 0; i < 3; i++) cb.recordFailure();
    }

    const result = await resolveModel();
    expect(result.provider).toBe("openrouter");
    expect(result.model).toBeDefined();
  });

  test("respects custom preference order from settings", async () => {
    mockGetSetting.mockImplementation(
      credentialedSettings((key: string) => {
        if (key === "provider:preferenceOrder") return ["google", "anthropic", "openai"];
        // Override default tier to "fast" since all google models are fast
        if (key === "provider:defaultTier") return "fast";
        return undefined;
      }),
    );

    const result = await resolveModel();
    expect(result.provider).toBe("google");
  });

  test("self-heals a stored order missing openrouter so it stays reachable", async () => {
    // Simulates an upgraded deployment whose admin saved a 3-provider order
    // before openrouter existed. getPreferenceOrder must append openrouter,
    // so once the three stored providers' circuit breakers are open, routing
    // still falls through to openrouter instead of throwing "No available".
    mockGetSetting.mockImplementation(
      credentialedSettings((key: string) =>
        key === "provider:preferenceOrder" ? ["anthropic", "openai", "google"] : undefined,
      ),
    );
    for (const p of ["anthropic", "openai", "google"]) {
      const cb = getCircuitBreaker(p);
      for (let i = 0; i < 3; i++) cb.recordFailure();
    }

    const result = await resolveModel();
    expect(result.provider).toBe("openrouter");
    expect(result.model).toBeDefined();
  });

  test("respects custom default tier from settings", async () => {
    mockGetSetting.mockImplementation(((key: string) => {
      if (key === "provider:defaultTier") return Promise.resolve("fast");
      return Promise.resolve(undefined);
    }) as any);

    const result = await resolveModel("anthropic");
    // fast tier anthropic = a haiku model
    expect(result.model).toBeDefined();
  });

  test("WS3: explicit requestedTier overrides the configured default tier", async () => {
    // Default tier is "fast" from settings, but the caller requests
    // "powerful" — the requested tier must win (the classifier decided).
    mockGetSetting.mockImplementation(((key: string) => {
      if (key === "provider:defaultTier") return Promise.resolve("fast");
      return Promise.resolve(undefined);
    }) as any);

    const fast = await resolveModel("anthropic", undefined, "fast");
    const powerful = await resolveModel("anthropic", undefined, "powerful");
    expect(fast.model).toBeDefined();
    expect(powerful.model).toBeDefined();
    // Different tiers resolve to different anthropic models.
    expect(powerful.model).not.toBe(fast.model);
  });

  test("WS3: requestedTier is ignored for an explicit provider+model pin", async () => {
    // Level-1 passthrough must be honored regardless of the requested tier
    // (an established/pinned model is never re-routed — cache protection).
    const result = await resolveModel("anthropic", "claude-sonnet-4-20250514", "fast");
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-sonnet-4-20250514");
  });

  test("Level-3 breaker check is credentialScope-keyed: one user's open breaker doesn't reroute others", async () => {
    // Open anthropic's breaker for user-a ONLY.
    const cb = getCircuitBreaker("anthropic", "user-a");
    for (let i = 0; i < 3; i++) cb.recordFailure();

    // user-a is rerouted past anthropic…
    const scoped = await resolveModel(undefined, undefined, undefined, "user-a");
    expect(scoped.provider).toBe("openai");
    // …while a context-free (shared-scope) caller still gets anthropic.
    const shared = await resolveModel();
    expect(shared.provider).toBe("anthropic");
  });

  // ── Level 3 must pick a provider it can AUTHENTICATE ────────────────
  //
  // Bug reproduction. Reported as "No credentials available for anthropic"
  // while a ChatGPT model was selected in the picker. Level 3 runs whenever
  // no provider is pinned — an Auto-routing turn, or any conversation row
  // with a null provider — and it used to select purely on "does this
  // provider have a model in the tier". `anthropic` is first in
  // DEFAULT_PREFERENCE_ORDER and always has catalog models, so on an
  // OpenAI-only deployment every such turn resolved to anthropic and then
  // threw from getCredential. The picker was never consulted, which is why
  // the message named a provider the user had not chosen.
  describe("Level 3 credential gating", () => {
    // Only openai is authenticable — the exact shape of the reported
    // deployment (ChatGPT OAuth connected, no Anthropic key).
    const onlyOpenAI = ((key: string) =>
      Promise.resolve(key === "provider:apiKey:openai" ? "encrypted:sk-test" : undefined)) as any;

    test("skips a credential-less anthropic and resolves the provider that can actually run", async () => {
      mockGetSetting.mockImplementation(onlyOpenAI);

      const result = await resolveModel();

      expect(result.provider).toBe("openai");
      expect(result.model).toBeDefined();
    });

    test("honors preference order among CREDENTIALED providers, not catalog presence", async () => {
      // google sits first in the stored order but has no key; openai does.
      mockGetSetting.mockImplementation(((key: string) => {
        if (key === "provider:preferenceOrder") return Promise.resolve(["google", "openai"]);
        if (key === "provider:apiKey:openai") return Promise.resolve("encrypted:sk-test");
        return Promise.resolve(undefined);
      }) as any);

      expect((await resolveModel()).provider).toBe("openai");
    });

    test("an explicit provider+model pin is NOT credential-gated — Level 1 still passes through", async () => {
      // The probe belongs to the CHOOSING branch only. A user who pinned a
      // model must still reach the provider's own error (which names the
      // real problem) rather than being silently rerouted elsewhere.
      mockGetSetting.mockImplementation(onlyOpenAI);

      const result = await resolveModel("anthropic", "claude-sonnet-4-20250514");
      expect(result.provider).toBe("anthropic");
      expect(result.model).toBe("claude-sonnet-4-20250514");
    });

    // Second half of the same bug. Once Level 3 stopped choosing anthropic
    // it chose openai — then handed a ChatGPT OAuth token `gpt-4` and died
    // with 'Model "gpt-4" is not supported with openai OAuth'. Having a
    // credential is not enough; the MODEL has to be one that credential can
    // serve. Only subscription-eligible ids qualify under OAuth.
    test("under an OAuth credential, picks a subscription-eligible model — never a bare api-key catalog id", async () => {
      // The stored value is ciphertext; this file's `decrypt` mock strips
      // the "encrypted:" prefix, so build the token the same way.
      const oauthBlob =
        "encrypted:" +
        JSON.stringify({ accessToken: "tok", refreshToken: "r", expiresAt: Date.now() + 3_600_000 });
      mockGetSetting.mockImplementation(((key: string) =>
        Promise.resolve(
          key === "provider:accessMode:openai"
            ? "oauth"
            : key === "provider:oauth:openai"
              ? oauthBlob
              : undefined,
        )) as any);

      const result = await resolveModel();
      expect(result.provider).toBe("openai");
      // gpt-4 has no OAuth sibling; resolveModelForCredential would throw.
      expect(result.model).not.toBe("gpt-4");
      // The chosen id must survive the very swap that used to throw.
      expect(() => resolveModelForCredential(result.piModel, "openai", "oauth")).not.toThrow();
    });

    test("with NO provider credentialed, the throw names the real constraint", async () => {
      mockGetSetting.mockImplementation((() => Promise.resolve(undefined)) as any);
      // Env keys would satisfy getApiKey's fallback and mask the case.
      const saved: Record<string, string | undefined> = {};
      for (const v of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY"]) {
        saved[v] = process.env[v];
        delete process.env[v];
      }
      try {
        await expect(resolveModel()).rejects.toThrow(/No available providers with credentials/);
      } finally {
        for (const [v, val] of Object.entries(saved)) if (val !== undefined) process.env[v] = val;
      }
    });
  });

  describe("resolveModel with custom models", () => {
    test("custom model with baseUrl passes it through to piModel", async () => {
      mockGetSetting.mockImplementation(((key: string) => {
        if (key === "provider:customModels")
          return Promise.resolve([
            {
              modelId: "llama3",
              provider: "ollama",
              tier: "balanced",
              baseUrl: "http://localhost:11434",
            },
          ]);
        return Promise.resolve(undefined);
      }) as any);

      const result = await resolveModel("ollama", "llama3");
      expect(result.provider).toBe("ollama");
      expect(result.model).toBe("llama3");
      expect(result.piModel.baseUrl).toBe("http://localhost:11434/v1");
    });

    test("custom model without baseUrl falls back to default openai URL", async () => {
      mockGetSetting.mockImplementation(((key: string) => {
        if (key === "provider:customModels")
          return Promise.resolve([
            {
              modelId: "my-custom-model",
              provider: "ollama",
              tier: "balanced",
            },
          ]);
        return Promise.resolve(undefined);
      }) as any);

      const result = await resolveModel("ollama", "my-custom-model");
      expect(result.provider).toBe("ollama");
      expect(result.model).toBe("my-custom-model");
      expect(result.piModel.baseUrl).toBe("https://api.openai.com/v1");
    });

    test("non-custom model (in pi-ai registry) is unaffected", async () => {
      const result = await resolveModel("anthropic", "claude-sonnet-4-20250514");
      expect(result.provider).toBe("anthropic");
      expect(result.model).toBe("claude-sonnet-4-20250514");
      // Registry models have their own baseUrl set by pi-ai, not our custom logic
      expect(result.piModel).toBeDefined();
    });

    test("no custom models setting returns undefined baseUrl lookup, uses default", async () => {
      // mockGetSetting already returns undefined by default (from beforeEach)
      const result = await resolveModel("ollama", "some-model");
      expect(result.provider).toBe("ollama");
      expect(result.model).toBe("some-model");
      // No custom models found, so baseUrl is undefined -> falls back to default
      expect(result.piModel.baseUrl).toBe("https://api.openai.com/v1");
    });
  });

  // ── The `__current__` inherit sentinel ────────────────────────────
  //
  // Bug reproduction, found by actually running an ez-factory workflow:
  // every `agent` step died with `No credentials available for
  // __current__`. `CURRENT_MODEL_SENTINEL` means "use the model in force",
  // and the only site that ever substituted it reads the parent
  // CONVERSATION — which a workflow step does not have. The sentinel then
  // reached Level 1 as two truthy strings, took the pinned passthrough, and
  // `getCredential("__current__")` threw.
  //
  // Every config-based agent stored with the sentinel (all three seeded
  // `ez-factory` agents, `ez-code coder`) was unrunnable from a workflow
  // because of it. The adapter deliberately does not interpret the sentinel
  // ("the router's problem" — `pi-llm-adapter-model-override.test.ts`), so
  // the resolution belongs here.
  describe("CURRENT_MODEL_SENTINEL", () => {
    test("a fully-sentinel binding routes by tier instead of pinning `__current__`", async () => {
      const result = await resolveModel(CURRENT_MODEL_SENTINEL, CURRENT_MODEL_SENTINEL);
      // The decisive assertion: the sentinel is NEVER the resolved provider.
      // Pre-fix this returned `{provider: "__current__", model: "__current__"}`
      // and the caller's `getCredential` threw on it.
      expect(result.provider).not.toBe(CURRENT_MODEL_SENTINEL);
      expect(result.model).not.toBe(CURRENT_MODEL_SENTINEL);
      // …and it lands on a real, credentialed provider from the order.
      expect(result.provider).toBe("anthropic");
      expect(result.model).toBeDefined();
    });

    test("a sentinel PROVIDER with a real model still refuses to pin the sentinel", async () => {
      // Half a sentinel is normalised the same way, so nothing downstream
      // ever searches for a provider literally named `__current__`.
      const result = await resolveModel(CURRENT_MODEL_SENTINEL, "claude-sonnet-4-20250514");
      expect(result.provider).not.toBe(CURRENT_MODEL_SENTINEL);
    });

    test("a sentinel MODEL under a real provider picks that provider's tier model", async () => {
      const result = await resolveModel("anthropic", CURRENT_MODEL_SENTINEL);
      expect(result.provider).toBe("anthropic");
      expect(result.model).not.toBe(CURRENT_MODEL_SENTINEL);
    });

    test("a real provider+model pin is untouched by the normalisation", async () => {
      // Guards the normalisation against over-reach: only the exact sentinel
      // string is collapsed, never a legitimate binding.
      const result = await resolveModel("anthropic", "claude-sonnet-4-20250514");
      expect(result.provider).toBe("anthropic");
      expect(result.model).toBe("claude-sonnet-4-20250514");
    });
  });
});

describe("suggestFallback", () => {
  beforeEach(() => {
    resetAllCircuitBreakers();
    mockGetSetting.mockReset();
    mockGetSetting.mockImplementation(credentialedSettings());
  });

  test("returns next available provider+model in same tier", async () => {
    const suggestion = await suggestFallback("anthropic", "balanced");
    expect(suggestion).not.toBeNull();
    expect(suggestion!.provider).not.toBe("anthropic");
    expect(suggestion!.tier).toBe("balanced");
    expect(suggestion!.model).toBeDefined();
  });

  test("skips circuit-breaker-open providers", async () => {
    // Open openai's circuit breaker (next in default order after anthropic)
    const cb = getCircuitBreaker("openai");
    for (let i = 0; i < 3; i++) cb.recordFailure();

    // Use "fast" tier since google models are all classified as fast (gemini contains "mini")
    const suggestion = await suggestFallback("anthropic", "fast");
    expect(suggestion).not.toBeNull();
    expect(suggestion!.provider).toBe("google");
  });

  test("breaker checks are credentialScope-keyed: one user's open breaker doesn't affect other scopes", async () => {
    // Open openai's breaker for user-a ONLY.
    const cb = getCircuitBreaker("openai", "user-a");
    for (let i = 0; i < 3; i++) cb.recordFailure();

    // user-a's fallback skips openai…
    const scoped = await suggestFallback("anthropic", "fast", "user-a");
    expect(scoped).not.toBeNull();
    expect(scoped!.provider).toBe("google");
    // …while the shared-scope (default) fallback still suggests it.
    const shared = await suggestFallback("anthropic", "fast");
    expect(shared).not.toBeNull();
    expect(shared!.provider).toBe("openai");
  });

  test("suggests openrouter when preceding providers are open", async () => {
    // Default order is anthropic → openai → google → openrouter. Failing
    // anthropic and opening openai + google leaves openrouter as the only
    // suggestion, proving it is part of the preference order.
    for (const p of ["openai", "google"]) {
      const cb = getCircuitBreaker(p);
      for (let i = 0; i < 3; i++) cb.recordFailure();
    }

    const suggestion = await suggestFallback("anthropic", "balanced");
    expect(suggestion).not.toBeNull();
    expect(suggestion!.provider).toBe("openrouter");
    expect(suggestion!.model).toBeDefined();
  });

  test("returns null when no alternatives available", async () => {
    // Open all other providers (openrouter now included in default order)
    for (const p of ["openai", "google", "openrouter"]) {
      const cb = getCircuitBreaker(p);
      for (let i = 0; i < 3; i++) cb.recordFailure();
    }

    const suggestion = await suggestFallback("anthropic", "balanced");
    expect(suggestion).toBeNull();
  });

  test("self-heals a stored order missing openrouter when suggesting a fallback", async () => {
    // Stored order predates openrouter; getPreferenceOrder appends it, so with
    // the stored anthropic/openai/google all failed/open, openrouter is the
    // only remaining fallback suggestion.
    mockGetSetting.mockImplementation(
      credentialedSettings((key: string) =>
        key === "provider:preferenceOrder" ? ["anthropic", "openai", "google"] : undefined,
      ),
    );
    for (const p of ["openai", "google"]) {
      const cb = getCircuitBreaker(p);
      for (let i = 0; i < 3; i++) cb.recordFailure();
    }

    const suggestion = await suggestFallback("anthropic", "balanced");
    expect(suggestion).not.toBeNull();
    expect(suggestion!.provider).toBe("openrouter");
  });

  // Same rule as Level 3. Suggesting a provider we cannot authenticate
  // converts a recoverable provider error into a second credentials error,
  // and shows the user a "try X instead" that could never have worked.
  test("never suggests a provider with no usable credential", async () => {
    mockGetSetting.mockImplementation(((key: string) =>
      Promise.resolve(key === "provider:apiKey:openrouter" ? "encrypted:sk-test" : undefined)) as any);
    const saved: Record<string, string | undefined> = {};
    for (const v of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
    try {
      // openai + google precede openrouter in the default order but have no
      // credential, so the only honest suggestion is openrouter.
      const suggestion = await suggestFallback("anthropic", "balanced");
      expect(suggestion).not.toBeNull();
      expect(suggestion!.provider).toBe("openrouter");
    } finally {
      for (const [v, val] of Object.entries(saved)) if (val !== undefined) process.env[v] = val;
    }
  });
});

describe("ProviderUnavailableError", () => {
  test("carries failedProvider, failedModel, and suggestion fields", () => {
    const err = new ProviderUnavailableError(
      "Anthropic is unavailable",
      "anthropic",
      "claude-sonnet-4-20250514",
      { provider: "openai", model: "gpt-4o", tier: "balanced" },
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.failedProvider).toBe("anthropic");
    expect(err.failedModel).toBe("claude-sonnet-4-20250514");
    expect(err.suggestion).toEqual({ provider: "openai", model: "gpt-4o", tier: "balanced" });
    expect(err.message).toBe("Anthropic is unavailable");
  });

  test("suggestion can be null", () => {
    const err = new ProviderUnavailableError("No providers", "anthropic", "claude-sonnet-4-20250514", null);
    expect(err.suggestion).toBeNull();
  });
});

describe("getApiKey (BYOK-aware)", () => {
  beforeEach(() => {
    mockGetSetting.mockReset();
    mockGetSetting.mockImplementation(() => Promise.resolve(undefined));
  });

  test("checks stored key before env var", async () => {
    mockGetSetting.mockImplementation(((key: string) => {
      if (key === "provider:apiKey:anthropic") return Promise.resolve("encrypted:sk-stored-key");
      return Promise.resolve(undefined);
    }) as any);

    const key = await getApiKey("anthropic");
    expect(key).toBe("sk-stored-key");
  });

  test("falls back to env var when no stored key", async () => {
    // No stored key, should use env var
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-env-key";
    try {
      const key = await getApiKey("anthropic");
      expect(key).toBe("sk-env-key");
    } finally {
      if (originalKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = originalKey;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });

  test("falls through to env var when decrypt fails", async () => {
    mockGetSetting.mockImplementation(((key: string) => {
      if (key === "provider:apiKey:anthropic") return Promise.resolve("bad-encrypted-data");
      return Promise.resolve(undefined);
    }) as any);

    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-fallback-key";
    try {
      const key = await getApiKey("anthropic");
      expect(key).toBe("sk-fallback-key");
    } finally {
      if (originalKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = originalKey;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });
});
