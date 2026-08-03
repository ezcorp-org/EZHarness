/**
 * Meta-test for `scripts/unlanded-branches.ts` (`bun run branches:unlanded`).
 *
 * Two halves, because the script makes two separable claims:
 *
 *  1. **Pure core** — argument parsing, branch globbing, `git cherry` output
 *     parsing, and the exit-code/render contract, driven through a fake
 *     {@link GitPort}. These pin the behaviour that makes the check
 *     trustworthy: a pattern that matches ZERO branches can never exit 0, a
 *     `git cherry` failure is never silently skipped, and the
 *     branches-examined count is always emitted.
 *
 *  2. **Real `git`, real squash** — a throwaway repository is built with the
 *     exact topology that fooled the original audit: three feature branches
 *     REALLY merged into an integration branch, one never merged, and a
 *     trunk carrying a SQUASH of the integration branch (tree-identical to
 *     it, the same relationship `09f6f326` has to `ad1795f5`). This proves
 *     the squash-immunity claim against the actual `git cherry` binary
 *     rather than a mock of it, and reproduces the known-good split:
 *     merged branches are NOT flagged, the unmerged one IS.
 *
 * `scripts/**` is outside `SOURCE_GLOBS` (scripts/coverage-config.ts:145-157),
 * so this file needs no coverage-thresholds key — same as
 * src/__tests__/e2e-lanes.test.ts for scripts/e2e-lane-args.ts.
 */
import { afterAll, describe, expect, test } from "bun:test";
// Synchronous fixture setup runs at module top level, so the file writes must
// be synchronous too — `Bun.write` returns a promise and `git add` would race it.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PATTERNS,
  DEFAULT_TIP,
  EXIT_CLEAN,
  EXIT_DEGENERATE_TIP,
  EXIT_UNLANDED,
  EXIT_UNUSABLE,
  type GitPort,
  MAX_CANDIDATE_TIPS,
  degenerateTipEvidence,
  main,
  matchBranches,
  parseArgs,
  parseCherry,
  render,
  scan,
} from "../../scripts/unlanded-branches.ts";

// ── fake git ────────────────────────────────────────────────────────────

function fakeGit(opts: {
  branches: string[];
  cherry?: Record<string, string>;
  subjects?: Record<string, string>;
  unresolvable?: boolean;
  candidates?: string[];
}): GitPort {
  return {
    listBranches: () => opts.branches,
    resolve: (rev) => (opts.unresolvable ? null : `${rev}0000000000000000000000000000000000`.slice(0, 40)),
    cherry: (_tip, branch) => {
      const out = opts.cherry?.[branch];
      if (out === undefined) throw new Error(`no fake cherry output for ${branch}`);
      return out;
    },
    subjects: (shas) => new Map(shas.map((s) => [s, opts.subjects?.[s] ?? `subject for ${s}`])),
    candidateTips: () => opts.candidates ?? [],
  };
}

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHA_C = "cccccccccccccccccccccccccccccccccccccccc";

// ── 1. pure core ────────────────────────────────────────────────────────

describe("matchBranches", () => {
  test("matches full branch names against globs, de-duplicates and sorts", () => {
    const got = matchBranches(
      ["feat/ez-factory-c7", "feat/other", "fix/workflow-x", "security/r1", "main"],
      ["feat/ez-factory-*", "fix/workflow-*", "security/*", "feat/ez-factory-c7"],
    );
    expect(got).toEqual(["feat/ez-factory-c7", "fix/workflow-x", "security/r1"]);
  });

  test("a single `*` does NOT cross a slash — the documented scoping rule", () => {
    expect(matchBranches(["security/a/b", "security/a"], ["security/*"])).toEqual(["security/a"]);
    expect(matchBranches(["security/a/b", "security/a"], ["security/**"]).sort()).toEqual([
      "security/a",
      "security/a/b",
    ]);
  });

  test("the shipped default patterns select the program families and nothing else", () => {
    const got = matchBranches(
      [
        "feat/ez-factory-integrate",
        "fix/ez-factory-gate-debt",
        "fix/workflow-unwritten-columns",
        "security/project-membership-r1",
        "test/ez-code-factory-invariant-gaps",
        "followup/x",
        "review/x",
        "verify/x",
        "wip/x",
        "main",
        "feat/city-conditions-extension",
        "chore/remove-pullfrog",
      ],
      DEFAULT_PATTERNS,
    );
    expect(got).toEqual([
      "feat/ez-factory-integrate",
      "fix/ez-factory-gate-debt",
      "fix/workflow-unwritten-columns",
      "followup/x",
      "review/x",
      "security/project-membership-r1",
      "test/ez-code-factory-invariant-gaps",
      "verify/x",
      "wip/x",
    ]);
  });
});

