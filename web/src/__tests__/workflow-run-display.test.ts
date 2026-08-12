/**
 * Display mappings for the workflow detail page. These exist as a tested
 * module precisely because they silently drifted: adding the `tool` step
 * kind and the `awaiting_approval` run status server-side left the page
 * rendering a blank kind badge and swallowing the one message that tells
 * an operator what to approve.
 */
import { describe, test, expect } from "bun:test";
import {
  isExplainableStatus,
  kindLabel,
  runErrorText,
  runOutput,
  statusColor,
} from "../lib/workflow-run-display";

describe("kindLabel", () => {
  test("labels every step kind the server can emit", () => {
    expect(kindLabel("agent")).toBe("agent");
    expect(kindLabel("transform")).toBe("transform");
    expect(kindLabel("gate")).toBe("gate");
    expect(kindLabel("tool")).toBe("tool");
  });

  test("an unknown kind falls back to the raw value, never a blank badge", () => {
    // The previous bare `Record` lookup returned undefined for `tool`,
    // which Svelte rendered as an empty chip.
    expect(kindLabel("something-new")).toBe("something-new");
    expect(kindLabel("something-new")).not.toBe("");
  });
});

describe("statusColor", () => {
  test("distinguishes awaiting_approval from success, error and running", () => {
    const awaiting = statusColor("awaiting_approval");
    expect(awaiting).not.toBe(statusColor("success"));
    expect(awaiting).not.toBe(statusColor("error"));
    expect(awaiting).not.toBe(statusColor("running"));
  });

  test("known statuses map to their own colours", () => {
    expect(statusColor("success")).toBe("text-green-400");
    expect(statusColor("error")).toBe("text-red-400");
    expect(statusColor("cancelled")).toBe("text-[var(--color-text-muted)]");
  });

  test("an unknown status reads as in-progress rather than blank", () => {
    expect(statusColor("running")).toBe("text-yellow-400");
    expect(statusColor("brand-new-status")).toBe("text-yellow-400");
  });
});

describe("isExplainableStatus", () => {
  test("a finished-fine or still-going run has nothing to explain", () => {
    expect(isExplainableStatus("success")).toBe(false);
    expect(isExplainableStatus("running")).toBe(false);
    expect(isExplainableStatus("idle")).toBe(false);
  });

  test("every non-success terminal status does", () => {
    expect(isExplainableStatus("error")).toBe(true);
    expect(isExplainableStatus("cancelled")).toBe(true);
    expect(isExplainableStatus("awaiting_approval")).toBe(true);
  });
});

describe("runErrorText", () => {
  test("surfaces the approval message for an awaiting_approval run", () => {
    // The regression: this returned "" because the old guard only
    // matched `error` and `cancelled`, hiding the single most
    // actionable string on the page.
    const text = runErrorText({
      status: "awaiting_approval",
      result: {
        success: false,
        output: null,
        error: {
          code: "awaiting_approval",
          message:
            'Step "install" requires interactive approval for capability fs.write and cannot run in a workflow',
        },
      },
    });
    expect(text).toContain('Step "install"');
    expect(text).toContain("requires interactive approval");
  });

  test("renders a plain-string error (gate / loop failures)", () => {
    expect(
      runErrorText({
        status: "error",
        result: { success: false, output: null, error: 'Gate "check" failed: x is not truthy' },
      }),
    ).toBe('Gate "check" failed: x is not truthy');
  });

  test("renders a {code,message} error (cancellation)", () => {
    expect(
      runErrorText({
        status: "cancelled",
        result: {
          success: false,
          output: null,
          error: { code: "cancelled", message: "workflow cancelled" },
        },
      }),
    ).toBe("workflow cancelled");
  });

  test("renders nothing for a successful run", () => {
    expect(runErrorText({ status: "success", result: { success: true, output: "ok" } })).toBe("");
  });

  test("renders nothing for a run still in progress", () => {
    expect(runErrorText({ status: "running" })).toBe("");
  });

  test("tolerates a failed run with no usable error payload", () => {
    expect(runErrorText({ status: "error" })).toBe("");
    expect(runErrorText({ status: "error", result: { success: false, output: null } })).toBe("");
    expect(
      runErrorText({
        status: "error",
        result: { success: false, output: null, error: {} as never },
      }),
    ).toBe("");
  });

  test("reads an UNTYPED result, so the trace page shares this reader", () => {
    // The run trace types `result` as `unknown` (it comes straight off the
    // API), the workflow page holds a typed SSE `WorkflowRun`. Both must go
    // through this function — two readers of the same column drift, and the
    // one that drifted last time swallowed the approval message entirely.
    const fromTheWire: unknown = { success: false, output: null, error: "boom" };
    expect(runErrorText({ status: "error", result: fromTheWire })).toBe("boom");
  });

  test("a result that is not an object has no error to read", () => {
    expect(runErrorText({ status: "error", result: "a bare string" })).toBe("");
    expect(runErrorText({ status: "error", result: null })).toBe("");
  });
});

describe("runOutput", () => {
  test("unwraps the AgentResult to the value a person came to read", () => {
    // `success` is already on screen as the status and `error` has its own
    // line, so returning the wrapper would bury a one-line answer under two
    // fields the page has already rendered.
    expect(runOutput({ success: true, output: "published" })).toBe("published");
    expect(runOutput({ success: true, output: { id: 7 } })).toEqual({ id: 7 });
  });

  test("a FAILED run's output still surfaces", () => {
    // Load-bearing: an `awaiting_approval` or `suspended` run records the
    // last successful result on purpose — that handoff payload is what
    // makes a parked run actionable. Gating on `success` would hide it from
    // exactly the runs that need it.
    expect(
      runOutput({
        success: false,
        output: { draftId: "d-1" },
        error: { code: "awaiting_approval", message: "needs a human" },
      }),
    ).toEqual({ draftId: "d-1" });
  });

  test("a recorded null output is preserved, not turned into 'absent'", () => {
    // `{ output: null }` is what a graph whose last step produced nothing
    // records. It is a measurement; the caller renders it as such.
    expect(runOutput({ success: true, output: null })).toBeNull();
  });

  test("a run with no result at all reports undefined", () => {
    expect(runOutput(undefined)).toBeUndefined();
    expect(runOutput(null)).toBeUndefined();
  });

  test("a result that is not the expected wrapper is returned WHOLE", () => {
    // Showing something unexpected beats showing "not recorded" over a
    // value that plainly exists.
    expect(runOutput("just a string")).toBe("just a string");
    expect(runOutput({ note: "no output key" })).toEqual({ note: "no output key" });
  });
});
