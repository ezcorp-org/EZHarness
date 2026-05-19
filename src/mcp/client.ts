import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { McpServerDefinition, ToolDefinition, ToolCallResult } from "../extensions/types";

/**
 * Phase 58 / MCP-05 — Subclass of StdioClientTransport that fires a
 * post-spawn hook AFTER the child process exists but BEFORE the
 * JSON-RPC `initialize` (which Client.connect dispatches in the next
 * tick after super.connect resolves).
 *
 * The hook is awaited — Open Question 1 lock: any race between the
 * launcher's `read -n 1` and the SDK's `initialize` write to stdin
 * would either (a) hang (launcher never unblocked) or (b) corrupt the
 * MCP's stdin (handshake byte read as the first JSON-RPC frame).
 *
 * Pattern: override `start()` to call super.start() (which sets
 * `_process`), then invoke our hook with the pid + a writeByte callback
 * that uses the spawned process's stdin handle. This isolates the
 * SDK-internal `_process` access to a single private subclass scope.
 */
type ChildSpawnedHook = (
  pid: number,
  writeByte: (b: number) => Promise<void>,
) => Promise<void>;

class HookedStdioClientTransport extends StdioClientTransport {
  constructor(
    serverParams: ConstructorParameters<typeof StdioClientTransport>[0],
    private readonly onChildSpawned?: ChildSpawnedHook,
  ) {
    super(serverParams);
  }

  override async start(): Promise<void> {
    await super.start();
    if (!this.onChildSpawned) return;

    // Reach into the SDK's _process field via a cast — same pattern as
    // McpClient.getChildProcess() (Plan 01 escape hatch). The transport
    // may have already exited (start() resolves on 'spawn' but the
    // child can die before our hook runs); we degrade-soft.
    const proc = (this as unknown as {
      _process?: {
        pid?: number;
        stdin?: { write?: (chunk: Buffer | Uint8Array, cb?: (err?: Error) => void) => boolean };
      };
    })._process;
    const pid = proc?.pid;
    if (typeof pid !== "number" || !proc?.stdin?.write) return;

    const stdin = proc.stdin;
    const writeByte = (b: number): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        try {
          stdin.write!(new Uint8Array([b]), (err) => {
            if (err) reject(err);
            else resolve();
          });
        } catch (err) {
          reject(err as Error);
        }
      });
    await this.onChildSpawned(pid, writeByte);
  }
}

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

  /**
   * Returns the underlying stdio transport's spawned child process, or
   * null if unavailable (http/sse transports, transport not yet
   * constructed, or SDK internal shape change).
   *
   * SDK escape hatch: `@modelcontextprotocol/sdk` does not expose the
   * stdio transport's child process publicly. Phase 58 / MCP-04 needs
   * this for the seccomp soak reader (`runMcpSeccompSoakReader` needs
   * the child PID + an `exited` promise) and the registry wires it on
   * the post-connect path. We reach into the SDK's internal
   * `transport._process` field via a cast — this is a known stability
   * risk documented in Plan 55-03 deferred-items. If a future SDK
   * version drops `_process` (or renames it), this method returns null
   * and the soak reader silently no-ops (degrade-soft posture; the
   * audit signal goes quiet but nothing in production breaks).
   */
  getChildProcess(): { pid: number; exited: Promise<unknown> } | null {
    const transport = (this.client as {
      transport?: { _process?: { pid?: number; exited?: Promise<unknown> } };
    }).transport;
    const proc = transport?._process;
    if (!proc || typeof proc.pid !== "number" || !proc.exited) return null;
    return { pid: proc.pid, exited: proc.exited };
  }

  private buildTransport() {
    if (this.spec.transport === "stdio") {
      // Phase 58 / MCP-05 — when the spec carries an onChildSpawned hook
      // (Stage 2 veth setup), construct a HookedStdioClientTransport so
      // the hook fires AFTER spawn and BEFORE initialize. Pre-Phase-58
      // specs (no hook) fall back to the bare StdioClientTransport.
      if (this.spec.onChildSpawned) {
        return new HookedStdioClientTransport(
          {
            command: this.spec.command,
            args: this.spec.args ?? [],
            env: this.spec.env,
          },
          this.spec.onChildSpawned,
        );
      }
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
