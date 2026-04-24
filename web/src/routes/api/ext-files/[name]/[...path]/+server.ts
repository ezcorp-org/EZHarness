/**
 * Serve files written by an extension into
 * `<projectRoot>/.ezcorp/extension-data/<name>/`.
 *
 * Why this route exists: extensions like openai-image-gen-2 produce
 * binary artifacts (generated images) that need to render in the chat
 * UI. Shipping them inline as `data:image/...` URIs in the tool result
 * works once but dies on the next turn — the base64 gets replayed as
 * input text and overruns the model's context window. So the extension
 * writes bytes to disk and emits a short URL pointing here.
 *
 * Security:
 *   - Authenticated users only (cookie or bearer).
 *   - `<name>` must match our strict allowlist — anything else is 404.
 *     We don't want an attacker-controlled name probing arbitrary
 *     extensions' state.
 *   - The final resolved path must live under the extension's data
 *     directory. Traversal attempts (`..`, symlinks, absolute paths)
 *     fail closed.
 */

import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { join } from "node:path";
import { existsSync, createReadStream, statSync } from "node:fs";
import {
	ALLOWED_EXTENSIONS,
	MIME_BY_EXT,
	extensionDataRoot,
	resolveExtFilesPath,
} from "$server/chat/attachments/ext-files-resolver";
import type { RequestHandler } from "./$types";

function notFound(): Response {
	return new Response(JSON.stringify({ error: "Not found" }), {
		status: 404,
		headers: { "Content-Type": "application/json" },
	});
}

/** Resolve the extension data root inside the server's project root.
 *  Prefixed with `_` because SvelteKit's +server.ts loader only
 *  permits HTTP verbs + `_`-prefixed exports. */
export function _extensionDataRoot(name: string, cwd: string = process.cwd()): string {
	return extensionDataRoot(name, cwd);
}

export const GET: RequestHandler = async ({ params, locals }) => {
	const scopeErr = requireScope(locals, "read");
	if (scopeErr) return scopeErr;
	requireAuth(locals);

	const resolved = resolveExtFilesPath(params.name, params.path);
	if (!resolved) return notFound();
	if (!existsSync(resolved.absPath)) return notFound();
	const stat = statSync(resolved.absPath);
	if (!stat.isFile()) return notFound();

	const stream = createReadStream(resolved.absPath) as unknown as ReadableStream;
	return new Response(stream as any, {
		status: 200,
		headers: {
			"Content-Type": resolved.mimeType,
			"Content-Length": String(stat.size),
			// Immutable + short max-age: filenames are UUIDs so content
			// never changes, but a short age keeps control with us if a
			// filename is re-used (shouldn't happen, but belt & braces).
			"Cache-Control": "private, max-age=3600",
		},
	});
};

// Re-export for test ergonomics. SvelteKit allows `_`-prefixed exports.
export const _TEST = { ALLOWED_EXTENSIONS, MIME_BY_EXT, _extensionDataRoot, join };
