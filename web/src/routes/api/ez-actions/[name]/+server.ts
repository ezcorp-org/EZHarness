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
import { getConversation, createMessage, getLatestLeaf } from "$server/db/queries/conversations";
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

	// Resolve the conversation's current leaf so the synthetic
	// ez-action-result row hangs off the latest message in the branch.
	// Without this, a direct dispatcher invocation produces an orphan
	// row (parent_message_id = null) that can drift in the branched-
	// conversation render path. The submit-time handler in
	// /api/conversations/[id]/messages parents under the just-persisted
	// user message; the dispatcher has no preceding user message, so the
	// branch leaf is the canonical anchor. `null` (empty conversation)
	// is fine — the row simply has no parent.
	const leaf = await getLatestLeaf(conversationId);
	const parentMessageId = leaf?.id;

	// Run the handler. Handlers are expected to return decline / error
	// result cards rather than throw; an uncaught throw is a handler
	// bug. Mirror the submit-time pattern (messages/+server.ts:290): on
	// throw, synthesize an `error` result card so the user STILL sees a
	// card (not a bare HTTP 500). Every action invocation yields a card
	// — that's the contract — so HTTP 5xx is reserved for genuine
	// transport / persistence failures.
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
		result = {
			kind: "error",
			card: {
				title: "Action failed",
				body: `The "${name}" action threw an unexpected error.`,
				variant: "error",
			},
		};
		// We intentionally do NOT bubble (err as Error).message into the
		// card — the submit-time path doesn't either, and exposing
		// internal error text via an unauthenticated chat-renderable
		// row is the kind of leak that lands on a security review. The
		// detail is captured server-side by the request log.
		console.error("[ez-actions] handler threw", { name, error: String(err) });
	}

	// Persist the result as a synthetic message so it's part of
	// conversation history (renders inline; survives reload). We use
	// `role: "ez-action-result"` (free-text role column — no schema
	// migration needed) and JSON-encode the EzActionResult into
	// `content`. The chat renderer special-cases this role.
	const persisted = await createMessage(conversationId, {
		role: "ez-action-result",
		content: JSON.stringify(result),
		parentMessageId,
	});

	return json({ result, messageId: persisted.id });
};
