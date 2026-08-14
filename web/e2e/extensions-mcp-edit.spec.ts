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

	// The uniform 502 body from src/mcp/connect-failure.ts. Hardcoded here on
	// purpose: this asserts what an ADMIN READS on screen, and the string is
	// pinned to the source constant by exact equality in
	// src/__tests__/mcp-connect-failure.test.ts.
	const UNIFORM_FAILURE =
		"MCP server unreachable or invalid. If the target is on a private network, " +
		"allow it with EZCORP_MCP_TARGET_ALLOW.";

	test("a blocked SSRF target shows the uniform failure and changes nothing", async ({
		page,
		mockApi,
	}) => {
		// An admin re-points an installed MCP server at the cloud metadata
		// endpoint. The server refuses it, and the UI must show the same
		// message it shows for any other connect failure — the admin learns
		// nothing about whether the address was internal, and neither would an
		// attacker holding an admin-scoped key.
		const current = baseExt([
			{ name: "forecast", description: "Get forecast" },
			{ name: "alerts", description: "Severe alerts" },
		]);

		await mockApi({
			projects: [proj],
			extensions: [current],
			routes: {
				[`/api/extensions/${EXT_ID}`]: (url) => {
					const p = url.pathname;
					if (p === `/api/extensions/${EXT_ID}`) return current;
					if (p.endsWith("/settings")) return { schema: {}, userValues: {} };
					if (p.endsWith("/expired-grants")) return { grants: [] };
					if (p.endsWith("/audit")) return { entries: [] };
					if (p.endsWith("/violations")) return [];
					return {};
				},
			},
		});

		// Registered AFTER mockApi so it wins: the mock `routes` map always
		// fulfills 200, and this case is specifically about a 502 body.
		let putBody: unknown;
		await page.route(`**/api/mcp-servers/${EXT_ID}`, async (route) => {
			putBody = route.request().postDataJSON();
			await route.fulfill({ status: 502, json: { error: UNIFORM_FAILURE } });
		});

		await page.goto(`/extensions/${EXT_ID}`);
		await expect(page.getByTestId("mcp-connection-panel")).toBeVisible();

		await page.getByTestId("mcp-edit-connection-button").click();
		await page.getByTestId("mcp-edit-transport").selectOption("http");
		await page.getByTestId("mcp-edit-url").fill("http://169.254.169.254/latest/meta-data/");
		await page.getByTestId("mcp-test-save-button").click();

		// The admin sees the one constant message.
		await expect(page.getByText(UNIFORM_FAILURE)).toBeVisible();

		// And nothing in it names the target, the range, or a transport errno.
		const banner = await page.getByText(UNIFORM_FAILURE).textContent();
		expect(banner).not.toContain("169.254");
		expect(banner).not.toContain("ECONNREFUSED");
		expect(banner).not.toContain("blocked");

		// The request really was the metadata URL, so this exercised the
		// blocked path rather than a typo somewhere earlier.
		expect(JSON.stringify(putBody)).toContain("169.254.169.254");

		// Nothing committed: the edit panel stays open for the admin to fix
		// the target, there is no success banner, and no tool-delta note (all
		// three only appear after a save that actually persisted).
		await expect(page.getByTestId("mcp-edit-panel")).toBeVisible();
		await expect(page.getByText("Connection updated")).toHaveCount(0);
		await expect(page.getByTestId("mcp-tool-delta")).toHaveCount(0);
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
		// Scoped to the heading: the extension NAME also appears in the
		// uninstall panel's copy and on its button, so a bare `getByText` is
		// a strict-mode violation.
		await expect(page.getByRole("heading", { name: "local-ext" })).toBeVisible();
		await expect(page.getByTestId("mcp-connection-panel")).toHaveCount(0);
	});
});
