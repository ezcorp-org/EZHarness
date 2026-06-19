/**
 * DOM tests for TeamsSection (admin settings):
 *   1. Create team — POST /api/teams { name }, refetch on success
 *   2. Create-team failure — input keeps its value, list unchanged
 *   3. Expand — fetches members, renders names/emails/roles
 *   4. Add member — POST /api/teams/{id}/members { userId, role }
 *   5. Remove member — DELETE /api/teams/{id}/members { userId }
 *   6. Role selector options (viewer / editor / owner)
 *   7. Delete team — DELETE /api/teams/{id}
 */
import { describe, test, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import TeamsSection from "../settings/TeamsSection.svelte";

type Team = { id: string; name: string; createdAt: string };
type Member = { id: string; userId: string; userName: string; userEmail: string; role: string };
type User = { id: string; email: string; name: string; role: string; status: string };

interface FetchCall {
	url: string;
	method: string;
	body?: any;
}
let fetchCalls: FetchCall[] = [];

function stubFetch(state: {
	teams: Team[];
	users?: User[];
	members?: Record<string, Member[]>;
	failCreate?: boolean;
}) {
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
			if (url.includes("/members")) return Response.json({ members: lookupMembers(url, state.members) });
			if (url.includes("/api/users")) return Response.json({ users: state.users ?? [] });
			if (url.includes("/api/teams")) {
				if (method === "POST" && state.failCreate) {
					return Response.json({ error: "boom" }, { status: 500 });
				}
				return Response.json({ teams: state.teams });
			}
			return Response.json({});
		}),
	);
}

function lookupMembers(url: string, members?: Record<string, Member[]>): Member[] {
	const match = url.match(/\/api\/teams\/([^/]+)\/members/);
	return (match && members?.[match[1]!]) || [];
}

const team = (id: string, name: string): Team => ({ id, name, createdAt: "2026-01-01T00:00:00.000Z" });
const alice: Member = { id: "m-1", userId: "user-2", userName: "Alice", userEmail: "alice@example.com", role: "viewer" };
const bob: User = { id: "user-3", email: "bob@example.com", name: "Bob", role: "member", status: "active" };

afterEach(() => vi.unstubAllGlobals());

describe("TeamsSection create team", () => {
	test("posts the trimmed name and shows the new team on success", async () => {
		const state = { teams: [] as Team[] };
		stubFetch(state);
		const { getByText, getByPlaceholderText } = render(TeamsSection);
		await waitFor(() => expect(getByText("No teams yet.")).toBeInTheDocument());

		await fireEvent.input(getByPlaceholderText("New team name"), {
			target: { value: "  Design Squad  " },
		});
		state.teams = [team("t-new", "Design Squad")];
		await fireEvent.click(getByText("Create Team"));

		await waitFor(() => {
			const post = fetchCalls.find((c) => c.method === "POST");
			expect(post).toBeTruthy();
			expect(post!.url).toContain("/api/teams");
			expect(post!.body).toEqual({ name: "Design Squad" });
		});
		await waitFor(() => expect(getByText("Design Squad")).toBeInTheDocument());
	});

	test("failed create keeps the typed name and does not refetch", async () => {
		stubFetch({ teams: [], failCreate: true });
		const { getByText, getByPlaceholderText } = render(TeamsSection);
		await waitFor(() => expect(getByText("No teams yet.")).toBeInTheDocument());

		const input = getByPlaceholderText("New team name") as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "Doomed Team" } });
		await fireEvent.click(getByText("Create Team"));

		await waitFor(() => expect(fetchCalls.some((c) => c.method === "POST")).toBe(true));
		expect(input.value).toBe("Doomed Team");
		// Only the mount GET hit /api/teams — no post-failure refetch.
		expect(fetchCalls.filter((c) => c.method === "GET" && c.url.includes("/api/teams") && !c.url.includes("/members"))).toHaveLength(1);
	});
});