describe("parseCherry", () => {
  test("splits `+` (unlanded) from `-` (equivalent patch upstream)", () => {
    expect(parseCherry(`+ ${SHA_A}\n- ${SHA_B}\n+ ${SHA_C}\n`)).toEqual({
      unlanded: [SHA_A, SHA_C],
      equivalent: [SHA_B],
    });
  });

  test("empty output is zero commits, not an error", () => {
    expect(parseCherry("")).toEqual({ unlanded: [], equivalent: [] });
    expect(parseCherry("\n\n")).toEqual({ unlanded: [], equivalent: [] });
  });

  test("an unrecognised line THROWS rather than silently reading as clean", () => {
    expect(() => parseCherry("fatal: bad revision\n")).toThrow(/unparseable/);
    expect(() => parseCherry(`* ${SHA_A}\n`)).toThrow(/unparseable/);
  });
});

describe("parseArgs", () => {
  test("defaults to origin/main and the program patterns", () => {
    expect(parseArgs([])).toEqual({
      tip: DEFAULT_TIP,
      patterns: [...DEFAULT_PATTERNS],
      allowAllUnlanded: false,
    });
  });

  test("the first positional overrides the tip", () => {
    expect(parseArgs(["ad1795f5"]).tip).toBe("ad1795f5");
  });

  test("--pattern REPLACES the defaults and is repeatable", () => {
    expect(parseArgs(["--pattern=a/*", "--pattern=b/*"]).patterns).toEqual(["a/*", "b/*"]);
  });

  test("--allow-all-unlanded is recognised", () => {
    expect(parseArgs(["--allow-all-unlanded"]).allowAllUnlanded).toBe(true);
  });

  test("a typo'd flag or a stray second positional THROWS, never silently narrows scope", () => {
    expect(() => parseArgs(["--patern=a/*"])).toThrow(/unknown flag/);
    expect(() => parseArgs(["--pattern="])).toThrow(/requires a glob/);
    expect(() => parseArgs(["tip1", "tip2"])).toThrow(/extra argument/);
  });
});

describe("scan", () => {
  test("an unresolvable tip throws instead of scanning against nothing", () => {
    const git = fakeGit({ branches: ["feat/ez-factory-a"], unresolvable: true });
    expect(() => scan(git, "no-such-ref", ["feat/*"])).toThrow(/does not resolve/);
  });

  test("a git failure on one branch is collected as an error, never dropped", () => {
    const git = fakeGit({ branches: ["feat/a", "feat/b"], cherry: { "feat/a": "" } });
    const s = scan(git, "tip", ["feat/*"]);
    expect(s.examined).toEqual(["feat/a", "feat/b"]);
    expect(s.verdicts.map((v) => v.branch)).toEqual(["feat/a"]);
    expect(s.errors.map((e) => e.branch)).toEqual(["feat/b"]);
  });
});

describe("render — exit contract", () => {
  test("ZERO branches matched exits UNUSABLE with empty stdout, never CLEAN", () => {
    const git = fakeGit({ branches: ["main"] });
    const r = render(scan(git, "tip", ["nope/*"]), git);
    expect(r.exitCode).toBe(EXIT_UNUSABLE);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("matched ZERO branches");
    expect(r.stderr).toContain("proved NOTHING");
    // The distinguishing fact is on stderr in both cases.
    expect(r.stderr).toContain("examined=0 branch(es)");
  });

  test("all branches landed exits CLEAN with empty stdout AND a non-zero examined count", () => {
    const git = fakeGit({ branches: ["feat/a", "feat/b"], cherry: { "feat/a": "", "feat/b": `- ${SHA_A}\n` } });
    const r = render(scan(git, "tip", ["feat/*"]), git);
    expect(r.exitCode).toBe(EXIT_CLEAN);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("examined=2 branch(es)");
    expect(r.stderr).toContain("flagged=0");
  });

  test("empty stdout at CLEAN and at UNUSABLE differ ONLY by exit code + stderr", () => {
    // The failure mode this whole check exists to prevent: "found nothing"
    // and "looked at nothing" must never be the same observable result.
    const clean = render(
      scan(fakeGit({ branches: ["feat/a"], cherry: { "feat/a": "" } }), "tip", ["feat/*"]),
      fakeGit({ branches: ["feat/a"], cherry: { "feat/a": "" } }),
    );
    const nothing = render(
      scan(fakeGit({ branches: ["feat/a"] }), "tip", ["zzz/*"]),
      fakeGit({ branches: ["feat/a"] }),
    );
    expect(clean.stdout).toBe(nothing.stdout);
    expect(clean.exitCode).not.toBe(nothing.exitCode);
    expect(clean.stderr).not.toBe(nothing.stderr);
  });

  test("unlanded work exits UNLANDED and names branch, short sha and subject on stdout", () => {
    const git = fakeGit({
      branches: ["feat/a", "feat/b"],
      cherry: { "feat/a": "", "feat/b": `+ ${SHA_B}\n` },
      subjects: { [SHA_B]: "fix(thing): the dropped commit" },
    });
    const r = render(scan(git, "tip", ["feat/*"]), git);
    expect(r.exitCode).toBe(EXIT_UNLANDED);
    expect(r.stdout).toContain("1 of 2 examined branch(es)");
    expect(r.stdout).toContain("feat/b — 1 unlanded commit(s)");
    expect(r.stdout).toContain(SHA_B.slice(0, 8));
    expect(r.stdout).toContain("fix(thing): the dropped commit");
    // The branch that landed must not appear in the report at all.
    expect(r.stdout).not.toContain("feat/a");
  });

  test("a git failure exits UNUSABLE and names the branch — never a silent pass", () => {
    const git = fakeGit({ branches: ["feat/a", "feat/b"], cherry: { "feat/a": "" } });
    const r = render(scan(git, "tip", ["feat/*"]), git);
    expect(r.exitCode).toBe(EXIT_UNUSABLE);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("feat/b");
  });
});

