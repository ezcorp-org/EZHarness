/**
 * v1.4 — DOM tests for MemoryItem.svelte's injection-eligibility
 * toggle. Sibling test file (existing logic for the row lives in
 * `web/src/__tests__/memory-list-logic.test.ts`; this file is the
 * first DOM-level test for the component, so it owns the toggle
 * surface in isolation).
 *
 * Coverage targets (per spec § Phase 2.2):
 *   - Renders both states (`true` / `false`) with correct status
 *     text and visual cue (`border-l-amber-300` on the row when
 *     excluded; `data-injection-eligible` attr mirrors).
 *   - Click on the toggle calls the API helper with the right id +
 *     body via `fetch` to `PATCH /api/memories/[id]`.
 *   - On success, the local row reflects the new state.
 *   - On error, the row reverts AND the toast is surfaced via
 *     `addToast`.
 *   - Accessibility: `aria-label` updates with state on both the
 *     outer row and the toggle button; `aria-pressed` mirrors
 *     the toggle's logical state.
 */
import { render, fireEvent, screen, waitFor } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the toast helper before importing MemoryItem so the mock is
// in place at module-load time. Both the canonical path and the
// `.js` variant are mocked because Svelte SFC imports resolve via
// the latter under the vite-plugin-svelte transform. `vi.hoisted`
// is needed because `vi.mock` is hoisted to the top of the file —
// the factory MUST reference values that are also hoisted, or
// vitest throws "Cannot access ... before initialization".
const { mockAddToast } = vi.hoisted(() => ({ mockAddToast: vi.fn() }));
vi.mock("$lib/toast.svelte", () => ({ addToast: mockAddToast }));
vi.mock("$lib/toast.svelte.js", () => ({ addToast: mockAddToast }));

import MemoryItem from "../MemoryItem.svelte";

// Local mirror of the `Memory` interface exported by
// `MemoryItem.svelte`'s `<script module>` block. The SFC's typed
// re-export resolves fine in production code (see
// `MemoryList.svelte`) but the vitest tsconfig path can't always
// see the generated `.d.ts` for Svelte 5 module-block exports —
// mirroring the shape locally avoids the resolver brittleness
// without weakening the contract (the fixtures still flow into
// the component as `Memory`).
interface Memory {
	id: string;
	content: string;
	category: string;
	confidence: string;
	status: string;
	projectId: string | null;
	projectIds?: string[];
	conversationId: string | null;
	messageIds: string[] | null;
	provenance: null;
	lastAccessedAt: string;
	createdAt: string;
	updatedAt: string;
	injectionEligible: boolean;
}

function makeMemory(overrides: Partial<Memory> = {}): Memory {
	return {
		id: "mem-1",
		content: "user prefers dark mode in the morning",
		category: "preferences",
		confidence: "high",
		status: "active",
		projectId: null,
		projectIds: [],
		conversationId: null,
		messageIds: null,
		provenance: null,
		lastAccessedAt: "2026-05-01T00:00:00.000Z",
		createdAt: "2026-04-01T00:00:00.000Z",
		updatedAt: "2026-04-15T00:00:00.000Z",
		injectionEligible: true,
		...overrides,
	};
}

function renderRow(memory: Memory) {
	const onupdated = vi.fn();
	const ondeleted = vi.fn();
	const result = render(MemoryItem, { memory, onupdated, ondeleted });
	// Auto-expand so the toggle (which lives in the expanded view)
	// is in the DOM. The collapsed row only shows status + content.
	const row = result.getByTestId("memory-row");
	const summary = row.querySelector(".cursor-pointer") as HTMLElement;
	return { ...result, row, summary, onupdated, ondeleted };
}

