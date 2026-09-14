import type { Page } from "@playwright/test";
import type { FactoryDefinition, FactoryDraftDetails, FactoryDraftSummary, FactoryVersionDetails, FactoryVersionSummary } from "@ezcorp/factory-sdk/types";
import { expect, test, captureEvidence } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const projectId = "factory-project";
const factoryId = "catalog-enrichment-with-a-deliberately-long-definition-name";
const digest = "a".repeat(64);
const definitionDigest = "sha256:" + digest;
type FailureOperation = "list" | "create" | "import" | "save" | "validate" | "export" | "archive" | "versions" | "publish";

function definition(version = "0.2.0"): FactoryDefinition {
	return {
		schemaVersion: "factory.v1",
		id: factoryId,
		version,
		interpreterCompatibility: "factory-kernel.v1",
		inputPorts: {},
		outputPorts: {},
		graph: {
			nodes: [
				{ id: "collect-the-entire-catalog-from-the-primary-source", kind: "task", runner: { package: "catalog-reader", version: "1.0.0", digest: definitionDigest, export: "collect" }, capabilities: [], effects: [] },
				{ id: "publish-the-normalized-catalog-for-downstream-consumers", kind: "task", runner: { package: "catalog-writer", version: "1.0.0", digest: definitionDigest, export: "publish" }, capabilities: [], effects: [], dependsOn: ["collect-the-entire-catalog-from-the-primary-source"] },
			],
			outputs: {},
		},
		acceptance: { id: factoryId + ".contract", version: "0.2.0", claims: [] },
		packages: [],
		factories: [],
		capabilities: [],
		effects: ["none"],
		bounds: { maxExpandedNodes: 10_000, maxScopeDepth: 16 },
		presentation: { title: "Catalog enrichment for all downstream product and inventory consumers" },
	};
}

function summary(revision = 3): FactoryDraftSummary {
	return { factoryId, revision, archived: false, availability: "available", sourceDigest: digest, updatedAtMs: 1_789_000_000_000 };
}

function details(source = definition(), revision = 3): FactoryDraftDetails {
	return { ...summary(revision), source };
}

function historicalDefinition(): FactoryDefinition {
	const source = definition("0.1.0");
	return { ...source, acceptance: { ...source.acceptance, version: "0.1.0" } };
}

function published(source: FactoryDefinition = historicalDefinition()): FactoryVersionDetails {
	return {
		factoryId,
		version: source.version,
		draftRevision: 2,
		definitionDigest,
		compiledBlobDigest: digest,
		compiledBytes: 900,
		publishedAtMs: 1_788_000_000_000,
		source,
	};
}

