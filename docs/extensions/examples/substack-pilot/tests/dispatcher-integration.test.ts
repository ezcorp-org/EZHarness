// ── createToolDispatcher routing (real channel wiring) ──────────
//
// Phase 7 of the defineEntity SDK port: post-type CRUD is no longer
// served by this subprocess (the host's tool-executor short-circuits
// to the SDK handler before any subprocess RPC). The tests that
// previously exercised `list_post_types` / `get_post_type` here are
// removed — their coverage now lives in the SDK's own integration
// tests at `packages/@ezcorp/sdk/src/entities/__tests__/tools.test.ts`
// and the host dispatcher test at
// `src/__tests__/entities-dispatcher.test.ts`.
//
// What remains here is the protocol-level routing contract that
// substack-pilot's REMAINING tools still depend on:
//
//   - `summarize_urls` (a tool we kept) returns a tool-level result
//     envelope through the real channel wiring
//   - Unknown tool names surface as JSON-RPC -32601 (protocol error),
//     NOT as `isError: true` tool results
//
// Both are critical for the subprocess-side of the contract. If they
// regress, every subprocess-served tool call breaks at install time.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tools } from "../index";
import {
  createToolDispatcher,
  createHostChannelForTests,
  _setDispatcherRegister,
  JsonRpcError,
  toolError,
} from "@ezcorp/sdk/runtime";
import {
  _setBackendsForTests,
  _resetBackendsForTests,
} from "../lib/summarize";

// ── Stdin / stdout pipe helpers (unchanged from pre-port) ──────

interface ControlledStdin {
  iterable: AsyncIterable<string>;
  push(line: string): void;
  close(): void;
}

function createStdin(): ControlledStdin {
  const queue: string[] = [];
  let pendingResolve: ((v: IteratorResult<string>) => void) | null = null;
  let closed = false;
  return {
    push(line: string) {
      if (pendingResolve) {
        const r = pendingResolve;
        pendingResolve = null;
        r({ value: line, done: false });
      } else {
        queue.push(line);
      }
    },
    close() {
      closed = true;
      if (pendingResolve) {
        const r = pendingResolve;
        pendingResolve = null;
        r({ value: "", done: true });
      }
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<string>> {
            const buffered = queue.shift();
            if (buffered !== undefined) {
              return Promise.resolve({ value: buffered, done: false });
            }
            if (closed) return Promise.resolve({ value: "", done: true });
            return new Promise<IteratorResult<string>>((res) => {
              pendingResolve = res;
            });
          },
        };
      },
    },
  };
}

function createStdout() {
  const writes: string[] = [];
  return {
    writes,
    stdout: {
      write(s: string) {
        writes.push(s);
      },
    },
  };
}

const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await tick(5);
  }
}

// ── Channel wiring helper ──────────────────────────────────────

function wireDispatcherTo(ch: ReturnType<typeof createHostChannelForTests>): void {
  _setDispatcherRegister(({ handlers, opts }) => {
    ch.onRequest("tools/call", async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const name = typeof p.name === "string" ? p.name : "";
      const args = (p.arguments ?? {}) as Record<string, unknown>;
      const handler = handlers[name];
      if (!handler) throw new JsonRpcError(-32601, `Tool not found: ${name}`);
      try {
        return await handler(args);
      } catch (err) {
        if (opts?.onError) return opts.onError(err, name);
        return toolError(err instanceof Error ? err.message : String(err));
      }
    });
  });
}

// ── Fixtures ───────────────────────────────────────────────────

beforeEach(() => {
  // Stub out the summarize backends so the routing test doesn't hit
  // the real fetch + LLM path. The summarize tool's tool-level
  // wrapper still runs through createToolDispatcher; we just want a
  // clean success envelope from the deepest call.
  _setBackendsForTests({
    fetch: async () => ({
      ok: true,
      status: 200,
      text: async () => "<html><title>X</title>Y</html>",
    }) as never,
    llm: { async complete() {
      return { content: "summary text" };
    } },
  });
});

afterEach(() => {
  _resetBackendsForTests();
  // Swap dispatcher registration back to a no-op so a registration
  // from one test doesn't bind onto a stopped channel in the next.
  _setDispatcherRegister(() => {});
});

// ── Tests ──────────────────────────────────────────────────────

describe("createToolDispatcher — real channel routing", () => {
  test("summarize_urls routes through the channel and returns a tool result", async () => {
    const stdin = createStdin();
    const { writes, stdout } = createStdout();
    const ch = createHostChannelForTests({ stdin: stdin.iterable, stdout });
    wireDispatcherTo(ch);
    createToolDispatcher(tools);
    ch.start();

    stdin.push(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "summarize_urls",
          arguments: { urls: ["https://x.test/a"] },
        },
      }),
    );
    await waitFor(() => writes.length >= 1);
    stdin.close();

    const frame = JSON.parse(writes[0] ?? "{}");
    expect(frame.jsonrpc).toBe("2.0");
    expect(frame.id).toBe(1);
    expect(frame.error).toBeUndefined();
    expect(frame.result).toBeDefined();
    expect(frame.result.isError).toBe(false);
  });

  test("unknown tool name surfaces as a JSON-RPC -32601 error envelope", async () => {
    // Critical distinction: protocol-level (-32601) vs tool-level
    // (isError:true). If the dispatcher ever started returning
    // isError-results for unknown tools, hosts that branch on
    // `frame.error` would never see the failure.
    const stdin = createStdin();
    const { writes, stdout } = createStdout();
    const ch = createHostChannelForTests({ stdin: stdin.iterable, stdout });
    wireDispatcherTo(ch);
    createToolDispatcher(tools);
    ch.start();

    stdin.push(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "totally-not-a-real-tool", arguments: {} },
      }),
    );
    await waitFor(() => writes.length >= 1);
    stdin.close();

    const frame = JSON.parse(writes[0] ?? "{}");
    expect(frame.result).toBeUndefined();
    expect(frame.error).toBeDefined();
    expect(frame.error.code).toBe(-32601);
    expect(frame.error.message).toContain("totally-not-a-real-tool");
  });

  test("post-type CRUD tool names DON'T route here anymore (SDK-served)", async () => {
    // Phase 7 contract pin: list_post_types is no longer registered
    // on this subprocess. The host's tool-executor short-circuits to
    // the SDK handler BEFORE reaching this dispatcher. If a future
    // change to index.ts ever re-registered the name here, this test
    // would FAIL (returning -32601 means the tool truly isn't on the
    // subprocess), which is exactly what we want.
    const stdin = createStdin();
    const { writes, stdout } = createStdout();
    const ch = createHostChannelForTests({ stdin: stdin.iterable, stdout });
    wireDispatcherTo(ch);
    createToolDispatcher(tools);
    ch.start();

    stdin.push(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "list_post_types", arguments: {} },
      }),
    );
    await waitFor(() => writes.length >= 1);
    stdin.close();

    const frame = JSON.parse(writes[0] ?? "{}");
    expect(frame.error?.code).toBe(-32601);
  });
});
