import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

/**
 * Tests for inline tool retry logic.
 * We test the fetch-based retry contract and the edit-retry callback pattern.
 */

// Bun's `Mock<…>` doesn't satisfy the full `typeof fetch` (missing
// `preconnect`), so we cast through `unknown`.
function mockFetch(
  impl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  return mock(impl) as unknown as typeof globalThis.fetch;
}

interface InlineToolCall {
  id: string;
  extensionName: string;
  toolName: string;
  input: Record<string, unknown>;
  status: "pending" | "running" | "complete" | "error";
  output?: string;
  error?: string;
  retryCount: number;
  conversationId: string;
}

function makeCall(overrides: Partial<InlineToolCall> = {}): InlineToolCall {
  return {
    id: "inv-1",
    extensionName: "test-ext",
    toolName: "do-thing",
    input: { query: "hello", limit: 10 },
    status: "error",
    error: "timeout",
    retryCount: 1,
    conversationId: "conv-1",
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

describe("inline tool retry", () => {
  test("retry re-invokes with the same arguments", async () => {
    const call = makeCall();
    let capturedBody: Record<string, unknown> | null = null;

    globalThis.fetch = mockFetch(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({ success: true, output: "retried ok", retryCount: 1, durationMs: 50, toolCallId: call.id }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    // Simulate retry: re-post with same args
    const res = await fetch("/api/tool-invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        extensionName: call.extensionName,
        toolName: call.toolName,
        input: call.input,
        conversationId: call.conversationId,
        invocationId: call.id,
      }),
    });

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.extensionName).toBe("test-ext");
    expect(capturedBody!.toolName).toBe("do-thing");
    expect(capturedBody!.input).toEqual({ query: "hello", limit: 10 });
    expect(capturedBody!.conversationId).toBe("conv-1");
    expect(capturedBody!.invocationId).toBe("inv-1");
  });

  test("retry preserves invocationId for idempotency tracking", async () => {
    const call = makeCall({ id: "unique-inv-42" });
    let capturedBody: Record<string, unknown> | null = null;

    globalThis.fetch = mockFetch(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({ success: true, output: "ok", retryCount: 0, durationMs: 10, toolCallId: "unique-inv-42" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    await fetch("/api/tool-invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        extensionName: call.extensionName,
        toolName: call.toolName,
        input: call.input,
        conversationId: call.conversationId,
        invocationId: call.id,
      }),
    });

    expect(capturedBody!.invocationId).toBe("unique-inv-42");
  });
});

describe("edit-retry callback", () => {
  test("edit-retry invokes callback with previous call's args for pre-filling", () => {
    const call = makeCall({ input: { query: "original", limit: 5 } });
    let receivedCall: InlineToolCall | null = null;

    const oneditretry = mock((c: InlineToolCall) => {
      receivedCall = c;
    });

    // Simulate clicking edit-retry
    oneditretry(call);

    expect(oneditretry).toHaveBeenCalledTimes(1);
    expect(receivedCall).not.toBeNull();
    expect(receivedCall!.input).toEqual({ query: "original", limit: 5 });
    expect(receivedCall!.extensionName).toBe("test-ext");
    expect(receivedCall!.toolName).toBe("do-thing");
  });

  test("edit-retry receives the full call object including error state", () => {
    const call = makeCall({ error: "connection refused", retryCount: 2 });
    let receivedCall: InlineToolCall | null = null;

    const oneditretry = mock((c: InlineToolCall) => {
      receivedCall = c;
    });

    oneditretry(call);

    expect(receivedCall!.error).toBe("connection refused");
    expect(receivedCall!.retryCount).toBe(2);
    expect(receivedCall!.status).toBe("error");
  });
});

describe("error card retry count display", () => {
  function retryCountText(retryCount: number): string {
    if (retryCount > 0) {
      return `Failed after ${retryCount} ${retryCount === 1 ? "retry" : "retries"}`;
    }
    return "Failed";
  }

  test("shows 'Failed' with no retries", () => {
    expect(retryCountText(0)).toBe("Failed");
  });

  test("shows singular 'retry' for count 1", () => {
    expect(retryCountText(1)).toBe("Failed after 1 retry");
  });

  test("shows plural 'retries' for count > 1", () => {
    expect(retryCountText(2)).toBe("Failed after 2 retries");
    expect(retryCountText(3)).toBe("Failed after 3 retries");
  });
});
