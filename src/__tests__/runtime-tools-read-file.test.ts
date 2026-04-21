import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { createReadFileTool } from "../runtime/tools/read-file";
import { TOOL_OUTPUT_LIMITS } from "../runtime/tools/output-limits";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { resolve } from "path";
import { tmpdir } from "os";

function getText(result: any): string {
  return result.content[0].text;
}

let projectPath: string;

beforeAll(async () => {
  projectPath = await mkdtemp(resolve(tmpdir(), "read-file-test-"));
  await mkdir(resolve(projectPath, "sub"), { recursive: true });
  await writeFile(resolve(projectPath, "hello.txt"), "hello world");
  await writeFile(resolve(projectPath, "sub/nested.json"), '{"ok": true}');
});

afterAll(async () => {
  await rm(projectPath, { recursive: true, force: true });
});

describe("createReadFileTool", () => {
  test("returns the file contents for a path inside the project", async () => {
    const tool = createReadFileTool(projectPath);
    const result = await tool.execute("1", { path: "hello.txt" });
    expect(getText(result)).toBe("hello world");
    expect(result.details.isError).toBeUndefined();
  });

  test("reads files inside nested subdirectories", async () => {
    const tool = createReadFileTool(projectPath);
    const result = await tool.execute("1", { path: "sub/nested.json" });
    expect(getText(result)).toBe('{"ok": true}');
  });

  test("returns an error result when the file does not exist", async () => {
    const tool = createReadFileTool(projectPath);
    const result = await tool.execute("1", { path: "nope.txt" });
    expect(getText(result)).toContain("Error:");
    expect(result.details.isError).toBe(true);
  });

  test("rejects path traversal with ../", async () => {
    const tool = createReadFileTool(projectPath);
    const result = await tool.execute("1", { path: "../../etc/passwd" });
    expect(getText(result)).toContain("Path traversal");
    expect(result.details.isError).toBe(true);
  });

  test("truncates files larger than the readFile cap and flags details.truncated", async () => {
    // Temporarily lower the readFile cap so we don't have to write multi-MB to disk.
    const originalCap = TOOL_OUTPUT_LIMITS.readFile;
    TOOL_OUTPUT_LIMITS.readFile = 4 * 1024; // 4 KB
    try {
      await writeFile(resolve(projectPath, "big.txt"), "A".repeat(10 * 1024));
      const tool = createReadFileTool(projectPath);
      const result = await tool.execute("1", { path: "big.txt" });
      const text = getText(result);
      expect(text).toContain("[output truncated:");
      expect(text).toContain("readFile cap is 4 KB");
      expect(result.details.truncated).toBe(true);
      expect(result.details.originalBytes).toBe(10 * 1024);
    } finally {
      if (originalCap === undefined) delete TOOL_OUTPUT_LIMITS.readFile;
      else TOOL_OUTPUT_LIMITS.readFile = originalCap;
    }
  });
});
