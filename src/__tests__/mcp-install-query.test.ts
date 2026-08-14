import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import {
  installMcpExtension,
  updateMcpExtension,
  getExtensionByName,
  getExtension,
  createExtension,
} from "../db/queries/extensions";
import type { NewExtension } from "../db/schema";

/** The declaration a HOSTLESS stdio server's tools carry: no `network` cap to
 *  declare, but the `ezcorp:mcp:invoke` sentinel is declared anyway (F5) —
 *  an empty declaration flattens to an empty needed set, and
 *  `firstMissingCapability([], …)` can never fail, so the PDP would allow
 *  every call no matter what the admin revoked. */
const MCP_ONLY_DECL = { custom: { "ezcorp:mcp:invoke": true } };

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
    // Each cached tool now carries the capability declaration the PDP reads
    // at dispatch (B5). This server's command line names no host, so there is
    // no `network` cap — the sentinel alone is what keeps it gated (F5).
    expect(ext.manifest.tools).toEqual(
      tools.map((t) => ({ ...t, capabilities: MCP_ONLY_DECL })),
    );
    expect(ext.manifest.permissions).toEqual({ network: [], mcpInvoke: true });
    expect(ext.manifest.mcpServers?.[0]?.transport).toBe("stdio");
    expect(ext.manifest.schemaVersion).toBe(2);
    // Hostless, so no `network` grant — but the sentinel IS granted at
    // install, which is what makes a later revocation bite.
    expect(ext.grantedPermissions.network).toBeUndefined();
    expect(ext.grantedPermissions.mcpInvoke).toBe(true);
    expect(typeof ext.grantedPermissions.grantedAt.mcpInvoke).toBe("number");
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

describe("updateMcpExtension", () => {
  test("re-points server config + refreshes tools, preserving identity", async () => {
    const ext = await installMcpExtension({
      name: "upd-mcp-1",
      description: "v1 desc",
      server: { transport: "stdio", name: "upd-mcp-1", command: "node", args: ["v1.js"] },
      cachedTools: [{ name: "old-tool" }],
    });
    const originalVersion = ext.manifest.version;
    const originalAuthor = ext.manifest.author.name;

    const updated = await updateMcpExtension({
      id: ext.id,
      description: "v2 desc",
      server: { transport: "stdio", name: "upd-mcp-1", command: "node", args: ["v2.js"] },
      cachedTools: [{ name: "new-tool" }, { name: "second" }],
    });

    expect(updated).not.toBeNull();
    expect(updated!.source).toBe("mcp:stdio");
    expect(updated!.description).toBe("v2 desc");
    expect(updated!.manifest.description).toBe("v2 desc");
    // Refreshed tools are re-stamped with the hostless-stdio declaration — a
    // bare `{...manifest, tools}` would drop it and put the PDP back on an
    // undeclared needed set.
    expect(updated!.manifest.tools).toEqual([
      { name: "new-tool", capabilities: MCP_ONLY_DECL },
      { name: "second", capabilities: MCP_ONLY_DECL },
    ]);
    const server0 = updated!.manifest.mcpServers?.[0] as { args?: string[] } | undefined;
    expect(server0?.args).toEqual(["v2.js"]);
    // Identity preserved.
    expect(updated!.name).toBe("upd-mcp-1");
    expect(updated!.manifest.version).toBe(originalVersion);
    expect(updated!.manifest.author.name).toBe(originalAuthor);

    const roundtrip = await getExtension(ext.id);
    expect((roundtrip!.manifest as any).tools).toEqual([
      { name: "new-tool", capabilities: MCP_ONLY_DECL },
      { name: "second", capabilities: MCP_ONLY_DECL },
    ]);
  });

  test("keeps the existing description when omitted", async () => {
    const ext = await installMcpExtension({
      name: "upd-mcp-keep-desc",
      description: "keep me",
      server: { transport: "http", name: "upd-mcp-keep-desc", url: "https://a.example/mcp" },
      cachedTools: [],
    });
    const updated = await updateMcpExtension({
      id: ext.id,
      server: { transport: "http", name: "upd-mcp-keep-desc", url: "https://b.example/mcp" },
      cachedTools: [],
    });
    expect(updated!.manifest.description).toBe("keep me");
  });

  test("transport switch updates the source slug", async () => {
    const ext = await installMcpExtension({
      name: "upd-mcp-transport",
      server: { transport: "stdio", name: "upd-mcp-transport", command: "node" },
      cachedTools: [],
    });
    const updated = await updateMcpExtension({
      id: ext.id,
      server: { transport: "sse", name: "upd-mcp-transport", url: "https://x.example/sse" },
      cachedTools: [],
    });
    expect(updated!.source).toBe("mcp:sse");
    expect(updated!.manifest.mcpServers?.[0]?.transport).toBe("sse");
  });

  test("returns null for a missing id", async () => {
    const result = await updateMcpExtension({
      id: "00000000-0000-0000-0000-000000000000",
      server: { transport: "stdio", name: "x", command: "node" },
      cachedTools: [],
    });
    expect(result).toBeNull();
  });

  test("returns null when the target is not an MCP extension", async () => {
    const local = await createExtension({
      name: "upd-local-ext",
      version: "1.0.0",
      description: "local",
      manifest: {
        schemaVersion: 2,
        name: "upd-local-ext",
        version: "1.0.0",
        description: "local",
        author: { name: "local" },
        kind: "local",
        tools: [],
        permissions: {},
      },
      source: "local",
      installPath: "/tmp/x",
      enabled: true,
      grantedPermissions: { grantedAt: {} },
      checksumVerified: false,
      consecutiveFailures: 0,
    } as NewExtension);

    const result = await updateMcpExtension({
      id: local.id,
      server: { transport: "stdio", name: "upd-local-ext", command: "node" },
      cachedTools: [],
    });
    expect(result).toBeNull();
  });
});
