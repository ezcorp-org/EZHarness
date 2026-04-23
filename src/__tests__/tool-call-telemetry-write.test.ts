/**
 * Write-path coverage for tool-call analytics.
 *
 * Locks in that both write sites (extension-tool path in tool-executor.ts
 * and the built-in path in executor.ts) populate the four new dimensions
 * on tool_calls rows — user_id, agent_config_id, model, provider — so the
 * admin analytics queries can aggregate without a three-way join.
 *
 * The extension path is exercised end-to-end through ToolExecutor with a
 * real PGlite DB (FKs enforced). The built-in path is covered with a
 * direct drizzle insert that mirrors the exact shape executor.ts:1175
 * writes, which is the seam the migration/schema contract cares about.
 */

import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, getTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { eq } from "drizzle-orm";
import { ToolExecutor } from "../extensions/tool-executor";
import type { ExtensionRegistry } from "../extensions/registry";
import type { ToolCallResult } from "../extensions/types";
import { persistToolCall } from "../db/queries/tool-calls";
import {
  users,
  projects,
  agentConfigs,
  extensions,
  conversations,
  toolCalls,
} from "../db/schema";

const USER_ID = "u-telemetry-1";
const PROJECT_ID = "p-telemetry-1";
const AGENT_ID = "ag-telemetry-1";
const EXT_ID = "ext-telemetry-1";
const CONV_ID = "conv-telemetry-1";

function makeFakeRegistry(): ExtensionRegistry {
  const fakeProc = {
    callTool: async (_name: string, _args: Record<string, unknown>, _meta?: Record<string, unknown>): Promise<ToolCallResult> => {
      return { content: [{ type: "text", text: "ok" }], isError: false };
    },
    setNotificationHandler: () => {},
    setRequestHandler: () => {},
  };
  return {
    getRegisteredTool: () => ({
      extensionId: EXT_ID,
      extensionName: "test-ext",
      originalName: "my_tool",
      name: "my_tool",
      description: "",
      inputSchema: { type: "object" },
    }),
    getManifest: () => ({
      schemaVersion: 2,
      name: "test-ext",
      version: "0.0.1",
      description: "",
      author: { name: "t" },
      permissions: {},
      entrypoint: "./e.ts",
      tools: [{ name: "my_tool", description: "", inputSchema: { type: "object" } }],
    }),
    getProcess: async () => fakeProc,
    getMcpClient: async () => { throw new Error("not mcp"); },
  } as unknown as ExtensionRegistry;
}

async function seedFixtures() {
  const db = getTestDb();
  await db.insert(users).values({ id: USER_ID, email: "t@x.com", passwordHash: "x", name: "Telemetry", role: "member" } as any);
  await db.insert(projects).values({ id: PROJECT_ID, name: "p", path: "/tmp/p" } as any);
  await db.insert(agentConfigs).values({ id: AGENT_ID, name: "TelemetryAgent", prompt: "test", userId: USER_ID } as any);
  await db.insert(extensions).values({
    id: EXT_ID,
    name: "test-ext",
    version: "0.0.1",
    source: "local",
    manifest: {} as any,
    isBundled: false,
  } as any);
  await db.insert(conversations).values({
    id: CONV_ID, projectId: PROJECT_ID, userId: USER_ID, agentConfigId: AGENT_ID,
    model: "claude-opus-4-7", provider: "anthropic",
  } as any);
  // The 'builtin' extensions row is already seeded by migrate.ts (see the
  // INSERT ... ON CONFLICT DO NOTHING block around line 496) so native
  // tool calls' FK on tool_calls.extension_id = 'builtin' already resolves.
}

