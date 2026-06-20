/**
 * The runtime-bus event names the SSE endpoint (`./+server.ts`) forwards
 * to browser clients. This is now an alias for the single canonical list in
 * `$lib/runtime-event-names` (shared with the client SSE consumer in
 * `ws.ts` and the harness client) — kept under this name + module so the
 * SSE endpoint and its completeness regression test import it unchanged.
 * SvelteKit rejects non-handler exports from `+server.ts`, which is why
 * this lives in its own module.
 */
export { RUNTIME_EVENT_NAMES as BUS_EVENTS } from "$lib/runtime-event-names";
