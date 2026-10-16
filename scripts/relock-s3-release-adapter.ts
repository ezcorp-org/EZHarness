#!/usr/bin/env bun
/**
 * Re-locks the reference S3 release adapter (W4H-28, ruling A): `bun scripts/relock-s3-release-adapter.ts`.
 * Refuses on a dirty tree; rebuilds the adapter in the pinned image (Podman); writes lock.json and the factory-sdk
 * literal; prints each digest old -> new. Commit the two files it writes.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildS3ReleaseAdapterLock, relockS3ReleaseAdapter, S3ReleaseAdapterRelockError, type S3ReleaseAdapterRelockDependencies } from "../src/factory/s3-release-adapter/relock";

const ROOT = join(import.meta.dir, "..");

export const relockDependencies: S3ReleaseAdapterRelockDependencies = {
  clean: async () => (await new Response(Bun.spawn(["git", "status", "--porcelain"], { cwd: ROOT, stdout: "pipe" }).stdout).text()).trim() === "",
  build: buildS3ReleaseAdapterLock,
  read: path => readFile(join(ROOT, path), "utf8"),
  write: (path, text) => writeFile(join(ROOT, path), text),
};

export async function main(dependencies: S3ReleaseAdapterRelockDependencies = relockDependencies, print: (line: string) => void = console.log): Promise<number> {
  try {
    const { old, next } = await relockS3ReleaseAdapter(dependencies);
    for (const key of Object.keys(next) as Array<keyof typeof next>) print(`${key}: ${old[key] ?? "(none)"} -> ${next[key]}${old[key] === next[key] ? " (unchanged)" : ""}`);
    return 0;
  } catch (error) {
    if (!(error instanceof S3ReleaseAdapterRelockError)) throw error;
    print(`refused: ${error.code}: ${error.message}`);
    return 2;
  }
}

if (import.meta.main) process.exit(await main());
