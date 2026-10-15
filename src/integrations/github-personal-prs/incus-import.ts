import { randomUUID } from "node:crypto";
import { canonicalJson } from "@ezcorp/extension-contract";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../../db/connection";
import { sandboxBindings, sandboxOperations } from "../../db/schema";
import { releaseRows } from "../../db/queries/extension-releases";
import { configuredIncusFeatureService } from "../../infrastructure/incus-feature-runtime";
import { approvedRepositorySource } from "./repository-source";
import { GithubSourceError } from "./github-source";
import { assertIncusImportSnapshot, importIncusSnapshot } from "./incus-workspace";
import { currentIncusAuthority, incusWorkspaceAuthority, sameIncusAuthority } from "./incus-workspace-service";
import { WorkspaceTransferError } from "./provider-transfer";
import { validateSnapshot, type SnapshotFileInput, type ValidatedSnapshot } from "./snapshot";
import { PersonalPrError, type PersonalPrView } from "./service";

export interface CreateIncusRepositoryInput {
  name: string; installationId: string; connectionId: string; presetId: string;
  repositoryId: number; baseRef: string; idempotencyKey: string;
}
interface ImportRow {
  id: string; owner_id: string; project_id: string; binding_id: string; state: string;
  repository_id: number; repository_name: string; base_ref: string; base_sha: string;
  operation_id: string; idempotency_key: string; artifact: unknown; resource_id: string | null; workspace_authority: unknown;
}
function parse<T>(value: unknown): T { return typeof value === "string" ? JSON.parse(value) as T : value as T; }
function authority(row: ImportRow): Record<string, unknown> { return parse(row.workspace_authority); }
function snapshot(row: ImportRow): ValidatedSnapshot { return validateSnapshot(parse<SnapshotFileInput[]>(row.artifact)); }
function view(row: ImportRow): PersonalPrView {
  return { state: "working", projectId: row.project_id, importState: row.state === "ready" ? "ready" : "unknown",
    repository: { id: Number(row.repository_id), fullName: row.repository_name, baseRef: row.base_ref, baseSha: row.base_sha } };
}
async function source(userId: string, projectId: string): Promise<ImportRow> {
  const [row] = releaseRows<ImportRow>(await getDb().execute(sql`SELECT * FROM github_personal_pr_imports WHERE project_id=${projectId} AND owner_id=${userId}`));
  if (!row || authority(row)?.kind !== "incus") throw new Error("This project has no admitted Incus repository import");
  return row;
}
function request(input: CreateIncusRepositoryInput) { const { idempotencyKey: _key, ...value } = input; return value; }
function verifyRequest(row: ImportRow, input: CreateIncusRepositoryInput): void {
  const pinned = authority(row);
  if (pinned?.kind !== "incus" || !pinned.request || row.idempotency_key !== input.idempotencyKey
    || canonicalJson(pinned.request) !== canonicalJson(request(input))) throw new PersonalPrError("conflict", "Repository import idempotency key changed request");
}

async function approvedIncusSource(userId: string, input: CreateIncusRepositoryInput, operationId: string) {
  try { return await approvedRepositorySource(userId, input.repositoryId, input.baseRef, operationId); }
  catch (error) {
    if (error instanceof GithubSourceError && error.code === "unsupported_repository") {
      throw new WorkspaceTransferError("unsupported_workspace", "Repository source exceeds the supported import limits");
    }
    throw error;
  }
}

/** Source and marker are saved before the new project can issue its first guest operation. */
export async function createPrivateIncusRepository(userId: string, input: CreateIncusRepositoryInput): Promise<PersonalPrView> {
  const existing = releaseRows<ImportRow>(await getDb().execute(sql`SELECT * FROM github_personal_pr_imports WHERE owner_id=${userId} AND idempotency_key=${input.idempotencyKey}`));
  if (existing.length > 1) throw new Error("Repository import identity is ambiguous");
  if (existing[0]) {
    verifyRequest(existing[0], input);
    return resumeIncusRepository(userId, existing[0].project_id);
  }
  const operationId = randomUUID();
  const selected = await approvedIncusSource(userId, input, operationId);
  if (!selected.source) return { state: "blocked", blockReason: selected.blocked };
  const approved = selected.source;
  assertIncusImportSnapshot(approved.snapshot);
  const created = await configuredIncusFeatureService().prepareProject({ name: input.name, ownerUserId: userId,
    installationId: input.installationId, connectionId: input.connectionId, presetId: input.presetId, idempotencyKey: input.idempotencyKey },
  async (transaction, prepared) => {
    const [saved] = releaseRows<ImportRow>(await transaction.execute(sql`SELECT * FROM github_personal_pr_imports WHERE project_id=${prepared.project.id}`));
    if (!prepared.created) {
      if (!saved || saved.owner_id !== userId || saved.binding_id !== prepared.binding.id) throw new Error("An existing workspace cannot be attached to repository import");
      verifyRequest(saved, input);
      return;
    }
    if (saved) throw new Error("Repository import already exists");
    const pinned = { ...incusWorkspaceAuthority(prepared.binding, prepared.releaseDigest), request: request(input) };
    const files = approved.snapshot.files.map(file => ({ path: file.path, mode: file.mode, data: Buffer.from(file.bytes).toString("base64"), sha256: file.sha256 }));
    await transaction.execute(sql`INSERT INTO github_personal_pr_imports
      (id,owner_id,project_id,binding_id,workspace_revision,provider_generation,repository_id,repository_name,base_ref,base_sha,base_digest,state,operation_id,idempotency_key,artifact,workspace_authority)
      VALUES (${randomUUID()},${userId},${prepared.project.id},${prepared.binding.id},${prepared.binding.generation},${prepared.binding.generation},${approved.repositoryId},${approved.fullName},${approved.baseRef},${approved.baseSha},${approved.snapshot.digest},'importing',${operationId},${input.idempotencyKey},${JSON.stringify(files)},${JSON.stringify(pinned)})`);
  });
  return resumeIncusRepository(userId, created.project.id);
}

