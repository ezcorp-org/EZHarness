import type { RpcHandlerDeps } from "./tool-executor/rpc-handlers";
import type { Capability } from "./capability-types";
import { LifecycleError } from "./v4/types";

export async function authorizeProjectOperation(deps: RpcHandlerDeps, extensionId: string, userId: string, conversationId: string | null, operation: string, capabilities: Capability[], trustedProjectId?: string) {
  if (!conversationId && !trustedProjectId) throw new LifecycleError("project_required", "Bind this operation to a project conversation before using project access.");
  const { getUserById } = await import("../db/queries/users");
  const { getConversation } = await import("../db/queries/conversations");
  const { getProject } = await import("../db/queries/projects");
  const { checkProjectRole } = await import("../auth/middleware");
  const user = await getUserById(userId);
  const conversation = conversationId ? await getConversation(conversationId) : undefined;
  if (user?.status !== "active" || (conversationId && (!conversation || conversation.userId !== user.id || !conversation.projectId))) throw new LifecycleError("permission_denied", "The caller must own the project conversation.");
  let projectId = conversation?.projectId;
  if (trustedProjectId) {
    const { getExtensionProjectBinding } = await import("./project-binding");
    const binding = await getExtensionProjectBinding(extensionId);
    if (!binding || binding.ownerId !== user.id || binding.projectId !== trustedProjectId || (projectId && projectId !== binding.projectId)) throw new LifecycleError("permission_denied", "The approved project binding is missing or changed.");
    projectId = binding.projectId;
  }
  if (!projectId) throw new LifecycleError("project_required", "An approved project binding is required.");
  const role = await checkProjectRole({ user }, projectId, "member");
  if (role instanceof Response) throw new LifecycleError("permission_denied", "Project membership is required.");
  const project = await getProject(projectId);
  if (!project?.path) throw new LifecycleError("project_required", "A local project is required.");
  const decision = await deps.engine.authorize({ extensionId, userId: user.id, conversationId: conversation?.id ?? null, toolName: operation }, capabilities);
  if (decision.decision !== "allow") throw new LifecycleError("permission_denied", "Approve shell and required project capabilities before this operation.");
  return { project, user, conversation };
}
