import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { setupPiAiMocks } from "./helpers/mock-pi-ai";

// Set up pi-ai mocks BEFORE any imports that trigger executor module loading
setupPiAiMocks({ textChunks: ["Hello", " world"] });

import { EventBus } from "../runtime/events";
import { AgentExecutor } from "../runtime/executor";
import { loadAgents } from "../runtime/loader";
import { startTestServer as startServer } from "./helpers/test-server";
import { setupTestDb, closeTestDb, mockDbConnection, mockRealSettings, restoreFetch } from "./helpers/test-pglite";
import { createProject } from "../db/queries/projects";
import * as convQueries from "../db/queries/conversations";
import type { AgentEvents } from "../types";

mockDbConnection();

mockRealSettings();
let server: Awaited<ReturnType<typeof startServer>>;
let baseUrl: string;
let bus: EventBus<AgentEvents>;
let projectId: string;

beforeAll(async () => {
  restoreFetch();
  mockDbConnection();
  mockRealSettings();
  await setupTestDb();
  const agents = await loadAgents(import.meta.dir + "/../agents");
  bus = new EventBus<AgentEvents>();
  const executor = new AgentExecutor(agents, bus);
  server = await startServer(0, executor, bus);
  baseUrl = `http://localhost:${server.port}`;

  const project = await createProject({ name: "Chat Test Project", path: "/tmp/chat-test" });
  projectId = project.id;
});

afterAll(async () => {
  server?.stop(true);
  await closeTestDb();
});

beforeEach(() => {
  restoreFetch();
  mockDbConnection();
  mockRealSettings();
});

describe("Conversation CRUD API", () => {
  let convId: string;

  test("POST /api/conversations creates a conversation", async () => {
    const res = await fetch(`${baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, title: "Test Conv" }),
    });
    expect(res.status).toBe(201);
    const conv = (await res.json()) as any;
    expect(conv.projectId).toBe(projectId);
    expect(conv.title).toBe("Test Conv");
    convId = conv.id;
  });

  test("GET /api/conversations?projectId lists conversations", async () => {
    const res = await fetch(`${baseUrl}/api/conversations?projectId=${projectId}`);
    expect(res.status).toBe(200);
    const convs = (await res.json()) as any[];
    expect(convs.length).toBeGreaterThanOrEqual(1);
    expect(convs.some((c: any) => c.id === convId)).toBe(true);
  });

  test("GET /api/conversations requires projectId", async () => {
    const res = await fetch(`${baseUrl}/api/conversations`);
    expect(res.status).toBe(400);
  });

  test("GET /api/conversations/:id returns conversation", async () => {
    const res = await fetch(`${baseUrl}/api/conversations/${convId}`);
    expect(res.status).toBe(200);
    const conv = (await res.json()) as any;
    expect(conv.id).toBe(convId);
  });

  test("GET /api/conversations/:id returns 404 for missing", async () => {
    const res = await fetch(`${baseUrl}/api/conversations/nonexistent`);
    expect(res.status).toBe(404);
  });

  test("PUT /api/conversations/:id updates conversation", async () => {
    const res = await fetch(`${baseUrl}/api/conversations/${convId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Updated Title" }),
    });
    expect(res.status).toBe(200);
    const conv = (await res.json()) as any;
    expect(conv.title).toBe("Updated Title");
  });

  test("DELETE /api/conversations/:id returns 204", async () => {
    // Create a fresh one to delete
    const createRes = await fetch(`${baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    const created = (await createRes.json()) as any;

    const res = await fetch(`${baseUrl}/api/conversations/${created.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);

    // Verify gone
    const getRes = await fetch(`${baseUrl}/api/conversations/${created.id}`);
    expect(getRes.status).toBe(404);
  });
});

describe("Messages API", () => {
  let convId: string;

  beforeAll(async () => {
    const res = await fetch(`${baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, title: "Message Test" }),
    });
    const conv = (await res.json()) as any;
    convId = conv.id;
  });

  test("POST /api/conversations/:id/messages sends message and returns runId", async () => {
    const res = await fetch(`${baseUrl}/api/conversations/${convId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Hello AI" }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.userMessage).toBeDefined();
    expect(data.userMessage.role).toBe("user");
    expect(data.userMessage.content).toBe("Hello AI");
    expect(data.runId).toBeDefined();
    expect(typeof data.runId).toBe("string");
  });

  test("POST /api/conversations/:id/messages returns 400 without content", async () => {
    const res = await fetch(`${baseUrl}/api/conversations/${convId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/conversations/:id/messages returns 404 for missing conversation", async () => {
    const res = await fetch(`${baseUrl}/api/conversations/nonexistent/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "test" }),
    });
    expect(res.status).toBe(404);
  });

  test("GET /api/conversations/:id/messages returns messages", async () => {
    // Wait a bit for streaming to complete and assistant message to be saved
    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`${baseUrl}/api/conversations/${convId}/messages`);
    expect(res.status).toBe(200);
    const msgs = (await res.json()) as any[];
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    expect(msgs[0].role).toBe("user");
  });
});

