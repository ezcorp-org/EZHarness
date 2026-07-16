import { test, expect, describe } from "bun:test";
import {
  stripAdversarial,
  redactSecrets,
  sanitizePromptText,
  sanitizePromptMultilineText,
  cleanedUserIntent,
  executionContextPromptSection,
  worktreeSteeringPreamble,
  userIntentPromptSection,
  intentConformanceReviewClause,
  roundHistoryPromptSection,
  sanitizedPreviousFindingsForPrompt,
  REVIEW_FINDINGS_SCHEMA,
  COMMIT_SUMMARY_SCHEMA,
} from "./prompts";
import { serializeFindings, deserializeFindings, type StepRoundRecord } from "./runs";

// ── adversarial + secret hygiene ────────────────────────────────────

describe("stripAdversarial", () => {
  test("neuters control delimiters + role tags", () => {
    const out = stripAdversarial("<|system|> <system>x</system> [INST]y[/INST]");
    // The delimiters are broken (neutered), not removed: <| → <<|, |> → |>>.
    expect(out).toContain("<<|");
    expect(out).toContain("|>>");
    expect(out).not.toContain("<system>");
    expect(out).not.toContain("[INST]");
    expect(out).toContain("<sys>");
    expect(out).toContain("[inst]");
  });
});

describe("redactSecrets", () => {
  test("redacts key=value, sk-, ghp_, AWS, JWT shapes", () => {
    expect(redactSecrets("api_key: ABCDEF0123456789")).toContain("[REDACTED]");
    expect(redactSecrets("sk-" + "a".repeat(24))).toBe("[REDACTED]");
    expect(redactSecrets("ghp_" + "b".repeat(24))).toBe("[REDACTED]");
    expect(redactSecrets("AKIA" + "0123456789ABCDEF")).toBe("[REDACTED]");
    expect(redactSecrets("eyJhbc.eyJdef.sig123")).toBe("[REDACTED]");
  });
  test("leaves ordinary text untouched", () => {
    expect(redactSecrets("just a normal sentence")).toBe("just a normal sentence");
  });
});

describe("sanitizePromptText / Multiline", () => {
  test("strips conflict markers + collapses whitespace", () => {
    expect(sanitizePromptText("a\t b  <<<<<<< c")).toBe("a b c");
  });
  test("multiline preserves line breaks but trims each line", () => {
    expect(sanitizePromptMultilineText("  a  b \r\n  c  ")).toBe("a b\nc");
  });
  test("======= and >>>>>>> markers are neutralized", () => {
    expect(sanitizePromptText("x ======= y >>>>>>> z")).toBe("x y z");
  });
});

describe("cleanedUserIntent", () => {
  test("empty / null → ''", () => {
    expect(cleanedUserIntent(null)).toBe("");
    expect(cleanedUserIntent("   ")).toBe("");
  });
  test("sanitizes, strips adversarial, redacts secrets", () => {
    const out = cleanedUserIntent("ship <|x|> feature; password: hunter2secret1");
    expect(out).toContain("<<|");
    expect(out).toContain("[REDACTED]");
  });
});

// ── static sections ─────────────────────────────────────────────────

describe("executionContextPromptSection", () => {
  test("describes the worktree .git pointer file", () => {
    const s = executionContextPromptSection();
    expect(s).toContain("isolated git worktree");
    expect(s).toContain("pointer file");
  });
});

describe("worktreeSteeringPreamble", () => {
  test("names the evidence dir and forbids out-of-tree writes", () => {
    const s = worktreeSteeringPreamble("/tmp/ezcf-evidence");
    expect(s).toContain("Workspace boundary");
    expect(s).toContain("/tmp/ezcf-evidence");
  });
});

// ── user intent framing ─────────────────────────────────────────────

describe("userIntentPromptSection", () => {
  test("empty intent → ''", () => {
    expect(userIntentPromptSection({ intent: "", authoritative: true })).toBe("");
  });
  test("authoritative framing uses acceptance-criteria language + BEGIN/END", () => {
    const s = userIntentPromptSection({ intent: "add a flag", authoritative: true });
    expect(s).toContain("AUTHORITATIVE acceptance criteria");
    expect(s).toContain("-----BEGIN USER INTENT-----");
    expect(s).toContain("-----END USER INTENT-----");
  });
  test("inferred framing uses hint language", () => {
    const s = userIntentPromptSection({ intent: "add a flag", authoritative: false });
    expect(s).toContain("treat as a hint, not ground truth");
    expect(s).not.toContain("AUTHORITATIVE acceptance criteria");
  });
});

describe("intentConformanceReviewClause", () => {
  test("emitted only for authoritative intent", () => {
    expect(intentConformanceReviewClause({ intent: "x", authoritative: false })).toBe("");
    expect(intentConformanceReviewClause({ intent: "", authoritative: true })).toBe("");
    const s = intentConformanceReviewClause({ intent: "x", authoritative: true });
    expect(s).toContain("Intent conformance (required)");
    expect(s).toContain('"ask-user"');
  });
});

