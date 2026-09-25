import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/hydration.js";
import { captureEvidence } from "../fixtures/evidence.js";

// These journeys use a real authenticated admin and database, while route-stubbing Incus APIs.
// They prove the operator UI contract; live-host qualification remains a separate milestone.

const environment = {
	installationId: "11111111-1111-4111-8111-111111111111",
	releaseId: "22222222-2222-4222-8222-222222222222",
	releaseGeneration: 3,
	connectionId: "33333333-3333-4333-8333-333333333333",
	connectionRevision: 1,
	presetId: "incus-compose-v1",
	label: "Production Incus · Compose",
	profile: "persistent-web-compose.v1",
	qualified: false,
	limits: { memoryBytes: 4 * 1024 ** 3, cpuMillis: 2000, diskBytes: 20 * 1024 ** 3, pids: 1024 },
	qualificationState: "not_qualified",
	qualificationRunId: null,
	qualificationValidUntil: null,
	blockedReason: "Run live qualification before creating project sandboxes.",
	setupId: "setup-approved-1",
};

const project = { id: "project-a", name: "Payments API" };
const bindingId = "44444444-4444-4444-8444-444444444444";
const planDigest = "a".repeat(64);

function feature(state: string, operation: { id: string; kind: string; state: string; errorCode?: string | null } | null = null) {
	return {
		projectId: project.id,
		projectName: project.name,
		bindingId,
		installationId: environment.installationId,
		releaseId: environment.releaseId,
		connectionId: environment.connectionId,
		connectionRevision: environment.connectionRevision,
		generation: 1,
		presetId: environment.presetId,
		desiredState: state === "RUNNING" ? "RUNNING" : "STOPPED",
		observedState: state,
		operation,
	};
}

type FeatureFixture = ReturnType<typeof feature> & { tombstonedAt?: string | null; cleanupConfirmedAt?: string | null };

