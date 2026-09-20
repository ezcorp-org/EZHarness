import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { getSandboxController } from "$server/runtime/sandbox/controller";
import { sandboxError, statusDto } from "$lib/server/sandbox-route";
import type { RequestHandler } from "./$types";

/** Executes only an already-admitted operation. This endpoint never accepts a driver, path, command, or request body. */
export const POST: RequestHandler = async ({ params, locals }) => {
	const scopeErr = requireScope(locals, "write");
	if (scopeErr) return scopeErr;
	const user = requireAuth(locals);
	try {
		return json(statusDto(await getSandboxController().executeAdmittedLocalSandboxOperation(user.id, params.id)));
	} catch (error) {
		return sandboxError(error);
	}
};
