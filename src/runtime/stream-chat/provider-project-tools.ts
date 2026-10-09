import { getProject } from "../../db/queries/projects";
import { getConversation } from "../../db/queries/conversations";
import { resolveProjectWorkspaceTarget } from "../workspaces/project-target";
import { sameSandboxWorkspaceBinding, type WorkspaceTarget, type SandboxPreviewServerRequest } from "../workspaces/target";
import { detectDevServerCommand } from "../preview/dev-command-detection";
import { onPreviewDetected } from "../preview/preview-detection-bridge";
import { getRegisteredPreviewBus } from "../preview/preview-bus-registry";
import { resolvePreviewAppHost } from "../preview/preview-proxy";
import { toolError } from "../tools/types";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

async function assertPreviewOwner(request: SandboxPreviewServerRequest): Promise<void> {
  const conversation = await getConversation(request.conversationId);
  const project = await getProject(request.binding.projectId);
  if (!conversation || conversation.userId !== request.userId || conversation.projectId !== request.binding.projectId || !project) {
    throw new Error("Preview conversation is unavailable");
  }
  const current = await resolveProjectWorkspaceTarget(project, "preview launch");
  if (current.kind !== "sandbox" || !sameSandboxWorkspaceBinding(current.binding, request.binding)) {
    throw new Error("Preview workspace changed");
  }
}

async function launchProviderPreview(target: Extract<WorkspaceTarget, { kind: "sandbox" }>,
  request: SandboxPreviewServerRequest): Promise<AgentToolResult<unknown>> {
  const previews = target.backend!.previews!;
  await assertPreviewOwner(request);
  const server = await previews.startServer!(request);
  try {
    request.signal?.throwIfAborted();
    await assertPreviewOwner(request);
    const delivered = await onPreviewDetected({ userId: request.userId, conversationId: request.conversationId, port: server.port }, {
      getBus: getRegisteredPreviewBus, appHost: resolvePreviewAppHost,
      secure: () => process.env.FORCE_SECURE_COOKIES === "true",
    });
    if (!delivered) throw new Error("Preview consent was not delivered");
    return { content: [{ type: "text", text: `Dev server started in the sandbox on port ${server.port}. Open the preview card to view the site.` }],
      details: { exitCode: 0, stdout: "", stderr: "", streaming: false, preview: { launched: true, ...server } } };
  } catch {
    await previews.stopServer!({ ...request, server });
    return toolError("Sandbox preview launch did not complete.");
  }
}

/** Build provider-backed tools that verify their project binding on each call. */
export async function resolveProviderProjectBuiltinTools(
  projectId: string,
  target: WorkspaceTarget,
  preview?: import("../tools").ShellPreviewWiring,
  principal?: import("../workspace/target").WorkspacePrincipal,
): Promise<import("../tools").BuiltinToolDef[]> {
  const { getBuiltinToolDefs } = await import("../tools");
  return getBuiltinToolDefs(target, preview, undefined, principal).map(definition => ({
    ...definition,
    execute: async (toolCallId, params, signal, onUpdate) => {
      try {
        const project = await getProject(projectId);
        if (!project) throw new Error("Project workspace is unavailable");
        const current = await resolveProjectWorkspaceTarget(project, "built-in tools", target);
        if (target.kind === "sandbox" && (current.kind !== "sandbox"
          || current.binding.workspaceId !== target.binding.workspaceId
          || current.binding.generation !== target.binding.generation)) {
          throw new Error("Workspace binding changed");
        }
        const command = params && typeof params === "object" ? (params as { command?: unknown }).command : undefined;
        const detected = definition.name === "shell" && typeof command === "string" ? detectDevServerCommand(command) : null;
        if (detected && target.kind === "sandbox" && target.backend?.previews?.startServer
          && target.backend.previews.stopServer && principal?.userId && principal.conversationId) {
          try {
            return await launchProviderPreview(target, { binding: target.binding, userId: principal.userId,
              conversationId: principal.conversationId, argv: ["/bin/sh", "-c", command as string], signal });
          } catch {
            return toolError("Sandbox preview state is unconfirmed. Do not repeat the launch.");
          }
        }
        return await definition.execute(toolCallId, params, signal, onUpdate);
      } catch {
        const { toolError } = await import("../tools/types");
        return toolError("Workspace binding changed; start a new run before retrying.");
      }
    },
  }));
}
