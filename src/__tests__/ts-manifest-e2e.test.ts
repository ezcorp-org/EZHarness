import { test, expect, describe, afterEach } from "bun:test";
import { loadManifest } from "../extensions/loader";
import { join } from "path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLES_DIR = join(ROOT, "docs/extensions/examples");
const MOCK_EXT_DIR = join(ROOT, "src/__tests__/helpers/mock-extension");

function at<T>(arr: readonly T[] | undefined, i: number, what: string): T {
  const v = arr?.[i];
  if (v === undefined) throw new Error(`expected ${what} at index ${i}`);
  return v;
}

const EXAMPLE_NAMES = [
  "code-review-delegator",
  "github-stats",
  "markdown-utils",
  "multi-agent-orchestrator",
  "project-analyzer",
  "research-agent",
];

// ── Example extensions are loadable ─────────────────────────────

describe("example extensions load via loadManifest", () => {
  for (const name of EXAMPLE_NAMES) {
    test(`${name} loads successfully`, async () => {
      const manifest = await loadManifest(join(EXAMPLES_DIR, name));
      expect(manifest.name).toBe(name);
      // Phase 1: loadManifest auto-promotes v2 → v3 with _inheritedFromV2.
      expect(manifest.schemaVersion).toBe(3);
      expect((manifest as { _inheritedFromV2?: boolean })._inheritedFromV2).toBe(true);
    });
  }

  test("mock-extension loads successfully", async () => {
    const manifest = await loadManifest(MOCK_EXT_DIR);
    expect(manifest.name).toBe("test-tools");
    // Phase 1: loadManifest auto-promotes v2 → v3 with _inheritedFromV2.
    expect(manifest.schemaVersion).toBe(3);
    expect((manifest as { _inheritedFromV2?: boolean })._inheritedFromV2).toBe(true);
  });
});

// ── Full lifecycle roundtrip ────────────────────────────────────

describe("full lifecycle roundtrip", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const d of tempDirs) await rm(d, { recursive: true, force: true });
    tempDirs.length = 0;
  });

  test("tools + handler → loadManifest strips handler, manifest valid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ez-e2e-"));
    tempDirs.push(dir);

    await Bun.write(
      join(dir, "ezcorp.config.ts"),
      `
import { defineExtension } from "${join(ROOT, "src/extensions/sdk/define")}";
export default defineExtension({
  schemaVersion: 2,
  name: "roundtrip-tools",
  version: "1.0.0",
  description: "Roundtrip test with handler",
  author: { name: "Test" },
  tools: [{
    name: "greet",
    description: "Say hello",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    handler: (input: any) => \`Hello \${input.name}\`,
  }],
  entrypoint: "./index.ts",
  permissions: {},
});
`,
    );

    const manifest = await loadManifest(dir);
    expect(manifest.name).toBe("roundtrip-tools");
    expect(manifest.tools).toHaveLength(1);
    expect(at(manifest.tools, 0, "tool").name).toBe("greet");
    expect((manifest.tools![0] as any).handler).toBeUndefined();
  });

  test("all component types → loadManifest strips functions from all", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ez-e2e-"));
    tempDirs.push(dir);

    await Bun.write(
      join(dir, "ezcorp.config.ts"),
      `
import { defineExtension } from "${join(ROOT, "src/extensions/sdk/define")}";
export default defineExtension({
  schemaVersion: 2,
  name: "roundtrip-all",
  version: "1.0.0",
  description: "Roundtrip with all components",
  author: { name: "Test" },
  tools: [{
    name: "t1",
    description: "Tool one",
    inputSchema: { type: "object", properties: {} },
    handler: () => "result",
    validate: (x: any) => true,
  }],
  entrypoint: "./index.ts",
  skills: [{
    name: "s1",
    description: "Skill one",
    pattern: "do something",
    handler: () => "skill result",
  }],
  agent: {
    prompt: "You are a test agent",
    category: "Testing",
    onMessage: (msg: any) => msg,
  },
  permissions: {},
});
`,
    );

    const manifest = await loadManifest(dir);
    expect(manifest.name).toBe("roundtrip-all");
    expect(manifest.tools).toHaveLength(1);
    expect(manifest.skills).toHaveLength(1);
    expect(manifest.agent).toBeDefined();
    // All functions stripped
    expect((manifest.tools![0] as any).handler).toBeUndefined();
    expect((manifest.tools![0] as any).validate).toBeUndefined();
    expect((manifest.skills![0] as any).handler).toBeUndefined();
    expect((manifest.agent as any).onMessage).toBeUndefined();
    // Data preserved
    expect(at(manifest.tools, 0, "tool").name).toBe("t1");
    expect(at(manifest.skills, 0, "skill").name).toBe("s1");
    expect((manifest.agent as any).prompt).toBe("You are a test agent");
  });
});

