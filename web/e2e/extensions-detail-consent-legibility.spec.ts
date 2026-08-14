/**
 * The extension detail page is where an admin gives consent, so what it shows
 * has to be both LEGIBLE and TRUE. Product validation found it was neither:
 *
 *   U1  a near-limit host in the Network Access row rendered ~490px past the
 *       card and past the viewport (`overflow-wrap:normal`, `text-overflow:
 *       clip`), so the admin could not read the hostname being approved.
 *       Consent to a string the UI refuses to show is not consent — which is
 *       the specific claim the MCP permission work rests on.
 *   U2  every MCP extension told the admin who installed it "An admin must
 *       enable modification before you can edit it", on the same page that
 *       offers them an "Edit connection" button. New in #204, which started
 *       stamping `creatorUserId` on MCP rows.
 *   U3  the audit panel said only permission events were recorded, directly
 *       above an MCP-install row.
 *
 * U1 is asserted by MEASUREMENT, not by a screenshot: the pill's right edge
 * must sit inside the card and inside the viewport. A screenshot proves what
 * it looked like once; the geometry assertion is what keeps it fixed.
 */
import { test, expect } from "./fixtures/test-base.js";
import { captureEvidence } from "./fixtures/evidence.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1" });
const EXT_ID = "mcp-legibility-1";

/** The e2e mock's `/api/auth/me` identity — see `fixtures/api-mocks.ts`. */
const ADMIN_ID = "e2e-admin";

/**
 * A near-limit hostname. DNS allows 253 chars total and 63 per label, and
 * real MCP endpoints do get long (tenant + region + service + provider). This
 * is the shape that ran off the card: one unbroken token with no spaces and
 * no hyphens for the browser to break at.
 */
const LONG_HOST =
	"mcp-gateway-production-us-east-1-primary.tenant-acme-corporation-holdings-international.integrations-platform-edge-router-service.enterprise-observability-and-compliance-layer.example-enterprise-platform.com";

/** A short host in the SAME row, so the wrap check calibrates itself against
 *  a one-line pill instead of a magic pixel height. */
const SHORT_HOST = "mcp.notion.com";

function mcpExt(over: Record<string, unknown> = {}) {
	return {
		id: EXT_ID,
		name: "notion-mcp",
		version: "0.0.0",
		description: "Notion over MCP",
		enabled: true,
		source: "mcp:stdio",
		installPath: null,
		checksumVerified: false,
		consecutiveFailures: 0,
		isBundled: false,
		// The admin who installed it. #204 started persisting this for MCP rows.
		creatorUserId: ADMIN_ID,
		modifiable: false,
		manifest: {
			author: "local",
			entrypoint: "",
			kind: "mcp",
			mcpServers: [
				{ transport: "stdio", name: "notion", command: "npx", args: ["-y", "mcp-remote", `https://${LONG_HOST}/mcp`] },
			],
			tools: [{ name: "search", description: "Search pages", inputSchema: {} }],
			permissions: { network: [SHORT_HOST, LONG_HOST] },
		},
		grantedPermissions: { network: [SHORT_HOST, LONG_HOST], grantedAt: { network: 1_700_000_000_000 } },
		installedPermissions: { network: [SHORT_HOST, LONG_HOST], grantedAt: { network: 1_700_000_000_000 } },
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...over,
	};
}

/** The three MCP lifecycle rows, in the shape `mcp-audit.ts` writes. */
const AUDIT_ENTRIES = [
	{
		id: "a2",
		userId: ADMIN_ID,
		action: "ext:mcp:server-refreshed",
		target: EXT_ID,
		metadata: {
			permission: "network",
			actor: ADMIN_ID,
			reason: "mcp-refresh",
			extensionName: "notion-mcp",
			oldValue: { transport: "stdio", target: "npx", toolCount: 1, toolNames: ["search"] },
			newValue: { transport: "stdio", target: "npx", toolCount: 2, toolNames: ["search", "create"] },
		},
		createdAt: new Date(Date.now() - 60_000).toISOString(),
	},
	{
		id: "a1",
		userId: ADMIN_ID,
		action: "ext:mcp:server-installed",
		target: EXT_ID,
		metadata: {
			permission: "network",
			actor: ADMIN_ID,
			reason: "mcp-install",
			extensionName: "notion-mcp",
			oldValue: null,
			newValue: { transport: "stdio", target: "npx", argCount: 3, toolCount: 1, toolNames: ["search"] },
		},
		createdAt: new Date(Date.now() - 120_000).toISOString(),
	},
];

