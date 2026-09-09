import { describe, test, expect } from "bun:test";
import { validateManifest } from "@ezcorp/extension-contract";

function evalTemplateManifest(source: string) {
  const prefix = "export default validateManifest(";
  return validateManifest(JSON.parse(source.slice(source.indexOf(prefix) + prefix.length, source.lastIndexOf(");"))));
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
    expect(manifest.schemaVersion).toBe(4);
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.name).toBe("my-tool");
    expect(manifest.description).toBe("A cool tool");
    expect(manifest.tools).toHaveLength(1);
    expect(manifest.entrypoint).toBe("./extension.ts");
    expect(manifest.permissions).toEqual({});
  });

  test("toolEntrypoint returns non-empty string", async () => {
    const { toolEntrypoint } = await import("../../packages/@ezcorp/sdk/src/scaffold/templates/tool");
    const code = toolEntrypoint("my-tool", "A cool tool");
    expect(code.length).toBeGreaterThan(0);
    expect(code).toContain("serve(extension)");
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
    expect(manifest.skills).toHaveLength(1);
    expect(manifest.skills![0]!.prompt).toBeDefined();
  });

  test("skillEntrypoint serves prompt metadata", async () => {
    const { skillEntrypoint } = await import("../../packages/@ezcorp/sdk/src/scaffold/templates/skill");
    expect(skillEntrypoint("my-skill", "A cool skill")).toContain("serve(extension)");
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
    expect(manifest.agent).toBeDefined();
    expect(manifest.agent!.prompt).toBeDefined();
    expect(manifest.agent!.category).toBeDefined();
  });

  test("agentEntrypoint serves prompt metadata", async () => {
    const { agentEntrypoint } = await import("../../packages/@ezcorp/sdk/src/scaffold/templates/agent");
    expect(agentEntrypoint("my-agent", "A cool agent")).toContain("serve(extension)");
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
    expect(manifest.tools).toHaveLength(1);
    expect(manifest.skills).toHaveLength(1);
    expect(manifest.agent).toBeDefined();
    expect(manifest.entrypoint).toBe("./extension.ts");
  });

  test("multiEntrypoint returns non-empty string", async () => {
    const { multiEntrypoint } = await import("../../packages/@ezcorp/sdk/src/scaffold/templates/multi");
    const code = multiEntrypoint("my-multi", "A cool multi");
    expect(code.length).toBeGreaterThan(0);
    expect(code).toContain("serve(extension)");
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
