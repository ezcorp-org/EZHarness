import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// ── Mocks (must be set up before importing the module under test) ─────

const mockStream = mock(async (_model: any, _context: any, _opts: any) => ({
  [Symbol.asyncIterator]: async function* () {
    yield { type: "text", text: "hello" };
  },
}));

const mockComplete = mock(async (_model: any, _context: any, _opts: any) => ({
  role: "assistant" as const,
  content: [{ type: "text", text: "completed" }],
}));

mock.module("@earendil-works/pi-ai/compat", () => ({
  stream: mockStream,
  complete: mockComplete,
  // Throw like the real catalog does for unknown lookups so the registry's
  // resolveOAuthModel falls through to LOCAL_OAUTH_OVERRIDES (the OAuth
  // swap tests below rely on the gpt-5.5 override entry).
  getModel: mock(() => {
    throw new Error("unknown model (stub)");
  }),
  getModels: mock(() => []),
  getProviders: mock(() => []),
  getEnvApiKey: mock(() => undefined),
}));

const mockGetCredential = mock(
  async (
    _provider: string,
    _conversationId?: string,
  ): Promise<{ type: "apikey" | "oauth"; token: string }> => ({
    type: "apikey",
    token: "test-api-key-123",
  }),
);

mock.module("../providers/credentials", () => ({
  getCredential: mockGetCredential,
  getApiKey: mock(async () => "test-api-key-123"),
}));

afterAll(() => restoreModuleMocks());

// Import after mocks
const { streamLLM, completeLLM } = await import("../providers/llm");

// ── Fixtures ──────────────────────────────────────────────────────────

const fakeModel = { provider: "anthropic", id: "claude-sonnet-4" } as any;
const fakeContext = {
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
} as any;

// ── Tests ─────────────────────────────────────────────────────────────

describe("streamLLM", () => {
  beforeEach(() => {
    mockGetCredential.mockClear();
    mockStream.mockClear();
  });

  test("resolves credential and calls pi-ai stream()", async () => {
    await streamLLM(fakeModel, fakeContext);

    expect(mockGetCredential).toHaveBeenCalledTimes(1);
    expect(mockGetCredential).toHaveBeenCalledWith("anthropic", undefined);
    expect(mockStream).toHaveBeenCalledTimes(1);
    expect(mockStream).toHaveBeenCalledWith(fakeModel, fakeContext, {
      apiKey: "test-api-key-123",
      signal: undefined,
    });
  });

  test("passes signal option through to pi-ai stream()", async () => {
    const controller = new AbortController();
    await streamLLM(fakeModel, fakeContext, { signal: controller.signal });

    expect(mockStream).toHaveBeenCalledWith(fakeModel, fakeContext, {
      apiKey: "test-api-key-123",
      signal: controller.signal,
    });
  });

  test("passes conversationId to getCredential", async () => {
    await streamLLM(fakeModel, fakeContext, { conversationId: "conv-abc" });

    expect(mockGetCredential).toHaveBeenCalledWith("anthropic", "conv-abc");
  });

  test("returns the async iterator from pi-ai stream()", async () => {
    const result = await streamLLM(fakeModel, fakeContext);

    // Should be iterable
    expect(typeof result[Symbol.asyncIterator]).toBe("function");
  });

  test("propagates errors from getCredential", async () => {
    mockGetCredential.mockImplementationOnce(async () => {
      throw new Error("No credentials available for anthropic");
    });

    await expect(streamLLM(fakeModel, fakeContext)).rejects.toThrow(
      "No credentials available for anthropic",
    );
  });

  test("propagates errors from pi-ai stream()", async () => {
    mockStream.mockImplementationOnce(async () => {
      throw new Error("Stream connection failed");
    });

    await expect(streamLLM(fakeModel, fakeContext)).rejects.toThrow(
      "Stream connection failed",
    );
  });
});