async function routeFactoryApi(page: Page, options: { conflictOnce?: boolean; diagnosticsWithoutNode?: boolean; noVersions?: boolean; releaseInbox?: boolean; runs?: boolean } = {}): Promise<{
	requests: Array<{ method: string; path: string; headers: Record<string, string>; body: unknown }>;
	failNext(operation: FailureOperation): void;
	conflictNext(): void;
}> {
	let current = details();
	let conflict = options.conflictOnce ?? false;
	const prior = published();
	const requests: Array<{ method: string; path: string; headers: Record<string, string>; body: unknown }> = [];
	const failures = new Set<FailureOperation>();
	let runRevision = 4;
	// A different factory from the drafts above, so the page carries two genuinely distinct lists.
	const runSummary = () => ({ runId: "run-remediation", factoryId: "reference.code.v1", factoryVersion: "1.0.0", definitionDigest, grantRevision: 1, revision: runRevision, status: "waiting", createdAtMs: 1_789_000_000_000, updatedAtMs: 1_789_000_100_000 });
	let releaseInbox = options.releaseInbox ? [
		{ notificationId: "notification-command", createdAtMs: 4, kind: "command_approval_requested", approvalId: "approval-command", runId: "run-review", commandId: "command-review", nodeInstanceId: "human-review", contextDigest: digest, context: { subject: "catalog candidate" }, choices: ["ship", "hold"], actorScope: "operator", expiresAtMs: 2_000_000_000_000 },
		{ notificationId: "notification-approval", operationId: "factory-release:catalog", createdAtMs: 3, kind: "approval_requested", approvalId: "approval-catalog", contextDigest: digest, expiresAtMs: 2_000_000_000_000 },
		{ notificationId: "notification-uncertain", operationId: "factory-release:unknown", createdAtMs: 2, kind: "release_uncertain", dispatchGeneration: 2, outcomeCode: "provider_response_unknown" },
		{ notificationId: "notification-settled", operationId: "factory-release:complete", createdAtMs: 1, kind: "release_settled", dispatchGeneration: 1, outcomeCode: "confirmed" },
	] : [];
	await page.route("**/api/factories/**", async route => {
		const request = route.request();
		const url = new URL(request.url());
		const method = request.method();
		let body: unknown;
		try { body = request.postDataJSON(); } catch { body = undefined; }
		requests.push({ method, path: url.pathname + url.search, headers: request.headers(), body });
		const respond = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
		const envelope = <T extends Record<string, unknown>>(value: T) => ({ schemaVersion: "factory.api.response.v1", ...value });
		const reject = (operation: FailureOperation): ReturnType<typeof respond> | null => failures.delete(operation)
			? respond(envelope({ kind: "error", error: { code: "factory_unavailable", message: operation + " unavailable", retryable: true } }), 503)
			: null;

		if (url.pathname.endsWith("/release/notifications") && method === "GET") {
			return respond(envelope({ kind: "release.notification.page", page: { items: releaseInbox } }));
		}
		if (url.pathname.endsWith("/release/approvals/approval-catalog") && method === "PUT") {
			releaseInbox = releaseInbox.filter(item => item.notificationId !== "notification-approval");
			return respond(envelope({ kind: "release.approval.resource", resource: { approvalId: "approval-catalog", operationId: "factory-release:catalog", contextDigest: digest, status: "approved" } }));
		}
		if (url.pathname.endsWith("/runs/run-review/approvals/approval-command") && method === "PUT") {
			releaseInbox = releaseInbox.filter(item => item.notificationId !== "notification-command");
			return respond(envelope({ kind: "approval.resource", resource: { approvalId: "approval-command", runId: "run-review", commandId: "command-review", nodeInstanceId: "human-review", revision: 1, contextDigest: digest, status: "answered", choices: ["ship", "hold"], context: { subject: "catalog candidate" }, actorScope: "operator", expiresAtMs: 2_000_000_000_000, choice: "ship", decidedBy: "user-1", decidedAtMs: 1 } }));
		}

		if (url.pathname.endsWith("/runs/run-remediation/control") && method === "POST") {
			const control = body as { action: string };
			if (control.action === "replan") {
				return respond(envelope({ kind: "error", error: { code: "factory_control_widening", message: "The replacement factory widens the current run authority.", retryable: false } }), 403);
			}
			runRevision += 1;
			return respond(envelope({ kind: "mutation.accepted", receipt: { resourceId: "run-remediation", commandId: "factory-control:repair", statusUrl: "/api/factories/projects/" + projectId + "/runs/run-remediation/commands/factory-control:repair" } }), 202);
		}
		if (url.pathname.endsWith("/runs/run-remediation") && method === "GET") {
			return respond(envelope({ kind: "run.details", resource: { ...runSummary(), parameters: {}, error: { code: "factory_assurance_claim_failed", message: "A required protected claim failed." } } }));
		}
		if (url.pathname.endsWith("/runs") && method === "GET") {
			return respond(envelope({ kind: "run.page", page: { items: options.runs === false ? [] : [runSummary()] } }));
		}

		if (url.pathname.endsWith("/validate") && method === "POST") {
			const rejection = reject("validate");
			if (rejection) return rejection;
			return respond(envelope({ kind: "draft.validation", valid: false, diagnostics: [{ code: "output-unbound", message: "Bind the catalog output before publication.", path: ["graph", "outputs"], ...(options.diagnosticsWithoutNode ? {} : { nodeId: "publish-the-normalized-catalog-for-downstream-consumers" }) }] }));
		}
		if (url.pathname.endsWith("/export") && method === "GET") {
			const rejection = reject("export");
			if (rejection) return rejection;
			return respond(envelope({ kind: "draft.export", format: url.searchParams.get("format") ?? "json", source: JSON.stringify(current.source, null, 2) }));
		}
		if (url.pathname.endsWith("/import") && method === "POST") {
			const rejection = reject("import");
			if (rejection) return rejection;
			return respond(envelope({ kind: "draft.summary", resource: summary() }));
		}
		if (url.pathname.endsWith("/versions/0.1.0") && method === "GET") {
			return respond(envelope({ kind: "version.details", resource: prior }));
		}
		if (url.pathname.endsWith("/versions") && method === "GET") {
			const rejection = reject("versions");
			if (rejection) return rejection;
			const { source: _source, ...priorSummary } = prior;
			return respond(envelope({ kind: "version.page", page: { items: options.noVersions ? [] : [priorSummary] } }));
		}
		if (url.pathname.endsWith("/versions") && method === "POST") {
			const rejection = reject("publish");
			if (rejection) return rejection;
			const { source: _source, ...priorSummary } = prior;
			const release: FactoryVersionSummary = { ...priorSummary, version: current.source.version, draftRevision: current.revision, publishedAtMs: 1_789_000_100_000 };
			return respond(envelope({ kind: "version.summary", resource: release }));
		}
		if (url.pathname.endsWith("/" + encodeURIComponent(factoryId)) && method === "GET") {
			return respond(envelope({ kind: "draft.details", resource: current }));
		}
		if (url.pathname.endsWith("/" + encodeURIComponent(factoryId)) && method === "PUT") {
			if (conflict) {
				conflict = false;
				current = details(definition(), 4);
				return respond(envelope({ kind: "error", error: { code: "factory_precondition_failed", message: "The draft changed on the server.", retryable: false, currentRevision: 4 } }), 412);
			}
			const rejection = reject("save");
			if (rejection) return rejection;
			const update = body as { source: FactoryDefinition };
			current = { ...details(update.source, current.revision + 1), sourceDigest: "b".repeat(64) };
			return respond(envelope({ kind: "draft.summary", resource: { ...summary(current.revision), sourceDigest: current.sourceDigest } }));
		}
		if (url.pathname.endsWith("/" + encodeURIComponent(factoryId)) && method === "DELETE") {
			const rejection = reject("archive");
			if (rejection) return rejection;
			return respond(envelope({ kind: "draft.summary", resource: { ...summary(current.revision + 1), archived: true } }));
		}
		if (url.pathname.endsWith("/definitions") && method === "POST") {
			const rejection = reject("create");
			if (rejection) return rejection;
			const created = body as { source: FactoryDefinition };
			current = details(created.source, 1);
			return respond(envelope({ kind: "draft.summary", resource: summary(1) }));
		}
		if (url.pathname.endsWith("/definitions") && method === "GET") {
			const rejection = reject("list");
			if (rejection) return rejection;
			return respond(envelope({ kind: "draft.page", page: { items: [summary()] } }));
		}
		return respond(envelope({ kind: "error", error: { code: "factory_not_found", message: "No mock route", retryable: false } }), 404);
	});
	return {
		requests,
		failNext: operation => failures.add(operation),
		conflictNext: () => { conflict = true; },
	};
}

