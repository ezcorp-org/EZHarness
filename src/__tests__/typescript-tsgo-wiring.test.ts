// The TypeScript 7 dual install, enforced instead of stated.
//
// `svelte-check/bin/ts-version-check.js` does this, unconditionally, before it
// checks anything:
//
//     const pkg = require('typescript/package.json');
//     if (major < 7) return;
//     throw new Error('TypeScript 7 support currently requires both ...');
//
// So the resolved `typescript` must stay major 6, and TypeScript 7 reaches the
// codebase only through the `@typescript/native` alias, selected per-call with
// `--tsgo`. Dependabot PR #163 bumped `typescript` to `^7.0.2` directly and the
// `Svelte check` CI job died on that throw.
//
// Two failure modes, both silent, both pinned here:
//
//   1. `typescript` drifts to 7 (or the alias disappears) — svelte-check stops
//      running everywhere at once.
//   2. A svelte-check call site is added, or edited, WITHOUT `--tsgo`. That one
//      path throws instead of checking. It is a hole rather than a failure:
//      the job that was supposed to type-check templates simply stops doing it,
//      and the error text reads like a setup problem rather than a gate loss.
//
// (2) is why the call sites are DISCOVERED rather than listed. A hardcoded
// triple would pass forever while a fourth invocation went unchecked.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** Files that may invoke svelte-check, scanned as text. */
const SHELL_LIKE = [".github/workflows/ci.yml", "scripts/lib/hook-lib.sh"];

/** Manifests whose `scripts` values may invoke svelte-check. */
const MANIFESTS = ["package.json", "web/package.json"];

