import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EzcorpClient } from "../../src/client.js";
import { register, TOOLS } from "../../src/mcp/tools/chat.js";
import { startStubServer, type StubServer } from "../fixtures/stub-server.js";

describe("tools/chat", () => {
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

  test("TOOLS has 5 entries", () => {
    expect(TOOLS).toHaveLength(5);
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain("start_chat");
    expect(names).toContain("send_message");
    expect(names).toContain("get_messages");
    expect(names).toContain("stream_run");
    expect(names).toContain("cancel_run");
  });

  test("start_chat creates a conversation", async () => {
    const conv = await client.createConversation({ projectId: "global" });
    expect(conv).toMatchObject({ projectId: "global" });
    expect(typeof conv.id).toBe("string");
  });

  test("send_message returns runId", async () => {
    const conv = await client.createConversation({ projectId: "global" });
    const result = await client.sendMessage(conv.id, { content: "hello" });
    expect(typeof result.runId).toBe("string");
    expect(result.userMessage.content).toBe("hello");
  });

  test("get_messages returns messages after send", async () => {
    const conv = await client.createConversation({ projectId: "global" });
    await client.sendMessage(conv.id, { content: "hello" });
    const msgs = await client.getMessages(conv.id);
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[0]?.content).toBe("hello");
  });

  test("cancel_run returns ok", async () => {
    const conv = await client.createConversation({ projectId: "global" });
    const result = await client.cancelRun(conv.id);
    expect(result.ok).toBe(true);
  });

  test("cancel_run with force=true also returns ok", async () => {
    const conv = await client.createConversation({ projectId: "global" });
    const result = await client.cancelRun(conv.id, true);
    expect(result.ok).toBe(true);
  });

  test("stream_run collects events for a run", async () => {
    const conv = await client.createConversation({ projectId: "global" });
    const { runId } = await client.sendMessage(conv.id, { content: "hi" });

    // The stub emits run:start, run:token, run:turn_saved, run:complete via queueMicrotask.
    // Give the microtasks a tick to run before we start streaming.
    await new Promise((r) => setTimeout(r, 20));

    const events: unknown[] = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      for await (const ev of client.streamEvents({ signal: controller.signal })) {
        const data = ev.data as Record<string, unknown>;
        if (data["runId"] !== runId) continue;
        events.push(ev);
        if (ev.type === "run:complete" || ev.type === "run:error") break;
      }
    } catch {
      // AbortError is expected if no run:complete found
    } finally {
      clearTimeout(timer);
    }

    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain("run:complete");
  });

  test("stream_run times out when no events match", async () => {
    const conv = await client.createConversation({ projectId: "global" });
    await client.sendMessage(conv.id, { content: "hi" });

    // Use a fake runId that won't match anything
    const fakeRunId = "00000000-0000-0000-0000-000000000000";
    const events: unknown[] = [];
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    try {
      for await (const ev of client.streamEvents({ signal: controller.signal })) {
        const data = ev.data as Record<string, unknown>;
        if (data["runId"] !== fakeRunId) continue;
        events.push(ev);
        if ((ev as { type: string }).type === "run:complete") break;
      }
    } catch {
      // expected abort
    }

    // No events should have matched
    expect(events).toHaveLength(0);
  });
});
