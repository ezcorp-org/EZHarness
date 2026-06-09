/**
 * Phase 3 (B) — edit-after-install for MCP extensions.
 *
 * Opens an MCP extension detail page, asserts the Connection panel renders
 * (transport + command, header keys only), opens the Edit-connection panel
 * pre-filled, changes the args, clicks "Test & Save" (PUT /api/mcp-servers/
 * [id]), and verifies the updated config + tool count are reflected, with an
 * added/removed tool-delta note.
 *
 * The detail page issues several GETs under /api/extensions/[id]/* (settings,
 * audit, expired-grants, violations) plus the main detail GET. Because the
 * custom `routes` map matches on substring, a single handler keyed by the
 * extension id branches on the exact pathname: the detail path returns the
 * (mutating) ext record; subroutes return benign empty shapes so the page's
 * other loaders degrade gracefully.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1" });
const EXT_ID = "mcp-edit-1";

function baseExt(tools: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>) {
	return {
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
			mcpServers: [{ transport: "stdio", name: "weather", command: "npx", args: ["weather", "--v1"] }],
			tools: tools.map((t) => ({ inputSchema: {}, ...t })),
			permissions: {},
		},
		grantedPermissions: { grantedAt: {} },
		createdAt: new Date().toISOString(),
	};
}

test.describe("Extensions — MCP edit-after-install", () => {
	test("Connection panel renders, edit args, Test & Save updates config + tool count", async ({ page, mockApi }) => {
		// Mutable server-side state for the detail GET: after the PUT we flip to
		// the v2 tool set.
		let current = baseExt([
			{ name: "forecast", description: "Get forecast" },
			{ name: "alerts", description: "Severe alerts" },
		]);
		const updated = baseExt([
			{ name: "forecast", description: "Get forecast" },
			{ name: "radar", description: "Radar imagery" },
		]);
		// New config persisted after edit.
		updated.manifest.mcpServers = [
			{ transport: "stdio", name: "weather", command: "npx", args: ["weather", "--v2"] },
		];

		await mockApi({
			projects: [proj],
			extensions: [current],
			routes: {
				// Detail GET + subroute GETs share this id-keyed handler.
				[`/api/extensions/${EXT_ID}`]: (url) => {
					const p = url.pathname;
					if (p === `/api/extensions/${EXT_ID}`) return current;
					if (p.endsWith("/settings")) return { schema: {}, userValues: {} };
					if (p.endsWith("/expired-grants")) return { grants: [] };
					if (p.endsWith("/audit")) return { entries: [] };
					if (p.endsWith("/violations")) return [];
					return {};
				},
				// The edit PUT — flips `current` to the v2 record and returns it.
				[`/api/mcp-servers/${EXT_ID}`]: () => {
					current = updated;
					return updated;
				},
			},
		});

		await page.goto(`/extensions/${EXT_ID}`);

		// Connection panel + readonly summary.
		const panel = page.getByTestId("mcp-connection-panel");
		await expect(panel).toBeVisible();
		await expect(page.getByTestId("mcp-connection-transport")).toHaveText("stdio");
		await expect(page.getByTestId("mcp-connection-command")).toContainText("--v1");
		// Tools count before edit.
		await expect(page.getByText("Tools (2)")).toBeVisible();

		// Open the edit panel — pre-filled with current args.
		await page.getByTestId("mcp-edit-connection-button").click();
		const argsInput = page.getByTestId("mcp-edit-args");
		await expect(argsInput).toHaveValue("weather --v1");
		await argsInput.fill("weather --v2");

		// Test & Save → PUT → reload reflects new config + tools.
		await page.getByTestId("mcp-test-save-button").click();

		await expect(page.getByTestId("mcp-connection-command")).toContainText("--v2");
		await expect(page.getByText("Tools (2)")).toBeVisible();
		// Tool delta note: radar added, alerts removed.
		const delta = page.getByTestId("mcp-tool-delta");
		await expect(delta).toBeVisible();
		await expect(delta).toContainText("radar");
		await expect(delta).toContainText("alerts");
	});

	test("Connection panel is hidden for a non-MCP extension", async ({ page, mockApi }) => {
		const local = {
			id: "local-x",
			name: "local-ext",
			version: "1.0.0",
			description: "local",
			enabled: true,
			source: "local",
			installPath: "/tmp/x",
			checksumVerified: false,
			consecutiveFailures: 0,
			isBundled: false,
			manifest: { author: "local", entrypoint: "index.ts", kind: "local", tools: [], permissions: {} },
			grantedPermissions: { grantedAt: {} },
			createdAt: new Date().toISOString(),
		};
		await mockApi({
			projects: [proj],
			extensions: [local],
			routes: {
				"/api/extensions/local-x": (url) => {
					const p = url.pathname;
					if (p === "/api/extensions/local-x") return local;
					if (p.endsWith("/settings")) return { schema: {}, userValues: {} };
					if (p.endsWith("/expired-grants")) return { grants: [] };
					if (p.endsWith("/audit")) return { entries: [] };
					if (p.endsWith("/violations")) return [];
					return {};
				},
			},
		});

		await page.goto("/extensions/local-x");
		await expect(page.getByText("local-ext")).toBeVisible();
		await expect(page.getByTestId("mcp-connection-panel")).toHaveCount(0);
	});
});
