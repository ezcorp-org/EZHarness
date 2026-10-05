import { json } from "@sveltejs/kit";
import { requireSessionAuth } from "$server/auth/middleware";
import { listAccessibleRepositories } from "$server/integrations/github-user/broker";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
	const user = requireSessionAuth(locals);
	if (user instanceof Response) return user;
	try {
		return json({ repositories: await listAccessibleRepositories({ userId: user.id }) }, { headers: { "cache-control": "no-store" } });
	} catch {
		return json({ error: "Could not load GitHub repositories" }, { status: 503, headers: { "cache-control": "no-store" } });
	}
};
