import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { createListFilesTool } from "../runtime/tools/list-files";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { resolve } from "path";
import { tmpdir } from "os";

function getText(result: any): string {
  return result.content[0].text;
}

let projectPath: string;

beforeAll(async () => {
  projectPath = await mkdtemp(resolve(tmpdir(), "list-files-test-"));
  await writeFile(resolve(projectPath, "a.ts"), "");
  await writeFile(resolve(projectPath, "b.js"), "");
  await writeFile(resolve(projectPath, "c.ts"), "");
  await mkdir(resolve(projectPath, "src"));
  await mkdir(resolve(projectPath, "empty"));
});

afterAll(async () => {
  await rm(projectPath, { recursive: true, force: true });
});

describe("createListFilesTool", () => {
  test("lists files and directories with a trailing slash for dirs", async () => {
    const tool = createListFilesTool(projectPath);
    const result = await tool.execute("1", { path: "." });
    const text = getText(result);
    expect(text).toContain("a.ts");
    expect(text).toContain("b.js");
    expect(text).toContain("c.ts");
    expect(text).toContain("src/");
  });

  test("defaults to the project root when path is omitted", async () => {
    const tool = createListFilesTool(projectPath);
    const result = await tool.execute("1", {});
    expect(getText(result)).toContain("a.ts");
  });

  test("filters results by glob pattern", async () => {
    const tool = createListFilesTool(projectPath);
    const result = await tool.execute("1", { path: ".", pattern: "*.ts" });
    const text = getText(result);
    expect(text).toContain("a.ts");
    expect(text).toContain("c.ts");
    expect(text).not.toContain("b.js");
  });

  test("returns '(empty directory)' for an empty directory", async () => {
    const tool = createListFilesTool(projectPath);
    const result = await tool.execute("1", { path: "empty" });
    expect(getText(result)).toBe("(empty directory)");
  });

  test("rejects path traversal", async () => {
    const tool = createListFilesTool(projectPath);
    const result = await tool.execute("1", { path: "../.." });
    expect(getText(result)).toContain("Path traversal");
    expect(result.details.isError).toBe(true);
  });

  test("returns an error for a nonexistent directory", async () => {
    const tool = createListFilesTool(projectPath);
    const result = await tool.execute("1", { path: "nonexistent" });
    expect(getText(result)).toContain("Error:");
    expect(result.details.isError).toBe(true);
  });
});
