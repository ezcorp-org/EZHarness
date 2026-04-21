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
  DIRECT_CARRIER_EVENT_TYPES,
} from "../runtime/sse-conversation-filter";

// ── Fake getConversation ──
type FakeRow = { userId?: string | null } | null;
function makeGetConversation(rows: Record<string, FakeRow>): (id: string) => Promise<FakeRow> {
  return async (id: string) => rows[id] ?? null;
}

beforeEach(() => __clearMembershipCacheForTests());
afterEach(() => __clearMembershipCacheForTests());

describe("DIRECT_CARRIER_EVENT_TYPES", () => {
  test("enumerates the 13 event types identified in the prereqs audit", () => {
    expect(DIRECT_CARRIER_EVENT_TYPES.size).toBe(13);
    for (const name of [
      "run:complete", "run:error", "run:cancel", "run:turn_saved",
      "tool:start", "tool:complete", "tool:error",
      "tool:permission_request", "tool:permission_mode_change",
      "obs:turn", "orchestrator:human_input",
      "task:snapshot", "task:assignment_update",
    ]) {
      expect(DIRECT_CARRIER_EVENT_TYPES.has(name as never)).toBe(true);
    }
  });

  test("does NOT include runId-only events (pass-through tier)", () => {
    for (const name of [
      "run:start", "run:log", "run:status", "run:token", "run:usage",
      "run:turn_text_reset",
      "pipeline:start", "pipeline:step", "pipeline:complete", "pipeline:error",
      "tool:kill",
      "agent:spawn", "agent:status", "agent:complete",
      "orchestrator:human_response",
      "ext:state",
    ]) {
      expect(DIRECT_CARRIER_EVENT_TYPES.has(name as never)).toBe(false);
    }
  });
});

describe("isAuthorizedForConversation", () => {
  test("returns true when the conversation owner matches the subscriber", async () => {
    const get = makeGetConversation({ "conv-A": { userId: "user-1" } });
    await expect(isAuthorizedForConversation("user-1", "conv-A", get)).resolves.toBe(true);
  });

  test("returns false when the conversation belongs to another user", async () => {
    const get = makeGetConversation({ "conv-A": { userId: "user-2" } });
    await expect(isAuthorizedForConversation("user-1", "conv-A", get)).resolves.toBe(false);
  });

  test("returns false for a non-existent conversation row", async () => {
    const get = makeGetConversation({});
    await expect(isAuthorizedForConversation("user-1", "missing", get)).resolves.toBe(false);
  });

  test("fails OPEN on DB error (returns true) — avoids UI black-out on transient infra failure", async () => {
    const getThrowing = async () => { throw new Error("db is down"); };
    await expect(isAuthorizedForConversation("user-1", "conv-A", getThrowing)).resolves.toBe(true);
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
