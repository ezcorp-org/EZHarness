/**
 * Daily Briefing — run pipeline integration tests (PGlite + stub executor).
 *
 * Full pipeline against a real schema: config row → run → conversation
 * + synthetic message + assistant content exist with the right
 * userId/projectId; `conversation:created` + `briefing:delivered`
 * emitted; empty-conversation deletion on error/timeout; project
 * fallback chain; catch-up flagging; runtime-registry fallback.
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import {
  runBriefingForUser,
  resolveBriefingProject,
  buildBriefingTitle,
  buildBriefingSystemPrompt,
  buildSyntheticPrompt,
  deleteBriefingConversationIfEmpty,
  notifyBriefingAutoDisabled,
  DEFAULT_BRIEFING_RUN_TIMEOUT_MS,
} from "../runtime/briefing/run";
import {
  registerBriefingRuntime,
  getBriefingRuntime,
  _resetBriefingRuntimeForTests,
  type BriefingExecutor,
} from "../runtime/briefing/runtime-registry";
import { _resetBriefingAgentCacheForTests, BRIEFING_AGENT_NAME } from "../runtime/briefing/agent-config";
import { createMessage, getMessages, getConversation } from "../db/queries/conversations";
import { EventBus } from "../runtime/events";
import type { AgentEvents, AgentRun } from "../types";
import { users, projects, conversations, messages, agentConfigs, briefingConfigs } from "../db/schema";
import type { BriefingConfig } from "../db/queries/briefing-configs";
import { eq } from "drizzle-orm";

const NOW = new Date("2026-06-10T07:00:05.000Z");

let userId: string;
let projectId: string;

function makeConfig(overrides?: Partial<BriefingConfig>): BriefingConfig {
  return {
    userId,
    enabled: true,
    cron: "0 7 * * *",
    timezone: "UTC",
    projectId,
    instructions: "",
    watchlist: [],
    model: null,
    provider: null,
    lastFireAt: null,
    lastFireStatus: null,
    consecutiveErrors: 0,
    nextFireAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as BriefingConfig;
}

interface StubCall {
  conversationId: string;
  userMessage: string;
  options: Record<string, unknown>;
}

/** Build a stub executor whose streamChat writes `assistantContent`
 *  (when non-null) and resolves with the given run status. */
function makeExecutor(opts: {
  assistantContent?: string | null;
  status?: AgentRun["status"];
  error?: unknown;
  neverResolve?: boolean;
}): { executor: BriefingExecutor; calls: StubCall[]; cancelled: string[] } {
  const calls: StubCall[] = [];
  const cancelled: string[] = [];
  const executor = {
    async streamChat(conversationId: string, userMessage: string, options: Record<string, unknown>) {
      calls.push({ conversationId, userMessage, options });
      if (opts.neverResolve) return new Promise<never>(() => {});
      if (opts.assistantContent) {
        await createMessage(conversationId, { role: "assistant", content: opts.assistantContent });
      }
      const status = opts.status ?? "success";
      return {
        id: (options.runId as string) ?? "run-1",
        agentName: "chat",
        status,
        startedAt: Date.now(),
        logs: [],
        ...(status !== "success" ? { result: { success: false, output: null, error: opts.error ?? "boom" } } : {}),
      } as AgentRun;
    },
    cancelRun(id: string) {
      cancelled.push(id);
      return true;
    },
  } as unknown as BriefingExecutor;
  return { executor, calls, cancelled };
}

beforeAll(async () => {
  await setupTestDb();
}, 30_000);

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(async () => {
  _resetBriefingRuntimeForTests();
  _resetBriefingAgentCacheForTests();
  const db = getTestDb();
  await db.delete(briefingConfigs);
  await db.delete(messages);
  await db.delete(conversations);
  await db.delete(agentConfigs);
  await db.delete(projects);
  await db.delete(users);

  const [u] = await db.insert(users).values({ email: "a@t.local", passwordHash: "x", name: "A" }).returning();
  userId = u!.id;
  const [p] = await db.insert(projects).values({ name: "P", path: "/tmp/p" }).returning();
  projectId = p!.id;
});

// ── Pure builders ─────────────────────────────────────────────────

