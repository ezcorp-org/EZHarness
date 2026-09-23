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
 *   6. previews a quarantine's reach, and records a purge request;
 *   7. round 2: a run waiting on an approval streams live, a service reader's
 *      stream closes as revoked, and the approval is decided in the inbox;
 *      grant expiry and revocation; a download ticket rechecked; a shared
 *      artifact carries no authority on its source; a draft a newer server
 *      wrote is read-only and exports; long labels and a large map at 1440
 *      and 390 px in light and dark; no console error in any journey.
 *
 * Two deployment facts are the stack's, and it says so in its record: the v4
 * installation record of the guest release, and the package PREPARATION once
 * the console has trusted it (no product route or role prepares a package).
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { APIRequestContext, Browser, Page } from "@playwright/test";
import { expect, test } from "./fixtures/hydration.js";
import { captureEvidence } from "./fixtures/evidence.js";
import { factoryLayoutOverflow } from "./fixtures/factory-layout.js";
import { FACTORY_SERVICES_CURSOR_TTL_MS, FACTORY_SERVICES_FUTURE_DRAFT_REQUEST_PATH, FACTORY_SERVICES_STATE_PATH, readFactoryServicesState, type FactoryServicesState } from "./factory-services/state.js";

test.describe.configure({ mode: "serial" });

let state: FactoryServicesState;
let runId = "";

test.beforeAll(() => { state = readFactoryServicesState(); });

// No journey may log a script error. A refused request the page makes on purpose is a network
// line ("Failed to load resource"), not a script error, and is named by its own assertions.
const consoleErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
	const errors: string[] = [];
	consoleErrors.set(page, errors);
	page.on("console", message => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(message.text()); });
	page.on("pageerror", error => errors.push(error.message));
});
test.afterEach(({ page }) => { expect(consoleErrors.get(page) ?? []).toEqual([]); });

