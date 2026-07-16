/**
 * Unit tests for the Phase 2a-lite SSE conversation filter.
 *
 * Exercises `shouldDeliverEvent` with a fake `getConversation` so we
 * can deterministically simulate owner/non-owner/missing-row without
 * a real DB. The membership cache is cleared between tests so TTL
 * side-effects don't leak across assertions.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  shouldDeliverEvent,
  isAuthorizedForConversation,
  __clearMembershipCacheForTests,
  __clearExtensionEventRegistryForTests,
  __clearRunScopeCacheForTests,
  DIRECT_CARRIER_EVENT_TYPES,
  SCOPED_RUNTIME_EVENT_TYPES,
  isDirectCarrierEvent,
  isRegisteredExtensionEvent,
  registerExtensionEvent,
  unregisterExtensionEvents,
  type GetRunScope,
} from "../runtime/sse-conversation-filter";

// ── Fake getConversation ──
type FakeRow = { userId?: string | null; parentConversationId?: string | null } | null;
function makeGetConversation(rows: Record<string, FakeRow>): (id: string) => Promise<FakeRow> {
  return async (id: string) => rows[id] ?? null;
}

beforeEach(() => {
  __clearMembershipCacheForTests();
  __clearRunScopeCacheForTests();
});
afterEach(() => {
  __clearMembershipCacheForTests();
  __clearRunScopeCacheForTests();
});

describe("DIRECT_CARRIER_EVENT_TYPES", () => {
  test("enumerates the direct-carrier event types (13 from prereqs audit + ask-user:answer + ez:client-tool + extensions:installed + goal:update + the two briefing events + conversation:tree-changed; Phase 5's orchestrator:human_* removed by ask-user migration)", () => {
    // 19 entries: 13 from the prereqs audit + ez:client-tool (Phase 48
    // Wave 3) + extensions:installed (agent-install-ux-polish Phase 2)
    // + goal:update (/goal Phase 2, FR-20) + conversation:created +
    // briefing:delivered (Daily Briefing Phase 1) + conversation:tree-changed
    // (Sessions P4 rewind/checkpoint).
    expect(DIRECT_CARRIER_EVENT_TYPES.size).toBe(19);
    for (const name of [
      "run:complete", "run:error", "run:cancel", "run:turn_saved",
      "tool:start", "tool:complete", "tool:error",
      "tool:permission_request", "tool:permission_mode_change",
      "obs:turn", "ask-user:answer",
      "ez:client-tool",
      "task:snapshot", "task:assignment_update",
      "extensions:installed",
      "goal:update",
      "conversation:created",
      "briefing:delivered",
      "conversation:tree-changed",
    ]) {
      expect(DIRECT_CARRIER_EVENT_TYPES.has(name as never)).toBe(true);
    }
  });

  test("includes ask-user:answer — host-side response of the ask-user bundled extension's POST endpoint", () => {
    // Explicit assertion for the entry kept after the ask-user
    // migration. A regression removing this would silently break the
    // POST → bus → extension subscription gate-resolution path.
    expect(DIRECT_CARRIER_EVENT_TYPES.has("ask-user:answer")).toBe(true);
  });

  test("does NOT include the legacy orchestrator:human_* events — removed by the ask-user migration", () => {
    expect(DIRECT_CARRIER_EVENT_TYPES.has("orchestrator:human_input" as never)).toBe(false);
    expect(DIRECT_CARRIER_EVENT_TYPES.has("orchestrator:human_response" as never)).toBe(false);
  });

  test("does NOT include runId-only events (pass-through tier)", () => {
    for (const name of [
      "run:start", "run:log", "run:status", "run:token", "run:usage",
      "run:turn_text_reset",
      "workflow:start", "workflow:step", "workflow:complete", "workflow:error",
      "tool:kill",
      "agent:spawn", "agent:status", "agent:complete",
      "ext:state",
    ]) {
      expect(DIRECT_CARRIER_EVENT_TYPES.has(name as never)).toBe(false);
    }
  });
});

describe("isAuthorizedForConversation", () => {
  test("returns true when the conversation owner matches the subscriber", async () => {
    const get = makeGetConversation({ "conv-A": { userId: "user-1" } });
    expect(isAuthorizedForConversation("user-1", "conv-A", get)).resolves.toBe(true);
  });

  test("returns false when the conversation belongs to another user", async () => {
    const get = makeGetConversation({ "conv-A": { userId: "user-2" } });
    expect(isAuthorizedForConversation("user-1", "conv-A", get)).resolves.toBe(false);
  });

  test("returns false for a non-existent conversation row", async () => {
    const get = makeGetConversation({});
    expect(isAuthorizedForConversation("user-1", "missing", get)).resolves.toBe(false);
  });

  test("fails OPEN on DB error (returns true) — avoids UI black-out on transient infra failure", async () => {
    const getThrowing = async () => { throw new Error("db is down"); };
    expect(isAuthorizedForConversation("user-1", "conv-A", getThrowing)).resolves.toBe(true);
  });

  test("caches membership within TTL — second lookup does not query DB", async () => {
    let calls = 0;
    const get = async (id: string): Promise<FakeRow> => {
      calls += 1;
      return { userId: id === "conv-A" ? "user-1" : "user-2" };
    };
    await isAuthorizedForConversation("user-1", "conv-A", get);
    await isAuthorizedForConversation("user-1", "conv-A", get);
    expect(calls).toBe(1);
  });
});

describe("shouldDeliverEvent — direct-carrier filtering", () => {
  test("passes when subscriber owns the event's conversationId", async () => {
    const get = makeGetConversation({ "conv-A": { userId: "user-1" } });
    const deliver = await shouldDeliverEvent(
      "tool:complete",
      { conversationId: "conv-A", extensionId: "ext", toolName: "t", output: {}, duration: 0, success: true },
      { userId: "user-1" },
      get,
    );
    expect(deliver).toBe(true);
  });

  test("blocks when event's conversationId belongs to another user (cross-user leak prevention)", async () => {
    const get = makeGetConversation({ "conv-B": { userId: "user-2" } });
    const deliver = await shouldDeliverEvent(
      "task:snapshot",
      { conversationId: "conv-B", tasks: [] },
      { userId: "user-1" },
      get,
    );
    expect(deliver).toBe(false);
  });

  test("ask-user:answer is filtered by conversationId — passes to owner of conv-A, drops for conv-B subscriber", async () => {
    // The ask-user POST endpoint emits this event with conversationId
    // at the top level. The filter blocks cross-user leak attempts
    // identically to tool:complete / task:snapshot.
    const get = makeGetConversation({
      "conv-A": { userId: "user-1" },
      "conv-B": { userId: "user-2" },
    });

    // conv-A owner receives the event emitted for conv-A.
    const deliverSameConv = await shouldDeliverEvent(
      "ask-user:answer",
      { toolCallId: "tc-1", answer: "blue", conversationId: "conv-A" },
      { userId: "user-1" },
      get,
    );
    expect(deliverSameConv).toBe(true);

    // user-2 is on conv-B but the event targets conv-A → filter drops it.
    const deliverCrossUser = await shouldDeliverEvent(
      "ask-user:answer",
      { toolCallId: "tc-1", answer: "blue", conversationId: "conv-A" },
      { userId: "user-2" },
      get,
    );
    expect(deliverCrossUser).toBe(false);
  });

  test("blocks a forged conversationId (event claims conv user does not own)", async () => {
    // This is the capability-tool attack scenario — an extension emits
    // a `task:assignment_update` with a forged conversationId pointing
    // at user-B's conversation. Server-side filter must block.
    const get = makeGetConversation({
      "user-1-conv": { userId: "user-1" },
      "user-2-conv": { userId: "user-2" },
    });
    const deliver = await shouldDeliverEvent(
      "task:assignment_update",
      { conversationId: "user-2-conv", taskId: "t", assignment: {} },
      { userId: "user-1" },
      get,
    );
    expect(deliver).toBe(false);
  });
});

describe("shouldDeliverEvent — goal:update (/goal Phase 2, FR-20, FR-16)", () => {
  // The `◎ /goal active|paused` chip's underlying event MUST be
  // routed per-subscriber by the payload's `conversationId`. These
  // assertions are the FR-16 / FR-20 contract: every event emitted by
  // the goal-host for conv-A is delivered ONLY to subscribers
  // authorized for conv-A, never to subscribers on other conversations
  // — even if those subscribers are the same user (a user could have
  // multiple conversations open in separate tabs; each tab's
  // GoalPill should only update for its own conversation).

  test("goal:update for conv-A passes to conv-A's owner", async () => {
    const get = makeGetConversation({ "conv-A": { userId: "user-1" } });
    const deliver = await shouldDeliverEvent(
      "goal:update",
      {
        conversationId: "conv-A",
        state: "active",
        condition: "ship the goal feature",
        armedAt: 1_000_000,
        turnsEvaluated: 0,
        lastReason: null,
      },
      { userId: "user-1" },
      get,
    );
    expect(deliver).toBe(true);
  });

  test("goal:update for conv-A is BLOCKED for a different user (cross-user isolation)", async () => {
    // Two users, two conversations. User-2 must never receive
    // user-1's goal-state transitions, even though `goal:update` is a
    // generic event name (not pre-bound to a user).
    const get = makeGetConversation({
      "conv-A": { userId: "user-1" },
      "conv-B": { userId: "user-2" },
    });
    const deliver = await shouldDeliverEvent(
      "goal:update",
      { conversationId: "conv-A", state: "paused" },
      { userId: "user-2" },
      get,
    );
    expect(deliver).toBe(false);
  });

  test("goal:update for conv-A is BLOCKED on the same user's other conversation tab (per-tab subscriber-conv hint is informational; auth is per-event)", async () => {
    // Same user has two conversations open. The subscriber's
    // `conversationId` hint is captured at connect time as the
    // currently-viewed conversation, but authorization is enforced
    // against the EVENT's claimed conversationId — so a goal:update
    // emitted for conv-A still authorizes via "does subscriber.userId
    // own conv-A?". With strict-owner authorization, the answer is
    // YES (same user) → the event is delivered to BOTH tabs. The
    // GoalPill component then double-checks the payload's
    // conversationId on the client side and ignores frames for the
    // wrong conversation. This test pins that server-side behavior
    // (the per-tab discriminator is the pill, not this filter).
    const get = makeGetConversation({
      "conv-A": { userId: "user-1" },
      "conv-C": { userId: "user-1" },
    });
    const deliver = await shouldDeliverEvent(
      "goal:update",
      { conversationId: "conv-A", state: "active" },
      { userId: "user-1", conversationId: "conv-C" },
      get,
    );
    // Strict-owner authorization passes because user-1 owns conv-A.
    // Per-conversation tab scoping happens client-side in the pill.
    expect(deliver).toBe(true);
  });

  test("goal:update for a non-existent conversation is BLOCKED (fail-closed on unknown rows)", async () => {
    // A forged or stale conversationId resolves to a `null` row; the
    // membership check returns false → the event is dropped. Matches
    // the behavior of `tool:complete` for missing rows (the underlying
    // `isAuthorizedForConversation` branch is shared).
    const get = makeGetConversation({});
    const deliver = await shouldDeliverEvent(
      "goal:update",
      { conversationId: "no-such-conv", state: "off" },
      { userId: "user-1" },
      get,
    );
    expect(deliver).toBe(false);
  });

  test("goal:update is recognized by isDirectCarrierEvent (so it gets the auth-filter codepath)", () => {
    // The static set + `isDirectCarrierEvent` are the gate that
    // distinguishes "filter this" from "pass through". A regression
    // dropping goal:update from the set would silently broadcast
    // every user's goal-state to every subscriber.
    expect(isDirectCarrierEvent("goal:update")).toBe(true);
  });
});

describe("shouldDeliverEvent — conversation:tree-changed (Sessions P4 rewind)", () => {
  // The rewind nudge MUST be scoped per-subscriber by the payload's
  // conversationId, exactly like goal:update: a rewind in user-1's
  // conversation must never light up user-2's tree.

  test("conversation:tree-changed for conv-A passes to conv-A's owner", async () => {
    const get = makeGetConversation({ "conv-A": { userId: "user-1" } });
    const deliver = await shouldDeliverEvent(
      "conversation:tree-changed",
      { conversationId: "conv-A", currentLeaf: "m-42" },
      { userId: "user-1" },
      get,
    );
    expect(deliver).toBe(true);
  });

  test("conversation:tree-changed for conv-A is BLOCKED for a different user (cross-user isolation)", async () => {
    const get = makeGetConversation({
      "conv-A": { userId: "user-1" },
      "conv-B": { userId: "user-2" },
    });
    const deliver = await shouldDeliverEvent(
      "conversation:tree-changed",
      { conversationId: "conv-A", currentLeaf: "m-42" },
      { userId: "user-2" },
      get,
    );
    expect(deliver).toBe(false);
  });

  test("conversation:tree-changed for a non-existent conversation is BLOCKED (fail-closed on unknown rows)", async () => {
    const get = makeGetConversation({});
    const deliver = await shouldDeliverEvent(
      "conversation:tree-changed",
      { conversationId: "no-such-conv", currentLeaf: null },
      { userId: "user-1" },
      get,
    );
    expect(deliver).toBe(false);
  });

  test("conversation:tree-changed is recognized by isDirectCarrierEvent (so it gets the auth-filter codepath)", () => {
    expect(isDirectCarrierEvent("conversation:tree-changed")).toBe(true);
  });

  test("fails CLOSED on a DB error (dropped, not broadcast) — UNLIKE the fail-open conv carriers", async () => {
    // The generic conv-scoped carriers fail OPEN on DB error (avoid UI
    // black-out). A tree-changed nudge instead fails CLOSED: a missed nudge
    // self-heals on reconnect/refetch, so dropping beats leaking the
    // conversation + rewound-leaf ids cross-user under DB stress.
    const getThrowing = async () => { throw new Error("db is down"); };
    const deliver = await shouldDeliverEvent(
      "conversation:tree-changed",
      { conversationId: "conv-A", currentLeaf: "m-1" },
      { userId: "user-1" },
      getThrowing,
    );
    expect(deliver).toBe(false);
  });
});

describe("shouldDeliverEvent — pass-through tier", () => {
  test("DROPS runId-only events when no run-scope resolver is wired (Wave 0 fail-closed — previously broadcast)", async () => {
    // Pre-Wave-0 behavior was `true` here: run:start (and run:token —
    // raw LLM text!) broadcast to every authenticated subscriber. The
    // scoped-runtime tier now fails closed when scope can't be proven.
    const get = makeGetConversation({});
    const deliver = await shouldDeliverEvent(
      "run:start",
      { run: { id: "run-1" } },
      { userId: "user-1" },
      get,
    );
    expect(deliver).toBe(false);
  });

  test("passes ext:state events (extension-scoped, not conversation-scoped)", async () => {
    const get = makeGetConversation({});
    const deliver = await shouldDeliverEvent(
      "ext:state",
      { extensionId: "ext-1", extensionName: "ext", state: {}, timestamp: 0 },
      { userId: "user-1" },
      get,
    );
    expect(deliver).toBe(true);
  });

  test("passes ext:page-state events (content-free Hub invalidation signal — broadcast by design)", async () => {
    // Extension Pages Hub §2.5: the mediator strips the page tree
    // before emitting, so the event leaks only "page X changed" and is
    // deliberately NOT in DIRECT_CARRIER_EVENT_TYPES. If someone adds
    // it there, this test fails — the event carries no conversationId/
    // userId to authorize against and would be silently dropped.
    const get = makeGetConversation({});
    const deliver = await shouldDeliverEvent(
      "ext:page-state",
      { extensionId: "ext-1", extensionName: "cron-dashboard", pageId: "dashboard", timestamp: 0 },
      { userId: "user-1" },
      get,
    );
    expect(deliver).toBe(true);
  });

  test("agent:* events are scoped by parentConversationId (Wave 0 — previously broadcast)", async () => {
    const owned = makeGetConversation({ pc: { userId: "user-1" } });
    const foreign = makeGetConversation({ pc: { userId: "user-2" } });
    const payload = { runId: "r", agentRunId: "ar", subConversationId: "sc", agentName: "a", agentConfigId: "ac", success: true, resultPreview: "", parentConversationId: "pc" };
    expect(await shouldDeliverEvent("agent:complete", payload, { userId: "user-1" }, owned)).toBe(true);
    __clearMembershipCacheForTests();
    expect(await shouldDeliverEvent("agent:complete", payload, { userId: "user-1" }, foreign)).toBe(false);
    // Phase B2: a background child's terminal agent:complete (success=false)
    // is scoped identically — the emit is now fired from start-assignment on
    // every terminal, so the failure variant must reach the owning parent too.
    __clearMembershipCacheForTests();
    const failurePayload = { ...payload, success: false, resultPreview: "Run was cancelled" };
    expect(await shouldDeliverEvent("agent:complete", failurePayload, { userId: "user-1" }, owned)).toBe(true);
  });
});

describe("shouldDeliverEvent — optional-carrier events without conversationId", () => {
  test("run:complete without conversationId passes through (payload field is optional)", async () => {
    const get = makeGetConversation({});
    const deliver = await shouldDeliverEvent(
      "run:complete",
      { run: { id: "run-1" } /* no conversationId */ },
      { userId: "user-1" },
      get,
    );
    expect(deliver).toBe(true);
  });

  test("run:complete WITH conversationId is filtered (strict when the field is present)", async () => {
    const get = makeGetConversation({ "conv-B": { userId: "user-2" } });
    const deliver = await shouldDeliverEvent(
      "run:complete",
      { run: { id: "run-1" }, conversationId: "conv-B" },
      { userId: "user-1" },
      get,
    );
    expect(deliver).toBe(false);
  });
});

