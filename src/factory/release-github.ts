import { canonicalJson } from "@ezcorp/extension-contract";
import { digestBytes, digestObject } from "../extensions/v4/blobs";
import { ProjectGitHubHttpError, requestProjectGitHub } from "../extensions/project-github-transport";
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
import { assertFactoryGitBranchBinding, isFactoryGitReleaseProvider, type FactoryGitBranchBinding } from "./release-git-refs";
import type { FactoryProviderReceipt, FactoryReleaseClaim, FactoryReleaseOperation, FactoryReleaseProvider } from "./releases";

/**
 * The GitHub half of the C10 release adapter.
 *
 * What it publishes is a complete immutable tree on one unique branch, plus one draft pull request
 * to the tested base. What it never does is force-update a ref, merge a pull request, or send a
 * second creating request from reconciliation. Every identity GitHub returns is compared with one
 * computed locally from the approved bytes, so a 200 that stored something else is a failure.
 *
 * The request is self-proving: it declares the tree SHA and the commit SHA it expects, and
 * validation recomputes both from the file list and refuses a mismatch. An approved request
 * therefore names exactly one possible remote state, and a lost response can be resolved by
 * reading one ref rather than by guessing.
 */

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

function record(value: unknown): Record<string, unknown> {
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
function identity(value: unknown): FactoryGitIdentity {
  const source = record(value);
  if (Object.keys(source).length !== 4) invalid();
  if (source.timezone !== "+0000") invalid();
  return { name: bounded(source.name, 255), email: bounded(source.email, 255), atSeconds: source.atSeconds as number, timezone: source.timezone };
}

/** True when a path sits under one of the prefixes a request was approved for. */
function allowed(path: string, prefixes: readonly string[]): boolean {
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
  if (typeof source.titleBodyDigest !== "string" || source.titleBodyDigest !== `sha256:${digestObject({ title, body })}`) invalid();
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
    const file = record(entry);
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
    const commitId = factoryGitCommitId({ treeId, parents: [request.baseSha], author: identity(request.author), committer: identity(request.committer), message: request.commitMessage });
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
  const source = record(value);
  assertPublicationEnvelope(source);

  const request = source as unknown as FactoryGitHubPublicationRequest;
  const { blobs, files } = collectPublicationFiles(request);
  assertPublicationPaths(request, blobs);
  assertPublicationIdentity(request, files);
  return { request, blobs };
}

interface GitHubTreeEntry { path?: unknown; mode?: unknown; type?: unknown; sha?: unknown }

export interface FactoryGitHubProviderOptions {
  /** `owner/name`, matched against the operation's destination account. */
  readonly repository: string;
  /** The project identity the shared transport authorizes and audits under. */
  readonly projectId: string;
  /** Rechecks the broker's recorded authority immediately before every network call. */
  readonly authorize: () => Promise<unknown>;
  /** The broker's own credential, from private service configuration. Never logged. */
  readonly readToken: () => Promise<string | null>;
  readonly request?: typeof requestProjectGitHub;
  readonly timeoutMs?: number;
}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class FactoryGitHubReleaseProvider implements FactoryReleaseProvider {
  private readonly send: typeof requestProjectGitHub;
  constructor(private readonly options: FactoryGitHubProviderOptions) {
    if (!REPOSITORY.test(options.repository ?? "")) throw new FactoryGitHubError("factory_github_foreign_target");
    this.send = options.request ?? requestProjectGitHub;
  }

  private async call(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.send({
      projectId: this.options.projectId, path, method, ...(body === undefined ? {} : { body }),
      authorize: this.options.authorize, readToken: this.options.readToken,
      ...(signal ? { signal } : {}),
      maxBodyBytes: 16 * 1024 * 1024, timeoutMs: this.options.timeoutMs ?? 60_000,
    });
  }

  /** The binding an operation may create, re-derived from its id rather than read from its row. */
  private binding(operation: FactoryReleaseOperation): FactoryGitBranchBinding {
    if (!isFactoryGitReleaseProvider(operation.destination.provider) || operation.destination.account !== this.options.repository) throw new FactoryGitHubError("factory_github_foreign_target");
    if (operation.destinationRef === undefined || operation.destinationBranch === undefined) throw new FactoryGitHubError("factory_github_foreign_target");
    // One vocabulary reaches the caller: a ref that is not this operation's own is a foreign target.
    try { return assertFactoryGitBranchBinding({ ref: operation.destinationRef, branch: operation.destinationBranch }, operation.operationId); }
    catch { throw new FactoryGitHubError("factory_github_foreign_target"); }
  }

  /** The one destination object shape a git publication may name. */
  private assertDestinationObject(operation: FactoryReleaseOperation, request: FactoryGitHubPublicationRequest): void {
    if (operation.destination.object !== `pull-request/${request.baseBranch}/${request.commitSha}`) throw new FactoryGitHubError("factory_github_foreign_target");
    if (operation.destination.expectedVersion !== undefined) throw new FactoryGitHubError("factory_github_foreign_target");
  }

  private marker(operationId: string): string { return `${FACTORY_GITHUB_OPERATION_MARKER} ${operationId}`; }

  private plan(operation: FactoryReleaseOperation): FactoryGitHubPublicationPlan {
    const plan = assertFactoryGitHubPublicationRequest(operation.request);
    this.assertDestinationObject(operation, plan.request);
    if (!plan.request.body.includes(this.marker(operation.operationId))) throw new FactoryGitHubError("factory_github_request_invalid");
    return plan;
  }

  async publish(claim: FactoryReleaseClaim, signal?: AbortSignal): Promise<FactoryProviderReceipt> {
    const binding = this.binding(claim);
    const { request, blobs } = this.plan(claim);
    const repository = this.options.repository;

    const repositoryRecord = record(await this.call("GET", `/repos/${repository}`, undefined, signal));
    if (repositoryRecord.id !== request.repositoryId) throw new FactoryGitHubError("factory_github_foreign_target");

    // The tested base must exist as a commit. Its current branch head is deliberately not required
    // to equal it: opening a pull request claims the tested base, not the moving one.
    let baseCommit: Record<string, unknown>;
    try { baseCommit = record(await this.call("GET", `/repos/${repository}/git/commits/${request.baseSha}`, undefined, signal)); }
    catch (error) { if (error instanceof ProjectGitHubHttpError && error.status === 404) throw new FactoryGitHubError("factory_github_base_unknown"); throw error; }
    if (baseCommit.sha !== request.baseSha) throw new FactoryGitHubError("factory_github_identity_mismatch");
    const baseTreeSha = assertFactoryGitSha(String(record(baseCommit.tree).sha));
    await this.assertTreeChanges(repository, baseTreeSha, request, blobs, signal);

    for (const [path, blob] of blobs) {
      const created = record(await this.call("POST", `/repos/${repository}/git/blobs`, { content: Buffer.from(blob.content).toString("base64"), encoding: "base64" }, signal));
      if (created.sha !== blob.blobId) throw new FactoryGitHubError("factory_github_identity_mismatch");
      if (!blobs.has(path)) throw new FactoryGitHubError("factory_github_identity_mismatch");
    }
    const tree = record(await this.call("POST", `/repos/${repository}/git/trees`, {
      tree: [...blobs].map(([path, blob]) => ({ path, mode: blob.mode, type: "blob", sha: blob.blobId })),
    }, signal));
    if (tree.sha !== request.treeSha) throw new FactoryGitHubError("factory_github_identity_mismatch");

    const commit = record(await this.call("POST", `/repos/${repository}/git/commits`, {
      message: request.commitMessage, tree: request.treeSha, parents: [request.baseSha],
      author: this.wireIdentity(request.author), committer: this.wireIdentity(request.committer),
    }, signal));
    const parents = Array.isArray(commit.parents) ? commit.parents.map(parent => record(parent).sha) : [];
    if (commit.sha !== request.commitSha || record(commit.tree).sha !== request.treeSha || parents.length !== 1 || parents[0] !== request.baseSha) throw new FactoryGitHubError("factory_github_identity_mismatch");

    await this.createRefOnce(repository, binding, request.commitSha, signal);
    const pull = await this.openDraftPullRequestOnce(repository, binding, claim, request, signal);
    return this.receipt(claim, binding, request, pull);
  }

  private wireIdentity(value: FactoryGitIdentity): Record<string, string> {
    const seconds = value.atSeconds;
    const iso = new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
    return { name: value.name, email: value.email, date: iso };
  }

  /**
   * Protected assets, allowed paths, and the dependency lock, measured against the tested base.
   *
   * Every difference between the candidate tree and the base tree — added, removed, or changed —
   * must sit under a prefix the request was approved for, and every protected path must be
   * byte-identical to the base. A truncated base listing is refused rather than partially checked.
   */
  private async assertTreeChanges(repository: string, baseTreeSha: string, request: FactoryGitHubPublicationRequest, blobs: FactoryGitHubPublicationPlan["blobs"], signal?: AbortSignal): Promise<void> {
    const listing = record(await this.call("GET", `/repos/${repository}/git/trees/${baseTreeSha}?recursive=1`, undefined, signal));
    if (listing.truncated === true) throw new FactoryGitHubError("factory_github_base_tree_truncated");
    if (!Array.isArray(listing.tree)) throw new FactoryGitHubError("factory_github_identity_mismatch");
    const base = new Map<string, string>();
    for (const entry of listing.tree as GitHubTreeEntry[]) {
      if (entry.type !== "blob") continue;
      if (typeof entry.path !== "string" || typeof entry.sha !== "string") throw new FactoryGitHubError("factory_github_identity_mismatch");
      base.set(entry.path, entry.sha);
    }
    for (const path of request.protectedPaths) {
      if (base.get(path) !== blobs.get(path)!.blobId) throw new FactoryGitHubError("factory_github_protected_asset_changed");
    }
    for (const [path, blob] of blobs) {
      if (base.get(path) === blob.blobId) continue;
      if (!allowed(path, request.allowedPaths)) throw new FactoryGitHubError("factory_github_path_not_allowed");
    }
    for (const path of base.keys()) {
      if (blobs.has(path) || allowed(path, request.allowedPaths)) continue;
      throw new FactoryGitHubError("factory_github_path_not_allowed");
    }
  }

  /**
   * Creates the branch, and resolves a lost response by reading that exact ref.
   *
   * A ref that already points at this operation's commit is the result of its own earlier attempt,
   * so the publication continues. A ref pointing anywhere else is a conflict: it is never
   * force-updated, and no second create is sent.
   */
  private async createRefOnce(repository: string, binding: FactoryGitBranchBinding, commitSha: string, signal?: AbortSignal): Promise<void> {
    try {
      const created = record(await this.call("POST", `/repos/${repository}/git/refs`, { ref: binding.ref, sha: commitSha }, signal));
      if (created.ref !== binding.ref || record(created.object).sha !== commitSha) throw new FactoryGitHubError("factory_github_identity_mismatch");
      return;
    } catch (error) {
      if (!(error instanceof ProjectGitHubHttpError) || error.status !== 422) throw error;
    }
    const existing = await this.readRef(repository, binding, signal);
    if (existing !== commitSha) throw new FactoryGitHubError("factory_github_ref_conflict");
  }

  /**
   * The ref as one URL path, with every segment escaped.
   *
   * The branch suffix is percent-encoded already, so its `%` characters must themselves be escaped
   * or GitHub decodes them back into the colon the encoding exists to remove. The slashes stay
   * literal, because the ref endpoint takes a multi-segment ref.
   */
  private refPath(binding: FactoryGitBranchBinding): string {
    return binding.branch.split("/").map(segment => encodeURIComponent(segment)).join("/");
  }

  private async readRef(repository: string, binding: FactoryGitBranchBinding, signal?: AbortSignal): Promise<string | null> {
    try {
      const found = record(await this.call("GET", `/repos/${repository}/git/ref/heads/${this.refPath(binding)}`, undefined, signal));
      if (found.ref !== binding.ref) throw new FactoryGitHubError("factory_github_identity_mismatch");
      return assertFactoryGitSha(String(record(found.object).sha));
    } catch (error) {
      if (error instanceof ProjectGitHubHttpError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * Opens exactly one draft pull request, and never sends a second creating request.
   *
   * A lost or refused POST is resolved by listing pull requests for this exact head and base. One
   * match carrying the operation marker is this operation's own earlier attempt. Several matches,
   * or one that does not carry the marker, need an operator. No match is left to the caller as the
   * uncertain outcome it is: the store keeps the operation uncertain rather than sending again.
   */
  private async openDraftPullRequestOnce(repository: string, binding: FactoryGitBranchBinding, operation: FactoryReleaseOperation, request: FactoryGitHubPublicationRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    try {
      return this.assertPull(record(await this.call("POST", `/repos/${repository}/pulls`, {
        title: request.title, body: request.body, head: binding.branch, base: request.baseBranch, draft: true,
      }, signal)), binding, operation, request);
    } catch (error) {
      if (error instanceof FactoryGitHubError) throw error;
      const found = await this.findPull(repository, binding, operation, request, signal);
      if (!found) throw error;
      return found;
    }
  }

  /** The one pull request this operation's head, base, and marker identify, or nothing. */
  private async findPull(repository: string, binding: FactoryGitBranchBinding, operation: FactoryReleaseOperation, request: FactoryGitHubPublicationRequest, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    const owner = repository.split("/")[0]!;
    const listed = await this.call("GET", `/repos/${repository}/pulls?state=all&per_page=100&head=${encodeURIComponent(`${owner}:${binding.branch}`)}&base=${encodeURIComponent(request.baseBranch)}`, undefined, signal);
    if (!Array.isArray(listed)) throw new FactoryGitHubError("factory_github_pull_invalid");
    const matches = listed.map(record).filter(pull => record(pull.head).ref === binding.branch && record(pull.head).sha === request.commitSha && String(pull.body ?? "").includes(this.marker(operation.operationId)));
    // Several matches, or results on this exact head that do not carry the marker, are states an
    // operator has to resolve. An empty list is the uncertain outcome, not a licence to send again.
    if (matches.length > 1) throw new FactoryGitHubError("factory_github_pull_ambiguous");
    if (matches.length === 0) {
      if (listed.length > 0) throw new FactoryGitHubError("factory_github_pull_ambiguous");
      return null;
    }
    return this.assertPull(matches[0]!, binding, operation, request);
  }

  private assertPull(pull: Record<string, unknown>, binding: FactoryGitBranchBinding, operation: FactoryReleaseOperation, request: FactoryGitHubPublicationRequest): Record<string, unknown> {
    const head = record(pull.head);
    const base = record(pull.base);
    if (!Number.isSafeInteger(pull.number) || (pull.number as number) < 1) throw new FactoryGitHubError("factory_github_pull_invalid");
    if (head.ref !== binding.branch || head.sha !== request.commitSha) throw new FactoryGitHubError("factory_github_identity_mismatch");
    if (base.ref !== request.baseBranch || record(base.repo).id !== request.repositoryId) throw new FactoryGitHubError("factory_github_identity_mismatch");
    if (pull.draft !== true) throw new FactoryGitHubError("factory_github_pull_invalid");
    if (pull.merged === true || typeof pull.html_url !== "string" || typeof pull.node_id !== "string") throw new FactoryGitHubError("factory_github_pull_invalid");
    if (!String(pull.body ?? "").includes(this.marker(operation.operationId))) throw new FactoryGitHubError("factory_github_pull_invalid");
    return pull;
  }

  private receipt(operation: FactoryReleaseOperation, binding: FactoryGitBranchBinding, request: FactoryGitHubPublicationRequest, pull: Record<string, unknown>): FactoryProviderReceipt {
    const effect = {
      repositoryId: request.repositoryId, ref: binding.ref, branch: binding.branch,
      headSha: request.commitSha, treeSha: request.treeSha, baseSha: request.baseSha, baseBranch: request.baseBranch,
      titleBodyDigest: request.titleBodyDigest, dependencyLockDigest: request.dependencyLockDigest,
      pullNumber: pull.number, pullNodeId: pull.node_id, pullUrl: pull.html_url, draft: true,
    };
    return {
      provider: "github", account: this.options.repository, object: operation.destination.object,
      requestDigest: operation.requestDigest, operationId: operation.operationId, dispatchGeneration: operation.dispatchGeneration,
      providerReceiptId: `github:${request.repositoryId}:pull:${pull.number}`,
      version: request.commitSha,
      effectDigest: `sha256:${digestObject(effect)}`,
      ref: binding.ref, branch: binding.branch,
    };
  }

  /**
   * The receipt for an operation that may already have published, read without writing anything.
   *
   * This is what an operator uses after a lost response: it reads the exact ref and lists pull
   * requests for that exact head, base, and operation marker. It sends no create of any kind, so
   * calling it can never produce a second effect. `null` means the remote shows no publication,
   * which keeps the operation uncertain rather than authorizing another send.
   */
  async lookupReceipt(operation: FactoryReleaseOperation, signal?: AbortSignal): Promise<FactoryProviderReceipt | null> {
    const binding = this.binding(operation);
    const { request } = this.plan(operation);
    if (await this.readRef(this.options.repository, binding, signal) !== request.commitSha) return null;
    const pull = await this.findPull(this.options.repository, binding, operation, request, signal);
    return pull ? this.receipt(operation, binding, request, pull) : null;
  }

  async verifyReceipt(operation: FactoryReleaseOperation, receipt: FactoryProviderReceipt, _evidence: unknown, signal?: AbortSignal): Promise<boolean> {
    const binding = this.binding(operation);
    const { request } = this.plan(operation);
    if (await this.readRef(this.options.repository, binding, signal) !== request.commitSha) return false;
    const number = Number(String(receipt.providerReceiptId).split(":").pop());
    if (!Number.isSafeInteger(number) || number < 1) return false;
    let pull: Record<string, unknown>;
    try { pull = this.assertPull(record(await this.call("GET", `/repos/${this.options.repository}/pulls/${number}`, undefined, signal)), binding, operation, request); }
    catch (error) { if (error instanceof ProjectGitHubHttpError && error.status === 404) return false; if (error instanceof FactoryGitHubError) return false; throw error; }
    return canonicalJson(this.receipt(operation, binding, request, pull)) === canonicalJson(receipt);
  }

  /**
   * No effect means both halves are absent: the ref does not exist and no pull request names it.
   *
   * The listing is read, never created from. A list that returns nothing after a lost POST proves
   * nothing on its own, which is why this also requires the ref to be absent: the ref is created
   * before the pull request, so an absent ref means the publication never got that far.
   */
  async proveNoEffect(operation: FactoryReleaseOperation, evidence: unknown, signal?: AbortSignal): Promise<boolean> {
    if (!evidence || typeof evidence !== "object" || (evidence as { operationId?: unknown }).operationId !== operation.operationId) return false;
    const binding = this.binding(operation);
    const { request } = this.plan(operation);
    if (await this.readRef(this.options.repository, binding, signal) !== null) return false;
    try { return (await this.findPull(this.options.repository, binding, operation, request, signal)) === null; }
    catch (error) { if (error instanceof FactoryGitHubError) return false; throw error; }
  }
}
