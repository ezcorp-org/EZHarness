import type { Page, Route } from "@playwright/test";
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const EXT_ID = "mcp-edit-1";
const REVIEW_URL = `/extensions/author?installation=${EXT_ID}&workspace=candidate-1`;
const PROBE_FAILURE = "MCP catalog probe failed. Check the public endpoint and credentials; no release was activated.";
const proj = makeProject({ id: "proj-1" });
function baseExt() {
	return {
		id: EXT_ID, name: "weather-mcp", version: "1.0.0", description: "Weather tools", enabled: true,
		source: "release-v4", installPath: null, checksumVerified: true, consecutiveFailures: 0, isBundled: false,
		manifest: { schemaVersion: 4, author: { name: "local" }, kind: "mcp", mcpServers: [{ transport: "stdio", name: "weather", command: "/usr/local/bin/bun", args: ["server.js", "--v1"] }], tools: [{ name: "forecast", description: "Forecast", inputSchema: {} }, { name: "alerts", description: "Alerts", inputSchema: {} }], permissions: {} },
		grantedPermissions: { grantedAt: {} }, createdAt: new Date().toISOString(),
	};
}
function detailRoutes(extension: ReturnType<typeof baseExt>) {
	return { [`/api/extensions/${EXT_ID}`]: (url: URL) => {
		if (url.pathname === `/api/extensions/${EXT_ID}`) return extension;
		if (url.pathname.endsWith("/settings")) return { schema: {}, userValues: {} };
		if (url.pathname.endsWith("/expired-grants")) return { grants: [] };
		if (url.pathname.endsWith("/audit")) return { entries: [] };
		if (url.pathname.endsWith("/violations")) return [];
		return {};
	} };
}
async function stageAtApiBoundary(page: Page) {
	let submitted: unknown;
	const pending: Route[] = [];
	await page.route(`**/api/mcp-servers/${EXT_ID}`, async route => {
		expect(route.request().method()).toBe("PUT");
		submitted = route.request().postDataJSON();
		await route.fulfill({ status: 202, json: { installation: { id: EXT_ID, activeReleaseId: "active-v1" }, workspace: { id: "candidate-1", revision: 1 }, operation: { id: "build-1", state: "queued" }, openUrl: REVIEW_URL } });
	});
	await page.route("**/extensions/author**", route => { pending.push(route); });
	return {
		submitted: () => submitted,
		async handoff() {
			await expect.poll(() => pending.length).toBeGreaterThan(0);
			const url = new URL(pending[0]!.request().url());
			expect(["/extensions/author", "/extensions/author/__data.json"]).toContain(url.pathname);
			expect(url.searchParams.get("installation")).toBe(EXT_ID);
			expect(url.searchParams.get("workspace")).toBe("candidate-1");
		},
		async close() { for (const route of pending) await route.abort(); },
	};
}

