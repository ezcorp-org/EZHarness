/**
 * Tests for @ezcorp/harness-client: pure SSE decoding, the event-name
 * parity guard against the app's canonical list, and the HTTP/SSE client
 * driven against a live fake server.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HarnessClient, HarnessApiError, SseDataBuffer, RUNTIME_EVENT_NAMES, HARNESS_ROUTES, buildPath } from "./index";
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
let lastUrl: string | null = null;
let lastConversationBody: Record<string, unknown> | null = null;
let scripted: { scriptKey: string; turns: unknown[] } | null = null;
let lastWireBody: Record<string, unknown> | null = null;
let lastRewindBody: Record<string, unknown> | null = null;
let lastToolInvoke: Record<string, unknown> | null = null;
// Extension-lifecycle + hub-action capture (Track 3 surface).
let lastInstallBody: Record<string, unknown> | null = null;
let lastActivateBody: Record<string, unknown> | null = null;
let lastPatchBody: Record<string, unknown> | null = null;
let lastPermissionsBody: Record<string, unknown> | null = null;
let lastSecretBody: Record<string, unknown> | null = null;
let lastHubActionBody: Record<string, unknown> | null = null;
// Toggles the shape GET /api/extensions returns so both the bare-array and
// `{ extensions }` normalization branches are exercised.
let extListShape: "array" | "wrapper" | "other" = "array";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      lastAuth = req.headers.get("authorization");
      lastUrl = req.url;
      const p = url.pathname;
      if (req.method === "POST" && p === "/api/conversations") {
        lastConversationBody = (await req.json()) as Record<string, unknown>;
        return Response.json({ id: "c1" });
      }
      // Capture-only route: echoes the raw path so encoding can be asserted.
      if (req.method === "GET" && p.startsWith("/api/runs/")) {
        if (url.searchParams.get("wait") === "1" && p !== "/api/runs/r1") {
          return Response.json({ outcome: "complete", run: { id: "x", status: "success" } });
        }
        if (p !== "/api/runs/r1") return Response.json({ id: "captured", status: "running" });
      }
      // Redirect route: a 3xx the client must refuse to follow.
      if (req.method === "GET" && p === "/api/settings/redirect") {
        return new Response(null, { status: 302, headers: { Location: "http://evil.example/steal" } });
      }
      if (req.method === "POST" && p === "/api/conversations/c1/messages") {
        return Response.json({ userMessage: { id: "m1" }, runId: "r1" });
      }
      // ── Sessions P4 rewind/checkpoint surface ──
      if (req.method === "GET" && /^\/api\/conversations\/[^/]+\/tree$/.test(p)) {
        if (p === "/api/conversations/off/tree") {
          return Response.json({ error: "Session history producer is disabled", code: "session_producer_disabled" }, { status: 409 });
        }
        return Response.json({
          conversationId: p.split("/")[3],
          currentLeaf: "a1",
          nodes: [{ id: "a1", parentId: null, role: "assistant", excluded: false, createdAt: "t" }],
        });
      }
      if (req.method === "POST" && /^\/api\/conversations\/[^/]+\/rewind$/.test(p)) {
        lastRewindBody = (await req.json()) as Record<string, unknown>;
        return Response.json({ conversationId: p.split("/")[3], currentLeaf: lastRewindBody.targetMessageId, nodes: [] });
      }
      // ── Extension control surface ──
      if (req.method === "GET" && p === "/api/extensions") {
        if (extListShape === "array") return Response.json([{ id: "e1", name: "scratchpad" }]);
        if (extListShape === "wrapper") return Response.json({ extensions: [{ id: "e2", name: "task-tracking" }] });
        return Response.json({ note: "neither array nor wrapper" });
      }
      if (p.startsWith("/api/conversations/") && p.endsWith("/extensions")) {
        if (req.method === "POST") {
          lastWireBody = (await req.json()) as Record<string, unknown>;
          if (p === "/api/conversations/forbidden/extensions") {
            return Response.json({ error: "Insufficient scope", required: "extensions" }, { status: 403 });
          }
          const names = (lastWireBody.names as string[]) ?? [];
          const unknown = names.filter((n) => n === "ghost");
          if (unknown.length > 0) {
            return Response.json({ error: "Unknown extension(s)", unknown }, { status: 404 });
          }
          return Response.json({ wired: names, extensionIds: names.map((n) => `id-${n}`) });
        }
        if (req.method === "GET") {
          return Response.json({ extensions: [{ id: "e1", name: "scratchpad" }] });
        }
      }
      if (req.method === "POST" && p === "/api/tool-invoke") {
        lastToolInvoke = (await req.json()) as Record<string, unknown>;
        if (lastToolInvoke.extensionName === "denied") {
          return Response.json({ error: "Insufficient scope", required: "extensions" }, { status: 403 });
        }
        // A tool-level failure is HTTP 200 with { success: false } — the client
        // must RESOLVE with it, not throw.
        if (lastToolInvoke.extensionName === "failing") {
          return Response.json({ success: false, error: "boom", toolCallId: lastToolInvoke.invocationId });
        }
        return Response.json({ success: true, output: `${lastToolInvoke.toolName}:ok`, toolCallId: lastToolInvoke.invocationId });
      }
      // ── Extension lifecycle surface (Track 3) ──
      if (req.method === "POST" && p === "/api/extensions") {
        lastInstallBody = (await req.json()) as Record<string, unknown>;
        return Response.json({ id: "ext-new", name: "installed-ext", enabled: false }, { status: 201 });
      }
      if (req.method === "POST" && /^\/api\/extensions\/[^/]+\/activate$/.test(p)) {
        lastActivateBody = (await req.json()) as Record<string, unknown>;
        return Response.json({ id: p.split("/")[3], name: "installed-ext", enabled: true });
      }
      if (req.method === "PUT" && /^\/api\/extensions\/[^/]+\/permissions$/.test(p)) {
        lastPermissionsBody = (await req.json()) as Record<string, unknown>;
        return Response.json({
          id: p.split("/")[3],
          name: "installed-ext",
          grantedPermissions: lastPermissionsBody.permissions,
        });
      }
      if (/^\/api\/extensions\/[^/]+\/secrets$/.test(p)) {
        const body = (await req.json()) as Record<string, unknown>;
        if (req.method === "POST") {
          lastSecretBody = body;
          // id "denied" models a per-extension RBAC refusal.
          if (p === "/api/extensions/denied/secrets") {
            return Response.json({ error: "Missing extension scope 'secrets' for denied" }, { status: 403 });
          }
          return Response.json({ ok: true });
        }
        if (req.method === "DELETE") {
          lastSecretBody = body;
          return Response.json({ deleted: body.name === "known" });
        }
      }
      if (/^\/api\/extensions\/[^/]+$/.test(p) && req.method !== "GET") {
        if (req.method === "PATCH") {
          lastPatchBody = (await req.json()) as Record<string, unknown>;
          if (lastPatchBody.enabled === true) {
            return Response.json({ error: "Use POST /:id/activate to enable an extension" }, { status: 400 });
          }
          return Response.json({ id: p.split("/")[3], name: "installed-ext", enabled: false });
        }
        if (req.method === "DELETE") {
          // Uninstall: 204 No Content, empty body.
          return new Response(null, { status: 204 });
        }
      }
      // ── Hub actions (Track 3) ──
      if (req.method === "POST" && /^\/api\/hub\/pages\/[^/]+\/actions\/[^/]+$/.test(p)) {
        lastHubActionBody = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const action = p.split("/")[6];
        if (action === "refresh") {
          return Response.json({ ok: true, page: { type: "root", children: [] }, renderedAt: 123 });
        }
        return Response.json({ ok: true });
      }
      // ── Cancel run (Track 3) ──
      if (req.method === "DELETE" && p.startsWith("/api/runs/")) {
        if (p === "/api/runs/r1") return Response.json({ ok: true });
        return Response.json({ error: "Run not found or not running" }, { status: 404 });
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
      // SSE redirect route: a 3xx the streamEvents path must refuse to follow.
      if (req.method === "GET" && p === "/api/runtime-events-redirect") {
        return new Response(null, { status: 302, headers: { Location: "http://evil.example/steal" } });
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

  test("createConversation defaults projectId to the global project", async () => {
    await client().createConversation();
    expect(lastConversationBody).toEqual({ projectId: "global" });
    await client().createConversation({ title: "t" });
    expect(lastConversationBody).toEqual({ projectId: "global", title: "t" });
  });

  test("createConversation lets an explicit projectId win over the default", async () => {
    await client().createConversation({ projectId: "p-42" });
    expect(lastConversationBody).toEqual({ projectId: "p-42" });
  });

  test("configure: get/set settings", async () => {
    expect(await client().getSetting<{ value: number }>("k")).toEqual({ value: 7 });
    expect(await client().setSetting("foo", 1)).toEqual({ ok: true });
  });

  test("getRun (non-wait) returns the run row", async () => {
    expect(await client().getRun("r1")).toMatchObject({ id: "r1", status: "running" });
  });

  test("getConversationTree returns the tree; a UUID-ish id is path-encoded", async () => {
    const tree = await client().getConversationTree("c1");
    expect(tree).toMatchObject({ conversationId: "c1", currentLeaf: "a1" });
    expect(tree.nodes).toHaveLength(1);
  });

  test("getConversationTree throws HarnessApiError 409 when the flag is off", async () => {
    try {
      await client().getConversationTree("off");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(HarnessApiError);
      expect((e as HarnessApiError).status).toBe(409);
      expect((e as HarnessApiError).body).toMatchObject({ code: "session_producer_disabled" });
    }
  });

  test("rewindConversation posts the target (+ optional summary) and returns the tree", async () => {
    const tree = await client().rewindConversation("c1", "m2", { summary: "went sideways" });
    expect(lastRewindBody).toEqual({ targetMessageId: "m2", summary: "went sideways" });
    expect(tree.currentLeaf).toBe("m2");
    // Omitting summary sends only targetMessageId (no undefined key).
    await client().rewindConversation("c1", "m3");
    expect(lastRewindBody).toEqual({ targetMessageId: "m3" });
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

  test("percent-encodes ids with special chars in the request path", async () => {
    await client().getRun("../../etc/passwd");
    const u = new URL(lastUrl!);
    // The traversal stays a single encoded segment, not a path climb.
    expect(u.pathname).toBe("/api/runs/..%2F..%2Fetc%2Fpasswd");

    await client().getRun("r1?x=1&y=2");
    const u2 = new URL(lastUrl!);
    expect(u2.pathname).toBe("/api/runs/r1%3Fx%3D1%26y%3D2");
    // No injected query params leaked from the id.
    expect(u2.searchParams.get("x")).toBeNull();
    expect(u2.searchParams.get("y")).toBeNull();

    await client().getRun("a b#c");
    const u3 = new URL(lastUrl!);
    expect(u3.pathname).toBe("/api/runs/a%20b%23c");
    expect(u3.hash).toBe("");
  });

  test("encodes the wait-path runId without disturbing the query", async () => {
    await client().awaitRun("../evil", 5_000);
    const u = new URL(lastUrl!);
    expect(u.pathname).toBe("/api/runs/..%2Fevil");
    expect(u.searchParams.get("wait")).toBe("1");
    expect(u.searchParams.get("timeoutMs")).toBe("5000");
  });

  test("encodes conversationId and toolCallId path segments", async () => {
    await client().sendMessage("c/../x", "hi").catch(() => {});
    expect(new URL(lastUrl!).pathname).toBe("/api/conversations/c%2F..%2Fx/messages");

    await client().resolveToolPermission("tc/../1", true).catch(() => {});
    expect(new URL(lastUrl!).pathname).toBe("/api/tool-calls/tc%2F..%2F1/permission");
  });

  test("refuses to follow a redirect (no bearer-token replay)", async () => {
    let threw = false;
    try {
      await client().getSetting("redirect");
    } catch (e) {
      threw = true;
      // fetch rejects with a TypeError under `redirect: "error"`; never silently follows.
      expect(e).not.toBeInstanceOf(HarnessApiError);
    }
    expect(threw).toBe(true);
  });

  test("streamEvents refuses to follow a redirect (no bearer-token replay)", async () => {
    // Point streamEvents' `/api/runtime-events` fetch at the 302 route via a
    // path-rewriting fetch wrapper. Under `redirect: "error"` the SSE fetch
    // must reject (TypeError) rather than transparently follow to the
    // attacker host and replay the bearer token.
    const redirectingFetch: typeof fetch = (input, init) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return fetch(u.replace("/api/runtime-events", "/api/runtime-events-redirect"), init);
    };
    const c = new HarnessClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      apiKey: "ezk_test",
      fetch: redirectingFetch,
    });
    let threw = false;
    try {
      for await (const _ of c.streamEvents()) {
        // unreachable: the fetch itself must reject before yielding.
      }
    } catch (e) {
      threw = true;
      // fetch rejects with a TypeError under `redirect: "error"`; it never
      // surfaces as a HarnessApiError (which would imply the redirect was
      // followed and the response read).
      expect(e).not.toBeInstanceOf(HarnessApiError);
    }
    expect(threw).toBe(true);
  });

  test("streamEvents yields parsed runtime events", async () => {
    const events: string[] = [];
    for await (const evt of client().streamEvents({ conversationId: "c1" })) {
      events.push(evt.type);
    }
    expect(events).toEqual(["run:start", "run:complete"]);
  });
});

describe("HarnessClient — extension control", () => {
  test("listExtensions returns a bare array (includes scratchpad)", async () => {
    extListShape = "array";
    const exts = await client().listExtensions();
    expect(exts).toEqual([{ id: "e1", name: "scratchpad" }]);
    expect(exts.some((e) => e.name === "scratchpad")).toBe(true);
  });

  test("listExtensions normalizes a { extensions } wrapper", async () => {
    extListShape = "wrapper";
    const exts = await client().listExtensions();
    expect(exts).toEqual([{ id: "e2", name: "task-tracking" }]);
  });

  test("listExtensions throws on an unexpected shape (does not silently return [])", async () => {
    extListShape = "other";
    await expect(client().listExtensions()).rejects.toThrow(/unexpected \/api\/extensions response shape/);
  });

  test("wireExtensions posts { names } and returns wired + extensionIds", async () => {
    const res = await client().wireExtensions("c1", ["scratchpad"]);
    expect(res).toEqual({ wired: ["scratchpad"], extensionIds: ["id-scratchpad"] });
    expect(lastWireBody).toEqual({ names: ["scratchpad"] });
    expect(new URL(lastUrl!).pathname).toBe("/api/conversations/c1/extensions");
    expect(lastAuth).toBe("Bearer ezk_test");
  });

  test("wireExtensions percent-encodes the conversationId path segment", async () => {
    await client().wireExtensions("c/../x", ["scratchpad"]);
    expect(new URL(lastUrl!).pathname).toBe("/api/conversations/c%2F..%2Fx/extensions");
  });

  test("wireExtensions throws HarnessApiError 404 on an unknown name", async () => {
    try {
      await client().wireExtensions("c1", ["ghost"]);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(HarnessApiError);
      expect((e as HarnessApiError).status).toBe(404);
      expect((e as HarnessApiError).body).toMatchObject({ error: "Unknown extension(s)", unknown: ["ghost"] });
    }
  });

  test("wireExtensions maps a 403 to HarnessApiError", async () => {
    try {
      await client().wireExtensions("forbidden", ["scratchpad"]);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(HarnessApiError);
      expect((e as HarnessApiError).status).toBe(403);
    }
  });

  test("listWiredExtensions returns the wired set (encoded path)", async () => {
    const wired = await client().listWiredExtensions("c/../x");
    expect(wired).toEqual([{ id: "e1", name: "scratchpad" }]);
    expect(new URL(lastUrl!).pathname).toBe("/api/conversations/c%2F..%2Fx/extensions");
  });

  test("invokeExtensionTool auto-generates an invocationId and returns the result", async () => {
    const res = await client().invokeExtensionTool("c1", "scratchpad", "scratchpad_write", { key: "k", value: "v" });
    expect(res).toMatchObject({ success: true, output: "scratchpad_write:ok" });
    expect(lastToolInvoke).toMatchObject({
      conversationId: "c1",
      extensionName: "scratchpad",
      toolName: "scratchpad_write",
      input: { key: "k", value: "v" },
    });
    // Auto-generated: a uuid-shaped invocationId is present; messageId is absent.
    expect(typeof lastToolInvoke!.invocationId).toBe("string");
    expect((lastToolInvoke!.invocationId as string).length).toBeGreaterThanOrEqual(32);
    expect("messageId" in lastToolInvoke!).toBe(false);
  });

  test("invokeExtensionTool honours an explicit invocationId + messageId, defaults input to {}", async () => {
    const res = await client().invokeExtensionTool("c1", "scratchpad", "scratchpad_read", undefined, {
      invocationId: "inv-fixed",
      messageId: "m-9",
    });
    expect(res.success).toBe(true);
    expect(lastToolInvoke).toEqual({
      conversationId: "c1",
      extensionName: "scratchpad",
      toolName: "scratchpad_read",
      input: {},
      invocationId: "inv-fixed",
      messageId: "m-9",
    });
  });

  test("invokeExtensionTool RESOLVES with a tool-level failure (HTTP 200 { success:false })", async () => {
    const res = await client().invokeExtensionTool("c1", "failing", "whatever");
    expect(res).toMatchObject({ success: false, error: "boom" });
  });

  test("invokeExtensionTool maps a 403 to HarnessApiError", async () => {
    try {
      await client().invokeExtensionTool("c1", "denied", "whatever");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(HarnessApiError);
      expect((e as HarnessApiError).status).toBe(403);
    }
  });
});

describe("route table (HARNESS_ROUTES + buildPath)", () => {
  test("every table entry has an uppercase HTTP method and an /api path template", () => {
    const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
    for (const [name, route] of Object.entries(HARNESS_ROUTES)) {
      expect(methods.has(route.httpMethod), `${name} httpMethod`).toBe(true);
      expect(route.pathTemplate.startsWith("/api/"), `${name} pathTemplate`).toBe(true);
    }
  });

  test("getRun and awaitRun intentionally share GET /api/runs/:id", () => {
    expect(HARNESS_ROUTES.getRun).toEqual({ httpMethod: "GET", pathTemplate: "/api/runs/:id" });
    expect(HARNESS_ROUTES.awaitRun).toEqual({ httpMethod: "GET", pathTemplate: "/api/runs/:id" });
  });

  test("buildPath percent-encodes each param as a single segment", () => {
    expect(buildPath("/api/settings/:key", { key: "theme:dark" })).toBe("/api/settings/theme%3Adark");
    expect(buildPath("/api/extensions/:id/activate", { id: "../x" })).toBe("/api/extensions/..%2Fx/activate");
    expect(buildPath("/api/hub/pages/:id/actions/:action", { id: "p 1", action: "do" })).toBe(
      "/api/hub/pages/p%201/actions/do",
    );
  });

  test("buildPath leaves a template with no params untouched", () => {
    expect(buildPath("/api/extensions")).toBe("/api/extensions");
  });

  test("buildPath throws loudly on a missing route param", () => {
    expect(() => buildPath("/api/extensions/:id/activate", {})).toThrow(
      /missing route param ':id'/,
    );
  });
});

describe("HarnessClient — extension lifecycle", () => {
  test("installExtension posts the source body and returns the new row (201)", async () => {
    const res = await client().installExtension({ source: "local", path: "/srv/ext" });
    expect(res).toEqual({ id: "ext-new", name: "installed-ext", enabled: false });
    expect(lastInstallBody).toEqual({ source: "local", path: "/srv/ext" });
    expect(new URL(lastUrl!).pathname).toBe("/api/extensions");
    expect(lastAuth).toBe("Bearer ezk_test");
  });

  test("installExtension supports the git source shape", async () => {
    await client().installExtension({ source: "git", url: "https://h/r.git", ref: "main" });
    expect(lastInstallBody).toEqual({ source: "git", url: "https://h/r.git", ref: "main" });
  });

  test("activateExtension without perms posts an empty body and enables", async () => {
    const res = await client().activateExtension("e1");
    expect(res).toMatchObject({ id: "e1", enabled: true });
    expect(lastActivateBody).toEqual({});
    expect(new URL(lastUrl!).pathname).toBe("/api/extensions/e1/activate");
  });

  test("activateExtension forwards grantedPermissions when supplied", async () => {
    await client().activateExtension("e1", { network: true });
    expect(lastActivateBody).toEqual({ grantedPermissions: { network: true } });
  });

  test("setExtensionEnabled(false) disables and returns the updated row", async () => {
    const res = await client().setExtensionEnabled("e1", false);
    expect(res).toMatchObject({ id: "e1", enabled: false });
    expect(lastPatchBody).toEqual({ enabled: false });
    expect(new URL(lastUrl!).pathname).toBe("/api/extensions/e1");
  });

  test("setExtensionEnabled(true) is rejected by the server (enable via /activate)", async () => {
    await expect(client().setExtensionEnabled("e1", true)).rejects.toMatchObject({ status: 400 });
  });

  test("uninstallExtension resolves with no body on 204", async () => {
    const res = await client().uninstallExtension("e1");
    expect(res).toBeUndefined();
    expect(new URL(lastUrl!).pathname).toBe("/api/extensions/e1");
  });

  test("updateExtensionPermissions PUTs the permissions and returns the row", async () => {
    const res = await client().updateExtensionPermissions("e1", { network: true, shell: false });
    expect(lastPermissionsBody).toEqual({ permissions: { network: true, shell: false } });
    expect(res).toMatchObject({ id: "e1", grantedPermissions: { network: true, shell: false } });
    expect(new URL(lastUrl!).pathname).toBe("/api/extensions/e1/permissions");
  });

  test("lifecycle methods percent-encode the extension id path segment", async () => {
    await client().activateExtension("e/../x");
    expect(new URL(lastUrl!).pathname).toBe("/api/extensions/e%2F..%2Fx/activate");
  });
});

describe("HarnessClient — extension secrets", () => {
  test("setExtensionSecret posts name+value (no projectId) and never echoes the value", async () => {
    const res = await client().setExtensionSecret("e1", "TOKEN", "s3cr3t");
    expect(res).toEqual({ ok: true });
    expect(lastSecretBody).toEqual({ name: "TOKEN", value: "s3cr3t" });
    expect(new URL(lastUrl!).pathname).toBe("/api/extensions/e1/secrets");
  });

  test("setExtensionSecret forwards an explicit projectId (including null)", async () => {
    await client().setExtensionSecret("e1", "TOKEN", "v", { projectId: "p-1" });
    expect(lastSecretBody).toEqual({ name: "TOKEN", value: "v", projectId: "p-1" });
    await client().setExtensionSecret("e1", "TOKEN", "v", { projectId: null });
    expect(lastSecretBody).toEqual({ name: "TOKEN", value: "v", projectId: null });
  });

  test("setExtensionSecret maps a per-extension RBAC 403 to HarnessApiError", async () => {
    await expect(client().setExtensionSecret("denied", "TOKEN", "v")).rejects.toMatchObject({ status: 403 });
  });

  test("deleteExtensionSecret returns { deleted } and forwards projectId when given", async () => {
    const hit = await client().deleteExtensionSecret("e1", "known");
    expect(hit).toEqual({ deleted: true });
    expect(lastSecretBody).toEqual({ name: "known" });
    const miss = await client().deleteExtensionSecret("e1", "absent", { projectId: "p-2" });
    expect(miss).toEqual({ deleted: false });
    expect(lastSecretBody).toEqual({ name: "absent", projectId: "p-2" });
  });
});

describe("HarnessClient — hub actions + cancel run", () => {
  test("triggerHubAction posts an empty body when no payload and returns { ok }", async () => {
    const res = await client().triggerHubAction("core:daily-briefing", "noop");
    expect(res).toEqual({ ok: true });
    expect(lastHubActionBody).toEqual({});
    expect(new URL(lastUrl!).pathname).toBe("/api/hub/pages/core%3Adaily-briefing/actions/noop");
  });

  test("triggerHubAction forwards a scalar payload and surfaces a rendered page", async () => {
    const res = await client().triggerHubAction("core:x", "refresh", { since: 5, mode: "full" });
    expect(lastHubActionBody).toEqual({ payload: { since: 5, mode: "full" } });
    expect(res).toMatchObject({ ok: true, page: { type: "root" }, renderedAt: 123 });
  });

  test("cancelRun deletes the run and returns { ok:true }", async () => {
    const res = await client().cancelRun("r1");
    expect(res).toEqual({ ok: true });
    expect(new URL(lastUrl!).pathname).toBe("/api/runs/r1");
  });

  test("cancelRun maps a not-running 404 to HarnessApiError", async () => {
    await expect(client().cancelRun("gone")).rejects.toMatchObject({ status: 404 });
  });
});
