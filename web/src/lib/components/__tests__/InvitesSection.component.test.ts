/**
 * DOM tests for InvitesSection (admin settings):
 *   1. Create invite — POST /api/auth/invite carries email + role
 *   2. Copy link — clipboard write + "Copied!" flash that reverts
 *   3. Delete invite — DELETE /api/auth/invite/{id} then refetch
 *   4. Used invite hides Copy/Delete actions
 *   5. Expiry date display
 *   6. Loading / empty states
 */
import { describe, test, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import InvitesSection from "../settings/InvitesSection.svelte";

type InviteEntry = {
	id: string;
	email: string | null;
	token: string;
	role: string;
	expiresAt: string;
	usedAt: string | null;
};

function makeInvite(overrides: Partial<InviteEntry> = {}): InviteEntry {
	return {
		id: "inv-1",
		email: "alice@example.com",
		token: "tok-abc",
		role: "member",
		expiresAt: "2026-06-20T00:00:00.000Z",
		usedAt: null,
		...overrides,
	};
}

interface FetchCall {
	url: string;
	method: string;
	body?: any;
}
let fetchCalls: FetchCall[] = [];

function stubFetch(getInvites: () => InviteEntry[], status = 200) {
	fetchCalls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			fetchCalls.push({
				url,
				method,
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			});
			if (method === "GET") return Response.json({ invites: getInvites() });
			return Response.json({ ok: true }, { status });
		}),
	);
}

function stubClipboard() {
	const writeText = vi.fn();
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText },
		configurable: true,
	});
	return writeText;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("InvitesSection create", () => {
	test("creates an invite with email and role in the POST body", async () => {
		let invites: InviteEntry[] = [];
		stubFetch(() => invites);
		const { getByLabelText, getByText } = render(InvitesSection);

		await waitFor(() => expect(getByText("No pending invites.")).toBeInTheDocument());

		await fireEvent.input(getByLabelText("Email (optional)"), {
			target: { value: "new@example.com" },
		});
		await fireEvent.change(getByLabelText("Role"), { target: { value: "admin" } });
		invites = [makeInvite({ email: "new@example.com", role: "admin" })];
		await fireEvent.click(getByText("Create Invite"));

		await waitFor(() => {
			const post = fetchCalls.find((c) => c.method === "POST");
			expect(post).toBeTruthy();
			expect(post!.url).toContain("/api/auth/invite");
			expect(post!.body).toEqual({ email: "new@example.com", role: "admin" });
		});
		// Successful create refetches and renders the new invite.
		await waitFor(() => expect(getByText("new@example.com")).toBeInTheDocument());
	});

	test("omits email from the POST body when left blank", async () => {
		stubFetch(() => []);
		const { getByText } = render(InvitesSection);
		await waitFor(() => expect(getByText("No pending invites.")).toBeInTheDocument());

		await fireEvent.click(getByText("Create Invite"));

		await waitFor(() => {
			const post = fetchCalls.find((c) => c.method === "POST");
			expect(post!.body).toEqual({ role: "member" });
		});
	});
});

describe("InvitesSection copy link", () => {
	test("copy writes the invite URL to the clipboard, flashes Copied!, then reverts", async () => {
		vi.useFakeTimers();
		const writeText = stubClipboard();
		stubFetch(() => [makeInvite({ token: "tok-xyz" })]);
		const { getByText } = render(InvitesSection);

		await vi.advanceTimersByTimeAsync(0); // flush the mount fetch
		expect(getByText("alice@example.com")).toBeInTheDocument();

		await fireEvent.click(getByText("Copy Link"));
		expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/api/auth/invite/tok-xyz`);
		expect(getByText("Copied!")).toBeInTheDocument();

		await vi.advanceTimersByTimeAsync(2000);
		expect(getByText("Copy Link")).toBeInTheDocument();
	});
});

describe("InvitesSection delete", () => {
	test("delete fires DELETE /api/auth/invite/{id} and refetches the list", async () => {
		let invites = [makeInvite({ id: "inv-9" })];
		stubFetch(() => invites);
		const { getByText, queryByText } = render(InvitesSection);
		await waitFor(() => expect(getByText("alice@example.com")).toBeInTheDocument());

		invites = [];
		await fireEvent.click(getByText("Delete"));

		await waitFor(() => {
			const del = fetchCalls.find((c) => c.method === "DELETE");
			expect(del).toBeTruthy();
			expect(del!.url).toContain("/api/auth/invite/inv-9");
		});
		await waitFor(() => expect(queryByText("alice@example.com")).not.toBeInTheDocument());
		// Refetch happened: two GETs (mount + post-delete).
		expect(fetchCalls.filter((c) => c.method === "GET")).toHaveLength(2);
	});
});

describe("InvitesSection rendering states", () => {
	test("used invite shows Used and hides Copy Link / Delete", async () => {
		stubFetch(() => [makeInvite({ usedAt: "2026-06-10T00:00:00.000Z" })]);
		const { getByText, queryByText } = render(InvitesSection);
		await waitFor(() => expect(getByText("Used")).toBeInTheDocument());
		expect(queryByText("Copy Link")).not.toBeInTheDocument();
		expect(queryByText("Delete")).not.toBeInTheDocument();
	});

	test("null email renders the (any email) placeholder and the role pill", async () => {
		stubFetch(() => [makeInvite({ email: null, role: "admin" })]);
		const { getByText } = render(InvitesSection);
		await waitFor(() => expect(getByText("(any email)")).toBeInTheDocument());
		expect(getByText("admin")).toBeInTheDocument();
	});

	test("expiry date is displayed", async () => {
		const expiresAt = "2026-06-20T00:00:00.000Z";
		stubFetch(() => [makeInvite({ expiresAt })]);
		const { getByText } = render(InvitesSection);
		await waitFor(() =>
			expect(
				getByText(`Expires: ${new Date(expiresAt).toLocaleDateString()}`),
			).toBeInTheDocument(),
		);
	});

	test("shows Loading... before the fetch resolves, empty state after", async () => {
		stubFetch(() => []);
		const { getByText } = render(InvitesSection);
		expect(getByText("Loading...")).toBeInTheDocument();
		await waitFor(() => expect(getByText("No pending invites.")).toBeInTheDocument());
	});

	test("fetch failure still clears the loading state (silent catch)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network down");
			}),
		);
		const { getByText } = render(InvitesSection);
		await waitFor(() => expect(getByText("No pending invites.")).toBeInTheDocument());
	});
});
