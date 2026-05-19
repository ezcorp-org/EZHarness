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
  DIRECT_CARRIER_EVENT_TYPES,
  isDirectCarrierEvent,
  isRegisteredExtensionEvent,
  registerExtensionEvent,
  unregisterExtensionEvents,
} from "../runtime/sse-conversation-filter";

// ── Fake getConversation ──
type FakeRow = { userId?: string | null } | null;
function makeGetConversation(rows: Record<string, FakeRow>): (id: string) => Promise<FakeRow> {
  return async (id: string) => rows[id] ?? null;
}

beforeEach(() => __clearMembershipCacheForTests());
afterEach(() => __clearMembershipCacheForTests());

describe("DIRECT_CARRIER_EVENT_TYPES", () => {
  test("enumerates the direct-carrier event types (13 from prereqs audit + ask-user:answer + ez:client-tool + extensions:installed; Phase 5's orchestrator:human_* removed by ask-user migration)", () => {
    // 15 entries: 13 from the prereqs audit + ez:client-tool (Phase 48
    // Wave 3) + extensions:installed (agent-install-ux-polish Phase 2 —
    // user-scoped, listed so isDirectCarrierEvent triggers
    // authorization filtering; shouldDeliverEvent has a dedicated
    // fail-closed userId branch for it).
    expect(DIRECT_CARRIER_EVENT_TYPES.size).toBe(15);
    for (const name of [
      "run:complete", "run:error", "run:cancel", "run:turn_saved",
      "tool:start", "tool:complete", "tool:error",
      "tool:permission_request", "tool:permission_mode_change",
      "obs:turn", "ask-user:answer",
      "ez:client-tool",
      "task:snapshot", "task:assignment_update",
      "extensions:installed",
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
      "pipeline:start", "pipeline:step", "pipeline:complete", "pipeline:error",
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

describe("shouldDeliverEvent — pass-through tier", () => {
  test("passes runId-only events regardless of subscriber", async () => {
    const get = makeGetConversation({});
    const deliver = await shouldDeliverEvent(
      "run:start",
      { run: { id: "run-1" } },
      { userId: "user-1" },
      get,
    );
    expect(deliver).toBe(true);
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

  test("passes agent:* events (subConversationId resolution deferred — Phase 2d follow-up)", async () => {
    const get = makeGetConversation({});
    const deliver = await shouldDeliverEvent(
      "agent:complete",
      { runId: "r", agentRunId: "ar", subConversationId: "sc", agentName: "a", agentConfigId: "ac", success: true, resultPreview: "", parentConversationId: "pc" },
      { userId: "user-1" },
      get,
    );
    expect(deliver).toBe(true);
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
