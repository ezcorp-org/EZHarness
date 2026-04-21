import { describe, test, expect } from "bun:test";
import { validateManifestV2 } from "../extensions/manifest";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

/** Write a template's TypeScript output to a temp file, import it, and return the default export (the config object). */
async function evalTemplateManifest(tsCode: string): Promise<any> {
  const tmpFile = join(tmpdir(), `ezcorp-test-${randomUUID()}.ts`);
  let rewritten = tsCode
    // Rewrite the import to point at the real defineExtension
    .replace(
      /from ["']@?ezcorp\/sdk["']/,
      `from "${join(import.meta.dir, "../extensions/sdk/define")}"`,
    )
    // Strip non-resolvable local imports (e.g. handleRequest from "./index")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']\.\/.+["'];?\s*$/gm, "")
    // Remove handler references that would be undefined after stripping imports
    .replace(/handler:\s*\w+,?\s*\n?/g, "");
  await Bun.write(tmpFile, rewritten);
  try {
    const mod = await import(tmpFile);
    return mod.default;
  } finally {
    try { await Bun.file(tmpFile).unlink?.(); } catch { /* ignore */ }
  }
}

describe("SDK types re-exports", () => {
  test("re-exports all extension API types from sdk/types", async () => {
    const sdkTypes = await import("../extensions/sdk/types");
    expect(sdkTypes).toBeDefined();
  });
});

describe("tool template", () => {
  test("toolManifest generates valid manifest", async () => {
    const { toolManifest } = await import("../extensions/sdk/templates/tool");
    const ts = toolManifest("my-tool", "A cool tool");
    const manifest = await evalTemplateManifest(ts);
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
    const { toolEntrypoint } = await import("../extensions/sdk/templates/tool");
    const code = toolEntrypoint("my-tool", "A cool tool");
    expect(code.length).toBeGreaterThan(0);
    expect(code).toContain("jsonrpc");
  });

  test("toolTest returns test skeleton", async () => {
    const { toolTest } = await import("../extensions/sdk/templates/tool");
    const code = toolTest("my-tool", "A cool tool");
    expect(code).toContain("bun:test");
    expect(code).toContain("test");
  });

  test("toolReadme returns markdown", async () => {
    const { toolReadme } = await import("../extensions/sdk/templates/tool");
    const md = toolReadme("my-tool", "A cool tool");
    expect(md).toContain("# my-tool");
    expect(md).toContain("A cool tool");
  });
});

describe("skill template", () => {
  test("skillManifest generates valid manifest with skills array", async () => {
    const { skillManifest } = await import("../extensions/sdk/templates/skill");
    const ts = skillManifest("my-skill", "A cool skill");
    const manifest = await evalTemplateManifest(ts);
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(true);
    expect(manifest.skills).toHaveLength(1);
    expect(manifest.skills[0].prompt).toBeDefined();
  });

  test("skillEntrypoint returns empty string", async () => {
    const { skillEntrypoint } = await import("../extensions/sdk/templates/skill");
    expect(skillEntrypoint("my-skill", "A cool skill")).toBe("");
  });

  test("skillTest returns test skeleton", async () => {
    const { skillTest } = await import("../extensions/sdk/templates/skill");
    expect(skillTest("my-skill", "A cool skill")).toContain("bun:test");
  });

  test("skillReadme returns markdown", async () => {
    const { skillReadme } = await import("../extensions/sdk/templates/skill");
    expect(skillReadme("my-skill", "A cool skill")).toContain("# my-skill");
  });
});

describe("agent template", () => {
  test("agentManifest generates valid manifest with agent component", async () => {
    const { agentManifest } = await import("../extensions/sdk/templates/agent");
    const ts = agentManifest("my-agent", "A cool agent");
    const manifest = await evalTemplateManifest(ts);
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(true);
    expect(manifest.agent).toBeDefined();
    expect(manifest.agent.prompt).toBeDefined();
    expect(manifest.agent.category).toBeDefined();
  });

  test("agentEntrypoint returns empty string", async () => {
    const { agentEntrypoint } = await import("../extensions/sdk/templates/agent");
    expect(agentEntrypoint("my-agent", "A cool agent")).toBe("");
  });

  test("agentTest returns test skeleton", async () => {
    const { agentTest } = await import("../extensions/sdk/templates/agent");
    expect(agentTest("my-agent", "A cool agent")).toContain("bun:test");
  });

  test("agentReadme returns markdown", async () => {
    const { agentReadme } = await import("../extensions/sdk/templates/agent");
    expect(agentReadme("my-agent", "A cool agent")).toContain("# my-agent");
  });
});

describe("multi template", () => {
  test("multiManifest generates valid manifest with tools, skills, and agent", async () => {
    const { multiManifest } = await import("../extensions/sdk/templates/multi");
    const ts = multiManifest("my-multi", "A cool multi");
    const manifest = await evalTemplateManifest(ts);
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(true);
    expect(manifest.tools).toHaveLength(1);
    expect(manifest.skills).toHaveLength(1);
    expect(manifest.agent).toBeDefined();
    expect(manifest.entrypoint).toBe("./index.ts");
  });

  test("multiEntrypoint returns non-empty string", async () => {
    const { multiEntrypoint } = await import("../extensions/sdk/templates/multi");
    const code = multiEntrypoint("my-multi", "A cool multi");
    expect(code.length).toBeGreaterThan(0);
    expect(code).toContain("jsonrpc");
  });

  test("multiTest returns test skeleton", async () => {
    const { multiTest } = await import("../extensions/sdk/templates/multi");
    expect(multiTest("my-multi", "A cool multi")).toContain("bun:test");
  });

  test("multiReadme returns markdown", async () => {
    const { multiReadme } = await import("../extensions/sdk/templates/multi");
    expect(multiReadme("my-multi", "A cool multi")).toContain("# my-multi");
  });
});
