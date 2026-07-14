/**
 * Server-handler tests for `/api/contexts/model-support/+server.ts` — the
 * settings status-line endpoint. Pins the peek (normal load) vs probe
 * (?recheck=1) behaviour, the no-endpoint short-circuit, and the scope/auth
 * gates. vi.mock the model-support module (NOT bun mock.module — excluded from
 * lcov).
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/auth/middleware", () => ({
	requireAuth: (locals: Record<string, unknown>) => {
		const user = locals.user;
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

let local: { baseUrl: string | null; model: string } = { baseUrl: "http://side", model: "qwen3.5:4b" };
let peekResult: unknown = null;
let probeResult: unknown = { supported: true, baseUrl: "http://side", model: "qwen3.5:4b", checkedAt: 1 };
const getModelSupport = vi.fn(async () => probeResult);
const peekModelSupport = vi.fn(() => peekResult);
const invalidateModelSupport = vi.fn();
vi.mock("$server/contexts/model-support", () => ({
	resolveLocalModel: vi.fn(async () => local),
	getModelSupport: (...a: unknown[]) => (getModelSupport as (...x: unknown[]) => unknown)(...a),
	peekModelSupport: (...a: unknown[]) => (peekModelSupport as (...x: unknown[]) => unknown)(...a),
	invalidateModelSupport: () => invalidateModelSupport(),
}));

const { GET } = await import("../routes/api/contexts/model-support/+server");

function event(search = "", locals: Record<string, unknown> = { user: { id: "u1", role: "user" } }) {
	return { url: new URL(`http://x/api/contexts/model-support${search}`), locals } as never;
}
async function orThrown(fn: () => Promise<Response> | Response): Promise<Response> {
	try {
		return await fn();
	} catch (t) {
		expect(t).toBeInstanceOf(Response);
		return t as Response;
	}
}

beforeEach(() => {
	local = { baseUrl: "http://side", model: "qwen3.5:4b" };
	peekResult = null;
	probeResult = { supported: true, baseUrl: "http://side", model: "qwen3.5:4b", checkedAt: 1 };
	getModelSupport.mockClear();
	peekModelSupport.mockClear();
	invalidateModelSupport.mockClear();
});

describe("GET /api/contexts/model-support", () => {
	test("403 when API-key scope lacks 'read'", async () => {
		const res = await GET(event("", { user: { id: "u1" }, apiKeyScopes: ["chat"] }));
		expect(res.status).toBe(403);
	});

	test("401 when unauthenticated", async () => {
		const res = await orThrown(() => GET(event("", {})));
		expect(res.status).toBe(401);
	});

	test("no local endpoint → configured:false, endpoint-down (no probe)", async () => {
		local = { baseUrl: null, model: "qwen3.5:4b" };
		const body = (await (await GET(event())).json()) as any;
		expect(body).toEqual({
			localModel: "qwen3.5:4b",
			configured: false,
			probed: false,
			supported: false,
			reason: "endpoint-down",
		});
		expect(getModelSupport).not.toHaveBeenCalled();
		expect(peekModelSupport).not.toHaveBeenCalled();
	});

	test("normal load PEEKS — cold cache → probed:false", async () => {
		peekResult = null;
		const body = (await (await GET(event())).json()) as any;
		expect(body).toEqual({
			localModel: "qwen3.5:4b",
			configured: true,
			probed: false,
			supported: false,
			reason: null,
		});
		expect(getModelSupport).not.toHaveBeenCalled();
		expect(peekModelSupport).toHaveBeenCalled();
	});

	test("normal load PEEKS — warm cache → the cached result, no probe", async () => {
		peekResult = { supported: false, baseUrl: "http://side", model: "qwen3.5:4b", reason: "load-failed", checkedAt: 5 };
		const body = (await (await GET(event())).json()) as any;
		expect(body).toEqual({
			localModel: "qwen3.5:4b",
			configured: true,
			probed: true,
			supported: false,
			reason: "load-failed",
		});
		expect(getModelSupport).not.toHaveBeenCalled();
	});

	test("?recheck=1 invalidates then PROBES a fresh result", async () => {
		probeResult = { supported: true, baseUrl: "http://side", model: "qwen3.5:4b", checkedAt: 9 };
		const body = (await (await GET(event("?recheck=1"))).json()) as any;
		expect(invalidateModelSupport).toHaveBeenCalledTimes(1);
		expect(getModelSupport).toHaveBeenCalledTimes(1);
		expect(peekModelSupport).not.toHaveBeenCalled();
		expect(body).toEqual({
			localModel: "qwen3.5:4b",
			configured: true,
			probed: true,
			supported: true,
			reason: null,
		});
	});

	test("?recheck=1 surfaces an unsupported probe with its reason", async () => {
		probeResult = { supported: false, baseUrl: "http://side", model: "qwen3.5:4b", reason: "timeout", checkedAt: 9 };
		const body = (await (await GET(event("?recheck=1"))).json()) as any;
		expect(body.supported).toBe(false);
		expect(body.reason).toBe("timeout");
	});
});
