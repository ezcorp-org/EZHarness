/**
 * DOM tests for UsersSection (locked decision 8):
 *   1. Search filters by name and email (case-insensitive)
 *   2. Pagination: 20 rows + Load more (search resets the page window)
 *   3. Conditional badges: role only when ≠ member, status only when
 *      ≠ active, sessions pill only when count > 0
 */
import { describe, test, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import UsersSection from "../settings/UsersSection.svelte";

const currentUser = { id: "admin-1", email: "admin@test.local", name: "Admin", role: "admin" as const };

function makeUsers(n: number) {
	return Array.from({ length: n }, (_, i) => ({
		id: `u${i}`,
		email: `user${i}@test.local`,
		name: `User ${i}`,
		role: "member",
		status: "active",
	}));
}

function stubFetch(users: unknown[], sessions: unknown[] = []) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/api/users")) return Response.json({ users });
			if (url.includes("/api/admin/sessions")) return Response.json({ sessions });
			return Response.json({});
		}),
	);
}

afterEach(() => vi.unstubAllGlobals());

describe("UsersSection search", () => {
	test("filters by name and email, case-insensitive", async () => {
		stubFetch([
			{ id: "u1", email: "alice@corp.io", name: "Alice", role: "member", status: "active" },
			{ id: "u2", email: "bob@corp.io", name: "Bob", role: "member", status: "active" },
		]);
		const { getByTestId, getByText, queryByText } = render(UsersSection, { props: { currentUser } });

		await waitFor(() => {
			expect(getByText("Alice")).toBeInTheDocument();
		});

		await fireEvent.input(getByTestId("users-search"), { target: { value: "ALICE" } });
		expect(getByText("Alice")).toBeInTheDocument();
		expect(queryByText("Bob")).not.toBeInTheDocument();

		// Email match too
		await fireEvent.input(getByTestId("users-search"), { target: { value: "bob@corp" } });
		expect(queryByText("Alice")).not.toBeInTheDocument();
		expect(getByText("Bob")).toBeInTheDocument();

		// No match → empty message
		await fireEvent.input(getByTestId("users-search"), { target: { value: "zzz" } });
		expect(getByText('No users match "zzz".')).toBeInTheDocument();
	});
});

describe("UsersSection pagination", () => {
	test("renders 20 rows then loads more", async () => {
		stubFetch(makeUsers(45));
		const { getByTestId, getByText, queryByText } = render(UsersSection, { props: { currentUser } });

		await waitFor(() => {
			expect(getByText("User 0")).toBeInTheDocument();
		});
		expect(getByText("User 19")).toBeInTheDocument();
		expect(queryByText("User 20")).not.toBeInTheDocument();
		expect(getByTestId("users-load-more")).toHaveTextContent("Load more (25 remaining)");

		await fireEvent.click(getByTestId("users-load-more"));
		expect(getByText("User 39")).toBeInTheDocument();
		expect(getByTestId("users-load-more")).toHaveTextContent("Load more (5 remaining)");

		await fireEvent.click(getByTestId("users-load-more"));
		expect(getByText("User 44")).toBeInTheDocument();
		expect(queryByText(/Load more/)).not.toBeInTheDocument();
	});

	test("search resets the page window", async () => {
		stubFetch(makeUsers(30));
		const { getByTestId, getByText, queryByTestId } = render(UsersSection, { props: { currentUser } });

		await waitFor(() => {
			expect(getByText("User 0")).toBeInTheDocument();
		});
		await fireEvent.click(getByTestId("users-load-more"));
		// "User 2" matches User 2 / 20-29 → 11 results, all visible.
		await fireEvent.input(getByTestId("users-search"), { target: { value: "User 2" } });
		expect(getByText("User 29")).toBeInTheDocument();
		expect(queryByTestId("users-load-more")).not.toBeInTheDocument();
	});
});

describe("UsersSection load failure", () => {
	test("failed /api/users fetch shows an error state, not the empty message", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/api/users")) return Response.json({ error: "boom" }, { status: 500 });
				if (url.includes("/api/admin/sessions")) return Response.json({ sessions: [] });
				return Response.json({});
			}),
		);
		const { getByTestId, queryByText } = render(UsersSection, { props: { currentUser } });

		await waitFor(() => {
			expect(getByTestId("users-load-error")).toHaveTextContent("Failed to load users.");
		});
		expect(queryByText("No users found.")).not.toBeInTheDocument();
	});

	test("Retry recovers once the fetch succeeds", async () => {
		let usersCalls = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/api/users")) {
					usersCalls += 1;
					if (usersCalls === 1) return Response.json({ error: "boom" }, { status: 500 });
					return Response.json({
						users: [{ id: "u1", email: "alice@corp.io", name: "Alice", role: "member", status: "active" }],
					});
				}
				if (url.includes("/api/admin/sessions")) return Response.json({ sessions: [] });
				return Response.json({});
			}),
		);
		const { getByTestId, getByText, queryByTestId } = render(UsersSection, { props: { currentUser } });

		await waitFor(() => {
			expect(getByTestId("users-load-error")).toBeInTheDocument();
		});

		await fireEvent.click(getByText("Retry"));
		await waitFor(() => {
			expect(getByText("Alice")).toBeInTheDocument();
		});
		expect(queryByTestId("users-load-error")).not.toBeInTheDocument();
	});
});

describe("UsersSection conditional badges", () => {
	test("default member/active/0-sessions row renders no badges", async () => {
		stubFetch([{ id: "u1", email: "plain@corp.io", name: "Plain", role: "member", status: "active" }]);
		const { getByText, queryByText, queryByTitle } = render(UsersSection, { props: { currentUser } });

		await waitFor(() => {
			expect(getByText("Plain")).toBeInTheDocument();
		});
		expect(queryByText("member")).not.toBeInTheDocument();
		expect(queryByText("active")).not.toBeInTheDocument();
		expect(queryByTitle("Active sessions")).not.toBeInTheDocument();
	});

	test("admin/inactive/with-sessions row renders all badges", async () => {
		stubFetch(
			[{ id: "u1", email: "boss@corp.io", name: "Boss", role: "admin", status: "inactive" }],
			[{ id: "s1", userId: "u1", userName: "Boss", userEmail: "boss@corp.io", userAgent: null, ipAddress: null, lastActiveAt: null, createdAt: "2026-01-01T00:00:00Z" }],
		);
		const { getByText, getByTitle } = render(UsersSection, { props: { currentUser } });

		await waitFor(() => {
			expect(getByText("admin")).toBeInTheDocument();
		});
		expect(getByText("inactive")).toBeInTheDocument();
		expect(getByTitle("Active sessions")).toHaveTextContent("1 sessions");
	});
});
