/**
 * The quality-gate reporters must fail closed.
 *
 *   scripts/quality-report.ts  — an EXPECTED gate that wrote no report is a
 *                                failure with a finding naming it, never a
 *                                silent PASS. (The nightly reported
 *                                "PASS / No failures" on a run where every
 *                                gate had died: this suite is that bug's
 *                                acceptance test.)
 *   scripts/mutation.ts        — --report-only suppresses ONLY a threshold
 *                                verdict. A Stryker exit with no report is an
 *                                infrastructure failure and still fails.
 *                                --shard I/N partitions the scope exactly.
 *   scripts/merge-mutation-reports.ts
 *                              — the nightly's N shard reports merge into one
 *                                without overlap, and score the way Stryker
 *                                scores.
 *
 * Both scripts export their decision logic as pure functions, so this is
 * fixture-driven and touches no files.
 */
import { describe, expect, test } from "bun:test";
import { mergeMutationReports } from "../../scripts/merge-mutation-reports.ts";
import {
  filesWithoutCoverage,
  mutationExitCode,
  parseShard,
  shardOf,
} from "../../scripts/mutation.ts";
import {
  buildSummary,
  type CrapReport,
  type CoverageReport,
  GATE_NAMES,
  type MutationReport,
  mutationTotals,
  parseExpected,
  renderText,
  type SummaryInputs,
} from "../../scripts/quality-report.ts";

const passingCoverage: CoverageReport = {
  threshold: 90,
  linePct: 97.33,
  passed: true,
  coveredLines: 970,
  totalLines: 1000,
  worstByMissingLines: [],
};

const passingCrap: CrapReport = {
  scope: "all",
  mode: "full-repo-ratchet",
  passed: true,
  thresholds: { maxScore: 30, warnScore: 15, maxFullRepoViolations: 83 },
  totals: { violations: 1, functionsScored: 9505 },
  violations: [
    {
      file: "src/legacy.ts",
      name: "tangle",
      line: 12,
      complexity: 9,
      coverage: 0.4,
      uncoveredLines: [13, 14, 15],
      crap: 26.5,
    },
  ],
};

const mutantAt = (line: number, status: string, replacement = "a < b") => ({
  id: `${line}-${status}`,
  mutatorName: "EqualityOperator",
  replacement,
  status,
  location: { start: { line, column: 44 }, end: { line, column: 50 } },
});

/** 2 killed, 1 survived, 1 no-coverage → 50%, under an 80% threshold. */
const failingMutation: MutationReport = {
  files: {
    "src/lib/x.ts": {
      source: "export const f = (a: number, b: number) => a <= b;\nexport const g = (a: number, b: number) => a <= b;\n",
      mutants: [
        mutantAt(1, "Killed"),
        mutantAt(1, "Timeout"),
        mutantAt(2, "NoCoverage"),
        mutantAt(1, "Survived"),
      ],
    },
  },
};

function inputs(over: Partial<SummaryInputs>): SummaryInputs {
  return {
    expected: ["coverage", "crap", "mutation"],
    coverage: passingCoverage,
    crap: passingCrap,
    mutation: null,
    mutationSkipped: null,
    mutationThreshold: 80,
    limit: 25,
    generatedAt: "2026-09-20T00:00:00.000Z",
    ...over,
  };
}

describe("parseExpected", () => {
  test("accepts a comma list of known gates in the given order", () => {
    expect(parseExpected(["--text", "--expect", "mutation,crap"])).toEqual(["mutation", "crap"]);
    expect(parseExpected(["--expect", " coverage , crap "])).toEqual(["coverage", "crap"]);
  });

  test("is required — no flag, a dangling flag, and a flag followed by another flag all throw", () => {
    expect(() => parseExpected(["--text"])).toThrow(/--expect <gate,...> is required/);
    expect(() => parseExpected(["--expect"])).toThrow(/is required/);
    expect(() => parseExpected(["--expect", "--text"])).toThrow(/is required/);
  });

  test("rejects an unknown gate, an empty list, and a duplicate", () => {
    expect(() => parseExpected(["--expect", "coverage,lint"])).toThrow(/unknown gate "lint"/);
    expect(() => parseExpected(["--expect", ","])).toThrow(/empty gate list/);
    expect(() => parseExpected(["--expect", "crap,crap"])).toThrow(/listed twice/);
  });

  test("every gate name the summary knows is accepted", () => {
    expect(parseExpected(["--expect", GATE_NAMES.join(",")])).toEqual([...GATE_NAMES]);
  });
});

