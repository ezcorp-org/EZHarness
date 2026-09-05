import { json } from "@sveltejs/kit";
import { desc, eq } from "drizzle-orm";
import { getDb } from "$server/db/connection";
import { toolCalls } from "$server/db/schema";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { resolveRootConversationForOwnership } from "$lib/server/conversation-ownership";
import type { RequestHandler } from "./$types";

const OUTPUT_COLUMNS = {
	output: toolCalls.output,
	userId: toolCalls.userId,
	conversationId: toolCalls.conversationId,
} as const;

export const GET: RequestHandler = async ({ params, locals }) => {
	const scopeErr = requireScope(locals, "read");
	if (scopeErr) return scopeErr;
	const user = requireAuth(locals);

	const db = getDb();
	// `params.id` is whatever `toolCallRowToSummary` exposed as the card's
	// client-visible id — the row's own PK for an extension tool, but a
	// built-in tool's PROVIDER WIRE id (see `toolCalls.providerToolCallId`'s
	// doc in schema.ts). Try the PK first (cheap, unambiguous); a miss falls
	// back to the wire-id column, most-recent-first, because that value is
	// deliberately NOT unique — the ownership check below stays fail-closed
	// if that fallback ever resolves to the wrong tenant's row.
	let rows = await db
		.select(OUTPUT_COLUMNS)
		.from(toolCalls)
		.where(eq(toolCalls.id, params.id))
		.limit(1);

	if (rows.length === 0) {
		rows = await db
			.select(OUTPUT_COLUMNS)
			.from(toolCalls)
			.where(eq(toolCalls.providerToolCallId, params.id))
			.orderBy(desc(toolCalls.createdAt))
			.limit(1);
	}

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
