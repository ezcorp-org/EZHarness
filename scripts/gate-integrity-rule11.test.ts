/**
 * W03g: gate-integrity check 11. Any change to the patch gate (it holds the
 * attestation schema) or to scripts/coverage-attestations.json needs the
 * gate-change-approved label. The fixtures pin the name-status parsing for every
 * status; the two end-to-end cases run the real gate in a scratch repository,
 * so the wiring in main() is proved, not only the helper.
 */
import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scratchRepository } from "../src/__tests__/helpers/scratch-git";
import { ATTESTATION_SURFACE, attestationSurfaceViolations } from "./gate-integrity.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const LABEL_HINT = "an attestation lets an uncovered line pass";

describe("gate-integrity check 11: the attestation surface needs the label", () => {
  test("the surface is exactly the patch gate and the attestation file", () => {
    expect(ATTESTATION_SURFACE).toEqual(["scripts/check-patch-coverage.ts", "scripts/coverage-attestations.json"]);
  });

  test.each([
    ["the attestation file added", "A\tscripts/coverage-attestations.json", ["A scripts/coverage-attestations.json"]],
    ["an entry changed", "M\tscripts/coverage-attestations.json", ["M scripts/coverage-attestations.json"]],
    ["the attestation file deleted", "D\tscripts/coverage-attestations.json", ["D scripts/coverage-attestations.json"]],
    ["the patch gate (and its schema) changed", "M\tscripts/check-patch-coverage.ts", ["M scripts/check-patch-coverage.ts"]],
    ["the attestation file renamed away", "R100\tscripts/coverage-attestations.json\tscripts/old.json", ["R scripts/coverage-attestations.json"]],
    ["another file renamed onto the patch gate", "R090\tscripts/other.ts\tscripts/check-patch-coverage.ts", ["R scripts/check-patch-coverage.ts"]],
    ["a copy onto the attestation file", "C100\tscripts/coverage-thresholds.json\tscripts/coverage-attestations.json", ["C scripts/coverage-attestations.json"]],
  ])("%s is flagged", (_label, nameStatus, expected) => {
    expect(attestationSurfaceViolations(nameStatus)).toEqual(
      expected.map((change) => `patch-gate attestation surface changed (${change}) — ${LABEL_HINT}`),
    );
  });

  test("files beside the surface are not flagged, and blank lines are ignored", () => {
    const nameStatus = [
      "M\tscripts/check-patch-coverage-typeonly.test.ts",
      "A\tscripts/check-patch-coverage-attestation.test.ts",
      "M\tscripts/coverage-thresholds.json",
      "",
      "M\tsrc/factory/task-stops.ts",
    ].join("\n");
    expect(attestationSurfaceViolations(nameStatus)).toEqual([]);
  });

  test("a C-quoted path is unquoted before it is matched", () => {
    expect(attestationSurfaceViolations('M\t"scripts/coverage-attestations.json"')).toEqual([
      `patch-gate attestation surface changed (M scripts/coverage-attestations.json) — ${LABEL_HINT}`,
    ]);
  });
});

/**
 * A scratch repository holding the real gate, one commit that changes the
 * attestation file, and the locked parser on NODE_PATH. Each end-to-end case
 * spawns the gate exactly once, under its own 60 s bound: a cold `bun` spawn
 * took up to 22 s on this host under swap pressure (W18 hygiene C2), so the
 * bound covers one spawn with margin and never a chain of them.
 */
function gateAfterAttestationChange(approved: boolean) {
  const root = mkdtempSync(join(tmpdir(), "gate-integrity-rule11-"));
  try {
    const repo = scratchRepository(root, { name: "Gate fixture", email: "gate-fixture@example.test" });
    mkdirSync(join(repo.dir, "scripts"), { recursive: true });
    for (const relative of ["scripts/gate-integrity.ts", "scripts/coverage-config.ts", "scripts/unified-diff.ts"]) {
      cpSync(join(REPO_ROOT, relative), join(repo.dir, relative));
    }
    writeFileSync(join(repo.dir, "biome.json"), '{ "linter": { "enabled": true } }\n');
    repo.git("add", ".");
    repo.git("commit", "--quiet", "-m", "base");
    repo.git("branch", "gate-base");
    writeFileSync(join(repo.dir, "scripts/coverage-attestations.json"), "[]\n");
    repo.git("add", ".");
    repo.git("commit", "--quiet", "-m", "attestation file");
    const env: Record<string, string> = {
      ...repo.env,
      BASE_REF: "gate-base",
      NODE_PATH: join(REPO_ROOT, ".github/gate-integrity-deps/node_modules"),
    };
    if (approved) env.GATE_CHANGE_APPROVED = "1";
    const run = Bun.spawnSync([process.execPath, "scripts/gate-integrity.ts"], { cwd: repo.dir, env, stdout: "pipe", stderr: "pipe" });
    return { exitCode: run.exitCode, output: `${run.stdout.toString()}${run.stderr.toString()}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("gate-integrity check 11 end to end", () => {
  test("without the label, a new attestation file fails the gate by name", () => {
    const result = gateAfterAttestationChange(false);
    expect(result.output).toContain(
      `patch-gate attestation surface changed (A scripts/coverage-attestations.json) — ${LABEL_HINT} — needs the gate-change-approved label`,
    );
    expect(result.exitCode, result.output).toBe(1);
  }, 60_000);

  test("with the label, the same change passes and is logged as bypassed", () => {
    const result = gateAfterAttestationChange(true);
    expect(result.output).toContain("(bypassed) patch-gate attestation surface changed (A scripts/coverage-attestations.json)");
    expect(result.exitCode, result.output).toBe(0);
  }, 60_000);
});
