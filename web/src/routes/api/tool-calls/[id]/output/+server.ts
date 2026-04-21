import { json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import { getDb } from "$server/db/connection";
import { toolCalls } from "$server/db/schema";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
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
		return json({ error: "Not found" }, { status: 404 });
	}

	// Extract text from ToolCallResult shape: { content: [{ type: "text", text: "..." }] }
	const raw = rows[0]!.output;
	let output: unknown = raw;
	if (raw && typeof raw === "object" && Array.isArray((raw as any).content)) {
		const texts = ((raw as any).content as any[])
			.filter((c: any) => c.type === "text" && typeof c.text === "string")
			.map((c: any) => c.text);
		if (texts.length > 0) output = texts.join("\n");
	}

	return json({ output });
};
