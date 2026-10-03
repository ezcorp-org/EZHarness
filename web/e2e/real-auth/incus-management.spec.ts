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

function feature(state: string, operation: { id: string; kind: string; state: string; errorCode?: string | null; providerOperationRecorded?: boolean } | null = null) {
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

type FeatureFixture = ReturnType<typeof feature> & { tombstonedAt?: string | null; cleanupConfirmedAt?: string | null;
	cleanupRecovery?: { id: string; state: string; failedDestroyOperationId: string; stopOperationId: string; destroyOperationId: string } | null };

async function mockManagement(page: Page, options: { initiallyQualified?: boolean; initialFeature?: ReturnType<typeof feature>; loseFirstCreateResponse?: boolean; rejectFirstCreate?: boolean; holdApply?: boolean; preparedProject?: { id: string; name: string }; preparedBindingId?: string } = {}) {
	let qualified = options.initiallyQualified ?? false;
	let qualificationRunId: string | null = null;
	const selectedProject = options.preparedProject ?? project;
	const selectedBindingId = options.preparedBindingId ?? bindingId;
	const selectedFeature = (state: string, operation: Parameters<typeof feature>[1]) => ({ ...feature(state, operation),
		projectId: selectedProject.id, projectName: selectedProject.name, bindingId: selectedBindingId });
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
		projects: [selectedProject], features: currentFeature ? [currentFeature] : [], truncated: false,
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
			return route.fulfill({ json: { project: { id: selectedProject.id, name: body.name }, binding: { id: selectedBindingId } } });
		}
		if (body.action === "create") {
			if (!preparedProject) return route.fulfill({ status: 409, json: { error: "Project is not prepared" } });
			const key = String(body.idempotencyKey);
			createKeys.add(key);
			createKeyAttempts.push(key);
			if (options.rejectFirstCreate && !firstCreateLost) {
				firstCreateLost = true;
				currentFeature = selectedFeature("ABSENT", { id: "op-create-rejected", kind: "CREATE", state: "REJECTED" });
				return route.fulfill({ status: 409, json: { state: "REJECTED", reason: "The environment has no free capacity." } });
			}
			currentFeature = options.loseFirstCreateResponse && !firstCreateLost
				? selectedFeature("UNKNOWN", { id: "op-create", kind: "CREATE", state: "OUTCOME_UNKNOWN" })
				: selectedFeature("STOPPED", { id: "op-create", kind: "CREATE", state: "SUCCEEDED" });
			if (options.loseFirstCreateResponse && !firstCreateLost) {
				firstCreateLost = true;
				return route.abort("failed");
			}
		}
		if (body.action === "start") currentFeature = selectedFeature("RUNNING", { id: "op-start", kind: "START", state: "SUCCEEDED" });
		if (body.action === "stop") currentFeature = selectedFeature("STOPPED", { id: "op-stop", kind: "STOP", state: "SUCCEEDED" });
		if (body.action === "destroy") currentFeature = { ...selectedFeature("ABSENT", { id: "op-destroy", kind: "DESTROY", state: "SUCCEEDED" }), tombstonedAt: "2026-09-25T12:00:00Z", cleanupConfirmedAt: "2026-09-25T12:00:01Z" };
		if (body.action === "status") return route.fulfill({ json: { binding: currentFeature, operation: currentFeature?.operation ?? null } });
		return route.fulfill({ status: 202, json: { state: "DISPATCHED", operation: currentFeature?.operation } });
	});
	return { actions, createKeys, createKeyAttempts, applyStarted, releaseApplyReply: () => releaseApplyReply?.(),
		setFeature: (value: FeatureFixture) => { currentFeature = value; } };
}

async function savedKey(page: Page, suffix: string): Promise<string> {
	const key = await page.evaluate(ending => Object.keys(localStorage).find(item => item.endsWith(`:${ending}`)), suffix);
	expect(key).toBeDefined();
	return key!;
}

test("the feature API rejects inherited action names for an authenticated operator", async ({ page }) => {
	await page.goto("/extensions");
	for (const action of ["constructor", "toString", "__proto__"]) {
		const result = await page.evaluate(async value => {
			const response = await fetch("/api/infrastructure/incus/features", {
				method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: value }),
			});
			return { status: response.status, body: await response.json() };
		}, action);
		expect(result).toMatchObject({ status: 400, body: { code: "invalid_input" } });
	}
});

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
	await expect(page.getByTestId("qualification-workflow")).toContainText("Qualification passed");
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
	await expect(page.getByRole("status").filter({ hasText: "Sandbox disposal was requested" })).toBeVisible();
	await page.getByRole("button", { name: "Remove qualification fixtures" }).click();
	await expect(page.getByRole("status").filter({ hasText: "Temporary operator fixtures were removed" })).toBeVisible();

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

