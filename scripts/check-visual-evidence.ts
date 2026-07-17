#!/usr/bin/env bun
/**
 * Visual-evidence gate (diff-scoped).
 *
 * The coverage gates prove that changed *lines* are exercised, but a `.svelte`
 * / `.css` edit can be 100%-covered by a non-visual unit test and still ship a
 * broken-looking screen nobody actually rendered. This gate closes that hole:
 * any PR that touches a USER-VISIBLE surface must also add or modify a
 * Playwright spec under `web/e2e/` (tagged `@evidence`) that renders the change
 * — so every visual edit lands with a browser-level screenshot/assertion behind
 * it.
 *
 * Visual surface = a repo-relative path matching ANY of:
 *   web/src/routes/**\/+page.svelte, web/src/routes/**\/+layout.svelte,
 *   web/src/lib/components/**\/*.svelte, web/src/**\/*.css, web/src/app.css
 * MINUS anything under web/src/lib/server/** (server code is never visual).
 *
 * NOTE: the surface is defined here, NOT via coverage `EXCLUDES` — that list
 * deliberately excludes route `+page.svelte` from line-coverage, so reusing it
 * here would silently let route pages dodge the visual gate (false negative).
 *
 * Maintainer-only bypass: a genuine non-visual `.svelte` edit (logic-only,
 * no rendered change) can be exempted with the restricted `evidence-exempt`
 * label, which CI surfaces as `EVIDENCE_EXEMPT=1` — authors cannot apply it.
 *
 * COVERS MAP (`web/e2e/evidence-covers.json`): a plain PR spec that only needs
 * *some* @evidence spec touched is a blunt instrument — a chat-footer edit could
 * be "evidenced" by an unrelated settings spec. The covers map pins each visual
 * source glob to the @evidence spec(s) that actually render it, so a changed
 * visual file with a covering entry must have ONE OF ITS covering specs changed
 * (not just any spec). Files with no covering entry fall back to the old coarse
 * rule (any changed spec passes). The map also drives capture selection
 * (`visual-evidence/select-specs.ts`) so the shots posted match the diff. A
 * missing / unparseable map fails OPEN to the coarse rule (a warning is logged)
 * — the gate must never harden into a wall over a bad JSON edit.
 *
 * Pure helpers exported for unit testing; main() wires git + env + the map file.
 */
import { Glob } from "bun";
import { join } from "node:path";
import { escapeGlob, REPO_ROOT } from "./coverage-config.ts";

/**
 * Globs for the user-visible surface. A file is a visual surface iff it matches
 * one of these AND is not under web/src/lib/server/** (see isVisualSurfaceFile).
 */
export const VISUAL_SURFACE_GLOBS: readonly string[] = [
  "web/src/routes/**/+page.svelte",
  "web/src/routes/**/+layout.svelte",
  "web/src/lib/components/**/*.svelte",
  "web/src/**/*.css",
  "web/src/app.css",
];

/** Server code is never a visual surface, even if it matches a surface glob. */
const SERVER_GLOBS: readonly string[] = ["web/src/lib/server/**"];

/** Playwright specs that count as visual evidence. */
export const SPEC_GLOBS: readonly string[] = ["web/e2e/**/*.spec.ts"];

const visualGlobs = VISUAL_SURFACE_GLOBS.map((p) => new Glob(escapeGlob(p)));
const serverGlobs = SERVER_GLOBS.map((p) => new Glob(escapeGlob(p)));
const specGlobs = SPEC_GLOBS.map((p) => new Glob(escapeGlob(p)));

/**
 * True iff a repo-relative path is a user-visible surface: matches a
 * visual-surface glob and is NOT under web/src/lib/server/**.
 */
export function isVisualSurfaceFile(path: string): boolean {
  if (serverGlobs.some((g) => g.match(path))) return false;
  return visualGlobs.some((g) => g.match(path));
}

/** True iff a repo-relative path is a Playwright spec under web/e2e/. */
export function isSpecFile(path: string): boolean {
  return specGlobs.some((g) => g.match(path));
}

