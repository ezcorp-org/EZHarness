import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ExtensionRegistry } from "../extensions/registry";
import { ToolExecutor } from "../extensions/tool-executor";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";
import type { ExtensionManifestV2 } from "../extensions/types";

/**
 * Verifies that `ToolExecutor.executeToolCall` routes to `getMcpClient`
 * (not `getProcess`) when the registered tool's extension has
 * `manifest.kind === "mcp"`. No real MCP server is started — we replace
 * the registry's `getMcpClient` with a stub. If the executor were
 * to hit the subprocess path, it would call `getProcess` and throw
 * because the MCP manifest has no entrypoint.
 */
describe("ToolExecutor dispatch for MCP-kind extensions", () => {
  beforeEach(() => {
    ExtensionRegistry.resetInstance();
  });
  afterEach(() => {
    ExtensionRegistry.resetInstance();
  });

  test("executeToolCall for MCP-kind extension uses MCP client, not subprocess", async () => {
    const registry = ExtensionRegistry.getInstance();
    const extId = "ext-mcp-1";
    const manifest: ExtensionManifestV2 = {
      schemaVersion: 2,
      name: "remote",
      version: "0.0.0",
      description: "",
      author: { name: "t" },
      kind: "mcp",
      mcpServers: [{ transport: "stdio", name: "remote", command: "node" }],
      tools: [
        { name: "ping", description: "ping tool", inputSchema: { type: "object" } },
      ],
      permissions: {},
    };
    registry.setManifestForTest(extId, manifest);
    registry.setGrantedPermsForTest(extId, { grantedAt: {} });
    registry.registerToolForTest("remote__ping", {
      name: "remote__ping",
      originalName: "ping",
      description: "ping tool",
      inputSchema: { type: "object" },
      extensionId: extId,
      extensionName: "remote",
    });

    // Stub the MCP client path — returns a fixed result so we can assert
    // the executor took this branch.
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    (registry as unknown as { getMcpClient: (id: string) => Promise<unknown> }).getMcpClient =
      async (_id: string) => ({
        callTool: async (name: string, args: Record<string, unknown>) => {
          calls.push({ name, args });
          return { content: [{ type: "text" as const, text: "pong" }], isError: false };
        },
      });

    // Poison the subprocess path — if executor routes here it must fail.
    (registry as unknown as { getProcess: () => Promise<unknown> }).getProcess = async () => {
      throw new Error("subprocess path should not be used for MCP extensions");
    };

    const executor = new ToolExecutor(registry, createStubPermissionEngine());
    const result = await executor.executeToolCall(
      "remote__ping",
      { q: "hi" },
      "conv-1",
      null,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ name: "ping", args: { q: "hi" } });
    expect(result.isError).toBe(false);
    expect(result.content[0]).toEqual({ type: "text", text: "pong" });
  });
});
