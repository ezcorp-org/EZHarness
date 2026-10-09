/**
 * E2E — the author page's "Your installations" list names what it links to
 * (frontend-visual change ⇒ `@evidence` per the feature contract).
 *
 * The list used to print a raw installation id per row, which told an author
 * nothing about which workspace a row would open. Each row now leads with the
 * extension name and keeps the id as muted secondary text underneath. A row
 * whose name is not known yet falls back to the id alone — no empty second
 * line, no placeholder.
 *
 * RENDER tier: `mockPageData` fulfils the SvelteKit `__data.json` request for
 * the author route, so the list is reached through a client-side navigation
 * from /extensions (an injected same-origin link, which the SvelteKit router
 * intercepts). Name RESOLUTION is unit-tested in
 * `installation-name.server.test.ts`; this spec pins what a user SEES.
 */
import { test, expect } from "./fixtures/test-base.js";
import { captureEvidence } from "./fixtures/evidence.js";
import { makeProject } from "./fixtures/data.js";
import { mockPageData, resumePage } from "./fixtures/page-data.js";
import type { Page } from "@playwright/test";

const NAMED = "3b0f9c41-6f3a-4d0b-9a2e-1c7d5e8f4a62";
const UNNAMED = "a94d27e8-51bc-4f37-8c6a-0e9b3d2f7c15";
const proj = makeProject({ id: "proj-author-installations", name: "Authoring Project" });

function installation(id: string, name: string | null, status: string): Record<string, unknown> {
	return { id, name, status, ownerId: "mock-owner", scope: "global", activeReleaseId: null, generation: 0, enabled: false, uninstalled: false, grants: [], acknowledgedGeneration: 0 };
}

/** The LIST branch of the author load: no selected installation, so no state. */
const listData: Record<string, unknown> = {
	installations: [installation(NAMED, "memory-extractor", "active"), installation(UNNAMED, null, "disabled")],
	state: null,
	extensionName: null,
	breadcrumbTail: null,
	workspace: null,
	files: {},
	sourceUnavailable: null,
	canApprove: false,
	canBindProject: false,
	projects: [],
	projectBinding: null,
};

/** Client-side navigation to the author route so the mocked loader answers. */
async function openInstallationList(page: Page) {
	await mockPageData(page, "/extensions/author", listData);
	await page.goto("/extensions");
	await page.evaluate(() => {
		const link = document.createElement("a");
		link.href = "/extensions/author";
		link.textContent = "Open author page";
		link.dataset.testid = "e2e-open-author";
		document.body.append(link);
	});
	await page.getByTestId("e2e-open-author").click();
	await expect(page).toHaveURL((url) => url.pathname === "/extensions/author" && !url.searchParams.has("installation"));
	await expect(page.getByRole("heading", { name: "Your installations" })).toBeVisible();
}

