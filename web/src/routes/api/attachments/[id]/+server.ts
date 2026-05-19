/**
 * Stream bytes for a message attachment by id.
 *
 * Access control: the caller must own the owning conversation (or be admin).
 * Mirrors the fail-closed ownership check used by the messages route —
 * unowned rows (null userId) are admin-only.
 *
 * Cache-Control is `immutable` because `storagePath` is UUID-keyed and never
 * rewritten — changing content means a new attachment row with a new id.
 *
 * Default Content-Disposition is `inline` so browsers render images directly
 * in <img> tags and preview PDFs/text. Pass `?download=1` to force the
 * attachment download flow with the original filename.
 */

import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { getAttachment } from "$server/db/queries/attachments";
import { getConversation } from "$server/db/queries/conversations";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import type { RequestHandler } from "./$types";

function notFound(): Response {
	return new Response(JSON.stringify({ error: "Not found" }), {
		status: 404,
		headers: { "Content-Type": "application/json" },
	});
}

// RFC 6266 quoted-string: escape `"` and `\` in the filename we put into
// Content-Disposition. Anything non-ASCII falls back to a stripped filename —
// browsers that need the full Unicode name can read `filename*=UTF-8''...`
// but the simple ASCII form is enough for our download UX.
function dispositionFilename(raw: string): string {
	const ascii = raw.replace(/[^\x20-\x7E]/g, "_");
	return ascii.replace(/["\\]/g, "_");
}

export const GET: RequestHandler = async ({ params, url, locals }) => {
	const scopeErr = requireScope(locals, "read");
	if (scopeErr) return scopeErr;
	const user = requireAuth(locals);

	const id = params.id;
	if (!id) return notFound();

	const row = await getAttachment(id);
	if (!row) return notFound();

	const conv = await getConversation(row.conversationId);
	if (!conv) return notFound();
	if (conv.userId !== user.id && user.role !== "admin") return notFound();

	// Admins reading another user's attachment is a privileged read — log it
	// so owners can audit cross-user access. Owner self-reads and the 404
	// path above are deliberately unlogged.
	if (user.role === "admin" && conv.userId !== user.id) {
		try {
			await insertAuditEntry(user.id, "attachment:admin_read", row.id, {
				conversationId: row.conversationId,
				ownerId: conv.userId,
				filename: row.filename,
				mimeType: row.mimeType,
			});
		} catch { /* swallow */ }
	}

	const file = Bun.file(row.storagePath);
	if (!(await file.exists())) return notFound();

	const forceDownload = url.searchParams.get("download") === "1";
	const disposition = forceDownload
		? `attachment; filename="${dispositionFilename(row.filename)}"`
		: "inline";

	return new Response(file.stream() as unknown as ReadableStream, {
		status: 200,
		headers: {
			"Content-Type": row.mimeType || "application/octet-stream",
			"Content-Length": String(row.sizeBytes),
			"Content-Disposition": disposition,
			"Cache-Control": "private, max-age=31536000, immutable",
		},
	});
};
