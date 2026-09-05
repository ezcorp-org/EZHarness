import { json } from "@sveltejs/kit";
import { requireSessionAuth } from "$server/auth/middleware";
import { getExtensionLifecycle } from "$server/extensions/extension-lifecycle-service";
import { extensionControlError } from "$lib/server/extensions/control-errors";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, locals, params }) => {
  try {
    const user = requireSessionAuth(locals);
    if (user instanceof Response) return user;
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || !("approvalId" in body) || typeof body.approvalId !== "string" || !("decision" in body) || typeof body.decision !== "boolean") return json({ code: "invalid_input", message: "Provide approvalId and a boolean decision." }, { status: 400 });
    return json(await (await getExtensionLifecycle()).approve({ principalId: user.id, scope: "global", kind: "human" }, params.installationId, body.approvalId, body.decision));
  } catch (error) {
    return extensionControlError(error);
  }
};
