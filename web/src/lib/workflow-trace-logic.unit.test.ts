/**
 * Display logic for the run trace.
 *
 * The theme of this file is the NULL/zero distinction. Every telemetry
 * column is nullable and NULL means "not measured" — a provider that
 * omitted usage, a step that ran no LLM, a model with no per-token price.
 * A formatter that rendered those as `0` would turn a gap into a
 * measurement with no way for the reader to tell, so each one is asserted
 * against BOTH null and a genuine zero.
 */
import { test, expect, describe } from "vitest";
import {
  canRetryFrom,
  COST_UNAVAILABLE_HINT,
  costCellHint,
  dagRanks,
  formatCost,
  formatDuration,
  formatTokens,
  isLiveRun,
  isTruncated,
  pauseNote,
  NOT_REPORTED,
  payloadView,
  statusLabel,
  timelineBars,
  type RunTrace,
  type TraceStep,
} from "./workflow-trace-logic";

function step(over: Partial<TraceStep> = {}): TraceStep {
  return {
    stepName: "draft",
    status: "success",
    runId: null,
    provider: null,
    model: null,
    attempt: null,
    iterations: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    durationMs: null,
    errorCode: null,
    skippedReason: null,
    resolvedInput: null,
    output: null,
    startedAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    iterationRows: [],
    ...over,
  };
}

function trace(over: Partial<RunTrace> = {}): RunTrace {
  return {
    run: {
      id: "r1",
      workflowName: "nightly",
      status: "success",
      projectId: null,
      userId: "u1",
      startedAt: "2026-07-01T00:00:00.000Z",
      finishedAt: "2026-07-01T00:00:10.000Z",
      suspendedReason: null,
      resumable: false,
      jobRef: null,
      definitionHash: null,
      definitionVersionId: null,
      runPhase: "boundary",
      idempotencyKey: null,
      result: null,
    },
    steps: [],
    totals: { inputTokens: null, outputTokens: null, durationMs: null, steps: 0 },
    ...over,
  };
}

describe("formatTokens", () => {
  test("renders a dash for NULL, and a real 0 for zero", () => {
    // The whole point. "Not reported" and "reported zero" are different
    // facts, and collapsing them loses the only signal that a provider
    // went quiet.
    expect(formatTokens(null)).toBe(NOT_REPORTED);
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(0)).not.toBe(NOT_REPORTED);
  });

  test("groups thousands so a big number stays readable", () => {
    expect(formatTokens(1234567)).toBe("1,234,567");
  });
});

describe("formatDuration", () => {
  test("renders a dash for NULL, and 0ms for a genuine zero", () => {
    expect(formatDuration(null)).toBe(NOT_REPORTED);
    expect(formatDuration(0)).toBe("0ms");
  });

  test("stays in ms below a second", () => {
    // A 40 ms transform reading "0.0s" would hide the difference
    // between fast and instant.
    expect(formatDuration(40)).toBe("40ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  test("switches to seconds, then to minutes", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(45_600)).toBe("45.6s");
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(125_000)).toBe("2m 5s");
  });
});

describe("formatCost", () => {
  test("renders a dash for NULL — 'not measured', never 'free'", () => {
    // NULL is what `stepCostUsd` returns when no cost could be MEASURED:
    // a step that ran no LLM, a provider that reported no usage, or an
    // unpriced subscription model. A "$0.0000" here would be a claim
    // that the step was measured and was free.
    expect(formatCost(null)).toBe(NOT_REPORTED);
  });

  test("a measured zero renders as a real $0.0000, distinct from the dash", () => {
    // The other side of the same coin: a PRICED model that consumed
    // nothing records "0.000000", and that zero is data. Collapsing it
    // into the dash would erase the distinction the column exists for.
    expect(formatCost("0.000000")).toBe("$0.0000");
    expect(formatCost("0.000000")).not.toBe(formatCost(null));
  });

  test("formats a real numeric cost", () => {
    // NUMERIC arrives from the driver as a string, so this must not
    // assume a number.
    expect(formatCost("0.123456")).toBe("$0.1235");
    expect(formatCost("0")).toBe("$0.0000");
  });

  test("falls back to the dash rather than rendering NaN", () => {
    expect(formatCost("not-a-number")).toBe(NOT_REPORTED);
  });
});

