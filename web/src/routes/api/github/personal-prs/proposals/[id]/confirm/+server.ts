import { json } from "@sveltejs/kit";
import { z } from "zod";
import { requireSessionAuth } from "$server/auth/middleware";
import { confirmPersonalPr } from "$server/integrations/github-personal-prs/service";
import { readBoundedJson } from "$lib/server/security/bounded-json";
import { personalPrRouteError } from "../../../_route";
import type { RequestHandler } from "./$types";

const schema = z.strictObject({
	expectedDigest: z.string().min(32).max(128),
	title: z.string().trim().min(1).max(256),
	body: z.string().max(16_384),
	idempotencyKey: z.string().uuid(),
});

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireSessionAuth(locals);
	if (user instanceof Response) return user;
	try {
		const input = schema.safeParse(await readBoundedJson(request, 18_432));
		if (!input.success) return json({ code: "invalid_input", error: "Invalid pull request confirmation" }, { status: 400, headers: { "cache-control": "no-store" } });
		return json(await confirmPersonalPr(user.id, { proposalId: params.id, ...input.data }), { headers: { "cache-control": "no-store" } });
	} catch (error) {
		return personalPrRouteError(error);
	}
};
