import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
	binding: null as null | { presetId: string; observedState: string; installationId: string; releaseId: string; connectionId: string },
	connection: { kind: "incus" } as null | { kind: string },
	projectRole: vi.fn(),
	adminSession: vi.fn(),
	readScope: vi.fn(),
	select: vi.fn(),
}));

vi.mock("$server/auth/middleware", () => ({
	checkProjectRole: state.projectRole,
	requireAdminSession: state.adminSession,
}));
vi.mock("$lib/server/security/api-keys", () => ({ requireScope: state.readScope }));
vi.mock("$server/db/connection", () => ({
	getDb: () => ({ select: state.select }),
}));

const { GET } = await import("./+server");
const user = { id: "owner", role: "admin" };
const event = (id = "project") => ({ params: { id }, locals: { user, authMethod: "session" } }) as never;
const binding = { presetId: "incus-compose-v1", observedState: "STOPPED", installationId: "installation",
	releaseId: "release", connectionId: "connection" };

beforeEach(() => {
	state.binding = null;
	state.connection = { kind: "incus" };
	state.projectRole.mockReset().mockResolvedValue(user);
	state.adminSession.mockReset().mockReturnValue(user);
	state.readScope.mockReset().mockReturnValue(null);
	state.select.mockReset().mockImplementation(() => {
		const result = state.select.mock.calls.length === 1 ? state.binding : state.connection;
		return { from: () => ({ where: () => ({ limit: async () => result ? [result] : [] }) }) };
	});
});

describe("project Incus feature identity", () => {
	test("returns only the binding kind and admin-session management access", async () => {
		state.binding = binding;
		const response = await GET(event("bound"));
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({ kind: "incus", presetId: "incus-compose-v1", observedState: "STOPPED", canManage: true });
		expect(state.projectRole).toHaveBeenCalledWith(expect.anything(), "bound", "member");
	});

	test("keeps the Incus identity but omits the admin link for a member", async () => {
		state.binding = binding;
		state.adminSession.mockReturnValue(new Response(null, { status: 403 }));
		const response = await GET(event());
		expect(await response.json()).toEqual({ kind: "incus", presetId: "incus-compose-v1", observedState: "STOPPED", canManage: false });
	});

	test("returns explicit none for an ordinary project", async () => {
		const response = await GET(event());
		expect(await response.json()).toEqual({ kind: "none" });
	});

	test("does not classify an unrelated or missing provider connection as Incus", async () => {
		state.binding = binding;
		state.connection = { kind: "other" };
		expect(await (await GET(event())).json()).toEqual({ kind: "unavailable" });
		state.select.mockClear();
		state.connection = null;
		expect(await (await GET(event())).json()).toEqual({ kind: "unavailable" });
	});

	test("refuses outsiders and API callers without read scope before binding lookup", async () => {
		state.projectRole.mockResolvedValueOnce(new Response(null, { status: 403 }));
		expect((await GET(event())).status).toBe(403);
		expect(state.select).not.toHaveBeenCalled();
		state.readScope.mockReturnValueOnce(new Response(null, { status: 403 }));
		expect((await GET(event())).status).toBe(403);
		expect(state.projectRole).toHaveBeenCalledTimes(1);
	});
});
