/**
 * DOM tests for BriefingSettings.svelte — the Daily Briefing settings
 * editor (Phase 2, spec §5.4 minus the Phase 3 watchlist manager).
 *
 * Coverage:
 *   1. Load — GET /api/briefing/config populates toggle, time/preset
 *      (parsed from cron), timezone, project, instructions, overrides,
 *      and the last-run status line
 *   2. Never-configured (no createdAt) — timezone defaults from the
 *      browser's Intl zone, not the server's UTC default
 *   3. Hand-edited cron — raw read-only display + switch-to-picker
 *   4. Save — PUT body carries cron built from the pickers, nulled
 *      empty overrides, and projectId null for "most recent"
 *   5. Save error — 400 body surfaces the server's message
 *   6. Run now — 202 success message; 429 countdown (button disabled,
 *      re-enabled after expiry); 503 friendly message
 *   7. Load failure — error line, no form
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import BriefingSettings from "../settings/BriefingSettings.svelte";

interface FetchCall {
	url: string;
	method: string;
	body?: any;
}

let fetchCalls: FetchCall[] = [];

type ConfigOverrides = Record<string, unknown>;

function makeConfig(overrides: ConfigOverrides = {}) {
	return {
		userId: "user-1",
		enabled: false,
		cron: "0 7 * * *",
		timezone: "UTC",
		projectId: null,
		instructions: "",
		watchlist: [],
		model: null,
		provider: null,
		lastFireAt: null,
		lastFireStatus: null,
		consecutiveErrors: 0,
		nextFireAt: null,
		...overrides,
	};
}

/** Install the fetch stub. `config` answers GET; `runNow` answers POST
 *  run-now (may return a pending promise for in-flight assertions, or
 *  throw to simulate a network rejection); `put` (when set) overrides
 *  the default PUT echo and may throw. Otherwise PUT echoes the body
 *  merged over the config (like the API). */
function stubFetch(opts: {
	config?: ConfigOverrides | (() => Response);
	putStatus?: number;
	putBody?: unknown;
	put?: () => Response;
	runNow?: () => Response | Promise<Response>;
} = {}) {
	fetchCalls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: any, init: any = {}) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : (input?.url ?? "");
			const method = (init.method ?? "GET").toUpperCase();
			let body: any;
			if (init.body) {
				try {
					body = JSON.parse(init.body);
				} catch {
					/* non-json */
				}
			}
			fetchCalls.push({ url, method, body });

			if (url.includes("/api/briefing/run-now") && method === "POST") {
				return opts.runNow
					? opts.runNow()
					: new Response(JSON.stringify({ started: true }), { status: 202 });
			}
			if (url.includes("/api/briefing/config") && method === "GET") {
				if (typeof opts.config === "function") return opts.config();
				return new Response(JSON.stringify(makeConfig(opts.config)), { status: 200 });
			}
			if (url.includes("/api/briefing/config") && method === "PUT") {
				if (opts.put) return opts.put();
				if (opts.putStatus && opts.putStatus >= 400) {
					return new Response(JSON.stringify(opts.putBody ?? { error: "invalid briefing config" }), {
						status: opts.putStatus,
					});
				}
				return new Response(
					JSON.stringify({ ...makeConfig({ createdAt: "2026-06-01T00:00:00.000Z" }), ...body }),
					{ status: 200 },
				);
			}
			// ModelSearchPicker loads its options on mount (real contract:
			// GET /api/models returns ModelOption[]).
			if (url.includes("/api/models") && method === "GET") {
				return new Response(
					JSON.stringify([
						{ provider: "anthropic", model: "claude-fable-5", tier: "frontier", costTier: "high", displayName: "Fable 5", available: true },
						{ provider: "openai", model: "gpt-5.5", tier: "frontier", costTier: "high", displayName: "GPT-5.5", available: true },
					]),
					{ status: 200 },
				);
			}
			return new Response("{}", { status: 200 });
		}),
	);
}

function getInput(container: HTMLElement, testid: string): HTMLInputElement {
	const el = container.querySelector(`[data-testid="${testid}"]`);
	expect(el, `missing [data-testid=${testid}]`).not.toBeNull();
	return el as HTMLInputElement;
}

