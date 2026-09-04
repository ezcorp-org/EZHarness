import { error } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { getExtensionLifecycle } from "$server/extensions/extension-lifecycle-service";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ url, locals }) => {
  const user = requireAuth(locals);
  const installationId = url.searchParams.get("installation");
  if (url.searchParams.has("prefill")) throw error(410, "Import legacy drafts into a version 4 workspace before building.");
  const lifecycle = await getExtensionLifecycle();
  const actor = { principalId: user.id, scope: "global", kind: "human" as const };
  if (!installationId) return { installations: await lifecycle.list(actor), state: null, workspace: null, files: {}, canApprove: locals.authMethod === "session" };
  try {
    const state = await lifecycle.inspect(actor, installationId);
    const workspaceId = url.searchParams.get("workspace") ?? Object.values(state.workspaces).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.id;
    const source = workspaceId ? await lifecycle.readWorkspace(actor, installationId, workspaceId) : { workspace: null, files: {} };
    return { installations: [state.installation], state, ...source, canApprove: locals.authMethod === "session" };
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && ["not_found", "forbidden"].includes(String(cause.code))) throw error(404, "Workspace not found.");
    throw cause;
  }
};
