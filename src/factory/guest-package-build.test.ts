import { describe, expect, test } from "bun:test";
import type { BuildRequest, BuildResult, WorkspaceFiles } from "@ezcorp/extension-contract";
import { filesDigest } from "@ezcorp/extension-runner";
import { digestBytes, digestObject, getFiles } from "../extensions/v4/blobs";
import { LifecycleError, type BlobStore } from "../extensions/v4/types";
import {
  FactoryGuestPackageStagingError,
  buildFactoryGuestHarnessRelease,
  buildFactoryGuestPackage,
  factoryGuestEntrySource,
  factoryGuestManifest,
  stageFactoryGuestSource,
} from "./guest-package-build";

const files: WorkspaceFiles = { "extension.ts": "export {};" };
const evidence = { protocolVersion: 4, tests: [] } as unknown as BuildResult["evidence"];
const artifacts: WorkspaceFiles = { "extension.ts": "export {};", ".runner/recipe.json": "{}" };

/** A content-addressed release blob store in memory: what the lifecycle's FileBlobStore promises. */
function memoryBlobs() {
  const stored = new Map<string, Uint8Array>();
  const blobs: BlobStore = {
    async put(bytes) { const digest = digestBytes(bytes); stored.set(digest, bytes); return digest; },
    async get(digest) { const bytes = stored.get(digest); if (!bytes) throw new LifecycleError("artifact_missing", "One stored extension release blob is missing."); return bytes; },
  };
  return { blobs, stored };
}

function runner(answer: Partial<BuildResult>) {
  const asked: BuildRequest[] = [];
  return { asked, async build(input: BuildRequest): Promise<BuildResult> { asked.push(input); return { operationId: input.operationId, state: "succeeded", sourceDigest: input.sourceDigest, imageDigest: "image@sha256:x", diagnostics: [], evidence, ...answer }; } };
}