describe("buildSummary — fail closed on a missing report", () => {
  test("every expected gate present and passing → pass, nothing missing", () => {
    const s = buildSummary(
      inputs({ expected: ["coverage", "crap"], mutation: null }),
    );
    expect(s.status).toBe("pass");
    expect(s.expected).toEqual(["coverage", "crap"]);
    expect(s.missing).toEqual([]);
    expect(s.totals.errors).toBe(0);
    // A passing ratchet's frozen debt is a warning, never an error.
    expect(s.totals.warnings).toBe(1);
    expect(s.warningsSample[0]?.gate).toBe("crap");
  });

  test("the nightly's case: mutation expected, no report → FAIL naming the gate", () => {
    const s = buildSummary(inputs({ expected: ["mutation"], coverage: null, crap: null }));
    expect(s.status).toBe("fail");
    expect(s.missing).toEqual(["mutation"]);
    expect(s.gates.mutation).toEqual({ ran: false });
    expect(s.findings).toHaveLength(1);
    const f = s.findings[0];
    expect(f?.gate).toBe("mutation");
    expect(f?.severity).toBe("error");
    expect(f?.file).toBe("coverage/quality/mutation.json");
    expect(f?.what).toMatch(/expected to run but wrote no report/);
    expect(f?.what).toMatch(/not a pass/);
  });

  test("one of several gates missing is enough to fail, and each missing gate gets its own finding", () => {
    const s = buildSummary(inputs({ crap: null, mutation: null }));
    expect(s.status).toBe("fail");
    expect(s.missing).toEqual(["crap", "mutation"]);
    expect(s.findings.map((f) => f.gate)).toEqual(["crap", "mutation"]);
    // The gate that DID run is still summarised.
    expect(s.gates.coverage).toEqual({ passed: true, linePct: 97.33, threshold: 90 });
  });

  test("a skipped-diff receipt satisfies the mutation gate without a score", () => {
    const s = buildSummary(
      inputs({
        expected: ["mutation"],
        mutationSkipped: { skipped: true, reason: "no mutatable files in diff" },
      }),
    );
    expect(s.status).toBe("pass");
    expect(s.missing).toEqual([]);
    expect(s.gates.mutation).toEqual({ skipped: true, reason: "no mutatable files in diff" });
  });

  test("a receipt that is not `skipped: true` does not count as a report", () => {
    const s = buildSummary(
      inputs({
        expected: ["mutation"],
        mutationSkipped: { skipped: false as unknown as true, reason: "x" },
      }),
    );
    expect(s.status).toBe("fail");
    expect(s.missing).toEqual(["mutation"]);
  });

  test("a report for a gate that was NOT expected is not read", () => {
    const failingCoverage: CoverageReport = {
      ...passingCoverage,
      passed: false,
      linePct: 50,
      worstByMissingLines: [{ file: "src/a.ts", pct: 10, missing: 90 }],
    };
    const s = buildSummary(inputs({ expected: ["crap"], coverage: failingCoverage }));
    expect(s.status).toBe("pass");
    expect(s.gates).not.toHaveProperty("coverage");
  });
});

