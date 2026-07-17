#!/usr/bin/env bun
/**
 * Visual-evidence CHANGED-FILES EXPANDER (WF2, `visual-evidence-publish.yml`).
 *
 * WF1's capture lane runs the covers-UNION: the changed specs PLUS every
 * @evidence spec whose covers-map globs render a changed visual file. Without
 * this script, WF2's gallery partition floated only the literally-changed spec
 * files inline — the covers-selected shots (which directly re-render the
 * changed component, often the most diff-relevant evidence) were folded into
 * the <details> block. This expander aligns the float scope with the capture
 * scope: it appends the covering specs of every changed visual file to the
 * changed-files list before pass-2 renders the comment.
 *
 * TRUST MODEL: runs in the PRIVILEGED tier but consumes only TRUSTED inputs —
 * the changed-file list fetched from the GitHub API (attacker-chosen file
 * NAMES, but they only ever feed Glob.match) and the DEFAULT-branch covers map
 * + glob helpers (this workflow never checks out PR code). Output lines are
 * either the original API lines or spec-path KEYS from the default-branch map.
 * The result stays presentation-only: publish.ts re-filters it through
 * parseChangedSpecPaths and uses it solely to order the gallery.
 *
 * Fail-soft: on ANY error the input file is left untouched and the exit code
 * is 0 — a broken expansion degrades to the unexpanded partition, never a red
 * workflow or a missing comment.
 *
 * Import chain is bun/node builtins only (Glob from "bun" + node:path via
 * check-visual-evidence.ts/coverage-config.ts) — WF2 runs with NO bun install.
 */
import {
  type CoversMap,
  coveringSpecsForFile,
  isVisualSurfaceFile,
  loadCoversMap,
} from "../check-visual-evidence.ts";

/**
 * Pure: append to `lines` (deduped, original order preserved) every covers-map
 * spec whose globs render one of the changed visual files. Non-visual lines
 * pass through untouched; already-present specs are not duplicated.
 */
export function expandChangedFiles(lines: readonly string[], coversMap: CoversMap): string[] {
  const out = [...lines];
  const seen = new Set(lines);
  for (const line of lines) {
    if (!isVisualSurfaceFile(line)) continue;
    for (const spec of coveringSpecsForFile(line, coversMap)) {
      if (!seen.has(spec)) {
        seen.add(spec);
        out.push(spec);
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  try {
    const file = process.argv[2];
    if (!file) return; // no target — nothing to do, fail-soft
    const coversMap = await loadCoversMap();
    if (!coversMap) return; // missing/malformed map → leave the list unexpanded
    const lines = (await Bun.file(file).text())
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const expanded = expandChangedFiles(lines, coversMap);
    await Bun.write(file, `${expanded.join("\n")}\n`);
    console.log(
      `expand-changed-specs: ${lines.length} line(s) → ${expanded.length} (covering specs appended).`,
    );
  } catch (err) {
    // Fail-soft: never red the privileged workflow over a presentation aid.
    console.error(`expand-changed-specs: skipped (${String(err)})`);
  }
}

if (import.meta.main) {
  await main();
}
