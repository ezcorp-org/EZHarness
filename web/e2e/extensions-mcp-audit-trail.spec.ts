/**
 * B4 — the MCP lifecycle audit trail, as an admin actually sees it.
 *
 * `POST /api/mcp-servers` (install), `PUT /api/mcp-servers/[id]` (edit) and
 * `POST /api/mcp-servers/[id]/refresh` wrote NO audit row until 2026-08,
 * which made configuring a credentialed connection to a third-party server
 * the one privileged extension mutation with no trail. The rows now land in
 * the shared `audit_log` table under `ext:mcp:server-*`, and the surface an
 * operator reads them on is the extension detail page's Audit Trail panel
 * (fed by `GET /api/extensions/[id]/audit`).
 *
 * This spec pins both halves of that: the rows RENDER for an admin, and the
 * panel is absent for a member — the new rows name which MCP servers exist
 * and who configured them, so they must not reach a non-admin.
 *
 * Harness mirrors `extensions-mcp-edit.spec.ts`: one id-keyed handler
 * branches on the exact pathname, because the `routes` map matches on
 * substring and the detail page fans out to several `/api/extensions/[id]/*`
 * subroutes on mount.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1" });
const EXT_ID = "mcp-audit-1";
const ADMIN_ID = "admin-0001-aaaa";

const MCP_EXT = {
	id: EXT_ID,
	name: "weather-mcp",
	version: "0.0.0",
	description: "Weather tools",
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
		mcpServers: [{ transport: "stdio", name: "weather", command: "npx", args: ["weather"] }],
		tools: [{ name: "forecast", description: "Get forecast", inputSchema: {} }],
		permissions: {},
	},
	grantedPermissions: { grantedAt: {} },
	installedPermissions: {},
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
};

/**
 * The rows the three handlers write, in the shape `buildMcpAuditMetadata`
 * produces. Note what `newValue` carries and what it does not: the env KEY
 * name, never its value.
 */
const AUDIT_ENTRIES = [
	{
		id: "a3",
		userId: ADMIN_ID,
		action: "ext:mcp:server-refreshed",
		target: EXT_ID,
		metadata: {
			permission: "network",
			actor: ADMIN_ID,
			reason: "mcp-refresh",
			extensionName: "weather-mcp",
			oldValue: { transport: "stdio", target: "npx", authKeys: [], toolCount: 1, toolNames: ["forecast"] },
			newValue: { transport: "stdio", target: "npx", authKeys: [], toolCount: 2, toolNames: ["forecast", "radar"] },
		},
		createdAt: new Date(Date.now() - 60_000).toISOString(),
	},
	{
		id: "a2",
		userId: ADMIN_ID,
		action: "ext:mcp:server-updated",
		target: EXT_ID,
		metadata: {
			permission: "network",
			actor: ADMIN_ID,
			reason: "mcp-update",
			extensionName: "weather-mcp",
			oldValue: { transport: "stdio", target: "npx", authKeys: [], toolCount: 1, toolNames: ["forecast"] },
			newValue: {
				transport: "stdio",
				target: "npx",
				argCount: 2,
				authKeys: ["WEATHER_API_KEY"],
				toolCount: 1,
				toolNames: ["forecast"],
			},
		},
		createdAt: new Date(Date.now() - 120_000).toISOString(),
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
			extensionName: "weather-mcp",
			oldValue: null,
			newValue: { transport: "stdio", target: "npx", argCount: 1, authKeys: [], toolCount: 1, toolNames: ["forecast"] },
		},
		createdAt: new Date(Date.now() - 180_000).toISOString(),
	},
];

/** One handler for the detail GET + every subroute the page fans out to. */
function extRoutes(entries: unknown[]) {
	return {
		[`/api/extensions/${EXT_ID}`]: (url: URL) => {
			const p = url.pathname;
			if (p === `/api/extensions/${EXT_ID}`) return MCP_EXT;
			if (p.endsWith("/audit")) return { entries };
			if (p.endsWith("/settings")) return { schema: {}, userValues: {} };
			if (p.endsWith("/expired-grants")) return { grants: [] };
			if (p.endsWith("/violations")) return [];
			return {};
		},
	};
}

test.describe("Extensions — MCP lifecycle audit trail", () => {
	test("an admin sees the install, edit and refresh rows on the detail page", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], extensions: [MCP_EXT], routes: extRoutes(AUDIT_ENTRIES) });

		await page.goto(`/extensions/${EXT_ID}`);

		const trail = page.locator("div", { has: page.getByRole("heading", { name: "Audit Trail" }) }).last();
		await expect(trail).toBeVisible();

		// The three mutations that used to leave no trace at all, each now a
		// sentence rather than a mangled slug. Install and edit lead with the
		// DESTINATION — an audit row about an MCP server that does not say
		// which server is not an audit row — and refresh leads with the tool
		// delta, because a refresh leaves the connection alone.
		await expect(trail).toContainText("MCP server installed — stdio npx");
		await expect(trail).toContainText("MCP server edited — stdio npx");
		await expect(trail).toContainText("MCP server refreshed — 1 → 2 tools");

		// The generic branch used to render these as
		// `mcp:server installed (network) — mcp-install`: the raw namespace
		// colon, a `(network)` that is a SIEM scope field rather than the
		// permission being granted, and a reason that just repeats the verb.
		// Assert the leak is gone, not merely that the new copy is present.
		await expect(trail).not.toContainText("mcp:server");
		await expect(trail).not.toContainText("(network)");

		// WHO still comes from metadata.actor, truncated by the page's
		// shortActor.
		await expect(trail).toContainText(`admin:${ADMIN_ID.slice(0, 8)}`);

		// The empty-state must be gone — otherwise "no rows" would read as a
		// pass against a panel that rendered nothing.
		await expect(trail).not.toContainText("No audit entries yet");
	});

	test("a member does not see the Audit Trail panel at all", async ({ page, mockApi }) => {
		// The rows name which MCP servers exist and who configured them, so
		// they must not reach a non-admin. The page gates on /api/auth/me.
		await mockApi({
			projects: [proj],
			extensions: [MCP_EXT],
			routes: {
				...extRoutes(AUDIT_ENTRIES),
				"/api/auth/me": () => ({
					user: { id: "member-1", email: "m@x.test", name: "Member", role: "member" },
				}),
			},
		});

		await page.goto(`/extensions/${EXT_ID}`);
		// The page itself rendered (so this is a real negative, not a blank load).
		await expect(page.getByText("weather-mcp").first()).toBeVisible();

		await expect(page.getByRole("heading", { name: "Audit Trail" })).toHaveCount(0);
		await expect(page.getByText("mcp:server installed")).toHaveCount(0);
	});
});
