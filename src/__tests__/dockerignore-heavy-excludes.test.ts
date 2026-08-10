import { describe, expect, test } from "bun:test";

// Guards the build-context excludes.
//
// Docker's ignore patterns are PATH-EXACT: a bare `worktrees` line matches the
// top-level directory and nothing else. `.dockerignore` has been bitten by that
// three times now — first `node_modules` (fixed by enumerating
// `web/node_modules` on line 2), then the test globs (fixed by the recursive
// prefixes at the bottom of the file), then `worktrees`, which did NOT cover
// `.claude/worktrees/` where the Agent tool's worktree isolation writes every
// spawned agent's checkout.
//
// That third miss was expensive and silent: measured on the primary dev box,
// `.claude/worktrees` held 101 worktrees / 26 GB / 5,326,186 files against
// 80,368 files in the repo proper. A bare `FROM scratch` + `COPY . /x` probe
// transferred 21.67 GB and had still not finished after 12 minutes; with the
// recursive forms it transfers 96.58 MB in 0.9s. Nothing failed — builds just
// took "a crazy amount of time", which reads as a slow machine rather than a
// one-line config bug.
//
// The second half of the trap is that BuildKit uses `<dockerfile>.dockerignore`
// when that file exists and REPLACES the root `.dockerignore` with it — the two
// are never merged. So `Dockerfile.test.dockerignore` silently opted out of
// every exclude below, including the secret masks.

const ROOT = new URL("../../", import.meta.url).pathname;

/** Every ignore file that governs a build context in this repo. */
const IGNORE_FILES = [".dockerignore", "Dockerfile.test.dockerignore"] as const;

/**
 * Trees that are multi-GB, gitignored, and never a build input. The recursive
 * forms are required for the two that also appear nested: `.claude/worktrees`
 * and the per-workspace `node_modules` under `packages/@ezcorp`.
 */
const HEAVY_PATTERNS = ["**/worktrees", "**/node_modules", ".claude", ".cache"] as const;

/** Host secrets that must never enter a build context. */
const SECRET_PATTERNS = [".env", ".env.*", "**/.pi-secret", "**/.pi-salt"] as const;

async function ignoreLines(file: string): Promise<string[]> {
  const text = await Bun.file(`${ROOT}${file}`).text();
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

describe("docker build-context excludes", () => {
  for (const file of IGNORE_FILES) {
    describe(file, () => {
      test("excludes the heavy local-only trees", async () => {
        const lines = await ignoreLines(file);
        for (const pattern of HEAVY_PATTERNS) {
          expect(lines).toContain(pattern);
        }
      });

      test("excludes host secrets", async () => {
        const lines = await ignoreLines(file);
        for (const pattern of SECRET_PATTERNS) {
          expect(lines).toContain(pattern);
        }
      });

      test("a bare `worktrees` is never the only spelling", async () => {
        // The exact regression: `worktrees` alone leaves `.claude/worktrees`
        // in the context. If the bare form is present, the recursive form
        // must be too.
        const lines = await ignoreLines(file);
        if (lines.includes("worktrees")) {
          expect(lines).toContain("**/worktrees");
        }
      });
    });
  }

  test("every tracked dockerignore is covered by this test", async () => {
    // A new per-dockerfile ignore file REPLACES the root one, so it silently
    // opts out of every exclude above. Fail here until it is added to
    // IGNORE_FILES rather than discovering it via a 12-minute build.
    const { stdout } = Bun.spawnSync({
      cmd: ["git", "ls-files", "--", "*.dockerignore", ".dockerignore"],
      cwd: ROOT,
    });
    const tracked = stdout
      .toString()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    expect(tracked.length).toBeGreaterThan(0);
    for (const file of tracked) {
      expect(IGNORE_FILES as readonly string[]).toContain(file);
    }
  });
});
