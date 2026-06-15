/**
 * DOM tests for the settings shell (`settings/+layout.svelte`):
 *   1. Nav renders all member items; admin entry hidden for members
 *   2. Admin entry (with "admin" badge) appears for admin users
 *   3. Active item derives from page.url.pathname (aria-current)
 *   4. Nested audit route highlights the Audit Log child, not Admin
 *   5. Search filter narrows the nav; Enter navigates to the top match;
 *      admin matches stay hidden for members
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { page } from "$app/state";
import { goto } from "$app/navigation";
import Layout from "../routes/(app)/settings/+layout.svelte";

const gotoMock = vi.mocked(goto);

vi.mock("$app/navigation", () => ({ goto: vi.fn() }));

const children = createRawSnippet(() => ({
	render: () => `<div data-testid="layout-children">content</div>`,
}));

function stubMe(role: "admin" | "member" | null) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/api/auth/me")) {
				if (role === null) return new Response("{}", { status: 401 });
				return Response.json({
					user: { id: "u1", email: "u@test.local", name: "U", role },
				});
			}
			return Response.json({});
		}),
	);
}

function setPath(pathname: string) {
	// The stub types `page.url.pathname` against SvelteKit's generated
	// route union — cast through the stub's own type for arbitrary paths.
	page.url = { pathname, search: "", href: `http://localhost${pathname}` } as unknown as typeof page.url;
}

beforeEach(() => {
	setPath("/settings/models");
	gotoMock.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("settings layout nav", () => {
	test("renders member items and children; hides admin entries", async () => {
		stubMe("member");
		const { getByTestId, queryByTestId } = render(Layout, { props: { children } });

		expect(getByTestId("layout-children")).toBeInTheDocument();
		expect(getByTestId("settings-nav-models")).toBeInTheDocument();
		expect(getByTestId("settings-nav-personalization")).toBeInTheDocument();
		expect(getByTestId("settings-nav-developer")).toBeInTheDocument();
		expect(getByTestId("settings-nav-briefing")).toBeInTheDocument();

		// /api/auth/me resolves async — admin items must stay hidden after it lands
		await waitFor(() => {
			expect(queryByTestId("settings-nav-admin")).not.toBeInTheDocument();
			expect(queryByTestId("settings-nav-admin-audit")).not.toBeInTheDocument();
		});
	});

	test("shows admin entry with badge for admins", async () => {
		stubMe("admin");
		const { getByTestId } = render(Layout, { props: { children } });

		await waitFor(() => {
			expect(getByTestId("settings-nav-admin")).toBeInTheDocument();
		});
		expect(getByTestId("settings-nav-admin")).toHaveTextContent("admin");
		expect(getByTestId("settings-nav-admin-audit")).toBeInTheDocument();
	});

	test("active item derived from pathname", async () => {
		stubMe("member");
		setPath("/settings/personalization");
		const { getByTestId } = render(Layout, { props: { children } });

		expect(getByTestId("settings-nav-personalization")).toHaveAttribute("aria-current", "page");
		expect(getByTestId("settings-nav-models")).not.toHaveAttribute("aria-current");
	});

	test("System and Moderation links render for admins with canonical hrefs", async () => {
		stubMe("admin");
		const { getByTestId } = render(Layout, { props: { children } });

		await waitFor(() => {
			expect(getByTestId("settings-nav-system")).toBeInTheDocument();
		});
		expect(getByTestId("settings-nav-system")).toHaveAttribute("href", "/admin/dashboard");
		expect(getByTestId("settings-nav-system")).toHaveTextContent("System");
		expect(getByTestId("settings-nav-moderation")).toHaveAttribute("href", "/admin/moderation");
		expect(getByTestId("settings-nav-moderation")).toHaveTextContent("Moderation");
	});

	test("System and Moderation links are hidden for members", async () => {
		stubMe("member");
		const { queryByTestId } = render(Layout, { props: { children } });

		await waitFor(() => {
			expect(queryByTestId("settings-nav-system")).not.toBeInTheDocument();
			expect(queryByTestId("settings-nav-moderation")).not.toBeInTheDocument();
		});
	});

	test("audit child route highlights Audit Log, not Admin", async () => {
		stubMe("admin");
		setPath("/settings/admin/audit");
		const { getByTestId } = render(Layout, { props: { children } });

		await waitFor(() => {
			expect(getByTestId("settings-nav-admin-audit")).toHaveAttribute("aria-current", "page");
		});
		expect(getByTestId("settings-nav-admin")).not.toHaveAttribute("aria-current");
	});

	test("anonymous user (401) sees only member items", async () => {
		stubMe(null);
		const { getByTestId, queryByTestId } = render(Layout, { props: { children } });

		expect(getByTestId("settings-nav-models")).toBeInTheDocument();
		await waitFor(() => {
			expect(queryByTestId("settings-nav-admin")).not.toBeInTheDocument();
		});
	});
});

describe("settings layout search filter", () => {
	test("typing narrows the visible nav entries", async () => {
		stubMe("member");
		const { getByTestId, queryByTestId } = render(Layout, { props: { children } });

		await fireEvent.input(getByTestId("settings-nav-search"), { target: { value: "provider" } });

		// "provider" is an anchor of Models & Providers only.
		expect(getByTestId("settings-nav-models")).toBeInTheDocument();
		expect(queryByTestId("settings-nav-personalization")).not.toBeInTheDocument();
		expect(queryByTestId("settings-nav-developer")).not.toBeInTheDocument();
	});

	test("no match shows the empty state", async () => {
		stubMe("member");
		const { getByTestId, queryByTestId } = render(Layout, { props: { children } });

		await fireEvent.input(getByTestId("settings-nav-search"), { target: { value: "zzz-nope" } });

		expect(getByTestId("settings-nav-empty")).toBeInTheDocument();
		expect(queryByTestId("settings-nav-models")).not.toBeInTheDocument();
	});

	test("Enter navigates to the top match", async () => {
		stubMe("member");
		const { getByTestId } = render(Layout, { props: { children } });

		const input = getByTestId("settings-nav-search");
		await fireEvent.input(input, { target: { value: "personal" } });
		await fireEvent.keyDown(input, { key: "Enter" });

		expect(gotoMock).toHaveBeenCalledWith("/settings/personalization");
	});

	test("Enter is a no-op when there is no match", async () => {
		stubMe("member");
		const { getByTestId } = render(Layout, { props: { children } });

		const input = getByTestId("settings-nav-search");
		await fireEvent.input(input, { target: { value: "zzz-nope" } });
		await fireEvent.keyDown(input, { key: "Enter" });

		expect(gotoMock).not.toHaveBeenCalled();
	});

	test("admin-only matches stay hidden for members", async () => {
		stubMe("member");
		const { getByTestId, queryByTestId } = render(Layout, { props: { children } });

		// Let /api/auth/me resolve so isAdmin settles to false.
		await waitFor(() => expect(queryByTestId("settings-nav-admin")).not.toBeInTheDocument());

		// "teams" only matches the admin entry → empty for members.
		await fireEvent.input(getByTestId("settings-nav-search"), { target: { value: "teams" } });

		expect(getByTestId("settings-nav-empty")).toBeInTheDocument();
		expect(queryByTestId("settings-nav-admin")).not.toBeInTheDocument();
	});

	test("admin sees admin matches when filtering", async () => {
		stubMe("admin");
		const { getByTestId } = render(Layout, { props: { children } });

		await waitFor(() => expect(getByTestId("settings-nav-admin")).toBeInTheDocument());

		await fireEvent.input(getByTestId("settings-nav-search"), { target: { value: "teams" } });

		expect(getByTestId("settings-nav-admin")).toBeInTheDocument();
	});
});
