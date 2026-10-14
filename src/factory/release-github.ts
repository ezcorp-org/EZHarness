import { canonicalJson } from "@ezcorp/extension-contract";
import { digestObject } from "../extensions/v4/blobs";
import { ProjectGitHubHttpError, requestProjectGitHub } from "../extensions/project-github-transport";
import { assertFactoryGitSha, type FactoryGitIdentity } from "./git-objects";
import {
  FACTORY_GITHUB_OPERATION_MARKER,
  FactoryGitHubError,
  assertFactoryGitHubPublicationRequest,
  publicationPathAllowed as allowed,
  publicationRecord as record,
  type FactoryGitHubPublicationPlan,
  type FactoryGitHubPublicationRequest,
} from "./release-github-request";
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

export {
  FACTORY_GITHUB_LIMITS,
  FACTORY_GITHUB_OPERATION_MARKER,
  FACTORY_GITHUB_PUBLICATION_SCHEMA_VERSION,
  FactoryGitHubError,
  assertFactoryGitHubPublicationRequest,
  type FactoryGitHubErrorCode,
  type FactoryGitHubPublicationFile,
  type FactoryGitHubPublicationPlan,
  type FactoryGitHubPublicationRequest,
} from "./release-github-request";

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
