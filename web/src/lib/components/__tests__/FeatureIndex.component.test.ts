/**
 * DOM tests for FeatureIndex.svelte's inline-edit keyboard UX.
 *
 * Regression coverage for the failure-path bug where commitEdit's
 * `finally { editingId = null }` discarded the user's typed value on
 * validation error, plus the missing Enter / Escape keyboard support.
 *
 * Scope: just the keyboard wiring + failure-keep-open behavior. The
 * full settings UI flow is exercised end-to-end in
 * web/e2e/feature-index-scan.spec.ts; this is the faster pre-flight.
 */

import { render, fireEvent, screen, waitFor } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import FeatureIndex from "../FeatureIndex.svelte";
import { addToast } from "$lib/toast.svelte.js";

// Mock the toast store so scan toasts can be asserted without a mounted
// Toaster (and so the auto-dismiss setTimeout doesn't interact with the
// fake timers below).
vi.mock("$lib/toast.svelte.js", () => ({ addToast: vi.fn() }));

interface FeatureFixture {
	id: string;
	projectId: string;
	name: string;
	description: string;
	source: "user" | "agent";
	fileCount: number;
	createdAt: string;
	updatedAt: string;
}

const makeFeature = (overrides: Partial<FeatureFixture> = {}): FeatureFixture => ({
	id: "feat-1",
	projectId: "proj-1",
	name: "auth",
	description: "Files under src/auth",
	source: "agent",
	fileCount: 0,
	createdAt: "2026-05-02T00:00:00.000Z",
	updatedAt: "2026-05-02T00:00:00.000Z",
	...overrides,
});

/**
 * Build a fetch stub keyed on (method, urlSubstring). Each handler
 * receives the parsed JSON body (if any) and returns either a Response
 * directly or {status, body} for terseness.
 */
