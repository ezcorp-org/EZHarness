import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test as base, request as playwrightRequest, type Frame, type Page, type TestInfo } from "@playwright/test";

const BROWSER_COVERAGE = process.env.EZCORP_BROWSER_COVERAGE === "1";

type CoverageExpectedManifest = { routes: string[]; files: string[] };

/** The runner supplies this JSON from the fail-closed source inventory script.
 * It is intentionally absent for a small proof run; a final collection sets
 * it and conversion then requires every listed route and canonical source. */
function expectedCoverageManifest(raw: string | undefined): CoverageExpectedManifest | undefined {
	if (raw === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("browser coverage: EZCORP_BROWSER_COVERAGE_EXPECTED_MANIFEST must be JSON");
	}
	if (!parsed || typeof parsed !== "object") {
		throw new Error("browser coverage: expected manifest must be an object");
	}
	const candidate = parsed as Partial<CoverageExpectedManifest>;
	if (!Array.isArray(candidate.routes) || !Array.isArray(candidate.files)
		|| candidate.routes.some((path) => typeof path !== "string")
		|| candidate.files.some((path) => typeof path !== "string")) {
		throw new Error("browser coverage: expected manifest must contain string routes and files arrays");
	}
	return { routes: candidate.routes, files: candidate.files };
}

const browserCoverageExpectedManifest = BROWSER_COVERAGE
	? expectedCoverageManifest(process.env.EZCORP_BROWSER_COVERAGE_EXPECTED_MANIFEST)
	: undefined;
const browserCoverageSourceRevision = BROWSER_COVERAGE
	? process.env.EZCORP_BROWSER_COVERAGE_SOURCE_REVISION
	: undefined;
if (BROWSER_COVERAGE && !/^[0-9a-f]{40}$/.test(browserCoverageSourceRevision ?? "")) {
	throw new Error("browser coverage: EZCORP_BROWSER_COVERAGE_SOURCE_REVISION must be the current 40-character Git revision");
}

// Vite's copied client manifest contains every immutable asset name from one
// production build. Its digest prevents range mergers from combining receipts
// produced by different builds whose source maps might point at different
// source text. Compute it once per worker; coverage is opt-in, so ordinary
// mock and real journeys do not need a built manifest at collection time.
const browserCoverageBuildId = BROWSER_COVERAGE
	? createHash("sha256")
		.update(readFileSync(resolve(process.cwd(), "build", "client", "manifest.json")))
		.digest("hex")
	: undefined;

type CoverageScript = { url: string; functions: unknown[] };
type RawCoverage = { result: Array<CoverageScript & { scriptId: string }> };
type CoverageReceipt = {
	result: CoverageScript[];
	buildId: string;
	expectedRouteFiles?: string[];
	expectedFiles?: string[];
	sourceRevision: string;
	testsWithApplicationScripts: number;
	testsWithoutApplicationScripts: number;
};

type V8CoverageMerger = {
	mergeProcessCovs(receipts: Array<{ result: CoverageScript[] }>): { result: CoverageScript[] };
};

// The package has no declaration entry point. Resolve its runtime module just
// like the converter does, so the normal test typecheck does not need to
// weaken its module boundary to `any`.
const v8CoverageMerger: Promise<V8CoverageMerger> | undefined = BROWSER_COVERAGE
	? import(pathToFileURL(resolve(process.cwd(), "node_modules", "@bcoe/v8-coverage/src/lib/index.js")).href)
		.then((module) => module as unknown as V8CoverageMerger)
	: undefined;
const coverageByWorker = new Map<number, CoverageReceipt>();

function coverageOutput(testInfo: TestInfo): string {
	const outputDir = process.env.EZCORP_BROWSER_COVERAGE_OUTPUT
		?? resolve(process.cwd(), "..", "tasks", "testing-gaps", "browser", "v8-coverage");
	const project = testInfo.project.name.replaceAll(/[^a-zA-Z0-9]+/g, "-");
	return resolve(outputDir, `${project}-worker-${testInfo.workerIndex}.json`);
}