async function openConsole(page: Page): Promise<void> {
	await page.goto("/factories");
	const console = page.getByTestId("factory-console");
	await console.getByRole("button", { name: new RegExp(factoryId) }).click();
	await expect(console.getByRole("heading", { name: factoryId })).toBeVisible();
	await expect(page.getByTestId("factory-graph")).toBeVisible();
}

test.describe("factory authoring console", () => {
	test("shows the current-authorized release inbox and records an exact decision @evidence", async ({ page, mockApi }, testInfo) => {
		await page.addInitScript(() => localStorage.setItem("ezcorp-theme", "light"));
		await page.setViewportSize({ width: 1440, height: 980 });
		await mockApi({ projects: [makeProject({ id: projectId, name: "Product Operations" })] });
		const mocked = await routeFactoryApi(page, { releaseInbox: true });
		await page.goto("/factories");
		await expect(page.getByRole("heading", { name: "Factory inbox" })).toBeVisible();
		await expect(page.getByText("Factory approval requested")).toBeVisible();
		await expect(page.getByText("Release approval requested")).toBeVisible();
		await expect(page.getByText("Release outcome uncertain")).toBeVisible();
		await expect(page.getByText("Release completed")).toBeVisible();
		await captureEvidence(page, testInfo, "factory-release-inbox-authorized", { fullPage: true });
		const approval = page.locator("article", { hasText: "Release approval requested" });
		await approval.getByRole("button", { name: "Approve" }).click();
		await expect(page.getByText("factory-release:catalog")).toHaveCount(0);
		const decision = mocked.requests.find(item => item.path.endsWith("/release/approvals/approval-catalog"));
		expect(decision?.method).toBe("PUT");
		expect(decision?.headers["if-match"]).toBe("0");
		expect(decision?.body).toEqual({ contextDigest: digest, decision: "approved" });
		const commandApproval = page.locator("article", { hasText: "Factory approval requested" });
		await commandApproval.getByRole("button", { name: "ship" }).click();
		await expect(page.getByText("command-review")).toHaveCount(0);
		const commandDecision = mocked.requests.find(item => item.path.endsWith("/runs/run-review/approvals/approval-command"));
		expect(commandDecision?.method).toBe("PUT");
		expect(commandDecision?.headers["if-match"]).toBe("0");
		expect(commandDecision?.body).toEqual({ contextDigest: digest, choice: "ship" });
	});

	test("requests a bounded repair and refuses a widening replan @evidence", async ({ page, mockApi }, testInfo) => {
		await page.addInitScript(() => localStorage.setItem("ezcorp-theme", "light"));
		await page.setViewportSize({ width: 1440, height: 1100 });
		await mockApi({ projects: [makeProject({ id: projectId, name: "Product Operations" })] });
		const mocked = await routeFactoryApi(page);
		await page.goto("/factories");
		const controls = page.getByTestId("factory-run-controls");
		await expect(controls.getByRole("heading", { name: "Run controls" })).toBeVisible();
		await controls.getByRole("button", { name: /run-remediation/ }).click();
		await expect(controls.getByText("factory_assurance_claim_failed")).toBeVisible();

		await controls.getByLabel("Node").fill("generate-private-candidate");
		await controls.getByLabel("Reason").fill("Rejected: the protected test is missing");
		await controls.getByLabel("Input override").fill('{"remediation":{"kind":"inline","value":"restore the protected test"}}');
		await captureEvidence(page, testInfo, "factory-run-controls-bounded-repair", { fullPage: true });
		await controls.getByRole("button", { name: "Request repair" }).click();
		await expect(controls.getByText("Queued repair as factory-control:repair.")).toBeVisible();
		const repair = mocked.requests.find(item => item.path.endsWith("/runs/run-remediation/control"));
		expect(repair?.headers["if-match"]).toBe("4");
		expect(repair?.body).toEqual({ action: "repair", nodeId: "generate-private-candidate", reason: "Rejected: the protected test is missing", parameters: { remediation: { kind: "inline", value: "restore the protected test" } } });
		// The control refreshed the run, so the next request must carry the revision it moved to.
		await expect(controls.getByText("at revision 5")).toBeVisible();

		await controls.getByRole("button", { name: "Replan" }).click();
		await controls.getByLabel("Child factory").fill("reference.code.v1");
		await controls.getByLabel("Child version").fill("2.0.0");
		await controls.getByLabel("Child digest").fill(definitionDigest);
		await controls.getByRole("button", { name: "Request replan" }).click();
		await expect(controls.getByRole("alert")).toContainText("widens the run's authority");
		await captureEvidence(page, testInfo, "factory-run-controls-widening-denied", { fullPage: true });
	});

	test("authors with the real graph library, shows diagnostics, and exports @evidence", async ({ page, mockApi }, testInfo) => {
		await page.addInitScript(() => localStorage.setItem("ezcorp-theme", "light"));
		await page.setViewportSize({ width: 1440, height: 980 });
		await mockApi({ projects: [makeProject({ id: projectId, name: "Product Operations" })] });
		const mocked = await routeFactoryApi(page);
		await openConsole(page);

		await expect(page.getByTestId("factory-graph-node")).toHaveCount(2);
		await expect(page.getByTestId("factory-graph-node").first()).toContainText("collect-the-entire-catalog");
		await page.getByLabel("New node ID").fill("verify-catalog-contract");
		await page.getByRole("button", { name: "Add node" }).click();
		const flow = page.getByTestId("svelte-flow__wrapper");
		const sourceHandle = flow.locator('[data-id="collect-the-entire-catalog-from-the-primary-source"] .svelte-flow__handle.source');
		const targetHandle = flow.locator('[data-id="verify-catalog-contract"] .svelte-flow__handle.target');
		await sourceHandle.dragTo(targetHandle);
		await expect(flow.locator(".svelte-flow__edge")).toHaveCount(2);
		await page.getByRole("button", { name: "Validate" }).click();
		await expect(page.getByText("Bind the catalog output before publication.")).toBeVisible();
		await page.getByText("Bind the catalog output before publication.").click();
		await expect(page.getByLabel("Selected node JSON")).toHaveValue(/publish-the-normalized-catalog/);

		const download = page.waitForEvent("download");
		await page.getByRole("button", { name: "JSON" }).click();
		expect((await download).suggestedFilename()).toBe(factoryId + ".json");
		await captureEvidence(page, testInfo, "factory-authoring-wide-light-long-labels", { fullPage: true });
		expect(mocked.requests.some(item => item.path.endsWith("/validate") && item.method === "POST")).toBe(true);

		await flow.click({ position: { x: 20, y: 20 } });
		const edge = flow.locator(".svelte-flow__edge").first();
		await edge.locator(".svelte-flow__edge-interaction").click({ force: true });
		await edge.press("Delete");
		const graphNode = flow.getByRole("button", { name: "verify-catalog-contract, task" });
		await graphNode.click();
		await graphNode.press("Delete");
		await expect(page.getByRole("button", { name: /task verify-catalog-contract/ })).toHaveCount(0);
	});

	test("refetches a stale revision and compares the exact pinned version before immutable publication @evidence", async ({ page, mockApi }, testInfo) => {
		await page.addInitScript(() => localStorage.setItem("ezcorp-theme", "dark"));
		await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
		await page.setViewportSize({ width: 390, height: 844 });
		await mockApi({ projects: [makeProject({ id: projectId, name: "Product Operations" })] });
		const mocked = await routeFactoryApi(page, { conflictOnce: true });
		await openConsole(page);

		await page.getByLabel("New node ID").fill("review");
		await page.getByRole("button", { name: "Add node" }).click();
		await page.getByRole("button", { name: "Save" }).click();
		await expect(page.getByTestId("factory-conflict")).toContainText("server is at revision 4");
		await page.getByRole("button", { name: "Keep my changes" }).click();
		mocked.conflictNext();
		await page.getByRole("button", { name: "Save" }).click();
		await expect(page.getByTestId("factory-conflict")).toContainText("server is at revision 4");
		await page.getByRole("button", { name: "Load server" }).click();
		await expect(page.getByText("Loaded the current server revision.")).toBeVisible();
		await page.getByLabel("New node ID").fill("review");
		await page.getByRole("button", { name: "Add node" }).click();
		await page.getByRole("button", { name: "Save" }).click();
		await expect(page.getByText("Draft revision 5 saved.")).toBeVisible();

		await page.getByRole("button", { name: "Publish", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "Review version 0.2.0" });
		await expect(dialog).toContainText("Pinned published source 0.1.0");
		await expect(dialog).toContainText("Exact source to publish");
		await expect(dialog).toContainText("Acceptance contract changed");
		await expect(dialog).toContainText("does not activate a runner or package");
		await captureEvidence(page, testInfo, "factory-publication-narrow-dark-reduced-motion", { fullPage: true });
		await dialog.getByRole("button", { name: "Publish 0.2.0" }).click();
		await expect(page.getByText("Published immutable version 0.2.0.")).toBeVisible();

		const save = mocked.requests.filter(item => item.method === "PUT");
		expect(save).toHaveLength(3);
		expect(save.every(item => item.headers["if-match"] === "3" || item.headers["if-match"] === "4")).toBe(true);
		expect(save.every(item => Boolean(item.headers["idempotency-key"]))).toBe(true);
		const publication = mocked.requests.find(item => item.method === "POST" && item.path.endsWith("/versions"));
		expect(publication?.headers["if-match"]).toBe("5");
		expect(publication?.body).toEqual({ version: "0.2.0" });
	});

	test("creates and imports through the current membership project", async ({ page, mockApi }) => {
		await mockApi({ projects: [makeProject({ id: projectId, name: "Product Operations" })] });
		const mocked = await routeFactoryApi(page);
		await page.goto("/factories");
		await expect(page.getByLabel("Factory project")).toHaveValue(projectId);
		await page.getByLabel("New factory ID").fill("created-definition");
		await page.getByRole("button", { name: "Create factory" }).click();
		await expect.poll(() => mocked.requests.filter(item => item.method === "POST" && item.path.endsWith("/definitions")).length).toBe(1);

		await page.getByLabel("Import factory").click();
		await page.locator('input[type="file"]').setInputFiles({ name: "catalog.yaml", mimeType: "application/yaml", buffer: Buffer.from("schemaVersion: factory.v1") });
		await expect.poll(() => mocked.requests.filter(item => item.path.endsWith("/import")).length).toBe(1);
		const imported = mocked.requests.find(item => item.path.endsWith("/import"));
		expect(imported?.body).toEqual({ format: "yaml", source: "schemaVersion: factory.v1" });
	});

	test("edits source and nodes, navigates nested graphs, and archives the draft", async ({ page, mockApi }) => {
		await mockApi({ projects: [makeProject({ id: projectId, name: "Product Operations" })] });
		const mocked = await routeFactoryApi(page, { diagnosticsWithoutNode: true, noVersions: true });
		await openConsole(page);

		await page.getByRole("button", { name: "Definition", exact: true }).click();
		const sourceEditor = page.getByLabel("Factory definition JSON");
		await sourceEditor.fill("not-json");
		await page.getByRole("button", { name: "Apply source" }).click();
		await expect(page.getByRole("alert")).toContainText("Unexpected token");
		await page.getByRole("button", { name: "Dismiss error" }).click();
		const changed = definition("0.3.0");
		await sourceEditor.fill(JSON.stringify(changed));
		await page.getByRole("button", { name: "Apply source" }).click();
		await expect(page.getByText(/0.3.0 · 2 nodes/)).toBeVisible();

		await page.getByRole("button", { name: "Graph", exact: true }).click();
		await page.getByRole("button", { name: /task collect-the-entire-catalog/ }).click();
		const nodeEditor = page.getByLabel("Selected node JSON");
		await nodeEditor.fill("{}");
		await page.getByRole("button", { name: "Apply node" }).click();
		await expect(page.getByRole("alert")).toContainText("supported kind");
		await page.getByRole("button", { name: "Dismiss error" }).click();
		const renamedNode = { ...changed.graph.nodes[0]!, id: "collect-catalog" };
		await nodeEditor.fill(JSON.stringify(renamedNode));
		await page.getByRole("button", { name: "Apply node" }).click();
		await expect(page.getByRole("button", { name: /task collect-catalog/ })).toBeVisible();

		await page.getByLabel("Node kind").selectOption("branch");
		await page.getByLabel("New node ID").fill("choose-release-path");
		await page.getByRole("button", { name: "Add node" }).click();
		await page.getByRole("button", { name: "Open choose-release-path / then" }).click();
		await expect(page.getByText("No nodes in this graph.")).toBeVisible();
		await page.getByRole("button", { name: "Root" }).click();

		await page.getByRole("button", { name: /task publish-the-normalized/ }).click();
		await page.getByLabel("Dependency from").selectOption("collect-catalog");
		await page.getByRole("button", { name: "Connect" }).click();
		await page.getByRole("button", { name: /branch choose-release-path/ }).click();
		await page.getByRole("button", { name: "Delete" }).click();
		await expect(page.getByRole("button", { name: /branch choose-release-path/ })).toHaveCount(0);

		await page.getByRole("button", { name: "Validate" }).click();
		await page.getByText("Bind the catalog output before publication.").click();
		await expect(page.getByLabel("Factory definition JSON")).toBeVisible();
		await page.getByRole("button", { name: "Versions" }).click();
		await expect(page.getByText("No versions published yet.")).toBeVisible();
		await page.getByRole("button", { name: "Graph", exact: true }).click();
		await page.getByRole("button", { name: "Save" }).click();
		await expect(page.getByText("Draft revision 4 saved.")).toBeVisible();
		await page.getByRole("button", { name: "Publish", exact: true }).click();
		await expect(page.getByRole("dialog", { name: "Review version 0.3.0" })).toContainText("No prior immutable version.");
		await page.getByRole("button", { name: "Cancel" }).click();

		await page.getByRole("button", { name: "Archive draft" }).click();
		await expect.poll(() => mocked.requests.some(item => item.method === "DELETE")).toBe(true);
	});

	test("keeps every failed authoring operation recoverable", async ({ page, mockApi }) => {
		await mockApi({ projects: [makeProject({ id: projectId, name: "Product Operations" })] });
		const mocked = await routeFactoryApi(page);
		mocked.failNext("list");
		await page.goto("/factories");
		await expect(page.getByRole("alert")).toContainText("list unavailable");
		await page.reload();
		await expect(page.getByText(factoryId)).toBeVisible();

		mocked.failNext("create");
		await page.getByLabel("New factory ID").fill("rejected-definition");
		await page.getByRole("button", { name: "Create factory" }).click();
		await expect(page.getByRole("alert")).toContainText("create unavailable");
		await page.getByRole("button", { name: "Dismiss error" }).click();

		mocked.failNext("import");
		await page.locator('input[type="file"]').setInputFiles({ name: "rejected.json", mimeType: "application/json", buffer: Buffer.from("{}") });
		await expect(page.getByRole("alert")).toContainText("import unavailable");
		await page.getByRole("button", { name: "Dismiss error" }).click();
		await page.getByTestId("factory-console").getByRole("button", { name: new RegExp(factoryId) }).click();

		await page.getByLabel("New node ID").fill("duplicate");
		await page.getByRole("button", { name: "Add node" }).click();
		await page.getByLabel("New node ID").fill("duplicate");
		await page.getByRole("button", { name: "Add node" }).click();
		await expect(page.getByRole("alert")).toContainText("unique");
		await page.getByRole("button", { name: "Dismiss error" }).click();

		for (const [operation, button] of [["validate", "Validate"], ["export", "JSON"], ["archive", "Archive draft"]] as const) {
			mocked.failNext(operation);
			await page.getByRole("button", { name: button }).click();
			await expect(page.getByRole("alert")).toContainText(operation + " unavailable");
			await page.getByRole("button", { name: "Dismiss error" }).click();
		}

		mocked.failNext("save");
		await page.getByRole("button", { name: "Save" }).click();
		await expect(page.getByRole("alert")).toContainText("save unavailable");
		await page.getByRole("button", { name: "Dismiss error" }).click();
		await page.getByRole("button", { name: "Save" }).click();
		await expect(page.getByText("Draft revision 4 saved.")).toBeVisible();
		mocked.failNext("versions");
		await page.getByRole("button", { name: "Publish", exact: true }).click();
		await expect(page.getByRole("alert")).toContainText("versions unavailable");
		await page.getByRole("button", { name: "Dismiss error" }).click();

		await page.getByRole("button", { name: "Publish", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "Review version 0.2.0" });
		mocked.failNext("publish");
		await dialog.getByRole("button", { name: "Publish 0.2.0" }).click();
		await expect(page.getByRole("alert")).toContainText("publish unavailable");
	});
});
