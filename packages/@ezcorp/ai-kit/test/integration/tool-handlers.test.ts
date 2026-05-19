import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EzcorpClient } from "../../src/client.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { startStubServer, type StubServer } from "../fixtures/stub-server.js";

/** Exercises EVERY registered MCP tool handler through the MCP transport so
 *  that each handler's lines are covered (not just the underlying client
 *  methods). This is the "full sweep" test — per-tool semantics are asserted
 *  in the focused tests under test/unit/tools-*.test.ts. */

interface ToolText {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

const read = (r: unknown): unknown => JSON.parse((r as ToolText).content[0]!.text);

describe("every MCP tool handler round-trips through the transport", () => {
  let stub: StubServer;
  let mcp: Client;
  const uuid = "00000000-0000-4000-8000-000000000001";

  beforeEach(async () => {
    stub = startStubServer();
    const ez = new EzcorpClient({ baseUrl: stub.url });
    const server = createMcpServer(ez);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    mcp = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await mcp.connect(b);
  });

  afterEach(async () => {
    await mcp.close();
    stub.stop();
  });

  // ── Discover ──
  test("list_projects", async () => {
    const res = read(await mcp.callTool({ name: "list_projects", arguments: {} })) as Array<{
      id: string;
    }>;
    expect(res[0]?.id).toBe("global");
  });
  test("list_agents", async () => {
    expect(read(await mcp.callTool({ name: "list_agents", arguments: {} }))).toEqual([]);
  });
  test("search_mentions", async () => {
    const res = read(
      await mcp.callTool({ name: "search_mentions", arguments: { q: "x", type: "agent" } }),
    ) as Array<{ kind: string }>;
    expect(res[0]?.kind).toBe("agent");
  });
  test("list_models", async () => {
    const res = read(await mcp.callTool({ name: "list_models", arguments: {} })) as unknown[];
    expect(Array.isArray(res)).toBe(true);
  });
  test("list_extensions", async () => {
    const res = read(await mcp.callTool({ name: "list_extensions", arguments: {} })) as unknown[];
    expect(res).toEqual([]);
  });

  // ── Chat ──
  test("start_chat + send_message + get_messages + cancel_run", async () => {
    const conv = read(
      await mcp.callTool({ name: "start_chat", arguments: { projectId: "global" } }),
    ) as { id: string };
    const sent = read(
      await mcp.callTool({
        name: "send_message",
        arguments: { conversationId: conv.id, content: "hi" },
      }),
    ) as { runId: string };
    expect(sent.runId).toBeString();

    const msgs = read(
      await mcp.callTool({ name: "get_messages", arguments: { conversationId: conv.id } }),
    ) as unknown[];
    expect(msgs.length).toBeGreaterThan(0);

    const cancelled = read(
      await mcp.callTool({
        name: "cancel_run",
        arguments: { conversationId: conv.id, force: true },
      }),
    ) as { ok: boolean };
    expect(cancelled.ok).toBe(true);
  });

  test("stream_run collects events then hits run:complete", async () => {
    const conv = read(
      await mcp.callTool({ name: "start_chat", arguments: { projectId: "global" } }),
    ) as { id: string };
    const { runId } = read(
      await mcp.callTool({
        name: "send_message",
        arguments: { conversationId: conv.id, content: "go" },
      }),
    ) as { runId: string };
    const res = read(
      await mcp.callTool({
        name: "stream_run",
        arguments: { runId, conversationId: conv.id, timeoutSeconds: 5 },
      }),
    ) as Array<{ type: string }>;
    expect(res.some((e) => e.type === "run:complete")).toBe(true);
  });

  test("stream_run times out when runId never appears", async () => {
    const res = read(
      await mcp.callTool({
        name: "stream_run",
        arguments: { runId: "never-matches", timeoutSeconds: 0.1 },
      }),
    ) as Array<{ type: string }>;
    expect(res.some((e) => e.type === "stream_run:timeout")).toBe(true);
  });

  test("stream_run filters out mismatched conversationId", async () => {
    const conv = read(
      await mcp.callTool({ name: "start_chat", arguments: { projectId: "global" } }),
    ) as { id: string };
    const { runId } = read(
      await mcp.callTool({
        name: "send_message",
        arguments: { conversationId: conv.id, content: "x" },
      }),
    ) as { runId: string };
    // Passing a WRONG conversationId filter should still include events (only matching convId filters out)
    const res = read(
      await mcp.callTool({
        name: "stream_run",
        arguments: { runId, conversationId: "wrong-conv-id", timeoutSeconds: 0.5 },
      }),
    ) as Array<{ type: string }>;
    // Events emitted with the real conversationId are filtered out by the wrong filter -> timeout
    expect(res[res.length - 1]?.type === "stream_run:timeout" || res.length === 0).toBe(true);
  });

  // ── Agents ──
  test("create_agent + get_agent (found + not-found)", async () => {
    const agent = read(
      await mcp.callTool({
        name: "create_agent",
        arguments: { name: "rev", prompt: "you review" },
      }),
    ) as { id: string };
    const fetched = read(
      await mcp.callTool({ name: "get_agent", arguments: { agentId: agent.id } }),
    ) as { id: string };
    expect(fetched.id).toBe(agent.id);

    const missingRes = await mcp.callTool({
      name: "get_agent",
      arguments: { agentId: uuid },
    });
    expect((missingRes as ToolText).isError).toBe(true);
  });

  test("generate_agent wizard (first turn returns clarifying text, second returns config)", async () => {
    const turn1 = read(
      await mcp.callTool({
        name: "generate_agent",
        arguments: { messages: [{ role: "user", content: "build me one" }] },
      }),
    ) as { config: unknown };
    expect(turn1.config).toBeNull();

    const turn2 = read(
      await mcp.callTool({
        name: "generate_agent",
        arguments: {
          messages: [
            { role: "user", content: "build me one" },
            { role: "assistant", content: "ok" },
            { role: "user", content: "reviewer" },
          ],
        },
      }),
    ) as { config: { name: string } };
    expect(turn2.config?.name).toBeString();
  });

  // ── Orchestrate ──
  test("list_sub_conversations returns empty for a fresh parent", async () => {
    const conv = read(
      await mcp.callTool({ name: "start_chat", arguments: { projectId: "global" } }),
    ) as { id: string };
    const subs = read(
      await mcp.callTool({
        name: "list_sub_conversations",
        arguments: { conversationId: conv.id },
      }),
    ) as unknown[];
    expect(subs).toEqual([]);
  });

  test("assign_task + start_assignment spawns a sub-conversation", async () => {
    const conv = read(
      await mcp.callTool({ name: "start_chat", arguments: { projectId: "global" } }),
    ) as { id: string };
    const assigned = read(
      await mcp.callTool({
        name: "assign_task",
        arguments: { conversationId: conv.id, taskId: "t1", agentConfigId: uuid },
      }),
    ) as { assignment: { id: string } };
    const started = read(
      await mcp.callTool({
        name: "start_assignment",
        arguments: {
          conversationId: conv.id,
          taskId: "t1",
          assignmentId: assigned.assignment.id,
        },
      }),
    ) as { subConversationId: string };
    expect(started.subConversationId).toBeString();
  });

  test("spawn_agents composes ![agent:…] mentions", async () => {
    const conv = read(
      await mcp.callTool({ name: "start_chat", arguments: { projectId: "global" } }),
    ) as { id: string };
    const res = read(
      await mcp.callTool({
        name: "spawn_agents",
        arguments: {
          conversationId: conv.id,
          agents: ["a1", "a2"],
          task: "review this",
          model: "claude-sonnet-4-6",
        },
      }),
    ) as { runId: string };
    expect(res.runId).toBeString();
    const msgs = (await new EzcorpClient({ baseUrl: stub.url }).getMessages(conv.id)) as Array<{
      content: string;
    }>;
    expect(msgs[0]?.content).toContain("![agent:a1]");
    expect(msgs[0]?.content).toContain("![agent:a2]");
  });

  test("spawn_team composes a ![team:name] mention", async () => {
    const conv = read(
      await mcp.callTool({ name: "start_chat", arguments: { projectId: "global" } }),
    ) as { id: string };
    const res = read(
      await mcp.callTool({
        name: "spawn_team",
        arguments: {
          conversationId: conv.id,
          teamName: "ProductTeam",
          task: "ship it",
          provider: "anthropic",
        },
      }),
    ) as { runId: string };
    expect(res.runId).toBeString();
    const msgs = (await new EzcorpClient({ baseUrl: stub.url }).getMessages(conv.id)) as Array<{
      content: string;
    }>;
    expect(msgs[0]?.content).toContain("![team:ProductTeam]");
  });

  test("spawn_chats batches N root conversations", async () => {
    const res = read(
      await mcp.callTool({
        name: "spawn_chats",
        arguments: {
          chats: [
            { projectId: "global", initialMessage: "A" },
            { projectId: "global", initialMessage: "B" },
            { projectId: "global", initialMessage: "C" },
          ],
        },
      }),
    ) as { chats: Array<{ conversationId: string; runId: string }> };
    expect(res.chats).toHaveLength(3);
    expect(new Set(res.chats.map((c) => c.conversationId)).size).toBe(3);
  });
});