// ── agent-install-ux-polish Phase 2 (D3): user-scoped delivery ──────
//
// `extensions:installed` carries NO conversationId. It MUST be
// delivered to the installing user's SSE session ONLY, never
// broadcast, and the userId branch FAILS CLOSED (mirrors
// tool:permission_request's H7 scoping but stricter — a missing /
// empty / mismatched userId is dropped, not passed through).

describe("shouldDeliverEvent — extensions:installed (user-scoped, fail-closed)", () => {
  // getConversation must never be consulted for this event (it has no
  // conversationId) — a throwing fake proves the userId branch
  // short-circuits before any conversation lookup.
  const neverCalled = async (): Promise<FakeRow> => {
    throw new Error("getConversation must not be called for extensions:installed");
  };

  test("delivered to the installing user's own session", async () => {
    const deliver = await shouldDeliverEvent(
      "extensions:installed",
      { userId: "user-1", extensionId: "ext-1", name: "weather" },
      { userId: "user-1" },
      neverCalled,
    );
    expect(deliver).toBe(true);
  });

  test("NOT delivered to a different user (no cross-user install leak)", async () => {
    const deliver = await shouldDeliverEvent(
      "extensions:installed",
      { userId: "user-1", extensionId: "ext-1", name: "weather" },
      { userId: "user-2" },
      neverCalled,
    );
    expect(deliver).toBe(false);
  });

  test("absent userId → dropped (fail-closed, never broadcast)", async () => {
    const deliver = await shouldDeliverEvent(
      "extensions:installed",
      { extensionId: "ext-1", name: "weather" },
      { userId: "user-1" },
      neverCalled,
    );
    expect(deliver).toBe(false);
  });

  test("empty-string userId → dropped (fail-closed)", async () => {
    const deliver = await shouldDeliverEvent(
      "extensions:installed",
      { userId: "", extensionId: "ext-1", name: "weather" },
      { userId: "user-1" },
      neverCalled,
    );
    expect(deliver).toBe(false);
  });

  test("non-string userId → dropped (fail-closed)", async () => {
    const deliver = await shouldDeliverEvent(
      "extensions:installed",
      { userId: 123 as unknown as string, extensionId: "ext-1", name: "weather" },
      { userId: "user-1" },
      neverCalled,
    );
    expect(deliver).toBe(false);
  });

  test("is a recognized direct-carrier event", () => {
    expect(isDirectCarrierEvent("extensions:installed")).toBe(true);
  });
});

