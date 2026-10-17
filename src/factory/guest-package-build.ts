import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BuildRequest, BuildResult, ExtensionManifestV4, Runner, WorkspaceFiles } from "@ezcorp/extension-contract";
import { filesDigest } from "@ezcorp/extension-runner";
import { digestObject, putFiles } from "../extensions/v4/blobs";
import type { BlobStore } from "../extensions/v4/types";
import { factorySdkClosure } from "./guest-sdk-closure";

/**
 * One builder for every guest runner package: the W19a graph guest, the reference-code validator
 * guest, and the reference-code runner packages the product installs (W4H-26).
 *
 * A guest ships the repository's own committed source, not a bundle and not a copy written for
 * the sandbox: the runner typechecks the `.ts` files it stages, and a hand-written guest would be a
 * second implementation whose evidence is about itself. So each file is read from disk as the
 * repository holds it and only its import specifiers are rewritten, because the guest workspace is
 * flat. The rewrite is a fixed table: a specifier the table does not name fails the staging rather
 * than reaching the guest unresolved. The SDK modules the staged files reach are added by following
 * the SDK's own imports (`guest-sdk-closure.ts`).
 */
export interface FactoryGuestPackageLayout {
  /** Flat file name, and the path it is read from relative to the repository root. */
  readonly sources: Readonly<Record<string, string>>;
  /** Every import specifier the sources use, and the flat specifier it becomes. */
  readonly specifiers: Readonly<Record<string, string>>;
  /** Specifiers the guest image provides; the staging leaves them alone. */
  readonly provided: ReadonlySet<string>;
  /** Files written for the package itself (an entry, the test file the build step requires). */
  readonly generated?: Readonly<Record<string, string>>;
}

export class FactoryGuestPackageStagingError extends Error {
  constructor(readonly detail: string, code = "factory_guest_package_staging_failed") {
    super(`${code}: ${detail}`);
    this.name = "FactoryGuestPackageStagingError";
  }
}

export type FactoryGuestStagingFailure = (detail: string) => Error;

const IMPORT = /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s+["']([^"']+)["']/g;

/** Rewrites one file's specifiers to the flat workspace, refusing any the table does not name. */
export function stageFactoryGuestSource(
  path: string,
  source: string,
  layout: Pick<FactoryGuestPackageLayout, "specifiers" | "provided">,
  fail: FactoryGuestStagingFailure = detail => new FactoryGuestPackageStagingError(detail),
): string {
  let staged = source;
  for (const match of source.matchAll(IMPORT)) {
    const specifier = match[1]!;
    if (layout.provided.has(specifier)) continue;
    const replacement = layout.specifiers[specifier];
    if (!replacement) throw fail(`${path} imports '${specifier}', which the guest workspace does not provide`);
    staged = staged.replaceAll(`"${specifier}"`, `"${replacement}"`).replaceAll(`'${specifier}'`, `'${replacement}'`);
  }
  return staged;
}

/** Where a repository keeps the factory SDK's sources: the one directory the closure stages SDK modules from. */
export function factorySdkSourceDirectory(repositoryRoot: string): string {
  return join(repositoryRoot, "packages/@ezcorp/factory-sdk/src");
}

/** The exact files one guest package is built from: its staged sources, the SDK closure, and its generated files. */
export async function stageFactoryGuestPackage(
  repositoryRoot: string,
  layout: FactoryGuestPackageLayout,
  fail?: FactoryGuestStagingFailure,
): Promise<WorkspaceFiles> {
  const files: Record<string, string> = {};
  for (const [name, path] of Object.entries(layout.sources)) {
    files[name] = stageFactoryGuestSource(name, await readFile(join(repositoryRoot, path), "utf8"), layout, fail);
  }
  Object.assign(files, layout.generated ?? {});
  return { ...await factorySdkClosure(factorySdkSourceDirectory(repositoryRoot), files), ...files };
}

/** What one successful guest build produced, as a release record names it. */
export interface FactoryGuestPackageBuild {
  readonly artifactDigest: string;
  readonly imageDigest: string;
  readonly manifest: ExtensionManifestV4;
  readonly evidence: BuildResult["evidence"];
}

/** Builds a staged package in the given runner's isolated build container, or refuses with the runner's diagnostics. */
export async function buildFactoryGuestPackage(
  runner: Pick<Runner, "build">,
  request: Omit<BuildRequest, "entrypoint"> & { readonly entrypoint?: string },
): Promise<FactoryGuestPackageBuild> {
  const built = await runner.build({ ...request, entrypoint: request.entrypoint ?? "extension.ts" });
  if (built.state !== "succeeded" || !built.artifactDigest || !built.manifest) {
    const detail = built.diagnostics.map(entry => `${entry.code}${entry.message ? `: ${entry.message}` : ""}`).join("; ");
    throw new FactoryGuestPackageStagingError(detail || built.state, "factory_guest_package_build_failed");
  }
  return { artifactDigest: built.artifactDigest, imageDigest: built.imageDigest, manifest: built.manifest, evidence: built.evidence };
}

