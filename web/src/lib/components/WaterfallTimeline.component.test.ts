/**
 * DOM tests for WaterfallTimeline.svelte.
 *
 * WHY THIS EXISTS: the component's two embedded normalizers were extracted
 * into `$lib/timeline-normalize` so the chat-graph builder could reuse them.
 * The only e2e coverage (`web/e2e/waterfall-timeline.spec.ts`) wraps every
 * assertion in `if (await obsButton.isVisible(...))`, so it can pass without
 * asserting anything — it is not a safety net for a refactor of the render
 * path. These tests pin the actual output: bar order, the synthesized
 * "Thinking" rows, the geometry written into the inline styles, the duration
 * column, and expand-on-click.
 *
 * Every expectation here was written against the PRE-extraction component and
 * must keep passing against the post-extraction one — that equivalence is the
 * point. Do not "update" a number here to match new behaviour without first
 * proving the old component produced it too.
 */

import { render, cleanup, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, afterEach } from "vitest";
import WaterfallTimeline from "./WaterfallTimeline.svelte";

afterEach(() => cleanup());

/**
 * Props MUST be nested under `props`: `events` is also a legacy
 * @testing-library/svelte component option, so the flat form is rejected as an
 * unknown option before the component ever mounts.
 */
function renderTimeline(props: Record<string, unknown>) {
  return render(WaterfallTimeline, { props });
}

const T = Date.parse("2026-07-26T12:00:00.000Z");

/** An observability row as `/api/observability/:id` returns it. */
function obsEvent(
  over: Partial<{
    id: string;
    eventType: string;
    data: Record<string, unknown>;
    durationMs: number | null;
    createdAt: number;
  }> = {},
) {
  const { createdAt = T, ...rest } = over;
  return {
    id: "evt",
    eventType: "tool_call",
    data: {},
    durationMs: null,
    ...rest,
    createdAt: new Date(createdAt).toISOString(),
  };
}

/** The label column of every row, in render order. */
function labels(container: HTMLElement): string[] {
  return [...container.querySelectorAll("span.w-24")].map((el) => el.textContent?.trim() ?? "");
}

/** The duration column of every row, in render order. */
function durations(container: HTMLElement): string[] {
  return [...container.querySelectorAll("span.w-16.text-right.font-mono")]
    .filter((el) => !el.className.includes("text-muted"))
    .map((el) => el.textContent?.trim() ?? "");
}

/** The coloured fill of every row: its inline left/width geometry. */
function geometry(container: HTMLElement): { left: string; width: string }[] {
  return [...container.querySelectorAll("div.absolute.top-0")]
    .filter((el) => !el.className.includes("bg-red-500/30"))
    .map((el) => {
      const s = (el as HTMLElement).style;
      return { left: s.left, width: s.width };
    });
}

describe("WaterfallTimeline — empty states", () => {
  test("renders the empty message with no data at all", () => {
    const { container } = renderTimeline({});
    expect(container.textContent).toContain("No tool calls recorded.");
  });

  test("renders the empty message when every event is a non-tool type", () => {
    const { container } = renderTimeline({
      events: [
        obsEvent({ id: "a", eventType: "turn_summary" }),
        obsEvent({ id: "b", eventType: "agent_call" }),
      ],
    });
    expect(container.textContent).toContain("No tool calls recorded.");
  });

  test("renders the empty message when the timeline has zero width", () => {
    // Two instantaneous calls at the same timestamp: no axis to lay out.
    const { container } = renderTimeline({
      events: [obsEvent({ id: "a", durationMs: 0 }), obsEvent({ id: "b", durationMs: 0 })],
    });
    expect(container.textContent).toContain("No tool calls recorded.");
  });
});

describe("WaterfallTimeline — observability-event source", () => {
  /** Mirrors the e2e fixture: readFile 250ms at T, writeFile 150ms at T+500. */
  const events = [
    obsEvent({
      id: "evt-1",
      durationMs: 250,
      data: {
        toolName: "readFile",
        extensionId: "fs-ext",
        input: { path: "/tmp/test" },
        output: { content: "hello" },
      },
    }),
    obsEvent({
      id: "evt-2",
      createdAt: T + 500,
      durationMs: 150,
      data: {
        toolName: "writeFile",
        extensionId: "fs-ext",
        input: { path: "/tmp/out" },
        output: { ok: true },
      },
    }),
  ];

  test("renders each tool plus a synthesized Thinking row for the gap", () => {
    const { container } = renderTimeline({ events });
    expect(labels(container)).toEqual(["readFile", "Thinking", "writeFile"]);
  });

  test("lays the bars out as percentages of the 650ms axis", () => {
    const { container } = renderTimeline({ events });
    const pct = (ms: number) => `${(ms / 650) * 100}%`;
    expect(geometry(container)).toEqual([
      { left: "0%", width: pct(250) },
      { left: pct(250), width: pct(250) },
      { left: pct(500), width: pct(150) },
    ]);
  });

  test("shows each row's duration in the duration column", () => {
    const { container } = renderTimeline({ events });
    expect(durations(container)).toEqual(["250ms", "250ms", "150ms"]);
  });

  test("a sub-100ms gap is not treated as thinking", () => {
    const { container } = renderTimeline({
      events: [
        obsEvent({ id: "a", durationMs: 100, data: { toolName: "first" } }),
        obsEvent({ id: "b", createdAt: T + 200, durationMs: 100, data: { toolName: "second" } }),
      ],
    });
    expect(labels(container)).toEqual(["first", "second"]);
  });

  test('a row with no toolName falls back to "unknown"', () => {
    const { container } = renderTimeline({
      events: [obsEvent({ id: "a", durationMs: 400 })],
    });
    expect(labels(container)).toEqual(["unknown"]);
  });

  test("a tool_error row renders the red error overlay", () => {
    const { container } = renderTimeline({
      events: [
        obsEvent({
          id: "a",
          eventType: "tool_error",
          durationMs: 400,
          data: { toolName: "bash", error: "exit 1" },
        }),
      ],
    });
    expect(container.querySelector("div.bg-red-500\\/30")).not.toBeNull();
  });

  test("events arriving out of order are sorted onto the axis", () => {
    const { container } = renderTimeline({
      events: [
        obsEvent({
          id: "late",
          createdAt: T + 500,
          durationMs: 150,
          data: { toolName: "writeFile" },
        }),
        obsEvent({ id: "early", durationMs: 250, data: { toolName: "readFile" } }),
      ],
    });
    expect(labels(container)).toEqual(["readFile", "Thinking", "writeFile"]);
  });
});