test.describe("Extension author page — installation list", () => {
	test.describe("desktop", () => {
		test.use({ viewport: { width: 1280, height: 800 } });

		test("leads each row with the extension name and keeps the id secondary @evidence", async ({ page, mockApi }, testInfo) => {
			await mockApi({ projects: [proj] });
			await openInstallationList(page);

			const named = page.getByRole("link", { name: /memory-extractor/ });
			await expect(named).toHaveAttribute("href", `?installation=${NAMED}`);
			await expect(named.locator(".installation-id")).toHaveText(NAMED);
			await expect(named.locator(".installation-status")).toHaveText("active");

			const unnamed = page.getByRole("link", { name: new RegExp(UNNAMED) });
			await expect(unnamed).toHaveAttribute("href", `?installation=${UNNAMED}`);
			await expect(unnamed).toHaveText(`${UNNAMED}disabled`);
			await expect(unnamed.locator(".installation-id")).toHaveCount(0);

			await captureEvidence(page, testInfo, "extension-author-installations-named");
		});
	});

	test.describe("mobile", () => {
		test.use({ viewport: { width: 390, height: 844 } });

		test("fits the name, id and status in a phone-width row @evidence", async ({ page, mockApi }, testInfo) => {
			await mockApi({ projects: [proj] });
			await openInstallationList(page);

			// A 36-character id under a name is the widest this row ever gets.
			// The id column and the status must stay side by side, inside the
			// viewport — not overlapping, not scrolling the page sideways.
			const named = page.getByRole("link", { name: /memory-extractor/ });
			const row = (await named.boundingBox())!;
			const id = (await named.locator(".installation-id").boundingBox())!;
			const status = (await named.locator(".installation-status").boundingBox())!;
			expect(row.x + row.width).toBeLessThanOrEqual(390);
			expect(id.x + id.width).toBeLessThanOrEqual(status.x);
			expect(id.y).toBeGreaterThan(status.y);

			// The id wraps (it is one long unbroken token), but the status is a
			// word and must never break mid-word to make room for it. One client
			// rect per status = one line.
			for (const badge of await page.locator(".installation-status").all()) {
				expect(await badge.evaluate((node) => node.getClientRects().length)).toBe(1);
			}

			await captureEvidence(page, testInfo, "extension-author-installations-named-mobile");
		});
	});
});


/** Render-tier proof only. Real DB drain/refusal and cleaned activation are covered
 * by src/extensions/v4/lifecycle.test.ts and the lifecycle-service/store suites. */
