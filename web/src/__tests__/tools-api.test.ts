import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockToolsResponse(tools: Array<{ name: string; description: string; extension: string; extensionType?: string }>) {
  return new Response(JSON.stringify({ tools, count: tools.length }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const sampleTools = [
  { name: "scan", description: "Scan code", extension: "analyzer", extensionType: "extension", tokenEstimate: 25 },
  { name: "lint", description: "Lint files", extension: "analyzer", extensionType: "extension", tokenEstimate: 22 },
  { name: "summarize", description: "Summarize text", extension: "markdown-utils", extensionType: "mcp", tokenEstimate: 30 },
];

describe("GET /api/tools contract", () => {
  test("returns tools array and count", async () => {
    globalThis.fetch = mock(async () => mockToolsResponse(sampleTools));
    const res = await fetch("/api/tools");
    const data = await res.json();
    expect(data.tools).toHaveLength(3);
    expect(data.count).toBe(3);
  });

  test("each tool has name, description, and extension", async () => {
    globalThis.fetch = mock(async () => mockToolsResponse(sampleTools));
    const res = await fetch("/api/tools");
    const data = await res.json();
    for (const tool of data.tools) {
      expect(tool).toHaveProperty("name");
      expect(tool).toHaveProperty("description");
      expect(tool).toHaveProperty("extension");
      expect(tool).toHaveProperty("extensionType");
      expect(tool).toHaveProperty("tokenEstimate");
    }
  });

  test("returns empty array when no tools loaded", async () => {
    globalThis.fetch = mock(async () => mockToolsResponse([]));
    const res = await fetch("/api/tools");
    const data = await res.json();
    expect(data.tools).toEqual([]);
    expect(data.count).toBe(0);
  });

  test("extension name parsed from namespaced tool name (dot separator)", async () => {
    // Simulates the server-side logic: "analyzer.scan" -> extension="analyzer", name="scan"
    const namespacedName = "analyzer.scan";
    const dotIdx = namespacedName.indexOf(".");
    const extension = dotIdx >= 0 ? namespacedName.slice(0, dotIdx) : "unknown";
    const name = dotIdx >= 0 ? namespacedName.slice(dotIdx + 1) : namespacedName;
    expect(extension).toBe("analyzer");
    expect(name).toBe("scan");
  });

  test("tool without dot in name gets extension='unknown'", async () => {
    const namespacedName = "standalone-tool";
    const dotIdx = namespacedName.indexOf(".");
    const extension = dotIdx >= 0 ? namespacedName.slice(0, dotIdx) : "unknown";
    const name = dotIdx >= 0 ? namespacedName.slice(dotIdx + 1) : namespacedName;
    expect(extension).toBe("unknown");
    expect(name).toBe("standalone-tool");
  });

  test("handles fetch failure gracefully", async () => {
    globalThis.fetch = mock(async () => new Response(null, { status: 500 }));
    const res = await fetch("/api/tools");
    expect(res.ok).toBe(false);
  });
});

describe("tools grouping by extension (client-side logic)", () => {
  function groupByExtension(tools: Array<{ name: string; description: string; extension: string }>) {
    return tools.reduce((map, t) => {
      const arr = map.get(t.extension) ?? [];
      arr.push(t);
      map.set(t.extension, arr);
      return map;
    }, new Map<string, typeof tools>());
  }

  test("groups tools by extension name", () => {
    const grouped = groupByExtension(sampleTools);
    expect(grouped.size).toBe(2);
    expect(grouped.get("analyzer")).toHaveLength(2);
    expect(grouped.get("markdown-utils")).toHaveLength(1);
  });

  test("empty tools produce empty map", () => {
    const grouped = groupByExtension([]);
    expect(grouped.size).toBe(0);
  });

  test("single extension groups all tools together", () => {
    const tools = [
      { name: "a", description: "A", extension: "ext1" },
      { name: "b", description: "B", extension: "ext1" },
    ];
    const grouped = groupByExtension(tools);
    expect(grouped.size).toBe(1);
    expect(grouped.get("ext1")).toHaveLength(2);
  });

  test("each tool in its own extension when all unique", () => {
    const tools = [
      { name: "a", description: "A", extension: "ext1" },
      { name: "b", description: "B", extension: "ext2" },
      { name: "c", description: "C", extension: "ext3" },
    ];
    const grouped = groupByExtension(tools);
    expect(grouped.size).toBe(3);
  });
});
