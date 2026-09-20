import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { eq } from "drizzle-orm";
import { isAbsolute } from "node:path";
import { getDb } from "../../db/connection";
import { projects, projectWorkspaceBindings } from "../../db/schema";

export type WorkspaceTarget =
  | { kind: "local"; root: string; revision: number }
  | { kind: "sandbox"; bindingId: string; projectId: string; revision: number };

export type SandboxWorkspaceOperation = "readFile" | "listFiles" | "readDirectory" | "editFile" | "shell" | "grep" | "glob";
export interface WorkspacePrincipal { userId: string; conversationId: string }

export type SandboxWorkspaceDispatcher = (
  target: Extract<WorkspaceTarget, { kind: "sandbox" }>,
  operation: SandboxWorkspaceOperation,
  params: unknown,
  signal?: AbortSignal,
  principal?: WorkspacePrincipal,
) => Promise<AgentToolResult<unknown>>;

let sandboxDispatcher: SandboxWorkspaceDispatcher | null = null;

/** Host startup supplies the reviewed provider dispatcher after validating
 * the local runtime. Unconfigured sandbox-bound tools deny. */
export function configureSandboxWorkspaceDispatcher(dispatcher: SandboxWorkspaceDispatcher | null): void {
  sandboxDispatcher = dispatcher;
}

export function getSandboxWorkspaceDispatcher(): SandboxWorkspaceDispatcher | null {
  return sandboxDispatcher;
}

/** Resolve the persisted project policy. No caller supplied directory enters
 * this decision: a sandbox binding never carries a host filesystem root. */
export async function resolveWorkspaceTarget(projectId: string, expectedRevision?: number): Promise<WorkspaceTarget> {
  const db = getDb();
  const [project] = await db.select({ id: projects.id, path: projects.path }).from(projects).where(eq(projects.id, projectId));
  if (!project) throw new Error("Project workspace is unavailable");

  const [binding] = await db
    .select()
    .from(projectWorkspaceBindings)
    .where(eq(projectWorkspaceBindings.projectId, projectId));
  if (!binding) {
    if (!project.path || !isAbsolute(project.path)) throw new Error("Project workspace is unavailable");
    return { kind: "local", root: project.path, revision: 0 };
  }
  if (binding.kind !== "sandbox" || binding.state !== "active" || !binding.bindingId) {
    throw new Error("Sandbox workspace is unavailable");
  }
  if (expectedRevision !== undefined && binding.revision !== expectedRevision) {
    throw new Error("Sandbox workspace is unavailable");
  }
  return { kind: "sandbox", bindingId: binding.bindingId, projectId, revision: binding.revision };
}

/** A persisted sandbox binding must never receive direct host adapters. */
export async function projectRequiresSandbox(projectId: string | undefined): Promise<boolean> {
  if (!projectId) return false;
  const [binding] = await getDb()
    .select({ kind: projectWorkspaceBindings.kind, state: projectWorkspaceBindings.state })
    .from(projectWorkspaceBindings)
    .where(eq(projectWorkspaceBindings.projectId, projectId));
  return requiresSandboxBinding(binding);
}

/** A row from a newer engine is never evidence that direct host access is
 * safe. Only no binding means the compatible local target. */
export function requiresSandboxBinding(binding: { kind: string } | undefined): boolean {
  return binding !== undefined;
}
