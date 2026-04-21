/**
 * Integration test: the EZCorp executor injects `_meta.ezOnBehalfOf` into
 * a tools/call request; the ai-kit MCP server's wrapper picks it out,
 * runs the handler in an AsyncLocalStorage scope; EzcorpClient's outbound
 * HTTP calls carry the `X-Ezcorp-On-Behalf-Of` header with that user id.
 *
 * This is the bit of the chain that lives entirely inside the ai-kit
 * package — the server-side header handling is covered by bearer-auth
 * tests; the executor-side injection is covered by
 * tool-executor-on-behalf-of.test.ts.
 *
 * We use the MCP InMemoryTransport so the test does not depend on any
 * subprocess behavior — we send a tools/call directly with `_meta`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EzcorpClient } from "../../src/client";
import { createMcpServer } from "../../src/mcp/server";
import { startStubServer, type StubServer } from "../fixtures/stub-server";

describe("ai-kit OBO propagation: _meta.ezOnBehalfOf → X-Ezcorp-On-Behalf-Of", () => {
  let stub: StubServer;
  let mcp: Client;
  let capturedHeaders: Array<Record<string, string | null>>;

  beforeEach(async () => {
    stub = startStubServer();
    capturedHeaders = [];
    // Wrap the stub's fetch so we can observe the headers ai-kit sends.
    // Cast through `unknown` because Bun's `typeof fetch` includes a
    // `preconnect` property that our passthrough doesn't implement — we
    // don't exercise `preconnect` from within EzcorpClient, so the shape
    // difference is harmless here.
    const origFetch = fetch;
    const spyFetch = ((input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const captured: Record<string, string | null> = {};
      headers.forEach((v, k) => (captured[k.toLowerCase()] = v));
      capturedHeaders.push(captured);
      return origFetch(input, init);
    }) as unknown as typeof fetch;
    const ez = new EzcorpClient({ baseUrl: stub.url, fetch: spyFetch });
    const server = createMcpServer(ez);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    mcp = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await mcp.connect(b);
  });

  afterEach(async () => {
    await mcp.close();
    stub.stop();
  });

  test("tools/call with _meta.ezOnBehalfOf → outbound HTTP carries the header", async () => {
    await mcp.callTool({
      name: "list_projects",
      arguments: {},
      _meta: { ezOnBehalfOf: "geff" },
    });
    expect(capturedHeaders).toHaveLength(1);
    expect(capturedHeaders[0]!["x-ezcorp-on-behalf-of"]).toBe("geff");
  });

  test("tools/call WITHOUT _meta → no header is sent (baseline)", async () => {
    await mcp.callTool({ name: "list_projects", arguments: {} });
    expect(capturedHeaders[0]!["x-ezcorp-on-behalf-of"]).toBeUndefined();
  });

  test("nested tools/call uses each call's own OBO (ALS is per-run, not per-client)", async () => {
    // First call with geff
    await mcp.callTool({
      name: "list_projects",
      arguments: {},
      _meta: { ezOnBehalfOf: "geff" },
    });
    // Second call with admin-123
    await mcp.callTool({
      name: "list_projects",
      arguments: {},
      _meta: { ezOnBehalfOf: "admin-123" },
    });
    // Third call with no meta — should NOT leak the last OBO
    await mcp.callTool({ name: "list_projects", arguments: {} });

    expect(capturedHeaders[0]!["x-ezcorp-on-behalf-of"]).toBe("geff");
    expect(capturedHeaders[1]!["x-ezcorp-on-behalf-of"]).toBe("admin-123");
    expect(capturedHeaders[2]!["x-ezcorp-on-behalf-of"]).toBeUndefined();
  });

  test("non-string _meta.ezOnBehalfOf is ignored (defense against malformed meta)", async () => {
    await mcp.callTool({
      name: "list_projects",
      arguments: {},
      _meta: { ezOnBehalfOf: 12345 as unknown as string }, // deliberately wrong type
    });
    expect(capturedHeaders[0]!["x-ezcorp-on-behalf-of"]).toBeUndefined();
  });

  test("empty-string _meta.ezOnBehalfOf is ignored", async () => {
    await mcp.callTool({
      name: "list_projects",
      arguments: {},
      _meta: { ezOnBehalfOf: "" },
    });
    expect(capturedHeaders[0]!["x-ezcorp-on-behalf-of"]).toBeUndefined();
  });

  test("OBO propagates through a fan-out tool (spawn_chats) to EACH outbound call", async () => {
    await mcp.callTool({
      name: "spawn_chats",
      arguments: {
        chats: [
          { projectId: "global", initialMessage: "A" },
          { projectId: "global", initialMessage: "B" },
        ],
      },
      _meta: { ezOnBehalfOf: "geff" },
    });
    // spawn_chats issues: 2 createConversation + 2 sendMessage = 4 HTTP calls.
    expect(capturedHeaders.length).toBeGreaterThanOrEqual(4);
    for (const h of capturedHeaders) {
      expect(h["x-ezcorp-on-behalf-of"]).toBe("geff");
    }
  });
});

/** Companion tests for the `_meta.ezModel` / `_meta.ezProvider` context
 *  fields. These must flow from the MCP request → ALS → outbound HTTP
 *  body (NOT a header — the model is a per-request parameter the server
 *  already accepts in createConversation / sendMessage). */
