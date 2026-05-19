import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, getTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

// Must mock before importing modules that use db/connection
mockDbConnection();

import {
  insertObservabilityEvent,
  getConversationObservability,
  getConversationStats,
  getGlobalStats,
} from "../db/queries/observability";
import { startCollector } from "../observability/collector";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import { sql } from "drizzle-orm";

// ── Helpers ──────────────────────────────────────────────────────────

let conversationId: string;
let conversationId2: string;
let messageId: string;

beforeEach(async () => {
  await setupTestDb();
  const db = getTestDb();

  // Seed project
  await db.execute(sql`
    INSERT INTO projects (id, name, path) VALUES ('obs-proj', 'Test', '/tmp')
    ON CONFLICT (id) DO NOTHING
  `);

  // Seed conversations
  const cid1 = crypto.randomUUID();
  const cid2 = crypto.randomUUID();
  await db.execute(sql`INSERT INTO conversations (id, project_id, title) VALUES (${cid1}, 'obs-proj', 'Conv 1')`);
  await db.execute(sql`INSERT INTO conversations (id, project_id, title) VALUES (${cid2}, 'obs-proj', 'Conv 2')`);
  conversationId = cid1;
  conversationId2 = cid2;

  // Seed a message
  const mid = crypto.randomUUID();
  await db.execute(sql`INSERT INTO messages (id, conversation_id, role, content) VALUES (${mid}, ${cid1}, 'user', 'hello')`);
  messageId = mid;

  // Seed an extension
  await db.execute(sql`
    INSERT INTO extensions (id, name, version, manifest, source, install_path)
    VALUES ('ext-1', 'test-ext', '1.0.0', '{"name":"test-ext","version":"1.0.0","entrypoint":"index.ts","tools":[]}'::jsonb, 'local:/tmp', '/tmp/ext')
    ON CONFLICT (id) DO NOTHING
  `);
});

afterAll(async () => {
  await closeTestDb();
});

// ── DB Query Tests ───────────────────────────────────────────────────

describe("observability queries", () => {
  test("insertObservabilityEvent persists event to DB", async () => {
    const event = await insertObservabilityEvent({
      conversationId,
      eventType: "tool_call",
      data: { toolName: "search", extensionId: "ext-1", duration: 150, success: true },
      durationMs: 150,
    });

    expect(event.id).toBeDefined();
    expect(event.conversationId).toBe(conversationId);
    expect(event.eventType).toBe("tool_call");
    expect((event.data as any).toolName).toBe("search");
  });

  test("insertObservabilityEvent with messageId", async () => {
    const event = await insertObservabilityEvent({
      conversationId,
      messageId,
      eventType: "turn_summary",
      data: { tokenUsage: { input: 100, output: 200 }, totalDurationMs: 500 },
      durationMs: 500,
    });

    expect(event.messageId).toBe(messageId);
    expect(event.eventType).toBe("turn_summary");
  });

  test("getConversationObservability returns events ordered by createdAt", async () => {
    await insertObservabilityEvent({
      conversationId,
      eventType: "tool_call",
      data: { toolName: "first", extensionId: "ext-1" },
      durationMs: 100,
    });
    await insertObservabilityEvent({
      conversationId,
      eventType: "tool_call",
      data: { toolName: "second", extensionId: "ext-1" },
      durationMs: 200,
    });

    const events = await getConversationObservability(conversationId);
    expect(events.length).toBe(2);
    expect((events[0]!.data as any).toolName).toBe("first");
    expect((events[1]!.data as any).toolName).toBe("second");
  });

  test("getConversationStats returns per-conversation totals", async () => {
    // Tokens come from messages.usage (authoritative); durations come from
    // observability_events turn_summary rows.
    const db = getTestDb();
    await db.execute(sql`INSERT INTO messages (id, conversation_id, role, content, usage) VALUES (${crypto.randomUUID()}, ${conversationId}, 'assistant', 'turn1', '{"inputTokens":100,"outputTokens":200}'::jsonb)`);
    await db.execute(sql`INSERT INTO messages (id, conversation_id, role, content, usage) VALUES (${crypto.randomUUID()}, ${conversationId}, 'assistant', 'turn2', '{"inputTokens":50,"outputTokens":100}'::jsonb)`);

    await insertObservabilityEvent({
      conversationId,
      eventType: "turn_summary",
      data: { tokenUsage: { input: 100, output: 200 }, totalDurationMs: 500 },
      durationMs: 500,
    });
    await insertObservabilityEvent({
      conversationId,
      eventType: "turn_summary",
      data: { tokenUsage: { input: 50, output: 100 }, totalDurationMs: 300 },
      durationMs: 300,
    });

    const stats = await getConversationStats(conversationId);
    expect(stats.totalInputTokens).toBe(150);
    expect(stats.totalOutputTokens).toBe(300);
    expect(stats.avgDurationMs).toBe(400);
    expect(stats.turnCount).toBe(2);
  });

  test("getGlobalStats aggregates across all conversations", async () => {
    const db = getTestDb();
    await db.execute(sql`INSERT INTO messages (id, conversation_id, role, content, usage) VALUES (${crypto.randomUUID()}, ${conversationId}, 'assistant', 'turn1', '{"inputTokens":100,"outputTokens":200}'::jsonb)`);
    await db.execute(sql`INSERT INTO messages (id, conversation_id, role, content, usage) VALUES (${crypto.randomUUID()}, ${conversationId2}, 'assistant', 'turn2', '{"inputTokens":200,"outputTokens":300}'::jsonb)`);

    const stats = await getGlobalStats();
    expect(stats.totalInputTokens).toBe(300);
    expect(stats.totalOutputTokens).toBe(500);
    expect(stats.totalTurnCount).toBe(2);
  });
});

