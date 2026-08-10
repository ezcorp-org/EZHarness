/**
 * `bun run branches:unlanded [<integration-tip>] [--pattern=<glob>]…`
 *
 * Report local branches that still carry commits which have NOT landed in an
 * integration tip. Built after an audit found four pieces of finished work
 * silently dropped during a multi-branch program.
 *
 * ## Why `git cherry`, and not ancestry
 *
 * The program squash-merged six PRs. A squash rewrites history, so NO program
 * branch is ever an ancestor of `main` — `git merge-base --is-ancestor`
 * answered "not on main" for twelve branches, ten of which had fully landed.
 * That single false signal is what buried the real drops in noise.
 *
 * `git cherry <upstream> <head>` compares PATCH-IDs, not ancestry: it marks a
 * commit `-` when an equivalent patch already exists upstream and `+` when it
 * does not. `+` is the answer to "is this work actually in?", independent of
 * how the branch was merged, rebased or re-authored.
 *
 * ## The tip has to be a history-PRESERVING ref (read this before defaulting)
 *
 * Patch-id equivalence is per-commit. A squash collapses N commits into ONE
 * commit with one combined patch-id, which equals none of the N. So against a
 * squash-merged `main`, `git cherry` marks EVERY branch commit `+` — landed
 * and dropped alike. Measured in this repo at `origin/main` = 757ce827:
 * `fix/ez-factory-gate-debt` (fully landed) reported 122 `+` commits.
 *
 * The audit's working tip was `ad1795f5`, the integration branch head that
 * PR #54's squash `09f6f326` was cut from — both trees are `17eb77d8`. Same
 * content, real merge history, so `git cherry` has per-commit patch-ids to
 * match against. Against that tip the four known drops flag and the four
 * known-landed branches come back clean.
 *
 * Hence {@link degenerateTipEvidence}, which detects that mechanically: when
 * ONE commit is flagged on at least half of ≥3 examined branches, those
 * branches share a stretch of history the tip cannot see per-commit, which is
 * exactly what a squash does. The run is then reported as an INSTRUMENT
 * FAILURE (exit 3), not as a finding — a check that flags everything is as
 * useless as one that flags nothing. Measured on this repo: at
 * `tip=origin/main` commit `40d57aae` is flagged on 33 of 34 branches (fires);
 * at `tip=ad1795f5` the most-shared flagged commit reaches 5 of 34 (silent).
 *
 * A blunter "100% of branches flagged" rule was tried first and MISSED the
 * real case — `origin/main` flagged 33 of 34, one branch short, and emitted
 * 267KB of noise at exit 1.
 *
 * ## Exit codes (0/1 are answers, ≥2 mean "no trustworthy answer")
 *
 * | code | meaning                                            | stdout |
 * |------|----------------------------------------------------|--------|
 * | 0    | every matched branch is fully landed                | empty  |
 * | 1    | at least one branch has unlanded commits            | report |
 * | 2    | usage error, unresolvable tip, git failure, **or the pattern matched ZERO branches** | empty |
 * | 3    | degenerate tip — 100% of ≥3 branches flagged        | empty  |
 *
 * Empty stdout means "nothing dropped" ONLY at exit 0. The scope line
 * (`tip=… patterns=… examined=N …`) always goes to STDERR, so stdout stays
 * paste-into-a-PR clean while "how many branches did you actually look at"
 * is never invisible.
 *
 * Tested by `src/__tests__/unlanded-branches.test.ts`, which drives the pure
 * core through a fake git port AND builds a throwaway repo with a real squash
 * merge to prove the squash-immunity claim against the real `git cherry`.
 */
import { Glob } from "bun";

/** Branch families of the ez-factory program — the DEFAULT scope, not the
 *  only one. The next program will have different prefixes; pass
 *  `--pattern=` (repeatable) to replace this list wholesale. */
export const DEFAULT_PATTERNS: readonly string[] = [
  "feat/ez-factory-*",
  "fix/ez-factory-*",
  "fix/workflow-*",
  "security/*",
  "test/ez-*",
  "followup/*",
  "review/*",
  "verify/*",
  "wip/*",
];

