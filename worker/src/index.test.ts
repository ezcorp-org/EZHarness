import { afterAll, beforeEach, expect, mock, test } from "bun:test";

import { restoreModuleMocks } from "../../src/__tests__/helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

interface LlmCall {
  messages: Array<{ role: string; content: string }>;
  options: Record<string, unknown> | undefined;
}

const llmCalls: LlmCall[] = [];

// The route constructs the production AgentExecutor.  Only its provider
// boundary is replaced so this HTTP test never needs credentials or network.
mock.module("../../src/runtime/executor-helpers", () => ({
  createPiLlmAdapter: () => ({
    complete: async (messages: LlmCall["messages"], options: LlmCall["options"]) => {
      llmCalls.push({ messages, options });
      return { text: "Brief fixture summary", usage: { inputTokens: 3, outputTokens: 2 } };
    },
  }),
  persistErrorMessage: async () => undefined,
  resolveFailoverAttempt: async () => {
    throw new Error("Failover is outside the worker agent-run route");
  },
}));

const worker = (await import("./index")).default;

async function request(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`https://worker.test${path}`, init));
}

beforeEach(() => {
  llmCalls.length = 0;
});

test("run routes return stored executor records and reject a missing run", async () => {
  const created = await request("/api/agents/summarizer/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(created.status).toBe(200);
  const run = await created.json() as { id: string; status: string; result: { success: boolean; error: string } };
  expect(run.status).toBe("success");
  expect(run.result).toEqual({ success: false, output: null, error: "Missing input.text" });

  const listed = await request("/api/runs");
  expect(listed.status).toBe(200);
  const runs = await listed.json() as Array<{ id: string; result: unknown }>;
  expect(runs).toEqual(expect.arrayContaining([expect.objectContaining({ id: run.id, result: run.result })]));

  const found = await request(`/api/runs/${run.id}`);
  expect(found.status).toBe(200);
  expect(await found.json()).toEqual(expect.objectContaining({ id: run.id, result: run.result }));

  const missing = await request("/api/runs/no-such-run");
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: "Not found" });
});

test("summarizer runs through the LLM adapter with the submitted binding", async () => {
  const response = await request("/api/agents/summarizer/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Long fixture text", provider: "openai", model: "fixture-model" }),
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(expect.objectContaining({
    status: "success",
    result: { success: true, output: { summary: "Brief fixture summary" } },
  }));
  expect(llmCalls).toEqual([{
    messages: [{ role: "user", content: "Long fixture text" }],
    options: {
      system: "Summarize the following text concisely.",
      provider: "openai",
      model: "fixture-model",
    },
  }]);
});

test("unknown agents produce a client error without invoking the LLM boundary", async () => {
  const response = await request("/api/agents/unknown/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "must not reach a provider" }),
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "Agent not found: unknown" });
  expect(llmCalls).toEqual([]);
});

test("lists agents and handles preflight, malformed JSON, and unknown paths", async () => {
  const preflight = await request("/api/agents", { method: "OPTIONS" });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
  const agents = await request("/api/agents");
  expect(agents.status).toBe(200);
  expect(await agents.json()).toEqual([expect.objectContaining({ name: "summarizer", capabilities: ["llm"] })]);
  const invalid = await request("/api/agents/summarizer/run", { method: "POST", body: "not-json" });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toEqual({ error: expect.any(String) });
  const unknown = await request("/unknown");
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toEqual({ error: "Not found" });
  expect(llmCalls).toEqual([]);
});
