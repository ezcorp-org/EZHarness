/**
 * The factory console, end to end through the REAL application (`factory-services` lane).
 *
 * The stack is real: the built product server, PostgreSQL, object storage,
 * Temporal, the Node orchestrator, the pool admission service, and the host
 * supervisor that launches the guest in a Podman container. The session is
 * the administrator the stack set up through the first-run route. The journeys
 * run in order because each one leaves the state the next one reads:
 *
 *   1. the administrator grants itself `factory.trust` in the console;
 *   2. binds the built guest release, reviews, and trusts it;
 *   3. imports and publishes a definition that runs that guest, then races a
 *      save against a publish and replays an idempotency key;
 *   4. starts a run from the version list and watches it live to a terminal
 *      status: attempts, costs, acceptance, artifacts, and a safe preview;
 *   5. proves the scoped API: a read-only key, a service credential, a
 *      cross-project artifact share, and download headers;
 *   6. previews a quarantine's reach, and records a purge request.
 *
 * Two deployment facts are the stack's, and it says so in its record: the v4
 * installation record of the guest release, and the package PREPARATION once
 * the console has trusted it (no product route or role prepares a package).
 */
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/hydration.js";
import { captureEvidence } from "./fixtures/evidence.js";
import { FACTORY_SERVICES_STATE_PATH, readFactoryServicesState, type FactoryServicesState } from "./factory-services/state.js";

test.describe.configure({ mode: "serial" });

let state: FactoryServicesState;
let runId = "";

test.beforeAll(() => { state = readFactoryServicesState(); });

async function selectProject(page: Page, view: "authoring" | "runs" | "inbox" | "admin"): Promise<void> {
	await page.goto(view === "authoring" ? "/factories" : `/factories?view=${view}`);
	await page.getByLabel("Factory project").selectOption(state.projectId);
	await expect(page.getByRole("tab", { name: view === "admin" ? "Administration" : view[0]!.toUpperCase() + view.slice(1) })).toHaveAttribute("aria-selected", "true");
}

async function waitForPreparation(): Promise<void> {
	await expect.poll(() => (JSON.parse(readFileSync(FACTORY_SERVICES_STATE_PATH, "utf8")) as { prepared?: boolean }).prepared, { timeout: 600_000, intervals: [2_000] }).toBe(true);
}

test("an administrator grants itself package trust in the console", async ({ page }) => {
	await selectProject(page, "admin");
	const admin = page.getByTestId("factory-administration");
	const form = admin.getByRole("form", { name: "Grant factory authority" });
	await form.getByLabel("Identifier").fill(state.adminId);
	await form.getByLabel("Action").selectOption("factory.trust");
	await form.getByRole("button", { name: "Grant" }).click();
	await expect(admin.getByRole("status")).toContainText(`factory.trust granted to user ${state.adminId} at revision 1.`);
	await expect(admin.getByText(`user · ${state.adminId}`).first()).toBeVisible();
});

test("the console binds the built guest release and trusts it after reviewing its reach @evidence", async ({ page }, testInfo) => {
	await selectProject(page, "admin");
	const admin = page.getByTestId("factory-administration");
	await admin.getByRole("button", { name: "Install" }).click();
	const form = admin.getByRole("form", { name: "Install runner package" });
	const reference = state.guest.reference;
	await form.getByLabel("Package").fill(reference.package);
	await form.getByLabel("Manifest name").fill(reference.manifestName);
	await form.getByLabel("Version").fill(reference.version);
	await form.getByLabel("Export").fill(reference.export);
	await form.getByLabel("Digest").fill(reference.digest);
	await form.getByLabel("Installation").fill(state.guest.installationId);
	await form.getByLabel("Release").fill(state.guest.releaseId);
	await form.getByRole("button", { name: "Bind package" }).click();
	await expect(admin.getByRole("status")).toContainText(`${reference.package}@${reference.version} is bound.`);
	const actions = admin.getByRole("group", { name: `Trust actions for ${reference.package}` });
	await actions.getByRole("button", { name: "Trust", exact: true }).click();
	const review = page.getByRole("dialog", { name: `Trust ${reference.package}` });
	await expect(review).toContainText("No live run uses this package.");
	await captureEvidence(page, testInfo, "factory-services-package-trust-review");
	await review.getByRole("button", { name: "Commit at revision 0" }).click();
	await expect(admin.getByRole("status")).toContainText(`${reference.package} is active at trust revision 1. The change is in the audit log.`);
	await expect(actions.getByRole("button", { name: "Re-trust" })).toBeVisible();
	await captureEvidence(page, testInfo, "factory-services-administration");
	await waitForPreparation();
});

