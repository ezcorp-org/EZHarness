/**
 * Universal load for `/agents/<name>` — supplies the trailing crumb for the
 * Command Deck breadcrumb strip in `web/src/routes/(app)/+layout.svelte`.
 *
 * That strip is this page's ONLY breadcrumb at every viewport (the
 * `.deck-breadcrumb` rule in `app.css` keeps it visible below `lg`), so the
 * page renders none of its own. Pure and synchronous: the agent name is
 * already in the route, so there is no fetch and no server round trip.
 *
 * `params.name` arrives ALREADY DECODED. SvelteKit decodes the pathname
 * before it matches a route — `decode_pathname` in the server responder,
 * `decode_params` in the client router — so decoding it again here would
 * corrupt an agent name that contains a literal `%` (`a%20b` would read back
 * as `a b`) and would throw `URIError` on one that is not valid percent
 * escaping (an agent called `50% off` would 500 the page). The page component
 * reads the same undecoded `page.params.name` to find the agent, so the crumb
 * and the heading cannot disagree. Pinned in
 * `web/src/__tests__/agents-name-page-load.unit.test.ts` and end-to-end in
 * `web/e2e/agent-detail-breadcrumb.spec.ts`.
 */
import type { PageLoad } from "./$types";

export const load: PageLoad = ({ params }) => ({ breadcrumbTail: params.name });
