/**
 * Composer suggestions — debounced tool chips + prompt-enhancement popover.
 *
 * RENDER-tier spec (mockApi; no real backend): drives the ChatInput wiring
 * against the mocked POST /api/composer/suggest and asserts the UX contract
 * the feature review flagged as make-or-break:
 *   - suggestions appear only after a typing pause on a long-enough draft
 *   - the popover never fights the mention popover
 *   - chip click inserts the extension mention; Apply/Undo round-trips the
 *     rewrite; Esc dismisses without re-nagging on the same draft
 *   - sidecar-absent deployments get chips but no enhancement row
 *   - the request body always carries the authoritative modeId
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Suggest Project" });
const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

const SUGGEST_TOOLS = [
	{ name: "scan", extension: "analyzer", extensionType: "extension", description: "Scan code for issues", score: 0.91 },
	{ name: "search", extension: "web-tools", extensionType: "extension", description: "Search the web", score: 0.62 },
	{ name: "task_create", extension: "ez", extensionType: "built-in", description: "Create a task", score: 0.5 },
];
const ENHANCEMENT = {
	enhanced: "Review the analyzer output and list the top three bugs with suggested fixes.",
	reason: "More specific and actionable",
};

const DRAFT = "please review my code for bugs";

async function setupAndFocus(page: any, mockApi: any, composerSuggest: Record<string, unknown>) {
	await mockApi({
		projects: [proj],
		conversations: [conv],
		messages: [],
		composerSuggest,
	});
	await page.goto(`/project/${proj.id}/chat/${conv.id}`);
	await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

	const textarea = page.locator("textarea");
	// The WS mock's open event may race with app subscription — retry open
	// events until the composer enables (same idiom as mention-system.spec).
	await page.waitForFunction(() => {
		const listeners = (window as any).__fakeWsListeners;
		if (listeners?.open) {
			for (const fn of listeners.open) {
				// One throwing listener must not block the rest; the error
				// itself is irrelevant to the readiness poll.
				try { fn(new Event("open")); } catch (err) { void err; }
			}
		}
		const ta = document.querySelector("textarea");
		return ta && !ta.disabled;
	}, { timeout: 5000 });
	await expect(textarea).toBeEnabled({ timeout: 5000 });
	await page.waitForTimeout(100);
	await textarea.click();
	return textarea;
}

const popover = (page: any) => page.getByTestId("suggestion-popover");

test.describe("Composer suggestions", () => {
	test("typing pause pops ranked tool chips + enhancement @evidence", async ({ page, mockApi }, testInfo) => {
		const textarea = await setupAndFocus(page, mockApi, {
			tools: SUGGEST_TOOLS,
			enhancement: ENHANCEMENT,
		});
		await textarea.pressSequentially(DRAFT, { delay: 25 });

		// 600ms debounce + fetch + render — poll via toBeVisible.
		await expect(popover(page)).toBeVisible({ timeout: 4000 });
		const chips = page.getByTestId("suggestion-tool-chip");
		await expect(chips).toHaveCount(3);
		await expect(chips.nth(0)).toContainText("scan");
		// Built-in chip renders informational (span, no button role).
		await expect(page.locator('span[data-testid="suggestion-tool-chip"][data-tool="task_create"]')).toBeVisible();
		// Enhancement row with Apply.
		await expect(page.getByTestId("suggestion-enhance-row")).toContainText(ENHANCEMENT.enhanced);
		await expect(page.getByTestId("suggestion-apply")).toBeVisible();

		await captureEvidence(page, testInfo, "composer-suggestions-popover");
	});

	test("short drafts never trigger the popover", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi, { tools: SUGGEST_TOOLS });
		await textarea.pressSequentially("hi", { delay: 25 });
		await page.waitForTimeout(1000);
		await expect(popover(page)).not.toBeVisible();
	});

	test("tool chip click inserts the extension mention and closes the popover", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi, { tools: SUGGEST_TOOLS });
		await textarea.pressSequentially(DRAFT, { delay: 25 });
		await expect(popover(page)).toBeVisible({ timeout: 4000 });

		await page.locator('button[data-testid="suggestion-tool-chip"][data-tool="scan"]').click();
		// Compact display projection of `![ext:analyzer]`.
		await expect(textarea).toHaveValue(/!analyzer/);
		await expect(popover(page)).not.toBeVisible();
	});

	test("Apply swaps the draft for the rewrite; Undo restores the original", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi, {
			tools: SUGGEST_TOOLS,
			enhancement: ENHANCEMENT,
		});
		await textarea.pressSequentially(DRAFT, { delay: 25 });
		await expect(page.getByTestId("suggestion-apply")).toBeVisible({ timeout: 4000 });

		await page.getByTestId("suggestion-apply").click();
		await expect(textarea).toHaveValue(ENHANCEMENT.enhanced);
		// Applied state offers Undo (visible mutation — reversible by design).
		await expect(page.getByTestId("suggestion-undo")).toBeVisible();
		await page.getByTestId("suggestion-undo").click();
		await expect(textarea).toHaveValue(DRAFT);
	});

	test("Escape dismisses and the same draft does not re-nag", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi, { tools: SUGGEST_TOOLS });
		await textarea.pressSequentially(DRAFT, { delay: 25 });
		await expect(popover(page)).toBeVisible({ timeout: 4000 });

		await textarea.press("Escape");
		await expect(popover(page)).not.toBeVisible();
		// No re-appearance without a draft change.
		await page.waitForTimeout(900);
		await expect(popover(page)).not.toBeVisible();
	});

	test("mention popover always wins over suggestions", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi, { tools: SUGGEST_TOOLS });
		await textarea.pressSequentially(DRAFT, { delay: 25 });
		await expect(popover(page)).toBeVisible({ timeout: 4000 });

		await textarea.pressSequentially(" !", { delay: 25 });
		await expect(page.locator("#mention-listbox")).toBeVisible({ timeout: 4000 });
		await expect(popover(page)).not.toBeVisible();
	});

	test("colliding short tool names disambiguate with the extension suffix @evidence", async ({ page, mockApi }, testInfo) => {
		const clash = (extension: string) => ({
			name: "weather-now",
			extension,
			extensionType: "extension",
			description: `Weather via ${extension}`,
			score: 0.5,
		});
		const textarea = await setupAndFocus(page, mockApi, {
			tools: [clash("open-meteo"), clash("weather-api"), SUGGEST_TOOLS[0]],
		});
		await textarea.pressSequentially(DRAFT, { delay: 25 });
		await expect(popover(page)).toBeVisible({ timeout: 4000 });

		const chips = page.getByTestId("suggestion-tool-chip");
		await expect(chips.nth(0)).toHaveText(/weather-now · open-meteo/);
		await expect(chips.nth(1)).toHaveText(/weather-now · weather-api/);
		// Unique names stay bare — no suffix noise when there's no collision.
		await expect(chips.nth(2)).toHaveText(/^🔧 scan$/);

		await captureEvidence(page, testInfo, "composer-suggestions-chip-disambiguation");
	});

	test("sidecar absent: chips render, enhancement row does not", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi, {
			tools: SUGGEST_TOOLS,
			enhancement: null,
			llmAvailable: false,
		});
		await textarea.pressSequentially(DRAFT, { delay: 25 });
		await expect(popover(page)).toBeVisible({ timeout: 4000 });
		await expect(page.getByTestId("suggestion-enhance-row")).not.toBeVisible();
		await expect(page.getByTestId("suggestion-apply")).not.toBeVisible();
	});

	test("suggest requests carry the authoritative modeId and split includes", async ({ page, mockApi }) => {
		const bodies: Array<Record<string, unknown>> = [];
		const textarea = await setupAndFocus(page, mockApi, { tools: SUGGEST_TOOLS, enhancement: ENHANCEMENT });
		// Registered AFTER mockApi → takes precedence; record then fall through.
		await page.route("**/api/composer/suggest", async (route: any) => {
			bodies.push(route.request().postDataJSON());
			await route.fallback();
		});

		await textarea.pressSequentially(DRAFT, { delay: 25 });
		await expect(popover(page)).toBeVisible({ timeout: 4000 });

		expect(bodies.length).toBeGreaterThanOrEqual(2);
		const includes = bodies.map((b) => (b.include as string[]).join(",")).sort();
		expect(includes).toContain("tools");
		expect(includes).toContain("enhance");
		for (const body of bodies) {
			expect(body).toHaveProperty("modeId", null); // no mode selected → explicit null
			expect(body.conversationId).toBe(conv.id);
			// Per-project toggle fallback rides along (server prefers the
			// conversation's own project when it resolves).
			expect(body.projectId).toBe(proj.id);
			expect(body.draft).toBe(DRAFT);
		}
	});
});
