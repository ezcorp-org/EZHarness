/**
 * Daily Briefing — API route integration tests (PGlite + real handlers).
 *
 * Exhaustive status-code coverage per the Phase 1 mandate:
 *   GET  /api/briefing/config   → 200 (defaults), 200 (stored), 401, 403
 *   PUT  /api/briefing/config   → 200, 400 (bad JSON / cron / tz /
 *                                 watchlist), 401, 403, own-config only
 *   POST /api/briefing/run-now  → 202 (stored + default config), 401,
 *                                 403, 429 (+ per-user buckets +
 *                                 Retry-After), 503 (no runtime),
 *                                 error bookkeeping incl. auto-disable
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockServerAlias, createMockEvent, jsonFromResponse } from "./helpers/mock-request";
import type { AuthUser } from "../auth/types";

// ── Module-level mocks (BEFORE handler imports) ──────────────────
mockDbConnection();
mockServerAlias();
mock.module("$server/db/queries/briefing-configs", () => require("../db/queries/briefing-configs"));
mock.module("$server/runtime/briefing/config-validation", () => require("../runtime/briefing/config-validation"));
mock.module("$server/runtime/briefing/runtime-registry", () => require("../runtime/briefing/runtime-registry"));
mock.module("$server/runtime/briefing/run", () => require("../runtime/briefing/run"));
// In-file restore pattern for `$server/logger` (it has no served
// top-level namespace in MODULE_PATHS): snapshot the real module,
// register it, and re-register the SAME exports in afterAll — the
// mock-cleanup coverage meta-test recognizes the ≥2-mocks form.
const realLogger = require("../logger");
mock.module("$server/logger", () => realLogger);
mock.module("$lib/server/http-errors", () => require("../../web/src/lib/server/http-errors"));
mock.module("$lib/server/security/api-keys", () => require("../../web/src/lib/server/security/api-keys"));
mock.module("$lib/server/security/rate-limiter", () => require("../../web/src/lib/server/security/rate-limiter"));
// Shared run-now trigger (Extension Pages Hub): the route delegates to
// this module; alias it to the real web-layer file so the route + the
// hub action exercise ONE rate bucket in these tests.
mock.module("$lib/server/briefing-run-now", () => require("../../web/src/lib/server/briefing-run-now"));
mock.module("../../web/src/routes/api/briefing/config/$types", () => ({}));
mock.module("../../web/src/routes/api/briefing/run-now/$types", () => ({}));

// ── Handler imports ──────────────────────────────────────────────
import { GET as configGet, PUT as configPut } from "../../web/src/routes/api/briefing/config/+server";
import { POST as runNowPost, __rateLimiter, __testHooks } from "../../web/src/routes/api/briefing/run-now/+server";

// ── Backing modules ──────────────────────────────────────────────
import { users, projects, conversations, messages, agentConfigs, briefingConfigs } from "../db/schema";
import { getBriefingConfig, upsertBriefingConfig, BRIEFING_AUTO_DISABLE_AFTER } from "../db/queries/briefing-configs";
import { createMessage } from "../db/queries/conversations";
import {
  registerBriefingRuntime,
  _resetBriefingRuntimeForTests,
  type BriefingExecutor,
} from "../runtime/briefing/runtime-registry";
import { _resetBriefingAgentCacheForTests } from "../runtime/briefing/agent-config";
import { EventBus } from "../runtime/events";
import type { AgentEvents, AgentRun } from "../types";

let userA: AuthUser;
let userB: AuthUser;
let projectId: string;

function makeStubExecutor(opts: { assistantContent?: string | null; fail?: boolean }): BriefingExecutor {
  return {
    async streamChat(conversationId: string, _msg: string, options: Record<string, unknown>) {
      if (opts.fail) throw new Error("provider exploded");
      if (opts.assistantContent) {
        await createMessage(conversationId, { role: "assistant", content: opts.assistantContent });
      }
      return {
        id: options.runId as string,
        agentName: "chat",
        status: "success",
        startedAt: Date.now(),
        logs: [],
      } as AgentRun;
    },
    cancelRun() {
      return true;
    },
  } as unknown as BriefingExecutor;
}

function registerStubRuntime(opts: { assistantContent?: string | null; fail?: boolean } = { assistantContent: "Morning!" }): void {
  registerBriefingRuntime({ executor: makeStubExecutor(opts), bus: new EventBus<AgentEvents>() });
}

async function call(handler: (event: ReturnType<typeof createMockEvent>) => Promise<Response>, event: ReturnType<typeof createMockEvent>): Promise<Response> {
  try {
    return await handler(event);
  } catch (e) {
    return e as Response; // requireAuth throws a Response
  }
}

beforeAll(async () => {
  await setupTestDb();
}, 30_000);

afterAll(async () => {
  // Second registration of the in-file logger snapshot (see the
  // module-level comment) — keeps the alias pointing at the real
  // module for any subsequent file in the same process.
  mock.module("$server/logger", () => realLogger);
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(async () => {
  _resetBriefingRuntimeForTests();
  _resetBriefingAgentCacheForTests();
  __rateLimiter.reset();
  __testHooks.lastRun = undefined;

  const db = getTestDb();
  await db.delete(briefingConfigs);
  await db.delete(messages);
  await db.delete(conversations);
  await db.delete(agentConfigs);
  await db.delete(projects);
  await db.delete(users);

  const [u1] = await db.insert(users).values({ email: "a@t.local", passwordHash: "x", name: "A" }).returning();
  const [u2] = await db.insert(users).values({ email: "b@t.local", passwordHash: "x", name: "B" }).returning();
  userA = { id: u1!.id, email: u1!.email, name: u1!.name, role: "member" };
  userB = { id: u2!.id, email: u2!.email, name: u2!.name, role: "member" };
  const [p] = await db.insert(projects).values({ name: "P", path: "/tmp/p" }).returning();
  projectId = p!.id;
});

// ── GET /api/briefing/config ──────────────────────────────────────

describe("GET /api/briefing/config", () => {
  test("401 unauthenticated", async () => {
    const res = await call(configGet, createMockEvent({ url: "http://localhost/api/briefing/config" }));
    expect(res.status).toBe(401);
  });

  test("403 when the API key lacks the read scope", async () => {
    const event = createMockEvent({ url: "http://localhost/api/briefing/config", user: userA });
    (event.locals as { apiKeyScopes?: string[] }).apiKeyScopes = ["chat"];
    const res = await call(configGet, event);
    expect(res.status).toBe(403);
  });

  test("200 with documented defaults when never configured (no row minted)", async () => {
    const res = await call(configGet, createMockEvent({ user: userA }));
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data).toEqual({
      userId: userA.id,
      enabled: false,
      cron: "0 7 * * *",
      timezone: "UTC",
      projectId: null,
      instructions: "",
      watchlist: [],
      model: null,
      provider: null,
      lastFireAt: null,
      lastFireStatus: null,
      consecutiveErrors: 0,
      nextFireAt: null,
    });
    expect(await getBriefingConfig(userA.id)).toBeNull(); // read never writes
  });

  test("200 with the stored row", async () => {
    await upsertBriefingConfig(userA.id, { enabled: true, instructions: "focus", projectId });
    const res = await call(configGet, createMockEvent({ user: userA }));
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.enabled).toBe(true);
    expect(data.instructions).toBe("focus");
    expect(data.projectId).toBe(projectId);
    expect(data.nextFireAt).not.toBeNull();
  });
});

// ── PUT /api/briefing/config ──────────────────────────────────────

describe("PUT /api/briefing/config", () => {
  test("401 unauthenticated", async () => {
    const res = await call(configPut, createMockEvent({ method: "PUT", body: {} }));
    expect(res.status).toBe(401);
  });

  test("403 when the API key lacks the chat scope", async () => {
    const event = createMockEvent({ method: "PUT", body: { enabled: true }, user: userA });
    (event.locals as { apiKeyScopes?: string[] }).apiKeyScopes = ["read"];
    const res = await call(configPut, event);
    expect(res.status).toBe(403);
  });

  test("400 on a non-JSON body", async () => {
    const event = createMockEvent({ method: "PUT", user: userA });
    event.request = new Request("http://localhost/api/briefing/config", {
      method: "PUT",
      body: "{not json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await call(configPut, event);
    expect(res.status).toBe(400);
    expect((await jsonFromResponse(res)).error).toMatch(/valid JSON/);
  });

  test("400 on invalid cron / timezone / watchlist / enabled", async () => {
    for (const [body, pattern] of [
      [{ cron: "* * * * *" }, /min-5-min-interval/],
      [{ timezone: "Mars/Olympus" }, /invalid timezone/],
      [{ watchlist: [{ topic: "" }] }, /non-empty topic/],
      [{ enabled: "yes" }, /enabled must be a boolean/],
    ] as const) {
      const res = await call(configPut, createMockEvent({ method: "PUT", body, user: userA }));
      expect(res.status).toBe(400);
      expect((await jsonFromResponse(res)).error).toMatch(pattern);
    }
  });

  test("200 creates the row and computes nextFireAt", async () => {
    const res = await call(configPut, createMockEvent({
      method: "PUT",
      body: { enabled: true, cron: "30 6 * * 1-5", timezone: "UTC", projectId, instructions: "short + sharp" },
      user: userA,
    }));
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.cron).toBe("30 6 * * 1-5");
    expect(data.nextFireAt).not.toBeNull();
    const row = await getBriefingConfig(userA.id);
    expect(row!.instructions).toBe("short + sharp");
  });

  test("400 when the merged state fails the upsert's defensive parse (legacy bad cron + partial update)", async () => {
    // Bypass validation: insert a row with an unparseable stored cron,
    // then PUT a partial update that doesn't touch cron — the merged
    // recompute throws and the route folds it into a 400.
    await getTestDb().insert(briefingConfigs).values({
      userId: userA.id,
      enabled: false,
      cron: "totally not cron",
      timezone: "UTC",
    });
    const res = await call(configPut, createMockEvent({ method: "PUT", body: { enabled: true }, user: userA }));
    expect(res.status).toBe(400);
    // Fixed string — raw parser/driver text never reaches the client.
    expect((await jsonFromResponse(res)).error).toBe("invalid briefing config");
  });

  test("400 'unknown project' when projectId points at a nonexistent project (FK violation mapped)", async () => {
    const res = await call(configPut, createMockEvent({
      method: "PUT",
      body: { enabled: true, projectId: crypto.randomUUID() },
      user: userA,
    }));
    expect(res.status).toBe(400);
    expect((await jsonFromResponse(res)).error).toBe("unknown project");
    expect(await getBriefingConfig(userA.id)).toBeNull(); // nothing persisted
  });

  test("200 partial update preserves other fields", async () => {
    await upsertBriefingConfig(userA.id, { enabled: true, instructions: "old", projectId });
    const res = await call(configPut, createMockEvent({ method: "PUT", body: { instructions: "new" }, user: userA }));
    expect(res.status).toBe(200);
    const row = await getBriefingConfig(userA.id);
    expect(row!.instructions).toBe("new");
    expect(row!.enabled).toBe(true);
    expect(row!.projectId).toBe(projectId);
  });

  test("own-config only: user A's PUT never touches user B", async () => {
    await call(configPut, createMockEvent({ method: "PUT", body: { enabled: true, instructions: "A's" }, user: userA }));
    const resB = await call(configGet, createMockEvent({ user: userB }));
    const dataB = await jsonFromResponse(resB);
    expect(dataB.enabled).toBe(false);
    expect(dataB.instructions).toBe("");
    expect(await getBriefingConfig(userB.id)).toBeNull();
  });
});

// ── POST /api/briefing/run-now ────────────────────────────────────

describe("POST /api/briefing/run-now", () => {
  test("401 unauthenticated", async () => {
    registerStubRuntime();
    const res = await call(runNowPost, createMockEvent({ method: "POST" }));
    expect(res.status).toBe(401);
  });

  test("403 when the API key lacks the chat scope", async () => {
    registerStubRuntime();
    const event = createMockEvent({ method: "POST", user: userA });
    (event.locals as { apiKeyScopes?: string[] }).apiKeyScopes = ["read"];
    const res = await call(runNowPost, event);
    expect(res.status).toBe(403);
  });

  test("503 when the briefing runtime is not registered (does NOT consume the rate slot)", async () => {
    const res = await call(runNowPost, createMockEvent({ method: "POST", user: userA }));
    expect(res.status).toBe(503);

    // The 503 must not have consumed the user's slot.
    registerStubRuntime();
    await upsertBriefingConfig(userA.id, { projectId });
    const retry = await call(runNowPost, createMockEvent({ method: "POST", user: userA }));
    expect(retry.status).toBe(202);
    // Drain the background run so it can't race the next test's wipe.
    await __testHooks.lastRun;
  });

  test("202 with a stored config: briefing conversation lands for the right user, status recorded", async () => {
    registerStubRuntime({ assistantContent: "Good morning — here's your briefing." });
    await upsertBriefingConfig(userA.id, { enabled: true, projectId });

    const res = await call(runNowPost, createMockEvent({ method: "POST", user: userA }));
    expect(res.status).toBe(202);
    expect(await jsonFromResponse(res)).toEqual({ started: true });

    const result = await __testHooks.lastRun;
    expect(result!.status).toBe("ok");

    const db = getTestDb();
    const convs = await db.select().from(conversations);
    expect(convs).toHaveLength(1);
    expect(convs[0]!.userId).toBe(userA.id);
    expect(convs[0]!.projectId).toBe(projectId);
    expect(convs[0]!.title).toMatch(/^Daily Briefing — /);

    const row = await getBriefingConfig(userA.id);
    expect(row!.lastFireStatus).toBe("ok");
    expect(row!.consecutiveErrors).toBe(0);
  });

  test("202 without a stored config: runs on defaults via the project fallback chain", async () => {
    registerStubRuntime({ assistantContent: "Briefing on defaults." });
    // The user's most recent conversation anchors the fallback project.
    await getTestDb().insert(conversations).values({ projectId, title: "Recent work", userId: userA.id });

    const res = await call(runNowPost, createMockEvent({ method: "POST", user: userA }));
    expect(res.status).toBe(202);
    const result = await __testHooks.lastRun;
    expect(result!.status).toBe("ok");
    expect(result!.conversationId).toBeDefined();
    // No config row exists — bookkeeping is a benign no-op.
    expect(await getBriefingConfig(userA.id)).toBeNull();
  });

  test("202 → 'skipped' when no project is resolvable", async () => {
    registerStubRuntime();
    await getTestDb().delete(projects);
    const res = await call(runNowPost, createMockEvent({ method: "POST", user: userA }));
    expect(res.status).toBe(202);
    const result = await __testHooks.lastRun;
    expect(result!.status).toBe("skipped");
  });

  test("429 on the second call within the window, with Retry-After", async () => {
    registerStubRuntime();
    await upsertBriefingConfig(userA.id, { projectId });

    const first = await call(runNowPost, createMockEvent({ method: "POST", user: userA }));
    expect(first.status).toBe(202);
    await __testHooks.lastRun;

    const second = await call(runNowPost, createMockEvent({ method: "POST", user: userA }));
    expect(second.status).toBe(429);
    const body = await jsonFromResponse(second);
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(Number(second.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  test("the Hub run-now trigger and the route share ONE rate bucket", async () => {
    // Extension Pages Hub §1.3: a user must not double-dip the
    // 1-per-5-minutes window by alternating between the settings button
    // (this route) and the Hub tab's "Run now" action (which calls
    // triggerBriefingRunNow directly).
    const { triggerBriefingRunNow } = require("../../web/src/lib/server/briefing-run-now");
    registerStubRuntime();
    await upsertBriefingConfig(userA.id, { projectId });

    const viaHub = await triggerBriefingRunNow(userA.id);
    expect(viaHub).toEqual({ ok: true });
    await __testHooks.lastRun;

    const viaRoute = await call(runNowPost, createMockEvent({ method: "POST", user: userA }));
    expect(viaRoute.status).toBe(429);

    // And the inverse ordering: route first, hub second.
    __rateLimiter.reset();
    expect((await call(runNowPost, createMockEvent({ method: "POST", user: userA }))).status).toBe(202);
    await __testHooks.lastRun;
    const hubSecond = await triggerBriefingRunNow(userA.id);
    expect(hubSecond.ok).toBe(false);
    expect(hubSecond.reason).toBe("rate-limited");
    expect(hubSecond.retryAfter).toBeGreaterThan(0);
  });

  test("hub trigger reports unavailable (no runtime) without consuming the rate slot", async () => {
    const { triggerBriefingRunNow } = require("../../web/src/lib/server/briefing-run-now");
    // No registerStubRuntime() — runtime gate must fire first.
    const result = await triggerBriefingRunNow(userA.id);
    expect(result).toEqual({ ok: false, reason: "unavailable" });

    registerStubRuntime();
    await upsertBriefingConfig(userA.id, { projectId });
    expect((await triggerBriefingRunNow(userA.id)).ok).toBe(true);
    await __testHooks.lastRun;
  });

  test("rate-limit buckets are per-user: user B is unaffected by user A's slot", async () => {
    registerStubRuntime();
    await upsertBriefingConfig(userA.id, { projectId });
    await upsertBriefingConfig(userB.id, { projectId });

    expect((await call(runNowPost, createMockEvent({ method: "POST", user: userA }))).status).toBe(202);
    await __testHooks.lastRun;
    expect((await call(runNowPost, createMockEvent({ method: "POST", user: userA }))).status).toBe(429);
    expect((await call(runNowPost, createMockEvent({ method: "POST", user: userB }))).status).toBe(202);
    await __testHooks.lastRun;
  });

  test("a failing run records the error on the config row", async () => {
    registerStubRuntime({ fail: true });
    await upsertBriefingConfig(userA.id, { enabled: true, projectId });

    const res = await call(runNowPost, createMockEvent({ method: "POST", user: userA }));
    expect(res.status).toBe(202);
    const result = await __testHooks.lastRun;
    expect(result!.status).toBe("error");

    const row = await getBriefingConfig(userA.id);
    expect(row!.lastFireStatus).toBe("error");
    expect(row!.consecutiveErrors).toBe(1);
    // Empty-failure hygiene held: no orphaned conversation.
    expect(await getTestDb().select().from(conversations)).toHaveLength(0);
  });

  test("the 5th consecutive run-now failure auto-disables and posts the notification conversation", async () => {
    registerStubRuntime({ fail: true });
    await upsertBriefingConfig(userA.id, { enabled: true, projectId });
    // Pre-load 4 prior failures.
    const db = getTestDb();
    const { eq } = await import("drizzle-orm");
    await db.update(briefingConfigs)
      .set({ consecutiveErrors: BRIEFING_AUTO_DISABLE_AFTER - 1 })
      .where(eq(briefingConfigs.userId, userA.id));

    const res = await call(runNowPost, createMockEvent({ method: "POST", user: userA }));
    expect(res.status).toBe(202);
    await __testHooks.lastRun;

    const row = await getBriefingConfig(userA.id);
    expect(row!.enabled).toBe(false);
    expect(row!.consecutiveErrors).toBe(BRIEFING_AUTO_DISABLE_AFTER);

    const convs = await db.select().from(conversations);
    expect(convs).toHaveLength(1);
    expect(convs[0]!.title).toBe("Daily Briefing disabled");
    expect(convs[0]!.userId).toBe(userA.id);
  });
});