async function mockManagement(page: Page, options: { initiallyQualified?: boolean; initialFeature?: ReturnType<typeof feature>; loseFirstCreateResponse?: boolean; rejectFirstCreate?: boolean; holdApply?: boolean } = {}) {
	let qualified = options.initiallyQualified ?? false;
	let qualificationRunId: string | null = null;
	let currentFeature: FeatureFixture | null = options.initialFeature ?? null;
	let firstCreateLost = false;
	let preparedProject = false;
	const createKeys = new Set<string>();
	const createKeyAttempts: string[] = [];
	const actions: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
	let signalApplyStarted: (() => void) | undefined;
	let releaseApplyReply: (() => void) | undefined;
	const applyStarted = new Promise<void>(resolve => { signalApplyStarted = resolve; });
	const applyReply = new Promise<void>(resolve => { releaseApplyReply = resolve; });
	await page.route("**/api/infrastructure/incus/management", route => route.fulfill({ json: {
		environments: [{ ...environment, qualified, qualificationState: qualified ? "qualified" : environment.qualificationState,
			qualificationRunId,
			qualificationValidUntil: qualified ? "2027-01-01T00:00:00.000Z" : null, blockedReason: qualified ? null : environment.blockedReason }],
		projects: [project], features: currentFeature ? [currentFeature] : [], truncated: false,
	} }));
	const capacityPlan = { schemaVersion: 1, setupId: environment.setupId, installationId: environment.installationId,
		releaseId: environment.releaseId, releaseDigest: "release-digest", generation: environment.releaseGeneration,
		connectionId: environment.connectionId, connectionRevision: environment.connectionRevision, recipeDigest: "recipe-digest",
		setupPlanDigest: "setup-plan-digest", observation: { hostId: "host-1", availableMemoryBytes: 8 * 1024 ** 3,
			poolFreeBytes: 100 * 1024 ** 3, availablePids: 4096, cpuThreads: 8 },
		capacity: { allocatable: { memoryBytes: 4 * 1024 ** 3, cpuMillicores: 4000, diskBytes: 40 * 1024 ** 3, pids: 1024, executionSlots: 4 } },
		expiresAt: "2030-01-01T00:00:00.000Z", planDigest: "capacity-digest" };
	let capacityReceipt: Record<string, unknown> | null = null;
	await page.route("**/api/infrastructure/incus/capacity*", async route => {
		if (route.request().method() === "GET") return route.fulfill({ json: { receipt: capacityReceipt } });
		const body = route.request().postDataJSON() as Record<string, unknown>;
		actions.push({ endpoint: "capacity", body });
		if (body.action === "plan") return route.fulfill({ json: { plan: capacityPlan } });
		capacityReceipt = { plan: capacityPlan, appliedBy: "admin", appliedAt: "2026-09-25T00:00:00.000Z" };
		return route.fulfill({ json: { receipt: capacityReceipt } });
	});
	await page.route("**/api/infrastructure/incus/qualification", async route => {
		const body = route.request().postDataJSON() as Record<string, unknown>;
		actions.push({ endpoint: "qualification", body });
		qualified = true;
		qualificationRunId = String(body.operationId);
		return route.fulfill({ status: 202, json: { run: { runId: body.operationId, state: "AWAITING_RESTART" } } });
	});
	await page.route("**/api/infrastructure/incus/probe-fixtures", async route => {
		const body = route.request().postDataJSON() as Record<string, unknown>;
		actions.push({ endpoint: "probe-fixtures", body });
		if (body.action === "plan") return route.fulfill({ json: { plan: { operationId: body.operationId, digest: planDigest,
			scope: scopeFromEnvironment(), directory: "/srv/ezharness/incus-fixtures", profile: environment.profile,
			connectionRevision: environment.connectionRevision, providerGeneration: environment.releaseGeneration,
			config: { unqualifiedPresetId: "persistent-web-compose.unqualified.v1", cases: {
				unsupported: { projectId: "project-unsupported", bindingId: "binding-unsupported", canaryPath: "/work/.ezharness/canary-unsupported" },
				missingControl: { projectId: "project-missing-control", bindingId: "binding-missing-control", canaryPath: "/work/.ezharness/canary-missing-control" },
				drift: { projectId: "project-drift", bindingId: "binding-drift", canaryPath: "/work/.ezharness/canary-drift" },
				unqualified: { projectId: "project-unqualified", bindingId: "binding-unqualified", canaryPath: "/work/.ezharness/canary-unqualified" },
			} } } } });
		if (body.action === "apply") {
			if (options.holdApply) { signalApplyStarted?.(); await applyReply; }
			return route.fulfill({ json: { receipt: { state: "ready", planDigest } } });
		}
		if (body.action === "status") return route.fulfill({ json: { state: "ready", receipt: { state: "ready", planDigest } } });
		return route.fulfill({ json: { receipt: { state: "cleaned", planDigest } } });
	});
	await page.route("**/api/infrastructure/incus/features", async route => {
		const body = route.request().postDataJSON() as Record<string, unknown>;
		actions.push({ endpoint: "features", body });
		if (body.action === "prepareProject") {
			preparedProject = true;
			return route.fulfill({ json: { project: { id: project.id, name: body.name }, binding: { id: bindingId } } });
		}
		if (body.action === "create") {
			if (!preparedProject) return route.fulfill({ status: 409, json: { error: "Project is not prepared" } });
			const key = String(body.idempotencyKey);
			createKeys.add(key);
			createKeyAttempts.push(key);
			if (options.rejectFirstCreate && !firstCreateLost) {
				firstCreateLost = true;
				currentFeature = feature("ABSENT", { id: "op-create-rejected", kind: "CREATE", state: "REJECTED" });
				return route.fulfill({ status: 409, json: { state: "REJECTED", reason: "The environment has no free capacity." } });
			}
			currentFeature = options.loseFirstCreateResponse && !firstCreateLost
				? feature("UNKNOWN", { id: "op-create", kind: "CREATE", state: "OUTCOME_UNKNOWN" })
				: feature("STOPPED", { id: "op-create", kind: "CREATE", state: "SUCCEEDED" });
			if (options.loseFirstCreateResponse && !firstCreateLost) {
				firstCreateLost = true;
				return route.abort("failed");
			}
		}
		if (body.action === "start") currentFeature = feature("RUNNING", { id: "op-start", kind: "START", state: "SUCCEEDED" });
		if (body.action === "stop") currentFeature = feature("STOPPED", { id: "op-stop", kind: "STOP", state: "SUCCEEDED" });
		if (body.action === "destroy") currentFeature = { ...feature("ABSENT", { id: "op-destroy", kind: "DESTROY", state: "SUCCEEDED" }), tombstonedAt: "2026-09-25T12:00:00Z", cleanupConfirmedAt: "2026-09-25T12:00:01Z" };
		if (body.action === "status") return route.fulfill({ json: { binding: currentFeature, operation: currentFeature?.operation ?? null } });
		return route.fulfill({ status: 202, json: { state: "DISPATCHED", operation: currentFeature?.operation } });
	});
	return { actions, createKeys, createKeyAttempts, applyStarted, releaseApplyReply: () => releaseApplyReply?.() };
}

