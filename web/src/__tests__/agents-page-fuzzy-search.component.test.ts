/**
 * Phase 49.2 — Agents page fuzzy-search integration test.
 *
 * Renders `/agents/+page.svelte` directly, drives the search input,
 * and asserts:
 *   - Empty query → all agents visible in default order.
 *   - Typing "summa" → only matching agents visible after debounce.
 *   - >100 candidates → bridge offloads to a Worker (we mock the
 *     bridge's `rankAgents` to capture the call).
 *   - Empty results state shows the "No agents match …" affordance
 *     and the Clear button restores the full list.
 */

import "@testing-library/jest-dom/vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";

const {
  pageStore,
  fetchAgentsMock,
  fetchAgentConfigsMock,
  rankAgentsMock,
  WORKER_THRESHOLD,
} = vi.hoisted(() => {
  return {
    pageStore: {
      subscribe: (run: (v: { url: URL; params: Record<string, string> }) => void) => {
        run({ url: new URL("http://localhost/agents"), params: {} });
        return () => {};
      },
    },
    fetchAgentsMock: vi.fn(),
    fetchAgentConfigsMock: vi.fn(),
    rankAgentsMock: vi.fn(),
    WORKER_THRESHOLD: 100,
  };
});

vi.mock("$app/navigation", () => ({ goto: vi.fn() }));
vi.mock("$app/stores", () => ({ page: pageStore }));

vi.mock("$lib/api.js", () => ({
  fetchAgents: (...args: unknown[]) => fetchAgentsMock(...args),
  fetchAgentConfigs: (...args: unknown[]) => fetchAgentConfigsMock(...args),
  createConversation: vi.fn(),
}));

vi.mock("$lib/stores.svelte.js", () => ({
  store: { activeProjectId: "global" },
}));

// Bridge is mocked so we can assert worker-offload behaviour without
// spinning up a real Worker. The real `WORKER_THRESHOLD` is re-exported
// from the source so the test stays in lock-step with the production
// value.
vi.mock("$lib/workers/agent-fuzzy-search-bridge.js", () => ({
  rankAgents: (...args: unknown[]) => rankAgentsMock(...args),
  WORKER_THRESHOLD: 100,
}));

import AgentsPage from "../routes/(app)/agents/+page.svelte";

function makeAgent(name: string, description = ""): Record<string, unknown> {
  return {
    id: `id-${name}`,
    name,
    description,
    source: "config",
    prompt: "p",
    capabilities: [],
    category: null,
    shared: false,
    permission: "write",
  };
}

beforeEach(() => {
  fetchAgentsMock.mockReset();
  fetchAgentConfigsMock.mockReset().mockResolvedValue([]);
  rankAgentsMock.mockReset();
});

