/**
 * Phase 57 — GAP-57-B regression: AgentSearchPicker ↔ /api/user/agent-picker wiring.
 *
 * The server route is fully unit-tested (9/9 GREEN at
 * web/src/__tests__/agent-picker-prefs-route.server.test.ts) and the
 * AgentSearchPicker UI renders save/pin affordances, but the binding
 * between them — fetch GET on mount + fetch PUT on each mutation —
 * has no test coverage until this file. The e2e
 * (agent-picker-prefs.spec.ts) is fixme'd pending auth-fixture infra.
 *
 * Five cases:
 *   1. GET /api/user/agent-picker fires on mount (loadPrefs).
 *   2. saveCurrentSearch → PUT with { savedSearches: [{ query, createdAt }] }.
 *   3. pinAgent → PUT with { pinned: [agentId] }.
 *   4. unsaveSearch → PUT with { savedSearches: [] } (after one saved).
 *   5. unpinAgent → PUT with { pinned: [] } (after one pinned).
 *
 * Verbatim contract per Plan 57-06 (lines 49-59 of AgentSearchPicker.svelte):
 *   loadPrefs() → fetch("/api/user/agent-picker")
 *   persistPrefs(updates) → fetch("/api/user/agent-picker", {method:"PUT", body: JSON.stringify(updates)})
 *
 * Runner: vitest (jsdom env).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, screen, waitFor } from "@testing-library/svelte";
import AgentSearchPicker from "../AgentSearchPicker.svelte";
import type { AgentConfig } from "$lib/api";

interface FetchCall {
	url: string;
	method: string;
	body?: any;
}

let fetchCalls: FetchCall[] = [];

const SAMPLE_AGENTS: AgentConfig[] = [
	{
		id: "agent-a",
		name: "Agent A",
		description: "First agent",
		capabilities: [],
		prompt: "",
		provider: null,
		model: null,
		category: null,
		createdAt: "2026-05-01T00:00:00Z",
		updatedAt: "2026-05-01T00:00:00Z",
	} as unknown as AgentConfig,
	{
		id: "agent-b",
		name: "Agent B",
		description: "Second agent",
		capabilities: [],
		prompt: "",
		provider: null,
		model: null,
		category: null,
		createdAt: "2026-05-01T00:00:00Z",
		updatedAt: "2026-05-01T00:00:00Z",
	} as unknown as AgentConfig,
];

/**
 * Default GET response: empty prefs. Individual tests can override by
 * resetting fetchCalls and re-stubbing before render.
 */
