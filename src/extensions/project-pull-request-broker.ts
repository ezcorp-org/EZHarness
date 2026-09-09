import { realpath } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { canonicalJson, sha256 } from "@ezcorp/extension-contract";
import { getDb } from "../db/connection";
import { releaseRows, type ReleaseDatabase } from "../db/queries/extension-releases";
import { guardedFetch } from "../search/egress";
import { authorizeProjectOperation } from "./project-access";
import { getExtensionProjectBinding } from "./project-binding";
import { readProjectGit } from "./project-git-broker";
import { getPermissionEngine } from "./permission-engine";
import { getSecret } from "./secrets-store";
import { resolveReverseRpcMeta } from "./tool-executor/provenance";
import type { RpcHandlerDeps } from "./tool-executor/rpc-handlers";
import type { JsonRpcRequest, JsonRpcResponse } from "./types";
import { LifecycleError, type LifecycleActor } from "./v4/types";

interface ProjectScope { installationId: string; ownerId: string; projectId: string; bindingId: string }
interface ProjectAuthority { repository: string; selfProject: boolean; writePaths: string[] }
interface ProjectEffect { proposalId: string }
interface PullRequestSnapshot { head: string; base: string; nodeId: string; state: string; mergeable: string; draft: boolean; files: string[]; digest: string }
type ProjectDecision = "finalize" | "close" | "reject";
interface ProjectProposal extends ProjectScope { id: string; number: number; repository: string; merge: boolean; runId: string; snapshot: PullRequestSnapshot; createdAt: number; decision?: ProjectDecision; decidedBy?: string; decidedAt?: number; result?: { marked: "ready" | "merged" | "closed" } }
interface StoredProposal { state: "proposed" | "executing" | "completed" | "rejected" | "failed"; proposal: ProjectProposal }
interface ProjectPullRequestDependencies {
  database: ReleaseDatabase;
  authorize(scope: ProjectScope, effect?: ProjectEffect): Promise<ProjectAuthority>;
  request(scope: ProjectScope, path: string, method?: string, body?: unknown): Promise<unknown>;
  now?: () => number;
}

