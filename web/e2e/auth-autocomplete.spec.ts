/**
 * Credential inputs declare `autocomplete` — asserted in a real browser, on
 * the real server-rendered pages.
 *
 * A `type="password"` / `type="email"` field with no `autocomplete` lets the
 * browser guess: a password manager fills a saved login into a reset form, or
 * offers to save an API key as an account password. `input-autocomplete-guard.test.ts`
 * proves the attribute is in the SOURCE for every such input in the tree; this
 * spec proves it survives to the rendered DOM — the compiler, SSR, and
 * hydration all get a chance to drop an attribute, and only a browser sees the
 * result the password manager sees.
 *
 * WHICH PAGES: the two credential screens that genuinely render under the mock
 * tier. `/reset-password/[token]`'s server load touches no DB (it just echoes
 * the token), and `/account` runs on mocked APIs. `/login`, `/setup` and
 * `/signup/[token]` all call `getUserCount()` / `getInviteByToken()` in
 * `+page.server.ts`; under this tier's `PI_SKIP_INIT=1` preview server those
 * throw and the routes serve a 500 (verified: `curl /login` → 500), which is
 * exactly why `auth-login.spec.ts` and `setup-first-run.spec.ts` drive a static
 * HTML reimplementation instead. Asserting `autocomplete` against a hand-written
 * shell would assert the fixture, not the app — so those three pages are covered
 * by `auth-page-autocomplete.component.test.ts`, which renders the real
 * `+page.svelte` through the Svelte compiler.
 *
 * SCOPE is secret-bearing fields, not only auth ones (the filename predates the
 * widening): the MCP header box on `/extensions` holds an
 * `Authorization: Bearer …` token and is a `<textarea>`, so it carries no
 * `type` for the source guard's type-driven sweep to key on. The guard pins it
 * by anchor; this asserts the same field in a browser.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Test Project" });

const accountRoutes = {
	"/api/auth/me": () => ({
		user: { id: "user-1", email: "user@test.local", name: "Test User", role: "member" },
	}),
	"/api/account": () => ({
		id: "user-1",
		email: "user@test.local",
		name: "Test User",
		role: "member" as const,
		createdAt: "2026-01-15T00:00:00.000Z",
	}),
};

test.describe("credential inputs carry autocomplete in the rendered DOM", () => {
	test("reset-password form labels its email and both new-password fields @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({});
		await page.goto("/reset-password/some-valid-token");

		const email = page.locator("#email");
		const password = page.locator("#password");
		const confirm = page.locator("#confirmPassword");

		await expect(email).toBeVisible();

		// The address identifies the account being reset, so it is `username`
		// (not `email`) — that is the token a password manager pairs with the
		// password fields to update the right saved credential.
		await expect(email).toHaveAttribute("autocomplete", "username");
		// Both password fields are `new-password`: this form SETS a password, so
		// offering the stored current one would fill the value being replaced,
		// and it is what triggers the manager's "suggest a strong password" UI.
		await expect(password).toHaveAttribute("autocomplete", "new-password");
		await expect(confirm).toHaveAttribute("autocomplete", "new-password");

		// The types are what make the attribute load-bearing — assert them too,
		// so this cannot pass on a field that quietly stopped being a password.
		await expect(password).toHaveAttribute("type", "password");
		await expect(confirm).toHaveAttribute("type", "password");

		await captureEvidence(page, testInfo, "reset-password-autocomplete");

		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) => a.name === "reset-password-autocomplete" && a.contentType === "image/png",
				),
			).toBe(true);
		} else {
			expect(testInfo.attachments.some((a) => a.name === "reset-password-autocomplete")).toBe(
				false,
			);
		}
	});

	test("account page distinguishes current-password from new-password @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj], routes: accountRoutes });
		await page.goto("/account");

		const email = page.locator("#account-email");
		await expect(email).toHaveValue("user@test.local");

		// Here the address IS the profile field being edited, not a login
		// identifier, so `email` is the correct token rather than `username`.
		await expect(email).toHaveAttribute("autocomplete", "email");

		// Change-password trio: the old secret is `current-password` so the
		// manager offers the stored one; the two new fields are `new-password`
		// so it offers to generate and then save the replacement. Getting these
		// backwards is what makes a manager overwrite a good password with the
		// old one.
		await expect(page.locator("#current-pw")).toHaveAttribute(
			"autocomplete",
			"current-password",
		);
		await expect(page.locator("#new-pw")).toHaveAttribute("autocomplete", "new-password");
		await expect(page.locator("#confirm-pw")).toHaveAttribute("autocomplete", "new-password");

		await captureEvidence(page, testInfo, "account-password-autocomplete");

		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) => a.name === "account-password-autocomplete" && a.contentType === "image/png",
				),
			).toBe(true);
		}
	});

	test("the MCP header box opts out of autofill @evidence", async ({ page, mockApi }, testInfo) => {
		// This box holds `Authorization: Bearer <token>` lines. It is a
		// `<textarea>`, so it has no `type` attribute — the source guard's
		// type-driven sweep is structurally blind to it and pins it by anchor
		// instead. Only a rendered assertion proves the attribute reaches the DOM.
		//
		// `off` (not `new-password`) is right here precisely BECAUSE it is not a
		// password-typed field: the ignore-`off` behaviour that forces
		// `new-password` on the BYOK key and PAT boxes applies to password inputs
		// only, so on a textarea `off` is both honoured and sufficient.
		await mockApi({ projects: [proj], extensions: [] });
		await page.goto("/extensions");

		await page.getByRole("button", { name: "MCP Server" }).click();
		// The header box exists only for the HTTP/SSE transports — a stdio server
		// is a local subprocess and carries no HTTP headers at all.
		await page.locator('select:has(option[value="sse"])').selectOption("http");

		const headers = page.getByPlaceholder("Headers (one per line, e.g. Authorization: Bearer ...)");
		await expect(headers).toBeVisible();
		await expect(headers).toHaveAttribute("autocomplete", "off");

		await captureEvidence(page, testInfo, "mcp-headers-autocomplete");

		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) => a.name === "mcp-headers-autocomplete" && a.contentType === "image/png",
				),
			).toBe(true);
		}
	});

	test("the email-change confirmation field asks for the CURRENT password", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj], routes: accountRoutes });
		await page.goto("/account");

		const email = page.locator("#account-email");
		await expect(email).toHaveValue("user@test.local");

		// This field is rendered only once the address actually differs, so it
		// is reachable only by editing — a source-only check would never see it
		// in its rendered state. It guards the change with the EXISTING
		// password, so `current-password` is right and `new-password` would make
		// the manager offer a freshly generated string for a field that must
		// match what is already stored.
		await email.fill("changed@test.local");
		const confirmPw = page.locator('input[placeholder="Current password"]');
		await expect(confirmPw).toBeVisible();
		await expect(confirmPw).toHaveAttribute("type", "password");
		await expect(confirmPw).toHaveAttribute("autocomplete", "current-password");
	});
});