/** A guest a harness built itself, with the release record it then installs ("harness-supplied", W02). */
export interface FactoryGuestHarnessRelease {
  readonly build: FactoryGuestPackageBuild;
  readonly sourceDigest: string;
  readonly release: Record<string, unknown>;
}

/**
 * Builds a staged guest, stores its source, and derives the release record a proof harness installs.
 *
 * The product's own installs write their records through the v4 lifecycle; this is the one form
 * the proof harnesses (W19a's graph guest, the factory-services guest) share, so the record they
 * write cannot drift between them. The artifact digest comes from the real build, never a literal.
 */
export async function buildFactoryGuestHarnessRelease(options: {
  readonly runner: Pick<Runner, "build" | "collectArtifacts">;
  readonly blobs: BlobStore;
  readonly files: WorkspaceFiles;
  readonly operationId: string;
  readonly limits: BuildRequest["limits"];
  readonly installationId: string;
  readonly releaseId: string;
}): Promise<FactoryGuestHarnessRelease> {
  const build = await buildFactoryGuestPackage(options.runner, { operationId: options.operationId, sourceDigest: filesDigest(options.files), files: options.files, limits: options.limits });
  // C05 "Prepare a release built outside the lifecycle" (W4H-32): like a lifecycle release, the harness release keeps its
  // artifact copy beside its source, so a fresh preparation store is restored from it. Checked before anything is stored.
  const artifacts = await options.runner.collectArtifacts(build.artifactDigest);
  if (filesDigest(artifacts) !== build.artifactDigest) throw new FactoryGuestPackageStagingError("the collected files do not digest to the build's artifact", "factory_guest_package_artifact_mismatch");
  const sourceDigest = await putFiles(options.blobs, options.files, "workspace");
  if (await putFiles(options.blobs, artifacts, "artifact") !== build.artifactDigest) throw new FactoryGuestPackageStagingError("the stored artifact copy does not carry the build's digest", "factory_guest_package_artifact_mismatch");
  const input = {
    installationId: options.installationId, workspaceId: "workspace", workspaceRevision: 1, sourceDigest,
    artifactDigest: build.artifactDigest, imageDigest: build.imageDigest, manifest: build.manifest, evidence: build.evidence,
    runnerProfile: "rootless-podman-v4", policyDigest: digestObject({ runner: "v4" }),
  };
  return { build, sourceDigest, release: { ...input, id: options.releaseId, releaseDigest: digestObject(input), createdAt: "2030-01-01T00:00:00.000Z" } };
}

/** The v4 manifest of a guest runner package: one tool per export, no permissions (C05: grants come per attempt). */
export function factoryGuestManifest(input: { readonly name: string; readonly version: string; readonly author: string; readonly description: string; readonly tools: Readonly<Record<string, string>> }): Record<string, unknown> {
  return {
    schemaVersion: 4, name: input.name, version: input.version, author: { name: input.author }, description: input.description, permissions: {},
    tools: Object.entries(input.tools).map(([name, description]) => ({ name, description, inputSchema: { type: "object" }, outputSchema: { type: "object" } })),
  };
}

/**
 * The generated entry of a guest runner package: it serves each named export of `module` as a tool,
 * and hands each the guest's one reverse capability, `factory.broker`, and nothing else.
 */
export function factoryGuestEntrySource(input: { readonly manifest: Record<string, unknown>; readonly module: string; readonly tools: readonly string[] }): string {
  return [
    "import { defineExtension, serve } from '@ezcorp/sdk/v4';",
    `import * as guest from './${input.module}';`,
    "import type { FactoryGuestBrokerCall } from './guest-materials.ts';",
    "import type { FactoryRunnerRequest } from './types.ts';",
    "",
    `const manifest = { ...${JSON.stringify(input.manifest)}, schemaVersion: 4 as const };`,
    "",
    "interface GuestContext { call(method: string, value: unknown): Promise<unknown> }",
    "type Task = (request: FactoryRunnerRequest, call: FactoryGuestBrokerCall) => Promise<unknown>;",
    "",
    "/** Each export gets the guest's one reverse capability and nothing else. */",
    "const task = (run: Task) => async (input: unknown, context: GuestContext) =>",
    "  run(input as FactoryRunnerRequest, async (payload) => context.call('factory.broker', payload));",
    "",
    `await serve(defineExtension({ manifest, tools: { ${input.tools.map(name => `${name}: task(guest.${name})`).join(", ")} } }));`,
    "",
  ].join("\n");
}
