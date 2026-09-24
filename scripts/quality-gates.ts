#!/usr/bin/env bun
/**
 * Shared plumbing for the quality gates defined in scripts/quality-gates.json.
 *
 * Every gate script (crap-score.ts, check-global-coverage.ts, mutation.ts,
 * quality-report.ts) reads its numbers from here so the thresholds have exactly
 * ONE home. Nothing in this module enforces anything — it only loads config,
 * resolves the lcov the coverage pipeline already produced, and answers "what
 * did this PR change?".
 *
 * The lcov reader deliberately reuses coverage-config.ts rather than
 * re-parsing: `parseLcov` and `parseHitLines` are the same functions the
 * per-file coverage gate trusts, so a CRAP score can never disagree with the
 * coverage gate about whether a line is covered.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  type FileCov,
  isExcluded,
  parseHitLines,
  parseLcov,
  REPO_ROOT,
} from "./coverage-config.ts";
import { parseUnifiedDiff } from "./unified-diff.ts";

export const GATES_PATH = resolve(REPO_ROOT, "scripts/quality-gates.json");
export const LCOV_PATH = resolve(REPO_ROOT, "coverage/lcov.info");

/** Where every gate writes its machine-readable report. */
export const REPORT_DIR = resolve(REPO_ROOT, "coverage/quality");

/** Every quality gate name. Derive the type so the runtime list cannot drift. */
export const GATE_NAMES = ["coverage", "crap", "mutation"] as const;
export type GateName = (typeof GATE_NAMES)[number];

/** The report file each gate is responsible for writing. */
export const MUTATION_REPORT_FILE = "mutation.json";
export const MUTATION_SKIPPED_FILE = "mutation-summary.json";
export const GATE_REPORT_FILE: Readonly<Record<GateName, string>> = {
  coverage: "global-coverage.json",
  crap: "crap.json",
  mutation: MUTATION_REPORT_FILE,
};

export type QualityGates = {
  coverage: { globalLineThreshold: number };
  crap: {
    maxScore: number;
    warnScore: number;
    maxFullRepoViolations: number;
    enforceGlobs: string[];
  };
  mutation: { scoreThreshold: number; prBudgetMinutes: number; mutateGlobs: string[] };
};

/**
 * Load and validate scripts/quality-gates.json.
 *
 * FAIL-CLOSED: a missing file, malformed JSON, or a non-numeric threshold is a
 * hard error, never a silent default. A gate that read `undefined` as `0` would
 * pass everything — the exact failure mode gate-integrity.ts exists to prevent.
 */
export async function loadGates(): Promise<QualityGates> {
  if (!existsSync(GATES_PATH)) {
    throw new Error(`quality gate config missing: ${GATES_PATH}`);
  }
  const raw = JSON.parse(await Bun.file(GATES_PATH).text()) as QualityGates;

  const requireNum = (v: unknown, path: string): void => {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`quality-gates.json: ${path} must be a finite number, got ${String(v)}`);
    }
  };
  requireNum(raw.coverage?.globalLineThreshold, "coverage.globalLineThreshold");
  requireNum(raw.crap?.maxScore, "crap.maxScore");
  requireNum(raw.crap?.warnScore, "crap.warnScore");
  requireNum(raw.crap?.maxFullRepoViolations, "crap.maxFullRepoViolations");
  requireNum(raw.mutation?.scoreThreshold, "mutation.scoreThreshold");
  requireNum(raw.mutation?.prBudgetMinutes, "mutation.prBudgetMinutes");
  if (!Array.isArray(raw.crap?.enforceGlobs) || raw.crap.enforceGlobs.length === 0) {
    throw new Error("quality-gates.json: crap.enforceGlobs must be a non-empty array");
  }
  if (!Array.isArray(raw.mutation?.mutateGlobs) || raw.mutation.mutateGlobs.length === 0) {
    throw new Error("quality-gates.json: mutation.mutateGlobs must be a non-empty array");
  }
  return raw;
}

