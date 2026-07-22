import { test, expect, describe } from "bun:test";
import {
  ACTION_BADGE,
  appendRunDetail,
  buildAuditView,
  buildConfigView,
  buildDashboard,
  buildHome,
  buildJobView,
  buildProjectDashboard,
  buildRunDetail,
  buildRunDetailView,
  buildStepDetailView,
  buildUnknownView,
  effectiveRunStatus,
  FULL_PAGE_ID,
  JOB_SAVE_EVENT,
  JOB_TOGGLE_EVENT,
  JOB_DELETE_EVENT,
  RUN_NOW_EVENT,
  normalizeRespondPayload,
  parkedStep,
  parseRunIdPayload,
  parseView,
  projectIdForRun,
  runsForProject,
  SEVERITY_ICON,
  shortSha,
  STATUS_BADGE,
  STATUS_TONE,
  STEP_STATUS_BADGE,
  STEP_STATUS_TONE,
  type ProjectRef,
  type RunDetail,
  type StepDetail,
} from "./page";
import { repoId } from "./gate";
import { PageBuilder } from "@ezcorp/sdk/runtime";
import { emptyFindings } from "./runs";
import type { Finding, Findings, RunRecord, RunStatus, StepResultRecord, StepRoundRecord, StepStatus } from "./runs";
import { snapshotRepoConfig, emptyOutcomeFlags, type StepIORecord } from "./step-io";
import { emptyRepoConfig } from "./repo-config";
import { buildDefaultJob, type Job } from "./jobs";
import { defaultPipelineConfig, PIPELINE_STEPS } from "./config";
import type { AuditBucket } from "./audit";
import type { SweepHeartbeat } from "./sweep";

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
  test("stalled carries the warning glyph", () => {
    expect(STATUS_BADGE.stalled).toBe("⚠ stalled");
  });
});