describe("prompt/title builders", () => {
  test("buildBriefingTitle renders weekday + month/day in the user's tz", () => {
    expect(buildBriefingTitle(NOW, "UTC")).toBe("Daily Briefing — Wednesday, Jun 10");
    // 07:00 UTC on Jun 10 is still Jun 9 evening in Honolulu (UTC-10).
    expect(buildBriefingTitle(NOW, "Pacific/Honolulu")).toBe("Daily Briefing — Tuesday, Jun 9");
  });

  test("buildBriefingSystemPrompt embeds the section contract, date, tz, and user instructions", () => {
    const prompt = buildBriefingSystemPrompt({ now: NOW, timezone: "UTC", instructions: "focus on work, skip chit-chat" });
    expect(prompt).toContain("Unfinished business");
    expect(prompt).toContain("Open tasks");
    expect(prompt).toContain("by title, never by id");
    expect(prompt).toContain("Wednesday, June 10, 2026");
    expect(prompt).toContain("timezone: UTC");
    expect(prompt).toContain("## User instructions\nfocus on work, skip chit-chat");
  });

  test("buildBriefingSystemPrompt omits the instructions section when empty/whitespace", () => {
    const prompt = buildBriefingSystemPrompt({ now: NOW, timezone: "UTC", instructions: "   " });
    expect(prompt).not.toContain("## User instructions");
  });

  test("buildSyntheticPrompt embeds the ISO instant and flags catch-up fires", () => {
    const normal = buildSyntheticPrompt(NOW, false);
    expect(normal).toContain(`[Scheduled briefing — ${NOW.toISOString()}]`);
    expect(normal).not.toContain("catch-up");
    const catchUp = buildSyntheticPrompt(NOW, true);
    expect(catchUp).toContain("catch-up");
  });
});

// ── resolveBriefingProject ────────────────────────────────────────

describe("resolveBriefingProject", () => {
  test("uses the configured project when it exists", async () => {
    expect(await resolveBriefingProject(makeConfig())).toBe(projectId);
  });

  test("falls back to the most recently active conversation's project", async () => {
    const db = getTestDb();
    const [p2] = await db.insert(projects).values({ name: "P2", path: "/tmp/p2" }).returning();
    await db.insert(conversations).values({ projectId: p2!.id, title: "Recent", userId });
    const cfg = makeConfig({ projectId: "deleted-project-id" });
    expect(await resolveBriefingProject(cfg)).toBe(p2!.id);
  });

  test("returns null when nothing is resolvable (→ skipped)", async () => {
    expect(await resolveBriefingProject(makeConfig({ projectId: null }))).toBeNull();
  });

  test("prior briefings are excluded from the fallback chain — a user whose only recent conversation is a briefing resolves to null", async () => {
    // Bootstrap the shared agent so the exclusion id resolves, then
    // park the user's ONLY conversation on it (yesterday's briefing).
    const { ensureBriefingAgentConfig } = await import("../runtime/briefing/agent-config");
    const agent = await ensureBriefingAgentConfig();
    await getTestDb().insert(conversations).values({
      projectId,
      title: "Daily Briefing — Tuesday, Jun 9",
      userId,
      agentConfigId: agent.id,
    });
    expect(await resolveBriefingProject(makeConfig({ projectId: null }))).toBeNull();
  });
});

// ── runBriefingForUser ────────────────────────────────────────────