export class ProjectPullRequests {
  constructor(private readonly dependencies: ProjectPullRequestDependencies) {}
  private now() { return this.dependencies.now?.() ?? Date.now(); }
  private checkFiles(authority: ProjectAuthority, files: string[]) {
    if (!authority.writePaths.length || files.some(path => !authority.writePaths.some(prefix => prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix))) throw new LifecycleError("write_scope_denied", "The pull request changes files outside the human-approved project write scope.");
  }
  private async call(scope: ProjectScope, repository: string, path: string, method = "GET", body?: unknown): Promise<unknown> {
    const authority = await this.dependencies.authorize(scope, method === "GET" ? undefined : { proposalId: (scope as ProjectProposal).id });
    if (authority.repository !== repository) throw new LifecycleError("project_changed", "The project origin changed. Request a new review.");
    return this.dependencies.request(scope, path, method, body);
  }
  private async snapshot(scope: ProjectScope, repository: string, number: number): Promise<PullRequestSnapshot> {
    const deadline = this.now() + 60_000;
    const prefix = `/repos/${repository}/pulls/${number}`;
    const data = await this.call(scope, repository, prefix) as Record<string, unknown>;
    const head = (data?.head as { sha?: unknown })?.sha;
    const base = (data?.base as { sha?: unknown })?.sha;
    if (typeof head !== "string" || !/^[a-f0-9]{40}$/.test(head) || typeof base !== "string" || !/^[a-f0-9]{40}$/.test(base) || typeof data.node_id !== "string" || data.node_id.length > 256 || !["open", "closed"].includes(String(data.state))) throw new LifecycleError("invalid_provider_response", "GitHub returned invalid pull request metadata.");
    const files: string[] = [];
    for (let page = 1; page <= 30; page++) {
      if (this.now() >= deadline) throw new LifecycleError("read_timeout", "The GitHub review snapshot exceeded its time limit.");
      const values = await this.call(scope, repository, `${prefix}/files?per_page=100&page=${page}`);
      if (!Array.isArray(values) || values.length > 100) throw new LifecycleError("invalid_provider_response", "GitHub returned invalid file metadata.");
      for (const value of values) {
        for (const key of ["filename", "previous_filename"]) {
          const path = value?.[key];
          if (key === "previous_filename" && path === undefined) continue;
          if (typeof path !== "string" || path.length > 4096 || path.startsWith("/") || path.includes("\\") || /\p{Cc}/u.test(path) || path.split("/").some(part => part === ".." || part === "." || !part)) throw new LifecycleError("invalid_provider_response", "GitHub returned an unsafe file path.");
          files.push(path);
        }
      }
      if (values.length < 100) break;
      if (page === 30) throw new LifecycleError("file_limit", "This pull request has too many files for extension approval.");
    }
    files.sort();
    const snapshot = { head, base, nodeId: data.node_id, state: data.merged === true ? "MERGED" : String(data.state).toUpperCase(), mergeable: data.mergeable === true ? "MERGEABLE" : data.mergeable === false ? "CONFLICTING" : "UNKNOWN", draft: data.draft === true, files };
    return { ...snapshot, digest: await sha256(canonicalJson(snapshot)) };
  }
  async read(scope: ProjectScope, number: number): Promise<PullRequestSnapshot> {
    if (!Number.isSafeInteger(number) || number < 1) throw new LifecycleError("invalid_input", "Provide a positive pull request number.");
    const authority = await this.dependencies.authorize(scope);
    return this.snapshot(scope, authority.repository, number);
  }
  async propose(scope: ProjectScope, input: { number: number; merge: boolean; runId: string }) {
    if (typeof input.merge !== "boolean" || typeof input.runId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.runId)) throw new LifecycleError("invalid_input", "Provide the loop run and explicit merge choice.");
    const authority = await this.dependencies.authorize(scope);
    if (input.merge && authority.selfProject) throw new LifecycleError("self_merge_denied", "The harness project must be merged manually on GitHub.");
    if (!Number.isSafeInteger(input.number) || input.number < 1) throw new LifecycleError("invalid_input", "Provide a positive pull request number.");
    const snapshot = await this.snapshot(scope, authority.repository, input.number);
    this.checkFiles(authority, snapshot.files);
    if (snapshot.state !== "OPEN") throw new LifecycleError("pr_closed", "Only an open pull request can be proposed.");
    const proposal: ProjectProposal = { ...scope, ...input, id: crypto.randomUUID(), repository: authority.repository, snapshot, createdAt: this.now() };
    await this.dependencies.database.execute(sql`INSERT INTO extension_project_decisions(id, installation_id, state, payload) VALUES(${proposal.id}, ${scope.installationId}, 'proposed', ${JSON.stringify(proposal)})`);
    return { proposalId: proposal.id, reviewUrl: `/extensions/project-proposals/${proposal.id}`, head: snapshot.head, files: snapshot.files, state: snapshot.state };
  }
  private async stored(id: string): Promise<StoredProposal> {
    const row = releaseRows<{ state: StoredProposal["state"]; payload: string }>(await this.dependencies.database.execute(sql`SELECT state, payload FROM extension_project_decisions WHERE id = ${id}`))[0];
    if (!row) throw new LifecycleError("not_found", "Project proposal not found.");
    return { state: row.state, proposal: JSON.parse(row.payload) };
  }
  async inspect(actor: LifecycleActor, id: string): Promise<StoredProposal> {
    if (actor.kind !== "human") throw new LifecycleError("human_required", "A human session must review project changes.");
    const record = await this.stored(id);
    if (record.proposal.ownerId !== actor.principalId) throw new LifecycleError("not_found", "Project proposal not found.");
    await this.dependencies.authorize(record.proposal);
    return record;
  }
  async observe(scope: ProjectScope, id: string, action: "finalize" | "close") {
    const record = await this.stored(id);
    if (["installationId", "ownerId", "projectId", "bindingId"].some(key => record.proposal[key as keyof ProjectScope] !== scope[key as keyof ProjectScope])) throw new LifecycleError("not_found", "Project proposal not found.");
    await this.dependencies.authorize(scope);
    if (record.state === "completed" && record.proposal.decision !== action) throw new LifecycleError("decision_mismatch", "The human selected a different project action.");
    return { state: record.state === "proposed" || record.state === "executing" ? "pending" : record.state, action: record.proposal.decision, result: record.proposal.result };
  }
  async decide(actor: LifecycleActor, id: string, decision: ProjectDecision, expectedDigest: string) {
    if (!["finalize", "close", "reject"].includes(decision)) throw new LifecycleError("invalid_input", "Choose finalize, close or reject.");
    const record = await this.inspect(actor, id);
    const proposal = record.proposal;
    if (proposal.snapshot.digest !== expectedDigest || this.now() - proposal.createdAt > 24 * 60 * 60 * 1000) throw new LifecycleError("stale_proposal", "The review is stale. Request a new proposal.");
    if (record.state !== "proposed") {
      if (proposal.decision === decision && ["completed", "rejected"].includes(record.state)) return record;
      throw new LifecycleError("already_decided", "This proposal has already been decided. Verify any partial GitHub effects manually.");
    }
    proposal.decision = decision; proposal.decidedBy = actor.principalId; proposal.decidedAt = this.now();
    const claimed = releaseRows(await this.dependencies.database.execute(sql`UPDATE extension_project_decisions SET state = ${decision === "reject" ? "rejected" : "executing"}, payload = ${JSON.stringify(proposal)} WHERE id = ${id} AND state = 'proposed' RETURNING id`));
    if (claimed.length !== 1) throw new LifecycleError("already_decided", "This proposal has already been decided.");
    if (decision === "reject") return this.stored(id);
    try {
      const current = await this.snapshot(proposal, proposal.repository, proposal.number);
      if (current.digest !== expectedDigest) throw new LifecycleError("pr_changed", "The pull request changed after review. Request a new proposal.");
      this.checkFiles(await this.dependencies.authorize(proposal), current.files);
      const prefix = `/repos/${proposal.repository}`;
      if (decision === "close") {
        const closed = await this.call(proposal, proposal.repository, `${prefix}/pulls/${proposal.number}`, "PATCH", { state: "closed" }) as { state?: unknown };
        if (closed?.state !== "closed") throw new LifecycleError("close_failed", "GitHub did not confirm the pull request closure.");
        proposal.result = { marked: "closed" };
      } else {
        const authority = await this.dependencies.authorize(proposal);
        if (proposal.merge && authority.selfProject) throw new LifecycleError("self_merge_denied", "The harness project cannot be merged by extensions.");
        if (current.mergeable !== "MERGEABLE") throw new LifecycleError("not_mergeable", "GitHub has not confirmed that the pull request can be merged.");
        if (current.draft) {
          const ready = await this.call(proposal, proposal.repository, "/graphql", "POST", { query: "mutation Ready($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id}}}", variables: { id: current.nodeId } }) as { data?: { markPullRequestReadyForReview?: { pullRequest?: { id?: unknown } } } };
          if (ready?.data?.markPullRequestReadyForReview?.pullRequest?.id !== current.nodeId) throw new LifecycleError("ready_failed", "GitHub did not confirm that the pull request is ready.");
        }
        const comment = await this.call(proposal, proposal.repository, `${prefix}/issues/${proposal.number}/comments`, "POST", { body: "Approved via docs-updater." }) as { id?: unknown };
        if (typeof comment?.id !== "number" || !Number.isSafeInteger(comment.id) || comment.id < 1) throw new LifecycleError("comment_failed", "GitHub did not confirm the approval comment.");
        if (proposal.merge) {
          const merged = await this.call(proposal, proposal.repository, `${prefix}/pulls/${proposal.number}/merge`, "PUT", { sha: current.head, merge_method: "squash" }) as { merged?: unknown };
          if (merged?.merged !== true) throw new LifecycleError("merge_failed", "GitHub did not confirm the merge.");
        }
        proposal.result = { marked: proposal.merge ? "merged" : "ready" };
      }
      await this.dependencies.database.execute(sql`UPDATE extension_project_decisions SET state = 'completed', payload = ${JSON.stringify(proposal)} WHERE id = ${id} AND state = 'executing'`);
      return this.stored(id);
    } catch (cause) {
      await this.dependencies.database.execute(sql`UPDATE extension_project_decisions SET state = 'failed' WHERE id = ${id} AND state = 'executing'`);
      throw cause instanceof LifecycleError ? cause : new LifecycleError("project_effect_failed", "The GitHub operation failed. Verify partial effects manually; it will not be retried.");
    }
  }
}

