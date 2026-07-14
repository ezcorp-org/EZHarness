/**
 * Unit tests for `src/contexts/config.ts` — the model-resolution ladder.
 *
 * Every rung is exercised with injected deps (no DB, no network, no model).
 */
import { test, expect, describe } from "bun:test";
import {
  CONTEXTS_MODEL_KEY,
  ContextsUnavailableError,
  describeCapability,
  describeTarget,
  parseModelSetting,
  resolveContextsTarget,
  unsupportedModelMessage,
  type ResolveContextsDeps,
} from "../contexts/config";
import type { ModelSupportResult } from "../contexts/model-support";

const supportedResult: ModelSupportResult = { supported: true, baseUrl: "", model: "", checkedAt: 0 };
function unsupported(reason: ModelSupportResult["reason"]): ModelSupportResult {
  return { supported: false, baseUrl: "", model: "", reason, checkedAt: 0 };
}

function deps(overrides: Partial<ResolveContextsDeps>): Partial<ResolveContextsDeps> {
  return {
    getSetting: async () => undefined,
    getSuggestConfig: async () => ({ baseUrl: null, model: "qwen3.5:4b" }),
    isEnhanceAvailable: async () => false,
    resolveModel: async () => {
      throw new Error("no model");
    },
    getConversation: async () => null,
    getModelSupport: async () => supportedResult,
    ...overrides,
  };
}

describe("parseModelSetting", () => {
  test("valid provider/model", () => {
    expect(parseModelSetting("anthropic/claude-x")).toEqual({ provider: "anthropic", modelId: "claude-x" });
  });
  test("model id may contain slashes (split on first)", () => {
    expect(parseModelSetting("openrouter/meta-llama/llama-3")).toEqual({
      provider: "openrouter",
      modelId: "meta-llama/llama-3",
    });
  });
  test("no slash → null", () => {
    expect(parseModelSetting("anthropic")).toBeNull();
  });
  test("leading slash / empty provider → null", () => {
    expect(parseModelSetting("/model")).toBeNull();
  });
  test("empty model part → null", () => {
    expect(parseModelSetting("anthropic/")).toBeNull();
  });
  test("empty + non-string → null", () => {
    expect(parseModelSetting("")).toBeNull();
    expect(parseModelSetting(undefined)).toBeNull();
    expect(parseModelSetting(42)).toBeNull();
  });
});

describe("describeTarget", () => {
  test("sidecar → local/<model>", () => {
    expect(describeTarget({ kind: "sidecar", baseUrl: "http://x", model: "qwen3:1.7b" })).toBe("local/qwen3:1.7b");
  });
  test("pi → <provider>/<modelId>", () => {
    expect(describeTarget({ kind: "pi", provider: "anthropic", modelId: "claude-x", piModel: {} })).toBe(
      "anthropic/claude-x",
    );
  });
});

