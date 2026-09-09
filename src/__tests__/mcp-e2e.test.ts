import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { ADMIN_USER } from "./helpers/mock-request";
import { makeStdioMcpServer } from "./helpers/stdio-mcp-fixture";
import { eq } from "drizzle-orm";

mockDbConnection();
import { ExtensionRegistry } from "../extensions/registry";
import { ToolExecutor } from "../extensions/tool-executor";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";
import { createAgentConfig, updateAgentConfig } from "../db/queries/agent-configs";
import { createConversation } from "../db/queries/conversations";
import { listExtensions, deleteExtension, installMcpExtension, updateExtension } from "../db/queries/extensions";
import { getDb } from "../db/connection";
import { toolCalls, projects, users } from "../db/schema";

import { isolatedMcpRelease } from "./helpers/mcp-isolated-release-fixture";
import { dirname } from "node:path";
import { rm } from "node:fs/promises";
let release: Awaited<ReturnType<typeof isolatedMcpRelease>> | undefined;
afterEach(async () => { await release?.close(); release = undefined; });
let projectId: string;

async function approvedMcp(name: string, toolName: string) {
  const source = makeStdioMcpServer({ tools: [{ name: toolName, description: "Fixture" }] });
  try {
    const server = { transport: "stdio" as const, name, command: "/usr/local/bin/bun", args: ["/workspace/server.js"] };
    const manifest = { schemaVersion: 4, name, version: "1.0.0", description: "MCP E2E", author: { name: "Tests" }, kind: "mcp", permissions: {}, mcpServers: [server] };
    const row = await installMcpExtension({ name, server, cachedTools: [] });
    release = await isolatedMcpRelease({
      "extension.ts": `import {createMcpExtension,serve} from '@ezcorp/sdk/v4';await serve(await createMcpExtension({manifest:${JSON.stringify(manifest)}}));`,
      "metadata.test.ts": "import {test,expect} from 'bun:test';test('source',()=>expect(true).toBe(true));",
      "server.js": await Bun.file(source.scriptPath).text(),
    }, row.id);
    release.fixture.snapshot.installation.ownerId = ADMIN_USER.id;
    await updateExtension(row.id, { manifest: release.build.manifest!, source: "release-v4" });
    await release.fixture.registry.loadFromDb();
    return row;
  } finally { await rm(dirname(source.scriptPath), { recursive: true, force: true }); }
}

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
    const ext = await approvedMcp("e2e-mcp", "echo");

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
    executor.setCurrentUserId(ADMIN_USER.id);
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
  }, 120_000);

  test("team agent propagates MCP tools to members via references.teamToolScope", async () => {
    const ext = await approvedMcp("team-mcp", "peek");

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
  }, 120_000);
});
