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
  reviewMainPromptBody,
  reviewFixPromptBody,
  testEvidencePromptBody,
  testFixPromptBody,
  lintColdPromptBody,
  lintFixPromptBody,
  documentPromptBody,
  DOCUMENT_PLACEMENT_POLICY,
  DOCUMENT_SCOPE_DISCIPLINE,
  HOUSEKEEPING_LINT_SECTION,
  REVIEW_FINDINGS_SCHEMA,
  COMMIT_SUMMARY_SCHEMA,
  PR_CONTENT_SCHEMA,
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
  test("pr-content schema requires title + body", () => {
    expect(PR_CONTENT_SCHEMA.required).toEqual(["title", "body"]);
  });
});

// ── per-step prompt bodies (extracted verbatim from the step files) ─────
//
// Byte-equality fixtures: each fixture under __fixtures__/prompts/ was
// independently proven equal to the PRE-extraction inline template (git
// @abf5dc5f) rendered with these same inputs, so any future drift in a builder
// breaks the fixture. `import.meta.dir` keeps the path stable per-file run.

const FX = `${import.meta.dir}/__fixtures__/prompts`;
const reviewBase = {
  branch: "feature/widget",
  baseCommit: "aaaa111",
  targetCommit: "bbbb222",
  reviewScope: "branch changes between aaaa111 and bbbb222",
  defaultBranch: "main",
  ignorePatterns: "*.md, dist/**",
  historySection: "",
};
const commit = { branch: "feature/widget", baseCommit: "aaaa111", targetCommit: "bbbb222" };
const prev = "prior finding text";

const bodyFixtures: { name: string; body: string }[] = [
  { name: "review-main.txt", body: reviewMainPromptBody(reviewBase) },
  { name: "review-fix.txt", body: reviewFixPromptBody({ ...reviewBase, previousFindings: prev }) },
  {
    name: "test-evidence.txt",
    body: testEvidencePromptBody({
      ...commit,
      configuredTestCommand: "\nConfigured test command already ran successfully as baseline: `bun test`\n",
      evidenceGuidance: "- Write new evidence files into this temporary evidence directory: /tmp/ev",
      reassessHistory: "",
    }),
  },
  { name: "test-fix.txt", body: testFixPromptBody({ ...commit, historySection: "", previousFindings: prev }) },
  { name: "lint-cold.txt", body: lintColdPromptBody({ ...commit, reassessHistory: "", previousFindings: prev }) },
  { name: "lint-fix.txt", body: lintFixPromptBody({ ...commit, historySection: "", previousFindings: prev }) },
  {
    name: "document-combined.txt",
    body: documentPromptBody({
      ...commit,
      defaultBranch: "main",
      ignoreLabel: "*.md, dist/**",
      combinedLint: true,
      trustedPolicy: "\n\nRepository documentation ownership policy (trusted, from the default branch):\nMy repo rules",
      historySection: "",
      previousFindings: prev,
    }),
  },
  {
    name: "document-plain.txt",
    body: documentPromptBody({
      ...commit,
      defaultBranch: "main",
      ignoreLabel: "none",
      combinedLint: false,
      trustedPolicy: "",
      historySection: "",
      previousFindings: "",
    }),
  },
];

describe("per-step prompt bodies — byte-equality fixtures", () => {
  for (const b of bodyFixtures) {
    test(`${b.name} renders byte-identical to the extracted fixture`, async () => {
      const want = await Bun.file(`${FX}/${b.name}`).text();
      expect(b.body).toBe(want);
    });
  }
});

