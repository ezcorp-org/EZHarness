/**
 * DOM tests for UsersSection (Settings v2 — server-side pagination):
 *   1. Server search: typing hits /api/users with `q` (debounced),
 *      server returns the matching page + total
 *   2. Pagination: 20 rows + Load more fetches the next offset, server
 *      `total` drives when the pager disappears; search resets to page 0
 *   3. Conditional badges: role only when ≠ member, status only when
 *      ≠ active, sessions pill only when count > 0
 */
import { describe, test, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import UsersSection from "../settings/UsersSection.svelte";

const currentUser = { id: "admin-1", email: "admin@test.local", name: "Admin", role: "admin" as const };

function makeUsers(n: number, start = 0) {
	return Array.from({ length: n }, (_, i) => ({
		id: `u${start + i}`,
		email: `user${start + i}@test.local`,
		name: `User ${start + i}`,
		role: "member",
		status: "active",
	}));
}

interface UsersRequest {
	limit: number;
	offset: number;
	q: string | null;
}

/**
 * Server-paging stub over a fixed dataset. Records every /api/users
 * request, honours limit/offset/q server-side, and returns
 * `{ users: <page>, total: <filtered count> }`.
 */
function stubPagedFetch(dataset: ReturnType<typeof makeUsers>, sessions: unknown[] = []) {
	const requests: UsersRequest[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://localhost");
			if (url.pathname === "/api/users") {
				const limit = Number(url.searchParams.get("limit"));
				const offset = Number(url.searchParams.get("offset"));
				const q = url.searchParams.get("q");
				requests.push({ limit, offset, q });
				const filtered = q
					? dataset.filter(
							(u) => u.name.toLowerCase().includes(q.toLowerCase()) || u.email.toLowerCase().includes(q.toLowerCase()),
						)
					: dataset;
				return Response.json({ users: filtered.slice(offset, offset + limit), total: filtered.length });
			}
			if (url.pathname === "/api/admin/sessions") return Response.json({ sessions });
			return Response.json({});
		}),
	);
	return requests;
}