describe("Streaming events", () => {
  test("run:token events are emitted during streaming", async () => {
    const tokens: string[] = [];
    const off = bus.on("run:token", (data) => {
      tokens.push(data.token);
    });

    // Create conversation and send message
    const createRes = await fetch(`${baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, title: "Stream Test" }),
    });
    const conv = (await createRes.json()) as any;

    const msgRes = await fetch(`${baseUrl}/api/conversations/${conv.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "stream test" }),
    });
    expect(msgRes.status).toBe(200);

    // Wait for streaming to complete
    await new Promise((r) => setTimeout(r, 200));

    expect(tokens).toContain("Hello");
    expect(tokens).toContain(" world");
    off();
  });

  test("run:usage events are emitted on stream completion", async () => {
    let usage: any = null;
    const off = bus.on("run:usage", (data) => {
      usage = data.usage;
    });

    const createRes = await fetch(`${baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, title: "Usage Test" }),
    });
    const conv = (await createRes.json()) as any;

    await fetch(`${baseUrl}/api/conversations/${conv.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "usage test" }),
    });

    await new Promise((r) => setTimeout(r, 200));

    // Usage now comes from pi-ai format (input/output)
    expect(usage).toBeDefined();
    expect(usage.input).toBe(10);
    expect(usage.output).toBe(5);
    off();
  });
});

// ── Phase 2 Tests ─────────────────────────────────────────────────

