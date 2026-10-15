import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

test("creates a new Incus source workspace and preserves uncertain import recovery @evidence", async ({ page, mockApi }, testInfo) => {
	const source = makeProject({ id: "source-project", name: "Source project" });
	await mockApi({ projects: [source] });
	await page.route("**/api/github/connection", (route) => route.fulfill({ json: { status: "connected", configured: true } }));
	await page.route("**/api/github/repositories", (route) => route.fulfill({ json: { repositories: [{ id: 42, fullName: "owner/private", defaultBranch: "main", private: true, accessStatus: "ready" }] } }));
	await page.route("**/api/sandboxes/providers", (route) => route.fulfill({ json: { providers: [] } }));
	await page.route("**/api/infrastructure/incus/management", (route) => route.fulfill({ json: { environments: [
		{ installationId: "incus", connectionId: "local", presetId: "small", label: "Private Incus", qualified: true },
		{ installationId: "incus", connectionId: "local", presetId: "blocked", label: "Unqualified Incus", qualified: false },
	], truncated: false } }));
	const requests: { body: unknown; key: string | undefined }[] = [];
	await page.route("**/api/github/sandboxes", (route) => {
		requests.push({ body: route.request().postDataJSON(), key: route.request().headers()["idempotency-key"] });
		return route.fulfill({ status: 202, json: { project: { id: "new-incus-project" }, import: { state: "working", importState: "unknown", repository: { id: 42, fullName: "owner/private", baseRef: "main", baseSha: "a".repeat(40) } } } });
	});
	await page.goto(`/project/${source.id}/settings`);
	await page.getByRole("button", { name: "Import a GitHub repository into a private sandbox" }).click();
	const importer = page.getByTestId("github-sandbox-import");
	await importer.getByLabel("Repository", { exact: true }).selectOption("42");
	await importer.getByLabel("Sandbox provider").selectOption("incus:incus:local:small");
	await expect(importer.getByRole("option", { name: "Unqualified Incus" })).toHaveCount(0);
	await expect(importer.getByText(/starts a new private Incus workspace/)).toBeVisible();
	await page.setViewportSize({ width: 390, height: 844 });
	await importer.evaluate((element) => element.scrollIntoView({ block: "center" }));
	await captureEvidence(page, testInfo, "personal-github-incus-source-mobile", { fullPage: true });
	await importer.getByRole("button", { name: "Create private sandbox & import" }).click();
	await expect(importer.getByRole("link", { name: "Inspect saved operation in Incus management" })).toHaveAttribute("href", "/extensions/incus-management");
	await expect(importer.getByLabel("Repository", { exact: true })).toBeDisabled();
	await captureEvidence(page, testInfo, "personal-github-incus-unknown-mobile", { fullPage: true });
	await importer.getByRole("button", { name: "Retry saved import" }).click();
	await expect.poll(() => requests.length).toBe(2);
	expect(requests[1]).toEqual(requests[0]);
	expect(requests[0]?.body).toEqual({ kind: "incus", name: "Sandbox for owner/private", installationId: "incus", connectionId: "local", presetId: "small", repositoryId: 42, baseRef: "main" });
	expect(requests[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
	await expect(page).toHaveURL(/\/project\/source-project\/settings/);
});

test("imports a selected repository into a private sandbox before opening chat @evidence", async ({ page, mockApi }, testInfo) => {
	const source = makeProject({ id: "source-project", name: "Source project" });
	const target = makeProject({ id: "private-project", name: "Private repository", path: "" });
	const provider = { installationId: "11111111-1111-4111-8111-111111111111", providerId: "local-podman", label: "Local Podman", ready: true };
	let ready = false;
	await mockApi({ projects: [source, target] });
	await page.route("**/api/github/connection", (route) => route.fulfill({ json: { status: "connected", configured: true } }));
	await page.route("**/api/github/repositories", (route) => route.fulfill({ json: { repositories: [{ id: 42, fullName: "owner/private", defaultBranch: "main", private: true, accessStatus: "ready" }] } }));
	await page.route("**/api/sandboxes/providers", (route) => route.fulfill({ json: { providers: [provider] } }));
	await page.route("**/api/projects/*/sandbox", (route) => {
		if (route.request().url().includes("source-project")) return route.fulfill({ status: 409, json: { code: "SANDBOX_NOT_CONFIGURED", error: "No sandbox" } });
		return route.fulfill({ json: { projectId: target.id, bindingId: "binding-1", state: ready ? "stopped" : "creating", privateOwnerOnly: true, initializationState: ready ? "ready" : "pending", privateConversationId: ready ? "owner-conversation" : null, provider, resource: ready ? { resourceId: "resource-1", observedState: "stopped", desiredState: "stopped", limits: {} } : null, operation: null } });
	});
	await page.route("**/api/github/sandboxes", (route) => {
		expect(route.request().postDataJSON()).toEqual({ name: "Sandbox for owner/private", providerInstallationId: provider.installationId, providerId: provider.providerId });
		expect(route.request().headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
		return route.fulfill({ status: 201, json: { project: target } });
	});
	await page.route("**/api/github/personal-prs/sandboxes/private-project/import", (route) => {
		expect(route.request().postDataJSON()).toMatchObject({ repositoryId: 42, baseRef: "release/1.x" });
		ready = true;
		return route.fulfill({ json: { state: "ready" } });
	});
	await page.goto(`/project/${target.id}/settings`);
	await expect(page.getByTestId("project-sandbox-panel").getByRole("link", { name: "Open chat" })).toHaveCount(0);
	await page.goto(`/project/${source.id}/settings`);
	await page.getByRole("button", { name: "Import a GitHub repository into a private sandbox" }).click();
	const importer = page.getByTestId("github-sandbox-import");
	await importer.getByLabel("Repository", { exact: true }).selectOption("42");
	await expect(importer.getByLabel("Base branch")).toHaveValue("main");
	await importer.getByLabel("Base branch").fill("release/1.x");
	await importer.getByLabel("Sandbox provider").selectOption(provider.installationId);
	await page.setViewportSize({ width: 390, height: 844 });
	await importer.evaluate((element) => element.scrollIntoView({ block: "center" }));
	await expect(importer.getByLabel("Base branch")).toBeInViewport();
	await expect(importer.getByRole("button", { name: "Create private sandbox & import" })).toBeInViewport();
	await captureEvidence(page, testInfo, "personal-github-import-mobile", { fullPage: true });
	await importer.getByRole("button", { name: "Create private sandbox & import" }).click();
	await expect(page).toHaveURL(/\/project\/private-project\/settings/);
	const readyPanel = page.getByTestId("project-sandbox-panel");
	const openChat = readyPanel.getByRole("link", { name: "Open chat" });
	await expect(openChat).toHaveAttribute("href", "/project/private-project/chat/owner-conversation");
	await readyPanel.evaluate((element) => element.scrollIntoView({ block: "center" }));
	await expect(openChat).toBeInViewport();
	await captureEvidence(page, testInfo, "personal-github-import-ready", { fullPage: true });
});

test("a connected account can enable its first repository @evidence", async ({ page, mockApi }, testInfo) => {
	let checks = 0;
	let enabled = false;
	await mockApi({ projects: [makeProject({ id: "source-project", name: "Source project" })] });
	await page.route("**/api/github/connection", (route) => route.fulfill({ json: {
		status: "connected", configured: true, authMode: "device", account: { id: 123, login: "owner" },
		installUrl: "https://github.com/apps/ezcorp-github-auth/installations/new",
	} }));
	await page.route("**/api/github/repositories", (route) => {
		checks++;
		if (checks === 2) return route.fulfill({ status: 503, json: { error: "Repository check unavailable" } });
		return route.fulfill({ json: { repositories: enabled ? [{ id: 42, fullName: "owner/private", defaultBranch: "main", private: true, accessStatus: "ready" }] : [] } });
	});
	await page.goto("/project/source-project/settings");
	await page.getByRole("button", { name: "Import a GitHub repository into a private sandbox" }).click();
	const importer = page.getByTestId("github-sandbox-import");
	await expect(importer.getByText("No enabled repositories are available.")).toBeVisible();
	const enableRepositories = importer.getByRole("link", { name: "Enable repositories on GitHub" });
	await expect(enableRepositories).toHaveAttribute("href", "https://github.com/apps/ezcorp-github-auth/installations/new");
	await importer.evaluate((element) => element.scrollIntoView({ block: "center" }));
	await expect(enableRepositories).toBeInViewport();
	await captureEvidence(page, testInfo, "personal-github-first-repository", { fullPage: true });
	await page.goto("/settings/github");
	await expect(page.getByRole("link", { name: "Enable repositories on GitHub" })).toHaveAttribute("href", "https://github.com/apps/ezcorp-github-auth/installations/new");
	await page.getByRole("button", { name: "Recheck repositories" }).click();
	await expect(page.getByRole("alert")).toHaveText("Repository check unavailable");
	await page.getByRole("button", { name: "Recheck repositories" }).click();
	await expect(page.getByText("No enabled repositories yet.")).toBeVisible();
	enabled = true;
	await page.getByRole("button", { name: "Recheck repositories" }).click();
	const enabledCount = page.getByText("1 enabled repository available.");
	await expect(enabledCount).toBeVisible();
	await page.getByRole("button", { name: "Recheck repositories" }).evaluate((element) => element.scrollIntoView({ block: "center" }));
	await expect(enabledCount).toBeInViewport();
	await captureEvidence(page, testInfo, "personal-github-repositories-rechecked");
	await page.goto("/project/source-project/settings");
	await page.getByRole("button", { name: "Import a GitHub repository into a private sandbox" }).click();
	await expect(page.getByTestId("github-sandbox-import").getByRole("option", { name: "owner/private" })).toHaveCount(1);
	expect(checks).toBe(5);
});
