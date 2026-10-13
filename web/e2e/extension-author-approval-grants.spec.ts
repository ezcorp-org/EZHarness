/**
 * E2E — the author page's approval card says, in words, what the release
 * may do (frontend-visual change ⇒ `@evidence`).
 *
 * The card used to print the grants as raw JSON. It now reads them with the
 * same text the CLI and the install prompt use (src/extensions/permission-text.ts),
 * and keeps the raw grants in a collapsed detail.
 *
 * RENDER tier: `setupAuthorReviewMock` fulfils the author route's
 * `__data.json`, so the page is reached by an in-app link from /extensions.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";
import { setupAuthorReviewMock } from "./fixtures/extension-source-import.js";
import { clickInAppLink } from "./fixtures/client-nav.js";

const INSTALLATION = "0b6f2f8e-5f1e-4d0c-9a51-6b1c2d3e4f50";
const proj = makeProject({ id: "proj-author-grants", name: "Authoring Project" });

function reviewData(): Record<string, unknown> {
	const installation = {
		id: INSTALLATION,
		ownerId: "mock-owner",
		scope: "global",
		activeReleaseId: null,
		generation: 0,
		enabled: false,
		uninstalled: false,
		status: "disabled",
		grants: [],
		acknowledgedGeneration: 0,
	};
	// A stdio MCP release that also asks for the shell grant.
	const release = {
		id: "release-1",
		manifest: {
			name: "weather-mcp",
			version: "1.0.0",
			kind: "mcp",
			mcpServers: [{ name: "weather", transport: "stdio", command: "bun", args: ["server.ts"] }],
			permissions: { shell: true, network: ["api.weather.example"] },
		},
		releaseDigest: "sha256:release",
		sourceDigest: "sha256:source",
		artifactDigest: "sha256:artifact",
		runnerProfile: "podman",
		imageDigest: "sha256:image",
		evidence: { tests: [] },
	};
	const approval = {
		id: "approval-1",
		installationId: INSTALLATION,
		releaseId: release.id,
		releaseDigest: release.releaseDigest,
		principalId: "mock-owner",
		scope: "global",
		grants: ['["network",["api.weather.example"]]', '["shell",true]'],
		runnerProfile: "podman",
		expectedActiveReleaseId: null,
		expectedGeneration: 0,
		status: "pending",
		createdAt: "2026-10-13T00:00:00.000Z",
	};
	return {
		installations: [installation],
		state: { installation, workspaces: {}, revisions: {}, releases: { [release.id]: release }, approvals: { [approval.id]: approval }, operations: {} },
		extensionName: "weather-mcp",
		breadcrumbTail: "weather-mcp",
		workspace: null,
		files: {},
		sourceUnavailable: null,
		canApprove: true,
		canBindProject: false,
		projects: [],
		projectBinding: null,
	};
}

test("the approval card reads each grant in words and keeps the raw grants collapsed @evidence", async ({ page, mockApi }, testInfo) => {
	await mockApi({ projects: [proj] });
	const review = await setupAuthorReviewMock(page, { installationId: INSTALLATION, reviewData });
	try {
		await page.goto("/extensions");
		await clickInAppLink(page, `/extensions/author?installation=${INSTALLATION}`);
		const card = page.locator("article.approval");
		await expect(card.getByRole("heading", { name: "Human approval required" })).toBeVisible();
		await expect(card.getByTestId("approval-grant-line")).toHaveText([
			"Network access to api.weather.example",
			"Start other programs or processes (enforced in the extension's worker; without it, process creation is blocked)",
			"Starts its MCP server process (process spawning allowed)",
		]);
		const raw = card.getByTestId("approval-raw-grants");
		await expect(raw).not.toHaveAttribute("open");
		await expect(raw.locator("pre")).toBeHidden();
		await card.scrollIntoViewIfNeeded();
		await captureEvidence(page, testInfo, "extension-author-approval-grants");

		await raw.getByText("Raw grants").click();
		await expect(raw.locator("pre")).toContainText('"shell"');
	} finally {
		await review.close();
	}
});
