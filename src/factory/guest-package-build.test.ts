import { describe, expect, test } from "bun:test";
import type { BuildRequest, BuildResult, WorkspaceFiles } from "@ezcorp/extension-contract";
import { filesDigest } from "@ezcorp/extension-runner";
import { digestObject } from "../extensions/v4/blobs";
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
    const stored: Uint8Array[] = [];
    const blobs = { async put(bytes: Uint8Array) { stored.push(bytes); return digestObject(files); }, async get() { return stored[0]!; } };
    const built = await buildFactoryGuestHarnessRelease({ runner: runner({ artifactDigest: "b".repeat(64), manifest: manifest as never }), blobs: blobs as never, files, operationId: "op", limits: {} as never, installationId: "inst", releaseId: "rel" });
    expect(built.sourceDigest).toBe(digestObject(files));
    expect(built.release).toMatchObject({ id: "rel", installationId: "inst", sourceDigest: digestObject(files), artifactDigest: "b".repeat(64), runnerProfile: "rootless-podman-v4", manifest });
    const { id: _id, releaseDigest, createdAt: _createdAt, ...input } = built.release as Record<string, unknown>;
    expect(releaseDigest).toBe(digestObject(input));
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
