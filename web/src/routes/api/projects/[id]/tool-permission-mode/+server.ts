import type { RequestHandler } from "./$types";
import { getBus } from "$lib/server/context";
import { requireScope } from "$lib/server/security/api-keys";

export const GET: RequestHandler = async ({ params, request, locals }) => {
	const scopeErr = requireScope(locals, "read");
	if (scopeErr) return scopeErr;
	const { handleGetPermissionMode } = await import("$server/routes/tool-permission");
	return handleGetPermissionMode(request, params.id);
};

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const scopeErr = requireScope(locals, "chat");
	if (scopeErr) return scopeErr;
	const { handleSetPermissionMode } = await import("$server/routes/tool-permission");
	const bus = getBus();
	return handleSetPermissionMode(request, params.id, {
		onModeChange: (mode, conversationId) => {
			if (conversationId) {
				bus.emit("tool:permission_mode_change" as any, { conversationId, mode });
			}
		},
	});
};
