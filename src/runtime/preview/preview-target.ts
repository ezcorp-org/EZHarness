import { getConversation } from "../../db/queries/conversations";
import { getProject } from "../../db/queries/projects";
import { resolveProjectWorkspaceTarget } from "../workspaces/project-target";
import { sameSandboxWorkspaceBinding, type SandboxWorkspaceBinding, type SandboxWorkspaceTarget } from "../workspaces/target";
import type { PreviewRegistryRow } from "./preview-proxy";

type QualificationPreviewKey = {
  previewId: string;
  userId: string;
  conversationId: string;
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
  if (!key.previewId || !key.userId || !key.conversationId || qualificationPreviews.has(key.previewId)) {
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
    if (!project) return undefined;
    try {
      const current = await resolveProjectWorkspaceTarget(project, "preview access");
      if (current.kind === "sandbox") {
        return sameSandboxWorkspaceBinding(reference.binding, current.binding) ? current : undefined;
      }
    } catch { /* An exact fixture lease may supply this one preview. */ }
    return await resolveQualificationPreviewTarget(row);
  } catch { return undefined; }
}
