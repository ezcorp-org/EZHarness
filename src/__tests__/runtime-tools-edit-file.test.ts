import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createEditFileTool } from "../runtime/tools/edit-file";
import { mkdtemp, writeFile, readFile as fsReadFile, rm } from "fs/promises";
import { resolve } from "path";
import { tmpdir } from "os";

function getText(result: any): string {
  return result.content[0].text;
}

let projectPath: string;

beforeEach(async () => {
  projectPath = await mkdtemp(resolve(tmpdir(), "edit-file-test-"));
});

afterEach(async () => {
  await rm(projectPath, { recursive: true, force: true });
});

describe("createEditFileTool", () => {
  test("creates a new file when old_string is omitted and mkdirs parents", async () => {
    const tool = createEditFileTool(projectPath);
    const result = await tool.execute("1", { path: "a/b/c.txt", new_string: "deep" });
    expect(getText(result)).toContain("Created/overwrote a/b/c.txt");
    expect(await fsReadFile(resolve(projectPath, "a/b/c.txt"), "utf-8")).toBe("deep");
  });

  test("performs single search-and-replace when old_string is unique", async () => {
    await writeFile(resolve(projectPath, "f.txt"), "hello world");
    const tool = createEditFileTool(projectPath);
    const result = await tool.execute("1", { path: "f.txt", old_string: "world", new_string: "earth" });
    expect(getText(result)).toContain("Replaced in f.txt");
    expect(await fsReadFile(resolve(projectPath, "f.txt"), "utf-8")).toBe("hello earth");
  });

  test("errors without replace_all when old_string matches multiple times", async () => {
    await writeFile(resolve(projectPath, "f.txt"), "foo bar foo baz foo");
    const tool = createEditFileTool(projectPath);
    const result = await tool.execute("1", { path: "f.txt", old_string: "foo", new_string: "qux" });
    expect(getText(result)).toContain("found 3 times");
    expect(result.details.isError).toBe(true);
    // File must be unchanged on error.
    expect(await fsReadFile(resolve(projectPath, "f.txt"), "utf-8")).toBe("foo bar foo baz foo");
  });

  test("replaces every occurrence when replace_all is true", async () => {
    await writeFile(resolve(projectPath, "f.txt"), "foo bar foo baz foo");
    const tool = createEditFileTool(projectPath);
    const result = await tool.execute("1", { path: "f.txt", old_string: "foo", new_string: "qux", replace_all: true });
    expect(getText(result)).toContain("Replaced 3 occurrences");
    expect(await fsReadFile(resolve(projectPath, "f.txt"), "utf-8")).toBe("qux bar qux baz qux");
  });

  test("errors when old_string is an empty string", async () => {
    await writeFile(resolve(projectPath, "f.txt"), "x");
    const tool = createEditFileTool(projectPath);
    const result = await tool.execute("1", { path: "f.txt", old_string: "", new_string: "y" });
    expect(getText(result)).toContain("old_string is empty");
    expect(result.details.isError).toBe(true);
  });

  test("errors when the file does not exist in replace mode", async () => {
    const tool = createEditFileTool(projectPath);
    const result = await tool.execute("1", { path: "missing.txt", old_string: "a", new_string: "b" });
    expect(getText(result)).toContain("file not found");
    expect(result.details.isError).toBe(true);
  });

  test("rejects path traversal during create", async () => {
    const tool = createEditFileTool(projectPath);
    const result = await tool.execute("1", { path: "../../etc/passwd", new_string: "pwn" });
    expect(getText(result)).toContain("Path traversal");
    expect(result.details.isError).toBe(true);
  });

  test("replaces a line range in-place", async () => {
    await writeFile(resolve(projectPath, "f.txt"), "a\nb\nc\nd");
    const tool = createEditFileTool(projectPath);
    const result = await tool.execute("1", {
      path: "f.txt",
      new_string: "B\nC",
      lineRange: { startLine: 2, endLine: 3 },
    });
    expect(getText(result)).toContain("Replaced lines 2-3");
    expect(await fsReadFile(resolve(projectPath, "f.txt"), "utf-8")).toBe("a\nB\nC\nd");
  });
});
