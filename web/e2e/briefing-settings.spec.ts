/**
 * Daily Briefing e2e — settings page CRUD + Run now handling +
 * watchlist manager round-trip (spec §5.4; watchlist per §4.3/§10).
 *
 * Pure render/wiring spec: runs in plain preview via mockApi —
 * `/api/briefing/*` is mocked per-test with page.route registered
 * AFTER mockApi so Playwright matches it first. The combined
 * "Run now → conversation appears live in the sidebar" exit flow
 * lives in briefing-live-delivery.spec.ts; the chat-tool confirmation
 * card lives in briefing-watch-tool-card.spec.ts.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const STORED_CONFIG = {
	userId: "user-1",
	enabled: true,
	cron: "30 8 * * 1-5",
	timezone: "Europe/Berlin",
	projectId: "proj-a",
	instructions: "Focus on work threads.",
	watchlist: [],
	model: null,
	provider: null,
	lastFireAt: "2026-06-11T07:00:00.000Z",
	lastFireStatus: "ok",
	consecutiveErrors: 0,
	nextFireAt: "2026-06-12T06:30:00.000Z",
	createdAt: "2026-06-01T00:00:00.000Z",
	updatedAt: "2026-06-10T00:00:00.000Z",
};

test.describe("Daily Briefing settings page", () => {
	const proj = makeProject({ id: "proj-a", name: "Alpha" });

	test("loads a stored config, edits it, and PUTs the picker-built cron", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });

		let putBody: Record<string, unknown> | null = null;
		await page.route("**/api/briefing/config", async (route) => {
			if (route.request().method() === "PUT") {
				putBody = route.request().postDataJSON();
				return route.fulfill({ json: { ...STORED_CONFIG, ...putBody } });
			}
			return route.fulfill({ json: STORED_CONFIG });
		});

		await page.goto("/settings/briefing");

		// Loaded state: pickers reflect the stored UI-written cron.
		await expect(page.getByTestId("briefing-enable-toggle")).toBeChecked();
		await expect(page.getByTestId("briefing-time")).toHaveValue("08:30");
		await expect(page.getByTestId("briefing-preset")).toHaveValue("weekdays");
		await expect(page.getByTestId("briefing-schedule-desc")).toContainText("Weekdays at 08:30");
		await expect(page.getByTestId("briefing-timezone")).toHaveValue("Europe/Berlin");
		await expect(page.getByTestId("briefing-project")).toHaveValue("proj-a");
		await expect(page.getByTestId("briefing-instructions")).toHaveValue("Focus on work threads.");
		await expect(page.getByTestId("briefing-last-run")).toContainText("delivered");

		// Edit: time + preset + instructions, then save.
		await page.getByTestId("briefing-time").fill("06:15");
		await page.getByTestId("briefing-preset").selectOption("daily");
		await page.getByTestId("briefing-instructions").fill("Short and sweet.");
		await page.getByTestId("briefing-save").click();

		await expect(page.getByTestId("briefing-save-success")).toBeVisible();
		expect(putBody).toMatchObject({
			enabled: true,
			cron: "15 6 * * *",
			timezone: "Europe/Berlin",
			projectId: "proj-a",
			instructions: "Short and sweet.",
			model: null,
			provider: null,
		});
		// An UNTOUCHED watchlist must stay out of the PUT body — the
		// server's preserve-on-omit semantics keep chat-added topics safe
		// from unrelated settings saves.
		expect(putBody).not.toHaveProperty("watchlist");
	});

	test("watchlist round-trip: stored topics render; remove + add persist through PUT and survive a reload", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj] });

		// Stateful route so the post-reload assertions prove the page
		// renders what was PERSISTED, not leftover client state.
		let stored: Record<string, unknown> = {
			...STORED_CONFIG,
			watchlist: [
				{ topic: "Bun 2.0 release", addedAt: "2026-06-01T00:00:00.000Z" },
				{ topic: "PGlite roadmap", addedAt: "2026-06-02T00:00:00.000Z" },
			],
		};
		const putBodies: Array<Record<string, unknown>> = [];
		await page.route("**/api/briefing/config", async (route) => {
			if (route.request().method() === "PUT") {
				const body = route.request().postDataJSON();
				putBodies.push(body);
				stored = { ...stored, ...body };
				return route.fulfill({ json: stored });
			}
			return route.fulfill({ json: stored });
		});

		await page.goto("/settings/briefing");

		// Stored topics (e.g. captured conversationally) are visible +
		// individually removable — the curation floor.
		const items = page.getByTestId("briefing-watchlist-item");
		await expect(items).toHaveCount(2);
		await expect(items.nth(0)).toContainText("Bun 2.0 release");
		await expect(items.nth(1)).toContainText("PGlite roadmap");

		// Remove one, add another, save.
		await page.getByTestId("briefing-watchlist-remove").first().click();
		await expect(items).toHaveCount(1);
		await page.getByTestId("briefing-watchlist-input").fill("EZCorp v1.4 launch");
		await page.getByTestId("briefing-watchlist-add").click();
		await expect(items).toHaveCount(2);
		await page.getByTestId("briefing-save").click();
		await expect(page.getByTestId("briefing-save-success")).toBeVisible();

		const watchlistPut = putBodies[0]!.watchlist as Array<{ topic: string }>;
		expect(watchlistPut.map((w) => w.topic)).toEqual(["PGlite roadmap", "EZCorp v1.4 launch"]);

		// Reload → the persisted list (not client state) renders.
		await page.reload();
		await expect(items).toHaveCount(2);
		await expect(items.nth(0)).toContainText("PGlite roadmap");
		await expect(items.nth(1)).toContainText("EZCorp v1.4 launch");

		// A follow-up save WITHOUT touching the watchlist omits the key
		// again (the dirty flag reset on the PUT echo / reload).
		await page.getByTestId("briefing-instructions").fill("unrelated change");
		await page.getByTestId("briefing-save").click();
		await expect(page.getByTestId("briefing-save-success")).toBeVisible();
		expect(putBodies[1]).not.toHaveProperty("watchlist");
	});

	test("watchlist guards: duplicate topic is rejected inline without losing the list", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj] });
		await page.route("**/api/briefing/config", (route) =>
			route.fulfill({
				json: {
					...STORED_CONFIG,
					watchlist: [{ topic: "Bun 2.0 release", addedAt: "2026-06-01T00:00:00.000Z" }],
				},
			}),
		);

		await page.goto("/settings/briefing");
		await expect(page.getByTestId("briefing-watchlist-item")).toHaveCount(1);

		await page.getByTestId("briefing-watchlist-input").fill("bun 2.0 RELEASE");
		await page.getByTestId("briefing-watchlist-add").click();
		await expect(page.getByTestId("briefing-watchlist-error")).toContainText("already on the watchlist");
		await expect(page.getByTestId("briefing-watchlist-item")).toHaveCount(1);
	});

	test("saved settings survive a reload — the fresh GET shows the persisted values", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj] });

		// Stateful route: PUT mutates the stored config, GET serves it —
		// so the post-reload assertions prove the page renders what was
		// PERSISTED, not leftover client state.
		let stored: Record<string, unknown> = { ...STORED_CONFIG };
		await page.route("**/api/briefing/config", async (route) => {
			if (route.request().method() === "PUT") {
				stored = { ...stored, ...route.request().postDataJSON() };
				return route.fulfill({ json: stored });
			}
			return route.fulfill({ json: stored });
		});

		await page.goto("/settings/briefing");
		await expect(page.getByTestId("briefing-time")).toHaveValue("08:30");

		await page.getByTestId("briefing-time").fill("09:45");
		await page.getByTestId("briefing-preset").selectOption("weekends");
		await page.getByTestId("briefing-instructions").fill("Persisted across reloads.");
		await page.getByTestId("briefing-save").click();
		await expect(page.getByTestId("briefing-save-success")).toBeVisible();

		await page.reload();

		await expect(page.getByTestId("briefing-time")).toHaveValue("09:45");
		await expect(page.getByTestId("briefing-preset")).toHaveValue("weekends");
		await expect(page.getByTestId("briefing-schedule-desc")).toContainText("Weekends at 09:45");
		await expect(page.getByTestId("briefing-instructions")).toHaveValue("Persisted across reloads.");
		await expect(page.getByTestId("briefing-timezone")).toHaveValue("Europe/Berlin");
	});

	test("hand-edited cron is shown read-only as a raw string", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.route("**/api/briefing/config", (route) =>
			route.fulfill({ json: { ...STORED_CONFIG, cron: "*/30 6-9 * * *" } }),
		);

		await page.goto("/settings/briefing");

		await expect(page.getByTestId("briefing-raw-cron")).toHaveText("*/30 6-9 * * *");
		await expect(page.getByTestId("briefing-time")).toHaveCount(0);

		// Switching back to the picker swaps in the time/preset controls.
		await page.getByTestId("briefing-use-picker").click();
		await expect(page.getByTestId("briefing-time")).toBeVisible();
		await expect(page.getByTestId("briefing-raw-cron")).toHaveCount(0);
	});

	test("Run now: 429 shows a countdown and disables the button; 503 degrades gracefully", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj] });
		await page.route("**/api/briefing/config", (route) => route.fulfill({ json: STORED_CONFIG }));

		// First click → 429 with a short retry window; later clicks → 503.
		let calls = 0;
		await page.route("**/api/briefing/run-now", (route) => {
			calls += 1;
			if (calls === 1) {
				return route.fulfill({
					status: 429,
					headers: { "Retry-After": "2" },
					json: { error: "Briefing was already run recently — try again later", retryAfter: 2 },
				});
			}
			return route.fulfill({
				status: 503,
				json: { error: "Briefing runtime is not available yet — try again shortly" },
			});
		});

		await page.goto("/settings/briefing");
		await expect(page.getByTestId("briefing-run-now")).toBeEnabled();

		// 429 → friendly countdown, button disabled while it ticks.
		await page.getByTestId("briefing-run-now").click();
		await expect(page.getByTestId("briefing-retry-countdown")).toContainText("try again in");
		await expect(page.getByTestId("briefing-run-now")).toBeDisabled();

		// Countdown expires → button recovers.
		await expect(page.getByTestId("briefing-run-now")).toBeEnabled({ timeout: 5000 });
		await expect(page.getByTestId("briefing-retry-countdown")).toHaveCount(0);

		// 503 → graceful message, no countdown, button stays usable.
		await page.getByTestId("briefing-run-now").click();
		await expect(page.getByTestId("briefing-run-now-message")).toContainText("still starting up");
		await expect(page.getByTestId("briefing-run-now")).toBeEnabled();
	});

	test("Run now: 202 confirms the briefing started", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.route("**/api/briefing/config", (route) => route.fulfill({ json: STORED_CONFIG }));
		await page.route("**/api/briefing/run-now", (route) =>
			route.fulfill({ status: 202, json: { started: true } }),
		);

		await page.goto("/settings/briefing");
		await page.getByTestId("briefing-run-now").click();
		await expect(page.getByTestId("briefing-run-now-message")).toContainText("Briefing started");
	});

	test("main settings page links to the briefing editor", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.route("**/api/briefing/config", (route) => route.fulfill({ json: STORED_CONFIG }));

		await page.goto("/settings");
		await expect(page.getByTestId("briefing-settings-link")).toBeVisible();
		await page.getByTestId("briefing-settings-link").click();
		await expect(page).toHaveURL(/\/settings\/briefing$/);
		await expect(page.getByRole("heading", { name: "Daily Briefing" }).first()).toBeVisible();
	});
});