test("provider update refusal keeps the current release visible and gives drain guidance @evidence", async ({ page, mockApi }, testInfo) => {
  await mockApi({ projects: [proj] });
  const timestamp = "2026-10-04T00:00:00.000Z";
  const release = (id: string, version: string) => ({
    id, installationId: NAMED, workspaceId: "workspace", workspaceRevision: 1,
    sourceDigest: `${id}-source`, artifactDigest: `${id}-artifact`, releaseDigest: `${id}-digest`,
    imageDigest: "image", runnerProfile: "isolated", policyDigest: "policy", createdAt: timestamp,
    manifest: { schemaVersion: 4, name: "incus-provider", version, permissions: {} },
    evidence: { tests: [{ name: "provider-conformance", passed: true }] },
  });
  const current = release("current-provider", "0.1.2");
  const candidate = release("next-provider", "0.1.3");
  const state = {
    installation: { ...installation(NAMED, "incus-provider", "active"), activeReleaseId: current.id,
      generation: 3, enabled: true, acknowledgedGeneration: 3 },
    workspaces: {}, revisions: {}, releases: { [current.id]: current, [candidate.id]: candidate }, operations: {} as Record<string, unknown>,
    approvals: { approved: { id: "approved", releaseId: candidate.id, releaseDigest: candidate.releaseDigest,
      principalId: "mock-owner", scope: "global", grants: [], status: "approved", runnerProfile: "isolated" } },
  };
  const requests: { tool: string; input: Record<string, unknown> }[] = [];
  await page.route("**/api/extensions/control", async route => {
    const request = route.request().postDataJSON();
    requests.push(request);
    if (request.tool === "extensions_release") {
      expect(request.input.action).toBe("activate");
      expect(request.input.installationId).toBe(NAMED);
      expect(request.input.approvalId).toBe("approved");
      expect(request.input.idempotencyKey).toEqual(expect.any(String));
      const operation = { id: "refused-update", kind: "activate", state: "failed", createdAt: timestamp,
        diagnostics: [{ stage: "activate", code: "provider_not_drained", message: "Drain all provider sandboxes before changing the active release." }], events: [] };
      state.operations[operation.id] = operation;
      await route.fulfill({ json: operation });
      return;
    }
    expect(request.tool).toBe("extensions_inspect");
    await route.fulfill({ json: state });
  });
  await mockPageData(page, "/extensions/author", { ...listData, installations: [], state,
    extensionName: "incus-provider", breadcrumbTail: "incus-provider", canApprove: true });
  await resumePage(page, `/extensions/author?installation=${NAMED}`);
  const currentCard = page.locator("article.release").filter({ has: page.getByRole("heading", { name: "incus-provider 0.1.2" }) });
  const nextCard = page.locator("article.release").filter({ has: page.getByRole("heading", { name: "incus-provider 0.1.3" }) });
  await expect(currentCard.getByText("Active", { exact: true })).toBeVisible();
  await expect(nextCard.getByText("Verified", { exact: true })).toBeVisible();
  await expect(page.getByText("provider_not_drained", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Activate approved release", exact: true }).click();
  await expect(page.getByText("activate / provider_not_drained", { exact: true })).toBeVisible();
  await expect(page.getByText("Drain all provider sandboxes before changing the active release.", { exact: false })).toBeVisible();
  await expect(currentCard.getByText("Active", { exact: true })).toBeVisible();
  await expect(nextCard.getByText("Verified", { exact: true })).toBeVisible();
  await expect(page.locator(".state-badge")).toHaveText("active · generation 3");
  expect(requests.filter(request => request.tool === "extensions_release")).toHaveLength(1);
  expect(requests.filter(request => request.tool === "extensions_inspect")).toHaveLength(1);
  await captureEvidence(page, testInfo, "provider-update-requires-drain");
});

/** UI approval protocol; actual expired-proof validation is covered by the durable lifecycle suite. */
test("a human can approve the exact reviewed release after its build proof interval @evidence", async ({ page, mockApi }, testInfo) => {
  await mockApi({ projects: [proj] });
  const releaseDigest = "a".repeat(64);
  const candidate = { id: "historical-provider", installationId: NAMED, runnerProfile: "isolated", releaseDigest,
    createdAt: "2026-09-21T10:00:00.000Z", manifest: { schemaVersion: 4, name: "incus-provider", version: "0.1.3", permissions: {} },
    verification: { sandboxPresetQualifications: [{ verifiedAt: "2026-09-21T11:00:00.000Z", validUntil: "2026-09-21T13:00:00.000Z" }] },
    evidence: { tests: [{ name: "provider-conformance", passed: true }] } };
  const approval = { id: "historical-review", releaseId: candidate.id, releaseDigest, principalId: "mock-owner",
    scope: "global", grants: [], status: "pending", runnerProfile: "isolated" };
  const state = { installation: installation(NAMED, "incus-provider", "verified"), workspaces: {}, revisions: {},
    releases: { [candidate.id]: candidate }, operations: {}, approvals: { [approval.id]: approval } };
  let decisions = 0;
  await page.route(`**/api/extensions/releases/${NAMED}/approve`, async route => {
    expect(route.request().postDataJSON()).toEqual({ approvalId: approval.id, decision: true });
    decisions += 1;
    approval.status = "approved";
    await route.fulfill({ json: approval });
  });
  await page.route("**/api/extensions/control", async route => {
    expect(route.request().postDataJSON()).toEqual({ tool: "extensions_inspect", input: { installationId: NAMED } });
    await route.fulfill({ json: state });
  });
  await mockPageData(page, "/extensions/author", { ...listData, installations: [], state,
    extensionName: "incus-provider", breadcrumbTail: "incus-provider", canApprove: true });
  await resumePage(page, `/extensions/author?installation=${NAMED}`);
  await expect(page.getByRole("button", { name: "Approve exact release", exact: true })).toBeDisabled();
  await page.getByRole("checkbox", { name: "I reviewed this release and its permissions.", exact: true }).check();
  await page.getByRole("button", { name: "Approve exact release", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Approved release", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Activate approved release", exact: true })).toBeVisible();
  expect(decisions).toBe(1);
  expect(state.installation.activeReleaseId).toBe(null);
  expect(state.releases[candidate.id].releaseDigest).toBe(releaseDigest);
  await captureEvidence(page, testInfo, "delayed-exact-release-human-approval");
});