/**
 * Retain only source-mapped application assets from the document that is
 * currently running. A test can leave that document by a native form POST or
 * a reload; its V8 isolate then disappears before the end-of-test snapshot.
 */
function applicationScripts(
	raw: RawCoverage,
	origin: string,
	sourceMapUrls: ReadonlyMap<string, string>,
): CoverageScript[] {
	return raw.result.flatMap((script) => {
		try {
			const url = new URL(script.url);
			const sourceMapURL = sourceMapUrls.get(script.scriptId);
			if (url.origin !== origin || !url.pathname.startsWith("/_app/") || !sourceMapURL) return [];
			return [{ url: script.url, functions: script.functions }];
		} catch {
			return [];
		}
	});
}

async function checkpointCoverage(
	testInfo: TestInfo,
	result: CoverageScript[],
	expectedRouteFiles: string[] | undefined,
	expectedFiles: string[] | undefined,
): Promise<void> {
	const key = testInfo.workerIndex;
	const previous = coverageByWorker.get(key);
	const mergedResult = previous && result.length > 0
		? (await v8CoverageMerger!).mergeProcessCovs([
			structuredClone({ result: previous.result }),
			structuredClone({ result }),
		]).result
		: previous?.result ?? result;
	const receipt: CoverageReceipt = {
		result: mergedResult,
		buildId: browserCoverageBuildId!,
		sourceRevision: browserCoverageSourceRevision!,
		expectedRouteFiles: [...new Set([
			...(previous?.expectedRouteFiles ?? []),
			...(expectedRouteFiles ?? []),
		])].sort(),
		expectedFiles: [...new Set([
			...(previous?.expectedFiles ?? []),
			...(expectedFiles ?? []),
		])].sort(),
		testsWithApplicationScripts: (previous?.testsWithApplicationScripts ?? 0) + Number(result.length > 0),
		testsWithoutApplicationScripts: (previous?.testsWithoutApplicationScripts ?? 0) + Number(result.length === 0),
	};
	coverageByWorker.set(key, receipt);
	const output = coverageOutput(testInfo);
	await mkdir(dirname(output), { recursive: true });
	const temporaryOutput = `${output}.${process.pid}.tmp`;
	// This file is an execution artifact, not a review document. Compact JSON
	// keeps a full two-worker run bounded near two merged asset graphs rather
	// than multiplying indentation across millions of nested V8 ranges.
	await writeFile(temporaryOutput, JSON.stringify(receipt));
	await rename(temporaryOutput, output);
}

/**
 * The one readiness gate for an e2e navigation: wait until the client app has
 * actually hydrated.
 *
 * WHY THIS EXISTS (issue #145, first observed on PR #141's `Visual evidence`
 * job, run 31139375254):
 *
 * Every route in this app is SERVER-RENDERED, so the obvious gate
 *
 *     await page.goto(`/project/${id}/chat/${convId}`);
 *     await expect(page.getByText("Send a message to start…")).toBeVisible();
 *     await page.locator("textarea").fill("hello");     // <- pre-hydration
 *
 * proves nothing. Measured against the running preview with `curl` and zero
 * JavaScript executed, that chat route returns 33 440 bytes of HTML already
 * containing the empty-state paragraph, the `<textarea>` AND the send button.
 * The assertion is satisfied at FIRST PAINT. Everything after it races
 * hydration. Locally hydration lands within milliseconds so the window never
 * opens; on a starved 4-core runner (preview server + 4 Playwright workers)
 * it does, and then:
 *
 *   1. `fill()` writes into the pre-hydration `<textarea>` node.
 *   2. Hydration re-creates the composer with component state `value = ""`.
 *   3. The typed text is silently discarded.
 *   4. `disabled={(!value.trim() && …) || …}` is now PERMANENTLY true.
 *   5. The click burns its whole timeout against a button that can never
 *      enable — a TERMINAL state, not a slow one.
 *
 * Auditing the suite found 489 such windows across 150 specs, so the fix has
 * to be structural rather than 489 hand-written gates: `app.html` ships
 * `data-hydrated="false"`, the root `+layout.svelte` onMount flips it to
 * `"true"`, and `fixtures/test-base.ts` wraps `page.goto` so EVERY navigation
 * passes through here. No spec has to remember.
 *
 * The marker cannot false-pass the way a text assertion does: `"false"` is
 * literally what the server sends, so only the client app can produce
 * `"true"`.
 */