// ── Codebase migration completeness ─────────────────────────────

describe("codebase migration completeness", () => {
  test("no .json manifest files in examples (only ezcorp.config.ts)", async () => {
    const { Glob: BunGlob } = globalThis.Bun || Bun;
    const glob = new BunGlob("*/manifest.json");
    const matches: string[] = [];
    for await (const path of glob.scan({ cwd: EXAMPLES_DIR })) {
      matches.push(path);
    }
    expect(matches).toEqual([]);
  });

  test.each([
    "docs/extensions/getting-started.md",
    "docs/extensions/manifest-schema.md",
    "docs/extensions/api-reference.md",
  ])("%s contains defineExtension", async (relPath) => {
    const content = await Bun.file(join(ROOT, relPath)).text();
    expect(content).toContain("defineExtension");
  });

  test("no manifest.json references in docs/extensions/*.md", async () => {
    const glob = new Bun.Glob("*.md");
    for await (const path of glob.scan({ cwd: join(ROOT, "docs/extensions") })) {
      const content = await Bun.file(join(ROOT, "docs/extensions", path)).text();
      // Allow references in migration notes or deprecation warnings, but not JSON manifest blocks
      expect(content).not.toMatch(/"manifest\.json"/);
    }
  });

  test("all 6 example ezcorp.config.ts files contain defineExtension", async () => {
    for (const name of EXAMPLE_NAMES) {
      const content = await Bun.file(join(EXAMPLES_DIR, name, "ezcorp.config.ts")).text();
      expect(content).toContain("defineExtension");
    }
  });
});

// ── Handler stripping E2E ───────────────────────────────────────

describe("handler stripping E2E", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const d of tempDirs) await rm(d, { recursive: true, force: true });
    tempDirs.length = 0;
  });

  async function writeAndLoad(configBody: string) {
    const dir = await mkdtemp(join(tmpdir(), "ez-strip-"));
    tempDirs.push(dir);
    await Bun.write(
      join(dir, "ezcorp.config.ts"),
      `import { defineExtension } from "${join(ROOT, "src/extensions/sdk/define")}";\nexport default defineExtension(${configBody});`,
    );
    return loadManifest(dir);
  }

  test("handler on tool is stripped", async () => {
    const m = await writeAndLoad(`{
      schemaVersion: 2, name: "strip-tool-handler", version: "1.0.0",
      description: "test", author: { name: "T" }, permissions: {},
      entrypoint: "./index.ts",
      tools: [{ name: "x", description: "x", inputSchema: { type: "object", properties: {} }, handler: () => {} }],
    }`);
    expect((m.tools![0] as any).handler).toBeUndefined();
  });

  test("multiple function props on tool are stripped", async () => {
    const m = await writeAndLoad(`{
      schemaVersion: 2, name: "strip-multi-fn", version: "1.0.0",
      description: "test", author: { name: "T" }, permissions: {},
      entrypoint: "./index.ts",
      tools: [{ name: "x", description: "x", inputSchema: { type: "object", properties: {} },
        handler: () => {}, validate: () => true, transform: (x: any) => x }],
    }`);
    const tool = m.tools![0] as any;
    expect(tool.handler).toBeUndefined();
    expect(tool.validate).toBeUndefined();
    expect(tool.transform).toBeUndefined();
    expect(tool.name).toBe("x");
  });

  test("handler on agent is stripped", async () => {
    const m = await writeAndLoad(`{
      schemaVersion: 2, name: "strip-agent", version: "1.0.0",
      description: "test", author: { name: "T" }, permissions: {},
      agent: { prompt: "hello", category: "Test", handler: () => {}, onMessage: (m: any) => m },
    }`);
    const agent = m.agent as any;
    expect(agent.handler).toBeUndefined();
    expect(agent.onMessage).toBeUndefined();
    expect(agent.prompt).toBe("hello");
  });

  test("handler on skills is stripped", async () => {
    const m = await writeAndLoad(`{
      schemaVersion: 2, name: "strip-skills", version: "1.0.0",
      description: "test", author: { name: "T" }, permissions: {},
      skills: [{ name: "s", description: "s", pattern: "do", handler: () => "r", execute: async () => {} }],
    }`);
    const skill = m.skills![0] as any;
    expect(skill.handler).toBeUndefined();
    expect(skill.execute).toBeUndefined();
    expect(skill.name).toBe("s");
  });
});
