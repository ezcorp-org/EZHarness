import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, link, unlink, realpath, lstat, type FileHandle } from "node:fs/promises";
import { resolve, join } from "node:path";
import { canonicalJson, validateArtifactFiles, validateWorkspaceFiles, validateWorkspacePath, type WorkspaceFiles } from "@ezcorp/extension-contract";
import { LifecycleError, type BlobStore } from "./types";

export { canonicalJson } from "@ezcorp/extension-contract";

export function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function digestObject(value: unknown): string {
  return digestBytes(new TextEncoder().encode(canonicalJson(value)));
}

export function validatePath(path: string): void {
  try { validateWorkspacePath(path); } catch { throw new LifecycleError("invalid_path", "Use a bounded relative file path without traversal."); }
}

export function validateFiles(files: WorkspaceFiles, kind: "workspace" | "artifact" = "workspace"): void {
  if (kind === "artifact") validateArtifactFiles(files);
  else validateWorkspaceFiles(files);
}

export async function putFiles(blobs: BlobStore, files: WorkspaceFiles, kind: "workspace" | "artifact" = "workspace"): Promise<string> {
  validateFiles(files, kind);
  return blobs.put(new TextEncoder().encode(canonicalJson(files)));
}

export async function getFiles(blobs: BlobStore, digest: string, kind: "workspace" | "artifact" = "workspace"): Promise<WorkspaceFiles> {
  const bytes = await blobs.get(digest);
  if (digestBytes(bytes) !== digest) throw new LifecycleError("artifact_corrupt", "Stored content does not match its digest.");
  const files: WorkspaceFiles = JSON.parse(new TextDecoder().decode(bytes));
  validateFiles(files, kind);
  return files;
}

export type ReleaseBlobAuditCondition = "healthy" | "empty" | "mostly_missing" | "single_missing" | "partially_missing";

export interface ReleaseBlobAudit {
  expected: number;
  present: number;
  missing: number;
  condition: ReleaseBlobAuditCondition;
}

export interface ReleaseBlobDigests {
  sourceDigest: string;
  artifactDigest: string;
}

/**
 * Check every immutable release object by name only. Reading and parsing all
 * stored artifacts during boot would turn a volume diagnostic into unbounded
 * startup work, and the digest filenames are already the storage contract.
 */
export async function auditReleaseBlobPresence(blobs: Pick<FileBlobStore, "has">, digests: Iterable<string>): Promise<ReleaseBlobAudit> {
  const expected = [...new Set(digests)];
  let present = 0;
  for (const digest of expected) if (await blobs.has(digest)) present++;
  const missing = expected.length - present;
  const condition: ReleaseBlobAuditCondition = missing === 0 ? "healthy"
    : present === 0 ? "empty"
      : missing === 1 ? "single_missing"
        : missing * 2 >= expected.length ? "mostly_missing"
          : "partially_missing";
  return { expected: expected.length, present, missing, condition };
}

/**
 * Classify the persistent release store without logging installation ids,
 * release names, or content digests. The caller supplies the boot logger.
 */
export async function auditReleaseBlobStorage(blobs: Pick<FileBlobStore, "has">, releases: Iterable<ReleaseBlobDigests>, warn: (message: string, details: ReleaseBlobAudit) => void): Promise<ReleaseBlobAudit> {
  const digests: string[] = [];
  for (const release of releases) digests.push(release.sourceDigest, release.artifactDigest);
  const audit = await auditReleaseBlobPresence(blobs, digests);
  if (audit.condition === "empty") warn("Extension release blob storage is empty. The release volume may be renamed or unmounted; mount the expected volume or copy release blobs from the prior volume. Do not restore the database.", audit);
  else if (audit.condition === "mostly_missing") warn("Most extension release blobs are missing. The release volume may be renamed or unmounted; mount the expected volume or copy release blobs from the prior volume. Do not restore the database.", audit);
  else if (audit.condition === "single_missing") warn("One extension release blob is missing. Restore or rebuild the affected release.", audit);
  else if (audit.condition === "partially_missing") warn("Some extension release blobs are missing. Restore or rebuild the affected releases.", audit);
  return audit;
}

export class FileBlobStore implements BlobStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private async directory(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await realpath(this.root)) !== this.root || !(await lstat(this.root)).isDirectory()) throw new LifecycleError("unsafe_blob_root", "Blob storage must be a host-owned directory without symlinks.");
  }

  async put(bytes: Uint8Array): Promise<string> {
    if (bytes.byteLength > 192 * 1024 * 1024) throw new LifecycleError("artifact_corrupt", "Stored content exceeds the artifact byte limit.");
    await this.directory();
    const digest = digestBytes(bytes);
    const temporary = join(this.root, `.stage-${randomUUID()}`);
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      try {
        await link(temporary, join(this.root, digest));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.get(digest);
      }
      const directory = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await directory.sync(); } finally { await directory.close(); }
      return digest;
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  /** True only for an existing regular blob; never reads its contents. */
  async has(digest: string): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new LifecycleError("invalid_digest", "Invalid content digest.");
    await this.directory();
    let handle: FileHandle;
    try {
      handle = await open(join(this.root, digest), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw cause;
    }
    try { return (await handle.stat()).isFile(); } finally { await handle.close(); }
  }

  async get(digest: string): Promise<Uint8Array> {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new LifecycleError("invalid_digest", "Invalid content digest.");
    await this.directory();
    let handle: FileHandle;
    try {
      handle = await open(join(this.root, digest), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw new LifecycleError("artifact_missing", "One stored extension release blob is missing. Restore or rebuild the affected release.");
      throw cause;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 192 * 1024 * 1024) throw new LifecycleError("artifact_corrupt", "Stored content is not a bounded regular file.");
      const bytes = await handle.readFile();
      if (digestBytes(bytes) !== digest) throw new LifecycleError("artifact_corrupt", "Stored content does not match its digest.");
      return bytes;
    } finally { await handle.close(); }
  }
}
