/**
 * DOM tests for ContextsTab.svelte — the saved-contexts library tab.
 *
 * Covers (spec test matrix):
 *   - type chips sourced live from GET /api/context-types
 *   - debounced (300ms) search assembles the /api/contexts fetch URL
 *   - type-chip + project filters flow into the request params
 *   - row expand reveals the full extracted markdown
 *   - Copy calls $lib/clipboard.copyToClipboard (true → badge; false → none)
 *   - Delete is optimistic (click-to-confirm) with rollback on API error
 *     and on a network throw
 *   - empty states (no rows vs. filtered-to-empty)
 *   - conversation deep-link renders for a real project
 *
 * Pattern mirrors LessonsTab.component.test.ts: fake timers for the
 * debounce/confirm windows, `vi.stubGlobal("fetch", …)` per test, then
 * assert against the rendered DOM. `$lib/clipboard` is module-mocked so
 * Copy is asserted without a real clipboard.
 */
import { render, fireEvent, screen, waitFor, within } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import ContextsTab from "../ContextsTab.svelte";
import { copyToClipboard } from "$lib/clipboard";

// Local mirrors of the component's exported shapes. A `.ts` test can't
// import named types across the `*.svelte` ambient module (default export
// only), so these are duplicated here for the fixtures.
interface ContextType {
	id: string;
	label: string;
	description: string;
	sortOrder: number;
}
interface SavedContext {
	id: string;
	topicLabel: string;
	typeId: string;
	title: string;
	content: string;
	conversationId: string | null;
	model: string;
	createdAt: string;
	updatedAt: string;
}

vi.mock("$lib/clipboard", () => ({ copyToClipboard: vi.fn() }));
const mockCopy = vi.mocked(copyToClipboard);

const DEFAULT_TYPES: ContextType[] = [
	{ id: "feature", label: "Feature", description: "A feature", sortOrder: 0 },
	{ id: "idea", label: "Idea", description: "An idea", sortOrder: 1 },
	{ id: "decision", label: "Decision", description: "A decision", sortOrder: 2 },
	{ id: "bug-fix", label: "Bug Fix", description: "A bug fix", sortOrder: 3 },
];

function makeContext(overrides: Partial<SavedContext> = {}): SavedContext {
	return {
		id: "ctx-1",
		topicLabel: "Auth rewrite",
		typeId: "decision",
		title: "Decision: switch to JWT refresh rotation",
		content: "We decided to rotate refresh tokens.\n\n```ts\nconst t = rotate();\n```",
		conversationId: "conv-9",
		model: "qwen3:1.7b",
		// Years old so relativeTime() exercises every branch.
		createdAt: "2023-01-01T00:00:00.000Z",
		updatedAt: "2023-01-02T00:00:00.000Z",
		...overrides,
	};
}

interface FetchCall {
	url: string;
	method: string;
	body?: unknown;
}

function stubFetch(opts: {
	contexts?: SavedContext[];
	total?: number;
	types?: ContextType[];
	contextsStatus?: number;
	deleteStatus?: number;
	deleteThrow?: boolean;
} = {}): FetchCall[] {
	const calls: FetchCall[] = [];
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			const method = (init?.method ?? "GET").toUpperCase();
			calls.push({
				url,
				method,
				body: init?.body ? JSON.parse(init.body as string) : undefined,
			});

			if (url.includes("/api/context-types")) {
				return json({ types: opts.types ?? DEFAULT_TYPES });
			}
			if (url.includes("/api/contexts/") && method === "DELETE") {
				if (opts.deleteThrow) throw new Error("offline");
				const status = opts.deleteStatus ?? 204;
				return new Response(null, { status });
			}
			if (url.includes("/api/contexts")) {
				const contexts = opts.contexts ?? [];
				return json(
					{ contexts, total: opts.total ?? contexts.length },
					opts.contextsStatus ?? 200,
				);
			}
			return json({});
		}),
	);
	return calls;
}

