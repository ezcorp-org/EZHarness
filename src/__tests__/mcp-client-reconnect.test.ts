/**
 * MCP defect 1 — a restarted MCP server used to leave a cached DEAD client.
 *
 * `McpClient.connected` was cleared ONLY by an explicit `close()`, so once
 * the server went away the wrapper still reported `isConnected === true` and
 * `ExtensionRegistry.getMcpClient`'s early return handed that corpse back on
 * every subsequent call — until the harness itself restarted. There was no
 * auto-reconnect anywhere.
 *
 * These run against a REAL stdio MCP server (a spawned child speaking real
 * JSON-RPC) and kill it the way a restart does: the process exits mid-request
 * without replying. Nothing here waits on a clock — the SDK runs
 * `Protocol.onclose` BEFORE it rejects the in-flight request, so the caller's
 * own `rejects` await is the synchronisation point.
 */
import { test, expect, describe } from "bun:test";
import { McpClient } from "../mcp/client";
import {
  makeStdioMcpServer,
  MCP_FIXTURE_DIE_TOOL,
} from "./helpers/stdio-mcp-fixture";
import type { McpServerDefinition } from "../extensions/types";

function restartableServer(name: string): McpServerDefinition {
  const srv = makeStdioMcpServer({ toolName: "echo", controls: true });
  return { transport: "stdio", name, command: srv.command, args: srv.args };
}

describe("McpClient — a dead transport is observable", () => {
  test("the server exiting clears isConnected and fires onClosed", async () => {
    const client = new McpClient(restartableServer("restart-observable"));
    let closedCalls = 0;
    client.setLifecycleHooks({ onClosed: () => { closedCalls += 1; } });

    await client.connect();
    expect(client.isConnected).toBe(true);
    expect((await client.listTools()).map((t) => t.name)).toEqual(["echo"]);
    expect(closedCalls).toBe(0);

    // The server exits without answering. Pre-fix, `isConnected` stayed
    // `true` here forever.
    await expect(client.callTool(MCP_FIXTURE_DIE_TOOL, {})).rejects.toThrow();

    expect(client.isConnected).toBe(false);
    expect(closedCalls).toBe(1);
  });

  test("an explicit close() also settles the flag and notifies", async () => {
    const client = new McpClient(restartableServer("explicit-close"));
    let closedCalls = 0;
    client.setLifecycleHooks({ onClosed: () => { closedCalls += 1; } });

    await client.connect();
    await client.close();

    expect(client.isConnected).toBe(false);
    expect(closedCalls).toBe(1);
    // close() on an already-closed client is a no-op, not a second event.
    await client.close();
    expect(closedCalls).toBe(1);
  });

  test("hooks are optional — a client with none survives the same death", async () => {
    const client = new McpClient(restartableServer("no-hooks"));
    await client.connect();
    await expect(client.callTool(MCP_FIXTURE_DIE_TOOL, {})).rejects.toThrow();
    expect(client.isConnected).toBe(false);
  });
});

describe("McpClient — the next call reconnects", () => {
  test("listTools() after a death spawns a fresh server and answers", async () => {
    const client = new McpClient(restartableServer("reconnect-list"));
    await client.connect();
    await expect(client.callTool(MCP_FIXTURE_DIE_TOOL, {})).rejects.toThrow();
    expect(client.isConnected).toBe(false);

    // Pre-fix this threw "Not connected" (the SDK's Protocol has no transport
    // once it has closed) because `connect()` short-circuited on a `connected`
    // flag that no longer described reality.
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
    expect(client.isConnected).toBe(true);

    await client.close();
  });

  test("callTool() after a death reconnects and executes", async () => {
    const client = new McpClient(restartableServer("reconnect-call"));
    await client.connect();
    await expect(client.callTool(MCP_FIXTURE_DIE_TOOL, {})).rejects.toThrow();

    const result = await client.callTool("echo", { text: "after-restart" });
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "echoed:after-restart" }]);

    await client.close();
  });

  test("a client can survive more than one restart", async () => {
    const client = new McpClient(restartableServer("reconnect-twice"));
    await client.connect();

    for (const round of ["first", "second"]) {
      await expect(client.callTool(MCP_FIXTURE_DIE_TOOL, {})).rejects.toThrow();
      expect(client.isConnected).toBe(false);
      const result = await client.callTool("echo", { text: round });
      expect(result.content).toEqual([{ type: "text", text: `echoed:${round}` }]);
    }

    await client.close();
  });

  test("the reconnect re-runs the SSRF target guard", async () => {
    // A `http` spec whose host resolves private is refused by
    // `assertMcpTargetAllowed`. Reaching that refusal proves the guard is on
    // the reconnect path too — a target that turned internal between the two
    // connects cannot be reached by riding a stale `connected` flag.
    const client = new McpClient({
      transport: "http",
      name: "guard-on-reconnect",
      url: "http://169.254.169.254/mcp",
    });
    await expect(client.connect()).rejects.toThrow();
    expect(client.isConnected).toBe(false);
    await expect(client.connect()).rejects.toThrow();
  });
});
