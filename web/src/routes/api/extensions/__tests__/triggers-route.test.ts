/**
 * Unit tests for the dynamic-triggers read route
 * (web/src/routes/api/extensions/[id]/triggers/+server.ts).
 *
 * The store and the extension query layer are mocked so the tests are pure
 * and focused on the handler's auth / shape / branch logic. Every line is
 * driven, and the assertions pin the two things that matter:
 *   - the route is ADMIN-ONLY (it exposes every user's hook URLs and cron
 *     schedules for the extension, which is operator information), and
 *   - NO SECRET ever appears in the body — a hook token is obtainable only
 *     through the shown-once rotate route.
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "../../../../../../src/__tests__/helpers/mock-cleanup";
import {
  mockServerAlias,
  MEMBER_USER,
  ADMIN_USER,
  createMockEvent,
} from "../../../../../../src/__tests__/helpers/mock-request";

mockServerAlias();

mock.module(
  "../../../../../../web/src/routes/api/extensions/[id]/triggers/$types",
  () => ({}),
);

import * as httpErrorsActual from "../../../../lib/server/http-errors";
mock.module("$lib/server/http-errors", () => httpErrorsActual);

let scopeResponse: Response | null = null;
mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => scopeResponse,
}));

import * as middlewareActual from "../../../../../../src/auth/middleware";
mock.module("$server/auth/middleware", () => middlewareActual);

let extensionsById: Record<string, { id: string; name: string }> = {};
mock.module("$server/db/queries/extensions", () => ({
  getExtension: async (id: string) => extensionsById[id] ?? null,
}));

let crons: unknown[] = [];
let hooks: unknown[] = [];
const storeCalls: Array<{ fn: string; arg: string }> = [];
mock.module("$server/extensions/triggers-store", () => ({
  listDynamicCrons: async (extensionId: string) => {
    storeCalls.push({ fn: "crons", arg: extensionId });
    return crons;
  },
  listDynamicWebhooks: async (extensionName: string) => {
    storeCalls.push({ fn: "hooks", arg: extensionName });
    return hooks;
  },
}));

const { GET } = await import("../[id]/triggers/+server");

const EXT = { id: "ext-uuid-1", name: "ez-factory" };

function cronRow(over: Record<string, unknown> = {}) {
  return {
    key: "job:1",
    cron: "0 9 * * 1",
    timezone: "America/New_York",
    enabled: true,
    maxRunsPerDay: 20,
    nextFireAt: new Date("2026-08-03T13:00:00.000Z"),
    lastFireAt: new Date("2026-07-27T13:00:00.000Z"),
    lastFireStatus: "ok",
    consecutiveErrors: 0,
    ...over,
  };
}

function hookRow(over: Record<string, unknown> = {}) {
  return {
    key: "hook:1",
    slug: "factory-abc123abc123",
    enabled: true,
    lastDeliveryAt: new Date("2026-07-28T10:00:00.000Z"),
    lastDeliveryStatus: "ok",
    ...over,
  };
}

function call(user: typeof ADMIN_USER | typeof MEMBER_USER | undefined, id = EXT.id) {
  const event = createMockEvent({ params: { id }, ...(user ? { user } : {}) });
  return GET(event as never);
}

beforeEach(() => {
  scopeResponse = null;
  extensionsById = { [EXT.id]: EXT };
  crons = [];
  hooks = [];
  storeCalls.length = 0;
});

afterAll(() => {
  restoreModuleMocks();
});

describe("auth", () => {
  test("a failing scope check short-circuits", async () => {
    scopeResponse = new Response("nope", { status: 403 });
    const res = await call(ADMIN_USER);
    expect(res.status).toBe(403);
    // Nothing was read.
    expect(storeCalls).toHaveLength(0);
  });

  test("an unauthenticated caller is rejected", async () => {
    await expect(call(undefined)).rejects.toBeDefined();
    expect(storeCalls).toHaveLength(0);
  });

  test("a non-admin member is rejected", async () => {
    // The rows expose every user's hook URLs and schedules for this
    // extension — operator information, not end-user information.
    await expect(call(MEMBER_USER)).rejects.toBeDefined();
    expect(storeCalls).toHaveLength(0);
  });
});

describe("lookup", () => {
  test("an unknown extension is 404", async () => {
    const res = await call(ADMIN_USER, "no-such-ext");
    expect(res.status).toBe(404);
    expect(storeCalls).toHaveLength(0);
  });
});

describe("shape", () => {
  test("reads schedules by UUID and webhooks by NAME", async () => {
    // The two tables key differently on purpose: extension_webhooks FKs
    // `extensions.name` so the session-less hook route can resolve a hook
    // by the same key it reads the secret with. Passing the wrong one
    // silently returns nothing.
    await call(ADMIN_USER);
    expect(storeCalls).toEqual([
      { fn: "crons", arg: EXT.id },
      { fn: "hooks", arg: EXT.name },
    ]);
  });

  test("returns an empty list when there are no dynamic triggers", async () => {
    const res = await call(ADMIN_USER);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ triggers: [] });
  });

  test("serializes a cron row with its dates as ISO strings", async () => {
    crons = [cronRow()];
    const body = await (await call(ADMIN_USER)).json();
    expect(body.triggers).toEqual([{
      kind: "cron",
      key: "job:1",
      cron: "0 9 * * 1",
      timezone: "America/New_York",
      enabled: true,
      maxRunsPerDay: 20,
      nextFireAt: "2026-08-03T13:00:00.000Z",
      lastFireAt: "2026-07-27T13:00:00.000Z",
      lastFireStatus: "ok",
      consecutiveErrors: 0,
    }]);
  });

  test("a never-fired cron reports nulls, not undefined", async () => {
    crons = [cronRow({ lastFireAt: null, lastFireStatus: null })];
    const body = await (await call(ADMIN_USER)).json();
    expect(body.triggers[0].lastFireAt).toBeNull();
    expect(body.triggers[0].lastFireStatus).toBeNull();
  });

  test("serializes a webhook row with its resolved public URL", async () => {
    hooks = [hookRow()];
    const body = await (await call(ADMIN_USER)).json();
    expect(body.triggers).toEqual([{
      kind: "webhook",
      key: "hook:1",
      slug: "factory-abc123abc123",
      url: "/api/hooks/ez-factory/factory-abc123abc123",
      enabled: true,
      lastDeliveryAt: "2026-07-28T10:00:00.000Z",
      lastDeliveryStatus: "ok",
    }]);
  });

  test("a never-delivered hook reports nulls", async () => {
    hooks = [hookRow({ lastDeliveryAt: null, lastDeliveryStatus: null })];
    const body = await (await call(ADMIN_USER)).json();
    expect(body.triggers[0].lastDeliveryAt).toBeNull();
    expect(body.triggers[0].lastDeliveryStatus).toBeNull();
  });

  test("returns both kinds together", async () => {
    crons = [cronRow()];
    hooks = [hookRow()];
    const body = await (await call(ADMIN_USER)).json();
    expect(body.triggers.map((t: { kind: string }) => t.kind)).toEqual(["cron", "webhook"]);
  });

  test("NO SECRET is ever present in the body", async () => {
    crons = [cronRow()];
    hooks = [hookRow()];
    const raw = await (await call(ADMIN_USER)).text();
    expect(raw).not.toContain("ezhook_");
    expect(raw).not.toContain("secret");
  });

  test("a disabled trigger is still listed, flagged disabled", async () => {
    // An operator needs to see a job that STOPPED firing — that is the
    // whole diagnostic value of the route.
    crons = [cronRow({ enabled: false, consecutiveErrors: 5 })];
    const body = await (await call(ADMIN_USER)).json();
    expect(body.triggers[0].enabled).toBe(false);
    expect(body.triggers[0].consecutiveErrors).toBe(5);
  });
});
