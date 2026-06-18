/**
 * Component tests for the extension-author preview page
 * (`web/src/routes/(app)/extensions/author/+page.svelte`).
 *
 * The page's behavior split:
 *   - file tabs: render the on-disk file map, click switches `selected`
 *   - debounced save: 600ms after last keystroke → PUT to the draft API
 *   - flushPendingSave: a 485cb20 fix that flushes a pending debounced
 *     PUT before Validate/Install/Discard fire, so the action's server
 *     roundtrip doesn't race a stale on-disk read
 *   - Validate / Install / Discard: each posts to a dedicated endpoint;
 *     Install on 201 calls `goto(redirectUrl)`, on non-2xx renders an
 *     install-error block; Discard prompts `confirm()` then DELETEs +
 *     navigates to /extensions
 *   - in-flight disabled state: while validating/installing/discarding
 *     each button's `disabled` reflects its own flag
 *   - empty files state: renders the "No files in this draft" branch
 *
 * The page reads `data: { draft, files }` from `+page.server.ts`
 * (covered separately by extension-author-page-server-load.server.test.ts);
 * here we mount the component with fixture data and exercise the
 * client-side surface.
 */
import "@testing-library/jest-dom/vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock $app/navigation BEFORE importing the page so `goto` resolves to
// the test spy. The stub in `src/__tests__/stubs/app-navigation.ts`
// would otherwise return a fresh function each call.
const gotoSpy = vi.fn();
vi.mock("$app/navigation", () => ({
	goto: (...args: unknown[]) => gotoSpy(...args),
}));

// `./$types` is a type-only import inside the route; the Svelte
// compiler erases it before vitest sees the module graph, so no
// runtime stub is needed here.

import ExtensionAuthorPage from "../routes/(app)/extensions/author/+page.svelte";

function makeData(overrides: Partial<{
	draftId: string;
	payload: Record<string, unknown>;
	files: Record<string, string>;
}> = {}) {
	const draftId = overrides.draftId ?? "draft-abc";
	const payload =
		overrides.payload ?? { name: "weather", type: "tool", mode: "author" };
	const files =
		overrides.files ?? {
			"ezcorp.config.ts": "// config\nexport default { name: 'weather' };",
			"index.ts": "// entry\nexport function tool() {}",
		};
	return {
		draft: {
			id: draftId,
			kind: "extension" as const,
			payload,
			createdAt: new Date("2026-05-01T00:00:00.000Z"),
			expiresAt: new Date("2026-05-02T00:00:00.000Z"),
			consumedAt: null,
		},
		files,
	};
}

/**
 * Build a `fetch` spy whose response is selected per-URL+method. Returns
 * the spy AND a helper to override a route's response mid-test. The
 * spy is wired to `globalThis.fetch` so the SUT picks it up via plain
 * `fetch()` calls.
 */
function installFetchSpy(routes: Record<
	string,
	(req: Request) => Promise<Response> | Response
>) {
	const map = new Map(Object.entries(routes));
	const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const method = (init?.method ?? "GET").toUpperCase();
		const key = `${method} ${url}`;
		const handler = map.get(key);
		if (!handler) {
			throw new Error(`No fetch route registered for: ${key}`);
		}
		// `new Request(url)` rejects bare paths under jsdom, so anchor
		// against a synthetic origin. Handlers only care about the
		// method + body, not the host.
		const req = new Request(`http://localhost${url}`, init);
		return handler(req);
	});
	const originalFetch = globalThis.fetch;
	globalThis.fetch = spy as unknown as typeof fetch;
	return {
		spy,
		setRoute(key: string, handler: (req: Request) => Promise<Response> | Response) {
			map.set(key, handler);
		},
		// Calls whose URL contains `substr`. Used to scope assertions to the
		// draft endpoints, ignoring the `GET /api/extensions` fetches that
		// AuthorCompositionPanel + ExtensionAttachPicker fire on mount.
		callsMatching(substr: string) {
			return spy.mock.calls.filter(([input]) => String(input).includes(substr));
		},
		restore() {
			globalThis.fetch = originalFetch;
		},
	};
}

let fetchRig: ReturnType<typeof installFetchSpy>;

beforeEach(() => {
	gotoSpy.mockReset();
});

afterEach(() => {
	fetchRig?.restore();
});

