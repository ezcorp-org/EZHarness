import { eq } from "drizzle-orm";

import { getDb } from "../../db/connection";
import { sandboxBindings } from "../../db/schema";
import { projectRequiresSandbox } from "../workspace/target";
import {
  localWorkspaceTarget,
  resolveWorkspaceTarget,
  sandboxCapabilityUnavailable,
  type LocalWorkspaceTarget,
  type WorkspaceTarget,
} from "./target";

/** Resolve project execution from durable host state before any file or shell
 * provider is selected. A supplied in-process sandbox handle must match the
 * active binding fields the controller persists. */
export async function resolveProjectWorkspaceTarget(
  project: { id: string; path: string | null | undefined },
  operation: string,
  requestedTarget?: WorkspaceTarget,
  workingDir?: string,
): Promise<WorkspaceTarget> {
  // The earlier local-sandbox binding has its own dispatcher. Never infer a
  // host-local target from this project's path while that binding exists.
  if (await projectRequiresSandbox(project.id)) throw sandboxCapabilityUnavailable(operation);
  const [binding] = await getDb()
    .select()
    .from(sandboxBindings)
    .where(eq(sandboxBindings.projectId, project.id))
    .limit(1);
  if (binding) {
    if (
      requestedTarget?.kind !== "sandbox"
      || requestedTarget.binding.projectId !== project.id
      || requestedTarget.binding.connectionId !== binding.connectionId
      || requestedTarget.binding.generation !== binding.generation
      || !binding.resourceKey
      || requestedTarget.binding.workspaceId !== binding.resourceKey
      || binding.desiredState !== "RUNNING"
      || binding.observedState !== "RUNNING"
    ) {
      throw sandboxCapabilityUnavailable(operation);
    }
    return requestedTarget;
  }
  if (requestedTarget?.kind === "sandbox") throw sandboxCapabilityUnavailable(operation);
  if (!project.path) throw new Error(`Project path is unavailable for ${operation}`);
  return resolveWorkspaceTarget({
    projectPath: project.path,
    workingDir,
    requestedTarget,
  });
}

/**
 * Select a host-local target only after proving the project has no durable
 * sandbox binding. The web routes use this until the live adapter can inject
 * a qualified backend target. A project path alone never overrides a binding.
 */
export async function resolveLocalProjectTarget(
  project: { id: string; path: string | null | undefined },
  operation: string,
): Promise<LocalWorkspaceTarget> {
  const target = await resolveProjectWorkspaceTarget(project, operation);
  if (target.kind !== "local") throw sandboxCapabilityUnavailable(operation);
  return localWorkspaceTarget(target.root);
}