describe("runBriefingForUser", () => {
  test("happy path: conversation + synthetic message + assistant reply, events emitted, correct identity", async () => {
    const { executor, calls } = makeExecutor({ assistantContent: "Good morning — 2 open threads." });
    const bus = new EventBus<AgentEvents>();
    const created: unknown[] = [];
    const delivered: unknown[] = [];
    bus.on("conversation:created", (e) => created.push(e));
    bus.on("briefing:delivered", (e) => delivered.push(e));

    const result = await runBriefingForUser(makeConfig(), {}, { executor, bus, now: () => NOW });
    expect(result.status).toBe("ok");
    expect(result.conversationId).toBeDefined();

    const conv = await getConversation(result.conversationId!);
    expect(conv).not.toBeNull();
    expect(conv!.userId).toBe(userId);
    expect(conv!.projectId).toBe(projectId);
    expect(conv!.title).toBe("Daily Briefing — Wednesday, Jun 10");
    expect(conv!.systemPrompt).toContain("Unfinished business");
    expect(conv!.agentConfigId).toBeTruthy();

    // The shared briefing agent was bootstrapped + attached.
    const db = getTestDb();
    const agents = await db.select().from(agentConfigs).where(eq(agentConfigs.name, BRIEFING_AGENT_NAME));
    expect(agents).toHaveLength(1);
    expect(conv!.agentConfigId).toBe(agents[0]!.id);

    const msgs = await getMessages(result.conversationId!);
    expect(msgs.some((m) => m.role === "user" && m.content.startsWith("[Scheduled briefing —"))).toBe(true);
    expect(msgs.some((m) => m.role === "assistant" && m.content.includes("Good morning"))).toBe(true);

    // streamChat received the executor contract: runId + parent anchored
    // on the synthetic message + the briefing agent config.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.projectId).toBe(projectId);
    expect(calls[0]!.options.agentConfigId).toBe(agents[0]!.id);
    expect(typeof calls[0]!.options.runId).toBe("string");
    // Security contract (spec §9): the unattended pipeline run is
    // read-only — no edit-file/shell on a turn nobody is watching.
    expect(calls[0]!.options.toolRestriction).toBe("read-only");
    const userMsg = msgs.find((m) => m.role === "user");
    expect(calls[0]!.options.parentMessageId).toBe(userMsg!.id);

    expect(created).toHaveLength(1);
    expect(created[0]).toEqual({
      conversationId: result.conversationId,
      projectId,
      userId,
      source: "briefing",
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toEqual({
      userId,
      conversationId: result.conversationId,
      projectId,
    });
  });

  test("model/provider overrides flow into both the conversation row and streamChat", async () => {
    const { executor, calls } = makeExecutor({ assistantContent: "hi" });
    const bus = new EventBus<AgentEvents>();
    const result = await runBriefingForUser(
      makeConfig({ model: "gpt-x", provider: "openai" }),
      {},
      { executor, bus, now: () => NOW },
    );
    expect(result.status).toBe("ok");
    const conv = await getConversation(result.conversationId!);
    expect(conv!.model).toBe("gpt-x");
    expect(conv!.provider).toBe("openai");
    expect(calls[0]!.options.model).toBe("gpt-x");
    expect(calls[0]!.options.provider).toBe("openai");
  });

  test("catch-up fires flag the synthetic prompt", async () => {
    const { executor, calls } = makeExecutor({ assistantContent: "hi" });
    const bus = new EventBus<AgentEvents>();
    await runBriefingForUser(makeConfig(), { catchUp: true }, { executor, bus, now: () => NOW });
    expect(calls[0]!.userMessage).toContain("catch-up");
  });

  test("skipped when no project is resolvable — nothing created, no events", async () => {
    const { executor, calls } = makeExecutor({ assistantContent: "hi" });
    const bus = new EventBus<AgentEvents>();
    const events: unknown[] = [];
    bus.on("briefing:delivered", (e) => events.push(e));
    const result = await runBriefingForUser(makeConfig({ projectId: null }), {}, { executor, bus, now: () => NOW });
    expect(result.status).toBe("skipped");
    expect(calls).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(await getTestDb().select().from(conversations)).toHaveLength(0);
  });

  test("run error with NO assistant content deletes the conversation (empty-failure hygiene)", async () => {
    const { executor } = makeExecutor({ assistantContent: null, status: "error", error: "provider key missing" });
    const bus = new EventBus<AgentEvents>();
    const events: unknown[] = [];
    bus.on("briefing:delivered", (e) => events.push(e));

    const result = await runBriefingForUser(makeConfig(), {}, { executor, bus, now: () => NOW });
    expect(result.status).toBe("error");
    expect(result.error).toContain("provider key missing");
    expect(await getTestDb().select().from(conversations)).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  test("run error after a mid-run USER reply keeps the conversation (the reply is never destroyed)", async () => {
    // The user replies while the run is still streaming, then the run
    // errors with no assistant content. delete-if-empty must treat the
    // real (non-synthetic) user message as preservable content.
    const executor = {
      async streamChat(conversationId: string) {
        await createMessage(conversationId, { role: "user", content: "actually, focus on the launch plan" });
        return {
          id: "run-1",
          agentName: "chat",
          status: "error",
          startedAt: Date.now(),
          logs: [],
          result: { success: false, output: null, error: "provider exploded" },
        } as AgentRun;
      },
      cancelRun() { return true; },
    } as unknown as BriefingExecutor;
    const bus = new EventBus<AgentEvents>();

    const result = await runBriefingForUser(makeConfig(), {}, { executor, bus, now: () => NOW });
    expect(result.status).toBe("error");
    const conv = await getConversation(result.conversationId!);
    expect(conv).not.toBeNull();
    const msgs = await getMessages(result.conversationId!);
    expect(msgs.some((m) => m.content === "actually, focus on the launch plan")).toBe(true);
  });

  test("run error WITH partial assistant content keeps the conversation", async () => {
    const { executor } = makeExecutor({ assistantContent: "partial briefing…", status: "error" });
    const bus = new EventBus<AgentEvents>();
    const result = await runBriefingForUser(makeConfig(), {}, { executor, bus, now: () => NOW });
    expect(result.status).toBe("error");
    const conv = await getConversation(result.conversationId!);
    expect(conv).not.toBeNull();
  });

  test("structured run errors are stringified", async () => {
    const { executor } = makeExecutor({ status: "error", error: { code: "cancelled", message: "run cancelled" } });
    const bus = new EventBus<AgentEvents>();
    const result = await runBriefingForUser(makeConfig(), {}, { executor, bus, now: () => NOW });
    expect(result.status).toBe("error");
    expect(result.error).toContain("cancelled");
  });

  test("timeout cancels the run and deletes the empty conversation", async () => {
    const { executor, cancelled, calls } = makeExecutor({ neverResolve: true });
    const bus = new EventBus<AgentEvents>();
    const result = await runBriefingForUser(makeConfig(), {}, {
      executor,
      bus,
      now: () => NOW,
      runTimeoutMs: 20,
    });
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/timed out/);
    expect(cancelled).toEqual([calls[0]!.options.runId as string]);
    expect(await getTestDb().select().from(conversations)).toHaveLength(0);
  });

  test("a throwing cancelRun after timeout is swallowed (run still errors + cleans up)", async () => {
    const executor = {
      streamChat() { return new Promise(() => {}); },
      cancelRun() { throw new Error("cancel exploded"); },
    } as unknown as BriefingExecutor;
    const bus = new EventBus<AgentEvents>();
    const result = await runBriefingForUser(makeConfig(), {}, {
      executor,
      bus,
      now: () => NOW,
      runTimeoutMs: 20,
    });
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/timed out/);
    expect(await getTestDb().select().from(conversations)).toHaveLength(0);
  });

  test("a 'successful' run without assistant content is treated as an error + deleted", async () => {
    const { executor } = makeExecutor({ assistantContent: null, status: "success" });
    const bus = new EventBus<AgentEvents>();
    const result = await runBriefingForUser(makeConfig(), {}, { executor, bus, now: () => NOW });
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/without assistant content/);
    expect(await getTestDb().select().from(conversations)).toHaveLength(0);
  });

  test("a 'successful' run with only a user reply still errors but keeps the conversation", async () => {
    const executor = {
      async streamChat(conversationId: string) {
        await createMessage(conversationId, { role: "user", content: "are you there?" });
        return { id: "run-1", agentName: "chat", status: "success", startedAt: Date.now(), logs: [] } as AgentRun;
      },
      cancelRun() { return true; },
    } as unknown as BriefingExecutor;
    const bus = new EventBus<AgentEvents>();
    const result = await runBriefingForUser(makeConfig(), {}, { executor, bus, now: () => NOW });
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/without assistant content/);
    expect(await getConversation(result.conversationId!)).not.toBeNull();
  });

  test("streamChat throwing is folded into an error result + delete-if-empty", async () => {
    const executor = {
      async streamChat() { throw new Error("connection refused"); },
      cancelRun() { return true; },
    } as unknown as BriefingExecutor;
    const bus = new EventBus<AgentEvents>();
    const result = await runBriefingForUser(makeConfig(), {}, { executor, bus, now: () => NOW });
    expect(result.status).toBe("error");
    expect(result.error).toContain("connection refused");
    expect(await getTestDb().select().from(conversations)).toHaveLength(0);
  });

  test("falls back to the registered runtime when no deps are injected", async () => {
    const { executor } = makeExecutor({ assistantContent: "from registry" });
    const bus = new EventBus<AgentEvents>();
    registerBriefingRuntime({ executor, bus });
    expect(getBriefingRuntime()).not.toBeNull();

    const result = await runBriefingForUser(makeConfig(), {}, { now: () => NOW });
    expect(result.status).toBe("ok");
  });

  test("errors cleanly when no runtime is registered and none injected", async () => {
    const result = await runBriefingForUser(makeConfig());
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/runtime not registered/);
  });

  test("default per-fire timeout is 5 minutes", () => {
    expect(DEFAULT_BRIEFING_RUN_TIMEOUT_MS).toBe(300_000);
  });
});

