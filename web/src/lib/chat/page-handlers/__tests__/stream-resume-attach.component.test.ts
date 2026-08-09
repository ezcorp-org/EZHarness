/**
 * Component test for `attachStreamResume` — the `$effect` wiring that the
 * plain-function suite (`stream-resume.unit.test.ts`) can't reach, since
 * `$effect` only runs inside a real rune scope.
 *
 * Covers the two effects it owns:
 *   1. WS-reconnect resume — a disconnected → connected transition on
 *      `store.connected` re-runs `checkActiveRun`, throttled by the module's
 *      per-conversation cooldown.
 *   2. Zombie / staleness watchdog — while a run is in flight it schedules
 *      the 10s staleness interval and the `resumedRun ? 5s : 30s` zombie
 *      timeout, and tears BOTH down when the run ends or the host unmounts.
 *
 * The watchdog is the reason the reported bug went unrecovered: with the
 * teardown living only on the one-shot zombie timer, a swallowed error left
 * the skeleton loader spinning forever. Here we assert the REPEATING timer
 * keeps firing, which is what makes recovery self-healing.
 */
import { render } from "@testing-library/svelte";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

const { backgroundFetchMock, stopStreamingMock, startStreamingMock } = vi.hoisted(() => ({
  backgroundFetchMock: vi.fn(),
  stopStreamingMock: vi.fn(),
  startStreamingMock: vi.fn(() => true),
}));

vi.mock("$lib/utils/fetch-policy.js", () => ({
  backgroundFetch: backgroundFetchMock,
  userFetch: vi.fn(),
  invalidate: vi.fn(),
}));

// The store stub is a `$state` object from a `.svelte.ts` module — the
// reconnect `$effect` reads `store.connected`, and only a TRACKED read
// re-fires it. A plain-object stub would make that effect inert.
vi.mock("$lib/stores.svelte.js", async () => {
  const { storeStub } = await import("./store-stub.svelte.js");
  return {
    store: storeStub,
    startStreaming: startStreamingMock,
    stopStreaming: stopStreamingMock,
  };
});

const { storeStub, resetStoreStub } = await import("./store-stub.svelte.js");

const {
  STALENESS_POLL_INTERVAL_MS,
  ZOMBIE_TIMEOUT_FRESH_MS,
  ZOMBIE_TIMEOUT_RESUMED_MS,
  __resetReconnectCooldown,
} = await import("../stream-resume.svelte.js");

