// Template assertions retargeted (fix-wave B Phase 4): the dead legacy
// copies at src/extensions/sdk/templates/* were deleted — the LIVE
// scaffold templates live in packages/@ezcorp/sdk/src/scaffold/templates
// (consumed by scaffoldExtension, covered end-to-end by
// sdk-scaffold.test.ts). Every assertion below exercises the live
// scaffold output; nothing was dropped except the import target.
import { describe, test, expect } from "bun:test";
import { validateManifestV2 } from "../extensions/manifest";
import { defineExtension } from "../extensions/sdk/define";

/**
 * Evaluate a template's generated TypeScript manifest to its default-export
 * config object — WITHOUT writing a temp file or dynamic-`import()`ing it.
 *
 * The earlier implementation wrote each rewritten template to `os.tmpdir()`
 * and `await import()`ed it. Importing a unique-path `.ts` module from
 * outside the project tree makes Bun re-resolve `@ezcorp/sdk` from the tmp
 * base and register a never-evicted module per call; under the memory
 * pressure of the full `bun test` process that corrupted Bun's loader and
 * SIGSEGV'd the whole shard (repro: 8GB RSS balloon → `Segmentation fault
 * at address 0x8023`). The unlink was never the trigger — the import was.
 *
 * This mirrors the source-of-truth pattern already used by
 * ts-manifest-integration / sdk-scaffold / ext-init: strip the imports,
 * turn `export default` into a `return`, and evaluate the body with the
 * real (identity) `defineExtension` injected. No files, no module-registry
 * growth, deterministic.
 */
function evalTemplateManifest(tsCode: string): any {
  const body = tsCode
    // Drop the SDK import — `defineExtension` is injected as a parameter.
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@?ezcorp\/sdk["'];?\s*$/gm, "")
    // Strip non-resolvable local imports (e.g. handleRequest from "./index").
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']\.\/.+["'];?\s*$/gm, "")
    // Remove handler references that would be undefined after stripping imports.
    .replace(/handler:\s*\w+,?\s*\n?/g, "")
    // Turn the module's default export into the function's return value.
    .replace(/^export default /m, "return ");
  // eslint-disable-next-line no-new-func
  return new Function("defineExtension", body)(defineExtension);
}

describe("SDK types re-exports", () => {
  test("re-exports all extension API types from sdk/types", async () => {
    const sdkTypes = await import("../extensions/sdk/types");
    expect(sdkTypes).toBeDefined();
  });
});

describe("tool template", () => {
  test("toolManifest generates valid manifest", async () => {
    const { toolManifest } = await import("../../packages/@ezcorp/sdk/src/scaffold/templates/tool");
    const ts = toolManifest("my-tool", "A cool tool");
    const manifest = evalTemplateManifest(ts);
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.name).toBe("my-tool");
    expect(manifest.description).toBe("A cool tool");
    expect(manifest.tools).toHaveLength(1);
    expect(manifest.entrypoint).toBe("./index.ts");
    expect(manifest.permissions).toEqual({});
  });

  test("toolEntrypoint returns non-empty string", async () => {
    const { toolEntrypoint } = await import("../../packages/@ezcorp/sdk/src/scaffold/templates/tool");
    const code = toolEntrypoint("my-tool", "A cool tool");
    expect(code.length).toBeGreaterThan(0);
    expect(code).toContain("jsonrpc");
  });

  test("toolTest returns test skeleton", async () => {
    const { toolTest } = await import("../../packages/@ezcorp/sdk/src/scaffold/templates/tool");
    const code = toolTest("my-tool", "A cool tool");
    expect(code).toContain("bun:test");
    expect(code).toContain("test");
  });

  test("toolReadme returns markdown", async () => {
    const { toolReadme } = await import("../../packages/@ezcorp/sdk/src/scaffold/templates/tool");
    const md = toolReadme("my-tool", "A cool tool");
    expect(md).toContain("# my-tool");
    expect(md).toContain("A cool tool");
  });
});