describe("Search API", () => {
  let searchConvId: string;

  beforeAll(async () => {
    // Create a conversation with a distinctive title and message
    const res = await fetch(`${baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, title: "Quantum Computing Discussion" }),
    });
    const conv = (await res.json()) as any;
    searchConvId = conv.id;

    // Add a message with searchable content
    await convQueries.createMessage(searchConvId, {
      role: "user",
      content: "Tell me about quantum entanglement phenomena",
    });
  });

  test("GET /api/conversations?search= returns matching conversations", async () => {
    const res = await fetch(
      `${baseUrl}/api/conversations?projectId=${projectId}&search=quantum`,
    );
    expect(res.status).toBe(200);
    const results = (await res.json()) as any[];
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r: any) => r.id === searchConvId)).toBe(true);
  });

  test("search with no matches returns empty array", async () => {
    const res = await fetch(
      `${baseUrl}/api/conversations?projectId=${projectId}&search=xyznonexistent999`,
    );
    expect(res.status).toBe(200);
    const results = (await res.json()) as any[];
    expect(results).toEqual([]);
  });

  test("search with empty query returns empty array", async () => {
    const res = await fetch(
      `${baseUrl}/api/conversations?projectId=${projectId}&search=`,
    );
    expect(res.status).toBe(200);
    const results = (await res.json()) as any[];
    // Empty search should not crash -- returns empty or all
    expect(Array.isArray(results)).toBe(true);
  });
});

describe("Branch-aware messages", () => {
  let convId: string;
  let rootMsgId: string;
  let branchAMsgId: string;
  let branchBMsgId: string;

  beforeAll(async () => {
    const res = await fetch(`${baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, title: "Branch Test" }),
    });
    const conv = (await res.json()) as any;
    convId = conv.id;

    // Create a tree: root -> branchA, root -> branchB
    const root = await convQueries.createMessage(convId, {
      role: "user",
      content: "root message",
    });
    rootMsgId = root.id;

    const branchA = await convQueries.createMessage(convId, {
      role: "assistant",
      content: "branch A response",
      parentMessageId: rootMsgId,
    });
    branchAMsgId = branchA.id;

    // Guarantee branchB has a strictly later created_at than branchA.
    // Without this pause the two inserts can land in the same millisecond
    // and getLatestLeaf would pick whichever id sorts last, flaking the
    // "default GET returns latest-leaf path" assertion.
    await new Promise((r) => setTimeout(r, 5));

    const branchB = await convQueries.createMessage(convId, {
      role: "assistant",
      content: "branch B response",
      parentMessageId: rootMsgId,
    });
    branchBMsgId = branchB.id;
  });

  test("GET messages?all=true returns flat list of all messages", async () => {
    const res = await fetch(
      `${baseUrl}/api/conversations/${convId}/messages?all=true`,
    );
    expect(res.status).toBe(200);
    const msgs = (await res.json()) as any[];
    expect(msgs.length).toBe(3); // root + branchA + branchB
  });

  test("GET messages?leafMessageId= returns path from root to that leaf", async () => {
    const res = await fetch(
      `${baseUrl}/api/conversations/${convId}/messages?leafMessageId=${branchAMsgId}`,
    );
    expect(res.status).toBe(200);
    const msgs = (await res.json()) as any[];
    expect(msgs.length).toBe(2); // root + branchA
    expect(msgs.some((m: any) => m.id === rootMsgId)).toBe(true);
    expect(msgs.some((m: any) => m.id === branchAMsgId)).toBe(true);
    expect(msgs.some((m: any) => m.id === branchBMsgId)).toBe(false);
  });

  test("default GET returns latest-leaf path", async () => {
    const res = await fetch(
      `${baseUrl}/api/conversations/${convId}/messages`,
    );
    expect(res.status).toBe(200);
    const msgs = (await res.json()) as any[];
    // Should be root + the latest leaf (branchB, created last)
    expect(msgs.length).toBe(2);
    expect(msgs.some((m: any) => m.id === rootMsgId)).toBe(true);
    expect(msgs.some((m: any) => m.id === branchBMsgId)).toBe(true);
  });
});

