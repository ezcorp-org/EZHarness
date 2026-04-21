import { describe, test, expect } from "bun:test";
import { validateMcpManifest } from "../extensions/manifest";

function baseMcp(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    name: "remote",
    version: "1.0.0",
    description: "remote",
    author: { name: "t" },
    kind: "mcp" as const,
    mcpServers: [
      { transport: "stdio", name: "remote", command: "node", args: ["./s.ts"] },
    ],
    permissions: {},
    ...overrides,
  };
}

describe("validateMcpManifest", () => {
  test("valid stdio manifest passes", () => {
    const r = validateMcpManifest(baseMcp());
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  test("valid http manifest passes", () => {
    const r = validateMcpManifest(baseMcp({
      mcpServers: [
        { transport: "http", name: "r", url: "https://ex.com/mcp", headers: { Authorization: "Bearer x" } },
      ],
    }));
    expect(r.valid).toBe(true);
  });

  test("valid sse manifest passes", () => {
    const r = validateMcpManifest(baseMcp({
      mcpServers: [
        { transport: "sse", name: "r", url: "https://ex.com/sse" },
      ],
    }));
    expect(r.valid).toBe(true);
  });

  test("missing kind fails", () => {
    const m = baseMcp();
    delete (m as { kind?: unknown }).kind;
    const r = validateMcpManifest(m);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes(`kind must be "mcp"`))).toBe(true);
  });

  test("kind='local' fails for MCP manifest check", () => {
    const r = validateMcpManifest(baseMcp({ kind: "local" }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes(`kind must be "mcp"`))).toBe(true);
  });

  test("zero mcpServers entries fails", () => {
    const r = validateMcpManifest(baseMcp({ mcpServers: [] }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("exactly one mcpServers entry"))).toBe(true);
  });

  test("two mcpServers entries fails", () => {
    const r = validateMcpManifest(baseMcp({
      mcpServers: [
        { transport: "stdio", name: "a", command: "node" },
        { transport: "stdio", name: "b", command: "node" },
      ],
    }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("exactly one mcpServers entry"))).toBe(true);
  });

  test("entrypoint set on MCP manifest fails", () => {
    const r = validateMcpManifest(baseMcp({ entrypoint: "./should-not-exist.ts" }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("must not set entrypoint"))).toBe(true);
  });

  test("cached tools are allowed without entrypoint", () => {
    const r = validateMcpManifest(baseMcp({
      tools: [
        { name: "t", description: "d", inputSchema: { type: "object" } },
      ],
    }));
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  test("non-object input fails", () => {
    const r = validateMcpManifest(null);
    expect(r.valid).toBe(false);
  });

  test("transport-specific field error bubbles up from validateMcpServersArray", () => {
    const r = validateMcpManifest(baseMcp({
      mcpServers: [{ transport: "http", name: "r" }],
    }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("mcpServers[0].url"))).toBe(true);
  });
});
