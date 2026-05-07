/**
 * POST /api/ez-actions/[name]
 *
 * Dispatch endpoint for EZ Actions (`![EZ:name]` runtime sigil).
 * Resolves `[name]` against the in-memory registry, verifies the
 * caller owns the conversation, runs the handler, and persists the
 * result as a synthetic `messages` row with `role: "ez-action-result"`
 * (JSON-encoded `EzActionResult` payload in `content`).
 *
 * Auth: `requireAuth + requireScope("read")` — same pattern as
 * `/api/lessons` (the EZ Actions auth surface mirrors lessons because
 * the v1 set of actions all read or write user-scoped resources). The
 * conversation ownership check is the second gate; we collapse "not
 * found" + "not owned" into 404 per the project's id-enumeration
 * defense pattern.
 *
 * Request body:
 *   { conversationId: string, projectId: string }
 *
 * Response (200):
 *   { result: EzActionResult, messageId: string }
 *
 * Notes on body validation: we accept whatever projectId the client
 * sends but RECONCILE it against the conversation's actual projectId
 * server-side. The handler ALWAYS uses the conversation's projectId
 * — never the body's — so a mismatched/manipulated client payload
 * cannot misdirect the action to a different project.
 */
import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { getConversation, createMessage } from "$server/db/queries/conversations";
import { getEzAction } from "$server/runtime/ez-actions/registry";
import type { EzActionResult } from "$server/runtime/ez-actions/types";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, request, locals }) => {
	const scopeErr = requireScope(locals, "read");
	if (scopeErr) return scopeErr;
	const user = requireAuth(locals);

	const name = params.name;
	if (!name) return errorJson(400, "Missing action name");

	const action = getEzAction(name);
	if (!action) return errorJson(404, "No such EZ action");

	const body = (await request.json().catch(() => null)) as
		| { conversationId?: unknown; projectId?: unknown }
		| null;
	const conversationId =
		typeof body?.conversationId === "string" ? body.conversationId : null;
	if (!conversationId) {
		return errorJson(400, "conversationId is required");
	}

	// Owner gate: collapse "not found" + "not owned" into one 404 so a
	// scanning client can't enumerate conversation ids by status code.
	const conv = await getConversation(conversationId);
	if (!conv) return errorJson(404, "Conversation not found");
	if (conv.userId !== user.id) return errorJson(404, "Conversation not found");

	// Run the handler. The handler is responsible for its own error
	// containment — every documented decline / error path returns a
	// card. An UNCAUGHT throw is a handler bug; collapse it to a 500
	// + minimal response (no internal detail leak).
	let result: EzActionResult;
	try {
		result = await action.handler({
			conversationId,
			userId: user.id,
			// Use the conversation's projectId, NOT the body's. The body
			// projectId is accepted for client-side convenience but we
			// never trust it.
			projectId: conv.projectId,
		});
	} catch (err) {
		return errorJson(500, "EZ action handler failed", {
			detail: (err as Error).message,
		});
	}

	// Persist the result as a synthetic message so it's part of
	// conversation history (renders inline; survives reload). We use
	// `role: "ez-action-result"` (free-text role column — no schema
	// migration needed) and JSON-encode the EzActionResult into
	// `content`. The chat renderer special-cases this role.
	const persisted = await createMessage(conversationId, {
		role: "ez-action-result",
		content: JSON.stringify(result),
	});

	return json({ result, messageId: persisted.id });
};