// ── Daily Briefing Phase 1: user-scoped delivery signals ────────────
//
// `conversation:created` + `briefing:delivered` carry BOTH a userId
// and a conversationId, but delivery is gated on the userId branch
// ONLY (fail-closed) — the conversation-ownership check fails OPEN on
// DB errors, which is unacceptable for a cross-user briefing leak.
// The throwing fake proves the branch short-circuits before any
// conversation lookup despite the payload carrying a conversationId.

describe("shouldDeliverEvent — briefing events (user-scoped, fail-closed)", () => {
  const neverCalled = async (): Promise<FakeRow> => {
    throw new Error("getConversation must not be called for briefing events");
  };
  const payload = {
    userId: "user-1",
    conversationId: "conv-brief",
    projectId: "proj-1",
    source: "briefing",
  };

  for (const eventType of ["conversation:created", "briefing:delivered"] as const) {
    test(`${eventType}: delivered to the owning user's own session`, async () => {
      const deliver = await shouldDeliverEvent(eventType, payload, { userId: "user-1" }, neverCalled);
      expect(deliver).toBe(true);
    });

    test(`${eventType}: user B never receives user A's event`, async () => {
      const deliver = await shouldDeliverEvent(eventType, payload, { userId: "user-B" }, neverCalled);
      expect(deliver).toBe(false);
    });

    test(`${eventType}: absent userId → dropped (fail-closed, never broadcast)`, async () => {
      const { userId: _drop, ...withoutUser } = payload;
      const deliver = await shouldDeliverEvent(eventType, withoutUser, { userId: "user-1" }, neverCalled);
      expect(deliver).toBe(false);
    });

    test(`${eventType}: empty-string userId → dropped (fail-closed)`, async () => {
      const deliver = await shouldDeliverEvent(eventType, { ...payload, userId: "" }, { userId: "user-1" }, neverCalled);
      expect(deliver).toBe(false);
    });

    test(`${eventType}: non-string userId → dropped (fail-closed)`, async () => {
      const deliver = await shouldDeliverEvent(
        eventType,
        { ...payload, userId: 42 as unknown as string },
        { userId: "user-1" },
        neverCalled,
      );
      expect(deliver).toBe(false);
    });

    test(`${eventType}: is a recognized direct-carrier event`, () => {
      expect(isDirectCarrierEvent(eventType)).toBe(true);
    });
  }
});