describe("resolveContextsTarget ladder", () => {
  test("rung 1: setting → custom local model with baseUrl → sidecar", async () => {
    const t = await resolveContextsTarget(
      "c1",
      deps({
        getSetting: async (k) =>
          k === CONTEXTS_MODEL_KEY
            ? "ollama/qwen3:4b"
            : k === "provider:customModels"
              ? [{ id: "qwen3:4b", baseUrl: "http://localhost:11434" }]
              : undefined,
      }),
    );
    expect(t).toEqual({ kind: "sidecar", baseUrl: "http://localhost:11434", model: "qwen3:4b" });
  });

  test("rung 1: setting resolves to a cloud model (no custom baseUrl) → pi", async () => {
    const t = await resolveContextsTarget(
      "c1",
      deps({
        getSetting: async (k) => (k === CONTEXTS_MODEL_KEY ? "anthropic/claude-x" : []),
        resolveModel: async (p, m) => ({ provider: p!, model: m!, piModel: { id: m } }),
      }),
    );
    expect(t).toEqual({ kind: "pi", provider: "anthropic", modelId: "claude-x", piModel: { id: "claude-x" } });
  });

  test("rung 1 unresolvable → warns and falls through to the default sidecar", async () => {
    const t = await resolveContextsTarget(
      "c1",
      deps({
        getSetting: async (k) => (k === CONTEXTS_MODEL_KEY ? "bogus/model" : []),
        resolveModel: async () => {
          throw new Error("unresolvable");
        },
        getSuggestConfig: async () => ({ baseUrl: "http://side", model: "qwen3:1.7b" }),
        isEnhanceAvailable: async () => true,
      }),
    );
    expect(t).toEqual({ kind: "sidecar", baseUrl: "http://side", model: "qwen3:1.7b" });
  });

  test("rung 2: unset + sidecar probe OK → sidecar", async () => {
    const t = await resolveContextsTarget(
      "c1",
      deps({
        getSuggestConfig: async () => ({ baseUrl: "http://side", model: "qwen3:1.7b" }),
        isEnhanceAvailable: async () => true,
      }),
    );
    expect(t).toEqual({ kind: "sidecar", baseUrl: "http://side", model: "qwen3:1.7b" });
  });

  test('empty-string setting (UI "clear" / "Current Chat Model") is treated as unset → sidecar', async () => {
    // The settings UI PUTs `contexts:model = ""`; it must NOT error, and must
    // fall to the default-local sidecar without warning (empty = intentional).
    const t = await resolveContextsTarget(
      "c1",
      deps({
        getSetting: async (k) => (k === CONTEXTS_MODEL_KEY ? "" : []),
        getSuggestConfig: async () => ({ baseUrl: "http://side", model: "qwen3:1.7b" }),
        isEnhanceAvailable: async () => true,
      }),
    );
    expect(t).toEqual({ kind: "sidecar", baseUrl: "http://side", model: "qwen3:1.7b" });
  });

  test("whitespace-only setting is treated as unset → sidecar", async () => {
    const t = await resolveContextsTarget(
      "c1",
      deps({
        getSetting: async (k) => (k === CONTEXTS_MODEL_KEY ? "   " : []),
        getSuggestConfig: async () => ({ baseUrl: "http://side", model: "qwen3:1.7b" }),
        isEnhanceAvailable: async () => true,
      }),
    );
    expect(t.kind).toBe("sidecar");
  });

  test("malformed non-empty setting (no slash) → warns + falls through to sidecar", async () => {
    const t = await resolveContextsTarget(
      "c1",
      deps({
        getSetting: async (k) => (k === CONTEXTS_MODEL_KEY ? "gpt4" : []),
        getSuggestConfig: async () => ({ baseUrl: "http://side", model: "qwen3:1.7b" }),
        isEnhanceAvailable: async () => true,
      }),
    );
    expect(t).toEqual({ kind: "sidecar", baseUrl: "http://side", model: "qwen3:1.7b" });
  });

  test("rung 3: sidecar down → conversation turn model → pi", async () => {
    const t = await resolveContextsTarget(
      "c1",
      deps({
        getSuggestConfig: async () => ({ baseUrl: "http://side", model: "qwen3:1.7b" }),
        isEnhanceAvailable: async () => false,
        getConversation: async () => ({ provider: "openai", model: "gpt-4" }),
        resolveModel: async (p, m) => {
          if (p === "openai") return { provider: "openai", model: m!, piModel: {} };
          throw new Error("no");
        },
      }),
    );
    expect(t).toMatchObject({ kind: "pi", provider: "openai", modelId: "gpt-4" });
  });

  test("rung 3: turn model unresolvable → default tier → pi", async () => {
    const t = await resolveContextsTarget(
      "c1",
      deps({
        getConversation: async () => ({ provider: "openai", model: "gpt-4" }),
        resolveModel: async (p) => {
          if (p === undefined) return { provider: "anthropic", model: "claude", piModel: {} };
          throw new Error("turn model gone");
        },
      }),
    );
    expect(t).toMatchObject({ kind: "pi", provider: "anthropic", modelId: "claude" });
  });

  test("rung 3: conversation with null provider/model skips to default tier", async () => {
    const t = await resolveContextsTarget(
      "c1",
      deps({
        getConversation: async () => ({ provider: null, model: null }),
        resolveModel: async (p) => {
          expect(p).toBeUndefined();
          return { provider: "anthropic", model: "claude", piModel: {} };
        },
      }),
    );
    expect(t).toMatchObject({ kind: "pi", provider: "anthropic" });
  });

  test("empty conversationId → skips conversation lookup, goes to default tier", async () => {
    const t = await resolveContextsTarget(
      "",
      deps({
        resolveModel: async () => ({ provider: "anthropic", model: "claude", piModel: {} }),
      }),
    );
    expect(t).toMatchObject({ kind: "pi", provider: "anthropic" });
  });

  test("rung 4: nothing resolvable → ContextsUnavailableError", async () => {
    await expect(
      resolveContextsTarget("c1", deps({})),
    ).rejects.toBeInstanceOf(ContextsUnavailableError);
  });
});