export function getProjectPullRequests(deps: Pick<RpcHandlerDeps, "engine"> = { engine: getPermissionEngine() }): ProjectPullRequests {
  async function authorize(scope: ProjectScope, effect?: ProjectEffect): Promise<ProjectAuthority> {
    const binding = await getExtensionProjectBinding(scope.installationId);
    if (!binding || binding.id !== scope.bindingId || binding.projectId !== scope.projectId || binding.ownerId !== scope.ownerId) throw new LifecycleError("binding_required", "Approve a current project binding before using GitHub operations.");
    const { project } = await authorizeProjectOperation(deps, scope.installationId, scope.ownerId, null, effect ? "project.pullRequest.write" : "project.pullRequest", [{ kind: "shell" }, { kind: "network", value: "api.github.com" }], scope.projectId, scope.bindingId, effect?.proposalId);
    const origin = await readProjectGit(project.path!, "origin");
    if (typeof origin !== "string") throw new LifecycleError("github_origin_required", "The bound project requires an exact GitHub origin.");
    const { getProjectRoot } = await import("./project-root");
    return { repository: origin.slice("https://github.com/".length), selfProject: project.id === "self" || await realpath(project.path!) === await realpath(getProjectRoot()), writePaths: binding.writePaths ?? [] };
  }
  return new ProjectPullRequests({ database: getDb(), authorize, request: async (scope, path, method = "GET", body) => {
    const effect = method === "GET" ? undefined : { proposalId: (scope as ProjectProposal).id };
    if (effect && !effect.proposalId) throw new LifecycleError("human_required", "GitHub writes require a recorded human decision.");
    await authorize(scope, effect);
    const token = await getSecret("github-projects", scope.projectId, "apiToken");
    if (!token) throw new LifecycleError("credential_required", "Configure the host-owned GitHub credential for this project.");
    const response = await guardedFetch(`https://api.github.com${path}`, { method, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "x-github-api-version": "2022-11-28" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, { mode: "backend", allowedHosts: ["api.github.com"], maxRedirects: 0, maxBodyBytes: 2 * 1024 * 1024, timeoutMs: 15_000, retryConnectionFailures: false, authorizeUrl: async () => { await authorize(scope, effect); } });
    if (!response.ok) throw new LifecycleError("github_failed", `GitHub returned HTTP ${response.status}.`);
    const value = await response.json();
    if (value && typeof value === "object" && "errors" in value) throw new LifecycleError("github_failed", "GitHub rejected the requested operation.");
    return value;
  } });
}

export async function handleProjectPullRequestReview(deps: RpcHandlerDeps, extensionId: string, request: JsonRpcRequest): Promise<JsonRpcResponse> {
  const resolved = resolveReverseRpcMeta(extensionId, request);
  if (!resolved.ok) return resolved.errorResponse;
  try {
    const binding = await getExtensionProjectBinding(extensionId);
    if (!binding || binding.ownerId !== resolved.onBehalfOf || resolved.prov.projectId && (resolved.prov.projectId !== binding.projectId || resolved.prov.projectBindingId !== binding.id)) throw new LifecycleError("binding_required", "A human must bind this release to a project before GitHub review.");
    const scope = { installationId: extensionId, ownerId: resolved.onBehalfOf, projectId: binding.projectId, bindingId: binding.id };
    const input = request.params as Record<string, unknown>;
    const service = getProjectPullRequests(deps);
    let result: unknown;
    if (input.action === "files" || input.action === "status") {
      const snapshot = await service.read(scope, input.number as number);
      result = input.action === "files" ? { files: snapshot.files, unavailable: false } : { state: snapshot.state, mergeable: snapshot.mergeable, unavailable: false };
    } else if (input.action === "propose") result = await service.propose(scope, { number: input.number as number, merge: input.merge as boolean, runId: input.runId as string });
    else if ((input.action === "finalize" || input.action === "close") && typeof input.proposalId === "string") result = await service.observe(scope, input.proposalId, input.action);
    else throw new LifecycleError("invalid_input", "Use a fixed GitHub read, proposal or result operation.");
    return { jsonrpc: "2.0", id: request.id, result };
  } catch (cause) { return { jsonrpc: "2.0", id: request.id, error: { code: -32603, message: cause instanceof LifecycleError ? cause.message : "GitHub project operation failed." } }; }
}
