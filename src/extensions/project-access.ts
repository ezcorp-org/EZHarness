import type { RpcHandlerDeps } from "./tool-executor/rpc-handlers";
import type { Capability } from "./capability-types";
import { LifecycleError } from "./v4/types";
import type { ProjectOperationConsent } from "./project-consent";

export async function authorizeProjectOperation(deps: Pick<RpcHandlerDeps, "engine">, extensionId: string, userId: string, conversationId: string | null, operation: string, capabilities: Capability[], trustedProjectId?: string, trustedBindingId?: string, proposalId?: string) {
  requireProjectContext(conversationId, trustedProjectId);
  const { getUserById } = await import("../db/queries/users");
  const { getConversation } = await import("../db/queries/conversations");
  const { getProject } = await import("../db/queries/projects");
  const { checkProjectRole } = await import("../auth/middleware");
  const user = await getUserById(userId);
  const conversation = conversationId ? await getConversation(conversationId) : undefined;
  requireOwnedConversation(user, conversation, conversationId);
  const { projectId, projectConsent } = await resolveProjectAuthorization({ extensionId, user, conversation, conversationId, trustedProjectId, trustedBindingId, proposalId, operation });
  requireProjectMembership(await checkProjectRole({ user }, projectId, "member"));
  const project = await getProject(projectId);
  await requireNonSandboxProject(projectId);
  if (!project?.path) throw new LifecycleError("project_required", "A local project is required.");
  const decision = await deps.engine.authorize({ extensionId, userId: user.id, conversationId: conversation?.id ?? null, toolName: operation, ...(projectConsent ? { projectConsent } : {}) }, capabilities);
  if (decision.decision !== "allow") throw new LifecycleError("permission_denied", "Approve shell and required project capabilities before this operation.");
  return { project, user, conversation };
}

function requireProjectContext(conversationId: string | null, trustedProjectId?: string): void {
  if (!conversationId && !trustedProjectId) throw new LifecycleError("project_required", "Bind this operation to a project conversation before using project access.");
}

function requireOwnedConversation(user: { id: string; status?: string } | null | undefined, conversation: { userId: string | null; projectId: string | null } | null | undefined, conversationId: string | null): asserts user is { id: string; status: string } {
  if (user?.status !== "active" || (conversationId && (!conversation || conversation.userId !== user.id || !conversation.projectId))) throw new LifecycleError("permission_denied", "The caller must own the project conversation.");
}

async function resolveProjectAuthorization({ extensionId, user, conversation, conversationId, trustedProjectId, trustedBindingId, proposalId, operation }: {
  extensionId: string;
  user: { id: string };
  conversation: { projectId: string | null } | null | undefined;
  conversationId: string | null;
  trustedProjectId?: string;
  trustedBindingId?: string;
  proposalId?: string;
  operation: string;
}): Promise<{ projectId: string; projectConsent?: ProjectOperationConsent }> {
  let projectId = conversation?.projectId;
  let projectConsent: ProjectOperationConsent | undefined;
  if (trustedProjectId && (!conversationId || trustedBindingId)) {
    const { getExtensionProjectBinding } = await import("./project-binding");
    const binding = await getExtensionProjectBinding(extensionId);
    if (!binding || binding.id !== trustedBindingId || binding.ownerId !== user.id || binding.projectId !== trustedProjectId || (projectId && projectId !== binding.projectId)) throw new LifecycleError("permission_denied", "The approved project binding is missing or changed.");
    projectId = binding.projectId;
    projectConsent = { projectId, bindingId: binding.id, ...(proposalId ? { proposalId } : {}) };
  }
  if (trustedProjectId && projectId !== trustedProjectId) throw new LifecycleError("permission_denied", "The project conversation changed.");
  if (!projectId) throw new LifecycleError("project_required", "An approved project binding is required.");
  if (!projectConsent && operation !== "project.openPr") {
    const { getExtensionProjectBinding } = await import("./project-binding");
    const binding = await getExtensionProjectBinding(extensionId);
    if (binding?.ownerId === user.id && binding.projectId === projectId) projectConsent = { projectId, bindingId: binding.id };
  }
  return { projectId, projectConsent };
}

function requireProjectMembership(role: unknown): void {
  if (role instanceof Response) throw new LifecycleError("permission_denied", "Project membership is required.");
}

async function requireNonSandboxProject(projectId: string): Promise<void> {
  const { projectRequiresSandbox } = await import("../runtime/workspace/target");
  if (await projectRequiresSandbox(projectId)) throw new LifecycleError("project_required", "This sandbox project does not permit direct host project access.");
}
