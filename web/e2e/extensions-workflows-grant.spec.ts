/**
 * The `permissions.workflows` row in the install/enable review dialog (W2).
 *
 * An extension that ships its own `*.workflow.yaml` assets can declare
 * `permissions.workflows: {names, maxRunsPerHour?}` to trigger runs of them
 * from its own code. Enabling such an extension must surface that as a
 * reviewable, opt-out-able consent row — an admin should never grant a
 * capability that can start LLM-spending runs without seeing it.
 *
 * Two things this spec pins that unit tests cannot:
 *   1. The row RENDERS the fully-namespaced names (`<extension>:<workflow>`),
 *      which is the whole reason namespacing is safe — an admin can see at a
 *      glance that the extension can only reach its OWN workflows.
 *   2. Unchecking the toggle actually omits `workflows` from the activate
 *      POST body (asserted on the intercepted request, not just the UI).
 *
 * The `@evidence`-tagged test satisfies the Visual evidence CI gate (this is
 * a frontend-visual route change). `captureEvidence` is a hard no-op unless
 * `EZCORP_E2E_EVIDENCE=1`, so the normal `e2e-mock` run stays byte-identical.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeExtension } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1" });

/** A DISABLED extension declaring two shipped workflows — disabled so the
 *  enable toggle opens the review dialog rather than PATCHing straight to
 *  `enabled: false`. */
function workflowExtension() {
	return makeExtension({
		id: "ext-wf",
		name: "release-bot",
		enabled: false,
		isBundled: false,
		manifest: {
			schemaVersion: 3,
			name: "release-bot",
			version: "1.0.0",
			description: "Ships two workflows and triggers them itself",
			author: { name: "tester" },
			entrypoint: "./index.ts",
			persistent: false,
			tools: [{ name: "noop", description: "n", inputSchema: { type: "object" } }],
			permissions: {
				workflows: { names: ["deploy", "rollback"], maxRunsPerHour: 6 },
			},
		},
	});
}

/** Capture the body of the activate POST so the grant sent to the server can
 *  be asserted directly. Returns a getter, plus fulfils the request. */
async function interceptActivate(page: import("@playwright/test").Page) {
	const bodies: Array<Record<string, unknown>> = [];
	await page.route("**/api/extensions/ext-wf/activate", async (route) => {
		bodies.push(route.request().postDataJSON() as Record<string, unknown>);
		await route.fulfill({ json: { ok: true } });
	});
	return () => bodies;
}

test.describe("Extensions review dialog — workflows grant", () => {
	test("renders the namespaced workflow names, checked by default", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj], extensions: [workflowExtension()] });

		await page.goto("/extensions");
		await expect(page.getByTestId("ext-card")).toHaveCount(1);
		await page.getByTitle("Enable").click();

		const row = page.getByTestId("review-workflows");
		await expect(row).toBeVisible();
		// Capability-tier toggles default ON — the admin must actively opt out.
		await expect(page.getByTestId("review-workflows-toggle")).toBeChecked();
		// The declared rate ceiling is shown, not hidden behind a default.
		await expect(row).toContainText("up to 6 per hour");
		// NAMESPACED names — the visible proof the extension can only reach
		// its own workflows, never the host's `deploy`.
		await expect(row).toContainText("release-bot:deploy");
		await expect(row).toContainText("release-bot:rollback");
	});

	test("granting sends the declared names to the activate endpoint", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj], extensions: [workflowExtension()] });
		const bodies = await interceptActivate(page);

		await page.goto("/extensions");
		await expect(page.getByTestId("ext-card")).toHaveCount(1);
		await page.getByTitle("Enable").click();
		await expect(page.getByTestId("review-workflows")).toBeVisible();
		await page.getByRole("button", { name: "Enable with selected permissions" }).click();

		await expect.poll(() => bodies().length).toBe(1);
		const granted = bodies()[0]?.grantedPermissions as Record<string, unknown>;
		expect(granted.workflows).toEqual({
			names: ["deploy", "rollback"],
			maxRunsPerHour: 6,
		});
		expect((granted.grantedAt as Record<string, number>).workflows).toBeGreaterThan(0);
	});

	test("unchecking the toggle sends an EXPLICIT denial, not silence", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj], extensions: [workflowExtension()] });
		const bodies = await interceptActivate(page);

		await page.goto("/extensions");
		await expect(page.getByTestId("ext-card")).toHaveCount(1);
		await page.getByTitle("Enable").click();
		await page.getByTestId("review-workflows-toggle").uncheck();
		await page.getByRole("button", { name: "Enable with selected permissions" }).click();

		await expect.poll(() => bodies().length).toBe(1);
		const granted = bodies()[0]?.grantedPermissions as Record<string, unknown>;
		// ── This assertion was INVERTED until phase 8b ────────────────────
		//
		// It used to require `granted.workflows` to be ABSENT, reasoning that
		// a `{names: []}` husk "would read as granted to a presence check".
		// The husk concern is real but it is a SERVER-side concern, and the
		// clamp already handles it — every empty-name branch of
		// `clampWorkflowsPermission` collapses to `undefined`.
		//
		// What the old assertion missed is what ABSENCE means to that same
		// clamp: `src/extensions/clamp-permissions.ts:317-320` and `:358-359`
		// read a missing submitted grant as "the admin approved the
		// declaration as-is". So staying silent re-granted exactly what the
		// admin had just unchecked, and this checkbox was decorative.
		// `workflows-permission.test.ts` pins the server half — this husk
		// clamps to `undefined` for BOTH manifest shapes.
		expect(granted.workflows).toEqual({ names: [], allowDelegated: false });
		// Still no `grantedAt` stamp: nothing was granted.
		expect((granted.grantedAt as Record<string, unknown>).workflows).toBeUndefined();
	});

	test("an extension declaring no workflows shows no row", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			extensions: [
				makeExtension({ id: "ext-plain", name: "plain", enabled: false, isBundled: false }),
			],
		});

		await page.goto("/extensions");
		await expect(page.getByTestId("ext-card")).toHaveCount(1);
		await page.getByTitle("Enable").click();

		await expect(page.getByTestId("review-workflows")).toHaveCount(0);
	});

	test("renders the workflows consent row and captures evidence @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj], extensions: [workflowExtension()] });

		await page.goto("/extensions");
		await expect(page.getByTestId("ext-card")).toHaveCount(1);
		await page.getByTitle("Enable").click();
		await expect(page.getByTestId("review-workflows")).toBeVisible();
		await captureEvidence(page, testInfo, "extensions-workflows-grant");

		// Assert the capture contract in BOTH modes (mirrors extensions-sort)
		// so the test is meaningful without the flag, not a bare screenshot.
		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) =>
						a.name === "extensions-workflows-grant" && a.contentType === "image/png",
				),
			).toBe(true);
		} else {
			expect(
				testInfo.attachments.some((a) => a.name === "extensions-workflows-grant"),
			).toBe(false);
		}
	});
});
