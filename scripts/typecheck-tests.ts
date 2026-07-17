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
 *   - SUBSET-only: every entry must be one of the landing-time baseline
 *     entries frozen below — entries can be REMOVED (fix a file → delete
 *     its line) but never added or swapped (removing A while adding B
 *     keeps the length, so a length check alone would miss it).
 *   - shrink-only ceiling kept as a secondary belt.
 *   - no stale entries: a listed file that no longer exists fails.
 *   - no duplicates.
 * Both this script and the ratchet JSON are CODEOWNERS-owned, so growing
 * the baseline or the ceiling requires a human gate-owner review either
 * way; these checks exist so such a change can never ride in silently on
 * an unrelated diff.
 * A ratcheted file's errors are honest TODOs; everything else gates NOW.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

// Landing-time ceilings (2026-07-17). Shrink freely; raising = review.
// Exported (with the baselines) so gate-scripts.test.ts can validate the
// COMMITTED ratchet JSON against the committed truth.
export const BACKEND_RATCHET_CEILING = 37;
export const E2E_RATCHET_CEILING = 15;

// Landing-time BASELINES (2026-07-17): the frozen universe of ratchetable
// files. The live JSON must stay a subset of these.
export const BACKEND_RATCHET_BASELINE: readonly string[] = [
  "src/integrations/github-projects/__tests__/client-core.test.ts",
  "src/integrations/github-projects/__tests__/progress.test.ts",
  "src/integrations/github-projects/__tests__/spawn.test.ts",
  "src/integrations/github-projects/__tests__/web-connect-flow.integration.test.ts",
  "src/__tests__/auth-layout-integration.test.ts",
  "src/__tests__/auth-layout.test.ts",
  "src/__tests__/await-run-completion.test.ts",
  "src/__tests__/briefing-api.test.ts",
  "src/__tests__/builtin-tool-watchdog-no-regression.integration.test.ts",
  "src/__tests__/chat-tool-loop-e2e.test.ts",
  "src/__tests__/db-migration-pg-trgm.test.ts",
  "src/__tests__/extension-runtime.test.ts",
  "src/__tests__/goal-host-db-helpers.test.ts",
  "src/__tests__/goal-host-unit.test.ts",
  "src/__tests__/host-maintenance-daemon.test.ts",
  "src/__tests__/host-maintenance-gin-sweep.test.ts",
  "src/__tests__/hub-api.test.ts",
  "src/__tests__/hub-render-pull.test.ts",
  "src/__tests__/installer-coverage.test.ts",
  "src/__tests__/json-rpc-streaming.test.ts",
  "src/__tests__/mcp-install-query.test.ts",
  "src/__tests__/mcp-netns-integration.test.ts",
  "src/__tests__/observability-collector.test.ts",
  "src/__tests__/openai-image-gen-2-watchdog-e2e.integration.test.ts",
  "src/__tests__/raw-query.test.ts",
  "src/__tests__/runtime-tools-edit-file.test.ts",
  "src/__tests__/runtime-tools-glob.test.ts",
  "src/__tests__/runtime-tools-list-files.test.ts",
  "src/__tests__/runtime-tools-read-directory.test.ts",
  "src/__tests__/runtime-tools-read-file.test.ts",
  "src/__tests__/runtime-tools-shell.test.ts",
  "src/__tests__/seam-observability-resilience-integration.test.ts",
  "src/__tests__/session-backfill-parity.test.ts",
  "src/__tests__/subscribe-bridge-cardlayout.test.ts",
  "src/__tests__/task-tracking-extension.test.ts",
  "src/__tests__/tool-executor-per-conversation-depth.test.ts",
  "src/__tests__/watchdog-tool-error-emission.integration.test.ts",
];
export const E2E_RATCHET_BASELINE: readonly string[] = [
  "web/e2e/agents-new.spec.ts",
  "web/e2e/agent-team-prepopulation.spec.ts",
  "web/e2e/conversation-tools-scope.spec.ts",
  "web/e2e/extensions-library-tabs.spec.ts",
  "web/e2e/extensions-mcp-edit.spec.ts",
  "web/e2e/extensions-mcp-tab.spec.ts",
  "web/e2e/extensions.spec.ts",
  "web/e2e/file-mentions.spec.ts",
  "web/e2e/inline-custom-card.spec.ts",
  "web/e2e/menu-keyboard-nav.spec.ts",
  "web/e2e/modes-extensions.spec.ts",
  "web/e2e/picker-pills.spec.ts",
  "web/e2e/task-card-actions-full.spec.ts",
  "web/e2e/tool-call-anchoring.spec.ts",
  "web/e2e/v1.3-permission-backbone.spec.ts",
];

interface Ratchet {
  backendTests: string[];
  e2eSpecs: string[];
}

function fail(msg: string): never {
  console.error(`::error::typecheck-tests: ${msg}`);
  process.exit(1);
}

/**
 * Pure ratchet-shape validation (exported for gate-scripts.test.ts):
 * string-array, no duplicates, ceiling, and SUBSET of the frozen baseline.
 * Returns the first violation message or null. File-existence is checked
 * by the caller (fs-dependent).
 */
export function ratchetViolation(
  key: string,
  list: unknown,
  ceiling: number,
  baseline: readonly string[],
): string | null {
  if (!Array.isArray(list) || list.some((f) => typeof f !== "string")) {
    return `ratchet ${key} must be a string array`;
  }
  if (list.length > ceiling) {
    return (
      `ratchet ${key} has ${list.length} entries > ceiling ${ceiling} — the list only ` +
      `shrinks. Fix the type errors instead of excluding new files.`
    );
  }
  if (new Set(list).size !== list.length) return `ratchet ${key} contains duplicates`;
  const allowed = new Set(baseline);
  for (const f of list) {
    if (!allowed.has(f)) {
      return (
        `ratchet ${key} entry '${f}' is not in the landing-time baseline — entries can only ` +
        `be REMOVED, never added or swapped. New type errors must be fixed, not ratcheted.`
      );
    }
  }
  return null;
}

async function loadRatchet(): Promise<Ratchet> {
  const raw = await Bun.file(join(REPO_ROOT, "scripts/typecheck-tests-ratchet.json")).json();
  for (const [key, ceiling, baseline] of [
    ["backendTests", BACKEND_RATCHET_CEILING, BACKEND_RATCHET_BASELINE],
    ["e2eSpecs", E2E_RATCHET_CEILING, E2E_RATCHET_BASELINE],
  ] as const) {
    const violation = ratchetViolation(key, raw[key], ceiling, baseline);
    if (violation !== null) fail(violation);
    for (const f of raw[key] as string[]) {
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