function makeFetchStub(routes: Array<{
	method: string;
	match: string;
	respond: (body: unknown) => { status: number; body: unknown };
}>) {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const method = (init?.method ?? "GET").toUpperCase();
		const route = routes.find((r) => r.method === method && url.includes(r.match));
		if (!route) {
			return new Response("{}", { status: 200 });
		}
		const body = init?.body ? JSON.parse(init.body as string) : undefined;
		const out = route.respond(body);
		return new Response(JSON.stringify(out.body), {
			status: out.status,
			headers: { "content-type": "application/json" },
		});
	});
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	vi.mocked(addToast).mockClear();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("FeatureIndex — inline edit keyboard handling", () => {
	test("Enter on the name input commits and closes on success", async () => {
		const feature = makeFeature();
		vi.stubGlobal(
			"fetch",
			makeFetchStub([
				{
					method: "GET",
					match: "/api/projects/proj-1/features",
					respond: () => ({ status: 200, body: [feature] }),
				},
				{
					method: "PATCH",
					match: `/api/projects/proj-1/features/${feature.id}`,
					respond: (body: any) => ({
						status: 200,
						body: { ...feature, ...body, source: "user" },
					}),
				},
			]),
		);

		render(FeatureIndex, { projectId: "proj-1" });

		// Wait for the feature to load and click "Edit name".
		const editNameButton = await waitFor(() =>
			screen.getByRole("button", { name: "Edit name" }),
		);
		await fireEvent.click(editNameButton);

		const nameInput = (await waitFor(() =>
			screen.getByDisplayValue("auth"),
		)) as HTMLInputElement;
		expect(nameInput.tagName).toBe("INPUT");

		// Type a valid new name and press Enter.
		await fireEvent.input(nameInput, { target: { value: "auth-renamed" } });
		await fireEvent.keyDown(nameInput, { key: "Enter" });

		// On success the input unmounts (editingId reset). Wait for it.
		await waitFor(() => {
			expect(screen.queryByDisplayValue("auth-renamed")).toBeNull();
		});
	});

	test("Enter on validation failure keeps the input open WITH the typed value preserved", async () => {
		const feature = makeFeature();
		vi.stubGlobal(
			"fetch",
			makeFetchStub([
				{
					method: "GET",
					match: "/api/projects/proj-1/features",
					respond: () => ({ status: 200, body: [feature] }),
				},
				{
					method: "PATCH",
					match: `/api/projects/proj-1/features/${feature.id}`,
					respond: () => ({
						status: 400,
						body: {
							error: "Validation failed",
							fields: {
								name: "Feature name can only contain letters, numbers, hyphens, and underscores — no spaces or other punctuation.",
							},
						},
					}),
				},
			]),
		);

		render(FeatureIndex, { projectId: "proj-1" });

		const editNameButton = await waitFor(() =>
			screen.getByRole("button", { name: "Edit name" }),
		);
		await fireEvent.click(editNameButton);

		const nameInput = (await waitFor(() =>
			screen.getByDisplayValue("auth"),
		)) as HTMLInputElement;

		// Type a bad value and Enter — server returns 400.
		await fireEvent.input(nameInput, { target: { value: "has a space" } });
		await fireEvent.keyDown(nameInput, { key: "Enter" });

		// Headline assertion: the input stays mounted with the bad value.
		await waitFor(() => {
			expect(screen.getByDisplayValue("has a space")).toBeInTheDocument();
		});

		// And the actionable field message surfaces (not a bare
		// "Validation failed"). errorMessage is set after the await in
		// commitEdit; waitFor lets the microtask flush.
		await waitFor(() => {
			expect(
				screen.getByText(
					/Feature name can only contain letters, numbers, hyphens, and underscores/,
				),
			).toBeInTheDocument();
		});
	});

	test("Escape on the name input cancels and closes WITHOUT firing a PATCH", async () => {
		const feature = makeFeature({ source: "user" });
		const fetchStub = makeFetchStub([
			{
				method: "GET",
				match: "/api/projects/proj-1/features",
				respond: () => ({ status: 200, body: [feature] }),
			},
			{
				method: "PATCH",
				match: `/api/projects/proj-1/features/${feature.id}`,
				respond: () => ({ status: 200, body: feature }),
			},
		]);
		vi.stubGlobal("fetch", fetchStub);

		render(FeatureIndex, { projectId: "proj-1" });

		const editNameButton = await waitFor(() =>
			screen.getByRole("button", { name: "Edit name" }),
		);
		await fireEvent.click(editNameButton);

		const nameInput = (await waitFor(() =>
			screen.getByDisplayValue("auth"),
		)) as HTMLInputElement;
		await fireEvent.input(nameInput, { target: { value: "scratch-value" } });
		await fireEvent.keyDown(nameInput, { key: "Escape" });

		// Input unmounts; the typed scratch value never lands anywhere.
		await waitFor(() => {
			expect(screen.queryByDisplayValue("scratch-value")).toBeNull();
		});
		// And no PATCH was fired (only the initial GET).
		const patchCalls = fetchStub.mock.calls.filter(
			(call) => (call[1] as RequestInit | undefined)?.method === "PATCH",
		);
		expect(patchCalls).toHaveLength(0);
	});

	test("Shift+Enter in the description textarea inserts a newline and does NOT submit", async () => {
		const feature = makeFeature();
		const fetchStub = makeFetchStub([
			{
				method: "GET",
				match: "/api/projects/proj-1/features",
				respond: () => ({ status: 200, body: [feature] }),
			},
		]);
		vi.stubGlobal("fetch", fetchStub);

		render(FeatureIndex, { projectId: "proj-1" });

		const editDescriptionButton = await waitFor(() =>
			screen.getByRole("button", { name: "Edit description" }),
		);
		await fireEvent.click(editDescriptionButton);

		const textarea = (await waitFor(() =>
			screen.getByDisplayValue("Files under src/auth"),
		)) as HTMLTextAreaElement;
		expect(textarea.tagName).toBe("TEXTAREA");

		// Shift+Enter: handler must not call commitEdit. We assert the
		// negative — no PATCH fires — since simulating the browser's
		// default newline insertion is jsdom-specific.
		await fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

		const patchCalls = fetchStub.mock.calls.filter(
			(call) => (call[1] as RequestInit | undefined)?.method === "PATCH",
		);
		expect(patchCalls).toHaveLength(0);
	});
});

describe("FeatureIndex — scan failure surfacing", () => {
	test("a scan that returns a notice renders the info banner (not the red error banner)", async () => {
		vi.stubGlobal(
			"fetch",
			makeFetchStub([
				// Scan POST must be matched BEFORE the generic GET (both share
				// the /features prefix); makeFetchStub keys on method too.
				{
					method: "POST",
					match: "/api/projects/proj-1/features/scan",
					respond: () => ({
						status: 200,
						body: {
							features: [],
							notice:
								"No feature directories found under /app/TESTENV (scanned top-level fallback)",
						},
					}),
				},
				{
					method: "GET",
					match: "/api/projects/proj-1/features",
					respond: () => ({ status: 200, body: [] }),
				},
			]),
		);

		render(FeatureIndex, { projectId: "proj-1" });

		const scanButton = await waitFor(() =>
			screen.getByRole("button", { name: "Scan features" }),
		);
		await fireEvent.click(scanButton);

		const notice = await waitFor(() => screen.getByTestId("scan-notice"));
		expect(notice).toHaveTextContent(
			"No feature directories found under /app/TESTENV (scanned top-level fallback)",
		);
		// Info banner is styled distinctly (blue, not the red error banner).
		expect(notice.className).toContain("blue");
		expect(notice.className).not.toContain("red");
	});

	test("a scan that 400s renders the error banner with the server message and no notice", async () => {
		const message =
			'Working directory "app/ezAppTest" does not exist on the server (resolved to "/app/app/ezAppTest"). Set an absolute path in project settings.';
		vi.stubGlobal(
			"fetch",
			makeFetchStub([
				{
					method: "POST",
					match: "/api/projects/proj-1/features/scan",
					respond: () => ({ status: 400, body: { error: message } }),
				},
				{
					method: "GET",
					match: "/api/projects/proj-1/features",
					respond: () => ({ status: 200, body: [] }),
				},
			]),
		);

		render(FeatureIndex, { projectId: "proj-1" });

		const scanButton = await waitFor(() =>
			screen.getByRole("button", { name: "Scan features" }),
		);
		await fireEvent.click(scanButton);

		// The verbatim resolved-path message surfaces through readError.
		await waitFor(() => {
			expect(screen.getByText(message)).toBeInTheDocument();
		});
		// No info notice banner on the error path.
		expect(screen.queryByTestId("scan-notice")).toBeNull();
	});
});

