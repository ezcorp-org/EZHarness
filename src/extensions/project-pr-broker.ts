import type { RpcHandlerDeps } from "./tool-executor/rpc-handlers";
import type { JsonRpcRequest, JsonRpcResponse } from "./types";
import { resolveReverseRpcMeta } from "./tool-executor/provenance";
import { LifecycleError } from "./v4/types";
import { authorizeProjectOperation } from "./project-access";

export async function handleProjectPullRequest(deps: RpcHandlerDeps, extensionId: string, request: JsonRpcRequest): Promise<JsonRpcResponse> {
  const resolved = resolveReverseRpcMeta(extensionId, request);
  if (!resolved.ok) return resolved.errorResponse;
  try {
    const input = request.params as Record<string, unknown> | undefined;
    if (!input || typeof input.runId !== "string" || typeof input.title !== "string" || typeof input.body !== "string") throw new LifecycleError("invalid_input", "Provide runId, title, and body.");
    const { project } = await authorizeProjectOperation(deps, extensionId, resolved.onBehalfOf, resolved.conversationId, "project.openPr", [{ kind: "shell" }, { kind: "network", value: "github.com" }, { kind: "network", value: "api.github.com" }]);
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
