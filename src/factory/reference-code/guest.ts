import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceFiles } from "@ezcorp/extension-contract";
import { filesDigest } from "@ezcorp/extension-runner";

/**
 * The exact bytes one reference-code validator guest runs.
 *
 * The guest ships the product's own committed source, not a bundle and not a second copy written
 * for the sandbox. A hand-written guest would be a parallel implementation of the protected claims,
 * and the claims it reported would be evidence about that copy rather than about the validator the
 * host tests. A bundle would be worse in a different way: the runner typechecks the `.ts` files it
 * stages, and generated output carries no types, so the one check the sandbox performs on a guest
 * would be answering about transpiled JavaScript.
 *
 * So the files below are read from disk exactly as this repository holds them, and only their
 * import specifiers are rewritten, because the guest workspace is flat and the repository's is not.
 * The rewrite is a fixed table rather than a regular expression over paths: a specifier that is not
 * in it fails the staging rather than reaching the guest unresolved.
 *
 * The closure is deliberately narrow — the static claims, the two scans, the tree model, the git
 * object identities, the byte digest, and the SDK's own type module. It reaches no workspace, no
 * subprocess, no storage client, and no network.
 */

export const REFERENCE_CODE_GUEST_ENTRYPOINT = "extension.ts";

/** Where each staged file comes from, relative to the repository root. */
export const REFERENCE_CODE_GUEST_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  [REFERENCE_CODE_GUEST_ENTRYPOINT]: "src/factory/reference-code/guest-entry.ts",
  "static-claims.ts": "src/factory/reference-code/static-claims.ts",
  "scans.ts": "src/factory/reference-code/scans.ts",
  "snapshot.ts": "src/factory/reference-code/snapshot.ts",
  "git-objects.ts": "src/factory/git-objects.ts",
  "digest.ts": "src/extensions/v4/digest.ts",
  "factory-sdk-types.ts": "packages/@ezcorp/factory-sdk/src/types.ts",
});

/** Every import specifier the closure uses, and the flat name it becomes. */
const SPECIFIERS: Readonly<Record<string, string>> = Object.freeze({
  "@ezcorp/factory-sdk/types": "./factory-sdk-types.ts",
  "../../extensions/v4/digest": "./digest.ts",
  "../git-objects": "./git-objects.ts",
  "./static-claims": "./static-claims.ts",
  "./scans": "./scans.ts",
  "./snapshot": "./snapshot.ts",
});

/** Specifiers the guest image provides and the staging must leave alone. */
const PROVIDED = new Set(["@ezcorp/sdk/v4", "node:crypto"]);

export class ReferenceCodeGuestStagingError extends Error {
  constructor(readonly detail: string) {
    super(`reference_code_guest_staging_failed: ${detail}`);
    this.name = "ReferenceCodeGuestStagingError";
  }
}

function repositoryRoot(): string {
  return join(import.meta.dir, "../../..");
}

const IMPORT = /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s+["']([^"']+)["']/g;

/** Rewrites one file's specifiers to the flat workspace, refusing any the table does not name. */
export function stageReferenceCodeGuestSource(path: string, source: string): string {
  let staged = source;
  for (const match of source.matchAll(IMPORT)) {
    const specifier = match[1]!;
    if (PROVIDED.has(specifier)) continue;
    const replacement = SPECIFIERS[specifier];
    if (!replacement) throw new ReferenceCodeGuestStagingError(`${path} imports '${specifier}', which the guest workspace does not provide`);
    staged = staged.replaceAll(`"${specifier}"`, `"${replacement}"`).replaceAll(`'${specifier}'`, `'${replacement}'`);
  }
  return staged;
}

/** The committed source the guest runs, staged flat, plus the test file the build step requires. */
export async function referenceCodeGuestFiles(): Promise<WorkspaceFiles> {
  const root = repositoryRoot();
  const files: Record<string, string> = {};
  for (const [name, source] of Object.entries(REFERENCE_CODE_GUEST_SOURCES)) {
    files[name] = stageReferenceCodeGuestSource(name, await readFile(join(root, source), "utf8"));
  }
  files["feature.test.ts"] = [
    'import { expect, test } from "bun:test";',
    'import { referenceCodeGuestReport } from "./extension.ts";',
    "",
    'test("the staged guest refuses a payload it does not recognize", () => {',
    '  const report = referenceCodeGuestReport({ schemaVersion: "not.a.known.shape" });',
    '  expect(report.claims.every(claim => claim.verdict === "VALIDATOR_ERROR")).toBe(true);',
    "});",
    "",
  ].join("\n");
  return files;
}

/** The digest the build seals; a caller that stages other bytes gets a different one. */
export async function referenceCodeGuestDigest(): Promise<string> {
  return filesDigest(await referenceCodeGuestFiles());
}