describe("skill template", () => {
  test("skillManifest generates valid manifest with skills array", async () => {
    const { skillManifest } = await import("../../packages/@ezcorp/sdk/src/scaffold/templates/skill");
    const ts = skillManifest("my-skill", "A cool skill");
    const manifest = evalTemplateManifest(ts);
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(true);
    expect(manifest.skills).toHaveLength(1);
    expect(manifest.skills[0].prompt).toBeDefined();
  });

  test("skillEntrypoint returns empty string", async () => {
    const { skillEntrypoint } = await import("../../packages/@ezcorp/sdk/src/scaffold/templates/skill");
    expect(skillEntrypoint("my-skill", "A cool skill")).toBe("");
  });

  test("skillTest returns test skeleton", async () => {
    const { skillTest } = await import("../../packages/@ezcorp/sdk/src/scaffold/templates/skill");
    expect(skillTest("my-skill", "A cool skill")).toContain("bun:test");
  });

  test("skillReadme returns markdown", async () => {
    const { skillReadme } = await import("../../packages/@ezcorp/sdk/src/scaffold/templates/skill");
    expect(skillReadme("my-skill", "A cool skill")).toContain("# my-skill");
  });
});

describe("agent template", () => {
  test("agentManifest generates valid manifest with agent component", async () => {
    const { agentManifest } = await import("../../packages/@ezcorp/sdk/src/scaffold/templates/agent");
    const ts = agentManifest("my-agent", "A cool agent");
    const manifest = evalTemplateManifest(ts);
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(true);
    expect(manifest.agent).toBeDefined();
    expect(manifest.agent.prompt).toBeDefined();
    expect(manifest.agent.category).toBeDefined();
  });

  test("agentEntrypoint returns empty string", async () => {
    const { agentEntrypoint } = await import("../../packages/@ezcorp/sdk/src/scaffold/templates/agent");
    expect(agentEntrypoint("my-agent", "A cool agent")).toBe("");
  });

  test("agentTest returns test skeleton", async () => {
    const { agentTest } = await import("../../packages/@ezcorp/sdk/src/scaffold/templates/agent");
    expect(agentTest("my-agent", "A cool agent")).toContain("bun:test");
  });

  test("agentReadme returns markdown", async () => {
    const { agentReadme } = await import("../../packages/@ezcorp/sdk/src/scaffold/templates/agent");
    expect(agentReadme("my-agent", "A cool agent")).toContain("# my-agent");
  });
});

describe("multi template", () => {
  test("multiManifest generates valid manifest with tools, skills, and agent", async () => {
    const { multiManifest } = await import("../../packages/@ezcorp/sdk/src/scaffold/templates/multi");
    const ts = multiManifest("my-multi", "A cool multi");
    const manifest = evalTemplateManifest(ts);
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(true);
    expect(manifest.tools).toHaveLength(1);
    expect(manifest.skills).toHaveLength(1);
    expect(manifest.agent).toBeDefined();
    expect(manifest.entrypoint).toBe("./index.ts");
  });

  test("multiEntrypoint returns non-empty string", async () => {
    const { multiEntrypoint } = await import("../../packages/@ezcorp/sdk/src/scaffold/templates/multi");
    const code = multiEntrypoint("my-multi", "A cool multi");
    expect(code.length).toBeGreaterThan(0);
    expect(code).toContain("jsonrpc");
  });

  test("multiTest returns test skeleton", async () => {
    const { multiTest } = await import("../../packages/@ezcorp/sdk/src/scaffold/templates/multi");
    expect(multiTest("my-multi", "A cool multi")).toContain("bun:test");
  });

  test("multiReadme returns markdown", async () => {
    const { multiReadme } = await import("../../packages/@ezcorp/sdk/src/scaffold/templates/multi");
    expect(multiReadme("my-multi", "A cool multi")).toContain("# my-multi");
  });
});
