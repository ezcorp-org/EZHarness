/**
 * Shared model-capabilities test stub.
 *
 * Why this exists: any test that mounts `<ChatThread>` (page or panel)
 * also mounts the real `<ChatInput>`, whose `$effect` calls
 * `getClientCapabilities(provider, model, fetch, …)` →
 * `GET /api/models/capabilities`. If that fetch resolves to a body
 * WITHOUT a well-formed `kinds: AttachmentKind[]`, ChatInput's
 * `attachmentsSupported` derived crashes at `capabilities.kinds.length`
 * (ChatInput.svelte:298) — and because the effect resolves AFTER the
 * component may have unmounted, the throw lands in test teardown as an
 * unhandled async error that crashes the whole `vitest --coverage`
 * merge.
 *
 * Centralising the well-formed capabilities body (and the
 * cache-reset) here keeps every ChatThread-mounting suite DRY and
 * removes the teardown-crash class entirely.
 */

import type { ClientCapabilities } from "$lib/chat/attachment-client";

/** A complete, well-formed capabilities row (text-only, no attachments). */
export function makeClientCapabilities(
	provider = "openai",
	model = "gpt-4o",
	overrides: Partial<ClientCapabilities> = {},
): ClientCapabilities {
	return {
		provider,
		model,
		kinds: ["text"],
		acceptedMimeTypes: [],
		maxBytesPerFile: 0,
		maxFilesPerMessage: 0,
		...overrides,
	};
}

/**
 * URL-aware fetch responder that returns a well-formed capabilities
 * body for `/api/models/capabilities` (and an empty available-model
 * list for `/api/models` unless `models` is supplied). Returns `null`
 * for every other URL so callers can chain their own routing:
 *
 *   const caps = makeCapabilitiesFetch();
 *   g.fetch = vi.fn(async (input) => caps(input) ?? defaultResponse);
 */
export function makeCapabilitiesFetch(
	models: Array<Record<string, unknown>> = [],
) {
	return (input: RequestInfo | URL): Response | null => {
		const url = String(
			typeof input === "string" || input instanceof URL
				? input
				: (input as Request).url,
		);
		if (url.includes("/api/models/capabilities")) {
			return new Response(JSON.stringify(makeClientCapabilities()), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (/\/api\/models(\?|$)/.test(url)) {
			return new Response(JSON.stringify(models), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return null;
	};
}
