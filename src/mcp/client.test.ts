import { test, expect, describe } from "bun:test";
import { McpClient } from "./client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * End-to-end test: spawn a trivial stdio MCP server written inline with Bun
 * and verify listTools + callTool round-trip correctly.
 *
 * The server implements the minimum MCP surface: initialize, tools/list,
 * tools/call. It reads newline-delimited JSON-RPC on stdin and writes
 * responses to stdout.
 */
function makeStdioServer() {
  const dir = mkdtempSync(join(tmpdir(), "mcp-test-"));
  const scriptPath = join(dir, "server.ts");
  const src = `
    const sendMessage = (msg) => {
      process.stdout.write(JSON.stringify(msg) + "\\n");
    };

    const respond = (id, result) => sendMessage({ jsonrpc: "2.0", id, result });

    let buffer = "";
    process.stdin.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf("\\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        if (req.method === "initialize") {
          respond(req.id, {
            protocolVersion: req.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "test-server", version: "1.0.0" },
          });
        } else if (req.method === "notifications/initialized") {
          // no response
        } else if (req.method === "tools/list") {
          respond(req.id, {
            tools: [
              {
                name: "echo",
                description: "Echo input back",
                inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
              },
            ],
          });
        } else if (req.method === "tools/call") {
          const text = req.params?.arguments?.text ?? "";
          respond(req.id, {
            content: [{ type: "text", text: "echoed: " + text }],
            isError: false,
          });
        } else {
          sendMessage({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Method not found" } });
        }
      }
    });
  `;
  writeFileSync(scriptPath, src);
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

describe("McpClient (stdio)", () => {
  test("connects, lists tools, and calls a tool", async () => {
    const script = makeStdioServer();
    const client = new McpClient({
      transport: "stdio",
      name: "test",
      command: "bun",
      args: ["run", script],
    });
    try {
      await client.connect();
      expect(client.isConnected).toBe(true);

      const tools = await client.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe("echo");

      const result = await client.callTool("echo", { text: "hello" });
      expect(result.isError).toBe(false);
      expect(result.content).toEqual([{ type: "text", text: "echoed: hello" }]);
    } finally {
      await client.close();
    }
  }, 10_000);

  test("forwards env to stdio subprocess", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-env-"));
    const scriptPath = join(dir, "server.ts");
    writeFileSync(
      scriptPath,
      `
      const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
      let buffer = "";
      process.stdin.on("data", (chunk) => {
        buffer += chunk.toString();
        let idx;
        while ((idx = buffer.indexOf("\\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line.trim()) continue;
          const req = JSON.parse(line);
          if (req.method === "initialize") {
            send({ jsonrpc: "2.0", id: req.id, result: {
              protocolVersion: req.params?.protocolVersion ?? "2025-06-18",
              capabilities: { tools: {} }, serverInfo: { name: "s", version: "0.0.1" } } });
          } else if (req.method === "notifications/initialized") {
          } else if (req.method === "tools/list") {
            send({ jsonrpc: "2.0", id: req.id, result: { tools: [
              { name: "who", description: "", inputSchema: { type: "object" } },
            ] } });
          } else if (req.method === "tools/call") {
            send({ jsonrpc: "2.0", id: req.id, result: {
              content: [{ type: "text", text: "secret=" + (process.env.MY_SECRET ?? "") }],
              isError: false } });
          }
        }
      });
    `,
    );
    const client = new McpClient({
      transport: "stdio",
      name: "envtest",
      command: "bun",
      args: ["run", scriptPath],
      env: { MY_SECRET: "shh", PATH: process.env.PATH ?? "" },
    });
    try {
      const result = await client.callTool("who", {});
      expect(result.isError).toBe(false);
      expect(result.content[0]).toEqual({ type: "text", text: "secret=shh" });
    } finally {
      await client.close();
    }
  }, 10_000);

  test("close() is idempotent and resets isConnected", async () => {
    const script = makeStdioServer();
    const client = new McpClient({
      transport: "stdio", name: "idem", command: "bun", args: ["run", script],
    });
    expect(client.isConnected).toBe(false);
    await client.connect();
    expect(client.isConnected).toBe(true);
    await client.close();
    expect(client.isConnected).toBe(false);
    // close when already closed must not throw
    await client.close();
    expect(client.isConnected).toBe(false);
  }, 10_000);

  test("connect() is idempotent", async () => {
    const script = makeStdioServer();
    const client = new McpClient({
      transport: "stdio", name: "conn-idem", command: "bun", args: ["run", script],
    });
    try {
      await client.connect();
      // Second connect is a no-op — must not throw and must stay connected.
      await client.connect();
      expect(client.isConnected).toBe(true);
    } finally {
      await client.close();
    }
  }, 10_000);

  test("listTools auto-connects when not yet connected", async () => {
    const script = makeStdioServer();
    const client = new McpClient({
      transport: "stdio", name: "lazy", command: "bun", args: ["run", script],
    });
    try {
      expect(client.isConnected).toBe(false);
      const tools = await client.listTools();
      expect(client.isConnected).toBe(true);
      expect(tools).toHaveLength(1);
    } finally {
      await client.close();
    }
  }, 10_000);

  test("callTool auto-connects when not yet connected", async () => {
    const script = makeStdioServer();
    const client = new McpClient({
      transport: "stdio", name: "lazy-call", command: "bun", args: ["run", script],
    });
    try {
      expect(client.isConnected).toBe(false);
      const result = await client.callTool("echo", { text: "hi" });
      expect(client.isConnected).toBe(true);
      expect(result.content[0]).toEqual({ type: "text", text: "echoed: hi" });
    } finally {
      await client.close();
    }
  }, 10_000);

  test("maps non-text content parts to stringified text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-mixed-"));
    const scriptPath = join(dir, "server.ts");
    writeFileSync(
      scriptPath,
      `
      const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
      let buffer = "";
      process.stdin.on("data", (chunk) => {
        buffer += chunk.toString();
        let idx;
        while ((idx = buffer.indexOf("\\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line.trim()) continue;
          const req = JSON.parse(line);
          if (req.method === "initialize") {
            send({ jsonrpc: "2.0", id: req.id, result: {
              protocolVersion: req.params?.protocolVersion ?? "2025-06-18",
              capabilities: { tools: {} }, serverInfo: { name: "s", version: "0.0.1" } } });
          } else if (req.method === "notifications/initialized") {
          } else if (req.method === "tools/list") {
            send({ jsonrpc: "2.0", id: req.id, result: { tools: [
              { name: "mixed", description: "", inputSchema: { type: "object" } },
            ] } });
          } else if (req.method === "tools/call") {
            send({ jsonrpc: "2.0", id: req.id, result: {
              content: [
                { type: "text", text: "first" },
                { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
              ],
              isError: false } });
          }
        }
      });
    `,
    );
    const client = new McpClient({
      transport: "stdio", name: "mixed", command: "bun", args: ["run", scriptPath],
    });
    try {
      const result = await client.callTool("mixed", {});
      expect(result.content).toHaveLength(2);
      expect(result.content[0]).toEqual({ type: "text", text: "first" });
      expect(result.content[1]!.type).toBe("text");
      const parsed = JSON.parse(result.content[1]!.text);
      expect(parsed.type).toBe("image");
      expect(parsed.mimeType).toBe("image/png");
    } finally {
      await client.close();
    }
  }, 10_000);

  test("callTool propagates server-side tool errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-err-"));
    const scriptPath = join(dir, "server.ts");
    writeFileSync(
      scriptPath,
      `
      const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
      let buffer = "";
      process.stdin.on("data", (chunk) => {
        buffer += chunk.toString();
        let idx;
        while ((idx = buffer.indexOf("\\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line.trim()) continue;
          const req = JSON.parse(line);
          if (req.method === "initialize") {
            send({ jsonrpc: "2.0", id: req.id, result: {
              protocolVersion: req.params?.protocolVersion ?? "2025-06-18",
              capabilities: { tools: {} }, serverInfo: { name: "s", version: "0.0.1" } } });
          } else if (req.method === "notifications/initialized") {
            // no-op
          } else if (req.method === "tools/list") {
            send({ jsonrpc: "2.0", id: req.id, result: { tools: [
              { name: "boom", description: "", inputSchema: { type: "object" } },
            ] } });
          } else if (req.method === "tools/call") {
            send({ jsonrpc: "2.0", id: req.id, result: {
              content: [{ type: "text", text: "kaboom" }], isError: true } });
          }
        }
      });
    `,
    );
    const client = new McpClient({
      transport: "stdio",
      name: "err",
      command: "bun",
      args: ["run", scriptPath],
    });
    try {
      const result = await client.callTool("boom", {});
      expect(result.isError).toBe(true);
      expect(result.content[0]).toEqual({ type: "text", text: "kaboom" });
    } finally {
      await client.close();
    }
  }, 10_000);
});

