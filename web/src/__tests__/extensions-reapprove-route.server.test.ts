/**
 * Phase 56 (per-capability TTL UI) — Wave 0 RED scaffold for the
 * settings-side `POST /api/extensions/[id]/reapprove` route's
 * `ttlOverrideMs` field acceptance + audit metadata + defense-in-depth
 * admin gating around `scope=forever`.
 *
 * Today the route at `web/src/routes/api/extensions/[id]/reapprove/+server.ts`
 * accepts `{ capability, scope? }`. Plan 56-02 widens the body to also
 * accept optional `ttlOverrideMs?: number | null` and:
 *   • threads the value through the always-allow row writer (so
 *     `options.ttlOverrideMs` lands in `buildAlwaysAllowValue`),
 *   • computes `expiresAt = grantedAt + ttlOverrideMs` when positive
 *     (or `null` when null),
 *   • records audit metadata `{ requestedTtl, appliedTtl }`,
 *   • keeps the existing admin gate on `scope: "forever"` (defense-in-
 *     depth — picker `Never` (`ttlOverrideMs: null`) at any scope OTHER
 *     than `forever` MUST work for non-admins).
 *
 * These tests are RED until Plan 56-02 lands the field. Today the body
 * is silently discarded → audit metadata is missing → assertions fail.
 *
 * The mocking pattern mirrors existing route tests in this directory:
 *   - `vi.mock("$server/...", ...)` collaborators
 *   - dynamic `await import(...)` of the route handler AFTER mocks
 *   - `makeEvent({ body, locals })` helper to forge a RequestEvent
 *
 * Coverage (six described cases):
 *   1. Positive `ttlOverrideMs` → 200, writer gets the value, audit OK
 *   2. `ttlOverrideMs: null` → 200, writer gets null, audit { null, null }
 *   3. `ttlOverrideMs: 0` → 400 (Pitfall 2 — positive | null | omitted)
 *   4. `ttlOverrideMs: -5` → 400 (same path as zero)
 *   5. `ttlOverrideMs` omitted → 200, writer gets undefined (legacy)
 *   6. Non-admin + `scope=forever` + `ttlOverrideMs: null` → 403
 *   7. Non-admin + `scope: "conversation"` + `ttlOverrideMs: null` → 200
 *      (picker Never is NOT scope escalation — CONTEXT.md decision).
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

// ── Mock auth + scope middleware ──────────────────────────────────
// `requireAuth(locals)` returns the user. `requireRole(locals, "admin")`
// throws a 403 Response when the user lacks the role — mirror that
// contract in the mock so the defense-in-depth admin gate fires.

vi.mock("$server/auth/middleware", () => ({
	requireAuth: (locals: Record<string, unknown>) => {
		const user = locals.user as
			| { id: string; role: string }
			| undefined;
		if (!user) throw new Response("Unauthorized", { status: 401 });
		return user;
	},
	requireRole: (locals: Record<string, unknown>, role: string) => {
		const user = locals.user as { role: string } | undefined;
		if (!user || user.role !== role) {
			throw new Response(JSON.stringify({ error: "Forbidden" }), {
				status: 403,
			});
		}
		return user;
	},
}));

vi.mock("$lib/server/security/api-keys", () => ({
	requireScope: () => null,
}));

vi.mock("$lib/server/http-errors", () => ({
	errorJson: (status: number, message: string) =>
		new Response(JSON.stringify({ error: message }), {
			status,
			headers: { "Content-Type": "application/json" },
		}),
}));

// ── Mock the extension lookup ─────────────────────────────────────
//
// `getExtension(id)` returns the row. The route uses it to derive
// the manifest ceiling for clamping. Provide a manifest that grants
// `shell` so the clamp doesn't strip the grant.

vi.mock("$server/db/queries/extensions", () => ({
	getExtension: async (_id: string) => ({
		id: "ext-1",
		name: "test-extension",
		enabled: true,
		manifest: {
			permissions: { shell: true },
		},
		installedPermissions: { shell: true },
		grantedPermissions: { shell: true, grantedAt: { shell: Date.now() } },
	}),
	updateExtension: async (_id: string, patch: unknown) => ({
		id: "ext-1",
		...(patch as Record<string, unknown>),
	}),
}));

// ── Mock bundled / ceiling helpers ─────────────────────────────────

vi.mock("$server/extensions/bundled", () => ({
	isBundledExtensionName: () => false,
}));

vi.mock("$server/extensions/bundled-ceiling", () => ({
	getCeiling: () => null,
}));

vi.mock("$lib/server/extension-helpers", () => ({
	clampExtensionPermissions: (submitted: unknown, _manifest: unknown) =>
		submitted,
}));

// ── Mock the registry reload ──────────────────────────────────────

vi.mock("$server/extensions/registry", () => ({
	ExtensionRegistry: {
		getInstance: () => ({ reload: async () => {} }),
	},
}));

// ── Mock the always-allow row writer (spy point for ttlOverrideMs) ─
//
// Plan 56-02 threads `ttlOverrideMs` into the upsert call. The exact
// helper name + module path are planner discretion — RESEARCH lists
// `upsertAlwaysAllow` as the candidate writer. We declare BOTH a
// `setSensitiveAlwaysAllow` mock (current helper in
// `src/extensions/permissions.ts`) AND an `upsertAlwaysAllow` mock
// (likely Plan 56-02 addition). The test inspects whichever one was
// called.

interface WriterCall {
	args: unknown[];
	options?: { ttlOverrideMs?: number | null; expiresAt?: number | null };
}
const writerCalls: WriterCall[] = [];

vi.mock("$server/extensions/permissions", async () => {
	const actual = await vi.importActual<typeof import("$server/extensions/permissions")>(
		"$server/extensions/permissions",
	);
	return {
		...actual,
		setSensitiveAlwaysAllow: vi.fn(async (...args: unknown[]) => {
			// Plan 56-02 will widen the signature to accept an options
			// object (last positional arg). Capture verbatim so the test
			// can introspect.
			const last = args[args.length - 1];
			const options =
				last && typeof last === "object" && !Array.isArray(last)
					? (last as { ttlOverrideMs?: number | null; expiresAt?: number | null })
					: undefined;
			writerCalls.push({ args, options });
		}),
		buildAlwaysAllowValue: vi.fn((allowed: boolean, now?: number, options?: unknown) => {
			// Plan 56-02 will add the optional 3rd-arg `options` carrying
			// `ttlOverrideMs` + `expiresAt`. Record the call so the test
			// can assert against it.
			const opts = options as
				| { ttlOverrideMs?: number | null; expiresAt?: number | null }
				| undefined;
			writerCalls.push({ args: [allowed, now, options], options: opts });
			return {
				allowed,
				grantedAt: now ?? Date.now(),
				...(opts ?? {}),
			};
		}),
	};
});

// ── Audit-log spy ─────────────────────────────────────────────────

const auditCalls: Array<{
	userId: string;
	action: string;
	target: string;
	metadata: Record<string, unknown>;
}> = [];

vi.mock("$server/db/queries/audit-log", () => ({
	insertAuditEntry: async (
		userId: string,
		action: string,
		target: string,
		metadata: Record<string, unknown>,
	) => {
		auditCalls.push({ userId, action, target, metadata });
	},
}));

vi.mock("$server/extensions/audit-actions", () => ({
	EXT_AUDIT_ACTIONS: {
		PERMISSION_REAPPROVED: "ext:permission-reapproved",
	},
}));

// ── Import handler AFTER mocks ────────────────────────────────────

const { POST } = await import(
	"../routes/api/extensions/[id]/reapprove/+server"
);

// ── Helpers ───────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

interface RequestEventLike {
	request: Request;
	locals: Record<string, unknown>;
	params: { id: string };
}

function makeEvent(body: unknown, role: "admin" | "member" = "member"): RequestEventLike {
	return {
		request: new Request("http://localhost/api/extensions/ext-1/reapprove", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: {
			user: { id: "user-1", email: "u@x", name: "u", role },
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
	writerCalls.length = 0;
	auditCalls.length = 0;
});

// ── Tests ──────────────────────────────────────────────────────────

describe("POST /api/extensions/[id]/reapprove — ttlOverrideMs", () => {
	test("body with ttlOverrideMs: 7d → 200; writer gets options.ttlOverrideMs/expiresAt; audit metadata.requestedTtl/appliedTtl set", async () => {
		const grantedAt = Date.now();
		const res = await expectThrownOrResponse(() =>
			POST(
				makeEvent({
					capability: "shell",
					scope: "conversation",
					ttlOverrideMs: 7 * DAY_MS,
				}) as never,
			),
		);

		expect(res.status).toBe(200);
		// At least one writer call must have happened with ttlOverrideMs
		// set. We don't care which helper landed first — buildAlwaysAllowValue
		// or setSensitiveAlwaysAllow — only that the override threaded
		// through.
		const positive = writerCalls.find(
			(c) => c.options?.ttlOverrideMs === 7 * DAY_MS,
		);
		expect(positive).toBeDefined();
		// `expiresAt` should mirror grantedAt + ttl. We allow a 1s slack
		// because the handler stamps grantedAt internally.
		const expectedExpires = grantedAt + 7 * DAY_MS;
		const actualExpires = positive?.options?.expiresAt;
		expect(typeof actualExpires).toBe("number");
		if (typeof actualExpires === "number") {
			expect(Math.abs(actualExpires - expectedExpires)).toBeLessThan(2_000);
		}

		// Audit metadata MUST carry both fields.
		expect(auditCalls).toHaveLength(1);
		const audit = auditCalls[0]!;
		expect(audit.metadata.requestedTtl).toBe(7 * DAY_MS);
		expect(audit.metadata.appliedTtl).toBe(7 * DAY_MS);
	});

	test("body with ttlOverrideMs: null → 200; writer gets null/null; audit { requestedTtl: null, appliedTtl: null }", async () => {
		// CONTEXT.md locked decision: picker `Never` sets BOTH
		// `ttlOverrideMs: null` AND `expiresAt: null`. Audit reflects the
		// unbounded grant directly (null TTL is queryable; no separate
		// `isUnboundedTtl` flag).
		const res = await expectThrownOrResponse(() =>
			POST(
				makeEvent({
					capability: "shell",
					scope: "conversation",
					ttlOverrideMs: null,
				}) as never,
			),
		);

		expect(res.status).toBe(200);
		const writerHit = writerCalls.find((c) => c.options?.ttlOverrideMs === null);
		expect(writerHit).toBeDefined();
		expect(writerHit?.options?.expiresAt).toBe(null);

		expect(auditCalls).toHaveLength(1);
		expect(auditCalls[0]?.metadata.requestedTtl).toBe(null);
		expect(auditCalls[0]?.metadata.appliedTtl).toBe(null);
	});

	test("body with ttlOverrideMs: 0 → 400 with Pitfall-2 error message", async () => {
		// Zero is a footgun: it expires the grant the moment it's
		// written. The handler MUST reject before persisting.
		const res = await expectThrownOrResponse(() =>
			POST(
				makeEvent({
					capability: "shell",
					scope: "conversation",
					ttlOverrideMs: 0,
				}) as never,
			),
		);

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(typeof body.error).toBe("string");
		expect(body.error).toMatch(/ttlOverrideMs/);
		expect(body.error).toMatch(/positive number.*null.*omitted/i);

		// No writer call, no audit entry on rejection.
		expect(writerCalls).toHaveLength(0);
		expect(auditCalls).toHaveLength(0);
	});

	test("body with ttlOverrideMs: -5 → 400 (same path as zero)", async () => {
		const res = await expectThrownOrResponse(() =>
			POST(
				makeEvent({
					capability: "shell",
					scope: "conversation",
					ttlOverrideMs: -5,
				}) as never,
			),
		);
		expect(res.status).toBe(400);
		expect(writerCalls).toHaveLength(0);
		expect(auditCalls).toHaveLength(0);
	});

	test("body WITHOUT ttlOverrideMs (field omitted) → 200; writer gets options.ttlOverrideMs === undefined (legacy path)", async () => {
		const res = await expectThrownOrResponse(() =>
			POST(
				makeEvent({
					capability: "shell",
					scope: "conversation",
				}) as never,
			),
		);
		expect(res.status).toBe(200);

		// At least one writer call WITHOUT `ttlOverrideMs` set — i.e.
		// either no options arg, or an options object where the field
		// is explicitly undefined. The audit row's requestedTtl should
		// either be undefined (omitted) or unset.
		const legacyCall = writerCalls.find(
			(c) => c.options === undefined || c.options.ttlOverrideMs === undefined,
		);
		expect(legacyCall).toBeDefined();
	});

	test("non-admin + scope='forever' + ttlOverrideMs: null → 403 (scope=forever still admin-gated; defense in depth)", async () => {
		// CONTEXT.md: "Server endpoints still gate scope=forever to
		// admins — defense in depth unchanged." Picker Never on a
		// scope=forever request from a non-admin is REJECTED on the
		// scope, not on the picker.
		const res = await expectThrownOrResponse(() =>
			POST(
				makeEvent(
					{
						capability: "shell",
						scope: "forever",
						ttlOverrideMs: null,
					},
					"member",
				) as never,
			),
		);
		expect(res.status).toBe(403);
		expect(writerCalls).toHaveLength(0);
	});

	test("non-admin + scope='conversation' + ttlOverrideMs: null → 200 (picker Never is NOT scope escalation)", async () => {
		// CONTEXT.md: "All users can pick Never from the picker
		// dropdown — no admin gate." A non-admin choosing Never for a
		// per-conversation grant gets the same green-path as the
		// admin — only `scope=forever` is admin-gated.
		const res = await expectThrownOrResponse(() =>
			POST(
				makeEvent(
					{
						capability: "shell",
						scope: "conversation",
						ttlOverrideMs: null,
					},
					"member",
				) as never,
			),
		);
		expect(res.status).toBe(200);
		const writerHit = writerCalls.find(
			(c) => c.options?.ttlOverrideMs === null,
		);
		expect(writerHit).toBeDefined();
	});
});
