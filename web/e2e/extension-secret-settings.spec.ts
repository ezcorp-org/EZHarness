/**
 * Secret-typed extension settings — e2e for the write-only secret field on
 * the extension detail page's Settings panel.
 *
 * Drives a fixture extension whose manifest declares a `type: "secret"`
 * settings field (the graded-card-scanner `psa_api_token` shape) against
 * mocked routes. Pins the user-visible contract:
 *   - the field renders as a MASKED (password) input, never prefilled
 *   - a Set / Not set badge + hint are driven by the GET payload's
 *     `secrets[key].isSet` existence probe (no value ever reaches the page)
 *   - typing a token + Save issues PUT /settings/user carrying the value;
 *     the badge flips to "Set" after the refetch
 *   - Clear queues an explicit empty-string clear; Save deletes the row
 *
 * The `@evidence`-tagged test satisfies the Visual evidence CI gate (this
 * is a frontend-visual change to SchemaForm/SettingsPanel). `captureEvidence`
 * is a hard no-op unless `EZCORP_E2E_EVIDENCE=1`, so the normal `e2e-mock`
 * run stays byte-identical.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import type { Page } from "@playwright/test";
import { makeProject } from "./fixtures/data.js";

const EXT_ID = "ext-scan";
const TOKEN = "psa-live-token-1234567890";

const SECRET_SCHEMA = {
	psa_api_token: {
		type: "secret",
		label: "PSA API token",
		description:
			"Free token from api.psacard.com — used for card identity + population lookups.",
		storageKey: "psa-token",
	},
} as const;

function makeDetail() {
	return {
		id: EXT_ID,
		name: "graded-card-scanner",
		version: "0.1.0",
		description: "Scan PSA graded-card slabs and see value + population.",
		enabled: true,
		source: "local",
		installPath: `/tmp/${EXT_ID}`,
		checksumVerified: true,
		consecutiveFailures: 0,
		manifest: {
			schemaVersion: 2,
			name: "graded-card-scanner",
			author: { name: "EZCorp" },
			entrypoint: "./index.ts",
			persistent: false,
			tools: [],
			permissions: { storage: true },
			settings: SECRET_SCHEMA,
		},
		grantedPermissions: {
			network: [],
			filesystem: [],
			shell: false,
			env: [],
			grantedAt: { storage: Date.now() },
		},
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}

function settingsPayload(isSet: boolean) {
	return {
		schema: SECRET_SCHEMA,
		declaredDefaults: {},
		userValues: {},
		resolved: {},
		secrets: { psa_api_token: { isSet } },
		capabilities: [],
	};
}

/**
 * Stateful route mock for the settings surface. Registered AFTER `mockApi`
 * so these more-specific handlers win (Playwright consults the newest
 * registration first). GET reflects the current stored state; PUT captures
 * the body and applies set ("" = clear) semantics like the real route.
 */
async function installSettingsMock(page: Page, opts: { initiallySet: boolean }) {
	const state = { isSet: opts.initiallySet, putBodies: [] as unknown[] };

	await page.route(`**/api/extensions/${EXT_ID}`, (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		return route.fulfill({ json: makeDetail() });
	});
	await page.route(`**/api/extensions/${EXT_ID}/settings`, (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		return route.fulfill({ json: settingsPayload(state.isSet) });
	});
	await page.route(`**/api/extensions/${EXT_ID}/settings/user`, (route) => {
		if (route.request().method() !== "PUT") return route.fallback();
		const body = route.request().postDataJSON() as {
			values?: Record<string, unknown>;
		};
		state.putBodies.push(body);
		const submitted = body.values?.psa_api_token;
		if (typeof submitted === "string") {
			state.isSet = submitted !== "";
		}
		return route.fulfill({
			json: {
				ok: true,
				userValues: {},
				secrets: { psa_api_token: { isSet: state.isSet } },
			},
		});
	});

	return state;
}

