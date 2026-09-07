import { test, expect, waitForHydration } from "../fixtures/hydration.js";
import type { APIRequestContext, Browser, BrowserContext } from "@playwright/test";
import { captureEvidence } from "../fixtures/evidence.js";

async function inviteVerifiedMember({
	request,
	baseURL,
	browser,
	email,
	name,
}: {
	request: APIRequestContext;
	baseURL: string | undefined;
	browser: Browser;
	email: string;
	name: string;
}): Promise<BrowserContext> {
	const inviteResponse = await request.post("/api/auth/invite", {
		data: { email, role: "member" },
	});
	expect(inviteResponse.status(), await inviteResponse.text()).toBe(201);
	const { invite } = (await inviteResponse.json()) as { invite: { token: string } };
	const memberContext = await browser.newContext({ baseURL });
	try {
		const accepted = await memberContext.request.post(`/api/auth/invite/${invite.token}`, {
			data: { name, email, password: "Audit-Local-Pw-9x!" },
		});
		expect(accepted.status(), await accepted.text()).toBe(201);
		const me = await memberContext.request.get("/api/auth/me");
		expect(me.status()).toBe(200);
		expect(((await me.json()) as { user: { role: string } }).user.role).toBe("member");
		return memberContext;
	} catch (error) {
		await memberContext.close();
		throw error;
	}
}

