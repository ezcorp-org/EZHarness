/**
 * Phase 57 — UX-03 Wave 0 RED scaffold for the agent-picker-prefs route.
 *
 * Pins the must_haves contract from PLAN frontmatter:
 *   "In the agent picker, a user can save a search query (persists under
 *    user:<id>:agentPicker:savedSearches) and pin agents (persists under
 *    user:<id>:agentPicker:pinned); orphaned references (deleted agents/
 *    users) self-trim on read."
 *
 * Nine cases:
 *   GET happy/empty/stored/trim/no-rewrite/auth
 *   PUT replaces savedSearches / replaces pinned / omitted-fields no-op
 *
 * RED reason: the route file
 * `web/src/routes/api/user/agent-picker/+server.ts` does not yet exist
 * (Wave 3 / Plan 57-06 Task 1 will create it). Cases 1-9 fail with
 * "Failed to resolve import" until the file lands.
 *
 * Runner: vitest (server suffix triggers the .server.test.ts include in
 * web/vitest.config.ts). Mocks $server/auth/middleware (requireAuth),
 * $server/db/queries/settings (getSetting + upsertSetting), and
 * $server/db/queries/agent-configs (listAgentConfigs) so the route's
 * server-side dependencies don't hit real DB.
 *
 * NEVER bun:test for web/ — Svelte + Vite pipeline only here.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

vi.mock("$server/auth/middleware", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$server/db/queries/settings", () => ({
	getSetting: vi.fn(),
	upsertSetting: vi.fn(),
}));

vi.mock("$server/db/queries/agent-configs", () => ({
	listAgentConfigs: vi.fn(),
}));

const { requireAuth } = await import("$server/auth/middleware");
const { getSetting, upsertSetting } = await import(
	"$server/db/queries/settings"
);
const { listAgentConfigs } = await import("$server/db/queries/agent-configs");
const { GET, PUT } = await import("../routes/api/user/agent-picker/+server");

function makeEvent(init: {
	body?: unknown;
	locals?: Record<string, unknown>;
	method?: string;
} = {}) {
	const body = init.body !== undefined ? JSON.stringify(init.body) : undefined;
	const request = new Request("http://localhost/api/user/agent-picker", {
		method: init.method ?? "GET",
		body,
		headers: body ? { "content-type": "application/json" } : undefined,
	});
	return {
		url: new URL("http://localhost/api/user/agent-picker"),
		locals: init.locals ?? {},
		request,
	} as never;
}

const USER = { id: "user-1", email: "u@x", name: "U", role: "member" };

beforeEach(() => {
	vi.mocked(requireAuth).mockReset();
	vi.mocked(getSetting).mockReset();
	vi.mocked(upsertSetting).mockReset();
	vi.mocked(listAgentConfigs).mockReset();
});

describe("GET /api/user/agent-picker", () => {
	test("returns { savedSearches: [], pinned: [] } when no settings exist", async () => {
		vi.mocked(requireAuth).mockReturnValue(USER as never);
		vi.mocked(getSetting).mockResolvedValue(undefined);
		vi.mocked(listAgentConfigs).mockResolvedValue([] as never);
		const res = await GET(makeEvent({ locals: { user: USER } }));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ savedSearches: [], pinned: [] });
	});

	test("returns stored savedSearches verbatim", async () => {
		vi.mocked(requireAuth).mockReturnValue(USER as never);
		const saved = [{ query: "foo", createdAt: 123 }];
		vi.mocked(getSetting).mockImplementation(async (k: string) =>
			k === "user:user-1:agentPicker:savedSearches" ? saved : undefined,
		);
		vi.mocked(listAgentConfigs).mockResolvedValue([] as never);
		const res = await GET(makeEvent({ locals: { user: USER } }));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.savedSearches).toEqual(saved);
	});

	test("trims orphaned pinned IDs (deleted agents) on read", async () => {
		vi.mocked(requireAuth).mockReturnValue(USER as never);
		vi.mocked(getSetting).mockImplementation(async (k: string) =>
			k === "user:user-1:agentPicker:pinned"
				? ["agent-1", "agent-99-deleted"]
				: undefined,
		);
		vi.mocked(listAgentConfigs).mockResolvedValue([
			{ id: "agent-1" },
		] as never);
		const res = await GET(makeEvent({ locals: { user: USER } }));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.pinned).toEqual(["agent-1"]);
	});

	test("re-persists trimmed pinned list ONLY if a trim occurred", async () => {
		vi.mocked(requireAuth).mockReturnValue(USER as never);
		vi.mocked(getSetting).mockImplementation(async (k: string) =>
			k === "user:user-1:agentPicker:pinned"
				? ["agent-1", "agent-99-deleted"]
				: undefined,
		);
		vi.mocked(listAgentConfigs).mockResolvedValue([
			{ id: "agent-1" },
		] as never);
		await GET(makeEvent({ locals: { user: USER } }));
		// Exactly one upsert call — the trimmed pinned list write-back.
		// savedSearches is empty/undefined so no write there.
		const pinnedWrites = vi
			.mocked(upsertSetting)
			.mock.calls.filter(([k]) => k === "user:user-1:agentPicker:pinned");
		expect(pinnedWrites.length).toBe(1);
		expect(pinnedWrites[0]?.[1]).toEqual(["agent-1"]);
	});

	test("does NOT re-persist when pinned list is already clean (no write-amplification)", async () => {
		vi.mocked(requireAuth).mockReturnValue(USER as never);
		vi.mocked(getSetting).mockImplementation(async (k: string) =>
			k === "user:user-1:agentPicker:pinned" ? ["agent-1"] : undefined,
		);
		vi.mocked(listAgentConfigs).mockResolvedValue([
			{ id: "agent-1" },
		] as never);
		await GET(makeEvent({ locals: { user: USER } }));
		const pinnedWrites = vi
			.mocked(upsertSetting)
			.mock.calls.filter(([k]) => k === "user:user-1:agentPicker:pinned");
		expect(pinnedWrites.length).toBe(0);
	});

	test("requires auth (401 when locals.user is undefined)", async () => {
		vi.mocked(requireAuth).mockImplementation(() => {
			throw new Response(JSON.stringify({ error: "Unauthorized" }), {
				status: 401,
			});
		});
		let res: Response | undefined;
		try {
			res = await GET(makeEvent({ locals: {} }));
		} catch (thrown) {
			expect(thrown).toBeInstanceOf(Response);
			res = thrown as Response;
		}
		expect(res?.status).toBe(401);
	});
});

describe("PUT /api/user/agent-picker", () => {
	test("wholesale-replaces savedSearches when present in body", async () => {
		vi.mocked(requireAuth).mockReturnValue(USER as never);
		const saved = [{ query: "x", createdAt: 1 }];
		const res = await PUT(
			makeEvent({
				method: "PUT",
				body: { savedSearches: saved },
				locals: { user: USER },
			}),
		);
		expect(res.status).toBeLessThan(300);
		expect(vi.mocked(upsertSetting)).toHaveBeenCalledWith(
			"user:user-1:agentPicker:savedSearches",
			saved,
		);
	});

	test("wholesale-replaces pinned when present in body", async () => {
		vi.mocked(requireAuth).mockReturnValue(USER as never);
		const pinned = ["agent-1", "agent-2"];
		const res = await PUT(
			makeEvent({
				method: "PUT",
				body: { pinned },
				locals: { user: USER },
			}),
		);
		expect(res.status).toBeLessThan(300);
		expect(vi.mocked(upsertSetting)).toHaveBeenCalledWith(
			"user:user-1:agentPicker:pinned",
			pinned,
		);
	});

	test("omitted fields skip upsert (no clobbering)", async () => {
		vi.mocked(requireAuth).mockReturnValue(USER as never);
		const saved = [{ query: "x", createdAt: 1 }];
		await PUT(
			makeEvent({
				method: "PUT",
				body: { savedSearches: saved }, // no pinned key
				locals: { user: USER },
			}),
		);
		// Exactly ONE upsert call (the savedSearches one). pinned key
		// must NOT be touched when omitted.
		expect(vi.mocked(upsertSetting)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(upsertSetting).mock.calls[0]?.[0]).toBe(
			"user:user-1:agentPicker:savedSearches",
		);
	});
});
