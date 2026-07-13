/**
 * Unit tests for `src/contexts/config.ts` — the model-resolution ladder.
 *
 * Every rung is exercised with injected deps (no DB, no network, no model).
 */
import { test, expect, describe } from "bun:test";
import {
  CONTEXTS_MODEL_KEY,
  ContextsUnavailableError,
  describeTarget,
  parseModelSetting,
  resolveContextsTarget,
  type ResolveContextsDeps,
} from "../contexts/config";

function deps(overrides: Partial<ResolveContextsDeps>): Partial<ResolveContextsDeps> {
  return {
    getSetting: async () => undefined,
    getSuggestConfig: async () => ({ baseUrl: null, model: "qwen3:1.7b" }),
    isEnhanceAvailable: async () => false,
    resolveModel: async () => {
      throw new Error("no model");
    },
    getConversation: async () => null,
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