beforeEach(() => {
	vi.useRealTimers();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("BriefingSettings — load", () => {
	test("populates the form from a stored config (UI-written cron → pickers)", async () => {
		stubFetch({
			config: {
				enabled: true,
				cron: "30 8 * * 1-5",
				timezone: "Europe/Berlin",
				projectId: "proj-b",
				instructions: "Work stuff only.",
				model: "claude-fable-5",
				provider: "anthropic",
				lastFireAt: "2026-06-11T07:00:00.000Z",
				lastFireStatus: "ok",
				createdAt: "2026-06-01T00:00:00.000Z",
			},
		});
		const { container, getByTestId } = render(BriefingSettings, {
			projects: [
				{ id: "proj-a", name: "Alpha" },
				{ id: "proj-b", name: "Beta" },
			],
		});

		await waitFor(() => expect(getInput(container, "briefing-enable-toggle").checked).toBe(true));
		expect(getInput(container, "briefing-time").value).toBe("08:30");
		expect((getByTestId("briefing-preset") as HTMLSelectElement).value).toBe("weekdays");
		expect(getByTestId("briefing-schedule-desc").textContent).toContain("Weekdays at 08:30");
		expect(getInput(container, "briefing-timezone").value).toBe("Europe/Berlin");
		expect((getByTestId("briefing-project") as HTMLSelectElement).value).toBe("proj-b");
		expect((getByTestId("briefing-instructions") as HTMLTextAreaElement).value).toBe("Work stuff only.");
		// Stored override renders as the standard picker's selected pill
		// (display name resolved from /api/models).
		await waitFor(() =>
			expect(getByTestId("briefing-model").textContent).toContain("Fable 5"),
		);
		expect(getByTestId("briefing-last-run").textContent).toContain("delivered");
	});

	test("never-configured user gets the browser timezone as the default", async () => {
		const spy = vi.spyOn(Intl, "DateTimeFormat").mockReturnValue({
			resolvedOptions: () => ({ timeZone: "Australia/Sydney" }),
		} as unknown as Intl.DateTimeFormat);
		// Defaults response has NO createdAt (no row was minted on read).
		stubFetch({ config: { timezone: "UTC" } });
		const { container } = render(BriefingSettings, { projects: [] });

		await waitFor(() =>
			expect(getInput(container, "briefing-timezone").value).toBe("Australia/Sydney"),
		);
		expect(container.querySelector('[data-testid="briefing-last-run"]')?.textContent).toContain(
			"No briefing has run yet.",
		);
		spy.mockRestore();
	});

	test("stored config keeps its saved timezone (createdAt present)", async () => {
		stubFetch({ config: { timezone: "UTC", createdAt: "2026-06-01T00:00:00.000Z" } });
		const { container } = render(BriefingSettings, { projects: [] });
		await waitFor(() => expect(getInput(container, "briefing-timezone").value).toBe("UTC"));
	});

	test("hand-edited cron renders read-only with a switch back to the picker", async () => {
		stubFetch({ config: { cron: "*/30 6-9 * * *", createdAt: "2026-06-01T00:00:00.000Z" } });
		const { container, getByTestId, queryByTestId } = render(BriefingSettings, { projects: [] });

		await waitFor(() => expect(queryByTestId("briefing-raw-cron")).not.toBeNull());
		expect(getByTestId("briefing-raw-cron").textContent).toBe("*/30 6-9 * * *");
		expect(queryByTestId("briefing-time")).toBeNull();

		await fireEvent.click(getByTestId("briefing-use-picker"));
		expect(queryByTestId("briefing-raw-cron")).toBeNull();
		expect(container.querySelector('[data-testid="briefing-time"]')).not.toBeNull();
	});

	test("load failure shows the error line instead of the form", async () => {
		stubFetch({ config: () => new Response("{}", { status: 500 }) });
		const { queryByTestId } = render(BriefingSettings, { projects: [] });
		await waitFor(() => expect(queryByTestId("briefing-load-error")).not.toBeNull());
		expect(queryByTestId("briefing-save")).toBeNull();
	});
});

describe("BriefingSettings — save", () => {
	test("PUT body carries picker-built cron, nulled empty overrides, and null projectId", async () => {
		stubFetch({ config: { createdAt: "2026-06-01T00:00:00.000Z" } });
		const { container, getByTestId } = render(BriefingSettings, { projects: [] });
		await waitFor(() => expect(container.querySelector('[data-testid="briefing-save"]')).not.toBeNull());

		await fireEvent.click(getInput(container, "briefing-enable-toggle"));
		await fireEvent.input(getInput(container, "briefing-time"), { target: { value: "06:15" } });
		await fireEvent.change(getByTestId("briefing-preset"), { target: { value: "weekends" } });
		await fireEvent.input(getByTestId("briefing-instructions"), { target: { value: "Short and sweet" } });
		await fireEvent.click(getByTestId("briefing-save"));

		await waitFor(() => expect(container.querySelector('[data-testid="briefing-save-success"]')).not.toBeNull());
		const put = fetchCalls.find((c) => c.method === "PUT");
		expect(put?.body).toMatchObject({
			enabled: true,
			cron: "15 6 * * 0,6",
			projectId: null,
			instructions: "Short and sweet",
			model: null,
			provider: null,
		});
		// Watchlist is Phase 3 — a Phase 2 save must NOT clobber it.
		expect(put?.body).not.toHaveProperty("watchlist");
	});

	test("model override: picking from the standard picker sends model+provider; clearing the pill nulls both", async () => {
		stubFetch({ config: { createdAt: "2026-06-01T00:00:00.000Z" } });
		const { container, getByTestId } = render(BriefingSettings, { projects: [] });
		await waitFor(() => expect(container.querySelector('[data-testid="briefing-save"]')).not.toBeNull());

		// Open the standard ModelSearchPicker and choose GPT-5.5
		// (options come from the /api/models stub — the real contract).
		const search = getInput(container, "open-model-search-picker");
		await fireEvent.focus(search);
		const option = await waitFor(() => {
			const btn = Array.from(container.querySelectorAll('#model-picker-listbox button')).find(
				(b) => b.textContent?.includes("GPT-5.5"),
			);
			expect(btn).toBeTruthy();
			return btn!;
		});
		await fireEvent.mouseDown(option);
		await waitFor(() => expect(getByTestId("briefing-model").textContent).toContain("GPT-5.5"));

		await fireEvent.click(getByTestId("briefing-save"));
		await waitFor(() => expect(fetchCalls.some((c) => c.method === "PUT")).toBe(true));
		expect(fetchCalls.find((c) => c.method === "PUT")?.body).toMatchObject({
			model: "gpt-5.5",
			provider: "openai",
		});

		// Clear via the pill's × → the next save nulls the override.
		// SelectedPill removes on MOUSEDOWN, not click (see the
		// modes-extensions e2e lesson) — fireEvent.click never fires it.
		const removeBtn = await waitFor(() => {
			const btn = getByTestId("briefing-model").querySelector("button[aria-label^='Remove']");
			expect(btn).toBeTruthy();
			return btn as HTMLButtonElement;
		});
		await fireEvent.mouseDown(removeBtn);
		fetchCalls = [];
		await fireEvent.click(getByTestId("briefing-save"));
		await waitFor(() => expect(fetchCalls.some((c) => c.method === "PUT")).toBe(true));
		expect(fetchCalls.find((c) => c.method === "PUT")?.body).toMatchObject({
			model: null,
			provider: null,
		});
	});

	test("a raw (hand-edited) cron is sent back unchanged on save", async () => {
		stubFetch({ config: { cron: "*/30 6-9 * * *", createdAt: "2026-06-01T00:00:00.000Z" } });
		const { container, getByTestId } = render(BriefingSettings, { projects: [] });
		await waitFor(() => expect(container.querySelector('[data-testid="briefing-save"]')).not.toBeNull());

		await fireEvent.click(getByTestId("briefing-save"));
		await waitFor(() => expect(fetchCalls.some((c) => c.method === "PUT")).toBe(true));
		expect(fetchCalls.find((c) => c.method === "PUT")?.body.cron).toBe("*/30 6-9 * * *");
	});

	test("selected project id is forwarded", async () => {
		stubFetch({ config: { createdAt: "2026-06-01T00:00:00.000Z" } });
		const { container, getByTestId } = render(BriefingSettings, {
			projects: [{ id: "proj-a", name: "Alpha" }],
		});
		await waitFor(() => expect(container.querySelector('[data-testid="briefing-save"]')).not.toBeNull());

		await fireEvent.change(getByTestId("briefing-project"), { target: { value: "proj-a" } });
		await fireEvent.click(getByTestId("briefing-save"));
		await waitFor(() => expect(fetchCalls.some((c) => c.method === "PUT")).toBe(true));
		expect(fetchCalls.find((c) => c.method === "PUT")?.body.projectId).toBe("proj-a");
	});

	test("server-side validation error is surfaced", async () => {
		stubFetch({
			config: { createdAt: "2026-06-01T00:00:00.000Z" },
			putStatus: 400,
			putBody: { error: "invalid timezone: Mars/Olympus" },
		});
		const { container, getByTestId } = render(BriefingSettings, { projects: [] });
		await waitFor(() => expect(container.querySelector('[data-testid="briefing-save"]')).not.toBeNull());

		await fireEvent.click(getByTestId("briefing-save"));
		await waitFor(() =>
			expect(container.querySelector('[data-testid="briefing-save-error"]')?.textContent).toContain(
				"invalid timezone: Mars/Olympus",
			),
		);
	});

	test("network rejection during save surfaces the generic failure message", async () => {
		stubFetch({
			config: { createdAt: "2026-06-01T00:00:00.000Z" },
			put: () => {
				throw new Error("offline");
			},
		});
		const { container, getByTestId } = render(BriefingSettings, { projects: [] });
		await waitFor(() => expect(container.querySelector('[data-testid="briefing-save"]')).not.toBeNull());

		await fireEvent.click(getByTestId("briefing-save"));
		await waitFor(() =>
			expect(container.querySelector('[data-testid="briefing-save-error"]')?.textContent).toContain(
				"Failed to save briefing settings.",
			),
		);
		// The save button recovers (finally-block resets `saving`).
		expect((getByTestId("briefing-save") as HTMLButtonElement).disabled).toBe(false);
	});

	test("an invalid picker time blocks the save with a message and never PUTs", async () => {
		stubFetch({ config: { createdAt: "2026-06-01T00:00:00.000Z" } });
		const { container, getByTestId } = render(BriefingSettings, { projects: [] });
		await waitFor(() => expect(container.querySelector('[data-testid="briefing-save"]')).not.toBeNull());

		// An empty time (cleared <input type="time">) makes buildBriefingCron
		// return null — the `!cron` guard must short-circuit before fetch.
		await fireEvent.input(getInput(container, "briefing-time"), { target: { value: "" } });
		await fireEvent.click(getByTestId("briefing-save"));

		await waitFor(() =>
			expect(container.querySelector('[data-testid="briefing-save-error"]')?.textContent).toContain(
				"Pick a valid time of day.",
			),
		);
		expect(fetchCalls.some((c) => c.method === "PUT")).toBe(false);
	});
});

describe("BriefingSettings — run now", () => {
	async function renderLoaded(runNow: () => Response | Promise<Response>) {
		stubFetch({ config: { createdAt: "2026-06-01T00:00:00.000Z" }, runNow });
		const utils = render(BriefingSettings, { projects: [] });
		await waitFor(() =>
			expect(utils.container.querySelector('[data-testid="briefing-run-now"]')).not.toBeNull(),
		);
		return utils;
	}

	test("202 shows the started message", async () => {
		const { container, getByTestId } = await renderLoaded(
			() => new Response(JSON.stringify({ started: true }), { status: 202 }),
		);
		await fireEvent.click(getByTestId("briefing-run-now"));
		await waitFor(() =>
			expect(container.querySelector('[data-testid="briefing-run-now-message"]')?.textContent).toContain(
				"Briefing started",
			),
		);
	});

	test("429 starts a friendly countdown, disables the button, and recovers", async () => {
		const { container, getByTestId } = await renderLoaded(
			() =>
				new Response(JSON.stringify({ error: "Briefing was already run recently", retryAfter: 2 }), {
					status: 429,
				}),
		);
		await fireEvent.click(getByTestId("briefing-run-now"));

		await waitFor(() =>
			expect(container.querySelector('[data-testid="briefing-retry-countdown"]')?.textContent).toContain(
				"try again in 2s",
			),
		);
		expect((getByTestId("briefing-run-now") as HTMLButtonElement).disabled).toBe(true);

		// Countdown expiry re-enables the button (real 1s interval ticks).
		await waitFor(
			() => expect((getByTestId("briefing-run-now") as HTMLButtonElement).disabled).toBe(false),
			{ timeout: 4000 },
		);
		expect(container.querySelector('[data-testid="briefing-retry-countdown"]')).toBeNull();
	}, 10_000);

	test("429 without a retryAfter falls back to a 60s window", async () => {
		const { container, getByTestId } = await renderLoaded(
			() => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 }),
		);
		await fireEvent.click(getByTestId("briefing-run-now"));
		await waitFor(() =>
			expect(container.querySelector('[data-testid="briefing-retry-countdown"]')?.textContent).toContain(
				"1m 0s",
			),
		);
	});

	test("503 shows the still-starting message without a countdown", async () => {
		const { container, getByTestId } = await renderLoaded(
			() => new Response(JSON.stringify({ error: "Briefing runtime is not available yet" }), { status: 503 }),
		);
		await fireEvent.click(getByTestId("briefing-run-now"));
		await waitFor(() =>
			expect(container.querySelector('[data-testid="briefing-run-now-message"]')?.textContent).toContain(
				"still starting up",
			),
		);
		expect(container.querySelector('[data-testid="briefing-retry-countdown"]')).toBeNull();
		expect((getByTestId("briefing-run-now") as HTMLButtonElement).disabled).toBe(false);
	});

	test("unexpected error status surfaces the server message", async () => {
		const { container, getByTestId } = await renderLoaded(
			() => new Response(JSON.stringify({ error: "kaboom" }), { status: 500 }),
		);
		await fireEvent.click(getByTestId("briefing-run-now"));
		await waitFor(() =>
			expect(container.querySelector('[data-testid="briefing-run-now-message"]')?.textContent).toContain(
				"kaboom",
			),
		);
	});

	test("network rejection surfaces the generic failure message and recovers", async () => {
		const { container, getByTestId } = await renderLoaded(() => {
			throw new Error("offline");
		});
		await fireEvent.click(getByTestId("briefing-run-now"));
		await waitFor(() =>
			expect(container.querySelector('[data-testid="briefing-run-now-message"]')?.textContent).toContain(
				"Failed to start the briefing.",
			),
		);
		expect((getByTestId("briefing-run-now") as HTMLButtonElement).disabled).toBe(false);
	});

	test("double-click while in flight fires exactly one POST (re-entrancy guard)", async () => {
		let resolveRunNow!: (res: Response) => void;
		const pending = new Promise<Response>((resolve) => {
			resolveRunNow = resolve;
		});
		const { container, getByTestId } = await renderLoaded(() => pending);
		const button = getByTestId("briefing-run-now") as HTMLButtonElement;

		await fireEvent.click(button);
		await waitFor(() => expect(button.textContent).toContain("Starting..."));
		expect(button.disabled).toBe(true);

		// Second click while the first POST is still in flight. fireEvent
		// dispatches even on a disabled button (dispatchEvent bypasses the
		// activation-behaviour suppression), so this exercises the
		// `if (runNowBusy) return` guard, not just the disabled attribute.
		await fireEvent.click(button);

		resolveRunNow(new Response(JSON.stringify({ started: true }), { status: 202 }));
		await waitFor(() =>
			expect(container.querySelector('[data-testid="briefing-run-now-message"]')?.textContent).toContain(
				"Briefing started",
			),
		);
		expect(button.disabled).toBe(false);

		const posts = fetchCalls.filter((c) => c.method === "POST" && c.url.includes("/api/briefing/run-now"));
		expect(posts).toHaveLength(1);
	});
});

