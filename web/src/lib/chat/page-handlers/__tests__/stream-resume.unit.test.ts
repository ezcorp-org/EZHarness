/**
 * Vitest suite for the stream-resume orchestration's plain inner functions.
 *
 * Why this exists alongside the bun-leg `stream-resume.test.ts`: the merged
 * lcov that the patch-coverage gate reads is produced by the node-vitest leg,
 * and the web bun-leg's coverage is NOT merged. The bun suite stays the
 * behavioural workhorse; this one measures the same module under the leg the
 * gate actually reads. `attachStreamResume` (the `$effect` wiring) needs a
 * real rune scope and is covered by `stream-resume-attach.component.test.ts`.
 *
 * Headline regression: teardown of a finished run used to live ONLY in the
 * one-shot `runZombieCheck` timer, which swallows its errors and never
 * re-arms. When a run finished without its terminal SSE event reaching the
 * browser — a dead bus subscription, a sleeping tab, a throttled poll — the
 * chat skeleton loader spun until the user refreshed. The REPEATING staleness
 * poll now performs the same teardown.
 */
import { test, expect, describe, beforeEach, vi } from "vitest";
import type { Message } from "$lib/api.js";

const { backgroundFetchMock, stopStreamingMock, startStreamingMock, storeStub } = vi.hoisted(
  () => ({
    backgroundFetchMock: vi.fn(),
    stopStreamingMock: vi.fn(),
    startStreamingMock: vi.fn(() => true),
    storeStub: {
      connected: false,
      streamingToolCalls: {} as Record<string, Array<Record<string, unknown>>>,
    },
  }),
);

