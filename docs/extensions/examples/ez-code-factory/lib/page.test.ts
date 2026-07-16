import { test, expect, describe } from "bun:test";
import {
  ACTION_BADGE,
  appendRunDetail,
  buildDashboard,
  buildRunDetail,
  normalizeRespondPayload,
  parkedStep,
  parseYoloRunId,
  SEVERITY_ICON,
  shortSha,
  STATUS_BADGE,
  STEP_STATUS_BADGE,
  type RunDetail,
} from "./page";
import { PageBuilder } from "@ezcorp/sdk/runtime";
import { emptyFindings } from "./runs";
import type { Finding, Findings, RunRecord, RunStatus, StepResultRecord, StepStatus } from "./runs";

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run_abc",
    repoId: "0123456789ab",
    branch: "feat/x",
    ref: "refs/heads/feat/x",
    headSha: "abcdef0123456789",
    baseSha: "0000000000000000",
    status: "completed",
    worktreePath: null,
    createdAt: "2026-07-15T08:00:00.000Z",
    updatedAt: "2026-07-15T08:00:05.000Z",
    parkedMs: 0,
    awaitingAgentSince: null,
    intent: null,
    intentSource: null,
    ...over,
  };
}

function stepResult(over: Partial<StepResultRecord> = {}): StepResultRecord {
  return {
    runId: "run_abc",
    step: "review",
    status: "awaiting_approval",
    findings: emptyFindings(),
    agentPid: null,
    autoFixLimit: 0,
    round: 1,
    autoFixAttempts: 0,
    executionMs: 0,
    fixSummary: null,
    ...over,
  };
}

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    severity: "error",
    file: "src/a.ts",
    line: 3,
    description: "possible null deref",
    action: "ask-user",
    source: "agent",
    userInstructions: "",
    category: "correctness",
    ...over,
  };
}

function withFindings(items: Finding[], over: Partial<Findings> = {}): Findings {
  return { ...emptyFindings(), items, ...over };
}

type Node = Record<string, unknown>;

/** All nodes (top-level + one level of section children) as a flat list. */
function flatNodes(nodes: unknown[]): Node[] {
  const out: Node[] = [];
  for (const raw of nodes) {
    const n = raw as Node;
    out.push(n);
    if (n.type === "section" && Array.isArray(n.nodes)) {
      out.push(...(n.nodes as Node[]));
    }
  }
  return out;
}

/** The first section node in a tree's top-level nodes. */
function firstSection(nodes: unknown[]): Node {
  return (nodes as Node[]).find((n) => n.type === "section")!;
}

describe("shortSha", () => {
  test("takes the first 8 chars", () => {
    expect(shortSha("abcdef0123456789")).toBe("abcdef01");
  });
});

describe("STATUS_BADGE", () => {
  test("has a badge for every run status", () => {
    const statuses: RunStatus[] = ["created", "worktree_ready", "completed", "failed"];
    for (const s of statuses) expect(STATUS_BADGE[s]).toBeTruthy();
  });
});

