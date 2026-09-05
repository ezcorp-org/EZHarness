import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installFromLocal, shouldAutoEnableOnInstall } from "../extensions/installer";
import { loadManifest } from "../extensions/loader";
import { validateManifestV2, validateMcpManifest } from "../extensions/manifest";

const directories: string[] = [];
function fixture(config: Record<string, unknown>) {
  const directory = mkdtempSync(join(tmpdir(), "extension-audit-"));
  directories.push(directory);
  const marker = join(directory, "host-executed");
  writeFileSync(join(directory, "index.ts"), "export default {};");
  writeFileSync(join(directory, "ezcorp.config.ts"),
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "unsafe"); export default ${JSON.stringify(config)};`);
  return { directory, marker };
}

afterAll(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); });

function metadata(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 2, name: "audit-probe", version: "1.0.0", description: "Audit probe", author: { name: "probe" }, ...overrides };
}

describe("AF-2: a bundled name or caller flag cannot grant runtime trust", () => {
  test("spoofed ai-kit local install fails before config evaluation", async () => {
    const source = fixture(metadata({ name: "ai-kit", entrypoint: "./index.ts", tools: [] }));
    await expect(installFromLocal(source.directory, { grantedAt: {} }, false)).rejects.toThrow("EXTENSION_V4_REQUIRED");
    expect(existsSync(source.marker)).toBe(false);
    expect(shouldAutoEnableOnInstall("ai-kit")).toBe(false);
  });

  test("registry does not use a bundled name as its trust boundary", () => {
    const source = readFileSync(resolve(import.meta.dir, "../extensions/registry.ts"), "utf8");
    expect(source).not.toMatch(/import\s*\{[^}]*isBundledExtensionName[^}]*\}\s*from\s*["']\.\/bundled["']/);
    expect(source).not.toMatch(/isBundledExtensionName\s*\(/);
  });

  test("even explicit legacy bundled provenance cannot bypass approved release publication", async () => {
    const source = fixture(metadata({ name: "scratchpad", entrypoint: "./index.ts", tools: [] }));
    await expect(installFromLocal(source.directory, { grantedAt: {} }, false, { isBundled: true })).rejects.toThrow("EXTENSION_V4_REQUIRED");
    expect(existsSync(source.marker)).toBe(false);
    expect(shouldAutoEnableOnInstall("scratchpad")).toBe(false);
  });
});

describe("AF-3a: validateManifestV2 rejects entrypoint traversal", () => {
  function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: 2,
      name: "af3-test",
      version: "1.0.0",
      description: "af3 entrypoint test",
      author: { name: "t" },
      tools: [],
      ...overrides,
    };
  }

  test("rejects entrypoint with '..' traversal", async () => {
    const { validateManifestV2 } = await import("../extensions/manifest");
    const r = validateManifestV2(baseManifest({ entrypoint: "../../etc/passwd" }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /entrypoint/i.test(e) && /\.\./.test(e))).toBe(true);
  });

  test("rejects absolute entrypoint", async () => {
    const { validateManifestV2 } = await import("../extensions/manifest");
    const r = validateManifestV2(baseManifest({ entrypoint: "/etc/hostname" }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /entrypoint/i.test(e) && /absolute/i.test(e))).toBe(true);
  });

  test("rejects entrypoint with a nested '..' segment (foo/../../bar)", async () => {
    // Defense-in-depth: any path segment equal to `..` is rejected, even
    // if flanked by normal segments. The validator splits on `[\\/]` and
    // checks segment equality, so "sub/../../escape.ts" trips the rule.
    const { validateManifestV2 } = await import("../extensions/manifest");
    const r = validateManifestV2(baseManifest({ entrypoint: "sub/../../escape.ts" }));
    expect(r.valid).toBe(false);
  });

  test("accepts './index.ts'", async () => {
    const { validateManifestV2 } = await import("../extensions/manifest");
    const r = validateManifestV2(baseManifest({ entrypoint: "./index.ts" }));
    expect(r.valid).toBe(true);
  });

  test("accepts bare 'index.ts'", async () => {
    const { validateManifestV2 } = await import("../extensions/manifest");
    const r = validateManifestV2(baseManifest({ entrypoint: "index.ts" }));
    expect(r.valid).toBe(true);
  });

  test("accepts absent entrypoint when manifest has no tools (MCP-shaped package)", async () => {
    // AF-3 acceptance §"Part A's entrypoint check and Part B's validator
    // do not conflict — if MCP manifests legitimately omit entrypoint,
    // Part A must handle an absent entrypoint as valid rather than required."
    const { validateManifestV2 } = await import("../extensions/manifest");
    const r = validateManifestV2({
      schemaVersion: 2,
      name: "mcp-like",
      version: "1.0.0",
      description: "x",
      author: { name: "t" },
      kind: "mcp",
      mcpServers: [{ name: "s", transport: "stdio", command: "bun" }],
    });
    expect(r.valid).toBe(true);
  });

  test("rejects a non-string entrypoint (type guard)", async () => {
    // The traversal check lives behind a `typeof === "string"` guard.
    // Sending a non-string entrypoint must still produce a validator
    // failure, not a crash.
    const { validateManifestV2 } = await import("../extensions/manifest");
    const r = validateManifestV2(baseManifest({ entrypoint: 42 }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /entrypoint/i.test(e))).toBe(true);
  });
});


describe("AF-3b: validate MCP metadata as data and never evaluate host config", () => {
  const server = { name: "server", transport: "stdio", command: "bun" };
  for (const sample of [
    { label: "zero MCP servers", overrides: { kind: "mcp", mcpServers: [] }, valid: false, error: /exactly one mcpServers entry/ },
    { label: "multiple MCP servers", overrides: { kind: "mcp", mcpServers: [server, { ...server, name: "second" }] }, valid: false, error: /exactly one mcpServers entry/ },
    { label: "MCP with an entrypoint", overrides: { kind: "mcp", mcpServers: [server], entrypoint: "./index.ts" }, valid: false, error: /entrypoint/ },
    { label: "well-formed MCP metadata", overrides: { kind: "mcp", mcpServers: [server] }, valid: true, error: undefined },
    { label: "plain tool metadata", overrides: { entrypoint: "./index.ts", tools: [{ name: "noop", description: "noop", inputSchema: { type: "object" } }] }, valid: true, error: undefined },
  ]) {
    test(sample.label, async () => {
      const manifest = metadata(sample.overrides);
      const validation = "kind" in manifest ? validateMcpManifest(manifest) : validateManifestV2(manifest);
      expect(validation.valid).toBe(sample.valid);
      if (sample.error) expect(validation.errors.join("\n")).toMatch(sample.error);
      const source = fixture(manifest);
      await expect(loadManifest(source.directory)).rejects.toMatchObject({ code: "EXTENSION_V4_REQUIRED" });
      expect(existsSync(source.marker)).toBe(false);
    });
  }
});