// ── Collector Tests ──────────────────────────────────────────────────

describe("ObservabilityCollector", () => {
  test("persists tool:complete events", async () => {
    const bus = new EventBus<AgentEvents>();
    const unsubscribe = startCollector(bus);

    bus.emit("tool:complete", {
      conversationId,
      extensionId: "ext-1",
      toolName: "search",
      output: { results: [] },
      duration: 150,
      success: true,
    });

    // Allow async processing
    await new Promise((r) => setTimeout(r, 100));

    const events = await getConversationObservability(conversationId);
    expect(events.length).toBe(1);
    expect(events[0]!.eventType).toBe("tool_call");
    expect((events[0]!.data as any).toolName).toBe("search");
    expect((events[0]!.data as any).success).toBe(true);

    unsubscribe();
  });

  test("persists tool:error events", async () => {
    const bus = new EventBus<AgentEvents>();
    const unsubscribe = startCollector(bus);

    bus.emit("tool:error", {
      conversationId,
      extensionId: "ext-1",
      toolName: "broken_tool",
      error: "Connection refused",
      duration: 50,
    });

    await new Promise((r) => setTimeout(r, 100));

    const events = await getConversationObservability(conversationId);
    expect(events.length).toBe(1);
    expect(events[0]!.eventType).toBe("tool_error");
    expect((events[0]!.data as any).error).toBe("Connection refused");

    unsubscribe();
  });

  test("persists obs:turn summary events", async () => {
    const bus = new EventBus<AgentEvents>();
    const unsubscribe = startCollector(bus);

    bus.emit("obs:turn", {
      conversationId,
      messageId,
      llmDurationMs: 300,
      toolDurationMs: 100,
      totalDurationMs: 400,
      tokenUsage: { input: 500, output: 250 },
    });

    await new Promise((r) => setTimeout(r, 100));

    const events = await getConversationObservability(conversationId);
    expect(events.length).toBe(1);
    expect(events[0]!.eventType).toBe("turn_summary");
    expect((events[0]!.data as any).tokenUsage.input).toBe(500);
    expect(events[0]!.durationMs).toBe(400);

    unsubscribe();
  });

  test("startCollector returns working unsubscribe function", async () => {
    const bus = new EventBus<AgentEvents>();
    const unsubscribe = startCollector(bus);
    unsubscribe();

    bus.emit("tool:complete", {
      conversationId,
      extensionId: "ext-1",
      toolName: "after_unsub",
      output: {},
      duration: 10,
      success: true,
    });

    await new Promise((r) => setTimeout(r, 100));

    const events = await getConversationObservability(conversationId);
    expect(events.length).toBe(0);
  });
});
