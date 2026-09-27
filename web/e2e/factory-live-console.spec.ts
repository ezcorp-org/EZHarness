/**
 * The live factory console, rendered against a scripted API (mock tier).
 *
 * This spec pins the console's visual and keyboard behaviour: the run
 * inspector with a large attempt map, the stream badge, hostile artifact
 * previews, and package administration with an affected-run review, at 1440
 * and 390 pixels, light and dark, with reduced motion. The
 * same journeys run against the real application in the `factory-services`
 * lane (`factory-services-console.spec.ts`); nothing here stands in for that.
 */
import { crc32, deflateSync } from "node:zlib";
import type { Page, Route } from "@playwright/test";
import type {
	FactoryApiResponse,
	FactoryArtifactResource,
	FactoryAttemptResource,
	FactoryPackageResource,
	FactoryRunInspection,
	FactoryRunSummary,
} from "@ezcorp/factory-sdk/types";
import { expect, test, captureEvidence } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";
import { factoryLayoutOverflow } from "./fixtures/factory-layout.js";

const projectId = "factory-live-project";
const digest = (fill: string) => `sha256:${fill.repeat(64)}`;
const longFactory = "catalog-enrichment-with-a-deliberately-long-definition-name-for-layout";
/** A real gradient PNG, built here, so the preview decodes and re-encodes actual pixels. */
function gradientPng(width: number, height: number): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
		const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8);
	const rows = Buffer.alloc((width * 3 + 1) * height);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows.set([40 + Math.round(180 * x / width), 90 + Math.round(120 * y / height), 220], y * (width * 3 + 1) + 1 + x * 3);
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
const PNG_GRADIENT = gradientPng(96, 48);

/** A run the user stopped while two of its releases were in flight (W09e). */
const STOPPED_RUN = "run-stopped-during-release";
const RELEASE_DEADLINE_MS = 1_900_000_000_000;

function runStatus(runId: string): FactoryRunSummary["status"] {
	return runId === "run-finished" ? "succeeded" : runId === "run-failed" ? "failed" : runId === STOPPED_RUN ? "cancelled" : "running";
}

/** The definition each listed run belongs to, the same in the list, the run read and the inspection. */
function factoryOf(runId: string): string {
	return ({ "run-finished": "nightly-inventory-refresh", "run-failed": "image-thumbnails", [STOPPED_RUN]: "catalog-publisher" } as Record<string, string>)[runId] ?? longFactory;
}

function runSummary(runId: string, status: FactoryRunSummary["status"], factoryId = factoryOf(runId)): FactoryRunSummary {
	return { runId, factoryId, factoryVersion: "2.4.0", definitionDigest: digest("a"), grantRevision: 3, revision: 7, status, createdAtMs: 1_789_000_000_000, updatedAtMs: 1_789_000_100_000 };
}

function attempts(count: number, offset = 0): FactoryAttemptResource[] {
	return Array.from({ length: count }, (_, index) => {
		const n = index + offset;
		return {
			attemptId: `attempt-${String(n).padStart(4, "0")}`, nodeInstanceId: `normalize-partition-${String(Math.floor(n / 3)).padStart(3, "0")}-of-the-inventory-catalog`,
			attemptNumber: (n % 3) + 1, candidateGeneration: n % 2, status: n % 7 === 0 ? "failed" : n % 5 === 0 ? "running" : "completed",
			startedAtMs: 1_789_000_000_000 + n, updatedAtMs: 1_789_000_000_500 + n, ...(n % 7 === 0 ? {} : { resultDigest: digest("b") }),
		};
	});
}