describe("ExtensionAuthorPage — render & file tabs", () => {
	test("renders the file tree, draft metadata, and the first file's content", async () => {
		fetchRig = installFetchSpy({});
		const data = makeData();
		const { getByTestId, getByText } = render(ExtensionAuthorPage, {
			props: { data },
		});
		// File tree shows both files (sorted: ezcorp.config.ts < index.ts).
		expect(getByTestId("file-tab-ezcorp.config.ts")).toBeInTheDocument();
		expect(getByTestId("file-tab-index.ts")).toBeInTheDocument();
		// First file (ezcorp.config.ts after sort) is the active tab.
		expect(getByTestId("file-tab-ezcorp.config.ts")).toHaveClass("active");
		// Its content is in the textarea.
		const ta = getByTestId("file-content") as HTMLTextAreaElement;
		expect(ta.value).toContain("// config");
		// Draft metadata renders.
		expect(getByText(/draft-abc/)).toBeInTheDocument();
		expect(getByText(/weather/)).toBeInTheDocument();
		expect(getByText(/\(tool\)/)).toBeInTheDocument();
	});

	test("clicking a different file tab swaps the textarea content and active highlight", async () => {
		fetchRig = installFetchSpy({});
		const data = makeData();
		const { getByTestId } = render(ExtensionAuthorPage, { props: { data } });

		await fireEvent.click(getByTestId("file-tab-index.ts"));

		expect(getByTestId("file-tab-index.ts")).toHaveClass("active");
		expect(getByTestId("file-tab-ezcorp.config.ts")).not.toHaveClass("active");
		const ta = getByTestId("file-content") as HTMLTextAreaElement;
		expect(ta.value).toContain("// entry");
	});

	test("empty files map → renders the 'No files in this draft' branch", () => {
		fetchRig = installFetchSpy({});
		const data = makeData({ files: {} });
		const { getByText, queryByTestId } = render(ExtensionAuthorPage, {
			props: { data },
		});
		expect(getByText(/No files in this draft/i)).toBeInTheDocument();
		// Textarea is not mounted because `selected` is empty.
		expect(queryByTestId("file-content")).toBeNull();
	});
});

