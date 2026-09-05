import { json } from "@sveltejs/kit";
import { requireSessionAuth } from "$server/auth/middleware";
import { setExtensionProjectBinding } from "$server/extensions/project-binding";
import { extensionControlError } from "$lib/server/extensions/control-errors";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, locals, params }) => {
  try {
    const user = requireSessionAuth(locals);
    if (user instanceof Response) return user;
    const body = await request.json();
    if (!body || typeof body !== "object" || typeof body.releaseId !== "string" || typeof body.generation !== "number" || !(body.projectId === null || typeof body.projectId === "string")) return json({ code: "invalid_input", message: "Provide projectId, releaseId and generation." }, { status: 400 });
    return json(await setExtensionProjectBinding({ principalId: user.id, scope: "global", kind: "human" }, { installationId: params.installationId, projectId: body.projectId, releaseId: body.releaseId, generation: body.generation }));
  } catch (error) { return extensionControlError(error); }
};
