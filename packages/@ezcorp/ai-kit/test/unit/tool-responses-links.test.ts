import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EzcorpClient } from "../../src/client.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { startStubServer, type StubServer } from "../fixtures/stub-server.js";

/** Asserts that every tool response for an entity-producing tool
 *  includes a clickable `url` (+ `markdownLink`) that points at the
 *  configured `publicUrl`. Covers the two problems the feature solves:
 *  (1) always include a deep link, (2) respect cross-domain hosting. */
describe("tool responses include entity links", () => {
  const PUBLIC = "https://ezcorp.example.com";
  let stub: StubServer;
  let mcpClient: Client;

  beforeEach(async () => {
    stub = startStubServer();
    // baseUrl points at loopback (stub); publicUrl is the user-facing
    // origin — mirrors the real deployment where the subprocess talks
    // to the API on localhost but links must land on the public domain.
    const ezClient = new EzcorpClient({ baseUrl: stub.url, publicUrl: PUBLIC });
    const server = createMcpServer(ezClient);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    mcpClient = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    await mcpClient.connect(clientTransport);
  });

  afterEach(async () => {
    await mcpClient.close();
    stub.stop();
  });

  const textOf = (res: unknown): string =>
    ((res as { content: Array<{ type: string; text: string }> }).content)[0]?.text ?? "{}";

  test("start_chat response includes url pointing at publicUrl", async () => {
    const res = await mcpClient.callTool({
      name: "start_chat",
      arguments: { projectId: "global" },
    });
    const body = JSON.parse(textOf(res)) as {
      id: string;
      url: string;
      markdownLink: string;
    };
    expect(body.url).toBe(`${PUBLIC}/project/global/chat/${body.id}`);
    expect(body.markdownLink).toMatch(/^\[.+\]\(https:\/\/ezcorp\.example\.com\/.+\)$/);
  });

  test("send_message response includes conversationUrl + runUrl", async () => {
    const convRes = await mcpClient.callTool({
      name: "start_chat",
      arguments: { projectId: "global" },
    });
    const conv = JSON.parse(textOf(convRes)) as { id: string };

    const msgRes = await mcpClient.callTool({
      name: "send_message",
      arguments: { conversationId: conv.id, content: "hi" },
    });
    const body = JSON.parse(textOf(msgRes)) as {
      runId: string;
      conversationUrl: string;
      runUrl: string;
    };
    expect(body.conversationUrl).toBe(`${PUBLIC}/project/global/chat/${conv.id}`);
    expect(body.runUrl).toBe(`${PUBLIC}/runs/${body.runId}`);
  });

  test("cancel_run response includes conversation url", async () => {
    const convRes = await mcpClient.callTool({
      name: "start_chat",
      arguments: { projectId: "global" },
    });
    const conv = JSON.parse(textOf(convRes)) as { id: string };
    const cancel = await mcpClient.callTool({
      name: "cancel_run",
      arguments: { conversationId: conv.id },
    });
    const body = JSON.parse(textOf(cancel)) as { ok: boolean; url: string };
    expect(body.url).toBe(`${PUBLIC}/project/global/chat/${conv.id}`);
  });

  test("list_sub_conversations returns array with per-item urls", async () => {
    const convRes = await mcpClient.callTool({
      name: "start_chat",
      arguments: { projectId: "global" },
    });
    const conv = JSON.parse(textOf(convRes)) as { id: string };
    // Spawn a sub-conversation by starting an assignment — its stub
    // fake creates a child conv parented at `conv.id`.
    await mcpClient.callTool({
      name: "start_assignment",
      arguments: { conversationId: conv.id, taskId: "t1", assignmentId: "a1" },
    });
    const list = await mcpClient.callTool({
      name: "list_sub_conversations",
      arguments: { conversationId: conv.id },
    });
    const subs = JSON.parse(textOf(list)) as Array<{ id: string; url: string }>;
    expect(Array.isArray(subs)).toBe(true);
    expect(subs.length).toBeGreaterThan(0);
    for (const s of subs) {
      expect(s.url).toBe(`${PUBLIC}/project/global/chat/${s.id}`);
    }
  });

  test("create_agent response includes agent url by name", async () => {
    const res = await mcpClient.callTool({
      name: "create_agent",
      arguments: { name: "Reviewer", prompt: "You review." },
    });
    const body = JSON.parse(textOf(res)) as { name: string; url: string };
    expect(body.url).toBe(`${PUBLIC}/agents/Reviewer`);
  });

  test("spawn_chats response includes a url + runUrl per chat", async () => {
    const res = await mcpClient.callTool({
      name: "spawn_chats",
      arguments: {
        chats: [
          { projectId: "global", initialMessage: "A" },
          { projectId: "global", initialMessage: "B" },
        ],
      },
    });
    const body = JSON.parse(textOf(res)) as {
      chats: Array<{ conversationId: string; runId: string; url: string; runUrl: string }>;
    };
    expect(body.chats).toHaveLength(2);
    for (const c of body.chats) {
      expect(c.url).toBe(`${PUBLIC}/project/global/chat/${c.conversationId}`);
      expect(c.runUrl).toBe(`${PUBLIC}/runs/${c.runId}`);
    }
  });

  test("start_assignment response includes sub-chat + run urls", async () => {
    const convRes = await mcpClient.callTool({
      name: "start_chat",
      arguments: { projectId: "global" },
    });
    const conv = JSON.parse(textOf(convRes)) as { id: string };
    const res = await mcpClient.callTool({
      name: "start_assignment",
      arguments: { conversationId: conv.id, taskId: "t1", assignmentId: "a1" },
    });
    const body = JSON.parse(textOf(res)) as {
      subConversationId: string;
      runId: string;
      subConversationUrl: string;
      runUrl: string;
    };
    expect(body.subConversationUrl).toBe(
      `${PUBLIC}/project/global/chat/${body.subConversationId}`,
    );
    expect(body.runUrl).toBe(`${PUBLIC}/runs/${body.runId}`);
  });

  test("spawn_agents response includes conversation + run urls", async () => {
    const convRes = await mcpClient.callTool({
      name: "start_chat",
      arguments: { projectId: "global" },
    });
    const conv = JSON.parse(textOf(convRes)) as { id: string };
    const res = await mcpClient.callTool({
      name: "spawn_agents",
      arguments: { conversationId: conv.id, agents: ["a1", "a2"], task: "go" },
    });
    const body = JSON.parse(textOf(res)) as {
      runId: string;
      conversationUrl: string;
      runUrl: string;
    };
    expect(body.conversationUrl).toBe(`${PUBLIC}/project/global/chat/${conv.id}`);
    expect(body.runUrl).toBe(`${PUBLIC}/runs/${body.runId}`);
  });
});

