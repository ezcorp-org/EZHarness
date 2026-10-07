import { createHash, X509Certificate } from "node:crypto";
import { eq } from "drizzle-orm";
import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import { getDb, type Database } from "../db/connection";
import { conversations, previewSessions, type SandboxBinding } from "../db/schema";
import { isValidPreviewId } from "../db/queries/preview-sessions";
import { sameSandboxWorkspaceBinding } from "../runtime/workspaces/target";
import { resolveQualificationPreviewTarget } from "../runtime/preview/preview-target";
import { IncusWorkspaceCaller } from "./incus-workspace-caller";
import { IncusQualificationStore } from "./incus-qualification";
import { guestHelperSha256 } from "./incus-guest/protocol";
import { resourceName } from "./incus-transport/lifecycle";
import type { IncusPreviewAuthorize, IncusPreviewDuplexRequest } from "./incus-transport/preview-duplex";

type PreviewRow = typeof previewSessions.$inferSelect;
type ConversationRow = Pick<typeof conversations.$inferSelect, "userId" | "projectId">;

export interface IncusPreviewAuthorityDependencies {
  db?: Database;
  caller?: Pick<IncusWorkspaceCaller, "authorizeBinding">;
  readPreview?: (id: string) => Promise<PreviewRow | undefined>;
  readConversation?: (id: string) => Promise<ConversationRow | undefined>;
  /** Host-owned profile proof; request payloads cannot supply this decision. */
  qualified?: (binding: SandboxBinding) => Promise<boolean>;
  /** Exact, short-lived host fixture permit. Absent in ordinary operation. */
  fixturePermitted?: (request: IncusPreviewDuplexRequest) => Promise<boolean>;
  now?: () => number;
}

export async function incusPreviewQualified(binding: SandboxBinding, db: Database = getDb()): Promise<boolean> {
  if (binding.profile !== "persistent-web-compose.v1" || !binding.presetId) return false;
  const proof = await new IncusQualificationStore({ db }).load({ installationId: binding.providerInstallationId,
    releaseId: binding.providerReleaseId, connectionId: binding.connectionId, presetId: binding.presetId });
  return !!proof && proof.presetDigest === binding.presetDigest
    && proof.effectiveSettingsDigest === binding.effectiveSettingsDigest;
}

/** One authority path for opening and continuing a guest preview stream. */
export function createIncusPreviewAuthorizer(deps: IncusPreviewAuthorityDependencies = {}): IncusPreviewAuthorize {
  const db = deps.db ?? getDb();
  const caller = deps.caller ?? new IncusWorkspaceCaller({ db });
  const now = deps.now ?? Date.now;
  const qualified = deps.qualified ?? (binding => incusPreviewQualified(binding, db));
  const readPreview = deps.readPreview ?? (async id => (await db.select().from(previewSessions)
    .where(eq(previewSessions.id, id)).limit(1))[0]);
  const readConversation = deps.readConversation ?? (async id => (await db.select({ userId: conversations.userId,
    projectId: conversations.projectId }).from(conversations).where(eq(conversations.id, id)).limit(1))[0]);

  async function current(request: IncusPreviewDuplexRequest) {
    if (!isValidPreviewId(request.previewId) || !request.userId || request.signal.aborted) {
      throw new Error("Incus preview authority is unavailable");
    }
    const row = await readPreview(request.previewId);
    const reference = row?.workspaceTarget;
    if (!row?.conversationId || row.userId !== request.userId || row.kind !== "dynamic" || row.status !== "active"
      || row.revokedAt || row.expiresAt.getTime() <= now()
      || row.expiresAt.getTime() !== request.expiresAt.getTime()
      || row.targetPort !== request.targetPort || !Number.isSafeInteger(row.targetPort)
      || row.targetPort! < 1024 || row.targetPort! > 65535 || reference?.kind !== "sandbox"
      || !sameSandboxWorkspaceBinding(reference.binding, request.binding)) {
      throw new Error("Incus preview registration changed");
    }
    const conversation = await readConversation(row.conversationId);
    if (conversation?.userId !== request.userId || conversation.projectId !== request.binding.projectId) {
      throw new Error("Incus preview conversation changed");
    }
    const authorized = await caller.authorizeBinding(reference.binding, request.userId);
    const { current: binding, snapshot, connection } = authorized;
    const provider = snapshot.release.manifest.sandboxProviders?.find(item => item.id === "incus" && item.kind === "sandbox");
    const preset = provider?.presets.find(item => item.id === binding.presetId
      && item.profile === "persistent-web-compose.v1" && item.profile === binding.profile);
    const fixturePermitted = async () => deps.fixturePermitted
      ? deps.fixturePermitted(request)
      : !!await resolveQualificationPreviewTarget(row);
    if (!preset || await sandboxPresetDigest(preset) !== binding.presetDigest
      || connection.configuration.kind !== "incus" || connection.configuration.guestUser !== "sandbox"
      || (!await qualified(binding) && !await fixturePermitted())) {
      throw new Error("Incus preview profile is not qualified");
    }
    return { ...authorized, preset, row, binding: reference.binding };
  }

  return async request => {
    // Capture mutable request fields before any asynchronous authority lookup.
    const captured = Object.freeze({ ...request, binding: Object.freeze({ ...request.binding }),
      expiresAt: new Date(request.expiresAt) });
    const authority = await current(captured);
    const { connection, preset, current: binding } = authority;
    if (connection.configuration.kind !== "incus") throw new Error("Incus connection changed");
    const config = connection.configuration;
    return {
      authorizedBinding: authority.binding,
      registeredPort: authority.row.targetPort!,
      command: {
        action: "endpoint.open", connectionId: binding.connectionId,
        deadlineMs: Math.min(now() + 30_000, captured.expiresAt.getTime()),
        pins: { connectionId: binding.connectionId,
          serverCertificateSha256: createHash("sha256").update(new X509Certificate(connection.serverCertificatePem).raw).digest("hex"),
          project: connection.project, profile: config.profile, helperVersion: config.helperVersion, guestUser: config.guestUser },
        tags: { managedBy: "ezharness-incus-sandbox", connectionId: binding.connectionId, sandboxId: binding.id },
        sandboxName: resourceName(binding.connectionId, binding.id), payload: {},
      },
      scope: { providerInstallationId: binding.providerInstallationId, providerReleaseId: binding.providerReleaseId,
        revision: binding.connectionRevision!, signal: captured.signal,
        approvedGuest: { user: config.guestUser, uid: 1000, gid: 1000, helperSha256: guestHelperSha256() },
        approvedPreset: { profile: preset.profile, incusProfile: config.profile, presetId: preset.id,
          presetDigest: binding.presetDigest!, effectiveSettingsDigest: binding.effectiveSettingsDigest!,
          imageFingerprint: preset.imageDigest,
          limits: { memoryBytes: preset.limits.memoryBytes, cpuMillis: preset.limits.cpuMillis,
            pids: preset.limits.pids, diskBytes: preset.limits.diskBytes } } },
      connections: { resolveForHost: async scope => {
        const fresh = await current(captured);
        if (scope.connectionId !== fresh.connection.id || scope.providerInstallationId !== fresh.current.providerInstallationId
          || scope.providerReleaseId !== fresh.current.providerReleaseId || scope.revision !== fresh.connection.revision) {
          throw new Error("Incus preview connection changed");
        }
        return fresh.connection;
      } },
      revalidate: async () => { await current(captured); },
    };
  };
}
