import { error, fail } from "@sveltejs/kit";
import { requireSessionAuth } from "$server/auth/middleware";
import { getProjectPullRequests } from "$server/extensions/project-pull-request-broker";
import { LifecycleError } from "$server/extensions/v4/types";
import type { Actions, PageServerLoad } from "./$types";

function actor(locals: App.Locals) {
  const user = requireSessionAuth(locals);
  if (user instanceof Response) error(user.status, "A human session is required.");
  return { principalId: user.id, scope: "global", kind: "human" as const };
}

export const load: PageServerLoad = async ({ locals, params }) => {
  try { return await getProjectPullRequests().inspect(actor(locals), params.id); }
  catch (cause) { error(403, cause instanceof LifecycleError ? cause.message : "This project proposal cannot be reviewed."); }
};

export const actions: Actions = {
  default: async ({ locals, params, request }) => {
    const principal = actor(locals);
    const form = await request.formData();
    const decision = form.get("decision");
    const digest = form.get("digest");
    if (!["finalize", "close", "reject"].includes(String(decision)) || typeof digest !== "string" || form.get("reviewed") !== "yes") return fail(400, { message: "Review the exact commit and file list, then select an action." });
    try {
      await getProjectPullRequests().decide(principal, params.id, decision as "finalize" | "close" | "reject", digest);
      return { message: "Decision recorded. Return to the extension to update its loop status." };
    } catch (cause) { return fail(409, { message: cause instanceof LifecycleError ? cause.message : "The operation failed. Verify any partial GitHub effects manually." }); }
  },
};