const lifecycleScope = "github-personal-import";
async function failedLifecycle(row: ImportRow): Promise<never> {
  await getDb().execute(sql`UPDATE github_personal_pr_imports SET state='failed',completed_at=NOW()
    WHERE id=${row.id} AND owner_id=${row.owner_id} AND state='importing' AND resource_id IS NULL`);
  throw new WorkspaceTransferError("provider_failed", "Repository workspace lifecycle failed. Inspect its saved operation before disposal.");
}

async function lifecycleProgress(row: ImportRow): Promise<boolean> {
  const service = configuredIncusFeatureService();
  const journal = async (phase: "create" | "start") => {
    const [saved] = await getDb().select().from(sandboxOperations).where(eq(sandboxOperations.idempotencyKey, `${row.operation_id}:${phase}`)).limit(1);
    if (saved && (saved.bindingId !== row.binding_id || saved.idempotencyScope !== lifecycleScope)) throw new Error("Repository lifecycle journal changed");
    return saved && ["DISPATCHING", "PROVIDER_PENDING", "OUTCOME_UNKNOWN"].includes(saved.state)
      ? service.inspectSavedOperation(row.binding_id, saved.id) : saved;
  };
  const binding = async () => {
    const [value] = await getDb().select().from(sandboxBindings).where(eq(sandboxBindings.id, row.binding_id)).limit(1);
    if (!value || value.tombstonedAt) throw new Error("Repository workspace is unavailable");
    return value;
  };
  let create = await journal("create");
  if (!create) {
    if ((await binding()).currentOperationId) throw new Error("An existing workspace cannot be imported");
    const result = await service.create({ bindingId: row.binding_id, idempotencyScope: lifecycleScope, idempotencyKey: `${row.operation_id}:create` });
    if (result.state === "REJECTED") return failedLifecycle(row);
    if (result.state !== "DISPATCHED") return false;
    create = await service.inspectSavedOperation(row.binding_id, result.operation.id);
  }
  if (create.state === "FAILED") return failedLifecycle(row);
  if (create.state !== "SUCCEEDED") return false;
  let start = await journal("start");
  if (!start) {
    if ((await binding()).observedState !== "STOPPED") return false;
    const result = await service.start({ bindingId: row.binding_id, idempotencyScope: lifecycleScope, idempotencyKey: `${row.operation_id}:start` });
    if (result.state === "REJECTED") return failedLifecycle(row);
    if (result.state !== "DISPATCHED") return false;
    start = await service.inspectSavedOperation(row.binding_id, result.operation.id);
  }
  if (start.state === "FAILED") return failedLifecycle(row);
  const current = await binding();
  return start.state === "SUCCEEDED" && current.currentOperationId === start.id
    && current.generation === start.generation && current.desiredState === "RUNNING" && current.observedState === "RUNNING";
}

/** Retries read original CREATE/START journals and source bytes; partial file transfer is never replayed. */
export async function resumeIncusRepository(userId: string, projectId: string): Promise<PersonalPrView> {
  let row = await source(userId, projectId);
  if (row.state === "ready") return view(row);
  if (row.state !== "importing" || row.resource_id) throw new WorkspaceTransferError("provider_failed", "Repository import needs review; inspect its saved operation before disposal");
  const approved = snapshot(row);
  assertIncusImportSnapshot(approved);
  if (!await lifecycleProgress(row)) return view(row);
  const { target, identity } = await currentIncusAuthority(userId, projectId);
  const initial = authority(row);
  const priorBinding = initial.binding as Record<string, unknown>;
  // Only the saved initial START can advance the generation before the first import.
  const beforeStart = { ...identity, workspaceRevision: initial.workspaceRevision,
    binding: { ...identity.binding, generation: priorBinding.generation } };
  if (!sameIncusAuthority(beforeStart, initial)) throw new Error("Repository workspace authority changed during its initial start");
  const pinned = { ...identity, request: initial.request };
  const claimed = releaseRows<{ id: string }>(await getDb().execute(sql`UPDATE github_personal_pr_imports SET
    resource_id=${target.binding.workspaceId},provider_generation=${target.binding.generation},workspace_revision=${identity.workspaceRevision},workspace_authority=${JSON.stringify(pinned)}
    WHERE id=${row.id} AND owner_id=${userId} AND state='importing' AND resource_id IS NULL RETURNING id`));
  if (claimed.length !== 1) throw new WorkspaceTransferError("provider_failed", "Repository transfer is already admitted; inspect its saved status");
  try {
    await importIncusSnapshot(target, userId, approved, row.operation_id);
    await getDb().execute(sql`UPDATE github_personal_pr_imports SET state='ready',completed_at=NOW()
      WHERE id=${row.id} AND state='importing' AND resource_id=${target.binding.workspaceId}`);
  } catch {
    await getDb().execute(sql`UPDATE github_personal_pr_imports SET state='unknown',completed_at=NOW() WHERE id=${row.id} AND state='importing'`);
    throw new WorkspaceTransferError("provider_failed", "Source import did not settle. Inspect its saved workspace before disposal.");
  }
  row = await source(userId, projectId);
  return view(row);
}
