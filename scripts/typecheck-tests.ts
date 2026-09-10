/**
 * Wave-3 tests-typecheck legs (CI audit item 3.3): backend test files
 * (tsconfig.tests.json) + web/e2e specs (web/tsconfig.e2e.json) — surfaces
 * previously typechecked by NOTHING.
 *
 * Both programs include every test. The committed exclusion lists in
 * scripts/typecheck-tests-ratchet.json are kept only as an explicit,
 * fail-closed anti-regression control: they must stay empty. tsc has no CLI
 * --exclude, and a child tsconfig's `exclude` REPLACES its parent's, so this
 * script writes a temp child config per leg to preserve structural excludes.
 *
 * RATCHET RULES (enforced here, fail-closed):
 *   - Both arrays must be empty. Any listed test fails this command before
 *     TypeScript runs.
 *   - Arrays must contain only strings and no duplicates.
 * This makes adding an exclusion an immediate, visible gate failure.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

interface Ratchet {
  backendTests: string[];
  e2eSpecs: string[];
}

function fail(msg: string): never {
  console.error(`::error::typecheck-tests: ${msg}`);
  process.exit(1);
}

/**
 * Pure ratchet-shape validation (exported for gate-scripts.test.ts).
 * A valid committed ratchet is an empty pair of arrays.
 */
export function ratchetViolation(
  key: string,
  list: unknown,
): string | null {
  if (!Array.isArray(list) || list.some((f) => typeof f !== "string")) {
    return `ratchet ${key} must be a string array`;
  }
  if (new Set(list).size !== list.length) return `ratchet ${key} contains duplicates`;
  if (list.length !== 0) {
    return `ratchet ${key} must be empty — fix type errors instead of excluding test files`;
  }
  return null;
}

async function loadRatchet(): Promise<Ratchet> {
  const raw = await Bun.file(join(REPO_ROOT, "scripts/typecheck-tests-ratchet.json")).json();
  for (const key of ["backendTests", "e2eSpecs"] as const) {
    const violation = ratchetViolation(key, raw[key]);
    if (violation !== null) fail(violation);
  }
  return raw as Ratchet;
}

function runTscWithRatchet(opts: {
  label: string;
  parentConfig: string; // absolute
  structuralExcludes: string[]; // absolute or root-relative-to-parent semantics replicated as absolutes
  ratchetFiles: string[]; // repo-relative
  cwd: string;
  tmpRoot: string;
}): number {
  const childPath = join(opts.tmpRoot, `tsconfig.${opts.label}.json`);
  writeFileSync(
    childPath,
    JSON.stringify(
      {
        extends: opts.parentConfig,
        exclude: [...opts.structuralExcludes, ...opts.ratchetFiles.map((f) => join(REPO_ROOT, f))],
      },
      null,
      2,
    ),
  );
  console.log(
    `→ Typechecking ${opts.label} (${opts.ratchetFiles.length} ratcheted file(s) excluded)...`,
  );
  const proc = Bun.spawnSync(["bun", "x", "tsc", "--noEmit", "-p", childPath], {
    cwd: opts.cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exitCode ?? 1;
}

async function main(): Promise<void> {
  const ratchet = await loadRatchet();
  const tmpRoot = mkdtempSync(join(tmpdir(), "typecheck-tests-"));
  try {
    const backendExit = runTscWithRatchet({
      label: "backend-tests",
      parentConfig: join(REPO_ROOT, "tsconfig.tests.json"),
      // Mirrors tsconfig.tests.json's exclude (child exclude REPLACES it).
      structuralExcludes: ["**/node_modules/**", "**/worktrees/**"],
      ratchetFiles: ratchet.backendTests,
      cwd: REPO_ROOT,
      tmpRoot,
    });
    const e2eExit = runTscWithRatchet({
      label: "web-e2e",
      parentConfig: join(REPO_ROOT, "web/tsconfig.e2e.json"),
      // The parent relies on tsc's DEFAULT exclude (node_modules); an
      // explicit child exclude drops that default, so restate it.
      structuralExcludes: ["**/node_modules/**"],
      ratchetFiles: ratchet.e2eSpecs,
      cwd: join(REPO_ROOT, "web"),
      tmpRoot,
    });
    if (backendExit !== 0 || e2eExit !== 0) {
      console.error(
        `✗ tests-typecheck failed (backend-tests exit ${backendExit}, web-e2e exit ${e2eExit}).`,
      );
      process.exit(1);
    }
    console.log("✓ tests-typecheck passed (backend tests + web/e2e).");
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await main();
}
