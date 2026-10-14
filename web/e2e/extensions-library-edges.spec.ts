/**
 * Extensions library (`/extensions`) — failure and validation edges:
 * a failed list load, MCP form validation and header parsing, readable
 * install/refresh errors, and backing out of the critical-disable dialog.
 * RENDER tier (mockApi plus per-test routes registered after it, which win).
 */
import type { Page } from "@playwright/test";
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeExtension, makeProject, type ExtensionData } from "./fixtures/data.js";
import { setupAuthorReviewMock } from "./fixtures/extension-source-import.js";

const proj = makeProject({ id: "proj-1" });

function makeExt(overrides: Partial<ExtensionData> = {}): ExtensionData {
	return makeExtension({
		...overrides,
		manifest: { tools: [{ name: "analyze", description: "Analyze code" }], permissions: {}, ...overrides.manifest },
	});
}

const mcpExt = makeExt({
	id: "mcp-1",
	name: "weather-mcp",
	manifest: {
		kind: "mcp",
		tools: [{ name: "forecast", description: "Get forecast" }],
		permissions: {},
		mcpServers: [{ transport: "stdio", name: "weather", command: "npx", args: ["weather"] }],
	},
});

async function openMcpForm(page: Page) {
	await page.goto("/extensions");
	await page.getByRole("button", { name: "MCP Server" }).click();
}

function failInstall(page: Page, status: number, body: string, contentType = "application/json") {
	return page.route("**/api/mcp-servers", (route) =>
		route.request().method() === "POST" ? route.fulfill({ status, body, contentType }) : route.fallback(),
	);
}