describe("FeatureIndex — scan banner lifecycle + toasts", () => {
	test("notice banner clears on a subsequent rescan that finds features", async () => {
		let scanCall = 0;
		vi.stubGlobal(
			"fetch",
			makeFetchStub([
				{
					method: "POST",
					match: "/api/projects/proj-1/features/scan",
					respond: () => {
						scanCall++;
						// Scan #1: empty + notice. Scan #2: a feature, notice cleared.
						return scanCall === 1
							? { status: 200, body: { features: [], notice: "found nothing here" } }
							: {
									status: 200,
									body: { features: [makeFeature({ name: "auth" })], notice: null },
								};
					},
				},
				{
					method: "GET",
					match: "/api/projects/proj-1/features",
					respond: () => ({ status: 200, body: [] }),
				},
			]),
		);

		render(FeatureIndex, { projectId: "proj-1" });
		const scanButton = await waitFor(() =>
			screen.getByRole("button", { name: "Scan features" }),
		);

		// Scan #1 → notice banner appears.
		await fireEvent.click(scanButton);
		const notice = await waitFor(() => screen.getByTestId("scan-notice"));
		expect(notice).toHaveTextContent("found nothing here");

		// Scan #2 → notice is null, banner must disappear.
		await fireEvent.click(scanButton);
		await waitFor(() => {
			expect(screen.queryByTestId("scan-notice")).toBeNull();
		});
	});

	test("error banner clears on a subsequent successful scan", async () => {
		let scanCall = 0;
		vi.stubGlobal(
			"fetch",
			makeFetchStub([
				{
					method: "POST",
					match: "/api/projects/proj-1/features/scan",
					respond: () => {
						scanCall++;
						return scanCall === 1
							? { status: 400, body: { error: "boom: bad working dir" } }
							: { status: 200, body: { features: [], notice: null } };
					},
				},
				{
					method: "GET",
					match: "/api/projects/proj-1/features",
					respond: () => ({ status: 200, body: [] }),
				},
			]),
		);

		render(FeatureIndex, { projectId: "proj-1" });
		const scanButton = await waitFor(() =>
			screen.getByRole("button", { name: "Scan features" }),
		);

		// Scan #1 → error banner.
		await fireEvent.click(scanButton);
		const err = await waitFor(() => screen.getByTestId("feature-error"));
		expect(err).toHaveTextContent("boom: bad working dir");

		// Scan #2 succeeds → error banner cleared (errorMessage reset at start).
		await fireEvent.click(scanButton);
		await waitFor(() => {
			expect(screen.queryByTestId("feature-error")).toBeNull();
		});
	});

	test("a notice dispatches both the success toast and an info toast", async () => {
		vi.stubGlobal(
			"fetch",
			makeFetchStub([
				{
					method: "POST",
					match: "/api/projects/proj-1/features/scan",
					respond: () => ({
						status: 200,
						body: { features: [], notice: "scanned top-level fallback" },
					}),
				},
				{
					method: "GET",
					match: "/api/projects/proj-1/features",
					respond: () => ({ status: 200, body: [] }),
				},
			]),
		);

		render(FeatureIndex, { projectId: "proj-1" });
		const scanButton = await waitFor(() =>
			screen.getByRole("button", { name: "Scan features" }),
		);
		await fireEvent.click(scanButton);

		await waitFor(() => {
			expect(addToast).toHaveBeenCalledWith({
				type: "info",
				message: "scanned top-level fallback",
			});
		});
		expect(addToast).toHaveBeenCalledWith({
			type: "success",
			message: "Scan complete — 0 features",
		});
	});

	test("a network error (fetch rejects) surfaces a red 'Scan failed' banner", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				const method = (init?.method ?? "GET").toUpperCase();
				if (method === "POST" && url.includes("/features/scan")) {
					throw new Error("network down");
				}
				// Initial GET list.
				return new Response("[]", {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}),
		);

		render(FeatureIndex, { projectId: "proj-1" });
		const scanButton = await waitFor(() =>
			screen.getByRole("button", { name: "Scan features" }),
		);
		await fireEvent.click(scanButton);

		const err = await waitFor(() => screen.getByTestId("feature-error"));
		expect(err).toHaveTextContent("Scan failed");
		expect(err).toHaveTextContent("network down");
		expect(screen.queryByTestId("scan-notice")).toBeNull();
	});
});
