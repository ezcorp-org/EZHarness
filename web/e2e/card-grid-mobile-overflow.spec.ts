/**
 * Issue #209 — card grids must not overflow horizontally on a phone.
 *
 * A grid item defaults to `min-width: auto`, so an unbreakable string (an
 * agent name, a command slug, an extension name) sets the track's min-content
 * width and widens the whole column. The `truncate` on the inner heading is
 * then INERT — the heading has all the room it asked for, so it never clips,
 * and the content area scrolls sideways instead.
 *
 * Measured on this repo at a 393px viewport, before `min-w-0` on the CARD:
 *
 *   /agents      AgentCard    card 1307px  heading clientWidth 1265 == scrollWidth 1265
 *   /agents      TeamCard     card 1318px  heading clientWidth 1276 == scrollWidth 1276
 *   /commands    CommandCard  card  894px  heading clientWidth  852 == scrollWidth  852
 *   attach picker card         card  822px  name    clientWidth  712 vs scrollWidth  722
 *
 * Each test therefore asserts BOTH halves, because either one alone goes
 * vacuous:
 *
 *   OUTCOME     — the card fits the viewport, the scrollport does not scroll
 *                 sideways, and the heading is one line.
 *   ENGAGEMENT  — `scrollWidth > clientWidth` on the truncated element, so the
 *                 test still means something when a future fixture name
 *                 happens to fit inside the card.
 *
 * The picker case shows why: pre-fix its name ALREADY satisfied
 * `scrollWidth > clientWidth` (722 vs 712) while the card was 822px wide, so
 * engagement alone would have passed on the broken build.
 *
 * Box geometry alone is not enough either, so each test also asserts the card's
 * own `scrollWidth <= clientWidth`. An unbreakable token in a DESCRIPTION
 * overflows its block box as INK: every bounding rect stays honest (the card
 * measured 345px) while the scrollport grew to 1597px. The picker had the box
 * form of the same defect — an `items-start` flex column left the paragraph at
 * its own max-content, 1290px inside an 822px card, so `line-clamp-2` clipped
 * nothing.
 *
 * `document.scrollingElement` is the WEAKER of the two overflow checks here and
 * is asserted for completeness only: the app's scrollport is
 * `(app)/+layout.svelte`'s `<main class="… overflow-y-auto">`, and an
 * `overflow-y` that is not `visible` computes `overflow-x` to `auto`, so the
 * sideways scroll lands on `<main>` and the document never grew. It measured
 * 393 on the broken build too.
 *
 * Fixtures sit inside 15% of each field's real ceiling (asserted below), since
 * a short name makes every assertion here true for the wrong reason:
 *   agent / team name  90 of 100 chars — `createAgentConfigSchema.name.max(100)`
 *   command name       60 of  64 chars — `createUserCommandSchema.name.max(64)`
 *   extension name     64 of  64 chars — `EXTENSION_NAME_REGEX`
 * Widest lowercase glyph ('m') and no break opportunity, so the string is as
 * hostile as the field allows. A narrow glyph is its own trap: the same test
 * with 90 'l's produced a 338px min-content that fit the card and passed
 * against the unfixed build.
 *
 * The reference implementation is `extensions-mcp-tab.spec.ts` (#204), which
 * fixed the same defect on the /extensions card grid.
 */
import { test, expect } from "./fixtures/test-base.js";
import type { Page } from "@playwright/test";
import { captureEvidence } from "./fixtures/evidence.js";
import { makeProject, makeAgent, makeAgentConfig, makeExtension } from "./fixtures/data.js";

/** iPhone-14-class portrait viewport — the width the issue was reported at. */
const MOBILE = { width: 393, height: 852 };

const proj = makeProject({ id: "proj-1" });

const AGENT_NAME = `agent-${"m".repeat(82)}-x`;
const TEAM_NAME = `team-${"m".repeat(83)}-x`;
const CMD_NAME = `cmd-${"m".repeat(54)}-x`;
const EXT_NAME = `ext-${"m".repeat(58)}-x`;

