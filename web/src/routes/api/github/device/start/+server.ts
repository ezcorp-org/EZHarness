import { z } from "zod";
import { requireSessionAuth } from "$server/auth/middleware";
import { startDeviceAuthorization } from "$server/integrations/github-user/broker";
import { deviceAuthResponse, deviceRequest } from "../_route";
import type { RequestHandler } from "./$types";

const inputSchema = z.strictObject({ returnReviewId: z.string().uuid().optional() });

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireSessionAuth(locals);
	if (user instanceof Response) return deviceAuthResponse(user);
	return deviceRequest(request, user.id, locals.sessionId, inputSchema,
		(input, userId, sessionId) => startDeviceAuthorization({ userId, sessionId, ...input }),
		"Could not start GitHub connection");
};
