import { json } from "@sveltejs/kit";
import { z } from "zod";
import { requireSessionAuth } from "$server/auth/middleware";
import { startAuthorization } from "$server/integrations/github-user/broker";
import { readBoundedJson } from "$lib/server/security/bounded-json";
import type { RequestHandler } from "./$types";

const inputSchema = z.strictObject({ returnReviewId: z.string().uuid().optional() });

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireSessionAuth(locals);
	if (user instanceof Response) return user;
	const sessionId = (locals as typeof locals & { sessionId?: string }).sessionId;
	if (!sessionId) return json({ error: "Interactive session required" }, { status: 403, headers: { "cache-control": "no-store" } });
	try {
		const input = inputSchema.safeParse(await readBoundedJson(request, 1024));
		if (!input.success) return json({ error: "Invalid authorization request" }, { status: 400, headers: { "cache-control": "no-store" } });
		return json(await startAuthorization({ userId: user.id, sessionId, ...input.data }), { headers: { "cache-control": "no-store" } });
	} catch (error) {
		if (error instanceof SyntaxError || error instanceof Response && error.status === 413) return json({ error: "Invalid authorization request" }, { status: 400, headers: { "cache-control": "no-store" } });
		return json({ error: "Could not start GitHub authorization" }, { status: 503, headers: { "cache-control": "no-store" } });
	}
};