async function openDetail(
	page: import("@playwright/test").Page,
	mockApi: (overrides?: Record<string, unknown>) => Promise<void>,
	ext: ReturnType<typeof mcpExt>,
	entries: unknown[] = AUDIT_ENTRIES,
) {
	await mockApi({
		projects: [proj],
		extensions: [ext],
		routes: {
			[`/api/extensions/${EXT_ID}`]: (url: URL) => {
				const p = url.pathname;
				if (p === `/api/extensions/${EXT_ID}`) return ext;
				if (p.endsWith("/settings")) return { schema: {}, userValues: {} };
				if (p.endsWith("/expired-grants")) return { grants: [] };
				if (p.endsWith("/audit")) return { entries };
				if (p.endsWith("/violations")) return [];
				if (p.endsWith("/permissions")) return ext.grantedPermissions;
				return {};
			},
		},
	});
	await page.goto(`/extensions/${EXT_ID}`);
	await expect(page.getByRole("heading", { name: "notion-mcp" })).toBeVisible();
}

test.describe("Extensions detail — consent legibility", () => {
	test("@evidence a near-limit host stays inside the card and the viewport", async ({
		page,
		mockApi,
	}, testInfo) => {
		await openDetail(page, mockApi, mcpExt());

		const pill = page.locator(`label:has-text("${LONG_HOST}")`);
		await expect(pill).toBeVisible();

		// The card is the pill's nearest bordered ancestor — the same box the
		// measurement compared against.
		const card = page.locator("div.rounded-lg", { has: page.getByText("Network Access") }).last();
		const pillBox = await pill.boundingBox();
		const cardBox = await card.boundingBox();
		const viewport = page.viewportSize();
		expect(pillBox).not.toBeNull();
		expect(cardBox).not.toBeNull();
		expect(viewport).not.toBeNull();

		const pillRight = pillBox!.x + pillBox!.width;
		const cardRight = cardBox!.x + cardBox!.width;
		// Measured before the fix: pill right 1746 vs card right 1256 vs
		// viewport 1280 — 490px of the hostname was unreachable.
		expect(pillRight).toBeLessThanOrEqual(cardRight + 1);
		expect(pillRight).toBeLessThanOrEqual(viewport!.width);

		// Geometry alone is not enough: `max-w-full` clamps the BOX, so a pill
		// whose text still refused to break would pass the two checks above
		// while spilling visually. The positive signal that `break-all` engaged
		// is that this pill is TALLER than a one-line pill in the same row —
		// self-calibrating, so it survives a font or zoom change.
		const shortPill = page.locator(`label:has-text("${SHORT_HOST}")`);
		const shortBox = await shortPill.boundingBox();
		expect(shortBox).not.toBeNull();
		expect(pillBox!.height).toBeGreaterThan(shortBox!.height);

		// And it is genuinely readable — the whole host, not an ellipsis.
		await expect(pill).toContainText(LONG_HOST);

		await captureEvidence(page, testInfo, "mcp-long-host-wraps-inside-card");
	});

	test("@evidence an MCP extension does not claim its own admin cannot edit it", async ({
		page,
		mockApi,
	}, testInfo) => {
		// `creatorUserId === the logged-in admin` — the exact state #204 created
		// for every MCP row.
		await openDetail(page, mockApi, mcpExt());

		await expect(
			page.getByText("An admin must enable modification before you can edit it"),
		).toHaveCount(0);
		// The affordance that made the notice self-contradicting is present.
		await expect(page.getByTestId("mcp-edit-connection-button")).toBeVisible();

		await captureEvidence(page, testInfo, "mcp-no-false-modification-notice");
	});

	test("a NON-MCP extension still shows the modification notice", async ({ page, mockApi }) => {
		// The negative control: the fix narrowed the notice to non-MCP rows, it
		// did not delete it.
		const local = mcpExt({
			source: "local",
			manifest: {
				author: "local",
				entrypoint: "index.ts",
				kind: "subprocess",
				tools: [],
				permissions: { network: [SHORT_HOST, LONG_HOST] },
			},
		});
		await openDetail(page, mockApi, local);

		await expect(
			page.getByText("An admin must enable modification before you can edit it"),
		).toBeVisible();
	});

	test("@evidence the audit panel describes, and renders, MCP lifecycle rows", async ({
		page,
		mockApi,
	}, testInfo) => {
		await openDetail(page, mockApi, mcpExt());

		const trail = page
			.locator("div", { has: page.getByRole("heading", { name: "Audit Trail" }) })
			.last();
		await expect(trail).toBeVisible();

		// The copy now covers what the FIRST row on screen actually is.
		await expect(trail).toContainText("MCP server lifecycle");

		// Each row reads as a sentence, and the install row names WHICH server
		// the credentialed connection points at (`metadata.newValue.target`,
		// captured since #204 and never displayed until now).
		await expect(trail).toContainText("MCP server installed — stdio npx");
		await expect(trail).toContainText("MCP server refreshed — 1 → 2 tools");
		// The raw shapes are gone: no `mcp:` namespace colon, no `(network)`
		// masquerading as the permission granted, no `— mcp-install` repeating
		// the verb.
		await expect(trail).not.toContainText("mcp:server installed");
		await expect(trail).not.toContainText("(network)");
		await expect(trail).not.toContainText("mcp-install");

		await captureEvidence(page, testInfo, "mcp-audit-rows-read-as-sentences");
	});
});
