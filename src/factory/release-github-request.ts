import { canonicalizeJson } from "@ezcorp/factory-sdk/canonical";
import { digestBytes } from "../extensions/v4/digest";
import { isValidGitBranchName } from "../extensions/project-git-refs";
import {
  FactoryGitObjectError,
  assertFactoryGitPath,
  assertFactoryGitSha,
  factoryGitBlobId,
  factoryGitCommitId,
  factoryGitTreeId,
  type FactoryGitFile,
  type FactoryGitIdentity,
} from "./git-objects";

/**
 * The GitHub publication request and every rule it must satisfy, with no transport (W4H-28).
 *
 * Split out of `release-github.ts` so the reference-code freeze can run in a sandboxed guest and
 * still validate its candidate with the publication adapter's OWN rules: this module reaches no
 * network client, no object store and no host directory. `release-github.ts` re-exports it, so the
 * provider and the freeze apply one copy of the rules.
 */

/** The digest an approved title and body are bound by: sha256 over their canonical JSON. */
export function factoryGitHubTitleBodyDigest(title: string, body: string): string {
  return `sha256:${digestBytes(new TextEncoder().encode(canonicalizeJson({ title, body })))}`;
}

export const FACTORY_GITHUB_PUBLICATION_SCHEMA_VERSION = "factory.github-publication.v1" as const;
export const FACTORY_GITHUB_OPERATION_MARKER = "EZCorp-Factory-Operation:" as const;
export const FACTORY_GITHUB_LIMITS = Object.freeze({
  maxFiles: 5_000,
  maxTreeBytes: 32 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxTitleLength: 500,
  maxBodyLength: 100_000,
  maxProtectedPaths: 1_000,
  maxAllowedPaths: 1_000,
});

/** Files whose presence hands install-time network and script control to the repository. */
const REPOSITORY_CONTROLLED_INSTALL = new Set([".npmrc", ".yarnrc", ".yarnrc.yml", "bunfig.toml", ".pnpmfile.cjs", ".gitmodules"]);
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly"] as const;
const REMOTE_SPECIFIER = /^(?:git|git\+[a-z]+|https?|file|link|portal|github|gitlab|bitbucket|npm):|^[^@/]+\/[^@/]+(?:#|$)/i;
const LFS_POINTER = "version https://git-lfs.github.com/spec/";

export type FactoryGitHubErrorCode =
  | "factory_github_request_invalid"
  | "factory_github_foreign_target"
  | "factory_github_submodule_rejected"
  | "factory_github_lfs_rejected"
  | "factory_github_link_rejected"
  | "factory_github_network_install_rejected"
  | "factory_github_path_not_allowed"
  | "factory_github_protected_asset_changed"
  | "factory_github_dependency_lock_changed"
  | "factory_github_base_unknown"
  | "factory_github_base_tree_truncated"
  | "factory_github_identity_mismatch"
  | "factory_github_ref_conflict"
  | "factory_github_pull_ambiguous"
  | "factory_github_pull_invalid";

export class FactoryGitHubError extends Error {
  constructor(readonly code: FactoryGitHubErrorCode) { super(code); this.name = "FactoryGitHubError"; }
}

export interface FactoryGitHubPublicationFile {
  readonly path: string;
  readonly mode: "100644" | "100755";
  readonly contentBase64: string;
}

export interface FactoryGitHubPublicationRequest {
  readonly schemaVersion: typeof FACTORY_GITHUB_PUBLICATION_SCHEMA_VERSION;
  /** GitHub's numeric repository id. The name can be renamed; this cannot. */
  readonly repositoryId: number;
  readonly baseBranch: string;
  /** The exact base the protected checks ran against. Never the current moving head. */
  readonly baseSha: string;
  readonly treeSha: string;
  readonly commitSha: string;
  readonly commitMessage: string;
  readonly author: FactoryGitIdentity;
  readonly committer: FactoryGitIdentity;
  readonly title: string;
  readonly body: string;
  readonly titleBodyDigest: string;
  readonly dependencyLockPath: string;
  readonly dependencyLockDigest: string;
  readonly protectedPaths: readonly string[];
  readonly allowedPaths: readonly string[];
  readonly files: readonly FactoryGitHubPublicationFile[];
}

/** The request as validated, with every file decoded once and its blob identity computed. */
export interface FactoryGitHubPublicationPlan {
  readonly request: FactoryGitHubPublicationRequest;
  readonly blobs: ReadonlyMap<string, { readonly mode: "100644" | "100755"; readonly content: Uint8Array; readonly blobId: string }>;
}

function invalid(): never { throw new FactoryGitHubError("factory_github_request_invalid"); }

function bounded(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.includes("\0")) invalid();
  return value;
}

