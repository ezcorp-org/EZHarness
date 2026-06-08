/**
 * ExtensionRegistry.getToolsForAgent — per-tool subset (extensionTools).
 *
 * Verifies the agent execution chokepoint honors agentConfigs.extensionTools:
 *   - absent key / null map → all tools of attached extensions (back-compat)
 *   - empty array for an extension → all its tools
 *   - non-empty array → only those tools, matched against BOTH the namespaced
 *     name and the original (unnamespaced) name
 *   - de-selected tools are stripped; built-in/other extensions untouched
 *
 * Uses a real PGlite (for the agentConfigs row getToolsForAgent queries) plus
 * the registry's in-memory tool map seeded via setExtensionToolsForTest.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { ExtensionRegistry } = await import("../extensions/registry");
const { createAgentConfig } = await import("../db/queries/agent-configs");
type RegisteredTool = import("../extensions/registry").RegisteredTool;

function rt(name: string, originalName: string): RegisteredTool {
  return {
    name,
    originalName,
    extensionId: "ext-tools",
    extensionName: "toolbox",
    description: `stub ${originalName}`,
    inputSchema: { type: "object", properties: {}, required: [] },
  } as RegisteredTool;
}

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(() => {
  ExtensionRegistry.resetInstance();
  ExtensionRegistry.getInstance().setExtensionToolsForTest("ext-tools", [
    rt("toolbox__alpha", "alpha"),
    rt("toolbox__beta", "beta"),
  ]);
});

function namesOf(tools: Array<{ name: string }>): string[] {
  return tools.map((t) => t.name).sort();
}

describe("getToolsForAgent per-tool subset", () => {
  test("non-empty subset narrows to the selected tools (original-name match)", async () => {
    const cfg = await createAgentConfig({
      name: "agent-subset-" + Date.now(),
      prompt: "p",
      extensions: ["ext-tools"],
      extensionTools: { "ext-tools": ["alpha"] },
    } as any);

    const tools = await ExtensionRegistry.getInstance().getToolsForAgent(cfg.id);
    expect(namesOf(tools)).toEqual(["toolbox__alpha"]);
  });

  test("subset matches the namespaced name too", async () => {
    const cfg = await createAgentConfig({
      name: "agent-ns-" + Date.now(),
      prompt: "p",
      extensions: ["ext-tools"],
      extensionTools: { "ext-tools": ["toolbox__beta"] },
    } as any);

    const tools = await ExtensionRegistry.getInstance().getToolsForAgent(cfg.id);
    expect(namesOf(tools)).toEqual(["toolbox__beta"]);
  });

  test("null extensionTools → all tools (back-compat)", async () => {
    const cfg = await createAgentConfig({
      name: "agent-all-" + Date.now(),
      prompt: "p",
      extensions: ["ext-tools"],
      // extensionTools omitted → persists null
    } as any);

    const tools = await ExtensionRegistry.getInstance().getToolsForAgent(cfg.id);
    expect(namesOf(tools)).toEqual(["toolbox__alpha", "toolbox__beta"]);
  });

  test("empty array for an attached extension → all its tools", async () => {
    const cfg = await createAgentConfig({
      name: "agent-empty-" + Date.now(),
      prompt: "p",
      extensions: ["ext-tools"],
      extensionTools: { "ext-tools": [] },
    } as any);

    const tools = await ExtensionRegistry.getInstance().getToolsForAgent(cfg.id);
    expect(namesOf(tools)).toEqual(["toolbox__alpha", "toolbox__beta"]);
  });

  test("unknown agent id → empty", async () => {
    const tools = await ExtensionRegistry.getInstance().getToolsForAgent("does-not-exist");
    expect(tools).toEqual([]);
  });

  test("stripped ToolDefinition shape (no extensionId/originalName leak)", async () => {
    const cfg = await createAgentConfig({
      name: "agent-strip-" + Date.now(),
      prompt: "p",
      extensions: ["ext-tools"],
      extensionTools: { "ext-tools": ["alpha"] },
    } as any);

    const tools = await ExtensionRegistry.getInstance().getToolsForAgent(cfg.id);
    expect(tools).toHaveLength(1);
    expect((tools[0] as any).extensionId).toBeUndefined();
    expect((tools[0] as any).originalName).toBeUndefined();
    expect(tools[0]!.name).toBe("toolbox__alpha");
  });
});