vi.mock("$lib/utils/fetch-policy.js", () => ({
  backgroundFetch: backgroundFetchMock,
  userFetch: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("$lib/stores.svelte.js", () => ({
  store: storeStub,
  startStreaming: startStreamingMock,
  stopStreaming: stopStreamingMock,
}));

const {
  RECONNECT_CHECK_COOLDOWN_MS,
  runActiveRunCheck,
  shouldFireReconnectCheck,
  pollStaleness,
  runZombieCheck,
  __resetReconnectCooldown,
} = await import("../stream-resume.svelte.js");

type StreamResumeHost = import("../stream-resume.svelte.js").StreamResumeHost;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeOptimisticMessage(
  overrides: Partial<Message> & Pick<Message, "conversationId">,
): Message {
  return {
    id: "",
    role: "user",
    content: "",
    thinkingContent: null,
    model: null,
    provider: null,
    usage: null,
    runId: null,
    parentMessageId: null,
    excluded: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Message;
}

interface HostState {
  convId: string;
  loadGeneration: number;
  initialLoadDone: boolean;
  selectedModel: { provider: string; model: string } | null;
  activeRunId: string | null;
  activeRunStartedAt: number | null;
  serverStalenessMs: number | null;
  resumedRun: boolean;
  checkingActiveRun: boolean;
  allMessages: Message[];
  activeLeafId: string | null;
  currentStreamingText: string | undefined;
  loadMessagesCalls: number;
}

function makeHost(initial: Partial<HostState> = {}) {
  const state: HostState = {
    convId: "conv-1",
    loadGeneration: 1,
    initialLoadDone: true,
    selectedModel: { provider: "anthropic", model: "claude-sonnet-5" },
    activeRunId: null,
    activeRunStartedAt: null,
    serverStalenessMs: null,
    resumedRun: false,
    checkingActiveRun: false,
    allMessages: [],
    activeLeafId: null,
    currentStreamingText: undefined,
    loadMessagesCalls: 0,
    ...initial,
  };
  const host: StreamResumeHost = {
    convId: () => state.convId,
    loadGeneration: () => state.loadGeneration,
    initialLoadDone: () => state.initialLoadDone,
    selectedModel: () => state.selectedModel,
    activeRunId: {
      get: () => state.activeRunId,
      set: (v) => {
        state.activeRunId = v;
      },
    },
    activeRunStartedAt: {
      get: () => state.activeRunStartedAt,
      set: (v) => {
        state.activeRunStartedAt = v;
      },
    },
    serverStalenessMs: {
      get: () => state.serverStalenessMs,
      set: (v) => {
        state.serverStalenessMs = v;
      },
    },
    resumedRun: {
      get: () => state.resumedRun,
      set: (v) => {
        state.resumedRun = v;
      },
    },
    checkingActiveRun: {
      get: () => state.checkingActiveRun,
      set: (v) => {
        state.checkingActiveRun = v;
      },
    },
    allMessages: {
      get: () => state.allMessages,
      set: (v) => {
        state.allMessages = v;
      },
    },
    activeLeafId: {
      get: () => state.activeLeafId,
      set: (v) => {
        state.activeLeafId = v;
      },
    },
    loadMessages: async () => {
      state.loadMessagesCalls += 1;
    },
    makeOptimisticMessage,
    currentStreamingText: () => state.currentStreamingText,
    isStreaming: () => true,
  };
  return { host, state };
}

beforeEach(() => {
  backgroundFetchMock.mockReset();
  stopStreamingMock.mockReset();
  startStreamingMock.mockReset();
  startStreamingMock.mockImplementation(() => true);
  storeStub.connected = false;
  storeStub.streamingToolCalls = {};
  __resetReconnectCooldown();
});

// ── runActiveRunCheck ────────────────────────────────────────────────────

describe("runActiveRunCheck", () => {
  test("no run in flight → no streaming attach, clears checkingActiveRun", async () => {
    backgroundFetchMock.mockResolvedValueOnce(jsonResponse({ runId: null }));
    const { host, state } = makeHost({ checkingActiveRun: true });
    await runActiveRunCheck(host, 1);
    expect(startStreamingMock).not.toHaveBeenCalled();
    expect(state.activeRunId).toBeNull();
    expect(state.checkingActiveRun).toBe(false);
  });

  test("throttled (null) response → no-op, still clears checkingActiveRun", async () => {
    backgroundFetchMock.mockResolvedValueOnce(null);
    const { host, state } = makeHost({ checkingActiveRun: true });
    await runActiveRunCheck(host, 1);
    expect(startStreamingMock).not.toHaveBeenCalled();
    expect(state.checkingActiveRun).toBe(false);
  });

  test("non-OK response → no-op", async () => {
    backgroundFetchMock.mockResolvedValueOnce(jsonResponse({}, 500));
    const { host, state } = makeHost();
    await runActiveRunCheck(host, 1);
    expect(startStreamingMock).not.toHaveBeenCalled();
    expect(state.loadMessagesCalls).toBe(0);
  });

  test("generation advanced mid-flight → discards the stale answer", async () => {
    const { host, state } = makeHost();
    backgroundFetchMock.mockImplementationOnce(async () => {
      state.loadGeneration = 2; // user switched conversations
      return jsonResponse({ runId: "run-stale", status: "running" });
    });
    await runActiveRunCheck(host, 1);
    expect(startStreamingMock).not.toHaveBeenCalled();
    expect(state.activeRunId).toBeNull();
  });

  test("status flipped to non-running → reloads messages, no attach", async () => {
    backgroundFetchMock.mockResolvedValueOnce(
      jsonResponse({ runId: "run-123", status: "completed" }),
    );
    const { host, state } = makeHost();
    await runActiveRunCheck(host, 1);
    expect(startStreamingMock).not.toHaveBeenCalled();
    expect(state.loadMessagesCalls).toBe(1);
    expect(state.activeRunId).toBeNull();
  });

  test("startStreaming refuses (run already finished) → falls back to reload", async () => {
    backgroundFetchMock.mockResolvedValueOnce(
      jsonResponse({ runId: "run-done", status: "running" }),
    );
    startStreamingMock.mockImplementationOnce(() => false);
    const { host, state } = makeHost();
    await runActiveRunCheck(host, 1);
    expect(state.loadMessagesCalls).toBe(1);
    expect(state.activeRunId).toBeNull();
  });

  test("run in flight → attaches, records metadata, pushes a placeholder", async () => {
    const startedAt = "2026-01-01T12:00:00.000Z";
    backgroundFetchMock.mockResolvedValueOnce(
      jsonResponse({
        runId: "run-abc",
        status: "running",
        startedAt,
        stalenessMs: 1234,
        partialResponse: "partial text",
      }),
    );
    const userMsg = makeOptimisticMessage({
      id: "user-1",
      conversationId: "conv-1",
      role: "user",
      content: "hi",
    });
    const { host, state } = makeHost({ allMessages: [userMsg] });
    await runActiveRunCheck(host, 1);

    expect(startStreamingMock).toHaveBeenCalledWith("run-abc", "conv-1");
    expect(state.activeRunId).toBe("run-abc");
    expect(state.resumedRun).toBe(true);
    expect(state.activeRunStartedAt).toBe(new Date(startedAt).getTime());
    expect(state.serverStalenessMs).toBe(1234);

    const placeholder = state.allMessages.find((m) => m.id === "streaming-run-abc");
    expect(placeholder?.content).toBe("partial text");
    expect(placeholder?.parentMessageId).toBe("user-1");
    expect(state.activeLeafId).toBe("streaming-run-abc");
  });

  test("missing startedAt / stalenessMs → falls back to now / null", async () => {
    backgroundFetchMock.mockResolvedValueOnce(
      jsonResponse({ runId: "run-nometa", status: "running" }),
    );
    const { host, state } = makeHost();
    await runActiveRunCheck(host, 1);
    expect(typeof state.activeRunStartedAt).toBe("number");
    expect(state.serverStalenessMs).toBeNull();
  });

  test("does NOT duplicate an existing streaming placeholder (WS reconnect mid-stream)", async () => {
    backgroundFetchMock.mockResolvedValueOnce(
      jsonResponse({ runId: "run-dup", status: "running" }),
    );
    const existing = makeOptimisticMessage({
      id: "streaming-run-dup",
      conversationId: "conv-1",
      role: "assistant",
    });
    const { host, state } = makeHost({ allMessages: [existing] });
    await runActiveRunCheck(host, 1);
    expect(state.allMessages.filter((m) => m.id === "streaming-run-dup")).toHaveLength(1);
  });

  test("restores pending permission gates, deduped by tool-call id", async () => {
    backgroundFetchMock.mockResolvedValueOnce(
      jsonResponse({
        runId: "run-perm",
        status: "running",
        pendingPermissions: [
          {
            toolCallId: "tc-1",
            toolName: "shell__exec",
            input: { cmd: "ls" },
            cardType: "shell",
            cardLayout: "dock",
            category: "shell",
          },
          { toolCallId: "tc-1", toolName: "shell__exec", input: {} },
        ],
      }),
    );
    const { host } = makeHost();
    await runActiveRunCheck(host, 1);
    const cards = storeStub.streamingToolCalls["run-perm"]!;
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: "tc-1",
      toolName: "shell__exec",
      permissionPending: true,
      cardLayout: "dock",
    });
  });

  test("cardLayout 'inline' is preserved; an unknown layout drops to undefined", async () => {
    backgroundFetchMock.mockResolvedValueOnce(
      jsonResponse({
        runId: "run-layout",
        status: "running",
        pendingPermissions: [
          { toolCallId: "tc-inline", toolName: "t", input: {}, cardLayout: "inline" },
          { toolCallId: "tc-weird", toolName: "t", input: {}, cardLayout: "sideways" },
        ],
      }),
    );
    const { host } = makeHost();
    await runActiveRunCheck(host, 1);
    const cards = storeStub.streamingToolCalls["run-layout"]!;
    expect(cards[0]!.cardLayout).toBe("inline");
    expect(cards[1]!.cardLayout).toBeUndefined();
  });

  test("restores open ask-user gates, deduped by tool-call id", async () => {
    backgroundFetchMock.mockResolvedValueOnce(
      jsonResponse({
        runId: "run-ask",
        status: "running",
        pendingAskUser: [
          { toolCallId: "ask-1", question: "Pick one", options: ["a", "b"] },
          { toolCallId: "ask-1", question: "dup", options: [] },
        ],
      }),
    );
    const { host } = makeHost();
    await runActiveRunCheck(host, 1);
    const cards = storeStub.streamingToolCalls["run-ask"]!;
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: "ask-1",
      toolName: "ask-user__ask_user_question",
      cardType: "ask-user-question",
    });
  });

  test("a network throw is swallowed and checkingActiveRun still clears", async () => {
    backgroundFetchMock.mockRejectedValueOnce(new Error("offline"));
    const { host, state } = makeHost({ checkingActiveRun: true });
    await expect(runActiveRunCheck(host, 1)).resolves.toBeUndefined();
    expect(state.checkingActiveRun).toBe(false);
  });
});

