/**
 * Server-handler unit tests for /api/runs/[id] (+server.ts).
 *
 * Covers auth + scope gates for both verbs, GET 404 + happy path
 * (run row body shape), and DELETE 404 (cancelRun returns false) +
 * happy path verifying executor.cancelRun side-effect.
 *
 * Mocks getExecutor at the $lib/server/context boundary.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const mockGetRun = vi.fn();
const mockCancelRun = vi.fn();
const mockGetRunOwnership = vi.fn();
const mockResolveOwnership = vi.fn();
const mockAwaitRunCompletion = vi.fn();

vi.mock("$lib/server/context", () => ({
	getExecutor: () => ({
		getRun: mockGetRun,
		cancelRun: mockCancelRun,
		// Run-ownership attributes drive callerOwnsRun. Tests set this per case;
		// the default (null/null) is the fail-closed "unattributable" shape.
		getRunOwnership: mockGetRunOwnership,
	}),
	// The route imports getBus for the ?wait=1 path. These tests stub
	// awaitRunCompletion directly (below), so a no-op bus satisfies the import.
	getBus: () => ({ on: () => () => {}, emit: () => {}, off: () => {} }),
}));

// callerOwnsRun delegates the conversation-owner walk here. Mocked so the
// ownership decision is fully controllable from the test without a DB.
vi.mock("$lib/server/conversation-ownership", () => ({
	resolveRootConversationForOwnership: mockResolveOwnership,
}));

// The ?wait=1 path is exercised in its own describe block; stub the primitive
// so handler-level abort/timeout/outcome plumbing is unit-testable.
vi.mock("$server/runtime/await-run-completion", () => ({
	awaitRunCompletion: mockAwaitRunCompletion,
}));

const { GET, DELETE } = await import("../routes/api/runs/[id]/+server.ts");

function makeEvent(opts: {
	id?: string;
	locals?: Record<string, unknown>;
	method?: string;
	query?: string;
	signal?: AbortSignal;
}) {
	const id = opts.id ?? "run-abc";
	const qs = opts.query ? `?${opts.query}` : "";
	return {
		url: new URL(`http://localhost/api/runs/${id}${qs}`),
		locals: opts.locals ?? {},
		params: { id },
		request: { signal: opts.signal ?? new AbortController().signal } as Request,
	} as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "member" };
const admin = { id: "admin1", email: "a@x", name: "a", role: "admin" };

describe("GET /api/runs/[id]", () => {
	beforeEach(() => {
		mockGetRun.mockReset();
		mockGetRunOwnership.mockReset();
		mockResolveOwnership.mockReset();
		mockAwaitRunCompletion.mockReset();
		// Default: the run is owned by the test `user` so the pre-existing
		// happy-path/404 cases still pass the ownership gate.
		mockGetRunOwnership.mockResolvedValue({ userId: "u1", conversationId: null });
	});

	test("API-key scope check returns 403 when 'read' scope missing", async () => {
		const res = await GET(
			makeEvent({
				locals: {
					user,
					apiKeyScopes: ["chat"],
				},
			}),
		);
		expect(res).toBeInstanceOf(Response);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string; required?: string };
		expect(body.error).toBe("Insufficient scope");
		expect(body.required).toBe("read");
	});

	test("unauthenticated request throws 401 Response", async () => {
		let res: Response | undefined;
		try {
			await GET(makeEvent({ locals: {} }));
			expect.fail("should have thrown");
		} catch (thrown) {
			expect(thrown).toBeInstanceOf(Response);
			res = thrown as Response;
		}
		expect(res!.status).toBe(401);
		const body = (await res!.json()) as { error?: string };
		expect(body.error).toBe("Authentication required");
	});

	test("returns 404 when run not found", async () => {
		mockGetRun.mockResolvedValue(undefined);
		const res = await GET(makeEvent({ locals: { user } }));
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Not found");
		expect(mockGetRun).toHaveBeenCalledWith("run-abc");
	});

	test("happy path: returns run row", async () => {
		const run = {
			id: "run-abc",
			conversationId: "c1",
			state: "running",
			startedAt: "2024-01-01T00:00:00Z",
		};
		mockGetRun.mockResolvedValue(run);
		const res = await GET(makeEvent({ locals: { user } }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toEqual(run);
	});
});

describe("DELETE /api/runs/[id]", () => {
	beforeEach(() => {
		mockCancelRun.mockReset();
		mockGetRunOwnership.mockReset();
		mockResolveOwnership.mockReset();
		// Default: caller owns the run via userId match.
		mockGetRunOwnership.mockResolvedValue({ userId: "u1", conversationId: null });
	});

	test("API-key scope check returns 403 when 'chat' scope missing", async () => {
		const res = await DELETE(
			makeEvent({
				locals: {
					user,
					apiKeyScopes: ["read"],
				},
				method: "DELETE",
			}),
		);
		expect(res).toBeInstanceOf(Response);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string; required?: string };
		expect(body.error).toBe("Insufficient scope");
		expect(body.required).toBe("chat");
	});

	test("unauthenticated request throws 401 Response", async () => {
		let res: Response | undefined;
		try {
			await DELETE(makeEvent({ locals: {}, method: "DELETE" }));
			expect.fail("should have thrown");
		} catch (thrown) {
			expect(thrown).toBeInstanceOf(Response);
			res = thrown as Response;
		}
		expect(res!.status).toBe(401);
		const body = (await res!.json()) as { error?: string };
		expect(body.error).toBe("Authentication required");
	});

	test("returns 404 when cancelRun returns false (not found / not running)", async () => {
		mockCancelRun.mockReturnValue(false);
		const res = await DELETE(
			makeEvent({ locals: { user }, method: "DELETE" }),
		);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Run not found or not running");
		expect(mockCancelRun).toHaveBeenCalledWith("run-abc");
	});

	test("happy path: returns { ok: true } when cancelRun succeeds", async () => {
		mockCancelRun.mockReturnValue(true);
		const res = await DELETE(
			makeEvent({ locals: { user }, method: "DELETE" }),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok?: boolean };
		expect(body.ok).toBe(true);
		expect(mockCancelRun).toHaveBeenCalledWith("run-abc");
	});
});

// ─── Run-ownership IDOR invariant ──────────────────────────────────────
//
// "No authenticated NON-admin may GET/await/DELETE a run they did not
// initiate — for ANY run type (chat, agent, CLI), INCLUDING runs that
// predate run-attribution. Unattributable runs FAIL CLOSED for non-admins.
// Admins retain full access."
describe("run ownership (IDOR fix) — GET", () => {
	beforeEach(() => {
		mockGetRun.mockReset();
		mockGetRunOwnership.mockReset();
		mockResolveOwnership.mockReset();
		mockGetRun.mockResolvedValue({ id: "run-abc", status: "running" });
	});

	test("agent/CLI run owned by another user → 404 for non-admin (userId mismatch, no conversation)", async () => {
		mockGetRunOwnership.mockResolvedValue({ userId: "someone-else", conversationId: null });
		const res = await GET(makeEvent({ locals: { user } }));
		expect(res.status).toBe(404);
		expect(((await res.json()) as { error?: string }).error).toBe("Not found");
		// userId mismatch + no conversation ⇒ never falls through to a conv walk.
		expect(mockResolveOwnership).not.toHaveBeenCalled();
	});

	test("pre-migration / unattributable run (userId null, conversation null) → 404 for non-admin (fail closed)", async () => {
		mockGetRunOwnership.mockResolvedValue({ userId: null, conversationId: null });
		const res = await GET(makeEvent({ locals: { user } }));
		expect(res.status).toBe(404);
		expect(mockResolveOwnership).not.toHaveBeenCalled();
	});

	test("agent/CLI run initiated by caller → 200 (userId match)", async () => {
		mockGetRunOwnership.mockResolvedValue({ userId: "u1", conversationId: null });
		const res = await GET(makeEvent({ locals: { user } }));
		expect(res.status).toBe(200);
	});

	test("chat run the caller owns by conversation → 200 (conversation-owner walk)", async () => {
		mockGetRunOwnership.mockResolvedValue({ userId: null, conversationId: "c1" });
		mockResolveOwnership.mockResolvedValue({ conv: {}, root: {} }); // owns it
		const res = await GET(makeEvent({ locals: { user } }));
		expect(res.status).toBe(200);
		expect(mockResolveOwnership).toHaveBeenCalledWith("c1", user);
	});

	test("chat run owned by another user (conversation walk returns null) → 404 for non-admin", async () => {
		mockGetRunOwnership.mockResolvedValue({ userId: null, conversationId: "c1" });
		mockResolveOwnership.mockResolvedValue(null); // does NOT own it
		const res = await GET(makeEvent({ locals: { user } }));
		expect(res.status).toBe(404);
	});

	test("admin may read ANY run, including an unattributable one (no ownership lookup needed)", async () => {
		mockGetRunOwnership.mockResolvedValue({ userId: null, conversationId: null });
		const res = await GET(makeEvent({ locals: { user: admin } }));
		expect(res.status).toBe(200);
		// Admin short-circuits BEFORE any ownership resolution.
		expect(mockGetRunOwnership).not.toHaveBeenCalled();
		expect(mockResolveOwnership).not.toHaveBeenCalled();
	});
});

describe("run ownership (IDOR fix) — DELETE", () => {
	beforeEach(() => {
		mockCancelRun.mockReset();
		mockGetRunOwnership.mockReset();
		mockResolveOwnership.mockReset();
		mockCancelRun.mockReturnValue(true);
	});

	test("non-admin cancelling an unattributable run → 404 (fail closed, cancelRun never called)", async () => {
		mockGetRunOwnership.mockResolvedValue({ userId: null, conversationId: null });
		const res = await DELETE(makeEvent({ locals: { user }, method: "DELETE" }));
		expect(res.status).toBe(404);
		expect(((await res.json()) as { error?: string }).error).toBe(
			"Run not found or not running",
		);
		expect(mockCancelRun).not.toHaveBeenCalled();
	});

	test("non-admin cancelling another user's agent run → 404 (userId mismatch)", async () => {
		mockGetRunOwnership.mockResolvedValue({ userId: "someone-else", conversationId: null });
		const res = await DELETE(makeEvent({ locals: { user }, method: "DELETE" }));
		expect(res.status).toBe(404);
		expect(mockCancelRun).not.toHaveBeenCalled();
	});

	test("admin may cancel an unattributable run", async () => {
		mockGetRunOwnership.mockResolvedValue({ userId: null, conversationId: null });
		const res = await DELETE(makeEvent({ locals: { user: admin }, method: "DELETE" }));
		expect(res.status).toBe(200);
		expect(mockCancelRun).toHaveBeenCalledWith("run-abc");
		expect(mockGetRunOwnership).not.toHaveBeenCalled();
	});
});

// ─── ?wait=1 abort-on-disconnect (Finding 2) ───────────────────────────
describe("GET ?wait=1 — abort + outcome plumbing", () => {
	beforeEach(() => {
		mockGetRun.mockReset();
		mockGetRunOwnership.mockReset();
		mockAwaitRunCompletion.mockReset();
		mockGetRun.mockResolvedValue({ id: "run-abc", status: "running" });
		// Caller owns the run.
		mockGetRunOwnership.mockResolvedValue({ userId: "u1", conversationId: null });
	});

	test("passes request.signal through to awaitRunCompletion", async () => {
		const controller = new AbortController();
		mockAwaitRunCompletion.mockResolvedValue({
			kind: "done",
			outcome: "complete",
			run: { id: "run-abc", status: "success" },
		});
		const res = await GET(
			makeEvent({ locals: { user }, query: "wait=1", signal: controller.signal }),
		);
		expect(res.status).toBe(200);
		expect(mockAwaitRunCompletion).toHaveBeenCalledTimes(1);
		expect(mockAwaitRunCompletion.mock.calls[0][0].signal).toBe(controller.signal);
	});

	test("aborted result → 499 and the activeWaits slot is released (finally ran)", async () => {
		// Simulate an already-disconnected client: the primitive returns
		// 'aborted'. We then assert the slot was decremented by driving a
		// SECOND wait under a cap of 1 and confirming it is NOT rejected 429.
		const prev = process.env.EZCORP_MAX_RUN_WAITS;
		process.env.EZCORP_MAX_RUN_WAITS = "1";
		try {
			mockAwaitRunCompletion.mockResolvedValueOnce({ kind: "aborted" });
			const aborted = new AbortController();
			aborted.abort();
			const res1 = await GET(
				makeEvent({ locals: { user }, query: "wait=1", signal: aborted.signal }),
			);
			expect(res1.status).toBe(499);

			// Slot must be free again: a second wait succeeds (would be 429 if
			// the first never decremented activeWaits).
			mockAwaitRunCompletion.mockResolvedValueOnce({
				kind: "done",
				outcome: "complete",
				run: { id: "run-abc", status: "success" },
			});
			const res2 = await GET(makeEvent({ locals: { user }, query: "wait=1" }));
			expect(res2.status).toBe(200);
		} finally {
			if (prev === undefined) delete process.env.EZCORP_MAX_RUN_WAITS;
			else process.env.EZCORP_MAX_RUN_WAITS = prev;
		}
	});

	test("timeout result → 408", async () => {
		mockAwaitRunCompletion.mockResolvedValue({ kind: "timeout" });
		const res = await GET(makeEvent({ locals: { user }, query: "wait=1" }));
		expect(res.status).toBe(408);
	});

	test("concurrency cap → 429 when at capacity", async () => {
		const prev = process.env.EZCORP_MAX_RUN_WAITS;
		process.env.EZCORP_MAX_RUN_WAITS = "0"; // no slots
		try {
			const res = await GET(makeEvent({ locals: { user }, query: "wait=1" }));
			expect(res.status).toBe(429);
			expect(mockAwaitRunCompletion).not.toHaveBeenCalled();
		} finally {
			if (prev === undefined) delete process.env.EZCORP_MAX_RUN_WAITS;
			else process.env.EZCORP_MAX_RUN_WAITS = prev;
		}
	});
});
