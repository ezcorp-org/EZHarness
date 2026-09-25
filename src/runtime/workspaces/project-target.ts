import { eq } from "drizzle-orm";

import { getDb } from "../../db/connection";
import { sandboxBindings, type SandboxBinding } from "../../db/schema";
import { projectRequiresSandbox } from "../workspace/target";
import {
  localWorkspaceTarget,
  resolveWorkspaceTarget,
  sandboxCapabilityUnavailable,
  sandboxWorkspaceTarget,
  sameSandboxWorkspaceBinding,
  type LocalWorkspaceTarget,
  type SandboxWorkspaceTarget,
  type WorkspaceTarget,
} from "./target";

/** Installed by the host after it has resolved the approved provider release
 * and its connection. Tool arguments never participate in this selection. */
export type SandboxWorkspaceTargetResolver = (
  binding: Readonly<SandboxBinding>,
) => Promise<SandboxWorkspaceTarget | null>;

let sandboxTargetResolver: SandboxWorkspaceTargetResolver | null = null;

export function setSandboxWorkspaceTargetResolver(
  resolver: SandboxWorkspaceTargetResolver | null,
): void {
  sandboxTargetResolver = resolver;
}

function matchesPersistedBinding(
  target: SandboxWorkspaceTarget,
  projectId: string,
  binding: SandboxBinding,
): boolean {
  return target.binding.projectId === projectId
    && target.binding.connectionId === binding.connectionId
    && target.binding.generation === binding.generation
    && target.binding.workspaceId === binding.resourceKey;
}

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
    if (!binding.resourceKey || binding.tombstonedAt
      || binding.desiredState !== "RUNNING" || binding.observedState !== "RUNNING") {
      throw sandboxCapabilityUnavailable(operation);
    }
    if (requestedTarget?.kind === "sandbox") {
      if (!matchesPersistedBinding(requestedTarget, project.id, binding)) {
        throw sandboxCapabilityUnavailable(operation);
      }
      if (sandboxTargetResolver) {
        const current = await sandboxTargetResolver(binding);
        if (!current || !matchesPersistedBinding(current, project.id, binding)
          || !sameSandboxWorkspaceBinding(current.binding, requestedTarget.binding)) {
          throw sandboxCapabilityUnavailable(operation);
        }
      }
      return requestedTarget;
    }
    if (!sandboxTargetResolver) throw sandboxCapabilityUnavailable(operation);
    const resolved = await sandboxTargetResolver(binding);
    if (!resolved || !matchesPersistedBinding(resolved, project.id, binding)) {
      throw sandboxCapabilityUnavailable(operation);
    }
    return sandboxWorkspaceTarget(resolved.binding, resolved.backend);
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
