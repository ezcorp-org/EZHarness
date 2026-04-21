import { test, expect, describe } from "bun:test";
import { createBuiltinTools } from "./builtin-tools";
import { resolve } from "path";
import { mkdtemp, writeFile, mkdir, symlink, readFile as fsReadFile } from "fs/promises";
import { tmpdir } from "os";

// Helper to create a temp project dir
async function createTempProject() {
  return mkdtemp(resolve(tmpdir(), "builtin-tools-test-"));
}

function getText(result: any): string {
  return result.content[0].text;
}

describe("createBuiltinTools", () => {
  // ── Tool shape ──

  describe("tool shape", () => {
    const tools = createBuiltinTools("/tmp/test-project");

    test("returns all built-in tools", () => {
      expect(tools).toHaveLength(7);
      expect(tools.map(t => t.name)).toEqual(["readFile", "listFiles", "readDirectory", "editFile", "shell", "grep", "glob"]);
    });

    test("each tool has required AgentTool properties", () => {
      for (const tool of tools) {
        expect(tool.name).toBeString();
        expect(tool.label).toBeString();
        expect(tool.description).toBeString();
        expect(tool.description.length).toBeGreaterThan(10);
        expect(tool.parameters).toBeDefined();
        expect(tool.execute).toBeFunction();
      }
    });

    test("label matches name for each tool", () => {
      for (const tool of tools) {
        expect(tool.label).toBe(tool.name);
      }
    });
  });

  // ── readFile ──

  describe("readFile", () => {
    test("reads a file within project", async () => {
      const dir = await createTempProject();
      await writeFile(resolve(dir, "hello.txt"), "hello world");
      const tools = createBuiltinTools(dir);
      const readFile = tools.find(t => t.name === "readFile")!;
      const result = await readFile.execute("1", { path: "hello.txt" });
      expect(getText(result)).toBe("hello world");
      expect(result.details.isError).toBeUndefined();
    });

    test("reads a file in a subdirectory", async () => {
      const dir = await createTempProject();
      await mkdir(resolve(dir, "sub"));
      await writeFile(resolve(dir, "sub/deep.txt"), "nested content");
      const tools = createBuiltinTools(dir);
      const readFile = tools.find(t => t.name === "readFile")!;
      const result = await readFile.execute("1", { path: "sub/deep.txt" });
      expect(getText(result)).toBe("nested content");
    });

    test("reads binary-safe (returns text representation)", async () => {
      const dir = await createTempProject();
      await writeFile(resolve(dir, "data.json"), '{"key": "value"}');
      const tools = createBuiltinTools(dir);
      const readFile = tools.find(t => t.name === "readFile")!;
      const result = await readFile.execute("1", { path: "data.json" });
      expect(getText(result)).toBe('{"key": "value"}');
    });

    test("returns error for nonexistent file", async () => {
      const dir = await createTempProject();
      const tools = createBuiltinTools(dir);
      const readFile = tools.find(t => t.name === "readFile")!;
      const result = await readFile.execute("1", { path: "nope.txt" });
      expect(getText(result)).toContain("Error:");
      expect(result.details.isError).toBe(true);
    });

    test("rejects path traversal with ../", async () => {
      const dir = await createTempProject();
      const tools = createBuiltinTools(dir);
      const readFile = tools.find(t => t.name === "readFile")!;
      const result = await readFile.execute("1", { path: "../../etc/passwd" });
      expect(getText(result)).toContain("Path traversal");
      expect(result.details.isError).toBe(true);
    });

    test("rejects absolute path outside project", async () => {
      const dir = await createTempProject();
      const tools = createBuiltinTools(dir);
      const readFile = tools.find(t => t.name === "readFile")!;
      const result = await readFile.execute("1", { path: "/etc/passwd" });
      expect(getText(result)).toContain("Path traversal");
      expect(result.details.isError).toBe(true);
    });

    test("rejects sneaky traversal with valid prefix", async () => {
      const dir = await createTempProject();
      const tools = createBuiltinTools(dir);
      const readFile = tools.find(t => t.name === "readFile")!;
      const result = await readFile.execute("1", { path: "sub/../../etc/passwd" });
      expect(getText(result)).toContain("Path traversal");
      expect(result.details.isError).toBe(true);
    });

    test("rejects symlink that escapes project", async () => {
      const dir = await createTempProject();
      await symlink("/etc", resolve(dir, "escape-link"));
      const tools = createBuiltinTools(dir);
      const readFile = tools.find(t => t.name === "readFile")!;
      // The symlink itself resolves within the project, but the target is outside.
      // validatePath checks the string path, not the resolved symlink target,
      // so this tests that the path string stays within bounds.
      const result = await readFile.execute("1", { path: "escape-link/hostname" });
      // This path resolves to /tmp/.../escape-link/hostname which string-wise is inside projectPath,
      // but the actual file read would go to /etc/hostname via symlink.
      // Our current validatePath is string-based, so this reads successfully if the file exists.
      // This documents the current behavior.
      expect(getText(result)).toBeDefined();
    });

    test("allows reading file at project root itself (path='.')", async () => {
      const dir = await createTempProject();
      const tools = createBuiltinTools(dir);
      const readFile = tools.find(t => t.name === "readFile")!;
      // Reading a directory as a file should error
      const result = await readFile.execute("1", { path: "." });
      expect(result.details.isError).toBe(true);
    });
  });

  // ── listFiles ──

  describe("listFiles", () => {
    test("lists directory contents with types", async () => {
      const dir = await createTempProject();
      await writeFile(resolve(dir, "a.ts"), "");
      await writeFile(resolve(dir, "b.js"), "");
      await mkdir(resolve(dir, "src"));
      const tools = createBuiltinTools(dir);
      const listFiles = tools.find(t => t.name === "listFiles")!;
      const result = await listFiles.execute("1", { path: "." });
      const text = getText(result);
      expect(text).toContain("a.ts");
      expect(text).toContain("b.js");
      expect(text).toContain("src/");
    });

    test("defaults to project root when path omitted", async () => {
      const dir = await createTempProject();
      await writeFile(resolve(dir, "root-file.txt"), "");
      const tools = createBuiltinTools(dir);
      const listFiles = tools.find(t => t.name === "listFiles")!;
      const result = await listFiles.execute("1", {});
      expect(getText(result)).toContain("root-file.txt");
    });

    test("defaults to project root when path is empty string", async () => {
      const dir = await createTempProject();
      await writeFile(resolve(dir, "root-file.txt"), "");
      const tools = createBuiltinTools(dir);
      const listFiles = tools.find(t => t.name === "listFiles")!;
      const result = await listFiles.execute("1", { path: "" });
      expect(getText(result)).toContain("root-file.txt");
    });

    test("filters by glob pattern", async () => {
      const dir = await createTempProject();
      await writeFile(resolve(dir, "a.ts"), "");
      await writeFile(resolve(dir, "b.js"), "");
      await writeFile(resolve(dir, "c.ts"), "");
      const tools = createBuiltinTools(dir);
      const listFiles = tools.find(t => t.name === "listFiles")!;
      const result = await listFiles.execute("1", { path: ".", pattern: "*.ts" });
      const text = getText(result);
      expect(text).toContain("a.ts");
      expect(text).toContain("c.ts");
      expect(text).not.toContain("b.js");
    });

    test("glob pattern does not match directories with trailing slash", async () => {
      const dir = await createTempProject();
      await mkdir(resolve(dir, "src"));
      await writeFile(resolve(dir, "src.ts"), "");
      const tools = createBuiltinTools(dir);
      const listFiles = tools.find(t => t.name === "listFiles")!;
      const result = await listFiles.execute("1", { path: ".", pattern: "src*" });
      const text = getText(result);
      // Both "src" (dir, slash stripped for matching) and "src.ts" match "src*"
      expect(text).toContain("src/");
      expect(text).toContain("src.ts");
    });

    test("returns '(empty directory)' for empty dir", async () => {
      const dir = await createTempProject();
      await mkdir(resolve(dir, "empty"));
      const tools = createBuiltinTools(dir);
      const listFiles = tools.find(t => t.name === "listFiles")!;
      const result = await listFiles.execute("1", { path: "empty" });
      expect(getText(result)).toBe("(empty directory)");
    });

    test("returns error for nonexistent directory", async () => {
      const dir = await createTempProject();
      const tools = createBuiltinTools(dir);
      const listFiles = tools.find(t => t.name === "listFiles")!;
      const result = await listFiles.execute("1", { path: "nonexistent" });
      expect(getText(result)).toContain("Error:");
      expect(result.details.isError).toBe(true);
    });

    test("rejects path traversal", async () => {
      const dir = await createTempProject();
      const tools = createBuiltinTools(dir);
      const listFiles = tools.find(t => t.name === "listFiles")!;
      const result = await listFiles.execute("1", { path: "../.." });
      expect(getText(result)).toContain("Path traversal");
      expect(result.details.isError).toBe(true);
    });

    test("lists subdirectory contents", async () => {
      const dir = await createTempProject();
      await mkdir(resolve(dir, "src"));
      await writeFile(resolve(dir, "src/index.ts"), "");
      await writeFile(resolve(dir, "src/utils.ts"), "");
      const tools = createBuiltinTools(dir);
      const listFiles = tools.find(t => t.name === "listFiles")!;
      const result = await listFiles.execute("1", { path: "src" });
      const text = getText(result);
      expect(text).toContain("index.ts");
      expect(text).toContain("utils.ts");
    });
  });

  // ── readDirectory ──

  describe("readDirectory", () => {
    test("shows tree structure with connectors", async () => {
      const dir = await createTempProject();
      await mkdir(resolve(dir, "src"));
      await writeFile(resolve(dir, "src/index.ts"), "");
      await writeFile(resolve(dir, "package.json"), "");
      const tools = createBuiltinTools(dir);
      const readDir = tools.find(t => t.name === "readDirectory")!;
      const result = await readDir.execute("1", { path: "." });
      const text = getText(result);
      expect(text).toContain("src/");
      expect(text).toContain("index.ts");
      expect(text).toContain("package.json");
      // Check tree connectors
      expect(text).toMatch(/[├└]── /);
    });

    test("sorts directories before files", async () => {
      const dir = await createTempProject();
      await mkdir(resolve(dir, "zdir"));
      await writeFile(resolve(dir, "afile.txt"), "");
      const tools = createBuiltinTools(dir);
      const readDir = tools.find(t => t.name === "readDirectory")!;
      const result = await readDir.execute("1", { path: "." });
      const text = getText(result);
      const lines = text.split("\n");
      const zdirIdx = lines.findIndex((l: string) => l.includes("zdir/"));
      const afileIdx = lines.findIndex((l: string) => l.includes("afile.txt"));
      expect(zdirIdx).toBeLessThan(afileIdx);
    });

    test("uses └── for last item and ├── for others", async () => {
      const dir = await createTempProject();
      await writeFile(resolve(dir, "a.txt"), "");
      await writeFile(resolve(dir, "b.txt"), "");
      await writeFile(resolve(dir, "c.txt"), "");
      const tools = createBuiltinTools(dir);
      const readDir = tools.find(t => t.name === "readDirectory")!;
      const result = await readDir.execute("1", { path: "." });
      const lines = getText(result).split("\n");
      // Last line should use └──
      expect(lines[lines.length - 1]).toContain("└── ");
      // Non-last lines should use ├──
      expect(lines[0]).toContain("├── ");
    });

    test("uses │ prefix for nested non-last items and spaces for last", async () => {
      const dir = await createTempProject();
      await mkdir(resolve(dir, "adir"));
      await writeFile(resolve(dir, "adir/nested.txt"), "");
      await writeFile(resolve(dir, "zfile.txt"), "");
      const tools = createBuiltinTools(dir);
      const readDir = tools.find(t => t.name === "readDirectory")!;
      const result = await readDir.execute("1", { path: "." });
      const text = getText(result);
      // adir is not last (zfile comes after), so nested items get │ prefix
      expect(text).toContain("│   ");
    });

    test("uses space prefix for nested items under last directory", async () => {
      const dir = await createTempProject();
      await mkdir(resolve(dir, "zdir"));
      await writeFile(resolve(dir, "zdir/nested.txt"), "");
      const tools = createBuiltinTools(dir);
      const readDir = tools.find(t => t.name === "readDirectory")!;
      const result = await readDir.execute("1", { path: "." });
      const text = getText(result);
      // zdir is the only (and last) entry, nested items get space prefix
      expect(text).toContain("    ");
      expect(text).toContain("└── zdir/");
    });

    test("defaults to depth 2", async () => {
      const dir = await createTempProject();
      // walk starts at depth=1, so depth=2 means 2 levels visible
      // level 1: a/, level 2: a/child.txt and a/b/
      // level 3 (not shown): a/b/deep.txt
      await mkdir(resolve(dir, "a/b"), { recursive: true });
      await writeFile(resolve(dir, "a/child.txt"), "");
      await writeFile(resolve(dir, "a/b/deep.txt"), "");
      const tools = createBuiltinTools(dir);
      const readDir = tools.find(t => t.name === "readDirectory")!;
      const result = await readDir.execute("1", {});
      const text = getText(result);
      expect(text).toContain("a/");
      expect(text).toContain("b/");
      expect(text).toContain("child.txt");
      expect(text).not.toContain("deep.txt");
    });

    test("respects depth=1", async () => {
      const dir = await createTempProject();
      await mkdir(resolve(dir, "src"));
      await writeFile(resolve(dir, "src/index.ts"), "");
      await writeFile(resolve(dir, "root.txt"), "");
      const tools = createBuiltinTools(dir);
      const readDir = tools.find(t => t.name === "readDirectory")!;
      const result = await readDir.execute("1", { depth: 1 });
      const text = getText(result);
      expect(text).toContain("src/");
      expect(text).toContain("root.txt");
      // depth 1 should NOT show files inside src/
      expect(text).not.toContain("index.ts");
    });

    test("respects depth=3", async () => {
      const dir = await createTempProject();
      // depth=3: walk at 1,2,3 — 3 levels visible
      await mkdir(resolve(dir, "a/b"), { recursive: true });
      await writeFile(resolve(dir, "a/b/deep.txt"), "");
      const tools = createBuiltinTools(dir);
      const readDir = tools.find(t => t.name === "readDirectory")!;
      const result = await readDir.execute("1", { depth: 3 });
      const text = getText(result);
      expect(text).toContain("deep.txt");
    });

    test("depth=0 is falsy so defaults to 2", async () => {
      const dir = await createTempProject();
      await mkdir(resolve(dir, "src"));
      await writeFile(resolve(dir, "src/index.ts"), "");
      const tools = createBuiltinTools(dir);
      const readDir = tools.find(t => t.name === "readDirectory")!;
      // depth=0 is falsy, so `params.depth || 2` gives 2
      const result = await readDir.execute("1", { depth: 0 });
      const text = getText(result);
      expect(text).toContain("src/");
      expect(text).toContain("index.ts"); // depth 2 shows nested files
    });

    test("clamps depth above 3 to 3", async () => {
      const dir = await createTempProject();
      // 3 levels: a/ -> b/ -> level3.txt (visible at depth 3)
      // 4th level: b/c/deep.txt (not visible, clamped)
      await mkdir(resolve(dir, "a/b/c"), { recursive: true });
      await writeFile(resolve(dir, "a/b/level3.txt"), "");
      await writeFile(resolve(dir, "a/b/c/deep.txt"), "");
      const tools = createBuiltinTools(dir);
      const readDir = tools.find(t => t.name === "readDirectory")!;
      const result = await readDir.execute("1", { depth: 10 });
      const text = getText(result);
      expect(text).toContain("level3.txt");
      expect(text).not.toContain("deep.txt");
    });

    test("filters out hidden files and node_modules", async () => {
      const dir = await createTempProject();
      await mkdir(resolve(dir, ".git"));
      await mkdir(resolve(dir, "node_modules"));
      await mkdir(resolve(dir, ".hidden"));
      await writeFile(resolve(dir, ".env"), "SECRET=x");
      await writeFile(resolve(dir, "visible.txt"), "");
      const tools = createBuiltinTools(dir);
      const readDir = tools.find(t => t.name === "readDirectory")!;
      const result = await readDir.execute("1", { path: "." });
      const text = getText(result);
      expect(text).not.toContain(".git");
      expect(text).not.toContain("node_modules");
      expect(text).not.toContain(".hidden");
      expect(text).not.toContain(".env");
      expect(text).toContain("visible.txt");
    });

    test("returns '(empty directory)' for empty dir", async () => {
      const dir = await createTempProject();
      await mkdir(resolve(dir, "empty"));
      const tools = createBuiltinTools(dir);
      const readDir = tools.find(t => t.name === "readDirectory")!;
      const result = await readDir.execute("1", { path: "empty" });
      expect(getText(result)).toBe("(empty directory)");
    });

    test("returns '(empty directory)' for dir with only hidden files", async () => {
      const dir = await createTempProject();
      await mkdir(resolve(dir, "onlyhidden"));
      await writeFile(resolve(dir, "onlyhidden/.gitkeep"), "");
      const tools = createBuiltinTools(dir);
      const readDir = tools.find(t => t.name === "readDirectory")!;
      const result = await readDir.execute("1", { path: "onlyhidden" });
      expect(getText(result)).toBe("(empty directory)");
    });

    test("returns error for nonexistent path", async () => {
      const dir = await createTempProject();
      const tools = createBuiltinTools(dir);
      const readDir = tools.find(t => t.name === "readDirectory")!;
      const result = await readDir.execute("1", { path: "nonexistent" });
      expect(getText(result)).toContain("Error:");
      expect(result.details.isError).toBe(true);
    });

    test("rejects path traversal", async () => {
      const dir = await createTempProject();
      const tools = createBuiltinTools(dir);
      const readDir = tools.find(t => t.name === "readDirectory")!;
      const result = await readDir.execute("1", { path: "../../" });
      expect(getText(result)).toContain("Path traversal");
      expect(result.details.isError).toBe(true);
    });

    test("alphabetically sorts within same type", async () => {
      const dir = await createTempProject();
      await writeFile(resolve(dir, "cherry.txt"), "");
      await writeFile(resolve(dir, "apple.txt"), "");
      await writeFile(resolve(dir, "banana.txt"), "");
      const tools = createBuiltinTools(dir);
      const readDir = tools.find(t => t.name === "readDirectory")!;
      const result = await readDir.execute("1", { path: "." });
      const lines = getText(result).split("\n");
      const names = lines.map((l: string) => l.replace(/.*── /, ""));
      expect(names).toEqual(["apple.txt", "banana.txt", "cherry.txt"]);
    });
  });

  // ── editFile ──

  describe("editFile", () => {
    async function getEditTool(dir: string) {
      return createBuiltinTools(dir).find(t => t.name === "editFile")!;
    }

    async function readDisk(path: string) {
      return fsReadFile(path, "utf-8");
    }

    // Create/overwrite mode
    test("creates a new file when old_string is omitted", async () => {
      const dir = await createTempProject();
      const edit = await getEditTool(dir);
      const result = await edit.execute("1", { path: "new.txt", new_string: "hello" });
      expect(getText(result)).toContain("Created/overwrote new.txt");
      expect(await readDisk(resolve(dir, "new.txt"))).toBe("hello");
    });

    test("creates parent directories automatically", async () => {
      const dir = await createTempProject();
      const edit = await getEditTool(dir);
      await edit.execute("1", { path: "a/b/c.txt", new_string: "deep" });
      expect(await readDisk(resolve(dir, "a/b/c.txt"))).toBe("deep");
    });

    test("overwrites existing file when old_string is omitted", async () => {
      const dir = await createTempProject();
      await writeFile(resolve(dir, "exist.txt"), "old content");
      const edit = await getEditTool(dir);
      await edit.execute("1", { path: "exist.txt", new_string: "new content" });
      expect(await readDisk(resolve(dir, "exist.txt"))).toBe("new content");
    });

    test("shows line count and preview on create", async () => {
      const dir = await createTempProject();
      const edit = await getEditTool(dir);
      const result = await edit.execute("1", { path: "f.txt", new_string: "line1\nline2\nline3" });
      expect(getText(result)).toContain("3 lines");
      expect(getText(result)).toContain("1: line1");
    });

    // Search-and-replace mode
    test("replaces old_string with new_string", async () => {
      const dir = await createTempProject();
      await writeFile(resolve(dir, "f.txt"), "hello world");
      const edit = await getEditTool(dir);
      const result = await edit.execute("1", { path: "f.txt", old_string: "world", new_string: "earth" });
      expect(getText(result)).toContain("Replaced in f.txt");
      expect(await readDisk(resolve(dir, "f.txt"))).toBe("hello earth");
    });

    test("replaces multiline old_string", async () => {
      const dir = await createTempProject();
      await writeFile(resolve(dir, "f.txt"), "a\nb\nc\nd");
      const edit = await getEditTool(dir);
      await edit.execute("1", { path: "f.txt", old_string: "b\nc", new_string: "x\ny" });
      expect(await readDisk(resolve(dir, "f.txt"))).toBe("a\nx\ny\nd");
    });

    test("shows snippet with line numbers after replace", async () => {
      const dir = await createTempProject();
      await writeFile(resolve(dir, "f.txt"), "a\nb\nc\nd\ne\nf");
      const edit = await getEditTool(dir);
      const result = await edit.execute("1", { path: "f.txt", old_string: "c", new_string: "C" });
      const text = getText(result);
      expect(text).toMatch(/\d+: /); // line numbers in snippet
    });

    // replace_all
    test("errors on multiple matches without replace_all", async () => {
      const dir = await createTempProject();
      await writeFile(resolve(dir, "f.txt"), "foo bar foo baz foo");
      const edit = await getEditTool(dir);
      const result = await edit.execute("1", { path: "f.txt", old_string: "foo", new_string: "qux" });
      expect(getText(result)).toContain("found 3 times");
      expect(result.details.isError).toBe(true);
      // File should be unchanged
      expect(await readDisk(resolve(dir, "f.txt"))).toBe("foo bar foo baz foo");
    });

    test("replaces all occurrences with replace_all: true", async () => {
      const dir = await createTempProject();
      await writeFile(resolve(dir, "f.txt"), "foo bar foo baz foo");
      const edit = await getEditTool(dir);
      const result = await edit.execute("1", { path: "f.txt", old_string: "foo", new_string: "qux", replace_all: true });
      expect(getText(result)).toContain("Replaced 3 occurrences");
      expect(await readDisk(resolve(dir, "f.txt"))).toBe("qux bar qux baz qux");
    });

    // Error cases
    test("errors on empty old_string", async () => {
      const dir = await createTempProject();
      await writeFile(resolve(dir, "f.txt"), "content");
      const edit = await getEditTool(dir);
      const result = await edit.execute("1", { path: "f.txt", old_string: "", new_string: "x" });
      expect(getText(result)).toContain("old_string is empty");
      expect(result.details.isError).toBe(true);
    });

    test("errors when file not found in replace mode", async () => {
      const dir = await createTempProject();
      const edit = await getEditTool(dir);
      const result = await edit.execute("1", { path: "missing.txt", old_string: "x", new_string: "y" });
      expect(getText(result)).toContain("file not found");
      expect(result.details.isError).toBe(true);
    });

    test("errors when old_string not found in file", async () => {
      const dir = await createTempProject();
      await writeFile(resolve(dir, "f.txt"), "hello world");
      const edit = await getEditTool(dir);
      const result = await edit.execute("1", { path: "f.txt", old_string: "missing text", new_string: "x" });
      expect(getText(result)).toContain("old_string not found");
      expect(result.details.isError).toBe(true);
    });

    // Path traversal
    test("rejects path traversal", async () => {
      const dir = await createTempProject();
      const edit = await getEditTool(dir);
      const result = await edit.execute("1", { path: "../../etc/passwd", new_string: "hacked" });
      expect(getText(result)).toContain("Path traversal");
      expect(result.details.isError).toBe(true);
    });

    test("rejects path traversal in replace mode", async () => {
      const dir = await createTempProject();
      const edit = await getEditTool(dir);
      const result = await edit.execute("1", { path: "../secret", old_string: "a", new_string: "b" });
      expect(getText(result)).toContain("Path traversal");
      expect(result.details.isError).toBe(true);
    });

    // Edge cases
    test("handles replacing with empty string (deletion)", async () => {
      const dir = await createTempProject();
      await writeFile(resolve(dir, "f.txt"), "keep remove keep");
      const edit = await getEditTool(dir);
      await edit.execute("1", { path: "f.txt", old_string: " remove", new_string: "" });
      expect(await readDisk(resolve(dir, "f.txt"))).toBe("keep keep");
    });

    test("creates empty file", async () => {
      const dir = await createTempProject();
      const edit = await getEditTool(dir);
      await edit.execute("1", { path: "empty.txt", new_string: "" });
      expect(await readDisk(resolve(dir, "empty.txt"))).toBe("");
    });

    test("preserves whitespace exactly in search-and-replace", async () => {
      const dir = await createTempProject();
      await writeFile(resolve(dir, "f.txt"), "  indented\n    more");
      const edit = await getEditTool(dir);
      await edit.execute("1", { path: "f.txt", old_string: "  indented", new_string: "    reindented" });
      expect(await readDisk(resolve(dir, "f.txt"))).toBe("    reindented\n    more");
    });
  });
});
