import { getConversation } from "../../db/queries/conversations";
import { getProject } from "../../db/queries/projects";
import { resolveProjectWorkspaceTarget } from "../workspaces/project-target";
import { sameSandboxWorkspaceBinding, type SandboxWorkspaceBinding, type SandboxWorkspaceTarget } from "../workspaces/target";
import type { PreviewRegistryRow } from "./preview-proxy";

type QualificationPreviewKey = {
  previewId: string;
  userId: string;
  conversationId: string;
  targetPort: number;
  binding: Readonly<SandboxWorkspaceBinding>;
};
type QualificationPreviewEntry = QualificationPreviewKey & {
  resolve: () => Promise<SandboxWorkspaceTarget | undefined>;
};
const qualificationPreviews = new Map<string, QualificationPreviewEntry>();

/** A host-owned, process-local qualification route for one claimed fixture.
 * The caller owns the claim checks and must dispose this lease in finally. */
export function registerQualificationPreviewTarget(key: QualificationPreviewKey,
  resolve: QualificationPreviewEntry["resolve"]): () => void {
  if (!key.previewId || !key.userId || !key.conversationId || !Number.isInteger(key.targetPort)
    || key.targetPort < 1024 || key.targetPort > 65535 || qualificationPreviews.has(key.previewId)) {
    throw new Error("Qualification preview route is unavailable");
  }
  const entry = { ...key, resolve };
  qualificationPreviews.set(key.previewId, entry);
  return () => {
    if (qualificationPreviews.get(key.previewId) === entry) qualificationPreviews.delete(key.previewId);
  };
}

/** The same exact lease check is used by dispatch and the host transport authorizer. */
export async function resolveQualificationPreviewTarget(row: PreviewRegistryRow): Promise<SandboxWorkspaceTarget | undefined> {
  const entry = qualificationPreviews.get(row.id);
  if (!entry || row.userId !== entry.userId || row.conversationId !== entry.conversationId
    || row.kind !== "dynamic" || row.targetPort !== entry.targetPort
    || !(row.expiresAt instanceof Date) || row.expiresAt.getTime() <= Date.now()
    || row.workspaceTarget?.kind !== "sandbox"
    || !sameSandboxWorkspaceBinding(row.workspaceTarget.binding, entry.binding)) return undefined;
  const target = await entry.resolve();
  if (target?.kind !== "sandbox" || !sameSandboxWorkspaceBinding(target.binding, entry.binding)
    || !target.backend?.previews) return undefined;
  return target;
}

/** Resolve a stored preview against the conversation's current project and
 * exact running sandbox binding. A row cannot choose a stale provider grant. */
export async function resolveCurrentPreviewSandboxTarget(row: PreviewRegistryRow): Promise<SandboxWorkspaceTarget | undefined> {
  const reference = row.workspaceTarget;
  if (reference?.kind !== "sandbox" || !row.conversationId || !row.userId) return undefined;
  try {
    const conversation = await getConversation(row.conversationId);
    if (!conversation || conversation.userId !== row.userId || conversation.projectId !== reference.binding.projectId) {
      return undefined;
    }
    const project = await getProject(conversation.projectId);
    // Qualification fixtures use a separate project purpose and are hidden
    // from the normal user-project lookup. Only their exact claimed lease may
    // supply a preview after the conversation owner and project match above.
    if (!project) return await resolveQualificationPreviewTarget(row);
    try {
      const current = await resolveProjectWorkspaceTarget(project, "preview access");
      if (current.kind === "sandbox") {
        if (!sameSandboxWorkspaceBinding(reference.binding, current.binding)) return undefined;
        return current.backend?.previews ? current : await resolveQualificationPreviewTarget(row);
      }
    } catch { /* An exact fixture lease may supply this one preview. */ }
    return await resolveQualificationPreviewTarget(row);
  } catch { return undefined; }
}
