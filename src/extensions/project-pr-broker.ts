import type { RpcHandlerDeps } from "./tool-executor/rpc-handlers";
import type { JsonRpcRequest, JsonRpcResponse } from "./types";
import { resolveReverseRpcMeta } from "./tool-executor/provenance";
import { LifecycleError } from "./v4/types";

export async function handleProjectPullRequest(deps: RpcHandlerDeps, extensionId: string, request: JsonRpcRequest): Promise<JsonRpcResponse> {
  const resolved = resolveReverseRpcMeta(extensionId, request);
  if (!resolved.ok) return resolved.errorResponse;
  try {
    const input = request.params as Record<string, unknown> | undefined;
    if (!input || typeof input.runId !== "string" || typeof input.title !== "string" || typeof input.body !== "string") throw new LifecycleError("invalid_input", "Provide runId, title, and body.");
    if (!resolved.conversationId) throw new LifecycleError("project_required", "A project conversation is required.");
    const { getUserById } = await import("../db/queries/users");
    const { getConversation } = await import("../db/queries/conversations");
    const { getProject } = await import("../db/queries/projects");
    const { checkProjectRole } = await import("../auth/middleware");
    const user = await getUserById(resolved.onBehalfOf);
    const conversation = await getConversation(resolved.conversationId);
    if (user?.status !== "active" || !conversation || conversation.userId !== user.id || !conversation.projectId) throw new LifecycleError("permission_denied", "The caller must own the project conversation.");
    const role = await checkProjectRole({ user }, conversation.projectId, "member");
    if (role instanceof Response) throw new LifecycleError("permission_denied", "Project membership is required.");
    const project = await getProject(conversation.projectId);
    if (!project?.path) throw new LifecycleError("project_required", "A local project is required.");
    const decision = await deps.engine.authorize({ extensionId, userId: user.id, conversationId: conversation.id, toolName: "project.openPr" }, [{ kind: "shell" }, { kind: "network", value: "github.com" }, { kind: "network", value: "api.github.com" }]);
    if (decision.decision !== "allow") throw new LifecycleError("permission_denied", "Approve shell and GitHub network access before opening a pull request.");
    const { getSecret } = await import("./secrets-store");
    const token = await getSecret("github-projects", project.id, "apiToken");
    if (!token) throw new LifecycleError("credential_required", "Configure a GitHub token for this project. The extension never receives the token.");
    const { openProjectPullRequest } = await import("./project-open-pr");
    const result = await openProjectPullRequest({ projectRoot: project.path, runId: input.runId, title: input.title, body: input.body }, { githubToken: token });
    return { jsonrpc: "2.0", id: request.id, result };
  } catch (cause) {
    return { jsonrpc: "2.0", id: request.id, error: { code: -32603, message: cause instanceof LifecycleError ? cause.message : "Project pull request failed." } };
  }
}