describe("buildDashboard", () => {
  test("renders an empty-state + zeroed stats when there are no runs", () => {
    const tree = buildDashboard([]);
    expect(tree.title).toBe("ez-code-factory");
    const nodes = tree.nodes as Array<Record<string, unknown>>;
    const stats = nodes.find((n) => n.type === "stats") as { items: Array<{ value: string }> };
    expect(stats.items[0]!.value).toBe("0");
    expect(nodes.some((n) => n.type === "empty-state")).toBe(true);
    expect(nodes.some((n) => n.type === "table")).toBe(false);
  });

  test("renders a runs table with per-status stat counts", () => {
    const tree = buildDashboard([
      run({ id: "r1", status: "completed" }),
      run({ id: "r2", status: "failed" }),
      run({ id: "r3", status: "worktree_ready" }),
      run({ id: "r4", status: "created" }),
    ]);
    const nodes = tree.nodes as Array<Record<string, unknown>>;
    const stats = nodes.find((n) => n.type === "stats") as {
      items: Array<{ label: string; value: string }>;
    };
    expect(stats.items.find((i) => i.label === "Total runs")!.value).toBe("4");
    expect(stats.items.find((i) => i.label === "Active")!.value).toBe("2");
    expect(stats.items.find((i) => i.label === "Completed")!.value).toBe("1");
    expect(stats.items.find((i) => i.label === "Failed")!.value).toBe("1");

    const table = nodes.find((n) => n.type === "table") as {
      columns: string[];
      rows: Array<{ cells: string[] }>;
    };
    expect(table.columns).toEqual(["Run", "Branch", "Head", "Status", "Updated"]);
    expect(table.rows).toHaveLength(4);
    // Head SHA is shortened; status badge is rendered; time is trimmed.
    const firstRow = table.rows[0]!.cells;
    expect(firstRow[2]).toBe("abcdef01");
    expect(firstRow[3]).toBe(STATUS_BADGE.completed);
    expect(firstRow[4]).toBe("2026-07-15 08:00");
  });
});

// ── badge / icon maps ────────────────────────────────────────────────

describe("badge + icon maps", () => {
  test("STEP_STATUS_BADGE has a badge for every step status", () => {
    const statuses: StepStatus[] = [
      "pending",
      "running",
      "fixing",
      "awaiting_approval",
      "fix_review",
      "completed",
      "skipped",
      "failed",
    ];
    for (const s of statuses) expect(STEP_STATUS_BADGE[s]).toBeTruthy();
  });

  test("SEVERITY_ICON + ACTION_BADGE cover every value", () => {
    expect(SEVERITY_ICON.error).toContain("error");
    expect(SEVERITY_ICON.warning).toContain("warning");
    expect(SEVERITY_ICON.info).toContain("info");
    expect(ACTION_BADGE["no-op"]).toBe("no-op");
    expect(ACTION_BADGE["auto-fix"]).toBe("auto-fix");
    expect(ACTION_BADGE["ask-user"]).toBe("ask-user");
  });
});

// ── parkedStep ───────────────────────────────────────────────────────

describe("parkedStep", () => {
  test("finds an awaiting_approval step", () => {
    const s = parkedStep([stepResult({ step: "intent", status: "completed" }), stepResult()]);
    expect(s?.step).toBe("review");
  });

  test("finds a fix_review step", () => {
    const s = parkedStep([stepResult({ step: "rebase", status: "fix_review" })]);
    expect(s?.status).toBe("fix_review");
  });

  test("returns undefined when nothing is parked", () => {
    expect(parkedStep([stepResult({ status: "completed" })])).toBeUndefined();
    expect(parkedStep([])).toBeUndefined();
  });
});

// ── appendRunDetail / buildRunDetail ─────────────────────────────────