export const HYDRATION_ATTR = "data-hydrated";

/** Default budget. Hydration is a few ms locally; this is CI-starvation slack. */
export const HYDRATION_TIMEOUT_MS = 20_000;

/**
 * Block until `<html data-hydrated="true">`.
 *
 * A document with NO `data-hydrated` attribute at all is not an EZCorp app
 * document — a non-HTML navigation such as `page.goto("/manifest.json")`, or
 * anything served outside the SvelteKit app. Nothing will ever hydrate it, so
 * the gate is vacuously satisfied instead of hanging for the full timeout.
 * That branch is safe precisely because `app.html` wraps every document the
 * app itself serves (routes AND the SvelteKit error page), so "no marker"
 * can never mean "an app page that has not hydrated yet".
 */
export async function waitForHydration(
	page: Page,
	timeout: number = HYDRATION_TIMEOUT_MS,
): Promise<void> {
	await page.waitForFunction(
		(attr: string) => {
			const state = document.documentElement.getAttribute(attr);
			if (state === null) return true; // not an app document — nothing to hydrate
			return state === "true";
		},
		HYDRATION_ATTR,
		{ timeout },
	);
}

/**
 * The base `test` for EVERY tier: a `page` whose `goto` is hydration-gated.
 *
 * It lives here, and NOT in `test-base.ts`, because the real-auth tier must
 * not import `test-base` — that module pulls in the fetch mocks, which is
 * exactly what `playwright.real.config.ts` isolates its `testDir` to prevent.
 * Both tiers still share one gate: `test-base.ts` extends this with the mock
 * fixtures, and `e2e/real-auth/**` imports this module directly.
 *
 * Wrapping `goto` is the whole fix for issue #145. The alternative — a gate
 * written out at each call site — would be 489 of them across 150 specs, and
 * the 490th would reintroduce the bug.
 */