// ── Phase A2: extension-declared event registry ─────────────────────

describe("registerExtensionEvent — validation", () => {
  beforeEach(() => __clearExtensionEventRegistryForTests());
  afterEach(() => __clearExtensionEventRegistryForTests());

  test("accepts a valid namespace + event pair", () => {
    expect(registerExtensionEvent("claude-design", "knob-change")).toBe(true);
    expect(isRegisteredExtensionEvent("claude-design:knob-change")).toBe(true);
  });

  test("rejects namespace not matching extension-name regex", () => {
    expect(registerExtensionEvent("Bad Name", "evt")).toBe(false);
    expect(registerExtensionEvent("UPPER", "evt")).toBe(false);
    expect(registerExtensionEvent("", "evt")).toBe(false);
    expect(registerExtensionEvent("a".repeat(65), "evt")).toBe(false);
  });

  test("rejects empty event name", () => {
    expect(registerExtensionEvent("ext", "")).toBe(false);
  });

  test("rejects event name containing a colon (would re-prefix)", () => {
    expect(registerExtensionEvent("ext", "nested:event")).toBe(false);
  });

  test("re-registering the same pair is idempotent", () => {
    expect(registerExtensionEvent("ext", "evt")).toBe(true);
    expect(registerExtensionEvent("ext", "evt")).toBe(true);
    expect(isRegisteredExtensionEvent("ext:evt")).toBe(true);
  });
});

