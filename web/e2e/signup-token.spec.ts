import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures/hydration.js";
import { captureEvidence } from "./fixtures/evidence.js";

async function createInvite(request: APIRequestContext) {
	const email = `signup-${crypto.randomUUID()}@example.com`;
	const response = await request.post("/api/auth/invite", { data: { email, role: "member" } });
	expect(response.status(), await response.text()).toBe(201);
	const { invite } = await response.json() as { invite: { token: string; email: string } };
	expect(invite.email).toBe(email);
	return invite;
}

async function openSignup(page: Page, token: string, url = `/signup/${token}`) {
	// The API request fixture retains its admin session; this browser becomes
	// the invited visitor and executes the real server load without a cookie.
	await page.context().clearCookies();
	await page.goto(url);
	await expect(page.getByRole("heading", { name: "Join EZCorp" })).toBeVisible();
}

async function fillSignup(page: Page) {
	await page.getByLabel("Name", { exact: true }).fill("Invited Member");
	await page.getByLabel("Password", { exact: true }).fill("Signup-test-password-93!");
}

test.describe("Signup Token Page — real invite and session", () => {
	test("an admin's copied invite opens the signup form for an anonymous visitor @evidence", async ({ page, request, baseURL }, testInfo) => {
		const otherInvite = await createInvite(request); // Another valid invite can remain from a prior real-auth case.
		const invite = await createInvite(request);
		await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
		await page.goto("/settings/admin");
		const invites = page.locator("#invites");
		await expect(invites.getByText(otherInvite.email, { exact: true })).toBeVisible();
		const inviteRow = invites.getByText(invite.email, { exact: true }).locator("../..");
		await expect(inviteRow).toBeVisible();
		await inviteRow.getByRole("button", { name: "Copy Link", exact: true }).click();
		const copied = await page.evaluate(() => navigator.clipboard.readText());
		expect(new URL(copied).origin).toBe(new URL(baseURL!).origin);
		expect(new URL(copied).pathname).toBe(`/signup/${invite.token}`);

		await openSignup(page, invite.token, copied);
		await expect(page.getByLabel("Email", { exact: true })).toHaveValue(invite.email);
		await captureEvidence(page, testInfo, "copied-invite-signup-form");
	});

	test("an admin creates and deletes an invite through settings @evidence", async ({ page, request }, testInfo) => {
		const email = `settings-invite-${crypto.randomUUID()}@example.com`;
		await page.goto("/settings/admin");
		const invites = page.locator("#invites");
		await expect(invites.getByRole("button", { name: "Create Invite", exact: true })).toBeDisabled();
		await invites.getByLabel("Email (required)").fill("invalid");
		await expect(invites.getByRole("button", { name: "Create Invite", exact: true })).toBeDisabled();
		await expect(invites.getByText("Enter a valid email address to create an invite.", { exact: true })).toBeVisible();
		await invites.getByLabel("Email (required)").fill("a@b");
		await expect(invites.getByRole("button", { name: "Create Invite", exact: true })).toBeDisabled();
		await invites.getByLabel("Email (required)").fill(email);
		await invites.getByLabel("Role", { exact: true }).selectOption("admin");
		await captureEvidence(page, testInfo, "required-invite-email-form");
		const created = page.waitForResponse(response => response.request().method() === "POST"
			&& new URL(response.url()).pathname === "/api/auth/invite");
		await invites.getByRole("button", { name: "Create Invite", exact: true }).click();
		const response = await created;
		expect(response.status(), await response.text()).toBe(201);
		const { invite } = await response.json() as { invite: { id: string; email: string; role: string } };
		expect(invite).toMatchObject({ email, role: "admin" });
		const row = invites.getByText(email, { exact: true }).locator("../..");
		await expect(row.getByText("admin", { exact: true })).toBeVisible();
		await expect(invites.getByLabel("Email (required)")).toHaveValue("");
		const deleted = page.waitForResponse(result => result.request().method() === "DELETE"
			&& new URL(result.url()).pathname === "/api/auth/invite"
			&& result.request().postDataJSON().id === invite.id);
		await row.getByRole("button", { name: "Delete", exact: true }).click();
		expect((await deleted).status()).toBe(200);
		await expect(invites.getByText(email, { exact: true })).toHaveCount(0);
		await page.reload();
		await expect(page.locator("#invites").getByText(email, { exact: true })).toHaveCount(0);
		const saved = await request.get("/api/auth/invite");
		expect(saved.status()).toBe(200);
		expect((await saved.json()).invites.some((entry: { id: string }) => entry.id === invite.id)).toBe(false);
	});

	test("invalid token redirects an anonymous visitor to login", async ({ page }) => {
		await page.context().clearCookies();
		await page.goto(`/signup/missing-${crypto.randomUUID()}`);
		await expect(page).toHaveURL(/\/login$/);
	});

	test("valid invite renders its locked email and creates a durable signed-in session", async ({ page, request }) => {
		const invite = await createInvite(request);
		await openSignup(page, invite.token);
		await expect(page.getByLabel("Email", { exact: true })).toHaveValue(invite.email);
		await expect(page.getByLabel("Email", { exact: true })).toHaveAttribute("readonly", "");
		await fillSignup(page);
		const submitted = page.waitForResponse((response) => response.request().method() === "POST"
			&& new URL(response.url()).pathname === `/api/auth/invite/${invite.token}`);
		await page.getByRole("button", { name: "Create Account" }).click();
		const response = await submitted;
		// Success performs a full navigation before the fetch body is consumed.
		// Verify the response status, then read the saved identity after reload.
		expect(response.status()).toBe(201);
		await expect(page).not.toHaveURL(/\/(signup|login)(\/|$)/);
		await page.reload();
		const session = await page.request.get("/api/auth/me");
		expect(session.status(), await session.text()).toBe(200);
		expect(await session.json()).toMatchObject({ user: { name: "Invited Member", email: invite.email, role: "member" } });
	});

	test("client validation rejects a whitespace-only name before any signup request", async ({ page, request }) => {
		const invite = await createInvite(request);
		await openSignup(page, invite.token);
		await fillSignup(page);
		await page.getByLabel("Name", { exact: true }).fill("   ");
		const submissions: string[] = [];
		page.on("request", (request) => {
			if (request.method() === "POST" && request.url().includes(`/api/auth/invite/${invite.token}`)) submissions.push(request.url());
		});
		await page.getByRole("button", { name: "Create Account" }).click();
		await expect(page.getByText("Name is required", { exact: true })).toBeVisible();
		expect(submissions).toEqual([]);
		await expect(page).toHaveURL(new RegExp(`/signup/${invite.token}$`));
	});

	test("an invite consumed after page load shows the real API error on submit", async ({ page, request }) => {
		const invite = await createInvite(request);
		await openSignup(page, invite.token);
		// Another client claims the invite after this visitor has loaded it.
		const claimed = await request.post(`/api/auth/invite/${invite.token}`, {
			data: { name: "First Member", email: invite.email, password: "Signup-test-password-93!" },
		});
		expect(claimed.status(), await claimed.text()).toBe(201);
		await fillSignup(page);
		const submitted = page.waitForResponse((response) => response.request().method() === "POST"
			&& new URL(response.url()).pathname === `/api/auth/invite/${invite.token}`);
		await page.getByRole("button", { name: "Create Account" }).click();
		const response = await submitted;
		expect(response.status(), await response.text()).toBe(404);
		await expect(page.getByText("Invite not found or expired", { exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "Create Account" })).toBeEnabled();
		await expect(page).toHaveURL(new RegExp(`/signup/${invite.token}$`));
	});
});