describe("buildRunDetail (parked gate)", () => {
  const detail: RunDetail = {
    run: run({ id: "run-parked", status: "awaiting_approval", intent: "ship the fix" }),
    steps: [
      stepResult({ step: "intent", status: "completed", round: 1 }),
      stepResult({ step: "rebase", status: "completed", round: 1 }),
      stepResult({
        step: "review",
        status: "awaiting_approval",
        round: 2,
        fixSummary: "narrowed the query",
        findings: withFindings(
          [
            finding({ id: "f1", severity: "error", file: "src/a.ts", description: "null deref" }),
            finding({ id: "f2", severity: "warning", file: "", description: "", action: "no-op" }),
          ],
          {
            summary: "1 error, 1 warning",
            riskLevel: "medium",
            riskRationale: "touches auth",
            testingSummary: "unit only",
            tested: ["login"],
            artifacts: ["screenshot.png"],
          },
        ),
      }),
    ],
  };

  test("renders the step list, findings table, risk, log panel, and controls", () => {
    const tree = buildRunDetail(detail);
    const section = firstSection(tree.nodes);
    expect(section.title).toContain("run-parked");
    const inside = section.nodes as Node[];

    // Step list table (all 9 steps, in fixed order).
    const stepTable = inside.find(
      (n) => n.type === "table" && (n.columns as string[])[0] === "Step",
    ) as { rows: Array<{ cells: string[] }> };
    expect(stepTable.rows).toHaveLength(9);
    expect(stepTable.rows[0]!.cells[0]).toBe("intent");
    expect(stepTable.rows[2]!.cells).toEqual(["review", STEP_STATUS_BADGE.awaiting_approval, "2"]);
    // An un-run step (test) defaults to pending / round 0.
    expect(stepTable.rows[3]!.cells).toEqual(["test", STEP_STATUS_BADGE.pending, "0"]);

    // Gate heading names the parked step.
    const heading = inside.find((n) => n.type === "heading") as { text: string };
    expect(heading.text).toContain("review");

    // Risk stats line.
    const riskStats = inside.find(
      (n) => n.type === "stats" && (n.items as Array<{ label: string }>).some((i) => i.label === "Risk"),
    ) as { items: Array<{ label: string; value: string; hint?: string }> };
    const risk = riskStats.items.find((i) => i.label === "Risk")!;
    expect(risk.value).toBe("medium");
    expect(risk.hint).toBe("touches auth");

    // Findings table — severity icon, file (blank → em dash), description, action.
    const findingsTable = inside.find(
      (n) => n.type === "table" && (n.columns as string[])[0] === "Severity",
    ) as { rows: Array<{ cells: string[]; action: Record<string, unknown> }> };
    expect(findingsTable.rows).toHaveLength(2);
    expect(findingsTable.rows[0]!.cells).toEqual([
      SEVERITY_ICON.error,
      "src/a.ts",
      "null deref",
      ACTION_BADGE["ask-user"],
    ]);
    expect(findingsTable.rows[1]!.cells).toEqual([SEVERITY_ICON.warning, "—", "—", ACTION_BADGE["no-op"]]);
    // Each finding row dispatches a fix for THAT finding, with an instruction prompt.
    const rowAction = findingsTable.rows[0]!.action as {
      event: string;
      payload: Record<string, string>;
      prompt: { field: string };
    };
    expect(rowAction.event).toBe("ez-code-factory:respond");
    expect(rowAction.payload).toEqual({ runId: "run-parked", step: "review", action: "fix", findingId: "f1" });
    expect(rowAction.prompt.field).toBe("instruction");

    // Log panel carries summary / last fix / testing / tested / artifacts.
    const logTable = inside.find(
      (n) => n.type === "table" && (n.columns as string[])[0] === "Field",
    ) as { rows: Array<{ cells: string[] }> };
    const logKeys = logTable.rows.map((r) => r.cells[0]);
    expect(logKeys).toEqual(["Summary", "Last fix", "Testing", "Tested", "Artifacts"]);

    // Control buttons: approve (no confirm) / skip (confirm) / yolo (confirm) / abort (confirm).
    const buttons = inside.filter((n) => n.type === "button") as Array<{
      label: string;
      action: { event: string; payload: Record<string, string>; confirm?: string };
      style?: string;
    }>;
    const approve = buttons.find((b) => b.label === "Approve step")!;
    expect(approve.action.payload).toEqual({ runId: "run-parked", step: "review", action: "approve" });
    expect(approve.action.confirm).toBeUndefined();
    const skip = buttons.find((b) => b.label.startsWith("Skip"))!;
    expect(skip.action.payload.action).toBe("skip");
    expect(skip.action.confirm).toContain("review");
    const abort = buttons.find((b) => b.label.startsWith("Abort"))!;
    expect(abort.style).toBe("danger");
    expect(abort.action.payload.action).toBe("abort");
    const yolo = buttons.find((b) => b.label.startsWith("Yolo"))!;
    expect(yolo.action.event).toBe("ez-code-factory:yolo");
    expect(yolo.action.payload).toEqual({ runId: "run-parked", step: "review" });
    expect(yolo.action.confirm).toContain("auto-approve");

    // The intent stat hint surfaces the explicit intent.
    const statusStats = inside.find(
      (n) => n.type === "stats" && (n.items as Array<{ label: string }>).some((i) => i.label === "Intent"),
    ) as { items: Array<{ label: string; value: string; hint?: string }> };
    const intent = statusStats.items.find((i) => i.label === "Intent")!;
    expect(intent.value).toBe("explicit");
    expect(intent.hint).toBe("ship the fix");
  });

  test("a parked step with no findings renders an empty-state, no findings table", () => {
    const tree = buildRunDetail({
      run: run({ status: "awaiting_approval" }),
      steps: [stepResult({ step: "review", status: "awaiting_approval", findings: emptyFindings() })],
    });
    const inside = firstSection(tree.nodes).nodes as Node[];
    expect(inside.some((n) => n.type === "empty-state")).toBe(true);
    expect(inside.some((n) => n.type === "table" && (n.columns as string[])[0] === "Severity")).toBe(false);
    // No risk line + no log panel when the findings are empty.
    expect(inside.some((n) => n.type === "table" && (n.columns as string[])[0] === "Field")).toBe(false);
  });

  test("no explicit intent → the intent stat reads 'none' with no hint", () => {
    const tree = buildRunDetail({
      run: run({ status: "awaiting_approval", intent: null }),
      steps: [stepResult({ status: "awaiting_approval" })],
    });
    const inside = firstSection(tree.nodes).nodes as Node[];
    const statusStats = inside.find(
      (n) => n.type === "stats" && (n.items as Array<{ label: string }>).some((i) => i.label === "Intent"),
    ) as { items: Array<{ label: string; value: string; hint?: string }> };
    const intent = statusStats.items.find((i) => i.label === "Intent")!;
    expect(intent.value).toBe("none");
    expect(intent.hint).toBeUndefined();
  });
});