describe("costCellHint", () => {
  test("hints only on the dash, never on a rendered figure", () => {
    // "A dash means the cost could not be measured" hanging off a cell
    // reading $0.1235 describes a state that cell is not in. Now that
    // real costs land in this column, that is a live wrong tooltip.
    expect(costCellHint(null)).toBe(COST_UNAVAILABLE_HINT);
    expect(costCellHint("not-a-number")).toBe(COST_UNAVAILABLE_HINT);
    expect(costCellHint("0.123456")).toBeUndefined();
  });

  test("a MEASURED zero gets no hint — it is a figure, not a gap", () => {
    // The whole NULL/zero distinction, expressed in the UI: "$0.0000"
    // must not carry the "could not be measured" tooltip that NULL does.
    expect(costCellHint("0.000000")).toBeUndefined();
    expect(costCellHint("0.000000")).not.toBe(costCellHint(null));
  });
});

describe("statusLabel and isLiveRun", () => {
  test("never shows a raw enum for a known status", () => {
    expect(statusLabel("awaiting_approval")).toBe("Waiting for approval");
    expect(statusLabel("suspended")).toBe("Paused");
    expect(statusLabel("success")).toBe("Succeeded");
  });

  test("falls back to the raw value for an unknown status", () => {
    // An older or newer server must render as ITSELF, not blank.
    expect(statusLabel("teleported")).toBe("teleported");
  });

  test("a parked run counts as live, not as an ending", () => {
    // The trace must not assume a run is terminal: `suspended` and
    // `awaiting_approval` are both alive and answerable.
    expect(isLiveRun("suspended")).toBe(true);
    expect(isLiveRun("awaiting_approval")).toBe(true);
    expect(isLiveRun("running")).toBe(true);
    expect(isLiveRun("success")).toBe(false);
    expect(isLiveRun("error")).toBe(false);
    expect(isLiveRun("cancelled")).toBe(false);
  });
});

describe("pauseNote", () => {
  test("present tense only while the run is actually parked", () => {
    expect(pauseNote({ status: "suspended", suspendedReason: "approval" })).toBe(
      "paused: approval",
    );
  });

  test("past tense once the run has moved on", () => {
    // `suspended_reason` survives a resume by design — it is history,
    // not current state. Rendering it unconditionally in the present
    // tense labelled a SUCCEEDED run "paused: approval", which reads as
    // a live claim about a run that ended.
    expect(pauseNote({ status: "success", suspendedReason: "approval" })).toBe(
      "was paused: approval",
    );
    expect(pauseNote({ status: "error", suspendedReason: "orphaned-resumable" })).toBe(
      "was paused: orphaned-resumable",
    );
  });

  test("nothing to say for a run that never parked", () => {
    // null, not "", so the template renders no empty element.
    expect(pauseNote({ status: "success", suspendedReason: null })).toBeNull();
    expect(pauseNote({ status: "running", suspendedReason: null })).toBeNull();
  });
});