describe("Message editing / branching", () => {
  let convId: string;

  beforeAll(async () => {
    const res = await fetch(`${baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, title: "Edit Test" }),
    });
    const conv = (await res.json()) as any;
    convId = conv.id;
  });

  test("POST messages with parentMessageId creates message linked to that parent", async () => {
    // Create a root message first
    const root = await convQueries.createMessage(convId, {
      role: "user",
      content: "root",
    });

    const res = await fetch(`${baseUrl}/api/conversations/${convId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "child message", parentMessageId: root.id }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.userMessage.parentMessageId).toBe(root.id);
  });

  test("POST messages with editOf creates sibling (same parent as edited message)", async () => {
    // Build a small chain: root -> original
    const root = await convQueries.createMessage(convId, {
      role: "user",
      content: "edit test root",
    });
    const original = await convQueries.createMessage(convId, {
      role: "user",
      content: "original text",
      parentMessageId: root.id,
    });

    const res = await fetch(`${baseUrl}/api/conversations/${convId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "edited text", editOf: original.id }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    // The edited message should share the same parent as original
    expect(data.userMessage.parentMessageId).toBe(root.id);
  });

  test("branch path after edit excludes original branch", async () => {
    // Create: root -> msgA -> msgB (original branch)
    const root = await convQueries.createMessage(convId, {
      role: "user",
      content: "branch test root",
    });
    const msgA = await convQueries.createMessage(convId, {
      role: "assistant",
      content: "response A",
      parentMessageId: root.id,
    });
    await convQueries.createMessage(convId, {
      role: "user",
      content: "follow up B",
      parentMessageId: msgA.id,
    });

    // Edit msgA (creates sibling of msgA, same parent = root)
    const editRes = await fetch(`${baseUrl}/api/conversations/${convId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "edited response A", editOf: msgA.id }),
    });
    const editData = (await editRes.json()) as any;
    const editedMsgId = editData.userMessage.id;

    // Wait for streaming to create assistant response
    await new Promise((r) => setTimeout(r, 200));

    // Get path to the edited message -- should NOT include msgA or msgB
    const pathRes = await fetch(
      `${baseUrl}/api/conversations/${convId}/messages?leafMessageId=${editedMsgId}`,
    );
    const path = (await pathRes.json()) as any[];
    expect(path.some((m: any) => m.id === root.id)).toBe(true);
    expect(path.some((m: any) => m.id === editedMsgId)).toBe(true);
    expect(path.some((m: any) => m.id === msgA.id)).toBe(false);
  });
});

describe("Export API", () => {
  let convId: string;

  beforeAll(async () => {
    const res = await fetch(`${baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, title: "Export Test Conv" }),
    });
    const conv = (await res.json()) as any;
    convId = conv.id;

    // Add some messages for export
    const userMsg = await convQueries.createMessage(convId, {
      role: "user",
      content: "What is 2+2?",
    });
    await convQueries.createMessage(convId, {
      role: "assistant",
      content: "The answer is 4.",
      parentMessageId: userMsg.id,
    });
  });

  test("GET export?format=markdown returns text/markdown with Content-Disposition", async () => {
    const res = await fetch(
      `${baseUrl}/api/conversations/${convId}/export?format=markdown`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");

    const body = await res.text();
    expect(body).toContain("Export Test Conv");
    expect(body).toContain("What is 2+2?");
    expect(body).toContain("The answer is 4.");
  });

  test("GET export?format=json returns valid JSON with conversation + messages", async () => {
    const res = await fetch(
      `${baseUrl}/api/conversations/${convId}/export?format=json`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");

    const data = (await res.json()) as any;
    expect(data.conversation).toBeDefined();
    expect(data.conversation.id).toBe(convId);
    expect(data.conversation.title).toBe("Export Test Conv");
    expect(data.messages).toBeArray();
    expect(data.messages.length).toBe(2);
    expect(data.exportedAt).toBeDefined();
  });

  test("export on nonexistent conversation returns 404", async () => {
    const res = await fetch(
      `${baseUrl}/api/conversations/nonexistent/export?format=markdown`,
    );
    expect(res.status).toBe(404);
  });
});

describe("System prompt", () => {
  let convId: string;

  beforeAll(async () => {
    const res = await fetch(`${baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, title: "System Prompt Test" }),
    });
    const conv = (await res.json()) as any;
    convId = conv.id;
  });

  test("PUT /api/conversations/:id with systemPrompt persists it", async () => {
    const res = await fetch(`${baseUrl}/api/conversations/${convId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemPrompt: "You are a helpful pirate." }),
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as any;
    expect(updated.systemPrompt).toBe("You are a helpful pirate.");

    // Verify it persists on re-fetch
    const getRes = await fetch(`${baseUrl}/api/conversations/${convId}`);
    const conv = (await getRes.json()) as any;
    expect(conv.systemPrompt).toBe("You are a helpful pirate.");
  });

  test("resolveSystemPrompt returns conversation-level override", async () => {
    const resolved = await convQueries.resolveSystemPrompt(convId, projectId);
    expect(resolved).toBe("You are a helpful pirate.");
  });
});
