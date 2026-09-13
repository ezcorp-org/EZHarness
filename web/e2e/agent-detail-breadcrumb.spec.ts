/**
 * E2E — the agent detail page has exactly ONE breadcrumb, and it names the
 * agent (frontend-visual change ⇒ `@evidence` per the feature contract).
 *
 * The page used to render its own phone-only `<Breadcrumb>` on top of the
 * Command Deck strip, which the `.deck-breadcrumb` rule in `app.css` keeps
 * visible at every width — so phones showed two breadcrumbs stacked. The page
 * breadcrumb is gone; the strip now carries the agent name as the trailing
 * crumb, resolved from the route param by `$lib/breadcrumb-tail.svelte.ts`.
 * The in-page "Back to Agents" link is no longer desktop-only, because the
 * strip's "Agents" crumb is plain text and the phone lost its only in-context
 * way back.
 *
 * The percent-sign case is the resolver's contract in the real router:
 * SvelteKit decodes the pathname before it matches a route, so the crumb must
 * be the param VERBATIM. A second `decodeURIComponent` throws `URIError` on
 * this name and serves a 500 instead of the agent.
 *
 * The other two tail sources — a load-supplied name and a page-published one —
 * are covered by `breadcrumb-tail.spec.ts`.
 */
import { test, expect } from "./fixtures/test-base.js";
import { captureEvidence } from "./fixtures/evidence.js";
import { makeAgent, makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-agent-breadcrumb", name: "Agent Workspace" });
const summarizer = makeAgent({
	name: "summarizer",
	description: "Summarizes long text into concise summaries",
	capabilities: ["text-processing", "nlp"],
});

/** The strip is the only breadcrumb, and its trailing crumb is the agent. */
async function expectSoleBreadcrumb(page: import("@playwright/test").Page, agentName: string) {
	const strip = page.getByTestId("deck-breadcrumb");
	await expect(strip).toHaveCount(1);
	await expect(strip).toBeVisible();
	await expect(strip).toContainText("Agents");
	await expect(strip.getByTestId("deck-breadcrumb-tail")).toHaveText(agentName);
	// The page-level phone breadcrumb is gone — no second crumb trail anywhere.
	await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toHaveCount(0);
}

test.describe("Agent detail breadcrumb", () => {
	test.describe("desktop", () => {
		test.use({ viewport: { width: 1280, height: 800 } });

		test("names the agent in the deck strip and renders no second breadcrumb @evidence", async ({ page, mockApi }, testInfo) => {
			await mockApi({ projects: [proj], agents: [summarizer] });
			await page.goto("/agents/summarizer");

			await expect(page.getByRole("heading", { name: "summarizer" })).toBeVisible();
			await expectSoleBreadcrumb(page, "summarizer");
			await expect(page.getByTestId("agent-back-link")).toBeVisible();
			await captureEvidence(page, testInfo, "agent-detail-breadcrumb-desktop");
		});
	});

	test.describe("mobile", () => {
		test.use({ viewport: { width: 390, height: 844 } });

		test("shows one breadcrumb on a phone, not two stacked @evidence", async ({ page, mockApi }, testInfo) => {
			await mockApi({ projects: [proj], agents: [summarizer] });
			await page.goto("/agents/summarizer");

			await expect(page.getByRole("heading", { name: "summarizer" })).toBeVisible();
			await expectSoleBreadcrumb(page, "summarizer");
			// The strip's "Agents" crumb is plain text, so the phone keeps this
			// link as its in-context way back (it used to be desktop-only).
			await expect(page.getByTestId("agent-back-link")).toBeVisible();
			await captureEvidence(page, testInfo, "agent-detail-breadcrumb-mobile");
		});
	});

	test("a percent sign in the agent name reaches the crumb intact", async ({ page, mockApi }) => {
		const discounted = makeAgent({ name: "50% off", description: "Trims a prompt in half" });
		await mockApi({ projects: [proj], agents: [discounted] });
		await page.goto("/agents/50%25%20off");

		await expect(page.getByRole("heading", { name: "50% off" })).toBeVisible();
		await expect(page.getByTestId("deck-breadcrumb-tail")).toHaveText("50% off");
	});
});
