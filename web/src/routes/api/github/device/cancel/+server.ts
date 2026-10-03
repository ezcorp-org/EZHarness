import { z } from "zod";
import { requireSessionAuth } from "$server/auth/middleware";
import { cancelDeviceAuthorization } from "$server/integrations/github-user/broker";
import { deviceAuthResponse, deviceRequest } from "../_route";
import type { RequestHandler } from "./$types";

const inputSchema = z.strictObject({ attemptId: z.string().uuid() });

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireSessionAuth(locals);
	if (user instanceof Response) return deviceAuthResponse(user);
	return deviceRequest(request, user.id, locals.sessionId, inputSchema,
		(input, userId, sessionId) => cancelDeviceAuthorization({ userId, sessionId, attemptId: input.attemptId }),
		"Could not cancel GitHub connection");
};