describe("publicUrl precedence on EzcorpClient", () => {
  test("explicit publicUrl option wins over env and baseUrl", () => {
    const prev = process.env.EZCORP_PUBLIC_URL;
    process.env.EZCORP_PUBLIC_URL = "https://from-env.test";
    try {
      const c = new EzcorpClient({
        baseUrl: "http://localhost:9999",
        publicUrl: "https://explicit.test",
      });
      expect(c.publicUrl).toBe("https://explicit.test");
    } finally {
      if (prev === undefined) delete process.env.EZCORP_PUBLIC_URL;
      else process.env.EZCORP_PUBLIC_URL = prev;
    }
  });

  test("env var wins over baseUrl when publicUrl option absent", () => {
    const prev = process.env.EZCORP_PUBLIC_URL;
    process.env.EZCORP_PUBLIC_URL = "https://from-env.test";
    try {
      const c = new EzcorpClient({ baseUrl: "http://localhost:9999" });
      expect(c.publicUrl).toBe("https://from-env.test");
    } finally {
      if (prev === undefined) delete process.env.EZCORP_PUBLIC_URL;
      else process.env.EZCORP_PUBLIC_URL = prev;
    }
  });

  test("baseUrl is the fallback when no option or env is set", () => {
    const prev = process.env.EZCORP_PUBLIC_URL;
    delete process.env.EZCORP_PUBLIC_URL;
    try {
      const c = new EzcorpClient({ baseUrl: "http://localhost:9999" });
      expect(c.publicUrl).toBe("http://localhost:9999");
    } finally {
      if (prev !== undefined) process.env.EZCORP_PUBLIC_URL = prev;
    }
  });

  test("trailing slashes are stripped from publicUrl", () => {
    const c = new EzcorpClient({
      baseUrl: "http://localhost:9999",
      publicUrl: "https://example.com///",
    });
    expect(c.publicUrl).toBe("https://example.com");
  });
});

describe("_meta.ezPublicUrl overrides client.publicUrl inside a tool call", () => {
  let stub: StubServer;
  let mcpClient: Client;

  beforeEach(async () => {
    stub = startStubServer();
    const ezClient = new EzcorpClient({
      baseUrl: stub.url,
      publicUrl: "https://client-default.test",
    });
    const server = createMcpServer(ezClient);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    mcpClient = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    await mcpClient.connect(clientTransport);
  });
  afterEach(async () => {
    await mcpClient.close();
    stub.stop();
  });

  test("ezPublicUrl from _meta wins over client.publicUrl", async () => {
    const res = await mcpClient.callTool({
      name: "start_chat",
      arguments: { projectId: "global" },
      _meta: { ezPublicUrl: "https://per-call.test" },
    });
    const body = JSON.parse(
      (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}",
    ) as { id: string; url: string };
    expect(body.url).toBe(`https://per-call.test/project/global/chat/${body.id}`);
  });

  test("without ezPublicUrl, client.publicUrl is used", async () => {
    const res = await mcpClient.callTool({
      name: "start_chat",
      arguments: { projectId: "global" },
    });
    const body = JSON.parse(
      (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}",
    ) as { id: string; url: string };
    expect(body.url).toBe(`https://client-default.test/project/global/chat/${body.id}`);
  });
});
