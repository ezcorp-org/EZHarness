import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { canonicalJson } from "@ezcorp/extension-contract";
import { getDb, type DbTransaction } from "../../db/connection";
import { getSandboxController } from "../../runtime/sandbox/controller";
import { assertUserEffectCurrent, checkRepository, getConnectionBinding, withUserToken, withUserTokenReadOnly } from "../github-user/broker";
import { githubApi, githubApiRequest, GithubUserError } from "../github-user/transport";
import { fetchApprovedBase } from "./github-source";
import { exportSnapshotFromSandbox, importSnapshotToSandbox } from "./provider-transfer";
import { validateSnapshot, type SnapshotFileInput, type ValidatedSnapshot } from "./snapshot";
import { buildReviewDiff, type ReviewFile } from "./review-diff";
import { publishFrozenDraft, reconcileFrozenDraft, PrPublisherError, type PublishedPr } from "./publisher";

export class PersonalPrError extends Error {
  constructor(public readonly code: "invalid_input" | "not_found" | "forbidden" | "conflict" | "unavailable", message: string) {
    super(message);
    this.name = "PersonalPrError";
  }
}

export type PersonalPrState = "working" | "ready" | "reviewing" | "creating" | "created" | "no_changes" | "blocked" | "stale" | "failed";
export interface PersonalPrView {
  state: PersonalPrState;
  projectId?: string;
  importState?: "ready" | "failed" | "unknown";
  proposalId?: string;
  digest?: string;
  repository?: { id: number; fullName: string; baseRef: string; baseSha: string };
  files?: ReviewFile[];
  checks?: { name: string; result: string }[];
  title?: string;
  body?: string;
  prUrl?: string;
  blockReason?: string;
  recoveryAction?: "retry_pre_ref" | "check_github" | "reimport";
  reviewPath?: string;
}

