import { digestBytes } from "../../extensions/v4/blobs";
import { assertFactoryGitPath, assertFactoryGitSha, factoryGitBlobId, FactoryGitObjectError, type FactoryGitFileMode } from "../git-objects";

/**
 * The pinned repository snapshot the reference code factory generates against.
 *
 * A snapshot is taken once, from one immutable commit, and every later step measures against it:
 * the generator sees these bytes, the freeze names this commit as the parent, and the checks
 * compare the candidate to this tree. Nothing downstream re-reads the repository, so a branch that
 * moves during a run cannot change what was tested or what the pull request claims was tested.
 *
 * The supported launch repository is narrow on purpose (C10): one Bun/TypeScript package with a
 * checked-in frozen lockfile and explicit build, typecheck, and test scripts. A repository outside
 * that shape is refused here, by name, rather than discovered halfway through a check run.
 */

export const REFERENCE_CODE_SNAPSHOT_SCHEMA_VERSION = "factory.reference-code-snapshot.v1" as const;

/** Scripts C10 requires a supported launch repository to declare. */
export const REFERENCE_CODE_REQUIRED_SCRIPTS = Object.freeze(["build", "typecheck", "test"] as const);

/** Lockfile names Bun writes. One of them must be checked in and frozen. */
export const REFERENCE_CODE_LOCK_NAMES = Object.freeze(["bun.lock", "bun.lockb"] as const);

export const REFERENCE_CODE_SNAPSHOT_LIMITS = Object.freeze({
  maxFiles: 5_000,
  maxFileBytes: 8 * 1024 * 1024,
  maxTreeBytes: 32 * 1024 * 1024,
});

export type ReferenceCodeSnapshotErrorCode =
  | "reference_code_repository_unreadable"
  | "reference_code_base_commit_unknown"
  | "reference_code_manifest_missing"
  | "reference_code_manifest_invalid"
  | "reference_code_script_missing"
  | "reference_code_lockfile_missing"
  | "reference_code_tree_unsupported"
  | "reference_code_snapshot_too_large";

export class ReferenceCodeSnapshotError extends Error {
  constructor(readonly code: ReferenceCodeSnapshotErrorCode, readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ReferenceCodeSnapshotError";
  }
}

export interface ReferenceCodeFile {
  readonly path: string;
  readonly mode: FactoryGitFileMode;
  readonly content: Uint8Array;
}

export interface ReferenceCodeSnapshot {
  readonly schemaVersion: typeof REFERENCE_CODE_SNAPSHOT_SCHEMA_VERSION;
  /** The immutable base commit. Every candidate commit names this as its only parent. */
  readonly baseSha: string;
  /** The commit's root tree, recomputed locally rather than taken from the reader. */
  readonly treeSha: string;
  /** Complete, sorted by path. No entry is inherited from anywhere. */
  readonly files: readonly ReferenceCodeFile[];
  /** The checked-in frozen lockfile, by path and content digest. */
  readonly dependencyLockPath: string;
  readonly dependencyLockDigest: string;
  /** The declared scripts, exactly as the manifest spells them. */
  readonly scripts: Readonly<Record<(typeof REFERENCE_CODE_REQUIRED_SCRIPTS)[number], string>>;
  /** Content identity of the whole snapshot, independent of git. */
  readonly digest: string;
}

/**
 * One entry as a git tree reader reports it. The reader is a port so a snapshot can be taken from
 * a real repository, a fixture, or a recorded listing without three copies of the validation.
 */
export interface ReferenceCodeTreeEntry {
  readonly path: string;
  /** Git's raw mode. Anything but a regular file is refused, so `120000` and `160000` arrive here. */
  readonly mode: string;
  readonly content: Uint8Array;
}

export interface ReferenceCodeRepositoryReader {
  /** Resolves the commit, or throws. Must refuse a name that is not an immutable commit id. */
  resolveCommit(baseSha: string): Promise<{ readonly commitSha: string; readonly treeSha: string }>;
  /** Every blob reachable from that commit's tree, recursively. */
  readTree(commitSha: string): Promise<readonly ReferenceCodeTreeEntry[]>;
}

function sortFiles(files: readonly ReferenceCodeFile[]): readonly ReferenceCodeFile[] {
  return [...files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/**
 * Content identity for a complete file list.
 *
 * Deliberately not the git tree id: the git identity answers "which commit", and this answers
 * "which bytes", which is what the validator report, the disposable working copy, and the
 * candidate comparison all need. Both are recorded, and a mismatch in either is a refusal.
 */
export function referenceCodeFilesDigest(files: readonly ReferenceCodeFile[]): string {
  const lines = sortFiles(files).map(file => `${file.mode} ${digestBytes(file.content)} ${file.path}`);
  return `sha256:${digestBytes(new TextEncoder().encode(`${lines.join("\n")}\n`))}`;
}

function decodeUtf8(content: Uint8Array, code: ReferenceCodeSnapshotErrorCode): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(content); }
  catch { throw new ReferenceCodeSnapshotError(code, "not valid UTF-8"); }
}

/**
 * The declared build, typecheck, and test scripts, or a refusal naming the missing one.
 *
 * A script that is present but empty is treated as missing: a check that runs an empty command
 * exits zero and would report a passing claim for work that never happened.
 */
