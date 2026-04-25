import { json } from "@sveltejs/kit";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { getBus } from "$lib/server/context";
import {
	getPendingHumanConversationId,
	clearPendingHumanInput,
} from "$server/runtime/ask-human-registry";

// Boundary validation. POST mirrors the
// `orchestrator:human_response` event shape — `requestId` keys into
// the pending registry, `response` flows verbatim onto the bus.
// Strict mode rejects unknown keys. Stale/unknown requestIds remain
// the short-circuit `{ ok: true }` path (no body check raises 400 for
// the existing test contract).
const postBodySchema = z.object({
	requestId: z.string(),
	response: z.string(),
}).strict();

export const POST: RequestHandler = async ({ request, locals }) => {
	requireAuth(locals);
	const scopeErr = requireScope(locals, "chat");
	if (scopeErr) return scopeErr;

	const parsed = postBodySchema.safeParse(await request.json().catch(() => ({})));
	if (!parsed.success) {
		return errorJson(400, "requestId and response are required");
	}
	const { requestId, response } = parsed.data;

	// Reverse-map requestId → conversationId through the host-side shadow
	// registry populated by `task-events-handler.ts`' Phase 5
	// `orchestrator:human_input` branch. If the entry is missing the
	// extension's gate has already collapsed (timeout, abort, restart) —
	// return ok so the UI's optimistic dismissal doesn't raise a spurious
	// error. Phase 5 commit 4: the legacy built-in ask-human tool is
	// deleted; the extension's subscription handler is the sole gate.
	const conversationId = getPendingHumanConversationId(requestId);
	if (!conversationId) {
		return json({ ok: true });
	}

	getBus().emit("orchestrator:human_response", {
		requestId,
		response,
		conversationId,
	});
	clearPendingHumanInput(requestId);

	return json({ ok: true });
};