describe("TeamsSection members", () => {
	test("expanding a team fetches and lists members with role and Remove", async () => {
		stubFetch({ teams: [team("t-1", "Engineering")], members: { "t-1": [alice] } });
		const { getByText, getByTestId } = render(TeamsSection);
		await waitFor(() => expect(getByText("Engineering")).toBeInTheDocument());

		await fireEvent.click(getByTestId("team-expand-t-1"));

		await waitFor(() => expect(getByText("Alice (alice@example.com)")).toBeInTheDocument());
		expect(getByText("viewer")).toBeInTheDocument();
		expect(getByText("Remove")).toBeInTheDocument();
	});

	test("add member POSTs userId and role to the team members endpoint", async () => {
		stubFetch({ teams: [team("t-1", "Engineering")], users: [bob], members: { "t-1": [] } });
		const { getByText, getByTestId, getByLabelText } = render(TeamsSection);
		await waitFor(() => expect(getByText("Engineering")).toBeInTheDocument());

		await fireEvent.click(getByTestId("team-expand-t-1"));
		await waitFor(() => expect(getByText("No members.")).toBeInTheDocument());

		const addBtn = getByText("Add").closest("button")!;
		expect(addBtn).toBeDisabled();

		await fireEvent.change(getByLabelText("Select user"), { target: { value: "user-3" } });
		await fireEvent.change(getByLabelText("Member role"), { target: { value: "editor" } });
		expect(addBtn).not.toBeDisabled();
		await fireEvent.click(addBtn);

		await waitFor(() => {
			const post = fetchCalls.find((c) => c.method === "POST");
			expect(post).toBeTruthy();
			expect(post!.url).toContain("/api/teams/t-1/members");
			expect(post!.body).toEqual({ userId: "user-3", role: "editor" });
		});
	});

	test("remove member DELETEs with the userId in the body", async () => {
		stubFetch({ teams: [team("t-1", "Engineering")], members: { "t-1": [alice] } });
		const { getByText, getByTestId } = render(TeamsSection);
		await waitFor(() => expect(getByText("Engineering")).toBeInTheDocument());

		await fireEvent.click(getByTestId("team-expand-t-1"));
		await waitFor(() => expect(getByText("Remove")).toBeInTheDocument());

		await fireEvent.click(getByText("Remove"));

		await waitFor(() => {
			const del = fetchCalls.find((c) => c.method === "DELETE");
			expect(del).toBeTruthy();
			expect(del!.url).toContain("/api/teams/t-1/members");
			expect(del!.body).toEqual({ userId: "user-2" });
		});
	});

	test("role selector offers viewer, editor, and owner", async () => {
		stubFetch({ teams: [team("t-1", "Engineering")], members: { "t-1": [] } });
		const { getByText, getByTestId, getByLabelText } = render(TeamsSection);
		await waitFor(() => expect(getByText("Engineering")).toBeInTheDocument());

		await fireEvent.click(getByTestId("team-expand-t-1"));
		await waitFor(() => expect(getByLabelText("Member role")).toBeInTheDocument());

		const options = Array.from(
			(getByLabelText("Member role") as HTMLSelectElement).options,
		).map((o) => o.value);
		expect(options).toEqual(["viewer", "editor", "owner"]);
	});

	test("members already on the team are excluded from the user selector", async () => {
		const aliceUser: User = { id: "user-2", email: "alice@example.com", name: "Alice", role: "member", status: "active" };
		stubFetch({ teams: [team("t-1", "Engineering")], users: [aliceUser, bob], members: { "t-1": [alice] } });
		const { getByText, getByTestId, getByLabelText } = render(TeamsSection);
		await waitFor(() => expect(getByText("Engineering")).toBeInTheDocument());

		await fireEvent.click(getByTestId("team-expand-t-1"));

		// The <select> renders as soon as the team expands (synchronous
		// expandedTeamId set), but Alice is only filtered out once the
		// /members fetch resolves and populates teamMembers[t-1]. Assert the
		// option list inside waitFor so it retries until that async state
		// settles — otherwise on a loaded runner we read ["", "user-2",
		// "user-3"] before the exclusion filter applies.
		await waitFor(() => {
			const options = Array.from(
				(getByLabelText("Select user") as HTMLSelectElement).options,
			).map((o) => o.value);
			expect(options).toEqual(["", "user-3"]); // Alice (user-2) filtered out
		});
	});
});

describe("TeamsSection delete team", () => {
	test("delete fires DELETE /api/teams/{id} and refetches", async () => {
		const state = { teams: [team("t-del", "Doomed")] };
		stubFetch(state);
		const { getByText, queryByText } = render(TeamsSection);
		await waitFor(() => expect(getByText("Doomed")).toBeInTheDocument());

		state.teams = [];
		await fireEvent.click(getByText("Delete"));

		await waitFor(() => {
			const del = fetchCalls.find((c) => c.method === "DELETE");
			expect(del).toBeTruthy();
			expect(del!.url).toContain("/api/teams/t-del");
		});
		await waitFor(() => expect(queryByText("Doomed")).not.toBeInTheDocument());
	});
});
