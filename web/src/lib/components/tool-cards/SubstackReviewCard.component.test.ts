/**
 * SubstackReviewCard component tests (vitest + jsdom, run from web/).
 *
 * Covers: renders list / empty / loading / error; edit updates the
 * textarea + reveals Save; Approve & Send fires approve_item +
 * send_approved (mocked /api/tool-invoke) and flips the row to sent;
 * a pacing-deferred send keeps the row approved + surfaces the notice;
 * Reject requires two clicks (inline confirm) and the confirm resets
 * after the 3s timeout; a failed action surfaces the error banner.
 */
import { render, fireEvent, cleanup, waitFor } from "@testing-library/svelte";
import { describe, test, expect, afterEach, vi } from "vitest";
import SubstackReviewCard from "./SubstackReviewCard.svelte";
import type { ToolCallState } from "$lib/stores.svelte.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

interface QueueItem {
  id: string;
  kind: "reply" | "welcome-dm" | "note-comment";
  status: string;
  target_ref: string;
  context: string;
  draft_body: string;
  due_at: number | null;
  error?: string;
}

function payload(pending: QueueItem[], approved: QueueItem[] = []): string {
  return JSON.stringify({
    cardType: "substack-review",
    pending,
    approved,
    counts: { pending: pending.length, approved: approved.length },
  });
}

function makeCall(overrides: Partial<ToolCallState> = {}): ToolCallState {
  return {
    id: "tc-review-1",
    toolName: "substack-engagement__open_review_queue",
    status: "complete",
    input: {},
    output: payload([
      {
        id: "q-1",
        kind: "reply",
        status: "pending",
        target_ref: "c-1",
        context: "great post!",
        draft_body: "thanks — what hooked you?",
        due_at: null,
      },
    ]),
    startedAt: Date.now(),
    duration: 50,
    extensionId: "substack-engagement",
    cardType: "substack-review",
    ...overrides,
  };
}

