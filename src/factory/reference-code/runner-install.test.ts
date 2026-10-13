import { expect, test } from "bun:test";
import type { WorkspaceFiles } from "@ezcorp/extension-contract";
import { REFERENCE_CODE_GUEST_ENTRYPOINT } from "./guest";
import { REFERENCE_CODE_IMPLEMENTATIONS } from "./pack";
import { stageReferenceCodeRunnerPackages } from "./runner-install";

type Staged = { manifestName: string; files: WorkspaceFiles; entrypoint: string };

test("a factory-enabled boot stages both reference-code runner packages, which together declare every implementation (W4H-26)", async () => {
  const staged: Staged[][] = [];
  await stageReferenceCodeRunnerPackages(true, async entries => { staged.push([...entries]); });
  expect(staged).toHaveLength(1);
  expect(staged[0]!.map(entry => entry.manifestName)).toEqual(["reference-code", "reference-code-validator"]);
  const entries = staged[0]!.map(entry => entry.files[REFERENCE_CODE_GUEST_ENTRYPOINT] as string);
  for (const exported of Object.keys(REFERENCE_CODE_IMPLEMENTATIONS)) expect(entries.filter(entry => entry.includes(`"name":"${exported}"`))).toHaveLength(1);
  expect(staged[0]!.every(entry => entry.entrypoint === REFERENCE_CODE_GUEST_ENTRYPOINT)).toBe(true);
});

test("with factories off nothing is staged", async () => {
  let called = false;
  await stageReferenceCodeRunnerPackages(false, async () => { called = true; });
  expect(called).toBe(false);
});
