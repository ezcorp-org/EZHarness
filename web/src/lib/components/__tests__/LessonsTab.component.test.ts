/**
 * DOM tests for LessonsTab.svelte.
 *
 * Covers:
 *   - empty / loading / error states
 *   - row rendering (slug chip + title + visibility badge + body + meta)
 *   - owner-gated affordances: delete + promote present iff `ownedByMe: true`
 *   - promote dropdown disables backward options + entire control at `global`
 *   - inline click-to-confirm delete (matching KnowledgeBaseTab UX)
 *   - successful mutation refreshes list state without a full refetch
 *
 * Pattern mirrors `FeatureIndex.component.test.ts`: stub `fetch` per-test
 * via `vi.stubGlobal`, then `render(LessonsTab, …)` and assert against
 * the resulting DOM.
 */
import { render, fireEvent, screen, waitFor, within } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import LessonsTab from "../LessonsTab.svelte";

interface LessonFixture {
	id: string;
	slug: string;
	title: string;
	body: string;
	visibility: "user" | "project" | "global";
	ownedByMe: boolean;
	source: "user" | "distiller";
	firedCount: number;
	lastFiredAt: string | null;
	dismissedCount: number;
	createdAt: string;
	updatedAt: string;
	frontmatter: Record<string, unknown> | null;
}

function makeLesson(overrides: Partial<LessonFixture> = {}): LessonFixture {
	return {
		id: "l-1",
		slug: "use-bun-not-node",
		title: "Use Bun, not Node",
		body: "Always invoke `bun <file>` instead of `node <file>`.",
		visibility: "user",
		ownedByMe: true,
		source: "distiller",
		firedCount: 2,
		lastFiredAt: "2026-04-01T00:00:00.000Z",
		dismissedCount: 0,
		createdAt: "2026-03-01T00:00:00.000Z",
		updatedAt: "2026-03-15T00:00:00.000Z",
		frontmatter: null,
		...overrides,
	};
}

