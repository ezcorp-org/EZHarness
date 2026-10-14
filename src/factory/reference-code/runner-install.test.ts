import { expect, test } from "bun:test";
import type { WorkspaceFiles } from "@ezcorp/extension-contract";
import { REFERENCE_CODE_GUEST_ENTRYPOINT } from "./guest";
import { REFERENCE_CODE_IMPLEMENTATIONS } from "./pack";
import { getReadiness, setReadinessDiagnostic } from "../../readiness";
import { ContractError } from "@ezcorp/extension-contract";
import { LifecycleError } from "../../extensions/v4/types";
import { REFERENCE_CODE_RUNNER_OWNER_INACTIVE, REFERENCE_CODE_RUNNER_STAGE_REASONS, REFERENCE_CODE_RUNNER_STAGING_DIAGNOSTIC, referenceCodeRunnerStageFailure, referenceCodeRunnerStagingDiagnosis, stageReferenceCodeRunnerPackages, type ReferenceCodeRunnerStaging } from "./runner-install";

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

test("a staging failure is never thrown, and is visible in readiness by a stable code and a fixed reason, never its raw text (W4H-26 N5)", async () => {
  const logged: string[] = [];
  const diagnose = referenceCodeRunnerStagingDiagnosis((error) => { logged.push(error); });
  const planted = new Error("ENOENT: no such file or directory, open '/home/someone/web/src/factory/reference-code/runner-entry.ts'");
  await stageReferenceCodeRunnerPackages(true, async () => { throw planted; }, diagnose);
  const detail = getReadiness().detail as { diagnostics: { builtinRunnerPackages: unknown } };
  expect(detail.diagnostics.builtinRunnerPackages).toEqual({ state: "failed", code: "factory_builtin_runner_stage_failed", reason: "source_missing", message: REFERENCE_CODE_RUNNER_STAGE_REASONS.source_missing });
  expect(JSON.stringify(detail)).not.toContain("/home/someone");
  expect(JSON.stringify(detail)).not.toContain("ENOENT");
  // The raw text stays in the server log only.
  expect(logged).toEqual([String(planted)]);
  // One package's failure is named with its package, its code and its reason, nothing more.
  await stageReferenceCodeRunnerPackages(true, async () => ({ state: "staged", staged: ["reference-code"], failed: [{ manifestName: "reference-code-validator", ...referenceCodeRunnerStageFailure(new LifecycleError("runner_unconfigured", "socket /run/x missing")) }] }), diagnose);
  expect(getReadiness().detail).toMatchObject({ diagnostics: { builtinRunnerPackages: { state: "staged", failed: [{ manifestName: "reference-code-validator", code: "factory_builtin_runner_stage_failed", reason: "runner_unconfigured", message: REFERENCE_CODE_RUNNER_STAGE_REASONS.runner_unconfigured }] } } });
  expect(JSON.stringify(getReadiness().detail)).not.toContain("/run/x");
  expect(logged).toHaveLength(1);
  setReadinessDiagnostic(REFERENCE_CODE_RUNNER_STAGING_DIAGNOSTIC, undefined);
});

test("every staging error maps to one fixed reason", () => {
  const reason = (error: unknown) => referenceCodeRunnerStageFailure(error).reason;
  expect(reason(Object.assign(new Error("open failed"), { code: "ENOENT" }))).toBe("source_missing");
  expect(reason(new Error("ENOENT: no such file or directory"))).toBe("source_missing");
  expect(reason(new LifecycleError("runner_unconfigured", "x"))).toBe("runner_unconfigured");
  expect(reason(new LifecycleError("stale_release", "x"))).toBe("lifecycle_refused");
  expect(reason(new ContractError("Only JSON data is accepted"))).toBe("invalid_source");
  expect(reason("a string")).toBe("unexpected");
  for (const [key, message] of Object.entries(REFERENCE_CODE_RUNNER_STAGE_REASONS)) {
    expect(referenceCodeRunnerStageFailure(key === "owner_inactive" ? REFERENCE_CODE_RUNNER_OWNER_INACTIVE : new Error("x")).code).toBe("factory_builtin_runner_stage_failed");
    expect(message.length).toBeGreaterThan(10);
  }
  expect(reason(REFERENCE_CODE_RUNNER_OWNER_INACTIVE)).toBe("owner_inactive");
});
