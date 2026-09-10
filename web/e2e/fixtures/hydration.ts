import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test as base, type Page, type TestInfo } from "@playwright/test";

const BROWSER_COVERAGE = process.env.EZCORP_BROWSER_COVERAGE === "1";
const CANVAS_CHAT_ROUTE = "web/src/routes/(app)/project/[id]/chat/[convId]/+page.svelte";

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
type CoverageReceipt = {
	result: CoverageScript[];
	buildId: string;
	expectedRouteFiles?: string[];
};

type V8CoverageMerger = {
	mergeProcessCovs(receipts: Array<{ result: CoverageScript[] }>): { result: CoverageScript[] };
};

const v8CoverageMerger = BROWSER_COVERAGE
	? import("@bcoe/v8-coverage") as Promise<V8CoverageMerger>
	: undefined;
const coverageByWorker = new Map<number, CoverageReceipt>();

function coverageOutput(testInfo: TestInfo): string {
	const outputDir = process.env.EZCORP_BROWSER_COVERAGE_OUTPUT
		?? resolve(process.cwd(), "..", "tasks", "testing-gaps", "browser", "v8-coverage");
	const project = testInfo.project.name.replaceAll(/[^a-zA-Z0-9]+/g, "-");
	return resolve(outputDir, `${project}-worker-${testInfo.workerIndex}.json`);
}

async function checkpointCoverage(
	testInfo: TestInfo,
	result: CoverageScript[],
	expectedRouteFiles: string[] | undefined,
): Promise<void> {
	const key = testInfo.workerIndex;
	const previous = coverageByWorker.get(key);
	const mergedResult = previous
		? (await v8CoverageMerger!).mergeProcessCovs([
			structuredClone({ result: previous.result }),
			structuredClone({ result }),
		]).result
		: result;
	const receipt: CoverageReceipt = {
		result: mergedResult,
		buildId: browserCoverageBuildId!,
		expectedRouteFiles: [...new Set([
			...(previous?.expectedRouteFiles ?? []),
			...(expectedRouteFiles ?? []),
		])].sort(),
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
export const test = base.extend<{ browserCoverage: undefined }>({
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
	// fail closed when a requested Svelte route has no DA record.
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
		let coverageError: Error | undefined;
		try {
			await use(undefined);
		} finally {
			try {
				const raw = await session.send("Profiler.takePreciseCoverage") as {
					result: Array<{ scriptId: string; url: string; functions: unknown[] }>;
				};
				const origin = new URL(page.url()).origin;
				const result = raw.result.flatMap((script) => {
					try {
						const url = new URL(script.url);
						const sourceMapURL = sourceMapUrls.get(script.scriptId);
						if (url.origin !== origin || !url.pathname.startsWith("/_app/") || !sourceMapURL) return [];
						return [{ ...script, sourceMapURL }];
					} catch {
						return [];
					}
				});
				if (result.length === 0) coverageError = new Error("browser coverage: no same-origin /_app/ scripts were collected");
				else {
					const expectedRouteFiles = testInfo.file.endsWith("canvas-dock-open-close.spec.ts")
						? [CANVAS_CHAT_ROUTE]
						: undefined;
					await checkpointCoverage(testInfo, result, expectedRouteFiles);
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