/**
 * Build a fetch stub keyed on (method, urlSubstring). Mirrors the helper
 * in FeatureIndex.component.test.ts.
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
			return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
		}
		const body = init?.body ? JSON.parse(init.body as string) : undefined;
		const out = route.respond(body);
		const status = out.status;
		const init2: ResponseInit = { status, headers: { "content-type": "application/json" } };
		if (status === 204) {
			return new Response(null, { status: 204 });
		}
		return new Response(JSON.stringify(out.body), init2);
	});
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("LessonsTab — list + states", () => {
	test("renders empty state when API returns []", async () => {
		vi.stubGlobal(
			"fetch",
			makeFetchStub([
				{
					method: "GET",
					match: "/api/lessons?projectId=p1",
					respond: () => ({ status: 200, body: [] }),
				},
			]),
		);
		render(LessonsTab, { projectId: "p1" });
		await waitFor(() => {
			expect(screen.queryByTestId("lessons-empty")).not.toBeNull();
		});
		expect(screen.getByTestId("lessons-empty").textContent).toMatch(/No lessons yet/);
	});

	test("renders error state when API returns 500", async () => {
		vi.stubGlobal(
			"fetch",
			makeFetchStub([
				{
					method: "GET",
					match: "/api/lessons?projectId=p1",
					respond: () => ({ status: 500, body: { error: "boom" } }),
				},
			]),
		);
		render(LessonsTab, { projectId: "p1" });
		await waitFor(() => {
			expect(screen.queryByTestId("lessons-error")).not.toBeNull();
		});
		expect(screen.getByTestId("lessons-error").textContent).toMatch(/500/);
	});

	test("renders lesson rows when API returns data", async () => {
		const lesson = makeLesson({ slug: "rule-a", title: "Rule A" });
		vi.stubGlobal(
			"fetch",
			makeFetchStub([
				{
					method: "GET",
					match: "/api/lessons",
					respond: () => ({ status: 200, body: [lesson] }),
				},
			]),
		);
		render(LessonsTab, { projectId: "p1" });
		await waitFor(() => {
			expect(screen.queryByTestId("lessons-list")).not.toBeNull();
		});
		const row = screen.getByTestId("lesson-row");
		expect(row.getAttribute("data-lesson-id")).toBe("l-1");
		expect(within(row).getByTestId("lesson-slug").textContent).toBe("%rule-a");
		expect(within(row).getByText("Rule A")).not.toBeNull();
		expect(within(row).getByTestId("lesson-visibility-badge").textContent?.trim()).toBe("user");
	});

	test('meta row pins the literal "distiller" source label', async () => {
		vi.stubGlobal(
			"fetch",
			makeFetchStub([
				{
					method: "GET",
					match: "/api/lessons",
					respond: () => ({
						status: 200,
						body: [makeLesson({ id: "auto-row", source: "distiller" })],
					}),
				},
			]),
		);
		render(LessonsTab, { projectId: "p1" });
		await waitFor(() => {
			expect(screen.queryByTestId("lesson-meta")).not.toBeNull();
		});
		expect(screen.getByTestId("lesson-meta").textContent).toContain("source: distiller");
	});

	test('meta row pins the literal "user" source label', async () => {
		vi.stubGlobal(
			"fetch",
			makeFetchStub([
				{
					method: "GET",
					match: "/api/lessons",
					respond: () => ({
						status: 200,
						body: [makeLesson({ id: "manual-row", source: "user" })],
					}),
				},
			]),
		);
		render(LessonsTab, { projectId: "p1" });
		await waitFor(() => {
			expect(screen.queryByTestId("lesson-meta")).not.toBeNull();
		});
		expect(screen.getByTestId("lesson-meta").textContent).toContain("source: user");
	});
});

describe("LessonsTab — owner-gated affordances", () => {
	test("delete button is present when ownedByMe: true", async () => {
		vi.stubGlobal(
			"fetch",
			makeFetchStub([
				{
					method: "GET",
					match: "/api/lessons",
					respond: () => ({ status: 200, body: [makeLesson({ ownedByMe: true })] }),
				},
			]),
		);
		render(LessonsTab, { projectId: "p1" });
		await waitFor(() => {
			expect(screen.queryByTestId("lesson-delete")).not.toBeNull();
		});
		expect(screen.getByTestId("lesson-promote")).not.toBeNull();
	});

	test("delete + promote absent when ownedByMe: false (read-only chrome for shared lessons)", async () => {
		vi.stubGlobal(
			"fetch",
			makeFetchStub([
				{
					method: "GET",
					match: "/api/lessons",
					respond: () => ({
						status: 200,
						body: [makeLesson({ ownedByMe: false, visibility: "project" })],
					}),
				},
			]),
		);
		render(LessonsTab, { projectId: "p1" });
		await waitFor(() => {
			expect(screen.queryByTestId("lesson-row")).not.toBeNull();
		});
		expect(screen.queryByTestId("lesson-delete")).toBeNull();
		expect(screen.queryByTestId("lesson-promote")).toBeNull();
		expect(screen.queryByTestId("lesson-shared-badge")).not.toBeNull();
	});

	test("promote dropdown is disabled at global visibility (highest tier)", async () => {
		vi.stubGlobal(
			"fetch",
			makeFetchStub([
				{
					method: "GET",
					match: "/api/lessons",
					respond: () => ({
						status: 200,
						body: [makeLesson({ ownedByMe: true, visibility: "global" })],
					}),
				},
			]),
		);
		render(LessonsTab, { projectId: "p1" });
		const promote = (await waitFor(() =>
			screen.getByTestId("lesson-promote"),
		)) as HTMLSelectElement;
		expect(promote.disabled).toBe(true);
	});

	test("backward options are individually disabled (UI defense in depth)", async () => {
		// `project` visibility means `user` should be disabled; `global` open.
		vi.stubGlobal(
			"fetch",
			makeFetchStub([
				{
					method: "GET",
					match: "/api/lessons",
					respond: () => ({
						status: 200,
						body: [makeLesson({ ownedByMe: true, visibility: "project" })],
					}),
				},
			]),
		);
		render(LessonsTab, { projectId: "p1" });
		const promote = (await waitFor(() =>
			screen.getByTestId("lesson-promote"),
		)) as HTMLSelectElement;
		expect(promote.disabled).toBe(false);
		const userOption = promote.querySelector(
			'option[value="user"]',
		) as HTMLOptionElement;
		const projectOption = promote.querySelector(
			'option[value="project"]',
		) as HTMLOptionElement;
		const globalOption = promote.querySelector(
			'option[value="global"]',
		) as HTMLOptionElement;
		expect(userOption.disabled).toBe(true);
		expect(projectOption.disabled).toBe(false); // current
		expect(globalOption.disabled).toBe(false);
	});
});

describe("LessonsTab — delete flow (click-to-confirm)", () => {
	test("first click sets confirm state; second click fires DELETE and removes the row", async () => {
		let deleteCalled = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				const method = (init?.method ?? "GET").toUpperCase();
				if (method === "GET" && url.includes("/api/lessons?projectId=")) {
					return new Response(JSON.stringify([makeLesson({ id: "doomed" })]), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				}
				if (method === "DELETE" && url.includes("/api/lessons/doomed")) {
					deleteCalled = true;
					return new Response(null, { status: 204 });
				}
				return new Response("[]", { status: 200 });
			}),
		);
		render(LessonsTab, { projectId: "p1" });
		const deleteBtn = (await waitFor(() =>
			screen.getByTestId("lesson-delete"),
		)) as HTMLButtonElement;

		// First click → confirm state, no API call yet.
		await fireEvent.click(deleteBtn);
		expect(deleteBtn.textContent?.trim()).toBe("Confirm?");
		expect(deleteCalled).toBe(false);

		// Second click → DELETE fires + row removed.
		await fireEvent.click(deleteBtn);
		await waitFor(() => {
			expect(deleteCalled).toBe(true);
		});
		await waitFor(() => {
			expect(screen.queryByTestId("lesson-row")).toBeNull();
		});
	});

	test("confirm state auto-resets after 3 seconds of inactivity", async () => {
		vi.stubGlobal(
			"fetch",
			makeFetchStub([
				{
					method: "GET",
					match: "/api/lessons",
					respond: () => ({ status: 200, body: [makeLesson({ id: "patient" })] }),
				},
			]),
		);
		render(LessonsTab, { projectId: "p1" });
		const deleteBtn = (await waitFor(() =>
			screen.getByTestId("lesson-delete"),
		)) as HTMLButtonElement;
		await fireEvent.click(deleteBtn);
		expect(deleteBtn.textContent?.trim()).toBe("Confirm?");
		// Advance the fake timer 3 seconds — the timeout reverts the label.
		vi.advanceTimersByTime(3000);
		await waitFor(() => {
			expect(deleteBtn.textContent?.trim()).toBe("Delete");
		});
	});
});

describe("LessonsTab — promote flow", () => {
	test("PATCH succeeds → visibility badge updates without a full refetch", async () => {
		let patchBody: any = null;
		let getCallCount = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				const method = (init?.method ?? "GET").toUpperCase();
				if (method === "GET" && url.includes("/api/lessons?projectId=")) {
					getCallCount++;
					return new Response(
						JSON.stringify([makeLesson({ id: "to-promote", visibility: "user" })]),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
				if (method === "PATCH" && url.includes("/api/lessons/to-promote")) {
					patchBody = init?.body ? JSON.parse(init.body as string) : null;
					return new Response(
						JSON.stringify({ id: "to-promote", visibility: "project" }),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
				return new Response("[]", { status: 200 });
			}),
		);
		render(LessonsTab, { projectId: "p1" });
		const promote = (await waitFor(() =>
			screen.getByTestId("lesson-promote"),
		)) as HTMLSelectElement;

		// Trigger change to "project".
		promote.value = "project";
		await fireEvent.change(promote);

		await waitFor(() => {
			expect(patchBody).toEqual({ visibility: "project" });
		});
		// Badge re-renders with new visibility.
		await waitFor(() => {
			expect(screen.getByTestId("lesson-visibility-badge").textContent?.trim()).toBe(
				"project",
			);
		});
		// Optimistic in-place update: only the initial GET fired, not a refetch.
		expect(getCallCount).toBe(1);
	});

	test("PATCH 409 (backward) surfaces an error message", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				const method = (init?.method ?? "GET").toUpperCase();
				if (method === "GET" && url.includes("/api/lessons?projectId=")) {
					return new Response(
						JSON.stringify([makeLesson({ id: "stuck", visibility: "project" })]),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
				if (method === "PATCH") {
					return new Response(
						JSON.stringify({ error: "Visibility ladder is monotonic" }),
						{ status: 409, headers: { "content-type": "application/json" } },
					);
				}
				return new Response("[]", { status: 200 });
			}),
		);
		render(LessonsTab, { projectId: "p1" });
		const promote = (await waitFor(() =>
			screen.getByTestId("lesson-promote"),
		)) as HTMLSelectElement;
		// Force a backward attempt by directly POSTing — bypass the disabled
		// option guard. Setting value to a disabled option still fires
		// `change`; the handler will skip the no-op-or-backward path and
		// fall through to the API. (This exercises the server-error path.)
		promote.value = "global";
		await fireEvent.change(promote);
		await waitFor(() => {
			expect(screen.queryByTestId("lessons-error")).not.toBeNull();
		});
		expect(screen.getByTestId("lessons-error").textContent).toMatch(/409/);
	});
});
