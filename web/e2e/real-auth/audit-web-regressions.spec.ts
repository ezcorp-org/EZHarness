import { test, expect, waitForHydration } from "../fixtures/hydration.js";
import { captureEvidence } from "../fixtures/evidence.js";

test.describe("@evidence audit web regressions", () => {
	test("a real invited member completes onboarding without server-refused provider writes", async ({
		request,
		baseURL,
		browser,
	}, testInfo) => {
		const email = `audit-member-${Date.now()}@example.com`;
		const inviteResponse = await request.post("/api/auth/invite", {
			data: { email, role: "member" },
		});
		expect(inviteResponse.status(), await inviteResponse.text()).toBe(201);
		const { invite } = (await inviteResponse.json()) as { invite: { token: string } };

		const memberRequest = await browser.newContext({ baseURL });
		try {
			const accepted = await memberRequest.request.post(`/api/auth/invite/${invite.token}`, {
				data: { name: "Audit Member", email, password: "Audit-Local-Pw-9x!" },
			});
			expect(accepted.status(), await accepted.text()).toBe(201);
			const me = await memberRequest.request.get("/api/auth/me");
			expect(((await me.json()) as { user: { role: string } }).user.role).toBe("member");

			const page = await memberRequest.newPage();
			const refusedWrites: string[] = [];
			page.on("request", (outgoing) => {
				const url = new URL(outgoing.url());
				if (
					(outgoing.method() === "POST" && url.pathname === "/api/providers") ||
					(outgoing.method() === "PUT" && url.pathname.startsWith("/api/settings/"))
				) {
					refusedWrites.push(`${outgoing.method()} ${url.pathname}`);
				}
			});

			await page.goto("/");
			await waitForHydration(page);
			await page.waitForURL(/\/onboarding$/, { timeout: 10_000 });
			await expect(page.getByTestId("member-provider-guidance")).toBeVisible();
			await expect(page.locator('input[type="password"]')).toHaveCount(0);
			await page.getByTestId("onboarding-step1-continue").click();
			await expect(page.getByTestId("member-tier-guidance")).toBeVisible();
			await expect(page.getByLabel("Default model tier")).toHaveCount(0);
			await page.getByTestId("onboarding-step2-continue").click();
			await captureEvidence(page, testInfo, "member-onboarding-handoff", { fullPage: true });
			await page.getByRole("button", { name: "Finish" }).click();
			await page.waitForURL(/\/project\/[^/]+\/chat/, { timeout: 10_000 });

			const banner = page.locator('[data-testid="no-provider-banner"]:visible');
			await expect(banner).toContainText("An administrator needs to connect a provider");
			await expect(banner.getByTestId("no-provider-banner-cta")).toHaveCount(0);
			expect(refusedWrites).toEqual([]);
			await captureEvidence(page, testInfo, "member-chat-provider-handoff", { fullPage: true });
		} finally {
			await memberRequest.close();
		}
	});

	test("an admin provider save refreshes the checklist before reload", async ({ page }, testInfo) => {
		await page.goto("/settings/models");
		const providerStep = page.getByText("Set up a provider", { exact: true });
		await expect(providerStep).not.toHaveClass(/line-through/);

		await page.getByLabel("API key for Anthropic").fill("audit-placeholder-key");
		const saved = page.waitForResponse(
			(response) => response.url().endsWith("/api/providers") && response.request().method() === "POST",
		);
		await page.getByRole("button", { name: "Save Key" }).click();
		expect((await saved).status()).toBe(200);
		// A seeded fresh DB can already have the other three steps. In that
		// case this final mutation correctly dismisses the checklist; otherwise
		// its provider row changes in place. Either outcome proves refresh, not
		// a stale sidebar that changes only after reload.
		await expect
			.poll(async () => {
				if ((await providerStep.count()) === 0) return "dismissed";
				return (await providerStep.getAttribute("class")) ?? "";
			})
			.toMatch(/dismissed|line-through/);
		await captureEvidence(page, testInfo, "quickstart-provider-refreshed", { fullPage: true });
	});
});
