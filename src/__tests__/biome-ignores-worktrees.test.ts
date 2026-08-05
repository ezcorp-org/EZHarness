// `biome.json` must not silently disable itself inside an agent worktree.
//
// The bug: `files.includes` carried `"!**/.claude"` to skip the repo's own
// `.claude/` config directory. Biome matches those globs against the
// ABSOLUTE path, and every worktree-isolated agent runs from
// `<repo>/.claude/worktrees/agent-<id>/` — so the leading `**/` matched a
// path COMPONENT of the worktree's own location and the entire checkout
// was ignored. `bun run lint` there reported:
//
//     Checked 0 files in 5ms.
//     × No files were processed in the specified paths.
//     error: script "lint" exited with code 1
//
// Two ways that hurts, both observed: an agent reads the exit-1 as a lint
// failure it must chase, or it reads "0 problems" as a pass and ships
// unlinted code. Either way the gate is gone for every spawned agent while
// still looking green to CI (CI lints from the repo root, which is why this
// survived unnoticed).
//
// The fix is a root-relative `"!.claude"`. Nested `.claude/` directories
// elsewhere in the tree live under `worktrees/` and `TESTENV/`, which have
// their own ignore entries, so nothing is newly linted.
//
// This test drives the REAL binary against the REAL config from a path that
// reproduces the layout, because a pure string assertion on the glob would
// not have caught the absolute-vs-relative matching semantics that caused
// the bug.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * Stand up a throwaway checkout at `<tmp>/.claude/worktrees/agent-probe/`
 * carrying the repo's real `biome.json` plus one trivially-lintable file,
 * then run `biome check .` there exactly as `bun run lint` would.
 */
async function lintInSimulatedAgentWorktree(): Promise<{ exitCode: number; output: string }> {
  const base = mkdtempSync(join(tmpdir(), "ez-biome-"));
  try {
    const worktree = join(base, ".claude", "worktrees", "agent-probe");
    mkdirSync(worktree, { recursive: true });
    copyFileSync(join(REPO_ROOT, "biome.json"), join(worktree, "biome.json"));
    // `vcs.useIgnoreFile: true` needs BOTH a git dir and an ignore file;
    // without them biome exits on a config error unrelated to what we're
    // asserting. Empty .gitignore = ignore nothing, so the probe file is
    // reachable and the includes globs are the only thing under test.
    Bun.spawnSync(["git", "init", "-q"], { cwd: worktree });
    writeFileSync(join(worktree, ".gitignore"), "");
    writeFileSync(join(worktree, "probe.ts"), "export const probe = 1;\n");

    const proc = Bun.spawnSync(
      [join(REPO_ROOT, "node_modules", ".bin", "biome"), "check", "."],
      { cwd: worktree, stdout: "pipe", stderr: "pipe" },
    );
    return {
      exitCode: proc.exitCode,
      output: proc.stdout.toString() + proc.stderr.toString(),
    };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

describe("biome config vs agent worktrees", () => {
  test("lint processes files when run from a .claude/worktrees/ checkout", async () => {
    const { exitCode, output } = await lintInSimulatedAgentWorktree();

    // The exact symptom of the bug.
    expect(output).not.toContain("No files were processed");
    // `Checked 0 files` is the same failure stated positively.
    expect(output).not.toMatch(/Checked 0 files/);
    // And the clean-tree case must actually succeed.
    expect(exitCode).toBe(0);
  }, 60_000);

  test("the repo's own .claude/ directory is still ignored", async () => {
    const cfg = (await Bun.file(join(REPO_ROOT, "biome.json")).json()) as {
      files: { includes: string[] };
    };
    const includes = cfg.files.includes;

    expect(includes).toContain("!.claude");
    // The `**/` form is what matched the worktree's own path component.
    expect(includes).not.toContain("!**/.claude");
  });

  // The `lint` script passes EXPLICIT paths rather than `.`, which is what
  // makes it immune to the bug above (an ignore glob that matches the
  // worktree's own absolute path prunes `.` to nothing, but cannot prune a
  // path biome was handed directly). The cost of that immunity is a
  // hand-maintained path list, whose failure mode is the mirror image: a new
  // top-level directory is simply never linted, silently, forever. This pins
  // the list against `.` so adding one without extending the script is loud.
  test("the lint script's explicit paths reach every file `biome check .` would", async () => {
    const checked = (out: string): number | null => {
      const m = out.match(/Checked (\d+) files?/);
      return m?.[1] ? Number(m[1]) : null;
    };
    const run = (argv: string[]) => {
      const p = Bun.spawnSync(argv, { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
      return checked(p.stdout.toString() + p.stderr.toString());
    };

    const viaLintScript = run(["bun", "run", "lint"]);
    const viaWholeTree = run([join(REPO_ROOT, "node_modules", ".bin", "biome"), "check", "."]);

    expect(viaLintScript).not.toBeNull();
    expect(viaWholeTree).not.toBeNull();
    // Not a vacuous pass — the whole point of the explicit-path form.
    expect(viaLintScript).toBeGreaterThan(0);
    // And it must not be a SMALLER surface than linting the tree wholesale.
    expect(viaLintScript!).toBeGreaterThanOrEqual(viaWholeTree!);
  }, 120_000);

  test("no ignore glob can match a path component of an agent worktree", async () => {
    // `<repo>/.claude/worktrees/agent-<id>/` — any `**/<segment>` ignore
    // whose segment appears here re-introduces the bug for that segment.
    const worktreePathSegments = [".claude", "worktrees"];
    const cfg = (await Bun.file(join(REPO_ROOT, "biome.json")).json()) as {
      files: { includes: string[] };
    };

    const offenders = cfg.files.includes.filter((glob) =>
      worktreePathSegments.some((seg) => glob === `!**/${seg}`),
    );
    expect(offenders).toEqual([]);
  });
});
