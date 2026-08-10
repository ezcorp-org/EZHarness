/**
 * Integration tests for the `/goal` slash-prefix interceptor wired into
 * `web/src/routes/api/conversations/[id]/messages/+server.ts`.
 *
 * PRD §11.2 (I1-I13). Each test stubs `getGoalHost()` with a controllable
 * fake (`makeFakeGoalHost()`) so we can assert:
 *
 *   I1   — full set→eval-no→continue→eval-yes→clear cycle drives a card
 *          / streaming response shape correctly. (Loop body itself lives
 *          in unit suite; here we only assert the route-level
 *          observable behavior — that set falls through to streamChat
 *          and clear/status short-circuit with runId:null.)
 *   I1b  — set returns the streaming shape AND streamChat is invoked.
 *   I2   — `run:error` pause: route-level signal via dispatch.kind=card
 *          for a paused/cleared state isn't visible directly — see
 *          unit suite I2 equivalent. Here we cover the route-level
 *          card-only short-circuit path which is the visible surface.
 *   I3   — same as I2 for run:cancel (unit suite covers terminal-event
 *          plumbing; route covers the user-facing return shape).
 *   I5b  — FR-13b lazy rehydrate on a normal NON-/goal user POST.
 *   I5d  — /goal POST does NOT auto-resume via FR-13b (the helper
 *          gets the isGoalCmd:true flag and the goal-host fake records
 *          the call).
 *   I7   — re-/goal <same> calls handleGoalCommand twice with set; the
 *          underlying handler does the replace.
 *   I11  — headless `-p` path: same route POST drives the same
 *          interceptor; nothing mode-specific.
 *   I12  — /goal status returns runId:null card, streamChat NOT called.
 *   I13  — /goal clear mid-turn: route emits the card; the in-flight
 *          turn's run:complete behavior is the goal-host's concern
 *          (covered in the unit suite). The route-level invariant is
 *          that clear does not call streamChat.
 *
 * I4 / I6 / I8 / I9 / I10 are evaluator/run-loop behaviors that fire
 * AFTER streamChat returns; they're owned by the goal-host bus
 * subscription, covered exhaustively in `src/__tests__/goal-host-unit.
 * test.ts`. There is no route-observable distinction.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

// ── Mock surface — same shape as api-conversations-id-messages.server.test.ts

const getConversation = vi.fn();
const getLatestLeaf = vi.fn();
const getConversationPath = vi.fn();
const getMessages = vi.fn();
const getMessagesWithToolCalls = vi.fn();
const getSubConversationToolCalls = vi.fn();
const createMessage = vi.fn();
const insertAttachment = vi.fn();
const deleteAttachmentsForMessage = vi.fn();
const getProject = vi.fn();
const streamChat = vi.fn(
  (_conversationId: string, _userMessage: string, _options: Record<string, unknown>) => ({
    catch: () => Promise.resolve(),
  }),
);
const checkTokenBudget = vi.fn();

let goalHostMock: ReturnType<typeof makeFakeGoalHost> | null = null;

function makeFakeGoalHost() {
  const rehydrateCalls: Array<{ conversationId: string; isGoalCmd: boolean }> = [];
  const dispatchCalls: Array<{
    subcommand: "set" | "status" | "clear";
    condition?: string;
    conversationId: string;
    userId: string;
    projectId: string;
    userMessageId: string;
  }> = [];
  let nextDispatch:
    | { kind: "card"; result: unknown; row: { id: string; role: string; content: string } | null }
    | { kind: "start-turn"; turnMessage: string } = { kind: "start-turn", turnMessage: "ok" };

  return {
    rehydrateCalls,
    dispatchCalls,
    setNextDispatch(next: typeof nextDispatch) {
      nextDispatch = next;
    },
    ensureGoalRecordRehydrated: vi.fn(async (conversationId: string, isGoalCmd: boolean) => {
      rehydrateCalls.push({ conversationId, isGoalCmd });
    }),
    handleGoalCommand: vi.fn(async (input: typeof dispatchCalls[number]) => {
      dispatchCalls.push(input);
      return nextDispatch;
    }),
  };
}

vi.mock("$server/db/queries/conversations", () => ({
  getConversation,
  getLatestLeaf,
  getConversationPath,
  getMessages,
  getMessagesWithToolCalls,
  getSubConversationToolCalls,
  createMessage,
}));

vi.mock("$server/db/queries/attachments", () => ({
  insertAttachment,
  deleteAttachmentsForMessage,
}));

vi.mock("$server/db/queries/projects", () => ({
  getProject,
}));

vi.mock("$lib/server/context", () => ({
  getExecutor: () => ({ streamChat }),
  getGoalHost: () => goalHostMock,
}));

vi.mock("$lib/server/security/resource-quotas", () => ({
  checkTokenBudget,
}));

vi.mock("$lib/server/command-resolver", () => ({
  buildCommandResolver: () => async () => null,
}));

vi.mock("$server/providers/model-capabilities", () => ({
  getCapabilities: () => ({ maxFilesPerMessage: 0 }),
  classifyMime: () => null,
  getCapabilitiesWithExtensions: () => ({ maxFilesPerMessage: 0 }),
  classifyMimeWithCaps: () => null,
}));

vi.mock("$server/chat/attachments/validator", () => ({
  validateAttachment: async () => ({ ok: true, canonicalMime: "text/plain" }),
}));

vi.mock("$server/chat/attachments/storage", () => ({
  writeAttachment: async () => ({ storagePath: "p", sizeBytes: 1 }),
  deleteForMessage: async () => undefined,
}));

const { POST } = await import(
  "../routes/api/conversations/[id]/messages/+server.ts"
);

function makeEvent(opts: {
  body: unknown;
  locals?: Record<string, unknown>;
}) {
  const href = "http://localhost/api/conversations/c1/messages";
  // The handler only reads `params.id`, `locals.user`, and `request`
  // — the rest of `RequestEvent` (cookies/fetch/getClientAddress/...)
  // is unused. Cast through `unknown` so we don't need to fabricate
  // an entire SvelteKit event surface.
  return makeRequestEvent(href, {
    locals: opts.locals ?? {},
    params: { id: "c1" },
    request: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts.body),
    },
  });
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

beforeEach(() => {
  vi.clearAllMocks();
  getConversation.mockResolvedValue({
    id: "c1",
    userId: "u1",
    projectId: "p1",
    agentConfigId: null,
    modeId: null,
    provider: null,
    model: null,
  });
  getLatestLeaf.mockResolvedValue(null);
  // Echo whatever the caller asks us to persist so the disabled-card
  // fallback test can read its own JSON back out of the response.
  createMessage.mockImplementation(
    async (
      conversationId: string,
      data: { role: string; content: string; parentMessageId?: string },
    ) => ({
      id: data.role === "user" ? "m1" : `row-${Math.random().toString(36).slice(2, 8)}`,
      role: data.role,
      content: data.content,
      conversationId,
      parentMessageId: data.parentMessageId ?? null,
    }),
  );
  vi.mocked(checkTokenBudget).mockResolvedValue({ allowed: true });
  streamChat.mockReturnValue({ catch: () => Promise.resolve() });
  goalHostMock = makeFakeGoalHost();
});

// ── I1b / U7 (route-level): set falls through to streamChat ────────

describe("I1b — /goal <cond> set returns the streaming shape (FR-2-RET)", () => {
  test("non-null runId + ezActionResults:[] + streamChat invoked once", async () => {
    goalHostMock!.setNextDispatch({ kind: "start-turn", turnMessage: "refactor auth" });
    const res = await POST(
      makeEvent({ locals: { user }, body: { content: "/goal refactor auth" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      userMessage: { id: string };
      runId: string | null;
      ezActionResults: unknown[];
    };
    expect(body.runId).not.toBeNull();
    expect(typeof body.runId).toBe("string");
    expect(body.ezActionResults).toEqual([]);
    // Goal-host dispatched as "set" with the parsed condition.
    expect(goalHostMock!.dispatchCalls).toHaveLength(1);
    expect(goalHostMock!.dispatchCalls[0]!.subcommand).toBe("set");
    expect(goalHostMock!.dispatchCalls[0]!.condition).toBe("refactor auth");
    // Streaming turn invoked — set FELL THROUGH (NOT the :328
    // short-circuit).
    expect(streamChat).toHaveBeenCalledTimes(1);
  });

  test("set turn uses body.content (the literal /goal <cond>) as the streamChat user message", async () => {
    goalHostMock!.setNextDispatch({ kind: "start-turn", turnMessage: "x" });
    await POST(makeEvent({ locals: { user }, body: { content: "/goal refactor auth" } }));
    expect(streamChat.mock.calls[0]![1]).toBe("/goal refactor auth");
  });
});

// ── I12 — /goal status → runId:null card, no LLM ────────────────────

describe("I12 — /goal status returns runId:null card, NO streamChat", () => {
  test("status dispatch + card + no streamChat invocation", async () => {
    goalHostMock!.setNextDispatch({
      kind: "card",
      result: { kind: "decline", card: { title: "No active goal", body: "x", variant: "info" } },
      row: { id: "row-status", role: "ez-action-result", content: '{"kind":"decline"}' },
    });
    const res = await POST(makeEvent({ locals: { user }, body: { content: "/goal" } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runId: string | null;
      ezActionResults: Array<{ id: string }>;
    };
    expect(body.runId).toBeNull();
    expect(body.ezActionResults).toHaveLength(1);
    expect(body.ezActionResults[0]!.id).toBe("row-status");
    expect(streamChat).not.toHaveBeenCalled();
    expect(goalHostMock!.dispatchCalls[0]!.subcommand).toBe("status");
  });
});

// ── I13 — /goal clear short-circuits, no streamChat ────────────────

describe("I13 — /goal clear short-circuits without LLM", () => {
  test("clear dispatch + card + no streamChat", async () => {
    goalHostMock!.setNextDispatch({
      kind: "card",
      result: { kind: "success", card: { title: "Goal cleared", body: "x", variant: "info" } },
      row: { id: "row-clear", role: "ez-action-result", content: '{"kind":"success"}' },
    });
    const res = await POST(makeEvent({ locals: { user }, body: { content: "/goal clear" } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runId: string | null;
      ezActionResults: Array<{ id: string }>;
    };
    expect(body.runId).toBeNull();
    expect(body.ezActionResults[0]!.id).toBe("row-clear");
    expect(streamChat).not.toHaveBeenCalled();
    expect(goalHostMock!.dispatchCalls[0]!.subcommand).toBe("clear");
  });
});

// ── 4000-char reject (FR-3) ────────────────────────────────────────

describe("FR-3 — >4000-char condition is rejected without streamChat", () => {
  test("set with 4001-char condition → card, runId:null, no streamChat", async () => {
    goalHostMock!.setNextDispatch({
      kind: "card",
      result: { kind: "error", card: { title: "Goal condition too long", body: "x", variant: "error" } },
      row: { id: "row-reject", role: "ez-action-result", content: '{"kind":"error"}' },
    });
    const long = "x".repeat(4001);
    const res = await POST(makeEvent({ locals: { user }, body: { content: `/goal ${long}` } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string | null };
    expect(body.runId).toBeNull();
    expect(streamChat).not.toHaveBeenCalled();
  });
});

// ── I5b — FR-13b lazy rehydrate on NON-/goal POST ──────────────────

describe("I5b — FR-13b lazy rehydrate on a normal non-/goal POST", () => {
  test("rehydrate called BEFORE streamChat with isGoalCmd:false", async () => {
    const res = await POST(makeEvent({ locals: { user }, body: { content: "regular message" } }));
    expect(res.status).toBe(200);
    expect(goalHostMock!.rehydrateCalls).toEqual([{ conversationId: "c1", isGoalCmd: false }]);
    // And no goal dispatch fires for a non-/goal post.
    expect(goalHostMock!.dispatchCalls).toHaveLength(0);
    // Normal streaming continues.
    expect(streamChat).toHaveBeenCalledTimes(1);
  });
});

// ── I5d — /goal POST passes isGoalCmd:true so rehydrate suppresses flip ──

describe("I5d — /goal POST passes isGoalCmd:true to rehydrate (no auto-resume)", () => {
  test("/goal status sends isGoalCmd:true", async () => {
    goalHostMock!.setNextDispatch({
      kind: "card",
      result: { kind: "decline", card: { title: "x", body: "x", variant: "info" } },
      row: null,
    });
    await POST(makeEvent({ locals: { user }, body: { content: "/goal" } }));
    expect(goalHostMock!.rehydrateCalls).toEqual([{ conversationId: "c1", isGoalCmd: true }]);
  });

  test("/goal clear sends isGoalCmd:true", async () => {
    goalHostMock!.setNextDispatch({
      kind: "card",
      result: { kind: "success", card: { title: "x", body: "x", variant: "info" } },
      row: null,
    });
    await POST(makeEvent({ locals: { user }, body: { content: "/goal clear" } }));
    expect(goalHostMock!.rehydrateCalls).toEqual([{ conversationId: "c1", isGoalCmd: true }]);
  });

  test("/goal <cond> set sends isGoalCmd:true", async () => {
    goalHostMock!.setNextDispatch({ kind: "start-turn", turnMessage: "x" });
    await POST(makeEvent({ locals: { user }, body: { content: "/goal x" } }));
    expect(goalHostMock!.rehydrateCalls).toEqual([{ conversationId: "c1", isGoalCmd: true }]);
  });
});

// ── I7 — re-/goal <same> dispatches set twice (replace, no double-sub) ──

describe("I7 — re-/goal <same> on an active conv calls handleGoalCommand twice", () => {
  test("two consecutive set posts → two dispatch calls + two streamChat invocations", async () => {
    goalHostMock!.setNextDispatch({ kind: "start-turn", turnMessage: "x" });
    await POST(makeEvent({ locals: { user }, body: { content: "/goal x" } }));
    await POST(makeEvent({ locals: { user }, body: { content: "/goal x" } }));
    expect(goalHostMock!.dispatchCalls).toHaveLength(2);
    expect(goalHostMock!.dispatchCalls[0]!.subcommand).toBe("set");
    expect(goalHostMock!.dispatchCalls[1]!.subcommand).toBe("set");
    expect(streamChat).toHaveBeenCalledTimes(2);
  });
});

// ── I11 — headless `-p` path: same route, same interceptor ──────────

describe("I11 — headless / non-interactive POSTs hit the same code path", () => {
  test("/goal clear via the messages route hard-clears (route-level: no streamChat)", async () => {
    goalHostMock!.setNextDispatch({
      kind: "card",
      result: { kind: "success", card: { title: "Goal cleared", body: "x", variant: "info" } },
      row: { id: "row-clear-hl", role: "ez-action-result", content: '{}' },
    });
    const res = await POST(makeEvent({ locals: { user }, body: { content: "/goal clear" } }));
    const body = (await res.json()) as { runId: string | null };
    expect(body.runId).toBeNull();
    expect(streamChat).not.toHaveBeenCalled();
  });
});

// ── Disabled-mode fallback (EZCORP_GOAL_ENABLED off / init raced) ───

describe("disabled-mode fallback — getGoalHost() returns null", () => {
  test("/goal POST returns a 'disabled' card, runId:null, no streamChat", async () => {
    goalHostMock = null; // simulate EZCORP_GOAL_ENABLED=0
    const res = await POST(makeEvent({ locals: { user }, body: { content: "/goal anything" } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runId: string | null;
      ezActionResults: Array<{ content: string }>;
    };
    expect(body.runId).toBeNull();
    expect(streamChat).not.toHaveBeenCalled();
    const parsed = JSON.parse(body.ezActionResults[0]!.content) as {
      card: { title: string };
    };
    expect(parsed.card.title).toBe("/goal disabled");
  });

  test("disabled-card BODY matches the goal-host builder (unified text, reviewer nit 2)", async () => {
    // The route's null-host fallback MUST emit the same body text the
    // goal-host's `buildDisabledCard()` would have produced — one
    // source of truth, no drift between the two paths.
    goalHostMock = null;
    const res = await POST(makeEvent({ locals: { user }, body: { content: "/goal x" } }));
    const body = (await res.json()) as {
      ezActionResults: Array<{ content: string }>;
    };
    const parsed = JSON.parse(body.ezActionResults[0]!.content) as {
      kind: string;
      card: { title: string; body: string; variant: string };
    };
    expect(parsed.kind).toBe("decline");
    expect(parsed.card.variant).toBe("warning");
    // Pinned to the canonical builder's body text — change one place
    // and this test fails everywhere the route falls back.
    expect(parsed.card.body).toContain("EZCORP_GOAL_ENABLED=0");
    expect(parsed.card.body).toContain("Contact the operator to enable");
  });
});

// ── Sanity: NON-/goal POST does NOT invoke handleGoalCommand ───────

describe("non-/goal posts bypass the goal interceptor", () => {
  test("regular message → no dispatch, streamChat fires normally", async () => {
    const res = await POST(makeEvent({ locals: { user }, body: { content: "hello" } }));
    expect(res.status).toBe(200);
    expect(goalHostMock!.dispatchCalls).toHaveLength(0);
    expect(streamChat).toHaveBeenCalledTimes(1);
  });

  test("a message that contains the word 'goal' but isn't a /goal command → bypassed", async () => {
    await POST(makeEvent({ locals: { user }, body: { content: "what's the goal here?" } }));
    expect(goalHostMock!.dispatchCalls).toHaveLength(0);
  });

  test("`/goalpost foo` → bypassed (prefix must be the /goal token)", async () => {
    await POST(makeEvent({ locals: { user }, body: { content: "/goalpost foo" } }));
    expect(goalHostMock!.dispatchCalls).toHaveLength(0);
    expect(streamChat).toHaveBeenCalledTimes(1);
  });
});

// ── Rehydrate failure tolerated ────────────────────────────────────

describe("ensureGoalRecordRehydrated throw is swallowed (route never crashes)", () => {
  test("rehydrate throws → 200, streamChat still fires for a non-/goal post", async () => {
    goalHostMock!.ensureGoalRecordRehydrated.mockRejectedValue(new Error("read explosion"));
    const res = await POST(makeEvent({ locals: { user }, body: { content: "regular" } }));
    expect(res.status).toBe(200);
    expect(streamChat).toHaveBeenCalledTimes(1);
  });
});

// ── persistResultRow.row:null fallback (route synthesizes id) ──────

describe("dispatch.row null → route synthesizes a card id", () => {
  test("clear with row:null → ezActionResults has synthetic id + card content", async () => {
    goalHostMock!.setNextDispatch({
      kind: "card",
      result: { kind: "success", card: { title: "Cleared", body: "x", variant: "info" } },
      row: null,
    });
    const res = await POST(makeEvent({ locals: { user }, body: { content: "/goal clear" } }));
    const body = (await res.json()) as {
      ezActionResults: Array<{ id: string; content: string }>;
    };
    expect(body.ezActionResults).toHaveLength(1);
    expect(typeof body.ezActionResults[0]!.id).toBe("string");
    expect(body.ezActionResults[0]!.id.length).toBeGreaterThan(0);
    const parsed = JSON.parse(body.ezActionResults[0]!.content) as {
      card: { title: string };
    };
    expect(parsed.card.title).toBe("Cleared");
  });
});
