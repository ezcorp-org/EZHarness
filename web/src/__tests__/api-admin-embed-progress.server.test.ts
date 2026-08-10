/**
 * Server-handler unit tests for /api/admin/embed-progress/+server.ts (OPS-04).
 *
 * Auth + role + scope gates plus a happy-path walk through the shared
 * getEmbedProgress query (the single source of truth also used by the
 * backfill CLI). The DB layer and the query are mocked so the test stays
 * out of integration scope — this mirrors api-admin-system.server.test.ts.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";
import { expectThrownResponse } from "./helpers/server-route-test-utils";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

vi.mock("$server/db/connection", () => ({
	getDb: vi.fn(() => ({ __db: true })),
}));

vi.mock("$server/db/queries/message-embed-outbox", () => ({
	getEmbedProgress: vi.fn(async () => ({
		backlog: { pending: 0, inProgress: 0, failed: 0, total: 0 },
		coverage: { eligibleMessages: 0, embeddedMessages: 0 },
	})),
}));

const { getDb } = await import("$server/db/connection");
const { getEmbedProgress } = await import(
	"$server/db/queries/message-embed-outbox"
);
const { GET } = await import("../routes/api/admin/embed-progress/+server");

function makeEvent(locals: Record<string, unknown> = {}) {
	return makeRequestEvent("http://localhost/api/admin/embed-progress", {
	  locals,
	  request: null,
	});
}

const adminLocals = {
	user: { id: "u1", email: "u@test.com", name: "U", role: "admin" },
};

describe("GET /api/admin/embed-progress", () => {
	beforeEach(() => {
		vi.mocked(getEmbedProgress).mockClear();
		vi.mocked(getDb).mockClear();
		vi.mocked(getEmbedProgress).mockResolvedValue({
			backlog: { pending: 0, inProgress: 0, failed: 0, total: 0 },
			coverage: { eligibleMessages: 0, embeddedMessages: 0 },
		});
	});

	test("rejects 401 when locals.user is missing", async () => {
		const res = await expectThrownResponse(() => GET(makeEvent({})), 401);
		const body = (await res.json()) as { error?: string };
		expect(typeof body.error).toBe("string");
		expect(getEmbedProgress).not.toHaveBeenCalled();
	});

	test("rejects 403 when locals.user is non-admin", async () => {
		const member = { id: "u1", email: "u@test.com", name: "U", role: "member" };
		const res = await expectThrownResponse(
			() => GET(makeEvent({ user: member })),
			403,
		);
		const body = (await res.json()) as { error?: string };
		expect(typeof body.error).toBe("string");
		expect(getEmbedProgress).not.toHaveBeenCalled();
	});

	test("rejects 403 when apiKeyScopes lacks 'admin'", async () => {
		const res = await GET(makeEvent({ apiKeyScopes: ["read", "chat"] }));
		expect(res).toBeInstanceOf(Response);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string; required?: string };
		expect(body.error).toBe("Insufficient scope");
		expect(body.required).toBe("admin");
		expect(getEmbedProgress).not.toHaveBeenCalled();
	});

	test("happy path: admin caller gets getEmbedProgress output verbatim", async () => {
		vi.mocked(getEmbedProgress).mockResolvedValue({
			backlog: { pending: 3, inProgress: 1, failed: 2, total: 6 },
			coverage: { eligibleMessages: 100, embeddedMessages: 94 },
		});

		const res = await GET(makeEvent(adminLocals));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			backlog: { pending: number; inProgress: number; failed: number; total: number };
			coverage: { eligibleMessages: number; embeddedMessages: number };
		};
		expect(body.backlog).toEqual({ pending: 3, inProgress: 1, failed: 2, total: 6 });
		expect(body.coverage).toEqual({ eligibleMessages: 100, embeddedMessages: 94 });
		// Query runs exactly once, fed the getDb() handle.
		expect(getEmbedProgress).toHaveBeenCalledTimes(1);
		expect(getDb).toHaveBeenCalledTimes(1);
		expect(getEmbedProgress).toHaveBeenCalledWith({ __db: true });
	});

	test("propagates query rejection (caught by SvelteKit boundary)", async () => {
		vi.mocked(getEmbedProgress).mockRejectedValue(new Error("db down"));
		await expect(GET(makeEvent(adminLocals))).rejects.toThrow("db down");
	});
});
