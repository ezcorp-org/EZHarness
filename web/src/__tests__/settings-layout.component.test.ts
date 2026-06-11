/**
 * DOM tests for the settings shell (`settings/+layout.svelte`):
 *   1. Nav renders all member items; admin entry hidden for members
 *   2. Admin entry (with "admin" badge) appears for admin users
 *   3. Active item derives from page.url.pathname (aria-current)
 *   4. Nested audit route highlights the Audit Log child, not Admin
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { page } from "$app/state";
import Layout from "../routes/(app)/settings/+layout.svelte";

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

beforeEach(() => setPath("/settings/models"));
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
