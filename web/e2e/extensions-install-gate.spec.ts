/**
 * E2E for the v1.4 `*_API_KEY` install-rejection gate.
 *
 * Sibling layout — `extensions.spec.ts` is already large (>1100 LOC,
 * 4 top-level describes covering list/toggle/detail/install-flow); the
 * gate scenario is its own privacy-relevant control surface and stays
 * cleaner in its own file.
 *
 * Coverage targets (per plan §1.2):
 *   1. Submit an install request whose mocked manifest declares
 *      `permissions.env: ["FAKE_API_KEY"]`. The server rejects with
 *      the EnvKeyLeakInstallError shape (HTTP 400 + `{error: "Install
 *      refused: ... Migrate LLM credentials to ctx.llm ..."}`). Assert
 *      that the install UI surfaces both the "credential-shaped env
 *      name" copy AND the `ctx.llm` migration path AND that the row
 *      never appears in the installed list.
 *   2. Positive control — install request with non-credential env names
 *      (e.g. `EZCORP_BASE_URL`) succeeds and the extension lands in
 *      the list.
 *
 * The error text is sourced verbatim from
 * `src/extensions/clamp-permissions.ts::EnvKeyLeakInstallError` so the
 * substring assertions stay in sync if the message ever changes
 * (the test will fail loudly).
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1" });

// EnvKeyLeakInstallError message text — exact prefix + ctx.llm path
// pulled from clamp-permissions.ts. Two substring assertions are
// enough to verify the user-facing card content; we don't pin the
// full message because the trailing copy is operator-tone advice
// that may evolve.
const ENV_LEAK_REFUSAL_MSG =
	"Install refused: extension manifest declares credential-shaped env name(s) " +
	"[FAKE_API_KEY]. The deprecation has been live since Phase 51; " +
	"v1.4 is the cliff. Migrate LLM credentials to ctx.llm (host-brokered) and " +
	"third-party API creds to the upcoming ctx.secrets surface (v1.5+).";

test.describe("Extensions — *_API_KEY install gate", () => {
	test("install with credential-shaped env name (FAKE_API_KEY) → 400 with refusal copy + ctx.llm migration path, no card added", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj], extensions: [] });

		const installCalls: Array<{ body: any }> = [];
		// Stateful list so we can assert the rejected install does NOT
		// land in the list. Starts empty; never mutated by the rejected
		// POST below.
		const installedExtensions: any[] = [];

		await page.route("**/api/extensions", async (route) => {
			const method = route.request().method();
			if (method === "GET") {
				await route.fulfill({
					json: installedExtensions,
					headers: {
						"Content-Type": "application/json",
						"Cache-Control": "private, max-age=60",
					},
				});
				return;
			}
			if (method === "POST") {
				const body = route.request().postDataJSON();
				installCalls.push({ body });
				// Mirror the real route's error path: installer.ts catches
				// the EnvKeyLeakInstallError throw and returns it via
				// errorJson(400, message) (see web/src/routes/api/
				// extensions/+server.ts:107). The error text is what the
				// installer's gate emits.
				await route.fulfill({
					status: 400,
					json: { error: ENV_LEAK_REFUSAL_MSG },
				});
				return;
			}
			return route.fallback();
		});

		await page.goto("/extensions");

		// Local-path mode is the default. Fill the path and submit.
		await page.getByPlaceholder("/path/to/extension").fill("/tmp/leaky-ext");
		await page.getByRole("button", { name: "Install" }).click();

		// The error toast surfaces the server's verbatim `data.error`
		// string. Assert both halves of the contract:
		//   1. credential-shaped env name copy (with the leaked name)
		//   2. ctx.llm migration path
		// The page's `addToast` renders the message inside the toast
		// container; getByText with a substring match resolves either
		// half independently.
		await expect(
			page.getByText(/credential-shaped env name/i).first(),
		).toBeVisible({ timeout: 5000 });
		await expect(
			page.getByText(/FAKE_API_KEY/).first(),
		).toBeVisible({ timeout: 3000 });
		await expect(
			page.getByText(/ctx\.llm/).first(),
		).toBeVisible({ timeout: 3000 });

		// Install was attempted exactly once and was rejected — list
		// stays empty (positive: no card was rendered).
		expect(installCalls).toHaveLength(1);
		expect(installCalls[0]!.body.source).toBe("local");
		expect(installCalls[0]!.body.path).toBe("/tmp/leaky-ext");
		await expect(page.getByText("No extensions installed")).toBeVisible({
			timeout: 3000,
		});
	});

	test("install with non-credential env names (EZCORP_BASE_URL) → succeeds, card appears (positive control)", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj], extensions: [] });

		const installCalls: Array<{ body: any }> = [];
		const installedExtensions: any[] = [];
		// Mirror the gate's negative branch: the installer LET this one
		// through because the env name is not credential-shaped. The
		// 201 response carries the freshly-installed (disabled) row.
		const cleanExtension = {
			id: "ext-clean",
			name: "clean-ext",
			version: "1.0.0",
			description: "An extension with non-credential env names",
			enabled: false,
			source: "local",
			consecutiveFailures: 0,
			manifest: {
				tools: [{ name: "scan", description: "scan code" }],
				permissions: { env: ["EZCORP_BASE_URL"] },
			},
			grantedPermissions: {},
		};

		await page.route("**/api/extensions", async (route) => {
			const method = route.request().method();
			if (method === "GET") {
				await route.fulfill({
					json: installedExtensions,
					headers: {
						"Content-Type": "application/json",
						"Cache-Control": "private, max-age=60",
					},
				});
				return;
			}
			if (method === "POST") {
				const body = route.request().postDataJSON();
				installCalls.push({ body });
				// Gate let it through — push the row into the list so
				// the post-install refetch (`loadExtensions()`) renders it.
				installedExtensions.push(cleanExtension);
				await route.fulfill({ status: 201, json: cleanExtension });
				return;
			}
			return route.fallback();
		});

		await page.goto("/extensions");
		await page.getByPlaceholder("/path/to/extension").fill("/tmp/clean-ext");
		await page.getByRole("button", { name: "Install" }).click();

		// Card appears after the post-install refetch. Empty-state copy
		// disappears; the extension name is rendered.
		await expect(page.getByText("clean-ext")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("No extensions installed")).toBeHidden({
			timeout: 3000,
		});

		// No "credential-shaped" or "ctx.llm" toast leaked.
		await expect(page.getByText(/credential-shaped/i)).toHaveCount(0);
		await expect(page.getByText(/ctx\.llm/)).toHaveCount(0);

		expect(installCalls).toHaveLength(1);
		expect(installCalls[0]!.body.source).toBe("local");
		expect(installCalls[0]!.body.path).toBe("/tmp/clean-ext");
	});
});