interface Manifest {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * Drop whole-line comments before scanning.
 *
 * Prose in a `#` comment is not a call site, and a comment that QUOTES a
 * correct invocation would otherwise mask a neighbouring broken one. Same
 * reasoning as `stripCommentLines()` in the mock-cleanup meta-test.
 */
function stripCommentLines(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/**
 * Every `svelte-check` INVOCATION in `source`, as the argument tail that
 * follows it. An invocation is a run through a package executor — that is what
 * distinguishes it from the `"svelte-check": "^4.4.2"` devDependency line,
 * which is a declaration and carries no flags.
 */
function svelteCheckInvocations(source: string): string[] {
  const tails: string[] = [];
  const re = /(?:bunx|npx|bun\s+x)\s+(?:--bun\s+)?svelte-check\b([^\n"]*)/g;
  for (const m of stripCommentLines(source).matchAll(re)) tails.push(m[1] ?? "");
  return tails;
}

/** Same, for a package.json `scripts` value (no executor prefix there). */
function scriptInvocations(script: string): string[] {
  const tails: string[] = [];
  for (const m of script.matchAll(/svelte-check\b([^&|;]*)/g)) tails.push(m[1] ?? "");
  return tails;
}

const readText = async (rel: string): Promise<string> =>
  await Bun.file(join(REPO_ROOT, rel)).text();

const readManifest = async (rel: string): Promise<Manifest> =>
  (await Bun.file(join(REPO_ROOT, rel)).json()) as Manifest;

describe("TypeScript 7 dual install", () => {
  test("web pins typescript at major 6 — svelte-check throws on 7", async () => {
    const web = await readManifest("web/package.json");
    const ts = web.devDependencies?.typescript;
    expect(ts).toBeDefined();
    // Not a style preference: `>= 7` here is the exact condition that makes
    // ts-version-check.js throw, which takes the Svelte check job down.
    expect(ts).toMatch(/^\^?6\./);
  });

  test("TypeScript 7 is present, but only under the @typescript/native alias", async () => {
    const web = await readManifest("web/package.json");
    const native = web.devDependencies?.["@typescript/native"];
    expect(native).toBeDefined();
    // The alias is what `--tsgo` resolves. Drop it and every call site's
    // --tsgo has nothing to select.
    expect(native).toMatch(/^npm:typescript@7\./);
  });

  test("the --tsgo incremental cache directory is gitignored", async () => {
    // `--tsgo` opts into TypeScript's incremental build cache. svelte-check
    // writes it into `.svelte-kit`, and FALLS BACK to `web/.svelte-check`
    // when `.svelte-kit` has not been generated yet — i.e. in a fresh
    // worktree, before `svelte-kit sync`. Reproduced: 785 generated files.
    //
    // Two ways that bites, both invisible to CI (fresh checkout per job):
    //   - `biome.json` sets `vcs.useIgnoreFile: true`, so an unignored path
    //     gets LINTED. Measured: 4313 files / 212 errors / exit 1, from
    //     generated code nobody wrote.
    //   - the pre-push hook runs svelte_check ITSELF, so it poisons its own
    //     next run: push #1 leaves the artifact, push #2 fails on lint.
    //
    // Assert through git rather than by string-matching .gitignore, so any
    // ignore rule that covers the path counts.
    const proc = Bun.spawn(["git", "check-ignore", "-q", "web/.svelte-check/x.ts"], {
      cwd: REPO_ROOT,
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await proc.exited).toBe(0);
  });
});

describe("--tsgo is on EVERY svelte-check call site", () => {
  test("the shell/workflow call sites are found and all carry --tsgo", async () => {
    const found: Array<{ file: string; tail: string }> = [];
    for (const rel of SHELL_LIKE) {
      for (const tail of svelteCheckInvocations(await readText(rel))) {
        found.push({ file: rel, tail });
      }
    }
    // Guard the scanner itself: if the regex silently stops matching, the
    // "all carry --tsgo" assertion below passes vacuously over an empty list.
    expect(found.length).toBeGreaterThanOrEqual(SHELL_LIKE.length);
    for (const rel of SHELL_LIKE) {
      expect(found.some((f) => f.file === rel)).toBe(true);
    }
    const missing = found.filter((f) => !f.tail.includes("--tsgo"));
    expect(missing).toEqual([]);
  });

  test("the package.json script call sites all carry --tsgo", async () => {
    const found: Array<{ file: string; script: string; tail: string }> = [];
    for (const rel of MANIFESTS) {
      const scripts = (await readManifest(rel)).scripts ?? {};
      for (const [name, body] of Object.entries(scripts)) {
        for (const tail of scriptInvocations(body)) {
          found.push({ file: rel, script: name, tail });
        }
      }
    }
    // web's `check` + `check:watch` are the known two; the bound is a floor so
    // a new script is scanned rather than silently skipped.
    expect(found.length).toBeGreaterThanOrEqual(2);
    const missing = found.filter((f) => !f.tail.includes("--tsgo"));
    expect(missing).toEqual([]);
  });

  test("the scanner ignores the devDependency declaration", async () => {
    // `"svelte-check": "^4.4.2"` is a declaration, not a call site. If the
    // scanner counted it, it would report a permanently-missing --tsgo and the
    // gate would be unfixable — so this pins the discrimination.
    const raw = await readText("web/package.json");
    expect(raw).toContain('"svelte-check"');
    expect(svelteCheckInvocations(raw)).toEqual([]);
  });

  test("a call site added without --tsgo is caught", () => {
    // Negative control for the scanner, on synthetic input.
    const bad = "      - run: cd web && bunx svelte-check\n";
    expect(svelteCheckInvocations(bad)).toEqual([""]);
    expect(svelteCheckInvocations(bad)[0]?.includes("--tsgo")).toBe(false);

    const good = "      - run: cd web && bunx svelte-check --tsgo\n";
    expect(svelteCheckInvocations(good)[0]?.includes("--tsgo")).toBe(true);

    // ...and that a comment quoting a correct invocation cannot mask a broken
    // neighbour, which is the whole reason comment lines are stripped.
    const masked = "# ok: bunx svelte-check --tsgo\n- run: bunx svelte-check\n";
    expect(svelteCheckInvocations(masked)).toEqual([""]);
  });
});
