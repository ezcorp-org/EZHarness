/**
 * Component test for `attachTaskHydration` — the `$effect` wiring the plain
 * suite (`task-hydrate.test.ts`) can't reach, since `$effect` only runs
 * inside a real rune scope.
 *
 * This is the half that decides WHEN to reload the persisted task snapshot,
 * and it is the direct fix for the reported bug: the panel used to render
 * only from live `task:snapshot` events, so a refresh or a second tab showed
 * nothing at all. Covered here:
 *
 *   1. it hydrates on mount (refresh / new tab)
 *   2. it re-hydrates when the conversation changes, and never lets the old
 *      conversation's in-flight response land on the new one
 *   3. it re-hydrates on SSE reconnect and on a store resync request
 *   4. it does NOT loop — the effect writes the state it would otherwise
 *      depend on, so a missing `untrack` here is an infinite fetch storm
 */
import { render } from "@testing-library/svelte";
import { describe, test, expect, beforeEach, vi } from "vitest";

// The counters `attachTaskHydration` reads must be TRACKED reads, otherwise
// the reconnect / resync effects are inert and the tests below would pass
// without covering anything.
vi.mock("$lib/stores.svelte.js", async () => {
  const { hydrationStub } = await import("./task-hydrate-stub.svelte.js");
  return {
    getWsReconnectCount: () => hydrationStub.reconnects,
    taskHydrationRequests: () => hydrationStub.requests,
    getTaskSeq: () => 0,
    hydrateTaskSnapshotInto: () => {},
  };
});

const { hydrationStub, resetHydrationStub } = await import("./task-hydrate-stub.svelte.js");
const Harness = (await import("./TaskHydrateHarness.svelte")).default;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Let the effects' async fetch continuations settle. */
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetHydrationStub();
  fetchMock = vi.fn(async (url: string) =>
    jsonResponse({ conversationId: url.split("/")[3], tasks: [{ id: "t1" }] }),
  );
});

describe("attachTaskHydration", () => {
  test("hydrates once on mount", async () => {
    const onapply = vi.fn();
    render(Harness, { convId: "conv-1", fetchImpl: fetchMock as never, onapply });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/conversations/conv-1/tasks");
    expect(onapply).toHaveBeenCalledTimes(1);
    expect(onapply.mock.calls[0]?.[0]).toBe("conv-1");
  });

  test("does not re-fetch on its own — the effect must not depend on its own write", async () => {
    render(Harness, { convId: "conv-1", fetchImpl: fetchMock as never, onapply: vi.fn() });
    await flush();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("skips an empty conversation id", async () => {
    render(Harness, { convId: "", fetchImpl: fetchMock as never, onapply: vi.fn() });
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("re-hydrates when the conversation changes", async () => {
    const onapply = vi.fn();
    const { rerender } = render(Harness, {
      convId: "conv-1",
      fetchImpl: fetchMock as never,
      onapply,
    });
    await flush();

    await rerender({ convId: "conv-2", fetchImpl: fetchMock as never, onapply });
    await flush();

    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "/api/conversations/conv-1/tasks",
      "/api/conversations/conv-2/tasks",
    ]);
    expect(onapply.mock.calls.map((c) => c[0])).toEqual(["conv-1", "conv-2"]);
  });

  test("drops a slow response for a conversation the user already left", async () => {
    // conv-1's request never settles until after the switch to conv-2.
    let releaseFirst: (() => void) | undefined;
    const slowFetch = vi.fn(async (url: string) => {
      if (url.includes("conv-1")) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return jsonResponse({ tasks: [{ id: url.includes("conv-1") ? "stale" : "fresh" }] });
    });

    const onapply = vi.fn();
    const { rerender } = render(Harness, {
      convId: "conv-1",
      fetchImpl: slowFetch as never,
      onapply,
    });
    await flush();

    await rerender({ convId: "conv-2", fetchImpl: slowFetch as never, onapply });
    await flush();

    releaseFirst?.();
    await flush();

    // Only conv-2's snapshot was written — conv-1's late response would
    // have rendered one conversation's tasks under another.
    expect(onapply.mock.calls.map((c) => c[0])).toEqual(["conv-2"]);
  });

  test("re-hydrates when the event stream reconnects", async () => {
    render(Harness, { convId: "conv-1", fetchImpl: fetchMock as never, onapply: vi.fn() });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    hydrationStub.reconnects += 1;
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("re-hydrates when the store asks for a resync", async () => {
    render(Harness, { convId: "conv-1", fetchImpl: fetchMock as never, onapply: vi.fn() });
    await flush();

    // Raised when a `task:assignment_update` arrives for a conversation
    // with no loaded snapshot — the delta would otherwise be dropped.
    hydrationStub.requests += 1;
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
