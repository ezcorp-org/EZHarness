import { canonicalJson } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import type { SandboxBinding } from "../../db/schema";
import { getDb, type DbTransaction } from "../../db/connection";
import { releaseRows } from "../../db/queries/extension-releases";
import { IncusWorkspaceCaller } from "../../infrastructure/incus-workspace-caller";
import { resolveProjectWorkspaceTarget } from "../../runtime/workspaces/project-target";
import type { SandboxWorkspaceTarget } from "../../runtime/workspaces/target";
import { exportIncusSnapshot } from "./incus-workspace";
import type { PersonalPrWorkspace, PersonalPrWorkspaceStatus, WorkspacePublicationIdentity } from "./workspace";

interface Source { owner_id: string; conversation_id: string | null; state: string; workspace_authority: unknown }
export async function authorizedIncusTarget(userId: string, projectId: string): Promise<SandboxWorkspaceTarget> {
  const [project] = releaseRows<{ id: string; path: string | null; owner_only: boolean }>(await getDb().execute(sql`
    SELECT project.id,project.path, (SELECT count(*)=1 AND bool_and(member.user_id=${userId} AND member.role='owner')
      FROM project_members member WHERE member.project_id=project.id) AS owner_only
    FROM projects project WHERE project.id=${projectId} AND project.purpose='user'`));
  if (project?.owner_only !== true) throw new Error("A private repository workspace requires its sole owner");
  const target = await resolveProjectWorkspaceTarget(project, "personal repository workspace");
  if (target.kind !== "sandbox" || target.binding.providerId !== "incus") throw new Error("Incus repository workspace is unavailable");
  await new IncusWorkspaceCaller().authorizeBinding(target.binding, userId);
  return target;
}

export function incusWorkspaceAuthority(binding: SandboxBinding, releaseDigest: string) {
  if (!binding.resourceKey || !binding.presetId || !binding.presetDigest || !binding.effectiveSettingsDigest || !binding.connectionRevision) throw new Error("Incus workspace identity is incomplete");
  return { kind: "incus", bindingId: binding.id,
    binding: { projectId: binding.projectId, workspaceId: binding.resourceKey, connectionId: binding.connectionId,
      providerId: "incus", generation: binding.generation, presetId: binding.presetId, releaseDigest,
      presetDigest: binding.presetDigest, effectiveSettingsDigest: binding.effectiveSettingsDigest },
    providerInstallationId: binding.providerInstallationId, providerReleaseId: binding.providerReleaseId,
    connectionRevision: binding.connectionRevision, workspaceRevision: binding.generation };
}

/** Captured once after the controlled initial START; snapshots refer to the import's record. */
export async function currentIncusAuthority(userId: string, projectId: string) {
  const target = await authorizedIncusTarget(userId, projectId);
  const { current } = await new IncusWorkspaceCaller().authorizeBinding(target.binding, userId);
  return { target, identity: incusWorkspaceAuthority(current, target.binding.releaseDigest) };
}
export function sameIncusAuthority(current: Readonly<Record<string, unknown>>, saved: Readonly<Record<string, unknown>>): boolean {
  const { request: _request, ...identity } = saved;
  return canonicalJson(current) === canonicalJson(identity);
}

async function currentSource(userId: string, projectId: string): Promise<Source> {
  const [source] = releaseRows<Source>(await getDb().execute(sql`SELECT owner_id,conversation_id,state,workspace_authority
    FROM github_personal_pr_imports WHERE project_id=${projectId}`));
  if (!source || source.owner_id !== userId || source.workspace_authority == null) throw new Error("Private repository workspace is unavailable");
  return source;
}
function parsed(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "string" ? JSON.parse(value) : value as Readonly<Record<string, unknown>>;
}

export function incusPersonalPrWorkspace(userId: string, projectId: string): PersonalPrWorkspace {
  const status = async (): Promise<PersonalPrWorkspaceStatus> => {
    const source = await currentSource(userId, projectId);
    const { target, identity } = await currentIncusAuthority(userId, projectId);
    if (!sameIncusAuthority(identity, parsed(source.workspace_authority))) throw new Error("Imported Incus authority changed");
    return { projectId, kind: "incus", bindingId: identity.bindingId, privateOwnerOnly: true,
      initializationState: source.state === "ready" ? "ready" : source.state === "importing" ? "importing" : "failed",
      privateConversationId: source.conversation_id, provider: { generation: target.binding.generation },
      resource: { resourceId: target.binding.workspaceId, observedState: "running" }, operation: null, authority: parsed(source.workspace_authority) };
  };
  return {
    status,
    async forRun(conversationId) {
      const [conversation] = releaseRows<{ id: string }>(await getDb().execute(sql`SELECT id FROM conversations
        WHERE id=${conversationId} AND project_id=${projectId} AND user_id=${userId}`));
      if (!conversation) throw new Error("Repository run conversation belongs to another user");
      await getDb().execute(sql`UPDATE github_personal_pr_imports SET conversation_id=${conversationId}
        WHERE project_id=${projectId} AND owner_id=${userId} AND state='ready' AND conversation_id IS NULL`);
      return status();
    },
    async importSnapshot() { throw new Error("Incus repository import must create a new private workspace"); },
    prepareReview: status,
    async capture() { return exportIncusSnapshot(await authorizedIncusTarget(userId, projectId), userId); },
    canReview: current => current.resource?.observedState === "running",
    assertPublication: (transaction, expected) => assertIncusPublication(transaction, userId, projectId, expected),
  };
}

