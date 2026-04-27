/**
 * End-to-end integration test for the Phase A2 extension-event flow.
 *
 * Exercises every link in the chain that produced the original 400:
 *
 *   manifest declaration
 *     → bundled grant
 *       → EventSubscriptionDispatcher.registerExtension
 *         → registerExtensionEvent (SSE-filter registry)
 *           → POST /api/extensions/[name]/events/[event]
 *             → isRegisteredExtensionEvent gate
 *               → body schema (.max(256))
 *                 → conversation ownership check
 *                   → tool-call cross-binding check
 *                     → bus.emit(`<ext>:<event>`, {toolCallId, conversationId, …})
 *
 * Sister test to `extensions-events-route.test.ts` (link #6 onwards),
 * but where THAT file mocks the SSE-filter registry as a Set, this one
 * exercises the REAL `registerExtensionEvent` and feeds it through the
 * REAL dispatcher. If a future refactor breaks the wiring between
 * `permissions.eventSubscriptions` → `registerExtensionEvent` →
 * `isRegisteredExtensionEvent`, this test fails before any individual
 * unit suite would.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// ── Real SSE-filter and real EventBus — load FIRST so every other
// mock can pull symbols from them.
import {
  unregisterExtensionEvent,
  isRegisteredExtensionEvent,
} from "../runtime/sse-conversation-filter";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";

// ── Mock the conversation/tool-call lookups the route needs.
let mockConv: { id: string; userId: string | null } | null = null;
let mockToolCall: { id: string; conversationId: string | null } | null = null;
const conversationCalls: string[] = [];
mock.module("$server/db/queries/conversations", () => ({
  getConversation: async (id: string) => {
    conversationCalls.push(id);
    return mockConv;
  },
}));
mock.module("$server/db/queries/tool-calls", () => ({
  getToolCallConversationById: async (_id: string) => mockToolCall,
}));

// ── Mock auth / scope so the route's gates pass.
mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));
mock.module("$server/auth/middleware", () => ({
  requireAuth: () => ({
    id: "user-1",
    email: "u@x.com",
    name: "U",
    role: "member",
  }),
}));

// ── http-errors helper (same shape as the real module so the route's
// error-construction matches what callers see in prod).
mock.module("$lib/server/http-errors", () => ({
  errorJson: (status: number, message: string) =>
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
}));

// ── Stand up a real bus and inject it into `$lib/server/context` so
// the route's `getBus()` returns the same instance the dispatcher
// listens on. We don't import `web/src/lib/server/context` directly
// (it pulls in the full server boot) — we mock the public surface.
const bus = new EventBus<AgentEvents>();
mock.module("$lib/server/context", () => ({
  getBus: () => bus,
}));

afterAll(() => {
  unregisterExtensionEvent("fake", "ping");
  restoreModuleMocks();
});

// ── Now import the route + dispatcher AFTER mocks. ──────────────────
import { EventSubscriptionDispatcher } from "../extensions/event-subscription-dispatcher";

const { POST } = await import(
  "../../web/src/routes/api/extensions/[name]/events/[event]/+server"
);

// ── Fixtures ────────────────────────────────────────────────────────

const FAKE_EXT_ID = "ext-fake";
const FAKE_EXT_NAME = "fake";
const FAKE_EVENT = "ping";
const FAKE_FULL_EVENT = `${FAKE_EXT_NAME}:${FAKE_EVENT}`;

interface SendCall { method: string; params: Record<string, unknown>; }
function mockProc() {
  const calls: SendCall[] = [];
  return {
    isRunning: true,
    calls,
    sendNotification(method: string, params?: Record<string, unknown>) {
      calls.push({ method, params: params ?? {} });
    },
  };
}

function makeRequest(body: unknown, name = FAKE_EXT_NAME, event = FAKE_EVENT) {
  return {
    request: new Request(
      `http://localhost/api/extensions/${name}/events/${event}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
    ),
    locals: {
      user: { id: "user-1", email: "u@x.com", name: "U", role: "member" },
    },
    params: { name, event },
  };
}

// ── Dispatcher boot (mirrors web/src/lib/server/context.ts:104-116) ──

function bootDispatcher() {
  const proc = mockProc();
  const procs = new Map([[FAKE_EXT_ID, proc]]);
  const dispatcher = new EventSubscriptionDispatcher(
    bus,
    {
      getProcessIfRunning(id: string) {
        const p = procs.get(id);
        return p?.isRunning ? p : null;
      },
      getManifest(id: string) {
        return id === FAKE_EXT_ID ? { name: FAKE_EXT_NAME } : undefined;
      },
    } as never,
    async (_convId: string) => [FAKE_EXT_ID],
  );
  dispatcher.registerExtension(FAKE_EXT_ID, [FAKE_FULL_EVENT]);
  dispatcher.start();
  return { dispatcher, proc };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("extension-event end-to-end (route → bus → dispatcher → subprocess)", () => {
  beforeEach(() => {
    mockConv = null;
    mockToolCall = null;
    conversationCalls.length = 0;
    // Reset the registry state our test owns.
    unregisterExtensionEvent(FAKE_EXT_NAME, FAKE_EVENT);
  });

  test("registerExtension wires the event into the SSE-filter registry (link #4 → #5)", () => {
    expect(isRegisteredExtensionEvent(FAKE_FULL_EVENT)).toBe(false);
    const { dispatcher } = bootDispatcher();
    try {
      expect(isRegisteredExtensionEvent(FAKE_FULL_EVENT)).toBe(true);
    } finally {
      dispatcher.stop();
    }
  });

  test("happy path: POST → bus emit with {toolCallId, conversationId, ...userData} (links #4-#10)", async () => {
    const { dispatcher } = bootDispatcher();
    try {
      mockConv = { id: "conv-1", userId: "user-1" };

      const captured: Array<{ name: string; payload: unknown }> = [];
      // FAKE_FULL_EVENT is not in the static `AgentEvents` keyset — we cast
      // through `never` because `bus.on` is strongly-typed against a finite
      // event map and dynamic extension events (`<ns>:<event>`) are
      // intentionally outside it. Same pattern the route uses on emit.
      const off = bus.on(FAKE_FULL_EVENT as never, (payload: unknown) => {
        captured.push({ name: FAKE_FULL_EVENT, payload });
      });

      try {
        const res = await POST(
          makeRequest({
            toolCallId: "tc-1",
            conversationId: "conv-1",
            arbitrary: "user-data",
          }) as never,
        );
        expect(res.status).toBe(200);
        expect(captured).toHaveLength(1);
        expect(captured[0]!.payload).toEqual({
          toolCallId: "tc-1",
          conversationId: "conv-1",
          arbitrary: "user-data",
        });
      } finally {
        off();
      }
    } finally {
      dispatcher.stop();
    }
  });

  test("bus emit propagates to the subscribed subprocess via dispatcher (link #11)", async () => {
    const { dispatcher, proc } = bootDispatcher();
    try {
      mockConv = { id: "conv-1", userId: "user-1" };
      const res = await POST(
        makeRequest({ toolCallId: "tc-1", conversationId: "conv-1", n: 42 }) as never,
      );
      expect(res.status).toBe(200);
      // Give the bus listener a tick to fan out.
      await new Promise((r) => setTimeout(r, 20));
      // The dispatcher prefixes with `ezcorp/event/<eventType>`.
      expect(proc.calls).toHaveLength(1);
      expect(proc.calls[0]!.method).toBe(`ezcorp/event/${FAKE_FULL_EVENT}`);
      expect(proc.calls[0]!.params).toMatchObject({
        toolCallId: "tc-1",
        conversationId: "conv-1",
        n: 42,
      });
    } finally {
      dispatcher.stop();
    }
  });

  test("WITHOUT registerExtension the route returns 404 — proves dispatcher wiring is load-bearing", async () => {
    // No bootDispatcher() call this time. SSE-filter registry must
    // be empty for `fake:ping` and the route must reject.
    expect(isRegisteredExtensionEvent(FAKE_FULL_EVENT)).toBe(false);
    mockConv = { id: "conv-1", userId: "user-1" };
    const res = await POST(
      makeRequest({ toolCallId: "tc-1", conversationId: "conv-1" }) as never,
    );
    expect(res.status).toBe(404);
    // And the conversation lookup must NOT have run — gate ordering:
    // event-registry rejection precedes any DB read.
    expect(conversationCalls).toHaveLength(0);
  });

  test("83-char OpenAI-shaped toolCallId clears the schema (.max(256)) end-to-end", async () => {
    const { dispatcher } = bootDispatcher();
    try {
      mockConv = { id: "conv-1", userId: "user-1" };
      const longId = "call_" + "a".repeat(24) + "|fc_" + "b".repeat(48);
      expect(longId.length).toBe(81);
      const res = await POST(
        makeRequest({ toolCallId: longId, conversationId: "conv-1" }) as never,
      );
      expect(res.status).toBe(200);
    } finally {
      dispatcher.stop();
    }
  });
});
