/**
 * POST /api/extensions/[id]/reapprove-drift — route-layer contract.
 *
 * The core heal (disk-manifest load, lockfile gate, ceiling clamp,
 * atomic row update, audit) lives in
 * `src/extensions/bundled-drift-reapprove.ts` and is integration-tested
 * against the real on-disk web-search manifest in
 * `src/__tests__/bundled-drift-reapprove.test.ts`. THIS suite pins the
 * HTTP surface: auth gating (admin-only + extensions scope), the
 * 400/404/409/500 error mapping, the registry reload, and the
 * `{ extension, diffs }` response shape.
 *
 * Mocking pattern mirrors the sibling route tests in this directory
 * (extensions-reapprove-route.server.test.ts): `vi.mock("$server/…")`
 * collaborators, dynamic import of the handler AFTER mocks, forged
 * RequestEvent.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

// ── Auth middleware (real contract: requireRole throws a 403 Response) ─
vi.mock("$server/auth/middleware", () => ({
	requireAuth: (locals: Record<string, unknown>) => {
		const user = locals.user as { id: string; role: string } | undefined;
		if (!user) throw new Response("Unauthorized", { status: 401 });
		return user;
	},
	requireRole: (locals: Record<string, unknown>, role: string) => {
		const user = locals.user as { id: string; role: string } | undefined;
		if (!user || user.role !== role) {
			throw new Response(JSON.stringify({ error: "Insufficient permissions" }), {
				status: 403,
			});
		}
		return user;
	},
}));

// Real contract: null for cookie auth / matching scope; 403 Response otherwise.
vi.mock("$lib/server/security/api-keys", () => ({
	requireScope: (
		locals: { apiKeyScopes?: string[] },
		scope: string,
	): Response | null => {
		if (!locals.apiKeyScopes) return null;
		if (locals.apiKeyScopes.includes(scope)) return null;
		return new Response(JSON.stringify({ error: "Insufficient scope" }), {
			status: 403,
		});
	},
}));

vi.mock("$lib/server/http-errors", () => ({
	errorJson: (status: number, message: string) =>
		new Response(JSON.stringify({ error: message }), {
			status,
			headers: { "Content-Type": "application/json" },
		}),
}));

// ── Extension lookup (per-test row) ─────────────────────────────────
let extensionRow: Record<string, unknown> | null = null;

vi.mock("$server/db/queries/extensions", () => ({
	getExtension: vi.fn(async (_id: string) => extensionRow),
}));

// Bundled-name gate: only "web-search" counts as bundled in this suite.
vi.mock("$server/extensions/bundled", () => ({
	isBundledExtensionName: (name: string) => name === "web-search",
}));

// ── Core heal (per-test result) ─────────────────────────────────────
type CoreResult =
	| { ok: true; updated: unknown; diffs: unknown[] }
	| { ok: false; code: string; message: string };
let coreResult: CoreResult;
const reapproveBundledDrift = vi.fn(async () => coreResult);

vi.mock("$server/extensions/bundled-drift-reapprove", () => ({
	reapproveBundledDrift: (...args: unknown[]) =>
		(reapproveBundledDrift as unknown as (...a: unknown[]) => unknown)(...args),
}));

// ── Registry reload spy ─────────────────────────────────────────────
const reload = vi.fn(async () => {});
vi.mock("$server/extensions/registry", () => ({
	ExtensionRegistry: {
		getInstance: () => ({ reload }),
	},
}));

// ── Import handler AFTER mocks ──────────────────────────────────────
const { POST } = await import(
	"../routes/api/extensions/[id]/reapprove-drift/+server"
);

// ── Helpers ─────────────────────────────────────────────────────────
interface RequestEventLike {
	request: Request;
	locals: Record<string, unknown>;
	params: { id: string };
}

function makeEvent(
	role: "admin" | "member" = "admin",
	locals: Record<string, unknown> = {},
): RequestEventLike {
	return {
		request: new Request(
			"http://localhost/api/extensions/ext-1/reapprove-drift",
			{ method: "POST" },
		),
		locals: {
			user: { id: "user-1", email: "u@x", name: "u", role },
			...locals,
		},
		params: { id: "ext-1" },
	};
}

async function expectThrownOrResponse(
	fn: () => Promise<Response> | Response,
): Promise<Response> {
	try {
		return await fn();
	} catch (thrown) {
		expect(thrown).toBeInstanceOf(Response);
		return thrown as Response;
	}
}

beforeEach(() => {
	reapproveBundledDrift.mockClear();
	reload.mockClear();
	extensionRow = {
		id: "ext-1",
		name: "web-search",
		enabled: false,
		version: "0.9.0",
		manifest: { permissions: { network: ["api.tavily.com"] } },
		grantedPermissions: { network: ["api.tavily.com"], grantedAt: {} },
	};
	coreResult = {
		ok: true,
		updated: { id: "ext-1", name: "web-search", enabled: true, version: "1.0.0" },
		diffs: [
			{ field: "network", oldValue: ["api.tavily.com"], newValue: ["api.tavily.com", "searxng"] },
		],
	};
});

describe("POST /api/extensions/[id]/reapprove-drift", () => {
	test("admin + bundled → 200 with { extension, diffs }; core called with row + admin id; registry reloaded", async () => {
		const res = await expectThrownOrResponse(() => POST(makeEvent() as never));
		expect(res.status).toBe(200);

		const body = (await res.json()) as { extension: { enabled: boolean }; diffs: unknown[] };
		expect(body.extension.enabled).toBe(true);
		expect(body.diffs).toHaveLength(1);

		expect(reapproveBundledDrift).toHaveBeenCalledTimes(1);
		expect(reapproveBundledDrift).toHaveBeenCalledWith(extensionRow, "user-1");
		expect(reload).toHaveBeenCalledTimes(1);
	});

	test("member (non-admin) → 403; core never called", async () => {
		const res = await expectThrownOrResponse(() => POST(makeEvent("member") as never));
		expect(res.status).toBe(403);
		expect(reapproveBundledDrift).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
	});

	test("API key without the extensions scope → 403; core never called", async () => {
		const res = await expectThrownOrResponse(() =>
			POST(makeEvent("admin", { apiKeyScopes: ["chat"] }) as never),
		);
		expect(res.status).toBe(403);
		expect(reapproveBundledDrift).not.toHaveBeenCalled();
	});

	test("unknown extension id → 404", async () => {
		extensionRow = null;
		const res = await expectThrownOrResponse(() => POST(makeEvent() as never));
		expect(res.status).toBe(404);
		expect(reapproveBundledDrift).not.toHaveBeenCalled();
	});

	test("non-bundled extension → 400; core never called", async () => {
		extensionRow = { ...extensionRow!, name: "user-installed-thing" };
		const res = await expectThrownOrResponse(() => POST(makeEvent() as never));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/bundled/i);
		expect(reapproveBundledDrift).not.toHaveBeenCalled();
	});

	test("core lockfile-mismatch → 409; registry NOT reloaded", async () => {
		coreResult = {
			ok: false,
			code: "lockfile-mismatch",
			message: "On-disk manifest fails the manifest.lock.json check (tool-list drift)",
		};
		const res = await expectThrownOrResponse(() => POST(makeEvent() as never));
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/manifest\.lock\.json/);
		expect(reload).not.toHaveBeenCalled();
	});

	test("core manifest-unreadable → 500", async () => {
		coreResult = {
			ok: false,
			code: "manifest-unreadable",
			message: "Could not load on-disk manifest",
		};
		const res = await expectThrownOrResponse(() => POST(makeEvent() as never));
		expect(res.status).toBe(500);
		expect(reload).not.toHaveBeenCalled();
	});

	test("core not-found (row raced away) → 404", async () => {
		coreResult = { ok: false, code: "not-found", message: "Extension 'ext-1' no longer exists" };
		const res = await expectThrownOrResponse(() => POST(makeEvent() as never));
		expect(res.status).toBe(404);
	});

	test("core not-bundled (defensive re-check) → 400", async () => {
		coreResult = { ok: false, code: "not-bundled", message: "'web-search' is not a bundled extension" };
		const res = await expectThrownOrResponse(() => POST(makeEvent() as never));
		expect(res.status).toBe(400);
	});
});
