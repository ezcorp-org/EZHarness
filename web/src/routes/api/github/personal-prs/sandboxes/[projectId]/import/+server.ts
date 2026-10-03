import { json } from "@sveltejs/kit";
import { z } from "zod";
import { requireSessionAuth } from "$server/auth/middleware";
import { importApprovedRepository } from "$server/integrations/github-personal-prs/service";
import { readBoundedJson } from "$lib/server/security/bounded-json";
import { personalPrRouteError } from "../../../_route";
import type { RequestHandler } from "./$types";

const schema = z.strictObject({ repositoryId: z.number().int().positive().safe(), baseRef: z.string().min(1).max(255), idempotencyKey: z.string().uuid() });

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireSessionAuth(locals);
	if (user instanceof Response) return user;
	try {
		const input = schema.safeParse(await readBoundedJson(request, 2048));
		if (!input.success) return json({ code: "invalid_input", error: "Invalid repository import" }, { status: 400, headers: { "cache-control": "no-store" } });
		return json(await importApprovedRepository(user.id, { projectId: params.projectId, ...input.data }), { headers: { "cache-control": "no-store" } });
	} catch (error) {
		return personalPrRouteError(error);
	}
};