async function assertIncusPublication(transaction: DbTransaction, userId: string, projectId: string, expected: WorkspacePublicationIdentity): Promise<void> {
  // Lock the durable identities before the connection broker claims a GitHub write.
  await transaction.execute(sql`SELECT id FROM sandbox_bindings WHERE project_id=${projectId} FOR SHARE`);
  await transaction.execute(sql`SELECT id FROM project_members WHERE project_id=${projectId} FOR SHARE`);
  const [source] = releaseRows<Source>(await transaction.execute(sql`SELECT owner_id,conversation_id,state,workspace_authority
    FROM github_personal_pr_imports WHERE project_id=${projectId} FOR SHARE`));
  if (source?.state !== "ready" || source.owner_id !== userId || source.conversation_id !== expected.conversationId
    || canonicalJson(parsed(source.workspace_authority)) !== canonicalJson(expected.authority)) throw new Error("Private repository authority changed before publication");
  const [binding] = releaseRows<Record<string, unknown>>(await transaction.execute(sql`SELECT binding.*,
    (SELECT count(*)=1 AND bool_and(member.user_id=${userId} AND member.role='owner') FROM project_members member WHERE member.project_id=binding.project_id) AS owner_only,
    EXISTS(SELECT 1 FROM conversations conversation WHERE conversation.id=${expected.conversationId} AND conversation.project_id=binding.project_id AND conversation.user_id=${userId}) AS owned_conversation,
    connection.revision AS live_connection_revision,connection.revoked_at,
    connection.provider_installation_id AS live_connection_installation,connection.provider_release_id AS live_connection_release,
    installation.payload AS installation_payload,release.payload AS release_payload
    FROM sandbox_bindings binding JOIN provider_connections connection ON connection.id=binding.connection_id
    JOIN extension_release_installations installation ON installation.id=binding.provider_installation_id
    JOIN extension_release_records release ON release.installation_id=installation.id AND release.kind='releases' AND release.id=binding.provider_release_id
    WHERE binding.project_id=${projectId} FOR SHARE OF binding,connection,installation,release`));
  const authority = expected.authority;
  const pinned = authority.binding as Record<string, unknown> | undefined;
  const installation = binding ? parsed(binding.installation_payload) : {};
  const release = binding ? parsed(binding.release_payload) : {};
  if (!binding || !pinned || binding.owner_only !== true || binding.owned_conversation !== true) throw new Error("Incus owner authority changed before publication");
  const liveIdentity = { projectId, workspaceId: binding.resource_key, connectionId: binding.connection_id,
    providerId: "incus", generation: Number(binding.generation), presetId: binding.preset_id,
    releaseDigest: release.releaseDigest, presetDigest: binding.preset_digest, effectiveSettingsDigest: binding.effective_settings_digest };
  if (canonicalJson(liveIdentity) !== canonicalJson(pinned) || binding.id !== expected.bindingId
    || binding.resource_key !== expected.resourceId || Number(binding.generation) !== expected.generation
    || expected.workspaceRevision !== expected.generation || binding.desired_state !== "RUNNING"
    || binding.observed_state !== "RUNNING" || binding.tombstoned_at != null || binding.current_operation_id == null) {
    throw new Error("Incus workspace changed before publication");
  }
  assertPublicationProvider(binding, installation, authority);
}

function assertPublicationProvider(binding: Record<string, unknown>, installation: Readonly<Record<string, unknown>>, authority: Readonly<Record<string, unknown>>): void {
  if (binding.provider_installation_id !== authority.providerInstallationId || binding.provider_release_id !== authority.providerReleaseId
    || Number(binding.connection_revision) !== authority.connectionRevision || Number(binding.live_connection_revision) !== authority.connectionRevision
    || binding.live_connection_installation !== authority.providerInstallationId || binding.live_connection_release !== authority.providerReleaseId
    || binding.revoked_at != null || installation.activeReleaseId !== binding.provider_release_id || installation.enabled !== true
    || installation.uninstalled === true || installation.status !== "active" || !Number.isSafeInteger(installation.generation)
    || installation.acknowledgedGeneration !== installation.generation) throw new Error("Incus provider authority changed before publication");
}
