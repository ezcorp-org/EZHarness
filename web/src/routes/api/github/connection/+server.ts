import { json } from "@sveltejs/kit";
import { requireSessionAuth } from "$server/auth/middleware";
import { disconnect, getConnectionStatus } from "$server/integrations/github-user/broker";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
	const user = requireSessionAuth(locals);
	if (user instanceof Response) return user;
	try {
		return json(await getConnectionStatus({ userId: user.id }), { headers: { "cache-control": "no-store" } });
	} catch {
		return json({ error: "GitHub connection is unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
	}
};

export const DELETE: RequestHandler = async ({ locals }) => {
	const user = requireSessionAuth(locals);
	if (user instanceof Response) return user;
	try {
		return json(await disconnect({ userId: user.id }), { headers: { "cache-control": "no-store" } });
	} catch {
		return json({ error: "Could not disconnect GitHub" }, { status: 503, headers: { "cache-control": "no-store" } });
	}
};
