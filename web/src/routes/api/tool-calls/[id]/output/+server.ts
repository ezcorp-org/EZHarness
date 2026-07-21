import { json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import { getDb } from "$server/db/connection";
import { toolCalls } from "$server/db/schema";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { resolveRootConversationForOwnership } from "$lib/server/conversation-ownership";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
	const scopeErr = requireScope(locals, "read");
	if (scopeErr) return scopeErr;
	const user = requireAuth(locals);

	const db = getDb();
	const rows = await db
		.select({
			output: toolCalls.output,
			userId: toolCalls.userId,
			conversationId: toolCalls.conversationId,
		})
		.from(toolCalls)
		.where(eq(toolCalls.id, params.id));

	if (rows.length === 0) {
		return errorJson(404, "Not found");
	}

	// IDOR guard (parity with the tool-call permission route, sec-H2): tool
	// outputs carry file reads / shell output / extension results, so a caller
	// who merely learns another tenant's tool-call id must not read it.
	// Fail-closed owner-or-admin 404. Prefer the conversation-root walk (handles
	// sub-conversation tool calls whose row.userId is null); fall back to the
	// row's own userId only when the tool call isn't bound to a conversation.
	const row = rows[0]!;
	let owns: boolean;
	if (row.conversationId) {
		owns = (await resolveRootConversationForOwnership(row.conversationId, user)) !== null;
	} else {
		owns = row.userId === user.id || user.role === "admin";
	}
	if (!owns) {
		return errorJson(404, "Not found");
	}

	// Extract text from ToolCallResult shape: { content: [{ type: "text", text: "..." }] }
	const raw: unknown = row.output;
	let output: unknown = raw;
	if (raw && typeof raw === "object" && "content" in raw) {
		const content = (raw as { content: unknown }).content;
		if (Array.isArray(content)) {
			const texts = content
				.filter(
					(c): c is { type: "text"; text: string } =>
						typeof c === "object" &&
						c !== null &&
						(c as { type?: unknown }).type === "text" &&
						typeof (c as { text?: unknown }).text === "string",
				)
				.map((c) => c.text);
			if (texts.length > 0) output = texts.join("\n");
		}
	}

	return json({ output });
};
