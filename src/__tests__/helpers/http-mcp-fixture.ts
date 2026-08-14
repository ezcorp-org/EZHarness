/**
 * A minimal streamable-HTTP MCP server bound to loopback.
 *
 * The sibling `stdio-mcp-fixture.ts` covers the `stdio` transport, which the
 * SSRF target guard deliberately exempts (it spawns a process rather than
 * dialing an address). Proving the guard, the capability derivation and the
 * PDP COMPOSE needs the other kind: a real `http` target the client actually
 * connects to over a socket.
 *
 * It is loopback-only on purpose. A private address is exactly the case the
 * guard denies by default, so an integration test can prove both halves with
 * one fixture: refused without `EZCORP_MCP_TARGET_ALLOW`, and a complete
 * install → grant → dispatch path with it.
 *
 * Streamable HTTP is JSON-RPC over POST. This implements the subset the SDK's
 * `StreamableHTTPClientTransport` needs — a JSON response per request, `202`
 * for a notification (no `id`), and `405` on GET so the client's optional
 * server-push stream degrades instead of hanging.
 */

export type HttpMcpFixture = {
  /** The MCP endpoint, e.g. `http://127.0.0.1:41234/mcp`. */
  url: string;
  /** The loopback host, for allowlist assertions. */
  host: string;
  /** Tool names the server advertises, in `tools/list` order. */
  toolNames: string[];
  /** Swap the advertised tool list (used to prove a refresh actually moves). */
  setTools: (tools: Array<{ name: string; description: string }>) => void;
  stop: () => Promise<void>;
};

type JsonRpcRequest = { jsonrpc: "2.0"; id?: string | number; method: string; params?: unknown };

/** Start the server. Caller must `await stop()`. */
export function makeHttpMcpServer(
  opts: { tools?: Array<{ name: string; description: string }> } = {},
): HttpMcpFixture {
  let tools = opts.tools ?? [{ name: "echo", description: "Echo tool" }];

  const toolPayload = () =>
    tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    }));

  const handle = (req: JsonRpcRequest): unknown => {
    if (req.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion:
            (req.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "http-fixture", version: "1.0.0" },
        },
      };
    }
    if (req.method === "tools/list") {
      return { jsonrpc: "2.0", id: req.id, result: { tools: toolPayload() } };
    }
    if (req.method === "tools/call") {
      const text =
        (req.params as { arguments?: { text?: string } } | undefined)?.arguments?.text ?? "";
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: { content: [{ type: "text", text: `echoed:${text}` }], isError: false },
      };
    }
    return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Method not found" } };
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      // The client's optional server-push stream. 405 is the documented way to
      // say "this server has no standalone SSE channel"; the SDK moves on.
      if (request.method !== "POST") return new Response(null, { status: 405 });

      const body = (await request.json()) as JsonRpcRequest | JsonRpcRequest[];
      const batch = Array.isArray(body) ? body : [body];
      // A notification carries no `id` and gets no response body.
      const replies = batch.filter((m) => m.id !== undefined).map(handle);
      if (replies.length === 0) return new Response(null, { status: 202 });

      return new Response(JSON.stringify(Array.isArray(body) ? replies : replies[0]), {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "fixture-session" },
      });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    host: "127.0.0.1",
    get toolNames() {
      return tools.map((t) => t.name);
    },
    setTools: (next) => {
      tools = next;
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}
