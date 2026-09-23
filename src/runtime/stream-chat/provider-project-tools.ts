import { getProject } from "../../db/queries/projects";
import { resolveProjectWorkspaceTarget } from "../workspaces/project-target";
import type { WorkspaceTarget } from "../workspaces/target";

/** Build provider-backed tools that verify their project binding on each call. */
export async function resolveProviderProjectBuiltinTools(
  projectId: string,
  target: WorkspaceTarget,
  preview?: import("../tools").ShellPreviewWiring,
): Promise<import("../tools").BuiltinToolDef[]> {
  const { getBuiltinToolDefs } = await import("../tools");
  return getBuiltinToolDefs(target, preview).map(definition => ({
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
        return await definition.execute(toolCallId, params, signal, onUpdate);
      } catch {
        const { toolError } = await import("../tools/types");
        return toolError("Workspace binding changed; start a new run before retrying.");
      }
    },
  }));
}
