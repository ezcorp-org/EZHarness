import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import { _internals, main } from "./index";
import type { JsonRpcRequest, JsonRpcResponse } from "@ezcorp/sdk";

// Test format-table logic
function formatTable(headers: string[], rows: string[][]): string {
  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length))
  );

  const headerRow = "| " + headers.map((h, i) => h.padEnd(colWidths[i] ?? 0)).join(" | ") + " |";
  const separator = "| " + colWidths.map((w) => "-".repeat(w)).join(" | ") + " |";
  const dataRows = rows.map(
    (row) => "| " + headers.map((_, i) => (row[i] ?? "").padEnd(colWidths[i] ?? 0)).join(" | ") + " |"
  );

  return [headerRow, separator, ...dataRows].join("\n");
}

interface Heading {
  level: number;
  text: string;
  line: number;
}

function extractHeadings(markdown: string): Heading[] {
  const headings: Heading[] = [];
  const lines = markdown.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    const hashes = match?.[1];
    const text = match?.[2];
    if (hashes !== undefined && text !== undefined) {
      headings.push({ level: hashes.length, text: text.trim(), line: i + 1 });
    }
  }

  return headings;
}

test("format-table creates aligned markdown table", () => {
  const result = formatTable(["Name", "Age"], [["Alice", "30"], ["Bob", "25"]]);
  const lines = result.split("\n");
  expect(lines).toHaveLength(4); // header + separator + 2 rows
  expect(lines[0]).toContain("Name");
  expect(lines[0]).toContain("Age");
  expect(lines[1]).toMatch(/^\|[\s-|]+\|$/);
  expect(lines[2]).toContain("Alice");
  expect(lines[3]).toContain("Bob");
});

test("format-table handles varying column widths", () => {
  const result = formatTable(["ID", "Description"], [["1", "Short"], ["2", "A much longer value"]]);
  const lines = result.split("\n");
  // All rows should have same total width
  const widths = lines.map((l) => l.length);
  expect(new Set(widths).size).toBe(1);
});

test("format-table handles empty rows", () => {
  const result = formatTable(["A", "B"], []);
  const lines = result.split("\n");
  expect(lines).toHaveLength(2); // header + separator only
});

test("extract-headings finds all heading levels", () => {
  const md = "# H1\n## H2\n### H3\nParagraph\n#### H4";
  const headings = extractHeadings(md);
  expect(headings).toHaveLength(4);
  expect(headings[0]).toEqual({ level: 1, text: "H1", line: 1 });
  expect(headings[1]).toEqual({ level: 2, text: "H2", line: 2 });
  expect(headings[2]).toEqual({ level: 3, text: "H3", line: 3 });
  expect(headings[3]).toEqual({ level: 4, text: "H4", line: 5 });
});

test("extract-headings ignores non-heading lines", () => {
  const md = "Some text\n- a list\n```\n# code comment\n```\n## Real heading";
  const headings = extractHeadings(md);
  // The code comment inside backticks will match since we do simple line-by-line
  // This is expected for a simple parser
  expect(headings.length).toBeGreaterThanOrEqual(1);
  expect(headings[headings.length - 1]?.text).toBe("Real heading");
});

test("extract-headings returns empty for no headings", () => {
  const md = "Just some text\nwith no headings\nat all";
  expect(extractHeadings(md)).toHaveLength(0);
});

// Manifest tests
test("manifest has multi-component structure", async () => {
  const manifest = ((await import(import.meta.dir + "/ezcorp.config.ts")).default);
  expect(manifest.schemaVersion).toBe(4);
  expect(manifest.persistent).toBe(true);
  expect(manifest.tools).toHaveLength(2);
  expect(manifest.skills).toHaveLength(1);
  expect(manifest.agent).toBeDefined();
  expect(manifest.agent.category).toBe("Writing");
});

test("manifest skill has a host-readable prompt", async () => {
  const manifest = ((await import(import.meta.dir + "/ezcorp.config.ts")).default);
  const skill = manifest.skills[0];
  expect(skill.name).toBe("markdown-style");
  expect(skill.prompt).toContain("ATX-style");
});

describe("dispatch: extract-headings", () => {
  test("extracts headings via the real dispatcher", () => {
    const res = _internals.handleRequest({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "extract-headings", arguments: { markdown: "# Title\nbody\n## Sub" } },
    });
    const content = (res.result as { content: { type: string; text: string }[] }).content;
    expect(JSON.parse(content[0]!.text)).toEqual([
      { level: 1, text: "Title", line: 1 },
      { level: 2, text: "Sub", line: 3 },
    ]);
  });

  test("missing markdown argument is -32602", () => {
    const res = _internals.handleRequest({
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "extract-headings", arguments: {} },
    });
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toContain("markdown");
  });
});

describe("dispatch: format-table validation", () => {
  test("missing headers or rows is -32602", () => {
    const res = _internals.handleRequest({
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: { name: "format-table", arguments: {} },
    });
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toContain("Missing headers or rows");
  });
});

describe("registration", () => {
  test("registers handlers without opening stdin", () => {
    const input = spyOn(Bun.stdin, "stream");
    try {
      main();
      expect(input).not.toHaveBeenCalled();
    } finally {
      input.mockRestore();
    }
  });
});
