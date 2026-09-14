#!/usr/bin/env bun
/**
 * Downloads the pinned SDXL weight closure named by the reference image lock.
 *
 * Every byte this writes is bound to a digest the lock declared before the
 * download started, so the network cannot decide what the closure contains. A
 * large file carries the model host's SHA-256; a small one carries its Git blob
 * identifier, which is a SHA-1 over `blob <size>\0` plus the content. Both are
 * checked, the second because a small configuration file is not stored by
 * content address upstream and would otherwise arrive unbound.
 *
 * The closure is immutable once sealed: the directory and every file in it lose
 * write permission, and a rerun verifies rather than refetches. A mismatch
 * leaves the partial file in place under a `.rejected` name and exits non-zero,
 * because a silently discarded bad download is a lost fact.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { referenceImageLock, sdxlClosureDirectory, sdxlWeightUrl } from "../src/factory/reference-image/lock.ts";
import type { ReferenceImageModelFile } from "../src/factory/reference-image/lock.ts";

/** The Git blob identifier of these bytes: SHA-1 over `blob <size>\0` and the content. */
function gitBlobId(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** A weight file takes minutes on an ordinary link, so the ceiling is generous rather than default. */
const FETCH_TIMEOUT_MS = 60 * 60 * 1000;

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Reports what the bytes violate, or `undefined` when they satisfy their binding.
 *
 * Each file has exactly one binding that covers its content. A weight file is
 * bound by the model host's SHA-256; its Git identifier names the pointer object
 * upstream and says nothing about these bytes, so checking it here would reject
 * a correct download. A small file has no upstream SHA-256, and its Git
 * identifier is computed over the content, so that is the binding.
 */
function mismatch(file: ReferenceImageModelFile, bytes: Uint8Array): string | undefined {
  if (bytes.length !== file.bytes) return `expected ${file.bytes} bytes and read ${bytes.length}`;
  if (file.digest !== undefined) {
    const digest = sha256(bytes);
    return digest === file.digest ? undefined : `expected ${file.digest} and computed ${digest}`;
  }
  const blobId = gitBlobId(bytes);
  return blobId === file.blobId ? undefined : `expected blob ${file.blobId} and computed ${blobId}`;
}

interface FetchRecord {
  readonly path: string;
  readonly url: string;
  readonly bytes: number;
  readonly digest: string;
  readonly blobId: string;
  readonly action: "verified" | "downloaded";
  readonly elapsedMs: number;
}

async function present(target: string, file: ReferenceImageModelFile): Promise<boolean> {
  const info = await stat(target).catch(() => undefined);
  return info !== undefined && info.isFile() && info.size === file.bytes;
}

/**
 * Streams one file to disk while hashing it, then decides.
 *
 * A weight file is gigabytes; reading it into one buffer would hold all of it in
 * memory and hit the request timeout on a slow link. The bytes therefore go
 * straight to a partial file and both digests are computed as they pass. The
 * partial file is only renamed into place once it satisfies its binding, so a
 * failed or interrupted download can never be mistaken for a sealed one.
 */
async function download(file: ReferenceImageModelFile, url: string, target: string): Promise<{ digest: string; blobId: string; bytes: number }> {
  const partial = `${target}.partial`;
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Model host answered ${response.status} for ${file.path}`);
  if (response.body === null) throw new Error(`Model host sent no body for ${file.path}`);
  const content = createHash("sha256");
  const blob = createHash("sha1").update(`blob ${file.bytes}\0`);
  let written = 0;
  const sink = Bun.file(partial).writer();
  try {
    for await (const piece of response.body as unknown as AsyncIterable<Uint8Array>) {
      content.update(piece);
      blob.update(piece);
      written += piece.length;
      sink.write(piece);
      if (written > file.bytes) break;
    }
  } finally {
    await sink.end();
  }
  return { digest: `sha256:${content.digest("hex")}`, blobId: blob.digest("hex"), bytes: written };
}

/** Reports what a streamed download violated, given the digests computed in passing. */
function streamedMismatch(file: ReferenceImageModelFile, observed: { digest: string; blobId: string; bytes: number }): string | undefined {
  if (observed.bytes !== file.bytes) return `expected ${file.bytes} bytes and read ${observed.bytes}`;
  if (file.digest !== undefined) return observed.digest === file.digest ? undefined : `expected ${file.digest} and computed ${observed.digest}`;
  return observed.blobId === file.blobId ? undefined : `expected blob ${file.blobId} and computed ${observed.blobId}`;
}

async function fetchOne(file: ReferenceImageModelFile, directory: string): Promise<FetchRecord> {
  const target = join(directory, file.path);
  const url = sdxlWeightUrl(file.path);
  const startedAt = Date.now();
  if (await present(target, file)) {
    const existing = new Uint8Array(await readFile(target));
    const problem = mismatch(file, existing);
    if (problem !== undefined) throw new Error(`Sealed closure file ${file.path} no longer matches the lock: ${problem}`);
    return { path: file.path, url, bytes: existing.length, digest: sha256(existing), blobId: gitBlobId(existing), action: "verified", elapsedMs: Date.now() - startedAt };
  }
  await mkdir(dirname(target), { recursive: true });
  const observed = await download(file, url, target);
  const problem = streamedMismatch(file, observed);
  if (problem !== undefined) {
    await rename(`${target}.partial`, `${target}.rejected`);
    throw new Error(`Downloaded ${file.path} does not match the lock: ${problem}. The bytes are kept at ${target}.rejected`);
  }
  await rename(`${target}.partial`, target);
  return { path: file.path, url, bytes: observed.bytes, digest: observed.digest, blobId: observed.blobId, action: "downloaded", elapsedMs: Date.now() - startedAt };
}

/** Removes write permission from the closure so a later run cannot edit what it verified. */
async function seal(directory: string, files: readonly ReferenceImageModelFile[]): Promise<void> {
  for (const file of files) await chmod(join(directory, file.path), 0o444);
  const directories = new Set(files.map(file => dirname(join(directory, file.path))));
  for (const entry of [...directories].sort((left, right) => right.length - left.length)) await chmod(entry, 0o555);
  await chmod(directory, 0o555);
}

/** Restores owner write permission so a rerun can replace a file the lock changed. */
async function unseal(directory: string): Promise<void> {
  await chmod(directory, 0o755).catch(() => undefined);
  for (const file of referenceImageLock.model.files) {
    await chmod(dirname(join(directory, file.path)), 0o755).catch(() => undefined);
    await chmod(join(directory, file.path), 0o644).catch(() => undefined);
  }
}

async function main(): Promise<number> {
  const directory = sdxlClosureDirectory();
  const receiptPath = process.env.EZCORP_FACTORY_SDXL_RECEIPT ?? join(directory, "closure-receipt.json");
  await mkdir(directory, { recursive: true });
  await unseal(directory);
  const records: FetchRecord[] = [];
  const startedAt = new Date().toISOString();
  for (const file of referenceImageLock.model.files) {
    const record = await fetchOne(file, directory);
    records.push(record);
    process.stdout.write(`${record.action} ${record.path} ${record.bytes} ${record.digest}\n`);
  }
  const receipt = {
    schemaVersion: "factory.reference-image-closure-receipt.v1",
    source: referenceImageLock.model.source,
    repository: referenceImageLock.model.repository,
    revision: referenceImageLock.model.revision,
    directory,
    startedAt,
    completedAt: new Date().toISOString(),
    totalBytes: records.reduce((total, record) => total + record.bytes, 0),
    files: records,
  };
  await mkdir(dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, `${JSON.stringify(receipt, undefined, 2)}\n`);
  await seal(directory, referenceImageLock.model.files);
  process.stdout.write(`sealed ${directory} totalBytes=${receipt.totalBytes} receipt=${receiptPath}\n`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  });
}
