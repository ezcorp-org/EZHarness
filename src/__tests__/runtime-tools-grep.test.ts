import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { createGrepTool } from "../runtime/tools/grep";
import { TOOL_OUTPUT_LIMITS } from "../runtime/tools/output-limits";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { resolve } from "path";
import { tmpdir } from "os";

function getText(result: any): string {
  return result.content[0].text;
}

let projectPath: string;

beforeAll(async () => {
  projectPath = await mkdtemp(resolve(tmpdir(), "grep-test-"));
  await mkdir(resolve(projectPath, "src"), { recursive: true });
  await writeFile(
    resolve(projectPath, "src/hello.ts"),
    "const greeting = 'Hello World';\nconst farewell = 'Goodbye World';",
  );
  await writeFile(
    resolve(projectPath, "src/utils.ts"),
    "export function hello() { return 'hello'; }\nexport function HELLO() { return 'HELLO'; }",
  );
  await writeFile(resolve(projectPath, "readme.txt"), "This has no matching content.");
});

afterAll(async () => {
  await rm(projectPath, { recursive: true, force: true });
});

describe("createGrepTool", () => {
  test("finds matches across files and reports a positive matchCount", async () => {
    const tool = createGrepTool(projectPath);
    const result = await tool.execute("1", { pattern: "hello", path: "." });
    expect(result.details.matchCount).toBeGreaterThan(0);
    expect(getText(result)).toContain("hello");
    expect(result.details.pattern).toBe("hello");
  });

  test("returns 'No matches found.' when nothing matches", async () => {
    const tool = createGrepTool(projectPath);
    const result = await tool.execute("1", { pattern: "zzz_never_present_zzz", path: "." });
    expect(getText(result)).toContain("No matches found");
    expect(result.details.matchCount).toBe(0);
  });

  test("case-insensitive search finds more hits than case-sensitive", async () => {
    const tool = createGrepTool(projectPath);
    const sensitive = await tool.execute("1", { pattern: "hello", path: "src", caseSensitive: true });
    const insensitive = await tool.execute("1", { pattern: "hello", path: "src", caseSensitive: false });
    expect(insensitive.details.matchCount).toBeGreaterThan(sensitive.details.matchCount);
  });

  test("rejects path traversal", async () => {
    const tool = createGrepTool(projectPath);
    const result = await tool.execute("1", { pattern: "hello", path: "../.." });
    expect(getText(result)).toContain("Path traversal");
    expect(result.details.isError).toBe(true);
  });

  test("truncates output exceeding the grep cap and flags details.truncated", async () => {
    const longLine = "needle " + "x".repeat(2000);
    const content = Array.from({ length: 50 }, () => longLine).join("\n");
    await writeFile(resolve(projectPath, "hits.txt"), content);

    const originalCap = TOOL_OUTPUT_LIMITS.grep;
    TOOL_OUTPUT_LIMITS.grep = 4 * 1024; // 4 KB
    try {
      const tool = createGrepTool(projectPath);
      const result = await tool.execute("1", { pattern: "needle", path: "." });
      const text = getText(result);
      expect(text).toContain("[output truncated:");
      expect(text).toContain("grep cap is 4 KB");
      expect(result.details.truncated).toBe(true);
      expect(result.details.matchCount).toBeGreaterThan(0);
    } finally {
      if (originalCap === undefined) delete TOOL_OUTPUT_LIMITS.grep;
      else TOOL_OUTPUT_LIMITS.grep = originalCap;
    }
  });
});