describe("appendRunDetail (non-parked)", () => {
  test("a run awaiting_approval but with no parked step yet shows a loading state", () => {
    const page = new PageBuilder("t");
    appendRunDetail(page, {
      run: run({ status: "awaiting_approval" }),
      steps: [stepResult({ status: "running" })],
    });
    const inside = firstSection(page.build().nodes).nodes as Node[];
    const empty = inside.find((n) => n.type === "empty-state") as { title: string };
    expect(empty.title).toContain("Loading");
    // No action controls when nothing is parked.
    expect(inside.some((n) => n.type === "button")).toBe(false);
  });

  test("a terminal run shows a 'nothing to triage' state", () => {
    const page = new PageBuilder("t");
    appendRunDetail(page, { run: run({ status: "completed" }), steps: [stepResult({ status: "completed" })] });
    const inside = firstSection(page.build().nodes).nodes as Node[];
    const empty = inside.find((n) => n.type === "empty-state") as { title: string };
    expect(empty.title).toContain("Nothing to triage");
  });
});

describe("buildDashboard with parked-run detail", () => {
  test("inlines a triage section for each parked run", () => {
    const parked = run({ id: "run-parked", status: "awaiting_approval" });
    const tree = buildDashboard(
      [parked, run({ id: "run-done", status: "completed" })],
      [{ run: parked, steps: [stepResult({ status: "awaiting_approval", findings: emptyFindings() })] }],
    );
    const sections = (tree.nodes as Node[]).filter((n) => n.type === "section");
    expect(sections).toHaveLength(1);
    expect(sections[0]!.title).toContain("run-parked");
    // The runs table still renders above the detail.
    expect(flatNodes(tree.nodes).some((n) => n.type === "table")).toBe(true);
  });

  test("no details → the runs table only (backward-compatible default arg)", () => {
    const tree = buildDashboard([run({ status: "completed" })]);
    expect((tree.nodes as Node[]).some((n) => n.type === "section")).toBe(false);
  });
});