describe("view nav links (Config & jobs / Audit log)", () => {
  const CONFIG_GLOBAL = `/hub/${encodeURIComponent(FULL_PAGE_ID)}?view=config`;
  const AUDIT_GLOBAL = `/hub/${encodeURIComponent(FULL_PAGE_ID)}?view=audit`;

  function linkHrefs(tree: { nodes: unknown[] }): string[] {
    return allNodes(tree.nodes)
      .filter((n) => n.type === "link")
      .map((n) => n.href as string);
  }

  test("global dashboard + home carry both view links (global-hub hrefs)", () => {
    for (const tree of [buildDashboard([]), buildHome([], [])]) {
      const hrefs = linkHrefs(tree);
      expect(hrefs).toContain(CONFIG_GLOBAL);
      expect(hrefs).toContain(AUDIT_GLOBAL);
    }
  });

  test("project dashboard carries both view links (project-hub hrefs)", () => {
    const project = { id: "proj-1", name: "My App", path: "/repos/my-app" };
    const hrefs = linkHrefs(buildProjectDashboard(project, []));
    expect(hrefs).toContain(
      `/project/proj-1/hub/${encodeURIComponent(FULL_PAGE_ID)}?view=config`,
    );
    expect(hrefs).toContain(
      `/project/proj-1/hub/${encodeURIComponent(FULL_PAGE_ID)}?view=audit`,
    );
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
      rows: Array<{ cells: unknown[]; href?: string }>;
    };
    expect(table.columns).toEqual(["Run", "Branch", "Head", "Status", "Updated"]);
    expect(table.rows).toHaveLength(4);
    // Head SHA is shortened; status badge is rendered (toned); time is trimmed.
    const firstRow = table.rows[0]!.cells;
    expect(firstRow[2]).toBe("abcdef01");
    // A completed run's Status cell now carries a success tone.
    expect(firstRow[3]).toEqual({ text: STATUS_BADGE.completed, tone: "success" });
    expect(firstRow[4]).toBe("2026-07-15 08:00");
    // Every run row is a link to its detail (global-hub variant here — no
    // project context).
    expect(table.rows[0]!.href).toBe(
      `/hub/${encodeURIComponent("ext:ez-code-factory:dashboard")}?run=r1`,
    );
    // A neutral (mid-flight) status stays a bare string, not a {text,tone}.
    expect(table.rows[3]!.cells[3]).toBe(STATUS_BADGE.created);
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
    ) as { rows: Array<{ cells: unknown[] }> };
    expect(stepTable.rows).toHaveLength(9);
    expect(stepTable.rows[0]!.cells[0]).toBe("intent");
    // A parked step's Status cell carries a warning tone; the round count stays plain.
    expect(stepTable.rows[2]!.cells).toEqual([
      "review",
      { text: STEP_STATUS_BADGE.awaiting_approval, tone: "warning" },
      "2",
    ]);
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
      rows: Array<{ cells: unknown[]; href?: string }>;
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

  test("buildProjectDashboard (R1): run rows link to the project-scoped detail + toned status", () => {
    const mine = projectRun(PROJECT, { id: "r1", status: "failed" });
    const tree = buildProjectDashboard(PROJECT, [mine]);
    const [table] = tablesOf(tree);
    const row = table!.rows[0]!;
    // R1: href stays on the SAME project hub (context preserved by the route).
    expect(row.href).toBe(
      `/project/${PROJECT.id}/hub/${encodeURIComponent(FULL_PAGE_ID)}?run=r1`,
    );
    // R4: a failed run's Status cell is toned danger.
    expect(row.cells[3]).toEqual({ text: STATUS_BADGE.failed, tone: "danger" });
  });

  test("buildHome (R1): orphan run rows link to the GLOBAL detail variant", () => {
    const orphan = run({ id: "r9", repoId: "feedfacecafe", status: "awaiting_approval" });
    const tree = buildHome([PROJECT], [orphan]);
    const orphanRow = tablesOf(tree)
      .flatMap((t) => t.rows)
      .find((r) => r.cells[0] === "r9");
    expect(orphanRow!.href).toBe(
      `/hub/${encodeURIComponent(FULL_PAGE_ID)}?run=r9`,
    );
    // awaiting_approval → warning tone.
    expect(orphanRow!.cells[3]).toEqual({ text: STATUS_BADGE.awaiting_approval, tone: "warning" });
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

// ── status→tone DRY maps ─────────────────────────────────────────────

describe("status tone maps (R4)", () => {
  test("STATUS_TONE covers every run status with the required colour mapping", () => {
    const statuses: RunStatus[] = [
      "created", "worktree_ready", "running", "awaiting_approval",
      "checks_passed", "completed", "failed", "aborted",
    ];
    for (const s of statuses) expect(STATUS_TONE[s]).toBeTruthy();
    // Locked mapping from R4.
    expect(STATUS_TONE.failed).toBe("danger");
    expect(STATUS_TONE.aborted).toBe("danger");
    expect(STATUS_TONE.completed).toBe("success");
    expect(STATUS_TONE.checks_passed).toBe("success");
    expect(STATUS_TONE.awaiting_approval).toBe("warning");
    expect(STATUS_TONE.running).toBe("neutral");
    expect(STATUS_TONE.created).toBe("neutral");
    expect(STATUS_TONE.worktree_ready).toBe("neutral");
    // A stalled run is a truthful warning, not a failure.
    expect(STATUS_TONE.stalled).toBe("warning");
  });

  test("STEP_STATUS_TONE covers every step status; parked gates warn", () => {
    const statuses: StepStatus[] = [
      "pending", "running", "fixing", "awaiting_approval",
      "fix_review", "completed", "skipped", "failed",
    ];
    for (const s of statuses) expect(STEP_STATUS_TONE[s]).toBeTruthy();
    expect(STEP_STATUS_TONE.failed).toBe("danger");
    expect(STEP_STATUS_TONE.completed).toBe("success");
    expect(STEP_STATUS_TONE.awaiting_approval).toBe("warning");
    expect(STEP_STATUS_TONE.fix_review).toBe("warning");
    expect(STEP_STATUS_TONE.skipped).toBe("neutral");
  });
});

// ── run-detail VIEW (the ?run=<id> variant) ──────────────────────────

describe("buildRunDetailView (R2 detail tree)", () => {
  const dispatch = (over: Partial<import("./runs").AgentDispatchRef> = {}) => ({
    role: "reviewer",
    assignmentId: "asg-1",
    subConversationId: "sub-1",
    agentRunId: "arun-1",
    at: "2026-07-18T09:30:00.000Z",
    ...over,
  });

  test("null detail → a 'Run not found' empty-state, never an error", () => {
    const tree = buildRunDetailView("run_missing", null);
    expect(tree.title).toContain("run_missing");
    const empty = tree.nodes.find((n) => (n as Node).type === "empty-state") as Node;
    expect(empty).toBeTruthy();
    expect(String(empty.title)).toContain("not found");
  });

  test("renders run meta, the full step table (toned), and each step's detail", () => {
    const reviewSr = stepResult({
      step: "review",
      status: "completed",
      findings: withFindings([finding({ id: "f1", description: "null deref" })], {
        summary: "reviewed the diff",
        testingSummary: "ran unit tests",
      }),
      agentDispatches: [dispatch(), dispatch({ role: "fixer", assignmentId: "asg-2", subConversationId: "sub-2" })],
    });
    const detail: RunDetail = {
      run: run({ id: "run_v", status: "completed", branch: "feat/z", intent: "ship it", intentSource: "agent" }),
      steps: [reviewSr],
    };
    const tree = buildRunDetailView("run_v", detail);

    // Meta section carries the run status glyph + intent.
    const meta = firstSection(tree.nodes);
    const stats = (meta.nodes as Node[]).find((n) => n.type === "stats") as {
      items: Array<{ label: string; value: string; hint?: string }>;
    };
    expect(stats.items.find((i) => i.label === "Status")!.value).toBe(STATUS_BADGE.completed);
    expect(stats.items.find((i) => i.label === "Intent")!.hint).toBe("ship it");

    // Full pipeline step table (all 9 steps); review's status cell is toned.
    const stepTable = (meta.nodes as Node[]).find(
      (n) => n.type === "table" && (n.columns as string[])[0] === "Step",
    ) as { rows: Array<{ cells: unknown[] }> };
    expect(stepTable.rows).toHaveLength(9);
    const reviewRow = stepTable.rows.find((r) => r.cells[0] === "review")!;
    expect(reviewRow.cells[1]).toEqual({ text: STEP_STATUS_BADGE.completed, tone: "success" });

    // The review step's own detail subsection: findings (read-only, NO fix
    // action) + a log panel + the agent-turn provenance table.
    const all = allNodes(tree.nodes);
    const findingsTable = all.find(
      (n) => n.type === "table" && (n.columns as string[])[0] === "Severity",
    ) as { rows: Array<{ cells: unknown[]; action?: unknown }> };
    expect(findingsTable.rows[0]!.action).toBeUndefined(); // read-only

    const turns = all.find(
      (n) => n.type === "table" && (n.columns as string[])[0] === "#",
    ) as { columns: string[]; rows: Array<{ cells: unknown[]; href?: string }> };
    expect(turns.columns).toEqual(["#", "Role", "Sub-conversation", "Assignment", "When"]);
    expect(turns.rows).toHaveLength(2);
    // This call passes NO projectId (the orphan / global-view path), so the
    // provenance rows carry ids as TEXT with no deep-link — the project-scoped
    // deep-link is covered by its own test below.
    expect(turns.rows.every((r) => r.href === undefined)).toBe(true);
    expect(turns.rows[0]!.cells).toEqual(["1", "reviewer", "sub-1", "asg-1", "2026-07-18 09:30"]);
  });

  test("a step with no recorded dispatches shows an honest 'No recorded turns' note", () => {
    const detail: RunDetail = {
      run: run({ id: "run_old" }),
      steps: [
        stepResult({
          step: "review",
          status: "completed",
          findings: withFindings([finding()], { summary: "did the thing" }),
          // no agentDispatches (pre-linkage run)
        }),
      ],
    };
    const tree = buildRunDetailView("run_old", detail);
    const empties = allNodes(tree.nodes).filter((n) => n.type === "empty-state") as Node[];
    expect(empties.some((n) => String(n.title).includes("No recorded turns"))).toBe(true);
  });

  test("project-scoped: each turn row deep-links to its chat sub-conversation (ids as text, never turn CONTENT)", () => {
    const detail: RunDetail = {
      run: run({ id: "run_v" }),
      steps: [
        stepResult({
          step: "review",
          status: "awaiting_approval",
          findings: withFindings([finding()]),
          agentDispatches: [
            dispatch(),
            dispatch({ role: "fixer", assignmentId: "asg-2", subConversationId: "sub 2/x" }),
          ],
        }),
      ],
    };
    const tree = buildRunDetailView("run_v", detail, "proj-77");
    const turns = allNodes(tree.nodes).find(
      (n) => n.type === "table" && (n.columns as string[])[0] === "#",
    ) as { rows: Array<{ cells: unknown[]; href?: string }> };

    // Each row deep-links to /project/<projectId>/chat/<subConversationId>, with
    // BOTH ids encodeURIComponent'd (the second dispatch's id has a `/` + space).
    expect(turns.rows[0]!.href).toBe("/project/proj-77/chat/sub-1");
    expect(turns.rows[1]!.href).toBe("/project/proj-77/chat/sub%202%2Fx");
    // The row still carries only provenance ids/role/time — never turn CONTENT.
    expect(turns.rows[0]!.cells).toEqual(["1", "reviewer", "sub-1", "asg-1", "2026-07-18 09:30"]);
    // The ONLY /chat/ occurrences in the whole tree are those two hrefs (the
    // link exposes reachability, not conversation content).
    const content = allNodes(tree.nodes).map(ownContent).join(" ");
    expect(content.match(/\/chat\//g)).toHaveLength(2);
  });

  test("orphan / global view (no project): ids-as-text, no /chat/ deep-link", () => {
    const detail: RunDetail = {
      run: run({ id: "run_v" }),
      steps: [
        stepResult({
          step: "review",
          status: "awaiting_approval",
          findings: withFindings([finding()]),
          agentDispatches: [dispatch()],
        }),
      ],
    };
    const tree = buildRunDetailView("run_v", detail); // no projectId
    const content = allNodes(tree.nodes).map(ownContent).join(" ");
    // The sub-conversation id is present as provenance text…
    expect(content).toContain("sub-1");
    // …but never as a /chat/ deep-link (no project to address the run to).
    expect(content).not.toContain("/chat/");
  });
});

describe("projectIdForRun (deep-link project resolution)", () => {
  const projFor = (id: string, path: string): ProjectRef => ({ id, name: id, path });

  test("resolves the OWNING project by repoId match", () => {
    const p = projFor("proj-1", "/work/app");
    const r = run({ id: "run_1", repoId: repoId("/work/app") });
    expect(projectIdForRun(r, [projFor("other", "/work/nope"), p])).toBe("proj-1");
  });

  test("an orphan run (no matching project) resolves to undefined", () => {
    const r = run({ id: "run_x", repoId: repoId("/work/unregistered") });
    expect(projectIdForRun(r, [projFor("proj-1", "/work/app")])).toBeUndefined();
  });

  test("no project context at all → undefined (global view with an empty list)", () => {
    expect(projectIdForRun(run({ repoId: repoId("/work/app") }), [])).toBeUndefined();
  });
});

// ── effective status + stalled display (L3) ─────────────────────────

describe("effectiveRunStatus", () => {
  test("a running run in the stalled set → stalled; not in the set → running", () => {
    const r = run({ id: "run_1", status: "running" });
    expect(effectiveRunStatus(r, new Set(["run_1"]))).toBe("stalled");
    expect(effectiveRunStatus(r, new Set(["other"]))).toBe("running");
    expect(effectiveRunStatus(r, undefined)).toBe("running");
  });

  test("a PERSISTED stalled run is stalled regardless of the derived set", () => {
    expect(effectiveRunStatus(run({ id: "r", status: "stalled" }), undefined)).toBe("stalled");
  });

  test("non-running statuses pass through unchanged", () => {
    for (const s of ["completed", "failed", "awaiting_approval", "checks_passed"] as const) {
      expect(effectiveRunStatus(run({ id: "r", status: s }), new Set(["r"]))).toBe(s);
    }
  });
});

describe("stalled run rows + Stalled stat bucket", () => {
  function statsOf(tree: { nodes: unknown[] }) {
    return (tree.nodes as Array<Record<string, unknown>>).find((n) => n.type === "stats") as {
      items: Array<{ label: string; value: string }>;
    };
  }
  function runRow(tree: { nodes: unknown[] }, id: string) {
    return allNodes(tree.nodes)
      .filter((n) => n.type === "table")
      .flatMap((n) => (n.rows as Array<{ cells: unknown[]; href?: string }>))
      .find((r) => r.cells[0] === id);
  }

  test("a DERIVED-stalled running run renders ⚠ stalled (warning) and counts as Stalled, not Active", () => {
    const r = run({ id: "run_live", status: "running" });
    const tree = buildDashboard([r], [], new Set(["run_live"]));
    expect(runRow(tree, "run_live")!.cells[3]).toEqual({ text: STATUS_BADGE.stalled, tone: "warning" });
    const items = statsOf(tree).items;
    expect(items.find((i) => i.label === "Stalled")!.value).toBe("1");
    expect(items.find((i) => i.label === "Active")!.value).toBe("0");
  });

  test("a PERSISTED stalled run shows the Stalled bucket without any derived set", () => {
    const tree = buildDashboard([run({ id: "r", status: "stalled" })], []);
    expect(statsOf(tree).items.find((i) => i.label === "Stalled")!.value).toBe("1");
  });

  test("no stalled runs → NO Stalled bucket (backward-compatible 4-stat row)", () => {
    const tree = buildDashboard([run({ id: "r", status: "completed" })], []);
    expect(statsOf(tree).items.map((i) => i.label)).toEqual(["Total runs", "Active", "Completed", "Failed"]);
  });
});

describe("step-row links + step-level stalled (run detail)", () => {
  function stepTableOf(tree: { nodes: unknown[] }) {
    return allNodes(tree.nodes).find(
      (n) => n.type === "table" && (n.columns as string[])[0] === "Step",
    ) as { rows: Array<{ cells: unknown[]; href?: string }> };
  }

  test("every step row deep-links to its step detail (project-hub form)", () => {
    const detail: RunDetail = { run: run({ id: "run_p", status: "completed" }), steps: [stepResult({ step: "review", status: "completed" })] };
    const tree = buildRunDetailView("run_p", detail, "proj-9");
    const rows = stepTableOf(tree).rows;
    expect(rows[0]!.href).toBe(
      `/project/proj-9/hub/${encodeURIComponent(FULL_PAGE_ID)}?run=run_p&step=intent`,
    );
    // The review row (index 2 in PIPELINE_STEPS order) targets the review step.
    expect(rows[2]!.href).toBe(
      `/project/proj-9/hub/${encodeURIComponent(FULL_PAGE_ID)}?run=run_p&step=review`,
    );
  });

  test("without a projectId the step rows use the GLOBAL-hub form", () => {
    const detail: RunDetail = { run: run({ id: "run_g", status: "completed" }), steps: [] };
    const tree = buildRunDetailView("run_g", detail);
    expect(stepTableOf(tree).rows[0]!.href).toBe(
      `/hub/${encodeURIComponent(FULL_PAGE_ID)}?run=run_g&step=intent`,
    );
  });

  test("a stalled run's in-flight step surfaces ⚠ stalled (warning) in the step table", () => {
    const detail: RunDetail = {
      run: run({ id: "run_s", status: "running" }),
      steps: [stepResult({ step: "review", status: "running" })],
    };
    const tree = buildRunDetailView("run_s", detail, undefined, new Set(["run_s"]));
    const rows = stepTableOf(tree).rows;
    // review is index 2; its cell shows the stalled badge with warning tone.
    expect(rows[2]!.cells[1]).toEqual({ text: STATUS_BADGE.stalled, tone: "warning" });
    // A non-in-flight step (pending) keeps its own plain badge.
    expect(rows[3]!.cells[1]).toBe(STEP_STATUS_BADGE.pending);
    // The header status stat is stalled-aware too.
    const meta = firstSection(tree.nodes);
    const stats = (meta.nodes as Node[]).find((n) => n.type === "stats") as {
      items: Array<{ label: string; value: string }>;
    };
    expect(stats.items.find((i) => i.label === "Status")!.value).toBe(STATUS_BADGE.stalled);
  });
});

// ── step-detail VIEW (the ?run=<id>&step=<name> variant) ─────────────

describe("buildStepDetailView (L5 step detail)", () => {
  function ioDispatch(over: Partial<import("./step-io").StepIODispatch> = {}): import("./step-io").StepIODispatch {
    return {
      role: "reviewer",
      promptText: "review this diff",
      resultPreview: "looks fine, one nit",
      assignmentId: "asg-1",
      subConversationId: "sub-1",
      agentRunId: "arun-1",
      at: "2026-07-15T08:00:01.000Z",
      ...over,
    };
  }
  function ioShell(over: Partial<import("./step-io").StepIOShellCommand> = {}): import("./step-io").StepIOShellCommand {
    return { command: "bun test", exitCode: 0, output: "42 pass", durationMs: 120, ...over };
  }
  function ioRecord(over: Partial<StepIORecord> = {}): StepIORecord {
    return {
      runId: "run_abc",
      step: "review",
      round: 1,
      trigger: "initial",
      branch: "feat/x",
      headSha: "abcdef0123456789",
      worktreePath: "/wt/run_abc",
      repoConfig: snapshotRepoConfig({ ...emptyRepoConfig(), agent: "claude", commands: { ...emptyRepoConfig().commands, test: "bun test", lint: "biome" } }),
      startedAt: "2026-07-15T08:00:00.000Z",
      dispatches: [],
      shellCommands: [],
      endedAt: "2026-07-15T08:00:05.000Z",
      durationMs: 5000,
      error: null,
      outcome: emptyOutcomeFlags(),
      ...over,
    };
  }
  function roundRecord(over: Partial<StepRoundRecord> = {}): StepRoundRecord {
    return {
      runId: "run_abc",
      step: "review",
      round: 1,
      trigger: "initial",
      findingsJson: null,
      userFindingsJson: null,
      selectedFindingIds: null,
      selectionSource: null,
      fixSummary: null,
      durationMs: 0,
      ...over,
    };
  }
  function detail(over: Partial<StepDetail> = {}): StepDetail {
    return { run: run(), step: "review", result: stepResult(), rounds: [], io: [], ...over };
  }

  function tablesIn(tree: { nodes: unknown[] }) {
    return allNodes(tree.nodes).filter((n) => n.type === "table") as Array<{
      columns: string[];
      rows: Array<{ cells: unknown[]; href?: string }>;
    }>;
  }
  const tableByCol0 = (tree: { nodes: unknown[] }, col0: string) => tablesIn(tree).filter((t) => t.columns[0] === col0);
  const sectionTitles = (tree: { nodes: unknown[] }) =>
    allNodes(tree.nodes).filter((n) => n.type === "section").map((n) => String(n.title));

  test("null detail → a 'Step not found' empty state, never an error", () => {
    const tree = buildStepDetailView(null);
    const empty = (tree.nodes as Node[]).find((n) => n.type === "empty-state") as Node;
    expect(String(empty.title)).toContain("not found");
  });

  test("a result WITH detail renders the aggregate '<step> summary' section", () => {
    // stepHasDetail(result) is true (the result carries findings), so the summary
    // section (risk/findings/log/turns) renders in addition to the header + rounds.
    const tree = buildStepDetailView(
      detail({
        result: stepResult({
          findings: withFindings([finding({ id: "f1", description: "a nit" })], { summary: "one nit found" }),
        }),
      }),
    );
    expect(sectionTitles(tree)).toContain("review summary");
  });

  test("header stats carry run/branch/step/status/rounds/duration/updated", () => {
    const tree = buildStepDetailView(
      detail({
        run: run({ id: "run_h", branch: "feat/z", status: "completed", updatedAt: "2026-07-15T09:00:00.000Z" }),
        step: "test",
        result: stepResult({ step: "test", status: "completed", round: 3, executionMs: 8000 }),
        io: [ioRecord({ step: "test", round: 1 })],
      }),
    );
    const stats = allNodes(tree.nodes).find((n) => n.type === "stats") as {
      items: Array<{ label: string; value: string }>;
    };
    const by = (l: string) => stats.items.find((i) => i.label === l)!.value;
    expect(by("Run")).toBe("run_h");
    expect(by("Branch")).toBe("feat/z");
    expect(by("Step")).toBe("test");
    expect(by("Status")).toBe(STEP_STATUS_BADGE.completed);
    expect(by("Rounds")).toBe("3");
    expect(by("Duration")).toBe("8000 ms");
    expect(by("Updated")).toBe("2026-07-15 09:00");
  });

  test("renders per-round IO: inputs, agent dispatches (deep-linked), and shell commands", () => {
    const tree = buildStepDetailView(
      detail({
        result: stepResult({ round: 1 }),
        rounds: [roundRecord({ round: 1 })],
        io: [
          ioRecord({
            round: 1,
            dispatches: [ioDispatch()],
            shellCommands: [ioShell({ command: "bun test", exitCode: 1, output: "1 fail" })],
          }),
        ],
      }),
      "proj-42",
    );
    // Inputs table (Field/Detail) carries branch/head/worktree/agent/commands.
    const inputs = tableByCol0(tree, "Field")[0]!;
    const fields = inputs.rows.map((r) => r.cells[0]);
    expect(fields).toEqual(expect.arrayContaining(["Branch", "Head", "Worktree", "Agent", "Commands", "Duration"]));
    // Dispatch table deep-links to the chat sub-conversation on the project.
    const dispatches = tableByCol0(tree, "#")[0]!;
    expect(dispatches.rows[0]!.cells[1]).toBe("reviewer");
    expect(dispatches.rows[0]!.href).toBe("/project/proj-42/chat/sub-1");
    // Shell table shows command/exit/duration/output.
    const shell = tableByCol0(tree, "Command")[0]!;
    expect(shell.rows[0]!.cells).toEqual(["bun test", "1", "120 ms", "1 fail"]);
  });

  test("an empty shell output renders as an em dash (ioExcerpt empty branch)", () => {
    const tree = buildStepDetailView(
      detail({
        result: stepResult({ round: 1 }),
        rounds: [roundRecord({ round: 1 })],
        io: [ioRecord({ round: 1, shellCommands: [ioShell({ command: "true", output: "" })] })],
      }),
    );
    const shell = tableByCol0(tree, "Command")[0]!;
    // The Output cell (index 3) falls through ioExcerpt("") → "—".
    expect(shell.rows[0]!.cells[3]).toBe("—");
  });

  test("rounds render NEWEST-first", () => {
    const tree = buildStepDetailView(
      detail({
        result: stepResult({ round: 2 }),
        rounds: [roundRecord({ round: 1 }), roundRecord({ round: 2, trigger: "auto_fix" })],
        io: [ioRecord({ round: 1 }), ioRecord({ round: 2, trigger: "auto_fix" })],
      }),
    );
    const roundSections = sectionTitles(tree).filter((t) => t.startsWith("Round "));
    expect(roundSections[0]).toContain("Round 2");
    expect(roundSections[1]).toContain("Round 1");
  });

  test("errored-final-round: an IO record with NO step_round still renders (LEFT-join)", () => {
    const tree = buildStepDetailView(
      detail({
        result: stepResult({ round: 1 }),
        rounds: [roundRecord({ round: 1 })], // round 2 has NO step_round
        io: [ioRecord({ round: 1 }), ioRecord({ round: 2, error: "step review failed: boom" })],
      }),
    );
    const titles = sectionTitles(tree);
    expect(titles.some((t) => t.startsWith("Round 2"))).toBe(true);
    // The errored round's error surfaces in its inputs table.
    const content = allNodes(tree.nodes).map(ownContent).join(" ");
    expect(content).toContain("step review failed: boom");
  });

  test("a round with a step_round but NO IO shows 'No recorded IO for this round'", () => {
    const tree = buildStepDetailView(
      detail({ result: stepResult({ round: 1 }), rounds: [roundRecord({ round: 1, fixSummary: "tweaked" })], io: [] }),
    );
    const empties = allNodes(tree.nodes).filter((n) => n.type === "empty-state").map((n) => String(n.title));
    expect(empties.some((t) => t.includes("No recorded IO for this round"))).toBe(true);
  });

  test("whole step with NO rounds and NO io → 'No recorded IO for this step (run predates IO recording)'", () => {
    const tree = buildStepDetailView(detail({ result: null, rounds: [], io: [] }));
    const empties = allNodes(tree.nodes).filter((n) => n.type === "empty-state").map((n) => String(n.title));
    expect(empties.some((t) => t.includes("No recorded IO for this step"))).toBe(true);
  });

  test("clamps to the latest 10 rounds and notes the rest", () => {
    const rounds = Array.from({ length: 12 }, (_, i) => roundRecord({ round: i + 1 }));
    const io = Array.from({ length: 12 }, (_, i) => ioRecord({ round: i + 1 }));
    const tree = buildStepDetailView(detail({ result: stepResult({ round: 12 }), rounds, io }));
    const roundSections = sectionTitles(tree).filter((t) => t.startsWith("Round "));
    expect(roundSections).toHaveLength(10);
    // Newest kept, oldest dropped.
    expect(roundSections[0]).toContain("Round 12");
    expect(roundSections.some((t) => t.includes("Round 2 "))).toBe(false);
    // The "showing latest N" note is a muted text node (page.markdown → text).
    const content = allNodes(tree.nodes).map(ownContent).join(" ");
    expect(content).toContain("latest 10 of 12 rounds");
  });

  test("BUILDER pre-truncates a 32 KB stored blob so no cell exceeds ~280 chars", () => {
    const bigOutput = "x".repeat(32 * 1024);
    const bigPrompt = "p".repeat(32 * 1024);
    const tree = buildStepDetailView(
      detail({
        result: stepResult({ round: 1 }),
        rounds: [roundRecord({ round: 1 })],
        io: [ioRecord({ round: 1, dispatches: [ioDispatch({ promptText: bigPrompt })], shellCommands: [ioShell({ output: bigOutput })] })],
      }),
    );
    // Every table cell string in the tree must be a bounded excerpt.
    const cellStrings: string[] = [];
    for (const t of tablesIn(tree)) {
      for (const r of t.rows) {
        for (const c of r.cells) if (typeof c === "string") cellStrings.push(c);
      }
    }
    for (const c of cellStrings) expect(c.length).toBeLessThanOrEqual(300);
    // And the excerpt marker is present on the truncated ones.
    expect(cellStrings.some((c) => c.includes("· excerpt"))).toBe(true);
  });

  test("PRIVACY: agent/shell content lands ONLY in escaped nodes, never a markdown sink; dispatch rows keep chat hrefs", () => {
    const XSS = `<img src=x onerror="alert('ezcf_step_xss')">`;
    const tree = buildStepDetailView(
      detail({
        run: run({ id: "run_x", branch: `feat/${XSS}` }),
        result: stepResult({ round: 1 }),
        rounds: [roundRecord({ round: 1 })],
        io: [
          ioRecord({
            round: 1,
            branch: `feat/${XSS}`,
            dispatches: [ioDispatch({ promptText: XSS, resultPreview: XSS })],
            shellCommands: [ioShell({ command: XSS, output: XSS })],
            error: XSS,
          }),
        ],
      }),
      "proj-1",
    );
    const carriers = allNodes(tree.nodes).filter((n) => ownContent(n).includes(XSS));
    expect(carriers.length).toBeGreaterThan(0);
    expect(carriers.some((n) => n.type === "markdown")).toBe(false);
    for (const n of carriers) expect(ESCAPED_PAGE_TYPES.has(n.type as string)).toBe(true);
    // The dispatch row still deep-links to the chat (the deep-link is the ONLY
    // way transcript content is reachable — never inlined here).
    const dispatches = tableByCol0(tree, "#")[0]!;
    expect(dispatches.rows[0]!.href).toBe("/project/proj-1/chat/sub-1");
  });

  test("a stalled run's in-flight step surfaces ⚠ stalled in the header status", () => {
    const tree = buildStepDetailView(
      detail({ run: run({ id: "run_s", status: "running" }), result: stepResult({ status: "running", round: 1 }), rounds: [roundRecord()], io: [ioRecord()] }),
      undefined,
      new Set(["run_s"]),
    );
    const stats = allNodes(tree.nodes).find((n) => n.type === "stats") as {
      items: Array<{ label: string; value: string }>;
    };
    expect(stats.items.find((i) => i.label === "Status")!.value).toBe(STATUS_BADGE.stalled);
  });
});

// ── inline parked-triage step-table hrefs (appendRunDetail call site) ─

describe("appendRunDetail inline step-table hrefs", () => {
  function stepRows(page: PageBuilder) {
    const tree = page.build();
    const t = allNodes(tree.nodes).find(
      (n) => n.type === "table" && (n.columns as string[])[0] === "Step",
    ) as { rows: Array<{ href?: string }> };
    return t.rows;
  }
  const parked: RunDetail = {
    run: run({ id: "run_t", status: "awaiting_approval" }),
    steps: [stepResult({ step: "review", status: "awaiting_approval" })],
  };

  test("project form when a projectId is supplied", () => {
    const page = new PageBuilder("t");
    appendRunDetail(page, parked, { projectId: "proj-1" });
    expect(stepRows(page)[0]!.href).toBe(
      `/project/proj-1/hub/${encodeURIComponent(FULL_PAGE_ID)}?run=run_t&step=intent`,
    );
    // The parked review step (index 2) targets the review step detail.
    expect(stepRows(page)[2]!.href).toBe(
      `/project/proj-1/hub/${encodeURIComponent(FULL_PAGE_ID)}?run=run_t&step=review`,
    );
  });

  test("global form when no projectId is supplied", () => {
    const page = new PageBuilder("t");
    appendRunDetail(page, parked);
    expect(stepRows(page)[0]!.href).toBe(
      `/hub/${encodeURIComponent(FULL_PAGE_ID)}?run=run_t&step=intent`,
    );
  });
});

// ── Control-plane views (`?view=` — L6) ──────────────────────────────

function jobFix(over: Partial<Job> = {}): Job {
  return { ...buildDefaultJob("2026-07-15T00:00:00.000Z"), id: "job_1", name: "Nightly", ...over };
}
function sweepHb(over: Partial<SweepHeartbeat> = {}): SweepHeartbeat {
  return {
    ranAt: "2026-07-21T00:00:00.000Z",
    summary: { scanned: 3, advanced: 1, stillParked: 1, skipped: 0, stalled: 0 },
    ...over,
  };
}
/** Every table node reachable in a tree (recursing sections). */
function tablesDeep(tree: { nodes: unknown[] }) {
  return allNodes(tree.nodes).filter((n) => n.type === "table") as Array<{
    columns: string[];
    rows: Array<{ cells: unknown[]; href?: string; action?: { event: string; payload?: Record<string, unknown> } }>;
  }>;
}
/** Every button node reachable in a tree (recursing sections). */
function buttonsDeep(tree: { nodes: unknown[] }) {
  return allNodes(tree.nodes).filter((n) => n.type === "button") as Array<{
    label: string;
    action: { event: string; payload?: Record<string, unknown>; prompt?: { field?: string }; confirm?: string };
  }>;
}

describe("parseView", () => {
  test("config / audit / audit:<day> / job:<id>", () => {
    expect(parseView("config")).toEqual({ kind: "config" });
    expect(parseView("audit")).toEqual({ kind: "audit" });
    expect(parseView("audit:2026-07-21")).toEqual({ kind: "audit", day: "2026-07-21" });
    expect(parseView("job:abc-123")).toEqual({ kind: "job", jobId: "abc-123" });
  });
  test("malformed compound values → unknown (never a throw)", () => {
    expect(parseView("audit:notaday")).toEqual({ kind: "unknown" });
    expect(parseView("audit:2026-7-1")).toEqual({ kind: "unknown" });
    expect(parseView("job:")).toEqual({ kind: "unknown" });
    expect(parseView("bogus")).toEqual({ kind: "unknown" });
    expect(parseView("")).toEqual({ kind: "unknown" });
  });
});

describe("buildConfigView", () => {
  const cfg = defaultPipelineConfig();
  test("renders the pipeline, jobs table (row → ?view=job:<id>), and a New job button", () => {
    const jobs = [jobFix({ id: "j1", name: "Main", trigger: { kind: "push", branchPattern: "*" }, skipSteps: ["test"] })];
    const runs = [run({ id: "run_1", jobId: "j1", status: "completed" })];
    const tree = buildConfigView({ jobs, runs, config: cfg, sweepHeartbeat: sweepHb(), nowMs: Date.parse("2026-07-21T00:05:00.000Z"), extensionId: "ez-code-factory", projectId: "proj-1" });
    expect(tree.title).toBe("ez-code-factory — config");
    // Pipeline table lists every step; the skip overlay names the skipping job.
    const pipeline = tablesDeep(tree).find((t) => t.columns[0] === "Step")!;
    expect(pipeline.rows).toHaveLength(9);
    const testRow = pipeline.rows.find((r) => r.cells[0] === "test")!;
    expect(testRow.cells[1]).toBe("Main");
    // Jobs table row links to the job editor on the SAME (project) hub.
    const jobsTable = tablesDeep(tree).find((t) => t.columns[0] === "Name")!;
    expect(jobsTable.rows[0]!.href).toBe(`/project/proj-1/hub/${encodeURIComponent(FULL_PAGE_ID)}?view=${encodeURIComponent("job:j1")}`);
    // The last-run cell references the run id (text, not a separate link).
    expect(String(jobsTable.rows[0]!.cells[3])).toContain("run_1");
    // New job button dispatches job-save with a name prompt.
    const newBtn = buttonsDeep(tree).find((b) => b.label === "New job")!;
    expect(newBtn.action.event).toBe(JOB_SAVE_EVENT);
    expect(newBtn.action.prompt?.field).toBe("name");
    // Platform-settings pointer.
    const link = allNodes(tree.nodes).find((n) => n.type === "link" && (n.href as string) === "/extensions/ez-code-factory");
    expect(link).toBeDefined();
    // Cross-link into the audit view on the SAME (project) hub (audit
    // already links back to config).
    const audit = allNodes(tree.nodes).find(
      (n) =>
        n.type === "link" &&
        (n.href as string) === `/project/proj-1/hub/${encodeURIComponent(FULL_PAGE_ID)}?view=audit`,
    );
    expect(audit).toBeDefined();
  });

  test("jobs table row uses the GLOBAL-hub href when no projectId (both-hubs precedent)", () => {
    const jobs = [jobFix({ id: "j1" })];
    const tree = buildConfigView({ jobs, runs: [], config: cfg, sweepHeartbeat: sweepHb(), nowMs: Date.now(), extensionId: "ez-code-factory" });
    const jobsTable = tablesDeep(tree).find((t) => t.columns[0] === "Name")!;
    expect(jobsTable.rows[0]!.href).toBe(`/hub/${encodeURIComponent(FULL_PAGE_ID)}?view=${encodeURIComponent("job:j1")}`);
  });

  test("sweep-health: a null heartbeat renders the WARNING-toned 'never run' cell", () => {
    const tree = buildConfigView({ jobs: [jobFix()], runs: [], config: cfg, sweepHeartbeat: null, nowMs: Date.now(), extensionId: "ez-code-factory" });
    const cell = tablesDeep(tree)
      .flatMap((t) => t.rows)
      .flatMap((r) => r.cells)
      .find((c) => c && typeof c === "object" && (c as { text?: string }).text?.includes("sweep has never run")) as { text: string; tone: string } | undefined;
    expect(cell?.tone).toBe("warning");
    expect(cell?.text).toContain("sweep has never run");
  });

  test("sweep-health: a present heartbeat renders its age + summary stats", () => {
    const tree = buildConfigView({ jobs: [jobFix()], runs: [], config: cfg, sweepHeartbeat: sweepHb(), nowMs: Date.parse("2026-07-21T00:10:00.000Z"), extensionId: "ez-code-factory" });
    const stats = allNodes(tree.nodes).find((n) => n.type === "stats" && (n.items as Array<{ label: string }>).some((i) => i.label === "Last sweep")) as { items: Array<{ label: string; value: string }> };
    expect(stats.items.find((i) => i.label === "Last sweep")!.value).toBe("10 min ago");
    expect(stats.items.find((i) => i.label === "Scanned")!.value).toBe("3");
  });

  test("an empty jobs list renders the 'No jobs' empty state", () => {
    const tree = buildConfigView({ jobs: [], runs: [], config: cfg, sweepHeartbeat: null, nowMs: Date.now(), extensionId: "ez-code-factory" });
    expect(allNodes(tree.nodes).some((n) => n.type === "empty-state" && String(n.title) === "No jobs")).toBe(true);
  });

  test("a manual-trigger job renders its 'manual · <branch>' trigger label", () => {
    const job = jobFix({ id: "jm", name: "OnDemand", trigger: { kind: "manual", branch: "release" } });
    const tree = buildConfigView({ jobs: [job], runs: [], config: cfg, sweepHeartbeat: null, nowMs: Date.now(), extensionId: "ez-code-factory" });
    const jobsTable = tablesDeep(tree).find((t) => t.columns[0] === "Name")!;
    expect(jobsTable.rows[0]!.cells[1]).toBe("manual · release");
  });

  test("sweep-health age rolls up to days for an old heartbeat (> 48 h)", () => {
    // 3 days after ranAt → the ageLabel 'd ago' arm.
    const tree = buildConfigView({
      jobs: [jobFix()], runs: [], config: cfg,
      sweepHeartbeat: sweepHb({ ranAt: "2026-07-18T00:00:00.000Z" }),
      nowMs: Date.parse("2026-07-21T00:00:00.000Z"),
      extensionId: "ez-code-factory",
    });
    const stats = allNodes(tree.nodes).find((n) => n.type === "stats" && (n.items as Array<{ label: string }>).some((i) => i.label === "Last sweep")) as { items: Array<{ label: string; value: string }> };
    expect(stats.items.find((i) => i.label === "Last sweep")!.value).toBe("3 d ago");
  });
});

describe("buildJobView", () => {
  test("unknown job id → an honest not-found empty state (never a throw)", () => {
    const tree = buildJobView("ghost", null, []);
    expect(allNodes(tree.nodes).some((n) => n.type === "empty-state" && String(n.title).includes("not found"))).toBe(true);
  });

  test("renders the definition, the full action set, and its runs (row → ?run=)", () => {
    const job = jobFix({ id: "j1", name: "Nightly", enabled: true, trigger: { kind: "schedule", every: "daily", branch: "main" }, skipSteps: ["test"] });
    const runs = [run({ id: "run_9", jobId: "j1", status: "completed" })];
    const tree = buildJobView("j1", job, runs, "proj-1");
    const btns = buttonsDeep(tree);
    const events = btns.map((b) => b.action.event);
    // Every declared edit BUTTON is present (enabled job → Run now shown). The
    // five job-save buttons are name/branch/trigger/intent-template/agent — the
    // old comma-list skip-steps button is gone (Flow toggles supersede it).
    expect(events.filter((e) => e === JOB_SAVE_EVENT).length).toBe(5);
    expect(events).toContain(JOB_TOGGLE_EVENT);
    expect(events).toContain(RUN_NOW_EVENT);
    expect(events).toContain(JOB_DELETE_EVENT);
    // The Edit agent action collects the agent_name scalar (L4 editor coherence).
    const editAgent = btns.find((b) => b.label === "Edit agent")!;
    expect(editAgent.action.event).toBe(JOB_SAVE_EVENT);
    expect((editAgent.action.prompt as { field?: string }).field).toBe("agent_name");
    // Delete carries a confirm.
    expect(btns.find((b) => b.action.event === JOB_DELETE_EVENT)!.action.confirm).toContain("Delete");
    // The runs table deep-links each run on the project hub.
    const runsTable = tablesDeep(tree).find((t) => t.columns[0] === "Run")!;
    expect(runsTable.rows[0]!.href).toBe(`/project/proj-1/hub/${encodeURIComponent(FULL_PAGE_ID)}?run=run_9`);
  });

  test("the Edit intent template button is present; the old skip-steps button is gone", () => {
    const btns = buttonsDeep(buildJobView("j1", jobFix({ id: "j1" }), []));
    const intentBtn = btns.find((b) => b.label === "Edit intent template")!;
    expect(intentBtn).toBeDefined();
    expect(intentBtn.action.event).toBe(JOB_SAVE_EVENT);
    expect((intentBtn.action.prompt as { field?: string }).field).toBe("intent_template");
    // The superseded comma-list button no longer renders (its payload path lives on).
    expect(btns.some((b) => b.label === "Edit skip-steps")).toBe(false);
    expect(btns.some((b) => (b.action.prompt as { field?: string } | undefined)?.field === "skip_steps")).toBe(false);
  });

  test("the Flow table lists all 9 steps in pipeline order with the right tones + protected labels", () => {
    const job = jobFix({ id: "j1", name: "Nightly", skipSteps: ["test"] });
    const tree = buildJobView("j1", job, []);
    const flow = tablesDeep(tree).find((t) => t.columns[0] === "Step" && t.columns[1] === "State")!;
    expect(flow.rows.map((r) => r.cells[0])).toEqual([...PIPELINE_STEPS]);
    const cellOf = (step: string) => flow.rows.find((r) => r.cells[0] === step)!;
    // Skipped step → warning-tone `skipped` cell.
    expect(cellOf("test").cells[1]).toEqual({ text: "skipped", tone: "warning" });
    // A running (non-protected) step → the plain `runs` string (no tone).
    expect(cellOf("document").cells[1]).toBe("runs");
    // Protected steps are plain-labeled and carry NO row action.
    for (const p of ["intent", "rebase", "review", "push"]) {
      expect(cellOf(p).cells[1]).toBe("protected — always runs");
      expect(cellOf(p).action).toBeUndefined();
    }
  });

  test("Flow rows on non-protected steps carry a job-save toggle_step action with a directional confirm", () => {
    const job = jobFix({ id: "j1", name: "Nightly", skipSteps: ["test"] });
    const flow = tablesDeep(buildJobView("j1", job, [])).find((t) => t.columns[1] === "State")!;
    const cellOf = (step: string) => flow.rows.find((r) => r.cells[0] === step)!;
    // A RUNNING step's toggle offers to SKIP it.
    const docAction = cellOf("document").action!;
    expect(docAction.event).toBe(JOB_SAVE_EVENT);
    expect(docAction.payload).toEqual({ jobId: "j1", toggle_step: "document" });
    expect((docAction as { confirm?: string }).confirm).toBe('Skip the document step for job "Nightly"?');
    // A SKIPPED step's toggle offers to RUN it again.
    const testAction = cellOf("test").action!;
    expect(testAction.payload).toEqual({ jobId: "j1", toggle_step: "test" });
    expect((testAction as { confirm?: string }).confirm).toBe('Run the test step again for job "Nightly"?');
  });

  test("a muted note states the fixed-order / protected-always-run platform truth", () => {
    const tree = buildJobView("j1", jobFix({ id: "j1" }), []);
    const md = allNodes(tree.nodes).filter((n) => n.type === "text").map((n) => String(n.content)).join(" ");
    expect(md).toContain("order");
    expect(md.toLowerCase()).toContain("protected");
  });

  test("Delete lives under a Danger zone section, ordered after Definition/Flow/Runs", () => {
    const tree = buildJobView("j1", jobFix({ id: "j1", enabled: true }), [run({ id: "run_9", jobId: "j1" })]);
    const sectionTitles = allNodes(tree.nodes).filter((n) => n.type === "section").map((n) => String(n.title));
    expect(sectionTitles).toContain("Flow");
    expect(sectionTitles).toContain("Danger zone");
    // Order: the Job/Actions definition precedes Flow, which precedes Runs, which
    // precedes Danger zone.
    expect(sectionTitles.indexOf("Flow")).toBeLessThan(sectionTitles.indexOf("Runs"));
    expect(sectionTitles.indexOf("Runs")).toBeLessThan(sectionTitles.indexOf("Danger zone"));
    // The Danger-zone section owns the Delete button.
    const danger = allNodes(tree.nodes).find((n) => n.type === "section" && String(n.title) === "Danger zone") as
      | { nodes: unknown[] }
      | undefined;
    const dangerButtons = buttonsDeep({ nodes: danger!.nodes });
    expect(dangerButtons.some((b) => b.action.event === JOB_DELETE_EVENT)).toBe(true);
  });

  test("a DISABLED job hides the Run now button (run-now requires an enabled job)", () => {
    const tree = buildJobView("j1", jobFix({ id: "j1", enabled: false }), []);
    expect(buttonsDeep(tree).some((b) => b.action.event === RUN_NOW_EVENT)).toBe(false);
  });

  test("global-hub run href when no projectId", () => {
    const tree = buildJobView("j1", jobFix({ id: "j1", enabled: true }), [run({ id: "run_9", jobId: "j1" })]);
    const runsTable = tablesDeep(tree).find((t) => t.columns[0] === "Run")!;
    expect(runsTable.rows[0]!.href).toBe(`/hub/${encodeURIComponent(FULL_PAGE_ID)}?run=run_9`);
  });
});

describe("prompt-field slug contract (host anti-spoof)", () => {
  // LITERAL copy of the host validator's PROMPT_FIELD_REGEX
  // (src/extensions/page-schema.ts:44 — the ext cannot import from src/). The
  // host SILENTLY rewrites any non-matching `prompt.field` to the reserved
  // "value" key, so a camelCase field would drop the typed value on the floor.
  // This test FAILS the moment a builder emits a non-slug prompt field again.
  const PROMPT_FIELD_REGEX = /^[a-z0-9][a-z0-9_]{0,31}$/;

  /** Every `prompt.field` a tree's button/table-row actions emit. */
  function promptFields(tree: { nodes: unknown[] }): string[] {
    const out: string[] = [];
    for (const n of allNodes(tree.nodes)) {
      if (n.type === "button") {
        const f = (n.action as { prompt?: { field?: string } } | undefined)?.prompt?.field;
        if (typeof f === "string") out.push(f);
      }
      if (n.type === "table") {
        for (const row of (n.rows as Array<{ action?: { prompt?: { field?: string } } }>)) {
          const f = row.action?.prompt?.field;
          if (typeof f === "string") out.push(f);
        }
      }
    }
    return out;
  }

  test("EVERY prompt field the config + job views emit is a slug-legal payload key", () => {
    const job = jobFix({ id: "j1", name: "N", enabled: true, agentName: "a", intentTemplate: "t" });
    const trees = [
      buildConfigView({ jobs: [job], runs: [], config: defaultPipelineConfig(), sweepHeartbeat: null, nowMs: Date.now(), extensionId: "ez-code-factory" }),
      buildJobView("j1", job, []),
    ];
    const fields = trees.flatMap(promptFields);
    // The job editor + the config's New-job button emit prompt fields — assert
    // the set is non-empty (so the walk is real) and every one is slug-legal.
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) {
      expect(f).toMatch(PROMPT_FIELD_REGEX);
    }
  });
});

describe("buildAuditView", () => {
  const bucket: AuditBucket = [
    { at: "2026-07-21T08:00:00.000Z", actor: "system", kind: "sweep", detail: { scanned: 2 } },
    { at: "2026-07-21T09:00:00.000Z", actor: "1a2b3c4d5e6f-user", kind: "respond", runId: "run_5", step: "review", detail: { action: "approve", findingIds: ["f1"] } },
  ];

  test("renders entries NEWEST-first with a truncated actor; the run row deep-links ?run=", () => {
    const tree = buildAuditView("2026-07-21", bucket, ["2026-07-21"], "proj-1");
    const table = tablesDeep(tree).find((t) => t.columns[0] === "When")!;
    // Newest first: the respond entry (09:00) leads.
    expect(table.rows[0]!.cells[2]).toBe("respond");
    // Actor truncated to `user 1a2b3c…` (never the full id).
    expect(table.rows[0]!.cells[1]).toBe("user 1a2b3c…");
    expect(String(table.rows[0]!.cells[1])).not.toContain("5e6f");
    // The run row deep-links its detail on the project hub.
    expect(table.rows[0]!.href).toBe(`/project/proj-1/hub/${encodeURIComponent(FULL_PAGE_ID)}?run=run_5`);
    // A system entry with no runId has no row href.
    expect(table.rows[1]!.cells[1]).toBe("system");
    expect(table.rows[1]!.href).toBeUndefined();
  });

  test("day nav links to older/newer days that HAVE buckets, and a Config link", () => {
    const days = ["2026-07-22", "2026-07-21", "2026-07-20"];
    const tree = buildAuditView("2026-07-21", bucket, days, undefined);
    const links = allNodes(tree.nodes).filter((n) => n.type === "link") as Array<{ label: string; href: string }>;
    expect(links.some((l) => l.href.includes(encodeURIComponent("audit:2026-07-20")))).toBe(true); // older
    expect(links.some((l) => l.href.includes(encodeURIComponent("audit:2026-07-22")))).toBe(true); // newer
    expect(links.some((l) => l.href.includes(encodeURIComponent("config")))).toBe(true);
  });

  test("an empty day renders an explicit empty state (no table)", () => {
    const tree = buildAuditView("2026-07-19", [], ["2026-07-21"], undefined);
    expect(allNodes(tree.nodes).some((n) => n.type === "empty-state")).toBe(true);
    expect(tablesDeep(tree).some((t) => t.columns[0] === "When")).toBe(false);
  });

  test("a leading truncation marker renders a muted 'dropped' note but is not an entry row", () => {
    const withMarker: AuditBucket = [
      { kind: "truncated", dropped: 7, at: "2026-07-21T00:00:00.000Z" },
      { at: "2026-07-21T10:00:00.000Z", actor: "system", kind: "sweep" },
    ];
    const tree = buildAuditView("2026-07-21", withMarker, ["2026-07-21"], undefined);
    const table = tablesDeep(tree).find((t) => t.columns[0] === "When")!;
    expect(table.rows).toHaveLength(1); // only the real entry
    expect(allNodes(tree.nodes).some((n) => n.type === "text" && String(n.content).includes("7 older"))).toBe(true);
  });

  test("an unserializable (circular) entry detail renders as '—' (never throws)", () => {
    // Defence-in-depth: a stored detail is clamped at the sink, but the view's
    // auditDetailText still guards JSON.stringify — a circular detail → em dash.
    const circular: Record<string, unknown> = { action: "approve" };
    circular.self = circular;
    const bucketC: AuditBucket = [{ at: "2026-07-21T11:00:00.000Z", actor: "system", kind: "respond", runId: "r9", detail: circular }];
    const tree = buildAuditView("2026-07-21", bucketC, ["2026-07-21"], undefined);
    const table = tablesDeep(tree).find((t) => t.columns[0] === "When")!;
    expect(table.rows[0]!.cells[5]).toBe("—"); // the Detail column
  });
});

describe("buildUnknownView", () => {
  test("renders an empty state (never throws) and clamps the echoed value", () => {
    const tree = buildUnknownView("x".repeat(300));
    expect(allNodes(tree.nodes).some((n) => n.type === "empty-state")).toBe(true);
  });
});

describe("XSS — view builders keep user/agent strings out of the markdown ({@html}) sink", () => {
  const XSS = `<img src=x onerror="alert('ezcf_view_xss')">`;
  function hits(tree: { nodes: unknown[] }) {
    return allNodes(tree.nodes).filter((n) => ownContent(n).includes(XSS));
  }
  test("a job name / branch pattern / intent template never reach a markdown node", () => {
    const job = jobFix({ id: "j1", name: XSS, trigger: { kind: "push", branchPattern: `feat/${XSS}` }, intentTemplate: XSS, enabled: true });
    const cfg = buildConfigView({ jobs: [job], runs: [], config: defaultPipelineConfig(), sweepHeartbeat: null, nowMs: Date.now(), extensionId: "ez-code-factory" });
    const jobView = buildJobView("j1", job, [run({ id: "run_x", jobId: "j1", branch: `feat/${XSS}` })]);
    for (const tree of [cfg, jobView]) {
      const hit = hits(tree);
      expect(hit.length).toBeGreaterThan(0); // the payload IS rendered somewhere…
      expect(hit.some((n) => n.type === "markdown")).toBe(false); // …never in a markdown sink
      for (const n of hit) expect(ESCAPED_PAGE_TYPES.has(n.type as string)).toBe(true);
    }
  });
  test("an audit entry's detail / actor / kind never reach a markdown node", () => {
    const bucket: AuditBucket = [{ at: "2026-07-21T00:00:00.000Z", actor: XSS, kind: XSS, detail: { note: XSS } }];
    const tree = buildAuditView("2026-07-21", bucket, ["2026-07-21"], undefined);
    const hit = hits(tree);
    expect(hit.some((n) => n.type === "markdown")).toBe(false);
    for (const n of hit) expect(ESCAPED_PAGE_TYPES.has(n.type as string)).toBe(true);
  });
});