describe("ai-kit model propagation: _meta.ezModel → outbound body", () => {
  let stub: StubServer;
  let mcp: Client;
  let capturedBodies: Array<{ url: string; body: unknown }>;

  beforeEach(async () => {
    stub = startStubServer();
    capturedBodies = [];
    const origFetch = fetch;
    const spyFetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      let body: unknown = undefined;
      if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      capturedBodies.push({ url, body });
      return origFetch(input, init);
    }) as unknown as typeof fetch;
    const ez = new EzcorpClient({ baseUrl: stub.url, fetch: spyFetch });
    const server = createMcpServer(ez);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    mcp = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await mcp.connect(b);
  });

  afterEach(async () => {
    await mcp.close();
    stub.stop();
  });

  test("start_chat with _meta.ezModel sends that model in the create body", async () => {
    await mcp.callTool({
      name: "start_chat",
      arguments: { projectId: "global" },
      _meta: { ezModel: "claude-sonnet-4-6", ezProvider: "anthropic" },
    });
    const createCall = capturedBodies.find((c) => c.url.endsWith("/api/conversations"));
    expect(createCall).toBeDefined();
    const body = createCall!.body as { model?: string; provider?: string };
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.provider).toBe("anthropic");
  });

  test("LLM-supplied `model` arg WINS over inherited _meta.ezModel", async () => {
    await mcp.callTool({
      name: "start_chat",
      // LLM explicitly overrides:
      arguments: { projectId: "global", model: "claude-opus-4-1", provider: "anthropic" },
      _meta: { ezModel: "claude-sonnet-4-6", ezProvider: "anthropic" },
    });
    const createCall = capturedBodies.find((c) => c.url.endsWith("/api/conversations"));
    const body = createCall!.body as { model?: string };
    expect(body.model).toBe("claude-opus-4-1");
  });

  test("send_message inherits _meta.ezModel when arg omits it", async () => {
    // First create a conversation to get an id.
    const convRes = await mcp.callTool({
      name: "start_chat",
      arguments: { projectId: "global" },
      _meta: { ezModel: "claude-sonnet-4-6" },
    });
    const convId = JSON.parse(
      (convRes.content as Array<{ text: string }>)[0]!.text,
    ).id as string;
    capturedBodies.length = 0;

    await mcp.callTool({
      name: "send_message",
      arguments: { conversationId: convId, content: "hi" },
      _meta: { ezModel: "claude-sonnet-4-6" },
    });
    const msgCall = capturedBodies.find((c) => c.url.includes("/messages"));
    const body = msgCall!.body as { model?: string };
    expect(body.model).toBe("claude-sonnet-4-6");
  });

  test("spawn_chats batch inherits _meta.ezModel for EVERY sub-conversation", async () => {
    await mcp.callTool({
      name: "spawn_chats",
      arguments: {
        chats: [
          { projectId: "global", initialMessage: "A" },
          { projectId: "global", initialMessage: "B" },
        ],
      },
      _meta: { ezModel: "claude-haiku-4-5", ezProvider: "anthropic" },
    });
    const creates = capturedBodies.filter(
      (c) => c.url.endsWith("/api/conversations") && (c.body as { projectId?: string })?.projectId,
    );
    expect(creates).toHaveLength(2);
    for (const c of creates) {
      const body = c.body as { model?: string; provider?: string };
      expect(body.model).toBe("claude-haiku-4-5");
      expect(body.provider).toBe("anthropic");
    }
  });

  test("tools/call WITHOUT model meta → no model field in body (server picks its own default)", async () => {
    await mcp.callTool({
      name: "start_chat",
      arguments: { projectId: "global" },
    });
    const createCall = capturedBodies.find((c) => c.url.endsWith("/api/conversations"));
    const body = createCall!.body as { model?: string; provider?: string };
    expect(body.model).toBeUndefined();
    expect(body.provider).toBeUndefined();
  });

  test("model context does not leak between calls (ALS is per-call scope)", async () => {
    // Call 1: sonnet
    await mcp.callTool({
      name: "start_chat",
      arguments: { projectId: "global" },
      _meta: { ezModel: "claude-sonnet-4-6" },
    });
    // Call 2: no meta — must NOT see sonnet leak through
    capturedBodies.length = 0;
    await mcp.callTool({
      name: "start_chat",
      arguments: { projectId: "global" },
    });
    const createCall = capturedBodies.find((c) => c.url.endsWith("/api/conversations"));
    const body = createCall!.body as { model?: string };
    expect(body.model).toBeUndefined();
  });

  test("OBO + model inherited together, both propagate", async () => {
    // Header for OBO, body for model. Both must ride through in one call.
    const caps: Array<{ headers: Headers; body: unknown }> = [];
    const origFetch = fetch;
    const spy = ((input: string | URL | Request, init?: RequestInit) => {
      caps.push({
        headers: new Headers(init?.headers),
        body: init?.body ? JSON.parse(init.body as string) : null,
      });
      return origFetch(input, init);
    }) as unknown as typeof fetch;
    const ez = new EzcorpClient({ baseUrl: stub.url, fetch: spy });
    const server = createMcpServer(ez);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const mc = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await mc.connect(b);

    await mc.callTool({
      name: "start_chat",
      arguments: { projectId: "global" },
      _meta: {
        ezOnBehalfOf: "geff",
        ezModel: "claude-sonnet-4-6",
        ezProvider: "anthropic",
      },
    });
    await mc.close();
    const create = caps.find((c) => (c.body as { projectId?: string })?.projectId);
    expect(create!.headers.get("x-ezcorp-on-behalf-of")).toBe("geff");
    expect((create!.body as { model?: string }).model).toBe("claude-sonnet-4-6");
  });
});
