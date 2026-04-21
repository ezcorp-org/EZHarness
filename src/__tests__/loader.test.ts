import { test, expect, describe, afterAll } from "bun:test";
import { loadAgents, loadAgentsStatic } from "../runtime/loader";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentDefinition } from "../types";

let tempDir: string;

describe("loadAgents", () => {
  afterAll(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  test("loads valid .agent.ts file", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-test-"));

    const validAgent = `
export default {
  name: "test-agent",
  description: "A test agent",
  capabilities: ["shell"],
  async execute(ctx) {
    return { success: true, output: "done" };
  },
};
`;
    await Bun.write(join(tempDir, "test.agent.ts"), validAgent);

    const agents = await loadAgents(tempDir);
    expect(agents.size).toBe(1);
    expect(agents.has("test-agent")).toBe(true);

    const agent = agents.get("test-agent")!;
    expect(agent.name).toBe("test-agent");
    expect(typeof agent.execute).toBe("function");
  });

  test("skips invalid agent (missing name)", async () => {
    const invalidDir = await mkdtemp(join(tmpdir(), "agent-invalid-"));

    const invalidAgent = `
export default {
  description: "No name",
  async execute() { return { success: true, output: null }; },
};
`;
    await Bun.write(join(invalidDir, "bad.agent.ts"), invalidAgent);

    const agents = await loadAgents(invalidDir);
    expect(agents.size).toBe(0);

    await rm(invalidDir, { recursive: true, force: true });
  });
});

describe("loadAgentsStatic", () => {
  test("loads array of AgentDefinitions into map", () => {
    const defs: AgentDefinition[] = [
      {
        name: "alpha",
        description: "Alpha agent",
        capabilities: ["llm"],
        execute: async () => ({ success: true, output: "a" }),
      },
      {
        name: "beta",
        description: "Beta agent",
        capabilities: ["shell"],
        execute: async () => ({ success: true, output: "b" }),
      },
    ];

    const map = loadAgentsStatic(defs);
    expect(map.size).toBe(2);
    expect(map.get("alpha")!.name).toBe("alpha");
    expect(map.get("beta")!.name).toBe("beta");
  });
});
