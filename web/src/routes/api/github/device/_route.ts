import { json } from "@sveltejs/kit";
import type { z } from "zod";
import { GithubUserError } from "$server/integrations/github-user/transport";
import { readBoundedJson } from "$lib/server/security/bounded-json";

const headers = { "cache-control": "no-store" };

export function deviceJson(body: unknown, status = 200): Response {
	return json(body, { status, headers });
}

export function deviceAuthResponse(response: Response): Response {
	const safeHeaders = new Headers(response.headers);
	safeHeaders.set("cache-control", "no-store");
	return new Response(response.body, { status: response.status, headers: safeHeaders });
}

export function deviceRouteError(error: unknown, fallback: string): Response {
	if (error instanceof GithubUserError) {
		if (error.code === "DEVICE_ATTEMPT_UNAVAILABLE") return deviceJson({ error: "GitHub device authorization is unavailable" }, 404);
		if (error.code === "DEVICE_RESTART_REQUIRED") return deviceJson({ code: "DEVICE_RESTART_REQUIRED", error: "GitHub account lookup failed. Start a new connection." }, 409);
		if (error.code === "SESSION_EXPIRED") return deviceJson({ error: "Sign in again to connect GitHub" }, 403);
		if (error.code === "INVALID_RETURN") return deviceJson({ error: "Invalid review reference" }, 400);
	}
	return deviceJson({ error: fallback }, 503);
}

export async function deviceRequest<T>(
	request: Request,
	userId: string,
	sessionId: string | undefined,
	schema: z.ZodType<T>,
	action: (input: T, userId: string, sessionId: string) => Promise<unknown>,
	fallback: string,
): Promise<Response> {
	if (!sessionId) return deviceJson({ error: "Interactive session required" }, 403);
	try {
		const input = schema.safeParse(await readBoundedJson(request, 1024));
		if (!input.success) return deviceJson({ error: "Invalid device authorization request" }, 400);
		return deviceJson(await action(input.data, userId, sessionId));
	} catch (error) {
		if (error instanceof SyntaxError || error instanceof Response && error.status === 413) return deviceJson({ error: "Invalid device authorization request" }, 400);
		return deviceRouteError(error, fallback);
	}
}
