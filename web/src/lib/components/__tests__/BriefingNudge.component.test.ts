/**
 * DOM tests for BriefingNudge.svelte — the one-time Daily Briefing
 * discoverability card (spec §7.1).
 *
 * Contract:
 *   1. Shows when the config check confirms enabled === false and the
 *      user hasn't dismissed it; links to /settings/briefing
 *   2. Hidden when the briefing is already enabled
 *   3. Hidden when previously dismissed (localStorage) — and no config
 *      fetch is made at all
 *   4. Dismiss hides the card and persists to localStorage
 *   5. Fail-closed: failed fetch / non-boolean payloads (e.g. the e2e
 *      catch-all `{}`) never show the card
 *   6. Hidden when the config carries a `createdAt` — a stored row means
 *      the user already configured the briefing (then disabled it), so
 *      they must not be re-nudged
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import BriefingNudge from "../BriefingNudge.svelte";

const DISMISS_KEY = "ezcorp-briefing-nudge-dismissed";

let fetchMock: ReturnType<typeof vi.fn>;

function stubConfig(response: () => Response) {
	fetchMock = vi.fn(async () => response());
	vi.stubGlobal("fetch", fetchMock);
}

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function settle() {
	await new Promise((r) => setTimeout(r, 20));
}

describe("BriefingNudge", () => {
	test("shows when briefing is disabled and not dismissed; links to settings", async () => {
		stubConfig(() => new Response(JSON.stringify({ enabled: false }), { status: 200 }));
		const { queryByTestId, getByTestId } = render(BriefingNudge);

		await waitFor(() => expect(queryByTestId("briefing-nudge")).not.toBeNull());
		expect((getByTestId("briefing-nudge-link") as HTMLAnchorElement).getAttribute("href")).toBe(
			"/settings/briefing",
		);
		expect(getByTestId("briefing-nudge-link").textContent).toContain("Set up your morning briefing");
	});

	test("hidden when the config carries createdAt (configured-then-disabled user)", async () => {
		stubConfig(
			() =>
				new Response(
					JSON.stringify({ enabled: false, createdAt: "2026-06-01T00:00:00.000Z" }),
					{ status: 200 },
				),
		);
		const { queryByTestId } = render(BriefingNudge);
		await settle();
		expect(queryByTestId("briefing-nudge")).toBeNull();
	});

	test("hidden when the briefing is already enabled", async () => {
		stubConfig(() => new Response(JSON.stringify({ enabled: true }), { status: 200 }));
		const { queryByTestId } = render(BriefingNudge);
		await settle();
		expect(queryByTestId("briefing-nudge")).toBeNull();
	});

	test("hidden when previously dismissed — and skips the config fetch entirely", async () => {
		localStorage.setItem(DISMISS_KEY, "1");
		stubConfig(() => new Response(JSON.stringify({ enabled: false }), { status: 200 }));
		const { queryByTestId } = render(BriefingNudge);
		await settle();
		expect(queryByTestId("briefing-nudge")).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("dismiss hides the card and persists", async () => {
		stubConfig(() => new Response(JSON.stringify({ enabled: false }), { status: 200 }));
		const { queryByTestId, getByTestId } = render(BriefingNudge);
		await waitFor(() => expect(queryByTestId("briefing-nudge")).not.toBeNull());

		await fireEvent.click(getByTestId("briefing-nudge-dismiss"));
		expect(queryByTestId("briefing-nudge")).toBeNull();
		expect(localStorage.getItem(DISMISS_KEY)).toBe("1");
	});

	test("fail-closed: error responses never show the card", async () => {
		stubConfig(() => new Response("{}", { status: 500 }));
		const { queryByTestId } = render(BriefingNudge);
		await settle();
		expect(queryByTestId("briefing-nudge")).toBeNull();
	});

	test("fail-closed: a non-boolean enabled (catch-all `{}` payload) never shows the card", async () => {
		stubConfig(() => new Response("{}", { status: 200 }));
		const { queryByTestId } = render(BriefingNudge);
		await settle();
		expect(queryByTestId("briefing-nudge")).toBeNull();
	});

	test("fail-closed: network rejection never shows the card", async () => {
		fetchMock = vi.fn(async () => {
			throw new Error("offline");
		});
		vi.stubGlobal("fetch", fetchMock);
		const { queryByTestId } = render(BriefingNudge);
		await settle();
		expect(queryByTestId("briefing-nudge")).toBeNull();
	});
});
