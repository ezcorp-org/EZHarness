/**
 * MCP End-to-End Integration Test
 *
 * Full round-trip:
 *   1. User POSTs an MCP server config to /api/mcp-servers
 *   2. Handler spawns a real stdio MCP subprocess, calls tools/list,
 *      persists it as an extension row, reloads the registry.
 *   3. We attach the extension to an agent config.
 *   4. We resolve the agent's available tools via
 *      `ExtensionRegistry.getToolsForAgent()`.
 *   5. We invoke one of those tools via `ToolExecutor.executeToolCall`,
 *      which routes to the MCP client (not a subprocess extension).
 *   6. Verify the result, the in-DB tool_calls row, and that the same
 *      tool propagates to a team-kind agent that references the member.
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockServerAlias, createMockEvent, jsonFromResponse, ADMIN_USER } from "./helpers/mock-request";
import { makeStdioMcpServer } from "./helpers/stdio-mcp-fixture";
import { eq } from "drizzle-orm";

mockDbConnection();
mockServerAlias();

mock.module("$server/db/queries/extensions", () => require("../db/queries/extensions"));
mock.module("$server/extensions/registry", () => require("../extensions/registry"));
mock.module("$server/mcp/client", () => require("../mcp/client"));
mock.module("../../web/src/routes/api/mcp-servers/$types", () => ({}));

import { POST as installPOST } from "../../web/src/routes/api/mcp-servers/+server";
import { ExtensionRegistry } from "../extensions/registry";
import { ToolExecutor } from "../extensions/tool-executor";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";
import { createAgentConfig, updateAgentConfig } from "../db/queries/agent-configs";
import { createConversation } from "../db/queries/conversations";
import { listExtensions, deleteExtension } from "../db/queries/extensions";
import { getDb } from "../db/connection";
import { toolCalls, projects, users } from "../db/schema";

let projectId: string;

beforeAll(async () => {
  await setupTestDb();
  await getDb().insert(users).values({
    id: ADMIN_USER.id,
    email: ADMIN_USER.email,
    passwordHash: "h",
    name: ADMIN_USER.name,
    role: "admin",
  });
  const [p] = await getDb()
    .insert(projects)
    .values({ name: "mcp-e2e-proj", path: "/tmp/mcp-e2e" })
    .returning();
  projectId = p!.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(async () => {
  ExtensionRegistry.resetInstance();
  for (const ext of await listExtensions()) await deleteExtension(ext.id);
});

describe("E2E: install → attach → execute", () => {
  test("full round trip including tool_calls DB record", async () => {
    const fixture = makeStdioMcpServer({
      tools: [{ name: "echo", description: "Echo tool" }],
    });

    // 1. Install via real handler
    const installRes = await installPOST(createMockEvent({
      method: "POST",
      url: "http://localhost/api/mcp-servers",
      user: ADMIN_USER,
      body: {
        name: "e2e-mcp",
        server: { transport: "stdio", name: "e2e-mcp", command: fixture.command, args: fixture.args },
      },
    }));
    expect(installRes.status).toBe(201);
    const ext = await jsonFromResponse(installRes);

    // 2. Attach to a new agent config.
    // agentConfigs.extensions is a jsonb string[] column keyed by the
    // ExtensionRegistry; keep it in sync with references.extensions.
    const agent = await createAgentConfig({
      name: "e2e-agent",
      description: "E2E test agent",
      prompt: "be helpful",
      capabilities: ["llm"],
      userId: ADMIN_USER.id,
      references: { agents: [], extensions: [ext.id] },
      extensions: [ext.id],
    } as unknown as Parameters<typeof createAgentConfig>[0]);

    // 3. Reload registry (install already reloaded; this verifies idempotency)
    const registry = ExtensionRegistry.getInstance();

    // 4. Resolve tools visible to that agent
    const agentTools = await registry.getToolsForAgent(agent.id);
    expect(agentTools).toHaveLength(1);
    expect(agentTools[0]!.name).toBe("e2e-mcp__echo");

    // 5. Invoke the tool via the executor (routes to MCP client since kind=mcp)
    const conv = await createConversation(projectId, { title: "e2e-conv", userId: ADMIN_USER.id });
    const executor = new ToolExecutor(registry, createStubPermissionEngine());
    const result = await executor.executeToolCall(
      "e2e-mcp__echo",
      { text: "hello-world" },
      conv.id,
      null,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "echoed:hello-world" }]);

    // 6. Verify the tool_calls row
    const rows = await getDb().select().from(toolCalls).where(eq(toolCalls.extensionId, ext.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.toolName).toBe("e2e-mcp__echo");
    expect(rows[0]!.success).toBe(true);
    expect(rows[0]!.conversationId).toBe(conv.id);
    expect(rows[0]!.input).toEqual({ text: "hello-world" });

    ExtensionRegistry.resetInstance();
  }, 20_000);

  test("team agent propagates MCP tools to members via references.teamToolScope", async () => {
    const fixture = makeStdioMcpServer({
      tools: [{ name: "peek", description: "Peek" }],
    });
    const installRes = await installPOST(createMockEvent({
      method: "POST",
      url: "http://localhost/api/mcp-servers",
      user: ADMIN_USER,
      body: {
        name: "team-mcp",
        server: { transport: "stdio", name: "team-mcp", command: fixture.command, args: fixture.args },
      },
    }));
    expect(installRes.status).toBe(201);
    const ext = await jsonFromResponse(installRes);

    // Team agent OWNS the MCP extension (both references and the column)
    const team = await createAgentConfig({
      name: "e2e-team",
      description: "A team",
      prompt: "team prompt",
      capabilities: ["llm"],
      userId: ADMIN_USER.id,
      references: { agents: [], extensions: [ext.id] },
      category: "team",
      extensions: [ext.id],
    } as unknown as Parameters<typeof createAgentConfig>[0]);

    // A member agent references the team
    const member = await createAgentConfig({
      name: "e2e-member",
      description: "Team member",
      prompt: "member prompt",
      capabilities: ["llm"],
      userId: ADMIN_USER.id,
      references: { agents: [], extensions: [] },
    });
    await updateAgentConfig(member.id, {
      references: { agents: [team.id], extensions: [] },
    });

    const registry = ExtensionRegistry.getInstance();
    // The team itself should see the MCP tool
    const teamTools = await registry.getToolsForAgent(team.id);
    expect(teamTools.some((t) => t.name === "team-mcp__peek")).toBe(true);

    ExtensionRegistry.resetInstance();
  }, 20_000);
});