test.describe("@evidence audit web regressions", () => {
	test("a real invited member completes onboarding without server-refused provider writes", async ({
		request,
		baseURL,
		browser,
	}, testInfo) => {
		const email = `audit-member-${Date.now()}@example.com`;
		const memberRequest = await inviteVerifiedMember({
			request,
			baseURL,
			browser,
			email,
			name: "Audit Member",
		});
		try {
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
			await page.getByRole("button", { name: "Get started" }).click();
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

	test("a memory owner edits and deletes through the UI while an invited member cannot discover it", async ({
		request,
		baseURL,
		browser,
		page,
	}, testInfo) => {
		const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const originalContent = `Owner-only memory ${nonce}`;
		const editedContent = `Owner-edited memory ${nonce}`;
		const createdResponse = await request.post("/api/memories", {
			data: {
				content: originalContent,
				category: "preferences",
				confidence: "high",
			},
		});
		expect(createdResponse.status(), await createdResponse.text()).toBe(201);
		const created = (await createdResponse.json()) as { id: string; content: string; injectionEligible: boolean };
		expect(created.content).toBe(originalContent);
		expect(created.injectionEligible).toBe(true);

		const memberEmail = `memory-member-${nonce}@example.com`;
		const memberContext = await inviteVerifiedMember({
			request,
			baseURL,
			browser,
			email: memberEmail,
			name: "Memory Scope Member",
		});
		try {
			const memberList = await memberContext.request.get("/api/memories?scope=all");
			expect(memberList.status()).toBe(200);
			const visibleMemories = (await memberList.json()) as Array<{ id: string; content: string }>;
			expect(visibleMemories.some((memory) => memory.id === created.id || memory.content === originalContent)).toBe(false);
			const memberItem = await memberContext.request.get(`/api/memories/${created.id}`);
			expect(memberItem.status()).toBe(404);
		} finally {
			await memberContext.close();
		}

		await page.goto("/memories");
		await waitForHydration(page);
		const ownerRow = page.getByTestId("memory-row").filter({ hasText: originalContent });
		await expect(ownerRow).toBeVisible();
		await ownerRow.getByText(originalContent, { exact: true }).click();
		await expect(ownerRow.getByRole("button", { name: "Edit" })).toBeVisible();
		await ownerRow.getByRole("button", { name: "Edit" }).click();
		await ownerRow.locator("textarea").fill(editedContent);
		const updateResponse = page.waitForResponse(
			(response) => response.url().endsWith(`/api/memories/${created.id}`) && response.request().method() === "PUT",
		);
		await ownerRow.getByRole("button", { name: "Save" }).click();
		expect((await updateResponse).status()).toBe(200);
		const editedRow = page.getByTestId("memory-row").filter({ hasText: editedContent });
		await expect(editedRow.locator("p")).toHaveText(editedContent);

		const persisted = await request.get(`/api/memories/${created.id}`);
		expect(persisted.status()).toBe(200);
		expect(((await persisted.json()) as { content: string }).content).toBe(editedContent);

		const injectionToggle = editedRow.getByTestId("injection-eligibility-toggle");
		await expect(injectionToggle).toHaveAttribute("data-state", "allowed");
		const toggleResponse = page.waitForResponse(
			(response) => response.url().endsWith(`/api/memories/${created.id}`) && response.request().method() === "PATCH",
		);
		await injectionToggle.click();
		expect((await toggleResponse).status()).toBe(200);
		await expect(injectionToggle).toHaveAttribute("data-state", "excluded");
		await page.evaluate(() => {
			localStorage.setItem("ezcorp-theme", "light");
			document.documentElement.classList.remove("dark");
		});
		await expect(page.locator("html")).not.toHaveClass(/dark/);
		await captureEvidence(page, testInfo, "memory-owner-ui-edited-and-excluded-light", { fullPage: true });
		await page.evaluate(() => {
			localStorage.setItem("ezcorp-theme", "dark");
			document.documentElement.classList.add("dark");
		});
		await expect(page.locator("html")).toHaveClass(/dark/);
		await captureEvidence(page, testInfo, "memory-owner-ui-edited-and-excluded-dark", { fullPage: true });
		await page.evaluate(() => {
			localStorage.setItem("ezcorp-theme", "light");
			document.documentElement.classList.remove("dark");
		});

		await editedRow.getByRole("button", { name: "Delete" }).click();
		await expect(editedRow.getByRole("button", { name: "Confirm Delete?" })).toBeVisible();
		const deleteResponse = page.waitForResponse(
			(response) => response.url().endsWith(`/api/memories/${created.id}`) && response.request().method() === "DELETE",
		);
		await editedRow.getByRole("button", { name: "Confirm Delete?" }).click();
		expect((await deleteResponse).status()).toBe(204);
		await expect(editedRow).toHaveCount(0);
		const deleted = await request.get(`/api/memories/${created.id}`);
		expect(deleted.status()).toBe(404);
		await captureEvidence(page, testInfo, "memory-owner-ui-deleted", { fullPage: true });
	});

	test("an admin provider save refreshes the checklist before reload", async ({ page, request }, testInfo) => {
		const dbPath = process.env.PI_E2E_REAL_DB_PATH;
		const generatedDb = process.env.PI_E2E_REAL_DB_GENERATED === "1";
		expect(generatedDb && /^\/tmp\/ezcorp-e2e-/.test(dbPath ?? ""), "provider cleanup requires the generated disposable real-auth DB").toBe(true);

		let savedProvider = false;
		try {
			await page.route("**/api/providers/anthropic/refresh-models", (route) =>
				route.fulfill({ json: { success: true, count: 0, ids: [], fetchedAt: new Date().toISOString() } }),
			);
			await page.goto("/settings/models");
			const providerStep = page.getByText("Set up a provider", { exact: true });
			await expect(providerStep).not.toHaveClass(/line-through/);

			const anthropicCard = page.getByTestId("provider-card-anthropic");
			await anthropicCard.getByLabel("API key for Anthropic (Claude)", { exact: true }).fill(`audit-placeholder-${Date.now()}`);
			const saved = page.waitForResponse(
				(response) => response.url().endsWith("/api/providers") && response.request().method() === "POST",
			);
			await anthropicCard.getByRole("button", { name: "Save Key" }).click();
			expect((await saved).status()).toBe(200);
			savedProvider = true;
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
		} finally {
			if (savedProvider) {
				const removed = await request.delete("/api/providers", { data: { provider: "anthropic" } });
				expect(removed.status(), await removed.text()).toBe(200);
			}
		}
	});
});
