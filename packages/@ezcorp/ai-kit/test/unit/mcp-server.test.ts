import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EzcorpClient } from "../../src/client.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { TOOLS as DISCOVER_TOOLS } from "../../src/mcp/tools/discover.js";
import { TOOLS as CHAT_TOOLS } from "../../src/mcp/tools/chat.js";
import { TOOLS as AGENT_TOOLS } from "../../src/mcp/tools/agents.js";
import { TOOLS as ORCHESTRATE_TOOLS } from "../../src/mcp/tools/orchestrate.js";
import { startStubServer, type StubServer } from "../fixtures/stub-server.js";

const ALL_TOOLS = [
  ...DISCOVER_TOOLS,
  ...CHAT_TOOLS,
  ...AGENT_TOOLS,
  ...ORCHESTRATE_TOOLS,
];

describe("mcp-server (in-memory transport)", () => {
  let stub: StubServer;
  let mcpClient: Client;

  beforeEach(async () => {
    stub = startStubServer();
    const ezClient = new EzcorpClient({ baseUrl: stub.url });
    const server = createMcpServer(ezClient);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    mcpClient = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    await mcpClient.connect(clientTransport);
  });

  afterEach(async () => {
    await mcpClient.close();
    stub.stop();
  });

  test("tools/list returns all expected tool names", async () => {
    const res = await mcpClient.listTools();
    const registeredNames = res.tools.map((t) => t.name).sort();
    const expectedNames = ALL_TOOLS.map((t) => t.name).sort();
    expect(registeredNames).toEqual(expectedNames);
  });

  // Discover category
  test("list_projects returns project list", async () => {
    const res = await mcpClient.callTool({ name: "list_projects", arguments: {} });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "[]";
    const projects = JSON.parse(text) as Array<{ id: string }>;
    expect(Array.isArray(projects)).toBe(true);
    expect(projects[0]?.id).toBe("global");
  });

  // Chat category
  test("start_chat creates a conversation", async () => {
    const res = await mcpClient.callTool({
      name: "start_chat",
      arguments: { projectId: "global" },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}";
    const conv = JSON.parse(text) as { id: string; projectId: string };
    expect(typeof conv.id).toBe("string");
    expect(conv.projectId).toBe("global");
  });

  test("send_message returns runId", async () => {
    const convRes = await mcpClient.callTool({
      name: "start_chat",
      arguments: { projectId: "global" },
    });
    const conv = JSON.parse(
      (convRes.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}",
    ) as { id: string };

    const msgRes = await mcpClient.callTool({
      name: "send_message",
      arguments: { conversationId: conv.id, content: "Hello MCP" },
    });
    const result = JSON.parse(
      (msgRes.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}",
    ) as { runId: string };
    expect(typeof result.runId).toBe("string");
  });

  // Agents category
  test("create_agent creates and returns agent", async () => {
    const res = await mcpClient.callTool({
      name: "create_agent",
      arguments: { name: "SmokeTester", prompt: "You are a smoke-testing agent." },
    });
    const agent = JSON.parse(
      (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}",
    ) as { id: string; name: string };
    expect(agent.name).toBe("SmokeTester");
    expect(typeof agent.id).toBe("string");
  });

  // Orchestrate category
  test("spawn_chats creates N conversations", async () => {
    const res = await mcpClient.callTool({
      name: "spawn_chats",
      arguments: {
        chats: [
          { projectId: "global", initialMessage: "Task A" },
          { projectId: "global", initialMessage: "Task B" },
        ],
      },
    });
    const result = JSON.parse(
      (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}",
    ) as { chats: Array<{ conversationId: string; runId: string }> };
    expect(result.chats).toHaveLength(2);
  });
});
