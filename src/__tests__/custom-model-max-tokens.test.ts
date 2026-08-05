/**
 * `maxTokens` must actually be enforced against a custom / local model.
 *
 * ── The bug ──
 * pi-ai's openai-completions driver picks the output-cap field from
 * `detectCompat(model)`, which sends `max_tokens` only for a short list of
 * known gateways (chutes / moonshot / cloudflare-ai-gateway / together /
 * nvidia / ant-ling) and `max_completion_tokens` for every other baseUrl —
 * including every `provider:customModels` endpoint. Ollama, llama.cpp, vLLM
 * and LM Studio ignore `max_completion_tokens` entirely and honour only
 * `max_tokens`, so a declared cap was silently unenforced against every
 * custom model.
 *
 * Measured on a live Ollama (qwen3:1.7b, identical request otherwise):
 *     max_tokens: 40            -> completion_tokens 40,   finish_reason "length"
 *     max_completion_tokens: 40 -> completion_tokens 3694, finish_reason "stop"
 *
 * ── The fix, and why it is LOCAL and not upstream ──
 * `Model.compat` is pi-ai's own documented override for precisely this
 * ("Compatibility overrides for OpenAI-compatible APIs. If not set,
 * auto-detected from baseUrl" — pi-ai types.d.ts). `detectCompat` cannot know
 * whether an arbitrary user-typed URL is a local runtime or an OpenAI
 * endpoint; the operator who typed it does. So `resolveModelObject` sets
 * `compat.maxTokensField = "max_tokens"` on the model it synthesizes for a
 * user-supplied baseUrl, and ONLY then.
 *
 * ── Why a capture server ──
 * Asserting `model.compat.maxTokensField === "max_tokens"` only proves we set
 * a field. What matters is the bytes on the wire, so these tests run pi-ai
 * for real against a local HTTP capture server and read the request body it
 * received. If pi-ai ever renames the knob or stops honouring it, the field
 * assertion would still pass and this would fail — which is the point.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { stream } from "@earendil-works/pi-ai/compat";
import type { Model, Api } from "@earendil-works/pi-ai";
import { resolveModelObject } from "../providers/registry";

// ── Capture server ──────────────────────────────────────────────────
type Captured = Record<string, unknown>;
let captured: Captured[] = [];
let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";

/** A minimal OpenAI-compatible SSE reply so pi-ai's stream reader terminates. */
function sseBody(): string {
  const chunk = {
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "capture",
    choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
  };
  const last = {
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "capture",
    choices: [{ index: 0, delta: {}, finish_reason: "length" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  return `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`;
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method === "POST") {
        captured.push((await req.json()) as Captured);
        return new Response(sseBody(), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

/** Drive one real pi-ai stream through the capture server and return the
 *  request body it saw. */
async function capture(model: Model<Api>, maxTokens: number): Promise<Captured> {
  captured = [];
  const events = stream(
    model,
    { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] } as never,
    // `maxTokens` rides on pi-ai's StreamOptions — the exact position
    // `createPiLlmAdapter` puts a workflow step's binding in
    // (`{ apiKey: cred.token, ...tuning }`, src/runtime/executor-helpers.ts).
    { apiKey: "no-key-needed", maxTokens },
  );
  // Drain — the request is only issued once the stream is consumed.
  for await (const _ of events) {
    // no-op; the assertion is on what the server received
  }
  expect(captured.length).toBe(1);
  return captured[0]!;
}

describe("custom model output cap: the synthesized model", () => {
  test("a user-supplied baseUrl gets the max_tokens compat override", () => {
    const model = resolveModelObject("ollama", "qwen3:1.7b", baseUrl);
    expect((model as { compat?: { maxTokensField?: string } }).compat?.maxTokensField).toBe(
      "max_tokens",
    );
  });

  test("NO baseUrl keeps pi-ai's detection (the api.openai.com fallback)", () => {
    // OpenAI's own newer models REJECT `max_tokens`, so forcing it on the
    // default fallback URL would break the very case pi-ai gets right.
    const model = resolveModelObject("some-unknown-provider", "mystery-model");
    expect(model.baseUrl).toBe("https://api.openai.com/v1");
    expect((model as { compat?: { maxTokensField?: string } }).compat).toBeUndefined();
  });

  test("a catalog model is untouched (no synthesized compat)", () => {
    const model = resolveModelObject("anthropic", "claude-sonnet-4-20250514");
    expect(model.provider).toBe("anthropic");
    expect((model as { compat?: { maxTokensField?: string } }).compat?.maxTokensField).not.toBe(
      "max_tokens",
    );
  });
});

describe("custom model output cap: what actually goes on the wire", () => {
  test("THE FIX: a local custom model sends max_tokens, not max_completion_tokens", async () => {
    const model = resolveModelObject("ollama", "qwen3:1.7b", baseUrl) as Model<Api>;
    const body = await capture(model, 8000);
    expect(body.max_tokens).toBe(8000);
    // The field Ollama/llama.cpp/vLLM silently ignore must NOT be the one
    // carrying the cap — that is the entire bug.
    expect(body.max_completion_tokens).toBeUndefined();
  });

  test("the cap reaches the wire verbatim at a small value too", async () => {
    const model = resolveModelObject("ollama", "qwen3:1.7b", baseUrl) as Model<Api>;
    const body = await capture(model, 40);
    expect(body.max_tokens).toBe(40);
  });

  test("REGRESSION GUARD: the same model WITHOUT the override sends the ignored field", async () => {
    // Strip `compat` to reproduce pre-fix behaviour against the same server.
    // If this ever stops sending `max_completion_tokens`, pi-ai's default
    // changed and the override above may no longer be needed — this test is
    // what will say so, instead of the fix silently becoming a no-op.
    const { compat: _dropped, ...withoutOverride } = resolveModelObject(
      "ollama",
      "qwen3:1.7b",
      baseUrl,
    ) as Model<Api> & { compat?: unknown };
    const body = await capture(withoutOverride as Model<Api>, 8000);
    expect(body.max_completion_tokens).toBe(8000);
    expect(body.max_tokens).toBeUndefined();
  });

  test("the request still targets the operator's own endpoint", async () => {
    const model = resolveModelObject("ollama", "qwen3:1.7b", baseUrl) as Model<Api>;
    expect(model.baseUrl).toBe(`${baseUrl}/v1`);
    const body = await capture(model, 100);
    expect(body.model).toBe("qwen3:1.7b");
  });
});
