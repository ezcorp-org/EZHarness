import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { DEFAULT_IMAGE, filesDigest } from "@ezcorp/extension-runner";
import { s3ReleaseAdapterFiles, s3ReleaseAdapterProvidedDigests } from "./package";
import { buildS3ReleaseAdapterLock, type S3ReleaseAdapterBuilder } from "./relock";

/** A builder that records what it was given and answers a fixed result (the Podman build itself: the podman test). */
function fakeBuilder(state: "succeeded" | "failed") {
  const seen: { root?: string; input?: Parameters<S3ReleaseAdapterBuilder["build"]>[0]; closed: number } = { closed: 0 };
  const open = async (root: string): Promise<S3ReleaseAdapterBuilder> => {
    seen.root = root;
    return {
      build: async input => { seen.input = input; return { operationId: input.operationId, state, sourceDigest: input.sourceDigest, artifactDigest: "c".repeat(64), imageDigest: DEFAULT_IMAGE, diagnostics: state === "failed" ? [{ code: "typecheck_failed", message: "x" }] : [], evidence: { protocolVersion: 4, validatorVersion: "v", tests: [], discoveryDigest: "" } } as never; },
      close: async () => { seen.closed++; },
    };
  };
  return { open, seen };
}

test("a build gives the lock: the staged source, the provided SDK and toolchain, the artifact and the image", async () => {
  const { open, seen } = fakeBuilder("succeeded");
  const files = await s3ReleaseAdapterFiles();
  expect(await buildS3ReleaseAdapterLock(open)).toEqual({ sourceDigest: `sha256:${filesDigest(files)}`, ...await s3ReleaseAdapterProvidedDigests(), artifactDigest: `sha256:${"c".repeat(64)}`, image: DEFAULT_IMAGE });
  expect(seen.input).toMatchObject({ entrypoint: "extension.ts", sourceDigest: filesDigest(files), files });
  expect(seen.closed).toBe(1);
  expect(existsSync(seen.root!)).toBe(false);
}, 60_000);

test("a failed build names its diagnostics, and the builder is still closed and its folder removed", async () => {
  const { open, seen } = fakeBuilder("failed");
  await expect(buildS3ReleaseAdapterLock(open)).rejects.toThrow('the S3 release adapter did not build: [{"code":"typecheck_failed","message":"x"}]');
  expect(seen.closed).toBe(1);
  expect(existsSync(seen.root!)).toBe(false);
}, 60_000);
