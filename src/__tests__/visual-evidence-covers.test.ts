/**
 * Meta-test for the visual-evidence COVERS MAP (`web/e2e/evidence-covers.json`).
 *
 * The map pins each @evidence spec to the source globs it renders; both the hard
 * gate (`scripts/check-visual-evidence.ts`) and the capture selector
 * (`scripts/visual-evidence/select-specs.ts`) drive off it. This test keeps the
 * map honest and self-ratcheting:
 *   - it is a valid `{ spec → string[] }` shape;
 *   - EVERY on-disk @evidence spec has an entry with ≥1 glob (adding a new
 *     @evidence spec without a mapping fails CI here — the whole point);
 *   - every key points at an existing spec file that actually carries @evidence;
 *   - every glob compiles under Bun.Glob; and
 *   - every glob matches ≥1 real file (or is an allowed non-web-src extension
 *     dir), so a typo'd path can't silently cover nothing.
 *
 * Reads real files (no git/subprocess) — fast and deterministic.
 */
import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type CoversMap, isValidCoversMap } from "../../scripts/check-visual-evidence.ts";
import { escapeGlob } from "../../scripts/coverage-config.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const COVERS_PATH = join(REPO_ROOT, "web/e2e/evidence-covers.json");

const raw = JSON.parse(readFileSync(COVERS_PATH, "utf8")) as unknown;

/** Repo-relative @evidence spec paths on disk (any depth under web/e2e/). */
const evidenceSpecs = [...new Glob("web/e2e/**/*.spec.ts").scanSync({ cwd: REPO_ROOT })]
  .filter((rel) => readFileSync(join(REPO_ROOT, rel), "utf8").includes("@evidence"))
  .sort();

/** The file universe globs are allowed to point into (fast: skips node_modules/.git). */
const universe = [
  ...new Glob("web/src/**/*").scanSync({ cwd: REPO_ROOT }),
  ...new Glob("docs/extensions/**/*").scanSync({ cwd: REPO_ROOT }),
];

describe("evidence-covers.json: shape", () => {
  test("parses as a valid { spec → string[] } covers map", () => {
    expect(isValidCoversMap(raw)).toBe(true);
  });

  test("there is at least one @evidence spec on disk to map", () => {
    // Guards against a scan that silently found nothing (which would make the
    // completeness test below vacuously pass).
    expect(evidenceSpecs.length).toBeGreaterThan(0);
  });
});

describe("evidence-covers.json: completeness + keys", () => {
  const map = raw as CoversMap;

  test("every on-disk @evidence spec has an entry with ≥1 glob", () => {
    const missing = evidenceSpecs.filter((s) => !(map[s] && map[s]!.length > 0));
    expect(missing).toEqual([]);
  });

  test("every key points at an existing @evidence spec file (no stray/typo keys)", () => {
    const known = new Set(evidenceSpecs);
    const stray = Object.keys(map).filter((k) => !known.has(k));
    expect(stray).toEqual([]);
  });
});

describe("evidence-covers.json: globs", () => {
  const map = raw as CoversMap;
  const allGlobs = Object.entries(map).flatMap(([spec, globs]) =>
    globs.map((glob) => ({ spec, glob })),
  );

  test("every glob compiles under Bun.Glob", () => {
    const broken: string[] = [];
    for (const { spec, glob } of allGlobs) {
      try {
        // Match against a throwaway string to force pattern evaluation.
        new Glob(escapeGlob(glob)).match("x");
      } catch {
        broken.push(`${spec} → ${glob}`);
      }
    }
    expect(broken).toEqual([]);
  });

  test("every glob matches ≥1 real file (or is an allowed extension dir)", () => {
    const empties: string[] = [];
    for (const { spec, glob } of allGlobs) {
      const g = new Glob(escapeGlob(glob));
      const matches = universe.some((f) => g.match(f));
      // Extension-served surfaces (e.g. graded-card-scanner) legitimately live
      // outside web/src; those are allowed even though they never match a
      // web/src visual-surface file.
      const allowedNonWebSrc = glob.startsWith("docs/extensions/");
      if (!matches && !allowedNonWebSrc) empties.push(`${spec} → ${glob}`);
    }
    expect(empties).toEqual([]);
  });
});
