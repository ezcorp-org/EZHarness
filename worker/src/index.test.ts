import { afterAll, beforeEach, expect, mock, test } from "bun:test";

import worker from "./index";

interface ProviderRequest {
  headers: Headers;
  payload: Record<string, unknown>;
  url: string;
}

const providerRequests: ProviderRequest[] = [];
const originalFetch = globalThis.fetch;
const defaultEnv = { OPENAI_API_KEY: "openai-test-key", OPENAI_BASE_URL: "https://openai.test/v1" };

async function request(path: string, init?: RequestInit, env = defaultEnv): Promise<Response> {
  return worker.fetch(new Request(`https://worker.test${path}`, init), env);
}

function sse(events: Array<{ event?: string; data: unknown; raw?: boolean }>): Response {
  return new Response(events.map(({ event, data, raw }) => `${event ? `event: ${event}\n` : ""}data: ${raw ? String(data) : JSON.stringify(data)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function completion(provider: string): Response {
  if (provider === "anthropic") {
    return sse([
      { event: "message_start", data: { type: "message_start", message: { id: "fixture", type: "message", role: "assistant", model: "fixture", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } } },
      { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "anthropic summary" } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } } },
      { event: "message_stop", data: { type: "message_stop" } },
    ]);
  }
  if (provider === "google") {
    return sse([{
      data: {
        candidates: [{ content: { role: "model", parts: [{ text: "google summary" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
      },
    }]);
  }
  return sse([
    { event: "response.output_item.added", data: { type: "response.output_item.added", output_index: 0, item: { id: "fixture", type: "message", role: "assistant", content: [] } } },
    { event: "response.output_text.delta", data: { type: "response.output_text.delta", output_index: 0, delta: "openai summary" } },
    { event: "response.completed", data: { type: "response.completed", response: { id: "fixture", status: "completed", usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } } },
  ]);
}

function providerFor(url: string): "anthropic" | "google" | "openai" {
  if (url.includes("anthropic")) return "anthropic";
  if (url.includes("google")) return "google";
  return "openai";
}

beforeEach(() => {
  providerRequests.length = 0;
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const requestUrl = typeof url === "string" ? url : url.toString();
    providerRequests.push({
      url: requestUrl,
      headers: new Headers(init?.headers),
      payload: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return completion(providerFor(requestUrl));
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

test("run routes return stored executor records and reject a missing run", async () => {
  const created = await request("/api/agents/summarizer/run", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
  });
  const run = await created.json() as { id: string; status: string; result: { success: boolean; error: string } };
  expect(created.status).toBe(200);
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

test.each([
  ["openai", "fixture-openai", { OPENAI_API_KEY: "openai-test-key", OPENAI_BASE_URL: "https://openai.test/v1" }],
  ["anthropic", "fixture-anthropic", { ANTHROPIC_API_KEY: "anthropic-test-key", ANTHROPIC_BASE_URL: "https://anthropic.test" }],
  ["google", "fixture-google", { GOOGLE_API_KEY: "google-test-key", GOOGLE_BASE_URL: "https://google.test" }],
] as const)("summarizer completes %s through pi-ai", async (provider, model, env) => {
  const response = await request("/api/agents/summarizer/run", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Long fixture text", provider, model }),
  }, env);

  expect(response.status).toBe(200);
  const run = await response.json();
  expect(run).toEqual(expect.objectContaining({
    status: "success", provider, model, inputTokens: 3, outputTokens: 2,
    result: { success: true, output: { summary: `${provider} summary` } },
  }));
  expect(providerRequests).toHaveLength(1);
  expect(providerRequests[0]?.url).toContain(`${provider}.test`);
  expect(JSON.stringify(providerRequests[0]?.payload)).toContain("Long fixture text");
});

test("default provider and model bindings are used when the request omits them", async () => {
  const response = await request("/api/agents/summarizer/run", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Use defaults" }),
  }, { GOOGLE_API_KEY: "google-test-key", GOOGLE_BASE_URL: "https://google.test", DEFAULT_PROVIDER: "google", DEFAULT_MODEL: "default-google" });

  expect(await response.json()).toEqual(expect.objectContaining({ status: "success", provider: "google", model: "default-google" }));
  expect(providerRequests).toHaveLength(1);
});

function malformedCompletion(provider: string): Response {
  if (provider === "anthropic") {
    return sse([
      { event: "message_start", data: { type: "message_start", message: { id: "fixture", type: "message", role: "assistant", model: "fixture", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } } },
      { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } } },
      { event: "message_stop", data: { type: "message_stop" } },
    ]);
  }
  if (provider === "google") {
    return sse([{ data: { candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } } }]);
  }
  return sse([{ event: "response.completed", data: { type: "response.completed", response: { id: "fixture", status: "completed", usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } } }]);
}

test.each([
  ["openai", "fixture-openai", { OPENAI_API_KEY: "openai-test-key", OPENAI_BASE_URL: "https://openai.test/v1" }],
  ["anthropic", "fixture-anthropic", { ANTHROPIC_API_KEY: "anthropic-test-key", ANTHROPIC_BASE_URL: "https://anthropic.test" }],
  ["google", "fixture-google", { GOOGLE_API_KEY: "google-test-key", GOOGLE_BASE_URL: "https://google.test" }],
] as const)("%s provider, malformed reply, and missing binding become error runs", async (provider, model, env) => {
  globalThis.fetch = mock(async () => new Response("denied", { status: 401 })) as typeof fetch;
  const rejected = await request("/api/agents/summarizer/run", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "will fail", provider, model }),
  }, env);
  const rejectedRun = await rejected.json() as { status: string; result: { error: string } };
  expect(rejectedRun.status).toBe("error");
  expect(rejectedRun.result.error).toContain("401");

  globalThis.fetch = mock(async () => malformedCompletion(provider)) as typeof fetch;
  const malformed = await request("/api/agents/summarizer/run", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "empty", provider, model }),
  }, env);
  const malformedRun = await malformed.json() as { status: string; result: { error: string } };
  expect(malformedRun.status).toBe("error");
  expect(malformedRun.result.error).toContain("completion");

  const missing = await request("/api/agents/summarizer/run", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "no config", provider, model }),
  }, {});
  expect(await missing.json()).toEqual(expect.objectContaining({
    status: "error", result: expect.objectContaining({ error: `Missing ${provider} API key binding` }),
  }));
});

test("retains only the newest 100 completed runs", async () => {
  const created: string[] = [];
  for (let index = 0; index < 101; index += 1) {
    const response = await request("/api/agents/summarizer/run", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
    created.push((await response.json() as { id: string }).id);
  }
  const listed = await request("/api/runs");
  const runs = await listed.json() as Array<{ id: string }>;
  expect(runs.length).toBeLessThanOrEqual(100);
  expect(runs.map((run) => run.id)).not.toContain(created[0]);
  expect(runs.map((run) => run.id)).toContain(created.at(-1));
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
});
