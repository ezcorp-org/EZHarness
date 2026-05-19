import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { createGlobTool } from "../runtime/tools/glob";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { resolve } from "path";
import { tmpdir } from "os";

function getText(result: any): string {
  return result.content[0].text;
}

let projectPath: string;

beforeAll(async () => {
  projectPath = await mkdtemp(resolve(tmpdir(), "glob-test-"));
  await mkdir(resolve(projectPath, "src/components"), { recursive: true });
  await writeFile(resolve(projectPath, "src/index.ts"), "");
  await writeFile(resolve(projectPath, "src/utils.ts"), "");
  await writeFile(resolve(projectPath, "src/components/Button.svelte"), "");
  await writeFile(resolve(projectPath, "readme.md"), "");
});

afterAll(async () => {
  await rm(projectPath, { recursive: true, force: true });
});

describe("createGlobTool", () => {
  test("finds files matching a **/*.ts pattern and excludes other types", async () => {
    const tool = createGlobTool(projectPath);
    const result = await tool.execute("1", { pattern: "**/*.ts" });
    const text = getText(result);
    expect(text).toContain("index.ts");
    expect(text).toContain("utils.ts");
    expect(text).not.toContain("Button.svelte");
    expect(text).not.toContain("readme.md");
    expect(result.details.fileCount).toBe(2);
    expect(result.details.truncated).toBe(false);
  });

  test("returns a 'no files found' message for patterns with no matches", async () => {
    const tool = createGlobTool(projectPath);
    const result = await tool.execute("1", { pattern: "**/*.nonexistentext" });
    expect(getText(result)).toContain("No files found");
    expect(result.details.fileCount).toBe(0);
  });

  test("respects maxResults and flags truncated in details", async () => {
    const tool = createGlobTool(projectPath);
    const result = await tool.execute("1", { pattern: "**/*", maxResults: 2 });
    expect(result.details.truncated).toBe(true);
    expect(result.details.fileCount).toBe(2);
    expect(getText(result)).toContain("[truncated at 2 results]");
  });

  test("returns results sorted alphabetically", async () => {
    const tool = createGlobTool(projectPath);
    const result = await tool.execute("1", { pattern: "src/*.ts" });
    const lines = getText(result).split("\n").filter((l) => l.length > 0 && !l.startsWith("["));
    // Alphabetical: index.ts before utils.ts
    const indexIdx = lines.findIndex((l) => l.endsWith("index.ts"));
    const utilsIdx = lines.findIndex((l) => l.endsWith("utils.ts"));
    expect(indexIdx).toBeGreaterThanOrEqual(0);
    expect(indexIdx).toBeLessThan(utilsIdx);
  });

  test("rejects path traversal in the search path", async () => {
    const tool = createGlobTool(projectPath);
    const result = await tool.execute("1", { pattern: "*.ts", path: "../.." });
    expect(getText(result)).toContain("Path traversal");
    expect(result.details.isError).toBe(true);
  });
});
