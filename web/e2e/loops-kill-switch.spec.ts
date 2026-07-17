/**
 * Loops EZ Mode Phase 2 — global kill switch admin control.
 *
 * The `/settings/admin` Loops Safety section shows the current state
 * (Running / Suspended) and a single confirm-gated toggle. Engaging the
 * switch requires a confirm — the copy states the honest scope: it suspends
 * scheduled fires (and "fire now") plus ALL extension event deliveries
 * (including non-loop extensions; dropped deliveries are lost, cron rows stay
 * due), while manual tool fires stay live and parked approvals are kept.
 * Resuming applies immediately. The toggle PUTs the persisted
 * `loops:kill_switch` setting — the same key the host schedule daemon +
 * event dispatcher read to gate fires.
 *
 * mockApi-driven: an admin opens the page, engages the switch through the
 * confirm, and the PUT payload is asserted. Frontend-visual change →
 * `@evidence`-tagged so the Visual evidence CI gate captures a screenshot.
 * `captureEvidence` is a hard no-op unless `EZCORP_E2E_EVIDENCE=1`, so the
 * normal `e2e-mock` run stays byte-identical.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "My Project" });
const adminMe = {
	user: { id: "admin-1", email: "admin@test.local", name: "Admin", role: "admin" },
};

// The admin page renders several sibling sections (Users / Teams / Invites /
// System Health). Each fetches its own endpoint on mount and dereferences the
// array field WITHOUT a fallback — an unmocked `{}` response throws
// (`reading 'length'`), which propagates through Svelte's reactive graph and
// blocks click handlers on the SAME page (the documented ApiKeyManager
// failure mode). So we hand every sibling a well-formed empty shape.
const adminSectionRoutes = {
	"/api/users": () => ({ users: [], total: 0 }),
	"/api/teams": () => ({ teams: [] }),
	"/api/auth/invite": () => ({ invites: [] }),
} as const;

test.describe("Loops Safety kill switch", () => {
	test("admin engages the kill switch through the confirm; the PUT carries value true", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], routes: { "/api/auth/me": () => adminMe, ...adminSectionRoutes } });
		await page.goto("/settings/admin");

		// Loaded, running.
		await expect(page.getByTestId("loops-kill-switch-status")).toHaveText("Running");
		const toggle = page.getByTestId("loops-kill-switch-toggle");
		await expect(toggle).toHaveText("Suspend all loops");

		// Engaging asks for confirmation first (no PUT yet).
		await toggle.click();
		await expect(page.getByTestId("loops-kill-switch-confirm")).toBeVisible();

		// Confirm → PUT loops:kill_switch = true.
		const putPromise = page.waitForRequest(
			(r) => r.method() === "PUT" && r.url().includes("/api/settings/loops:kill_switch"),
		);
		await page.getByTestId("loops-kill-switch-confirm-yes").click();
		const put = await putPromise;
		expect(put.postDataJSON()).toEqual({ value: true });

		// State flips to Suspended; the toggle now offers Resume.
		await expect(page.getByTestId("loops-kill-switch-status")).toHaveText("Suspended");
		await expect(page.getByTestId("loops-kill-switch-toggle")).toHaveText("Resume loops");
	});

	test("cancelling the confirm sends no PUT and stays running", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], routes: { "/api/auth/me": () => adminMe, ...adminSectionRoutes } });
		await page.goto("/settings/admin");

		await page.getByTestId("loops-kill-switch-toggle").click();
		await expect(page.getByTestId("loops-kill-switch-confirm")).toBeVisible();
		await page.getByTestId("loops-kill-switch-confirm-cancel").click();
		await expect(page.getByTestId("loops-kill-switch-confirm")).toHaveCount(0);
		await expect(page.getByTestId("loops-kill-switch-status")).toHaveText("Running");
	});

	test("resuming from a suspended state PUTs value false immediately (no confirm)", async ({ page, mockApi }) => {
		// Seed the switch as engaged so the page loads Suspended.
		await mockApi({
			projects: [proj],
			routes: {
				"/api/auth/me": () => adminMe,
				"/api/settings": () => ({ "loops:kill_switch": true }),
				...adminSectionRoutes,
			},
		});
		await page.goto("/settings/admin");

		await expect(page.getByTestId("loops-kill-switch-status")).toHaveText("Suspended");
		const putPromise = page.waitForRequest(
			(r) => r.method() === "PUT" && r.url().includes("/api/settings/loops:kill_switch"),
		);
		await page.getByTestId("loops-kill-switch-toggle").click(); // Resume — no confirm
		const put = await putPromise;
		expect(put.postDataJSON()).toEqual({ value: false });
		await expect(page.getByTestId("loops-kill-switch-status")).toHaveText("Running");
	});

	test("renders the Loops Safety control and captures evidence @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [proj], routes: { "/api/auth/me": () => adminMe, ...adminSectionRoutes } });
		await page.goto("/settings/admin");

		await expect(page.getByTestId("loops-kill-switch")).toBeVisible();
		await expect(page.getByTestId("loops-kill-switch-status")).toHaveText("Running");
		await captureEvidence(page, testInfo, "loops-kill-switch");

		// Second state: the engage confirm panel.
		await page.getByTestId("loops-kill-switch-toggle").click();
		await expect(page.getByTestId("loops-kill-switch-confirm")).toBeVisible();
		await captureEvidence(page, testInfo, "loops-kill-switch-confirm");

		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) => a.name === "loops-kill-switch" && a.contentType === "image/png",
				),
			).toBe(true);
		} else {
			expect(testInfo.attachments.some((a) => a.name === "loops-kill-switch")).toBe(false);
		}
	});
});