describe("per-step prompt bodies — substitution + structure", () => {
  test("review-main interpolates every context field into the header", () => {
    const out = reviewMainPromptBody(reviewBase);
    expect(out.startsWith("Review the code changes")).toBe(true);
    expect(out).toContain("- branch: feature/widget");
    expect(out).toContain("- base commit: aaaa111");
    expect(out).toContain("- target commit: bbbb222");
    expect(out).toContain("- review scope: branch changes between aaaa111 and bbbb222");
    expect(out).toContain("- default branch: main");
    expect(out).toContain("- ignore patterns: *.md, dist/**");
  });

  test("history section appends verbatim at the tail", () => {
    const out = reviewMainPromptBody({ ...reviewBase, historySection: "\n\nHISTORY-XYZ" });
    expect(out.endsWith("\n\nHISTORY-XYZ")).toBe(true);
  });

  test("review-fix sanitizes raw previous findings (conflict markers collapsed)", () => {
    const out = reviewFixPromptBody({ ...reviewBase, previousFindings: "keep <<<<<<< drop" });
    expect(out).toContain("Previous review findings to address:");
    expect(out).not.toContain("<<<<<<<");
    expect(out).toContain("keep");
  });

  test("test-fix omits the previous-findings block when there are none", () => {
    const out = testFixPromptBody({ ...commit, historySection: "", previousFindings: "" });
    expect(out.startsWith("Fix the failing tests in this repository.")).toBe(true);
    expect(out).not.toContain("Previous test findings to address:");
  });

  test("test-fix includes the previous-findings block when present", () => {
    const out = testFixPromptBody({ ...commit, historySection: "", previousFindings: prev });
    expect(out).toContain("Previous test findings to address:");
    expect(out).toContain(prev);
  });

  test("test-evidence embeds the baseline-command + evidence-dir fragments", () => {
    const out = testEvidencePromptBody({
      ...commit,
      configuredTestCommand: "\nBASELINE-NOTE\n",
      evidenceGuidance: "- EVIDENCE-DIR-NOTE",
      reassessHistory: "\n\nREASSESS",
    });
    expect(out.startsWith("You are validating a code change by testing it.")).toBe(true);
    expect(out).toContain("BASELINE-NOTE");
    expect(out).toContain("- EVIDENCE-DIR-NOTE");
    expect(out.endsWith("\n\nREASSESS")).toBe(true);
  });

  test("lint-cold gates the previous-findings block on presence", () => {
    expect(lintColdPromptBody({ ...commit, reassessHistory: "", previousFindings: "" })).not.toContain(
      "Previous lint findings to address:",
    );
    const withPrev = lintColdPromptBody({ ...commit, reassessHistory: "", previousFindings: prev });
    expect(withPrev.startsWith("Detect the linting and formatting tools")).toBe(true);
    expect(withPrev).toContain("Previous lint findings to address:");
  });

  test("lint-fix gates the previous-findings block on presence", () => {
    expect(lintFixPromptBody({ ...commit, historySection: "", previousFindings: "" })).not.toContain(
      "Previous lint findings to address:",
    );
    const withPrev = lintFixPromptBody({ ...commit, historySection: "", previousFindings: prev });
    expect(withPrev.startsWith("Fix the lint issues in this repository.")).toBe(true);
    expect(withPrev).toContain("Previous lint findings to address:");
  });

  test("document combined-lint pass uses the housekeeping intro + lint duty + combined edit rule", () => {
    const out = documentPromptBody({
      ...commit,
      defaultBranch: "main",
      ignoreLabel: "none",
      combinedLint: true,
      trustedPolicy: "",
      historySection: "",
      previousFindings: "",
    });
    expect(out.startsWith("Perform the combined documentation and lint housekeeping pass for this change.")).toBe(true);
    expect(out).toContain(HOUSEKEEPING_LINT_SECTION);
    expect(out).toContain("Lint fixes must be safe, mechanical, and behavior-preserving");
  });

  test("document doc-only pass uses the doc intro + doc edit rule and omits the lint duty", () => {
    const out = documentPromptBody({
      ...commit,
      defaultBranch: "main",
      ignoreLabel: "none",
      combinedLint: false,
      trustedPolicy: "",
      historySection: "",
      previousFindings: "",
    });
    expect(out.startsWith("Keep the project documentation accurate for this change.")).toBe(true);
    expect(out).not.toContain(HOUSEKEEPING_LINT_SECTION);
    expect(out).toContain("- Only edit documentation files or doc comments.");
  });

  test("document embeds placement policy + scope discipline constants and the trusted policy", () => {
    const out = documentPromptBody({
      ...commit,
      defaultBranch: "main",
      ignoreLabel: "none",
      combinedLint: false,
      trustedPolicy: "\n\nTRUSTED-POLICY",
      historySection: "",
      previousFindings: prev,
    });
    expect(out).toContain(DOCUMENT_PLACEMENT_POLICY);
    expect(out).toContain(DOCUMENT_SCOPE_DISCIPLINE);
    expect(out).toContain("\n\nTRUSTED-POLICY");
    expect(out).toContain("Previous findings to address:");
  });
});
