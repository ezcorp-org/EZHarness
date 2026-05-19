/**
 * Integration test: ezcorp.config.ts manifest + tool callability
 *
 * Three things asserted here:
 *  1. The manifest passes validateManifestV2 (SDK schema) — schemaVersion 2,
 *     required fields, every tool has name/description/inputSchema, etc.
 *  2. Every tool declared in the manifest is in the locked tool-name list
 *     (coordinates with the MCP engineer's naming convention).
 *  3. Each tool corresponds to a real method on EzcorpClient — called against
 *     the stub server it must return the same response shape that the
 *     corresponding MCP tool handler would surface via ToolCallResult.
 *     This gives us one-implementation parity without requiring the MCP
 *     server binary to exist at test time (which the MCP engineer owns).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { EzcorpClient } from "../../src/client";
import { startStubServer, type StubServer } from "../fixtures/stub-server";

// ── 1. Manifest validation ────────────────────────────────────────────────

// Import the validator from the host project (not the SDK — the SDK just
// re-exports the identity defineExtension; the authoritative validator lives
// in src/extensions/manifest.ts which is what the platform uses at load time).
import { validateManifestV2 } from "../../../../../src/extensions/manifest";
import manifest from "../../ezcorp.config";

// ── Locked tool-name list ─────────────────────────────────────────────────
// Must stay in sync with the plan's "COORDINATE via tool names" section and
// the MCP engineer's src/mcp/tools/*.ts filenames.
const LOCKED_TOOL_NAMES = new Set([
  "start_chat",
  "send_message",
  "spawn_chats",
  "spawn_agents",
  "spawn_team",
  "assign_task",
  "start_assignment",
  "list_sub_conversations",
  "list_projects",
  "list_agents",
  "search_mentions",
  "create_agent",
  "generate_agent",
  "get_agent",
  "get_messages",
  "cancel_run",
  "stream_run",
  "list_models",
  "list_extensions",
]);

describe("ezcorp.config manifest", () => {
  test("passes validateManifestV2", () => {
    const result = validateManifestV2(manifest);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("schemaVersion is the literal number 2", () => {
    expect(manifest.schemaVersion).toBe(2);
  });

  test("name is 'ai-kit'", () => {
    expect(manifest.name).toBe("ai-kit");
  });

  test("version is '0.1.0'", () => {
    expect(manifest.version).toBe("0.1.0");
  });

  test("entrypoint is set (required because tools[] is non-empty)", () => {
    expect(typeof manifest.entrypoint).toBe("string");
    expect(manifest.entrypoint!.length).toBeGreaterThan(0);
  });

  test("every declared tool name is in the locked list", () => {
    const declared = (manifest.tools ?? []).map((t) => t.name);
    for (const name of declared) {
      expect(LOCKED_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  test("all 19 locked tool names are declared", () => {
    const declared = new Set((manifest.tools ?? []).map((t) => t.name));
    for (const name of LOCKED_TOOL_NAMES) {
      expect(declared.has(name)).toBe(true);
    }
  });

  test("every tool has a non-empty description", () => {
    for (const tool of manifest.tools ?? []) {
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  test("every tool has an inputSchema object", () => {
    for (const tool of manifest.tools ?? []) {
      expect(typeof tool.inputSchema).toBe("object");
      expect(tool.inputSchema).not.toBeNull();
    }
  });

  test("skills array has entries with name + description", () => {
    const skills = manifest.skills ?? [];
    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) {
      expect(typeof skill.name).toBe("string");
      expect(typeof skill.description).toBe("string");
    }
  });

  test("permissions.network is declared (localhost at minimum)", () => {
    expect(Array.isArray(manifest.permissions.network)).toBe(true);
    expect((manifest.permissions.network ?? []).length).toBeGreaterThan(0);
  });

  test("scripts.postinstall points to postinstall script", () => {
    expect(manifest.scripts?.postinstall).toBe("scripts/postinstall.ts");
  });
});

// ── 2. Tool–client parity ─────────────────────────────────────────────────
//
// Each tool declared in the manifest wraps a method on EzcorpClient.
// We spin up the stub server and call the corresponding client method for
// every tool.  The expected shape matches what an MCP tool handler returns
// via ToolCallResult.content[0].text — the handler serialises the API
// response as JSON, so we can compare the raw client responses directly.

describe("tool–client parity (stub server)", () => {
  let stub: StubServer;
  let client: EzcorpClient;
  let convId: string;
  let agentId: string;

  beforeAll(() => {
    stub = startStubServer({ apiKey: "test-key" });
    client = new EzcorpClient({ baseUrl: stub.url, apiKey: "test-key" });
  });

  afterAll(() => {
    stub.stop();
  });

  // ── Discovery ──────────────────────────────────────────────────────────

  test("list_projects → array of projects", async () => {
    const result = await client.listProjects();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toHaveProperty("id");
  });

  test("list_agents → array", async () => {
    const result = await client.listAgents();
    expect(Array.isArray(result)).toBe(true);
  });

  test("list_models → array", async () => {
    const result = await client.listModels();
    expect(Array.isArray(result)).toBe(true);
  });

  test("list_extensions → array", async () => {
    const result = await client.listExtensions();
    expect(Array.isArray(result)).toBe(true);
  });

  test("search_mentions → array of hits", async () => {
    const result = await client.searchMentions({ q: "test" });
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]).toHaveProperty("name");
  });

  // ── Agent authoring ────────────────────────────────────────────────────

  test("create_agent → agent with id, name, prompt", async () => {
    const result = await client.createAgent({
      name: "test-agent",
      prompt: "You are a test agent.",
    });
    expect(result).toHaveProperty("id");
    expect(result.name).toBe("test-agent");
    agentId = result.id;
  });

  test("get_agent (list_agents then pick by id) → agent object", async () => {
    // get_agent is surfaced via listAgents + filter in the tool handler.
    // We use the raw client call that the handler will use.
    const agents = await client.listAgents();
    const found = agents.find((a) => a.id === agentId);
    expect(found).toBeDefined();
    expect(found!.id).toBe(agentId);
  });

  test("generate_agent (first turn) → text with no config", async () => {
    const result = await client.generateAgent({
      messages: [{ role: "user", content: "Build me a code reviewer" }],
    });
    expect(typeof result.text).toBe("string");
    expect(result.config).toBeNull();
  });

  test("generate_agent (second turn) → text with config", async () => {
    const result = await client.generateAgent({
      messages: [
        { role: "user", content: "Build me a code reviewer" },
        { role: "assistant", content: "What should I focus on?" },
        { role: "user", content: "correctness" },
      ],
    });
    expect(typeof result.text).toBe("string");
    expect(result.config).not.toBeNull();
    expect(typeof result.config!.name).toBe("string");
    expect(typeof result.config!.prompt).toBe("string");
  });

  // ── Chat ───────────────────────────────────────────────────────────────

  test("start_chat → conversation with id and projectId", async () => {
    const result = await client.createConversation({ projectId: "global" });
    expect(result).toHaveProperty("id");
    expect(result.projectId).toBe("global");
    convId = result.id;
  });

  test("start_chat with parentConversationId → sub-conversation row", async () => {
    const parent = await client.createConversation({ projectId: "global" });
    const child = await client.createConversation({
      projectId: "global",
      parentConversationId: parent.id,
      parentMessageId: "00000000-0000-4000-8000-000000000001",
    });
    expect(child.parentConversationId).toBe(parent.id);
  });

  test("send_message → userMessage + runId", async () => {
    const result = await client.sendMessage(convId, { content: "hello" });
    expect(result).toHaveProperty("runId");
    expect(result.userMessage.role).toBe("user");
  });

  test("get_messages → array of messages", async () => {
    const result = await client.getMessages(convId);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  test("cancel_run → { ok: true }", async () => {
    const result = await client.cancelRun(convId);
    expect(result.ok).toBe(true);
  });

  // ── Orchestration ─────────────────────────────────────────────────────

  test("spawn_chats → chats array with conversationId + runId", async () => {
    const result = await client.spawnChats({
      chats: [
        { projectId: "global", initialMessage: "task A" },
        { projectId: "global", initialMessage: "task B" },
      ],
    });
    expect(result.chats.length).toBe(2);
    for (const entry of result.chats) {
      expect(typeof entry.conversationId).toBe("string");
      expect(typeof entry.runId).toBe("string");
    }
  });

  test("spawn_agents → sends message with ![agent:…] tokens", async () => {
    // spawn_agents is a helper tool that composes mention tokens and calls
    // sendMessage. We verify the client-level send path (tool handler implements
    // the token-building; we test the transport here).
    const conv = await client.createConversation({ projectId: "global" });
    const content = ["![agent:alpha]", "![agent:beta]", "run in parallel"].join(" ");
    const result = await client.sendMessage(conv.id, { content });
    expect(result).toHaveProperty("runId");
  });

  test("spawn_team → sends message with ![team:…] token", async () => {
    const conv = await client.createConversation({ projectId: "global" });
    const content = "![team:devs] autoSpinUp:true please review";
    const result = await client.sendMessage(conv.id, { content });
    expect(result).toHaveProperty("runId");
  });

  test("list_sub_conversations → array filtered by parent", async () => {
    const parent = await client.createConversation({ projectId: "global" });
    await client.createConversation({
      projectId: "global",
      parentConversationId: parent.id,
      parentMessageId: "00000000-0000-4000-8000-000000000002",
    });
    const subs = await client.getSubConversations(parent.id);
    expect(Array.isArray(subs)).toBe(true);
    expect(subs.length).toBeGreaterThan(0);
    expect(subs[0]!.parentConversationId).toBe(parent.id);
  });

  test("assign_task → assignment with id and status", async () => {
    const conv = await client.createConversation({ projectId: "global" });
    const result = await client.assignTask({
      conversationId: conv.id,
      taskId: "task-1",
      agentConfigId: agentId,
    });
    expect(result.assignment).toHaveProperty("id");
    expect(typeof result.assignment.status).toBe("string");
  });

  test("start_assignment → runId + subConversationId", async () => {
    const conv = await client.createConversation({ projectId: "global" });
    const assign = await client.assignTask({
      conversationId: conv.id,
      taskId: "task-2",
      agentConfigId: agentId,
    });
    const result = await client.startAssignment({
      conversationId: conv.id,
      taskId: "task-2",
      assignmentId: assign.assignment.id,
    });
    expect(typeof result.runId).toBe("string");
    expect(typeof result.subConversationId).toBe("string");
  });

  // ── stream_run (SSE consumer) ─────────────────────────────────────────

  test("stream_run → consumes run:complete event", async () => {
    const conv = await client.createConversation({ projectId: "global" });
    const ac = new AbortController();
    const events: Array<{ type: string }> = [];

    const stream = client.streamEvents({ signal: ac.signal });

    // Send message — the stub queues run:start, run:token, run:turn_saved,
    // run:complete as microtasks.
    const { runId } = await client.sendMessage(conv.id, { content: "stream test" });

    // Collect events until run:complete for our runId
    let done = false;
    const timeout = setTimeout(() => {
      done = true;
      ac.abort();
    }, 5000);

    for await (const ev of stream) {
      if ((ev.data as { runId?: string }).runId === runId || !ev.data.runId) {
        events.push({ type: ev.type });
        if (ev.type === "run:complete") {
          done = true;
          clearTimeout(timeout);
          ac.abort();
          break;
        }
      }
      if (done) break;
    }

    const types = events.map((e) => e.type);
    expect(types).toContain("run:complete");
  });
});
