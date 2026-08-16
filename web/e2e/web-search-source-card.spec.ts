/**
 * E2E — the web-search source-disclosure card in the transcript
 * (frontend-visual change ⇒ `@evidence` per the feature contract).
 *
 * RENDER tier (`mockApi`): the conversation's `withToolCalls=true` GET
 * seeds persisted `search-web` / `read-url` calls exactly as the server
 * returns them. That is the path that matters here — the card is
 * deliberately built from the PERSISTED markdown output, so scrollback
 * must disclose sources as richly as a live call, with no migration.
 *
 * What is pinned is what a user can see and click:
 *
 *  1. Collapsed, the card already names the query, the source count and
 *     the domains — you never have to expand to learn what was read.
 *  2. Expanded, every result is a real anchor with `target="_blank"` AND
 *     `rel="noopener noreferrer"`, plus the snippet text that entered the
 *     model's context and a footer that says so.
 *  3. An LLM-supplied `javascript:` URL NEVER becomes an href. This is
 *     the security assertion the unit tests can only make structurally —
 *     here a real browser parses the DOM.
 *  4. `read-url` discloses the page: source link, host, size, body.
 *  5. Honest degradation: a failed call falls through to DefaultCard
 *     rather than rendering an empty sources panel.
 *  6. MOBILE. Long URLs and titles must not overflow the card at 390px.
 *
 * `captureEvidence` is a hard no-op unless `EZCORP_E2E_EVIDENCE=1`.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

const PROJECT_ID = "proj-web-search";
const project = makeProject({ id: PROJECT_ID, name: "Research Project" });

/** Byte-for-byte the shape `src/search/markdown.ts#formatResults` emits. */
const SEARCH_OUTPUT = [
	"- [Bun v1.3.0 — Release notes](https://bun.sh/blog/bun-v1-3)",
	"  Bun 1.3 ships a built-in Postgres client and a rewritten installer.",
	"- [Release v1.3.0 · oven-sh/bun](https://github.com/oven-sh/bun/releases/tag/bun-v1.3.0)",
	"  What's Changed: bun install now resolves peer dependencies by default.",
	"- [Bun 1.3 is out](https://news.ycombinator.com/item?id=41000000)",
	"  Discussion thread with 240 comments.",
	"- [Bun 1.3 roundup](https://blog.example.com/bun-1-3-roundup)",
	"  A walk through the release highlights.",
].join("\n");

const PAGE_OUTPUT = [
	"# Bun v1.3.0",
	"",
	"Bun 1.3 ships a built-in Postgres client, a rewritten installer, and",
	"a faster test runner.",
].join("\n");

/** A persisted tool call in the shape `withToolCalls=true` returns. */
function persistedCall(over: {
	id: string;
	toolName: string;
	cardType: string;
	output: string;
	input: Record<string, unknown>;
	messageId: string;
	failed?: boolean;
}) {
	return {
		id: over.id,
		extensionId: "web-search",
		toolName: over.toolName,
		input: over.input,
		outputSummary: over.output.slice(0, 120),
		fullOutput: over.output,
		success: !over.failed,
		durationMs: 1234,
		status: over.failed ? ("error" as const) : ("success" as const),
		messageId: over.messageId,
		cardType: over.cardType,
	};
}

function seedTurn(convId: string, prompt: string) {
	return [
		makeMessage({
			id: `${convId}-u1`,
			conversationId: convId,
			role: "user",
			content: prompt,
			parentMessageId: null,
			createdAt: "2026-08-15T12:00:00.000Z",
		}),
		makeMessage({
			id: `${convId}-a1`,
			conversationId: convId,
			role: "assistant",
			content: "Here is what I found.",
			parentMessageId: `${convId}-u1`,
			createdAt: "2026-08-15T12:00:02.000Z",
		}),
	];
}

async function seedSearch(
	mockApi: (config: Record<string, unknown>) => Promise<void>,
	convId: string,
	calls: Array<ReturnType<typeof persistedCall>>,
	prompt = "what's new in bun 1.3?",
) {
	await mockApi({
		projects: [project],
		conversations: [
			makeConversation({ id: convId, projectId: PROJECT_ID, title: "Research" }),
		],
		messages: seedTurn(convId, prompt),
		messageToolCalls: { [`${convId}-a1`]: calls },
	});
}

/** The standard `search-web` call used by most cases below. */
function searchCall(convId: string, id = "tc-search") {
	return persistedCall({
		id,
		toolName: "search-web",
		cardType: "web-search",
		output: SEARCH_OUTPUT,
		input: { query: "bun 1.3 release notes", maxResults: 5 },
		messageId: `${convId}-a1`,
	});
}