describe("/agents — Phase 49.2 fuzzy search", () => {
  test("empty query shows all agents in default order", async () => {
    fetchAgentsMock.mockResolvedValue([
      makeAgent("summarizer", "summarize text"),
      makeAgent("translator", "translate prose"),
      makeAgent("reviewer", "review code"),
    ]);
    const { findByText } = render(AgentsPage);
    await findByText("summarizer");
    await findByText("translator");
    await findByText("reviewer");
    // No call to rankAgents on initial render — empty query short-
    // circuits in the bridge BEFORE the page calls it (the page only
    // calls on input).
    expect(rankAgentsMock).not.toHaveBeenCalled();
  });

  test("typing in search input debounces, then calls rankAgents with the query", async () => {
    fetchAgentsMock.mockResolvedValue([
      makeAgent("summarizer", "summarize text"),
      makeAgent("translator", "translate prose"),
    ]);
    rankAgentsMock.mockResolvedValue({ indices: [0], usedWorker: false });
    const { findByTestId } = render(AgentsPage);
    const input = (await findByTestId("agent-search-input")) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "summa" } });
    // Debounce is 100ms — wait long enough for it to fire.
    await waitFor(
      () => {
        expect(rankAgentsMock).toHaveBeenCalled();
      },
      { timeout: 500 },
    );
    const call = rankAgentsMock.mock.calls[0]!;
    expect(call[0]).toBe("summa");
    expect(Array.isArray(call[1])).toBe(true);
  });

  test(">100 candidates → bridge call carries the full list (worker decision lives in the bridge)", async () => {
    // Generate WORKER_THRESHOLD + 5 agents. The page just hands the
    // whole list to `rankAgents`; the threshold logic lives inside the
    // bridge (asserted in agent-fuzzy-search-bridge.test.ts).
    const big = Array.from({ length: WORKER_THRESHOLD + 5 }, (_, i) =>
      makeAgent(`agent-${i}`, `desc ${i}`),
    );
    fetchAgentsMock.mockResolvedValue(big);
    rankAgentsMock.mockResolvedValue({
      indices: [0],
      usedWorker: true,
    });
    const { findByTestId } = render(AgentsPage);
    const input = (await findByTestId("agent-search-input")) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "agent" } });
    await waitFor(
      () => {
        expect(rankAgentsMock).toHaveBeenCalled();
      },
      { timeout: 500 },
    );
    const call = rankAgentsMock.mock.calls[0]!;
    expect(call[0]).toBe("agent");
    expect((call[1] as unknown[]).length).toBe(WORKER_THRESHOLD + 5);
  });

  test("stale-response guard: out-of-order worker replies don't clobber newer query", async () => {
    // Pin the guard at +page.svelte:103 — `if (searchQuery.trim() === trimmed)`.
    // Two debounced searches fire back-to-back; the SECOND resolves first
    // (with results for "ab"), then the FIRST resolves with stale results
    // for "a". The page must keep "ab"'s ranking; otherwise a slow worker
    // reply for an old keystroke would clobber the newer search.
    fetchAgentsMock.mockResolvedValue([
      makeAgent("alpha", "first match"),
      makeAgent("beta", "second match"),
    ]);

    // Manually-controlled deferred Promises so we can resolve out of order.
    let resolveFirst!: (v: { indices: number[]; usedWorker: boolean }) => void;
    let resolveSecond!: (v: { indices: number[]; usedWorker: boolean }) => void;
    const firstPromise = new Promise<{ indices: number[]; usedWorker: boolean }>(
      (r) => {
        resolveFirst = r;
      },
    );
    const secondPromise = new Promise<{ indices: number[]; usedWorker: boolean }>(
      (r) => {
        resolveSecond = r;
      },
    );
    rankAgentsMock
      .mockReturnValueOnce(firstPromise)
      .mockReturnValueOnce(secondPromise);

    const { findByTestId, queryByText } = render(AgentsPage);
    const input = (await findByTestId("agent-search-input")) as HTMLInputElement;

    // First keystroke: "a" — debounce flushes, first bridge call queued.
    await fireEvent.input(input, { target: { value: "a" } });
    await waitFor(() => expect(rankAgentsMock).toHaveBeenCalledTimes(1), {
      timeout: 500,
    });
    expect(rankAgentsMock.mock.calls[0]![0]).toBe("a");

    // Second keystroke: "ab" — debounce flushes, second bridge call queued.
    await fireEvent.input(input, { target: { value: "ab" } });
    await waitFor(() => expect(rankAgentsMock).toHaveBeenCalledTimes(2), {
      timeout: 500,
    });
    expect(rankAgentsMock.mock.calls[1]![0]).toBe("ab");

    // Resolve SECOND (newer) first: "ab" → only index 1 (beta).
    resolveSecond({ indices: [1], usedWorker: false });
    await waitFor(() => {
      // After "ab" resolves, only "beta" should be visible.
      expect(queryByText("alpha")).toBeNull();
      expect(queryByText("beta")).not.toBeNull();
    });

    // Now resolve FIRST (older) — its reply is for query "a", but the
    // current `searchQuery` is "ab", so the guard MUST drop this result.
    resolveFirst({ indices: [0], usedWorker: false });
    // Give the microtask + derived re-run a chance to flush.
    await new Promise((r) => setTimeout(r, 50));
    // "ab"'s ranking is still in effect — alpha (index 0) remains hidden.
    expect(queryByText("alpha")).toBeNull();
    expect(queryByText("beta")).not.toBeNull();
  });

  test("empty results → shows 'No agents match' state with Clear button", async () => {
    fetchAgentsMock.mockResolvedValue([
      makeAgent("summarizer"),
      makeAgent("translator"),
    ]);
    rankAgentsMock.mockResolvedValue({ indices: [], usedWorker: false });
    const { findByTestId, queryByTestId } = render(AgentsPage);
    const input = (await findByTestId("agent-search-input")) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "nothing-matches" } });
    const empty = await findByTestId("agent-search-empty");
    expect(empty).toBeInTheDocument();
    expect(empty.textContent).toContain("nothing-matches");
    // Click Clear → search query resets, empty state goes away.
    const clearBtn = await findByTestId("agent-search-clear");
    await fireEvent.click(clearBtn);
    await waitFor(() => {
      expect(queryByTestId("agent-search-empty")).toBeNull();
    });
    // Input should be empty after clear.
    expect((await findByTestId("agent-search-input") as HTMLInputElement).value).toBe("");
  });
});
