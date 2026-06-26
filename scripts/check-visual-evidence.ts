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
 * Pure helpers exported for unit testing; main() wires git + env.
 */
import { Glob } from "bun";
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

async function git(args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 ? out : "";
}

async function main(): Promise<void> {
  if (process.env.EVIDENCE_EXEMPT === "1") {
    console.log("Visual-evidence gate PASSED: exempt (evidence-exempt label).");
    return;
  }

  const base = process.env.BASE_REF || "origin/main";
  const changed = (await git(["diff", "--diff-filter=ACMR", "--name-only", `${base}...HEAD`]))
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const visualCount = changed.filter(isVisualSurfaceFile).length;
  const specCount = changed.filter(isSpecFile).length;

  const violation = visualEvidenceViolation(changed);
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
