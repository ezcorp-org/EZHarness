import { json } from "@sveltejs/kit";
import { requireSessionAuth } from "$server/auth/middleware";
import { completeAuthorization } from "$server/integrations/github-user/broker";
import { getPersonalPrForReviewId } from "$server/integrations/github-personal-prs/service";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals, url }) => {
	const user = requireSessionAuth(locals);
	if (user instanceof Response) return user;
	const sessionId = (locals as typeof locals & { sessionId?: string }).sessionId;
	if (!sessionId) return json({ error: "Interactive session required" }, { status: 403, headers: { "cache-control": "no-store" } });
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	if (!code || !state || code.length > 2048 || state.length > 256) return json({ error: "Invalid GitHub callback" }, { status: 400, headers: { "cache-control": "no-store" } });
	try {
		const completed = await completeAuthorization({ userId: user.id, state, code, sessionId });
		let destination = "/settings/github?connected=1";
		if (completed.returnReviewId) {
			try {
				const review = await getPersonalPrForReviewId(user.id, completed.returnReviewId);
				if (review.reviewPath && /^\/(?:project|chat)\/[a-zA-Z0-9_/-]+(?:\?review=[a-zA-Z0-9-]+)?$/.test(review.reviewPath)) destination = review.reviewPath;
			} catch { /* The connection remains valid; Settings is the safe return. */ }
		}
		return new Response(null, { status: 303, headers: { location: new URL(destination, url.origin).href, "cache-control": "no-store" } });
	} catch {
		return json({ error: "GitHub authorization failed or expired" }, { status: 400, headers: { "cache-control": "no-store" } });
	}
};