describe("resolveContextsTarget — resource-aware support gate", () => {
  test("rung 2 sidecar unsupported → SKIPS to the turn model (feature keeps working)", async () => {
    const t = await resolveContextsTarget(
      "c1",
      deps({
        getSuggestConfig: async () => ({ baseUrl: "http://side", model: "qwen3.5:4b" }),
        isEnhanceAvailable: async () => true,
        getModelSupport: async () => unsupported("load-failed"),
        getConversation: async () => ({ provider: "openai", model: "gpt-4" }),
        resolveModel: async (p, m) => ({ provider: p!, model: m!, piModel: {} }),
      }),
    );
    expect(t).toMatchObject({ kind: "pi", provider: "openai", modelId: "gpt-4" });
  });

  test("sidecar unsupported + no fallback → 503 carries the model + reason", async () => {
    await expect(
      resolveContextsTarget(
        "c1",
        deps({
          getSuggestConfig: async () => ({ baseUrl: "http://side", model: "qwen3.5:4b" }),
          isEnhanceAvailable: async () => true,
          getModelSupport: async () => unsupported("timeout"),
        }),
      ),
    ).rejects.toThrow(/can't run the local model qwen3\.5:4b .*too long to load/);
  });

  test("rung 1 local pin unsupported → falls through to a supported rung-2 default", async () => {
    const t = await resolveContextsTarget(
      "c1",
      deps({
        getSetting: async (k) =>
          k === CONTEXTS_MODEL_KEY
            ? "ollama/big-model"
            : k === "provider:customModels"
              ? [{ id: "big-model", baseUrl: "http://localhost:11434" }]
              : undefined,
        // Only the pinned big-model is unsupported; the default sidecar runs.
        getModelSupport: async (_b, model) =>
          model === "big-model" ? unsupported("model-missing") : supportedResult,
        getSuggestConfig: async () => ({ baseUrl: "http://side", model: "qwen3.5:4b" }),
        isEnhanceAvailable: async () => true,
      }),
    );
    expect(t).toEqual({ kind: "sidecar", baseUrl: "http://side", model: "qwen3.5:4b" });
  });

  test("rung 1 local pin supported → used (gate consulted, passes)", async () => {
    const t = await resolveContextsTarget(
      "c1",
      deps({
        getSetting: async (k) =>
          k === CONTEXTS_MODEL_KEY
            ? "ollama/big-model"
            : k === "provider:customModels"
              ? [{ id: "big-model", baseUrl: "http://localhost:11434" }]
              : undefined,
        getModelSupport: async () => supportedResult,
      }),
    );
    expect(t).toEqual({ kind: "sidecar", baseUrl: "http://localhost:11434", model: "big-model" });
  });
});

describe("unsupportedModelMessage", () => {
  test("each reason maps to human copy", () => {
    expect(unsupportedModelMessage("m", "endpoint-down")).toMatch(/endpoint is unreachable/);
    expect(unsupportedModelMessage("m", "model-missing")).toMatch(/isn't installed/);
    expect(unsupportedModelMessage("m", "load-failed")).toMatch(/couldn't load it/);
    expect(unsupportedModelMessage("m", "timeout")).toMatch(/too long to load/);
  });
  test("missing reason → generic 'unavailable'", () => {
    expect(unsupportedModelMessage("m")).toMatch(/\(it is unavailable\)/);
  });
});

describe("describeCapability", () => {
  const capDeps = (overrides: Partial<ResolveContextsDeps>) =>
    deps({
      getSuggestConfig: async () => ({ baseUrl: "http://side", model: "qwen3.5:4b" }),
      isEnhanceAvailable: async () => true,
      ...overrides,
    });

  test("supported local → activeLane local, no reason", async () => {
    const cap = await describeCapability("c1", capDeps({ getModelSupport: async () => supportedResult }));
    expect(cap).toEqual({ localModel: "qwen3.5:4b", supported: true, reason: undefined, activeLane: "local" });
  });

  test("unprobed (peek null) → optimistic supported", async () => {
    const cap = await describeCapability("c1", capDeps({ getModelSupport: async () => null }));
    expect(cap.supported).toBe(true);
    expect(cap.reason).toBeUndefined();
    expect(cap.activeLane).toBe("local");
  });

  test("unsupported + fallback lane → supported:false, activeLane turn-model", async () => {
    const cap = await describeCapability(
      "c1",
      capDeps({
        getModelSupport: async () => unsupported("load-failed"),
        getConversation: async () => ({ provider: "openai", model: "gpt-4" }),
        resolveModel: async (p, m) => ({ provider: p!, model: m!, piModel: {} }),
      }),
    );
    expect(cap).toEqual({ localModel: "qwen3.5:4b", supported: false, reason: "load-failed", activeLane: "turn-model" });
  });

  test("unsupported + NO fallback → supported:false, activeLane stays local", async () => {
    const cap = await describeCapability(
      "c1",
      capDeps({ getModelSupport: async () => unsupported("timeout") }),
    );
    expect(cap).toMatchObject({ supported: false, reason: "timeout", activeLane: "local" });
  });

  test("cloud pin → activeLane cloud, local support still reported", async () => {
    const cap = await describeCapability(
      "c1",
      capDeps({
        getSetting: async (k) => (k === CONTEXTS_MODEL_KEY ? "anthropic/claude-x" : []),
        resolveModel: async (p, m) => ({ provider: p!, model: m!, piModel: {} }),
        getModelSupport: async () => supportedResult,
      }),
    );
    expect(cap.activeLane).toBe("cloud");
    expect(cap.localModel).toBe("qwen3.5:4b");
  });

  test("no local endpoint configured → endpoint-down, unsupported", async () => {
    const cap = await describeCapability(
      "c1",
      capDeps({
        getSuggestConfig: async () => ({ baseUrl: null, model: "qwen3.5:4b" }),
        isEnhanceAvailable: async () => false,
        getConversation: async () => ({ provider: "openai", model: "gpt-4" }),
        resolveModel: async (p, m) => ({ provider: p!, model: m!, piModel: {} }),
      }),
    );
    expect(cap).toMatchObject({ supported: false, reason: "endpoint-down", activeLane: "turn-model" });
  });

  test("effectiveLocalModel uses a rung-1 local pin's model", async () => {
    const cap = await describeCapability(
      "c1",
      capDeps({
        getSetting: async (k) =>
          k === CONTEXTS_MODEL_KEY
            ? "ollama/pinned-local"
            : k === "provider:customModels"
              ? [{ id: "pinned-local", baseUrl: "http://localhost:11434" }]
              : undefined,
        getModelSupport: async () => supportedResult,
      }),
    );
    expect(cap.localModel).toBe("pinned-local");
    expect(cap.activeLane).toBe("local");
  });

  test("uses the cached-only peek by DEFAULT (no probe on the read path)", async () => {
    // No getModelSupport override → the real peekModelSupport is used; with a
    // cold cache it returns null → optimistic supported, never a network probe.
    const cap = await describeCapability("c1", {
      getSetting: async () => undefined,
      getSuggestConfig: async () => ({ baseUrl: "http://side", model: "qwen3.5:4b" }),
      isEnhanceAvailable: async () => true,
    });
    expect(cap.supported).toBe(true);
    expect(cap.activeLane).toBe("local");
  });
});
