import { test, expect, describe } from "bun:test";
import {
  ACTION_BADGE,
  appendRunDetail,
  buildDashboard,
  buildHome,
  buildProjectDashboard,
  buildRunDetail,
  FULL_PAGE_ID,
  normalizeRespondPayload,
  parkedStep,
  parseRunIdPayload,
  runsForProject,
  SEVERITY_ICON,
  shortSha,
  STATUS_BADGE,
  STEP_STATUS_BADGE,
  type ProjectRef,
  type RunDetail,
} from "./page";
import { repoId } from "./gate";
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

/** Every node in the tree, fully recursing into nested section children (the
 *  one-level `flatNodes` above is not enough for the XSS walk below). */
function allNodes(nodes: unknown[]): Node[] {
  const out: Node[] = [];
  for (const raw of nodes) {
    const n = raw as Node;
    out.push(n);
    if (n.type === "section" && Array.isArray(n.nodes)) out.push(...allNodes(n.nodes as unknown[]));
  }
  return out;
}

/** Every raw string reachable inside a node, EXCLUDING its `nodes` child array
 *  (section children are visited independently by `allNodes`). Concatenates the
 *  verbatim values — not JSON — so quote/`<>`-escaping can never mask a match. */
function ownContent(n: Node): string {
  const collect = (v: unknown): string => {
    if (typeof v === "string") return `${v} `;
    if (Array.isArray(v)) return v.map(collect).join("");
    if (v && typeof v === "object") return Object.values(v).map(collect).join("");
    return "";
  };
  const shallow: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n)) if (k !== "nodes") shallow[k] = v;
  return collect(shallow);
}

/** Page node types whose author strings the host validator `<>`-strips +
 *  truncates (`page-schema.ts`). The ONLY page node rendered through `{@html}`
 *  (DOMPurify, NOT `<>`-stripped — `validateMarkdown`) is `markdown`, so a
 *  user/agent-derived string must never land in a `markdown` node. */