const project = (id = state.projectId) => `/api/factories/projects/${encodeURIComponent(id)}`;
const once = (label: string) => `w14-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
/** A whole-second expiry `seconds` from now, as service grants and credentials require. */
const expiresIn = (seconds: number) => Math.floor((Date.now() + seconds * 1_000) / 1_000) * 1_000;

async function mutate(request: APIRequestContext, method: "POST" | "PUT" | "DELETE", path: string, revision: number, data?: unknown, key = once("mutation")) {
	return request.fetch(path, { method, headers: { "If-Match": String(revision), "Idempotency-Key": key }, ...(data === undefined ? {} : { data }) });
}

/** A project service account, a read credential, and optionally a factory.run grant that makes it a member. */
async function serviceReader(page: Page, projectId: string, name: string, grantSeconds: number | null): Promise<{ accountId: string; token: string; grantRevision: number }> {
	const account = await page.request.post("/api/service-accounts", { data: { name, projectId, scopes: ["read"], maxTokensPerDay: 1_000 } });
	expect(account.status()).toBe(201);
	const accountId = ((await account.json()) as { account: { id: string } }).account.id;
	const issued = await mutate(page.request, "POST", `${project(projectId)}/service-accounts/${encodeURIComponent(accountId)}/credentials`, 0, { scopes: ["read"], expiresAtMs: expiresIn(600) });
	expect(issued.status(), await issued.text()).toBe(200);
	const token = ((await issued.json()) as { token: string }).token;
	let grantRevision = 0;
	if (grantSeconds !== null) {
		const granted = await mutate(page.request, "PUT", `${project(projectId)}/grants/service/${encodeURIComponent(accountId)}/factory.run`, 0, { expiresAtMs: expiresIn(grantSeconds) });
		expect(granted.status(), await granted.text()).toBe(200);
		grantRevision = ((await granted.json()) as { resource: { revision: number } }).resource.revision;
	}
	return { accountId, token, grantRevision };
}

async function bearer(playwright: { request: { newContext: (options: object) => Promise<APIRequestContext> } }, token: string): Promise<APIRequestContext> {
	return playwright.request.newContext({ baseURL: state.baseURL, extraHTTPHeaders: { Authorization: `Bearer ${token}` }, storageState: { cookies: [], origins: [] } });
}

/** The sequences of the run events one event-stream read returns, in order. */
function streamSequences(text: string): number[] {
	return [...text.matchAll(/event: factory:run-event\ndata: (\{.*\})/g)].map(match => (JSON.parse(match[1]!) as { sequence: number }).sequence);
}

let earlyCursor = { token: "", sequence: 0, takenAtMs: 0 };

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

test("a save racing a publish leaves one consistent winner; in either fixed order a replayed key answers the same and a reused key is refused", async ({ page }) => {
	const definition = `${project()}/definitions/${encodeURIComponent(state.consoleFactoryId)}`;
	const readDraft = async () => (await (await page.request.get(definition)).json() as { resource: { revision: number; source: Record<string, unknown> } }).resource;
	const save = (revision: number, version: string, key: string, draftSource: Record<string, unknown>) => mutate(page.request, "PUT", definition, revision, { source: { ...draftSource, version } }, key);
	const publish = (revision: number, version: string, key: string) => mutate(page.request, "POST", `${definition}/versions`, revision, { version }, key);
	const draft = await readDraft();

	// The race: both on one revision. Whoever wins, the published bytes are the revision the publish named.
	const prepared = await save(draft.revision, "1.1.0", once("race-base"), draft.source);
	expect(prepared.status()).toBe(200);
	const base = (await prepared.json() as { resource: { revision: number } }).resource;
	const [raced, racedPublish] = await Promise.all([save(base.revision, "1.1.1", once("race-save"), draft.source), publish(base.revision, "1.1.0", once("race-publish"))]);
	for (const status of [raced.status(), racedPublish.status()]) expect([200, 409, 412]).toContain(status);
	expect([raced.status(), racedPublish.status()].some(status => status === 200)).toBe(true);
	const racedVersion = await page.request.get(`${definition}/versions/1.1.0`);
	if (racedPublish.status() === 200) expect((await racedVersion.json() as { resource: { draftRevision: number; source: { version: string } } }).resource).toMatchObject({ draftRevision: base.revision, source: { version: "1.1.0" } });
	else expect(racedVersion.status()).toBe(404);

	// Save first, then publish at the revision the save replaced: the publish is stale.
	const first = await readDraft();
	const saveKey = once("save-first");
	const saved = await save(first.revision, "2.0.0", saveKey, first.source);
	expect(saved.status()).toBe(200);
	const savedRevision = (await saved.json() as { resource: { revision: number } }).resource.revision;
	expect([409, 412]).toContain((await publish(first.revision, "2.0.0", once("stale-publish"))).status());
	const replayedSave = await save(first.revision, "2.0.0", saveKey, first.source);
	expect(replayedSave.status()).toBe(200);
	expect((await replayedSave.json() as { resource: { revision: number } }).resource.revision).toBe(savedRevision);
	const reusedSave = await save(first.revision, "2.0.9", saveKey, first.source);
	expect(reusedSave.status()).toBe(409);
	expect((await reusedSave.json() as { error: { code: string } }).error.code).toBe("idempotency_conflict");

	// Publish first, then save at the revision the publish named: the published bytes never move.
	const second = await readDraft();
	expect(second.source.version).toBe("2.0.0");
	const publishKey = once("publish-first");
	const published = await publish(second.revision, "2.0.0", publishKey);
	expect(published.status(), await published.text()).toBe(200);
	const version = (await published.json() as { resource: { version: string; draftRevision: number; definitionDigest: string } }).resource;
	expect(version).toMatchObject({ version: "2.0.0", draftRevision: second.revision });
	const later = await save(second.revision, "2.0.1", once("save-after-publish"), second.source);
	expect([200, 409, 412]).toContain(later.status());
	expect((await (await page.request.get(`${definition}/versions/2.0.0`)).json() as { resource: { definitionDigest: string; source: { version: string } } }).resource).toMatchObject({ definitionDigest: version.definitionDigest, source: { version: "2.0.0" } });
	const replayedPublish = await publish(second.revision, "2.0.0", publishKey);
	expect(replayedPublish.status()).toBe(200);
	expect((await replayedPublish.json() as { resource: { definitionDigest: string } }).resource.definitionDigest).toBe(version.definitionDigest);
	const reusedPublish = await publish(second.revision, "9.9.9", publishKey);
	expect(reusedPublish.status()).toBe(409);
	expect((await reusedPublish.json() as { error: { code: string } }).error.code).toBe("idempotency_conflict");
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
	await start.getByRole("button", { name: "Start run", exact: true }).click();
	const queued = start.getByRole("status");
	await expect(queued).toContainText("is queued. Acceptance is not the same as a started run.");
	await captureEvidence(page, testInfo, "factory-services-run-start");
	runId = (await queued.locator("code").textContent())!.trim();
	// A cursor from the first snapshot, to catch up from after the run ends.
	const early = await (await page.request.get(`${project()}/runs/${runId}/inspection`)).json() as { resource: { cursor: { token: string; sequence: number } } };
	earlyCursor = { ...early.resource.cursor, takenAtMs: Date.now() };
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
	// The list row follows the finished snapshot; it never keeps an older status.
	const finalStatus = ((await inspector.getByText(/^Run · /).textContent()) ?? "").replace("Run · ", "").trim();
	await expect(inspector.getByRole("button", { name: new RegExp(runId) })).toContainText(finalStatus);
	expect(await factoryLayoutOverflow(page)).toEqual([]);
	await captureEvidence(page, testInfo, "factory-services-run-finished");
	await page.setViewportSize({ width: 390, height: 844 });
	expect(await factoryLayoutOverflow(page)).toEqual([]);
	await captureEvidence(page, testInfo, "factory-services-run-finished-narrow");
	await page.setViewportSize({ width: 1440, height: 900 });
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

	// Catch-up: the early cursor resumes with every later event, contiguous, and a reconnect with it repeats none.
	const events = `${project()}/runs/${runId}/events?cursor=${encodeURIComponent(earlyCursor.token)}`;
	const firstRead = streamSequences(await (await page.request.get(events)).text());
	expect(firstRead.length).toBeGreaterThan(0);
	expect(firstRead).toEqual(firstRead.map((_, index) => earlyCursor.sequence + 1 + index));
	expect(streamSequences(await (await page.request.get(events)).text())).toEqual(firstRead);
	// The same cursor past its lifetime is 410, and the client takes a new snapshot.
	await page.waitForTimeout(Math.max(0, earlyCursor.takenAtMs + FACTORY_SERVICES_CURSOR_TTL_MS + 1_000 - Date.now()));
	const expired = await page.request.get(events);
	expect(expired.status()).toBe(410);
	expect((await expired.json() as { error: { code: string } }).error.code).toBe("factory_cursor_expired");
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

	// The registered validator material of a version: read authority, a named query, a plain 404 when
	// none is registered. (No production path registers material yet; the gate file records it.)
	const materials = `${base}/validator-materials`;
	const noMaterial = await page.request.get(`${materials}?factoryId=${encodeURIComponent(state.consoleFactoryId)}&factoryVersion=1.0.0`);
	expect(noMaterial.status()).toBe(404);
	expect((await noMaterial.json() as { error: { code: string } }).error.code).toBe("factory_material_not_found");
	const badQuery = await page.request.get(`${materials}?factoryId=${encodeURIComponent(state.consoleFactoryId)}`);
	expect(badQuery.status()).toBe(400);
	expect((await badQuery.json() as { error: { code: string } }).error.code).toBe("factory_material_query_invalid");

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
	const account = await page.request.post("/api/service-accounts", { data: { name: "w14-reader", projectId: state.projectId, scopes: ["read"], maxTokensPerDay: 1_000 } });
	expect(account.status()).toBe(201);
	const accountId = ((await account.json()) as { account: { id: string } }).account.id;
	// A credential expires on a whole second, and within the service credential bound.
	const expiresAtMs = Math.floor((Date.now() + 5 * 60_000) / 1_000) * 1_000;
	const issued = await page.request.post(`${base}/service-accounts/${encodeURIComponent(accountId)}/credentials`, { headers: { "If-Match": "0", "Idempotency-Key": `w14-credential-${Date.now()}` }, data: { scopes: ["read"], expiresAtMs } });
	expect(issued.status(), await issued.text()).toBe(200);
	const credential = (await issued.json()) as { token: string; resource: { credentialId: string; revision: number } };
	const serviceToken = credential.token;
	const service = await playwright.request.newContext({ baseURL: state.baseURL, extraHTTPHeaders: { Authorization: `Bearer ${serviceToken}` }, storageState: { cookies: [], origins: [] } });
	try {
		// Without a factory grant the service is not a member: a real run and a missing run answer alike.
		expect((await service.get(`${base}/runs/${runId}/inspection`)).status()).toBe(403);
		expect((await service.get(`${base}/runs/run-that-does-not-exist/inspection`)).status()).toBe(403);
		const granted = await page.request.put(`${base}/grants/service/${encodeURIComponent(accountId)}/factory.run`, { headers: { "If-Match": "0", "Idempotency-Key": `w14-service-grant-${Date.now()}` }, data: { expiresAtMs } });
		expect(granted.status(), await granted.text()).toBe(200);
		// With one, its own project reads exactly, and a run that does not exist is a plain 404.
		expect((await service.get(`${base}/runs/${runId}/inspection`)).status()).toBe(200);
		expect((await service.get(`${base}/runs/run-that-does-not-exist/inspection`)).status()).toBe(404);
		const foreign = await service.get(`/api/factories/projects/${encodeURIComponent(state.readerProjectId)}/packages`);
		expect(foreign.status()).toBe(403);
		expect([401, 403]).toContain((await service.post(`${base}/runs/${runId}/artifacts/${encodeURIComponent(artifact.artifactId)}/shares`, { headers: { "If-Match": "0", "Idempotency-Key": "w14-service-share" }, data: { targetProjectId: state.readerProjectId, mediaType: "application/json" } })).status());
		// Revocation takes effect on the next request.
		const revoked = await page.request.delete(`${base}/service-accounts/${encodeURIComponent(accountId)}/credentials/${encodeURIComponent(credential.resource.credentialId)}`, { headers: { "If-Match": String(credential.resource.revision), "Idempotency-Key": `w14-revoke-${Date.now()}` } });
		expect(revoked.status(), await revoked.text()).toBe(200);
		expect([401, 403]).toContain((await service.get(`${base}/runs/${runId}/inspection`)).status());
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
	// A reader the share was made for gets those bytes and nothing that acts on the source.
	const reader = await serviceReader(page, state.readerProjectId, "w14-shared-reader", 600);
	const readerApi = await bearer(playwright, reader.token);
	try {
		const sharedPath = `${readerBase}/shared-artifacts/${encodeURIComponent(artifact.artifactId)}?digest=${encodeURIComponent(artifact.digest)}&encodedBytes=${artifact.encodedBytes}&mediaType=application%2Fjson`;
		expect((await readerApi.get(sharedPath)).status()).toBe(200);
		expect((await readerApi.get(`${base}/runs/${runId}/inspection`)).status()).toBe(403);
		expect((await readerApi.post(`${base}/runs/${runId}/artifacts/${encodeURIComponent(artifact.artifactId)}/ticket`)).status()).toBe(403);
		expect([401, 403]).toContain((await readerApi.fetch(`${base}/release/trust`, { method: "PUT", headers: { "If-Match": "0", "Idempotency-Key": once("reader-release") }, data: { packageLock: state.guest.reference, validatorTrustDigest: `sha256:${"1".repeat(64)}` } })).status());
		expect((await readerApi.get(`${base}/validator-materials?factoryId=${encodeURIComponent(state.consoleFactoryId)}&factoryVersion=1.0.0`)).status()).toBe(403);
	} finally {
		await readerApi.dispose();
	}
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

/** Imports, publishes, and returns the published version of a definition built from the console definition. */
async function publishDefinition(page: Page, edit: (definition: Record<string, unknown>) => Record<string, unknown>): Promise<{ id: string; version: string; definitionDigest: string }> {
	const definition = edit(JSON.parse(readFileSync(state.definitionPath, "utf8")) as Record<string, unknown>);
	const imported = await mutate(page.request, "POST", `${project()}/definitions/import`, 0, { format: "json", source: JSON.stringify(definition) });
	expect(imported.status(), await imported.text()).toBe(200);
	const draft = (await imported.json() as { resource: { factoryId: string; revision: number } }).resource;
	const published = await mutate(page.request, "POST", `${project()}/definitions/${encodeURIComponent(draft.factoryId)}/versions`, draft.revision, { version: definition.version });
	expect(published.status(), await published.text()).toBe(200);
	const version = (await published.json() as { resource: { version: string; definitionDigest: string } }).resource;
	return { id: draft.factoryId, ...version };
}

async function runGrantRevision(page: Page): Promise<number> {
	const grants = await (await page.request.get(`${project()}/grants?principalKind=user&action=factory.run`)).json() as { page: { items: Array<{ principalId: string; revision: number }> } };
	return grants.page.items.find(item => item.principalId === state.adminId)!.revision;
}

test("a run waiting on an approval streams live; a revoked reader's stream closes as revoked; the inbox decides the approval @evidence", async ({ page, browser }, testInfo) => {
	const approvalFactory = await publishDefinition(page, definition => {
		const graph = definition.graph as { nodes: Array<Record<string, unknown>> };
		return {
			...definition, id: "factory-services.approval.v1",
			graph: { ...graph, nodes: [
				{ id: "gate", kind: "approval", choices: ["approve", "deny"], context: { kind: "ref", root: "input", name: "message" }, actorScope: "operator", expiresInMs: 3_600_000, onDenied: "fail", onExpired: "fail" },
				...graph.nodes.map(node => ({ ...node, dependsOn: ["gate"] })),
			] },
		};
	});
	const started = await mutate(page.request, "POST", `${project()}/definitions/${encodeURIComponent(approvalFactory.id)}/runs`, 0, {
		factoryVersion: approvalFactory.version, definitionDigest: approvalFactory.definitionDigest, grantRevision: await runGrantRevision(page),
		parameters: { message: { kind: "inline", value: "approve this candidate" } },
	});
	expect(started.status(), await started.text()).toBe(202);
	const waitingRun = (await started.json() as { receipt: { resourceId: string } }).receipt.resourceId;
	const inspection = `${project()}/runs/${waitingRun}/inspection`;
	// The run stays live while its approval node waits; the approval shows as a blocker.
	await expect.poll(async () => (await (await page.request.get(inspection)).json() as { resource: { blockers: Array<{ kind: string }> } }).resource.blockers.map(item => item.kind), { timeout: 120_000, intervals: [1_000] }).toContain("approval");

	// The console shows the live run and what it waits on.
	await page.goto(`/factories?view=runs&run=${encodeURIComponent(waitingRun)}`);
	await page.getByLabel("Factory project").selectOption(state.projectId);
	const inspector = page.getByTestId("factory-run-inspector");
	await expect(page.getByTestId("factory-stream-state")).toContainText("Live");
	await expect(inspector.getByText(/approval/i).first()).toBeVisible();
	await captureEvidence(page, testInfo, "factory-services-run-waiting");

	// A service reader streams the same run from a clean browser context; revoking its grant ends the stream.
	const reader = await serviceReader(page, state.projectId, "w14-stream-reader", 600);
	const cursor = (await (await page.request.get(inspection)).json() as { resource: { cursor: { token: string } } }).resource.cursor.token;
	const readerContext = await (browser as Browser).newContext({ storageState: { cookies: [], origins: [] } });
	try {
		const readerPage = await readerContext.newPage();
		await readerPage.goto(`${state.baseURL}/api/ready`);
		const streamed = readerPage.evaluate(async ({ url, token }) => {
			const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
			const reader = response.body!.getReader();
			const decoder = new TextDecoder();
			let text = `status ${response.status}\n`;
			const deadline = Date.now() + 60_000;
			while (Date.now() < deadline && !text.includes("factory:stream-closed")) {
				const chunk = await reader.read();
				if (chunk.done) break;
				text += decoder.decode(chunk.value);
			}
			return text;
		}, { url: `${project()}/runs/${waitingRun}/events?cursor=${encodeURIComponent(cursor)}`, token: reader.token });
		await page.waitForTimeout(2_500);
		const revoked = await mutate(page.request, "DELETE", `${project()}/grants/service/${encodeURIComponent(reader.accountId)}/factory.run`, reader.grantRevision);
		expect(revoked.status(), await revoked.text()).toBe(200);
		const text = await streamed;
		expect(text).toContain("status 200");
		expect(text).toContain('event: factory:stream-closed\ndata: {"reason":"revoked"}');
	} finally {
		await readerContext.close();
	}

	// The inbox decides the approval, and the run leaves the waiting state.
	await selectProject(page, "inbox");
	const request = page.locator("article", { hasText: "Factory approval requested" }).filter({ hasText: "approve this candidate" });
	await expect(request).toBeVisible();
	await captureEvidence(page, testInfo, "factory-services-approval-inbox");
	await request.getByRole("button", { name: "approve" }).click();
	await expect(request).toHaveCount(0);
	await expect.poll(async () => (await (await page.request.get(inspection)).json() as { resource: { blockers: Array<{ kind: string }> } }).resource.blockers.map(item => item.kind), { timeout: 180_000, intervals: [1_000] }).not.toContain("approval");
});

test("grant expiry and revocation take effect on the next request, and a download ticket rechecks them", async ({ page, playwright }) => {
	const reader = await serviceReader(page, state.projectId, "w14-expiring-reader", 8);
	const readerApi = await bearer(playwright, reader.token);
	try {
		const inspection = `${project()}/runs/${runId}/inspection`;
		expect((await readerApi.get(inspection)).status()).toBe(200);
		const view = await (await readerApi.get(inspection)).json() as { resource: { artifacts: { items: Array<{ artifactId: string }> } } };
		const artifactId = view.resource.artifacts.items[0]!.artifactId;
		const ticket = await readerApi.post(`${project()}/runs/${runId}/artifacts/${encodeURIComponent(artifactId)}/ticket`);
		expect(ticket.status()).toBe(200);
		const url = ((await ticket.json()) as { ticket: { url: string } }).ticket.url;
		// The grant expires; the next read, and the ticket's download, are refused.
		await expect.poll(async () => (await readerApi.get(inspection)).status(), { timeout: 30_000, intervals: [1_000] }).toBe(403);
		expect((await readerApi.get(url)).status()).toBe(403);

		// The console grants it again, with an expiry, and then revokes it.
		await selectProject(page, "admin");
		const admin = page.getByTestId("factory-administration");
		const form = admin.getByRole("form", { name: "Grant factory authority" });
		await form.getByLabel("Principal").selectOption("service");
		await form.getByLabel("Identifier").fill(reader.accountId);
		await form.getByLabel("Action").selectOption("factory.run");
		const inAnHour = new Date(Date.now() + 3_600_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
		await form.getByLabel(/Expires/).fill(inAnHour);
		await form.getByRole("button", { name: "Grant" }).click();
		await expect(admin.getByRole("status")).toContainText(`factory.run granted to service ${reader.accountId}`);
		expect((await readerApi.get(inspection)).status()).toBe(200);
		await admin.getByRole("button", { name: `Revoke factory.run for ${reader.accountId}` }).click();
		await expect(admin.getByRole("status")).toContainText(`factory.run revoked for service ${reader.accountId}.`);
		expect((await readerApi.get(inspection)).status()).toBe(403);
	} finally {
		await readerApi.dispose();
	}
});

test("a draft a newer server wrote opens read-only in the console and still exports its exact bytes @evidence", async ({ page }, testInfo) => {
	const definition = { ...(JSON.parse(readFileSync(state.definitionPath, "utf8")) as Record<string, unknown>), id: "factory-services.future.v1" };
	const imported = await mutate(page.request, "POST", `${project()}/definitions/import`, 0, { format: "json", source: JSON.stringify(definition) });
	expect(imported.status(), await imported.text()).toBe(200);
	writeFileSync(FACTORY_SERVICES_FUTURE_DRAFT_REQUEST_PATH, "factory-services.future.v1");
	await expect.poll(() => (JSON.parse(readFileSync(FACTORY_SERVICES_STATE_PATH, "utf8")) as { futureDraftId?: string }).futureDraftId, { timeout: 30_000, intervals: [500] }).toBe("factory-services.future.v1");
	const refused = await page.request.get(`${project()}/definitions/factory-services.future.v1`);
	expect(refused.status()).toBe(409);
	expect((await refused.json() as { error: { code: string } }).error.code).toBe("factory_definition_version_unsupported");
	await selectProject(page, "authoring");
	const console = page.getByTestId("factory-console");
	await console.getByRole("button", { name: /factory-services\.future\.v1/ }).click();
	await expect(console.getByRole("note")).toContainText("cannot edit");
	await expect(console.getByLabel("Stored definition source")).toHaveValue(/"schemaVersion": ?"factory\.v9"/);
	await expect(console.getByRole("button", { name: "Save" })).toHaveCount(0);
	await captureEvidence(page, testInfo, "factory-services-read-only-draft");
	const download = page.waitForEvent("download");
	await console.getByRole("button", { name: "Export JSON" }).click();
	const saved = await (await download).path();
	expect(readFileSync(saved!, "utf8")).toContain('"factory.v9"');
});

test("long labels and a large map read cleanly at 1440 and 390 px, in light and dark @evidence", async ({ page }, testInfo) => {
	const longId = "factory-services.a-deliberately-long-definition-label-that-must-wrap-without-overflowing.v1";
	await publishDefinition(page, definition => {
		const graph = definition.graph as { nodes: Array<Record<string, unknown>> };
		const template = graph.nodes[0]!;
		const nodes = Array.from({ length: 40 }, (_, index) => ({ ...template, id: `stage-${String(index).padStart(2, "0")}-${"with-a-long-node-label-".repeat(2)}${index}`, ...(index === 0 ? {} : { dependsOn: [`stage-${String(index - 1).padStart(2, "0")}-${"with-a-long-node-label-".repeat(2)}${index - 1}`] }) }));
		return { ...definition, id: longId, graph: { ...graph, nodes }, bounds: { ...(definition.bounds as object), maxExpandedNodes: 100 } };
	});
	for (const [theme, width, height] of [["light", 1440, 900], ["dark", 390, 844]] as const) {
		await page.addInitScript(value => localStorage.setItem("ezcorp-theme", value), theme);
		await page.setViewportSize({ width, height });
		await selectProject(page, "authoring");
		const console = page.getByTestId("factory-console");
		await console.getByRole("button", { name: /a-deliberately-long-definition-label/ }).click();
		await expect(console.getByRole("heading", { name: longId })).toBeVisible();
		await expect(page.getByTestId("factory-graph")).toBeVisible();
		expect(await factoryLayoutOverflow(page)).toEqual([]);
		await captureEvidence(page, testInfo, `factory-services-large-map-${width}-${theme}`);
		await page.goto(`/factories?view=runs&run=${encodeURIComponent(runId)}`);
		await page.getByLabel("Factory project").selectOption(state.projectId);
		await expect(page.getByTestId("factory-stream-state")).toBeVisible();
		expect(await factoryLayoutOverflow(page)).toEqual([]);
		await captureEvidence(page, testInfo, `factory-services-run-${width}-${theme}`);
	}
});