/**
 * Pure decision: given the set of changed files, return a human-readable
 * violation message if ≥1 file is a visual surface AND zero files are a
 * Playwright spec; otherwise null (the gate passes).
 */
export function visualEvidenceViolation(changedFiles: readonly string[]): string | null {
  const visual = changedFiles.filter(isVisualSurfaceFile);
  if (visual.length === 0) return null;
  if (changedFiles.some(isSpecFile)) return null;
  return (
    `${visual.length} user-visible surface file(s) changed without any Playwright evidence:\n` +
    visual.map((f) => `  - ${f}`).join("\n") +
    `\nAdd or modify an @evidence-tagged Playwright spec under web/e2e/ that renders ` +
    `this change (so the visual edit lands with a browser-level screenshot/assertion). ` +
    `For a genuine non-visual .svelte edit (logic-only, nothing rendered changes), ` +
    `request the maintainer-only \`evidence-exempt\` label instead.`
  );
}

/**
 * Covers map shape: repo-relative @evidence spec path → the repo-relative
 * source globs it renders. Read from `web/e2e/evidence-covers.json`.
 */
export type CoversMap = Record<string, readonly string[]>;

/** Absolute path of the covers manifest (HEAD checkout). */
export const COVERS_PATH = join(REPO_ROOT, "web/e2e/evidence-covers.json");

/**
 * Runtime shape guard for a parsed covers map: a plain object whose every value
 * is an array of strings. Anything else (array, null, non-string globs) is
 * rejected so a malformed edit fails OPEN to the coarse rule rather than
 * throwing mid-gate.
 */
export function isValidCoversMap(raw: unknown): raw is CoversMap {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
  for (const globs of Object.values(raw as Record<string, unknown>)) {
    if (!Array.isArray(globs) || globs.some((g) => typeof g !== "string")) return false;
  }
  return true;
}

/**
 * Compiled-glob cache, keyed by covers-map identity. Both the gate and the
 * selector call {@link coveringSpecsForFile} once per changed visual file with
 * the SAME map object — without the cache every call recompiled all ~75 globs
 * (O(changedFiles × globs) Glob constructions per process).
 */
const compiledCovers = new WeakMap<CoversMap, [string, Glob[]][]>();

/**
 * Pure: the covers-map spec keys whose globs match `file` (a repo-relative
 * path), sorted. Globs are escaped the same way as the surface globs so a
 * SvelteKit `[id]` segment matches literally. Used by both the gate (∃ covering
 * spec changed?) and the capture selector (union of covering specs).
 */
export function coveringSpecsForFile(file: string, coversMap: CoversMap): string[] {
  let compiled = compiledCovers.get(coversMap);
  if (!compiled) {
    compiled = Object.entries(coversMap).map(([spec, globs]) => [
      spec,
      globs.map((p) => new Glob(escapeGlob(p))),
    ]);
    compiledCovers.set(coversMap, compiled);
  }
  const hits: string[] = [];
  for (const [spec, globs] of compiled) {
    if (globs.some((g) => g.match(file))) hits.push(spec);
  }
  return hits.sort();
}

/**
 * Covers-aware decision. Same outer contract as {@link visualEvidenceViolation}
 * (null = pass, string = human-readable failure), but sharper when a covers map
 * is available:
 *   - no changed visual files            → pass.
 *   - changed visual files, NO changed spec → the coarse violation (identical
 *     message to the map-less gate — the whole point is a spec must be touched).
 *   - a changed visual file that HAS covering specs, none of which is among the
 *     changed specs → violation naming the file and its covering specs.
 *   - a changed visual file with NO covering entry keeps the coarse rule (any
 *     changed spec — of which there is at least one here — satisfies it).
 */