// ── shouldFireReconnectCheck ─────────────────────────────────────────────

describe("shouldFireReconnectCheck", () => {
  test("fires only on the disconnected → connected edge", () => {
    const { host } = makeHost();
    expect(shouldFireReconnectCheck(host, true, false, 0, 100_000)).toBe(true);
    // Already connected — not an edge.
    expect(shouldFireReconnectCheck(host, true, true, 0, 100_000)).toBe(false);
    // Going down is not a resume trigger.
    expect(shouldFireReconnectCheck(host, false, true, 0, 100_000)).toBe(false);
  });

  test("never fires while a run is already attached", () => {
    const { host } = makeHost({ activeRunId: "run-live" });
    expect(shouldFireReconnectCheck(host, true, false, 0, 100_000)).toBe(false);
  });

  test("never fires before the initial load settles", () => {
    const { host } = makeHost({ initialLoadDone: false });
    expect(shouldFireReconnectCheck(host, true, false, 0, 100_000)).toBe(false);
  });

  test("__resetReconnectCooldown clears one conversation or all of them", () => {
    // Both arms of the test-only reset helper — the per-conv delete and the
    // clear-everything default the suites lean on in `beforeEach`.
    expect(() => __resetReconnectCooldown("conv-1")).not.toThrow();
    expect(() => __resetReconnectCooldown()).not.toThrow();
  });

  test("throttles reconnect storms to one check per cooldown", () => {
    const { host } = makeHost();
    const last = 100_000;
    expect(
      shouldFireReconnectCheck(host, true, false, last, last + RECONNECT_CHECK_COOLDOWN_MS - 1),
    ).toBe(false);
    expect(
      shouldFireReconnectCheck(host, true, false, last, last + RECONNECT_CHECK_COOLDOWN_MS),
    ).toBe(true);
  });
});