test("running disposal requires Stop and a saved stopped result @evidence", async ({ page }, testInfo) => {
	const { actions } = await mockManagement(page, { initiallyQualified: true,
		initialFeature: feature("RUNNING", { id: "op-start", kind: "START", state: "SUCCEEDED" }) });
	await page.goto("/extensions/incus-management");
	const card = page.locator(".feature-card");
	await expect(card.getByText("Stop this sandbox before disposal.")).toBeVisible();
	await expect(card.getByRole("button", { name: "Dispose…" })).toBeDisabled();
	expect(actions.some(item => item.body.action === "destroy")).toBe(false);
	await card.scrollIntoViewIfNeeded();
	await captureEvidence(page, testInfo, "incus-management-stop-before-dispose", { fullPage: true });
	await card.getByRole("button", { name: "Stop", exact: true }).click();
	await expect(card.getByText("stopped", { exact: true })).toBeVisible();
	await card.getByRole("button", { name: "Dispose…" }).click();
	await card.getByRole("button", { name: "Dispose sandbox" }).click();
	await expect(card.getByText("Disposed", { exact: true })).toBeVisible();
	expect(actions.filter(item => ["stop", "destroy"].includes(String(item.body.action))).map(item => item.body.action)).toEqual(["stop", "destroy"]);
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

test("failed cleanup recovery requires review and keeps exact saved operation IDs @evidence", async ({ page }, testInfo) => {
	const failedId = "55555555-5555-4555-8555-555555555555";
	const failed = { ...feature("RUNNING", { id: failedId, kind: "DESTROY", state: "FAILED",
		errorCode: "REVISION_CONFLICT", providerOperationRecorded: false }), tombstonedAt: "2026-10-03T12:00:00Z" };
	const { setFeature } = await mockManagement(page, { initiallyQualified: true, initialFeature: failed });
	const requests: Record<string, unknown>[] = [];
	const recovery = { id: "recovery-1", state: "STOP_REQUIRED", failedDestroyOperationId: failedId,
		stopOperationId: "stop-recovery-1", destroyOperationId: "destroy-recovery-1" };
	await page.route("**/api/infrastructure/incus/features", async route => {
		const body = route.request().postDataJSON() as Record<string, unknown>;
		requests.push(body);
		if (body.action !== "recoverCleanup") return route.fulfill({ status: 409, json: { code: "stop_required" } });
		if (requests.length === 1) setFeature({ ...failed, observedState: "STOPPED", operation: { id: recovery.stopOperationId,
			kind: "STOP", state: "SUCCEEDED" }, cleanupRecovery: recovery });
		else setFeature({ ...failed, observedState: "ABSENT", operation: { id: recovery.destroyOperationId,
			kind: "DESTROY", state: "SUCCEEDED" }, cleanupConfirmedAt: "2026-10-03T12:01:00Z",
			cleanupRecovery: { ...recovery, state: "COMPLETED" } });
		return route.fulfill({ status: 202, json: { recovery, operation: {} } });
	});
	await page.goto("/extensions/incus-management");
	const card = page.locator(".feature-card");
	await expect(card.getByRole("button", { name: "Retry cleanup" })).toHaveCount(0);
	await card.getByRole("button", { name: "Review cleanup recovery…" }).click();
	const confirmation = card.getByRole("group", { name: "Confirm cleanup recovery of Payments API" });
	await expect(confirmation).toContainText(failedId);
	await expect(confirmation).toContainText("Stop first, then dispose");
	expect(requests).toHaveLength(0);
	await captureEvidence(page, testInfo, "incus-management-saved-cleanup-recovery", { fullPage: true });
	await confirmation.getByRole("button", { name: "Recover cleanup", exact: true }).click();
	await expect(card.getByText(`Saved cleanup recovery: ${recovery.id}`)).toBeVisible();
	await page.reload();
	await expect(card.getByText(`Saved cleanup recovery: ${recovery.id}`)).toBeVisible();
	expect(requests).toHaveLength(1);
	await card.getByRole("button", { name: "Review cleanup recovery…" }).click();
	await card.getByRole("button", { name: "Recover cleanup", exact: true }).click();
	await expect(card.getByText("Disposed", { exact: true })).toBeVisible();
	expect(requests).toEqual(Array.from({ length: 2 }, () => ({ action: "recoverCleanup", projectId: project.id,
		bindingId, failedDestroyOperationId: failedId })));
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
	await page.route("**/api/infrastructure/incus/features", route => route.fulfill({ status: 503, json: {} }));
	await page.getByRole("button", { name: "Reconcile pending work" }).click();
	await expect(page.getByRole("alert")).toContainText("Request failed (503)");
	await expect(card.getByText("Needs reconciliation")).toBeVisible();
	await expect(card.getByRole("button", { name: "Start" })).toHaveCount(0);
});

test("a failed environment refresh keeps the last approved view available", async ({ page }) => {
	await mockManagement(page, { initiallyQualified: true });
	await page.goto("/extensions/incus-management");
	await expect(page.getByRole("heading", { name: environment.label })).toBeVisible();
	await page.route("**/api/infrastructure/incus/management", route => route.fulfill({ status: 503, json: { message: "Environment service is temporarily unavailable" } }));
	await page.getByRole("button", { name: "Refresh", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("Environment service is temporarily unavailable");
	await expect(page.getByRole("heading", { name: environment.label })).toBeVisible();
});

test("an invalid fixture plan cannot be reviewed or applied", async ({ page }) => {
	await mockManagement(page);
	let applyAttempts = 0;
	await page.route("**/api/infrastructure/incus/probe-fixtures", route => {
		if ((route.request().postDataJSON() as { action: string }).action === "apply") applyAttempts++;
		return route.fulfill({ json: { plan: { digest: "invalid" } } });
	});
	await page.goto("/extensions/incus-management");
	await page.getByRole("button", { name: "Prepare qualification…" }).click();
	await expect(page.getByRole("alert")).toContainText("valid review digest");
	await expect(page.getByTestId("qualification-workflow")).toHaveCount(0);
	expect(applyAttempts).toBe(0);
});

test("a changed saved fixture plan blocks review after reload", async ({ page }) => {
	const { actions } = await mockManagement(page);
	await page.goto("/extensions/incus-management");
	await page.getByRole("button", { name: "Prepare qualification…" }).click();
	await expect(page.getByTestId("qualification-workflow")).toContainText(planDigest);
	await page.route("**/api/infrastructure/incus/probe-fixtures", async route => {
		const body = route.request().postDataJSON() as { action: string };
		if (body.action === "plan") return route.fulfill({ json: { plan: { digest: "b".repeat(64) } } });
		return route.fallback();
	});
	await page.reload();
	await expect(page.getByRole("alert")).toContainText("saved fixture plan changed");
	await expect(page.getByTestId("qualification-workflow")).toContainText("saved plan details are loading");
	await expect(page.getByRole("button", { name: "Apply reviewed fixture plan" })).toBeDisabled();
	expect(actions.filter(item => item.endpoint === "probe-fixtures" && item.body.action === "apply")).toHaveLength(0);
});

test("an uncertain fixture apply checks saved status before another action", async ({ page }) => {
	const { actions } = await mockManagement(page);
	let statusChecks = 0;
	let applyAttempts = 0;
	await page.route("**/api/infrastructure/incus/probe-fixtures", async route => {
		const body = route.request().postDataJSON() as { action: string };
		if (body.action === "apply") { applyAttempts++; return route.abort("failed"); }
		if (body.action === "status") {
			statusChecks++;
			if (statusChecks === 1) return route.fulfill({ status: 503, json: { message: "Fixture status service is unavailable" } });
			return route.fulfill({ json: { state: statusChecks === 2 ? "incomplete" : "absent" } });
		}
		return route.fallback();
	});
	await page.goto("/extensions/incus-management");
	await page.getByRole("button", { name: "Prepare qualification…" }).click();
	await page.getByRole("checkbox", { name: /I reviewed this plan/ }).check();
	await page.getByRole("button", { name: "Apply reviewed fixture plan" }).click();
	await expect(page.getByRole("alert")).toContainText("Fixture status service is unavailable");
	await expect(page.getByRole("button", { name: "Retry same apply" })).toHaveCount(0);
	await page.getByRole("button", { name: "Check fixture status" }).click();
	await expect(page.getByRole("alert")).toContainText("Fixture status is incomplete");
	await expect(page.getByRole("button", { name: "Retry same apply" })).toHaveCount(0);
	await page.getByRole("button", { name: "Check fixture status" }).click();
	await expect(page.getByRole("status").filter({ hasText: "No fixture plan is saved yet" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Retry same apply" })).toBeVisible();
	expect(actions.filter(item => item.endpoint === "probe-fixtures" && item.body.action === "plan")).toHaveLength(1);
	expect(applyAttempts).toBe(1);
	expect(statusChecks).toBe(3);
});

test("unconfirmed cleanup keeps the qualification workflow for review", async ({ page }) => {
	await mockManagement(page);
	const cleanupRequests: Array<Record<string, unknown>> = [];
	await page.route("**/api/infrastructure/incus/probe-fixtures", async route => {
		const body = route.request().postDataJSON() as Record<string, unknown>;
		if (body.action === "cleanup") {
			cleanupRequests.push(body);
			return route.fulfill({ json: { receipt: { state: "pending", planDigest } } });
		}
		return route.fallback();
	});
	await page.goto("/extensions/incus-management");
	await page.getByRole("button", { name: "Prepare qualification…" }).click();
	await page.getByRole("checkbox", { name: /I reviewed this plan/ }).check();
	await page.getByRole("button", { name: "Apply reviewed fixture plan" }).click();
	await expect(page.getByText("Operator fixtures are ready", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Remove fixtures" }).click();
	await expect(page.getByRole("alert")).toContainText("Cleanup was not confirmed");
	await expect(page.getByText("Operator fixtures are ready", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Remove fixtures" })).toBeEnabled();
	expect(cleanupRequests).toEqual([{ action: "cleanup", ...scopeFromEnvironment(), operationId: expect.any(String), planDigest }]);
});

test("a saved plan reloads with its original operation before review", async ({ page }) => {
	const { actions } = await mockManagement(page);
	await page.goto("/extensions/incus-management");
	await page.getByRole("button", { name: "Prepare qualification…" }).click();
	await expect(page.getByTestId("qualification-workflow")).toContainText(planDigest);
	await expect(page.getByRole("button", { name: "Prepare qualification…" })).toHaveCount(0);
	expect(actions.filter(item => item.endpoint === "probe-fixtures" && item.body.action === "plan")).toHaveLength(1);
	await page.reload();
	await expect(page.getByTestId("qualification-workflow")).toContainText("project-unsupported");
	await expect(page.getByRole("button", { name: "Apply reviewed fixture plan" })).toBeDisabled();
	const plans = actions.filter(item => item.endpoint === "probe-fixtures" && item.body.action === "plan");
	expect(plans).toHaveLength(2);
	expect(plans[1]?.body.operationId).toBe(plans[0]?.body.operationId);
});

for (const reply of ["lost", "preserved"] as const) {
	test(`a ${reply} qualification reply leaves the saved run available for status review`, async ({ page }) => {
		const { actions } = await mockManagement(page);
		let qualificationAttempts = 0;
		const savedOperationId = "55555555-5555-4555-8555-555555555555";
		await page.route("**/api/infrastructure/incus/qualification", route => {
			qualificationAttempts++;
			if (reply === "lost") return route.abort("failed");
			return route.fulfill({ status: 409, json: { code: "qualification_operation_preserved",
				operation: { id: savedOperationId, state: "OUTCOME_UNKNOWN" }, reason: "outcome_unsettled",
				message: `Saved operation ${savedOperationId} is OUTCOME_UNKNOWN and must be reviewed. Do not retry qualification or repeat the mutation. Check its saved status first.` } });
		});
		await page.goto("/extensions/incus-management");
		await page.getByRole("button", { name: "Prepare qualification…" }).click();
		await page.getByRole("checkbox", { name: /I reviewed this plan/ }).check();
		await page.getByRole("button", { name: "Apply reviewed fixture plan" }).click();
		await page.getByRole("checkbox", { name: /host is ready for a live sandbox qualification/ }).check();
		await page.getByRole("button", { name: "Run live qualification" }).click();
		await expect(page.getByRole("alert")).toContainText("Check the saved qualification status before you retry");
		await expect(page.getByTestId("qualification-workflow")).toContainText("Qualification status is being checked");
		await expect(page.getByRole("button", { name: "Check saved status" })).toBeVisible();
		if (reply === "preserved") {
			await expect(page.getByRole("alert")).toContainText(savedOperationId);
			await expect(page.getByRole("alert")).toContainText("OUTCOME_UNKNOWN");
			await expect(page.getByRole("alert")).toContainText("Do not retry qualification or repeat the mutation");
			await expect(page.getByRole("button", { name: "Run live qualification" })).toHaveCount(0);
		}
		expect(qualificationAttempts).toBe(1);
		expect(actions.filter(item => item.endpoint === "probe-fixtures" && item.body.action === "cleanup")).toHaveLength(0);
	});
}

test("damaged qualification and retry-key records do not start another host plan", async ({ page }) => {
	const { actions } = await mockManagement(page, { initialFeature: feature("STOPPED") });
	await page.goto("/extensions/incus-management");
	await page.getByRole("button", { name: "Prepare qualification…" }).click();
	await expect(page.getByTestId("qualification-workflow")).toContainText(planDigest);
	const qualificationKey = await savedKey(page, "qualification-draft");
	await page.getByRole("button", { name: "Start", exact: true }).click();
	const mutationKey = await savedKey(page, "mutation-keys");
	await page.evaluate(storageKey => localStorage.setItem(storageKey, JSON.stringify({ valid: "11111111-1111-4111-8111-111111111111", damaged: "not-a-key" })), mutationKey);
	await page.reload();
	await expect(page.getByRole("heading", { name: project.name })).toBeVisible();
	const planAttemptsBeforeCorruption = actions.filter(item => item.endpoint === "probe-fixtures" && item.body.action === "plan").length;
	await page.evaluate(({ qualificationKey, mutationKey }) => {
		localStorage.setItem(qualificationKey, "{");
		localStorage.setItem(mutationKey, "{");
	}, { qualificationKey, mutationKey });
	await page.reload();
	await expect(page.getByRole("alert")).toContainText("saved qualification draft could not be read");
	await expect(page.getByRole("button", { name: "Prepare qualification…" })).toBeDisabled();
	await expect(page.getByRole("heading", { name: project.name })).toBeVisible();
	expect(actions.filter(item => item.endpoint === "probe-fixtures" && item.body.action === "plan")).toHaveLength(planAttemptsBeforeCorruption);
});

test("a damaged project request stays blocked until an administrator checks it", async ({ page }) => {
	const { createKeyAttempts } = await mockManagement(page, { initiallyQualified: true, loseFirstCreateResponse: true });
	await page.goto("/extensions/incus-management");
	await page.getByRole("textbox", { name: "New project name" }).fill(project.name);
	await page.getByRole("button", { name: "Create project sandbox" }).click();
	await expect(page.getByRole("alert")).toContainText("same project and operation keys");
	const key = await savedKey(page, "project-draft");
	await page.evaluate(storageKey => localStorage.setItem(storageKey, "{"), key);
	await page.reload();
	await expect(page.getByRole("alert")).toContainText("saved project sandbox request could not be read");
	await expect(page.getByRole("button", { name: "Create project sandbox" })).toBeDisabled();
	expect(createKeyAttempts).toHaveLength(1);
});

test("an old unsaved qualification run returns to a safe retry with the same ID", async ({ page }) => {
	const { actions } = await mockManagement(page);
	await page.goto("/extensions/incus-management");
	await page.getByRole("button", { name: "Prepare qualification…" }).click();
	await page.getByRole("checkbox", { name: /I reviewed this plan/ }).check();
	await page.getByRole("button", { name: "Apply reviewed fixture plan" }).click();
	await expect(page.getByTestId("qualification-workflow")).toContainText("Operator fixtures are ready");
	const key = await savedKey(page, "qualification-draft");
	await page.evaluate(storageKey => {
		const draft = JSON.parse(localStorage.getItem(storageKey)!);
		localStorage.setItem(storageKey, JSON.stringify({ ...draft, phase: "running", startedAt: Date.now() - 60_000 }));
	}, key);
	await page.reload();
	await expect(page.getByRole("status").filter({ hasText: "No saved run matches this qualification request" })).toBeVisible();
	await expect(page.getByTestId("qualification-workflow")).toContainText("Operator fixtures are ready");
	await expect(page.getByRole("button", { name: "Run live qualification" })).toBeDisabled();
	await page.getByRole("checkbox", { name: /host is ready for a live sandbox qualification/ }).check();
	await page.getByRole("button", { name: "Run live qualification" }).click();
	const plan = actions.find(item => item.endpoint === "probe-fixtures" && item.body.action === "plan")?.body;
	expect(plan?.operationId).toMatch(/^[0-9a-f-]{36}$/);
	await expect.poll(() => actions.filter(item => item.endpoint === "qualification").map(item => item.body.operationId)).toEqual([plan?.operationId]);
});

test("a pending stop refreshes automatically when the provider settles", async ({ page }) => {
	const pendingStop = { ...feature("RUNNING", { id: "op-stop", kind: "STOP", state: "PROVIDER_PENDING" }), desiredState: "STOPPED" };
	await mockManagement(page, { initiallyQualified: true, initialFeature: pendingStop });
	await page.goto("/extensions/incus-management");
	const card = page.locator(".feature-card");
	await expect(card.getByText("Waiting for provider")).toBeVisible();
	await page.route("**/api/infrastructure/incus/management", route => route.fulfill({ json: {
		environments: [{ ...environment, qualified: true, qualificationState: "qualified" }],
		projects: [project], features: [feature("STOPPED", { id: "op-stop", kind: "STOP", state: "SUCCEEDED" })], truncated: false,
	} }));
	await expect(card.getByText("stopped observed", { exact: false })).toBeVisible({ timeout: 10_000 });
	await expect(card.getByRole("button", { name: "Start" })).toBeVisible();
	await expect(card.getByRole("link", { name: "Open chat" })).toHaveCount(0);
});

function scopeFromEnvironment() {
	return { installationId: environment.installationId, releaseId: environment.releaseId,
		connectionId: environment.connectionId, presetId: environment.presetId };
}


test("a management-created Incus project opens chat and saves its own conversation", async ({ page, request }) => {
	const seeded = await request.post("/api/__test/seed", { data: { incusProject: true, projectName: "Incus chat regression" } });
	expect(seeded.status()).toBe(201);
	const prepared = await seeded.json() as { project: { id: string; name: string }; binding: { id: string } };
	expect(prepared.project.id).toMatch(/^incus-project-[0-9a-f]{48}$/);
	await mockManagement(page, { initiallyQualified: true, preparedProject: prepared.project, preparedBindingId: prepared.binding.id });
	await page.goto("/extensions/incus-management");
	await page.getByRole("textbox", { name: "New project name" }).fill(prepared.project.name);
	await page.getByRole("button", { name: "Create project sandbox" }).click();
	const card = page.locator(".feature-card").filter({ has: page.getByRole("heading", { name: prepared.project.name }) });
	await card.getByRole("button", { name: "Start", exact: true }).click();
	await expect(card.getByRole("link", { name: "Open chat" })).toBeVisible();
	const createdResponse = page.waitForResponse(response => response.url().endsWith("/api/conversations") && response.request().method() === "POST");
	await card.getByRole("link", { name: "Open chat" }).click();
	await page.getByRole("button", { name: "New Conversation", exact: true }).click();
	const response = await createdResponse;
	expect(response.status()).toBe(201);
	const conversation = await response.json() as { id: string; projectId: string };
	expect(conversation.id).toMatch(/^[0-9a-f-]{36}$/);
	expect(conversation.projectId).toBe(prepared.project.id);
	await expect(page).toHaveURL(new RegExp(`/project/${prepared.project.id}/chat/${conversation.id}$`));
	await page.reload();
	const persisted = await request.get(`/api/conversations/${conversation.id}`);
	expect(persisted.status()).toBe(200);
	expect(await persisted.json()).toMatchObject({ id: conversation.id, projectId: prepared.project.id });
});


test("qualification failure shows the safe diagnostic and does not repeat the run", async ({ page }) => {
	await mockManagement(page);
	let attempts = 0;
	const message = "Qualification failed during enforcement (guest_reached_a_forbidden_network_target); cleanup confirmed. Inspect the saved fixtures before starting another run.";
	await page.route("**/api/infrastructure/incus/qualification", route => {
		attempts++;
		return route.fulfill({ status: 409, json: { code: "qualification_preparation_failed", stage: "enforcement", causeCode: "guest_reached_a_forbidden_network_target", cleanup: "confirmed", message } });
	});
	await page.goto("/extensions/incus-management");
	await page.getByRole("button", { name: "Prepare qualification…" }).click();
	await page.getByRole("checkbox", { name: /I reviewed this plan/ }).check();
	await page.getByRole("button", { name: "Apply reviewed fixture plan" }).click();
	await expect(page.getByTestId("qualification-workflow")).toContainText("Operator fixtures are ready");
	await page.getByRole("checkbox", { name: /host is ready for a live sandbox qualification/ }).check();
	await page.getByRole("button", { name: "Run live qualification" }).click();
	await expect(page.getByRole("alert")).toContainText(message);
	expect(attempts).toBe(1);
	await expect(page.getByRole("button", { name: "Create project sandbox" })).toBeDisabled();
});