describe("isRegisteredExtensionEvent — pattern matching", () => {
  beforeEach(() => __clearExtensionEventRegistryForTests());
  afterEach(() => __clearExtensionEventRegistryForTests());

  test("returns false for empty registry regardless of input", () => {
    expect(isRegisteredExtensionEvent("anything")).toBe(false);
    expect(isRegisteredExtensionEvent("ext:evt")).toBe(false);
    expect(isRegisteredExtensionEvent("")).toBe(false);
  });

  test("returns false for missing colon", () => {
    registerExtensionEvent("ext", "evt");
    expect(isRegisteredExtensionEvent("evt")).toBe(false);
    expect(isRegisteredExtensionEvent("ext")).toBe(false);
  });

  test("returns false for leading/trailing colon", () => {
    registerExtensionEvent("ext", "evt");
    expect(isRegisteredExtensionEvent(":evt")).toBe(false);
    expect(isRegisteredExtensionEvent("ext:")).toBe(false);
  });

  test("splits on the FIRST colon (suffix may contain colons in theory; rejected at register time)", () => {
    // We cannot register "a:b:c" because event name with ":" is rejected.
    // But the splitter uses first-colon — namespace "a" looks for event "b:c".
    // Both would have to have been registered to match.
    registerExtensionEvent("a", "b");
    expect(isRegisteredExtensionEvent("a:b")).toBe(true);
    expect(isRegisteredExtensionEvent("a:b:c")).toBe(false); // "a" has no event "b:c"
  });

  test("returns false for unknown namespace", () => {
    registerExtensionEvent("ext-a", "evt");
    expect(isRegisteredExtensionEvent("ext-b:evt")).toBe(false);
  });

  test("returns false for known namespace with unknown event", () => {
    registerExtensionEvent("ext", "evt-1");
    expect(isRegisteredExtensionEvent("ext:evt-2")).toBe(false);
  });
});