// ── pollStaleness — the self-healing watchdog ────────────────────────────

describe("pollStaleness", () => {
  test("no-ops without an attached run", async () => {
    const { host } = makeHost({ activeRunId: null });
    await pollStaleness(host);
    expect(backgroundFetchMock).not.toHaveBeenCalled();
  });

  test("server reports NO active run → stopStreaming (the missed run:complete)", async () => {
    backgroundFetchMock.mockResolvedValueOnce(jsonResponse({ runId: null }));
    const { host } = makeHost({ activeRunId: "run-gone" });
    await pollStaleness(host);
    expect(stopStreamingMock).toHaveBeenCalledWith("run-gone");
  });

  test("a DIFFERENT run took over → stopStreaming, no staleness write", async () => {
    backgroundFetchMock.mockResolvedValueOnce(
      jsonResponse({ runId: "run-OLD", stalenessMs: 9999 }),
    );
    const { host, state } = makeHost({ activeRunId: "run-NEW" });
    await pollStaleness(host);
    expect(stopStreamingMock).toHaveBeenCalledWith("run-NEW");
    expect(state.serverStalenessMs).toBeNull();
  });

  test("explicit non-running status → stopStreaming", async () => {
    backgroundFetchMock.mockResolvedValueOnce(
      jsonResponse({ runId: "run-x", status: "success", stalenessMs: 40_000 }),
    );
    const { host } = makeHost({ activeRunId: "run-x" });
    await pollStaleness(host);
    expect(stopStreamingMock).toHaveBeenCalledWith("run-x");
  });

  test("still running → stays attached, refreshes staleness + startedAt", async () => {
    const startedAt = "2026-02-02T08:00:00.000Z";
    backgroundFetchMock.mockResolvedValueOnce(
      jsonResponse({ runId: "run-x", status: "running", stalenessMs: 42_000, startedAt }),
    );
    const { host, state } = makeHost({ activeRunId: "run-x" });
    await pollStaleness(host);
    expect(stopStreamingMock).not.toHaveBeenCalled();
    expect(state.serverStalenessMs).toBe(42_000);
    expect(state.activeRunStartedAt).toBe(new Date(startedAt).getTime());
  });

  test("does NOT overwrite an already-known startedAt", async () => {
    backgroundFetchMock.mockResolvedValueOnce(
      jsonResponse({
        runId: "run-x",
        status: "running",
        startedAt: "2099-12-31T23:59:59.000Z",
        stalenessMs: 100,
      }),
    );
    const { host, state } = makeHost({ activeRunId: "run-x", activeRunStartedAt: 12_345 });
    await pollStaleness(host);
    expect(state.activeRunStartedAt).toBe(12_345);
  });

  test("throttled (null) and non-OK responses are no-ops — the next poll retries", async () => {
    backgroundFetchMock.mockResolvedValueOnce(null);
    const { host, state } = makeHost({ activeRunId: "run-x" });
    await pollStaleness(host);
    backgroundFetchMock.mockResolvedValueOnce(jsonResponse({}, 503));
    await pollStaleness(host);
    expect(stopStreamingMock).not.toHaveBeenCalled();
    expect(state.serverStalenessMs).toBeNull();
  });

  test("a network throw is swallowed, not propagated", async () => {
    backgroundFetchMock.mockRejectedValueOnce(new Error("offline"));
    const { host, state } = makeHost({ activeRunId: "run-x" });
    await expect(pollStaleness(host)).resolves.toBeUndefined();
    expect(state.serverStalenessMs).toBeNull();
  });
});