const ARTIFACTS: FactoryArtifactResource[] = [
	{ artifactId: "artifact-report", kind: "candidate_output", digest: digest("c"), encodedBytes: 1_280, nodeInstanceId: "summarize-the-quality-report-for-the-release-reviewers", createdAtMs: 1 },
	{ artifactId: "artifact-markup", kind: "candidate_output", digest: digest("d"), encodedBytes: 96, nodeInstanceId: "render-hostile-markup", createdAtMs: 2 },
	{ artifactId: "artifact-chart", kind: "material", digest: digest("e"), encodedBytes: PNG_GRADIENT.byteLength, nodeInstanceId: "plot-coverage", createdAtMs: 3 },
];
const ARTIFACT_BYTES: Record<string, { body: Buffer }> = {
	"artifact-report": { body: Buffer.from(JSON.stringify({ summary: "4 of 5 claims passed", failing: ["tests-pass"], note: "<script>alert('x')</script>" })) },
	"artifact-markup": { body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(document.cookie)</script></svg>') },
	"artifact-chart": { body: PNG_GRADIENT },
};

function inspection(runId: string, status: FactoryRunSummary["status"]): FactoryRunInspection {
	return {
		run: { ...runSummary(runId, status), parameters: { market: { kind: "inline", value: "eu-west" } }, ...(status === "failed" ? { error: { code: "factory_acceptance_rejected", message: "The candidate did not satisfy the release contract." } } : {}) },
		cursor: { token: `cursor-${runId}`, sequence: 41, expiresAtMs: 1_900_000_000_000 },
		projectionLag: 0,
		children: { items: [{ runId: "run-child-inventory-sync-with-a-long-identifier", factoryId: "inventory-sync-child-factory", factoryVersion: "1.3.0", state: "open", status: "running", deadlineMs: 1_900_000_000_000 }] },
		attempts: { items: attempts(50), nextCursor: "attempts-page-2" },
		artifacts: { items: ARTIFACTS },
		// A stopped run waits on nothing; its releases say what they did instead.
		blockers: status === "cancelled" ? [] : [
			{ kind: "approval", id: "approval-ship", nodeInstanceId: "approve-the-release-candidate", reason: "Waiting for an approval decision", sinceMs: 1 },
			{ kind: "release", id: "operation-catalog", nodeInstanceId: "publish-catalog", reason: "Release outcome is uncertain and needs reconciliation", sinceMs: 2 },
		],
		costs: status === "cancelled" ? {
			// Stopped releases: one held at its bound until its effect is known, one charged at the bound, one proven free.
			limitMicros: "25000000", allocatedMicros: "12500000", spentMicros: "9870000", knownCostMicros: "14070000", unknownCostMicros: "4200000", admissionBlocked: false, uncertain: true,
			releases: [
				{ operationId: "operation-catalog-archive", nodeInstanceId: "archive-catalog", state: "settled", costMicros: "0", source: "proven-no-effect", basis: "proven: the provider shows no publication and the sender is stopped" },
				{ operationId: "operation-catalog-mirror", nodeInstanceId: "mirror-catalog-to-the-secondary-region", state: "settled", costMicros: "4200000", source: "reserved-bound", basis: "bound: the provider reports no spend" },
				{ operationId: "operation-catalog-publish", nodeInstanceId: "publish-catalog", state: "held", costMicros: "4200000", hold: "operation-cost-unknown" },
			],
		} : { limitMicros: "25000000", allocatedMicros: "12500000", spentMicros: "9870000", knownCostMicros: "9870000", unknownCostMicros: "420000", admissionBlocked: false, uncertain: true },
		acceptance: [
			{ commandId: "cmd-accept-1", decision: "rejected", candidateDigest: digest("f"), reasons: [{ claimId: "tests-pass", validatorId: "validator.unit-tests", verdict: "FAIL", reasonCode: "TESTS_FAILED" }, { claimId: "coverage-at-least-ninety-percent-of-changed-lines", validatorId: "validator.coverage", verdict: "FAIL", reasonCode: "COVERAGE_BELOW_THRESHOLD" }], groupFailures: [{ groupId: "quality", passes: 1, minimumPasses: 2 }], decidedAtMs: 1 },
			{ commandId: "cmd-accept-2", decision: "accepted", candidateDigest: digest("9"), reasons: [], groupFailures: [], decidedAtMs: 2 },
		],
		releases: status === "cancelled" ? [
			{ operationId: "operation-catalog-publish", nodeInstanceId: "publish-catalog", state: "executing", action: "factory.release.publish", dispatchGeneration: 1, deadlineMs: RELEASE_DEADLINE_MS, stop: { requestedAtMs: 1_789_000_090_000, effect: "uncertain" } },
			{ operationId: "operation-catalog-mirror", nodeInstanceId: "mirror-catalog-to-the-secondary-region", state: "succeeded", action: "factory.release.publish", dispatchGeneration: 1, deadlineMs: RELEASE_DEADLINE_MS, stop: { requestedAtMs: 1_789_000_090_000, effect: "published" } },
			{ operationId: "operation-catalog-archive", nodeInstanceId: "archive-catalog", state: "failed", action: "factory.release.publish", dispatchGeneration: 1, outcomeCode: "stopped_no_effect", deadlineMs: RELEASE_DEADLINE_MS, stop: { requestedAtMs: 1_789_000_090_000, effect: "no_effect" } },
		] : [{ operationId: "operation-catalog", nodeInstanceId: "publish-catalog", state: "uncertain", action: "factory.release.publish", dispatchGeneration: 2, outcomeCode: "provider_timeout", deadlineMs: RELEASE_DEADLINE_MS }],
	};
}

const PACKAGES: FactoryPackageResource[] = [
	{ referenceId: "1".repeat(64), reference: { package: "@ezcorp/reference-code-runner-with-a-long-package-name", manifestName: "reference-code", version: "1.4.2", digest: digest("1"), export: "run" }, revision: 2, state: "active", installationId: "installation-1", releaseId: "release-1", boundAtMs: 1 },
	{ referenceId: "2".repeat(64), reference: { package: "@ezcorp/image-renderer", manifestName: "image-renderer", version: "0.9.0", digest: digest("2"), export: "render" }, revision: 3, state: "quarantined", installationId: "installation-1", releaseId: "release-2", boundAtMs: 2 },
	{ referenceId: "3".repeat(64), reference: { package: "@ezcorp/new-validator", manifestName: "new-validator", version: "0.1.0", digest: digest("3"), export: "validate" }, revision: 0, installationId: "installation-1", releaseId: "release-3", boundAtMs: 3 },
];

const envelope = (value: Record<string, unknown>): FactoryApiResponse => ({ schemaVersion: "factory.api.response.v1", ...value }) as FactoryApiResponse;
const sse = (frames: readonly string[]) => frames.join("");
const frame = (event: string, data: unknown, id?: string) => `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

interface Scenario { readonly revokeStream?: boolean }

async function routeConsole(page: Page, scenario: Scenario = {}) {
	const requests: Array<{ method: string; path: string; headers: Record<string, string>; body?: unknown }> = [];
	await page.route("**/api/factories/**", async (route: Route) => {
		const request = route.request();
		const url = new URL(request.url());
		const method = request.method();
		const body = request.postData() ? JSON.parse(request.postData()!) as unknown : undefined;
		requests.push({ method, path: url.pathname, headers: request.headers(), body });
		const json = (value: FactoryApiResponse, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
		const path = url.pathname;
		if (path.endsWith("/runs") && method === "GET") {
			return json(envelope({ kind: "run.page", page: { items: [runSummary("run-live-catalog", "running"), runSummary("run-finished", "succeeded"), runSummary("run-failed", "failed"), runSummary(STOPPED_RUN, "cancelled")] } }));
		}
		const runRead = /\/runs\/([^/]+)$/.exec(path);
		if (runRead && method === "GET") {
			return json(envelope({ kind: "run.details", resource: { ...runSummary(decodeURIComponent(runRead[1]!), "running"), parameters: {} } }));
		}
		const inspect = /\/runs\/([^/]+)\/inspection$/.exec(path);
		if (inspect) {
			const runId = decodeURIComponent(inspect[1]!);
			if (url.searchParams.get("section") === "attempts") {
				const search = url.searchParams.get("search");
				const items = search ? attempts(120).filter(item => item.nodeInstanceId.includes(search)) : attempts(50, 50);
				return json(envelope({ kind: "run.inspection.page", resource: { section: "attempts", page: search ? { items } : { items, nextCursor: url.searchParams.get("cursor") === "attempts-page-2" ? "attempts-page-3" : undefined } } }));
			}
			return json(envelope({ kind: "run.inspection", resource: inspection(runId, runStatus(runId)) }));
		}
		const events = /\/runs\/([^/]+)\/events$/.exec(path);
		if (events) {
			if (scenario.revokeStream) {
				return route.fulfill({ status: 200, contentType: "text/event-stream", body: sse([frame("factory:stream-closed", { reason: "revoked" })]) });
			}
			const event = (sequence: number) => frame("factory:run-event", { schemaVersion: "factory.run-event.v1", runId: "run", sequence, eventId: "7".repeat(64), payloadBytes: 188, payload: { kind: "node-completed" } }, `cursor-${sequence}`);
			return route.fulfill({ status: 200, contentType: "text/event-stream", body: sse([event(42), event(43), frame("factory:run-status", { status: decodeURIComponent(events[1]!) === STOPPED_RUN ? "cancelled" : "succeeded", sequence: 43, drained: true }, "cursor-43"), frame("factory:stream-closed", { reason: "drained" })]) });
		}
		const ticket = /\/runs\/([^/]+)\/artifacts\/([^/]+)\/ticket$/.exec(path);
		if (ticket) {
			const artifactId = decodeURIComponent(ticket[2]!);
			const bytes = ARTIFACT_BYTES[artifactId]!.body;
			return json(envelope({ kind: "artifact.ticket", ticket: { url: `/api/factories/projects/${projectId}/runs/${ticket[1]}/artifacts/${artifactId}/download?ticket=t`, expiresAtMs: 1_900_000_000_000, mediaType: "application/octet-stream", encodedBytes: bytes.byteLength } }));
		}
		const download = /\/artifacts\/([^/]+)\/download$/.exec(path);
		if (download) {
			return route.fulfill({ status: 200, headers: { "content-type": "application/octet-stream", "x-content-type-options": "nosniff", "content-disposition": "attachment" }, body: ARTIFACT_BYTES[decodeURIComponent(download[1]!)]!.body });
		}
		if (path.endsWith("/packages") && method === "GET") return json(envelope({ kind: "package.page", page: { items: PACKAGES } }));
		const impact = /\/packages\/([^/]+)\/impact$/.exec(path);
		if (impact) {
			const transition = url.searchParams.get("transition") as "publish" | "quarantine" | "revoke";
			const item = PACKAGES.find(candidate => candidate.referenceId === impact[1])!;
			const allowed = transition === "quarantine" ? item.state === "active" : transition === "revoke" ? item.state !== undefined && item.state !== "revoked" : item.state !== "revoked";
			return json(envelope({ kind: "package.impact", resource: { transition, currentRevision: item.revision, allowed, ...(allowed ? {} : { refusal: `The ${item.state ?? "untrusted"} package cannot take the ${transition} transition.` }), runs: allowed && transition !== "publish" ? [{ runId: "run-live-catalog", factoryId: longFactory, status: "running", liveAttempts: 2 }] : [], truncated: false } }));
		}
		if (/\/packages\/[^/]+\/affected-runs$/.test(path)) {
			const attempt = (runId: string, attemptId: string, disposition: string) => ({ runId, attemptId, attemptStatus: "running", launchState: "launched", trustRevision: Number(url.searchParams.get("trustRevision")), state: "quarantined", reason: "factory_package_quarantined", disposition, ...(disposition === "run-terminal" ? {} : { cancellationEventId: `cancel-${runId}` }), recordedAtMs: 1_900_000_000_000 });
			return json(envelope({ kind: "package.affected-runs", page: { items: [attempt("run-live-7f3a", "attempt-live-7f3a-1", "cancel-requested"), attempt("run-live-7f3a", "attempt-live-7f3a-2", "cancel-requested"), attempt("run-finished-c21", "attempt-finished-c21-1", "run-terminal")] } }));
		}
		const trust = /\/packages\/([^/]+)\/trust$/.exec(path);
		if (trust) {
			const item = PACKAGES.find(candidate => candidate.referenceId === trust[1])!;
			const transition = (body as { transition: string }).transition;
			return json(envelope({ kind: "package.resource", resource: { ...item, revision: item.revision + 1, state: transition === "publish" ? "active" : transition === "quarantine" ? "quarantined" : "revoked" } }));
		}
		if (path.endsWith("/grants") && method === "GET") {
			return json(envelope({ kind: "grant.page", page: { items: [
				{ principalKind: "user", principalId: "reviewer-with-a-very-long-member-identifier@example.com", action: "factory.approve", revision: 2, expiresAtMs: 1_900_000_000_000, revoked: false, displayName: "Reviewer with a very long display name from the operations team" },
				{ principalKind: "service", principalId: "nightly-scheduler", action: "factory.run", revision: 1, expiresAtMs: 1_900_000_000_000, revoked: false, displayName: "Nightly scheduler" },
				{ principalKind: "user", principalId: "former-operator", action: "factory.operate", revision: 3, expiresAtMs: null, revoked: true, displayName: "Former operator" },
			] } }));
		}
		return json(envelope({ kind: "error", error: { code: "factory_not_found", message: "No mock route", retryable: false } }), 404);
	});
	return { requests };
}

async function openRuns(page: Page, theme: "light" | "dark", width: number, scenario?: Scenario) {
	await page.addInitScript(value => localStorage.setItem("ezcorp-theme", value), theme);
	await page.setViewportSize({ width, height: width < 700 ? 844 : 1000 });
	const mocked = await routeConsole(page, scenario);
	await page.goto("/factories?view=runs");
	await expect(page.getByRole("tab", { name: "Runs" })).toHaveAttribute("aria-selected", "true");
	return mocked;
}

/** Evidence starts at the top: the app scrolls inside its own container, so reset every scrolled element. */
async function scrollToTop(page: Page): Promise<void> {
	await page.evaluate(() => { for (const element of document.querySelectorAll("*")) if (element.scrollTop > 0) element.scrollTop = 0; });
}

/**
 * No horizontal page overflow, and no text in the console that runs past the
 * viewport edge. A clipping ancestor hides the second kind from the first
 * check, so each visible element is measured; content inside a deliberate
 * horizontal scroller (the tab rail, the run strip, a wide table) is exempt.
 */

test.describe("factory live console", () => {
	for (const [theme, width] of [["light", 1440], ["dark", 1440], ["light", 390], ["dark", 390]] as const) {
		test(`inspects a run with a large attempt map at ${width}px in ${theme} @evidence`, async ({ page, mockApi }, testInfo) => {
			const errors: string[] = [];
			// Script errors, and any request the page made that the server refused, both by name.
			page.on("console", message => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(message.text()); });
			page.on("response", response => { if (response.status() >= 400) errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
			await mockApi({ projects: [makeProject({ id: projectId, name: "Product Operations with a long project name" })] });
			await openRuns(page, theme, width);
			const inspector = page.getByTestId("factory-run-inspector");
			await inspector.getByRole("button", { name: /run-live-catalog/ }).click();
			await expect(inspector.getByRole("heading", { level: 2, name: longFactory })).toBeVisible();
			await expect(page.getByTestId("factory-stream-state")).toContainText("Finished");
			await expect(page.getByTestId("factory-stream-state")).toContainText("sequence 43");
			await expect(inspector.getByText("Waiting for an approval decision")).toBeVisible();
			await expect(inspector.getByRole("table", { name: "Why candidates were rejected" })).toContainText("COVERAGE_BELOW_THRESHOLD");
			await expect(inspector.getByText("Some provider usage is not settled yet.")).toBeVisible();
			await inspector.getByRole("button", { name: "Load more attempts" }).click();
			await expect(inspector.getByRole("heading", { name: /Attempts/ })).toContainText("100+");
			expect(await factoryLayoutOverflow(page)).toEqual([]);
			await scrollToTop(page);
			await captureEvidence(page, testInfo, `factory-run-inspector-${width}-${theme}`);
			await inspector.getByRole("heading", { name: /Artifacts and evidence/ }).evaluate(element => element.scrollIntoView({ block: "center" }));
			await captureEvidence(page, testInfo, `factory-run-inspector-sections-${width}-${theme}`);
			expect(errors).toEqual([]);
		});
	}

	test("a run stopped during its releases shows what each release did and its deadline @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [makeProject({ id: projectId, name: "Product Operations" })] });
		await openRuns(page, "light", 1440);
		const inspector = page.getByTestId("factory-run-inspector");
		await inspector.getByRole("button", { name: new RegExp(STOPPED_RUN) }).click();
		await expect(inspector.getByRole("heading", { level: 2, name: "catalog-publisher" })).toBeVisible();
		const stops = inspector.getByTestId("factory-release-stop");
		await expect(stops).toHaveText([
			"Stopped during publish · effect uncertain · deadline 2030-03-17 17:46 UTC",
			"Stopped after publish · the release was published · deadline 2030-03-17 17:46 UTC",
			"Stopped before publish · nothing was published · deadline 2030-03-17 17:46 UTC",
		]);
		// The cost of each: settled at zero with its proof, settled at the bound, and held at the bound until known.
		const costs = inspector.getByTestId("factory-release-cost");
		await expect(costs).toHaveText([
			/archive-catalog\s*proven-no-effect · proven: the provider shows no publication and the sender is stopped\s*0\.0000/,
			/mirror-catalog-to-the-secondary-region\s*reserved-bound · bound: the provider reports no spend\s*4\.2000/,
			/publish-catalog\s*held at its bound · operation-cost-unknown\s*4\.2000/,
		]);
		await expect(costs.last()).toHaveAttribute("data-state", "held");
		await expect(stops.first()).toHaveAttribute("data-effect", "uncertain");
		await stops.first().evaluate(element => element.scrollIntoView({ block: "center" }));
		await captureEvidence(page, testInfo, "factory-run-stopped-release-1440-light");
		await page.setViewportSize({ width: 390, height: 844 });
		await expect(stops.last()).toBeVisible();
		expect(await factoryLayoutOverflow(page)).toEqual([]);
		await stops.last().evaluate(element => element.scrollIntoView({ block: "center" }));
		await captureEvidence(page, testInfo, "factory-run-stopped-release-390-light");
		await costs.first().evaluate(element => element.scrollIntoView({ block: "center" }));
		await captureEvidence(page, testInfo, "factory-run-stopped-release-costs-390-light");
	});

	test("filters attempts on the server and walks into a nested run and back", async ({ page, mockApi }) => {
		await mockApi({ projects: [makeProject({ id: projectId, name: "Product Operations" })] });
		const mocked = await openRuns(page, "light", 1440);
		const inspector = page.getByTestId("factory-run-inspector");
		await inspector.getByRole("button", { name: /run-live-catalog/ }).click();
		await inspector.getByLabel("Filter attempts by node").fill("partition-007");
		await inspector.getByRole("button", { name: "Apply attempt filter" }).click();
		await expect(inspector.getByRole("heading", { name: /Attempts/ })).toContainText("3");
		expect(mocked.requests.some(item => item.path.endsWith("/inspection") && item.method === "GET")).toBe(true);
		await inspector.getByRole("button", { name: "Open", exact: true }).click();
		await expect(inspector.getByRole("navigation", { name: "Parent runs" })).toBeVisible();
		await inspector.getByRole("button", { name: "Root run" }).click();
		await expect(inspector.getByRole("navigation", { name: "Parent runs" })).toHaveCount(0);
	});

	test("a revoked stream stops the view instead of showing stale status @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [makeProject({ id: projectId, name: "Product Operations" })] });
		await openRuns(page, "light", 1440, { revokeStream: true });
		const inspector = page.getByTestId("factory-run-inspector");
		await inspector.getByRole("button", { name: /run-live-catalog/ }).click();
		await expect(page.getByTestId("factory-stream-state")).toContainText("Access ended");
		await expect(inspector.getByRole("alert")).toContainText("Access to this run ended");
		await expect(inspector.getByRole("heading", { level: 2, name: "Run unavailable" })).toBeVisible();
		// Nothing from the snapshot survives the revocation.
		await expect(inspector.getByText("Waiting for an approval decision")).toHaveCount(0);
		await expect(inspector.getByRole("heading", { name: /Attempts/ })).toHaveCount(0);
		await captureEvidence(page, testInfo, "factory-run-inspector-revoked");
	});

	test("previews hostile artifacts only as escaped text or a re-encoded image @evidence", async ({ page, mockApi }, testInfo) => {
		const dialogs: string[] = [];
		page.on("dialog", dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
		await mockApi({ projects: [makeProject({ id: projectId, name: "Product Operations" })] });
		await openRuns(page, "dark", 1440);
		const inspector = page.getByTestId("factory-run-inspector");
		await inspector.getByRole("button", { name: /run-live-catalog/ }).click();
		await inspector.getByRole("button", { name: "Preview artifact-markup" }).click();
		const preview = page.getByTestId("factory-artifact-preview");
		await expect(preview.getByTestId("factory-artifact-text")).toContainText("<script>alert(document.cookie)</script>");
		await expect(preview.getByText("This is markup. It is shown as source and is never rendered.")).toBeVisible();
		expect(await preview.locator("svg script, script").count()).toBe(0);
		await captureEvidence(page, testInfo, "factory-artifact-preview-markup");
		await page.keyboard.press("Escape");
		await expect(preview).toHaveCount(0);
		await expect(inspector.getByRole("button", { name: "Preview artifact-markup" })).toBeFocused();
		await inspector.getByRole("button", { name: "Preview artifact-chart" }).click();
		const image = page.getByTestId("factory-artifact-preview").getByRole("img");
		await expect(image).toBeVisible();
		expect(await image.getAttribute("src")).toMatch(/^blob:/);
		await captureEvidence(page, testInfo, "factory-artifact-preview-image");
		await page.getByRole("button", { name: "Close artifact preview" }).click();
		await inspector.getByRole("button", { name: "Preview artifact-report" }).click();
		await expect(page.getByTestId("factory-artifact-text")).toContainText('"summary": "4 of 5 claims passed"');
		expect(dialogs).toEqual([]);
	});

	test("administers packages through an affected-run review and lists grants @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [makeProject({ id: projectId, name: "Product Operations" })] });
		await page.addInitScript(() => localStorage.setItem("ezcorp-theme", "light"));
		await page.setViewportSize({ width: 1440, height: 1200 });
		const mocked = await routeConsole(page);
		await page.goto("/factories?view=admin");
		const admin = page.getByTestId("factory-administration");
		await expect(admin.getByRole("heading", { name: "Runner packages" })).toBeVisible();
		await captureEvidence(page, testInfo, "factory-administration-1440-light");
		await admin.getByRole("group", { name: /reference-code-runner/ }).getByRole("button", { name: "Quarantine", exact: true }).click();
		const review = page.getByRole("dialog", { name: /Quarantine @ezcorp\/reference-code-runner/ });
		await expect(review).toContainText("1 live run use this package. New dispatch stops at once.");
		await expect(review).toContainText("2 live attempts");
		await captureEvidence(page, testInfo, "factory-package-quarantine-review");
		await review.getByRole("button", { name: "Commit at revision 2" }).click();
		await expect(admin.getByRole("status")).toContainText("quarantined at trust revision 3. The fence reached 2 runs.");
		const fenceRecord = admin.getByRole("region", { name: "Fence record" });
		await expect(fenceRecord.getByRole("listitem")).toHaveCount(3);
		await expect(fenceRecord).toContainText("already finished");
		expect(mocked.requests.find(item => item.path.endsWith("/affected-runs"))?.path).toBeTruthy();
		expect(await factoryLayoutOverflow(page)).toEqual([]);
		await captureEvidence(page, testInfo, "factory-package-fence-record");
		await page.setViewportSize({ width: 390, height: 844 });
		await fenceRecord.scrollIntoViewIfNeeded();
		expect(await factoryLayoutOverflow(page)).toEqual([]);
		await captureEvidence(page, testInfo, "factory-package-fence-record-390");
		await page.setViewportSize({ width: 1440, height: 1200 });
		const trust = mocked.requests.find(item => item.path.endsWith("/trust"));
		expect(trust?.headers["if-match"]).toBe("2");
		expect(trust?.headers["idempotency-key"]).toMatch(/^factory-console:package-quarantine:/);
		await admin.getByRole("group", { name: /image-renderer/ }).getByRole("button", { name: "Quarantine", exact: true }).click();
		const refused = page.getByRole("dialog", { name: /Quarantine @ezcorp\/image-renderer/ });
		await expect(refused.getByRole("alert")).toContainText("The quarantined package cannot take the quarantine transition.");
		await expect(refused.getByRole("button", { name: /Commit/ })).toBeDisabled();
		await page.keyboard.press("Escape");
		await refused.getByRole("button", { name: "Cancel" }).click();
		// The mock tier composes no factory application, so the tenant is unknown and the
		// console says so. The purge request journey runs against the real application.
		await expect(admin.getByRole("region", { name: "Tenant purge request" })).toContainText("Factory services are not ready");
	});

	test("administration is readable and non-destructive at 390px in dark @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [makeProject({ id: projectId, name: "Product Operations" })] });
		await page.addInitScript(() => localStorage.setItem("ezcorp-theme", "dark"));
		await page.setViewportSize({ width: 390, height: 844 });
		await routeConsole(page);
		await page.goto("/factories?view=admin");
		await expect(page.getByTestId("factory-administration").getByRole("heading", { name: "Project grants" })).toBeVisible();
		expect(await factoryLayoutOverflow(page)).toEqual([]);
		await captureEvidence(page, testInfo, "factory-administration-390-dark");
		await page.getByRole("heading", { name: "Project grants" }).evaluate(element => element.scrollIntoView({ block: "start" }));
		await captureEvidence(page, testInfo, "factory-administration-grants-390-dark");
	});

	test("is operable by keyboard alone, with reduced motion @evidence", async ({ page, mockApi }, testInfo) => {
		await page.emulateMedia({ reducedMotion: "reduce" });
		await mockApi({ projects: [makeProject({ id: projectId, name: "Product Operations" })] });
		await page.addInitScript(() => localStorage.setItem("ezcorp-theme", "light"));
		await page.setViewportSize({ width: 1440, height: 1000 });
		await routeConsole(page);
		await page.goto("/factories");
		const authoring = page.getByRole("tab", { name: "Authoring" });
		await authoring.focus();
		await page.keyboard.press("ArrowRight");
		await expect(page.getByRole("tab", { name: "Runs" })).toBeFocused();
		await expect(page).toHaveURL(/view=runs/);
		await page.keyboard.press("End");
		await expect(page.getByRole("tab", { name: "Administration" })).toBeFocused();
		await page.keyboard.press("Home");
		await page.keyboard.press("ArrowRight");
		const inspector = page.getByTestId("factory-run-inspector");
		const runButton = inspector.getByRole("button", { name: /run-live-catalog/ });
		await runButton.focus();
		await page.keyboard.press("Enter");
		await expect(page.getByTestId("factory-stream-state")).toContainText("Finished");
		const previewButton = inspector.getByRole("button", { name: "Preview artifact-report" });
		await previewButton.focus();
		await page.keyboard.press("Enter");
		await expect(page.getByRole("button", { name: "Close artifact preview" })).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(previewButton).toBeFocused();
		// The live pulse is the console's only continuous motion; with reduced motion it does not animate.
		const badge = page.getByTestId("factory-stream-state");
		await badge.evaluate(element => element.setAttribute("data-state", "live"));
		expect(await badge.locator(".pulse").evaluate(element => getComputedStyle(element).animationName)).toBe("none");
		await captureEvidence(page, testInfo, "factory-console-keyboard-reduced-motion");
	});
});