// ── deleteBriefingConversationIfEmpty ─────────────────────────────

describe("deleteBriefingConversationIfEmpty", () => {
  test("deletes when there is no assistant content; keeps otherwise", async () => {
    const db = getTestDb();
    const [empty] = await db.insert(conversations).values({ projectId, title: "Empty", userId }).returning();
    await createMessage(empty!.id, { role: "user", content: buildSyntheticPrompt(NOW, false) });
    expect(await deleteBriefingConversationIfEmpty(empty!.id)).toBe(true);
    expect(await getConversation(empty!.id)).toBeNull();

    const [full] = await db.insert(conversations).values({ projectId, title: "Full", userId }).returning();
    await createMessage(full!.id, { role: "assistant", content: "content" });
    expect(await deleteBriefingConversationIfEmpty(full!.id)).toBe(false);
    expect(await getConversation(full!.id)).not.toBeNull();
  });

  test("a real user reply counts as content; the synthetic prompt alone does not", async () => {
    const db = getTestDb();
    // Synthetic prompt only → still "empty".
    const [synthetic] = await db.insert(conversations).values({ projectId, title: "Synthetic", userId }).returning();
    await createMessage(synthetic!.id, { role: "user", content: buildSyntheticPrompt(NOW, false) });
    expect(await deleteBriefingConversationIfEmpty(synthetic!.id)).toBe(true);

    // Synthetic prompt + a real user reply → preserved.
    const [replied] = await db.insert(conversations).values({ projectId, title: "Replied", userId }).returning();
    await createMessage(replied!.id, { role: "user", content: buildSyntheticPrompt(NOW, false) });
    await createMessage(replied!.id, { role: "user", content: "hold on — what about the demo?" });
    expect(await deleteBriefingConversationIfEmpty(replied!.id)).toBe(false);
    expect(await getConversation(replied!.id)).not.toBeNull();
  });
});