describe("BriefingSettings — watchlist manager (Phase 3)", () => {
	const STORED_WATCHLIST = [
		{ topic: "Bun 2.0 release", addedAt: "2026-06-01T00:00:00.000Z" },
		{ topic: "PGlite roadmap", addedAt: "2026-06-02T00:00:00.000Z" },
	];

	async function renderWithWatchlist(watchlist = STORED_WATCHLIST) {
		stubFetch({ config: { watchlist, createdAt: "2026-06-01T00:00:00.000Z" } });
		const utils = render(BriefingSettings, { projects: [] });
		await waitFor(() =>
			expect(utils.container.querySelector('[data-testid="briefing-save"]')).not.toBeNull(),
		);
		return utils;
	}

	test("renders stored topics (incl. conversationally-captured ones) with remove buttons", async () => {
		const { container } = await renderWithWatchlist();
		const items = container.querySelectorAll('[data-testid="briefing-watchlist-item"]');
		expect(items).toHaveLength(2);
		expect(items[0]!.textContent).toContain("Bun 2.0 release");
		expect(items[1]!.textContent).toContain("PGlite roadmap");
		expect(container.querySelectorAll('[data-testid="briefing-watchlist-remove"]')).toHaveLength(2);
		expect(container.querySelector('[data-testid="briefing-watchlist-empty"]')).toBeNull();
	});

	test("empty watchlist shows the empty line", async () => {
		const { container } = await renderWithWatchlist([]);
		expect(container.querySelector('[data-testid="briefing-watchlist-empty"]')).not.toBeNull();
		expect(container.querySelectorAll('[data-testid="briefing-watchlist-item"]')).toHaveLength(0);
	});

	test("an untouched save OMITS the watchlist key (preserve-on-omit semantics survive)", async () => {
		const { container, getByTestId } = await renderWithWatchlist();
		await fireEvent.input(getByTestId("briefing-instructions"), { target: { value: "unrelated edit" } });
		await fireEvent.click(getByTestId("briefing-save"));
		await waitFor(() => expect(container.querySelector('[data-testid="briefing-save-success"]')).not.toBeNull());

		const put = fetchCalls.find((c) => c.method === "PUT");
		expect(put?.body).not.toHaveProperty("watchlist");
	});

	test("adding a topic marks the list dirty: save PUTs the full new list, then resets the dirty flag from the response", async () => {
		const { container, getByTestId } = await renderWithWatchlist();
		await fireEvent.input(getInput(container, "briefing-watchlist-input"), {
			target: { value: "  EZCorp v1.4  " },
		});
		await fireEvent.click(getByTestId("briefing-watchlist-add"));

		// Trimmed, appended, input cleared.
		const items = container.querySelectorAll('[data-testid="briefing-watchlist-item"]');
		expect(items).toHaveLength(3);
		expect(items[2]!.textContent).toContain("EZCorp v1.4");
		expect(getInput(container, "briefing-watchlist-input").value).toBe("");

		await fireEvent.click(getByTestId("briefing-save"));
		await waitFor(() => expect(container.querySelector('[data-testid="briefing-save-success"]')).not.toBeNull());

		const put = fetchCalls.find((c) => c.method === "PUT");
		expect(put?.body.watchlist).toHaveLength(3);
		expect(put?.body.watchlist[2]).toMatchObject({ topic: "EZCorp v1.4" });
		expect(typeof put?.body.watchlist[2].addedAt).toBe("string");

		// The PUT echo re-applies the config → dirty flag resets, so a
		// SECOND unrelated save omits the key again.
		fetchCalls = [];
		await fireEvent.click(getByTestId("briefing-save"));
		await waitFor(() => expect(fetchCalls.some((c) => c.method === "PUT")).toBe(true));
		expect(fetchCalls.find((c) => c.method === "PUT")?.body).not.toHaveProperty("watchlist");
	});

	test("Enter in the input adds the topic (no form submit / page nav)", async () => {
		const { container } = await renderWithWatchlist([]);
		const input = getInput(container, "briefing-watchlist-input");
		await fireEvent.input(input, { target: { value: "Keyboard topic" } });
		await fireEvent.keyDown(input, { key: "Enter" });
		expect(container.querySelectorAll('[data-testid="briefing-watchlist-item"]')).toHaveLength(1);
	});

	test("removing a topic PUTs the shrunken list on save", async () => {
		const { container, getByTestId } = await renderWithWatchlist();
		const removeButtons = container.querySelectorAll('[data-testid="briefing-watchlist-remove"]');
		await fireEvent.click(removeButtons[0]!);

		expect(container.querySelectorAll('[data-testid="briefing-watchlist-item"]')).toHaveLength(1);

		await fireEvent.click(getByTestId("briefing-save"));
		await waitFor(() => expect(fetchCalls.some((c) => c.method === "PUT")).toBe(true));
		const put = fetchCalls.find((c) => c.method === "PUT");
		expect(put?.body.watchlist).toEqual([STORED_WATCHLIST[1]]);
	});

	test("client-side guards: blank ignored, duplicate (case-insensitive) and over-long rejected with a message, cap enforced", async () => {
		const { container, getByTestId } = await renderWithWatchlist();
		const input = getInput(container, "briefing-watchlist-input");
		const add = getByTestId("briefing-watchlist-add");

		// Blank → ignored, no error.
		await fireEvent.input(input, { target: { value: "   " } });
		await fireEvent.click(add);
		expect(container.querySelectorAll('[data-testid="briefing-watchlist-item"]')).toHaveLength(2);
		expect(container.querySelector('[data-testid="briefing-watchlist-error"]')).toBeNull();

		// Case-insensitive duplicate → message, list unchanged.
		await fireEvent.input(input, { target: { value: "bun 2.0 RELEASE" } });
		await fireEvent.click(add);
		expect(container.querySelector('[data-testid="briefing-watchlist-error"]')?.textContent).toContain(
			"already on the watchlist",
		);
		expect(container.querySelectorAll('[data-testid="briefing-watchlist-item"]')).toHaveLength(2);

		// Over-long → message.
		await fireEvent.input(input, { target: { value: "x".repeat(201) } });
		await fireEvent.click(add);
		expect(container.querySelector('[data-testid="briefing-watchlist-error"]')?.textContent).toContain(
			"200 characters",
		);

		// No PUT was fired by any of the rejected adds.
		expect(fetchCalls.some((c) => c.method === "PUT")).toBe(false);
	});

	test("cap: a full 25-topic list rejects a 26th with a remove-one-first message", async () => {
		const full = Array.from({ length: 25 }, (_, i) => ({
			topic: `topic-${i}`,
			addedAt: "2026-06-01T00:00:00.000Z",
		}));
		const { container, getByTestId } = await renderWithWatchlist(full);
		await fireEvent.input(getInput(container, "briefing-watchlist-input"), {
			target: { value: "one too many" },
		});
		await fireEvent.click(getByTestId("briefing-watchlist-add"));
		expect(container.querySelector('[data-testid="briefing-watchlist-error"]')?.textContent).toContain(
			"remove one first",
		);
		expect(container.querySelectorAll('[data-testid="briefing-watchlist-item"]')).toHaveLength(25);
	});
});