export type LcovData = {
  /** repo-relative path → DA totals + missed line numbers. */
  perFile: Map<string, FileCov>;
  /** repo-relative path → set of line numbers with >0 hits. */
  hits: Map<string, Set<number>>;
  /** repo-relative path → every line number carrying a DA record. */
  measured: Map<string, Set<number>>;
};

/**
 * Read coverage/lcov.info once and expose the three views the gates need.
 *
 * `measured` is hits ∪ missed: the set of lines the instrumenter actually
 * emitted a record for. CRAP needs it to score a function against only the
 * lines coverage can see — counting a blank line, a comment, or a type-only
 * line as "uncovered" would inflate every score in the repo.
 */
export async function loadLcov(lcovPath = LCOV_PATH): Promise<LcovData> {
  if (!existsSync(lcovPath)) {
    throw new Error(
      `coverage/lcov.info not found at ${lcovPath} — run \`bun run test:coverage\` first ` +
        `(or download the lcov-cov-* CI artifacts and merge them with scripts/merge-lcov.ts).`,
    );
  }
  const text = await Bun.file(lcovPath).text();
  const perFile = parseLcov(text);
  const hits = parseHitLines(text);

  const measured = new Map<string, Set<number>>();
  for (const [file, cov] of perFile) {
    const lines = new Set<number>(hits.get(file) ?? []);
    for (const m of cov.missed) lines.add(m);
    measured.set(file, lines);
  }
  return { perFile, hits, measured };
}

/**
 * Files added/copied/modified/renamed between `baseRef`'s MERGE-BASE and HEAD.
 *
 * Merge-base, not the base tip — the same pinning gate-integrity.ts uses. A
 * file changed on main after the branch point is not this PR's problem, and
 * diffing against the tip would mutation-test it anyway.
 *
 * FAIL-CLOSED: a git error throws. "No data" must never read as "nothing
 * changed, gate passes".
 */
export function changedFiles(baseRef: string): string[] {
  const mergeBase = spawnSync("git", ["merge-base", baseRef, "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (mergeBase.status !== 0) {
    throw new Error(
      `git merge-base ${baseRef} HEAD failed (${mergeBase.status}): ${mergeBase.stderr?.trim()}`,
    );
  }
  const base = mergeBase.stdout.trim();
  const diff = spawnSync("git", ["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (diff.status !== 0) {
    throw new Error(`git diff against ${base} failed (${diff.status}): ${diff.stderr?.trim()}`);
  }
  return diff.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !isExcluded(l));
}

/**
 * repo-relative path → set of NEW-side line numbers this PR added or modified.
 *
 * Reuses `parseUnifiedDiff` from gate-integrity.ts — the same parser the
 * patch-coverage gate uses — so "which lines did this PR touch?" has one
 * answer across every gate. `-U0` keeps context lines out of the added set.
 *
 * This is what makes the CRAP gate usable on a mature tree: it scores the
 * functions a PR actually edited, not every function in a file the PR
 * happened to open.
 */
export function changedLines(baseRef: string): Map<string, Set<number>> {
  const mergeBase = spawnSync("git", ["merge-base", baseRef, "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (mergeBase.status !== 0) {
    throw new Error(
      `git merge-base ${baseRef} HEAD failed (${mergeBase.status}): ${mergeBase.stderr?.trim()}`,
    );
  }
  const diff = spawnSync(
    "git",
    ["diff", "-U0", "--diff-filter=ACMR", `${mergeBase.stdout.trim()}...HEAD`],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (diff.status !== 0) {
    throw new Error(`git diff -U0 failed (${diff.status}): ${diff.stderr?.trim()}`);
  }
  const out = new Map<string, Set<number>>();
  for (const [file, rec] of parseUnifiedDiff(diff.stdout)) {
    if (!isExcluded(file)) out.set(file, rec.addedLines);
  }
  return out;
}

/** Write a gate's JSON report, creating coverage/quality/ on first use. */
export async function writeReport(name: string, payload: unknown): Promise<string> {
  mkdirSync(REPORT_DIR, { recursive: true });
  const out = resolve(REPORT_DIR, name);
  await Bun.write(out, `${JSON.stringify(payload, null, 2)}\n`);
  return out;
}
