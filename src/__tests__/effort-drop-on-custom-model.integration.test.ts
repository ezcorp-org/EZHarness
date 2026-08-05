/**
 * The PREMISE, pinned on the wire: a reasoning `effort` requested against a
 * local/custom model is dropped before the request is serialized.
 *
 * Every other test in this change asserts on what EZCorp says about that
 * drop. This one asserts the drop itself — against real pi-ai, through the
 * real `resolveModelObject` synthesis, over a real socket — because the
 * warning is only honest while the premise holds.
 *
 * ## Why this is worth a socket
 *
 * The mechanism lives entirely in the dependency:
 * `getSupportedThinkingLevels(model)` returns `["off"]` when
 * `!model.reasoning`, `clampThinkingLevel` therefore clamps any level to
 * `"off"`, and the api layer turns `"off"` into `undefined` — and,
 * independently, every `thinkingFormat` branch is `… && model.reasoning`. A
 * mocked pi-ai would assert our belief ABOUT that, not that. If a pi-ai
 * upgrade ever starts honouring effort on an unflagged model, the run-log
 * warning `createPiLlmAdapter` emits becomes a lie, and this is the test that
 * says so instead of it going quiet again.
 *
 * The arms are two calls that differ in ONE field (`model.reasoning`), so
 * nothing about the host, the port, or the payload can explain the
 * difference between them.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { resolveModelObject } from "../providers/registry";

const bodies: Array<Record<string, unknown>> = [];
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      bodies.push((await req.json()) as Record<string, unknown>);
      return Response.json({
        id: "x",
        object: "chat.completion",
        created: 0,
        model: "qwen3:1.7b",
        choices: [
          { index: 0, message: { role: "assistant", content: "4" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

const context = {
  messages: [{ role: "user" as const, content: "2+2?", timestamp: 0 }],
};

describe("a reasoning effort against a synthesized custom/local model", () => {
  test("resolveModelObject synthesizes it with reasoning:false", () => {
    // The exact call `router.ts` makes for a pinned custom/local model:
    // `resolveModelObject(provider, modelId, custom?.baseUrl)`.
    const model = resolveModelObject("ollama", "qwen3:1.7b", baseUrl);
    expect(model.reasoning).toBe(false);
    expect(model.api).toBe("openai-completions");
  });

  test("the effort never reaches the wire — the body carries no reasoning field", async () => {
    const model = resolveModelObject("ollama", "qwen3:1.7b", baseUrl);
    // The exact call `createPiLlmAdapter` makes when an override carries an
    // effort: the *Simple entrypoint, with `reasoning` set.
    await completeSimple(model as never, context, {
      apiKey: "k",
      reasoning: "high",
      maxTokens: 100,
    } as never);

    const body = bodies.at(-1)!;
    expect(body.model).toBe("qwen3:1.7b");
    // Not lowered, not defaulted — absent. Every spelling pi-ai has for it.
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("reasoning");
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("enable_thinking");
    expect(body).not.toHaveProperty("chat_template_kwargs");
  });

  test("the SAME call on a reasoning-flagged model does send it", async () => {
    // The control arm. One field differs from the model above, so the
    // absence up there is attributable to `reasoning: false` and to nothing
    // else about this test's setup.
    const model = { ...resolveModelObject("ollama", "qwen3:1.7b", baseUrl), reasoning: true };
    await completeSimple(model as never, context, {
      apiKey: "k",
      reasoning: "high",
      maxTokens: 100,
    } as never);

    expect(bodies.at(-1)!.reasoning_effort).toBe("high");
  });

  test("the declared output cap is honoured in BOTH arms", async () => {
    // Guards the reading of the two arms above: `max_tokens` (not
    // `max_completion_tokens`) proves the local-runtime `compat` override in
    // `resolveModelObject` was applied, i.e. these really are the synthesized
    // custom-model requests and not some other code path.
    expect(bodies.at(-1)!.max_tokens).toBe(100);
    expect(bodies.at(-2)!.max_tokens).toBe(100);
  });
});
