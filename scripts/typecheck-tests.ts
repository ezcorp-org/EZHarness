/**
 * Wave-3 tests-typecheck legs (CI audit item 3.3): backend test files
 * (tsconfig.tests.json) + web/e2e specs (web/tsconfig.e2e.json) — surfaces
 * previously typechecked by NOTHING.
 *
 * Both programs run MINUS the dirty-file ratchet
 * (scripts/typecheck-tests-ratchet.json): files with pre-existing errors at
 * landing (backend 231 errors/37 files; e2e 74/15). tsc has no CLI
 * --exclude, and a child tsconfig's `exclude` REPLACES its parent's, so
 * this script writes a temp child config per leg (absolute `extends` +
 * absolute exclude paths — relative ones would resolve against the temp
 * dir) merging the parent's structural excludes with the ratchet entries.
 *
 * RATCHET RULES (enforced here, fail-closed):
 *   - shrink-only: list length can never exceed the landing-time ceiling
 *     below. Fix a file → delete its entry. Adding an entry requires
 *     raising the ceiling in THIS file — a CODEOWNERS-owned gate script —
 *     i.e. human review, never a drive-by.
 *   - no stale entries: a listed file that no longer exists fails.
 *   - no duplicates.
 * A ratcheted file's errors are honest TODOs; everything else gates NOW.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

// Landing-time ceilings (2026-07-17). Shrink freely; raising = review.
const BACKEND_RATCHET_CEILING = 37;
const E2E_RATCHET_CEILING = 15;

interface Ratchet {
  backendTests: string[];
  e2eSpecs: string[];
}

function fail(msg: string): never {
  console.error(`::error::typecheck-tests: ${msg}`);
  process.exit(1);
}

async function loadRatchet(): Promise<Ratchet> {
  const raw = await Bun.file(join(REPO_ROOT, "scripts/typecheck-tests-ratchet.json")).json();
  for (const [key, ceiling] of [
    ["backendTests", BACKEND_RATCHET_CEILING],
    ["e2eSpecs", E2E_RATCHET_CEILING],
  ] as const) {
    const list = raw[key];
    if (!Array.isArray(list) || list.some((f) => typeof f !== "string")) {
      fail(`ratchet ${key} must be a string array`);
    }
    if (list.length > ceiling) {
      fail(
        `ratchet ${key} has ${list.length} entries > ceiling ${ceiling} — the list only ` +
          `shrinks. Fix the type errors instead of excluding new files (raising the ceiling ` +
          `requires editing scripts/typecheck-tests.ts under review).`,
      );
    }
    if (new Set(list).size !== list.length) fail(`ratchet ${key} contains duplicates`);
    for (const f of list) {
      if (!(await Bun.file(join(REPO_ROOT, f)).exists())) {
        fail(`ratchet ${key} entry '${f}' does not exist — remove the stale entry`);
      }
    }
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