test("the console imports and publishes a definition that runs the guest", async ({ page }) => {
	await selectProject(page, "authoring");
	const console = page.getByTestId("factory-console");
	await console.locator('input[type="file"]').setInputFiles(state.definitionPath);
	await expect(console.getByRole("heading", { name: state.consoleFactoryId })).toBeVisible();
	await console.getByRole("button", { name: "Publish", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Review version 1.0.0" });
	await expect(dialog).toContainText("First publication");
	await dialog.getByRole("button", { name: "Publish 1.0.0" }).click();
	await expect(console.getByRole("status")).toContainText("Published immutable version 1.0.0.");
});

test("a save racing a publish on one revision leaves one consistent winner, and a replayed key answers the same", async ({ page }) => {
	const definition = `/api/factories/projects/${encodeURIComponent(state.projectId)}/definitions/${encodeURIComponent(state.consoleFactoryId)}`;
	const draft = (await (await page.request.get(definition)).json() as { resource: { revision: number; source: Record<string, unknown> } }).resource;
	const prepared = await page.request.put(definition, { headers: { "If-Match": String(draft.revision), "Idempotency-Key": `w14-save-101-${Date.now()}` }, data: { source: { ...draft.source, version: "1.0.1" } } });
	expect(prepared.status()).toBe(200);
	const base = (await prepared.json() as { resource: { revision: number } }).resource;

	const saveKey = `w14-race-save-${Date.now()}`;
	const saveBody = { source: { ...draft.source, version: "1.0.2" } };
	const [save, publish] = await Promise.all([
		page.request.put(definition, { headers: { "If-Match": String(base.revision), "Idempotency-Key": saveKey }, data: saveBody }),
		page.request.post(`${definition}/versions`, { headers: { "If-Match": String(base.revision), "Idempotency-Key": `w14-race-publish-${Date.now()}` }, data: { version: "1.0.1" } }),
	]);
	const statuses = [save.status(), publish.status()];
	for (const status of statuses) expect([200, 201, 409, 412]).toContain(status);
	expect(statuses.some(status => status < 300)).toBe(true);
	const published = await page.request.get(`${definition}/versions/1.0.1`);
	if (publish.status() < 300) {
		// The published bytes are the revision the publish named, never the racing save.
		const version = (await published.json() as { resource: { draftRevision: number; source: { version: string } } }).resource;
		expect(version.draftRevision).toBe(base.revision);
		expect(version.source.version).toBe("1.0.1");
	} else {
		expect(published.status()).toBe(404);
	}
	const after = (await (await page.request.get(definition)).json() as { resource: { source: { version: string } } }).resource;
	expect(after.source.version).toBe(save.status() < 300 ? "1.0.2" : "1.0.1");

	if (save.status() < 300) {
		// The same key and body answer the first result again; the same key with other bytes is refused.
		const first = await save.json() as { resource: { revision: number } };
		const replay = await page.request.put(definition, { headers: { "If-Match": String(base.revision), "Idempotency-Key": saveKey }, data: saveBody });
		expect(replay.status()).toBe(save.status());
		expect((await replay.json() as { resource: { revision: number } }).resource.revision).toBe(first.resource.revision);
		const reused = await page.request.put(definition, { headers: { "If-Match": String(base.revision), "Idempotency-Key": saveKey }, data: { source: { ...draft.source, version: "1.0.3" } } });
		expect(reused.status()).toBe(409);
		expect((await reused.json() as { error: { code: string } }).error.code).toBe("idempotency_conflict");
	}
});

test("a run started from the version list is watched live to a terminal status with its attempts, costs, and evidence @evidence", async ({ page }, testInfo) => {
	await selectProject(page, "authoring");
	const console = page.getByTestId("factory-console");
	await console.getByRole("button", { name: new RegExp(state.consoleFactoryId.replace(/\./g, "\\.")) }).first().click();
	await console.getByRole("button", { name: /^Versions/ }).click();
	await console.getByRole("button", { name: "Start a run of 1.0.0" }).click();
	const start = page.getByRole("dialog", { name: `Start ${state.consoleFactoryId} 1.0.0` });
	await expect(start).toContainText("The run pins version 1.0.0");
	await start.getByLabel(/Run input/).fill('{"message":{"kind":"inline","value":"W14 console journey"}}');
	await start.getByRole("button", { name: "Start run" }).click();
	const queued = start.getByRole("status");
	await expect(queued).toContainText("is queued. Acceptance is not the same as a started run.");
	await captureEvidence(page, testInfo, "factory-services-run-start");
	runId = (await queued.locator("code").textContent())!.trim();
	await start.getByRole("button", { name: "Watch in Runs" }).click();
	await expect(page).toHaveURL(new RegExp(`view=runs.*run=${runId}`));
	const inspector = page.getByTestId("factory-run-inspector");
	await expect(inspector.getByRole("heading", { level: 2, name: state.consoleFactoryId })).toBeVisible();
	const badge = page.getByTestId("factory-stream-state");
	await expect(badge).toBeVisible();
	await captureEvidence(page, testInfo, "factory-services-run-live");
	// The run reaches a terminal status through the real guest; the stream says Finished once drained.
	await expect(badge).toContainText("Finished", { timeout: 240_000 });
	await expect(inspector.getByText(/^Run · (succeeded|failed|cancelled)$/)).toBeVisible();
	await expect(inspector.getByRole("heading", { name: /Attempts/ })).not.toContainText(/^Attempts 0$/);
	await expect(inspector.locator("table.attempts tbody tr").first()).toBeVisible();
	await expect(inspector.getByRole("heading", { name: "Cost" })).toBeVisible();
	await captureEvidence(page, testInfo, "factory-services-run-finished");
	const artifacts = inspector.getByRole("heading", { name: /Artifacts and evidence/ });
	await artifacts.scrollIntoViewIfNeeded();
	const preview = inspector.getByRole("button", { name: /^Preview / }).first();
	await preview.click();
	const dialog = page.getByTestId("factory-artifact-preview");
	await expect(dialog.getByText("Shown as escaped text or a re-encoded image.", { exact: false })).toBeVisible();
	await expect(dialog.locator("script")).toHaveCount(0);
	await captureEvidence(page, testInfo, "factory-services-artifact-preview");
	await page.keyboard.press("Escape");
	await expect(preview).toBeFocused();
});

test("the scoped API: tickets, download headers, a read-only key, a service credential, and a named share", async ({ page, playwright }) => {
	const base = `/api/factories/projects/${encodeURIComponent(state.projectId)}`;
	const inspection = await (await page.request.get(`${base}/runs/${runId}/inspection`)).json() as { resource: { cursor: { token: string }; artifacts: { items: Array<{ artifactId: string; digest: string; encodedBytes: number }> } } };
	const artifact = inspection.resource.artifacts.items[0]!;

	// A ticket names one artifact and this caller; the bytes arrive only as an attachment.
	const ticket = await (await page.request.post(`${base}/runs/${runId}/artifacts/${encodeURIComponent(artifact.artifactId)}/ticket`)).json() as { ticket: { url: string } };
	const download = await page.request.get(ticket.ticket.url);
	expect(download.status()).toBe(200);
	expect(download.headers()).toMatchObject({ "content-type": "application/octet-stream", "x-content-type-options": "nosniff", "cache-control": "no-store", "content-security-policy": "default-src 'none'; sandbox" });
	expect(download.headers()["content-disposition"]).toMatch(/^attachment; filename=".+\.bin"$/);
	expect((await download.body()).byteLength).toBe(artifact.encodedBytes);
	expect((await page.request.get(ticket.ticket.url.replace(/ticket=[^&]+/, "ticket=forged.AAAA"))).status()).toBe(403);

	// The event stream resumes from a snapshot cursor; a forged cursor is refused with its own code.
	const events = await page.request.get(`${base}/runs/${runId}/events?cursor=${encodeURIComponent(inspection.resource.cursor.token)}`);
	expect(events.headers()["content-type"]).toBe("text/event-stream; charset=utf-8");
	expect(await events.text()).toContain("event: factory:stream-closed");
	const forged = await page.request.get(`${base}/runs/${runId}/events?cursor=${encodeURIComponent(inspection.resource.cursor.token.slice(0, -4) + "AAAA")}`);
	expect(forged.status()).toBe(400);
	expect(((await forged.json()) as { error: { code: string } }).error.code).toBe("factory_cursor_invalid");

	// A restricted key reads but cannot mutate, and cannot reach a human-session row at all.
	const minted = await page.request.post("/api/settings/developer/api-keys", { data: { name: "w14-read-only", scopes: ["read"] } });
	expect(minted.status()).toBe(201);
	const readKey = ((await minted.json()) as { key: string }).key;
	const keyed = await playwright.request.newContext({ baseURL: state.baseURL, extraHTTPHeaders: { Authorization: `Bearer ${readKey}` }, storageState: { cookies: [], origins: [] } });
	try {
		expect((await keyed.get(`${base}/runs/${runId}/inspection`)).status()).toBe(200);
		expect((await keyed.get(`${base}/packages`)).status()).toBe(200);
		const refusedInstall = await keyed.post(`${base}/packages`, { headers: { "If-Match": "0", "Idempotency-Key": "w14-key-install" }, data: { reference: state.guest.reference, installationId: state.guest.installationId, releaseId: state.guest.releaseId } });
		expect([401, 403]).toContain(refusedInstall.status());
		expect([401, 403]).toContain((await keyed.get(`/api/factories/tenants/${state.tenantId}/purge-preview`)).status());
	} finally {
		await keyed.dispose();
	}

	// A service credential is confined to its project and its delegated scope.
	const issued = await page.request.post(`${base}/service-accounts/w14-reader/credentials`, { headers: { "If-Match": "0", "Idempotency-Key": `w14-credential-${Date.now()}` }, data: { scopes: ["read"], expiresAtMs: Date.now() + 5 * 60_000 } });
	expect(issued.ok()).toBe(true);
	const serviceToken = ((await issued.json()) as { token: string }).token;
	const service = await playwright.request.newContext({ baseURL: state.baseURL, extraHTTPHeaders: { Authorization: `Bearer ${serviceToken}` }, storageState: { cookies: [], origins: [] } });
	try {
		expect([200, 403]).toContain((await service.get(`${base}/runs/${runId}/inspection`)).status());
		const foreign = await service.get(`/api/factories/projects/${encodeURIComponent(state.readerProjectId)}/packages`);
		expect(foreign.status()).toBe(403);
		expect([401, 403]).toContain((await service.post(`${base}/runs/${runId}/artifacts/${encodeURIComponent(artifact.artifactId)}/shares`, { headers: { "If-Match": "0", "Idempotency-Key": "w14-service-share" }, data: { targetProjectId: state.readerProjectId, mediaType: "application/json" } })).status());
	} finally {
		await service.dispose();
	}

	// A named share exposes exactly those bytes to the reader project, and nothing else of the run.
	const shared = await page.request.post(`${base}/runs/${runId}/artifacts/${encodeURIComponent(artifact.artifactId)}/shares`, { headers: { "If-Match": "0", "Idempotency-Key": `w14-share-${Date.now()}` }, data: { targetProjectId: state.readerProjectId, mediaType: "application/json" } });
	expect(shared.status()).toBe(200);
	const readerBase = `/api/factories/projects/${encodeURIComponent(state.readerProjectId)}`;
	const read = await page.request.get(`${readerBase}/shared-artifacts/${encodeURIComponent(artifact.artifactId)}?digest=${encodeURIComponent(artifact.digest)}&encodedBytes=${artifact.encodedBytes}&mediaType=application%2Fjson`);
	expect(read.status()).toBe(200);
	expect(read.headers()["x-content-type-options"]).toBe("nosniff");
	const otherDigest = `sha256:${"0".repeat(64)}`;
	expect((await page.request.get(`${readerBase}/shared-artifacts/${encodeURIComponent(artifact.artifactId)}?digest=${otherDigest}&encodedBytes=${artifact.encodedBytes}&mediaType=application%2Fjson`)).status()).toBe(404);
	expect((await page.request.get(`${readerBase}/runs/${runId}/inspection`)).status()).toBe(404);
	const unshared = await page.request.delete(`${base}/runs/${runId}/artifacts/${encodeURIComponent(artifact.artifactId)}/shares/${encodeURIComponent(state.readerProjectId)}`, { headers: { "If-Match": "0", "Idempotency-Key": `w14-unshare-${Date.now()}` } });
	expect(unshared.status()).toBe(200);
	expect((await page.request.get(`${readerBase}/shared-artifacts/${encodeURIComponent(artifact.artifactId)}?digest=${encodeURIComponent(artifact.digest)}&encodedBytes=${artifact.encodedBytes}&mediaType=application%2Fjson`)).status()).toBe(404);
});

test("the console previews a quarantine's reach and records a purge request without deleting anything @evidence", async ({ page }, testInfo) => {
	await selectProject(page, "admin");
	const admin = page.getByTestId("factory-administration");
	const reference = state.guest.reference;
	await admin.getByRole("group", { name: `Trust actions for ${reference.package}` }).getByRole("button", { name: "Quarantine", exact: true }).click();
	const review = page.getByRole("dialog", { name: `Quarantine ${reference.package}` });
	await expect(review).toContainText(/live run|No live run/);
	await expect(review.getByRole("button", { name: "Commit at revision 1" })).toBeEnabled();
	await review.getByRole("button", { name: "Cancel" }).click();

	const purge = admin.getByRole("region", { name: "Tenant purge request" });
	await expect(purge.getByRole("table")).toContainText("Runs that are queued, running, waiting, or cancelling");
	await expect(purge).toContainText("A purge would remove");
	await purge.getByLabel("Reason").fill("W14 journey: the request is recorded and deletes nothing");
	await purge.getByLabel("Type the tenant identifier to confirm").fill(state.tenantId);
	await purge.getByRole("button", { name: "Record purge request" }).click();
	await expect(admin.getByRole("status").first()).toContainText(/Purge request purge-[0-9a-f]+ (is queued\. Nothing has been deleted\.|was recorded and refused: open work remains\.)/);
	await captureEvidence(page, testInfo, "factory-services-purge-request");
	// Nothing was deleted: the run is still readable.
	expect((await page.request.get(`/api/factories/projects/${encodeURIComponent(state.projectId)}/runs/${runId}`)).status()).toBe(200);
});
