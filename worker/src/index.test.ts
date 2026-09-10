import { afterAll, beforeEach, expect, mock, test } from "bun:test";

import worker from "./index";

interface ProviderRequest {
  headers: Headers;
  payload: Record<string, unknown>;
  url: string;
}

const providerRequests: ProviderRequest[] = [];
const originalFetch = globalThis.fetch;
const env = { OPENAI_API_KEY: "worker-test-key", OPENAI_BASE_URL: "https://llm.test/v1" };

async function request(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`https://worker.test${path}`, init), env);
}

beforeEach(() => {
  providerRequests.length = 0;
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const requestUrl = typeof url === "string" ? url : url.toString();
    providerRequests.push({
      url: requestUrl,
      headers: new Headers(init?.headers),
      payload: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({
      choices: [{ message: { content: "Brief fixture summary" } }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
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
  expect(await listed.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: run.id, result: run.result })]));
  const found = await request(`/api/runs/${run.id}`);
  expect(await found.json()).toEqual(expect.objectContaining({ id: run.id, result: run.result }));
  const missing = await request("/api/runs/no-such-run");
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: "Not found" });
  expect(providerRequests).toEqual([]);
});

test("summarizer executes against the configured OpenAI boundary", async () => {
  const response = await request("/api/agents/summarizer/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Long fixture text", provider: "openai", model: "fixture-model" }),
  });

  expect(await response.json()).toEqual(expect.objectContaining({
    status: "success",
    provider: "openai",
    model: "fixture-model",
    inputTokens: 3,
    outputTokens: 2,
    result: { success: true, output: { summary: "Brief fixture summary" } },
  }));
  expect(providerRequests).toEqual([{
    url: "https://llm.test/v1/chat/completions",
    headers: expect.any(Headers),
    payload: {
      model: "fixture-model",
      messages: [
        { role: "system", content: "Summarize the following text concisely." },
        { role: "user", content: "Long fixture text" },
      ],
    },
  }]);
  expect(providerRequests[0]?.headers.get("authorization")).toBe("Bearer worker-test-key");
});

test("unknown agents and provider failures produce concrete error runs", async () => {
  const unknown = await request("/api/agents/unknown/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "must not reach a provider" }),
  });
  expect(unknown.status).toBe(400);
  expect(await unknown.json()).toEqual({ error: "Agent not found: unknown" });

  globalThis.fetch = mock(async () => new Response("denied", { status: 401 })) as typeof fetch;
  const rejected = await request("/api/agents/summarizer/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "will fail", provider: "openai", model: "fixture-model" }),
  });
  expect(await rejected.json()).toEqual(expect.objectContaining({
    status: "error",
    result: { success: false, output: null, error: "openai completion failed (401): denied" },
  }));
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
  expect(providerRequests).toEqual([]);
});
