import { json } from "@sveltejs/kit";
import { requireSessionAuth } from "$server/auth/middleware";
import { getPersonalPrForRun } from "$server/integrations/github-personal-prs/service";
import { personalPrRouteError } from "../../_route";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals, params }) => {
	const user = requireSessionAuth(locals);
	if (user instanceof Response) return user;
	try {
		return json(await getPersonalPrForRun(user.id, params.runId), { headers: { "cache-control": "no-store" } });
	} catch (error) {
		return personalPrRouteError(error);
	}
};
