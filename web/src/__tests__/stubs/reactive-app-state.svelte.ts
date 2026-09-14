/**
 * Reactive `$app/state` stand-in for tests that need navigation to be
 * OBSERVABLE by effects: `url` is `$state.raw`, exactly as in SvelteKit's
 * client runtime (`@sveltejs/kit/src/runtime/client/state.svelte.js`). The
 * plain `app-state.ts` stub is inert, so a `$effect` reading it never re-runs.
 */
class Page {
	url = $state.raw(new URL("http://localhost/"));
	route = $state.raw<{ id: string | null }>({ id: null });
	params = $state.raw<Record<string, string>>({});
	data = $state.raw<Record<string, unknown>>({});
}
export const page = new Page();
/** Move the page to `pathname`, the way a client-side navigation would. */
export function navigate(pathname: string): void {
	page.url = new URL(pathname, "http://localhost");
}
