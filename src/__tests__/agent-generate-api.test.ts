import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { stubAssistantMessage } from "./helpers/mock-pi-ai";

// Mock the pi-ai complete() function before any imports that use it
let mockCompleteText = "Hello, I can help you create an agent.";
let mockCompleteError: Error | null = null;

mock.module("@earendil-works/pi-ai", () => ({
  complete: async () => {
    if (mockCompleteError) throw mockCompleteError;
    return stubAssistantMessage(mockCompleteText);
  },
  stream: () => { throw new Error("not used"); },
  getModel: () => ({ id: "test-model", provider: "anthropic" }),
  getModels: () => [],
  getProviders: () => ["anthropic", "openai", "google"],
  getEnvApiKey: () => undefined,
}));

mock.module("../providers/router", () => ({
  resolveModel: async () => ({
    provider: "anthropic",
    model: "test-model",
    piModel: { id: "test-model", provider: "anthropic", api: "anthropic-messages", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 },
  }),
  ProviderUnavailableError: class ProviderUnavailableError extends Error {
    constructor(message: string, public readonly failedProvider: string, public readonly failedModel: string, public readonly suggestion: unknown) {
      super(message);
      this.name = "ProviderUnavailableError";
    }
  },
  suggestFallback: async () => null,
}));

mock.module("../providers/credentials", () => ({
  getCredential: async () => ({ type: "apikey", token: "test-key" }),
  getApiKey: async () => "test-key",
}));

mockDbConnection();

// We can't import the SvelteKit handler directly, so we replicate the
// extractAgentConfig logic and test the endpoint behavior via the test server pattern.
// Instead, we test the core logic by simulating what the endpoint does.

function extractAgentConfig(text: string): Record<string, unknown> | null {
  const match = text.match(/<agent_config>([\s\S]*?)<\/agent_config>/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[1]!);
    if (typeof raw.name !== "string" || !raw.name.trim()) return null;
    if (typeof raw.prompt !== "string" || !raw.prompt.trim()) return null;
    return raw;
  } catch {
    return null;
  }
}

// Simulate the endpoint handler logic using pi-ai complete()
async function simulateGenerateEndpoint(body: unknown): Promise<{ status: number; data: unknown }> {
  const { messages } = body as { messages?: { role: string; content: string }[] };

  if (!messages || messages.length === 0) {
    return { status: 400, data: { error: "messages required" } };
  }

  try {
    const { complete } = await import("@earendil-works/pi-ai");
    const { resolveModel } = await import("../providers/router");
    const { getCredential } = await import("../providers/credentials");

    const resolved = await resolveModel();
    const cred = await getCredential(resolved.provider);

    const response = await complete(resolved.piModel, {
      systemPrompt: "meta-agent-system-prompt",
      messages: messages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
        timestamp: Date.now(),
      })) as Message[],
    }, { apiKey: cred.token });

    // Extract text from AssistantMessage content
    const text = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("");

    const config = extractAgentConfig(text);
    return { status: 200, data: { text, config } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "LLM call failed";
    return { status: 500, data: { error: message } };
  }
}

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("POST /api/agent-configs/generate", () => {
  test("returns { text, config: null } for normal conversation turn", async () => {
    mockCompleteText = "What kind of agent would you like to create?";
    mockCompleteError = null;

    const result = await simulateGenerateEndpoint({
      messages: [{ role: "user", content: "create a finance agent" }],
    });

    expect(result.status).toBe(200);
    const data = result.data as { text: string; config: null };
    expect(data.text).toBe("What kind of agent would you like to create?");
    expect(data.config).toBeNull();
  });

  test("returns { text, config: {...} } when LLM outputs valid <agent_config> block", async () => {
    const agentJson = JSON.stringify({
      name: "finance-guru",
      description: "A financial advisor agent",
      prompt: "You are an expert financial advisor.",
      provider: "anthropic",
      model: null,
      temperature: null,
      maxTokens: null,
      category: "finance",
    });
    mockCompleteText = `Here's the agent config:\n<agent_config>${agentJson}</agent_config>`;
    mockCompleteError = null;

    const result = await simulateGenerateEndpoint({
      messages: [
        { role: "user", content: "create a finance agent" },
        { role: "assistant", content: "What should it do?" },
        { role: "user", content: "help with budgeting, yes generate it" },
      ],
    });

    expect(result.status).toBe(200);
    const data = result.data as { text: string; config: Record<string, unknown> };
    expect(data.config).not.toBeNull();
    expect(data.config!.name).toBe("finance-guru");
    expect(data.config!.prompt).toBe("You are an expert financial advisor.");
    expect(data.config!.category).toBe("finance");
  });

  test("returns 400 when messages is empty", async () => {
    const result = await simulateGenerateEndpoint({ messages: [] });
    expect(result.status).toBe(400);
    expect((result.data as { error: string }).error).toBe("messages required");
  });

  test("returns 400 when messages is missing", async () => {
    const result = await simulateGenerateEndpoint({});
    expect(result.status).toBe(400);
  });

  test("returns 500 when LLM fails", async () => {
    mockCompleteError = new Error("API rate limit exceeded");
    mockCompleteText = "";

    const result = await simulateGenerateEndpoint({
      messages: [{ role: "user", content: "create an agent" }],
    });

    expect(result.status).toBe(500);
    expect((result.data as { error: string }).error).toBe("API rate limit exceeded");

    mockCompleteError = null;
  });

  test("extracted config has required fields: name and prompt", async () => {
    const agentJson = JSON.stringify({
      name: "minimal-agent",
      description: "Minimal",
      prompt: "You are minimal.",
    });
    mockCompleteText = `<agent_config>${agentJson}</agent_config>`;
    mockCompleteError = null;

    const result = await simulateGenerateEndpoint({
      messages: [{ role: "user", content: "generate" }],
    });

    const data = result.data as { text: string; config: Record<string, unknown> };
    expect(data.config).not.toBeNull();
    expect(typeof data.config!.name).toBe("string");
    expect(typeof data.config!.prompt).toBe("string");
  });

  test("returns { text, config: null } when <agent_config> contains invalid JSON", async () => {
    mockCompleteText = `<agent_config>{ not valid json }</agent_config>`;
    mockCompleteError = null;

    const result = await simulateGenerateEndpoint({
      messages: [{ role: "user", content: "generate" }],
    });

    expect(result.status).toBe(200);
    const data = result.data as { text: string; config: null };
    expect(data.config).toBeNull();
  });

  test("returns config: null when name is missing from agent_config", async () => {
    const agentJson = JSON.stringify({
      description: "No name",
      prompt: "You are nameless.",
    });
    mockCompleteText = `<agent_config>${agentJson}</agent_config>`;
    mockCompleteError = null;

    const result = await simulateGenerateEndpoint({
      messages: [{ role: "user", content: "generate" }],
    });

    const data = result.data as { text: string; config: null };
    expect(data.config).toBeNull();
  });

  test("returns config: null when prompt is missing from agent_config", async () => {
    const agentJson = JSON.stringify({
      name: "no-prompt-agent",
      description: "No prompt",
    });
    mockCompleteText = `<agent_config>${agentJson}</agent_config>`;
    mockCompleteError = null;

    const result = await simulateGenerateEndpoint({
      messages: [{ role: "user", content: "generate" }],
    });

    const data = result.data as { text: string; config: null };
    expect(data.config).toBeNull();
  });
});
