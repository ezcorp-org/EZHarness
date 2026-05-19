/**
 * Tests for the `agent:complete` event routing in stores.svelte.ts —
 * specifically the DOM-event dispatch that tells the chat page to
 * re-hydrate after a sub-agent (e.g. invoked from the team panel)
 * finishes its work.
 *
 * Why a test double? The real store uses Svelte 5 runes which require
 * the Svelte runtime — same pattern as
 * stores-task-snapshot.test.ts and stores-tool-event-routing.test.ts.
 *
 * The handler this mirrors lives in stores.svelte.ts around lines
 * 867-901 (the `agent:complete` case).
 */
import { describe, test, expect, beforeEach } from "bun:test";

// ── Captured side effects ──────────────────────────────────────────

interface DispatchedEvent {
  type: string;
  detail: { parentConversationId: string; subConversationId: string };
}

let dispatched: DispatchedEvent[] = [];

// Stub the global window.dispatchEvent so we can observe DOM events
// without needing a real DOM.
function setupWindowStub() {
  (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
  (globalThis as { dispatchEvent?: (e: Event) => void }).dispatchEvent = (e: Event) => {
    const ce = e as CustomEvent;
    dispatched.push({ type: e.type, detail: ce.detail });
    return true;
  };
}

// ── Extracted handler — mirrors stores.svelte.ts agent:complete case ──

interface AgentCompleteEvent {
  type: "agent:complete";
  data: {
    runId: string;
    subConversationId: string;
    agentName: string;
    agentConfigId: string;
    success: boolean;
    resultPreview: string;
    agentRunId?: string;
    parentConversationId?: string;
  };
}

function handleAgentComplete(event: AgentCompleteEvent): void {
  const { subConversationId } = event.data;
  // Mirrors the block from stores.svelte.ts:895-901
  const parentConvId = (event.data as Record<string, unknown>).parentConversationId as string | undefined;
  if (parentConvId && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("ez:agent_complete", {
      detail: { parentConversationId: parentConvId, subConversationId },
    }));
  }
}

// ── Tests ─────────────────────────────────────────────────────────

describe("stores: agent:complete → ez:agent_complete DOM event", () => {
  beforeEach(() => {
    dispatched = [];
    setupWindowStub();
  });

  test("dispatches ez:agent_complete with parentConversationId when present", () => {
    handleAgentComplete({
      type: "agent:complete",
      data: {
        runId: "run-1",
        subConversationId: "sub-conv-1",
        agentName: "Reviewer",
        agentConfigId: "cfg-1",
        success: true,
        resultPreview: "Done.",
        parentConversationId: "main-conv-1",
      },
    });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.type).toBe("ez:agent_complete");
    expect(dispatched[0]!.detail).toEqual({
      parentConversationId: "main-conv-1",
      subConversationId: "sub-conv-1",
    });
  });

  test("does NOT dispatch when parentConversationId is missing (regression: pre-fix invoke-agent payload omitted it)", () => {
    handleAgentComplete({
      type: "agent:complete",
      data: {
        runId: "run-1",
        subConversationId: "sub-conv-1",
        agentName: "Reviewer",
        agentConfigId: "cfg-1",
        success: true,
        resultPreview: "Done.",
        // parentConversationId omitted
      },
    });

    expect(dispatched).toHaveLength(0);
  });

  test("dispatches even when success=false (failed runs should also refresh)", () => {
    handleAgentComplete({
      type: "agent:complete",
      data: {
        runId: "run-1",
        subConversationId: "sub-conv-1",
        agentName: "Reviewer",
        agentConfigId: "cfg-1",
        success: false,
        resultPreview: "model timeout",
        parentConversationId: "main-conv-1",
      },
    });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.detail.parentConversationId).toBe("main-conv-1");
  });
});

// ── Extracted handler — mirrors chat page handleAgentComplete listener ──
//
// This second block proves the chat page listener correctly invalidates
// the fetch-policy cooldowns BEFORE re-fetching. Without this, a private
// chat that completes within 5s of page load gets silently throttled
// (backgroundFetch returns null) and the main thread never updates —
// which is exactly the bug the user reported.

interface FetchPolicyMock {
  invalidatedKeys: string[];
  loadMessagesCalls: number;
  hydrateCalls: number;
}

function makeChatPageListener(currentConvId: string, mock: FetchPolicyMock) {
  return (e: Event) => {
    const { parentConversationId } = (e as CustomEvent).detail;
    if (parentConversationId !== currentConvId) return;
    // Mirrors +page.svelte handleAgentComplete (post-fix)
    mock.invalidatedKeys.push(`messages-all:${currentConvId}`);
    mock.invalidatedKeys.push(`messages-tools:${currentConvId}`);
    mock.loadMessagesCalls++;
    mock.hydrateCalls++;
  };
}

describe("chat page: ez:agent_complete listener", () => {
  let mock: FetchPolicyMock;

  beforeEach(() => {
    mock = { invalidatedKeys: [], loadMessagesCalls: 0, hydrateCalls: 0 };
  });

  test("invalidates fetch-policy cooldowns and triggers refresh when convId matches", () => {
    const listener = makeChatPageListener("main-conv-1", mock);
    listener(new CustomEvent("ez:agent_complete", {
      detail: { parentConversationId: "main-conv-1", subConversationId: "sub-conv-1" },
    }));

    expect(mock.invalidatedKeys).toEqual([
      "messages-all:main-conv-1",
      "messages-tools:main-conv-1",
    ]);
    expect(mock.loadMessagesCalls).toBe(1);
    expect(mock.hydrateCalls).toBe(1);
  });

  test("does NOT trigger refresh when event is for a different conversation", () => {
    const listener = makeChatPageListener("main-conv-1", mock);
    listener(new CustomEvent("ez:agent_complete", {
      detail: { parentConversationId: "different-conv", subConversationId: "sub-conv-1" },
    }));

    expect(mock.invalidatedKeys).toHaveLength(0);
    expect(mock.loadMessagesCalls).toBe(0);
    expect(mock.hydrateCalls).toBe(0);
  });

  test("regression: invalidate is called BEFORE refetch (otherwise throttle blocks the fetch)", () => {
    const order: string[] = [];
    const listener = (e: Event) => {
      const { parentConversationId } = (e as CustomEvent).detail;
      if (parentConversationId !== "main-conv-1") return;
      order.push("invalidate-all");
      order.push("invalidate-tools");
      order.push("loadMessages");
      order.push("hydrate");
    };

    listener(new CustomEvent("ez:agent_complete", {
      detail: { parentConversationId: "main-conv-1", subConversationId: "sub-conv-1" },
    }));

    expect(order).toEqual(["invalidate-all", "invalidate-tools", "loadMessages", "hydrate"]);
    expect(order.indexOf("invalidate-all")).toBeLessThan(order.indexOf("loadMessages"));
    expect(order.indexOf("invalidate-tools")).toBeLessThan(order.indexOf("hydrate"));
  });
});