const ESCAPED_PAGE_TYPES = new Set([
  "section",
  "heading",
  "stats",
  "table",
  "button",
  "link",
  "empty-state",
]);

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
    // The label + confirm describe the M6 fix-once autopilot accurately: it
    // auto-fixes once then approves, but STOPS at an ask-user gate (it never
    // blanket-bypasses human review).
    expect(yolo.label).toContain("fix once");
    expect(yolo.action.confirm).toContain("auto-fix");
    expect(yolo.action.confirm).toContain("STOP");
    expect(yolo.action.confirm).toContain("ask-user");

    // The intent stat hint surfaces the explicit intent.
    const statusStats = inside.find(
      (n) => n.type === "stats" && (n.items as Array<{ label: string }>).some((i) => i.label === "Intent"),
    ) as { items: Array<{ label: string; value: string; hint?: string }> };
    const intent = statusStats.items.find((i) => i.label === "Intent")!;
    expect(intent.value).toBe("explicit");
    expect(intent.hint).toBe("ship the fix");
  });

  test("a CI gate adds a read-only 'Re-check PR state' reconcile button; other gates do not", () => {
    // A run parked at the CI gate (or rested at checks_passed) gets the reconcile
    // control; a review gate does not.
    const ciTree = buildRunDetail({
      run: run({ status: "checks_passed" }),
      steps: [stepResult({ step: "ci", status: "awaiting_approval", findings: emptyFindings() })],
    });
    const ciButtons = (firstSection(ciTree.nodes).nodes as Node[]).filter((n) => n.type === "button") as Array<{
      label: string;
      action: { event: string; payload: Record<string, string>; confirm?: string };
      style?: string;
    }>;
    const recheck = ciButtons.find((b) => b.label === "Re-check PR state")!;
    expect(recheck).toBeDefined();
    expect(recheck.action.event).toBe("ez-code-factory:reconcile");
    expect(recheck.action.payload).toEqual({ runId: "run_abc" });
    // Read-only → never a confirm dialog, and rendered as a secondary control.
    expect(recheck.action.confirm).toBeUndefined();
    expect(recheck.style).toBe("secondary");

    // A review gate carries NO reconcile control.
    const reviewTree = buildRunDetail({
      run: run({ status: "awaiting_approval" }),
      steps: [stepResult({ step: "review", status: "awaiting_approval", findings: emptyFindings() })],
    });
    const reviewLabels = (firstSection(reviewTree.nodes).nodes as Node[])
      .filter((n) => n.type === "button")
      .map((n) => (n as { label: string }).label);
    expect(reviewLabels).not.toContain("Re-check PR state");
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
    // appendRiskLine early-returns on empty findings → no Risk stats line at all
    // (the Status/Head/Intent stats row remains, so match the Risk label itself).
    expect(
      inside.some(
        (n) =>
          n.type === "stats" &&
          (n.items as Array<{ label: string }>).some((i) => i.label === "Risk"),
      ),
    ).toBe(false);
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

// ── XSS safety — user/agent strings never reach the {@html} sink ─────

describe("XSS safety — user/agent strings never reach the markdown ({@html}) sink", () => {
  // A payload that would execute if it ever rendered through the Hub's sole
  // {@html} node type (`markdown`). A unique sentinel keeps the substring
  // search unambiguous against the trees' static help/label text.
  const XSS = `<img src=x onerror="alert('ezcf_xss_probe')">`;

  /** A parked review run whose EVERY user/agent-derived field carries the
   *  payload: the run branch (section title) + intent (intent stat hint), the
   *  finding's file + description (findings-table cells), the step summary (log
   *  panel cell), and the risk rationale (risk stats hint). */
  const xssDetail: RunDetail = {
    run: run({ id: "run-xss", branch: `feat/${XSS}`, status: "awaiting_approval", intent: XSS }),
    steps: [
      stepResult({
        step: "review",
        status: "awaiting_approval",
        findings: withFindings([finding({ id: "f1", file: XSS, description: XSS })], {
          summary: XSS,
          riskLevel: "high",
          riskRationale: XSS,
        }),
      }),
    ],
  };

  /** Every node in the tree whose OWN content carries the payload. */
  function carriers(nodes: unknown[]): Node[] {
    return allNodes(nodes).filter((n) => ownContent(n).includes(XSS));
  }

  test("buildRunDetail routes branch/intent/file/description/summary/riskRationale only into escaped nodes", () => {
    const hit = carriers(buildRunDetail(xssDetail).nodes);
    // Guard against a vacuous pass: the payload MUST actually be present, else
    // the "only in escaped nodes" claim is trivially (and misleadingly) true.
    expect(hit.length).toBeGreaterThan(0);
    // The load-bearing invariant: NO {@html} markdown node carries the payload.
    // This flips to FAIL the instant a builder routes any of these fields
    // through `page.markdownBlock(...)` (e.g. `appendLogPanel` rendering the
    // summary, or `appendRiskLine` the rationale, as markdown).
    expect(hit.some((n) => n.type === "markdown")).toBe(false);
    // Every carrier is a host-`<>`-stripped page node type — a defence-in-depth
    // restatement of the same invariant that also catches a brand-new sink type.
    for (const n of hit) expect(ESCAPED_PAGE_TYPES.has(n.type as string)).toBe(true);
  });

  test("buildDashboard inlines the same detail; its only markdown node (static help) stays payload-free", () => {
    const tree = buildDashboard([xssDetail.run], [xssDetail]);
    const hit = carriers(tree.nodes);
    expect(hit.length).toBeGreaterThan(0);
    // Same invariant on the inlined-triage path: payload never in a markdown sink.
    expect(hit.some((n) => n.type === "markdown")).toBe(false);
    for (const n of hit) expect(ESCAPED_PAGE_TYPES.has(n.type as string)).toBe(true);
    // The dashboard DOES emit a markdown help block, so markdown nodes exist in
    // this tree — prove none of them carries the payload (the negative above is
    // real, not passing merely because the tree happens to lack markdown nodes).
    const md = allNodes(tree.nodes).filter((n) => n.type === "markdown");
    expect(md.length).toBeGreaterThan(0);
    expect(md.every((n) => !ownContent(n).includes(XSS))).toBe(true);
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

// ── parseRunIdPayload ─────────────────────────────────────────────────

describe("parseRunIdPayload", () => {
  test("accepts a non-empty runId, trimmed", () => {
    expect(parseRunIdPayload({ runId: "  run_1  " })).toBe("run_1");
  });

  test("rejects non-object / array / missing / non-string / blank runId", () => {
    expect(parseRunIdPayload(null)).toBeNull();
    expect(parseRunIdPayload("x")).toBeNull();
    expect(parseRunIdPayload([1])).toBeNull();
    expect(parseRunIdPayload({})).toBeNull();
    expect(parseRunIdPayload({ runId: 5 })).toBeNull();
    expect(parseRunIdPayload({ runId: "   " })).toBeNull();
  });
});

// ── perProject dashboard variants ────────────────────────────────────

describe("perProject dashboard variants", () => {
  const PROJECT: ProjectRef = { id: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff", name: "My App", path: "/home/dev/my-app" };
  const OTHER: ProjectRef = { id: "aaaa1111-2222-4333-8444-555566667777", name: "Other", path: "/home/dev/other" };

  /** A run belonging to a project = repoId derived from its path, exactly
   *  as the gate derives it. */
  function projectRun(project: ProjectRef, over: Partial<RunRecord> = {}): RunRecord {
    return run({ repoId: repoId(project.path), ...over });
  }

  function nodesOf(tree: { nodes: unknown[] }): Array<Record<string, unknown>> {
    return tree.nodes as Array<Record<string, unknown>>;
  }

  function tablesOf(tree: { nodes: unknown[] }) {
    return nodesOf(tree).filter((n) => n.type === "table") as Array<{
      type: string;
      columns: string[];
      rows: Array<{ cells: string[]; href?: string }>;
    }>;
  }

  test("runsForProject matches by the gate's repoId derivation only", () => {
    const mine = projectRun(PROJECT, { id: "r1" });
    const foreign = run({ id: "r2", repoId: "feedfacecafe" });
    expect(runsForProject(PROJECT, [mine, foreign]).map((r) => r.id)).toEqual(["r1"]);
    expect(runsForProject(OTHER, [mine, foreign])).toEqual([]);
  });

  test("a trailing slash on the registered project path still matches the gated root", () => {
    // The gate hashed the cwd-derived root (no trailing slash); the DB row
    // was registered with one. Without normalization every run is orphaned.
    const mine = run({ id: "r1", repoId: repoId("/home/dev/my-app") });
    const slashed: ProjectRef = { id: PROJECT.id, name: PROJECT.name, path: "/home/dev/my-app/" };
    expect(runsForProject(slashed, [mine]).map((r) => r.id)).toEqual(["r1"]);
    // Bare root stays valid (never normalized to the empty string).
    const rootProject: ProjectRef = { id: "p-root", name: "Root", path: "/" };
    expect(runsForProject(rootProject, [mine])).toEqual([]);
  });

  test("buildProjectDashboard: titled per project, filtered to its runs", () => {
    const mine = projectRun(PROJECT, { id: "r1", branch: "feat/a" });
    const foreign = run({ id: "r2", repoId: "feedfacecafe", branch: "feat/b" });
    const tree = buildProjectDashboard(PROJECT, [mine, foreign]);
    expect(tree.title).toBe("ez-code-factory — My App");
    const [table] = tablesOf(tree);
    expect(table!.rows.map((r) => r.cells[0])).toEqual(["r1"]);
  });

  test("buildProjectDashboard: empty state when the project has no runs", () => {
    const foreign = run({ id: "r2", repoId: "feedfacecafe" });
    const tree = buildProjectDashboard(PROJECT, [foreign]);
    expect(nodesOf(tree).some((n) => n.type === "empty-state")).toBe(true);
    expect(tablesOf(tree)).toHaveLength(0);
  });

  test("buildProjectDashboard: inlines ONLY this project's parked details", () => {
    const mine = projectRun(PROJECT, { id: "r1", status: "awaiting_approval" });
    const foreign = run({ id: "r2", repoId: "feedfacecafe", status: "awaiting_approval" });
    const details: RunDetail[] = [
      { run: mine, steps: [stepResult({ runId: "r1" })] },
      { run: foreign, steps: [stepResult({ runId: "r2" })] },
    ];
    const tree = buildProjectDashboard(PROJECT, [mine, foreign], details);
    const content = allNodes(tree.nodes).map(ownContent).join(" ");
    expect(content).toContain("r1");
    // The foreign run's detail section (its step table + controls) must not
    // render; "r2" appears nowhere since its run row is filtered out too.
    expect(content).not.toContain("r2");
  });

  test("buildHome: one row per project with counts + a project-hub deep link", () => {
    const mine = projectRun(PROJECT, { id: "r1", status: "awaiting_approval", updatedAt: "2026-07-17T10:00:00.000Z" });
    const mine2 = projectRun(PROJECT, { id: "r2", status: "completed", updatedAt: "2026-07-16T10:00:00.000Z" });
    const tree = buildHome([PROJECT, OTHER], [mine, mine2]);
    const [projectsTable] = tablesOf(tree);
    expect(projectsTable!.columns).toEqual(["Project", "Runs", "Active", "Parked", "Last push"]);
    expect(projectsTable!.rows).toHaveLength(2);
    const [mineRow, otherRow] = projectsTable!.rows;
    expect(mineRow!.cells).toEqual(["My App", "2", "1", "1", "2026-07-17 10:00"]);
    expect(mineRow!.href).toBe(
      `/project/${PROJECT.id}/hub/${encodeURIComponent(FULL_PAGE_ID)}`,
    );
    expect(otherRow!.cells).toEqual(["Other", "0", "0", "0", "—"]);
  });

  test("buildHome: runs outside every registered project get the triage section", () => {
    const orphan = run({ id: "r9", repoId: "feedfacecafe", status: "awaiting_approval" });
    const details: RunDetail[] = [{ run: orphan, steps: [stepResult({ runId: "r9" })] }];
    const tree = buildHome([PROJECT], [orphan], details);
    const headings = nodesOf(tree)
      .filter((n) => n.type === "heading")
      .map((n) => String(n.text));
    expect(headings).toContain("Runs outside registered projects");
    // The orphan run row renders, and its parked detail section is inlined.
    const tables = tablesOf(tree);
    expect(tables.some((t) => t.rows.some((r) => r.cells[0] === "r9"))).toBe(true);
    expect(allNodes(tree.nodes).some((n) => n.type === "section")).toBe(true);
  });

  test("buildHome: project-owned runs do NOT appear in the orphan section", () => {
    const mine = projectRun(PROJECT, { id: "r1" });
    const tree = buildHome([PROJECT], [mine]);
    const headings = nodesOf(tree)
      .filter((n) => n.type === "heading")
      .map((n) => String(n.text));
    expect(headings).not.toContain("Runs outside registered projects");
  });

  test("buildHome: empty state only when there are no projects AND no runs", () => {
    expect(nodesOf(buildHome([], [])).some((n) => n.type === "empty-state")).toBe(true);
    expect(nodesOf(buildHome([PROJECT], [])).some((n) => n.type === "empty-state")).toBe(false);
  });

  test("buildHome: clamps the projects table at 100 rows and says so", () => {
    const many = Array.from({ length: 101 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      name: `p${i}`,
      path: `/proj/p${i}`,
    }));
    const tree = buildHome(many, []);
    const [projectsTable] = tablesOf(tree);
    expect(projectsTable!.rows).toHaveLength(100);
    const texts = nodesOf(tree)
      .filter((n) => n.type === "text")
      .map((n) => String(n.content));
    expect(texts.some((t) => t.includes("first 100 of 101"))).toBe(true);
  });
});