// ── normalizeRespondPayload ──────────────────────────────────────────

describe("normalizeRespondPayload", () => {
  test("a non-object passes through untouched (parse rejects it downstream)", () => {
    expect(normalizeRespondPayload(null)).toBeNull();
    expect(normalizeRespondPayload("x")).toBe("x");
    expect(normalizeRespondPayload([1, 2])).toEqual([1, 2]);
  });

  test("folds a scalar findingId + instruction into canonical arrays/objects", () => {
    const out = normalizeRespondPayload({
      runId: "r1",
      step: "review",
      action: "fix",
      findingId: "f1",
      instruction: "prefer a guard clause",
    }) as Record<string, unknown>;
    expect(out.findingIds).toEqual(["f1"]);
    expect(out.instructions).toEqual({ f1: "prefer a guard clause" });
  });

  test("a blank/whitespace instruction is dropped (no instructions object)", () => {
    const out = normalizeRespondPayload({ runId: "r1", step: "review", action: "fix", findingId: "f1", instruction: "   " }) as Record<string, unknown>;
    expect(out.findingIds).toEqual(["f1"]);
    expect(out.instructions).toBeUndefined();
  });

  test("a whitespace-only findingId is ignored", () => {
    const out = normalizeRespondPayload({ runId: "r1", step: "review", action: "fix", findingId: "  " }) as Record<string, unknown>;
    expect(out.findingIds).toBeUndefined();
  });

  test("keys the instruction by the first canonical findingId when no scalar id is present", () => {
    const out = normalizeRespondPayload({
      runId: "r1",
      step: "review",
      action: "fix",
      findingIds: ["fA", "fB"],
      instruction: "note",
    }) as Record<string, unknown>;
    // findingIds already an array → left as-is; instruction keyed by first id.
    expect(out.findingIds).toEqual(["fA", "fB"]);
    expect(out.instructions).toEqual({ fA: "note" });
  });

  test("an instruction with no resolvable key is dropped", () => {
    const out = normalizeRespondPayload({ runId: "r1", step: "review", action: "fix", instruction: "orphan" }) as Record<string, unknown>;
    expect(out.instructions).toBeUndefined();
  });

  test("canonical harness payloads pass through (arrays/objects preserved)", () => {
    const canonical = {
      runId: "r1",
      step: "review",
      action: "fix",
      findingIds: ["f1", "f2"],
      instructions: { f1: "a" },
      addedFindings: [{ description: "x" }],
    };
    const out = normalizeRespondPayload(canonical) as Record<string, unknown>;
    expect(out.findingIds).toEqual(["f1", "f2"]);
    expect(out.instructions).toEqual({ f1: "a" });
    expect(out.addedFindings).toEqual([{ description: "x" }]);
  });

  test("a scalar findingId does NOT override an existing findingIds array", () => {
    const out = normalizeRespondPayload({
      runId: "r1",
      step: "review",
      action: "fix",
      findingId: "scalar",
      findingIds: ["canonical"],
    }) as Record<string, unknown>;
    expect(out.findingIds).toEqual(["canonical"]);
  });
});

// ── parseYoloRunId ───────────────────────────────────────────────────

describe("parseYoloRunId", () => {
  test("accepts a non-empty runId, trimmed", () => {
    expect(parseYoloRunId({ runId: "  run_1  " })).toBe("run_1");
  });

  test("rejects non-object / array / missing / non-string / blank runId", () => {
    expect(parseYoloRunId(null)).toBeNull();
    expect(parseYoloRunId("x")).toBeNull();
    expect(parseYoloRunId([1])).toBeNull();
    expect(parseYoloRunId({})).toBeNull();
    expect(parseYoloRunId({ runId: 5 })).toBeNull();
    expect(parseYoloRunId({ runId: "   " })).toBeNull();
  });
});