describe("completeLLM", () => {
  beforeEach(() => {
    mockGetCredential.mockClear();
    mockComplete.mockClear();
  });

  test("resolves credential and calls pi-ai complete()", async () => {
    await completeLLM(fakeModel, fakeContext);

    expect(mockGetCredential).toHaveBeenCalledTimes(1);
    expect(mockGetCredential).toHaveBeenCalledWith("anthropic", undefined);
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(mockComplete).toHaveBeenCalledWith(fakeModel, fakeContext, {
      apiKey: "test-api-key-123",
    });
  });

  test("passes conversationId to getCredential", async () => {
    await completeLLM(fakeModel, fakeContext, { conversationId: "conv-xyz" });

    expect(mockGetCredential).toHaveBeenCalledWith("anthropic", "conv-xyz");
  });

  test("returns assistant message from pi-ai complete()", async () => {
    const result = await completeLLM(fakeModel, fakeContext);

    expect(result.role).toBe("assistant");
    expect(result.content).toEqual([{ type: "text", text: "completed" }]);
  });

  test("propagates errors from getCredential", async () => {
    mockGetCredential.mockImplementationOnce(async () => {
      throw new Error("Missing API key for anthropic");
    });

    await expect(completeLLM(fakeModel, fakeContext)).rejects.toThrow(
      "Missing API key for anthropic",
    );
  });

  test("propagates errors from pi-ai complete()", async () => {
    mockComplete.mockImplementationOnce(async () => {
      throw new Error("Model overloaded");
    });

    await expect(completeLLM(fakeModel, fakeContext)).rejects.toThrow(
      "Model overloaded",
    );
  });

  test("works with a google model — passes provider to getCredential", async () => {
    const googleModel = { provider: "google", id: "gemini-2.0-flash" } as any;
    await completeLLM(googleModel, fakeContext);

    expect(mockGetCredential).toHaveBeenCalledWith("google", undefined);
  });
});

describe("OAuth model swap (resolveModelForCredential applied in llm.ts)", () => {
  // With an OAuth credential, the standard endpoint model must be
  // exchanged for its subscription-eligible sibling before the pi-ai
  // call — a ChatGPT-plan token 401s api.openai.com ("Missing scopes:
  // api.responses.write"). gpt-5.5 resolves through the registry's
  // LOCAL_OAUTH_OVERRIDES (openai-codex backend), so no compat getModel
  // stubbing is needed here.
  const oauthCred = { type: "oauth" as const, token: "oauth-token-xyz" };
  const openaiModel = { provider: "openai", id: "gpt-5.5" } as any;

  beforeEach(() => {
    mockGetCredential.mockClear();
    mockStream.mockClear();
    mockComplete.mockClear();
  });

  test("completeLLM swaps an openai model to the codex backend under OAuth, keeping the provider name", async () => {
    mockGetCredential.mockImplementationOnce(async () => oauthCred);
    await completeLLM(openaiModel, fakeContext);

    const [modelArg] = mockComplete.mock.calls[0]! as [any, any, any];
    expect(modelArg.api).toBe("openai-codex-responses");
    expect(modelArg.baseUrl).toContain("chatgpt.com");
    // Provider name stays "openai" so credential lookups keep resolving.
    expect(modelArg.provider).toBe("openai");
  });

  test("streamLLM applies the same swap", async () => {
    mockGetCredential.mockImplementationOnce(async () => oauthCred);
    await streamLLM(openaiModel, fakeContext);

    const [modelArg] = mockStream.mock.calls[0]! as [any, any, any];
    expect(modelArg.api).toBe("openai-codex-responses");
    expect(modelArg.provider).toBe("openai");
  });

  test("an API-key credential passes the model through untouched", async () => {
    await completeLLM(openaiModel, fakeContext);

    const [modelArg] = mockComplete.mock.calls[0]! as [any, any, any];
    expect(modelArg).toBe(openaiModel);
  });

  test("an OAuth credential for a provider with no OAuth variant passes through (anthropic)", async () => {
    mockGetCredential.mockImplementationOnce(async () => oauthCred);
    await completeLLM(fakeModel, fakeContext);

    const [modelArg] = mockComplete.mock.calls[0]! as [any, any, any];
    expect(modelArg).toBe(fakeModel);
  });
});