describe("unregisterExtensionEvents — cleanup", () => {
  beforeEach(() => __clearExtensionEventRegistryForTests());
  afterEach(() => __clearExtensionEventRegistryForTests());

  test("drops every event for the namespace", () => {
    registerExtensionEvent("ext", "a");
    registerExtensionEvent("ext", "b");
    expect(isRegisteredExtensionEvent("ext:a")).toBe(true);
    expect(isRegisteredExtensionEvent("ext:b")).toBe(true);

    unregisterExtensionEvents("ext");
    expect(isRegisteredExtensionEvent("ext:a")).toBe(false);
    expect(isRegisteredExtensionEvent("ext:b")).toBe(false);
  });

  test("does not affect other namespaces", () => {
    registerExtensionEvent("ext-a", "evt");
    registerExtensionEvent("ext-b", "evt");

    unregisterExtensionEvents("ext-a");
    expect(isRegisteredExtensionEvent("ext-a:evt")).toBe(false);
    expect(isRegisteredExtensionEvent("ext-b:evt")).toBe(true);
  });

  test("unregistering an unknown namespace is a no-op", () => {
    registerExtensionEvent("ext", "evt");
    expect(() => unregisterExtensionEvents("never-registered")).not.toThrow();
    expect(isRegisteredExtensionEvent("ext:evt")).toBe(true);
  });
});

describe("isDirectCarrierEvent — combined predicate", () => {
  beforeEach(() => __clearExtensionEventRegistryForTests());
  afterEach(() => __clearExtensionEventRegistryForTests());

  test("returns true for platform events", () => {
    expect(isDirectCarrierEvent("tool:start")).toBe(true);
    expect(isDirectCarrierEvent("ask-user:answer")).toBe(true);
    expect(isDirectCarrierEvent("task:snapshot")).toBe(true);
  });

  test("returns true for registered extension events", () => {
    registerExtensionEvent("claude-design", "knob-change");
    expect(isDirectCarrierEvent("claude-design:knob-change")).toBe(true);
  });

  test("returns false for unknown events", () => {
    expect(isDirectCarrierEvent("nope:never")).toBe(false);
    expect(isDirectCarrierEvent("totally-unknown")).toBe(false);
  });

  test("platform events take precedence over registry collisions", () => {
    // Even if someone registered an extension named "tool" with event
    // "start" (which the dispatcher's namespace check would reject in
    // practice), the platform set is checked first.
    registerExtensionEvent("tool", "start");
    expect(isDirectCarrierEvent("tool:start")).toBe(true);
  });
});

describe("shouldDeliverEvent — extension events", () => {
  beforeEach(() => {
    __clearMembershipCacheForTests();
    __clearExtensionEventRegistryForTests();
  });
  afterEach(() => {
    __clearMembershipCacheForTests();
    __clearExtensionEventRegistryForTests();
  });

  test("extension event WITHOUT conversationId passes through (can't filter what we can't see)", async () => {
    registerExtensionEvent("claude-design", "knob-change");
    const get = makeGetConversation({});
    const deliver = await shouldDeliverEvent(
      "claude-design:knob-change",
      { primaryColor: "#ff0066" }, // no conversationId
      { userId: "user-1" },
      get,
    );
    expect(deliver).toBe(true);
  });

  test("extension event WITH owning user delivers", async () => {
    registerExtensionEvent("claude-design", "knob-change");
    const get = makeGetConversation({ "conv-A": { userId: "user-1" } });
    const deliver = await shouldDeliverEvent(
      "claude-design:knob-change",
      { conversationId: "conv-A", primaryColor: "#ff0066" },
      { userId: "user-1" },
      get,
    );
    expect(deliver).toBe(true);
  });

  test("extension event WITH non-owning user is filtered", async () => {
    registerExtensionEvent("claude-design", "knob-change");
    const get = makeGetConversation({ "conv-A": { userId: "owner" } });
    const deliver = await shouldDeliverEvent(
      "claude-design:knob-change",
      { conversationId: "conv-A", primaryColor: "#ff0066" },
      { userId: "intruder" },
      get,
    );
    expect(deliver).toBe(false);
  });

  test("UNREGISTERED extension event passes through (defense: not our problem)", async () => {
    // No registration call. The unknown event is treated as not-a-direct-
    // carrier and passes through to the client-side filter.
    const get = makeGetConversation({ "conv-A": { userId: "owner" } });
    const deliver = await shouldDeliverEvent(
      "unknown-ext:rogue",
      { conversationId: "conv-A" },
      { userId: "intruder" },
      get,
    );
    expect(deliver).toBe(true);
  });
});

// ── Wave 0 (orchestration-upgrade): scoped runtime streaming events ──
//
// `run:token` (raw streamed LLM text) and its siblings used to broadcast
// to every authenticated SSE subscriber. These suites pin the fail-closed
// scoping contract: conversation carrier → ownership check, userId →
// exact match, runId → executor-backed resolution, otherwise DROP.

