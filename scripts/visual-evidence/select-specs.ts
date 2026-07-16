#!/usr/bin/env bun
/**
 * Visual-evidence CAPTURE SELECTOR (WF1, `ci.yml` job `visual-evidence`).
 *
 * The capture lane used to run EVERY `@evidence` spec on every PR, so the
 * publisher posted 46–51 screenshots per PR of which ~95% were unrelated to the
 * diff. This script narrows the capture set based purely on the PR's
 * changed-file list:
 *
 *   selection = { changed specs that are @evidence-TAGGED }
 *             ∪ { specs whose covers-map globs render a changed visual file }
 *
 *   - selection empty, nothing visual changed        → __NONE__
 *       Skip capture; WF1 uploads a `skipped` marker manifest so WF2 can
 *       refresh a stale gallery comment (update-only, never a new comment).
 *       This is the decided behaviour for a PR that touches nothing
 *       user-visible — including a changed but non-@evidence spec (the
 *       majority of e2e specs), which has nothing to screenshot — and, as an
 *       intended side effect, for `push` to main (empty base...HEAD diff).
 *   - any changed visual file with NO covering entry → __ALL__ (fail-open)
 *       The old full-suite behaviour guaranteed every rendered change was
 *       screenshotted by *something*; for an unmapped surface we cannot know
 *       which spec renders it, so the whole suite runs rather than shipping a
 *       visual change nobody rendered. Growing `evidence-covers.json` shrinks
 *       how often this branch fires.
 *   - visual change but the covers map failed to load → __ALL__ (same reason).
 *   - otherwise                                       → the selection (`some`),
 *       printed as Playwright-rootDir-relative (`e2e/x.spec.ts`, rootDir =
 *       web/) positional args, sorted + deduped, each regex-ESCAPED — Playwright
 *       treats positional file args as regular expressions, so an unescaped
 *       metachar in a future spec filename would silently match nothing.
 *
 * DRY: "what changed" (`changedFilesSince`), "what is a visual surface" /
 * "what is a spec", and "which specs cover this file" all live once in
 * `../check-visual-evidence.ts` (the hard gate) and are imported here — the
 * selector must never drift from the gate's diff, globs, or covers map.
 *
 * `main()` is fail-OPEN: on ANY git/parse error it prints `__ALL__` and exits 0.
 * A capture selector that errored must never silently skip evidence — worst
 * case we over-capture. The ci.yml wrapper independently defaults an empty /
 * failed run to __ALL__ too, so this is belt-and-suspenders.
 *
 * Pure helpers are exported for unit testing; `main()` wires git + env + the
 * covers map + the @evidence-tag scan.
 */
import { join } from "node:path";
import {
  changedFilesSince,
  type CoversMap,
  coveringSpecsForFile,
  isSpecFile,
  isVisualSurfaceFile,
  loadCoversMap,
} from "../check-visual-evidence.ts";
import { REPO_ROOT } from "../coverage-config.ts";

/** Outcome of {@link selectEvidenceSpecs}: skip all, run all, or run a subset. */
export type SelectResult =
  | { mode: "none" }
  | { mode: "all" }
  | { mode: "some"; specs: string[] };

/**
 * Convert a repo-relative spec path (`web/e2e/x.spec.ts`) to the
 * Playwright-rootDir-relative form (`e2e/x.spec.ts`, rootDir = web/) that
 * `playwright test` expects as a positional filter. Paths that don't start
 * with `web/` are returned unchanged (defensive — the caller only feeds spec
 * paths, which always do).
 */
export function toWebRelativeSpecPath(path: string): string {
  return path.startsWith("web/") ? path.slice("web/".length) : path;
}

/**
 * Escape a spec path for use as a Playwright positional filter. Playwright
 * matches positional args as REGULAR EXPRESSIONS against test file paths, so a
 * filename containing `+ ( ) [ ] { } ^ $ | ? * . \` would otherwise be a
 * pattern that fails to match its own literal path — and the spec would be
 * silently dropped from the capture with no error.
 */
export function escapeSpecPathForPlaywright(path: string): string {
  return path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pure decision: given the PR's changed files (already ACMR-filtered by the
 * caller's git diff, so deletions never appear), pick which `@evidence` specs
 * the capture lane should run. See the module header for the full contract.
 *
 * `coversMap`: when supplied, changed visual files pull in their covering
 * specs; a changed visual file with NO covering entry (or a missing map)
 * forces `all` — an unmapped surface change must still be rendered somewhere.
 *
 * `evidenceTaggedSpecs`: the subset of changed spec paths that actually carry
 * an `@evidence` tag. Changed specs outside the set have nothing to capture
 * (`--grep @evidence` would match zero tests and the empty run would post a
 * spurious ⚠️ comment). Omitted → every changed spec is assumed tagged
 * (fail-open: over-capture, never under-report).
 */
export function selectEvidenceSpecs(
  changedFiles: readonly string[],
  coversMap?: CoversMap | null,
  evidenceTaggedSpecs?: ReadonlySet<string>,
): SelectResult {
  const changedSpecs = changedFiles.filter(isSpecFile);
  const changedVisual = changedFiles.filter(isVisualSurfaceFile);
  const taggedChangedSpecs = evidenceTaggedSpecs
    ? changedSpecs.filter((s) => evidenceTaggedSpecs.has(s))
    : changedSpecs;

  const specs = new Set(taggedChangedSpecs.map(toWebRelativeSpecPath));
  if (changedVisual.length > 0) {
    // A visual change with no way to attribute a renderer must fall open to
    // the full suite — the pre-diff-scoping guarantee was "every rendered
    // change is screenshotted by something", and we keep it.
    if (!coversMap) return { mode: "all" };
    for (const file of changedVisual) {
      const covering = coveringSpecsForFile(file, coversMap);
      if (covering.length === 0) return { mode: "all" };
      for (const spec of covering) specs.add(toWebRelativeSpecPath(spec));
    }
  }
  if (specs.size === 0) return { mode: "none" };
  return { mode: "some", specs: Array.from(specs).sort() };
}

/**
 * The subset of `changedSpecs` (repo-relative paths) whose file content carries
 * an `@evidence` tag. Substring check — the same heuristic the covers
 * meta-test uses; a title-tagged spec always contains the substring, so this
 * can only over-select (a comment-only mention), never under-select. An
 * unreadable file is assumed tagged (fail-open, over-capture).
 */
export async function evidenceTaggedSubset(
  changedSpecs: readonly string[],
  repoRoot: string = REPO_ROOT,
): Promise<Set<string>> {
  const tagged = new Set<string>();
  for (const spec of changedSpecs) {
    try {
      if ((await Bun.file(join(repoRoot, spec)).text()).includes("@evidence")) {
        tagged.add(spec);
      }
    } catch {
      tagged.add(spec);
    }
  }
  return tagged;
}

async function main(): Promise<void> {
  try {
    const base = process.env.BASE_REF || "origin/main";
    const changed = await changedFilesSince(base);
    const coversMap = await loadCoversMap();
    const tagged = await evidenceTaggedSubset(changed.filter(isSpecFile));
    const result = selectEvidenceSpecs(changed, coversMap, tagged);
    if (result.mode === "none") {
      console.log("__NONE__");
    } else if (result.mode === "all") {
      console.log("__ALL__");
    } else {
      console.log(result.specs.map(escapeSpecPathForPlaywright).join("\n"));
    }
  } catch {
    // Fail-open: never silently skip evidence on an internal error.
    console.log("__ALL__");
  }
}

if (import.meta.main) {
  await main();
}
