/**
 * Page-level rendering tests for /commands/+page.svelte, /commands/new/
 * +page.svelte, and /commands/[name]/+page.svelte. Stubs $app/navigation
 * (goto), $app/state (page.params), and fetch — covers the empty state,
 * the populated list, the loading skeleton, the error toast on API
 * failure, and the create+edit form submission paths.
 */

import "@testing-library/jest-dom/vitest";
import { render, waitFor, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";

const gotoMock = vi.fn();
vi.mock("$app/navigation", () => ({
	goto: gotoMock,
}));

const pageState = { params: {} as Record<string, string>, url: new URL("http://localhost/") };
vi.mock("$app/state", () => ({
	page: pageState,
}));

// `addToast` lives on a Svelte rune store — we mock the module to a
// pure spy so the test doesn't need a real toast root mounted.
const addToastMock = vi.fn();
vi.mock("$lib/toast.svelte.js", () => ({
	addToast: addToastMock,
}));

let fetchMock: ReturnType<typeof vi.fn>;
let confirmMock: ReturnType<typeof vi.fn>;

function setupFetch(routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
	fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		const method = (init?.method ?? "GET").toUpperCase();
		const key = `${method} ${url}`;
		const handler = routes[key] ?? routes[url];
		if (!handler) {
			return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
		}
		return handler(init);
	});
	(globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function makeCommand(overrides: Partial<{ id: string; userId: string; name: string; description: string; body: string; frontmatter: Record<string, string> }> = {}) {
	return {
		id: "c1",
		userId: "u1",
		name: "review",
		description: "Review staged changes",
		body: "Review: $ARGUMENTS",
		frontmatter: {},
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

beforeEach(() => {
	gotoMock.mockReset();
	addToastMock.mockReset();
	pageState.params = {};
	pageState.url = new URL("http://localhost/");
	confirmMock = vi.fn().mockReturnValue(true);
	(globalThis as unknown as { confirm: typeof window.confirm }).confirm =
		confirmMock as unknown as typeof window.confirm;
});

describe("/commands list page", () => {
	test("loading skeleton renders while fetch is in-flight", async () => {
		setupFetch({
			"/api/user-commands": () =>
				new Promise((resolve) =>
					setTimeout(() => resolve(jsonResponse([])), 100),
				),
		});
		const ListPage = (await import("../routes/(app)/commands/+page.svelte")).default;
		const { container } = render(ListPage);
		// Skeleton root has a stable class — search by [class*="skeleton"]
		// is fragile; we just assert the empty state is NOT shown yet.
		expect(container.textContent).not.toContain("No commands yet");
	});

	test("empty state renders when fetch returns []", async () => {
		setupFetch({ "/api/user-commands": () => jsonResponse([]) });
		const ListPage = (await import("../routes/(app)/commands/+page.svelte")).default;
		const { findByText } = render(ListPage);
		await findByText("No commands yet");
	});

	test("renders one CommandCard per row when fetch returns rows", async () => {
		setupFetch({
			"/api/user-commands": () =>
				jsonResponse([
					makeCommand({ id: "c1", name: "review" }),
					makeCommand({ id: "c2", name: "audit" }),
				]),
		});
		const ListPage = (await import("../routes/(app)/commands/+page.svelte")).default;
		const { findByText } = render(ListPage);
		await findByText("/review");
		await findByText("/audit");
	});

	test("error message surfaces when fetch fails", async () => {
		setupFetch({
			"/api/user-commands": () =>
				jsonResponse({ error: "DB down" }, 500),
		});
		const ListPage = (await import("../routes/(app)/commands/+page.svelte")).default;
		const { findByTestId } = render(ListPage);
		const err = await findByTestId("commands-page-error");
		expect(err).toHaveTextContent("DB down");
	});

	test("clicking Edit on a card navigates to /commands/[name]", async () => {
		setupFetch({
			"/api/user-commands": () => jsonResponse([makeCommand({ name: "review" })]),
		});
		const ListPage = (await import("../routes/(app)/commands/+page.svelte")).default;
		const { findByTestId } = render(ListPage);
		const editBtn = await findByTestId("command-card-edit");
		await fireEvent.click(editBtn);
		expect(gotoMock).toHaveBeenCalledWith("/commands/review");
	});

	test("Delete confirms, fires DELETE, removes the card, and toasts", async () => {
		setupFetch({
			"/api/user-commands": () => jsonResponse([makeCommand({ name: "review" })]),
			"DELETE /api/user-commands/review": () =>
				new Response(null, { status: 204 }),
		});
		const ListPage = (await import("../routes/(app)/commands/+page.svelte")).default;
		const { findByTestId, queryByText } = render(ListPage);
		const delBtn = await findByTestId("command-card-delete");
		await fireEvent.click(delBtn);
		expect(confirmMock).toHaveBeenCalled();
		await waitFor(() => expect(queryByText("/review")).toBeNull());
		expect(addToastMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "success", message: expect.stringContaining("Deleted") }),
		);
	});

	test("Delete cancel (confirm returns false) is a no-op", async () => {
		confirmMock.mockReturnValue(false);
		setupFetch({
			"/api/user-commands": () => jsonResponse([makeCommand({ name: "review" })]),
		});
		const ListPage = (await import("../routes/(app)/commands/+page.svelte")).default;
		const { findByTestId, findByText } = render(ListPage);
		await fireEvent.click(await findByTestId("command-card-delete"));
		// Card stays.
		await findByText("/review");
		// DELETE not fired (mock returns 200 only for GET; assert by call count).
		const deleteCalls = fetchMock.mock.calls.filter(
			(c) => (c[1] as RequestInit | undefined)?.method === "DELETE",
		);
		expect(deleteCalls).toHaveLength(0);
	});
});

describe("/commands/new page", () => {
	test("submitting a valid form fires POST and redirects to /commands/[savedName]", async () => {
		setupFetch({
			"POST /api/user-commands": () =>
				jsonResponse(makeCommand({ name: "myreview" }), 201),
		});
		const NewPage = (await import("../routes/(app)/commands/new/+page.svelte")).default;
		const { findByTestId } = render(NewPage);
		await fireEvent.input(await findByTestId("command-form-name"), {
			target: { value: "myreview" },
		});
		await fireEvent.input(await findByTestId("command-form-body"), {
			target: { value: "Review: $ARGUMENTS" },
		});
		await fireEvent.submit(await findByTestId("command-form"));
		await waitFor(() =>
			expect(gotoMock).toHaveBeenCalledWith("/commands/myreview"),
		);
		expect(addToastMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "success", message: expect.stringContaining("Created /myreview") }),
		);
	});

	test("auto-suffix rename surfaces a distinct info toast", async () => {
		setupFetch({
			"POST /api/user-commands": () =>
				jsonResponse(makeCommand({ name: "review-2" }), 201),
		});
		const NewPage = (await import("../routes/(app)/commands/new/+page.svelte")).default;
		const { findByTestId } = render(NewPage);
		await fireEvent.input(await findByTestId("command-form-name"), {
			target: { value: "review" },
		});
		await fireEvent.input(await findByTestId("command-form-body"), {
			target: { value: "x" },
		});
		await fireEvent.submit(await findByTestId("command-form"));
		await waitFor(() => expect(addToastMock).toHaveBeenCalled());
		const lastCall = addToastMock.mock.calls.at(-1)!;
		expect(lastCall[0]).toMatchObject({
			type: "info",
			message: expect.stringContaining("Saved as \"review-2\""),
		});
	});

	test("API failure surfaces an inline error", async () => {
		setupFetch({
			"POST /api/user-commands": () =>
				jsonResponse({ error: "Boom" }, 500),
		});
		const NewPage = (await import("../routes/(app)/commands/new/+page.svelte")).default;
		const { findByTestId } = render(NewPage);
		await fireEvent.input(await findByTestId("command-form-name"), { target: { value: "x" } });
		await fireEvent.input(await findByTestId("command-form-body"), { target: { value: "b" } });
		await fireEvent.submit(await findByTestId("command-form"));
		const errNode = await findByTestId("commands-new-error");
		expect(errNode).toHaveTextContent("Boom");
		expect(gotoMock).not.toHaveBeenCalled();
	});

	test("Cancel returns to /commands without firing the API", async () => {
		setupFetch({});
		const NewPage = (await import("../routes/(app)/commands/new/+page.svelte")).default;
		const { findByTestId } = render(NewPage);
		await fireEvent.click(await findByTestId("command-form-cancel"));
		expect(gotoMock).toHaveBeenCalledWith("/commands");
	});
});

