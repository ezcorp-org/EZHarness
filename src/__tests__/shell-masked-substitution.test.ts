/**
 * `export X="$(cmd)"` (and `local`, `readonly`, `declare`) returns the
 * builtin's status, not cmd's, so a failed command does not stop a
 * `set -e` script: it continues with an empty value. Assign first, then
 * export (`X="$(cmd)"; export X`). ShellCheck calls this SC2155.
 *
 * Scope: the deploy and release shell scripts. Gate and coverage tooling is
 * owned elsewhere and is not scanned here.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const EXCLUDED = /(^|\/)(coverage-[^/]*|[^/]*-coverage[^/]*|gate-integrity[^/]*|check-[^/]*|test[^/]*\.sh)$/;

function shellScripts(): string[] {
  const listed = (dir: string) =>
    readdirSync(join(REPO_ROOT, dir)).filter((name) => name.endsWith(".sh")).map((name) => `${dir}/${name}`);
  return [
    ...listed("scripts"),
    ...listed("scripts/lib"),
    ...listed("deploy/extension-runner"),
    "deploy/installer/ezcorp",
  ].filter((path) => !EXCLUDED.test(path));
}

/** A declaration builtin whose assigned value runs a command substitution (not plain `$((`). */
const MASKED = /^\s*(export|local|readonly|declare)(\s+-\w+)*\s+[A-Za-z_][A-Za-z0-9_]*=.*\$\((?!\()/;

describe("deploy and release shell scripts", () => {
  test("the scan covers the scripts named in the review", () => {
    const scripts = shellScripts();
    expect(scripts).toContain("scripts/verify-extension-container.sh");
    expect(scripts).toContain("scripts/start-real-extension-preview.sh");
    expect(scripts).not.toContain("scripts/test.sh");
  });

  test("never hide a command substitution's failure behind a declaration builtin", () => {
    const offenders: string[] = [];
    for (const path of shellScripts()) {
      readFileSync(join(REPO_ROOT, path), "utf8").split("\n").forEach((line, index) => {
        if (MASKED.test(line)) offenders.push(`${path}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
