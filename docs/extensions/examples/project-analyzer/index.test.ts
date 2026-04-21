import { test, expect } from "bun:test";
import { resolve, normalize } from "node:path";

// Test path validation logic
function isUnderCwd(cwd: string, filePath: string): boolean {
  const resolved = resolve(cwd, normalize(filePath));
  return resolved.startsWith(cwd + "/") || resolved === cwd;
}

test("isUnderCwd allows relative paths within cwd", () => {
  expect(isUnderCwd("/project", "src/index.ts")).toBe(true);
  expect(isUnderCwd("/project", "./README.md")).toBe(true);
  expect(isUnderCwd("/project", "nested/deep/file.txt")).toBe(true);
});

test("isUnderCwd rejects paths outside cwd", () => {
  expect(isUnderCwd("/project", "../etc/passwd")).toBe(false);
  expect(isUnderCwd("/project", "/etc/passwd")).toBe(false);
  expect(isUnderCwd("/project", "../../root/.ssh/id_rsa")).toBe(false);
});

test("isUnderCwd allows cwd itself", () => {
  expect(isUnderCwd("/project", ".")).toBe(true);
});

// Test manifest structure
test("manifest has required fields", async () => {
  const manifest = ((await import(import.meta.dir + "/ezcorp.config.ts")).default);
  expect(manifest.schemaVersion).toBe(2);
  expect(manifest.name).toBe("project-analyzer");
  expect(manifest.author.name).toBe("EzCorp");
  expect(manifest.entrypoint).toBe("./index.ts");
  expect(manifest.tools).toHaveLength(2);
  expect(manifest.permissions.filesystem).toEqual(["$CWD"]);
  expect(manifest.permissions.shell).toBe(true);
  expect(manifest.scripts.postinstall).toBe("./scripts/postinstall.ts");
});

// Test tool definitions
test("tools have valid input schemas", async () => {
  const manifest = ((await import(import.meta.dir + "/ezcorp.config.ts")).default);
  const [listFiles, readFile] = manifest.tools;

  expect(listFiles.name).toBe("listFiles");
  expect(listFiles.inputSchema.type).toBe("object");

  expect(readFile.name).toBe("readFile");
  expect(readFile.inputSchema.required).toContain("path");
});

// Test postinstall script exists
test("postinstall script exists", async () => {
  const file = Bun.file(resolve(import.meta.dir, "scripts/postinstall.ts"));
  expect(await file.exists()).toBe(true);
});
