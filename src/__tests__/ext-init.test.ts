import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateManifestV2 } from "../extensions/manifest";
import { parseArgs } from "../cli";

// ── parseArgs tests ─────────────────────────────────────────────────

describe("parseArgs ext init", () => {
  test("parses ext init with name", () => {
    const result = parseArgs(["ext", "init", "my-tool"]);
    expect(result.command).toBe("ext:init");
    expect(result.extName).toBe("my-tool");
  });

  test("parses ext init with --type flag", () => {
    const result = parseArgs(["ext", "init", "my-tool", "--type", "tool"]);
    expect(result.command).toBe("ext:init");
    expect(result.extName).toBe("my-tool");
    expect(result.type).toBe("tool");
  });

  test("parses ext init without name", () => {
    const result = parseArgs(["ext", "init"]);
    expect(result.command).toBe("ext:init");
    expect(result.extName).toBeUndefined();
  });
});

// ── initExtension tests ─────────────────────────────────────────────

describe("initExtension", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ezcorp-ext-init-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("creates directory with all expected files for tool type", async () => {
    const { initExtension } = await import("../extensions/sdk/init");
    await initExtension({ extName: "my-tool", type: "tool", cwd: tempDir });

    const extDir = join(tempDir, "my-tool");
    expect(existsSync(extDir)).toBe(true);
    expect(existsSync(join(extDir, "ezcorp.config.ts"))).toBe(true);
    expect(existsSync(join(extDir, "index.ts"))).toBe(true);
    expect(existsSync(join(extDir, "index.test.ts"))).toBe(true);
    expect(existsSync(join(extDir, "README.md"))).toBe(true);
    expect(existsSync(join(extDir, ".gitignore"))).toBe(true);
    expect(existsSync(join(extDir, "tsconfig.json"))).toBe(true);
    expect(existsSync(join(extDir, "package.json"))).toBe(true);
  });

  test("generated ezcorp.config.ts passes validation", async () => {
    const { initExtension } = await import("../extensions/sdk/init");
    await initExtension({ extName: "test-ext", type: "tool", cwd: tempDir });

    // Can't use loadManifest because the generated file imports "ezcorp/sdk"
    // which isn't resolvable from temp dirs. Instead, eval with shims.
    const content = await Bun.file(join(tempDir, "test-ext", "ezcorp.config.ts")).text();
    const transformed = content
      .replace(/import\s*\{[^}]*\}\s*from\s*["'][^"']*["'];?\n?/g, "")
      .replace(/import\s+\w+\s+from\s*["'][^"']*["'];?\n?/g, "")
      .replace("export default", "return");
    const noop = () => {};
    const manifest = new Function("defineExtension", "handleRequest", transformed)(
      (x: any) => x, noop,
    );
    if (manifest.tools) {
      for (const t of manifest.tools) delete t.handler;
    }
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("creates skill extension without entrypoint file", async () => {
    const { initExtension } = await import("../extensions/sdk/init");
    await initExtension({ extName: "my-skill", type: "skill", cwd: tempDir });

    const extDir = join(tempDir, "my-skill");
    expect(existsSync(extDir)).toBe(true);
    expect(existsSync(join(extDir, "ezcorp.config.ts"))).toBe(true);
    expect(existsSync(join(extDir, "index.ts"))).toBe(false);
    expect(existsSync(join(extDir, "index.test.ts"))).toBe(true);
  });

  test("creates agent extension without entrypoint file", async () => {
    const { initExtension } = await import("../extensions/sdk/init");
    await initExtension({ extName: "my-agent", type: "agent", cwd: tempDir });

    expect(existsSync(join(tempDir, "my-agent", "index.ts"))).toBe(false);
    expect(existsSync(join(tempDir, "my-agent", "ezcorp.config.ts"))).toBe(true);
  });

  test("creates multi-component extension with entrypoint", async () => {
    const { initExtension } = await import("../extensions/sdk/init");
    await initExtension({ extName: "my-multi", type: "multi", cwd: tempDir });

    const extDir = join(tempDir, "my-multi");
    expect(existsSync(join(extDir, "index.ts"))).toBe(true);
    expect(existsSync(join(extDir, "ezcorp.config.ts"))).toBe(true);

    const content = await Bun.file(join(extDir, "ezcorp.config.ts")).text();
    const transformed = content
      .replace(/import\s*\{[^}]*\}\s*from\s*["'][^"']*["'];?\n?/g, "")
      .replace(/import\s+\w+\s+from\s*["'][^"']*["'];?\n?/g, "")
      .replace("export default", "return");
    const noop = () => {};
    const manifest = new Function("defineExtension", "handleRequest", transformed)(
      (x: any) => x, noop,
    );
    expect(manifest.tools).toHaveLength(1);
    expect(manifest.skills).toHaveLength(1);
    expect(manifest.agent).toBeDefined();
  });

  test("fails if directory already exists", async () => {
    const { initExtension } = await import("../extensions/sdk/init");
    mkdirSync(join(tempDir, "existing-ext"));

    await expect(
      initExtension({ extName: "existing-ext", type: "tool", cwd: tempDir })
    ).rejects.toThrow('Directory "existing-ext" already exists');
  });

  test("fails without extName", async () => {
    const { initExtension } = await import("../extensions/sdk/init");

    await expect(
      initExtension({ type: "tool", cwd: tempDir })
    ).rejects.toThrow();
  });

  test("generated .gitignore contains common patterns", async () => {
    const { initExtension } = await import("../extensions/sdk/init");
    await initExtension({ extName: "my-tool", type: "tool", cwd: tempDir });

    const gitignore = readFileSync(join(tempDir, "my-tool", ".gitignore"), "utf-8");
    expect(gitignore).toContain("node_modules");
    expect(gitignore).toContain(".env");
    expect(gitignore).toContain("dist");
  });

  test("generated tsconfig.json is standalone (no workspace-root extends)", async () => {
    // Phase 3 dropped the path-mapping hack entirely. Scaffolded extensions
    // resolve `@ezcorp/sdk` via `bun add @ezcorp/sdk` from the npm registry,
    // so the tsconfig must stand alone without inheriting from the host repo.
    const { initExtension } = await import("../extensions/sdk/init");
    await initExtension({ extName: "my-tool", type: "tool", cwd: tempDir });

    const tsconfig = JSON.parse(readFileSync(join(tempDir, "my-tool", "tsconfig.json"), "utf-8"));
    expect(tsconfig.extends).toBeUndefined();
    expect(tsconfig.compilerOptions).toBeDefined();
    expect(tsconfig.compilerOptions.module).toBe("ESNext");
    expect(tsconfig.compilerOptions.moduleResolution).toBe("bundler");
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.types).toEqual(["bun"]);
    expect(tsconfig.include).toEqual(["*.ts"]);
  });

  test("generated package.json declares @ezcorp/sdk dependency", async () => {
    // Replaces the dropped path-mapping hack: scaffolded extensions now
    // carry their own package.json with @ezcorp/sdk as a registry dep,
    // so `bun install` in the extension directory pulls the published SDK.
    const { initExtension } = await import("../extensions/sdk/init");
    await initExtension({
      extName: "dep-tool",
      type: "tool",
      description: "Dep check tool",
      cwd: tempDir,
    });

    const pkg = JSON.parse(readFileSync(join(tempDir, "dep-tool", "package.json"), "utf-8"));
    expect(pkg.name).toBe("dep-tool");
    expect(pkg.version).toBe("0.1.0");
    expect(pkg.description).toBe("Dep check tool");
    expect(pkg.type).toBe("module");
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies["@ezcorp/sdk"]).toBe("^0.1.0");
  });

  test("uses description when provided", async () => {
    const { initExtension } = await import("../extensions/sdk/init");
    await initExtension({
      extName: "my-tool",
      type: "tool",
      description: "My custom description",
      cwd: tempDir,
    });

    const content = await Bun.file(join(tempDir, "my-tool", "ezcorp.config.ts")).text();
    const transformed = content
      .replace(/import\s*\{[^}]*\}\s*from\s*["'][^"']*["'];?\n?/g, "")
      .replace(/import\s+\w+\s+from\s*["'][^"']*["'];?\n?/g, "")
      .replace("export default", "return");
    const noop = () => {};
    const manifest = new Function("defineExtension", "handleRequest", transformed)(
      (x: any) => x, noop,
    );
    expect(manifest.description).toBe("My custom description");
  });
});
