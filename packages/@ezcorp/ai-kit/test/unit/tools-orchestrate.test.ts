import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EzcorpClient } from "../../src/client.js";
import { register, TOOLS } from "../../src/mcp/tools/orchestrate.js";
import { startStubServer, type StubServer } from "../fixtures/stub-server.js";

describe("tools/orchestrate", () => {
  let stub: StubServer;
  let client: EzcorpClient;
  let server: McpServer;

  beforeEach(() => {
    stub = startStubServer();
    client = new EzcorpClient({ baseUrl: stub.url });
    server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    register(server, client);
  });

  afterEach(() => stub.stop());

  test("TOOLS has 6 entries", () => {
    expect(TOOLS).toHaveLength(6);
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain("list_sub_conversations");
    expect(names).toContain("assign_task");
    expect(names).toContain("start_assignment");
    expect(names).toContain("spawn_chats");
    expect(names).toContain("spawn_agents");
    expect(names).toContain("spawn_team");
  });

  test("spawn_chats description mentions 'root-level'", () => {
    const tool = TOOLS.find((t) => t.name === "spawn_chats")!;
    expect(tool.description).toContain("root-level");
  });

  test("list_sub_conversations returns empty list for a new conversation", async () => {
    const conv = await client.createConversation({ projectId: "global" });
    const subs = await client.getSubConversations(conv.id);
    expect(subs).toHaveLength(0);
  });

  test("assign_task returns an assignment", async () => {
    const conv = await client.createConversation({ projectId: "global" });
    const agentId = "00000000-0000-4000-8000-000000000001";
    const result = await client.assignTask({
      conversationId: conv.id,
      taskId: "task-1",
      agentConfigId: agentId,
    });
    expect(result.assignment).toMatchObject({ status: "assigned" });
    expect(typeof result.assignment.id).toBe("string");
  });

  test("start_assignment spawns a sub-conversation", async () => {
    const conv = await client.createConversation({ projectId: "global" });
    const result = await client.startAssignment({
      conversationId: conv.id,
      taskId: "task-1",
      assignmentId: "assign-1",
    });
    expect(typeof result.runId).toBe("string");
    expect(typeof result.subConversationId).toBe("string");

    // The sub-conversation should appear in list_sub_conversations
    const subs = await client.getSubConversations(conv.id);
    expect(subs.some((s) => s.id === result.subConversationId)).toBe(true);
  });

  test("spawn_chats creates N independent conversations", async () => {
    const result = await client.spawnChats({
      chats: [
        { projectId: "global", initialMessage: "Task 1" },
        { projectId: "global", initialMessage: "Task 2" },
      ],
    });
    expect(result.chats).toHaveLength(2);
    expect(typeof result.chats[0]?.conversationId).toBe("string");
    expect(typeof result.chats[0]?.runId).toBe("string");
    // The two conversations must have different IDs
    expect(result.chats[0]?.conversationId).not.toBe(result.chats[1]?.conversationId);
  });

  test("spawn_agents fan-out: sends message with agent mentions", async () => {
    const conv = await client.createConversation({ projectId: "global" });
    const result = await client.sendMessage(conv.id, {
      content: "![agent:alpha] ![agent:beta] Do the work",
    });
    expect(typeof result.runId).toBe("string");
    const msgs = await client.getMessages(conv.id);
    expect(msgs[0]?.content).toContain("![agent:alpha]");
    expect(msgs[0]?.content).toContain("![agent:beta]");
  });

  test("spawn_team fan-out: sends message with team mention", async () => {
    const conv = await client.createConversation({ projectId: "global" });
    const result = await client.sendMessage(conv.id, {
      content: "![team:devs] Build a feature",
    });
    expect(typeof result.runId).toBe("string");
    const msgs = await client.getMessages(conv.id);
    expect(msgs[0]?.content).toContain("![team:devs]");
  });
});