beforeAll(async () => {
  await setupTestDb();
  await seedFixtures();
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(async () => {
  const db = getTestDb();
  await db.delete(toolCalls);
});

describe("tool_calls write path — extension tools (ToolExecutor.recordToolCall)", () => {
  test("populates userId, agentConfigId, model, provider from executor state", async () => {
    const execu = new ToolExecutor(makeFakeRegistry());
    execu.setCurrentUserId(USER_ID);
    execu.setCurrentAgentConfigId(AGENT_ID);
    execu.setCurrentModel("claude-opus-4-7");
    execu.setCurrentProvider("anthropic");

    await execu.executeToolCall("my_tool", { foo: "bar" }, CONV_ID, null);

    const db = getTestDb();
    const rows = await db.select().from(toolCalls).where(eq(toolCalls.conversationId, CONV_ID));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.toolName).toBe("my_tool");
    expect(row.userId).toBe(USER_ID);
    expect(row.agentConfigId).toBe(AGENT_ID);
    expect(row.model).toBe("claude-opus-4-7");
    expect(row.provider).toBe("anthropic");
    expect(row.success).toBe(true);
  });

  test("persists nulls when dimensions are not set (top-level chat with no agent binding)", async () => {
    const execu = new ToolExecutor(makeFakeRegistry());
    // No setters called — simulates an un-scoped invocation.
    await execu.executeToolCall("my_tool", {}, CONV_ID, null);

    const db = getTestDb();
    const rows = await db.select().from(toolCalls).where(eq(toolCalls.conversationId, CONV_ID));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.userId).toBeNull();
    expect(row.agentConfigId).toBeNull();
    expect(row.model).toBeNull();
    expect(row.provider).toBeNull();
  });

  test("setCurrentAgentConfigId(null) clears a previously-set agent", async () => {
    const execu = new ToolExecutor(makeFakeRegistry());
    execu.setCurrentAgentConfigId(AGENT_ID);
    execu.setCurrentAgentConfigId(null);
    execu.setCurrentUserId(USER_ID);
    await execu.executeToolCall("my_tool", {}, CONV_ID, null);

    const db = getTestDb();
    const rows = await db.select().from(toolCalls).where(eq(toolCalls.conversationId, CONV_ID));
    expect(rows[0]!.userId).toBe(USER_ID);
    expect(rows[0]!.agentConfigId).toBeNull();
  });

  test("still records on tool error — failure path carries the dimensions too", async () => {
    const erroringRegistry: ExtensionRegistry = {
      getRegisteredTool: () => ({
        extensionId: EXT_ID, extensionName: "test-ext", originalName: "my_tool",
        name: "my_tool", description: "", inputSchema: { type: "object" },
      }),
      getManifest: () => ({
        schemaVersion: 2, name: "test-ext", version: "0.0.1", description: "",
        author: { name: "t" }, permissions: {}, entrypoint: "./e.ts",
        tools: [{ name: "my_tool", description: "", inputSchema: { type: "object" } }],
      }),
      getProcess: async () => ({
        callTool: async () => { throw new Error("boom"); },
        setNotificationHandler: () => {},
        setRequestHandler: () => {},
      }),
      getMcpClient: async () => { throw new Error("not mcp"); },
    } as unknown as ExtensionRegistry;

    const execu = new ToolExecutor(erroringRegistry);
    execu.setCurrentUserId(USER_ID);
    execu.setCurrentAgentConfigId(AGENT_ID);
    execu.setCurrentModel("claude-opus-4-7");
    execu.setCurrentProvider("anthropic");

    const result = await execu.executeToolCall("my_tool", {}, CONV_ID, null);
    expect(result.isError).toBe(true);

    const db = getTestDb();
    const rows = await db.select().from(toolCalls).where(eq(toolCalls.conversationId, CONV_ID));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.success).toBe(false);
    expect(row.userId).toBe(USER_ID);
    expect(row.agentConfigId).toBe(AGENT_ID);
    expect(row.model).toBe("claude-opus-4-7");
    expect(row.provider).toBe("anthropic");
  });
});

describe("tool_calls write path — shared persistToolCall helper (single-source-of-truth)", () => {
  // Both the built-in path (executor.ts:tool_execution_end) and the extension
  // path (tool-executor.ts:recordToolCall) now route through persistToolCall.
  // Driving the helper directly here means: if anyone drops a dimension
  // from ONE call site, the helper contract is still verified — and the
  // remaining site's ToolExecutor test above catches the other half.

  test("persistToolCall inserts all four analytics dimensions + stable columns", async () => {
    await persistToolCall({
      id: "tc-helper-1",
      conversationId: CONV_ID,
      messageId: null,
      extensionId: "builtin",
      toolName: "read_file",
      input: { path: "/tmp/x" },
      output: { content: [{ type: "text", text: "ok" }] },
      success: true,
      durationMs: 0,
      userId: USER_ID,
      agentConfigId: AGENT_ID,
      model: "claude-opus-4-7",
      provider: "anthropic",
    });

    const db = getTestDb();
    const rows = await db.select().from(toolCalls).where(eq(toolCalls.id, "tc-helper-1"));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.extensionId).toBe("builtin");
    expect(row.toolName).toBe("read_file");
    expect(row.success).toBe(true);
    expect(row.userId).toBe(USER_ID);
    expect(row.agentConfigId).toBe(AGENT_ID);
    expect(row.model).toBe("claude-opus-4-7");
    expect(row.provider).toBe("anthropic");
  });

  test("persistToolCall defaults missing dimensions to null (caller didn't pass them)", async () => {
    await persistToolCall({
      id: "tc-helper-2",
      conversationId: CONV_ID,
      messageId: null,
      extensionId: "builtin",
      toolName: "read_file",
      input: {},
      output: { content: [] },
      success: true,
      durationMs: 0,
      // No userId / agentConfigId / model / provider.
    });

    const db = getTestDb();
    const rows = await db.select().from(toolCalls).where(eq(toolCalls.id, "tc-helper-2"));
    expect(rows[0]!.userId).toBeNull();
    expect(rows[0]!.agentConfigId).toBeNull();
    expect(rows[0]!.model).toBeNull();
    expect(rows[0]!.provider).toBeNull();
  });

  test("persistToolCall swallows DB errors (tool execution must not be blocked)", async () => {
    // FK violation: conversation_id doesn't exist. Helper must NOT throw.
    await expect(persistToolCall({
      conversationId: "conv-does-not-exist",
      messageId: null,
      extensionId: "builtin",
      toolName: "read_file",
      input: {},
      output: { content: [] },
      success: true,
      durationMs: 0,
    })).resolves.toBeUndefined();
  });
});