function decodeBase64(value: string): Uint8Array {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) invalid();
  return new Uint8Array(bytes);
}

export function publicationRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

/**
 * A path in a publication request, refused in this module's own vocabulary.
 *
 * `assertFactoryGitPath` throws `FactoryGitObjectError`, which is right for the object layer and
 * wrong here: a caller of `assertFactoryGitHubPublicationRequest` should get one error type for
 * every reason a request is unusable, whether the reason is an escaping path or a missing field.
 */
function publicationPath(value: unknown, maximum = 4096): string {
  const path = bounded(value, maximum);
  try { return assertFactoryGitPath(path); }
  catch (error) { if (error instanceof FactoryGitObjectError) invalid(); throw error; }
}

/**
 * The author or committer a commit is reproduced from.
 *
 * The timezone is pinned to `+0000` because the identity is sent to GitHub as an ISO instant,
 * which GitHub writes back as `+0000`; any other offset would make the commit GitHub stores differ
 * from the one this request names, and the identity check would refuse it after the write.
 */
function publicationIdentity(value: unknown): FactoryGitIdentity {
  const source = publicationRecord(value);
  if (Object.keys(source).length !== 4) invalid();
  if (source.timezone !== "+0000") invalid();
  return { name: bounded(source.name, 255), email: bounded(source.email, 255), atSeconds: source.atSeconds as number, timezone: source.timezone };
}

/** True when a path sits under one of the prefixes a request was approved for. */
export function publicationPathAllowed(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some(prefix => prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix);
}

function rejectRepositoryControlledInstall(path: string, content: Uint8Array): void {
  const name = path.split("/").pop()!;
  if (REPOSITORY_CONTROLLED_INSTALL.has(name)) {
    throw new FactoryGitHubError(name === ".gitmodules" ? "factory_github_submodule_rejected" : "factory_github_network_install_rejected");
  }
  if (name !== "package.json") return;
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)) as Record<string, unknown>; }
  catch { throw new FactoryGitHubError("factory_github_request_invalid"); }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new FactoryGitHubError("factory_github_request_invalid");
  const scripts = manifest.scripts;
  if (scripts && typeof scripts === "object" && INSTALL_SCRIPTS.some(name => Object.hasOwn(scripts, name))) throw new FactoryGitHubError("factory_github_network_install_rejected");
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const block = manifest[field];
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    for (const specifier of Object.values(block as Record<string, unknown>)) {
      if (typeof specifier !== "string" || REMOTE_SPECIFIER.test(specifier)) throw new FactoryGitHubError("factory_github_network_install_rejected");
    }
  }
}

/** The blob one accepted file contributes, keyed by its publication path. */
type PublicationBlob = { mode: "100644" | "100755"; content: Uint8Array; blobId: string };

/** The request's own envelope: exactly these keys, each within its declared bound. */
function assertPublicationEnvelope(source: Record<string, unknown>): void {
  const expectedKeys = ["schemaVersion", "repositoryId", "baseBranch", "baseSha", "treeSha", "commitSha", "commitMessage", "author", "committer", "title", "body", "titleBodyDigest", "dependencyLockPath", "dependencyLockDigest", "protectedPaths", "allowedPaths", "files"];
  if (Object.keys(source).length !== expectedKeys.length || !expectedKeys.every(key => Object.hasOwn(source, key))) invalid();
  if (source.schemaVersion !== FACTORY_GITHUB_PUBLICATION_SCHEMA_VERSION) invalid();
  if (!Number.isSafeInteger(source.repositoryId) || (source.repositoryId as number) < 1) invalid();
  const baseBranch = bounded(source.baseBranch, 255);
  if (!isValidGitBranchName(baseBranch)) invalid();
  const title = bounded(source.title, FACTORY_GITHUB_LIMITS.maxTitleLength);
  const body = bounded(source.body, FACTORY_GITHUB_LIMITS.maxBodyLength);
  if (!title.trim()) invalid();
  if (typeof source.titleBodyDigest !== "string" || source.titleBodyDigest !== factoryGitHubTitleBodyDigest(title, body)) invalid();
  if (!Array.isArray(source.files) || source.files.length < 1 || source.files.length > FACTORY_GITHUB_LIMITS.maxFiles) invalid();
  if (!Array.isArray(source.protectedPaths) || source.protectedPaths.length > FACTORY_GITHUB_LIMITS.maxProtectedPaths) invalid();
  if (!Array.isArray(source.allowedPaths) || source.allowedPaths.length < 1 || source.allowedPaths.length > FACTORY_GITHUB_LIMITS.maxAllowedPaths) invalid();
}

