import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireScope } from "$lib/server/security/api-keys";

export const POST: RequestHandler = async ({ request, locals }) => {
	const scopeErr = requireScope(locals, "chat");
	if (scopeErr) return scopeErr;

	const { requestId, response } = await request.json();
	const { resolveHumanInput } = await import("$server/runtime/tools/ask-human");
	resolveHumanInput(requestId, response);

	return json({ ok: true });
};
