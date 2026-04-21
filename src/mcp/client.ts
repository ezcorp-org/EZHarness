import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { McpServerDefinition, ToolDefinition, ToolCallResult } from "../extensions/types";

/**
 * Thin wrapper around @modelcontextprotocol/sdk's Client that
 * speaks one of the three supported transports and exposes the
 * app's `ToolDefinition` + `ToolCallResult` shapes.
 *
 * One instance corresponds to one extension row with `kind: "mcp"`.
 * Callers own lifecycle — `connect()` must be called before any
 * `listTools`/`callTool` and `close()` on shutdown.
 */
export class McpClient {
  private client: Client;
  private connected = false;

  constructor(private readonly spec: McpServerDefinition) {
    this.client = new Client({ name: "ezcorp-ai", version: "1.0.0" }, { capabilities: {} });
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const transport = this.buildTransport();
    await this.client.connect(transport);
    this.connected = true;
  }

  async listTools(): Promise<ToolDefinition[]> {
    if (!this.connected) await this.connect();
    const res = await this.client.listTools();
    return res.tools.map((t) => ({
      name: t.name,
      description: t.description ?? t.title ?? t.name,
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    if (!this.connected) await this.connect();
    const res = await this.client.callTool({ name, arguments: args });
    const content = Array.isArray(res.content) ? res.content : [];
    return {
      content: content.map((c) => {
        if (typeof c === "object" && c !== null && "type" in c && (c as { type: unknown }).type === "text") {
          return { type: "text", text: String((c as { text?: unknown }).text ?? "") };
        }
        return { type: "text", text: JSON.stringify(c) };
      }),
      isError: res.isError === true,
    };
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    await this.client.close();
    this.connected = false;
  }

  private buildTransport() {
    if (this.spec.transport === "stdio") {
      return new StdioClientTransport({
        command: this.spec.command,
        args: this.spec.args ?? [],
        env: this.spec.env,
      });
    }
    const url = new URL(this.spec.url);
    const headers = this.spec.headers;
    if (this.spec.transport === "http") {
      return new StreamableHTTPClientTransport(url, headers ? { requestInit: { headers } } : undefined);
    }
    return new SSEClientTransport(url, headers ? { requestInit: { headers } } : undefined);
  }
}