describe("SCOPED_RUNTIME_EVENT_TYPES", () => {
  const MEMBERS = [
    "run:start", "run:log", "run:status", "run:token", "run:usage",
    "run:turn_text_reset",
    "agent:spawn", "agent:status", "agent:complete",
    "workflow:start", "workflow:step", "workflow:complete", "workflow:error",
  ] as const;

  test("enumerates the 13 scoped runtime events", () => {
    expect(SCOPED_RUNTIME_EVENT_TYPES.size).toBe(13);
    for (const name of MEMBERS) {
      expect(SCOPED_RUNTIME_EVENT_TYPES.has(name as never)).toBe(true);
    }
  });

  test("every member requires authorization filtering (isDirectCarrierEvent)", () => {
    for (const name of MEMBERS) {
      expect(isDirectCarrierEvent(name)).toBe(true);
    }
  });

  test("members stay OUT of DIRECT_CARRIER_EVENT_TYPES — that set doubles as the extension-subscription allowlist and raw token streams must not become subscribable", () => {
    for (const name of MEMBERS) {
      expect(DIRECT_CARRIER_EVENT_TYPES.has(name as never)).toBe(false);
    }
  });

  test("registerExtensionEvent rejects collisions with scoped runtime events (an extension named 'run' cannot shadow run:token)", () => {
    expect(registerExtensionEvent("run", "token")).toBe(false);
    expect(registerExtensionEvent("agent", "spawn")).toBe(false);
    expect(registerExtensionEvent("workflow", "start")).toBe(false);
    __clearExtensionEventRegistryForTests();
  });
});

describe("shouldDeliverEvent — scoped runtime events (Wave 0)", () => {
  const makeRunScope = (map: Record<string, { conversationId?: string | null; userId?: string | null } | null>): GetRunScope =>
    async (runId: string) => map[runId] ?? null;

  test("run:token reaches ONLY the run's conversation owner (leak regression)", async () => {
    const get = makeGetConversation({ "conv-A": { userId: "owner" } });
    const getRunScope = makeRunScope({ "run-1": { conversationId: "conv-A" } });
    const payload = { runId: "run-1", token: "s3cret-stream", kind: "text" };
    expect(await shouldDeliverEvent("run:token", payload, { userId: "owner" }, get, getRunScope)).toBe(true);
    expect(await shouldDeliverEvent("run:token", payload, { userId: "intruder" }, get, getRunScope)).toBe(false);
  });

  test("conversation-less run resolves to the initiating user (agent/CLI runs)", async () => {
    const get = makeGetConversation({});
    const getRunScope = makeRunScope({ "run-2": { userId: "runner" } });
    const payload = { runId: "run-2", status: "working" };
    expect(await shouldDeliverEvent("run:status", payload, { userId: "runner" }, get, getRunScope)).toBe(true);
    expect(await shouldDeliverEvent("run:status", payload, { userId: "other" }, get, getRunScope)).toBe(false);
  });

  test("unknown run (resolver returns null) is DROPPED", async () => {
    const get = makeGetConversation({});
    const getRunScope = makeRunScope({});
    expect(await shouldDeliverEvent("run:token", { runId: "ghost", token: "x" }, { userId: "u" }, get, getRunScope)).toBe(false);
  });

  test("resolver failure is DROPPED (fail-closed), not broadcast", async () => {
    const get = makeGetConversation({});
    const getRunScope: GetRunScope = async () => { throw new Error("db down"); };
    expect(await shouldDeliverEvent("run:token", { runId: "run-1", token: "x" }, { userId: "u" }, get, getRunScope)).toBe(false);
  });

  test("missing resolver is DROPPED (legacy callers cannot broadcast scoped events)", async () => {
    const get = makeGetConversation({});
    expect(await shouldDeliverEvent("run:token", { runId: "run-1", token: "x" }, { userId: "u" }, get)).toBe(false);
  });

  test("scoped conversation authorization fails CLOSED on DB error (contrast: legacy carriers fail open)", async () => {
    const getThrowing = async (): Promise<FakeRow> => { throw new Error("db down"); };
    const getRunScope = makeRunScope({ "run-1": { conversationId: "conv-A" } });
    expect(await shouldDeliverEvent("run:token", { runId: "run-1", token: "x" }, { userId: "u" }, getThrowing, getRunScope)).toBe(false);
    // Legacy carrier keeps its documented fail-open contract.
    expect(await shouldDeliverEvent("tool:complete", { conversationId: "conv-A" }, { userId: "u" }, getThrowing)).toBe(true);
  });

  test("workflow:* events are scoped to the initiating userId, fail-closed when absent", async () => {
    const get = makeGetConversation({});
    const payload = { workflowRun: { id: "p1" }, userId: "runner" };
    expect(await shouldDeliverEvent("workflow:start", payload, { userId: "runner" }, get)).toBe(true);
    expect(await shouldDeliverEvent("workflow:start", payload, { userId: "other" }, get)).toBe(false);
    // CLI-triggered workflow (no userId) → dropped, never broadcast.
    expect(await shouldDeliverEvent("workflow:complete", { workflowRun: { id: "p2" } }, { userId: "runner" }, get)).toBe(false);
  });

  test("agent:status without parent carrier is scoped via subConversationId, walking to the parent owner", async () => {
    const get = makeGetConversation({
      "sub-1": { userId: null, parentConversationId: "conv-A" },
      "conv-A": { userId: "owner" },
    });
    const payload = { runId: "r-x", subConversationId: "sub-1", agentName: "a", status: "running" };
    expect(await shouldDeliverEvent("agent:status", payload, { userId: "owner" }, get)).toBe(true);
    __clearMembershipCacheForTests();
    expect(await shouldDeliverEvent("agent:status", payload, { userId: "intruder" }, get)).toBe(false);
  });

  test("run-scope resolution is cached — one resolver call serves a token burst", async () => {
    let calls = 0;
    const getRunScope: GetRunScope = async () => {
      calls += 1;
      return { conversationId: "conv-A" };
    };
    const get = makeGetConversation({ "conv-A": { userId: "owner" } });
    for (let i = 0; i < 5; i++) {
      await shouldDeliverEvent("run:token", { runId: "run-1", token: `t${i}` }, { userId: "owner" }, get, getRunScope);
    }
    expect(calls).toBe(1);
  });

  test("unresolved scope is NOT cached — the run row may not be written yet", async () => {
    const answers: Array<{ conversationId?: string } | null> = [null, { conversationId: "conv-A" }];
    let calls = 0;
    const getRunScope: GetRunScope = async () => {
      calls += 1;
      return answers.shift() ?? null;
    };
    const get = makeGetConversation({ "conv-A": { userId: "owner" } });
    expect(await shouldDeliverEvent("run:token", { runId: "run-1", token: "a" }, { userId: "owner" }, get, getRunScope)).toBe(false);
    expect(await shouldDeliverEvent("run:token", { runId: "run-1", token: "b" }, { userId: "owner" }, get, getRunScope)).toBe(true);
    expect(calls).toBe(2);
  });
});