describe("degenerate-tip guard", () => {
  const collapsed = {
    branches: ["feat/a", "feat/b", "feat/c"],
    cherry: {
      "feat/a": `+ ${SHA_A}\n+ ${SHA_B}\n`,
      "feat/b": `+ ${SHA_A}\n+ ${SHA_C}\n`,
      "feat/c": `+ ${SHA_A}\n`,
    },
  };

  test("one commit flagged on half the branches is reported as an INSTRUMENT FAILURE", () => {
    const git = fakeGit(collapsed);
    const r = render(scan(git, "tip", ["feat/*"]), git);
    expect(r.exitCode).toBe(EXIT_DEGENERATE_TIP);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(`${SHA_A.slice(0, 8)} is reported unlanded on 3 of 3`);
    expect(r.stderr).toContain("SQUASH-MERGED");
    expect(r.stderr).toContain("INSTRUMENT FAILURE");
  });

  // ── The exit-3 path is the DEFAULT path in a squash-merge repo (running
  // with no arguments lands here), so the message is the product. It has to
  // teach the reader what went wrong and what a usable tip is, from the
  // message alone. These pin that it does.
  describe("the exit-3 message is self-teaching", () => {
    const msg = () => {
      const git = fakeGit({ ...collapsed, candidates: ["feat/integration", "feat/older"] });
      return render(scan(git, "origin/main", ["feat/*"]), git).stderr;
    };

    test("names the tip as the thing at fault, not the branches", () => {
      expect(msg()).toContain("'origin/main' cannot answer this question");
      expect(msg()).toContain("Do not read the 3");
      expect(msg()).toContain("flagged branches as dropped work");
    });

    test("explains the MECHANISM — patch-ids, and why a squash defeats them", () => {
      const m = msg();
      expect(m).toContain("PATCH-ID");
      expect(m).toContain("replaces a");
      expect(m).toContain("combined patch-id equals none of");
      expect(m).toContain("landed and dropped alike");
    });

    test("says the DEFAULT tip can never answer, and that ancestry cannot either", () => {
      const m = msg();
      expect(m).toContain(`why ${DEFAULT_TIP} (the default) can NEVER answer this`);
      expect(m).toContain("git merge-base --is-ancestor");
    });

    test("defines what a usable tip IS, in terms the reader can check", () => {
      const m = msg();
      expect(m).toContain("A USABLE TIP is a ref with REAL merge history");
      expect(m).toContain("squashed FROM");
      expect(m).toContain("Same tree as the release");
    });

    test("offers runnable candidate commands and a way to confirm the choice", () => {
      const m = msg();
      expect(m).toContain("bun run branches:unlanded feat/integration");
      expect(m).toContain("bun run branches:unlanded feat/older");
      expect(m).toContain("git rev-parse <candidate>^{tree} origin/main^{tree}");
      expect(m).toContain("--allow-all-unlanded");
    });

    test("caps the candidate list rather than dumping every branch", () => {
      const many = Array.from({ length: 30 }, (_, i) => `feat/cand-${i}`);
      const git = fakeGit({ ...collapsed, candidates: many });
      const m = render(scan(git, "origin/main", ["feat/*"]), git).stderr;
      const shown = many.filter((c) => m.includes(`branches:unlanded ${c}\n`));
      expect(shown.length).toBe(MAX_CANDIDATE_TIPS);
      expect(shown).toEqual(many.slice(0, MAX_CANDIDATE_TIPS));
    });

    test("with NO candidate on disk it still says what to look for, not just 'none'", () => {
      const git = fakeGit({ ...collapsed, candidates: [] });
      const m = render(scan(git, "origin/main", ["feat/*"]), git).stderr;
      expect(m).toContain("no usable tip on disk");
      expect(m).toContain("Fetch or recreate the integration branch");
      expect(m).toContain("git rev-parse <candidate>^{tree} origin/main^{tree}");
      // The diagnosis must survive the loss of the suggestion.
      expect(m).toContain("INSTRUMENT FAILURE");
      expect(m).toContain("PATCH-ID");
    });
  });

  test("--allow-all-unlanded downgrades it to an ordinary UNLANDED report", () => {
    const git = fakeGit(collapsed);
    const r = render(scan(git, "tip", ["feat/*"]), git, true);
    expect(r.exitCode).toBe(EXIT_UNLANDED);
    expect(r.stdout).toContain("3 of 3 examined branch(es)");
  });

  test("mostly-disjoint flagged commits do NOT trip it — a real finding survives", () => {
    const git = fakeGit({
      branches: ["feat/a", "feat/b", "feat/c", "feat/d"],
      cherry: {
        "feat/a": `+ ${SHA_A}\n`,
        "feat/b": `+ ${SHA_B}\n`,
        "feat/c": "",
        "feat/d": "",
      },
    });
    const r = render(scan(git, "tip", ["feat/*"]), git);
    expect(r.exitCode).toBe(EXIT_UNLANDED);
    expect(r.stdout).toContain("2 of 4 examined branch(es)");
  });

  test("below the 3-branch floor it stays silent — 2 branches sharing a base is ordinary stacking", () => {
    const git = fakeGit({
      branches: ["feat/a", "feat/b"],
      cherry: { "feat/a": `+ ${SHA_A}\n`, "feat/b": `+ ${SHA_A}\n` },
    });
    expect(degenerateTipEvidence(scan(git, "tip", ["feat/*"]))).toBeNull();
    expect(render(scan(git, "tip", ["feat/*"]), git).exitCode).toBe(EXIT_UNLANDED);
  });

  test("counts BRANCHES, not occurrences — a repeated sha on one branch cannot fake the signal", () => {
    const git = fakeGit({
      branches: ["feat/a", "feat/b", "feat/c"],
      cherry: { "feat/a": `+ ${SHA_A}\n+ ${SHA_A}\n+ ${SHA_A}\n`, "feat/b": "", "feat/c": "" },
    });
    expect(degenerateTipEvidence(scan(git, "tip", ["feat/*"]))).toBeNull();
  });
});

