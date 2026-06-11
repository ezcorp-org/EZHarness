import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ExtensionRegistry, type RegisteredTool } from "../extensions/registry";

function at<T>(arr: readonly T[], i: number, what: string): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected ${what} at index ${i}`);
  return v;
}

function makeTool(name: string, extName: string, extId: string, desc = "A tool"): RegisteredTool {
  // Registry uses `__` (double underscore) as the separator — Anthropic's
  // tool-name regex `^[a-zA-Z0-9_-]+$` forbids dots.
  const sep = name.indexOf("__");
  return {
    name,
    description: desc,
    inputSchema: { type: "object", properties: {} },
    extensionId: extId,
    extensionName: extName,
    originalName: sep >= 0 ? name.slice(sep + 2) : name,
  };
}

/** Mirrors the server-side mapping logic in +server.ts — must stay in lock
 *  step with the real handler. See the endpoint for the rationale on `__`. */
function mapTools(allTools: Array<{ name: string; description: string }>) {
  return allTools.map((t) => {
    const sep = t.name.indexOf("__");
    const extension = sep >= 0 ? t.name.slice(0, sep) : "unknown";
    const name = sep >= 0 ? t.name.slice(sep + 2) : t.name;
    const tokenEstimate = Math.ceil(JSON.stringify(t).length / 4);
    return { name, description: t.description, extension, tokenEstimate };
  });
}

describe("ExtensionRegistry.getAllTools() + endpoint mapping", () => {
  beforeEach(() => {
    ExtensionRegistry.resetInstance();
  });

  afterEach(() => {
    ExtensionRegistry.resetInstance();
  });

  test("getAllTools returns registered tools without internal fields", () => {
    const registry = ExtensionRegistry.getInstance();
    registry.registerToolForTest("analyzer__scan", makeTool("analyzer__scan", "analyzer", "ext-1", "Scan code"));
    const tools = registry.getAllTools();
    expect(tools).toHaveLength(1);
    const first = at(tools, 0, "tool");
    expect(first.name).toBe("analyzer__scan");
    expect(first.description).toBe("Scan code");
    // Should NOT have internal fields
    expect((tools[0] as any).extensionId).toBeUndefined();
    expect((tools[0] as any).extensionName).toBeUndefined();
    expect((tools[0] as any).originalName).toBeUndefined();
  });

  test("getAllTools returns empty array when no tools registered", () => {
    const registry = ExtensionRegistry.getInstance();
    expect(registry.getAllTools()).toEqual([]);
  });

  test("endpoint mapping splits `__`-namespaced name correctly", () => {
    const registry = ExtensionRegistry.getInstance();
    registry.registerToolForTest("analyzer__scan", makeTool("analyzer__scan", "analyzer", "ext-1"));
    registry.registerToolForTest("analyzer__lint", makeTool("analyzer__lint", "analyzer", "ext-1"));
    registry.registerToolForTest("md__summarize", makeTool("md__summarize", "md", "ext-2"));

    const mapped = mapTools(registry.getAllTools());
    expect(mapped).toHaveLength(3);

    const scan = mapped.find((t) => t.name === "scan")!;
    expect(scan.extension).toBe("analyzer");

    const summarize = mapped.find((t) => t.name === "summarize")!;
    expect(summarize.extension).toBe("md");
  });

  test("REGRESSION: splitter must be `__`, not `.` — names with `__` survive intact in `extension` field", () => {
    // This is the exact bug that made the team edit override panel's Allowed
    // Tools input look empty: `/api/tools` used `.indexOf(".")` while the
    // registry uses `__` as the separator, so every extension tool fell
    // through to `extension: "unknown"` and the frontend's
    // toolNamesByExtension map never matched any real extension name.
    const registry = ExtensionRegistry.getInstance();
    registry.registerToolForTest("analyzer__scan", makeTool("analyzer__scan", "analyzer", "ext-1"));

    const mapped = mapTools(registry.getAllTools());
    const scan = mapped.find((t) => t.name === "scan");
    expect(scan).toBeDefined();
    expect(scan!.extension).toBe("analyzer");
    // Negative assertion: must NOT fall through to "unknown".
    expect(scan!.extension).not.toBe("unknown");
    // And the raw `__`-joined form must NOT leak through as the inner name.
    expect(scan!.name).not.toContain("__");
  });

  test("mapping handles tool name without `__` separator", () => {
    const registry = ExtensionRegistry.getInstance();
    registry.registerToolForTest("nosep", makeTool("nosep", "unknown", "ext-x"));

    const mapped = mapTools(registry.getAllTools());
    const m0 = at(mapped, 0, "mapped tool");
    expect(m0.extension).toBe("unknown");
    expect(m0.name).toBe("nosep");
  });

  test("mapping splits on the FIRST `__` when the suffix contains more `__`", () => {
    const registry = ExtensionRegistry.getInstance();
    registry.registerToolForTest("ext__tool__v2", makeTool("ext__tool__v2", "ext", "ext-3"));

    const mapped = mapTools(registry.getAllTools());
    const m0 = at(mapped, 0, "mapped tool");
    expect(m0.extension).toBe("ext");
    expect(m0.name).toBe("tool__v2");
  });

  test("multiple tools from same extension all map correctly", () => {
    const registry = ExtensionRegistry.getInstance();
    registry.registerToolForTest("weather__forecast", makeTool("weather__forecast", "weather", "ext-w", "Get forecast"));
    registry.registerToolForTest("weather__alerts", makeTool("weather__alerts", "weather", "ext-w", "Get alerts"));
    registry.registerToolForTest("weather__radar", makeTool("weather__radar", "weather", "ext-w", "Get radar"));

    const mapped = mapTools(registry.getAllTools());
    const weatherTools = mapped.filter((t) => t.extension === "weather");
    expect(weatherTools).toHaveLength(3);
    expect(weatherTools.map((t) => t.name).sort()).toEqual(["alerts", "forecast", "radar"]);
  });

  test("tokenEstimate is computed from JSON.stringify length / 4", () => {
    const registry = ExtensionRegistry.getInstance();
    registry.registerToolForTest("analyzer__scan", makeTool("analyzer__scan", "analyzer", "ext-1", "Scan code"));
    const allTools = registry.getAllTools();
    const mapped = mapTools(allTools);
    const tool = mapped[0]!;
    const expected = Math.ceil(JSON.stringify(allTools[0]!).length / 4);
    expect(tool.tokenEstimate).toBe(expected);
    expect(tool.tokenEstimate).toBeGreaterThan(0);
  });

  test("response shape matches { tools, count }", () => {
    const registry = ExtensionRegistry.getInstance();
    registry.registerToolForTest("a__b", makeTool("a__b", "a", "e1"));
    registry.registerToolForTest("c__d", makeTool("c__d", "c", "e2"));

    const allTools = registry.getAllTools();
    const tools = mapTools(allTools);
    const response = { tools, count: tools.length };

    expect(response.count).toBe(2);
    expect(response.tools).toHaveLength(2);
    expect(response.tools[0]).toHaveProperty("name");
    expect(response.tools[0]).toHaveProperty("description");
    expect(response.tools[0]).toHaveProperty("extension");
  });
});

describe("ExtensionRegistry.getExtensionType()", () => {
  beforeEach(() => {
    ExtensionRegistry.resetInstance();
  });

  afterEach(() => {
    ExtensionRegistry.resetInstance();
  });

  test("returns 'mcp' when manifest has mcpServers", () => {
    const registry = ExtensionRegistry.getInstance();
    registry.setManifestForTest("ext-1", {
      name: "db-server",
      version: "1.0.0",
      permissions: {},
      mcpServers: [{ transport: "stdio", name: "db", command: "node", args: ["server.js"] }],
    } as any);
    expect(registry.getExtensionType("db-server")).toBe("mcp");
  });

  test("returns 'agent' when manifest has agent and no tools/skills", () => {
    const registry = ExtensionRegistry.getInstance();
    registry.setManifestForTest("ext-2", {
      name: "my-agent",
      version: "1.0.0",
      permissions: {},
      agent: { prompt: "You are helpful" },
    } as any);
    expect(registry.getExtensionType("my-agent")).toBe("agent");
  });

  test("returns 'extension' when manifest has tools", () => {
    const registry = ExtensionRegistry.getInstance();
    registry.setManifestForTest("ext-3", {
      name: "analyzer",
      version: "1.0.0",
      permissions: {},
      tools: [{ name: "scan", description: "Scan", inputSchema: {} }],
    } as any);
    expect(registry.getExtensionType("analyzer")).toBe("extension");
  });

  test("returns 'extension' for agent with tools", () => {
    const registry = ExtensionRegistry.getInstance();
    registry.setManifestForTest("ext-4", {
      name: "hybrid",
      version: "1.0.0",
      permissions: {},
      agent: { prompt: "hi" },
      tools: [{ name: "t", description: "T", inputSchema: {} }],
    } as any);
    expect(registry.getExtensionType("hybrid")).toBe("extension");
  });

  test("returns 'extension' for unknown extension name", () => {
    const registry = ExtensionRegistry.getInstance();
    expect(registry.getExtensionType("nonexistent")).toBe("extension");
  });
});

describe("ExtensionRegistry.getExtensionDescription()", () => {
  beforeEach(() => {
    ExtensionRegistry.resetInstance();
  });

  afterEach(() => {
    ExtensionRegistry.resetInstance();
  });

  test("returns the manifest description, looked up by manifest NAME", () => {
    const registry = ExtensionRegistry.getInstance();
    registry.setManifestForTest("ext-1", {
      name: "analyzer",
      version: "1.0.0",
      permissions: {},
      description: "Static analysis helpers",
    } as any);
    expect(registry.getExtensionDescription("analyzer")).toBe("Static analysis helpers");
  });

  test("undefined for an unknown extension or an empty description", () => {
    const registry = ExtensionRegistry.getInstance();
    expect(registry.getExtensionDescription("ghost")).toBeUndefined();
    registry.setManifestForTest("ext-2", {
      name: "bare",
      version: "1.0.0",
      permissions: {},
      description: "",
    } as any);
    expect(registry.getExtensionDescription("bare")).toBeUndefined();
  });
});