function lastContextsGet(calls: FetchCall[]): FetchCall | undefined {
	return [...calls].reverse().find((c) => c.method === "GET" && c.url.includes("/api/contexts?"));
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	mockCopy.mockReset();
	mockCopy.mockResolvedValue(true);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("ContextsTab — chips + list", () => {
	test("renders type chips live from /api/context-types plus an All chip", async () => {
		stubFetch({ contexts: [makeContext()], total: 1 });
		render(ContextsTab, { projectId: "p1" });
		await waitFor(() => expect(screen.queryByTestId("context-type-chip-decision")).not.toBeNull());
		expect(screen.getByTestId("context-type-chip-all").textContent?.trim()).toBe("All");
		expect(screen.getByTestId("context-type-chip-feature").textContent?.trim()).toBe("Feature");
		expect(screen.getByTestId("context-type-chip-bug-fix").textContent?.trim()).toBe("Bug Fix");
	});

	test("initial fetch sends projectId + limit and renders rows (plural count)", async () => {
		const calls = stubFetch({
			contexts: [makeContext({ id: "a" }), makeContext({ id: "b", title: "Second" })],
			total: 2,
		});
		render(ContextsTab, { projectId: "p1" });
		await waitFor(() => expect(screen.getAllByTestId("context-row").length).toBe(2));

		const get = lastContextsGet(calls);
		expect(get?.url).toContain("projectId=p1");
		expect(get?.url).toContain("limit=50");
		expect(screen.getByText("2 contexts")).not.toBeNull();
	});

	test('"global" project omits the projectId param (cross-project listing)', async () => {
		const calls = stubFetch({ contexts: [makeContext()], total: 1 });
		render(ContextsTab, { projectId: "global" });
		await waitFor(() => expect(lastContextsGet(calls)).toBeTruthy());
		expect(lastContextsGet(calls)?.url).not.toContain("projectId=");
	});
});

describe("ContextsTab — search + filters", () => {
	test("debounced search assembles the fetch URL after 300ms", async () => {
		const calls = stubFetch({ contexts: [makeContext()], total: 1 });
		render(ContextsTab, { projectId: "p1" });
		await waitFor(() => expect(screen.queryByTestId("contexts-search")).not.toBeNull());

		const before = calls.filter((c) => c.method === "GET" && c.url.includes("/api/contexts?")).length;
		await fireEvent.input(screen.getByTestId("contexts-search"), { target: { value: "roadmap" } });
		// No request until the debounce elapses.
		expect(
			calls.filter((c) => c.method === "GET" && c.url.includes("/api/contexts?")).length,
		).toBe(before);

		vi.advanceTimersByTime(300);
		await waitFor(() => {
			const get = lastContextsGet(calls);
			expect(get?.url).toContain("search=roadmap");
		});
		expect(lastContextsGet(calls)?.url).toContain("projectId=p1");
	});

	test("clicking a type chip re-fetches with typeId", async () => {
		const calls = stubFetch({ contexts: [makeContext()], total: 1 });
		render(ContextsTab, { projectId: "p1" });
		await waitFor(() => expect(screen.queryByTestId("context-type-chip-decision")).not.toBeNull());

		await fireEvent.click(screen.getByTestId("context-type-chip-decision"));
		await waitFor(() => expect(lastContextsGet(calls)?.url).toContain("typeId=decision"));

		// Clicking "All" clears the type filter (drops the typeId param).
		await fireEvent.click(screen.getByTestId("context-type-chip-all"));
		await waitFor(() => expect(lastContextsGet(calls)?.url).not.toContain("typeId="));
	});
});

describe("ContextsTab — row expand + copy", () => {
	test("clicking a row expands it to the full content and toggles closed again", async () => {
		stubFetch({ contexts: [makeContext()], total: 1 });
		render(ContextsTab, { projectId: "p1" });
		const row = await waitFor(() => screen.getByTestId("context-row"));

		expect(screen.queryByTestId("context-content")).toBeNull();
		await fireEvent.click(within(row).getByText(/switch to JWT/));
		expect(screen.getByTestId("context-content").textContent).toContain("rotate refresh tokens");

		// Collapse.
		await fireEvent.click(within(row).getByText(/switch to JWT/));
		expect(screen.queryByTestId("context-content")).toBeNull();
	});

	test("expanded row renders a conversation deep-link for a real project", async () => {
		stubFetch({ contexts: [makeContext({ conversationId: "conv-9" })], total: 1 });
		render(ContextsTab, { projectId: "p1" });
		const row = await waitFor(() => screen.getByTestId("context-row"));
		await fireEvent.click(within(row).getByText(/switch to JWT/));
		const link = screen.getByTestId("context-conversation-link");
		expect(link.getAttribute("href")).toBe("/project/p1/chat/conv-9");
	});

	test("Copy calls copyToClipboard and flashes the copied badge (mock true)", async () => {
		mockCopy.mockResolvedValue(true);
		stubFetch({ contexts: [makeContext()], total: 1 });
		render(ContextsTab, { projectId: "p1" });
		const row = await waitFor(() => screen.getByTestId("context-row"));
		await fireEvent.click(within(row).getByText(/switch to JWT/));

		await fireEvent.click(screen.getByTestId("context-copy"));
		expect(mockCopy).toHaveBeenCalledWith(expect.stringContaining("rotate refresh tokens"));
		await waitFor(() => expect(screen.getByTestId("context-copy").textContent).toContain("Copied"));

		// The badge reverts to "Copy" after the 2s flash window.
		vi.advanceTimersByTime(2000);
		await waitFor(() =>
			expect(screen.getByTestId("context-copy").textContent).not.toContain("Copied"),
		);
	});

	test("Copy that fails (mock false) shows no copied badge", async () => {
		mockCopy.mockResolvedValue(false);
		stubFetch({ contexts: [makeContext()], total: 1 });
		render(ContextsTab, { projectId: "p1" });
		const row = await waitFor(() => screen.getByTestId("context-row"));
		await fireEvent.click(within(row).getByText(/switch to JWT/));

		await fireEvent.click(screen.getByTestId("context-copy"));
		await waitFor(() => expect(mockCopy).toHaveBeenCalled());
		expect(screen.getByTestId("context-copy").textContent).toContain("Copy");
		expect(screen.getByTestId("context-copy").textContent).not.toContain("Copied");
	});
});

describe("ContextsTab — delete (optimistic + rollback)", () => {
	async function openRow() {
		const row = await waitFor(() => screen.getByTestId("context-row"));
		await fireEvent.click(within(row).getByText(/switch to JWT/));
		return row;
	}

	test("click-to-confirm: first click confirms, second removes the row (204)", async () => {
		const calls = stubFetch({ contexts: [makeContext({ id: "doomed" })], total: 1, deleteStatus: 204 });
		render(ContextsTab, { projectId: "p1" });
		await openRow();

		const del = screen.getByTestId("context-delete");
		await fireEvent.click(del);
		expect(del.textContent?.trim()).toBe("Confirm Delete?");
		expect(calls.some((c) => c.method === "DELETE")).toBe(false);

		await fireEvent.click(screen.getByTestId("context-delete"));
		await waitFor(() =>
			expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/api/contexts/doomed"))).toBe(true),
		);
		await waitFor(() => expect(screen.queryByTestId("context-row")).toBeNull());
	});

	test("confirm state auto-resets after 3s of inactivity", async () => {
		stubFetch({ contexts: [makeContext({ id: "patient" })], total: 1 });
		render(ContextsTab, { projectId: "p1" });
		await openRow();

		const del = screen.getByTestId("context-delete");
		await fireEvent.click(del);
		expect(del.textContent?.trim()).toBe("Confirm Delete?");
		vi.advanceTimersByTime(3000);
		await waitFor(() => expect(screen.getByTestId("context-delete").textContent?.trim()).toBe("Delete"));
	});

	test("API error rolls the optimistic removal back", async () => {
		stubFetch({ contexts: [makeContext({ id: "rollback-500" })], total: 1, deleteStatus: 500 });
		render(ContextsTab, { projectId: "p1" });
		await openRow();

		await fireEvent.click(screen.getByTestId("context-delete")); // confirm
		await fireEvent.click(screen.getByTestId("context-delete")); // fire DELETE → 500
		await waitFor(() => {
			const row = screen.queryByTestId("context-row");
			expect(row?.getAttribute("data-context-id")).toBe("rollback-500");
		});
	});

	test("network throw during delete rolls the row back", async () => {
		stubFetch({ contexts: [makeContext({ id: "rollback-throw" })], total: 1, deleteThrow: true });
		render(ContextsTab, { projectId: "p1" });
		await openRow();

		await fireEvent.click(screen.getByTestId("context-delete")); // confirm
		await fireEvent.click(screen.getByTestId("context-delete")); // fire DELETE → throw
		await waitFor(() => {
			const row = screen.queryByTestId("context-row");
			expect(row?.getAttribute("data-context-id")).toBe("rollback-throw");
		});
	});
});

describe("ContextsTab — empty states", () => {
	test("no rows + no filters shows the getting-started empty state", async () => {
		stubFetch({ contexts: [], total: 0 });
		render(ContextsTab, { projectId: "p1" });
		await waitFor(() => expect(screen.queryByTestId("contexts-empty")).not.toBeNull());
		expect(screen.getByTestId("contexts-empty").textContent).toMatch(/No saved contexts yet/);
	});

	test("no rows WITH a search shows the filtered-empty message", async () => {
		const calls = stubFetch({ contexts: [], total: 0 });
		render(ContextsTab, { projectId: "p1" });
		await waitFor(() => expect(screen.queryByTestId("contexts-search")).not.toBeNull());

		await fireEvent.input(screen.getByTestId("contexts-search"), { target: { value: "nothing" } });
		vi.advanceTimersByTime(300);
		await waitFor(() => expect(lastContextsGet(calls)?.url).toContain("search=nothing"));
		await waitFor(() =>
			expect(screen.getByTestId("contexts-empty").textContent).toMatch(/match your filters/),
		);
	});
});