// ── 2. real git, real squash ────────────────────────────────────────────

const REPO = mkdtempSync(join(tmpdir(), "unlanded-branches-"));
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

function git(...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], {
    cwd: REPO,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  if (p.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${p.stderr.toString()}${p.stdout.toString()}`);
  }
  return p.stdout.toString().trim();
}

function commit(file: string, body: string, message: string): void {
  writeFileSync(join(REPO, file), body);
  git("add", "-A");
  git("commit", "--no-verify", "-m", message);
}

/*
 * The program's topology, in miniature:
 *
 *   main:        base ────────────────────────── S' (squash of integration)
 *                   \                           /
 *   integration:     shared ─ M(f1) ─ M(f2) ─ M(f3)
 *                       │ \    /       /       /
 *   feat/f1..f3:        │  c1 ┘  c2 ──┘  c3 ──┘   (REALLY merged → landed)
 *                       └─ feat/dropped: d1        (never merged → DROPPED)
 *
 * `S'` is tree-identical to the integration tip, exactly as PR #54's squash
 * `09f6f326` is tree-identical to `ad1795f5` (both trees `17eb77d8`).
 */
git("init", "-q", "-b", "main", ".");
commit("base.txt", "base\n", "base");
git("checkout", "-q", "-b", "integration");
commit("shared.txt", "shared\n", "shared groundwork every feature branch is cut from");
const SHARED = git("rev-parse", "HEAD");

for (const n of ["f1", "f2", "f3", "dropped"]) {
  git("checkout", "-q", "-b", `feat/${n}`, SHARED);
  commit(`${n}.txt`, `${n}\n`, `feat(${n}): work on ${n}`);
}
const DROPPED_SHA = git("rev-parse", "feat/dropped");

git("checkout", "-q", "integration");
for (const n of ["f1", "f2", "f3"]) {
  git("merge", "--no-ff", "--no-verify", "-m", `merge feat/${n}`, `feat/${n}`);
}
const INTEGRATION = git("rev-parse", "HEAD");

git("checkout", "-q", "main");
git("merge", "--squash", "integration");
git("commit", "--no-verify", "-m", "feat: the whole program, squashed onto main (#54)");
const MAIN = git("rev-parse", "HEAD");

describe("real git — squash-immunity and the known-good split", () => {
  test("fixture sanity: the squash on main is TREE-IDENTICAL to the integration tip", () => {
    expect(git("rev-parse", `${MAIN}^{tree}`)).toBe(git("rev-parse", `${INTEGRATION}^{tree}`));
    // …and yet it is not an ancestor — the exact reason ancestry lied.
    expect(
      Bun.spawnSync(["git", "merge-base", "--is-ancestor", "feat/f1", "main"], { cwd: REPO }).exitCode,
    ).not.toBe(0);
  });

  test("the failure being guarded: against the SQUASHED trunk, a landed branch still flags", () => {
    const p = Bun.spawnSync(["git", "cherry", "main", "feat/f1"], { cwd: REPO });
    const { unlanded } = parseCherry(p.stdout.toString());
    // feat/f1 IS in main's tree, yet every one of its commits reads unlanded.
    expect(unlanded.length).toBeGreaterThan(0);
  });

  test("against the INTEGRATION tip: merged branches are clean, the unmerged one is flagged", () => {
    const r = main([INTEGRATION, "--pattern=feat/*"], REPO);
    expect(r.exitCode).toBe(EXIT_UNLANDED);
    expect(r.stderr).toContain("examined=4 branch(es)");
    expect(r.stderr).toContain("flagged=1");
    expect(r.stdout).toContain("feat/dropped — 1 unlanded commit(s)");
    expect(r.stdout).toContain(DROPPED_SHA.slice(0, 8));
    expect(r.stdout).toContain("feat(dropped): work on dropped");
    for (const landed of ["feat/f1", "feat/f2", "feat/f3"]) {
      expect(r.stdout).not.toContain(landed);
    }
  });

  test("against the SQUASHED trunk: reported as a degenerate tip, not as four drops", () => {
    const r = main([MAIN, "--pattern=feat/*"], REPO);
    expect(r.exitCode).toBe(EXIT_DEGENERATE_TIP);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(`${SHARED.slice(0, 8)} is reported unlanded on 4 of 4`);
  });

  test("…and its candidate search names the REAL integration branch first", () => {
    // The suggestion has to be right, not merely present: on a real repo the
    // top candidate must be the branch that actually answers the question.
    const r = main([MAIN, "--pattern=feat/*"], REPO);
    const first = r.stderr.slice(r.stderr.indexOf("bun run branches:unlanded "));
    expect(first.split("\n")[0]).toBe("bun run branches:unlanded integration");
    // …and following that advice must clear the degenerate verdict.
    const followed = main(["integration", "--pattern=feat/*"], REPO);
    expect(followed.exitCode).toBe(EXIT_UNLANDED);
    expect(followed.stdout).toContain("feat/dropped");
  });

  test("--allow-all-unlanded on the squashed trunk shows all four, proving the guard is what suppressed them", () => {
    const r = main([MAIN, "--pattern=feat/*", "--allow-all-unlanded"], REPO);
    expect(r.exitCode).toBe(EXIT_UNLANDED);
    expect(r.stdout).toContain("4 of 4 examined branch(es)");
  });

  test("a pattern matching nothing in a real repo exits UNUSABLE, not CLEAN", () => {
    const r = main([INTEGRATION, "--pattern=no-such-prefix/*"], REPO);
    expect(r.exitCode).toBe(EXIT_UNUSABLE);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("examined=0 branch(es)");
  });

  test("an unresolvable tip exits UNUSABLE with a named reason", () => {
    const r = main(["definitely-not-a-ref", "--pattern=feat/*"], REPO);
    expect(r.exitCode).toBe(EXIT_UNUSABLE);
    expect(r.stderr).toContain("does not resolve");
  });

  test("a bad flag exits UNUSABLE and prints usage", () => {
    const r = main(["--nope"], REPO);
    expect(r.exitCode).toBe(EXIT_UNUSABLE);
    expect(r.stderr).toContain("unknown flag");
    expect(r.stderr).toContain("usage: bun run branches:unlanded");
  });
});
