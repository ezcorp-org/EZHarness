/**
 * Unit tests for the shared timeline normalizer.
 *
 * Two contracts are under test:
 *
 *  1. **Duration honesty.** A 0 from ANY of the three sources means "unknown",
 *     because built-in tools emit a hardcoded 0 into all of them. `durationMs`
 *     must be absent so the chat graph can render an em dash; `spanMs` still
 *     carries the layout fallback so the waterfall keeps its geometry.
 *
 *  2. **Waterfall parity.** `buildWaterfallBars` must reproduce, number for
 *     number, what the two normalizers previously embedded in
 *     `WaterfallTimeline.svelte` produced — the component was extracted, not
 *     rewritten. The two `parity` describes below pin hand-computed
 *     percentages from the pre-refactor formulas rather than re-deriving them
 *     from the new code, so a drift in the geometry fails loudly.
 */
import { describe, expect, test } from "bun:test";
import {
  buildWaterfallBars,
  normalizeObsEvents,
  normalizeToolCalls,
  resolveDurationMs,
  THINKING_GAP_MS,
  type ObsEventLike,
  type TimelineEntry,
} from "../timeline-normalize.js";

/** Build a `TimelineEntry` with only the fields a test cares about. */
function entry(over: Partial<TimelineEntry> & { startMs: number; spanMs: number }): TimelineEntry {
  return { toolName: "t", status: "complete", ...over };
}

/**
 * An obs row at `createdAt` epoch-ms, spelled as the ISO string the DB stores.
 * `createdAt` is omitted from the `Partial` before being re-added as a number —
 * intersecting it with the interface's `string` would collapse it to `never`.
 */
function obs(
  over: Omit<Partial<ObsEventLike>, "createdAt"> & { id: string; createdAt: number },
): ObsEventLike {
  return {
    eventType: "tool_call",
    data: {},
    durationMs: null,
    ...over,
    createdAt: new Date(over.createdAt).toISOString(),
  };
}