export const DEFAULT_TIP = "origin/main";

/** Below this many matched branches there is not enough signal to call a tip
 *  degenerate — two branches sharing a commit is ordinary stacking. */
export const DEGENERATE_MIN_BRANCHES = 3;

/** Fraction of examined branches that must ALL flag the SAME commit before
 *  the tip is called squash-collapsed. Half is deliberately conservative:
 *  a legitimately-behind integration tip makes branches flag their OWN,
 *  mostly-disjoint commits, not one commit shared by half the tree. */
export const SHARED_FLAG_FRACTION = 0.5;

export const EXIT_CLEAN = 0;
export const EXIT_UNLANDED = 1;
export const EXIT_UNUSABLE = 2;
export const EXIT_DEGENERATE_TIP = 3;

/** The git operations this check needs, injected so the pure core is
 *  testable without a repo. */
export interface GitPort {
  /** Local branch short names. */
  listBranches(): string[];
  /** Resolved commit sha for a rev, or `null` if it does not resolve. */
  resolve(rev: string): string | null;
  /** Raw `git cherry <tip> <branch>` stdout. Throws on git failure. */
  cherry(tip: string, branch: string): string;
  /** `sha -> subject` for the given shas. */
  subjects(shas: string[]): Map<string, string>;
  /**
   * Local branches that CONTAIN `sha`, most-integrated first.
   *
   * Used only to make the degenerate-tip error actionable. Containing the
   * shared commit is the necessary condition for a usable tip — such a ref
   * has that commit as a real ancestor, so `git cherry` can see it
   * per-commit. Ranked by total commit count, so the branch that absorbed
   * the most work is suggested first.
   */
  candidateTips(sha: string): string[];
}

/** How many candidate tips the degenerate-tip message lists. */
export const MAX_CANDIDATE_TIPS = 4;

export interface BranchVerdict {
  branch: string;
  /** Shas marked `+` — no equivalent patch in the tip. */
  unlanded: string[];
  /** Shas marked `-` — an equivalent patch IS in the tip. */
  equivalent: string[];
}

export interface Scan {
  tip: string;
  tipSha: string;
  patterns: string[];
  /** Every branch the patterns matched, sorted. Reported even when clean. */
  examined: string[];
  /** One verdict per examined branch, in `examined` order. */
  verdicts: BranchVerdict[];
  /** Branches whose `git cherry` call failed — never silently dropped. */
  errors: Array<{ branch: string; message: string }>;
}

/**
 * Branches matching ANY pattern, de-duplicated and sorted.
 *
 * Patterns are globs (`Bun.Glob`), so `*` stops at a `/` — `security/*`
 * selects `security/project-membership-r1` and NOT `security/a/b`. Use `**`
 * to cross separators.
 */
export function matchBranches(all: readonly string[], patterns: readonly string[]): string[] {
  const globs = patterns.map((p) => new Glob(p));
  const hits = new Set<string>();
  for (const branch of all) {
    if (globs.some((g) => g.match(branch))) hits.add(branch);
  }
  return [...hits].sort();
}

/**
 * Split `git cherry` stdout into `+` (unlanded) and `-` (equivalent-patch)
 * shas.
 *
 * Unrecognised lines THROW rather than being dropped: a format this parser
 * does not understand must not silently read as "nothing unlanded".
 */
export function parseCherry(stdout: string): { unlanded: string[]; equivalent: string[] } {
  const unlanded: string[] = [];
  const equivalent: string[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    if (line === "") continue;
    const m = /^([+-]) ([0-9a-f]{7,40})$/.exec(line);
    if (!m) throw new Error(`unparseable \`git cherry\` line: ${JSON.stringify(line)}`);
    (m[1] === "+" ? unlanded : equivalent).push(m[2]!);
  }
  return { unlanded, equivalent };
}

