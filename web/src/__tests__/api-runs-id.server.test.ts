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

vi.mock("$lib/server/context", () => ({
	getExecutor: () => ({ getRun: mockGetRun, cancelRun: mockCancelRun }),
	// The route now imports getBus for the ?wait=1 path. These tests don't
	// exercise wait, so a no-op bus stub satisfies the import.
	getBus: () => ({ on: () => () => {}, emit: () => {}, off: () => {} }),
}));

const { GET, DELETE } = await import("../routes/api/runs/[id]/+server.ts");

function makeEvent(opts: {
	id?: string;
	locals?: Record<string, unknown>;
	method?: string;
}) {
	const id = opts.id ?? "run-abc";
	return {
		url: new URL(`http://localhost/api/runs/${id}`),
		locals: opts.locals ?? {},
		params: { id },
		request: new Request(`http://localhost/api/runs/${id}`, {
			method: opts.method ?? "GET",
		}),
	} as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

describe("GET /api/runs/[id]", () => {
	beforeEach(() => {
		mockGetRun.mockReset();
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
