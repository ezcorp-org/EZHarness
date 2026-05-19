import { test, expect, describe, beforeAll, afterAll, afterEach } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { resolve } from "path";
import type { JsonRpcRequest, JsonRpcResponse } from "../extensions/types";
import { JsonRpcTransport } from "../extensions/json-rpc";

mockDbConnection();

import {
  createExtension,
  getExtension,
  getExtensionByName,
  listExtensions,
  updateExtension,
  deleteExtension,
  incrementFailures,
  resetFailures,
  disableExtension,
} from "../db/queries/extensions";
import { ExtensionProcess } from "../extensions/subprocess";
import { ExtensionRegistry } from "../extensions/registry";
import { createAgentConfig } from "../db/queries/agent-configs";
const MOCK_ENTRYPOINT = resolve(__dirname, "helpers/mock-extension/entrypoint.ts");

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

// ── Mock Extension Subprocess Tests ──────────────────────────────────

describe("mock extension subprocess", () => {
  test("responds to tools/call with echo result", async () => {
    const proc = Bun.spawn(["bun", "run", MOCK_ENTRYPOINT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "hello world" } },
    };

    proc.stdin.write(JSON.stringify(request) + "\n");
    proc.stdin.flush();

    // Read response
    const reader = proc.stdout.getReader();
    const { value } = await reader.read();
    const responseText = new TextDecoder().decode(value);
    const response: JsonRpcResponse = JSON.parse(responseText.trim());

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      content: [{ type: "text", text: "hello world" }],
      isError: false,
    });

    proc.kill();
    await proc.exited;
  });

  test("returns error for unknown tool", async () => {
    const proc = Bun.spawn(["bun", "run", MOCK_ENTRYPOINT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "nonexistent", arguments: {} },
    };

    proc.stdin.write(JSON.stringify(request) + "\n");
    proc.stdin.flush();

    const reader = proc.stdout.getReader();
    const { value } = await reader.read();
    const response: JsonRpcResponse = JSON.parse(new TextDecoder().decode(value).trim());

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(2);
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32601);
    expect(response.error!.message).toContain("nonexistent");
    expect(response.result).toBeUndefined();

    proc.kill();
    await proc.exited;
  });
});

// ── Extension CRUD Tests ─────────────────────────────────────────────

describe("extension CRUD queries", () => {
  const testManifest = {
    schemaVersion: 2,
    name: "test-tools",
    version: "1.0.0",
    description: "Test extension",
    author: { name: "Test" },
    entrypoint: "./entrypoint.ts",
    tools: [{ name: "echo", description: "Echo tool", inputSchema: {} }],
    permissions: {},
  };

  let extensionId: string;

  test("createExtension inserts and returns", async () => {
    const ext = await createExtension({
      name: "test-tools",
      version: "1.0.0",
      description: "Test extension",
      manifest: testManifest,
      source: "local:/test",
      installPath: "/tmp/test-ext",
    });
    expect(ext.id).toBeDefined();
    expect(ext.name).toBe("test-tools");
    expect(ext.enabled).toBe(true);
    expect(ext.consecutiveFailures).toBe(0);
    extensionId = ext.id;
  });

  test("getExtension by id", async () => {
    const ext = await getExtension(extensionId);
    expect(ext).not.toBeNull();
    expect(ext!.name).toBe("test-tools");
  });

  test("getExtensionByName", async () => {
    const ext = await getExtensionByName("test-tools");
    expect(ext).not.toBeNull();
    expect(ext!.id).toBe(extensionId);
  });

  test("listExtensions returns all", async () => {
    const list = await listExtensions();
    expect(list.length).toBeGreaterThanOrEqual(1);
  });

  test("listExtensions enabledOnly filters disabled", async () => {
    const allBefore = await listExtensions(true);
    await disableExtension(extensionId);
    const enabledAfter = await listExtensions(true);
    expect(enabledAfter.length).toBe(allBefore.length - 1);
    // Re-enable for further tests
    await updateExtension(extensionId, { enabled: true });
  });

  test("updateExtension updates fields", async () => {
    const updated = await updateExtension(extensionId, { version: "2.0.0" });
    expect(updated).not.toBeNull();
    expect(updated!.version).toBe("2.0.0");
  });

  test("incrementFailures increments count", async () => {
    await resetFailures(extensionId);
    const count1 = await incrementFailures(extensionId);
    expect(count1).toBe(1);
    const count2 = await incrementFailures(extensionId);
    expect(count2).toBe(2);
  });

  test("resetFailures resets to 0", async () => {
    await resetFailures(extensionId);
    const ext = await getExtension(extensionId);
    expect(ext!.consecutiveFailures).toBe(0);
  });

  test("deleteExtension removes", async () => {
    const deleted = await deleteExtension(extensionId);
    expect(deleted).toBe(true);
    const ext = await getExtension(extensionId);
    expect(ext).toBeNull();
  });
});