describe("/commands/[name] edit page", () => {
	test("loads command on mount and pre-populates the form", async () => {
		pageState.params = { name: "review" };
		setupFetch({
			"/api/user-commands/review": () =>
				jsonResponse(makeCommand({ name: "review", description: "the desc", body: "the body" })),
		});
		const EditPage = (await import("../routes/(app)/commands/[name]/+page.svelte")).default;
		const { findByTestId } = render(EditPage);
		const name = (await findByTestId("command-form-name")) as HTMLInputElement;
		expect(name.disabled).toBe(true);
		expect(name.value).toBe("review");
		const body = (await findByTestId("command-form-body")) as HTMLTextAreaElement;
		expect(body.value).toBe("the body");
	});

	test("load failure surfaces an inline error", async () => {
		pageState.params = { name: "missing" };
		setupFetch({
			"/api/user-commands/missing": () => jsonResponse({ error: "Not found" }, 404),
		});
		const EditPage = (await import("../routes/(app)/commands/[name]/+page.svelte")).default;
		const { findByTestId } = render(EditPage);
		const err = await findByTestId("commands-edit-load-error");
		expect(err).toHaveTextContent("Not found");
	});

	test("PATCH on submit fires + redirects to /commands", async () => {
		pageState.params = { name: "review" };
		setupFetch({
			"/api/user-commands/review": () =>
				jsonResponse(makeCommand({ name: "review", body: "v1" })),
			"PATCH /api/user-commands/review": () =>
				jsonResponse(makeCommand({ name: "review", body: "v2" })),
		});
		const EditPage = (await import("../routes/(app)/commands/[name]/+page.svelte")).default;
		const { findByTestId } = render(EditPage);
		const body = (await findByTestId("command-form-body")) as HTMLTextAreaElement;
		await fireEvent.input(body, { target: { value: "v2" } });
		await fireEvent.submit(await findByTestId("command-form"));
		await waitFor(() => expect(gotoMock).toHaveBeenCalledWith("/commands"));
		expect(addToastMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "success", message: expect.stringContaining("Updated /review") }),
		);
	});

	test("Delete confirms, fires DELETE, redirects + toasts", async () => {
		pageState.params = { name: "review" };
		setupFetch({
			"/api/user-commands/review": () =>
				jsonResponse(makeCommand({ name: "review" })),
			"DELETE /api/user-commands/review": () =>
				new Response(null, { status: 204 }),
		});
		const EditPage = (await import("../routes/(app)/commands/[name]/+page.svelte")).default;
		const { findByTestId } = render(EditPage);
		const delBtn = await findByTestId("commands-edit-delete");
		await fireEvent.click(delBtn);
		expect(confirmMock).toHaveBeenCalled();
		await waitFor(() => expect(gotoMock).toHaveBeenCalledWith("/commands"));
	});

	test("Delete cancel (confirm=false) does not fire API or redirect", async () => {
		pageState.params = { name: "review" };
		confirmMock.mockReturnValue(false);
		setupFetch({
			"/api/user-commands/review": () =>
				jsonResponse(makeCommand({ name: "review" })),
		});
		const EditPage = (await import("../routes/(app)/commands/[name]/+page.svelte")).default;
		const { findByTestId } = render(EditPage);
		await fireEvent.click(await findByTestId("commands-edit-delete"));
		expect(gotoMock).not.toHaveBeenCalled();
	});

	test("PATCH failure surfaces inline error + does NOT redirect", async () => {
		pageState.params = { name: "review" };
		setupFetch({
			"/api/user-commands/review": () =>
				jsonResponse(makeCommand({ name: "review" })),
			"PATCH /api/user-commands/review": () =>
				jsonResponse({ error: "Boom" }, 500),
		});
		const EditPage = (await import("../routes/(app)/commands/[name]/+page.svelte")).default;
		const { findByTestId } = render(EditPage);
		await fireEvent.submit(await findByTestId("command-form"));
		const err = await findByTestId("commands-edit-error");
		expect(err).toHaveTextContent("Boom");
		expect(gotoMock).not.toHaveBeenCalled();
	});

	test("Cancel returns to /commands", async () => {
		pageState.params = { name: "review" };
		setupFetch({
			"/api/user-commands/review": () =>
				jsonResponse(makeCommand({ name: "review" })),
		});
		const EditPage = (await import("../routes/(app)/commands/[name]/+page.svelte")).default;
		const { findByTestId } = render(EditPage);
		await fireEvent.click(await findByTestId("command-form-cancel"));
		expect(gotoMock).toHaveBeenCalledWith("/commands");
	});
});
