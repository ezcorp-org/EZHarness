import { test, expect } from "./fixtures/test-base.js";
import { makeAgent, makeWorkflow } from "./fixtures/data.js";
import { captureEvidence } from "./fixtures/evidence.js";

// Duplicate is the platform's ONE copy verb. It used to be two — a
// client-side "Duplicate" that navigated to a prefilled create form, and a
// server-side "Fork" that wrote the row on click. The server one survived
// (it carries `forked_from` provenance and the global name-collision
// rule); what survived from Duplicate is that you decide BEFORE anything
// is written.
//
// Four properties are visible from the browser and worth pinning:
//
//  1. There is exactly ONE copy button. Two were the bug.
//  2. Clicking it commits nothing — it opens a panel with a name and an
//     audience. The old Fork POSTed on click and stamped `project`, which
//     on the read/run ladder is every account on the instance.
//  3. The default audience is "Only me". A copy is yours until you widen
//     it.
//  4. The copy's NAME is decided server-side. `workflow_definitions.name`
//     is globally unique — ownership authorizes a workflow, it never
//     namespaces one — so a taken name is auto-suffixed and the UI must
//     navigate to whatever it actually ended up called.

const WORKFLOW = makeWorkflow({
	name: "docs-factory",
	description: "writes the docs",
	steps: [{ name: "step-1", agent: "summarizer" }],
});

/** `rgb(r, g, b)` → relative luminance, per WCAG 2.x. */
function luminance(rgb: string): number {
	const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? ["0", "0", "0"]).slice(0, 3).map(Number) as [
		number,
		number,
		number,
	];
	const channel = (v: number) => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two `rgb()` strings. */
function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
}

/** The three colours the copy panel's legibility actually rests on. */
async function readPanelColors(page: import("@playwright/test").Page) {
	return page.evaluate(() => {
		const at = (id: string) =>
			document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
		const panel = at("workflow-duplicate-panel");
		const note = at("duplicate-visibility-note");
		const input = at("duplicate-name");
		if (!panel || !note || !input) throw new Error("copy panel is not on the page");
		return {
			panelBg: getComputedStyle(panel).backgroundColor,
			noteText: getComputedStyle(note).color,
			inputText: getComputedStyle(input).color,
		};
	});
}

