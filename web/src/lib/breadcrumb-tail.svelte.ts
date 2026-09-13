/**
 * The trailing crumb of the Command Deck strip in
 * `web/src/routes/(app)/+layout.svelte` — the `summarizer` in
 * `global / Agents / summarizer`.
 *
 * ONE resolver for every route. The alternative is a near-identical
 * `+page.ts` per detail route, which is how this started: the strip is the
 * app's only breadcrumb at every viewport (the `.deck-breadcrumb` rule in
 * `app.css` is unlayered, so it beats Tailwind's `hidden` in
 * `@layer utilities`), so every detail route wants to name its subject and
 * none of them should have to restate the mechanism to do it.
 *
 * Three sources, highest priority first:
 *
 *   1. `page.data.breadcrumbTail` — a load already fetched the name. Server
 *      loads use this (extensions author, extension audit/preview, project
 *      proposals). Highest priority because a load that went to the trouble
 *      of naming the subject knows better than any fallback.
 *   2. The runtime tail — the page fetches its subject in the browser and
 *      pushes the name up when it lands (`setBreadcrumbTail`).
 *   3. `PARAM_NAME_ROUTES` — the route param IS the name, so the page needs
 *      no code at all.
 *
 * A route in none of the three gets no tail, and that is deliberate for
 * opaque ids: `global / Runs / 4f8c1b2e…` tells a reader strictly less than
 * `global / Runs`.
 */
import { browser } from "$app/environment";
import { page } from "$app/state";

/**
 * Route ids whose dynamic parameter is already the human-readable name, so
 * the strip can name the subject with no page-side code.
 *
 * Keys are SvelteKit route ids and therefore include the `(app)` group —
 * `page.route.id` reports `/(app)/agents/[name]`, not `/agents/[name]`.
 * Values name the parameter to read out of `page.params`.
 *
 * Deliberately NOT a pattern match over "last segment is a `[param]`": that
 * would sweep in every `[id]` route and put raw uuids in the chrome.
 * Membership here is a claim that the param is fit to read.
 */
export const PARAM_NAME_ROUTES: Readonly<Record<string, string>> = {
	"/(app)/agents/[name]": "name",
	"/(app)/commands/[name]": "name",
	"/(app)/workflows/[name]": "name",
	"/(app)/workflows/[name]/edit": "name",
};

/**
 * The browser-published tail, tagged with the pathname it describes.
 *
 * Tagging is what makes a stale crumb impossible. A page sets its subject
 * asynchronously, so a fast navigation can land the previous page's response
 * after the new route is showing; `resolveBreadcrumbTail` discards any entry
 * whose pathname is not the current one, so the worst case is no tail rather
 * than the wrong one. No teardown, no reset-on-navigate, nothing to forget.
 */
let runtime = $state<{ pathname: string; tail: string } | null>(null);

/**
 * Publish the subject name for the page being rendered. Call from an
 * `$effect` once the fetch resolves; pass `null` or `undefined` to withdraw.
 *
 * Reads the current pathname itself rather than taking it as an argument.
 * Callers should not have to know that staleness is prevented by tagging, and
 * making them pass `page.url.pathname` put a second `$app` read in every call
 * site — which promptly broke twenty component tests that mock `$app/stores`
 * with no `url`. The tagging is this module's business.
 *
 * Ignored outside the browser. Module state is per-PROCESS on the server and
 * therefore shared by every concurrent SSR request, so a server-side write
 * would leak one user's subject into another user's chrome. Effects do not
 * run during SSR, so today nothing calls this there — the guard makes that
 * true by construction instead of by convention.
 */
export function setBreadcrumbTail(tail: string | null | undefined): void {
	if (!browser) return;
	runtime = tail ? { pathname: page.url.pathname, tail } : null;
}

/**
 * Resolve the tail for the current page. Returns `null` when no source names
 * a subject, which the layout renders as a two-crumb strip.
 *
 * Empty strings count as absent throughout — an agent can be reached at
 * `/agents/` with an empty param, and ` global / Agents / ` is not a crumb.
 */
export function resolveBreadcrumbTail(
	routeId: string | null | undefined,
	pathname: string,
	params: Record<string, string | undefined>,
	dataTail: string | null | undefined,
): string | null {
	if (dataTail) return dataTail;
	if (runtime?.pathname === pathname) return runtime.tail;
	const param = routeId ? PARAM_NAME_ROUTES[routeId] : undefined;
	return (param ? params[param] : null) || null;
}
