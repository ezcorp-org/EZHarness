import { test, expect, describe } from "bun:test";
import {
  MAX_PR_BODY_BYTES,
  byteLen,
  countFindingsBySeverity,
  buildStepLine,
  buildPipelineSection,
  totalPipelineRounds,
  buildRiskLine,
  buildTestingSection,
  prependIntent,
  truncateAtLineBoundary,
  assemblePRBody,
  stripGeneratedSections,
  unwrapNestedPRBody,
  fallbackTitle,
  type StepWithRounds,
} from "./pr-body";
import {
  deserializeFindings,
  emptyFindings,
  serializeFindings,
  type Findings,
  type StepResultRecord,
  type StepRoundRecord,
  type StepStatus,
} from "./runs";

// ── builders ─────────────────────────────────────────────────────────

function findings(over: Partial<Findings> = {}): Findings {
  return { ...emptyFindings(), ...over };
}

function stepResult(step: string, status: StepStatus, f: Findings = emptyFindings()): StepResultRecord {
  return {
    runId: "r1",
    step,
    status,
    findings: f,
    agentPid: null,
    autoFixLimit: 3,
    round: 0,
    autoFixAttempts: 0,
    executionMs: 0,
    fixSummary: null,
  };
}

function round(step: string, over: Partial<StepRoundRecord> = {}): StepRoundRecord {
  return {
    runId: "r1",
    step,
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

/** A round carrying findings (serialized to the canonical wire). */
function roundWith(step: string, items: Array<Record<string, unknown>>, over: Partial<StepRoundRecord> = {}): StepRoundRecord {
  return round(step, { findingsJson: serializeFindings(deserializeFindings({ findings: items })), ...over });
}

describe("byteLen", () => {
  test("counts bytes not runes", () => {
    expect(byteLen("ab")).toBe(2);
    expect(byteLen("✅")).toBe(3);
  });
});

describe("countFindingsBySeverity", () => {
  test("empty", () => expect(countFindingsBySeverity(emptyFindings())).toBe("0 issues"));
  test("single severity", () => {
    const f = deserializeFindings({ findings: [{ severity: "error", description: "a", action: "no-op" }] });
    expect(countFindingsBySeverity(f)).toBe("1 error");
  });
  test("single severity plural", () => {
    const f = deserializeFindings({
      findings: [
        { severity: "warning", description: "a", action: "no-op" },
        { severity: "warning", description: "b", action: "no-op" },
      ],
    });
    expect(countFindingsBySeverity(f)).toBe("2 warnings");
  });
  test("mixed severities", () => {
    const f = deserializeFindings({
      findings: [
        { severity: "error", description: "a", action: "no-op" },
        { severity: "warning", description: "b", action: "no-op" },
        { severity: "info", description: "c", action: "no-op" },
      ],
    });
    expect(countFindingsBySeverity(f)).toBe("3 issues (1 error, 1 warning, 1 info)");
  });
});

describe("buildStepLine", () => {
  const line = (sr: StepResultRecord, rounds: StepRoundRecord[] = []): string =>
    buildStepLine({ result: sr, rounds });

  test("non-terminal statuses", () => {
    expect(line(stepResult("rebase", "pending"))).toContain("pending");
    expect(line(stepResult("rebase", "running"))).toContain("running");
    expect(line(stepResult("review", "awaiting_approval"))).toContain("awaiting approval");
    expect(line(stepResult("test", "fixing"))).toContain("auto-fixing");
    expect(line(stepResult("test", "fix_review"))).toContain("review fix");
    expect(line(stepResult("lint", "failed"))).toContain("failed");
    expect(line(stepResult("document", "skipped"))).toContain("skipped");
  });
  test("unknown step name falls back to raw name", () => {
    expect(line(stepResult("mystery", "pending"))).toContain("mystery");
  });
  test("completed, no rounds → findings unavailable", () => {
    expect(line(stepResult("review", "completed"))).toContain("findings unavailable");
  });
  test("completed, passed (round with no findings)", () => {
    expect(line(stepResult("test", "completed"), [round("test")])).toContain("passed");
  });
  test("review completed with medium risk, no findings → risk line", () => {
    const sr = stepResult("review", "completed", findings({ riskLevel: "medium" }));
    expect(line(sr, [round("review")])).toContain("medium risk");
  });
  test("completed with remaining findings → count", () => {
    const f = deserializeFindings({ findings: [{ severity: "warning", description: "x", action: "ask-user" }] });
    const sr = stepResult("review", "completed", f);
    expect(line(sr, [roundWith("review", [{ severity: "warning", description: "x", action: "ask-user" }])])).toContain(
      "1 warning",
    );
  });
  test("was-fixed: initial had findings, final clear, >1 round", () => {
    const sr = stepResult("test", "completed"); // final empty
    const rounds = [
      roundWith("test", [
        { severity: "error", description: "boom", action: "auto-fix" },
        { severity: "error", description: "boom2", action: "auto-fix" },
      ]),
      round("test", { trigger: "auto_fix", fixSummary: "fixed it" }), // fix round, no findings
    ];
    expect(line(sr, rounds)).toContain("2 issues found → auto-fixed");
    expect(line(sr, rounds)).toContain("✅");
  });
});

describe("buildPipelineSection", () => {
  test("empty when only pr/ci steps", () => {
    expect(buildPipelineSection([{ result: stepResult("pr", "completed"), rounds: [] }])).toBe("");
  });
  test("renders steps, excludes pr/ci, includes signature", () => {
    const steps: StepWithRounds[] = [
      { result: stepResult("review", "completed"), rounds: [roundWith("review", [{ severity: "info", description: "note", action: "no-op" }])] },
      { result: stepResult("ci", "completed"), rounds: [] },
    ];
    const md = buildPipelineSection(steps);
    expect(md).toContain("## Pipeline");
    expect(md).toContain("git push gate");
    expect(md).toContain("<details>");
    expect(md).toContain("note");
    expect(md).not.toContain("**CI**");
  });
  test("omitOldest inserts an omission marker and drops oldest rounds", () => {
    const steps: StepWithRounds[] = [
      {
        result: stepResult("test", "completed"),
        rounds: [
          roundWith("test", [{ severity: "error", description: "old", action: "auto-fix" }]),
          roundWith("test", [{ severity: "error", description: "new", action: "auto-fix" }], { trigger: "auto_fix" }),
        ],
      },
    ];
    const md = buildPipelineSection(steps, 1);
    expect(md).toContain("1 earlier update round omitted");
    expect(md).not.toContain("old");
    expect(md).toContain("new");
  });
  test("omission marker pluralizes", () => {
    const steps: StepWithRounds[] = [
      { result: stepResult("test", "completed"), rounds: [round("test"), round("test"), round("test")] },
    ];
    expect(buildPipelineSection(steps, 2)).toContain("2 earlier update rounds omitted");
  });
  test("fix round still-open + fix-applied fallback + re-checked note", () => {
    const steps: StepWithRounds[] = [
      {
        result: stepResult("lint", "completed"),
        rounds: [
          roundWith("lint", [{ severity: "warning", description: "lint issue", action: "auto-fix" }]),
          roundWith("lint", [{ severity: "warning", description: "still bad", action: "auto-fix" }], {
            trigger: "auto_fix",
          }), // fix round with remaining findings + no fixSummary
          round("lint", { trigger: "auto_fix", fixSummary: "cleaned up" }), // fix round, cleared
        ],
      },
    ];
    const md = buildPipelineSection(steps);
    expect(md).toContain("🔧 Fix applied."); // no summary on the 2nd round
    expect(md).toContain("still open");
    expect(md).toContain("🔧 Fix: cleaned up");
    expect(md).toContain("Re-checked — no issues remain.");
  });
  test("malformed round findingsJson is treated as no findings (defensive parse)", () => {
    const steps: StepWithRounds[] = [
      { result: stepResult("review", "completed"), rounds: [round("review", { findingsJson: "{not valid json" })] },
    ];
    const md = buildPipelineSection(steps);
    expect(md).toContain("No issues found.");
  });
  test("findings with file:line render location", () => {
    const steps: StepWithRounds[] = [
      {
        result: stepResult("review", "completed"),
        rounds: [roundWith("review", [{ severity: "error", file: "a.ts", line: 12, description: "bad", action: "ask-user" }])],
      },
    ];
    expect(buildPipelineSection(steps)).toContain("`a.ts:12` - bad");
  });
});

describe("totalPipelineRounds", () => {
  test("sums non-pr/ci rounds", () => {
    const steps: StepWithRounds[] = [
      { result: stepResult("review", "completed"), rounds: [round("review"), round("review")] },
      { result: stepResult("ci", "completed"), rounds: [round("ci")] },
    ];
    expect(totalPipelineRounds(steps)).toBe(2);
  });
});

describe("buildRiskLine", () => {
  test("no review → ''", () => {
    expect(buildRiskLine([{ result: stepResult("test", "completed"), rounds: [] }])).toBe("");
  });
  test("review final findings carry risk + rationale", () => {
    const sr = stepResult("review", "completed", findings({ riskLevel: "high", riskRationale: "scary" }));
    expect(buildRiskLine([{ result: sr, rounds: [] }])).toBe("🚨 High: scary");
  });
  test("risk without rationale", () => {
    const sr = stepResult("review", "completed", findings({ riskLevel: "low" }));
    expect(buildRiskLine([{ result: sr, rounds: [] }])).toBe("✅ Low");
  });
  test("unknown risk level → info glyph", () => {
    const sr = stepResult("review", "completed", findings({ riskLevel: "elevated" }));
    expect(buildRiskLine([{ result: sr, rounds: [] }])).toBe("ℹ️ Elevated");
  });
  test("falls back to latest round risk when final is empty", () => {
    const sr = stepResult("review", "completed"); // empty final
    const rounds = [round("review", { findingsJson: serializeFindings(deserializeFindings({ risk_level: "medium", risk_rationale: "meh" })) })];
    expect(buildRiskLine([{ result: sr, rounds }])).toBe("⚠️ Medium: meh");
  });
  test("empty risk everywhere → ''", () => {
    const sr = stepResult("review", "completed");
    expect(buildRiskLine([{ result: sr, rounds: [round("review")] }])).toBe("");
  });
});

describe("buildTestingSection", () => {
  test("no test step → ''", () => {
    expect(buildTestingSection([{ result: stepResult("review", "completed"), rounds: [] }])).toBe("");
  });
  test("no evidence → ''", () => {
    expect(buildTestingSection([{ result: stepResult("test", "completed"), rounds: [] }])).toBe("");
  });
  test("summary + tested (dedup) + url + inline artifacts", () => {
    const f = findings({
      testingSummary: "all green",
      tested: ["bun test", "bun test", "`bunx tsc`"],
      artifacts: ["https://ci/run/1", "logs: 3 passing", "  "],
    });
    const md = buildTestingSection([{ result: stepResult("test", "completed", f), rounds: [] }]);
    expect(md).toContain("## Testing");
    expect(md).toContain("all green");
    expect(md).toContain("- `bun test`");
    expect(md).toContain("- `bunx tsc`");
    expect(md).toContain("- Evidence: https://ci/run/1");
    expect(md).toContain("- Evidence: `logs: 3 passing`");
    // deduped: only one `bun test`
    expect(md.match(/- `bun test`/g)!.length).toBe(1);
  });
  test("summary from a later round when final has none", () => {
    const sr = stepResult("test", "completed"); // no evidence on final
    const rounds = [
      round("test", { findingsJson: serializeFindings(deserializeFindings({ testing_summary: "round summary", tested: ["x"] })) }),
    ];
    const md = buildTestingSection([{ result: sr, rounds }]);
    expect(md).toContain("round summary");
    expect(md).toContain("- `x`");
  });
  test("blank tested entry skipped", () => {
    const f = findings({ tested: ["  "], testingSummary: "s" });
    const md = buildTestingSection([{ result: stepResult("test", "completed", f), rounds: [] }]);
    expect(md).toContain("## Testing");
    expect(md).not.toContain("- ``");
  });
});

describe("prependIntent", () => {
  test("no intent → body unchanged", () => expect(prependIntent("body", "")).toBe("body"));
  test("empty body → intent only", () => expect(prependIntent("  ", "goal")).toBe("## Intent\n\ngoal"));
  test("both", () => expect(prependIntent("body", "goal")).toBe("## Intent\n\ngoal\n\nbody"));
});

describe("truncateAtLineBoundary", () => {
  test("maxBytes<=0 → ''", () => expect(truncateAtLineBoundary("abc", 0, "m")).toBe(""));
  test("fits → unchanged", () => expect(truncateAtLineBoundary("abc", 100, "m")).toBe("abc"));
  test("cuts on newline boundary + marker", () => {
    const text = "line one\nline two is quite long here\nline three";
    const out = truncateAtLineBoundary(text, 20, "MARK");
    expect(out).toContain("line one");
    expect(out).toContain("MARK");
    expect(out).not.toContain("line three");
  });
  test("no marker", () => {
    const out = truncateAtLineBoundary("aaaa\nbbbb\ncccc", 6, "");
    expect(out).not.toContain("cccc");
  });
  test("available<=0 with marker fitting → bare marker", () => {
    // maxBytes smaller than the "\n\n" + marker overhead but >= marker length.
    const out = truncateAtLineBoundary("xxxxxxxxxx", 4, "mm");
    expect(out).toBe("mm");
  });
  test("available<=0 and marker too big → ''", () => {
    const out = truncateAtLineBoundary("xxxxxxxxxx", 1, "marker-way-too-long");
    expect(out).toBe("");
  });
  test("cut with no newline keeps head", () => {
    const out = truncateAtLineBoundary("abcdefghijklmnop", 10, "M");
    expect(out).toContain("M");
    expect(out.startsWith("abc")).toBe(true);
  });
});

describe("stripGeneratedSections", () => {
  test("empty → ''", () => expect(stripGeneratedSections("")).toBe(""));
  test("removes generated sections, keeps What Changed", () => {
    const body = [
      "## What Changed",
      "",
      "- a change",
      "## Intent",
      "",
      "the goal",
      "## Risk Assessment",
      "",
      "risky",
      "## Custom",
      "",
      "kept",
    ].join("\n");
    const out = stripGeneratedSections(body);
    expect(out).toContain("## What Changed");
    expect(out).toContain("- a change");
    expect(out).toContain("## Custom");
    expect(out).toContain("kept");
    expect(out).not.toContain("## Intent");
    expect(out).not.toContain("## Risk Assessment");
  });
  test("skipping ends at the next non-heading only via a new heading", () => {
    const body = ["## Testing", "", "dropped line", "still dropped"].join("\n");
    expect(stripGeneratedSections(body)).toBe("");
  });
});

describe("unwrapNestedPRBody", () => {
  test("plain body unchanged", () => expect(unwrapNestedPRBody("## What")).toBe("## What"));
  test("empty unchanged", () => expect(unwrapNestedPRBody("")).toBe(""));
  test("nested JSON extracted", () => {
    expect(unwrapNestedPRBody(JSON.stringify({ title: "t", body: "## Real" }))).toBe("## Real");
  });
  test("nested JSON with blank body → original", () => {
    const raw = JSON.stringify({ title: "t", body: "  " });
    expect(unwrapNestedPRBody(raw)).toBe(raw);
  });
  test("malformed leading-brace JSON → original", () => {
    expect(unwrapNestedPRBody("{not json")).toBe("{not json");
  });
});

describe("fallbackTitle", () => {
  test("uses first commit subject, tightened", () => {
    expect(fallbackTitle("abc123 add a widget\ndef fix\n", "feat/x")).toBe("feat: add a widget");
  });
  test("commit log with no space token → branch", () => {
    expect(fallbackTitle("\n   \n", "feat/my-branch")).toBe("chore: feat/my-branch");
  });
  test("no commit log, no branch → default", () => {
    expect(fallbackTitle("", "  ")).toBe("chore: update pull request");
  });
});

describe("assemblePRBody ladder", () => {
  const testStep = (summary: string): StepWithRounds => ({
    result: stepResult("test", "completed", findings({ testingSummary: summary, tested: ["t"] })),
    rounds: [],
  });

  test("1. full body fits", () => {
    const body = assemblePRBody({
      cleanedIntent: "do the thing",
      whatChanged: "## What Changed\n\n- a change",
      steps: [
        { result: stepResult("review", "completed", findings({ riskLevel: "low", riskRationale: "fine" })), rounds: [] },
        testStep("all green"),
      ],
    });
    expect(body).toContain("## Intent");
    expect(body).toContain("do the thing");
    expect(body).toContain("## What Changed");
    expect(body).toContain("## Risk Assessment");
    expect(body).toContain("✅ Low: fine");
    expect(body).toContain("## Testing");
    expect(body).toContain("## Pipeline");
    expect(byteLen(body)).toBeLessThanOrEqual(MAX_PR_BODY_BYTES);
  });

  test("2. drops Testing when full overruns but core fits", () => {
    const hugeSummary = "x".repeat(MAX_PR_BODY_BYTES + 100);
    const body = assemblePRBody({
      cleanedIntent: "",
      whatChanged: "## What Changed\n\n- small",
      steps: [{ result: stepResult("review", "completed", findings({ riskLevel: "low" })), rounds: [] }, testStep(hugeSummary)],
    });
    expect(body).not.toContain("## Testing");
    expect(body).toContain("## What Changed");
    expect(byteLen(body)).toBeLessThanOrEqual(MAX_PR_BODY_BYTES);
  });

  test("3. drops oldest pipeline rounds", () => {
    // Many review rounds, each ~5KB, so core (no testing) overruns but dropping
    // the oldest rounds brings it under the cap.
    const bigDesc = "d".repeat(5000);
    const rounds: StepRoundRecord[] = [];
    for (let i = 0; i < 20; i++) {
      rounds.push(roundWith("review", [{ severity: "warning", description: `${bigDesc}-${i}`, action: "auto-fix" }], { round: i + 1, trigger: i === 0 ? "initial" : "auto_fix" }));
    }
    const body = assemblePRBody({
      cleanedIntent: "",
      whatChanged: "## What Changed\n\n- small",
      steps: [{ result: stepResult("review", "completed"), rounds }, testStep("x".repeat(70000))],
    });
    expect(body).toContain("earlier update");
    expect(byteLen(body)).toBeLessThanOrEqual(MAX_PR_BODY_BYTES);
  });

  test("4. hard-truncates when even the minimal body overruns", () => {
    const huge = "## What Changed\n\n" + "z\n".repeat(40000); // > cap on its own
    const body = assemblePRBody({
      cleanedIntent: "goal",
      whatChanged: huge,
      steps: [{ result: stepResult("review", "completed"), rounds: [round("review")] }],
    });
    expect(byteLen(body)).toBeLessThanOrEqual(MAX_PR_BODY_BYTES);
    expect(body).toContain("body truncated");
  });
});
