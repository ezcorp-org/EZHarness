/**
 * Builds a `CommandResolver` bound to the active user + project, using
 * the process-wide `CommandRegistry` from `context.ts`. This wrapper
 * exists so the two chat submit endpoints can pass a uniform resolver
 * into `executor.streamChat` without each reimplementing the same
 * project-path resolution + registry lookup.
 */

import { resolve } from "node:path";
import { getCommandRegistry } from "$lib/server/context";
import * as projectQueries from "$server/db/queries/projects";
import type { CommandResolver } from "$server/runtime/mention-wiring";

export function buildCommandResolver(
  userId: string,
  projectId: string | null | undefined,
): CommandResolver {
  return async (name) => {
    let projectPath: string | null = null;
    if (projectId) {
      try {
        const project = await projectQueries.getProject(projectId);
        projectPath = project?.path ? resolve(project.path) : null;
      } catch {
        projectPath = null;
      }
    }
    const registry = getCommandRegistry();
    const found = await registry.findCommand({
      name,
      userId,
      projectId: projectId ?? "global",
      projectPath,
    });
    if (!found) return null;
    return { body: found.body, frontmatter: found.frontmatter };
  };
}