test("qualifies an environment, creates a project sandbox, and manages its lifecycle @evidence", async ({ page }, testInfo) => {
	const { actions } = await mockManagement(page);
	await page.goto("/extensions");
	await expect(page.getByRole("link", { name: "Manage sandboxes" })).toBeVisible();
	await captureEvidence(page, testInfo, "incus-management-extension-entry", { fullPage: true });
	await page.getByRole("link", { name: "Manage sandboxes" }).click();
	await expect(page.getByRole("heading", { name: "Incus sandboxes" })).toBeVisible();
	await page.getByRole("link", { name: "Server setup" }).click();
	await expect(page.getByRole("heading", { name: "Connect an Incus server" })).toBeVisible();
	await captureEvidence(page, testInfo, "incus-management-setup-entry", { fullPage: true });
	await page.getByRole("link", { name: /Manage qualified environments/ }).click();
	await expect(page.getByRole("heading", { name: "Incus sandboxes" })).toBeVisible();
	await expect(page.getByTestId("incus-capacity-panel")).toBeVisible();
	await page.getByRole("button", { name: "Plan capacity" }).click();
	await expect(page.getByText("capacity-digest", { exact: true })).toBeVisible();
	await page.getByRole("checkbox", { name: /reviewed these host limits/ }).check();
	await page.getByRole("button", { name: "Apply reviewed capacity" }).click();
	await expect(page.getByText("Capacity is saved for this verified setup.")).toBeVisible();
	await expect(page.locator(".environment-card .pill").filter({ hasText: "Not qualified" })).toBeVisible();
	await page.getByRole("button", { name: "Prepare qualification…" }).click();
	await expect(page.getByTestId("qualification-workflow")).toContainText(planDigest);
	await expect(page.getByTestId("qualification-workflow")).toContainText("/srv/ezharness/incus-fixtures");
	await expect(page.getByTestId("qualification-workflow")).toContainText("project-unsupported");
	await page.getByRole("checkbox", { name: /I reviewed this plan/ }).check();
	await captureEvidence(page, testInfo, "incus-management-qualification-confirmation", { fullPage: true });
	await page.getByRole("button", { name: "Apply reviewed fixture plan" }).click();
	await expect(page.getByTestId("qualification-workflow").getByText("Operator fixtures are ready", { exact: true })).toBeVisible();
	await page.getByRole("checkbox", { name: /host is ready for a live sandbox qualification/ }).check();
	await page.getByRole("button", { name: "Run live qualification" }).click();
	await expect(page.locator(".management-shell > .alert.notice")).toContainText("Qualification started");
	await expect(page.getByText("Qualified", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Create project sandbox" })).toBeEnabled();
	await page.getByRole("textbox", { name: "New project name" }).fill(project.name);
	await page.getByRole("button", { name: "Create project sandbox" }).click();
	await expect(page.getByRole("heading", { name: "Payments API" })).toBeVisible();
	await expect(page.getByText("stopped observed", { exact: false })).toBeVisible();
	await captureEvidence(page, testInfo, "incus-management-project-sandbox", { fullPage: true });
	await page.getByRole("button", { name: "Start", exact: true }).click();
	await expect(page.getByText("running observed", { exact: false })).toBeVisible();
	await expect(page.getByRole("link", { name: "Open chat" })).toHaveAttribute("href", `/project/${project.id}`);
	await page.getByRole("button", { name: "Stop", exact: true }).click();
	await expect(page.getByText("stopped observed", { exact: false })).toBeVisible();
	await page.getByRole("button", { name: "Dispose…" }).click();
	await expect(page.getByRole("group", { name: "Confirm disposal of Payments API" })).toContainText("permanently removes its workspace data");
	await page.getByRole("button", { name: "Dispose sandbox" }).click();
	await expect(page.getByText("Disposed", { exact: true })).toBeVisible();
	await expect(page.getByRole("status")).toContainText("Sandbox disposal was requested");
	await page.getByRole("button", { name: "Remove qualification fixtures" }).click();
	await expect(page.getByRole("status")).toContainText("Temporary operator fixtures were removed");

	const qualification = actions.find(item => item.endpoint === "qualification")?.body;
	expect(qualification).toMatchObject({ action: "qualify", ...scopeFromEnvironment() });
	expect(qualification?.operationId).toMatch(/^[0-9a-f-]{36}$/);
	expect(actions.filter(item => item.endpoint !== "capacity").map(item => item.body.action)).toEqual(["plan", "apply", "qualify", "prepareProject", "create", "start", "stop", "destroy", "cleanup"]);
	const fixtureOperationIds = actions.filter(item => item.endpoint === "probe-fixtures" && item.body.action !== "cleanup").map(item => item.body.operationId);
	expect(new Set(fixtureOperationIds).size).toBe(1);
	expect(actions.find(item => item.body.action === "qualify")?.body.operationId).toBe(fixtureOperationIds[0]);
	const prepare = actions.find(item => item.body.action === "prepareProject")?.body;
	expect(prepare).toMatchObject({ action: "prepareProject", name: project.name, installationId: environment.installationId,
		connectionId: environment.connectionId, presetId: environment.presetId });
	expect(prepare?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
	for (const mutation of actions.filter(item => ["create", "start", "stop", "destroy"].includes(String(item.body.action)))) {
		expect(mutation.body).toMatchObject({ projectId: project.id, bindingId, idempotencyScope: "incus-management-ui" });
		expect(mutation.body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
	}
});

test("a lost create reply resumes with the same operation key after reload", async ({ page }) => {
	const { createKeys } = await mockManagement(page, { initiallyQualified: true, loseFirstCreateResponse: true });
	await page.goto("/extensions/incus-management");
	await page.getByRole("textbox", { name: "New project name" }).fill(project.name);
	await page.getByRole("button", { name: "Create project sandbox" }).click();
	await expect(page.getByRole("alert")).toContainText("same project and operation keys");
	await expect(page.locator(".feature-card")).toHaveCount(1);
	await expect(page.locator(".feature-card").getByText("Needs reconciliation")).toBeVisible();
	await page.reload();
	await expect(page.getByRole("button", { name: "Create project sandbox" })).toBeEnabled();
	await page.getByRole("button", { name: "Create project sandbox" }).click();
	await expect(page.locator(".feature-card")).toHaveCount(1);
	await expect(page.locator(".feature-card").getByText("stopped observed", { exact: false })).toBeVisible();
	await expect.poll(() => createKeys.size).toBe(1);
});

test("reload during fixture apply preserves its operation and requires saved status", async ({ page }) => {
	const { actions, applyStarted, releaseApplyReply } = await mockManagement(page, { holdApply: true });
	await page.goto("/extensions/incus-management");
	await page.getByRole("button", { name: "Prepare qualification…" }).click();
	await expect(page.getByTestId("qualification-workflow")).toContainText("project-unsupported");
	await page.getByRole("checkbox", { name: /I reviewed this plan/ }).check();
	void page.getByRole("button", { name: "Apply reviewed fixture plan" }).click();
	await applyStarted;
	const planRequest = actions.find(item => item.body.action === "plan")?.body;
	await page.reload();
	await expect(page.getByRole("button", { name: "Remove fixtures" })).toBeVisible();
	await expect(page.getByTestId("qualification-workflow")).toContainText("Operator fixtures are ready");
	await expect(page.getByRole("button", { name: "Prepare qualification…" })).toHaveCount(0);
	const applyRequest = actions.find(item => item.body.action === "apply")?.body;
	const statusRequest = actions.find(item => item.body.action === "status")?.body;
	expect(applyRequest).toMatchObject({ operationId: planRequest?.operationId, planDigest });
	expect(statusRequest).toMatchObject({ operationId: planRequest?.operationId });
	releaseApplyReply();
});

test("a proven create rejection retries with a fresh key", async ({ page }) => {
	const { createKeys, createKeyAttempts } = await mockManagement(page, { initiallyQualified: true, rejectFirstCreate: true });
	await page.goto("/extensions/incus-management");
	await page.getByRole("textbox", { name: "New project name" }).fill(project.name);
	await page.getByRole("button", { name: "Create project sandbox" }).click();
	await expect(page.getByRole("alert")).toContainText("no free capacity");
	await page.getByRole("button", { name: "Create project sandbox" }).click();
	await expect(page.locator(".feature-card").getByText("stopped observed", { exact: false })).toBeVisible();
	await expect.poll(() => createKeyAttempts.length).toBe(2);
	expect(createKeys.size).toBe(2);
	expect(createKeyAttempts[0]).not.toBe(createKeyAttempts[1]);
});

test("a pending stop hides chat until the saved desired state is safe", async ({ page }) => {
	const pendingStop = { ...feature("RUNNING", { id: "op-stop", kind: "STOP", state: "PROVIDER_PENDING" }), desiredState: "STOPPED" };
	await mockManagement(page, { initiallyQualified: true, initialFeature: pendingStop });
	await page.goto("/extensions/incus-management");
	const card = page.locator(".feature-card");
	await expect(card.getByText("Waiting for provider")).toBeVisible();
	await expect(card.getByRole("link", { name: "Open chat" })).toHaveCount(0);
	await expect(card.getByRole("button", { name: "Stop" })).toHaveCount(0);
});

test("unknown provider outcomes block lifecycle actions until reconciliation", async ({ page }, testInfo) => {
	await mockManagement(page, { initiallyQualified: true,
		initialFeature: feature("UNKNOWN", { id: "op-unknown", kind: "CREATE", state: "OUTCOME_UNKNOWN", errorCode: "PROVIDER_OUTCOME_UNKNOWN" }) });
	await page.goto("/extensions/incus-management");
	const card = page.locator(".feature-card");
	await expect(card.getByText("Needs reconciliation")).toBeVisible();
	await expect(card.getByRole("button", { name: "Start" })).toHaveCount(0);
	await expect(card.getByRole("link", { name: "Open chat" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Reconcile pending work" })).toBeVisible();
	await captureEvidence(page, testInfo, "incus-management-unknown-outcome", { fullPage: true });
});

function scopeFromEnvironment() {
	return { installationId: environment.installationId, releaseId: environment.releaseId,
		connectionId: environment.connectionId, presetId: environment.presetId };
}
