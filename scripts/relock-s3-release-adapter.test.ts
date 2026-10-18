import { describe, expect, test } from "bun:test";
import { S3_RELEASE_ADAPTER_LOCK_PATH, S3_RELEASE_ADAPTER_SDK_PATH, type S3ReleaseAdapterRelockDependencies } from "../src/factory/s3-release-adapter/relock";
import type { S3ReleaseAdapterLock } from "../src/factory/s3-release-adapter/package";
import { main, relockDependencies } from "./relock-s3-release-adapter";

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const OLD = { sourceDigest: digest("1"), artifactDigest: digest("a"), image: "image@sha256:1" };
const NEXT: S3ReleaseAdapterLock = { sourceDigest: digest("1"), sdkDigest: digest("2"), toolchainDigest: digest("3"), artifactDigest: digest("b"), image: "image@sha256:1" };
const SDK = `export const referenceS3ReleaseAdapter = Object.freeze({\n  digest: "${OLD.artifactDigest}",\n  export: "publish",\n});\n`;

function world(options: { clean?: boolean; sdk?: string; build?: () => Promise<S3ReleaseAdapterLock> } = {}) {
  const files: Record<string, string> = { [S3_RELEASE_ADAPTER_LOCK_PATH]: JSON.stringify(OLD), [S3_RELEASE_ADAPTER_SDK_PATH]: options.sdk ?? SDK };
  let builds = 0;
  const lines: string[] = [];
  const dependencies: S3ReleaseAdapterRelockDependencies = {
    clean: async () => options.clean ?? true,
    build: options.build ?? (async () => { builds++; return NEXT; }),
    read: async path => files[path]!,
    write: async (path, text) => { files[path] = text; },
  };
  return { files, lines, dependencies, print: (line: string) => lines.push(line), builds: () => builds };
}

describe("relock-s3-release-adapter", () => {
  test("rebuilds, writes the lock and the SDK literal, and prints each digest old -> new", async () => {
    const w = world();
    expect(await main(w.dependencies, w.print)).toBe(0);
    expect(JSON.parse(w.files[S3_RELEASE_ADAPTER_LOCK_PATH]!)).toEqual(NEXT);
    expect(w.files[S3_RELEASE_ADAPTER_SDK_PATH]).toBe(SDK.replace(OLD.artifactDigest, NEXT.artifactDigest));
    expect(w.lines).toEqual([
      `sourceDigest: ${digest("1")} -> ${digest("1")} (unchanged)`,
      `sdkDigest: (none) -> ${digest("2")}`,
      `toolchainDigest: (none) -> ${digest("3")}`,
      `artifactDigest: ${digest("a")} -> ${digest("b")}`,
      "image: image@sha256:1 -> image@sha256:1 (unchanged)",
    ]);
  });

  test("a dirty tree is refused before any build or write", async () => {
    const w = world({ clean: false });
    expect(await main(w.dependencies, w.print)).toBe(2);
    expect(w.lines).toEqual(["refused: relock_dirty_tree: Commit or stash every change first: a lock must describe committed bytes."]);
    expect(w.builds()).toBe(0);
    expect(JSON.parse(w.files[S3_RELEASE_ADAPTER_LOCK_PATH]!)).toEqual(OLD);
  });

  test("an SDK that does not name the locked artifact exactly once is refused before any build", async () => {
    for (const sdk of ["export const nothing = 1;\n", SDK + SDK]) {
      const w = world({ sdk });
      expect(await main(w.dependencies, w.print)).toBe(2);
      expect(w.lines[0]).toStartWith("refused: relock_sdk_literal_not_found:");
      expect(w.builds()).toBe(0);
    }
  });

  test("a failed build is not a refusal: it propagates and nothing is written", async () => {
    const w = world({ build: async () => { throw new Error("podman unavailable"); } });
    await expect(main(w.dependencies, w.print)).rejects.toThrow("podman unavailable");
    expect(JSON.parse(w.files[S3_RELEASE_ADAPTER_LOCK_PATH]!)).toEqual(OLD);
  });

  test("the real dependencies read this repository's lock and report the tree state", async () => {
    expect(JSON.parse(await relockDependencies.read(S3_RELEASE_ADAPTER_LOCK_PATH))).toHaveProperty("artifactDigest");
    expect(typeof await relockDependencies.clean()).toBe("boolean");
  });
});
