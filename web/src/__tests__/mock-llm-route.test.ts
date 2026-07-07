/**
 * Unit tests for the mock-LLM route handlers: the completions endpoint
 * (gating + scripted SSE replay) and the /script seed endpoint (gating +
 * auth + validation + wiring into the store).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { POST as completions } from "../routes/api/__test/mock-llm/v1/chat/completions/+server";
import { POST as seedScript, DELETE as clearScript } from "../routes/api/__test/mock-llm/script/+server";
import { dequeueMockTurn, clearMockScripts } from "$lib/server/mock-llm";

const savedE2E = process.env.PI_E2E_REAL;
const savedNodeEnv = process.env.NODE_ENV;
const savedAllow = process.env.EZCORP_ALLOW_TEST_SURFACE;

beforeEach(() => {
  process.env.PI_E2E_REAL = "1";
  delete process.env.NODE_ENV;
  process.env.EZCORP_ALLOW_TEST_SURFACE = "1"; // fail-closed gate's operator opt-in
  clearMockScripts();
});
afterEach(() => {
  if (savedE2E === undefined) delete process.env.PI_E2E_REAL; else process.env.PI_E2E_REAL = savedE2E;
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
  if (savedAllow === undefined) delete process.env.EZCORP_ALLOW_TEST_SURFACE; else process.env.EZCORP_ALLOW_TEST_SURFACE = savedAllow;
  clearMockScripts();
});

function jsonReq(body: unknown): Request {
  return new Request("http://127.0.0.1/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Minimal cookie-auth locals: a user present, no apiKeyScopes (so
// requireScope is a no-op — matches a logged-in admin driving via cookie).
const cookieLocals = { user: { id: "u1", email: "a@b", name: "A", role: "admin" } } as any;

describe("completions endpoint", () => {
  test("404 when the test surface is off", async () => {
    delete process.env.PI_E2E_REAL;
    const res = await completions({ request: jsonReq({ model: "mock:k" }) } as any);
    expect(res.status).toBe(404);
  });

  test("replays a seeded scripted turn as OpenAI SSE", async () => {
    await seedScript({ request: jsonReq({ scriptKey: "k", turns: [{ text: "hello there" }] }), locals: cookieLocals } as any);
    const res = await completions({ request: jsonReq({ model: "mock:k" }) } as any);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain('"content":"hello there"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  test("unseeded key → sentinel stop turn (debuggable, not a hang)", async () => {
    const res = await completions({ request: jsonReq({ model: "mock:unseeded" }) } as any);
    const text = await res.text();
    expect(text).toContain("no scripted turn");
    expect(text).toContain('"finish_reason":"stop"');
  });

  test("invalid JSON → 400", async () => {
    const bad = new Request("http://127.0.0.1/x", { method: "POST", body: "{not json" });
    const res = await completions({ request: bad } as any);
    expect(res.status).toBe(400);
  });

  test("a seeded status fault turn → non-2xx OpenAI error body", async () => {
    await seedScript({ request: jsonReq({ scriptKey: "f", turns: [{ fault: { status: 429, message: "slow" } }] }), locals: cookieLocals } as any);
    const res = await completions({ request: jsonReq({ model: "mock:f" }) } as any);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("slow");
  });

  test("a seeded connection fault turn → aborted body (transport failure)", async () => {
    await seedScript({ request: jsonReq({ scriptKey: "c", turns: [{ fault: { kind: "connection" } }] }), locals: cookieLocals } as any);
    const res = await completions({ request: jsonReq({ model: "mock:c" }) } as any);
    expect(res.status).toBe(200);
    let threw = false;
    try { await res.text(); } catch { threw = true; }
    expect(threw).toBe(true);
  });

  test("a seeded usage turn streams cache details in the final chunk", async () => {
    await seedScript({ request: jsonReq({ scriptKey: "u", turns: [{ text: "hi", usage: { input: 5, cacheRead: 9 } }] }), locals: cookieLocals } as any);
    const res = await completions({ request: jsonReq({ model: "mock:u" }) } as any);
    const text = await res.text();
    expect(text).toContain('"cached_tokens":9');
  });
});

describe("/script seed endpoint", () => {
  test("404 when the test surface is off", async () => {
    delete process.env.PI_E2E_REAL;
    const res = await seedScript({ request: jsonReq({ scriptKey: "k", turns: [] }), locals: cookieLocals } as any);
    expect(res.status).toBe(404);
  });

  test("seeds turns that the completions endpoint then dequeues in order", async () => {
    const res = await seedScript({
      request: jsonReq({ scriptKey: "conv", turns: [{ text: "a" }, { toolCalls: [{ name: "f" }] }] }),
      locals: cookieLocals,
    } as any);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, scriptKey: "conv", turns: 2 });
    expect(dequeueMockTurn("conv").text).toBe("a");
    expect(dequeueMockTurn("conv").toolCalls?.[0]?.name).toBe("f");
  });

  test("rejects bad scriptKey / turns shape", async () => {
    expect((await seedScript({ request: jsonReq({ turns: [] }), locals: cookieLocals } as any)).status).toBe(400);
    expect((await seedScript({ request: jsonReq({ scriptKey: "k", turns: "nope" }), locals: cookieLocals } as any)).status).toBe(400);
    expect((await seedScript({ request: jsonReq({ scriptKey: "k", turns: [{ toolCalls: [{}] }] }), locals: cookieLocals } as any)).status).toBe(400);
    expect((await seedScript({ request: jsonReq({ scriptKey: "k", turns: [{ finishReason: "boom" }] }), locals: cookieLocals } as any)).status).toBe(400);
    expect((await seedScript({ request: jsonReq({ scriptKey: "k", turns: [{ text: 123 }] }), locals: cookieLocals } as any)).status).toBe(400);
    expect((await seedScript({ request: jsonReq({ scriptKey: "k", turns: ["nope"] }), locals: cookieLocals } as any)).status).toBe(400);
    expect((await seedScript({ request: jsonReq({ scriptKey: "k", turns: [{ toolCalls: "x" }] }), locals: cookieLocals } as any)).status).toBe(400);
  });

  test("accepts valid usage + fault turns", async () => {
    const res = await seedScript({
      request: jsonReq({ scriptKey: "ok", turns: [
        { text: "cached", usage: { input: 10, cacheRead: 5, cacheWrite: 2, output: 3 } },
        { fault: { status: 503 } },
        { fault: { kind: "connection" } },
      ] }),
      locals: cookieLocals,
    } as any);
    expect(res.status).toBe(201);
    expect(dequeueMockTurn("ok").usage?.cacheRead).toBe(5);
    expect(dequeueMockTurn("ok").fault?.status).toBe(503);
    expect(dequeueMockTurn("ok").fault?.kind).toBe("connection");
  });

  test("rejects bad usage shapes", async () => {
    const bad = (turns: unknown) => seedScript({ request: jsonReq({ scriptKey: "k", turns }), locals: cookieLocals } as any);
    expect((await bad([{ usage: "nope" }])).status).toBe(400);
    expect((await bad([{ usage: { input: -1 } }])).status).toBe(400);
    expect((await bad([{ usage: { cacheRead: "x" } }])).status).toBe(400);
    expect((await bad([{ usage: { output: Number.POSITIVE_INFINITY } }])).status).toBe(400);
  });

  test("rejects bad fault shapes", async () => {
    const bad = (turns: unknown) => seedScript({ request: jsonReq({ scriptKey: "k", turns }), locals: cookieLocals } as any);
    expect((await bad([{ fault: "nope" }])).status).toBe(400);
    expect((await bad([{ fault: {} }])).status).toBe(400); // neither status nor kind
    expect((await bad([{ fault: { kind: "boom" } }])).status).toBe(400);
    expect((await bad([{ fault: { status: 200 } }])).status).toBe(400); // out of [400,599]
    expect((await bad([{ fault: { status: 4.5 } }])).status).toBe(400); // non-integer
    expect((await bad([{ fault: { status: 429, message: 7 } }])).status).toBe(400);
  });

  test("invalid JSON body → 400", async () => {
    const bad = new Request("http://127.0.0.1/x", { method: "POST", body: "{not json" });
    expect((await seedScript({ request: bad, locals: cookieLocals } as any)).status).toBe(400);
  });

  test("DELETE clears all scripts", async () => {
    await seedScript({ request: jsonReq({ scriptKey: "k", turns: [{ text: "x" }] }), locals: cookieLocals } as any);
    const res = await clearScript({ locals: cookieLocals } as any);
    expect(res.status).toBe(200);
    // After clear, the key returns the sentinel.
    expect(dequeueMockTurn("k").text).toContain("no scripted turn");
  });
});