test.describe("web-search source disclosure card", () => {
	test("discloses query, count and domains collapsed, then every source on expand @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		const convId = "conv-web-search";
		await seedSearch(mockApi, convId, [searchCall(convId)]);
		await page.goto(`/project/${PROJECT_ID}/chat/${convId}`);

		const card = page.getByTestId("web-context-card");
		await expect(card).toBeVisible({ timeout: 10_000 });
		await expect(card).toHaveAttribute("data-kind", "search");

		// COLLAPSED: the disclosure is already on screen.
		await expect(page.getByTestId("web-context-query")).toContainText("bun 1.3 release notes");
		await expect(page.getByTestId("web-context-count")).toHaveText("4 sources");
		await expect(page.getByTestId("web-context-host-chip")).toHaveText([
			"bun.sh",
			"github.com",
			"news.ycombinator.com",
		]);
		await expect(page.getByTestId("web-context-host-more")).toHaveText("+1");
		await expect(page.getByTestId("web-context-source")).toHaveCount(0);

		// EXPAND.
		await page.getByTestId("web-context-toggle").click();
		await expect(page.getByTestId("web-context-source")).toHaveCount(4);

		const links = page.getByTestId("web-context-source-link");
		await expect(links).toHaveCount(4);
		await expect(links.first()).toHaveText("Bun v1.3.0 — Release notes");
		await expect(links.first()).toHaveAttribute("href", "https://bun.sh/blog/bun-v1-3");
		// A `target="_blank"` link without this rel hands the opened page a
		// handle back to the app.
		for (let i = 0; i < 4; i++) {
			await expect(links.nth(i)).toHaveAttribute("target", "_blank");
			await expect(links.nth(i)).toHaveAttribute("rel", "noopener noreferrer");
		}

		// The snippets are the text the model actually read.
		await expect(page.getByTestId("web-context-snippet").first()).toHaveText(
			"Bun 1.3 ships a built-in Postgres client and a rewritten installer.",
		);
		await expect(page.getByTestId("web-context-footer")).toHaveText(
			"This text was added to the conversation context.",
		);

		// The surrounding turn still reads normally around the card.
		await expect(page.locator(`[data-message-id="${convId}-u1"]`)).toContainText(
			"what's new in bun 1.3?",
		);

		await captureEvidence(page, testInfo, "web-search-source-card");
		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) => a.name === "web-search-source-card" && a.contentType === "image/png",
				),
			).toBe(true);
		} else {
			expect(testInfo.attachments.some((a) => a.name === "web-search-source-card")).toBe(false);
		}
	});

	test("collapses back to the header on a second click", async ({ page, mockApi }) => {
		const convId = "conv-web-search-collapse";
		await seedSearch(mockApi, convId, [searchCall(convId, "tc-search-collapse")]);
		await page.goto(`/project/${PROJECT_ID}/chat/${convId}`);

		const toggle = page.getByTestId("web-context-toggle");
		await expect(toggle).toBeVisible({ timeout: 10_000 });
		await toggle.click();
		await expect(page.getByTestId("web-context-source")).toHaveCount(4);
		await toggle.click();
		// A real browser runs the slide outro, so the rows genuinely leave.
		await expect(page.getByTestId("web-context-source")).toHaveCount(0);
		await expect(toggle).toHaveAttribute("aria-expanded", "false");
		// …and the header disclosure survives the collapse.
		await expect(page.getByTestId("web-context-count")).toHaveText("4 sources");
	});

	test("a javascript: result is shown inert — never as an href", async ({ page, mockApi }) => {
		const convId = "conv-web-search-hostile";
		await seedSearch(mockApi, convId, [
			persistedCall({
				id: "tc-search-hostile",
				toolName: "search-web",
				cardType: "web-search",
				output: [
					"- [Totally safe link](javascript:alert(document.cookie))",
					"  click me",
					"- [A real one](https://bun.sh/)",
				].join("\n"),
				input: { query: "safe links" },
				messageId: `${convId}-a1`,
			}),
		]);
		await page.goto(`/project/${PROJECT_ID}/chat/${convId}`);

		await page.getByTestId("web-context-toggle").click();
		await expect(page.getByTestId("web-context-source")).toHaveCount(2);

		// Exactly one anchor — the https one. The hostile row is text.
		const links = page.getByTestId("web-context-source-link");
		await expect(links).toHaveCount(1);
		await expect(links).toHaveAttribute("href", "https://bun.sh/");
		await expect(page.getByTestId("web-context-source-unlinked")).toHaveText("Totally safe link");
		// The raw string is still disclosed — hiding it would tell the user less.
		await expect(page.getByTestId("web-context-source-raw")).toHaveText(
			"javascript:alert(document.cookie)",
		);
		// No anchor anywhere in the card points at a javascript: target.
		expect(
			await page
				.getByTestId("web-context-card")
				.locator("a[href^='javascript:']")
				.count(),
		).toBe(0);
	});

	test("an empty result set says nothing entered the context", async ({ page, mockApi }) => {
		const convId = "conv-web-search-empty";
		await seedSearch(mockApi, convId, [
			persistedCall({
				id: "tc-search-empty",
				toolName: "search-web",
				cardType: "web-search",
				output: "_No results._",
				input: { query: "asdkjhasdkjhasd" },
				messageId: `${convId}-a1`,
			}),
		]);
		await page.goto(`/project/${PROJECT_ID}/chat/${convId}`);

		await expect(page.getByTestId("web-context-count")).toHaveText("No results", {
			timeout: 10_000,
		});
		await page.getByTestId("web-context-toggle").click();
		await expect(page.getByTestId("web-context-empty")).toContainText(
			"nothing was added to the context",
		);
	});

	test("read-url discloses the page it pulled in @evidence", async ({ page, mockApi }, testInfo) => {
		const convId = "conv-web-read";
		await seedSearch(
			mockApi,
			convId,
			[
				persistedCall({
					id: "tc-read",
					toolName: "read-url",
					cardType: "web-page",
					output: PAGE_OUTPUT,
					input: { url: "https://www.bun.sh/blog/bun-v1-3", maxChars: 20000 },
					messageId: `${convId}-a1`,
				}),
			],
			"read https://bun.sh/blog/bun-v1-3 and summarise it",
		);
		await page.goto(`/project/${PROJECT_ID}/chat/${convId}`);

		const card = page.getByTestId("web-context-card");
		await expect(card).toBeVisible({ timeout: 10_000 });
		await expect(card).toHaveAttribute("data-kind", "page");
		await expect(page.getByTestId("web-context-page-title")).toHaveText("Bun v1.3.0");
		await expect(page.getByTestId("web-context-host-chip")).toHaveText("bun.sh");
		await expect(page.getByTestId("web-context-count")).toContainText("pulled into context");

		await page.getByTestId("web-context-toggle").click();
		const link = page.getByTestId("web-context-source-link");
		await expect(link).toHaveAttribute("href", "https://www.bun.sh/blog/bun-v1-3");
		await expect(link).toHaveAttribute("rel", "noopener noreferrer");
		// The extracted markdown renders as markdown, not as an escaped blob.
		const body = page.getByTestId("web-context-page-body");
		await expect(body).toContainText("Bun 1.3 ships a built-in Postgres client");
		await expect(body.locator("h1")).toHaveText("Bun v1.3.0");

		await captureEvidence(page, testInfo, "web-search-page-card");
		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) => a.name === "web-search-page-card" && a.contentType === "image/png",
				),
			).toBe(true);
		} else {
			expect(testInfo.attachments.some((a) => a.name === "web-search-page-card")).toBe(false);
		}
	});

	test("a failed search degrades to DefaultCard, not an empty sources panel", async ({
		page,
		mockApi,
	}) => {
		const convId = "conv-web-search-failed";
		await seedSearch(mockApi, convId, [
			persistedCall({
				id: "tc-search-failed",
				toolName: "search-web",
				cardType: "web-search",
				output: "Search failed: provider not allowed by policy.",
				input: { query: "bun 1.3 release notes" },
				messageId: `${convId}-a1`,
				failed: true,
			}),
		]);
		await page.goto(`/project/${PROJECT_ID}/chat/${convId}`);

		const defaultCard = page.getByTestId("tool-card-default");
		await expect(defaultCard).toBeVisible({ timeout: 10_000 });
		await expect(defaultCard).toContainText("search-web");
		await expect(page.getByTestId("web-context-card")).toHaveCount(0);
	});

	test("the header and the sources stay inside the card at 390px @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		// A long title beside a long host in a non-wrapping row is exactly how
		// header content escapes its card on mobile.
		await page.setViewportSize({ width: 390, height: 900 });
		const convId = "conv-web-search-mobile";
		await seedSearch(mockApi, convId, [searchCall(convId, "tc-search-mobile")]);
		await page.goto(`/project/${PROJECT_ID}/chat/${convId}`);

		const card = page.getByTestId("web-context-card");
		await expect(card).toBeVisible({ timeout: 10_000 });
		await page.getByTestId("web-context-toggle").click();
		await expect(page.getByTestId("web-context-source")).toHaveCount(4);

		const cardBox = (await card.boundingBox())!;
		for (const testId of ["web-context-query", "web-context-source-link", "web-context-snippet"]) {
			const box = (await page.getByTestId(testId).first().boundingBox())!;
			expect(box.x).toBeGreaterThanOrEqual(cardBox.x - 1);
			expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
		}
		// The card itself fits the viewport.
		expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(390);

		await captureEvidence(page, testInfo, "web-search-source-card-mobile");
		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) => a.name === "web-search-source-card-mobile" && a.contentType === "image/png",
				),
			).toBe(true);
		} else {
			expect(
				testInfo.attachments.some((a) => a.name === "web-search-source-card-mobile"),
			).toBe(false);
		}
	});
});
