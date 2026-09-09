import { error, redirect } from "@sveltejs/kit";
import { requireSessionAuth, checkProjectRole } from "$server/auth/middleware";
import { createConversation, listRecentConversationsForUser } from "$server/db/queries/conversations";
import { getProject, listProjects } from "$server/db/queries/projects";
import { ensureInitialized } from "$lib/server/context";
import { authorizeExtensionBrowser, extensionBrowserBundle } from "$lib/server/extension-browser";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, params, url, setHeaders }) => {
  const user = requireSessionAuth(locals);
  if (user instanceof Response) throw error(403, "Open extension previews in a human session.");
  await ensureInitialized();
  const conversationId = url.searchParams.get("conversationId") || undefined;
  try {
    const authority = await authorizeExtensionBrowser(params.id, user.id, conversationId);
    const bundle = await extensionBrowserBundle(authority.active.release.artifactDigest);
    const scope = authority.active.installation.scope;
    const projects = (await Promise.all((await listProjects()).map(async project => (scope === "global" || scope === `project:${project.id}`) && !(await checkProjectRole({ user }, project.id, "member") instanceof Response) ? { id: project.id, name: project.name } : null))).filter(project => project !== null);
    const conversations = (await listRecentConversationsForUser(user.id, { limit: 100 })).filter(conversation => projects.some(project => project.id === conversation.projectId)).map(({ id, title, projectId }) => ({ id, title, projectId }));
    setHeaders({ "Cache-Control": "private, no-store", "Permissions-Policy": "camera=(self), microphone=(), geolocation=()" });
    return { name: authority.extension.name, binding: authority.binding, nonce: crypto.randomUUID(), conversationId: conversationId ?? null, tools: bundle.spec.tools, conversations, projects };
  } catch { throw error(404, "Extension preview is unavailable or access changed."); }
};

export const actions: Actions = {
  create: async ({ locals, params, request }) => {
    const user = requireSessionAuth(locals);
    if (user instanceof Response) throw error(403, "A human session is required.");
    await ensureInitialized();
    const projectId = (await request.formData()).get("projectId");
    if (typeof projectId !== "string" || !await getProject(projectId) || await checkProjectRole({ user }, projectId, "member") instanceof Response) throw error(404, "Project not found.");
    const authority = await authorizeExtensionBrowser(params.id, user.id);
    if (authority.active.installation.scope !== "global" && authority.active.installation.scope !== `project:${projectId}`) throw error(403, "Select the extension's project.");
    const conversation = await createConversation(projectId, { userId: user.id, title: `${authority.extension.name} preview` });
    throw redirect(303, `/extensions/${encodeURIComponent(authority.extension.name)}/preview?conversationId=${encodeURIComponent(conversation.id)}`);
  },
};