describe("resolveDurationMs — the duration-honesty rule", () => {
  test("null and undefined are unknown", () => {
    expect(resolveDurationMs(null)).toBeUndefined();
    expect(resolveDurationMs(undefined)).toBeUndefined();
  });

  test("0 is unknown, not instant — built-in tools hardcode it", () => {
    expect(resolveDurationMs(0)).toBeUndefined();
  });

  test("negative durations (clock skew) are unknown", () => {
    expect(resolveDurationMs(-1)).toBeUndefined();
  });

  test("non-finite values are unknown", () => {
    expect(resolveDurationMs(Number.NaN)).toBeUndefined();
    expect(resolveDurationMs(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  test("a positive measurement is kept verbatim", () => {
    expect(resolveDurationMs(250)).toBe(250);
    expect(resolveDurationMs(0.5)).toBe(0.5);
  });
});

describe("normalizeToolCalls — live streaming source", () => {
  test("no calls yields no entries", () => {
    expect(normalizeToolCalls([], 1_000)).toEqual([]);
  });

  test("a reported duration becomes both the truth and the geometry", () => {
    const [e] = normalizeToolCalls(
      [
        {
          id: "tc-1",
          toolName: "readFile",
          status: "complete",
          startedAt: 1_000,
          duration: 250,
          extensionId: "fs-ext",
          input: { path: "/tmp" },
          output: { ok: true },
        },
      ],
      9_999,
    );
    expect(e).toMatchObject({
      id: "tc-1",
      toolName: "readFile",
      extensionId: "fs-ext",
      status: "complete",
      startMs: 1_000,
      durationMs: 250,
      spanMs: 250,
      input: { path: "/tmp" },
      output: { ok: true },
    });
  });

  test("a built-in tool's hardcoded 0 leaves durationMs unknown but spans 0", () => {
    const [e] = normalizeToolCalls(
      [{ toolName: "Read", status: "complete", startedAt: 1_000, duration: 0 }],
      5_000,
    );
    expect(e).toBeDefined();
    expect(e).not.toHaveProperty("durationMs");
    expect(e!.spanMs).toBe(0);
  });

  test("a call with no reported duration runs open-ended to `now`", () => {
    const [e] = normalizeToolCalls(
      [{ toolName: "grep", status: "running", startedAt: 1_000 }],
      1_750,
    );
    // Still an estimate, not a measurement — the truth stays unknown.
    expect(e).not.toHaveProperty("durationMs");
    expect(e!.spanMs).toBe(750);
    expect(e!.status).toBe("running");
  });

  test("an id-less store entry omits the id key entirely", () => {
    const [e] = normalizeToolCalls(
      [{ toolName: "grep", status: "complete", startedAt: 1_000, duration: 5 }],
      2_000,
    );
    expect(e).not.toHaveProperty("id");
  });

  test("an error call carries its message through", () => {
    const [e] = normalizeToolCalls(
      [{ toolName: "bash", status: "error", startedAt: 1_000, duration: 5, error: "boom" }],
      2_000,
    );
    expect(e!.status).toBe("error");
    expect(e!.error).toBe("boom");
  });

  test("entries come out ordered by start, ties keeping input order", () => {
    const out = normalizeToolCalls(
      [
        { id: "late", toolName: "c", status: "complete", startedAt: 3_000, duration: 1 },
        { id: "tie-a", toolName: "a", status: "complete", startedAt: 1_000, duration: 1 },
        { id: "tie-b", toolName: "b", status: "complete", startedAt: 1_000, duration: 1 },
      ],
      9_999,
    );
    expect(out.map((e) => e.id)).toEqual(["tie-a", "tie-b", "late"]);
  });

  test("the input array is not mutated", () => {
    const calls = [
      { toolName: "b", status: "complete" as const, startedAt: 3_000, duration: 1 },
      { toolName: "a", status: "complete" as const, startedAt: 1_000, duration: 1 },
    ];
    normalizeToolCalls(calls, 9_999);
    expect(calls.map((c) => c.toolName)).toEqual(["b", "a"]);
  });
});

describe("normalizeObsEvents — persisted observability source", () => {
  test("no events yields no entries", () => {
    expect(normalizeObsEvents([])).toEqual([]);
  });

  test("non-tool event types are dropped", () => {
    const out = normalizeObsEvents([
      obs({ id: "a", createdAt: 1_000, eventType: "turn_summary" }),
      obs({ id: "b", createdAt: 2_000, eventType: "agent_call" }),
      obs({ id: "c", createdAt: 3_000, eventType: "run_error" }),
    ]);
    expect(out).toEqual([]);
  });

  test("tool_call maps to complete, tool_error maps to error", () => {
    const out = normalizeObsEvents([
      obs({ id: "ok", createdAt: 1_000, eventType: "tool_call", durationMs: 10 }),
      obs({
        id: "bad",
        createdAt: 2_000,
        eventType: "tool_error",
        durationMs: 20,
        data: { error: "nope" },
      }),
    ]);
    expect(out.map((e) => e.status)).toEqual(["complete", "error"]);
    expect(out[1]!.error).toBe("nope");
  });

  test("a null duration is unknown and spans 0", () => {
    const [e] = normalizeObsEvents([obs({ id: "a", createdAt: 1_000, durationMs: null })]);
    expect(e).not.toHaveProperty("durationMs");
    expect(e!.spanMs).toBe(0);
  });

  test("a 0 duration is unknown too — the collector copies the built-in 0", () => {
    const [e] = normalizeObsEvents([obs({ id: "a", createdAt: 1_000, durationMs: 0 })]);
    expect(e).not.toHaveProperty("durationMs");
    expect(e!.spanMs).toBe(0);
  });

  test("a real extension-tool duration is kept", () => {
    const [e] = normalizeObsEvents([
      obs({
        id: "a",
        createdAt: 1_000,
        durationMs: 250,
        data: { toolName: "readFile", extensionId: "fs-ext", input: { p: 1 }, output: { ok: 1 } },
      }),
    ]);
    expect(e).toMatchObject({
      id: "a",
      toolName: "readFile",
      extensionId: "fs-ext",
      durationMs: 250,
      spanMs: 250,
      input: { p: 1 },
      output: { ok: 1 },
    });
  });

  test('a row with no toolName falls back to "unknown"', () => {
    const [e] = normalizeObsEvents([obs({ id: "a", createdAt: 1_000, data: {} })]);
    expect(e!.toolName).toBe("unknown");
    expect(e!.extensionId).toBeUndefined();
  });

  test("legacy rows that stored the payload under `result` still resolve", () => {
    const [e] = normalizeObsEvents([
      obs({ id: "a", createdAt: 1_000, data: { result: { legacy: true } } }),
    ]);
    expect(e!.output).toEqual({ legacy: true });
  });

  test("entries come out ordered by createdAt", () => {
    const out = normalizeObsEvents([
      obs({ id: "second", createdAt: 2_000 }),
      obs({ id: "first", createdAt: 1_000 }),
    ]);
    expect(out.map((e) => e.id)).toEqual(["first", "second"]);
  });
});

describe("buildWaterfallBars", () => {
  test("no entries yields no bars", () => {
    expect(buildWaterfallBars([])).toEqual([]);
  });

  test("a zero-width axis yields no bars", () => {
    // Every call at the same instant with an unknown span — there are no
    // meaningful percentages to compute.
    expect(
      buildWaterfallBars([
        entry({ startMs: 1_000, spanMs: 0 }),
        entry({ startMs: 1_000, spanMs: 0 }),
      ]),
    ).toEqual([]);
  });

  test("a lone call fills the whole axis", () => {
    const bars = buildWaterfallBars([entry({ startMs: 1_000, spanMs: 200, toolName: "grep" })]);
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({
      type: "tool",
      label: "grep",
      startOffset: 0,
      width: 100,
      duration: 200,
      status: "complete",
    });
  });

  test("a gap over the threshold synthesizes a Thinking bar", () => {
    const bars = buildWaterfallBars([
      entry({ startMs: 0, spanMs: 100 }),
      entry({ startMs: 300, spanMs: 100 }),
    ]);
    expect(bars.map((b) => b.type)).toEqual(["tool", "llm", "tool"]);
    expect(bars[1]).toMatchObject({
      type: "llm",
      label: "Thinking",
      duration: 200,
      status: "complete",
      startOffset: 25,
      width: 50,
    });
  });

  test("a gap at exactly the threshold is scheduling noise, not thinking", () => {
    const bars = buildWaterfallBars([
      entry({ startMs: 0, spanMs: 100 }),
      entry({ startMs: 100 + THINKING_GAP_MS, spanMs: 100 }),
    ]);
    expect(bars.map((b) => b.type)).toEqual(["tool", "tool"]);
  });

  test("an overlapping call never produces a negative-width Thinking bar", () => {
    const bars = buildWaterfallBars([
      entry({ startMs: 0, spanMs: 1_000 }),
      entry({ startMs: 200, spanMs: 100 }),
    ]);
    expect(bars.map((b) => b.type)).toEqual(["tool", "tool"]);
  });

  test("an unknown-duration call still gets a clickable minimum width", () => {
    const bars = buildWaterfallBars([
      entry({ startMs: 0, spanMs: 0, toolName: "Read" }),
      entry({ startMs: 1_000, spanMs: 500 }),
    ]);
    // 0 / 1500 would be a 0%-wide, unclickable bar.
    expect(bars[0]!.width).toBe(0.5);
    expect(bars[0]!.duration).toBe(0);
  });

  test("per-entry detail is carried onto the bar", () => {
    const bars = buildWaterfallBars([
      entry({
        startMs: 0,
        spanMs: 500,
        toolName: "bash",
        extensionId: "sh-ext",
        status: "error",
        input: { cmd: "ls" },
        output: { code: 1 },
        error: "exit 1",
      }),
    ]);
    expect(bars[0]).toMatchObject({
      label: "bash",
      extensionId: "sh-ext",
      status: "error",
      input: { cmd: "ls" },
      output: { code: 1 },
      error: "exit 1",
    });
  });

  test("a still-running call keeps its running status", () => {
    const bars = buildWaterfallBars([entry({ startMs: 0, spanMs: 500, status: "running" })]);
    expect(bars[0]!.status).toBe("running");
  });
});

describe("parity — obs-event path reproduces the pre-refactor geometry", () => {
  // Mirrors web/e2e/waterfall-timeline.spec.ts: readFile at T for 250ms, then
  // writeFile at T+500 for 150ms. Percentages below are hand-computed from
  // the OLD computeBarsFromEvents formulas over a 650ms axis.
  const T = Date.parse("2026-07-26T12:00:00.000Z");
  const bars = buildWaterfallBars(
    normalizeObsEvents([
      obs({
        id: "evt-1",
        createdAt: T,
        durationMs: 250,
        data: { toolName: "readFile", extensionId: "fs-ext" },
      }),
      obs({
        id: "evt-2",
        createdAt: T + 500,
        durationMs: 150,
        data: { toolName: "writeFile", extensionId: "fs-ext" },
      }),
    ]),
  );

  test("emits tool, Thinking, tool", () => {
    expect(bars.map((b) => b.label)).toEqual(["readFile", "Thinking", "writeFile"]);
  });

  test("the first bar starts at 0 and spans 250/650", () => {
    expect(bars[0]!.startOffset).toBe(0);
    expect(bars[0]!.width).toBeCloseTo((250 / 650) * 100, 10);
    expect(bars[0]!.duration).toBe(250);
  });

  test("the Thinking bar fills the 250ms gap between them", () => {
    expect(bars[1]!.startOffset).toBeCloseTo((250 / 650) * 100, 10);
    expect(bars[1]!.width).toBeCloseTo((250 / 650) * 100, 10);
    expect(bars[1]!.duration).toBe(250);
  });

  test("the second bar starts at 500/650 and spans 150/650", () => {
    expect(bars[2]!.startOffset).toBeCloseTo((500 / 650) * 100, 10);
    expect(bars[2]!.width).toBeCloseTo((150 / 650) * 100, 10);
    expect(bars[2]!.duration).toBe(150);
  });
});

describe("parity — live path reproduces the pre-refactor geometry", () => {
  // One finished 200ms call, then a still-running call that started 400ms
  // after the first ended. Axis = 0 → 1000 (now).
  const bars = buildWaterfallBars(
    normalizeToolCalls(
      [
        { toolName: "readFile", status: "complete", startedAt: 1_000, duration: 200 },
        { toolName: "grep", status: "running", startedAt: 1_600 },
      ],
      2_000,
    ),
  );

  test("emits tool, Thinking, tool", () => {
    expect(bars.map((b) => b.label)).toEqual(["readFile", "Thinking", "grep"]);
  });

  test("the finished call spans 200/1000 from the origin", () => {
    expect(bars[0]!.startOffset).toBe(0);
    expect(bars[0]!.width).toBeCloseTo(20, 10);
    expect(bars[0]!.duration).toBe(200);
  });

  test("the Thinking bar covers the 400ms gap", () => {
    expect(bars[1]!.startOffset).toBeCloseTo(20, 10);
    expect(bars[1]!.width).toBeCloseTo(40, 10);
    expect(bars[1]!.duration).toBe(400);
  });

  test("the running call is drawn open-ended, out to `now`", () => {
    expect(bars[2]!.startOffset).toBeCloseTo(60, 10);
    expect(bars[2]!.width).toBeCloseTo(40, 10);
    expect(bars[2]!.duration).toBe(400);
    expect(bars[2]!.status).toBe("running");
  });
});