export function visualEvidenceViolationWithCovers(
  changedFiles: readonly string[],
  coversMap: CoversMap,
): string | null {
  const visual = changedFiles.filter(isVisualSurfaceFile);
  if (visual.length === 0) return null;

  const changedSpecs = changedFiles.filter(isSpecFile);
  // No spec touched at all → coarse violation, byte-identical to the map-less
  // gate (the map can only ever make the gate stricter once a spec IS present).
  if (changedSpecs.length === 0) return visualEvidenceViolation(changedFiles);

  const changedSpecSet = new Set(changedSpecs);
  const offenders = visual
    .map((file) => ({ file, covers: coveringSpecsForFile(file, coversMap) }))
    .filter(({ covers }) => covers.length > 0 && !covers.some((s) => changedSpecSet.has(s)));

  if (offenders.length === 0) return null;
  return (
    `${offenders.length} changed visual file(s) are rendered by specific @evidence spec(s) ` +
    `that this diff did not touch:\n` +
    offenders
      .map(({ file, covers }) => `  - ${file}\n      covered by: ${covers.join(", ")}`)
      .join("\n") +
    `\nChange one of each file's covering specs (so the edit is re-screenshotted), or add a new ` +
    `@evidence spec under web/e2e/ and map it in web/e2e/evidence-covers.json. ` +
    `For a genuine non-visual .svelte edit (logic-only, nothing rendered changes), ` +
    `request the maintainer-only \`evidence-exempt\` label instead.`
  );
}

/**
 * Load + validate the covers map from disk. Returns null (and logs a warning)
 * on a missing / unreadable / unparseable / mis-shaped file so main() can fail
 * OPEN to the coarse gate.
 */
export async function loadCoversMap(path: string = COVERS_PATH): Promise<CoversMap | null> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      console.warn(`Visual-evidence gate: covers map not found at ${path} — using coarse rule.`);
      return null;
    }
    const raw = (await file.json()) as unknown;
    if (!isValidCoversMap(raw)) {
      console.warn(`Visual-evidence gate: covers map at ${path} is malformed — using coarse rule.`);
      return null;
    }
    return raw;
  } catch (err) {
    console.warn(`Visual-evidence gate: covers map unreadable (${String(err)}) — using coarse rule.`);
    return null;
  }
}

/**
 * Shared diff helper: `git diff --diff-filter=ACMR --name-only <base>...HEAD`
 * parsed to trimmed, non-empty repo-relative paths. THROWS on a non-zero git
 * exit — each caller owns its failure policy: the gate fails LOUD (a required
 * check must never silently pass on a broken BASE_REF), the capture selector
 * fails OPEN to `__ALL__` (a soft lane must never silently skip evidence).
 * Lives here so the gate and the selector can never drift on what "changed"
 * means.
 */
export async function changedFilesSince(base: string): Promise<string[]> {
  const proc = Bun.spawn(
    ["git", "diff", "--diff-filter=ACMR", "--name-only", `${base}...HEAD`],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git diff exited ${code}: ${err.trim()}`);
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main(): Promise<void> {
  if (process.env.EVIDENCE_EXEMPT === "1") {
    console.log("Visual-evidence gate PASSED: exempt (evidence-exempt label).");
    return;
  }

  const base = process.env.BASE_REF || "origin/main";
  let changed: string[];
  try {
    changed = await changedFilesSince(base);
  } catch (err) {
    // A required check must fail LOUD, not silently pass on an empty diff.
    console.error(`Visual-evidence gate ERROR: could not diff ${base}...HEAD — ${String(err)}`);
    process.exit(1);
  }

  const visualCount = changed.filter(isVisualSurfaceFile).length;
  const specCount = changed.filter(isSpecFile).length;

  // Covers-aware when the map loads; fail-open to the coarse rule otherwise.
  const coversMap = await loadCoversMap();
  const violation =
    coversMap === null
      ? visualEvidenceViolation(changed)
      : visualEvidenceViolationWithCovers(changed, coversMap);
  if (violation === null) {
    console.log(
      `Visual-evidence gate PASSED: ${visualCount} visual surface file(s), ` +
        `${specCount} Playwright spec(s) in this diff.`,
    );
    return;
  }
  console.error(`Visual-evidence gate FAILED:\n${violation}`);
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
