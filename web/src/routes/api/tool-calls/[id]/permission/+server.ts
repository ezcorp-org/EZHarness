import type { RequestHandler } from "./$types";
import { requireScope } from "$lib/server/security/api-keys";
import { requireAuth } from "$server/auth/middleware";

export const POST: RequestHandler = async ({ params, request, locals }) => {
	const scopeErr = requireScope(locals, "chat");
	if (scopeErr) return scopeErr;
	// sec-H2: require an authenticated user and enforce ownership inside
	// handleToolPermission — pre-fix any caller could approve/deny a gate.
	const user = requireAuth(locals);
	const { handleToolPermission } = await import("$server/routes/tool-permission");
	return handleToolPermission(request, params.id, user);
};
