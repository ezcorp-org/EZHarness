import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { createReadDirectoryTool } from "../runtime/tools/read-directory";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { resolve } from "path";
import { tmpdir } from "os";

function getText(result: any): string {
  return result.content[0].text;
}

let projectPath: string;

beforeAll(async () => {
  projectPath = await mkdtemp(resolve(tmpdir(), "read-directory-test-"));
  // Tree:
  //   package.json
  //   src/
  //     index.ts
  //     inner/
  //       deep.txt
  //   node_modules/        (excluded)
  //   .git/                (excluded)
  //   .env                 (excluded)
  await writeFile(resolve(projectPath, "package.json"), "{}");
  await mkdir(resolve(projectPath, "src/inner"), { recursive: true });
  await writeFile(resolve(projectPath, "src/index.ts"), "");
  await writeFile(resolve(projectPath, "src/inner/deep.txt"), "");
  await mkdir(resolve(projectPath, "node_modules"));
  await mkdir(resolve(projectPath, ".git"));
  await writeFile(resolve(projectPath, ".env"), "SECRET=x");
});

afterAll(async () => {
  await rm(projectPath, { recursive: true, force: true });
});

describe("createReadDirectoryTool", () => {
  test("renders a tree with unicode connectors for dirs and files", async () => {
    const tool = createReadDirectoryTool(projectPath);
    const result = await tool.execute("1", { path: "." });
    const text = getText(result);
    expect(text).toContain("src/");
    expect(text).toContain("package.json");
    expect(text).toMatch(/[├└]── /);
  });

  test("excludes node_modules, .git, and dotfiles", async () => {
    const tool = createReadDirectoryTool(projectPath);
    const result = await tool.execute("1", { path: "." });
    const text = getText(result);
    expect(text).not.toContain("node_modules");
    expect(text).not.toContain(".git");
    expect(text).not.toContain(".env");
  });

  test("respects depth=1 and hides files nested below the first level", async () => {
    const tool = createReadDirectoryTool(projectPath);
    const result = await tool.execute("1", { depth: 1 });
    const text = getText(result);
    expect(text).toContain("src/");
    // depth 1 should NOT show files inside src/
    expect(text).not.toContain("index.ts");
  });

  test("clamps depth above 3 down to 3", async () => {
    const tool = createReadDirectoryTool(projectPath);
    const result = await tool.execute("1", { depth: 99 });
    const text = getText(result);
    // level 1: src/, level 2: inner/, level 3: deep.txt — all visible
    expect(text).toContain("deep.txt");
  });

  test("returns '(empty directory)' for a directory with only hidden files", async () => {
    await mkdir(resolve(projectPath, "onlyhidden"));
    await writeFile(resolve(projectPath, "onlyhidden/.gitkeep"), "");
    const tool = createReadDirectoryTool(projectPath);
    const result = await tool.execute("1", { path: "onlyhidden" });
    expect(getText(result)).toBe("(empty directory)");
  });

  test("rejects path traversal", async () => {
    const tool = createReadDirectoryTool(projectPath);
    const result = await tool.execute("1", { path: "../../" });
    expect(getText(result)).toContain("Path traversal");
    expect(result.details.isError).toBe(true);
  });
});
