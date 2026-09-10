import { describe, expect, test } from "bun:test";
import { formatInput, toolStatusColor, toolStatusIcon } from "./tool-display";

describe("tool display", () => {
  test("maps terminal statuses to the correct icon and color", () => {
    expect(toolStatusIcon("success")).toBe("✓");
    expect(toolStatusIcon("error")).toBe("✗");
    expect(toolStatusIcon("pending")).toBe("…");
    expect(toolStatusColor("success")).toBe("text-green-400");
    expect(toolStatusColor("error")).toBe("text-red-400");
    expect(toolStatusColor("running")).toBe("text-yellow-400");
  });

  test("formats null, primary tool fields in order, and structured fallback", () => {
    expect(formatInput(null)).toBe("");
    expect(formatInput({ command: "git status", file_path: "/ignored" })).toBe("git status");
    expect(formatInput({ file_path: "/a", path: "/b" })).toBe("/a");
    expect(formatInput({ path: "/b", pattern: "*.ts" })).toBe("/b");
    expect(formatInput({ pattern: "*.ts", query: "find", url: "https://example.test" })).toBe("*.ts");
    expect(formatInput({ query: "find", url: "https://example.test" })).toBe("find");
    expect(formatInput({ url: "https://example.test" })).toBe("https://example.test");
    expect(formatInput({ nested: { id: 1 } })).toBe('{\n  "nested": {\n    "id": 1\n  }\n}');
  });
});
