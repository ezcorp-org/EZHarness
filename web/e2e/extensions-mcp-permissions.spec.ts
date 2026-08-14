/**
 * B5 — an MCP extension's network permission is visible and grantable.
 *
 * Before the fix, `installMcpExtension` synthesized `permissions: {}` for
 * every MCP row. The detail page renders its "Network Access" checkbox row
 * from `ext.manifest.permissions.network`, so an MCP extension showed "None
 * requested" — and because `clampExtensionPermissions` gates on
 * `if (submitted.network && manifest.network)`, an admin who submitted a host
 * anyway had it silently dropped. The stdio forward proxy
 * (`mcp-proxy.ts`) re-authorizes EVERY CONNECT against exactly that grant, so
 * the network capability was unreachable: no host could ever be allowed.
 *
 * The manifest now declares the hosts the server definition names — for a
 * stdio server, the URLs on its own command line — so the row is real,
 * pre-granted at install, and revocable here.
 */
import { test, expect } from "./fixtures/test-base.js";
import { captureEvidence } from "./fixtures/evidence.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1" });
const EXT_ID = "mcp-perms-1";
const HOST = "mcp.notion.com";

/** An MCP row as `installMcpExtension` writes it today. */
function mcpExt(opts: { args: string[]; network: string[]; granted: string[] }) {
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
		manifest: {
			author: "local",
			entrypoint: "",
			kind: "mcp",
			mcpServers: [
				{ transport: "stdio", name: "notion", command: "npx", args: opts.args },
			],
			tools: [
				{
					name: "search",
					description: "Search pages",
					inputSchema: {},
					// The declaration the PDP turns into the needed-cap set. The
					// `ezcorp:mcp:invoke` sentinel is present even when no host is
					// declared — an empty declaration flattens to an empty needed set,
					// which `firstMissingCapability` can never fail.
					capabilities: {
						...(opts.network.length > 0 ? { network: { hosts: opts.network } } : {}),
						custom: { "ezcorp:mcp:invoke": true },
					},
				},
			],
			permissions: { network: opts.network, mcpInvoke: true },
		},
		grantedPermissions:
			opts.granted.length > 0
				? {
						network: opts.granted,
						mcpInvoke: true,
						grantedAt: { network: 1_700_000_000_000, mcpInvoke: 1_700_000_000_000 },
					}
				: { mcpInvoke: true, grantedAt: { mcpInvoke: 1_700_000_000_000 } },
		installedPermissions:
			opts.granted.length > 0
				? {
						network: opts.granted,
						mcpInvoke: true,
						grantedAt: { network: 1_700_000_000_000, mcpInvoke: 1_700_000_000_000 },
					}
				: { mcpInvoke: true, grantedAt: { mcpInvoke: 1_700_000_000_000 } },
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}

async function openDetail(
	page: import("@playwright/test").Page,
	mockApi: (overrides?: Record<string, unknown>) => Promise<void>,
	ext: ReturnType<typeof mcpExt>,
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
				if (p.endsWith("/audit")) return { entries: [] };
				if (p.endsWith("/violations")) return [];
				if (p.endsWith("/permissions")) return ext.grantedPermissions;
				return {};
			},
		},
	});
	await page.goto(`/extensions/${EXT_ID}`);
	// Scoped to the heading: the name also appears in the uninstall copy.
	await expect(page.getByRole("heading", { name: "notion-mcp" })).toBeVisible();
}

test.describe("Extensions — MCP network permission", () => {
	test("@evidence shows the derived host as a granted, revocable permission", async ({
		page,
		mockApi,
	}, testInfo) => {
		const ext = mcpExt({
			args: ["-y", "mcp-remote", `https://${HOST}/mcp`],
			network: [HOST],
			granted: [HOST],
		});
		await openDetail(page, mockApi, ext);

		// The host the operator put on the command line is what the manifest
		// declares — the ceiling an admin's grant is clamped to.
		const row = page.getByText("Network Access");
		await expect(row).toBeVisible();
		const hostBox = page.locator(`label:has-text("${HOST}") input[type="checkbox"]`);
		await expect(hostBox).toBeVisible();
		// Pre-granted at install, so it renders checked.
		await expect(hostBox).toBeChecked();

		await captureEvidence(page, testInfo, "mcp-network-permission-granted");

		// Revoking it is a real action: the PUT carries an empty host list, and
		// the PDP then denies both the tool dispatch and every proxy CONNECT.
		const put = page.waitForRequest(
			(r) => r.url().includes(`/api/extensions/${EXT_ID}/permissions`) && r.method() === "PUT",
		);
		await hostBox.uncheck();
		await page.getByRole("button", { name: "Save Permissions" }).click();
		const body = (await put).postDataJSON() as { permissions: { network: string[] } };
		expect(body.permissions.network).toEqual([]);
	});

	test("a stdio server naming no host shows the deny-by-default state", async ({
		page,
		mockApi,
	}) => {
		const ext = mcpExt({
			args: ["-y", "@modelcontextprotocol/server-github"],
			network: [],
			granted: [],
		});
		await openDetail(page, mockApi, ext);

		await expect(page.getByText("Network Access")).toBeVisible();
		// Nothing is invented from a command line that names no host, so there
		// is nothing to grant and the forward proxy refuses every CONNECT.
		await expect(page.locator(`label:has-text("${HOST}")`)).toHaveCount(0);
		await expect(page.getByText("None requested").first()).toBeVisible();
	});
});
