import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

const API_URL = "/api/tool-invoke";

function makeBody(overrides: Record<string, unknown> = {}) {
  return {
    extensionName: "test-ext",
    toolName: "do-thing",
    input: { foo: "bar" },
    conversationId: "conv-1",
    invocationId: "inv-1",
    ...overrides,
  };
}

function successResponse(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    output: "result text",
    retryCount: 0,
    durationMs: 42,
    toolCallId: "inv-1",
    ...overrides,
  };
}

function errorResponse(overrides: Record<string, unknown> = {}) {
  return {
    success: false,
    error: "something broke",
    retryCount: 2,
    durationMs: 150,
    toolCallId: "inv-1",
    ...overrides,
  };
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("inline tool invocation API contract", () => {
  test("POST returns result for valid tool call", async () => {
    const expected = successResponse();
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(expected), { status: 200, headers: { "Content-Type": "application/json" } })
    );

    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeBody()),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.output).toBe("result text");
    expect(data.retryCount).toBe(0);
    expect(typeof data.durationMs).toBe("number");
    expect(data.toolCallId).toBe("inv-1");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("POST returns 404 for unknown extension", async () => {
    const body = makeBody({ extensionName: "nonexistent" });
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({ success: false, error: "Tool not found: nonexistent.do-thing" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      )
    );

    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toContain("Tool not found");
  });

  test("POST returns 400 for missing required fields", async () => {
    const requiredFields = ["extensionName", "toolName", "conversationId", "invocationId"];

    for (const field of requiredFields) {
      const body = makeBody({ [field]: undefined });
      // Remove the key entirely
      delete (body as Record<string, unknown>)[field];

      globalThis.fetch = mock(async () =>
        new Response(
          JSON.stringify({ success: false, error: "Missing required fields: extensionName, toolName, conversationId, invocationId" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        )
      );

      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toContain("Missing required fields");
    }
  });

  test("POST returns 400 for invalid JSON body", async () => {
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({ success: false, error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    );

    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json{{{",
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Invalid JSON body");
  });

  test("auto-retry: success response with retryCount > 0 indicates retries occurred", async () => {
    const expected = successResponse({ retryCount: 2, durationMs: 300 });
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(expected), { status: 200, headers: { "Content-Type": "application/json" } })
    );

    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeBody()),
    });

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.retryCount).toBe(2);
    expect(data.durationMs).toBeGreaterThan(0);
  });

  test("auto-retry: failure after max retries returns error with retryCount", async () => {
    const expected = errorResponse({ retryCount: 2 });
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(expected), { status: 200, headers: { "Content-Type": "application/json" } })
    );

    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeBody()),
    });

    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.retryCount).toBe(2);
    expect(data.error).toBe("something broke");
    expect(data.toolCallId).toBe("inv-1");
  });

  test("tool events include source=inline discriminator in response metadata", async () => {
    const expected = successResponse({ source: "inline" });
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(expected), { status: 200, headers: { "Content-Type": "application/json" } })
    );

    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeBody()),
    });

    const data = await res.json();
    expect(data.source).toBe("inline");
  });
});

describe("GET /api/extensions/:name/tools contract", () => {
  test("returns tool definitions for a known extension", async () => {
    const toolDefs = [
      { name: "do-thing", description: "Does the thing", inputSchema: { type: "object", properties: { foo: { type: "string" } } } },
      { name: "other-tool", description: "Other", inputSchema: { type: "object", properties: {} } },
    ];

    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ tools: toolDefs }), { status: 200, headers: { "Content-Type": "application/json" } })
    );

    const res = await fetch("/api/extensions/test-ext/tools");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tools).toHaveLength(2);
    expect(data.tools[0].name).toBe("do-thing");
    expect(data.tools[0].inputSchema).toBeDefined();
  });

  test("returns 404 for unknown extension", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ error: "Extension not found" }), { status: 404, headers: { "Content-Type": "application/json" } })
    );

    const res = await fetch("/api/extensions/nope/tools");
    expect(res.status).toBe(404);
  });
});
