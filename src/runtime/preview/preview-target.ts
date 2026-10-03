import { getConversation } from "../../db/queries/conversations";
import { getProject } from "../../db/queries/projects";
import { resolveProjectWorkspaceTarget } from "../workspaces/project-target";
import { sameSandboxWorkspaceBinding, type SandboxWorkspaceTarget } from "../workspaces/target";
import type { PreviewRegistryRow } from "./preview-proxy";

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
    const current = await resolveProjectWorkspaceTarget(project, "preview access");
    if (current.kind !== "sandbox" || !sameSandboxWorkspaceBinding(reference.binding, current.binding)) return undefined;
    return current;
  } catch { return undefined; }
}