function stubFetch(users: unknown[], sessions: unknown[] = []) {
	// Legacy {users}-only stub (no `total`) for the action/badge flows —
	// the component falls back to page length when `total` is omitted.
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

describe("UsersSection server search", () => {
	test("typing hits the server with `q` and renders the matching page", async () => {
		vi.useFakeTimers();
		try {
			const dataset = [
				{ id: "u1", email: "alice@corp.io", name: "Alice", role: "member", status: "active" },
				{ id: "u2", email: "bob@corp.io", name: "Bob", role: "member", status: "active" },
			];
			const requests = stubPagedFetch(dataset);
			const { getByTestId, getByText, queryByText } = render(UsersSection, { props: { currentUser } });

			await vi.advanceTimersByTimeAsync(0);
			expect(getByText("Alice")).toBeInTheDocument();
			expect(getByText("Bob")).toBeInTheDocument();

			// Type → debounce → one server request with q=alice.
			await fireEvent.input(getByTestId("users-search"), { target: { value: "alice" } });
			await vi.advanceTimersByTimeAsync(300);

			expect(getByText("Alice")).toBeInTheDocument();
			expect(queryByText("Bob")).not.toBeInTheDocument();
			expect(requests.some((r) => r.q === "alice" && r.offset === 0)).toBe(true);

			// No match → server returns an empty page → empty message.
			await fireEvent.input(getByTestId("users-search"), { target: { value: "zzz" } });
			await vi.advanceTimersByTimeAsync(300);
			expect(getByText('No users match "zzz".')).toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});

	test("debounces rapid keystrokes into a single request", async () => {
		vi.useFakeTimers();
		try {
			const requests = stubPagedFetch(makeUsers(5));
			const { getByTestId } = render(UsersSection, { props: { currentUser } });
			await vi.advanceTimersByTimeAsync(0);
			const initialCount = requests.length;

			const input = getByTestId("users-search");
			await fireEvent.input(input, { target: { value: "u" } });
			await fireEvent.input(input, { target: { value: "us" } });
			await fireEvent.input(input, { target: { value: "use" } });
			// Only after the debounce window does a single request fire.
			await vi.advanceTimersByTimeAsync(300);

			expect(requests.length).toBe(initialCount + 1);
			expect(requests[requests.length - 1]!.q).toBe("use");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("UsersSection server pagination", () => {
	test("renders the first 20 rows then fetches the next offset", async () => {
		const requests = stubPagedFetch(makeUsers(45));
		const { getByTestId, getByText, queryByText } = render(UsersSection, { props: { currentUser } });

		await waitFor(() => expect(getByText("User 0")).toBeInTheDocument());
		expect(getByText("User 19")).toBeInTheDocument();
		expect(queryByText("User 20")).not.toBeInTheDocument();
		expect(getByTestId("users-load-more")).toHaveTextContent("Load more (25 remaining)");

		await fireEvent.click(getByTestId("users-load-more"));
		await waitFor(() => expect(getByText("User 39")).toBeInTheDocument());
		expect(getByTestId("users-load-more")).toHaveTextContent("Load more (5 remaining)");
		expect(requests.some((r) => r.offset === 20 && r.limit === 20)).toBe(true);

		await fireEvent.click(getByTestId("users-load-more"));
		await waitFor(() => expect(getByText("User 44")).toBeInTheDocument());
		expect(queryByText(/Load more/)).not.toBeInTheDocument();
	});

	test("server search resets paging to offset 0 and re-totals", async () => {
		vi.useFakeTimers();
		try {
			const requests = stubPagedFetch(makeUsers(30));
			const { getByTestId, getByText, queryByTestId } = render(UsersSection, { props: { currentUser } });

			await vi.advanceTimersByTimeAsync(0);
			await fireEvent.click(getByTestId("users-load-more"));
			await vi.advanceTimersByTimeAsync(0);

			// "User 2" matches User 2 + 20-29 → 11 rows ≤ one page → no pager.
			await fireEvent.input(getByTestId("users-search"), { target: { value: "User 2" } });
			await vi.advanceTimersByTimeAsync(300);

			expect(getByText("User 29")).toBeInTheDocument();
			expect(queryByTestId("users-load-more")).not.toBeInTheDocument();
			// The search request started back at offset 0.
			expect(requests.some((r) => r.q === "User 2" && r.offset === 0)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
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

// ── Action flows (deactivate / reactivate / reset password / force logout) ──

interface FetchCall {
	url: string;
	method: string;
	body?: any;
}

function stubActionFetch(state: {
	users: () => unknown[];
	sessions?: unknown[];
	failUsersOnce?: boolean;
	forceLogout?: { status: number; json: Record<string, unknown> };
}) {
	const calls: FetchCall[] = [];
	let usersFailed = false;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			calls.push({
				url,
				method,
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			});
			if (url.includes("/api/auth/reset-password")) {
				return Response.json({ resetUrl: "/reset/tok-123" });
			}
			if (url.includes("/api/admin/sessions")) {
				if (method === "DELETE") {
					const fl = state.forceLogout ?? { status: 200, json: { revokedCount: 2 } };
					return Response.json(fl.json, { status: fl.status });
				}
				return Response.json({ sessions: state.sessions ?? [] });
			}
			if (url.includes("/api/users")) {
				if (method === "PUT") return Response.json({ ok: true });
				if (state.failUsersOnce && !usersFailed) {
					usersFailed = true;
					return Response.json({ error: "boom" }, { status: 500 });
				}
				return Response.json({ users: state.users() });
			}
			return Response.json({});
		}),
	);
	return calls;
}

const otherUser = (status = "active") => ({
	id: "u-other",
	email: "other@corp.io",
	name: "Other",
	role: "member",
	status,
});

const otherSession = {
	id: "s1",
	userId: "u-other",
	userName: "Other",
	userEmail: "other@corp.io",
	userAgent: null,
	ipAddress: null,
	lastActiveAt: null,
	createdAt: "2026-01-01T00:00:00Z",
};

describe("UsersSection deactivate / reactivate", () => {
	test("Deactivate PUTs status inactive and refetches", async () => {
		let users = [otherUser("active")];
		const calls = stubActionFetch({ users: () => users });
		const { getByText } = render(UsersSection, { props: { currentUser } });
		await waitFor(() => expect(getByText("Deactivate")).toBeInTheDocument());

		users = [otherUser("inactive")];
		await fireEvent.click(getByText("Deactivate"));

		await waitFor(() => {
			const put = calls.find((c) => c.method === "PUT");
			expect(put).toBeTruthy();
			expect(put!.url).toContain("/api/users/u-other");
			expect(put!.body).toEqual({ status: "inactive" });
		});
		await waitFor(() => expect(getByText("Reactivate")).toBeInTheDocument());
	});

	test("Reactivate PUTs status active", async () => {
		let users = [otherUser("inactive")];
		const calls = stubActionFetch({ users: () => users });
		const { getByText } = render(UsersSection, { props: { currentUser } });
		await waitFor(() => expect(getByText("Reactivate")).toBeInTheDocument());

		users = [otherUser("active")];
		await fireEvent.click(getByText("Reactivate"));

		await waitFor(() => {
			const put = calls.find((c) => c.method === "PUT");
			expect(put!.body).toEqual({ status: "active" });
		});
	});
});

describe("UsersSection reset password", () => {
	test("copies the reset URL to the clipboard and flashes Link copied!", async () => {
		vi.useFakeTimers();
		const writeText = vi.fn();
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		const calls = stubActionFetch({ users: () => [otherUser()] });
		const { getByText } = render(UsersSection, { props: { currentUser } });

		await vi.advanceTimersByTimeAsync(0); // flush mount fetches
		expect(getByText("Reset Password")).toBeInTheDocument();

		await fireEvent.click(getByText("Reset Password"));
		await vi.advanceTimersByTimeAsync(0);

		const post = calls.find((c) => c.url.includes("/api/auth/reset-password"));
		expect(post!.body).toEqual({ userId: "u-other" });
		expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/reset/tok-123`);
		expect(getByText("Link copied!")).toBeInTheDocument();

		await vi.advanceTimersByTimeAsync(2000);
		expect(getByText("Reset Password")).toBeInTheDocument();
		vi.useRealTimers();
	});
});

describe("UsersSection force logout", () => {
	test("confirm flow DELETEs the user's sessions and reports the revoked count", async () => {
		const calls = stubActionFetch({ users: () => [otherUser()], sessions: [otherSession] });
		const { getByText } = render(UsersSection, { props: { currentUser } });
		await waitFor(() => expect(getByText("Force Logout")).toBeInTheDocument());

		await fireEvent.click(getByText("Force Logout"));
		expect(getByText("Confirm?")).toBeInTheDocument();
		await fireEvent.click(getByText("Yes"));

		await waitFor(() => {
			const del = calls.find((c) => c.method === "DELETE");
			expect(del).toBeTruthy();
			expect(del!.body).toEqual({ userId: "u-other" });
		});
		await waitFor(() => expect(getByText("Revoked 2 session(s).")).toBeInTheDocument());
	});

	test("No dismisses the confirmation without a DELETE", async () => {
		const calls = stubActionFetch({ users: () => [otherUser()], sessions: [otherSession] });
		const { getByText, queryByText } = render(UsersSection, { props: { currentUser } });
		await waitFor(() => expect(getByText("Force Logout")).toBeInTheDocument());

		await fireEvent.click(getByText("Force Logout"));
		await fireEvent.click(getByText("No"));

		expect(queryByText("Confirm?")).not.toBeInTheDocument();
		expect(calls.some((c) => c.method === "DELETE")).toBe(false);
	});

	test("failed DELETE surfaces the server error message", async () => {
		stubActionFetch({
			users: () => [otherUser()],
			sessions: [otherSession],
			forceLogout: { status: 500, json: { error: "session store down" } },
		});
		const { getByText } = render(UsersSection, { props: { currentUser } });
		await waitFor(() => expect(getByText("Force Logout")).toBeInTheDocument());

		await fireEvent.click(getByText("Force Logout"));
		await fireEvent.click(getByText("Yes"));

		await waitFor(() => expect(getByText("session store down")).toBeInTheDocument());
	});
});

describe("UsersSection load error", () => {
	test("failed /api/users load shows the error row; Retry recovers", async () => {
		stubActionFetch({ users: () => [otherUser()], failUsersOnce: true });
		const { getByText, getByTestId } = render(UsersSection, { props: { currentUser } });

		await waitFor(() => expect(getByTestId("users-load-error")).toBeInTheDocument());

		await fireEvent.click(getByText("Retry"));
		await waitFor(() => expect(getByText("Other")).toBeInTheDocument());
	});
});
