/**
 * POST /api/conversations/[id]/messages/[mid]/retry — route-layer contract
 * (Sessions P5, the clean A/B retry).
 *
 * Pins the HTTP surface: scope/auth gating, 404 fail-closed on an unowned
 * conversation, 409 on the flag-off + active-run guards, 400 target validation,
 * 429 budget, and the happy path that re-runs the target assistant message's
 * parent USER turn via `streamChat` WITHOUT creating a new user row (the whole
 * point — same-role siblings). The run seam itself is proven end-to-end in the
 * executor/subscribe-bridge suites; here we assert the route calls it with the
 * EXISTING user turn as the anchor.
 *
 * Mocking pattern mirrors the sibling route test
 * (api-conversations-id-tree.server.test.ts): `vi.mock` collaborators, dynamic
 * import of the handler AFTER mocks, forged RequestEvent.
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

vi.mock("$lib/server/security/validation", () => ({
	validationError: () => new Response(JSON.stringify({ error: "invalid" }), { status: 400 }),
}));

// Ownership: authorize convId "conv-owned" for user-1, deny everything else.
const resolveRootConversationForOwnership = vi.fn(
	async (id: string, user: { id: string }) =>
		id === "conv-owned" && user.id === "user-1"
			? { conv: { id, projectId: "proj-1", provider: "anthropic", model: "claude", agentConfigId: "ac-1", modeId: "mode-1" }, root: { id } }
			: null,
);
vi.mock("$lib/server/conversation-ownership", () => ({
	resolveRootConversationForOwnership: (...args: unknown[]) =>
		(resolveRootConversationForOwnership as unknown as (...a: unknown[]) => unknown)(...args),
}));

let flagEnabled = true;
vi.mock("$server/db/session-sync", () => ({
	isSessionHistoryProducerEnabled: async () => flagEnabled,
}));

let memRun: unknown = null;
const streamChat = vi.fn(async (..._args: unknown[]) => ({ id: "run" }));
const getActiveRunForConversation = vi.fn((..._args: unknown[]) => memRun);
vi.mock("$lib/server/context", () => ({
	getExecutor: () => ({ getActiveRunForConversation, streamChat }),
}));

let dbRun: unknown = null;
const getActiveRun = vi.fn(async () => dbRun);
vi.mock("$server/db/queries/active-runs", () => ({
	getActiveRun: (...a: unknown[]) => (getActiveRun as unknown as (...x: unknown[]) => unknown)(...a),
}));

let budgetAllowed = true;
vi.mock("$lib/server/security/resource-quotas", () => ({
	checkTokenBudget: async () => ({ allowed: budgetAllowed, resetsAt: 123 }),
}));

vi.mock("$lib/server/command-resolver", () => ({
	buildCommandResolver: () => ({ _resolver: true }),
}));

let messages: Array<{ id: string; role: string; content: string; parentMessageId: string | null }> = [];
const getMessages = vi.fn(async () => messages);
vi.mock("$server/db/queries/conversations", () => ({
	getMessages: (...a: unknown[]) => (getMessages as unknown as (...x: unknown[]) => unknown)(...a),
}));

const { POST } = await import(
	"../routes/api/conversations/[id]/messages/[mid]/retry/+server"
);

interface EventLike {
	request: Request;
	locals: Record<string, unknown>;
	params: { id: string; mid: string };
}
function makeEvent(
	body: unknown = {},
	{ id = "conv-owned", mid = "a1", locals = {} as Record<string, unknown>, badJson = false } = {},
): EventLike {
	return {
		request: new Request(`http://localhost/api/conversations/${id}/messages/${mid}/retry`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: badJson ? "not-json{" : JSON.stringify(body),
		}),
		locals: { user: { id: "user-1", email: "u@x", name: "u", role: "member" }, ...locals },
		params: { id, mid },
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

const OK_MESSAGES = [
	{ id: "u1", role: "user", content: "the prompt", parentMessageId: null },
	{ id: "a1", role: "assistant", content: "first answer", parentMessageId: "u1" },
];

beforeEach(() => {
	flagEnabled = true;
	memRun = null;
	dbRun = null;
	budgetAllowed = true;
	messages = OK_MESSAGES.map((m) => ({ ...m }));
	streamChat.mockClear();
	streamChat.mockResolvedValue({ id: "run" });
	getActiveRunForConversation.mockClear();
	getActiveRun.mockClear();
	getMessages.mockClear();
	resolveRootConversationForOwnership.mockClear();
});

describe("POST /api/conversations/[id]/messages/[mid]/retry", () => {
	test("API key without the chat scope → 403; ownership never resolved", async () => {
		const res = await run(() => POST(makeEvent({}, { locals: { apiKeyScopes: ["read"] } }) as never));
		expect(res.status).toBe(403);
		expect(resolveRootConversationForOwnership).not.toHaveBeenCalled();
	});

	test("no user in locals → 401", async () => {
		const res = await run(() => POST(makeEvent({}, { locals: { user: undefined } }) as never));
		expect(res.status).toBe(401);
	});

	test("unowned conversation → 404; flag never checked", async () => {
		const res = await run(() => POST(makeEvent({}, { id: "conv-other" }) as never));
		expect(res.status).toBe(404);
		expect(streamChat).not.toHaveBeenCalled();
	});

	test("flag OFF → 409 session_producer_disabled", async () => {
		flagEnabled = false;
		const res = await run(() => POST(makeEvent() as never));
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe("session_producer_disabled");
	});

	test("in-memory active run → 409 active_run; DB never consulted", async () => {
		memRun = { id: "run-x" };
		const res = await run(() => POST(makeEvent() as never));
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe("active_run");
		expect(getActiveRun).not.toHaveBeenCalled();
	});

	test("DB active run (no mem run) → 409 active_run", async () => {
		dbRun = { id: "run-db" };
		const res = await run(() => POST(makeEvent() as never));
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe("active_run");
		expect(getActiveRun).toHaveBeenCalled();
	});

	test("unknown body field → 400 (validationError)", async () => {
		const res = await run(() => POST(makeEvent({ bogus: 1 }) as never));
		expect(res.status).toBe(400);
		expect(streamChat).not.toHaveBeenCalled();
	});

	test("budget exceeded → 429", async () => {
		budgetAllowed = false;
		const res = await run(() => POST(makeEvent() as never));
		expect(res.status).toBe(429);
		expect(streamChat).not.toHaveBeenCalled();
	});

	test("target not an assistant of this conversation → 400 target_not_found", async () => {
		const res = await run(() => POST(makeEvent({}, { mid: "nope" }) as never));
		expect(res.status).toBe(400);
		expect((await res.json()).code).toBe("target_not_found");
	});

	test("target assistant with no user parent → 400 no_user_parent", async () => {
		messages = [{ id: "a1", role: "assistant", content: "orphan", parentMessageId: null }];
		const res = await run(() => POST(makeEvent() as never));
		expect(res.status).toBe(400);
		expect((await res.json()).code).toBe("no_user_parent");
	});

	test("parent exists but is not a user row → 400 no_user_parent", async () => {
		messages = [
			{ id: "sys", role: "assistant", content: "x", parentMessageId: null },
			{ id: "a1", role: "assistant", content: "y", parentMessageId: "sys" },
		];
		const res = await run(() => POST(makeEvent() as never));
		expect(res.status).toBe(400);
		expect((await res.json()).code).toBe("no_user_parent");
	});

	test("happy path → 200; streamChat anchors the EXISTING user turn (no new row)", async () => {
		const res = await run(() => POST(makeEvent() as never));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { userMessage: { id: string }; retriedMessageId: string; runId: string };
		expect(body.userMessage.id).toBe("u1");
		expect(body.retriedMessageId).toBe("a1");
		expect(typeof body.runId).toBe("string");
		// The anchor is the existing user message; conversation identity by default.
		expect(streamChat).toHaveBeenCalledTimes(1);
		const [convId, content, opts] = streamChat.mock.calls[0]!;
		expect(convId).toBe("conv-owned");
		expect(content).toBe("the prompt");
		expect((opts as { parentMessageId: string }).parentMessageId).toBe("u1");
		expect((opts as { provider?: string }).provider).toBe("anthropic");
		expect((opts as { model?: string }).model).toBe("claude");
		expect((opts as { runId?: string }).runId).toBe(body.runId);
	});

	test("empty/absent body via bad JSON → 200 (retries with conversation identity)", async () => {
		const res = await run(() => POST(makeEvent(undefined, { badJson: true }) as never));
		expect(res.status).toBe(200);
		expect(streamChat).toHaveBeenCalledTimes(1);
	});

	test("body overrides provider/model/thinkingLevel", async () => {
		const res = await run(() =>
			POST(makeEvent({ provider: "openai", model: "gpt", thinkingLevel: "high" }) as never),
		);
		expect(res.status).toBe(200);
		const [, , opts] = streamChat.mock.calls[0]!;
		expect((opts as { provider?: string }).provider).toBe("openai");
		expect((opts as { model?: string }).model).toBe("gpt");
		expect((opts as { thinkingLevel?: string }).thinkingLevel).toBe("high");
	});

	test("streamChat rejection is swallowed (still 200; run streams via SSE)", async () => {
		streamChat.mockRejectedValueOnce(new Error("boom"));
		const res = await run(() => POST(makeEvent() as never));
		expect(res.status).toBe(200);
		// let the fire-and-forget .catch settle without an unhandled rejection
		await new Promise((r) => setTimeout(r, 0));
	});
});