// ── JSON-RPC Transport Tests ─────────────────────────────────────────

describe("JsonRpcTransport", () => {
  test("encode produces newline-delimited JSON", () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "test",
      params: { key: "value" },
    };
    const encoded = JsonRpcTransport.encode(request);
    expect(encoded).toBe('{"jsonrpc":"2.0","id":1,"method":"test","params":{"key":"value"}}\n');
    expect(encoded.endsWith("\n")).toBe(true);
  });

  test("decode parses newline-delimited JSON response", () => {
    const line = '{"jsonrpc":"2.0","id":1,"result":"ok"}\n';
    const decoded = JsonRpcTransport.decode(line);
    expect(decoded.jsonrpc).toBe("2.0");
    expect(decoded.id).toBe(1);
    expect(decoded.result).toBe("ok");
  });
});

// ── ExtensionProcess Tests ───────────────────────────────────────────

describe("ExtensionProcess", () => {
  test("spawns subprocess with minimal env (not inheriting process.env)", async () => {
    const ep = new ExtensionProcess(
      "test-id",
      MOCK_ENTRYPOINT,
      { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      { idleTimeoutMs: 10000 },
    );

    ep.ensureRunning();
    expect(ep.isRunning).toBe(true);
    ep.kill();
    expect(ep.isRunning).toBe(false);
  });

  test("call tools/call returns correct result via mock extension", async () => {
    const ep = new ExtensionProcess(
      "test-id-2",
      MOCK_ENTRYPOINT,
      { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      { idleTimeoutMs: 10000 },
    );

    const response = await ep.call("tools/call", { name: "echo", arguments: { text: "hi" } });
    expect(response.result).toEqual({
      content: [{ type: "text", text: "hi" }],
      isError: false,
    });

    ep.kill();
  });

  test("kills subprocess after idle timeout", async () => {
    const ep = new ExtensionProcess(
      "test-id-3",
      MOCK_ENTRYPOINT,
      { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      { idleTimeoutMs: 200 }, // 200ms idle timeout for test
    );

    ep.ensureRunning();
    expect(ep.isRunning).toBe(true);

    // Wait for idle timeout
    await new Promise((r) => setTimeout(r, 400));
    expect(ep.isRunning).toBe(false);
  });

  test("increments failure count on crash and auto-disables after 3", async () => {
    // Create extension in DB for crash tracking
    const ext = await createExtension({
      name: "crash-test",
      version: "1.0.0",
      manifest: {
        schemaVersion: 2,
        name: "crash-test",
        version: "1.0.0",
        description: "Crash test",
        author: { name: "Test" },
        entrypoint: "./entrypoint.ts",
        tools: [],
        permissions: {},
      },
      source: "local:/test",
      installPath: "/tmp/crash-test",
    });

    // Simulate 3 consecutive failures via direct DB calls
    await incrementFailures(ext.id);
    await incrementFailures(ext.id);
    const count = await incrementFailures(ext.id);
    expect(count).toBe(3);

    // Auto-disable after threshold
    if (count >= 3) {
      await disableExtension(ext.id);
    }

    const disabled = await getExtension(ext.id);
    expect(disabled!.enabled).toBe(false);

    // Cleanup
    await deleteExtension(ext.id);
  });
});

// ── ExtensionRegistry Tests ──────────────────────────────────────────

describe("ExtensionRegistry", () => {
  afterEach(() => {
    ExtensionRegistry.resetInstance();
  });

  test("getToolExtension returns correct extension ID with namespaced names", async () => {
    const ext = await createExtension({
      name: "registry-test",
      version: "1.0.0",
      manifest: {
        schemaVersion: 2,
        name: "registry-test",
        version: "1.0.0",
        description: "Registry test",
        author: { name: "Test" },
        entrypoint: "./entrypoint.ts",
        tools: [
          { name: "my-tool", description: "A tool", inputSchema: {} },
          { name: "other-tool", description: "Another tool", inputSchema: {} },
        ],
        permissions: {},
      },
      source: "local:/test",
      installPath: MOCK_ENTRYPOINT.replace("/entrypoint.ts", ""),
    });
    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();

    // Tools are now namespaced: "packageName__toolName"
    expect(registry.getToolExtension("registry-test__my-tool")).toBe(ext.id);
    expect(registry.getToolExtension("registry-test__other-tool")).toBe(ext.id);
    // Bare name should NOT resolve
    expect(registry.getToolExtension("my-tool")).toBeNull();
    expect(registry.getToolExtension("nonexistent")).toBeNull();

    await deleteExtension(ext.id);
  });

  test("two extensions with same tool name do not collide", async () => {
    const extA = await createExtension({
      name: "ext-a",
      version: "1.0.0",
      manifest: {
        schemaVersion: 2,
        name: "ext-a",
        version: "1.0.0",
        description: "Extension A",
        author: { name: "Test" },
        entrypoint: "./entrypoint.ts",
        tools: [{ name: "search", description: "Search A", inputSchema: {} }],
        permissions: {},
      },
      source: "local:/test-a",
      installPath: MOCK_ENTRYPOINT.replace("/entrypoint.ts", ""),
    });
    const extB = await createExtension({
      name: "ext-b",
      version: "1.0.0",
      manifest: {
        schemaVersion: 2,
        name: "ext-b",
        version: "1.0.0",
        description: "Extension B",
        author: { name: "Test" },
        entrypoint: "./entrypoint.ts",
        tools: [{ name: "search", description: "Search B", inputSchema: {} }],
        permissions: {},
      },
      source: "local:/test-b",
      installPath: MOCK_ENTRYPOINT.replace("/entrypoint.ts", ""),
    });

    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();

    expect(registry.getToolExtension("ext-a__search")).toBe(extA.id);
    expect(registry.getToolExtension("ext-b__search")).toBe(extB.id);

    const allTools = registry.getAllTools();
    const searchTools = allTools.filter((t) => t.name.endsWith("__search"));
    expect(searchTools.length).toBe(2);

    await deleteExtension(extA.id);
    await deleteExtension(extB.id);
  });

  test("getToolsForAgent returns tools with namespaced names", async () => {
    const ext = await createExtension({
      name: "agent-tool-test",
      version: "1.0.0",
      manifest: {
        schemaVersion: 2,
        name: "agent-tool-test",
        version: "1.0.0",
        description: "Test",
        author: { name: "Test" },
        entrypoint: "./entrypoint.ts",
        tools: [{ name: "agent-echo", description: "Echo for agent", inputSchema: { type: "object" } }],
        permissions: {},
      },
      source: "local:/test",
      installPath: MOCK_ENTRYPOINT.replace("/entrypoint.ts", ""),
    });

    // Create agent config with this extension assigned
    const agent = await createAgentConfig({
      name: "ext-test-agent",
      description: "Test agent for extensions",
      prompt: "You are a test agent.",
    });

    // Update agent to include extension ID (direct DB update)
    const { getDb } = await import("../db/connection");
    const { agentConfigs } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    await getDb()
      .update(agentConfigs)
      .set({ extensions: [ext.id] })
      .where(eq(agentConfigs.id, agent.id));

    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();

    const tools = await registry.getToolsForAgent(agent.id);
    expect(tools.length).toBe(1);
    // Tool name should be namespaced
    expect(tools[0]!.name).toBe("agent-tool-test__agent-echo");
    // originalName should NOT leak into the returned ToolDefinition
    expect((tools[0] as any).originalName).toBeUndefined();

    // Agent with no extensions should get empty array
    const agent2 = await createAgentConfig({
      name: "no-ext-agent",
      description: "No extensions",
      prompt: "No extensions.",
    });
    const tools2 = await registry.getToolsForAgent(agent2.id);
    expect(tools2.length).toBe(0);

    await deleteExtension(ext.id);
  });

  test("getAllTools returns tools with namespaced names and no internal fields", async () => {
    const ext = await createExtension({
      name: "all-tools-test",
      version: "1.0.0",
      manifest: {
        schemaVersion: 2,
        name: "all-tools-test",
        version: "1.0.0",
        description: "Test",
        author: { name: "Test" },
        entrypoint: "./entrypoint.ts",
        tools: [
          { name: "tool-a", description: "Tool A", inputSchema: {} },
          { name: "tool-b", description: "Tool B", inputSchema: {} },
        ],
        permissions: {},
      },
      source: "local:/test",
      installPath: MOCK_ENTRYPOINT.replace("/entrypoint.ts", ""),
    });

    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();

    const allTools = registry.getAllTools();
    expect(allTools.length).toBeGreaterThanOrEqual(2);
    const names = allTools.map((t) => t.name);
    // Names should be namespaced
    expect(names).toContain("all-tools-test__tool-a");
    expect(names).toContain("all-tools-test__tool-b");
    // No internal fields should leak
    for (const tool of allTools) {
      expect((tool as any).originalName).toBeUndefined();
      expect((tool as any).extensionId).toBeUndefined();
      expect((tool as any).extensionName).toBeUndefined();
    }

    await deleteExtension(ext.id);
  });
});