export const test = base.extend<{ browserCoverage: undefined; inviteRateLimitIsolation: undefined }>({
	// The serial real-auth suite shares one server. Preserve the real ten-attempt
	// limit within each case, while preventing previous cases from spending it.
	// Use the saved administrator session even when a case uses an empty cookie jar.
	inviteRateLimitIsolation: [async ({ baseURL }, use, testInfo) => {
		if (testInfo.config.globalSetup?.endsWith("/real-auth-setup.ts")) {
			const administrator = await playwrightRequest.newContext({
				baseURL,
				storageState: resolve(process.cwd(), "e2e", ".real-auth.json"),
			});
			try {
				const reset = await administrator.post("/api/__test/invite-rate-limit");
				if (reset.status() !== 200) throw new Error(`Invite limiter isolation failed (${reset.status()}): ${await reset.text()}`);
			} finally {
				await administrator.dispose();
			}
		}
		await use(undefined);
	}, { auto: true }],
	page: async ({ page }, use) => {
		const navigate = page.goto.bind(page);
		page.goto = async (url: string, options?: Parameters<Page["goto"]>[1]) => {
			const response = await navigate(url, options);
			await waitForHydration(page);
			return response;
		};
		await use(page);
	},
	// The mock and real-auth tiers share this opt-in CDP collector. It captures
	// only same-origin application chunks and makes the source-map converter
	// fail closed when a requested Svelte route or canonical source has no DA.
	browserCoverage: [async ({ page }, use, testInfo) => {
		if (!BROWSER_COVERAGE) {
			await use(undefined);
			return;
		}
		const session = await page.context().newCDPSession(page);
		const sourceMapUrls = new Map<string, string>();
		session.on("Debugger.scriptParsed", (event) => {
			if (event.sourceMapURL) sourceMapUrls.set(event.scriptId, event.sourceMapURL);
		});
		await session.send("Debugger.enable");
		await session.send("Profiler.enable");
		await session.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
		const documentSnapshots: CoverageScript[][] = [];
		let snapshotError: Error | undefined;
		let snapshotQueue = Promise.resolve();
		const snapshotCurrentDocument = () => {
			// Start CDP capture immediately. Chaining the *start* through a
			// Promise can let navigation destroy the old V8 isolate first.
			// The queue still gives teardown one awaitable completion point.
			const snapshot = (async () => {
				try {
					const current = new URL(page.url());
					if (!current.protocol.startsWith("http")) return;
					const raw = await session.send("Profiler.takePreciseCoverage") as RawCoverage;
					documentSnapshots.push(applicationScripts(raw, current.origin, sourceMapUrls));
				} catch (error) {
					snapshotError ??= error instanceof Error ? error : new Error(String(error));
				}
			})();
			snapshotQueue = snapshotQueue.then(() => snapshot);
			return snapshotQueue;
		};
		const checkpointAfterTopLevelNavigation = (frame: Frame) => {
			if (frame === page.mainFrame()) void snapshotCurrentDocument();
		};
		// Playwright-issued navigations have an awaitable pre-navigation seam. It
		// catches `page.reload()` and `page.goto()` even when a browser teardown
		// would otherwise discard the old isolate before an event callback runs.
		const checkpointNavigation = <Args extends unknown[], Result>(
			navigation: (...args: Args) => Promise<Result>,
		) => async (...args: Args): Promise<Result> => {
			await snapshotCurrentDocument();
			return navigation(...args);
		};
		const navigate = page.goto.bind(page);
		page.goto = checkpointNavigation(navigate);
		const reload = page.reload.bind(page);
		page.reload = checkpointNavigation(reload);
		const goBack = page.goBack.bind(page);
		page.goBack = checkpointNavigation(goBack);
		const goForward = page.goForward.bind(page);
		page.goForward = checkpointNavigation(goForward);
		page.on("framenavigated", checkpointAfterTopLevelNavigation);
		let coverageError: Error | undefined;
		try {
			await use(undefined);
		} finally {
			try {
				page.off("framenavigated", checkpointAfterTopLevelNavigation);
				page.goto = navigate;
				page.reload = reload;
				page.goBack = goBack;
				page.goForward = goForward;
				await snapshotCurrentDocument();
				await snapshotQueue;
				if (snapshotError) {
					coverageError = snapshotError;
				} else {
					const result = documentSnapshots.length > 1
						? (await v8CoverageMerger!).mergeProcessCovs(documentSnapshots.map((snapshot) => ({ result: snapshot }))).result
						: (documentSnapshots[0] ?? []);
					// CLI/API-only and PWA-manifest checks can legitimately load no
					// application chunk. Keep their checkpoint for an auditable count;
					// the final merged route/shim manifest still requires real DA data.
					await checkpointCoverage(
						testInfo,
						result,
						browserCoverageExpectedManifest?.routes,
						browserCoverageExpectedManifest?.files,
					);
				}
			} catch (error) {
				coverageError = error instanceof Error ? error : new Error(String(error));
			} finally {
				await session.send("Profiler.stopPreciseCoverage");
				await session.detach();
			}
		}
		if (coverageError) throw coverageError;
	}, { auto: true }],
});

export { expect } from "@playwright/test";
