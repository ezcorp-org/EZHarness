import { json } from "@sveltejs/kit";
import { requireSessionAuth } from "$server/auth/middleware";
import { getPersonalPrForReviewId } from "$server/integrations/github-personal-prs/service";
import { personalPrRouteError } from "../../_route";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals, params }) => {
	const user = requireSessionAuth(locals);
	if (user instanceof Response) return user;
	try {
		return json(await getPersonalPrForReviewId(user.id, params.id), { headers: { "cache-control": "no-store" } });
	} catch (error) {
		return personalPrRouteError(error);
	}
};