beforeEach(() => {
	mockAddToast.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("MemoryItem — injection-eligibility — initial render (allowed state)", () => {
	test("status text reads 'Allowed in chat context' when injectionEligible: true", async () => {
		const { row, summary } = renderRow(makeMemory({ injectionEligible: true }));
		await fireEvent.click(summary);
		const status = await waitFor(() =>
			screen.getByTestId("injection-eligibility-status"),
		);
		expect(status.textContent?.trim()).toBe("Allowed in chat context");
		// Visual cue: NO amber left-border accent on the allowed state.
		expect(row.className).not.toContain("border-l-amber-300");
		// Mirror attr — useful for downstream selectors / e2e.
		expect(row.getAttribute("data-injection-eligible")).toBe("true");
	});

	test("aria-label on the outer row reflects the allowed state", async () => {
		const { row } = renderRow(makeMemory({ injectionEligible: true }));
		expect(row.getAttribute("aria-label")).toBe("Memory allowed in chat context");
	});

	test("toggle button's aria-label + aria-pressed reflect allowed state", async () => {
		const { summary } = renderRow(makeMemory({ injectionEligible: true }));
		await fireEvent.click(summary);
		const toggle = (await waitFor(() =>
			screen.getByTestId("injection-eligibility-toggle"),
		)) as HTMLButtonElement;
		// `aria-pressed=false` because the "pressed" state encodes
		// the OFF / excluded condition (consistent with native
		// toggle-button conventions).
		expect(toggle.getAttribute("aria-pressed")).toBe("false");
		expect(toggle.getAttribute("aria-label")).toContain("allowed");
		expect(toggle.getAttribute("data-state")).toBe("allowed");
	});
});

describe("MemoryItem — injection-eligibility — initial render (excluded state)", () => {
	test("status text reads 'Excluded from chat context' when injectionEligible: false", async () => {
		const { summary } = renderRow(makeMemory({ injectionEligible: false }));
		await fireEvent.click(summary);
		const status = await waitFor(() =>
			screen.getByTestId("injection-eligibility-status"),
		);
		expect(status.textContent?.trim()).toBe("Excluded from chat context");
	});

	test("excluded row gets the amber left-border visual cue (single restrained treatment)", () => {
		const { row } = renderRow(makeMemory({ injectionEligible: false }));
		// One specific cue — not opacity (would misread as
		// "unavailable") and not multiple piled cues.
		expect(row.className).toContain("border-l-amber-300");
		expect(row.className).toContain("border-l-4");
		expect(row.getAttribute("data-injection-eligible")).toBe("false");
	});

	test("aria-label on the outer row reflects the excluded state (a11y)", () => {
		const { row } = renderRow(makeMemory({ injectionEligible: false }));
		expect(row.getAttribute("aria-label")).toBe(
			"This memory is excluded from chat context",
		);
	});

	test("toggle button's aria-label + aria-pressed reflect excluded state", async () => {
		const { summary } = renderRow(makeMemory({ injectionEligible: false }));
		await fireEvent.click(summary);
		const toggle = (await waitFor(() =>
			screen.getByTestId("injection-eligibility-toggle"),
		)) as HTMLButtonElement;
		expect(toggle.getAttribute("aria-pressed")).toBe("true");
		expect(toggle.getAttribute("aria-label")).toContain("excluded");
		expect(toggle.getAttribute("data-state")).toBe("excluded");
	});
});

describe("MemoryItem — injection-eligibility — happy path (PATCH succeeds)", () => {
	test("clicking the toggle calls PATCH /api/memories/<id> with the right body", async () => {
		const fetchSpy = vi.fn(
			async (_input: string | URL | Request, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						...makeMemory({ injectionEligible: false }),
						projectIds: [],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetchSpy);
		const { summary, onupdated } = renderRow(
			makeMemory({ injectionEligible: true }),
		);
		await fireEvent.click(summary);
		const toggle = await waitFor(() =>
			screen.getByTestId("injection-eligibility-toggle"),
		);
		await fireEvent.click(toggle);

		await waitFor(() => {
			expect(fetchSpy).toHaveBeenCalledTimes(1);
		});
		const call = fetchSpy.mock.calls[0]!;
		const url = call[0];
		const init = call[1] as RequestInit;
		expect(String(url)).toContain("/api/memories/mem-1");
		expect(init.method).toBe("PATCH");
		expect(JSON.parse(init.body as string)).toEqual({
			injectionEligible: false,
		});
		// onupdated fires with the server-confirmed row, NOT the
		// optimistic local copy — this guarantees the parent list
		// page persists the post-flip state on next render.
		await waitFor(() => {
			expect(onupdated).toHaveBeenCalledTimes(1);
		});
		const updatedArg = onupdated.mock.calls[0]![0] as Memory;
		expect(updatedArg.injectionEligible).toBe(false);
	});

	test("on success the row reflects the new state (status text + aria-label flip)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(
					JSON.stringify({
						...makeMemory({ injectionEligible: false }),
						projectIds: [],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			),
		);
		const { row, summary } = renderRow(makeMemory({ injectionEligible: true }));
		await fireEvent.click(summary);
		const toggle = await waitFor(() =>
			screen.getByTestId("injection-eligibility-toggle"),
		);
		await fireEvent.click(toggle);

		// Status text + aria-label propagate through the optimistic
		// flip and stay there once the server confirms.
		await waitFor(() => {
			expect(
				screen.getByTestId("injection-eligibility-status").textContent?.trim(),
			).toBe("Excluded from chat context");
		});
		expect(row.getAttribute("aria-label")).toBe(
			"This memory is excluded from chat context",
		);
		expect(row.className).toContain("border-l-amber-300");
		expect(mockAddToast).not.toHaveBeenCalled();
	});

	test("toggle from excluded → allowed flips the body in the same shape", async () => {
		const fetchSpy = vi.fn(
			async (_input: string | URL | Request, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						...makeMemory({ injectionEligible: true }),
						projectIds: [],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetchSpy);
		const { summary } = renderRow(makeMemory({ injectionEligible: false }));
		await fireEvent.click(summary);
		const toggle = await waitFor(() =>
			screen.getByTestId("injection-eligibility-toggle"),
		);
		await fireEvent.click(toggle);
		await waitFor(() => {
			expect(fetchSpy).toHaveBeenCalledTimes(1);
		});
		const init = fetchSpy.mock.calls[0]![1] as RequestInit;
		expect(JSON.parse(init.body as string)).toEqual({
			injectionEligible: true,
		});
	});
});

describe("MemoryItem — injection-eligibility — revert on error", () => {
	test("on PATCH 500 the local state reverts AND a toast is surfaced", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(JSON.stringify({ error: "DB down" }), {
					status: 500,
					headers: { "content-type": "application/json" },
				}),
			),
		);
		const { row, summary, onupdated } = renderRow(
			makeMemory({ injectionEligible: true }),
		);
		await fireEvent.click(summary);
		const toggle = await waitFor(() =>
			screen.getByTestId("injection-eligibility-toggle"),
		);
		await fireEvent.click(toggle);

		await waitFor(() => {
			expect(mockAddToast).toHaveBeenCalledTimes(1);
		});
		const toastArg = mockAddToast.mock.calls[0]![0] as {
			type: string;
			message: string;
		};
		expect(toastArg.type).toBe("error");
		// `checkResponse` in `lib/api.ts` throws `data.error` from the
		// JSON body, falling back to `${status} ${statusText}`. Either
		// way, "DB down" should land in the toast on this 500 path.
		expect(toastArg.message).toContain("DB down");

		// Local state reverted: status text is back to "Allowed", row
		// no longer carries the excluded visual cue, and `onupdated`
		// was NOT called.
		expect(
			screen.getByTestId("injection-eligibility-status").textContent?.trim(),
		).toBe("Allowed in chat context");
		expect(row.className).not.toContain("border-l-amber-300");
		expect(row.getAttribute("data-injection-eligible")).toBe("true");
		expect(onupdated).not.toHaveBeenCalled();
	});

	test("on network error (fetch throws) the row reverts and a toast surfaces", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("network refused");
			}),
		);
		const { row, summary, onupdated } = renderRow(
			makeMemory({ injectionEligible: false }),
		);
		await fireEvent.click(summary);
		const toggle = await waitFor(() =>
			screen.getByTestId("injection-eligibility-toggle"),
		);
		await fireEvent.click(toggle);

		await waitFor(() => {
			expect(mockAddToast).toHaveBeenCalledTimes(1);
		});
		// Reverted to excluded after the network throw.
		expect(
			screen.getByTestId("injection-eligibility-status").textContent?.trim(),
		).toBe("Excluded from chat context");
		expect(row.className).toContain("border-l-amber-300");
		expect(onupdated).not.toHaveBeenCalled();
	});
});

