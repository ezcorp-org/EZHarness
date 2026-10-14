import { describe, expect, test } from "bun:test";
import { declaresStdioMcpServer, isPureStdioMcpSource, MCP_BRIDGE_SOURCE, MCP_BRIDGE_TEST_SOURCE, processSpawnPolicy } from "./process-spawn";

const stdioManifest = { schemaVersion: 4, name: "files-mcp", version: "1.0.0", description: "MCP", author: { name: "admin" }, kind: "mcp", permissions: {}, mcpServers: [{ name: "files", transport: "stdio", command: "files-server" }], tools: [] };
const bridge = (manifest: unknown = stdioManifest) => ({ "extension.ts": MCP_BRIDGE_SOURCE, "mcp.manifest.json": JSON.stringify(manifest), "metadata.test.ts": MCP_BRIDGE_TEST_SOURCE });

describe("processSpawnPolicy", () => {
  test("a request without a policy is denied", () => {
    expect(processSpawnPolicy(undefined)).toBe("deny");
    expect(processSpawnPolicy("deny")).toBe("deny");
    expect(processSpawnPolicy("allow")).toBe("allow");
  });
  test("any other value is refused, not read as allow", () => {
    for (const value of [true, "ALLOW", 1, null, {}]) expect(() => processSpawnPolicy(value)).toThrow(expect.objectContaining({ code: "INVALID_PROCESS_SPAWN" }));
  });
});

describe("isPureStdioMcpSource", () => {
  test("the sealed bridge for one stdio server is pure, with or without its metadata test and runner files", () => {
    expect(isPureStdioMcpSource(bridge(), "extension.ts")).toBe(true);
    const { "metadata.test.ts": _test, ...withoutTest } = bridge();
    expect(isPureStdioMcpSource(withoutTest, "extension.ts")).toBe(true);
    expect(isPureStdioMcpSource({ ...bridge(), ".runner/extension.js": "bundle", ".runner/recipe.json": "{}" }, "extension.ts")).toBe(true);
  });
  test("custom code beside a stdio MCP entry is not pure", () => {
    expect(isPureStdioMcpSource({ ...bridge(), "extension.ts": `${MCP_BRIDGE_SOURCE}Bun.spawn(["sh"]);\n` }, "extension.ts")).toBe(false);
    expect(isPureStdioMcpSource({ ...bridge(), "helper.ts": "export const x = 1;\n" }, "extension.ts")).toBe(false);
    expect(isPureStdioMcpSource({ ...bridge(), "custom.ts": "Bun.spawn(['sh']);\n" }, "custom.ts")).toBe(false);
    expect(isPureStdioMcpSource({ ...bridge(), "metadata.test.ts": "import './evil';\n" }, "extension.ts")).toBe(false);
  });
  test("a file that can change what the bridge bundle loads is not pure", () => {
    for (const path of ["package.json", "tsconfig.json", "bunfig.toml", "bun.lock"]) expect(isPureStdioMcpSource({ ...bridge(), [path]: "{}" }, "extension.ts")).toBe(false);
  });
  test("a bridge without a stdio server, or with a broken manifest, is not pure", () => {
    expect(isPureStdioMcpSource(bridge({ ...stdioManifest, mcpServers: [{ name: "remote", transport: "http", url: "https://mcp.example.com/mcp" }] }), "extension.ts")).toBe(false);
    expect(isPureStdioMcpSource({ ...bridge(), "mcp.manifest.json": "{" }, "extension.ts")).toBe(false);
    const { "mcp.manifest.json": _manifest, ...withoutManifest } = bridge();
    expect(isPureStdioMcpSource(withoutManifest, "extension.ts")).toBe(false);
  });
});

describe("declaresStdioMcpServer", () => {
  test("needs kind mcp and exactly one stdio server", () => {
    expect(declaresStdioMcpServer({ kind: "mcp", mcpServers: [{ transport: "stdio" }] })).toBe(true);
    expect(declaresStdioMcpServer({ kind: "local", mcpServers: [{ transport: "stdio" }] })).toBe(false);
    expect(declaresStdioMcpServer({ kind: "mcp", mcpServers: [{ transport: "stdio" }, { transport: "stdio" }] })).toBe(false);
    expect(declaresStdioMcpServer({ kind: "mcp" })).toBe(false);
  });
});
