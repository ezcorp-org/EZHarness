import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { getSandboxController } from "$server/runtime/sandbox/controller";
import { errorJson } from "$lib/server/http-errors";
import { sandboxError } from "$lib/server/sandbox-route";
import type { RequestHandler } from "./$types";

/** Executes only an already-admitted operation. This endpoint never accepts a driver, path, command, or request body. */
export const POST: RequestHandler = async ({ params, locals, request }) => {
	const scopeErr = requireScope(locals, "write");
	if (scopeErr) return scopeErr;
	const user = requireAuth(locals);
	if (locals.authMethod !== "internal") return errorJson(403, "Sandbox host dispatch requires the reviewed extension broker");
	try {
		return json(await getSandboxController().executeAdmittedLocalSandboxOperationRaw(user.id, params.id, request.signal));
	} catch (error) {
		return sandboxError(error);
	}
};