describe("buildSummary — gate verdicts", () => {
  test("a failing coverage floor lists the worst files as errors", () => {
    const s = buildSummary(
      inputs({
        expected: ["coverage"],
        coverage: {
          ...passingCoverage,
          passed: false,
          linePct: 88.5,
          worstByMissingLines: [
            { file: "src/a.ts", pct: 10, missing: 90 },
            { file: "src/b.ts", pct: 50, missing: 20 },
          ],
        },
      }),
    );
    expect(s.status).toBe("fail");
    expect(s.findings.map((f) => f.file)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(s.findings[0]?.what).toMatch(/88\.50%, below the 90% floor/);
  });

  test("a broken CRAP ratchet promotes its violations to errors with the right lever", () => {
    const s = buildSummary(
      inputs({
        expected: ["crap"],
        crap: {
          ...passingCrap,
          passed: false,
          violations: [
            ...passingCrap.violations,
            {
              file: "src/tested.ts",
              name: "wide",
              line: 3,
              complexity: 40,
              coverage: 1,
              uncoveredLines: [],
              crap: 40,
            },
          ],
        },
      }),
    );
    expect(s.status).toBe("fail");
    expect(s.findings).toHaveLength(2);
    expect(s.findings[0]?.fix).toMatch(/^Add tests for the uncovered lines in tangle\(\) \(13, 14, 15\)/);
    expect(s.findings[1]?.fix).toMatch(/^Split wide\(\)/);
  });

  test("a mutation score under the threshold reports survivors before NoCoverage, quoting the code", () => {
    const s = buildSummary(inputs({ expected: ["mutation"], mutation: failingMutation }));
    expect(s.status).toBe("fail");
    expect(s.gates.mutation).toEqual({
      score: 50,
      threshold: 80,
      passed: false,
      killed: 1,
      timeout: 1,
      survived: 1,
      noCoverage: 1,
    });
    expect(s.findings.map((f) => f.detail?.status)).toEqual(["Survived", "NoCoverage"]);
    expect(s.findings[0]?.file).toBe("web/src/lib/x.ts");
    expect(s.findings[0]?.what).toBe(
      "Surviving EqualityOperator mutant: the suite still passes when `a <= b` becomes `a < b`.",
    );
    expect(s.findings[1]?.what).toMatch(/^No test executes this code/);
  });

  test("a passing mutation score records survivors as warnings", () => {
    const s = buildSummary(inputs({ expected: ["mutation"], mutation: failingMutation, mutationThreshold: 50 }));
    expect(s.status).toBe("pass");
    expect(s.totals.warnings).toBe(2);
    expect((s.gates.mutation as { passed: boolean }).passed).toBe(true);
  });

  test("--limit caps the findings and flags truncation", () => {
    const s = buildSummary(inputs({ expected: ["mutation"], mutation: failingMutation, limit: 1 }));
    expect(s.findings).toHaveLength(1);
    expect(s.truncated).toBe(true);
    expect(s.totals).toEqual({ errors: 2, warnings: 0, reported: 1 });
  });
});

describe("renderText", () => {
  test("names the expected gates and the missing ones on a failure", () => {
    const s = buildSummary(inputs({ expected: ["coverage", "crap"], crap: null }));
    const text = renderText(s, 25);
    expect(text).toContain("=== Quality gates: FAIL ===");
    expect(text).toContain("expected: coverage, crap");
    expect(text).toContain("MISSING REPORT: crap");
    expect(text).toContain("[crap] coverage/quality/crap.json");
  });

  test("a clean run says so and counts known debt", () => {
    const s = buildSummary(inputs({ expected: ["coverage", "crap"] }));
    const text = renderText(s, 25);
    expect(text).toContain("=== Quality gates: PASS ===");
    expect(text).not.toContain("MISSING REPORT");
    expect(text).toContain("No failures. (1 known-debt warning(s) recorded, not blocking.)");
  });
});

describe("mutationExitCode — --report-only suppresses only the threshold verdict", () => {
  const ok = { status: 0, signal: null };
  const under = { status: 1, signal: null };

  test("a clean exit is 0 either way", () => {
    expect(mutationExitCode(ok, { reportProduced: true, reportOnly: false }).code).toBe(0);
    expect(mutationExitCode(ok, { reportProduced: false, reportOnly: true }).code).toBe(0);
  });

  test("a genuine low score: fails normally, passes under --report-only", () => {
    expect(mutationExitCode(under, { reportProduced: true, reportOnly: false })).toEqual({
      code: 1,
      reason: "Stryker exited 1: score under the break threshold",
    });
    const v = mutationExitCode(under, { reportProduced: true, reportOnly: true });
    expect(v.code).toBe(0);
    expect(v.reason).toMatch(/--report-only.*threshold verdict/);
  });

  test("a non-zero exit with NO report is an infrastructure failure — --report-only does not apply", () => {
    for (const reportOnly of [false, true]) {
      const v = mutationExitCode(under, { reportProduced: false, reportOnly });
      expect(v.code).toBe(1);
      expect(v.reason).toMatch(/without writing .*mutation\.json/);
      expect(v.reason).toMatch(/--report-only does not apply/);
    }
  });

  test("a process that never started (null status) fails", () => {
    const v = mutationExitCode({ status: null, signal: null }, { reportProduced: false, reportOnly: true });
    expect(v.code).toBe(1);
  });

  test("a signal kill fails even with a report and --report-only", () => {
    const v = mutationExitCode({ status: null, signal: "SIGKILL" }, { reportProduced: true, reportOnly: true });
    expect(v).toEqual({ code: 1, reason: "Stryker was killed by SIGKILL — nothing was measured" });
  });

  test("a non-1 infrastructure exit code is passed through, not normalised", () => {
    expect(mutationExitCode({ status: 127, signal: null }, { reportProduced: false, reportOnly: true }).code).toBe(127);
  });
});

describe("mutationTotals — scores the way Stryker does", () => {
  test("timeouts count as killed, NoCoverage counts against", () => {
    expect(mutationTotals(failingMutation)).toEqual({
      killed: 1,
      timeout: 1,
      survived: 1,
      noCoverage: 1,
      score: 50,
    });
  });

  test("no mutants is 100, not a division by zero", () => {
    expect(mutationTotals({ files: {} }).score).toBe(100);
    expect(mutationTotals({ files: { "a.ts": { source: "", mutants: [] } } }).score).toBe(100);
  });
});

describe("filesWithoutCoverage — the scope-error detector", () => {
  test("lists only files whose every mutant is NoCoverage", () => {
    const report: MutationReport = {
      files: {
        "src/lib/dead.ts": { source: "", mutants: [mutantAt(1, "NoCoverage"), mutantAt(2, "NoCoverage")] },
        "src/lib/live.ts": { source: "", mutants: [mutantAt(1, "NoCoverage"), mutantAt(2, "Killed")] },
        "src/lib/empty.ts": { source: "", mutants: [] },
      },
    };
    expect(filesWithoutCoverage(report)).toEqual(["src/lib/dead.ts"]);
    expect(filesWithoutCoverage({})).toEqual([]);
  });
});

describe("parseShard / shardOf — a deterministic, exact partition", () => {
  test("parses I/N and rejects everything else", () => {
    expect(parseShard("2/6")).toEqual({ index: 2, count: 6 });
    expect(parseShard("0/1")).toEqual({ index: 0, count: 1 });
    for (const bad of [undefined, "", "6/6", "7/6", "1/0", "a/b", "1", "1/2/3", "-1/2"]) {
      expect(() => parseShard(bad)).toThrow(/--shard/);
    }
  });

  test("every item lands in exactly one shard, round-robin over the input order", () => {
    const files = Array.from({ length: 17 }, (_, i) => `f${String(i).padStart(2, "0")}.ts`);
    const count = 6;
    const shards = Array.from({ length: count }, (_, index) => shardOf(files, { index, count }));
    expect(shards[0]).toEqual(["f00.ts", "f06.ts", "f12.ts"]);
    expect(shards[5]).toEqual(["f05.ts", "f11.ts"]);
    const all = shards.flat().sort();
    expect(all).toEqual([...files].sort());
    expect(new Set(all).size).toBe(files.length);
    // Same input, same slices — N jobs can agree with no coordination.
    expect(shardOf(files, { index: 3, count })).toEqual(shards[3] as string[]);
  });

  test("one shard is the whole list; more shards than items leaves empty slices", () => {
    expect(shardOf(["a", "b"], { index: 0, count: 1 })).toEqual(["a", "b"]);
    expect(shardOf(["a", "b"], { index: 2, count: 3 })).toEqual([]);
  });
});

describe("mergeMutationReports — the nightly's N reports become one", () => {
  const shardA: MutationReport = {
    files: { "src/lib/a.ts": { source: "a", mutants: [mutantAt(1, "Killed"), mutantAt(1, "Survived")] } },
  };
  const shardB: MutationReport = {
    files: { "src/lib/b.ts": { source: "b", mutants: [mutantAt(1, "Killed")] } },
  };

  test("unions the files and keeps the first report's envelope", () => {
    const merged = mergeMutationReports([{ ...shardA, projectRoot: "/x" }, shardB]);
    expect(Object.keys(merged.files).sort()).toEqual(["src/lib/a.ts", "src/lib/b.ts"]);
    expect(merged.projectRoot).toBe("/x");
    expect(mutationTotals(merged)).toEqual({ killed: 2, timeout: 0, survived: 1, noCoverage: 0, score: (2 / 3) * 100 });
  });

  test("a file present in two reports is an overlap error, not a silent overwrite", () => {
    expect(() => mergeMutationReports([shardA, shardA])).toThrow(/appears in more than one shard/);
  });

  test("nothing to merge is an error", () => {
    expect(() => mergeMutationReports([])).toThrow(/nothing to merge/);
  });
});
