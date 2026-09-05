import { error } from "@sveltejs/kit";
import { checkProjectRole, requireAuth } from "$server/auth/middleware";
import { getExtensionLifecycle } from "$server/extensions/extension-lifecycle-service";
import { getExtensionProjectBinding } from "$server/extensions/project-binding";
import { listProjects } from "$server/db/queries/projects";
import { resolveControlActor } from "$lib/server/extensions/control-actor";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ url, locals }) => {
  const user = requireAuth(locals);
  const installationId = url.searchParams.get("installation");
  if (url.searchParams.has("prefill")) throw error(410, "Import legacy drafts into a version 4 workspace before building.");
  const lifecycle = await getExtensionLifecycle();
  const actor = { principalId: user.id, scope: "global", kind: "human" as const };
  const canApprove = locals.authMethod === "session" && user.role === "admin";
  if (!installationId) return { installations: await lifecycle.list(actor), state: null, workspace: null, files: {}, canApprove, canBindProject: false, projects: [], projectBinding: null };
  try {
    actor.scope = (await resolveControlActor(user, "human", installationId)).scope;
    const state = await lifecycle.inspect(actor, installationId);
    const workspaceId = url.searchParams.get("workspace") ?? Object.values(state.workspaces).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.id;
    const source = workspaceId ? await lifecycle.readWorkspace(actor, installationId, workspaceId) : { workspace: null, files: {} };
    const projects = (await Promise.all((await listProjects()).map(async project => project.path && !(await checkProjectRole({ user }, project.id, "member") instanceof Response) ? { id: project.id, name: project.name } : null))).filter((project): project is { id: string; name: string } => project !== null);
    return { installations: [state.installation], state, ...source, canApprove, canBindProject: locals.authMethod === "session" && state.installation.ownerId === user.id, projects, projectBinding: await getExtensionProjectBinding(installationId) };
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && ["not_found", "forbidden"].includes(String(cause.code))) throw error(404, "Workspace not found.");
    throw cause;
  }
};
