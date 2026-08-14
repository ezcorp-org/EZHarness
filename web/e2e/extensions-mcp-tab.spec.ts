/**
 * Phase 2 (A) — MCP filter tab + guided install confirmation.
 *
 * - The /extensions page renders a third "MCP {count}" tab.
 * - Switching to it shows only kind:"mcp" cards.
 * - A successful MCP install surfaces a "Connected · N tools found"
 *   confirmation banner (read from the returned extension's tool count).
 *
 * Mirrors the extensions-library-tabs harness: the page does an SSR load +
 * a client `loadExtensions()` on mount, both hitting the same /api/extensions
 * mock. The custom `routes` map intercepts /api/mcp-servers (POST) and
 * returns the freshly-installed extension.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

function makeExt(overrides: Record<string, unknown> = {}) {
	return {
		id: overrides.id ?? "ext-1",
		name: overrides.name ?? "my-extension",
		version: overrides.version ?? "1.0.0",
		description: overrides.description ?? "A handy extension",
		enabled: overrides.enabled !== undefined ? overrides.enabled : true,
		source: overrides.source ?? "local",
		consecutiveFailures: overrides.consecutiveFailures ?? 0,
		isBundled: overrides.isBundled ?? false,
		manifest: {
			tools: [{ name: "analyze", description: "Analyze code" }],
			permissions: {},
			...(overrides.manifest as object ?? {}),
		},
		grantedPermissions: overrides.grantedPermissions ?? {},
		...overrides,
	};
}

const proj = makeProject({ id: "proj-1" });

test.describe("Extensions — MCP tab", () => {
	test("renders three tabs and MCP tab shows only kind:mcp cards", async ({ page, mockApi }) => {
		const local = makeExt({ id: "local-1", name: "local-ext", isBundled: false });
		const mcp = makeExt({
			id: "mcp-1",
			name: "weather-mcp",
			manifest: {
				kind: "mcp",
				tools: [{ name: "forecast", description: "Get forecast" }],
				permissions: {},
				mcpServers: [{ transport: "stdio", name: "weather", command: "npx", args: ["weather"] }],
			},
		});
		await mockApi({ projects: [proj], extensions: [local, mcp] });

		await page.goto("/extensions");
		await expect(page.getByText("local-ext")).toBeVisible();

		// Three tabs present.
		await expect(page.getByTestId("ext-tab-installed")).toBeVisible();
		await expect(page.getByTestId("ext-tab-builtins")).toBeVisible();
		const mcpTab = page.getByTestId("ext-tab-mcp");
		await expect(mcpTab).toBeVisible();
		await expect(mcpTab).toContainText("1");

		// Switch to MCP: only the mcp card shows.
		await mcpTab.click();
		await expect(page.getByTestId("ext-tab-panel")).toHaveAttribute("data-active-tab", "mcp");
		await expect(page.getByText("weather-mcp")).toBeVisible();
		await expect(page.getByText("local-ext")).not.toBeVisible();
	});

	test("MCP tab shows empty state when no MCP servers connected", async ({ page, mockApi }) => {
		const local = makeExt({ id: "local-1", name: "local-ext", isBundled: false });
		await mockApi({ projects: [proj], extensions: [local] });

		await page.goto("/extensions");
		await page.getByTestId("ext-tab-mcp").click();
		await expect(page.getByText("No MCP servers connected")).toBeVisible();
	});

	test("successful MCP install shows the connected tool-count confirmation", async ({ page, mockApi }) => {
		const installed = {
			id: "mcp-new",
			name: "db-mcp",
			version: "1.0.0",
			description: "DB tools",
			enabled: true,
			source: "mcp",
			consecutiveFailures: 0,
			isBundled: false,
			manifest: {
				kind: "mcp",
				tools: [
					{ name: "query", description: "Run a query" },
					{ name: "schema", description: "Inspect schema" },
					{ name: "migrate", description: "Run migration" },
				],
				permissions: {},
				mcpServers: [{ transport: "stdio", name: "db", command: "npx", args: ["db-mcp"] }],
			},
			grantedPermissions: {},
		};
		await mockApi({
			projects: [proj],
			extensions: [],
			routes: { "/api/mcp-servers": () => installed },
		});

		await page.goto("/extensions");
		// Switch the install form to MCP.
		await page.getByRole("button", { name: "MCP Server" }).click();
		await page.getByPlaceholder("Extension name (unique)").fill("db-mcp");
		await page.getByPlaceholder("command (e.g. npx)").fill("npx");
		await page.getByPlaceholder("args (space-separated)").fill("db-mcp");
		await page.getByRole("button", { name: "Connect" }).click();

		const banner = page.getByTestId("mcp-install-confirmation");
		await expect(banner).toBeVisible();
		await expect(page.getByTestId("mcp-install-tool-count")).toHaveText("3");
		await expect(banner).toContainText("db-mcp");
	});

	test("a maximum-length name truncates instead of wrecking the card layout", async ({
		page,
		mockApi,
	}) => {
		// 64 chars is LEGAL: `EXTENSION_NAME_REGEX` admits `[a-z0-9][a-z0-9-_.]{0,63}`,
		// and the install input accepts up to exactly that. Before `min-w-0` +
		// `truncate` + `shrink-0`, such a name wrapped to four lines, pushed the
		// `MCP · stdio` badge into a two-line blob on top of it, and squeezed the
		// enable toggle from a 44px pill into a circle.
		const longName = `mcp-${"a".repeat(56)}-srv`;
		expect(longName).toHaveLength(64);
		const mcp = makeExt({
			id: "mcp-long",
			name: longName,
			manifest: {
				kind: "mcp",
				tools: [{ name: "probe", description: "Probe" }],
				permissions: { network: [], mcpInvoke: true },
				mcpServers: [{ transport: "stdio", name: longName, command: "npx", args: ["srv"] }],
			},
		});
		await mockApi({ projects: [proj], extensions: [mcp] });

		await page.goto("/extensions");
		await page.getByTestId("ext-tab-mcp").click();

		const card = page.getByTestId("ext-card").filter({ hasText: "MCP · stdio" });
		const heading = card.getByRole("heading", { name: longName });
		await expect(heading).toBeVisible();

		// The name is clipped, not wrapped: one line box, and the text genuinely
		// overflows its own element (which is what `truncate` renders as an
		// ellipsis). Asserting BOTH rules out "it fits, so nothing was tested".
		const box = await heading.boundingBox();
		expect(box).not.toBeNull();
		expect(box!.height).toBeLessThan(32);
		const metrics = await heading.evaluate((el) => {
			const card = el.closest("[data-testid='ext-card']") as HTMLElement;
			return {
				clipped: el.scrollWidth > el.clientWidth,
				cardWidth: card.getBoundingClientRect().width,
				viewport: window.innerWidth,
			};
		});
		expect(metrics.clipped).toBe(true);
		// …and the card itself still fits the viewport. A grid item defaults to
		// `min-width: auto`, so without `min-w-0` on the CARD the unbreakable name
		// widened the whole track — at 393px the card rendered 703px, the page
		// scrolled sideways, and `truncate` never engaged because the heading had
		// all the room it asked for.
		expect(metrics.cardWidth).toBeLessThanOrEqual(metrics.viewport);

		// The badge stays on one line beside it…
		const badge = card.getByText("MCP · stdio");
		const badgeBox = await badge.boundingBox();
		expect(badgeBox!.height).toBeLessThan(24);

		// …and the toggle keeps its full 44px (w-11) hit target rather than
		// collapsing to a circle.
		const toggle = card.getByTitle(/Disable|Enable/);
		const toggleBox = await toggle.boundingBox();
		expect(Math.round(toggleBox!.width)).toBe(44);
	});
});
