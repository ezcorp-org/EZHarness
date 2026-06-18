/**
 * Tests for @ezcorp/harness-client: pure SSE decoding, the event-name
 * parity guard against the app's canonical list, and the HTTP/SSE client
 * driven against a live fake server.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HarnessClient, HarnessApiError, SseDataBuffer, RUNTIME_EVENT_NAMES } from "./index";
// The app's canonical list — must stay identical to the package's copy.
import { RUNTIME_EVENT_NAMES as APP_EVENT_NAMES } from "../../../../web/src/lib/runtime-event-names";

describe("SseDataBuffer", () => {
  test("splits records and skips comments/heartbeats", () => {
    const b = new SseDataBuffer();
    expect(b.push(": connected\n\n")).toEqual([]);
    expect(b.push('data: {"type":"run:start"}\n\n')).toEqual(['{"type":"run:start"}']);
    expect(b.push(": heartbeat\n\n")).toEqual([]);
  });

  test("buffers across chunk boundaries", () => {
    const b = new SseDataBuffer();
    expect(b.push("data: hel")).toEqual([]);
    expect(b.push("lo\n")).toEqual([]);
    expect(b.push("\n")).toEqual(["hello"]);
  });

  test("joins multi-line data fields", () => {
    const b = new SseDataBuffer();
    expect(b.push("data: a\ndata: b\n\n")).toEqual(["a\nb"]);
  });
});

describe("event-name parity with the app", () => {
  test("package list === app list (no drift)", () => {
    expect([...RUNTIME_EVENT_NAMES]).toEqual([...APP_EVENT_NAMES]);
  });
});

// ── Live fake server ───────────────────────────────────────────────────
let server: ReturnType<typeof Bun.serve>;
let lastAuth: string | null = null;
let scripted: { scriptKey: string; turns: unknown[] } | null = null;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      lastAuth = req.headers.get("authorization");
      const p = url.pathname;
      if (req.method === "POST" && p === "/api/conversations") return Response.json({ id: "c1" });
      if (req.method === "POST" && p === "/api/conversations/c1/messages") {
        return Response.json({ userMessage: { id: "m1" }, runId: "r1" });
      }
      if (req.method === "GET" && p === "/api/runs/r1" && url.searchParams.get("wait") === "1") {
        return Response.json({ outcome: "complete", run: { id: "r1", status: "success", result: { output: "done" } } });
      }
      if (req.method === "POST" && p === "/api/__test/mock-llm/script") {
        scripted = (await req.json()) as typeof scripted;
        return Response.json({ ok: true }, { status: 201 });
      }
      if (req.method === "PUT" && p === "/api/settings/foo") return Response.json({ ok: true });
      if (req.method === "GET" && p === "/api/settings/k") return Response.json({ value: 7 });
      if (req.method === "GET" && p === "/api/settings/missing") {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      if (req.method === "GET" && p === "/api/runs/r1") {
        return Response.json({ id: "r1", status: "running" });
      }
      if (req.method === "POST" && p === "/api/tool-calls/tc1/permission") {
        return Response.json({ ok: true });
      }
      if (req.method === "DELETE" && p === "/api/__test/mock-llm/script") {
        scripted = null;
        return Response.json({ ok: true });
      }
      if (req.method === "GET" && p === "/api/runtime-events") {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            const enc = new TextEncoder();
            c.enqueue(enc.encode(": connected\n\n"));
            c.enqueue(enc.encode('data: {"type":"run:start","data":{"runId":"r1"}}\n\n'));
            c.enqueue(enc.encode('data: {"type":"run:complete","data":{"runId":"r1"}}\n\n'));
            c.close();
          },
        });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response("nope", { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));

function client(): HarnessClient {
  return new HarnessClient({ baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "ezk_test" });
}

describe("HarnessClient", () => {
  test("sends the bearer token", async () => {
    await client().createConversation();
    expect(lastAuth).toBe("Bearer ezk_test");
  });

  test("configure: get/set settings", async () => {
    expect(await client().getSetting<{ value: number }>("k")).toEqual({ value: 7 });
    expect(await client().setSetting("foo", 1)).toEqual({ ok: true });
  });

  test("getRun (non-wait) returns the run row", async () => {
    expect(await client().getRun("r1")).toMatchObject({ id: "r1", status: "running" });
  });

  test("resolveToolPermission posts approval with scope", async () => {
    expect(await client().resolveToolPermission("tc1", true, { scope: "session" })).toEqual({ ok: true });
  });

  test("clearLlmScripts clears the mock scripts", async () => {
    await client().scriptLlm("k", [{ text: "x" }]);
    expect(scripted).not.toBeNull();
    await client().clearLlmScripts();
    expect(scripted).toBeNull();
  });

  test("runToCompletion drives a message and returns the terminal result", async () => {
    const r = await client().runToCompletion("c1", "hello");
    expect(r.outcome).toBe("complete");
    expect(r.run.id).toBe("r1");
  });

  test("runScripted seeds the mock then drives with the mock provider", async () => {
    const r = await client().runScripted("c1", "go", [{ text: "scripted reply" }], { scriptKey: "k1" });
    expect(scripted).toMatchObject({ scriptKey: "k1", turns: [{ text: "scripted reply" }] });
    expect(r.outcome).toBe("complete");
  });

  test("non-2xx throws HarnessApiError with status + parsed body", async () => {
    try {
      await client().getSetting("missing");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(HarnessApiError);
      expect((e as HarnessApiError).status).toBe(404);
      expect((e as HarnessApiError).body).toMatchObject({ error: "not found" });
    }
  });

  test("streamEvents yields parsed runtime events", async () => {
    const events: string[] = [];
    for await (const evt of client().streamEvents({ conversationId: "c1" })) {
      events.push(evt.type);
    }
    expect(events).toEqual(["run:start", "run:complete"]);
  });
});