describe("ExtensionAuthorPage — debounced save", () => {
	test("typing into the textarea fires PUT /api/extensions/author/draft/<id> after 600ms with the edited content", async () => {
		vi.useFakeTimers();
		try {
			const putBodies: Array<{ path: string; content: string }> = [];
			fetchRig = installFetchSpy({
				"PUT /api/extensions/author/draft/draft-abc": async (req) => {
					putBodies.push(await req.json());
					return new Response(null, { status: 204 });
				},
			});

			const data = makeData();
			const { getByTestId } = render(ExtensionAuthorPage, {
				props: { data },
			});
			const ta = getByTestId("file-content") as HTMLTextAreaElement;
			await fireEvent.input(ta, {
				target: { value: "// edited config\nexport default {};" },
			});

			// Before 600ms — no PUT yet. (The composition panel's on-mount
			// `GET /api/extensions` is ignored; we scope to the draft route.)
			await vi.advanceTimersByTimeAsync(599);
			expect(fetchRig.callsMatching("/author/draft/")).toHaveLength(0);

			// Crossing 600ms — exactly one PUT, with the new content.
			await vi.advanceTimersByTimeAsync(2);
			expect(fetchRig.callsMatching("/author/draft/")).toHaveLength(1);
			expect(putBodies).toEqual([
				{
					path: "ezcorp.config.ts",
					content: "// edited config\nexport default {};",
				},
			]);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("ExtensionAuthorPage — validate flow", () => {
	test("ok=true response renders the success block; ok=false renders the error list", async () => {
		let validateOk = true;
		fetchRig = installFetchSpy({
			"POST /api/extensions/author/draft/draft-abc/validate": async () => {
				if (validateOk) {
					return new Response(
						JSON.stringify({ ok: true, manifest: { name: "weather" } }),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
				return new Response(
					JSON.stringify({ ok: false, errors: ["missing version", "bad capability"] }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
		});

		const data = makeData();
		const { getByTestId, queryByText, findByText } = render(
			ExtensionAuthorPage,
			{ props: { data } },
		);

		await fireEvent.click(getByTestId("validate-btn"));
		// Success copy.
		await findByText(/Manifest valid\. Ready to install\./i);
		const status = getByTestId("validation-status");
		expect(status).toHaveClass("ok");

		// Now flip to failure and re-validate.
		validateOk = false;
		await fireEvent.click(getByTestId("validate-btn"));
		await waitFor(() => {
			expect(queryByText(/Manifest valid/i)).toBeNull();
		});
		await findByText(/missing version/);
		await findByText(/bad capability/);
		expect(getByTestId("validation-status")).toHaveClass("err");
	});
});

describe("ExtensionAuthorPage — install flow", () => {
	test("happy path: 201 + redirectUrl → calls goto(redirectUrl)", async () => {
		fetchRig = installFetchSpy({
			"POST /api/extensions/author/install": async () =>
				new Response(
					JSON.stringify({
						extensionId: "ext-new",
						redirectUrl: "/extensions/weather",
					}),
					{ status: 201, headers: { "content-type": "application/json" } },
				),
		});

		const data = makeData();
		const { getByTestId } = render(ExtensionAuthorPage, { props: { data } });
		await fireEvent.click(getByTestId("install-btn"));

		await waitFor(() => expect(gotoSpy).toHaveBeenCalledTimes(1));
		expect(gotoSpy).toHaveBeenCalledWith("/extensions/weather");
	});

	test("422 error: renders the install-error block and does NOT navigate", async () => {
		fetchRig = installFetchSpy({
			"POST /api/extensions/author/install": async () =>
				new Response(
					JSON.stringify({ error: "manifest invalid: missing version" }),
					{ status: 422, headers: { "content-type": "application/json" } },
				),
		});

		const data = makeData();
		const { getByTestId, findByTestId } = render(ExtensionAuthorPage, {
			props: { data },
		});
		await fireEvent.click(getByTestId("install-btn"));

		const errBlock = await findByTestId("install-error");
		expect(errBlock).toHaveTextContent(/422/);
		expect(errBlock).toHaveTextContent(/manifest invalid/);
		expect(gotoSpy).not.toHaveBeenCalled();
	});
});

describe("ExtensionAuthorPage — discard flow", () => {
	test("confirm=true → DELETE draft + goto /extensions", async () => {
		let deleted = false;
		fetchRig = installFetchSpy({
			"DELETE /api/extensions/author/draft/draft-abc": async () => {
				deleted = true;
				return new Response(null, { status: 204 });
			},
		});
		const originalConfirm = window.confirm;
		window.confirm = vi.fn().mockReturnValue(true);
		try {
			const data = makeData();
			const { getByTestId } = render(ExtensionAuthorPage, { props: { data } });
			await fireEvent.click(getByTestId("discard-btn"));

			await waitFor(() => expect(deleted).toBe(true));
			await waitFor(() => expect(gotoSpy).toHaveBeenCalledWith("/extensions"));
		} finally {
			window.confirm = originalConfirm;
		}
	});

	test("confirm=false → no DELETE, no navigation", async () => {
		fetchRig = installFetchSpy({});
		const originalConfirm = window.confirm;
		window.confirm = vi.fn().mockReturnValue(false);
		try {
			const data = makeData();
			const { getByTestId } = render(ExtensionAuthorPage, { props: { data } });
			await fireEvent.click(getByTestId("discard-btn"));

			// No async work expected, but give the microtask queue a tick.
			await Promise.resolve();
			// Scope to the draft route — the composition panel's on-mount
			// `GET /api/extensions` is unrelated to the discard flow.
			expect(fetchRig.callsMatching("/author/draft/")).toHaveLength(0);
			expect(gotoSpy).not.toHaveBeenCalled();
		} finally {
			window.confirm = originalConfirm;
		}
	});
});

describe("ExtensionAuthorPage — in-flight disabled state", () => {
	test("clicking Validate disables it until the fetch resolves; Install disables only Install", async () => {
		let releaseValidate!: (r: Response) => void;
		const validatePending = new Promise<Response>((resolve) => {
			releaseValidate = resolve;
		});
		fetchRig = installFetchSpy({
			"POST /api/extensions/author/draft/draft-abc/validate": () =>
				validatePending,
		});

		const data = makeData();
		const { getByTestId } = render(ExtensionAuthorPage, { props: { data } });
		const validateBtn = getByTestId("validate-btn") as HTMLButtonElement;
		const installBtn = getByTestId("install-btn") as HTMLButtonElement;
		const discardBtn = getByTestId("discard-btn") as HTMLButtonElement;

		expect(validateBtn.disabled).toBe(false);
		await fireEvent.click(validateBtn);

		// During the pending fetch, the Validate button is disabled. The
		// page tracks each action's in-flight state independently — Install
		// and Discard remain interactive (the v1 UX is "any action can
		// override any other action"; only its own button reflects the
		// in-flight flag).
		await waitFor(() => expect(validateBtn.disabled).toBe(true));
		expect(installBtn.disabled).toBe(false);
		expect(discardBtn.disabled).toBe(false);

		releaseValidate(
			new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		await waitFor(() => expect(validateBtn.disabled).toBe(false));
	});
});

describe("ExtensionAuthorPage — pending-save flush (485cb20 regression guard)", () => {
	test("a pending debounced save is flushed BEFORE Validate POSTs", async () => {
		vi.useFakeTimers();
		try {
			const order: string[] = [];
			fetchRig = installFetchSpy({
				"PUT /api/extensions/author/draft/draft-abc": async (req) => {
					order.push(`PUT:${(await req.json()).content}`);
					return new Response(null, { status: 204 });
				},
				"POST /api/extensions/author/draft/draft-abc/validate": async () => {
					order.push("VALIDATE");
					return new Response(JSON.stringify({ ok: true }), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				},
			});

			const data = makeData();
			const { getByTestId } = render(ExtensionAuthorPage, { props: { data } });

			// Type — a save timer is now scheduled at t+600ms.
			const ta = getByTestId("file-content") as HTMLTextAreaElement;
			await fireEvent.input(ta, {
				target: { value: "// unsaved edit" },
			});
			// Advance only 100ms so the debounce has NOT fired naturally.
			await vi.advanceTimersByTimeAsync(100);
			expect(order).toEqual([]);

			// Click Validate mid-debounce. `flushPendingSave` should clear
			// the timer and run the save first, THEN POST validate.
			await fireEvent.click(getByTestId("validate-btn"));
			// Drain the microtask + macrotask queues so both awaited fetches
			// settle.
			await vi.runAllTimersAsync();

			expect(order).toEqual(["PUT:// unsaved edit", "VALIDATE"]);
		} finally {
			vi.useRealTimers();
		}
	});
});
