import { json } from "@sveltejs/kit";
import { requireSessionAuth } from "$server/auth/middleware";
import { checkRepository } from "$server/integrations/github-user/broker";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals, url }) => {
	const user = requireSessionAuth(locals);
	if (user instanceof Response) return user;
	const rawId = url.searchParams.get("repositoryId");
	const repositoryId = Number(rawId);
	if (!rawId || !Number.isSafeInteger(repositoryId) || repositoryId <= 0) return json({ error: "Invalid repository ID" }, { status: 400, headers: { "cache-control": "no-store" } });
	try {
		return json(await checkRepository({ userId: user.id, repositoryId }), { headers: { "cache-control": "no-store" } });
	} catch {
		return json({ error: "Could not check repository access" }, { status: 503, headers: { "cache-control": "no-store" } });
	}
};