test.describe("Secret settings field", () => {
	const proj = makeProject({ id: "proj-1" });

	test("not-set state: masked input, badge, save round-trip flips to Set", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj] });
		const state = await installSettingsMock(page, { initiallySet: false });

		await page.goto(`/extensions/${EXT_ID}`);

		// Masked input, never prefilled, with the Not set badge + hint.
		const input = page.getByTestId("schema-input-psa_api_token");
		await expect(input).toBeVisible();
		await expect(input).toHaveAttribute("type", "password");
		await expect(input).toHaveValue("");
		await expect(page.getByTestId("schema-secret-status-psa_api_token")).toHaveText(
			"Not set",
		);
		await expect(page.getByTestId("schema-secret-hint-psa_api_token")).toContainText(
			"Stored encrypted",
		);
		// No Clear affordance while nothing is stored.
		await expect(page.getByTestId("schema-secret-clear-psa_api_token")).toHaveCount(0);

		// Type the token and save — the PUT carries it; the refetch flips the badge.
		await input.fill(TOKEN);
		await page.getByTestId("settings-panel-user-save").click();

		await expect(page.getByTestId("schema-secret-status-psa_api_token")).toHaveText(
			"Set",
		);
		expect(state.putBodies).toEqual([{ values: { psa_api_token: TOKEN } }]);

		// After the save the input resets to empty — the value is never shown again.
		await expect(input).toHaveValue("");
		await expect(page.getByTestId("schema-secret-hint-psa_api_token")).toContainText(
			"never shown again",
		);
	});

	test("clear flow: Clear queues the empty-string clear, Save deletes", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj] });
		const state = await installSettingsMock(page, { initiallySet: true });

		await page.goto(`/extensions/${EXT_ID}`);

		await expect(page.getByTestId("schema-secret-status-psa_api_token")).toHaveText(
			"Set",
		);
		await page.getByTestId("schema-secret-clear-psa_api_token").click();
		await expect(page.getByTestId("schema-secret-hint-psa_api_token")).toContainText(
			"Will be cleared when you save.",
		);

		await page.getByTestId("settings-panel-user-save").click();

		await expect(page.getByTestId("schema-secret-status-psa_api_token")).toHaveText(
			"Not set",
		);
		expect(state.putBodies).toEqual([{ values: { psa_api_token: "" } }]);
	});

	test("renders masked input + isSet states and captures evidence @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj] });
		await installSettingsMock(page, { initiallySet: false });

		await page.goto(`/extensions/${EXT_ID}`);

		// State 1 — Not set: masked input + badge.
		const input = page.getByTestId("schema-input-psa_api_token");
		await expect(input).toBeVisible();
		await expect(input).toHaveAttribute("type", "password");
		await expect(page.getByTestId("schema-secret-status-psa_api_token")).toHaveText(
			"Not set",
		);
		await captureEvidence(page, testInfo, "secret-setting-not-set");

		// State 2 — Set (after typing + saving): badge flips, input is empty
		// again, and the saved-state hint explains the value is never shown.
		await input.fill(TOKEN);
		await page.getByTestId("settings-panel-user-save").click();
		await expect(page.getByTestId("schema-secret-status-psa_api_token")).toHaveText(
			"Set",
		);
		await expect(input).toHaveValue("");
		await captureEvidence(page, testInfo, "secret-setting-set");

		// Assert the capture contract both with and without the flag (mirrors
		// extensions-sort.spec.ts) so the test is meaningful in either mode.
		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) =>
						a.name === "secret-setting-not-set" && a.contentType === "image/png",
				),
			).toBe(true);
			expect(
				testInfo.attachments.some(
					(a) => a.name === "secret-setting-set" && a.contentType === "image/png",
				),
			).toBe(true);
		} else {
			expect(
				testInfo.attachments.some((a) => a.name.startsWith("secret-setting-")),
			).toBe(false);
		}
	});
});
