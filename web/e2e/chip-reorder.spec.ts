/** Real browser gestures must save the complete extension order in the database. */
import AxeBuilder from "@axe-core/playwright";
import type { APIRequestContext, Locator, Page, TestInfo } from "@playwright/test";
import { test as base, expect } from "./fixtures/hydration.js";
import { dragMouse, dragTouch, stableBoundingBox } from "./fixtures/gestures.js";
import { captureEvidence } from "./fixtures/evidence.js";

interface AgentFixture { id: string; name: string; extensions: string[] }
const test = base.extend<{ agent: AgentFixture }>({
	agent: async ({ request }, use) => {
		const seeded = await request.post("/api/__test/seed", { data: { seedAgentConfig: true } });
		expect(seeded.status(), await seeded.text()).toBe(201);
		const seed = (await seeded.json()) as { agentExtensions: Array<{ id: string; name: string }> };
		const extensions = seed.agentExtensions.map(({ id }) => id);
		expect(extensions).toHaveLength(3);
		const created = await request.post("/api/agent-configs", {
			data: { name: `chip-order-${crypto.randomUUID()}`, prompt: "Keep the selected extension order.", extensions },
		});
		expect(created.status(), await created.text()).toBe(201);
		const agent = (await created.json()) as AgentFixture;
		try {
			await use(agent);
		} finally {
			const removed = await request.delete(`/api/agent-configs/${agent.id}`);
			expect(removed.ok(), await removed.text()).toBe(true);
		}
	},
});

function chips(page: Page): Locator {
	return page.getByTestId("selected-extension-chips").locator("[data-chip-id]");
}
async function order(page: Page): Promise<(string | null)[]> {
	return chips(page).evaluateAll(elements => elements.map(element => element.getAttribute("data-chip-id")));
}
async function openAgent(page: Page, agent: AgentFixture): Promise<void> {
	await page.goto(`/agents/${agent.name}`);
	await expect(page.getByRole("heading", { name: `Edit Agent: ${agent.name}` })).toBeVisible();
	await expect.poll(() => order(page)).toEqual(agent.extensions);
	// Native mouse/CDP gestures need the same hit-target readiness as clicks.
	// Hydration can finish while the transparent splash is still fading out.
	await chips(page).nth(0).click({ trial: true });
	// Trial actionability can scroll the row to an edge on mobile. Center it
	// afterwards so a drag over the first chip does not request auto-scroll.
	await page.getByTestId("selected-extension-chips").evaluate(element => element.scrollIntoView({ block: "center", behavior: "instant" }));
	await expect.poll(async () => (await chips(page).nth(0).boundingBox())?.y ?? 0).toBeGreaterThan(100);
}
async function saveAndReload(page: Page, request: APIRequestContext, agent: AgentFixture, expected: string[]): Promise<void> {
	// Finalize runs after the drop animation; the preview order alone is not saved state.
	await expect(page.locator("#dnd-action-dragged-el")).toHaveCount(0);
	await expect.poll(() => order(page)).toEqual(expected);
	const [saved] = await Promise.all([
		page.waitForResponse(response => response.url().endsWith(`/api/agent-configs/${agent.id}`) && response.request().method() === "PUT"),
		page.getByRole("button", { name: "Save Agent", exact: true }).click(),
	]);
	expect(saved.ok(), await saved.text()).toBe(true);
	expect((await saved.json()).extensions).toEqual(expected);
	const stored = await request.get(`/api/agent-configs/${agent.id}`);
	expect(stored.ok(), await stored.text()).toBe(true);
	expect((await stored.json()).extensions).toEqual(expected);
	await page.goto(`/agents/${agent.name}`);
	await page.reload();
	await expect.poll(() => order(page)).toEqual(expected);
}
async function chipPoint(chip: Locator): Promise<{ x: number; y: number }> {
	// `stableBoundingBox`, not `boundingBox`: the webfont swap re-wraps this row
	// and a native press has no actionability re-check to save it.
	const box = await stableBoundingBox(chip);
	// Stay over the label: the remove button has its own pointer behavior.
	return { x: box.x + 8, y: box.y + box.height / 2 };
}

type DragGesture = typeof dragMouse;

/** Drag the last chip onto the first one and confirm the live preview before release. */
async function dragLastChipToFront(page: Page, agent: AgentFixture, drag: DragGesture): Promise<void> {
	const from = await chipPoint(chips(page).nth(2));
	const to = await chipPoint(chips(page).nth(0));
	await drag(page, from, to, async () => {
		// Name the chip the gesture actually picked up. A press that lands on a
		// neighbour still produces a ghost, so without this the only symptom is
		// an order that never changes — five seconds later, and about the wrong
		// chip.
		await expect(page.locator("#dnd-action-dragged-el")).toHaveAttribute("data-chip-id", agent.extensions[2]!);
		await expect.poll(async () => (await order(page)).slice(1)).toEqual(agent.extensions.slice(0, 2));
	});
}

/** Persist the dragged order, prove it round-trips, and attach the shots. */
async function saveReorderWithEvidence(page: Page, request: APIRequestContext, agent: AgentFixture, testInfo: TestInfo): Promise<void> {
	await saveAndReload(page, request, agent, [agent.extensions[2]!, agent.extensions[0]!, agent.extensions[1]!]);
	await captureEvidence(page, testInfo, "agent-header-after-reorder");
	await page.getByTestId("selected-extension-chips").scrollIntoViewIfNeeded();
	await captureEvidence(page, testInfo, "saved-extension-order");
}

test("mouse reorder survives Save, database read, and page reload @evidence", async ({ page, request, agent }, testInfo) => {
	await openAgent(page, agent);
	await dragLastChipToFront(page, agent, dragMouse);
	await saveReorderWithEvidence(page, request, agent, testInfo);
});

test.describe("touch", () => {
	test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
	test("finger drag saves the exact new order @evidence", async ({ page, request, agent }, testInfo) => {
		await openAgent(page, agent);
		await dragLastChipToFront(page, agent, dragTouch);
		await saveReorderWithEvidence(page, request, agent, testInfo);
	});
});

test("keyboard reorder saves the exact new order", async ({ page, request, agent }) => {
	await openAgent(page, agent);
	await chips(page).nth(0).focus();
	await page.keyboard.press("Space");
	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("Enter");
	await saveAndReload(page, request, agent, [agent.extensions[1]!, agent.extensions[0]!, agent.extensions[2]!]);
});

test("Escape releases keyboard drag without changing the saved order", async ({ page, request, agent }) => {
	await openAgent(page, agent);
	await chips(page).nth(0).focus();
	await page.keyboard.press("Space");
	await page.keyboard.press("Escape");
	await page.keyboard.press("ArrowRight");
	await saveAndReload(page, request, agent, agent.extensions);
});

test("selected extension controls have no accessibility violations", async ({ page, agent }) => {
	await openAgent(page, agent);
	const results = await new AxeBuilder({ page }).include('[data-testid="selected-extension-chips"]').analyze();
	expect(results.violations).toEqual([]);
});