test.describe("Extensions — MCP candidate staging", () => {
	test("edited args stage a candidate and hand off to review without changing the active catalog", async ({ page, mockApi }) => {
		const current = baseExt();
		const unchanged = structuredClone(current);
		await mockApi({ projects: [proj], extensions: [current], routes: detailRoutes(current) });
		const staging = await stageAtApiBoundary(page);
		try {
			await page.goto(`/extensions/${EXT_ID}`);
			await expect(page.getByTestId("mcp-connection-panel")).toBeVisible();
			await expect(page.getByTestId("mcp-connection-transport")).toHaveText("stdio");
			await expect(page.getByTestId("mcp-connection-command")).toContainText("--v1");
			await expect(page.getByText("Tools (2)")).toBeVisible();
			await page.getByTestId("mcp-edit-connection-button").click();
			await expect(page.getByTestId("mcp-edit-args")).toHaveValue("server.js --v1");
			await page.getByTestId("mcp-edit-args").fill("server.js --v2");
			await page.getByTestId("mcp-test-save-button").click();
			await staging.handoff();
			expect(staging.submitted()).toMatchObject({ server: { command: "/usr/local/bin/bun", args: ["server.js", "--v2"] } });
			expect(current).toEqual(unchanged);
			await expect(page.getByTestId("mcp-connection-command")).toContainText("--v1");
			await expect(page.getByTestId("mcp-tool-delta")).toHaveCount(0);
			await expect(page.getByText("Build pending; human approval is required.")).toBeVisible();
		} finally { await staging.close(); }
	});
	test("failed probe shows a redacted error without staging or changing the active release", async ({ page, mockApi }) => {
		const current = baseExt();
		await mockApi({ projects: [proj], extensions: [current], routes: detailRoutes(current) });
		let submitted: unknown;
		await page.route(`**/api/mcp-servers/${EXT_ID}`, async route => { submitted = route.request().postDataJSON(); await route.fulfill({ status: 500, json: { code: "mcp_probe_failed", message: PROBE_FAILURE } }); });
		await page.goto(`/extensions/${EXT_ID}`);
		await page.getByTestId("mcp-edit-connection-button").click();
		await page.getByTestId("mcp-edit-transport").selectOption("http");
		await page.getByTestId("mcp-edit-url").fill("http://169.254.169.254/latest/meta-data/");
		await page.getByTestId("mcp-test-save-button").click();
		const banner = page.getByText(PROBE_FAILURE);
		await expect(banner).toBeVisible();
		expect(await banner.textContent()).not.toMatch(/169\.254|ECONNREFUSED|blocked/);
		expect(submitted).toMatchObject({ server: { url: "http://169.254.169.254/latest/meta-data/" } });
		await expect(page).toHaveURL(new RegExp(`/extensions/${EXT_ID}$`));
		await expect(page.getByTestId("mcp-edit-panel")).toBeVisible();
		await page.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(page.getByTestId("mcp-connection-command")).toContainText("--v1");
		await expect(page.getByText("Build pending; human approval is required.")).toHaveCount(0);
		await expect(page.getByTestId("mcp-tool-delta")).toHaveCount(0);
	});
	test("credential blanks stay redacted and round-trip only into the staged candidate", async ({ page, mockApi }) => {
		const current = baseExt();
		current.manifest.mcpServers[0]!.args = ["server.js", "--token=", "https://mcp.vendor.com/mcp?api_key="];
		await mockApi({ projects: [proj], extensions: [current], routes: detailRoutes(current) });
		const staging = await stageAtApiBoundary(page);
		try {
			await page.goto(`/extensions/${EXT_ID}`);
			const command = page.getByTestId("mcp-connection-command");
			await expect(command).toContainText("--token=");
			await expect(command).toContainText("api_key=");
			await expect(command).toContainText("mcp.vendor.com");
			expect(await page.content()).not.toMatch(/api_key=[^&"'\s<]|--token=[^&"'\s<]/);
			await page.getByTestId("mcp-edit-connection-button").click();
			await expect(page.getByTestId("mcp-edit-args")).toHaveValue("server.js --token= https://mcp.vendor.com/mcp?api_key=");
			await page.getByTestId("mcp-test-save-button").click();
			await staging.handoff();
			expect(staging.submitted()).toMatchObject({ server: { args: ["server.js", "--token=", "https://mcp.vendor.com/mcp?api_key="] } });
			await expect(page.getByText("Build pending; human approval is required.")).toBeVisible();
		} finally { await staging.close(); }
	});
	test("Connection panel is hidden for a non-MCP extension", async ({ page, mockApi }) => {
		const current = baseExt();
		current.manifest.kind = "tool";
		current.manifest.mcpServers = [];
		await mockApi({ projects: [proj], extensions: [current], routes: detailRoutes(current) });
		await page.goto(`/extensions/${EXT_ID}`);
		await expect(page.getByRole("heading", { name: "weather-mcp" })).toBeVisible();
		await expect(page.getByTestId("mcp-connection-panel")).toHaveCount(0);
	});
});
