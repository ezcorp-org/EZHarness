import { expect, test } from "bun:test";
import { normalizeUrl, requestOpenAICompatCompletion } from "../providers/openai-compat-client";

const request = {
  baseUrl: "http://127.0.0.1:11434/v1/",
  model: "qwen",
  systemPrompt: "Return JSON.",
  userPrompt: "Classify this.",
  temperature: 0.2,
  maxTokens: 64,
  timeoutMs: 1_000,
};

test("normalizes bare and already-v1 OpenAI-compatible endpoints", () => {
  expect(normalizeUrl(" http://host:11434/// ")).toBe("http://host:11434");
  expect(normalizeUrl("http://host:11434/v1/")).toBe("http://host:11434");
});

test("sends the schema-constrained completion body to the canonical endpoint", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const response = await requestOpenAICompatCompletion({
    ...request,
    schema: { name: "classification", schema: { type: "object", properties: { answer: { type: "string" } } } },
    fetchFn: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response("{}", { status: 200 });
    },
  });

  expect(response.ok).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
  expect(calls[0]!.init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
    model: "qwen",
    stream: false,
    temperature: 0.2,
    max_tokens: 64,
    messages: [
      { role: "system", content: "Return JSON." },
      { role: "user", content: "Classify this." },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "classification", strict: true, schema: { type: "object", properties: { answer: { type: "string" } } } },
    },
  });
});

test("retries one schema-rejected response without response_format", async () => {
  const bodies: unknown[] = [];
  const response = await requestOpenAICompatCompletion({
    ...request,
    schema: { name: "result", schema: { type: "object" } },
    fetchFn: async (_url, init) => {
      bodies.push(JSON.parse(String(init!.body)));
      return new Response("unsupported schema", { status: bodies.length === 1 ? 400 : 200 });
    },
  });

  expect(response.status).toBe(200);
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toHaveProperty("response_format");
  expect(bodies[1]).not.toHaveProperty("response_format");
});

test("returns a non-schema HTTP failure without a retry", async () => {
  let calls = 0;
  const response = await requestOpenAICompatCompletion({
    ...request,
    fetchFn: async () => {
      calls += 1;
      return new Response("down", { status: 503 });
    },
  });
  expect(response.status).toBe(503);
  expect(calls).toBe(1);
});