function makeFetchStub(getResponse: any = { savedSearches: [], pinned: [] }) {
	return vi.fn(async (input: any, init: any = {}) => {
		const url = typeof input === "string" ? input : input?.url ?? "";
		const method = (init.method ?? "GET").toUpperCase();
		let body: any = undefined;
		if (init.body) {
			try {
				body = JSON.parse(init.body);
			} catch {
				/* non-json body */
			}
		}
		fetchCalls.push({ url, method, body });

		if (url.includes("/api/user/agent-picker") && method === "GET") {
			return new Response(JSON.stringify(getResponse), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (url.includes("/api/user/agent-picker") && method === "PUT") {
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response("[]", {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
}

beforeEach(() => {
	fetchCalls = [];
	vi.stubGlobal("fetch", makeFetchStub());
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("AgentSearchPicker <-> /api/user/agent-picker wiring (GAP-57-B)", () => {
	test("issues GET /api/user/agent-picker on mount", async () => {
		render(AgentSearchPicker, {
			agents: SAMPLE_AGENTS,
			onselect: vi.fn(),
		});
		// onMount fires synchronously after render; waitFor handles any
		// microtask boundary between mount and fetch resolution.
		await waitFor(() => {
			const getCall = fetchCalls.find(
				(c) => c.url.includes("/api/user/agent-picker") && c.method === "GET",
			);
			expect(getCall).toBeDefined();
		});
	});

	test("saveCurrentSearch -> PUT with savedSearches array containing the typed query", async () => {
		// Stub: initial prefs empty; user types "claude" and clicks Save.
		fetchCalls = [];
		vi.stubGlobal("fetch", makeFetchStub({ savedSearches: [], pinned: [] }));
		render(AgentSearchPicker, {
			agents: SAMPLE_AGENTS,
			onselect: vi.fn(),
		});

		const input = await screen.findByTestId("open-agent-picker");
		await fireEvent.focus(input);
		await fireEvent.input(input, { target: { value: "claude" } });

		const saveBtn = await screen.findByTestId("save-search-button");
		// The button uses onmousedown (matches the picker's other affordances
		// — see AgentSearchPicker.svelte:222).
		await fireEvent.mouseDown(saveBtn);

		await waitFor(() => {
			const putCall = fetchCalls.find(
				(c) => c.url.includes("/api/user/agent-picker") && c.method === "PUT",
			);
			expect(putCall).toBeDefined();
			expect(putCall!.body).toBeDefined();
			expect(putCall!.body.savedSearches).toBeDefined();
			expect(Array.isArray(putCall!.body.savedSearches)).toBe(true);
			expect(putCall!.body.savedSearches).toHaveLength(1);
			expect(putCall!.body.savedSearches[0].query).toBe("claude");
			expect(typeof putCall!.body.savedSearches[0].createdAt).toBe("number");
		});
	});

	test("pinAgent -> PUT with pinned array containing the agent id", async () => {
		fetchCalls = [];
		vi.stubGlobal("fetch", makeFetchStub({ savedSearches: [], pinned: [] }));
		render(AgentSearchPicker, {
			agents: SAMPLE_AGENTS,
			onselect: vi.fn(),
		});

		const input = await screen.findByTestId("open-agent-picker");
		await fireEvent.focus(input);

		const pinBtn = await screen.findByTestId("pin-agent-a");
		await fireEvent.mouseDown(pinBtn);

		await waitFor(() => {
			const putCall = fetchCalls
				.filter((c) => c.method === "PUT" && c.url.includes("/api/user/agent-picker"))
				.at(-1);
			expect(putCall).toBeDefined();
			expect(putCall!.body.pinned).toEqual(["agent-a"]);
		});
	});

	test("unsaveSearch -> PUT with savedSearches array missing the removed query", async () => {
		// Server returns one saved search; user clicks × to remove it.
		fetchCalls = [];
		vi.stubGlobal(
			"fetch",
			makeFetchStub({
				savedSearches: [{ query: "claude", createdAt: 1234567890 }],
				pinned: [],
			}),
		);
		render(AgentSearchPicker, {
			agents: SAMPLE_AGENTS,
			onselect: vi.fn(),
		});

		const input = await screen.findByTestId("open-agent-picker");
		await fireEvent.focus(input);

		// The unsave button uses aria-label="Remove saved search <query>"
		// (verified at AgentSearchPicker.svelte:241).
		const unsaveBtn = await screen.findByLabelText("Remove saved search claude");
		await fireEvent.mouseDown(unsaveBtn);

		await waitFor(() => {
			const putCall = fetchCalls
				.filter((c) => c.method === "PUT" && c.url.includes("/api/user/agent-picker"))
				.at(-1);
			expect(putCall).toBeDefined();
			expect(putCall!.body.savedSearches).toEqual([]);
		});
	});

	test("unpinAgent -> PUT with pinned array missing the removed agent id", async () => {
		fetchCalls = [];
		vi.stubGlobal(
			"fetch",
			makeFetchStub({
				savedSearches: [],
				pinned: ["agent-a"],
			}),
		);
		render(AgentSearchPicker, {
			agents: SAMPLE_AGENTS,
			onselect: vi.fn(),
		});

		const input = await screen.findByTestId("open-agent-picker");
		await fireEvent.focus(input);

		// Two unpin paths render the same testid; the pinned-section one
		// is `unpin-agent-a` (AgentSearchPicker.svelte:263). The per-result-row
		// pin button toggles to "Pinned"/unpin behavior in pin-${id} testid.
		// findAllByTestId tolerates both; pick the first.
		const unpinBtns = await screen.findAllByTestId("unpin-agent-a");
		expect(unpinBtns.length).toBeGreaterThan(0);
		await fireEvent.mouseDown(unpinBtns[0]);

		await waitFor(() => {
			const putCall = fetchCalls
				.filter((c) => c.method === "PUT" && c.url.includes("/api/user/agent-picker"))
				.at(-1);
			expect(putCall).toBeDefined();
			expect(putCall!.body.pinned).toEqual([]);
		});
	});
});
