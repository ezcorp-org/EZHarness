import { expect, test } from "bun:test";
import type { WorkspaceFiles } from "@ezcorp/extension-contract";
import { REFERENCE_CODE_GUEST_ENTRYPOINT } from "./guest";
import { REFERENCE_CODE_IMPLEMENTATIONS } from "./pack";
import { getReadiness, setReadinessDiagnostic } from "../../readiness";
import { REFERENCE_CODE_RUNNER_STAGING_DIAGNOSTIC, referenceCodeRunnerStagingDiagnosis, stageReferenceCodeRunnerPackages, type ReferenceCodeRunnerStaging } from "./runner-install";

type Staged = { manifestName: string; files: WorkspaceFiles; entrypoint: string };

test("a factory-enabled boot stages both reference-code runner packages, which together declare every implementation (W4H-26)", async () => {
  const staged: Staged[][] = [];
  const outcomes: ReferenceCodeRunnerStaging[] = [];
  await stageReferenceCodeRunnerPackages(true, async entries => { staged.push([...entries]); return { state: "staged", staged: entries.map(entry => entry.manifestName), failed: [] }; }, (outcome) => { outcomes.push(outcome); });
  expect(outcomes).toEqual([{ state: "staged", staged: ["reference-code", "reference-code-validator"], failed: [] }]);
  expect(staged).toHaveLength(1);
  expect(staged[0]!.map(entry => entry.manifestName)).toEqual(["reference-code", "reference-code-validator"]);
  const entries = staged[0]!.map(entry => entry.files[REFERENCE_CODE_GUEST_ENTRYPOINT] as string);
  for (const exported of Object.keys(REFERENCE_CODE_IMPLEMENTATIONS)) expect(entries.filter(entry => entry.includes(`"name":"${exported}"`))).toHaveLength(1);
  expect(staged[0]!.every(entry => entry.entrypoint === REFERENCE_CODE_GUEST_ENTRYPOINT)).toBe(true);
});

test("with factories off nothing is staged", async () => {
  let called = false;
  await stageReferenceCodeRunnerPackages(false, async () => { called = true; return { state: "awaiting-administrator" }; }, () => { called = true; });
  expect(called).toBe(false);
});

test("a staging failure is never thrown, and is visible by name in the readiness detail (W4H-26)", async () => {
  const logged: string[] = [];
  const diagnose = referenceCodeRunnerStagingDiagnosis((error) => { logged.push(error); });
  await stageReferenceCodeRunnerPackages(true, async () => { throw new Error("runner unconfigured"); }, diagnose);
  expect(getReadiness().detail).toMatchObject({ diagnostics: { builtinRunnerPackages: { state: "failed", error: "Error: runner unconfigured" } } });
  expect(logged).toEqual(["Error: runner unconfigured"]);
  // One package's failure is named with its package.
  await stageReferenceCodeRunnerPackages(true, async () => ({ state: "staged", staged: ["reference-code"], failed: [{ manifestName: "reference-code-validator", error: "Error: build queue" }] }), diagnose);
  expect(getReadiness().detail).toMatchObject({ diagnostics: { builtinRunnerPackages: { state: "staged", failed: [{ manifestName: "reference-code-validator", error: "Error: build queue" }] } } });
  expect(logged).toHaveLength(1);
  setReadinessDiagnostic(REFERENCE_CODE_RUNNER_STAGING_DIAGNOSTIC, undefined);
});