/**
 * A description holding an unbreakable token — the shape a pasted URL takes.
 * This is a second, quieter vector on the same cards: the token overflows its
 * own block box as INK, so the box geometry stays honest (345px) while the
 * scrollport grows (measured 1597px on /agents). Kept in the fixtures so the
 * `break-words` half of the fix cannot be reverted silently.
 */
const LONG_WORD_DESC = `see https://example.com/${"m".repeat(120)}`;

type CardMetrics = {
	cardWidth: number;
	cardScrollW: number;
	cardClientW: number;
	headScrollW: number;
	headClientW: number;
	headHeight: number;
	scrollportScrollW: number;
	scrollportClientW: number;
	docScrollW: number;
	viewport: number;
};

/**
 * Geometry of a card, its truncating heading, and the nearest ancestor that
 * actually scrolls (the first one whose computed `overflow-x` is not
 * `visible`). Returns numbers only — the assertions live in the test bodies so
 * a change here can never quietly stop asserting.
 */
async function measureCard(page: Page, cardSel: string, headSel: string): Promise<CardMetrics> {
	return await page.evaluate(
		({ cardSel, headSel }) => {
			const card = document.querySelector(cardSel) as HTMLElement | null;
			if (!card) throw new Error(`card not found: ${cardSel}`);
			const head = card.querySelector(headSel) as HTMLElement | null;
			if (!head) throw new Error(`heading not found: ${headSel}`);
			let scrollport: HTMLElement = document.scrollingElement as HTMLElement;
			for (let el = card.parentElement; el; el = el.parentElement) {
				if (getComputedStyle(el).overflowX !== "visible") {
					scrollport = el;
					break;
				}
			}
			return {
				cardWidth: Math.round(card.getBoundingClientRect().width),
				cardScrollW: card.scrollWidth,
				cardClientW: card.clientWidth,
				headScrollW: head.scrollWidth,
				headClientW: head.clientWidth,
				headHeight: Math.round(head.getBoundingClientRect().height),
				scrollportScrollW: scrollport.scrollWidth,
				scrollportClientW: scrollport.clientWidth,
				docScrollW: (document.scrollingElement as HTMLElement).scrollWidth,
				viewport: window.innerWidth,
			};
		},
		{ cardSel, headSel },
	);
}