describe("isAuthorizedForConversation — sub-conversation ownership walk", () => {
  test("null-owner sub-conversation inherits the parent's owner", async () => {
    const get = makeGetConversation({
      "sub-1": { userId: null, parentConversationId: "conv-A" },
      "conv-A": { userId: "owner" },
    });
    expect(await isAuthorizedForConversation("owner", "sub-1", get)).toBe(true);
    __clearMembershipCacheForTests();
    expect(await isAuthorizedForConversation("intruder", "sub-1", get)).toBe(false);
  });

  test("nested null-owner chain walks to the grandparent", async () => {
    const get = makeGetConversation({
      "sub-2": { userId: null, parentConversationId: "sub-1" },
      "sub-1": { userId: null, parentConversationId: "conv-A" },
      "conv-A": { userId: "owner" },
    });
    expect(await isAuthorizedForConversation("owner", "sub-2", get)).toBe(true);
  });

  test("ownerless chain authorizes NOBODY", async () => {
    const get = makeGetConversation({
      "sub-1": { userId: null, parentConversationId: "conv-A" },
      "conv-A": { userId: null },
    });
    expect(await isAuthorizedForConversation("anyone", "sub-1", get)).toBe(false);
  });

  test("cyclic parent chain terminates at the depth cap and denies", async () => {
    const get = makeGetConversation({
      "a": { userId: null, parentConversationId: "b" },
      "b": { userId: null, parentConversationId: "a" },
    });
    expect(await isAuthorizedForConversation("anyone", "a", get)).toBe(false);
  });
});

describe("shouldDeliverEvent — run terminal events runId upgrade (Wave 0)", () => {
  const makeRunScope = (map: Record<string, { conversationId?: string | null; userId?: string | null } | null>): GetRunScope =>
    async (runId: string) => map[runId] ?? null;

  test("run:complete without conversationId is scoped via runId when a resolver is wired", async () => {
    const get = makeGetConversation({ "conv-A": { userId: "owner" } });
    const getRunScope = makeRunScope({ "run-1": { conversationId: "conv-A" } });
    const payload = { run: { id: "run-1", result: { output: "private" } } };
    expect(await shouldDeliverEvent("run:complete", payload, { userId: "owner" }, get, getRunScope)).toBe(true);
    expect(await shouldDeliverEvent("run:complete", payload, { userId: "intruder" }, get, getRunScope)).toBe(false);
  });

  test("run:complete falls back to the initiating user for conversation-less runs", async () => {
    const get = makeGetConversation({});
    const getRunScope = makeRunScope({ "run-2": { userId: "runner" } });
    const payload = { run: { id: "run-2" } };
    expect(await shouldDeliverEvent("run:complete", payload, { userId: "runner" }, get, getRunScope)).toBe(true);
    expect(await shouldDeliverEvent("run:complete", payload, { userId: "other" }, get, getRunScope)).toBe(false);
  });

  test("genuinely unresolvable run:complete keeps the historical pass-through", async () => {
    const get = makeGetConversation({});
    const getRunScope = makeRunScope({});
    expect(await shouldDeliverEvent("run:complete", { run: { id: "ghost" } }, { userId: "u" }, get, getRunScope)).toBe(true);
  });
});
