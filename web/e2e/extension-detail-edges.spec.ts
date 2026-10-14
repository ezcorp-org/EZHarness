/**
 * Extension detail page (`/extensions/[id]`) — edges the other detail specs
 * leave out: an HTTP MCP connection's headers and edit validation, load
 * failures for settings and expired grants, uninstall failure and cancel,
 * the admin "modifiable" toggle, clearing security violations, and two
 * audit-trail summaries. RENDER tier (mockApi; per-test routes win).
 */
import type { Page } from "@playwright/test";
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeExtension, makeProject, type ExtensionData } from "./fixtures/data.js";

const EXT_ID = "edge-ext-1";
const proj = makeProject({ id: "proj-1" });

function httpMcp(headers: Record<string, string>): ExtensionData {
	return makeExtension({
		id: EXT_ID, name: "remote-mcp", version: "1.0.0", description: "Remote tools", enabled: true,
		source: "release-v4", installPath: null, checksumVerified: true, consecutiveFailures: 0, isBundled: false,
		manifest: {
			schemaVersion: 4, author: { name: "local" }, kind: "mcp",
			mcpServers: [{ transport: "http", name: "remote", url: "https://mcp.example.test/mcp", headers }],
			tools: [{ name: "lookup", description: "Lookup", inputSchema: {} }], permissions: {},
		},
		grantedPermissions: { grantedAt: {} }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
	});
}

/** A pre-v4 local extension: the only kind whose "modifiable" box is shown. */
function legacyExt(): ExtensionData {
	return makeExtension({
		id: EXT_ID, name: "local-tools", isBundled: false, enabled: true,
		manifest: { tools: [{ name: "analyze", description: "Analyze" }], permissions: {} },
	});
}

interface Detail {
	violations?: unknown[];
	audit?: unknown[];
}

function routesFor(extension: ExtensionData, detail: Detail = {}) {
	return {
		[`/api/extensions/${EXT_ID}`]: (url: URL) => {
			if (url.pathname === `/api/extensions/${EXT_ID}`) return extension;
			if (url.pathname.endsWith("/settings")) return { schema: {}, userValues: {} };
			if (url.pathname.endsWith("/expired-grants")) return { grants: [] };
			if (url.pathname.endsWith("/audit")) return { entries: detail.audit ?? [] };
			if (url.pathname.endsWith("/violations")) return detail.violations ?? [];
			return {};
		},
	};
}

async function open(page: Page, mockApi: (o: Record<string, unknown>) => Promise<void>, extension: ExtensionData, detail: Detail = {}) {
	await mockApi({ projects: [proj], extensions: [extension], routes: routesFor(extension, detail) });
}

function onMethod(page: Page, pattern: string, method: string, handle: Parameters<Page["route"]>[1]) {
	return page.route(pattern, (route, request) =>
		route.request().method() === method ? handle(route, request) : route.fallback(),
	);
}

