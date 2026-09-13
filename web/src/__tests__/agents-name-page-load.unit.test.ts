/**
 * Unit tests for the `/agents/<name>` universal load.
 *
 * The load exists for one reason: hand the Command Deck breadcrumb strip the
 * agent name as `breadcrumbTail`. The tests below pin the property that is
 * easy to get wrong — the crumb is the route param VERBATIM, never decoded a
 * second time. SvelteKit decodes the pathname before it matches a route, so a
 * second `decodeURIComponent` here would rewrite `a%20b` to `a b` and throw
 * `URIError` on `50% off`. The end-to-end half of that claim (that SvelteKit
 * really does hand over a decoded param) lives in
 * `web/e2e/agent-detail-breadcrumb.spec.ts`.
 */
import { expect, test } from "vitest";
import { load } from "../routes/(app)/agents/[name]/+page";

/** The load only ever reads `params`, so this is the whole event it needs. */
function event(name: string) {
	return { params: { name } } as Parameters<typeof load>[0];
}

test("hands the agent name to the breadcrumb strip as the trailing crumb", () => {
	expect(load(event("summarizer"))).toEqual({ breadcrumbTail: "summarizer" });
});

test("passes a name with spaces through untouched", () => {
	expect(load(event("nightly report writer"))).toEqual({ breadcrumbTail: "nightly report writer" });
});

test("keeps a literal percent escape instead of decoding the param twice", () => {
	// A second decode would turn this into "a b" and silently rename the agent
	// in the crumb.
	expect(load(event("a%20b"))).toEqual({ breadcrumbTail: "a%20b" });
});

test("does not throw on a name that is not valid percent escaping", () => {
	// `decodeURIComponent("50% off")` throws URIError, which in a load means a
	// 500 page instead of an agent.
	expect(load(event("50% off"))).toEqual({ breadcrumbTail: "50% off" });
});

test("keeps an empty name empty rather than inventing a crumb", () => {
	expect(load(event(""))).toEqual({ breadcrumbTail: "" });
});
