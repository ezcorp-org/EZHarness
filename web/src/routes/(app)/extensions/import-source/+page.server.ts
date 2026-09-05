import { error } from "@sveltejs/kit";
import { checkProjectRole, requireSessionAuth } from "$server/auth/middleware";
import { listExtensions } from "$server/db/queries/extensions";
import { listProjects } from "$server/db/queries/projects";
import { getExtensionLifecycle } from "$server/extensions/extension-lifecycle-service";
import { resolveControlActor } from "$lib/server/extensions/control-actor";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, url }) => {
  const user = requireSessionAuth(locals);
  if (user instanceof Response) throw error(403, "Open source imports in a human session.");
  const targets = (await listExtensions()).filter((extension) => extension.creatorUserId === user.id).map(({ id, name }) => ({ id, name }));
  const lifecycle = await getExtensionLifecycle();
  const actor = { principalId: user.id, scope: "global", kind: "human" as const };
  const selectedTarget = url.searchParams.get("installation") ?? "";
  const candidates = (await lifecycle.list(actor)).filter((installation) => !installation.uninstalled).map((installation) => installation.id);
  if (selectedTarget && !candidates.includes(selectedTarget)) candidates.push(selectedTarget);
  for (const installationId of candidates) {
    if (targets.some((target) => target.id === installationId)) continue;
    try {
      const resolved = await resolveControlActor(user, "human", installationId);
      const state = await lifecycle.inspect(resolved, installationId);
      if (state.installation.ownerId !== user.id || state.installation.uninstalled) throw error(404, "Installation not found.");
      const release = Object.values(state.releases).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      targets.push({ id: installationId, name: release?.manifest.name ?? `Unpublished installation · ${installationId.slice(0, 8)}` });
    } catch (cause) {
      if (installationId === selectedTarget) throw error(404, "Installation not found.");
      throw cause;
    }
  }
  targets.sort((left, right) => left.name.localeCompare(right.name));
  const projects = (await Promise.all((await listProjects()).map(async (project) => project.path && !(await checkProjectRole({ user }, project.id, "member") instanceof Response) ? { id: project.id, name: project.name } : null))).filter((project): project is { id: string; name: string } => project !== null);
  return { canCreate: user.role === "admin", targets, projects, selectedTarget };
};