describe("MemoryItem — injection-eligibility — inflight guard", () => {
	test("two rapid clicks before PATCH resolves dispatch only ONE fetch", async () => {
		// Pin the `if (togglingEligibility) return;` guard at
		// MemoryItem.svelte:226 — without it, a double-click fires
		// two PATCHes (and two audit rows). Use a deferred-resolve
		// stub so the second click happens while the first is in
		// flight.
		let resolveFetch!: (res: Response) => void;
		const fetchSpy = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					resolveFetch = resolve;
				}),
		);
		vi.stubGlobal("fetch", fetchSpy);
		const { summary } = renderRow(makeMemory({ injectionEligible: true }));
		await fireEvent.click(summary);
		const toggle = await waitFor(() =>
			screen.getByTestId("injection-eligibility-toggle"),
		);
		// Two clicks back-to-back, before the first PATCH resolves.
		await fireEvent.click(toggle);
		await fireEvent.click(toggle);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		// Resolve the inflight fetch so the test cleans up cleanly.
		resolveFetch(
			new Response(
				JSON.stringify({
					...makeMemory({ injectionEligible: false }),
					projectIds: [],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
	});
});

describe("MemoryItem — injection-eligibility — stopPropagation", () => {
	test("clicking the toggle does NOT collapse the expanded row", async () => {
		// The toggle lives inside the expanded section, and the
		// row's summary has a click-to-collapse handler. The
		// toggle's `event.stopPropagation()` at
		// MemoryItem.svelte:225 must prevent the click from
		// bubbling into the row collapse.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(
					JSON.stringify({
						...makeMemory({ injectionEligible: false }),
						projectIds: [],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			),
		);
		const { summary } = renderRow(makeMemory({ injectionEligible: true }));
		await fireEvent.click(summary);
		const toggle = await waitFor(() =>
			screen.getByTestId("injection-eligibility-toggle"),
		);
		await fireEvent.click(toggle);
		// Row stays expanded — the status element (only rendered
		// in the expanded branch) is still in the DOM.
		await waitFor(() => {
			expect(screen.queryByTestId("injection-eligibility-status")).not.toBeNull();
		});
	});
});

describe("MemoryItem — injection-eligibility — accessibility regression", () => {
	test("aria-label on the toggle button switches between the two state-strings", async () => {
		// Pin the actual a11y strings — screen-reader users rely on
		// them as the primary affordance label, and a future copy
		// change should be a deliberate, reviewed edit.
		const { summary } = renderRow(makeMemory({ injectionEligible: true }));
		await fireEvent.click(summary);
		const toggle = await waitFor(() =>
			screen.getByTestId("injection-eligibility-toggle"),
		);
		expect(toggle.getAttribute("aria-label")).toBe(
			"Memory allowed in chat context. Click to exclude.",
		);

		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(
					JSON.stringify({
						...makeMemory({ injectionEligible: false }),
						projectIds: [],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			),
		);
		await fireEvent.click(toggle);
		await waitFor(() => {
			expect(toggle.getAttribute("aria-label")).toBe(
				"This memory is excluded from chat context. Click to allow.",
			);
		});
	});
});
