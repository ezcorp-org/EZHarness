/**
 * Shared helpers for the import-wizard endpoints (`preview` + `commit`).
 * Not a route — SvelteKit only treats `+server.ts` / `+page.*` as
 * endpoints, so this plain module is safe to live alongside them.
 */

import { resolve } from "node:path";
import { errorJson } from "$lib/server/http-errors";
import { getProject } from "$server/db/queries/projects";

/** Abandoned-preview sweep threshold (1h). */
export const STALE_STAGING_MS = 60 * 60 * 1000;

/**
 * Resolve the active project's absolute root. The wizard requires a
 * concrete project (extensions install under `<projectRoot>/.ezcorp`),
 * so `"global"` / missing is a 400 — not a silent fallback.
 */
export async function resolveProjectRoot(
  projectId: unknown,
): Promise<{ root: string } | { err: Response }> {
  if (
    typeof projectId !== "string" ||
    projectId.length === 0 ||
    projectId === "global"
  ) {
    return {
      err: errorJson(
        400,
        "Select a project first — imports install under a project, not the global scope.",
      ),
    };
  }
  const project = await getProject(projectId);
  if (!project?.path) {
    return { err: errorJson(404, "Project not found or has no path") };
  }
  return { root: resolve(project.path) };
}

/**
 * Slugify a discovered command's filename stem into the DB
 * slash-command rule `/^[a-z0-9][a-z0-9-_]{0,63}$/` (no dots — unlike
 * skill extension names). `createUserCommand` still de-dupes via its
 * own `-2` suffixing.
 */
export function slugifyCommandName(raw: string): string {
  const s = raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[-_]+$/g, "")
    .slice(0, 64)
    .replace(/[-_]+$/g, "");
  return s.length > 0 ? s : "command";
}

/** Stable id pairing a discovered command's source + name. */
export function commandId(source: string, name: string): string {
  return `${source}|${name}`;
}