test.describe("Extension detail edges", () => {
	test("an HTTP MCP connection lists header names and the editor checks required fields @evidence", async ({ page, mockApi }, testInfo) => {
		await open(page, mockApi, httpMcp({ Authorization: "secret", "X-Team": "core" }));
		await page.goto(`/extensions/${EXT_ID}`);

		const headers = page.getByTestId("mcp-connection-headers");
		await expect(headers.locator("code")).toHaveText(["Authorization", "X-Team"]);
		await expect(headers).not.toContainText("secret");
		await captureEvidence(page, testInfo, "extension-detail-mcp-headers");

		await page.getByTestId("mcp-edit-connection-button").click();
		// Header names come back with blank values: blank on save keeps the secret.
		await expect(page.getByTestId("mcp-edit-headers")).toHaveValue("Authorization: \nX-Team: ");
		await page.getByPlaceholder("Description (optional)").fill("Remote lookups");

		await page.getByTestId("mcp-edit-url").fill("");
		await page.getByTestId("mcp-test-save-button").click();
		await expect(page.getByText("URL is required for http/sse transport")).toBeVisible();

		await page.getByTestId("mcp-edit-transport").selectOption("stdio");
		await page.getByTestId("mcp-edit-command").fill("  ");
		await page.getByTestId("mcp-test-save-button").click();
		await expect(page.getByText("Command is required for stdio transport")).toBeVisible();
	});

	test("an HTTP MCP connection with no headers says None", async ({ page, mockApi }) => {
		await open(page, mockApi, httpMcp({}));
		await page.goto(`/extensions/${EXT_ID}`);
		await expect(page.getByTestId("mcp-connection-headers")).toHaveText("None");
	});

	test("unreachable settings and expired-grant endpoints each show an error", async ({ page, mockApi }) => {
		await open(page, mockApi, httpMcp({}));
		await page.route(`**/api/extensions/${EXT_ID}/settings`, (route) => route.abort());
		await page.route(`**/api/extensions/${EXT_ID}/expired-grants`, (route) => route.abort());
		await page.goto(`/extensions/${EXT_ID}`);

		await expect(page.getByTestId("expired-grants-error")).toBeVisible();
		await expect(page.getByText(/Failed to fetch|NetworkError|net::/).first()).toBeVisible();
	});

	test("a refused uninstall keeps the page and says why; Cancel closes the dialog", async ({ page, mockApi }) => {
		await open(page, mockApi, httpMcp({}));
		await onMethod(page, `**/api/extensions/${EXT_ID}`, "DELETE", (route) =>
			route.fulfill({ status: 409, json: { error: "Extension is used by a running agent" } }),
		);
		await page.goto(`/extensions/${EXT_ID}`);

		await page.getByTestId("extension-detail-uninstall-button").click();
		await page.getByTestId("uninstall-confirm").click();
		await expect(page.getByText("Extension is used by a running agent")).toBeVisible();
		await expect(page).toHaveURL(`/extensions/${EXT_ID}`);

		await page.getByTestId("uninstall-dialog").getByRole("button", { name: "Cancel" }).click();
		await expect(page.getByTestId("uninstall-dialog")).toHaveCount(0);
	});

	test("an admin toggles 'modifiable'; a refused or failed update is reported", async ({ page, mockApi }) => {
		await open(page, mockApi, legacyExt());
		const bodies: unknown[] = [];
		let reply: "ok" | "refuse" | "drop" = "ok";
		await page.route(`**/api/extensions/${EXT_ID}/modifiable`, (route) => {
			bodies.push(route.request().postDataJSON());
			if (reply === "drop") return route.abort();
			return route.fulfill(reply === "ok" ? { json: { ok: true } } : { status: 400, json: { error: "no" } });
		});
		await page.goto(`/extensions/${EXT_ID}`);
		const toggle = page.getByTestId("modifiable-toggle");
		await expect(toggle).toBeEnabled();

		await toggle.click();
		await expect.poll(() => bodies).toEqual([{ modifiable: true }]);

		reply = "refuse";
		await toggle.click();
		await expect(page.getByText("Failed to update the modifiable setting.")).toBeVisible();

		reply = "drop";
		await toggle.click();
		await expect.poll(() => bodies.length).toBe(3);
		await expect(page.getByText("Failed to update the modifiable setting.")).toBeVisible();
	});

	test("an admin clears security violations; a failed clear is reported", async ({ page, mockApi }) => {
		const violations = [{ reason: "Wrote outside its sandbox", path: "/etc/passwd", timestamp: Date.now() - 60_000 }];
		await open(page, mockApi, httpMcp({}), { violations });
		let deletes = 0;
		await onMethod(page, `**/api/extensions/${EXT_ID}/violations`, "DELETE", (route) => {
			deletes++;
			if (deletes === 1) return route.fulfill({ status: 500, json: { error: "x" } });
			violations.length = 0;
			return route.fulfill({ json: { ok: true } });
		});
		await page.goto(`/extensions/${EXT_ID}`);
		await expect(page.getByText("Wrote outside its sandbox")).toBeVisible();

		await page.getByRole("button", { name: "Clear Violations" }).click();
		await expect(page.getByText("Failed to clear violations")).toBeVisible();

		await page.getByRole("button", { name: "Clear Violations" }).click();
		await expect(page.getByText("Violations cleared")).toBeVisible();
		await expect(page.getByText("Security Violations")).toHaveCount(0);
	});

	test("the audit trail names a purging uninstall and falls back for unknown MCP events", async ({ page, mockApi }) => {
		const audit = [
			{ id: "a1", userId: "e2e-admin", action: "ext:uninstalled", target: EXT_ID, metadata: { purgeData: true }, createdAt: new Date().toISOString() },
			{ id: "a2", userId: "e2e-admin", action: "ext:uninstalled", target: EXT_ID, metadata: {}, createdAt: new Date().toISOString() },
			{ id: "a3", userId: "e2e-admin", action: "ext:mcp:server-paused", target: EXT_ID, metadata: { reason: "maintenance" }, createdAt: new Date().toISOString() },
		];
		await open(page, mockApi, httpMcp({}), { audit });
		await page.goto(`/extensions/${EXT_ID}`);

		await expect(page.getByText("Extension uninstalled — data purged")).toBeVisible();
		await expect(page.getByText("Extension uninstalled", { exact: true })).toBeVisible();
		// No permission on the event: the raw verb, without a reason suffix.
		await expect(page.getByText("mcp:server paused", { exact: true })).toBeVisible();
	});
});
