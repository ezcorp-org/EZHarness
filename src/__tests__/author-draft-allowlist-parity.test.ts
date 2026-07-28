/**
 * Lockstep guard for the extension-author draft file allowlist.
 *
 * The SAME seven-entry set is declared FOUR times, each deliberately
 * without importing the others (a security-relevant constant must not
 * transit a module the gate doesn't already hard-depend on — the
 * convention `ez-drafts.ts` documents):
 *
 *   1. `SCAFFOLD_DRAFT_FILES`  (src/db/queries/ez-drafts.ts)
 *      — the HOST materialize gate. A key outside it makes
 *        `writeExtensionAuthorDraftFiles` throw, and the caller treats
 *        that as a transactional create failure and discards the draft.
 *   2. `AUTHOR_DRAFT_FILES`    (web/src/lib/server/author-draft-files.ts)
 *      — the web preview page's read + PUT gate.
 *   3. `ALLOWED_DRAFT_FILES`   (the bundled extension's index.ts)
 *      — the subprocess-side `read_draft` / `write_draft_file` gate.
 *   4. the SDK scaffolder's emitted file map — what actually gets
 *      written on `create_extension`.
 *
 * Nothing checked them against each other, so a drift was silent and
 * asymmetric: add a file to the scaffolder + the extension but not to
 * (1) and every `create_extension` throws away the whole draft; add it
 * everywhere but (2) and the preview page silently neither shows nor
 * saves that file — the author edits and installs while looking at less
 * than all of it.
 *
 * Same pairing pattern (and same reason) as `card-type-parity.test.ts`.
 * The extension's copy is parsed rather than imported: its module poisons
 * `node:fs` at load.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCAFFOLD_DRAFT_FILES } from "../db/queries/ez-drafts";
import { AUTHOR_DRAFT_FILES } from "../../web/src/lib/server/author-draft-files";
import { scaffoldExtension } from "@ezcorp/sdk/scaffold";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const EXT_INDEX = join(
  REPO_ROOT,
  "docs/extensions/examples/extension-author/index.ts",
);

/** The literal entries of the extension's own `ALLOWED_DRAFT_FILES`. */
function extensionAllowlist(): string[] {
  const src = readFileSync(EXT_INDEX, "utf8");
  const start = src.indexOf("const ALLOWED_DRAFT_FILES");
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("]);", start);
  expect(end).toBeGreaterThan(start);
  return [...src.slice(start, end).matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

const sorted = (xs: Iterable<string>) => [...xs].sort();

describe("extension-author draft allowlist parity", () => {
  test("host materialize gate and web read/PUT gate name the same files", () => {
    expect(sorted(AUTHOR_DRAFT_FILES)).toEqual(sorted(SCAFFOLD_DRAFT_FILES));
  });

  test("the bundled extension's own gate names the same files", () => {
    expect(sorted(extensionAllowlist())).toEqual(sorted(SCAFFOLD_DRAFT_FILES));
  });

  test("every file the scaffolder emits is accepted by the host gate", () => {
    // `tool` emits the full set; `skill` omits `index.ts` (no entrypoint).
    // Both must be materializable — a scaffolded key the host rejects
    // discards the entire draft.
    for (const type of ["tool", "skill", "agent", "multi"] as const) {
      const { files } = scaffoldExtension({
        name: "parity-probe",
        type,
        description: "allowlist parity probe",
      });
      const rejected = Object.keys(files).filter((f) => !SCAFFOLD_DRAFT_FILES.has(f));
      expect(
        rejected,
        `scaffold("${type}") emits key(s) the host would refuse to write: ${rejected.join(", ")}`,
      ).toEqual([]);
    }
  });

  test("the set is exactly the seven documented keys", () => {
    // Pins the shape itself, so a change has to be deliberate in all
    // four places at once rather than drifting one at a time.
    expect(sorted(SCAFFOLD_DRAFT_FILES)).toEqual([
      ".gitignore",
      "README.md",
      "ezcorp.config.ts",
      "index.test.ts",
      "index.ts",
      "package.json",
      "tsconfig.json",
    ]);
  });
});