/**
 * Decodes every declared file into the blob the tree will hold.
 *
 * A symlink or a gitlink entry is refused by name, so the reason is never "an odd mode".
 */
function collectPublicationFiles(request: FactoryGitHubPublicationRequest): { blobs: Map<string, PublicationBlob>; files: FactoryGitFile[] } {
  const blobs = new Map<string, PublicationBlob>();
  const files: FactoryGitFile[] = [];
  let totalBytes = 0;
  for (const entry of request.files) {
    const file = publicationRecord(entry);
    if (Object.keys(file).length !== 3) invalid();
    const path = publicationPath(file.path);
    if (file.mode === "120000") throw new FactoryGitHubError("factory_github_link_rejected");
    if (file.mode === "160000") throw new FactoryGitHubError("factory_github_submodule_rejected");
    if (file.mode !== "100644" && file.mode !== "100755") invalid();
    if (typeof file.contentBase64 !== "string" || file.contentBase64.length > FACTORY_GITHUB_LIMITS.maxFileBytes * 2) invalid();
    const content = decodeBase64(file.contentBase64);
    if (content.byteLength > FACTORY_GITHUB_LIMITS.maxFileBytes) invalid();
    totalBytes += content.byteLength;
    if (totalBytes > FACTORY_GITHUB_LIMITS.maxTreeBytes) invalid();
    if (blobs.has(path)) invalid();
    if (Buffer.from(content.subarray(0, LFS_POINTER.length)).toString("utf8") === LFS_POINTER) throw new FactoryGitHubError("factory_github_lfs_rejected");
    rejectRepositoryControlledInstall(path, content);
    blobs.set(path, { mode: file.mode, content, blobId: factoryGitBlobId(content) });
    files.push({ path, mode: file.mode, content });
  }
  return { blobs, files };
}

/** The paths the approval bound: every protected asset present, and the lock unchanged. */
function assertPublicationPaths(request: FactoryGitHubPublicationRequest, blobs: ReadonlyMap<string, PublicationBlob>): void {
  for (const path of request.protectedPaths) { publicationPath(path); if (!blobs.has(path)) throw new FactoryGitHubError("factory_github_protected_asset_changed"); }
  for (const prefix of request.allowedPaths) { publicationPath(typeof prefix === "string" && prefix.endsWith("/") ? prefix.slice(0, -1) : prefix); }
  const lock = blobs.get(publicationPath(request.dependencyLockPath));
  if (!lock) throw new FactoryGitHubError("factory_github_dependency_lock_changed");
  if (typeof request.dependencyLockDigest !== "string" || request.dependencyLockDigest !== `sha256:${digestBytes(lock.content)}`) throw new FactoryGitHubError("factory_github_dependency_lock_changed");
}

/**
 * The checks that matter most: the tree SHA and the commit SHA the request declares must be
 * exactly what its own file list, base parent, identities, and message produce. A request cannot
 * name an accepted candidate it does not contain.
 */
function assertPublicationIdentity(request: FactoryGitHubPublicationRequest, files: readonly FactoryGitFile[]): void {
  try {
    assertFactoryGitSha(request.baseSha); assertFactoryGitSha(request.treeSha); assertFactoryGitSha(request.commitSha);
    bounded(request.commitMessage, 8192);
    const treeId = factoryGitTreeId(files);
    if (treeId !== request.treeSha) throw new FactoryGitHubError("factory_github_identity_mismatch");
    const commitId = factoryGitCommitId({ treeId, parents: [request.baseSha], author: publicationIdentity(request.author), committer: publicationIdentity(request.committer), message: request.commitMessage });
    if (commitId !== request.commitSha) throw new FactoryGitHubError("factory_github_identity_mismatch");
  } catch (error) {
    if (error instanceof FactoryGitHubError) throw error;
    if (error instanceof FactoryGitObjectError) invalid();
    throw error;
  }
}

/**
 * Every rule the approved request must satisfy before one byte reaches GitHub.
 *
 * One rule group per step, run in the order they were written inline: the envelope, then the
 * files it declares, then the paths the approval bound, then the two identity checks.
 */
export function assertFactoryGitHubPublicationRequest(value: unknown): FactoryGitHubPublicationPlan {
  const source = publicationRecord(value);
  assertPublicationEnvelope(source);

  const request = source as unknown as FactoryGitHubPublicationRequest;
  const { blobs, files } = collectPublicationFiles(request);
  assertPublicationPaths(request, blobs);
  assertPublicationIdentity(request, files);
  return { request, blobs };
}