// ── round history ───────────────────────────────────────────────────

function round(over: Partial<StepRoundRecord> = {}): StepRoundRecord {
  return {
    runId: "r1",
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

describe("roundHistoryPromptSection", () => {
  test("no rounds → ''", () => {
    expect(roundHistoryPromptSection([])).toBe("");
  });
  test("a bare round still renders its header line", () => {
    const s = roundHistoryPromptSection([round()]);
    expect(s).toContain("Round 1 (initial)");
    expect(s).not.toContain("findings:");
  });
  test("renders findings, fix_summary, and user selections", () => {
    const findings = serializeFindings(
      deserializeFindings({
        findings: [
          { id: "f1", severity: "warning", description: "keep me", action: "auto-fix" },
          { id: "f2", severity: "info", description: "ignore me", action: "no-op" },
        ],
      }),
    );
    const s = roundHistoryPromptSection([
      round({
        round: 2,
        trigger: "auto_fix",
        findingsJson: findings,
        fixSummary: "did a thing",
        selectedFindingIds: JSON.stringify(["f1"]),
        selectionSource: "user",
      }),
    ]);
    expect(s).toContain("Round 2 (auto_fix)");
    expect(s).toContain("fix_summary");
    expect(s).toContain("did a thing");
    expect(s).toContain("user_chose_to_fix");
    expect(s).toContain("user_chose_to_ignore");
    expect(s).toContain("f1");
  });
  test("auto_fix selection source renders auto_selected_to_fix", () => {
    const findings = serializeFindings(
      deserializeFindings({
        findings: [{ id: "f1", severity: "error", description: "d", action: "auto-fix" }],
      }),
    );
    const s = roundHistoryPromptSection([
      round({
        findingsJson: findings,
        selectedFindingIds: JSON.stringify(["f1"]),
        selectionSource: "auto_fix",
      }),
    ]);
    expect(s).toContain("auto_selected_to_fix");
  });
  test("user-added findings JSON drives the selected set; unknown selected id still listed", () => {
    const findings = serializeFindings(
      deserializeFindings({
        findings: [{ id: "f1", severity: "warning", description: "d", action: "auto-fix" }],
      }),
    );
    const userFindings = serializeFindings(
      deserializeFindings({
        findings: [{ id: "user-1", severity: "warning", description: "added", action: "auto-fix" }],
      }),
    );
    const s = roundHistoryPromptSection([
      round({
        findingsJson: findings,
        userFindingsJson: userFindings,
        selectedFindingIds: JSON.stringify(["user-1"]),
        selectionSource: "user",
      }),
    ]);
    // user-1 is not in the base findings, so it is surfaced as a bare id list.
    expect(s).toContain("user-1");
  });
  test("malformed selected-ids JSON is tolerated (no selection lines)", () => {
    const findings = serializeFindings(
      deserializeFindings({
        findings: [{ id: "f1", severity: "warning", description: "d", action: "auto-fix" }],
      }),
    );
    const s = roundHistoryPromptSection([
      round({ findingsJson: findings, selectedFindingIds: "{not json", selectionSource: "user" }),
    ]);
    expect(s).toContain("Round 1");
    expect(s).not.toContain("user_chose_to_fix");
  });
  test("malformed findings JSON yields the header but no finding lines", () => {
    const s = roundHistoryPromptSection([round({ findingsJson: "not-json", round: 3 })]);
    expect(s).toContain("Round 3 (initial)");
    expect(s).not.toContain("findings:");
  });
});

// ── sanitizedPreviousFindingsForPrompt ──────────────────────────────

describe("sanitizedPreviousFindingsForPrompt", () => {
  test("non-JSON input is sanitized as raw text", () => {
    expect(sanitizedPreviousFindingsForPrompt("<<<<<<< raw  text")).toBe("raw text");
  });
  test("parses findings and re-emits the wire shape with sanitized fields", () => {
    const raw = serializeFindings(
      deserializeFindings({
        findings: [
          {
            id: "f1",
            severity: "warning",
            file: "a.ts",
            description: "bad  <<<<<<< thing",
            action: "auto-fix",
            user_instructions: "do   it",
          },
        ],
        summary: "sum",
        risk_level: "low",
        risk_rationale: "ok",
      }),
    );
    const out = JSON.parse(sanitizedPreviousFindingsForPrompt(raw));
    expect(out.findings[0].description).toBe("bad thing");
    expect(out.findings[0].user_instructions).toBe("do it");
    expect(out.risk_level).toBe("low");
  });
});

// ── schemas are well-formed ─────────────────────────────────────────

describe("schemas", () => {
  test("review schema requires findings + risk fields", () => {
    expect(REVIEW_FINDINGS_SCHEMA.required).toEqual(["findings", "risk_level", "risk_rationale"]);
  });
  test("commit-summary schema requires summary", () => {
    expect(COMMIT_SUMMARY_SCHEMA.required).toEqual(["summary"]);
  });
});
