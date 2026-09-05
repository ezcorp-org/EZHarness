import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { validateManifest, assertJson } from "@ezcorp/extension-contract";
import { defineExtension } from "@ezcorp/sdk/v4";
import { discoverFirstPartyManifest } from "./helpers/first-party-manifest";
import { scaffoldExtension } from "@ezcorp/sdk/scaffold";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLES_DIR = join(ROOT, "docs/extensions/examples");
const EXAMPLE_NAMES = ["code-review-delegator", "github-stats", "markdown-utils", "multi-agent-orchestrator", "project-analyzer", "research-agent"];

function manifest(name: string) {
  return validateManifest({ schemaVersion: 4, name, version: "1.0.0", description: "Roundtrip", author: { name: "Tests" }, permissions: {}, tools: [{ name: "greet", description: "Greeting", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false }, outputSchema: { type: "string" } }], skills: [{ name: "knowledge", description: "Knowledge", prompt: "Be useful" }], agent: { prompt: "You are a test agent", category: "Testing" } });
}

describe("first-party metadata discovery uses the v4 transport", () => {
  for (const name of EXAMPLE_NAMES) test(`${name} preserves its data manifest`, async () => {
    const result = await discoverFirstPartyManifest(join(EXAMPLES_DIR, name));
    expect(result.name).toBe(name);
    expect(result.schemaVersion).toBe(4);
    expect(Object.hasOwn(result, "_inheritedFromV2")).toBe(false);
    expect(() => assertJson(result)).not.toThrow();
  });
  test("a test tool definition keeps implementation separate from metadata", () => {
    const extension = defineExtension({ manifest: manifest("test-tools"), tools: { greet: input => `Hello ${(input as { name: string }).name}` } });
    expect(extension.manifest.name).toBe("test-tools");
    expect(extension.manifest.tools).toHaveLength(1);
    expect(Object.hasOwn(extension.manifest.tools![0]!, "handler")).toBe(false);
  });
});

describe("SDK metadata and implementation roundtrip", () => {
  test("validated tool dispatch invokes the separate handler", async () => {
    const extension = defineExtension({ manifest: manifest("roundtrip-tools"), tools: { greet: input => `Hello ${(input as { name: string }).name}` } });
    const context = { invocation: { invocationId: "test", workerId: "worker", releaseId: "release", principalId: "owner", scopeId: "test", token: "test", deadline: Date.now() + 1000 }, signal: new AbortController().signal, call: async () => { throw new Error("No host capabilities"); } };
    expect(await extension.invoke("greet", { name: "World" }, context)).toBe("Hello World");
    await expect(extension.invoke("greet", { name: 42 }, context)).rejects.toThrow();
    expect(extension.manifest.tools![0]!.name).toBe("greet");
  });
  test("all contribution data survives without functions or host imports", () => {
    const result = manifest("roundtrip-all");
    expect(result.tools).toHaveLength(1);
    expect(result.skills).toHaveLength(1);
    expect(result.agent?.prompt).toBe("You are a test agent");
    expect(() => assertJson(result)).not.toThrow();
    const files = scaffoldExtension({ name: "roundtrip-all", type: "multi", description: "Roundtrip" }).files;
    expect(files["extension.ts"]).toContain("defineExtension");
    expect(files["extension.test.ts"]).toContain("declared tool executes");
  });
});

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


describe("function-valued metadata is rejected, never silently stripped", () => {
  test("tool handler metadata is rejected", () => {
    const value = manifest("bad-handler");
    expect(() => validateManifest({ ...value, tools: [{ ...value.tools![0], handler: () => "result" }] })).toThrow("Only JSON data");
  });
  test("multiple tool callback fields cannot cross discovery", () => {
    const value = manifest("bad-callbacks");
    for (const field of ["handler", "validate", "transform"]) expect(() => validateManifest({ ...value, tools: [{ ...value.tools![0], [field]: () => true }] })).toThrow("Only JSON data");
  });
  test("agent handlers cannot cross discovery", () => {
    const value = manifest("bad-agent");
    for (const field of ["handler", "onMessage"]) expect(() => validateManifest({ ...value, agent: { ...value.agent, [field]: () => "message" } })).toThrow("Only JSON data");
  });
  test("skill handlers cannot cross discovery", () => {
    const value = manifest("bad-skill");
    for (const field of ["handler", "execute"]) expect(() => validateManifest({ ...value, skills: [{ ...value.skills![0], [field]: () => "result" }] })).toThrow("Only JSON data");
  });
});