// Mock /api/tool-invoke. `behavior` lets a test shape per-tool responses.
function stubFetch(
  behavior?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => {
    ok?: boolean;
    success?: boolean;
    output?: string;
    error?: string;
    status?: number;
  },
) {
  const calls: Array<{ toolName: string; input: Record<string, unknown> }> = [];
  const spy = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      toolName: string;
      input: Record<string, unknown>;
    };
    calls.push({ toolName: body.toolName, input: body.input });
    const r = behavior?.(body.toolName, body.input) ?? {};
    const status = r.status ?? (r.ok === false ? 500 : 200);
    return new Response(
      JSON.stringify({ success: r.success ?? true, output: r.output ?? "{}", error: r.error }),
      { status, headers: { "Content-Type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", spy);
  return { calls, spy };
}

describe("SubstackReviewCard — render states", () => {
  test("renders one row per queued item with kind + context + body", () => {
    stubFetch();
    const { getByTestId, getAllByTestId } = render(SubstackReviewCard, {
      toolCall: makeCall(),
      conversationId: "conv-1",
    });
    expect(getByTestId("substack-review-card")).toBeInTheDocument();
    const rows = getAllByTestId("review-row");
    expect(rows).toHaveLength(1);
    expect(getByTestId("review-kind").textContent).toContain("Comment reply");
    expect(getByTestId("review-context").textContent).toContain("great post!");
    expect((getByTestId("review-body") as HTMLTextAreaElement).value).toBe(
      "thanks — what hooked you?",
    );
    expect(getByTestId("review-counts").textContent).toContain("1 pending");
  });

  test("renders pending + approved buckets together", () => {
    stubFetch();
    const { getAllByTestId, getByTestId } = render(SubstackReviewCard, {
      toolCall: makeCall({
        output: payload(
          [
            {
              id: "q-1",
              kind: "reply",
              status: "pending",
              target_ref: "c-1",
              context: "ctx",
              draft_body: "b1",
              due_at: null,
            },
          ],
          [
            {
              id: "q-2",
              kind: "note-comment",
              status: "approved",
              target_ref: "n-1",
              context: "note",
              draft_body: "b2",
              due_at: null,
            },
          ],
        ),
      }),
      conversationId: "conv-1",
    });
    expect(getAllByTestId("review-row")).toHaveLength(2);
    expect(getByTestId("review-counts").textContent).toContain("1 pending");
    expect(getByTestId("review-counts").textContent).toContain("1 approved");
  });

  test("empty state when the queue has no pending/approved items", () => {
    stubFetch();
    const { getByTestId, queryByTestId } = render(SubstackReviewCard, {
      toolCall: makeCall({ output: payload([]) }),
      conversationId: "conv-1",
    });
    expect(getByTestId("review-empty")).toBeInTheDocument();
    expect(queryByTestId("review-list")).toBeNull();
  });

  test("loading state while the tool call is running", () => {
    stubFetch();
    const { getByTestId } = render(SubstackReviewCard, {
      toolCall: makeCall({ status: "running", output: undefined }),
      conversationId: "conv-1",
    });
    expect(getByTestId("review-loading")).toBeInTheDocument();
  });

  test("error state when the tool call errored", () => {
    stubFetch();
    const { getByTestId } = render(SubstackReviewCard, {
      toolCall: makeCall({ status: "error", error: "queue read failed", output: undefined }),
      conversationId: "conv-1",
    });
    expect(getByTestId("review-error").textContent).toContain("queue read failed");
  });

  test("malformed output degrades to the empty state (no throw)", () => {
    stubFetch();
    const { getByTestId } = render(SubstackReviewCard, {
      toolCall: makeCall({ output: "not json {" }),
      conversationId: "conv-1",
    });
    expect(getByTestId("review-empty")).toBeInTheDocument();
  });
});

describe("SubstackReviewCard — edit", () => {
  test("editing the textarea reveals Save and tracks the dirty value", async () => {
    stubFetch();
    const { getByTestId, queryByTestId } = render(SubstackReviewCard, {
      toolCall: makeCall(),
      conversationId: "conv-1",
    });
    expect(queryByTestId("review-save")).toBeNull();
    const ta = getByTestId("review-body") as HTMLTextAreaElement;
    await fireEvent.input(ta, { target: { value: "edited reply" } });
    expect(getByTestId("review-save")).toBeInTheDocument();
  });

  test("Save edit invokes edit_item with the new body", async () => {
    const { calls } = stubFetch();
    const { getByTestId } = render(SubstackReviewCard, {
      toolCall: makeCall(),
      conversationId: "conv-1",
    });
    const ta = getByTestId("review-body") as HTMLTextAreaElement;
    await fireEvent.input(ta, { target: { value: "edited reply" } });
    await fireEvent.click(getByTestId("review-save"));
    await waitFor(() => expect(calls.some((c) => c.toolName === "edit_item")).toBe(true));
    const editCall = calls.find((c) => c.toolName === "edit_item")!;
    expect(editCall.input).toEqual({ id: "q-1", draft_body: "edited reply" });
  });
});

describe("SubstackReviewCard — Approve & Send", () => {
  test("fires approve_item then send_approved and flips the row to sent", async () => {
    const { calls } = stubFetch((tool) =>
      tool === "send_approved" ? { output: JSON.stringify({ sent: 1, deferred: 0 }) } : {},
    );
    const { getByTestId } = render(SubstackReviewCard, {
      toolCall: makeCall(),
      conversationId: "conv-1",
    });
    await fireEvent.click(getByTestId("review-approve-send"));
    await waitFor(() => expect(calls.some((c) => c.toolName === "send_approved")).toBe(true));
    expect(calls.map((c) => c.toolName)).toEqual(["approve_item", "send_approved"]);
    await waitFor(() => expect(getByTestId("review-row").getAttribute("data-status")).toBe("sent"));
  });

  test("persists a pending edit before sending (edit_item → approve → send)", async () => {
    const { calls } = stubFetch((tool) =>
      tool === "send_approved" ? { output: JSON.stringify({ sent: 1 }) } : {},
    );
    const { getByTestId } = render(SubstackReviewCard, {
      toolCall: makeCall(),
      conversationId: "conv-1",
    });
    await fireEvent.input(getByTestId("review-body"), { target: { value: "final body" } });
    await fireEvent.click(getByTestId("review-approve-send"));
    await waitFor(() => expect(calls.some((c) => c.toolName === "send_approved")).toBe(true));
    expect(calls.map((c) => c.toolName)).toEqual(["edit_item", "approve_item", "send_approved"]);
    expect(calls[0]?.input.draft_body).toBe("final body");
  });

  test("a pacing-deferred send keeps the row approved + shows the notice", async () => {
    stubFetch((tool) =>
      tool === "send_approved" ? { output: JSON.stringify({ sent: 0, deferred: 1 }) } : {},
    );
    const { getByTestId } = render(SubstackReviewCard, {
      toolCall: makeCall({
        output: payload([
          {
            id: "q-1",
            kind: "note-comment",
            status: "pending",
            target_ref: "n-1",
            context: "note",
            draft_body: "nice note",
            due_at: null,
          },
        ]),
      }),
      conversationId: "conv-1",
    });
    await fireEvent.click(getByTestId("review-approve-send"));
    await waitFor(() =>
      expect(getByTestId("review-action-error").textContent).toContain("deferred"),
    );
    expect(getByTestId("review-row").getAttribute("data-status")).toBe("approved");
  });

  test("a send failure surfaces the error banner + marks the row failed", async () => {
    stubFetch((tool) => (tool === "send_approved" ? { success: false, error: "401 expired" } : {}));
    const { getByTestId } = render(SubstackReviewCard, {
      toolCall: makeCall(),
      conversationId: "conv-1",
    });
    await fireEvent.click(getByTestId("review-approve-send"));
    await waitFor(() =>
      expect(getByTestId("review-action-error").textContent).toContain("401 expired"),
    );
    expect(getByTestId("review-row").getAttribute("data-status")).toBe("failed");
  });
});

describe("SubstackReviewCard — Reject (inline click-to-confirm)", () => {
  test("first click arms 'Confirm?', second click invokes reject_item", async () => {
    const { calls } = stubFetch();
    const { getByTestId } = render(SubstackReviewCard, {
      toolCall: makeCall(),
      conversationId: "conv-1",
    });
    const reject = getByTestId("review-reject");
    expect(reject.textContent).toContain("Reject");

    await fireEvent.click(reject);
    expect(reject.textContent).toContain("Confirm?");
    // One click must NOT have fired the tool yet.
    expect(calls.some((c) => c.toolName === "reject_item")).toBe(false);

    await fireEvent.click(reject);
    await waitFor(() => expect(calls.some((c) => c.toolName === "reject_item")).toBe(true));
    expect(calls.find((c) => c.toolName === "reject_item")?.input).toEqual({ id: "q-1" });
    await waitFor(() =>
      expect(getByTestId("review-row").getAttribute("data-status")).toBe("rejected"),
    );
  });

  test("confirm resets to 'Reject' after the 3s timeout", async () => {
    vi.useFakeTimers();
    stubFetch();
    const { getByTestId } = render(SubstackReviewCard, {
      toolCall: makeCall(),
      conversationId: "conv-1",
    });
    const reject = getByTestId("review-reject");
    await fireEvent.click(reject);
    expect(reject.textContent).toContain("Confirm?");
    await vi.advanceTimersByTimeAsync(3001);
    expect(reject.textContent).toContain("Reject");
    expect(reject.textContent).not.toContain("Confirm?");
  });
});