interface Row { [key: string]: unknown }
function rows(value: unknown): Row[] { return (value as { rows?: Row[] }).rows ?? []; }
function parse<T>(value: unknown): T { return typeof value === "string" ? JSON.parse(value) as T : value as T; }
function files(snapshot: ValidatedSnapshot): SnapshotFileInput[] { return snapshot.files.map(file => ({ path: file.path, mode: file.mode, data: Buffer.from(file.bytes).toString("base64"), sha256: file.sha256 })); }
function sha(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function validId(value: string): boolean { return /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function latestRunQuery(run: Row, userId: string) {
  return sql`SELECT id,status,started_at,created_at FROM runs WHERE project_id=${run.project_id} AND conversation_id=${run.conversation_id} AND user_id=${userId} ORDER BY started_at DESC,created_at DESC LIMIT 2`;
}
function activeRunQuery(run: Row, userId: string) {
  return sql`SELECT id FROM runs WHERE project_id=${run.project_id} AND conversation_id=${run.conversation_id} AND user_id=${userId} AND id<>${run.run_id ?? run.id} AND finished_at IS NULL LIMIT 1`;
}
function isUniqueLatestRun(runId: string, latest: Row[], active: Row[]): boolean {
  const first = latest[0];
  if (!first || first.id !== runId || first.status !== "success" || active.length) return false;
  const second = latest[1];
  return !second || new Date(String(first.started_at)).getTime() !== new Date(String(second.started_at)).getTime() || new Date(String(first.created_at)).getTime() !== new Date(String(second.created_at)).getTime();
}

async function eligibleRun(userId: string, runId: string): Promise<{ run: Row; projectId: string; source: Row; status: Awaited<ReturnType<ReturnType<typeof getSandboxController>["getProjectSandboxStatus"]>> }> {
  const [run] = rows(await getDb().execute(sql`SELECT id,project_id,conversation_id,user_id,status,finished_at FROM runs WHERE id=${runId}`));
  if (!run || run.user_id !== userId || !run.project_id || !run.conversation_id) throw new PersonalPrError("not_found", "Run not found");
  if (run.status !== "success" || !run.finished_at) throw new PersonalPrError("conflict", "The run has not completed successfully");
  const latest = rows(await getDb().execute(latestRunQuery(run, userId)));
  const active = rows(await getDb().execute(activeRunQuery(run, userId)));
  if (!isUniqueLatestRun(runId, latest, active)) throw new PersonalPrError("conflict", "Review the latest completed run in this conversation");
  const projectId = String(run.project_id);
  const [source] = rows(await getDb().execute(sql`SELECT * FROM github_personal_pr_imports WHERE project_id=${projectId} AND owner_id=${userId} AND state='ready'`));
  if (!source) throw new PersonalPrError("conflict", "No ready imported repository for this run");
  const status = await getSandboxController().getProjectSandboxStatus(userId, projectId);
  if (!status.privateOwnerOnly || status.initializationState !== "ready" || status.privateConversationId !== run.conversation_id || !status.resource) throw new PersonalPrError("forbidden", "Run is not in your private sandbox conversation");
  if (source.binding_id !== status.bindingId || Number(source.provider_generation) !== status.provider.generation || source.resource_id !== status.resource.resourceId) throw new PersonalPrError("conflict", "Imported repository or sandbox changed");
  return { run, projectId, source, status };
}

export async function importApprovedRepository(userId: string, input: { projectId: string; repositoryId: number; baseRef: string; idempotencyKey: string }): Promise<PersonalPrView> {
  if (!validId(input.projectId) || !validId(input.idempotencyKey) || !Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0) throw new PersonalPrError("invalid_input", "Invalid repository import request");
  const [existing] = rows(await getDb().execute(sql`SELECT repository_id,repository_name,base_ref,base_sha,state,idempotency_key FROM github_personal_pr_imports WHERE owner_id=${userId} AND project_id=${input.projectId}`));
  if (existing) {
    if (existing.idempotency_key !== input.idempotencyKey || Number(existing.repository_id) !== input.repositoryId || existing.base_ref !== input.baseRef) throw new PersonalPrError("conflict", "This private sandbox has a different import");
    if (existing.state === "ready") return { state: "working", projectId: input.projectId, importState: "ready", repository: { id: input.repositoryId, fullName: String(existing.repository_name), baseRef: String(existing.base_ref), baseSha: String(existing.base_sha) } };
    throw new PersonalPrError("conflict", "Repository import is incomplete; use a new private sandbox if it failed");
  }
  const controller = getSandboxController();
  const initial = await controller.getProjectSandboxStatus(userId, input.projectId);
  if (!initial.privateOwnerOnly || initial.initializationState !== "pending" || initial.operation?.action !== "create" || initial.operation.state !== "admitted") throw new PersonalPrError("conflict", "This sandbox cannot import a repository");
  const repository = await checkRepository({ userId, repositoryId: input.repositoryId });
  if (repository.status !== "ready" || !repository.repository) return { state: "blocked", projectId: input.projectId, blockReason: repository.status };
  const operationId = randomUUID();
  const approved = await withUserToken({ userId, repositoryId: input.repositoryId, kind: "import", operationId }, token => fetchApprovedBase({ repositoryId: input.repositoryId, fullName: repository.repository!.fullName, baseRef: input.baseRef, token }, (path, credential) => githubApi(credential, path)));
  const current = await controller.getProjectSandboxStatus(userId, input.projectId);
  if (current.bindingId !== initial.bindingId || current.provider.generation !== initial.provider.generation || current.initializationState !== "pending") throw new PersonalPrError("conflict", "Sandbox binding changed during repository import");
  const [workspace] = rows(await getDb().execute(sql`SELECT revision FROM project_workspace_bindings WHERE project_id=${input.projectId} AND binding_id=${current.bindingId}`));
  if (!workspace) throw new PersonalPrError("conflict", "Sandbox workspace binding is unavailable");
  const importId = randomUUID();
  const artifact = files(approved.snapshot);
  await getDb().execute(sql`INSERT INTO github_personal_pr_imports (id,owner_id,project_id,binding_id,workspace_revision,provider_generation,repository_id,repository_name,base_ref,base_sha,base_digest,state,operation_id,idempotency_key,artifact) VALUES (${importId},${userId},${input.projectId},${current.bindingId},${Number(workspace.revision)},${current.provider.generation},${input.repositoryId},${approved.fullName},${approved.baseRef},${approved.baseSha},${approved.snapshot.digest},'importing',${operationId},${input.idempotencyKey},${JSON.stringify(artifact)})`);
  try {
    await controller.runPrivateWorkspaceImport(userId, input.projectId, operationId, async () => {
      const created = await controller.executeAdmittedLocalSandboxOperation(userId, initial.operation!.id);
      if (created.resource?.observedState !== "stopped" || created.bindingId !== current.bindingId) throw new PersonalPrError("unavailable", "Private sandbox could not be created");
      await importSnapshotToSandbox(controller, userId, input.projectId, approved.snapshot);
      const updated = rows(await getDb().execute(sql`UPDATE github_personal_pr_imports SET resource_id=${created.resource.resourceId},state='ready',completed_at=NOW() WHERE id=${importId} AND owner_id=${userId} AND binding_id=${current.bindingId} AND state='importing' RETURNING id`))[0];
      if (!updated) throw new PersonalPrError("conflict", "Repository import state changed");
    });
  } catch (error) {
    await getDb().execute(sql`UPDATE github_personal_pr_imports SET state='failed',completed_at=NOW() WHERE id=${importId} AND state='importing'`);
    throw error;
  }
  return { state: "working", projectId: input.projectId, importState: "ready", repository: { id: approved.repositoryId, fullName: approved.fullName, baseRef: approved.baseRef, baseSha: approved.baseSha } };
}

export async function preparePersonalPr(userId: string, input: { runId: string; title?: string; body?: string }): Promise<PersonalPrView> {
  if (!validId(input.runId)) throw new PersonalPrError("invalid_input", "Invalid run");
  const { run, projectId, source, status: initial } = await eligibleRun(userId, input.runId);
  const [existing] = rows(await getDb().execute(sql`SELECT proposal.id FROM github_personal_pr_proposals proposal JOIN github_personal_pr_snapshots snapshot ON snapshot.id=proposal.snapshot_id WHERE snapshot.run_id=${input.runId} AND proposal.owner_id=${userId}`));
  if (existing) return getPersonalPrForReviewId(userId, String(existing.id));
  const controller = getSandboxController();
  let status = initial;
  if (status.resource?.observedState === "running") {
    const stop = await controller.requestSandboxAction(userId, projectId, { action: "stop", idempotencyKey: randomUUID() });
    status = await controller.executeAdmittedLocalSandboxOperation(userId, stop.id);
  }
  if (status.resource?.observedState !== "stopped") throw new PersonalPrError("unavailable", "Sandbox must stop before review");
  if (source.binding_id !== status.bindingId || Number(source.provider_generation) !== status.provider.generation || source.resource_id !== status.resource.resourceId) throw new PersonalPrError("conflict", "Imported repository or sandbox changed");
  const [workspace] = rows(await getDb().execute(sql`SELECT revision FROM project_workspace_bindings WHERE project_id=${projectId} AND binding_id=${status.bindingId}`));
  if (!workspace || Number(workspace.revision) !== Number(source.workspace_revision)) throw new PersonalPrError("conflict", "Workspace revision changed");
  const base = validateSnapshot(parse<SnapshotFileInput[]>(source.artifact));
  if (base.digest !== source.base_digest) throw new PersonalPrError("conflict", "Imported base artifact changed");
  const snapshot = await exportSnapshotFromSandbox(controller, userId, projectId, String(run.conversation_id));
  const afterExport = await eligibleRun(userId, input.runId);
  if (afterExport.status.bindingId !== status.bindingId || afterExport.status.resource?.resourceId !== status.resource.resourceId || afterExport.status.resource?.observedState !== "stopped" || afterExport.source.id !== source.id) throw new PersonalPrError("conflict", "Private sandbox changed during review");
  const changes = await buildReviewDiff(base, snapshot);
  if (!changes.length) return { state: "no_changes", projectId };
  const connection = await getConnectionBinding({ userId });
  const title = (input.title ?? "Changes from EZHarness").trim();
  const body = input.body ?? "";
  if (!title || title.length > 500 || body.length > 100_000) throw new PersonalPrError("invalid_input", "Invalid pull request title or body");
  const snapshotId = randomUUID(); const proposalId = randomUUID(); const operationId = randomUUID();
  const branch = `ez-personal/${operationId}`;
  const proposalDigest = sha({ ownerId: userId, conversationId: run.conversation_id, runId: input.runId, projectId, bindingId: status.bindingId, workspaceRevision: Number(workspace.revision), providerGeneration: status.provider.generation, resourceId: status.resource.resourceId, repositoryId: Number(source.repository_id), baseRef: source.base_ref, baseSha: source.base_sha, baseDigest: source.base_digest, importId: source.id, snapshotId, treeDigest: snapshot.digest, connectionGeneration: connection.generation, githubAccountId: connection.githubAccountId, operationId, branch, title, body });
  await getDb().transaction(async (tx: DbTransaction) => {
    await tx.execute(sql`INSERT INTO github_personal_pr_snapshots (id,import_id,owner_id,project_id,conversation_id,run_id,binding_id,workspace_revision,provider_generation,resource_id,repository_id,base_sha,tree_digest,artifact,checks) VALUES (${snapshotId},${source.id},${userId},${projectId},${run.conversation_id},${input.runId},${status.bindingId},${Number(workspace.revision)},${status.provider.generation},${status.resource!.resourceId},${Number(source.repository_id)},${source.base_sha},${snapshot.digest},${JSON.stringify(files(snapshot))},${JSON.stringify([])})`);
    await tx.execute(sql`INSERT INTO github_personal_pr_proposals (id,snapshot_id,owner_id,github_account_id,connection_generation,repository_id,base_sha,title,body,digest,state,operation_id,branch,expires_at) VALUES (${proposalId},${snapshotId},${userId},${connection.githubAccountId},${connection.generation},${Number(source.repository_id)},${source.base_sha},${title},${body},${proposalDigest},'ready',${operationId},${branch},NOW() + INTERVAL '24 hours')`);
  });
  return { state: "ready", projectId, proposalId, digest: proposalDigest, repository: { id: Number(source.repository_id), fullName: String(source.repository_name), baseRef: String(source.base_ref), baseSha: String(source.base_sha) }, files: changes, checks: [], title, body, reviewPath: `/project/${projectId}/chat/${run.conversation_id}?review=${proposalId}` };
}

export async function getPersonalPrForReviewId(userId: string, proposalId: string): Promise<PersonalPrView> {
  if (!validId(proposalId)) throw new PersonalPrError("not_found", "Review not found");
  const [row] = rows(await getDb().execute(sql`SELECT proposal.*,snapshot.conversation_id,snapshot.run_id,snapshot.project_id,snapshot.artifact AS snapshot_artifact,source.repository_name,source.base_ref,source.artifact AS base_artifact FROM github_personal_pr_proposals proposal JOIN github_personal_pr_snapshots snapshot ON snapshot.id=proposal.snapshot_id JOIN github_personal_pr_imports source ON source.id=snapshot.import_id WHERE proposal.id=${proposalId} AND proposal.owner_id=${userId}`));
  if (!row) throw new PersonalPrError("not_found", "Review not found");
  const base = validateSnapshot(parse<SnapshotFileInput[]>(row.base_artifact));
  const current = validateSnapshot(parse<SnapshotFileInput[]>(row.snapshot_artifact));
  return { state: row.state as PersonalPrState, projectId: String(row.project_id), proposalId, digest: String(row.digest), repository: { id: Number(row.repository_id), fullName: String(row.repository_name), baseRef: String(row.base_ref), baseSha: String(row.base_sha) }, files: await buildReviewDiff(base, current), checks: [], title: String(row.title), body: String(row.body), ...(row.pr_url ? { prUrl: String(row.pr_url) } : {}), ...(row.failure_code ? { blockReason: String(row.failure_code) } : {}), ...(row.state === "failed" && !row.commit_sha ? { recoveryAction: "retry_pre_ref" as const } : row.state === "failed" || row.state === "creating" ? { recoveryAction: "check_github" as const } : row.state === "stale" ? { recoveryAction: "reimport" as const } : {}), reviewPath: `/project/${row.project_id}/chat/${row.conversation_id}?review=${proposalId}` };
}

export async function getPersonalPrForRun(userId: string, runId: string): Promise<PersonalPrView> {
  if (!validId(runId)) throw new PersonalPrError("not_found", "Run not found");
  const [row] = rows(await getDb().execute(sql`SELECT proposal.id FROM github_personal_pr_proposals proposal JOIN github_personal_pr_snapshots snapshot ON snapshot.id=proposal.snapshot_id WHERE snapshot.run_id=${runId} AND proposal.owner_id=${userId}`));
  if (row) return getPersonalPrForReviewId(userId, String(row.id));
  const [run] = rows(await getDb().execute(sql`SELECT user_id,project_id FROM runs WHERE id=${runId}`));
  if (!run || run.user_id !== userId) throw new PersonalPrError("not_found", "Run not found");
  try {
    const eligible = await eligibleRun(userId, runId);
    return { state: "working", projectId: eligible.projectId, blockReason: "review_not_prepared" };
  } catch (error) {
    if (!(error instanceof PersonalPrError)) throw error;
    return { state: "no_changes", projectId: String(run.project_id) };
  }
}

function proposalDigest(row: Row, title: string, body: string): string {
  return sha({ ownerId: row.owner_id, conversationId: row.conversation_id, runId: row.run_id, projectId: row.project_id,
    bindingId: row.binding_id, workspaceRevision: Number(row.workspace_revision), providerGeneration: Number(row.provider_generation),
    resourceId: row.resource_id, repositoryId: Number(row.repository_id), baseRef: row.base_ref, baseSha: row.base_sha,
    baseDigest: row.base_digest, importId: row.import_id, snapshotId: row.artifact_id, treeDigest: row.tree_digest, connectionGeneration: Number(row.connection_generation),
    githubAccountId: Number(row.github_account_id), operationId: row.operation_id, branch: row.branch, title, body });
}

async function resetPreRefFailure(userId: string, row: Row, expectedDigest: string): Promise<string> {
  if (row.digest !== expectedDigest || row.commit_sha) throw new PersonalPrError("conflict", "Reload the review before retrying publication");
  const operationId = randomUUID();
  const branch = `ez-personal/${operationId}`;
  const digest = proposalDigest({ ...row, operation_id: operationId, branch }, String(row.title), String(row.body));
  const updated = rows(await getDb().execute(sql`UPDATE github_personal_pr_proposals SET state='ready',operation_id=${operationId},branch=${branch},digest=${digest},failure_code=NULL,dispatched_at=NULL,completed_at=NULL WHERE id=${row.id} AND owner_id=${userId} AND state='failed' AND commit_sha IS NULL AND digest=${expectedDigest} RETURNING id`));
  if (!updated.length) throw new PersonalPrError("conflict", "Publication recovery changed. Reload the review");
  return digest;
}

async function proposalRow(userId: string, proposalId: string): Promise<Row> {
  const [row] = rows(await getDb().execute(sql`SELECT proposal.*,snapshot.id AS artifact_id,snapshot.import_id,snapshot.owner_id AS snapshot_owner_id,snapshot.project_id,snapshot.conversation_id,snapshot.run_id,snapshot.binding_id,snapshot.workspace_revision,snapshot.provider_generation,snapshot.resource_id,snapshot.tree_digest,snapshot.artifact AS snapshot_artifact,source.repository_name,source.base_ref,source.base_digest,source.artifact AS base_artifact,source.state AS import_state FROM github_personal_pr_proposals proposal JOIN github_personal_pr_snapshots snapshot ON snapshot.id=proposal.snapshot_id JOIN github_personal_pr_imports source ON source.id=snapshot.import_id WHERE proposal.id=${proposalId} AND proposal.owner_id=${userId}`));
  if (!row) throw new PersonalPrError("not_found", "Review not found");
  return row;
}

function verifiedArtifacts(row: Row): { base: ValidatedSnapshot; current: ValidatedSnapshot } {
  const base = validateSnapshot(parse<SnapshotFileInput[]>(row.base_artifact));
  const current = validateSnapshot(parse<SnapshotFileInput[]>(row.snapshot_artifact));
  if (base.digest !== row.base_digest || current.digest !== row.tree_digest) throw new PersonalPrError("conflict", "Reviewed files changed");
  return { base, current };
}

type ConfirmationInput = { proposalId: string; expectedDigest: string; title?: string; body?: string };

async function reviewForPublication(userId: string, input: ConfirmationInput, row: Row): Promise<{ title: string; body: string; artifacts: ReturnType<typeof verifiedArtifacts> }> {
  if (row.state !== "ready" || row.digest !== input.expectedDigest || row.import_state !== "ready") throw new PersonalPrError("conflict", "Review changed. Prepare a new review");
  const title = (input.title ?? String(row.title)).trim();
  const body = input.body ?? String(row.body);
  if (!title || title.length > 500 || body.length > 100_000) throw new PersonalPrError("invalid_input", "Invalid pull request title or body");
  if (proposalDigest(row, String(row.title), String(row.body)) !== row.digest) throw new PersonalPrError("conflict", "Review identity changed");
  const artifacts = verifiedArtifacts(row);
  const status = await getSandboxController().getProjectSandboxStatus(userId, String(row.project_id));
  if (!status.privateOwnerOnly || status.initializationState !== "ready" || status.privateConversationId !== row.conversation_id ||
      status.bindingId !== row.binding_id || status.provider.generation !== Number(row.provider_generation) ||
      status.resource?.resourceId !== row.resource_id || status.resource?.observedState !== "stopped") throw new PersonalPrError("conflict", "Private sandbox changed after review");
  return { title, body, artifacts };
}

function assertLivePublication(live: Row | undefined, row: Row, userId: string, expectedDigest: string, treeDigest: string): void {
  if (live?.state !== "ready" || live.digest !== expectedDigest || new Date(String(live.expires_at)).getTime() <= Date.now() || live.owner_id !== userId || live.private_owner_id !== userId || live.private_conversation_id !== live.conversation_id || live.private_initialization_state !== "ready" || live.import_state !== "ready" || live.run_status !== "success" || !live.finished_at || Number(live.live_revision) !== Number(live.workspace_revision) || live.binding_id !== row.binding_id || Number(live.provider_generation) !== Number(row.provider_generation) || live.provider_resource_id !== live.resource_id || live.observed_state !== "stopped" || live.tree_digest !== treeDigest) throw new PersonalPrError("conflict", "Review changed before publication");
}

async function claimPublication(tx: DbTransaction, userId: string, input: ConfirmationInput, row: Row, title: string, body: string, nextDigest: string, treeDigest: string): Promise<void> {
  const [live] = rows(await tx.execute(sql`SELECT proposal.state,proposal.digest,proposal.expires_at,snapshot.owner_id,snapshot.conversation_id,snapshot.run_id,snapshot.binding_id,snapshot.workspace_revision,snapshot.provider_generation,snapshot.resource_id,snapshot.tree_digest,source.state AS import_state,workspace.revision AS live_revision,binding.private_owner_id,binding.private_conversation_id,binding.private_initialization_state,resource.provider_resource_id,resource.observed_state,run.status AS run_status,run.finished_at FROM github_personal_pr_proposals proposal JOIN github_personal_pr_snapshots snapshot ON snapshot.id=proposal.snapshot_id JOIN github_personal_pr_imports source ON source.id=snapshot.import_id JOIN project_workspace_bindings workspace ON workspace.project_id=snapshot.project_id AND workspace.binding_id=snapshot.binding_id JOIN sandbox_provider_bindings binding ON binding.id=snapshot.binding_id JOIN sandbox_resources resource ON resource.binding_id=binding.id JOIN runs run ON run.id=snapshot.run_id WHERE proposal.id=${input.proposalId} AND proposal.owner_id=${userId} FOR UPDATE OF proposal`));
  assertLivePublication(live, row, userId, input.expectedDigest, treeDigest);
  const latest = rows(await tx.execute(latestRunQuery(row, userId)));
  const active = rows(await tx.execute(activeRunQuery(row, userId)));
  if (!isUniqueLatestRun(String(row.run_id), latest, active)) throw new PersonalPrError("conflict", "A newer run needs a new review");
  const updated = rows(await tx.execute(sql`UPDATE github_personal_pr_proposals SET state='creating',title=${title},body=${body},digest=${nextDigest},dispatched_at=NOW() WHERE id=${input.proposalId} AND owner_id=${userId} AND state='ready' AND digest=${input.expectedDigest} RETURNING id`));
  if (!updated.length) throw new PersonalPrError("conflict", "Review was already confirmed");
}

async function reconcileProposal(userId: string, row: Row): Promise<PersonalPrView> {
  if (!row.commit_sha) throw new PersonalPrError("conflict", "Publication outcome is uncertain. Check GitHub before another attempt");
  let published: PublishedPr | null;
  try {
    published = await withUserTokenReadOnly({ userId, repositoryId: Number(row.repository_id), expectedAccountId: Number(row.github_account_id) }, token =>
      reconcileFrozenDraft({ token, repositoryId: Number(row.repository_id), repositoryName: String(row.repository_name), baseRef: String(row.base_ref), branch: String(row.branch), commitSha: String(row.commit_sha) }, githubApiRequest));
  } catch (error) {
    if (error instanceof GithubUserError && error.code === "GITHUB_404") throw new PersonalPrError("conflict", "Publication outcome is uncertain. Check GitHub before another attempt");
    throw error;
  }
  if (!published) throw new PersonalPrError("conflict", "The branch exists, but no matching draft pull request was found. Check GitHub before another attempt");
  await getDb().execute(sql`UPDATE github_personal_pr_proposals SET state='created',pr_url=${published.url},completed_at=NOW() WHERE id=${row.id} AND owner_id=${userId} AND commit_sha=${published.commitSha} AND state IN ('creating','failed')`);
  return getPersonalPrForReviewId(userId, String(row.id));
}

/** Final host-only confirmation. The broker claims this operation under the connection generation lock. */
export async function confirmPersonalPr(userId: string, input: ConfirmationInput): Promise<PersonalPrView> {
  if (!validId(input.proposalId) || !/^[a-f0-9]{64}$/.test(input.expectedDigest)) throw new PersonalPrError("invalid_input", "Invalid review confirmation");
  const row = await proposalRow(userId, input.proposalId);
  if (row.state === "created") return getPersonalPrForReviewId(userId, input.proposalId);
  if (row.state === "failed" && !row.commit_sha) {
    const digest = await resetPreRefFailure(userId, row, input.expectedDigest);
    return confirmPersonalPr(userId, { ...input, expectedDigest: digest });
  }
  if (row.state === "creating" || row.state === "failed") return reconcileProposal(userId, row);
  if (row.state === "stale") throw new PersonalPrError("conflict", "Base changed. Import its current version into a new private sandbox for a new review");
  const { title, body, artifacts } = await reviewForPublication(userId, input, row);
  const nextDigest = proposalDigest(row, title, body);
  try {
    const result = await withUserToken({ userId, repositoryId: Number(row.repository_id), kind: "publish", operationId: String(row.operation_id), expectedGeneration: Number(row.connection_generation),
      authorizeDispatch: tx => claimPublication(tx, userId, input, row, title, body, nextDigest, artifacts.current.digest),
    }, token => publishFrozenDraft({ token, repositoryId: Number(row.repository_id), repositoryName: String(row.repository_name), baseRef: String(row.base_ref), baseSha: String(row.base_sha), branch: String(row.branch), title, body,
      base: artifacts.base, current: artifacts.current,
      onCommitReady: async commitSha => {
        const updated = rows(await getDb().execute(sql`UPDATE github_personal_pr_proposals SET commit_sha=${commitSha} WHERE id=${input.proposalId} AND owner_id=${userId} AND state='creating' AND operation_id=${row.operation_id} AND commit_sha IS NULL RETURNING id`));
        if (!updated.length) throw new PersonalPrError("conflict", "Publication claim changed");
      },
    }, async (credential, path, method, body) => {
      await assertUserEffectCurrent({ userId, operationId: String(row.operation_id), repositoryId: Number(row.repository_id), expectedGeneration: Number(row.connection_generation) });
      return githubApiRequest(credential, path, method, body);
    }));
    await getDb().execute(sql`UPDATE github_personal_pr_proposals SET state='created',pr_url=${result.url},completed_at=NOW() WHERE id=${input.proposalId} AND owner_id=${userId} AND state='creating' AND commit_sha=${result.commitSha}`);
    return getPersonalPrForReviewId(userId, input.proposalId);
  } catch (error) {
    const [after] = rows(await getDb().execute(sql`SELECT state,commit_sha FROM github_personal_pr_proposals WHERE id=${input.proposalId} AND owner_id=${userId}`));
    if (after?.state === "creating") {
      const knownBaseChange = error instanceof PrPublisherError && error.code === "base_changed";
      await getDb().execute(sql`UPDATE github_personal_pr_proposals SET state=${knownBaseChange ? "stale" : "failed"},failure_code=${knownBaseChange ? "base_changed_reimport_required" : after.commit_sha ? "outcome_unknown" : "pre_ref_retryable"},completed_at=NOW() WHERE id=${input.proposalId} AND owner_id=${userId} AND state='creating'`);
    }
    if (error instanceof PersonalPrError || error instanceof PrPublisherError || error instanceof GithubUserError) throw error;
    throw new PersonalPrError("unavailable", "GitHub publication failed; check the review before retrying");
  }
}
