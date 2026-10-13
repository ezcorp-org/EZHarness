import { join } from "node:path";
import type { WorkspaceFiles } from "@ezcorp/extension-contract";
import { factoryGuestEntrySource, factoryGuestManifest, stageFactoryGuestPackage } from "../guest-package-build";
import { REFERENCE_CODE_GUEST_ENTRYPOINT, REFERENCE_CODE_GUEST_PROVIDED, REFERENCE_CODE_GUEST_SPECIFIERS } from "./guest";
import {
  REFERENCE_CODE_EXPORT_MANIFEST_NAMES,
  REFERENCE_CODE_EXPORT_PACKAGES,
  REFERENCE_CODE_GENERATOR_MANIFEST_NAME,
  REFERENCE_CODE_GENERATOR_PACKAGE,
  REFERENCE_CODE_IMPLEMENTATIONS,
  REFERENCE_CODE_VALIDATOR_MANIFEST_NAME,
  REFERENCE_CODE_VALIDATOR_PACKAGE,
  type ReferenceCodeExportName,
} from "./pack";

/**
 * The two built-in reference-code runner packages, as the product installs them (W4H-26).
 *
 * This is where REFERENCE_CODE_IMPLEMENTATIONS is registered in the product: not in the host
 * process (C05 forbids running package code in the host plane, first-party or not), but as one
 * tool per export of the v4 package `reference.code.v1` names, staged from committed source by the
 * product's one guest-package builder. The export lists are derived from the pack's own tables, so a
 * new implementation cannot ship without a tool and a tool cannot name an implementation that does
 * not exist (`runner-packages.test.ts`).
 */

export const REFERENCE_CODE_RUNNER_VERSION = "1.0.0";

export interface ReferenceCodeRunnerPackage {
  readonly package: string;
  readonly manifestName: string;
  readonly version: string;
  readonly exports: readonly ReferenceCodeExportName[];
}

const exportsOf = (manifestName: string): ReferenceCodeExportName[] =>
  (Object.keys(REFERENCE_CODE_IMPLEMENTATIONS) as ReferenceCodeExportName[]).filter(name => REFERENCE_CODE_EXPORT_MANIFEST_NAMES[name] === manifestName);

export const REFERENCE_CODE_RUNNER_PACKAGES: readonly ReferenceCodeRunnerPackage[] = Object.freeze([
  { package: REFERENCE_CODE_GENERATOR_PACKAGE, manifestName: REFERENCE_CODE_GENERATOR_MANIFEST_NAME, version: REFERENCE_CODE_RUNNER_VERSION, exports: exportsOf(REFERENCE_CODE_GENERATOR_MANIFEST_NAME) },
  { package: REFERENCE_CODE_VALIDATOR_PACKAGE, manifestName: REFERENCE_CODE_VALIDATOR_MANIFEST_NAME, version: REFERENCE_CODE_RUNNER_VERSION, exports: exportsOf(REFERENCE_CODE_VALIDATOR_MANIFEST_NAME) },
]);

/** The committed sources every reference-code runner package stages. */
const RUNNER_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  "runner-entry.ts": "src/factory/reference-code/runner-entry.ts",
  "snapshot.ts": "src/factory/reference-code/snapshot.ts",
  "git-objects.ts": "src/factory/git-objects.ts",
  "digest.ts": "src/extensions/v4/digest.ts",
});

const RUNNER_SPECIFIERS: Readonly<Record<string, string>> = Object.freeze({
  ...REFERENCE_CODE_GUEST_SPECIFIERS,
  "@ezcorp/factory-sdk/guest-materials": "./guest-materials.ts",
});

const FEATURE_TEST = [
  'import { expect, test } from "bun:test";',
  'import { REFERENCE_CODE_RUNNER_TOOLS } from "./runner-entry.ts";',
  "",
  'test("a pending export refuses by name", async () => {',
  '  await expect(REFERENCE_CODE_RUNNER_TOOLS.generateCandidate({} as never, async () => null)).rejects.toThrow("reference_code_runner_pending");',
  "});",
  "",
].join("\n");

/** The exact files one reference-code runner package is built from, named by its v4 manifest name. */
export async function referenceCodeRunnerPackageFiles(manifestName: string): Promise<WorkspaceFiles> {
  const entry = REFERENCE_CODE_RUNNER_PACKAGES.find(candidate => candidate.manifestName === manifestName);
  if (!entry) throw new Error(`reference_code_runner_package_unknown: ${manifestName}`);
  const manifest = factoryGuestManifest({
    name: entry.manifestName, version: entry.version, author: "EZCorp", description: `The built-in ${REFERENCE_CODE_EXPORT_PACKAGES[entry.exports[0]!]} runner package (reference.code.v1)`,
    tools: Object.fromEntries(entry.exports.map(name => [name, `reference.code.v1 ${name}`])),
  });
  return stageFactoryGuestPackage(join(import.meta.dir, "../../.."), {
    sources: RUNNER_SOURCES, specifiers: RUNNER_SPECIFIERS, provided: REFERENCE_CODE_GUEST_PROVIDED,
    generated: { [REFERENCE_CODE_GUEST_ENTRYPOINT]: factoryGuestEntrySource({ manifest, module: "runner-entry.ts", tools: entry.exports }), "feature.test.ts": FEATURE_TEST },
  });
}
