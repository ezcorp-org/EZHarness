/**
 * GET /api/conversations/[id]/tree — route-layer contract (Sessions P4).
 *
 * The tree derivation (session topology + live-messages join) lives in
 * `src/db/session-sync.ts#computeSessionTree` and is integration-tested against
 * the real seam in `src/__tests__/session-sync.test.ts`. THIS suite pins the
 * HTTP surface: scope/auth gating, 404 fail-closed on an unowned conversation,
 * the 409 when the `sessions:historyProducer` flag is off (which is ALSO how
 * the frontend learns the feature is enabled), and the 200 tree passthrough.
 *
 * Mocking pattern mirrors the sibling route tests in this directory
 * (api-extensions-id-reapprove-drift.server.test.ts): `vi.mock("$server/…")`
 * collaborators, dynamic import of the handler AFTER mocks, forged RequestEvent.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/auth/middleware", () => ({
	requireAuth: (locals: Record<string, unknown>) => {
		const user = locals.user as { id: string; role: string } | undefined;
		if (!user) throw new Response("Unauthorized", { status: 401 });
		return user;
	},
}));

vi.mock("$lib/server/security/api-keys", () => ({
	requireScope: (locals: { apiKeyScopes?: string[] }, scope: string): Response | null => {
		if (!locals.apiKeyScopes) return null;
		if (locals.apiKeyScopes.includes(scope)) return null;
		return new Response(JSON.stringify({ error: "Insufficient scope" }), { status: 403 });
	},
}));

vi.mock("$lib/server/http-errors", () => ({
	errorJson: (status: number, message: string, details?: Record<string, unknown>) =>
		new Response(JSON.stringify(details ? { error: message, ...details } : { error: message }), {
			status,
			headers: { "Content-Type": "application/json" },
		}),
}));

// Ownership: authorize convId "conv-owned" for user-1, deny everything else.
const resolveRootConversationForOwnership = vi.fn(
	async (id: string, user: { id: string }) =>
		id === "conv-owned" && user.id === "user-1" ? { conv: { id }, root: { id } } : null,
);
vi.mock("$lib/server/conversation-ownership", () => ({
	resolveRootConversationForOwnership: (...args: unknown[]) =>
		(resolveRootConversationForOwnership as unknown as (...a: unknown[]) => unknown)(...args),
}));

let flagEnabled = true;
const computeSessionTree = vi.fn(async (conversationId: string) => ({
	conversationId,
	currentLeaf: "a1",
	nodes: [
		{ id: "u1", parentId: null, role: "user", excluded: false, createdAt: "2026-07-11T00:00:00.000Z" },
		{ id: "a1", parentId: "u1", role: "assistant", excluded: false, createdAt: "2026-07-11T00:00:01.000Z" },
	],
}));
vi.mock("$server/db/session-sync", () => ({
	isSessionHistoryProducerEnabled: async () => flagEnabled,
	computeSessionTree: (...args: unknown[]) =>
		(computeSessionTree as unknown as (...a: unknown[]) => unknown)(...args),
}));

const { GET } = await import("../routes/api/conversations/[id]/tree/+server");

interface EventLike {
	request: Request;
	locals: Record<string, unknown>;
	params: { id: string };
}
function makeEvent(id = "conv-owned", locals: Record<string, unknown> = {}): EventLike {
	return {
		request: new Request(`http://localhost/api/conversations/${id}/tree`),
		locals: { user: { id: "user-1", email: "u@x", name: "u", role: "member" }, ...locals },
		params: { id },
	};
}
async function run(fn: () => Promise<Response> | Response): Promise<Response> {
	try {
		return await fn();
	} catch (thrown) {
		expect(thrown).toBeInstanceOf(Response);
		return thrown as Response;
	}
}

beforeEach(() => {
	flagEnabled = true;
	computeSessionTree.mockClear();
	resolveRootConversationForOwnership.mockClear();
});

describe("GET /api/conversations/[id]/tree", () => {
	test("owned + flag ON → 200 with the tree", async () => {
		const res = await run(() => GET(makeEvent() as never));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { conversationId: string; currentLeaf: string; nodes: unknown[] };
		expect(body.conversationId).toBe("conv-owned");
		expect(body.currentLeaf).toBe("a1");
		expect(body.nodes).toHaveLength(2);
		expect(computeSessionTree).toHaveBeenCalledWith("conv-owned");
	});

	test("flag OFF → 409 session_producer_disabled; tree never computed", async () => {
		flagEnabled = false;
		const res = await run(() => GET(makeEvent() as never));
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe("session_producer_disabled");
		expect(computeSessionTree).not.toHaveBeenCalled();
	});

	test("unowned conversation → 404; flag never checked, tree never computed", async () => {
		const res = await run(() => GET(makeEvent("conv-other") as never));
		expect(res.status).toBe(404);
		expect(computeSessionTree).not.toHaveBeenCalled();
	});

	test("API key without the read scope → 403; ownership never resolved", async () => {
		const res = await run(() => GET(makeEvent("conv-owned", { apiKeyScopes: ["chat"] }) as never));
		expect(res.status).toBe(403);
		expect(resolveRootConversationForOwnership).not.toHaveBeenCalled();
	});
});