describe("the one guest-package builder (W4H-26)", () => {
  test("a build defaults to the extension.ts entry and answers its artifact, image, manifest and evidence", async () => {
    const manifest = factoryGuestManifest({ name: "m", version: "1.0.0", author: "a", description: "d", tools: { run: "Runs" } });
    const builder = runner({ artifactDigest: "a".repeat(64), manifest: manifest as never });
    const built = await buildFactoryGuestPackage(builder, { operationId: "op", sourceDigest: filesDigest(files), files, limits: {} as never });
    expect(builder.asked[0]!.entrypoint).toBe("extension.ts");
    expect(built).toEqual({ artifactDigest: "a".repeat(64), imageDigest: "image@sha256:x", manifest: manifest as never, evidence });
  });

  test("a failed build is refused with the runner's own diagnostics, or its state when it gave none", async () => {
    const failed = runner({ state: "failed", diagnostics: [{ code: "typecheck_failed", message: "TS2307" }, { code: "bare" }] as never });
    await expect(buildFactoryGuestPackage(failed, { operationId: "op", sourceDigest: "s", files, limits: {} as never })).rejects.toThrow("factory_guest_package_build_failed: typecheck_failed: TS2307; bare");
    await expect(buildFactoryGuestPackage(runner({ state: "failed" }), { operationId: "op", sourceDigest: "s", files, limits: {} as never })).rejects.toBeInstanceOf(FactoryGuestPackageStagingError);
    await expect(buildFactoryGuestPackage(runner({ state: "failed" }), { operationId: "op", sourceDigest: "s", files, limits: {} as never })).rejects.toThrow("factory_guest_package_build_failed: failed");
  });

  test("the harness release record is derived from the real build and the stored source", async () => {
    const manifest = factoryGuestManifest({ name: "m", version: "1.0.0", author: "a", description: "d", tools: {} });
    const { blobs } = memoryBlobs();
    const built = await buildFactoryGuestHarnessRelease({ runner: { ...runner({ artifactDigest: digestObject(artifacts), manifest: manifest as never }), async collectArtifacts() { return structuredClone(artifacts); } }, blobs, files, operationId: "op", limits: {} as never, installationId: "inst", releaseId: "rel" });
    expect(built.sourceDigest).toBe(digestObject(files));
    expect(built.release).toMatchObject({ id: "rel", installationId: "inst", sourceDigest: digestObject(files), artifactDigest: digestObject(artifacts), runnerProfile: "rootless-podman-v4", manifest });
    const { id: _id, releaseDigest, createdAt: _createdAt, ...input } = built.release as Record<string, unknown>;
    expect(releaseDigest).toBe(digestObject(input));
  });

  test("the harness release keeps its artifact copy in the release blobs beside its source, under the digest the release names (W4H-32)", async () => {
    const manifest = factoryGuestManifest({ name: "m", version: "1.0.0", author: "a", description: "d", tools: {} });
    const { blobs } = memoryBlobs();
    const built = await buildFactoryGuestHarnessRelease({ runner: { ...runner({ artifactDigest: digestObject(artifacts), manifest: manifest as never }), async collectArtifacts() { return structuredClone(artifacts); } }, blobs, files, operationId: "op", limits: {} as never, installationId: "inst", releaseId: "rel" });
    expect(await getFiles(blobs, built.release.artifactDigest as string, "artifact")).toEqual(artifacts);
    expect(await getFiles(blobs, built.sourceDigest, "workspace")).toEqual(files);
  });

  test("collected files that do not digest to the build's artifact are refused by name, and no artifact copy is stored (W4H-32)", async () => {
    const manifest = factoryGuestManifest({ name: "m", version: "1.0.0", author: "a", description: "d", tools: {} });
    const { blobs, stored } = memoryBlobs();
    const tampered = { ...artifacts, "extension.ts": "export const tampered = 1;" };
    await expect(buildFactoryGuestHarnessRelease({ runner: { ...runner({ artifactDigest: digestObject(artifacts), manifest: manifest as never }), async collectArtifacts() { return tampered; } }, blobs, files, operationId: "op", limits: {} as never, installationId: "inst", releaseId: "rel" }))
      .rejects.toThrow("factory_guest_package_artifact_mismatch");
    expect([...stored.keys()]).not.toContain(digestObject(artifacts));
    expect([...stored.keys()]).not.toContain(digestObject(tampered));
  });

  test("a release blob store that files the artifact copy under another digest is refused by name (W4H-32, validator-8 Addendum H mutant)", async () => {
    const manifest = factoryGuestManifest({ name: "m", version: "1.0.0", author: "a", description: "d", tools: {} });
    const { blobs } = memoryBlobs();
    // The source is filed under its own digest; the artifact copy comes back under another one.
    const skewed: BlobStore = { get: blobs.get, async put(bytes) { const digest = await blobs.put(bytes); return digest === digestObject(artifacts) ? "f".repeat(64) : digest; } };
    await expect(buildFactoryGuestHarnessRelease({ runner: { ...runner({ artifactDigest: digestObject(artifacts), manifest: manifest as never }), async collectArtifacts() { return structuredClone(artifacts); } }, blobs: skewed, files, operationId: "op", limits: {} as never, installationId: "inst", releaseId: "rel" }))
      .rejects.toThrow("factory_guest_package_artifact_mismatch: the stored artifact copy does not carry the build's digest");
  });

  test("the generated entry serves each named export as a tool with only the broker capability", () => {
    const source = factoryGuestEntrySource({ manifest: { name: "m" }, module: "entry.ts", tools: ["a", "b"] });
    expect(source).toContain("import * as guest from './entry.ts';");
    expect(source).toContain("tools: { a: task(guest.a), b: task(guest.b) }");
    expect(source).toContain("context.call('factory.broker', payload)");
    expect(source).toContain('{"name":"m"}');
  });

  test("the default staging failure names the file and the specifier", () => {
    expect(() => stageFactoryGuestSource("x.ts", 'import { a } from "./nope";\n', { specifiers: {}, provided: new Set() }))
      .toThrow("factory_guest_package_staging_failed: x.ts imports './nope', which the guest workspace does not provide");
  });
});