/**
 * These tests verify the transport-construction branch in `buildTransport`
 * without hitting the network. We intercept the SDK client's `connect` method
 * to capture the transport that would have been used, then abort. This
 * catches regressions where the McpClient stops honoring transport/url/headers
 * choices. No I/O occurs.
 */
describe("McpClient transport construction (http/sse)", () => {
  async function captureTransport(
    spec: ConstructorParameters<typeof McpClient>[0],
  ): Promise<unknown> {
    const client = new McpClient(spec);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = (client as unknown as { client: { connect: (t: unknown) => Promise<void> } }).client;
    let captured: unknown = null;
    inner.connect = async (t: unknown) => {
      captured = t;
      throw new Error("__abort__");
    };
    try {
      await client.connect();
    } catch (e) {
      if ((e as Error).message !== "__abort__") throw e;
    }
    return captured;
  }

  test("http transport builds StreamableHTTPClientTransport with URL", async () => {
    const t = await captureTransport({
      transport: "http",
      name: "h",
      url: "https://example.com/mcp",
    });
    expect(t).toBeInstanceOf(StreamableHTTPClientTransport);
  });

  test("http transport preserves custom headers via requestInit", async () => {
    const t = (await captureTransport({
      transport: "http",
      name: "h",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer abc" },
    })) as { _requestInit?: { headers?: Record<string, string> } };
    expect(t._requestInit?.headers).toEqual({ Authorization: "Bearer abc" });
  });

  test("sse transport builds SSEClientTransport with URL", async () => {
    const t = await captureTransport({
      transport: "sse",
      name: "s",
      url: "https://example.com/sse",
    });
    expect(t).toBeInstanceOf(SSEClientTransport);
  });

  test("sse transport preserves custom headers via requestInit", async () => {
    const t = (await captureTransport({
      transport: "sse",
      name: "s",
      url: "https://example.com/sse",
      headers: { "X-Api-Key": "k" },
    })) as { _requestInit?: { headers?: Record<string, string> } };
    expect(t._requestInit?.headers).toEqual({ "X-Api-Key": "k" });
  });

  test("stdio transport builds StdioClientTransport", async () => {
    const t = await captureTransport({
      transport: "stdio",
      name: "cli",
      command: "echo",
    });
    expect(t).toBeInstanceOf(StdioClientTransport);
  });
});