test.describe("card grids at a 393px viewport (#209)", () => {
	test("@evidence a near-max agent name clips instead of widening the grid track", async ({
		page,
		mockApi,
	}, testInfo) => {
		expect(AGENT_NAME).toHaveLength(90); // 90% of the 100-char zod ceiling
		await mockApi({
			projects: [proj],
			agents: [
				makeAgent({
					name: AGENT_NAME,
					source: "config",
					id: "cfg-1",
					prompt: "You are helpful.",
					description: LONG_WORD_DESC,
				}),
			],
		});
		await page.setViewportSize(MOBILE);
		await page.goto("/agents");

		const heading = page.getByRole("heading", { name: AGENT_NAME });
		await expect(heading).toBeVisible();
		await heading.scrollIntoViewIfNeeded();

		const m = await measureCard(page, "div.rounded-lg.border", "h3");
		// OUTCOME: the card fits the phone, nothing scrolls sideways, one line.
		expect(m.cardWidth).toBeLessThanOrEqual(m.viewport);
		expect(m.cardScrollW).toBeLessThanOrEqual(m.cardClientW); // no ink escapes the card
		expect(m.scrollportScrollW).toBeLessThanOrEqual(m.scrollportClientW);
		expect(m.docScrollW).toBeLessThanOrEqual(m.viewport);
		expect(m.headHeight).toBeLessThan(32);
		// ENGAGEMENT: the name genuinely overflows its own element, i.e. the
		// ellipsis is real. Without this the test passes on a short fixture.
		expect(m.headScrollW).toBeGreaterThan(m.headClientW);

		await captureEvidence(page, testInfo, "agents-card-max-length-name-393");
	});

	test("a near-max team name clips instead of widening the grid track", async ({ page, mockApi }) => {
		expect(TEAM_NAME).toHaveLength(90);
		await mockApi({
			projects: [proj],
			agents: [],
			agentConfigs: [
				makeAgentConfig({
					id: "team-1",
					name: TEAM_NAME,
					category: "team",
					description: LONG_WORD_DESC,
				}),
			],
		});
		await page.setViewportSize(MOBILE);
		await page.goto("/agents?tab=teams");

		const heading = page.getByRole("heading", { name: TEAM_NAME });
		await expect(heading).toBeVisible();
		await heading.scrollIntoViewIfNeeded();

		const m = await measureCard(page, "div.rounded-lg.border", "h3");
		expect(m.cardWidth).toBeLessThanOrEqual(m.viewport);
		expect(m.cardScrollW).toBeLessThanOrEqual(m.cardClientW); // no ink escapes the card
		expect(m.scrollportScrollW).toBeLessThanOrEqual(m.scrollportClientW);
		expect(m.docScrollW).toBeLessThanOrEqual(m.viewport);
		expect(m.headHeight).toBeLessThan(32);
		expect(m.headScrollW).toBeGreaterThan(m.headClientW);
	});

	test("@evidence a near-max command slug clips instead of widening the grid track", async ({
		page,
		mockApi,
	}, testInfo) => {
		expect(CMD_NAME).toHaveLength(60); // 94% of the 64-char zod ceiling
		await mockApi({
			projects: [proj],
			userCommands: [{ name: CMD_NAME, body: "Do the thing: $ARGUMENTS", description: LONG_WORD_DESC }],
		});
		await page.setViewportSize(MOBILE);
		await page.goto("/commands");

		const card = page.getByTestId("command-card");
		await expect(card).toBeVisible();
		await card.scrollIntoViewIfNeeded();

		const m = await measureCard(page, '[data-testid="command-card"]', "h3");
		expect(m.cardWidth).toBeLessThanOrEqual(m.viewport);
		expect(m.cardScrollW).toBeLessThanOrEqual(m.cardClientW); // no ink escapes the card
		expect(m.scrollportScrollW).toBeLessThanOrEqual(m.scrollportClientW);
		expect(m.docScrollW).toBeLessThanOrEqual(m.viewport);
		expect(m.headHeight).toBeLessThan(32);
		expect(m.headScrollW).toBeGreaterThan(m.headClientW);

		await captureEvidence(page, testInfo, "commands-card-max-length-slug-393");
	});

	test("@evidence a max-length extension name keeps the attach picker one column wide", async ({
		page,
		mockApi,
	}, testInfo) => {
		expect(EXT_NAME).toHaveLength(64); // exactly the EXTENSION_NAME_REGEX ceiling
		await mockApi({
			projects: [proj],
			extensions: [makeExtension({ id: "ext-1", name: EXT_NAME, description: LONG_WORD_DESC })],
			agentConfigs: [],
		});
		await page.setViewportSize(MOBILE);
		await page.goto("/agents/new");
		await page.getByRole("button", { name: "Configure" }).click();
		await page.getByTestId("open-extension-attach-picker").click();

		const card = page.getByTestId("extension-attach-picker-card");
		await expect(card).toBeVisible();
		await card.scrollIntoViewIfNeeded();

		// The picker's own scroll pane is the scrollport here, not `<main>` —
		// `measureCard` finds it by walking up to the first non-visible
		// `overflow-x`, which is the modal body.
		const m = await measureCard(page, '[data-testid="extension-attach-picker-card"]', "span.truncate");
		expect(m.cardWidth).toBeLessThanOrEqual(m.viewport);
		expect(m.cardScrollW).toBeLessThanOrEqual(m.cardClientW); // no ink escapes the card
		expect(m.scrollportScrollW).toBeLessThanOrEqual(m.scrollportClientW);
		expect(m.docScrollW).toBeLessThanOrEqual(m.viewport);
		expect(m.headHeight).toBeLessThan(32);
		expect(m.headScrollW).toBeGreaterThan(m.headClientW);
		// The name must be clipped to roughly the card, not merely "clipped by
		// 10px of a 722px string" — which is exactly what the broken build did.
		expect(m.headClientW).toBeLessThanOrEqual(m.cardWidth);

		await captureEvidence(page, testInfo, "attach-picker-max-length-name-393");
	});
});
