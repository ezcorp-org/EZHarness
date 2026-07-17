/**
 * Integration test: the REAL pi-ai openai-completions client talking to a
 * live server that serves our mock-LLM handler. Proves the wire contract
 * end-to-end — scripted text AND tool calls round-trip through pi-ai's HTTP
 * client + SSE parser into a parsed AssistantMessage. This is the riskiest
 * part of the deterministic-LLM design, so it gets a real network round-trip.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { stream } from "@earendil-works/pi-ai/compat";
import { resolveModelObject } from "../providers/registry";
// The mock-LLM module is pure (no web aliases) — safe to import from src.
import {
  setMockScript,
  dequeueMockTurn,
  mockScriptKeyFromModel,
  buildMockTurnResponse,
} from "../../web/src/lib/server/mock-llm";

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
        const body = (await req.json()) as { model?: unknown };
        const turn = dequeueMockTurn(mockScriptKeyFromModel(body.model));
        // Connection faults are simulated as a SOCKET DROP here, not via
        // buildMockFaultResponse's erroring body stream: inside a bun test
        // process, bun (>= 1.3.14, CI's pin) reports a server-side response
        // body stream error as an uncaught test-level error even when the
        // client reads and handles the abort (PR #8 runs 29589476463 +
        // 29601137701, shard 3 — pooled AND isolated; a Bun.serve `error`
        // hook does not intercept it). Timing out the request without ever
        // resolving the handler closes the TCP socket with no HTTP status —
        // the SAME client-visible transport failure, arguably more faithful
        // to a real dropped connection. The node-hosted determinism route
        // (web/src/routes/api/__test/mock-llm/.../+server.ts) keeps using
        // the erroring-stream Response, which is fine in its environment.
        if (turn.fault?.kind === "connection") {
          server.timeout(req, 1);
          return new Promise<Response>(() => {});
        }
        return buildMockTurnResponse(turn);
      }
      return new Response("not found", { status: 404 });
    },
  });
  // resolveModelObject normalises to a trailing /v1; the openai SDK then
  // appends /chat/completions.
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

function userContext(text: string) {
  return { systemPrompt: "test", messages: [{ role: "user" as const, content: text, timestamp: 1 }] };
}

describe("pi-ai ⇄ mock-LLM wire contract", () => {
  test("scripted text turn parses into an assistant text message", async () => {
    setMockScript("itest-text", [{ text: "hi from the mock" }]);
    const model = resolveModelObject("ezcorp-mock", "mock:itest-text", baseUrl);
    const msg = await stream(model, userContext("hello"), { apiKey: "no-key-needed" }).result();

    expect(msg.role).toBe("assistant");
    expect(msg.stopReason).toBe("stop");
    const text = msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
    expect(text).toBe("hi from the mock");
  });

  test("scripted tool call parses into a toolCall block with stopReason toolUse", async () => {
    setMockScript("itest-tool", [
      { toolCalls: [{ name: "read_file", arguments: { path: "/etc/hosts" } }] },
    ]);
    const model = resolveModelObject("ezcorp-mock", "mock:itest-tool", baseUrl);
    const msg = await stream(model, userContext("read it"), { apiKey: "no-key-needed" }).result();

    expect(msg.stopReason).toBe("toolUse");
    const toolCalls = msg.content.filter((b) => b.type === "toolCall") as Array<{
      name: string;
      arguments: Record<string, unknown>;
    }>;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.name).toBe("read_file");
    expect(toolCalls[0]!.arguments).toEqual({ path: "/etc/hosts" });
  });

  test("multi-turn script dequeues sequentially across calls", async () => {
    setMockScript("itest-seq", [{ text: "first" }, { text: "second" }]);
    const model = resolveModelObject("ezcorp-mock", "mock:itest-seq", baseUrl);
    const a = await stream(model, userContext("x"), { apiKey: "no-key-needed" }).result();
    const b = await stream(model, userContext("y"), { apiKey: "no-key-needed" }).result();
    const textOf = (m: typeof a) => m.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
    expect(textOf(a)).toBe("first");
    expect(textOf(b)).toBe("second");
  });

  test("synthetic usage surfaces cacheRead/cacheWrite on the parsed message", async () => {
    setMockScript("itest-cache", [
      { text: "cached", usage: { input: 200, cacheRead: 100, cacheWrite: 50, output: 7 } },
    ]);
    const model = resolveModelObject("ezcorp-mock", "mock:itest-cache", baseUrl);
    const msg = await stream(model, userContext("hi"), { apiKey: "no-key-needed" }).result();
    // This is what flows into ctx.totalUsage + the run:usage bus event.
    expect(msg.usage).toMatchObject({ input: 200, cacheRead: 100, cacheWrite: 50, output: 7 });
    expect(msg.usage!.totalTokens).toBe(357);
  });

  test("a plain turn reports a cache-miss (cacheRead/cacheWrite 0)", async () => {
    setMockScript("itest-miss", [{ text: "fresh" }]);
    const model = resolveModelObject("ezcorp-mock", "mock:itest-miss", baseUrl);
    const msg = await stream(model, userContext("hi"), { apiKey: "no-key-needed" }).result();
    expect(msg.usage!.cacheRead).toBe(0);
    expect(msg.usage!.cacheWrite).toBe(0);
  });

  test.each([
    ["429 rate-limit", { status: 429 }, "429"],
    ["503 server error", { status: 503 }, "503"],
  ])("fault %s fails the turn pre-first-token", async (_label, fault, marker) => {
    const key = `itest-fault-${marker}`;
    setMockScript(key, [{ fault: fault as { status: number } }]);
    const model = resolveModelObject("ezcorp-mock", "mock:" + key, baseUrl);
    const msg = await stream(model, userContext("hi"), { apiKey: "no-key-needed" }).result();
    expect(msg.stopReason).toBe("error");
    expect(msg.errorMessage).toContain(marker);
    // No assistant text made it through (failed before the first token).
    expect(msg.content.filter((b) => b.type === "text")).toHaveLength(0);
  });

  test("connection fault fails the turn with no HTTP status", async () => {
    setMockScript("itest-conn", [{ fault: { kind: "connection" } }]);
    const model = resolveModelObject("ezcorp-mock", "mock:itest-conn", baseUrl);
    const msg = await stream(model, userContext("hi"), { apiKey: "no-key-needed" }).result();
    expect(msg.stopReason).toBe("error");
    expect(msg.content.filter((b) => b.type === "text")).toHaveLength(0);
  });

  test("a [fault, success] script fails then recovers on the retry (failover)", async () => {
    setMockScript("itest-retry", [{ fault: { status: 429 } }, { text: "recovered" }]);
    const model = resolveModelObject("ezcorp-mock", "mock:itest-retry", baseUrl);
    const first = await stream(model, userContext("hi"), { apiKey: "no-key-needed" }).result();
    expect(first.stopReason).toBe("error");
    // The retry pulls the next scripted turn and succeeds deterministically.
    const second = await stream(model, userContext("hi"), { apiKey: "no-key-needed" }).result();
    expect(second.stopReason).toBe("stop");
    const text = second.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
    expect(text).toBe("recovered");
  });
});