// ── runZombieCheck ───────────────────────────────────────────────────────

describe("runZombieCheck", () => {
  test("no-ops without an attached run", async () => {
    const { host } = makeHost({ activeRunId: null });
    await runZombieCheck(host, "");
    expect(backgroundFetchMock).not.toHaveBeenCalled();
  });

  test("aborts when a token arrived since the timer was scheduled", async () => {
    const { host } = makeHost({ activeRunId: "run-x", currentStreamingText: "new" });
    await runZombieCheck(host, "old");
    expect(backgroundFetchMock).not.toHaveBeenCalled();
    expect(stopStreamingMock).not.toHaveBeenCalled();
  });

  test("server says finished → stopStreaming", async () => {
    backgroundFetchMock.mockResolvedValueOnce(
      jsonResponse({ runId: "run-x", status: "completed" }),
    );
    const { host } = makeHost({ activeRunId: "run-x", currentStreamingText: "stuck" });
    await runZombieCheck(host, "stuck");
    expect(stopStreamingMock).toHaveBeenCalledWith("run-x");
  });

  test("still running → refreshes staleness instead of tearing down", async () => {
    backgroundFetchMock.mockResolvedValueOnce(
      jsonResponse({ runId: "run-x", status: "running", stalenessMs: 31_000 }),
    );
    const { host, state } = makeHost({ activeRunId: "run-x", currentStreamingText: "stuck" });
    await runZombieCheck(host, "stuck");
    expect(stopStreamingMock).not.toHaveBeenCalled();
    expect(state.serverStalenessMs).toBe(31_000);
  });

  test("throttled (null) response is a no-op", async () => {
    backgroundFetchMock.mockResolvedValueOnce(null);
    const { host } = makeHost({ activeRunId: "run-x", currentStreamingText: "stuck" });
    await runZombieCheck(host, "stuck");
    expect(stopStreamingMock).not.toHaveBeenCalled();
  });

  test("a network throw is swallowed", async () => {
    backgroundFetchMock.mockRejectedValueOnce(new Error("offline"));
    const { host } = makeHost({ activeRunId: "run-x", currentStreamingText: "stuck" });
    await expect(runZombieCheck(host, "stuck")).resolves.toBeUndefined();
    expect(stopStreamingMock).not.toHaveBeenCalled();
  });
});
