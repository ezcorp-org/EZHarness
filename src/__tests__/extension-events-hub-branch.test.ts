/**
 * POST /api/extensions/[name]/events/[event] — hub-source branch
 * (Extension Pages Hub §2.4).
 *
 * Sister of extension-event-end-to-end.test.ts: same mock scaffolding,
 * but drives the `{source:"hub", pageId, payload?}` body shape:
 * manifest-event gate (shared with the legacy branch), declared-page
 * gate, 10/min/user rate limit, spawn+wire, `ezcorp/event/<ext>:<event>`
 * notification with host-stamped userId, page-cache invalidation.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

import {
  registerExtensionEvent,
  unregisterExtensionEvent,
} from "../runtime/sse-conversation-filter";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import { getPageCache } from "../extensions/page-cache";

// ── Subprocess + registry fakes ─────────────────────────────────────
interface SendCall { method: string; params: Record<string, unknown> }
const sendCalls: SendCall[] = [];
let spawnShouldFail = false;
let wireCalls = 0;

const fakeProc = {
  sendNotification(method: string, params?: Record<string, unknown>) {
    sendCalls.push({ method, params: params ?? {} });
  },
};

mock.module("$server/extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      getProcess: async (_id: string) => {
        if (spawnShouldFail) throw new Error("spawn exploded");
        return fakeProc;
      },
    }),
  },
}));
mock.module("$server/extensions/tool-executor", () => ({
  ToolExecutor: class {
    async ensureSubprocessRpcWired() {
      wireCalls++;
    }
  },
}));
mock.module("$server/extensions/permission-engine", () => ({
  getPermissionEngine: () => ({}),
}));

// ── Extension row lookup ────────────────────────────────────────────
let mockExt: Record<string, unknown> | null = null;
mock.module("$server/db/queries/extensions", () => ({
  getExtensionByName: async (_name: string) => mockExt,
  // hub-extension-pages also imports the list query (unused by the
  // hub-action branch, but the module must instantiate).
  listExtensions: async () => [],
}));

// Unused-by-the-hub-branch lookups still imported by the route module.
mock.module("$server/db/queries/conversations", () => ({
  getConversation: async () => null,
}));
mock.module("$server/db/queries/tool-calls", () => ({
  getToolCallConversationById: async () => null,
}));
mock.module("$server/db/queries/conversation-extensions", () => ({
  addConversationExtensions: async () => undefined,
  getConversationExtensionIds: async () => [],
}));
mock.module("$server/extensions/append-message-handler", () => ({
  handleAppendMessageRpc: async () => ({ jsonrpc: "2.0", id: 1, result: {} }),
}));
mock.module("$server/extensions/finalize-tool-call-handler", () => ({
  handleFinalizeToolCallRpc: async () => ({ jsonrpc: "2.0", id: 1, result: {} }),
}));

// ── Auth / scope / helpers ──────────────────────────────────────────
// REAL modules (not always-allow stubs): the mock events below carry
// `locals.user`, so the genuine gates pass for our requests — and a
// stub here would leak an always-authenticated requireAuth into any
// test file sharing the process (briefing-api's 401/403 cases).
mock.module("$lib/server/security/api-keys", () => require("../../web/src/lib/server/security/api-keys"));
mock.module("$server/auth/middleware", () => require("../auth/middleware"));
mock.module("$lib/server/http-errors", () => require("../../web/src/lib/server/http-errors"));
mock.module("$lib/server/security/rate-limiter", () => require("../../web/src/lib/server/security/rate-limiter"));
mock.module("$lib/server/hub-extension-pages", () => require("../../web/src/lib/server/hub-extension-pages"));
mock.module("$server/extensions/page-cache", () => require("../extensions/page-cache"));
const realLogger = require("../logger");
mock.module("$server/logger", () => realLogger);

const bus = new EventBus<AgentEvents>();
mock.module("$lib/server/context", () => ({
  getBus: () => bus,
}));

const { POST, __hubActionRateLimiter } = await import(
  "../../web/src/routes/api/extensions/[name]/events/[event]/+server"
);

afterAll(() => {
  unregisterExtensionEvent("cron-dashboard", "clear-log");
  // In-file ≥2-registration pattern (mock-cleanup meta-test): both
  // factories point at the real modules.
  mock.module("$lib/server/hub-extension-pages", () => require("../../web/src/lib/server/hub-extension-pages"));
  mock.module("$server/logger", () => realLogger);
  restoreModuleMocks();
});

const EXT_NAME = "cron-dashboard";
const EVENT = "clear-log";

function makeEvent(body: unknown, name = EXT_NAME, event = EVENT) {
  return {
    request: new Request(`http://localhost/api/extensions/${name}/events/${event}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    locals: { user: { id: "user-1", email: "u@x.com", name: "U", role: "member" } },
    params: { name, event },
  } as never;
}

function baseExt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ext-cron",
    name: EXT_NAME,
    enabled: true,
    manifest: { pages: [{ id: "dashboard", title: "Dash" }] },
    grantedPermissions: { eventSubscriptions: [`${EXT_NAME}:${EVENT}`], grantedAt: {} },
    ...overrides,
  };
}

beforeEach(() => {
  registerExtensionEvent(EXT_NAME, EVENT);
  sendCalls.length = 0;
  wireCalls = 0;
  spawnShouldFail = false;
  mockExt = baseExt();
  __hubActionRateLimiter.reset();
  getPageCache().clear();
});

describe("hub-source branch", () => {
  test("200: spawns + wires, sends the namespaced notification with host-stamped userId", async () => {
    const res = await POST(makeEvent({ source: "hub", pageId: "dashboard", payload: { all: true } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(wireCalls).toBe(1);
    expect(sendCalls).toEqual([
      {
        method: `ezcorp/event/${EXT_NAME}:${EVENT}`,
        params: { source: "hub", pageId: "dashboard", userId: "user-1", payload: { all: true } },
      },
    ]);
  });

  test("payload key omitted from the notification when absent", async () => {
    const res = await POST(makeEvent({ source: "hub", pageId: "dashboard" }));
    expect(res.status).toBe(200);
    expect(sendCalls[0]!.params).toEqual({ source: "hub", pageId: "dashboard", userId: "user-1" });
  });

  test("invalidates the page cache for the targeted page", async () => {
    getPageCache().set("ext-cron", "dashboard", { title: "T", nodes: [] });
    getPageCache().set("ext-cron", "other", { title: "O", nodes: [] });
    await POST(makeEvent({ source: "hub", pageId: "dashboard" }));
    expect(getPageCache().get("ext-cron", "dashboard")).toBeNull();
    expect(getPageCache().get("ext-cron", "other")).not.toBeNull();
  });

  test("400 for malformed hub bodies", async () => {
    for (const body of [
      { source: "hub" }, // missing pageId
      { source: "hub", pageId: "BAD ID" },
      { source: "hub", pageId: "dashboard", payload: "string" },
      { source: "hub", pageId: "dashboard", payload: ["arr"] },
    ]) {
      const res = await POST(makeEvent(body));
      expect(res.status).toBe(400);
    }
    expect(sendCalls).toHaveLength(0);
  });

  test("400 for payloads over 2KB", async () => {
    const res = await POST(
      makeEvent({ source: "hub", pageId: "dashboard", payload: { blob: "x".repeat(3000) } }),
    );
    expect(res.status).toBe(400);
  });

  test("404 when the event isn't registered in the manifest-event registry", async () => {
    unregisterExtensionEvent(EXT_NAME, EVENT);
    const res = await POST(makeEvent({ source: "hub", pageId: "dashboard" }));
    expect(res.status).toBe(404);
  });

  test("404 for unknown or disabled extensions", async () => {
    mockExt = null;
    expect((await POST(makeEvent({ source: "hub", pageId: "dashboard" }))).status).toBe(404);
    mockExt = baseExt({ enabled: false });
    expect((await POST(makeEvent({ source: "hub", pageId: "dashboard" }))).status).toBe(404);
  });

  test("404 when the page isn't declared in manifest.pages", async () => {
    expect((await POST(makeEvent({ source: "hub", pageId: "undeclared" }))).status).toBe(404);
    mockExt = baseExt({ manifest: {} });
    expect((await POST(makeEvent({ source: "hub", pageId: "dashboard" }))).status).toBe(404);
    expect(sendCalls).toHaveLength(0);
  });

  test("429 after 10 actions/min/user", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await POST(makeEvent({ source: "hub", pageId: "dashboard" }))).status).toBe(200);
    }
    const blocked = await POST(makeEvent({ source: "hub", pageId: "dashboard" }));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(sendCalls).toHaveLength(10);
  });

  test("500 when the subprocess can't spawn (action must not vanish silently)", async () => {
    spawnShouldFail = true;
    const res = await POST(makeEvent({ source: "hub", pageId: "dashboard" }));
    expect(res.status).toBe(500);
    expect(sendCalls).toHaveLength(0);
  });

  test("non-hub bodies fall through to the legacy conversation-scoped schema", async () => {
    // No `source:"hub"` → legacy schema requires conversationId etc.
    const res = await POST(makeEvent({ pageId: "dashboard" }));
    expect(res.status).toBe(400); // legacy schema rejects, hub branch untouched
    expect(sendCalls).toHaveLength(0);
  });
});
