import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { assertMcpTargetAllowed } from "./target-guard";
import { createMcpGuardedFetch } from "./guarded-fetch";
import type { McpServerDefinition, ToolDefinition, ToolCallResult } from "../extensions/types";
import { awaitMcpSignal } from "./cancellation";
import type { InvocationGuard } from "../extensions/runtime-locks";
export interface McpCallOptions { signal?: AbortSignal; invocationGuard?: InvocationGuard }

/**
 * Server-driven lifecycle events the owner (the extension registry) reacts
 * to. Both are attached with {@link McpClient.setLifecycleHooks} BEFORE
 * `connect()` — a transport can die during the handshake.
 */
export type McpClientHooks = {
  /**
   * The transport is gone: the MCP server restarted, the stdio child
   * exited, the HTTP/SSE stream dropped, or `close()` was called.
   * `isConnected` is already `false` when this runs.
   */
  onClosed?: () => void;
  /**
   * The server pushed `notifications/tools/list_changed` — its tool
   * catalog moved and the cached list at rest is stale.
   */
  onToolListChanged?: () => void;
};

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
  /**
   * This SDK `Client` has already owned a transport, so it can never take
   * another one: `Protocol.connect()` throws "Already connected to a
   * transport" while the transport is live, and a closed one still carries
   * the previous session's negotiated capabilities. A RECONNECT therefore
   * gets a brand-new `Client` (see `connect()`).
   */
  private spent = false;
  private hooks: McpClientHooks = {};

  constructor(private readonly spec: McpServerDefinition) {
    this.client = this.newClient();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Attach the owner's lifecycle hooks. Replaces any previously attached
   * set; call before `connect()`.
   */
  setLifecycleHooks(hooks: McpClientHooks): void {
    this.hooks = hooks;
  }

  /**
   * A fresh SDK `Client` with our two server-driven listeners already wired.
   *
   * `onclose` is the fix for the stale-client defect: `connected` used to be
   * cleared ONLY by an explicit `close()`, so a restarted MCP server left a
   * cached DEAD client behind until the harness itself restarted. The SDK
   * fires `Protocol.onclose` from `_onclose()` — which runs BEFORE the
   * in-flight requests are rejected — so a caller that sees a `callTool`
   * rejection already sees `isConnected === false`.
   */
  private newClient(): Client {
    const client = new Client({ name: "ezcorp-ai", version: "1.0.0" }, { capabilities: {} });
    client.onclose = () => {
      this.connected = false;
      this.hooks.onClosed?.();
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      this.hooks.onToolListChanged?.();
    });
    return client;
  }

  /**
   * SSRF gate, then connect.
   *
   * The guard lives HERE rather than in the API handlers because this is
   * the one chokepoint every network connect passes through — install,
   * edit, refresh, registry reload, and lazy tool dispatch all end up in
   * `connect()`. Guarding at the routes would leave the runtime paths
   * open and would need the same policy written twice.
   *
   * It also means the check is per-CONNECT, not per-install: a target
   * that resolved public when it was installed and resolves private later
   * is refused on the next connect (see `target-guard.ts` on the residual
   * TOCTOU window). `stdio` specs are a no-op in the guard.
   *
   * Re-entrant after a death: once the transport has closed, `listTools` /
   * `callTool` come back through here and RECONNECT. The guard re-runs, so
   * a reconnect is authorized on the same terms as the first connect.
   */
  async connect(options: McpCallOptions = {}): Promise<void> {
    options.signal?.throwIfAborted();
    if (this.connected) return;
    await assertMcpTargetAllowed(this.spec);
    options.signal?.throwIfAborted();
    if (this.spent) this.client = this.newClient();
    const transport = this.buildTransport();
    // Marked BEFORE the handshake: a `Client` whose `connect()` threw has
    // still taken ownership of a transport and must not be handed another.
    this.spent = true;
    try {
      await awaitMcpSignal(this.client.connect(transport, { signal: options.signal }), options.signal);
      options.signal?.throwIfAborted();
    } catch (error) {
      await this.client.close();
      throw error;
    }
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

  async callTool(name: string, args: Record<string, unknown>, _meta?: Record<string, unknown>, options: McpCallOptions = {}): Promise<ToolCallResult> {
    options.signal?.throwIfAborted();
    if (options.invocationGuard) await options.invocationGuard();
    options.signal?.throwIfAborted();
    if (!this.connected) await this.connect(options);
    if (options.invocationGuard) await options.invocationGuard();
    options.signal?.throwIfAborted();
    const res = await this.client.callTool({ name, arguments: args }, undefined, { signal: options.signal });
    options.signal?.throwIfAborted();
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
    // Every request either transport makes goes through this fetch — the
    // streamable POST/GET/DELETE, the SSE stream, and the SSE endpoint POST.
    // It re-runs the target guard on each `Location` hop, which is what
    // stops a reachable MCP server from redirecting us onto an internal
    // address (see guarded-fetch.ts). Without it the guard below only ever
    // saw the FIRST url and the SDK followed redirects for us.
    const fetch = createMcpGuardedFetch();
    const opts = { fetch, ...(headers ? { requestInit: { headers } } : {}) };
    if (this.spec.transport === "http") {
      return new StreamableHTTPClientTransport(url, opts);
    }
    return new SSEClientTransport(url, opts);
  }
}
