/**
 * POST /api/conversations/[id]/rewind — route-layer contract (Sessions P4).
 *
 * The moveTo/branch_summary mechanics live in
 * `src/db/session-sync.ts#rewindSession` and are integration-tested against the
 * real seam in `src/__tests__/session-sync.test.ts`. THIS suite pins the HTTP
 * surface: scope/auth gating, 404 fail-closed on an unowned conversation, the
 * 409s (flag off / active run), 400 validation + target-not-found, the
 * conversation:tree-changed emit, and the 200 tree passthrough.
 *
 * Uses the real `./schema` (Zod) — targetMessageId must be a UUID — and mocks
 * every collaborator via `vi.mock`, mirroring the sibling route tests here.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const VALID_TARGET = "11111111-1111-4111-8111-111111111111";

vi.mock("$server/logger", () => ({
	logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

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
	validationError: () => new Response(JSON.stringify({ error: "Validation failed" }), { status: 400 }),
}));

const resolveRootConversationForOwnership = vi.fn(
	async (id: string, user: { id: string }) =>
		id === "conv-owned" && user.id === "user-1" ? { conv: { id }, root: { id } } : null,
);
vi.mock("$lib/server/conversation-ownership", () => ({
	resolveRootConversationForOwnership: (...args: unknown[]) =>
		(resolveRootConversationForOwnership as unknown as (...a: unknown[]) => unknown)(...args),
}));

let memRun: unknown;
const emit = vi.fn();
vi.mock("$lib/server/context", () => ({
	getExecutor: () => ({ getActiveRunForConversation: () => memRun }),
	getBus: () => ({ emit }),
}));

let dbRun: unknown = null;
vi.mock("$server/db/queries/active-runs", () => ({ getActiveRun: async () => dbRun }));

let flagEnabled = true;
type Outcome = { ok: true; tree: unknown } | { ok: false; reason: "target_not_found" };
let outcome: Outcome = {
	ok: true,
	tree: { conversationId: "conv-owned", currentLeaf: VALID_TARGET, nodes: [] },
};
const rewindSession = vi.fn(async () => outcome);
vi.mock("$server/db/session-sync", () => ({
	isSessionHistoryProducerEnabled: async () => flagEnabled,
	rewindSession: (...args: unknown[]) =>
		(rewindSession as unknown as (...a: unknown[]) => unknown)(...args),
}));

const { POST } = await import("../routes/api/conversations/[id]/rewind/+server");

interface EventLike {
	request: Request;
	locals: Record<string, unknown>;
	params: { id: string };
}
function makeEvent(
	body: unknown = { targetMessageId: VALID_TARGET },
	id = "conv-owned",
	locals: Record<string, unknown> = {},
): EventLike {
	return {
		request: new Request(`http://localhost/api/conversations/${id}/rewind`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
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
	memRun = undefined;
	dbRun = null;
	outcome = { ok: true, tree: { conversationId: "conv-owned", currentLeaf: VALID_TARGET, nodes: [] } };
	rewindSession.mockClear();
	emit.mockClear();
	resolveRootConversationForOwnership.mockClear();
});

describe("POST /api/conversations/[id]/rewind", () => {
	test("owned + flag ON + no run + valid body → 200 tree; emits conversation:tree-changed", async () => {
		const res = await run(() => POST(makeEvent({ targetMessageId: VALID_TARGET, summary: "went sideways" }) as never));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { currentLeaf: string };
		expect(body.currentLeaf).toBe(VALID_TARGET);
		expect(rewindSession).toHaveBeenCalledWith("conv-owned", VALID_TARGET, "went sideways");
		expect(emit).toHaveBeenCalledWith("conversation:tree-changed", {
			conversationId: "conv-owned",
			currentLeaf: VALID_TARGET,
		});
	});

	test("flag OFF → 409 session_producer_disabled; rewind never attempted", async () => {
		flagEnabled = false;
		const res = await run(() => POST(makeEvent() as never));
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe("session_producer_disabled");
		expect(rewindSession).not.toHaveBeenCalled();
	});

	test("active in-memory run → 409 active_run; no rewind, no emit", async () => {
		memRun = { id: "run-1" };
		const res = await run(() => POST(makeEvent() as never));
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe("active_run");
		expect(rewindSession).not.toHaveBeenCalled();
		expect(emit).not.toHaveBeenCalled();
	});

	test("active DB run (survived a restart) → 409 active_run", async () => {
		dbRun = { id: "run-db", status: "running" };
		const res = await run(() => POST(makeEvent() as never));
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe("active_run");
	});

	test("invalid body (non-UUID target) → 400 validation; rewind never attempted", async () => {
		const res = await run(() => POST(makeEvent({ targetMessageId: "not-a-uuid" }) as never));
		expect(res.status).toBe(400);
		expect(rewindSession).not.toHaveBeenCalled();
	});

	test("target not in the conversation → 400 target_not_found; no emit", async () => {
		outcome = { ok: false, reason: "target_not_found" };
		const res = await run(() => POST(makeEvent() as never));
		expect(res.status).toBe(400);
		expect((await res.json()).code).toBe("target_not_found");
		expect(emit).not.toHaveBeenCalled();
	});

	test("unowned conversation → 404; flag never checked", async () => {
		const res = await run(() => POST(makeEvent({ targetMessageId: VALID_TARGET }, "conv-other") as never));
		expect(res.status).toBe(404);
		expect(rewindSession).not.toHaveBeenCalled();
	});

	test("API key without the chat scope → 403; ownership never resolved", async () => {
		const res = await run(() =>
			POST(makeEvent({ targetMessageId: VALID_TARGET }, "conv-owned", { apiKeyScopes: ["read"] }) as never),
		);
		expect(res.status).toBe(403);
		expect(resolveRootConversationForOwnership).not.toHaveBeenCalled();
	});

	test("a failing bus emit is swallowed — the rewind still returns 200", async () => {
		emit.mockImplementationOnce(() => {
			throw new Error("bus down");
		});
		const res = await run(() => POST(makeEvent() as never));
		expect(res.status).toBe(200);
	});
});
