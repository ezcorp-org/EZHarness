import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { installMcpExtension, getExtensionByName } from "../db/queries/extensions";

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe("installMcpExtension", () => {
  test("creates an MCP-kind extension row with null installPath and cached tools", async () => {
    const tools = [
      { name: "ping", description: "ping tool", inputSchema: { type: "object" } },
    ];
    const ext = await installMcpExtension({
      name: "query-mcp-1",
      description: "Remote MCP",
      server: { transport: "stdio", name: "query-mcp-1", command: "node", args: ["./srv.ts"] },
      cachedTools: tools,
    });

    expect(ext.name).toBe("query-mcp-1");
    expect(ext.installPath).toBeNull();
    expect(ext.source).toBe("mcp:stdio");
    expect(ext.enabled).toBe(true);
    expect(ext.manifest.kind).toBe("mcp");
    expect(ext.manifest.tools).toEqual(tools);
    expect(ext.manifest.mcpServers?.[0]?.transport).toBe("stdio");
    expect(ext.manifest.schemaVersion).toBe(2);
    expect(ext.grantedPermissions).toEqual({ grantedAt: {} });
    expect(ext.consecutiveFailures).toBe(0);
    expect(ext.checksumVerified).toBe(false);

    const roundtrip = await getExtensionByName("query-mcp-1");
    expect(roundtrip?.id).toBe(ext.id);
    expect(roundtrip?.installPath).toBeNull();
  });

  test("applies default version and author when omitted", async () => {
    const ext = await installMcpExtension({
      name: "query-mcp-defaults",
      server: { transport: "http", name: "query-mcp-defaults", url: "https://ex.com/mcp" },
      cachedTools: [],
    });
    expect(ext.manifest.version).toBe("0.0.0");
    expect(ext.manifest.author.name).toBe("local");
    expect(ext.manifest.description).toBe("");
  });

  test("source reflects the transport kind", async () => {
    const httpExt = await installMcpExtension({
      name: "query-mcp-http",
      server: { transport: "http", name: "query-mcp-http", url: "https://ex.com/mcp" },
      cachedTools: [],
    });
    const sseExt = await installMcpExtension({
      name: "query-mcp-sse",
      server: { transport: "sse", name: "query-mcp-sse", url: "https://ex.com/sse" },
      cachedTools: [],
    });
    expect(httpExt.source).toBe("mcp:http");
    expect(sseExt.source).toBe("mcp:sse");
  });

  test("unique name constraint — second insert with same name rejects", async () => {
    await installMcpExtension({
      name: "query-mcp-dup",
      server: { transport: "stdio", name: "query-mcp-dup", command: "node" },
      cachedTools: [],
    });
    await expect(
      installMcpExtension({
        name: "query-mcp-dup",
        server: { transport: "stdio", name: "query-mcp-dup", command: "node" },
        cachedTools: [],
      }),
    ).rejects.toThrow();
  });
});