const Harness = (await import("./StreamResumeHarness.svelte")).default;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Let queued microtasks (the effects' async fetch continuations) settle. */
async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  backgroundFetchMock.mockReset();
  backgroundFetchMock.mockResolvedValue(jsonResponse({ runId: null }));
  stopStreamingMock.mockReset();
  startStreamingMock.mockReset();
  startStreamingMock.mockImplementation(() => true);
  resetStoreStub();
  __resetReconnectCooldown();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("attachStreamResume — watchdog timers", () => {
  test("no run in flight → schedules nothing and clears the staleness slot", async () => {
    const seen: Array<number | null> = [];
    render(Harness, {
      activeRunId: null,
      isStreaming: false,
      onstate: (s: { serverStalenessMs: number | null }) => seen.push(s.serverStalenessMs),
    });
    await flush();
    backgroundFetchMock.mockClear();

    await vi.advanceTimersByTimeAsync(STALENESS_POLL_INTERVAL_MS * 3);
    await flush();
    // Neither timer exists, so the watchdog never hits the network.
    expect(backgroundFetchMock).not.toHaveBeenCalled();
    expect(seen.at(-1)).toBeNull();
  });

  test("run in flight → the staleness poll repeats on its interval", async () => {
    backgroundFetchMock.mockResolvedValue(
      jsonResponse({ runId: "run-live", status: "running", stalenessMs: 5_000 }),
    );
    const { getByTestId } = render(Harness, {
      activeRunId: "run-live",
      isStreaming: true,
    });
    await flush();
    backgroundFetchMock.mockClear();

    await vi.advanceTimersByTimeAsync(STALENESS_POLL_INTERVAL_MS);
    await flush();
    const afterFirst = backgroundFetchMock.mock.calls.length;
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    await vi.advanceTimersByTimeAsync(STALENESS_POLL_INTERVAL_MS);
    await flush();
    // REPEATING, not one-shot — this is what makes recovery self-healing.
    expect(backgroundFetchMock.mock.calls.length).toBeGreaterThan(afterFirst);
    expect(getByTestId("staleness")).toHaveTextContent("5000");
  });

  test("a run that ended silently is torn down by the repeating poll", async () => {
    backgroundFetchMock.mockResolvedValue(jsonResponse({ runId: null }));
    render(Harness, { activeRunId: "run-silent", isStreaming: true });
    await flush();

    await vi.advanceTimersByTimeAsync(STALENESS_POLL_INTERVAL_MS);
    await flush();

    expect(stopStreamingMock).toHaveBeenCalledWith("run-silent");
  });

  test("a FRESH run's zombie check waits the long timeout", async () => {
    backgroundFetchMock.mockResolvedValue(
      jsonResponse({ runId: "run-fresh", status: "running", stalenessMs: 1 }),
    );
    render(Harness, { activeRunId: "run-fresh", isStreaming: true, resumedRun: false });
    await flush();
    backgroundFetchMock.mockClear();

    await vi.advanceTimersByTimeAsync(ZOMBIE_TIMEOUT_RESUMED_MS);
    await flush();
    // Too early for the fresh-run zombie timeout; only the poll interval
    // (10s) could fire, and 5s hasn't reached it either.
    expect(backgroundFetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(ZOMBIE_TIMEOUT_FRESH_MS);
    await flush();
    expect(backgroundFetchMock).toHaveBeenCalled();
  });

  test("a RESUMED run's zombie check fires on the short timeout", async () => {
    backgroundFetchMock.mockResolvedValue(jsonResponse({ runId: null }));
    render(Harness, {
      activeRunId: "run-resumed",
      isStreaming: true,
      resumedRun: true,
      streamingText: "stuck",
    });
    await flush();

    await vi.advanceTimersByTimeAsync(ZOMBIE_TIMEOUT_RESUMED_MS);
    await flush();
    expect(stopStreamingMock).toHaveBeenCalledWith("run-resumed");
  });

  test("unmount tears both timers down — no work after the host is gone", async () => {
    backgroundFetchMock.mockResolvedValue(
      jsonResponse({ runId: "run-live", status: "running", stalenessMs: 1 }),
    );
    const { unmount } = render(Harness, { activeRunId: "run-live", isStreaming: true });
    await flush();
    unmount();
    backgroundFetchMock.mockClear();

    await vi.advanceTimersByTimeAsync(ZOMBIE_TIMEOUT_FRESH_MS * 2);
    await flush();
    expect(backgroundFetchMock).not.toHaveBeenCalled();
  });
});

describe("attachStreamResume — WS-reconnect resume", () => {
  test("a disconnected → connected transition re-checks for an active run", async () => {
    render(Harness, { activeRunId: null, isStreaming: false, now: () => 1_000_000 });
    await flush();
    backgroundFetchMock.mockClear();

    storeStub.connected = true; // the reconnect edge
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    expect(backgroundFetchMock).toHaveBeenCalled();
    const url = String(backgroundFetchMock.mock.calls[0]![1]);
    expect(url).toContain("/active-run");
  });

  test("does not re-check while a run is already attached", async () => {
    backgroundFetchMock.mockResolvedValue(
      jsonResponse({ runId: "run-live", status: "running", stalenessMs: 1 }),
    );
    render(Harness, { activeRunId: "run-live", isStreaming: true, now: () => 2_000_000 });
    await flush();
    backgroundFetchMock.mockClear();

    storeStub.connected = true;
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    // Any call here would have to come from the watchdog, which hasn't
    // reached its interval — so the reconnect path stayed quiet.
    expect(backgroundFetchMock).not.toHaveBeenCalled();
  });

  test("the manual checkActiveRun entrypoint reaches the same endpoint", async () => {
    backgroundFetchMock.mockResolvedValue(jsonResponse({ runId: null }));
    const { component } = render(Harness, { activeRunId: null, isStreaming: false });
    await flush();
    backgroundFetchMock.mockClear();

    await (component as unknown as { checkActiveRun: (g: number) => Promise<void> }).checkActiveRun(
      1,
    );
    await flush();
    expect(backgroundFetchMock).toHaveBeenCalled();
  });
});
