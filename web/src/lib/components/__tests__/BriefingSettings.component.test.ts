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
 *  run-now; PUT echoes the body merged over the config (like the API). */
function stubFetch(opts: {
	config?: ConfigOverrides | (() => Response);
	putStatus?: number;
	putBody?: unknown;
	runNow?: () => Response;
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
		expect(getInput(container, "briefing-model").value).toBe("claude-fable-5");
		expect(getInput(container, "briefing-provider").value).toBe("anthropic");
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
		await fireEvent.input(getInput(container, "briefing-model"), { target: { value: "   " } });
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
});

describe("BriefingSettings — run now", () => {
	async function renderLoaded(runNow: () => Response) {
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
});