// ── notifyBriefingAutoDisabled ────────────────────────────────────

describe("notifyBriefingAutoDisabled", () => {
  test("posts a one-time explanatory conversation and emits conversation:created", async () => {
    const bus = new EventBus<AgentEvents>();
    const created: unknown[] = [];
    bus.on("conversation:created", (e) => created.push(e));
    const { executor } = makeExecutor({});

    await notifyBriefingAutoDisabled(makeConfig(), 5, { executor, bus });

    const rows = await getTestDb().select().from(conversations);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("Daily Briefing disabled");
    expect(rows[0]!.userId).toBe(userId);
    const msgs = await getMessages(rows[0]!.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe("assistant");
    expect(msgs[0]!.content).toContain("5 consecutive failed runs");
    expect(created).toHaveLength(1);
  });

  test("no-ops (without throwing) when no project is resolvable", async () => {
    const bus = new EventBus<AgentEvents>();
    const { executor } = makeExecutor({});
    await notifyBriefingAutoDisabled(makeConfig({ projectId: null }), 5, { executor, bus });
    expect(await getTestDb().select().from(conversations)).toHaveLength(0);
  });

  test("swallows downstream failures (no registered runtime, no deps bus)", async () => {
    // resolveDeps returns null → the notification still posts, it just
    // can't emit the bus event.
    await notifyBriefingAutoDisabled(makeConfig(), 5);
    const rows = await getTestDb().select().from(conversations);
    expect(rows).toHaveLength(1);
  });

  test("swallows a throwing bus emit (notification already persisted)", async () => {
    const { executor } = makeExecutor({});
    const bus = {
      emit() { throw new Error("bus exploded"); },
      on() { return () => {}; },
      off() {},
      clear() {},
    } as never;
    await notifyBriefingAutoDisabled(makeConfig(), 5, { executor, bus });
    const rows = await getTestDb().select().from(conversations);
    expect(rows).toHaveLength(1);
  });
});