describe("WaterfallTimeline — expand on click", () => {
  const events = [
    obsEvent({
      id: "evt-1",
      durationMs: 400,
      data: {
        toolName: "searchCode",
        extensionId: "code-ext",
        input: { query: "hello" },
        output: { matches: 3 },
      },
    }),
  ];

  test("details are hidden until the row is clicked", () => {
    const { container } = renderTimeline({ events });
    expect(container.textContent).not.toContain("Input:");
  });

  test("clicking a row reveals its input, output and extension", async () => {
    const { container } = renderTimeline({ events });
    await fireEvent.click(container.querySelector("button")!);
    expect(container.textContent).toContain("Input:");
    expect(container.textContent).toContain('"query"');
    expect(container.textContent).toContain("Output:");
    expect(container.textContent).toContain('"matches"');
    expect(container.textContent).toContain("Extension: code-ext");
  });

  test("clicking the same row again collapses it", async () => {
    const { container } = renderTimeline({ events });
    const row = container.querySelector("button")!;
    await fireEvent.click(row);
    expect(container.textContent).toContain("Input:");
    await fireEvent.click(row);
    expect(container.textContent).not.toContain("Input:");
  });

  test("an expanded error row shows its message", async () => {
    const { container } = renderTimeline({
      events: [
        obsEvent({
          id: "a",
          eventType: "tool_error",
          durationMs: 400,
          data: { toolName: "bash", error: "exit 1" },
        }),
      ],
    });
    await fireEvent.click(container.querySelector("button")!);
    expect(container.textContent).toContain("Error: exit 1");
  });

  test("a Thinking row has no expandable detail", async () => {
    const { container } = renderTimeline({
      events: [
        obsEvent({ id: "a", durationMs: 250, data: { toolName: "readFile", input: { a: 1 } } }),
        obsEvent({
          id: "b",
          createdAt: T + 500,
          durationMs: 150,
          data: { toolName: "writeFile", input: { b: 2 } },
        }),
      ],
    });
    // Row index 1 is the synthesized Thinking bar.
    await fireEvent.click(container.querySelectorAll("button")[1]!);
    expect(container.textContent).not.toContain("Input:");
  });
});

describe("WaterfallTimeline — live tool-call source", () => {
  test("live calls take precedence over persisted events", () => {
    const now = Date.now();
    const { container } = renderTimeline({
      toolCalls: [
        { toolName: "liveTool", status: "complete", startedAt: now - 1_000, duration: 1_000 },
      ],
      events: [obsEvent({ id: "a", durationMs: 400, data: { toolName: "persistedTool" } })],
    });
    expect(labels(container)).toEqual(["liveTool"]);
  });

  test("a still-running call is drawn open-ended and pulses", () => {
    const now = Date.now();
    const { container } = renderTimeline({
      toolCalls: [
        { toolName: "done", status: "complete", startedAt: now - 1_000, duration: 200 },
        { toolName: "inflight", status: "running", startedAt: now - 400 },
      ],
    });
    expect(labels(container)).toEqual(["done", "Thinking", "inflight"]);
    // The running bar animates; the finished one does not.
    expect(container.querySelectorAll("div.animate-pulse")).toHaveLength(1);
  });

  test("a built-in tool's hardcoded 0 duration still renders a clickable bar", () => {
    // PRE-EXISTING BEHAVIOUR, deliberately pinned: built-in tools report
    // duration 0, and the waterfall shows "0ms" with a 0.5% minimum-width
    // bar. The extracted module reports this duration as UNKNOWN so the
    // chat graph can render an em dash instead — but the waterfall's own
    // output is unchanged. See $lib/timeline-normalize.
    const now = Date.now();
    const { container } = renderTimeline({
      toolCalls: [
        { toolName: "Read", status: "complete", startedAt: now - 1_000, duration: 0 },
        { toolName: "Write", status: "complete", startedAt: now - 500, duration: 500 },
      ],
    });
    expect(durations(container)).toEqual(["0ms", "500ms", "500ms"]);
    expect(geometry(container)[0]!.width).toBe("0.5%");
  });

  test("durations are formatted in seconds past the 1s mark", () => {
    const now = Date.now();
    const { container } = renderTimeline({
      toolCalls: [
        { toolName: "slow", status: "complete", startedAt: now - 20_000, duration: 1_500 },
        { toolName: "slower", status: "complete", startedAt: now - 10_000, duration: 12_000 },
      ],
    });
    expect(durations(container)).toEqual(["1.5s", "8.5s", "12s"]);
  });
});
