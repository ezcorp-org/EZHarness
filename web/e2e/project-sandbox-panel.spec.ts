import type { Page, Route } from "@playwright/test";
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const provider = {
	installationId: "11111111-1111-4111-8111-111111111111",
	providerId: "local-podman",
	label: "Local Podman",
	ready: true,
};

const status = {
	projectId: "sandbox-project",
	bindingId: "binding-1",
	state: "stopped",
	provider: { label: "Local Podman" },
	resource: { resourceId: "resource-1", observedState: "stopped", desiredState: "stopped", limits: {} },
	operation: null,
};

async function mockSandboxApi(page: Page) {
	let current = { ...status };
	await page.route("**/api/sandboxes/providers", (route: Route) => route.fulfill({ json: { providers: [provider] } }));
	await page.route("**/api/sandboxes", (route: Route) => {
		if (route.request().method() !== "POST") return route.fallback();
		return route.fulfill({ status: 201, json: { project: { id: "sandbox-project" }, sandbox: current } });
	});
	await page.route("**/api/projects/*/sandbox", async (route: Route) => {
		const projectId = new URL(route.request().url()).pathname.split("/")[3];
		if (projectId !== "sandbox-project") {
			return route.fulfill({ status: 409, json: { code: "SANDBOX_NOT_CONFIGURED", error: "Project has no sandbox binding" } });
		}
		if (route.request().method() === "GET") return route.fulfill({ json: current });
		const { action } = route.request().postDataJSON() as { action: "start" | "stop" | "destroy" };
		if (action === "destroy") return route.fulfill({ status: 409, json: { error: "Provider operation failed" } });
		current = { ...current, state: action === "start" ? "running" : "stopped" };
		return route.fulfill({ json: current });
	});
	await page.route("**/api/local-sandbox/operations/*/execute", (route: Route) => route.abort("blockedbyclient"));
}

test.describe("project sandbox panel", () => {
	test("creates a dedicated sandbox and shows the reviewed provider @evidence", async ({ page, mockApi }, testInfo) => {
		const project = makeProject({ id: "source-project", name: "Source project" });
		await mockApi({ projects: [project] });
		await mockSandboxApi(page);
		await page.goto(`/project/${project.id}/settings`);
		const panel = page.getByTestId("project-sandbox-panel");
		await expect(panel.getByRole("button", { name: /Local Podman/i })).toBeVisible();
		await captureEvidence(page, testInfo, "project-sandbox-create-desktop", { fullPage: true });
		const created = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/sandboxes" && request.method() === "POST");
		await panel.getByRole("button", { name: /Local Podman/i }).click();
		const request = await created;
		expect(request.postDataJSON()).toEqual({ name: "Sandbox for source-project", providerInstallationId: provider.installationId, providerId: provider.providerId });
		expect(request.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
		await expect(page).toHaveURL(/\/project\/sandbox-project\/settings/);
	});

	test("runs admitted start and stop, exposes open chat, fails dispose visibly, and remains usable on mobile @evidence", async ({ page, mockApi }, testInfo) => {
		const project = makeProject({ id: "sandbox-project", name: "Sandbox project", path: "" });
		await mockApi({ projects: [project] });
		await mockSandboxApi(page);
		await page.goto(`/project/${project.id}/settings`);
		const panel = page.getByTestId("project-sandbox-panel");
		await expect(panel.getByText("stopped")).toBeVisible();
		await expect(panel.getByRole("link", { name: "Open chat" })).toHaveAttribute("href", `/project/${project.id}`);
		await expect(page.getByRole("textbox", { name: "Working Directory" })).toHaveCount(0);
		await expect(page.getByText("Feature Index", { exact: true })).toHaveCount(0);
		await expect(page.getByTestId("project-settings-integrations")).toHaveCount(0);
		await panel.getByRole("button", { name: "Start" }).click();
		await expect(panel.getByText("running")).toBeVisible();
		await panel.getByRole("button", { name: "Stop" }).click();
		await expect(panel.getByText("stopped")).toBeVisible();
		await panel.getByRole("button", { name: "Dispose…" }).click();
		await expect(panel.getByText(/Workspace changes cannot be recovered/)).toBeVisible();
		await captureEvidence(page, testInfo, "project-sandbox-dispose-desktop", { fullPage: true });
		await panel.getByRole("button", { name: "Dispose sandbox" }).click();
		await expect(panel.getByRole("alert")).toHaveText("Provider operation failed");
		await page.setViewportSize({ width: 390, height: 844 });
		await expect(panel.getByRole("button", { name: "Start" })).toBeVisible();
		const pageWidth = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth }));
		expect(pageWidth.scrollWidth).toBeLessThanOrEqual(pageWidth.viewportWidth);
		await captureEvidence(page, testInfo, "project-sandbox-mobile-error", { fullPage: true });
	});

	test("keeps ordinary path-empty project settings and sandbox creation available", async ({ page, mockApi }) => {
		const project = makeProject({ id: "global-project", name: "Global project", path: "" });
		await mockApi({ projects: [project] });
		await mockSandboxApi(page);
		await page.goto(`/project/${project.id}/settings`);
		await expect(page.getByPlaceholder("/app/web/.ezcorp/projects/my-project")).toBeVisible();
		await expect(page.getByText("Feature Index", { exact: true })).toBeVisible();
		await expect(page.getByTestId("project-settings-integrations")).toBeVisible();
		await expect(page.getByTestId("project-sandbox-panel").getByRole("button", { name: /Local Podman/i })).toBeVisible();
	});
});
