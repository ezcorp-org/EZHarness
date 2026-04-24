import { json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import { getDb } from "$server/db/connection";
import { toolCalls } from "$server/db/schema";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
	const scopeErr = requireScope(locals, "read");
	if (scopeErr) return scopeErr;
	requireAuth(locals);

	const db = getDb();
	const rows = await db
		.select({ output: toolCalls.output })
		.from(toolCalls)
		.where(eq(toolCalls.id, params.id));

	if (rows.length === 0) {
		return errorJson(404, "Not found");
	}

	// Extract text from ToolCallResult shape: { content: [{ type: "text", text: "..." }] }
	const raw: unknown = rows[0]!.output;
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