describe("canRetryFrom", () => {
  test("offered on a suspended run", () => {
    const failing = step({ status: "error" });
    expect(canRetryFrom({ status: "suspended" }, failing)).toBe(true);
    // Already being driven — retrying would execute a batch twice.
    expect(canRetryFrom({ status: "running" }, failing)).toBe(false);
    // Terminal: no cursor to resume from.
    for (const status of ["success", "error", "cancelled"]) {
      expect(canRetryFrom({ status }, failing)).toBe(false);
    }
  });

  test("an APPROVAL-parked run gets the button — the population it exists for", () => {
    // The regression this pins. A deliberate park leaves `resumable` at
    // its `false` default, because that column is the crash-sweep's
    // verdict and `suspendWorkflowRun` pointedly does not set it. An
    // earlier version of this predicate required `resumable`, which hid
    // the button on every approval-parked run — the same mistake
    // `listClaimableWorkflowRuns` warns against in its own docblock.
    //
    // Passing the real shape of a parked row, `resumable: false`
    // included, so a re-added check fails here rather than in
    // production. The extra key is deliberate: the signature takes only
    // `status`, so this also asserts the predicate ignores it.
    const parked = { status: "suspended", resumable: false };
    expect(canRetryFrom(parked, step({ status: "awaiting_approval" }))).toBe(true);
    expect(canRetryFrom(parked, step({ status: "suspended" }))).toBe(true);
    expect(canRetryFrom(parked, step({ status: "error" }))).toBe(true);
  });

  test("matches resumeParkedRun's own gate, which never reads resumable", () => {
    // A UI predicate stricter than the mechanism it drives is a button
    // that lies about what the platform can do. `resumeParkedRun`
    // refuses anything not `suspended` and consults nothing else, so
    // these two must agree exactly.
    // Bound to a variable, not passed inline: the parameter is
    // `Pick<…, "status">`, so an object LITERAL carrying `resumable`
    // is an excess-property error — which is itself the guarantee
    // (the type now makes consulting it impossible). Widening through
    // a variable still hands the field over at runtime, so this
    // asserts the predicate ignores a value it is given.
    for (const resumable of [true, false]) {
      const parked = { status: "suspended", resumable };
      const failed = { status: "error", resumable };
      expect(canRetryFrom(parked, step({ status: "error" }))).toBe(true);
      expect(canRetryFrom(failed, step({ status: "error" }))).toBe(false);
    }
  });

  test("never offered on a step that already succeeded", () => {
    // A resume serves a completed step from its persisted output rather
    // than re-running it, so the button would be a lie.
    expect(canRetryFrom({ status: "suspended" }, step({ status: "success" }))).toBe(false);
    expect(canRetryFrom({ status: "suspended" }, step({ status: "awaiting_approval" }))).toBe(true);
  });
});

describe("payloadView", () => {
  test("absent for null and undefined", () => {
    expect(payloadView(null)).toEqual({ kind: "absent" });
    expect(payloadView(undefined)).toEqual({ kind: "absent" });
  });

  test("recognizes the truncation sentinel and carries its size", () => {
    expect(payloadView({ __truncated: true, bytes: 70011 })).toEqual({
      kind: "truncated",
      bytes: 70011,
    });
  });

  test("a payload that MENTIONS truncation is still a payload", () => {
    // The tagged union exists so this cannot be confused with the
    // sentinel — a step whose output discusses truncation must render
    // as content, not as a "too large" notice.
    const view = payloadView({ note: "__truncated was mentioned here" });
    expect(view.kind).toBe("json");
    expect((view as { text: string }).text).toContain("__truncated was mentioned");
  });

  test("pretty-prints real content", () => {
    const view = payloadView({ token: "[REDACTED]", repo: "ezcorp/harness" });
    expect(view.kind).toBe("json");
    expect((view as { text: string }).text).toContain('"token": "[REDACTED]"');
    // Indented, because an operator reads this by eye.
    expect((view as { text: string }).text).toContain("\n");
  });

  test("isTruncated rejects everything that is not the sentinel", () => {
    expect(isTruncated({ __truncated: true, bytes: 1 })).toBe(true);
    expect(isTruncated({ __truncated: false, bytes: 1 })).toBe(false);
    expect(isTruncated(null)).toBe(false);
    expect(isTruncated("__truncated")).toBe(false);
    expect(isTruncated({ success: true })).toBe(false);
  });
});