test.describe("Duplicate a workflow", () => {
	test.beforeEach(async ({ mockApi }) => {
		await mockApi({
			agents: [makeAgent({ name: "summarizer" })],
			workflows: [WORKFLOW],
		});
	});

	async function openDetail(page: import("@playwright/test").Page, name = WORKFLOW.name) {
		const response = await page.goto(`/workflows/${encodeURIComponent(name)}`);
		const finalUrl = response ? new URL(response.url()).pathname : "";
		test.skip(
			!finalUrl.startsWith("/workflows/"),
			"auth gate redirected away from the workflow page in this environment",
		);
		await expect(page.getByRole("heading", { name })).toBeVisible({ timeout: 5000 });
	}

	test("@evidence one copy affordance, and it asks before it writes", async ({
		page,
	}, testInfo) => {
		await openDetail(page);

		// Exactly one. The retired "Fork" button is gone, not renamed away
		// into a second pill that happens to say something else.
		await expect(page.getByTestId("workflow-duplicate")).toBeVisible();
		await expect(page.getByTestId("fork-workflow")).toHaveCount(0);
		await expect(page.getByTestId("edit-workflow")).toBeVisible();
		await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();

		// Nothing is written on click — a POST here would be the old bug.
		let posts = 0;
		await page.route(`**/api/workflows/${WORKFLOW.name}/fork`, (route) => {
			posts += 1;
			return route.fulfill({ status: 201, json: { name: "x", id: "x", forkedFrom: "x" } });
		});
		await page.getByTestId("workflow-duplicate").click();

		const panel = page.getByTestId("workflow-duplicate-panel");
		await expect(panel).toBeVisible();
		expect(posts).toBe(0);

		// The two decisions worth stopping for, both pre-filled with the safe
		// answer: a non-colliding name, and the narrowest audience.
		await expect(page.getByTestId("duplicate-name")).toHaveValue("docs-factory-copy");
		await expect(page.getByTestId("duplicate-visibility")).toHaveValue("private");
		await expect(page.getByTestId("duplicate-visibility-note")).toContainText(/only me|nobody else/i);

		await captureEvidence(page, testInfo, "workflow-duplicate-panel", { fullPage: true });
	});

	test("@evidence the wider tier says what it actually means", async ({ page }, testInfo) => {
		// "project" reads like "my team". It is not: the platform has no
		// membership model, so the tier admits every account on the instance.
		// The panel has to say so at the moment of choosing.
		await openDetail(page);
		await page.getByTestId("workflow-duplicate").click();
		await page.getByTestId("duplicate-visibility").selectOption("project");

		await expect(page.getByTestId("duplicate-visibility-note")).toContainText(/every account/i);
		await captureEvidence(page, testInfo, "workflow-duplicate-wider-tier");
	});

	test("@evidence the panel is legible in LIGHT mode too", async ({ page }, testInfo) => {
		// The panel is new markup on a route page, and every colour in it has
		// to come from the semantic tokens rather than a fixed Tailwind ramp
		// value — a ramp picked against the dark surface is what produces
		// text nobody can read once the theme flips.
		//
		// MEASURED, not proxied. The first version of this test asserted
		// `html` lacks the `.dark` class and called it done; that passes
		// whether or not a single colour actually moved, which is a green
		// test about nothing. Computed colours are the only thing that says
		// the tokens flowed through.
		await page.addInitScript(() => localStorage.setItem("ezcorp-theme", "light"));
		await openDetail(page);
		await page.getByTestId("workflow-duplicate").click();
		await expect(page.getByTestId("workflow-duplicate-panel")).toBeVisible();

		const light = await readPanelColors(page);
		expect(luminance(light.panelBg)).toBeGreaterThan(0.8); // a light surface
		expect(luminance(light.inputText)).toBeLessThan(0.2); // dark text on it
		// The explanatory note is the smallest, dimmest text in the panel and
		// therefore the first thing to become unreadable. WCAG AA for body
		// text is 4.5:1.
		expect(contrast(light.noteText, light.panelBg)).toBeGreaterThan(4.5);

		await captureEvidence(page, testInfo, "workflow-duplicate-panel-light");
	});

	test("the same panel clears AA in dark mode, and is not the same colours", async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem("ezcorp-theme", "dark"));
		await openDetail(page);
		await page.getByTestId("workflow-duplicate").click();
		await expect(page.getByTestId("workflow-duplicate-panel")).toBeVisible();

		const dark = await readPanelColors(page);
		expect(luminance(dark.panelBg)).toBeLessThan(0.2);
		expect(contrast(dark.noteText, dark.panelBg)).toBeGreaterThan(4.5);
	});

	test("the copy is created with the name and tier the user chose", async ({ page }) => {
		let body: Record<string, unknown> | null = null;
		await page.route(`**/api/workflows/${WORKFLOW.name}/fork`, (route) => {
			body = route.request().postDataJSON();
			// The server suffixed because the chosen name was already taken.
			return route.fulfill({
				status: 201,
				json: {
					name: "my-docs-2",
					id: "wf-copy-1",
					forkedFrom: WORKFLOW.name,
					visibility: "project",
				},
			});
		});

		await openDetail(page);
		await page.getByTestId("workflow-duplicate").click();
		await page.getByTestId("duplicate-name").fill("my-docs");
		await page.getByTestId("duplicate-visibility").selectOption("project");
		await page.getByTestId("duplicate-confirm").click();

		// Lands on the name the SERVER chose, not the one that was asked for.
		await expect(page).toHaveURL(/\/workflows\/my-docs-2\/edit$/, { timeout: 5000 });
		expect(body).toMatchObject({ name: "my-docs", visibility: "project" });
	});

	test("the default submit sends `private`, not the old `project`", async ({ page }) => {
		let body: Record<string, unknown> | null = null;
		await page.route(`**/api/workflows/${WORKFLOW.name}/fork`, (route) => {
			body = route.request().postDataJSON();
			return route.fulfill({
				status: 201,
				json: {
					name: "docs-factory-copy",
					id: "wf-copy-2",
					forkedFrom: WORKFLOW.name,
					visibility: "private",
				},
			});
		});

		await openDetail(page);
		await page.getByTestId("workflow-duplicate").click();
		await page.getByTestId("duplicate-confirm").click();

		await expect(page).toHaveURL(/\/workflows\/docs-factory-copy\/edit$/, { timeout: 5000 });
		expect(body).toMatchObject({ name: "docs-factory-copy", visibility: "private" });
	});

	test("Cancel closes the panel and writes nothing", async ({ page }) => {
		let posts = 0;
		await page.route(`**/api/workflows/${WORKFLOW.name}/fork`, (route) => {
			posts += 1;
			return route.fulfill({ status: 201, json: { name: "x", id: "x", forkedFrom: "x" } });
		});

		await openDetail(page);
		await page.getByTestId("workflow-duplicate").click();
		await expect(page.getByTestId("workflow-duplicate-panel")).toBeVisible();
		await page.getByTestId("duplicate-cancel").click();

		await expect(page.getByTestId("workflow-duplicate-panel")).toHaveCount(0);
		expect(posts).toBe(0);
		await expect(page).toHaveURL(new RegExp(`/workflows/${WORKFLOW.name}$`));
	});

	test("the button is a disclosure toggle, never a greyed-out dead pill", async ({ page }) => {
		// It used to `disabled` itself while its own panel was open, which
		// paints "this action is unavailable" at the exact moment the user is
		// using it. It owns the panel, so it closes it too.
		await openDetail(page);
		const button = page.getByTestId("workflow-duplicate");

		await expect(button).toBeEnabled();
		await expect(button).toHaveAttribute("aria-expanded", "false");

		await button.click();
		await expect(page.getByTestId("workflow-duplicate-panel")).toBeVisible();
		await expect(button).toBeEnabled();
		await expect(button).toHaveAttribute("aria-expanded", "true");

		await button.click();
		await expect(page.getByTestId("workflow-duplicate-panel")).toHaveCount(0);
		await expect(button).toHaveAttribute("aria-expanded", "false");
	});

	test("a failed copy surfaces the error and leaves the panel open", async ({ page }) => {
		// The user's chosen name and tier must survive the failure — the whole
		// point of deciding first is not being made to decide twice.
		await page.route(`**/api/workflows/${WORKFLOW.name}/fork`, (route) =>
			route.fulfill({
				status: 409,
				json: { error: 'A workflow named "docs-factory-copy" already exists' },
			}),
		);

		await openDetail(page);
		await page.getByTestId("workflow-duplicate").click();
		await page.getByTestId("duplicate-visibility").selectOption("project");
		await page.getByTestId("duplicate-confirm").click();

		await expect(page.getByTestId("duplicate-error")).toBeVisible({ timeout: 3000 });
		await expect(page.getByTestId("workflow-duplicate-panel")).toBeVisible();
		await expect(page.getByTestId("duplicate-visibility")).toHaveValue("project");
		await expect(page).toHaveURL(new RegExp(`/workflows/${WORKFLOW.name}$`));
	});

	test("a copy of an extension workflow drops the namespace", async ({ page, mockApi }) => {
		const namespaced = makeWorkflow({
			name: "ez-factory:docs-factory",
			description: "shipped by an extension",
			steps: [{ name: "step-1", agent: "summarizer" }],
		});
		await mockApi({ agents: [makeAgent({ name: "summarizer" })], workflows: [namespaced] });

		await openDetail(page, namespaced.name);
		await page.getByTestId("workflow-duplicate").click();

		// ':' cannot appear in a declared workflow name, so the copy could
		// never keep its source name — the prefill has already dropped it,
		// before the server ever sees the request.
		await expect(page.getByTestId("duplicate-name")).toHaveValue("docs-factory-copy");
	});
});