export function referenceCodeScripts(manifestContent: Uint8Array): ReferenceCodeSnapshot["scripts"] {
  let manifest: unknown;
  try { manifest = JSON.parse(decodeUtf8(manifestContent, "reference_code_manifest_invalid")); }
  catch (error) {
    if (error instanceof ReferenceCodeSnapshotError) throw error;
    throw new ReferenceCodeSnapshotError("reference_code_manifest_invalid", "package.json is not JSON");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new ReferenceCodeSnapshotError("reference_code_manifest_invalid", "package.json is not an object");
  }
  const scripts = (manifest as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    throw new ReferenceCodeSnapshotError("reference_code_script_missing", "package.json declares no scripts");
  }
  const declared = scripts as Record<string, unknown>;
  const resolved: Record<string, string> = {};
  for (const name of REFERENCE_CODE_REQUIRED_SCRIPTS) {
    const value = declared[name];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new ReferenceCodeSnapshotError("reference_code_script_missing", name);
    }
    resolved[name] = value;
  }
  return Object.freeze(resolved) as ReferenceCodeSnapshot["scripts"];
}

/**
 * Validates one tree listing and seals it as a snapshot.
 *
 * The mode check is the load-bearing one. A symlink (`120000`) can point outside the candidate
 * tree and a gitlink (`160000`) is a submodule; C10 supports neither, and both are refused by
 * their own name so the reason is never "an odd mode".
 */
export function sealReferenceCodeSnapshot(input: {
  readonly baseSha: string;
  readonly treeSha: string;
  readonly entries: readonly ReferenceCodeTreeEntry[];
}): ReferenceCodeSnapshot {
  assertFactoryGitSha(input.baseSha);
  assertFactoryGitSha(input.treeSha);
  if (input.entries.length < 1 || input.entries.length > REFERENCE_CODE_SNAPSHOT_LIMITS.maxFiles) {
    throw new ReferenceCodeSnapshotError("reference_code_snapshot_too_large", `${input.entries.length} entries`);
  }
  const files: ReferenceCodeFile[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const entry of input.entries) {
    if (entry.mode === "120000") throw new ReferenceCodeSnapshotError("reference_code_tree_unsupported", `symlink at ${entry.path}`);
    if (entry.mode === "160000") throw new ReferenceCodeSnapshotError("reference_code_tree_unsupported", `submodule at ${entry.path}`);
    if (entry.mode !== "100644" && entry.mode !== "100755") {
      throw new ReferenceCodeSnapshotError("reference_code_tree_unsupported", `mode ${entry.mode} at ${entry.path}`);
    }
    let path: string;
    try { path = assertFactoryGitPath(entry.path); }
    catch (error) {
      if (error instanceof FactoryGitObjectError) throw new ReferenceCodeSnapshotError("reference_code_tree_unsupported", `path ${entry.path}`);
      throw error;
    }
    if (seen.has(path)) throw new ReferenceCodeSnapshotError("reference_code_tree_unsupported", `duplicate path ${path}`);
    seen.add(path);
    if (entry.content.byteLength > REFERENCE_CODE_SNAPSHOT_LIMITS.maxFileBytes) {
      throw new ReferenceCodeSnapshotError("reference_code_snapshot_too_large", path);
    }
    totalBytes += entry.content.byteLength;
    if (totalBytes > REFERENCE_CODE_SNAPSHOT_LIMITS.maxTreeBytes) {
      throw new ReferenceCodeSnapshotError("reference_code_snapshot_too_large", `${totalBytes} bytes`);
    }
    files.push({ path, mode: entry.mode, content: entry.content });
  }
  const manifest = files.find(file => file.path === "package.json");
  if (!manifest) throw new ReferenceCodeSnapshotError("reference_code_manifest_missing");
  const scripts = referenceCodeScripts(manifest.content);
  const lock = files.find(file => (REFERENCE_CODE_LOCK_NAMES as readonly string[]).includes(file.path));
  if (!lock) throw new ReferenceCodeSnapshotError("reference_code_lockfile_missing", REFERENCE_CODE_LOCK_NAMES.join(" or "));
  const sorted = sortFiles(files);
  return Object.freeze({
    schemaVersion: REFERENCE_CODE_SNAPSHOT_SCHEMA_VERSION,
    baseSha: input.baseSha,
    treeSha: input.treeSha,
    files: sorted,
    dependencyLockPath: lock.path,
    dependencyLockDigest: `sha256:${digestBytes(lock.content)}`,
    scripts,
    digest: referenceCodeFilesDigest(sorted),
  });
}

/**
 * Takes the snapshot: resolve the pinned commit, read its complete tree, seal it.
 *
 * The commit the reader resolves must be the one that was asked for. A reader that answers a
 * different commit — because it accepted a branch name, or because the ref moved between the two
 * calls — is refused rather than trusted, since every later identity claim hangs off this SHA.
 */
export async function snapshotReferenceCodeRepository(
  reader: ReferenceCodeRepositoryReader,
  baseSha: string,
): Promise<ReferenceCodeSnapshot> {
  assertFactoryGitSha(baseSha);
  const resolved = await reader.resolveCommit(baseSha);
  if (resolved.commitSha !== baseSha) {
    throw new ReferenceCodeSnapshotError("reference_code_base_commit_unknown", `reader answered ${resolved.commitSha}`);
  }
  const entries = await reader.readTree(resolved.commitSha);
  return sealReferenceCodeSnapshot({ baseSha, treeSha: resolved.treeSha, entries });
}

/** The snapshot's files keyed by path, for callers that compare a candidate against the base. */
export function referenceCodeBaseBlobs(snapshot: ReferenceCodeSnapshot): ReadonlyMap<string, string> {
  return new Map(snapshot.files.map(file => [file.path, factoryGitBlobId(file.content)]));
}