describe("timelineBars", () => {
  test("places each step by offset and width against the run's span", () => {
    const t = trace({
      steps: [
        step({ stepName: "a", startedAt: "2026-07-01T00:00:00.000Z", durationMs: 2000 }),
        step({ stepName: "b", startedAt: "2026-07-01T00:00:05.000Z", durationMs: 5000 }),
      ],
    });
    const bars = timelineBars(t);
    expect(bars[0]!.offsetPct).toBe(0);
    expect(bars[0]!.widthPct).toBeCloseTo(20, 1);
    expect(bars[1]!.offsetPct).toBeCloseTo(50, 1);
    expect(bars[1]!.widthPct).toBeCloseTo(50, 1);
  });

  test("an unmeasured step still gets a visible sliver", () => {
    // Floored rather than zero-width, so a step with no duration is not
    // silently absent from the timeline.
    const t = trace({
      steps: [step({ stepName: "a", durationMs: null })],
    });
    expect(timelineBars(t)[0]!.widthPct).toBeGreaterThan(0);
  });

  test("a run whose steps all landed in one millisecond does not divide by zero", () => {
    // Every test fixture, and any all-transform workflow.
    const t = trace({
      run: {
        ...trace().run,
        startedAt: "2026-07-01T00:00:00.000Z",
        finishedAt: "2026-07-01T00:00:00.000Z",
      },
      steps: [step({ stepName: "a", durationMs: 0 }), step({ stepName: "b", durationMs: 0 })],
    });
    const bars = timelineBars(t);
    expect(bars).toHaveLength(2);
    for (const bar of bars) {
      expect(Number.isFinite(bar.offsetPct)).toBe(true);
      expect(Number.isFinite(bar.widthPct)).toBe(true);
    }
  });

  test("a bar never runs off the right edge", () => {
    const t = trace({
      steps: [step({ stepName: "a", startedAt: "2026-07-01T00:00:09.000Z", durationMs: 999_999 })],
    });
    const bar = timelineBars(t)[0]!;
    expect(bar.offsetPct + bar.widthPct).toBeLessThanOrEqual(100.001);
  });

  test("an unfinished run is spanned by its last step, not by NaN", () => {
    // A running/parked run has no `finishedAt`; parsing null would give
    // NaN and every bar would vanish.
    const t = trace({
      run: { ...trace().run, status: "running", finishedAt: null },
      steps: [step({ stepName: "a", startedAt: "2026-07-01T00:00:00.000Z", durationMs: 4000 })],
    });
    const bar = timelineBars(t)[0]!;
    expect(Number.isFinite(bar.widthPct)).toBe(true);
    expect(bar.widthPct).toBeGreaterThan(0);
  });
});

describe("dagRanks", () => {
  test("steps that started at the same instant share a rank", () => {
    // The executor dispatches a batch with `Promise.all`, so same-instant
    // steps ran concurrently and must not be drawn as a chain.
    const ranks = dagRanks([
      step({ stepName: "a", startedAt: "2026-07-01T00:00:00.000Z" }),
      step({ stepName: "b", startedAt: "2026-07-01T00:00:01.000Z" }),
      step({ stepName: "c", startedAt: "2026-07-01T00:00:01.000Z" }),
    ]);
    expect(ranks.map((r) => r.map((s) => s.stepName))).toEqual([["a"], ["b", "c"]]);
  });

  test("ranks are ordered oldest first regardless of input order", () => {
    const ranks = dagRanks([
      step({ stepName: "late", startedAt: "2026-07-01T00:00:09.000Z" }),
      step({ stepName: "early", startedAt: "2026-07-01T00:00:00.000Z" }),
    ]);
    expect(ranks.map((r) => r[0]!.stepName)).toEqual(["early", "late"]);
  });

  test("an empty run has no ranks", () => {
    expect(dagRanks([])).toEqual([]);
  });
});
