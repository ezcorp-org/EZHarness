/**
 * GET /api/conversations/[id]/graph — route-layer contract.
 *
 * The graph derivation lives in `src/runtime/chat-graph/*` and is covered
 * by the builder + loader suites under `src/__tests__/`. THIS suite pins
 * the HTTP surface: scope/auth gating, level selection via `?turn=`, and
 * the fail-closed 404 ladder — including that a turn id belonging to a
 * DIFFERENT conversation cannot be probed.
 *
 * Mocking pattern mirrors the sibling `api-conversations-id-tree.server.test.ts`:
 * `vi.mock` the collaborators, dynamic-import the handler after the mocks,
 * forge a RequestEvent.
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
	errorJson: (status: number, message: string) =>
		new Response(JSON.stringify({ error: message }), {
			status,
			headers: { "Content-Type": "application/json" },
		}),
}));

// Ownership: authorize "conv-owned" for user-1, deny everything else.
const resolveRootConversationForOwnership = vi.fn(
	async (id: string, user: { id: string }) =>
		id === "conv-owned" && user.id === "user-1" ? { conv: { id }, root: { id } } : null,
);
vi.mock("$lib/server/conversation-ownership", () => ({
	resolveRootConversationForOwnership: (...args: unknown[]) =>
		(resolveRootConversationForOwnership as unknown as (...a: unknown[]) => unknown)(...args),
}));

const loadConversationGraph = vi.fn(async (conversationId: string) => ({
	level: 1 as const,
	rootId: conversationId,
	conversationId,
	nodes: [
		{ id: "u1", kind: "prompt" as const, label: "hi", status: "success" as const, createdAt: "2026-07-26T12:00:00.000Z", drillable: true },
	],
	edges: [],
}));
// Only "u1" is a turn OF "conv-owned"; anything else is not found — which
// is exactly how a foreign turn id behaves (the loader only ever reads this
// conversation's rows).
const loadTurnGraph = vi.fn(async (conversationId: string, turnMessageId: string) =>
	turnMessageId === "u1"
		? {
				level: 2 as const,
				rootId: turnMessageId,
				conversationId,
				nodes: [
					{ id: "u1", kind: "prompt" as const, label: "hi", status: "success" as const, createdAt: "2026-07-26T12:00:00.000Z" },
					{ id: "a1", kind: "assistant" as const, label: "yo", status: "success" as const, createdAt: "2026-07-26T12:00:05.000Z" },
				],
				edges: [{ from: "u1", to: "a1", kind: "sequence" as const }],
			}
		: null,
);
vi.mock("$server/runtime/chat-graph/load", () => ({
	loadConversationGraph: (...args: unknown[]) =>
		(loadConversationGraph as unknown as (...a: unknown[]) => unknown)(...args),
	loadTurnGraph: (...args: unknown[]) =>
		(loadTurnGraph as unknown as (...a: unknown[]) => unknown)(...args),
}));

const { GET } = await import("../routes/api/conversations/[id]/graph/+server");

interface EventLike {
	request: Request;
	url: URL;
	locals: Record<string, unknown>;
	params: { id: string };
}
function makeEvent(id = "conv-owned", query = "", locals: Record<string, unknown> = {}): EventLike {
	const href = `http://localhost/api/conversations/${id}/graph${query}`;
	return {
		request: new Request(href),
		url: new URL(href),
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
	loadConversationGraph.mockClear();
	loadTurnGraph.mockClear();
	resolveRootConversationForOwnership.mockClear();
});

describe("GET /api/conversations/[id]/graph", () => {
	test("owned, no ?turn → 200 with the level-1 graph", async () => {
		const res = await run(() => GET(makeEvent() as never));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { level: number; conversationId: string; nodes: unknown[] };
		expect(body.level).toBe(1);
		expect(body.conversationId).toBe("conv-owned");
		expect(body.nodes).toHaveLength(1);
		expect(loadConversationGraph).toHaveBeenCalledWith("conv-owned");
		expect(loadTurnGraph).not.toHaveBeenCalled();
	});

	test("owned, ?turn=<id> → 200 with the level-2 graph", async () => {
		const res = await run(() => GET(makeEvent("conv-owned", "?turn=u1") as never));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { level: number; rootId: string; edges: unknown[] };
		expect(body.level).toBe(2);
		expect(body.rootId).toBe("u1");
		expect(body.edges).toHaveLength(1);
		expect(loadTurnGraph).toHaveBeenCalledWith("conv-owned", "u1");
		expect(loadConversationGraph).not.toHaveBeenCalled();
	});

	test("a turn id from ANOTHER conversation → 404, not a graph and not a 403", async () => {
		const res = await run(() => GET(makeEvent("conv-owned", "?turn=u-elsewhere") as never));
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Not found" });
	});

	test("an empty ?turn= still selects level 2, and 404s", async () => {
		const res = await run(() => GET(makeEvent("conv-owned", "?turn=") as never));
		expect(res.status).toBe(404);
		expect(loadTurnGraph).toHaveBeenCalledWith("conv-owned", "");
	});

	test("unowned conversation → 404; no graph is ever loaded", async () => {
		const res = await run(() => GET(makeEvent("conv-other") as never));
		expect(res.status).toBe(404);
		expect(loadConversationGraph).not.toHaveBeenCalled();
		expect(loadTurnGraph).not.toHaveBeenCalled();
	});

	test("unowned conversation + ?turn → still 404, so the id space stays opaque", async () => {
		const res = await run(() => GET(makeEvent("conv-other", "?turn=u1") as never));
		expect(res.status).toBe(404);
		expect(loadTurnGraph).not.toHaveBeenCalled();
	});

	test("API key without the read scope → 403; ownership never resolved", async () => {
		const res = await run(() => GET(makeEvent("conv-owned", "", { apiKeyScopes: ["chat"] }) as never));
		expect(res.status).toBe(403);
		expect(resolveRootConversationForOwnership).not.toHaveBeenCalled();
	});

	test("no session → 401 from requireAuth; ownership never resolved", async () => {
		const res = await run(() => GET(makeEvent("conv-owned", "", { user: undefined }) as never));
		expect(res.status).toBe(401);
		expect(resolveRootConversationForOwnership).not.toHaveBeenCalled();
	});
});
