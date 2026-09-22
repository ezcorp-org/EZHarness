import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { getSandboxController } from "$server/runtime/sandbox/controller";
import { providerDto, sandboxError } from "$lib/server/sandbox-route";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
	const scopeErr = requireScope(locals, "read");
	if (scopeErr) return scopeErr;
	const user = requireAuth(locals);
	try {
		return json({ providers: (await getSandboxController().listLocalSandboxProviders(user.id)).map(providerDto) });
	} catch (error) {
		return sandboxError(error);
	}
};