test.describe("Extensions library edges", () => {
	// Regression: the list response was used without checking res.ok, so an
	// error body replaced the extension array and the page stopped rendering.
	test("a failed list load keeps the page and says why @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [proj], extensions: [makeExt({ id: "e-1", name: "kept-ext", isBundled: false })] });
		await page.route("**/api/extensions", (route) =>
			route.request().method() === "GET"
				? route.fulfill({ status: 503, json: { error: "Extension store unavailable" } })
				: route.fallback(),
		);
		await page.goto("/extensions");

		await expect(page.getByText("Extension store unavailable")).toBeVisible();
		await expect(page.getByTestId("ext-tab-installed")).toBeVisible();
		await page.getByTestId("ext-tab-mcp").click();
		await expect(page.getByTestId("ext-tab-panel")).toHaveAttribute("data-active-tab", "mcp");
		await captureEvidence(page, testInfo, "extensions-load-failure");
	});

	test("the MCP form names each missing field before connecting", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], extensions: [] });
		const posts: string[] = [];
		page.on("request", (r) => {
			if (r.url().endsWith("/api/mcp-servers") && r.method() === "POST") posts.push(r.url());
		});
		await openMcpForm(page);
		const connect = page.getByRole("button", { name: "Connect" });

		await connect.click();
		await expect(page.getByText("Extension name is required")).toBeVisible();

		await page.getByPlaceholder("Extension name (unique)").fill("db-mcp");
		await connect.click();
		await expect(page.getByText("Command is required for stdio transport")).toBeVisible();

		await page.getByRole("combobox").filter({ hasText: "stdio" }).selectOption("http");
		await connect.click();
		await expect(page.getByText("URL is required for http/sse transport")).toBeVisible();
		expect(posts).toEqual([]);
	});

	test("an HTTP MCP server sends its parsed headers; a field error is shown in full", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], extensions: [] });
		await failInstall(page, 400, JSON.stringify({ error: "Invalid server", fields: { url: "must use https" } }));
		await openMcpForm(page);

		await page.getByPlaceholder("Extension name (unique)").fill("remote-mcp");
		await page.getByRole("combobox").filter({ hasText: "stdio" }).selectOption("http");
		await page.getByPlaceholder("https://example.com/mcp").fill("http://mcp.example.test");
		await page
			.getByPlaceholder("Headers (one per line, e.g. Authorization: Bearer ...)")
			.fill("Authorization: Bearer abc\nnot a header\nX-Route: a:b\n: no-key");
		const sent = page.waitForRequest((r) => r.url().endsWith("/api/mcp-servers") && r.method() === "POST");
		await page.getByRole("button", { name: "Connect" }).click();

		expect((await sent).postDataJSON().server).toEqual({
			transport: "http",
			name: "remote-mcp",
			url: "http://mcp.example.test",
			headers: { Authorization: "Bearer abc", "X-Route": "a:b" },
		});
		await expect(page.getByText("Invalid server — url: must use https")).toBeVisible();
	});

	test("install errors without a JSON body still read clearly", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], extensions: [] });
		await failInstall(page, 502, "upstream timed out", "text/plain");
		await openMcpForm(page);
		await page.getByPlaceholder("Extension name (unique)").fill("db-mcp");
		await page.getByPlaceholder("command (e.g. npx)").fill("npx");
		await page.getByRole("button", { name: "Connect" }).click();
		await expect(page.getByText("upstream timed out")).toBeVisible();

		await page.unroute("**/api/mcp-servers");
		await failInstall(page, 500, "", "text/plain");
		await page.getByRole("button", { name: "Connect" }).click();
		await expect(page.getByText("Internal Server Error")).toBeVisible();
	});

	// Regression: refresh parsed the error body as JSON, so a gateway's HTML
	// error surfaced as a JSON parse error instead of the real cause.
	test("a refresh failure shows the server's reason, even as plain text", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], extensions: [mcpExt] });
		await page.route("**/api/mcp-servers/mcp-1/refresh", (route) =>
			route.fulfill({ status: 502, contentType: "text/plain", body: "MCP server did not answer" }),
		);
		await page.goto("/extensions");
		await page.getByTitle("Refresh tools list from MCP server").click();
		await expect(page.getByText("MCP server did not answer")).toBeVisible();
	});

	test("a refresh stages a review and opens it", async ({ page, mockApi }) => {
		const location = "/extensions/author?installation=weather-mcp&workspace=draft";
		await mockApi({ projects: [proj], extensions: [mcpExt] });
		await page.route("**/api/mcp-servers/mcp-1/refresh", (route) => route.fulfill({ json: { openUrl: location } }));
		const review = await setupAuthorReviewMock(page, { installationId: "weather-mcp", workspaceId: "draft" });
		try {
			await page.goto("/extensions");
			await page.getByTitle("Refresh tools list from MCP server").click();
			await expect(page).toHaveURL(location);
			await review.expectReview();
		} finally {
			await review.close();
		}
	});

	test("the critical-disable dialog closes on Keep it on, Escape and the backdrop", async ({ page, mockApi }) => {
		const critical = makeExt({
			id: "crit-1",
			name: "loop-guard",
			enabled: true,
			isCritical: true,
			criticalConsequence: "Agents can loop forever without it.",
		} as Partial<ExtensionData>);
		await mockApi({ projects: [proj], extensions: [critical] });
		const patches: string[] = [];
		page.on("request", (r) => {
			if (r.method() === "PATCH") patches.push(r.url());
		});
		await page.goto("/extensions");
		const dialog = page.getByTestId("disable-critical-dialog");
		const open = async () => {
			await page.getByTitle("Disable").first().click();
			await expect(dialog).toBeVisible();
		};

		await open();
		await expect(page.getByTestId("disable-critical-consequence")).toHaveText("Agents can loop forever without it.");
		await page.getByRole("button", { name: "Keep it on" }).click();
		await expect(dialog).toHaveCount(0);

		await open();
		await dialog.press("Escape");
		await expect(dialog).toHaveCount(0);

		await open();
		await dialog.click({ position: { x: 5, y: 5 } });
		await expect(dialog).toHaveCount(0);
		expect(patches).toEqual([]);
	});
});