describe("BriefingSettings — watchlist delta-merge on save (chat-added topics survive)", () => {
	const STORED_WATCHLIST = [
		{ topic: "Bun 2.0 release", addedAt: "2026-06-01T00:00:00.000Z" },
		{ topic: "PGlite roadmap", addedAt: "2026-06-02T00:00:00.000Z" },
	];
	const CHAT_ADDED = { topic: "Zig 1.0", addedAt: "2026-06-10T00:00:00.000Z" };

	/** Stateful GET: the test mutates `server.watchlist` to simulate a
	 *  briefing_watch chat tool firing between page load and save. */
	function renderWithServerList(initial = STORED_WATCHLIST) {
		const server = { watchlist: initial };
		stubFetch({
			config: () =>
				new Response(
					JSON.stringify(
						makeConfig({ watchlist: server.watchlist, createdAt: "2026-06-01T00:00:00.000Z" }),
					),
					{ status: 200 },
				),
		});
		const utils = render(BriefingSettings, { projects: [] });
		return { ...utils, server };
	}

	async function loaded(container: HTMLElement) {
		await waitFor(() => expect(container.querySelector('[data-testid="briefing-save"]')).not.toBeNull());
	}

	test("a topic added via chat between load and save survives a concurrent UI save", async () => {
		const { container, getByTestId, server } = renderWithServerList();
		await loaded(container);

		await fireEvent.input(getInput(container, "briefing-watchlist-input"), {
			target: { value: "EZCorp v1.4" },
		});
		await fireEvent.click(getByTestId("briefing-watchlist-add"));

		// briefing_watch fires in another tab/conversation.
		server.watchlist = [...STORED_WATCHLIST, CHAT_ADDED];

		await fireEvent.click(getByTestId("briefing-save"));
		await waitFor(() => expect(container.querySelector('[data-testid="briefing-save-success"]')).not.toBeNull());

		const put = fetchCalls.find((c) => c.method === "PUT");
		expect((put?.body.watchlist as Array<{ topic: string }>).map((w) => w.topic)).toEqual([
			"Bun 2.0 release",
			"PGlite roadmap",
			"Zig 1.0",
			"EZCorp v1.4",
		]);
	});

	test("a UI removal still removes the topic even though the fresh GET still carries it", async () => {
		const { container, getByTestId, server } = renderWithServerList();
		await loaded(container);

		// Remove "Bun 2.0 release" in the UI.
		await fireEvent.click(container.querySelectorAll('[data-testid="briefing-watchlist-remove"]')[0]!);
		server.watchlist = [...STORED_WATCHLIST, CHAT_ADDED];

		await fireEvent.click(getByTestId("briefing-save"));
		await waitFor(() => expect(fetchCalls.some((c) => c.method === "PUT")).toBe(true));

		const put = fetchCalls.find((c) => c.method === "PUT");
		expect((put?.body.watchlist as Array<{ topic: string }>).map((w) => w.topic)).toEqual([
			"PGlite roadmap",
			"Zig 1.0",
		]);
	});

	test("case-insensitive dedupe: a UI add that raced the same chat-added topic keeps one entry (the server's)", async () => {
		const { container, getByTestId, server } = renderWithServerList();
		await loaded(container);

		await fireEvent.input(getInput(container, "briefing-watchlist-input"), {
			target: { value: "zig 1.0" },
		});
		await fireEvent.click(getByTestId("briefing-watchlist-add"));
		server.watchlist = [...STORED_WATCHLIST, CHAT_ADDED];

		await fireEvent.click(getByTestId("briefing-save"));
		await waitFor(() => expect(fetchCalls.some((c) => c.method === "PUT")).toBe(true));

		const put = fetchCalls.find((c) => c.method === "PUT");
		expect((put?.body.watchlist as Array<{ topic: string }>).map((w) => w.topic)).toEqual([
			"Bun 2.0 release",
			"PGlite roadmap",
			"Zig 1.0", // server casing wins; no duplicate "zig 1.0"
		]);
	});

	test("a merge that exceeds the 25-topic cap blocks the save with a visible message and never PUTs", async () => {
		const stored = Array.from({ length: 24 }, (_, i) => ({
			topic: `topic-${i}`,
			addedAt: "2026-06-01T00:00:00.000Z",
		}));
		const { container, getByTestId, server } = renderWithServerList(stored);
		await loaded(container);

		// UI add is fine locally (25 = at the cap)…
		await fireEvent.input(getInput(container, "briefing-watchlist-input"), {
			target: { value: "ui topic" },
		});
		await fireEvent.click(getByTestId("briefing-watchlist-add"));
		expect(container.querySelector('[data-testid="briefing-watchlist-error"]')).toBeNull();

		// …but chat added one concurrently, so the merge would be 26.
		server.watchlist = [...stored, { topic: "chat topic", addedAt: "2026-06-10T00:00:00.000Z" }];

		await fireEvent.click(getByTestId("briefing-save"));
		await waitFor(() =>
			expect(container.querySelector('[data-testid="briefing-save-error"]')?.textContent).toContain(
				"the limit is 25",
			),
		);
		expect(fetchCalls.some((c) => c.method === "PUT")).toBe(false);
		// The save button recovers (finally-block resets `saving`).
		expect((getByTestId("briefing-save") as HTMLButtonElement).disabled).toBe(false);
	});

	test("an untouched save performs NO merge fetch and still omits the watchlist key", async () => {
		const { container, getByTestId } = renderWithServerList();
		await loaded(container);
		fetchCalls = [];

		await fireEvent.click(getByTestId("briefing-save"));
		await waitFor(() => expect(fetchCalls.some((c) => c.method === "PUT")).toBe(true));

		expect(fetchCalls.find((c) => c.method === "PUT")?.body).not.toHaveProperty("watchlist");
		// No extra GET fired before the PUT — the merge only runs when dirty.
		expect(fetchCalls.filter((c) => c.method === "GET")).toHaveLength(0);
	});
});

describe("BriefingSettings — last-run status labels", () => {
	test.each([
		["error", "failed"],
		["skipped", "skipped"],
		// Unknown statuses (a future server enum value) fall back to the
		// raw string instead of rendering "undefined".
		["exploded", "exploded"],
	])("lastFireStatus %s renders as %s", async (status, label) => {
		stubFetch({
			config: {
				lastFireAt: "2026-06-11T07:00:00.000Z",
				lastFireStatus: status,
				createdAt: "2026-06-01T00:00:00.000Z",
			},
		});
		const { getByTestId, container } = render(BriefingSettings, { projects: [] });
		await waitFor(() => expect(container.querySelector('[data-testid="briefing-last-run"]')).not.toBeNull());
		expect(getByTestId("briefing-last-run").textContent).toContain(`— ${label}`);
		expect(getByTestId("briefing-last-run").textContent).toContain("Last run:");
	});
});
