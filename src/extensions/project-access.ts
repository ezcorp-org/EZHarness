import type { RpcHandlerDeps } from "./tool-executor/rpc-handlers";
import type { Capability } from "./capability-types";
import { LifecycleError } from "./v4/types";

export async function authorizeProjectOperation(deps: RpcHandlerDeps, extensionId: string, userId: string, conversationId: string | null, operation: string, capabilities: Capability[]) {
  if (!conversationId) throw new LifecycleError("project_required", "Bind this operation to a project conversation before using project access.");
  const { getUserById } = await import("../db/queries/users");
  const { getConversation } = await import("../db/queries/conversations");
  const { getProject } = await import("../db/queries/projects");
  const { checkProjectRole } = await import("../auth/middleware");
  const user = await getUserById(userId);
  const conversation = await getConversation(conversationId);
  if (user?.status !== "active" || !conversation || conversation.userId !== user.id || !conversation.projectId) throw new LifecycleError("permission_denied", "The caller must own the project conversation.");
  const role = await checkProjectRole({ user }, conversation.projectId, "member");
  if (role instanceof Response) throw new LifecycleError("permission_denied", "Project membership is required.");
  const project = await getProject(conversation.projectId);
  if (!project?.path) throw new LifecycleError("project_required", "A local project is required.");
  const decision = await deps.engine.authorize({ extensionId, userId: user.id, conversationId: conversation.id, toolName: operation }, capabilities);
  if (decision.decision !== "allow") throw new LifecycleError("permission_denied", "Approve shell and required project capabilities before this operation.");
  return { project, user, conversation };
}