/** Run the check. Pure with respect to `git`, which arrives via {@link GitPort}. */
export function scan(git: GitPort, tip: string, patterns: readonly string[]): Scan {
  const tipSha = git.resolve(tip);
  if (tipSha === null) throw new Error(`integration tip '${tip}' does not resolve to a commit`);

  const examined = matchBranches(git.listBranches(), patterns);
  const verdicts: BranchVerdict[] = [];
  const errors: Array<{ branch: string; message: string }> = [];
  for (const branch of examined) {
    try {
      const { unlanded, equivalent } = parseCherry(git.cherry(tip, branch));
      verdicts.push({ branch, unlanded, equivalent });
    } catch (e) {
      errors.push({ branch, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return { tip, tipSha, patterns: [...patterns], examined, verdicts, errors };
}

/**
 * The single most-shared flagged commit, if it is shared widely enough to
 * mean the tip is squash-collapsed — otherwise `null`.
 *
 * Counts BRANCHES, not occurrences, so a commit listed twice on one branch
 * cannot manufacture the signal.
 */
export function degenerateTipEvidence(s: Scan): { sha: string; branches: number } | null {
  if (s.verdicts.length < DEGENERATE_MIN_BRANCHES) return null;
  const threshold = Math.ceil(s.verdicts.length * SHARED_FLAG_FRACTION);
  const perBranch = new Map<string, number>();
  for (const v of s.verdicts) {
    for (const sha of new Set(v.unlanded)) perBranch.set(sha, (perBranch.get(sha) ?? 0) + 1);
  }
  let best: { sha: string; branches: number } | null = null;
  for (const [sha, branches] of perBranch) {
    if (branches >= threshold && (best === null || branches > best.branches))
      best = { sha, branches };
  }
  return best;
}

export interface Rendered {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Turn a {@link Scan} into the process's three outputs.
 *
 * `allowAllUnlanded` disables the degenerate-tip guard, for the genuine case
 * where an integration really has not absorbed any of its branches yet.
 */
export function render(s: Scan, git: GitPort, allowAllUnlanded = false): Rendered {
  const scope =
    `branches:unlanded: tip=${s.tip} (${s.tipSha.slice(0, 8)})  ` +
    `patterns=${s.patterns.join(",")}  examined=${s.examined.length} branch(es)`;

  // ── The pattern matched nothing. NOT "nothing was dropped". ──────────
  // This is the whole reason the scope line exists: a check that inspects
  // zero branches produces the same empty stdout as a clean run, so it must
  // never be allowed to exit 0.
  if (s.examined.length === 0) {
    return {
      stdout: "",
      stderr:
        `${scope}\n` +
        `FATAL: the branch pattern matched ZERO branches, so this check proved NOTHING.\n` +
        `  patterns: ${s.patterns.join(", ")}\n` +
        `  An empty result here is a broken filter, not a clean tree. Fix the\n` +
        `  --pattern globs (they match FULL branch names, '*' stops at '/') and re-run.\n`,
      exitCode: EXIT_UNUSABLE,
    };
  }

  if (s.errors.length > 0) {
    const lines = s.errors.map((e) => `  ${e.branch}: ${e.message}`).join("\n");
    return {
      stdout: "",
      stderr: `${scope}\nFATAL: \`git cherry\` failed for ${s.errors.length} branch(es):\n${lines}\n`,
      exitCode: EXIT_UNUSABLE,
    };
  }

  const flagged = s.verdicts.filter((v) => v.unlanded.length > 0);

  // ── One commit flagged across half the tree: the tip is collapsed. ───
  const degenerate = allowAllUnlanded ? null : degenerateTipEvidence(s);
  if (degenerate !== null) {
    const short = degenerate.sha.slice(0, 8);
    const candidates = git.candidateTips(degenerate.sha).slice(0, MAX_CANDIDATE_TIPS);
    const suggestion =
      candidates.length > 0
        ? `  TRY ONE OF THESE. They are the local branches that CONTAIN ${short},\n` +
          `  most-integrated first — containing it is exactly what '${s.tip}' fails to do:\n` +
          candidates.map((c) => `    bun run branches:unlanded ${c}\n`).join("") +
          `  Check the one you pick is the right integration branch: its tree should\n` +
          `  match the release it was squashed into —\n` +
          `    git rev-parse <candidate>^{tree} ${s.tip}^{tree}   # two identical lines\n`
        : `  No local branch contains ${short}, so this repo has no usable tip on disk.\n` +
          `  Fetch or recreate the integration branch the release was squashed from;\n` +
          `  its tree will match the release —\n` +
          `    git rev-parse <candidate>^{tree} ${s.tip}^{tree}   # two identical lines\n`;
    return {
      stdout: "",
      stderr:
        `${scope}  flagged=${flagged.length}\n` +
        `FATAL: '${s.tip}' cannot answer this question — it looks SQUASH-MERGED.\n` +
        `  This is an INSTRUMENT FAILURE, not a finding. Do not read the ${flagged.length}\n` +
        `  flagged branches as dropped work.\n` +
        `\n` +
        `  EVIDENCE: commit ${short} is reported unlanded on ${degenerate.branches} of ` +
        `${s.verdicts.length} examined\n` +
        `  branches. They SHARE that commit, so a tip that genuinely lacked it would\n` +
        `  mean ${degenerate.branches} independent branches each dropped the same work. The tip\n` +
        `  simply cannot see it.\n` +
        `\n` +
        `  WHY: \`git cherry\` matches commits by PATCH-ID. A squash merge replaces a\n` +
        `  branch's N commits with ONE commit whose combined patch-id equals none of\n` +
        `  the N, so every branch commit reads '+' — landed and dropped alike. This is\n` +
        `  why ${DEFAULT_TIP} (the default) can NEVER answer this in a squash-merge repo,\n` +
        `  and why ancestry (\`git merge-base --is-ancestor\`) cannot either.\n` +
        `\n` +
        `  A USABLE TIP is a ref with REAL merge history — the integration branch the\n` +
        `  release was squashed FROM. Same tree as the release, but it still holds the\n` +
        `  individual commits, so their patch-ids still match.\n` +
        `\n` +
        suggestion +
        `\n` +
        `  If these branches genuinely do share unlanded work, pass --allow-all-unlanded\n` +
        `  to accept the result as-is.\n`,
      exitCode: EXIT_DEGENERATE_TIP,
    };
  }

  if (flagged.length === 0) {
    return { stdout: "", stderr: `${scope}  flagged=0 — nothing unlanded\n`, exitCode: EXIT_CLEAN };
  }

  const subjects = git.subjects(flagged.flatMap((v) => v.unlanded));
  const body = flagged
    .map((v) => {
      const head = `${v.branch} — ${v.unlanded.length} unlanded commit(s)`;
      const commits = v.unlanded
        .map((sha) => `  ${sha.slice(0, 8)}  ${subjects.get(sha) ?? "(subject unavailable)"}`)
        .join("\n");
      return `${head}\n${commits}`;
    })
    .join("\n\n");

  return {
    stdout:
      `UNLANDED WORK — ${flagged.length} of ${s.examined.length} examined branch(es) carry ` +
      `commits with no equivalent patch in ${s.tip} (${s.tipSha.slice(0, 8)}):\n\n${body}\n`,
    stderr: `${scope}  flagged=${flagged.length}\n`,
    exitCode: EXIT_UNLANDED,
  };
}

export interface Cli {
  tip: string;
  patterns: string[];
  allowAllUnlanded: boolean;
}

/** Parse argv. Throws on anything unrecognised — a typo'd flag must not be
 *  silently ignored into a wrong scope. */
export function parseArgs(argv: readonly string[]): Cli {
  let tip: string | null = null;
  const patterns: string[] = [];
  let allowAllUnlanded = false;
  for (const arg of argv) {
    if (arg.startsWith("--pattern=")) {
      const p = arg.slice("--pattern=".length);
      if (p === "") throw new Error("--pattern= requires a glob");
      patterns.push(p);
    } else if (arg === "--allow-all-unlanded") {
      allowAllUnlanded = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown flag: ${arg}`);
    } else if (tip === null) {
      tip = arg;
    } else {
      throw new Error(`unexpected extra argument: ${arg}`);
    }
  }
  return {
    tip: tip ?? DEFAULT_TIP,
    patterns: patterns.length > 0 ? patterns : [...DEFAULT_PATTERNS],
    allowAllUnlanded,
  };
}

function run(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const p = Bun.spawnSync(["git", ...args], { cwd });
  return {
    ok: p.exitCode === 0,
    stdout: p.stdout.toString(),
    stderr: p.stderr.toString(),
  };
}

/** A {@link GitPort} backed by the real `git` binary in `cwd`. */
export function realGit(cwd: string): GitPort {
  return {
    listBranches() {
      const r = run(["for-each-ref", "--format=%(refname:short)", "refs/heads"], cwd);
      if (!r.ok) throw new Error(`git for-each-ref failed: ${r.stderr.trim()}`);
      return r.stdout.split("\n").filter((l) => l !== "");
    },
    resolve(rev) {
      const r = run(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], cwd);
      return r.ok ? r.stdout.trim() : null;
    },
    cherry(tip, branch) {
      const r = run(["cherry", tip, branch], cwd);
      if (!r.ok) throw new Error(r.stderr.trim() || "git cherry failed");
      return r.stdout;
    },
    subjects(shas) {
      const out = new Map<string, string>();
      if (shas.length === 0) return out;
      const r = run(["log", "--no-walk=unsorted", "--format=%H%x09%s", ...shas], cwd);
      if (!r.ok) return out; // subjects are cosmetic; the sha list is the finding
      for (const line of r.stdout.split("\n")) {
        const tab = line.indexOf("\t");
        if (tab > 0) out.set(line.slice(0, tab), line.slice(tab + 1));
      }
      return out;
    },
    candidateTips(sha) {
      const r = run(
        ["for-each-ref", "--contains", sha, "--format=%(refname:short)", "refs/heads"],
        cwd,
      );
      if (!r.ok) return []; // a suggestion is cosmetic; the diagnosis above is not
      const named = r.stdout.split("\n").filter((l) => l !== "");
      return named
        .map((name) => {
          const c = run(["rev-list", "--count", name], cwd);
          return { name, commits: c.ok ? Number(c.stdout.trim()) : 0 };
        })
        .sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name))
        .map((c) => c.name);
    },
  };
}

export const USAGE = `usage: bun run branches:unlanded [<integration-tip>] [--pattern=<glob>]… [--allow-all-unlanded]

  <integration-tip>   ref to test against (default: ${DEFAULT_TIP}). Must have REAL
                      merge history — a squash-merged trunk makes git cherry flag
                      every branch (the check exits ${EXIT_DEGENERATE_TIP} if it detects that).
  --pattern=<glob>    repeatable; REPLACES the default branch scope
                      (default: ${DEFAULT_PATTERNS.join(" ")})
  --allow-all-unlanded  accept a 100%-flagged result instead of exiting ${EXIT_DEGENERATE_TIP}

exit: ${EXIT_CLEAN}=clean  ${EXIT_UNLANDED}=unlanded work found  ${EXIT_UNUSABLE}=unusable (bad args / bad tip / ZERO branches matched)  ${EXIT_DEGENERATE_TIP}=degenerate tip`;

export function main(argv: readonly string[], cwd: string): Rendered {
  let cli: Cli;
  try {
    cli = parseArgs(argv);
  } catch (e) {
    return {
      stdout: "",
      stderr: `${e instanceof Error ? e.message : String(e)}\n\n${USAGE}\n`,
      exitCode: EXIT_UNUSABLE,
    };
  }
  const git = realGit(cwd);
  try {
    return render(scan(git, cli.tip, cli.patterns), git, cli.allowAllUnlanded);
  } catch (e) {
    return {
      stdout: "",
      stderr: `FATAL: ${e instanceof Error ? e.message : String(e)}\n`,
      exitCode: EXIT_UNUSABLE,
    };
  }
}

if (import.meta.main) {
  const r = main(process.argv.slice(2), process.cwd());
  if (r.stdout !== "") process.stdout.write(r.stdout);
  if (r.stderr !== "") process.stderr.write(r.stderr);
  process.exit(r.exitCode);
}
