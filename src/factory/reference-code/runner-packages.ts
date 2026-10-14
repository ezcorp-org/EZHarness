import { getProjectRoot } from "../../extensions/project-root";
import type { WorkspaceFiles } from "@ezcorp/extension-contract";
import { factoryGuestEntrySource, factoryGuestManifest, stageFactoryGuestPackage } from "../guest-package-build";
import { REFERENCE_CODE_GUEST_ENTRYPOINT, REFERENCE_CODE_GUEST_PROVIDED, REFERENCE_CODE_GUEST_SPECIFIERS } from "./guest";
import REFERENCE_CODE_TOOLCHAIN_LOCK from "./toolchain.lock.json" with { type: "json" };
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
  "candidate-rules.ts": "src/factory/reference-code/candidate-rules.ts",
  "guest-generate.ts": "src/factory/reference-code/guest-generate.ts",
  "freeze.ts": "src/factory/reference-code/freeze.ts",
  "checks.ts": "src/factory/reference-code/checks.ts",
  "static-claims.ts": "src/factory/reference-code/static-claims.ts",
  "scans.ts": "src/factory/reference-code/scans.ts",
  "workspace.ts": "src/factory/reference-code/workspace.ts",
  "review-rules.ts": "src/factory/reference-code/review-rules.ts",
  "release-github-request.ts": "src/factory/release-github-request.ts",
  "release-s3-accepted-publication.ts": "src/factory/release-s3-accepted-publication.ts",
  "project-git-refs.ts": "src/extensions/project-git-refs.ts",
  "snapshot.ts": "src/factory/reference-code/snapshot.ts",
  "git-objects.ts": "src/factory/git-objects.ts",
  "digest.ts": "src/extensions/v4/digest.ts",
});

const RUNNER_SPECIFIERS: Readonly<Record<string, string>> = Object.freeze({
  ...REFERENCE_CODE_GUEST_SPECIFIERS,
  "@ezcorp/factory-sdk/guest-materials": "./guest-materials.ts",
  "@ezcorp/factory-sdk/guest-model": "./guest-model.ts",
  "@ezcorp/factory-sdk/canonical": "./canonical.ts",
  "./candidate-rules": "./candidate-rules.ts",
  "./guest-generate": "./guest-generate.ts",
  "./freeze": "./freeze.ts",
  "./checks": "./checks.ts",
  "./workspace": "./workspace.ts",
  "./review-rules": "./review-rules.ts",
  "@ezcorp/factory-sdk": "./types.ts",
  "../release-github-request": "./release-github-request.ts",
  "../release-s3-accepted-publication": "./release-s3-accepted-publication.ts",
  "../extensions/project-git-refs": "./project-git-refs.ts",
  "../extensions/v4/digest": "./digest.ts",
  "./git-objects": "./git-objects.ts",
});

/** What the guest image provides: the v4 SDK and the runtime's own modules, which the checks lane spawns and writes with. */
const RUNNER_PROVIDED: ReadonlySet<string> = new Set([...REFERENCE_CODE_GUEST_PROVIDED, "node:child_process", "node:fs/promises", "node:os", "node:path"]);

/**
 * The validator package's own locked dependency set: the toolchain the protected checks run on
 * (W4H-28 P3). The v4 build fetches exactly these, by version and SHA-512, from the approved
 * registry; the guest runtime stages them read-only at the package root. A candidate whose lockfile
 * names anything else fails the frozen install by name, offline.
 */
function toolchainFiles(): Record<string, string> {
  const devDependencies = (REFERENCE_CODE_TOOLCHAIN_LOCK.packages[""] as { dependencies: Record<string, string> }).dependencies;
  return {
    "package.json": `${JSON.stringify({ name: REFERENCE_CODE_VALIDATOR_MANIFEST_NAME, private: true, devDependencies }, null, 2)}\n`,
    "package-lock.json": `${JSON.stringify(REFERENCE_CODE_TOOLCHAIN_LOCK, null, 2)}\n`,
  };
}

const FEATURE_TEST = [
  'import { expect, test } from "bun:test";',
  'import { referenceCodeRecordedTreeReader } from "./runner-entry.ts";',
  "",
  'test("a live repository connection is refused by name", () => {',
  '  expect(() => referenceCodeRecordedTreeReader({ provider: "github" })).toThrow("reference_code_repository_reader_unavailable");',
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
  return stageFactoryGuestPackage(getProjectRoot(), {
    sources: RUNNER_SOURCES, specifiers: RUNNER_SPECIFIERS, provided: RUNNER_PROVIDED,
    generated: {
      [REFERENCE_CODE_GUEST_ENTRYPOINT]: factoryGuestEntrySource({ manifest, module: "runner-entry.ts", tools: entry.exports }), "feature.test.ts": FEATURE_TEST,
      ...(entry.manifestName === REFERENCE_CODE_VALIDATOR_MANIFEST_NAME ? toolchainFiles() : {}),
    },
  });
}
