/**
 * Phase 56 (per-capability TTL UI) — Wave 0 RED scaffold for the
 * sticky-last-pick contract on both surfaces.
 *
 * CONTEXT.md locked decisions:
 *   - Per-kind sticky default: `user:<id>:reapprove:lastTtl:<kind>` (ms).
 *   - First-use fallback: uniform 30d.
 *   - "Never" is NOT sticky — picking `null` does NOT write the KV row,
 *     so next time the same kind expires the default returns to the
 *     previous sticky value (or 30d first-use).
 *   - Mirrors Phase 57 agent-picker saved-search pattern.
 *
 * RESEARCH.md recommendation #4 chose the batch-load surface as
 * `/api/extensions/[id]/expired-grants` — each row gets enriched with
 * `stickyTtlMs: number | null`. No new endpoint.
 *
 * These tests are RED until Plan 56-03 adds the enrichment and the
 * write-on-submit branches. The mocks intentionally fail today because
 * the route GET handler does not yet call `getSetting` per row, and
 * the POST handlers (reapprove route + chat-side tool-permission) do
 * not yet call `upsertSetting` on success.
 *
 * Coverage:
 *   1. Read-on-mount: GET /api/extensions/[id]/expired-grants returns
 *      rows enriched with `stickyTtlMs` (number if KV row present,
 *      null otherwise — frontend defaults to DEFAULT_TTL_FIRST_USE_MS).
 *   2. Write-on-submit (non-Never): POST reapprove with
 *      `ttlOverrideMs: 7*86400000` calls
 *      `upsertSetting("user:<id>:reapprove:lastTtl:shell", 7*86400000)`
 *      exactly once.
 *   3. Never-suppression: POST reapprove with `ttlOverrideMs: null`
 *      does NOT call `upsertSetting` for the lastTtl key.
 *   4. Write-on-submit chat-side: `handleToolPermission` with
 *      `ttlOverrideMs: 30*86400000` calls the SAME `upsertSetting`
 *      key shape with the user's id + the tool-call's resolved
 *      capability kind.
 *
 * The chat-side case crosses plan boundaries (reapprove vs chat-side
 * handler) intentionally — the sticky-pick CONTRACT is the same on
 * both surfaces, and locking it in one test file documents that
 * symmetry. Plan 56-03 will land both writes.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

// ── Settings KV spy ───────────────────────────────────────────────
//
// Both surfaces ultimately call `getSetting` / `upsertSetting` from
// `$server/db/queries/settings`. The mock captures every call.

interface SettingCall {
	op: "get" | "upsert";
	key: string;
	value?: unknown;
}
const settingCalls: SettingCall[] = [];
const settingStore = new Map<string, unknown>();

vi.mock("$server/db/queries/settings", () => ({
	getSetting: async (key: string) => {
		settingCalls.push({ op: "get", key });
		return settingStore.get(key);
	},
	upsertSetting: async (key: string, value: unknown) => {
		settingCalls.push({ op: "upsert", key, value });
		settingStore.set(key, value);
	},
}));

// ── Auth + scope ──────────────────────────────────────────────────

vi.mock("$server/auth/middleware", () => ({
	requireAuth: (locals: Record<string, unknown>) => {
		const user = locals.user as { id: string; role: string } | undefined;
		if (!user) throw new Response("Unauthorized", { status: 401 });
		return user;
	},
	requireRole: (locals: Record<string, unknown>, role: string) => {
		const user = locals.user as { role: string } | undefined;
		if (!user || user.role !== role) {
			throw new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
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

// ── Extension lookup ──────────────────────────────────────────────

vi.mock("$server/db/queries/extensions", () => ({
	getExtension: async (_id: string) => ({
		id: "ext-1",
		name: "test-extension",
		enabled: true,
		manifest: { permissions: { shell: true } },
		installedPermissions: { shell: true },
		grantedPermissions: { shell: true, grantedAt: { shell: Date.now() } },
	}),
	updateExtension: async (_id: string, patch: unknown) => ({
		id: "ext-1",
		...(patch as Record<string, unknown>),
	}),
}));

// ── Expired-grants list (drives the read-on-mount enrichment) ─────
//
// The current `/api/extensions/[id]/expired-grants` GET reads rows
// from `listExpiredGrantsForExtension`. Plan 56-03 will enrich each
// row with `stickyTtlMs` after reading `getSetting`. We seed the
// list with two rows (different capabilityKinds) so the per-kind
// lookup is exercised.

vi.mock("$server/db/queries/expired-grants", () => ({
	listExpiredGrantsForExtension: async (_id: string) => [
		{
			auditId: "audit-1",
			extensionId: "ext-1",
			capability: "shell",
			capabilityKind: "shell",
			ageMs: 2 * 86_400_000,
			expiredAt: Date.now() - 2 * 86_400_000,
		},
		{
			auditId: "audit-2",
			extensionId: "ext-1",
			capability: "filesystem-write",
			capabilityKind: "filesystem-write",
			ageMs: 3 * 86_400_000,
			expiredAt: Date.now() - 3 * 86_400_000,
		},
	],
}));

// ── Bundled / ceiling / clamper stubs ─────────────────────────────

vi.mock("$server/extensions/bundled", () => ({
	isBundledExtensionName: () => false,
}));
vi.mock("$server/extensions/bundled-ceiling", () => ({
	getCeiling: () => null,
}));
vi.mock("$lib/server/extension-helpers", () => ({
	clampExtensionPermissions: (submitted: unknown) => submitted,
}));
vi.mock("$server/extensions/registry", () => ({
	ExtensionRegistry: {
		getInstance: () => ({ reload: async () => {} }),
	},
}));
vi.mock("$server/db/queries/audit-log", () => ({
	insertAuditEntry: async () => {},
}));
vi.mock("$server/extensions/audit-actions", () => ({
	EXT_AUDIT_ACTIONS: {
		PERMISSION_REAPPROVED: "ext:permission-reapproved",
	},
}));
vi.mock("$server/extensions/permissions", async () => {
	const actual = await vi.importActual<typeof import("$server/extensions/permissions")>(
		"$server/extensions/permissions",
	);
	return { ...actual };
});

// ── Import handlers AFTER mocks ───────────────────────────────────

const { GET } = await import(
	"../routes/api/extensions/[id]/expired-grants/+server"
);
const { POST: reapprovePOST } = await import(
	"../routes/api/extensions/[id]/reapprove/+server"
);

// ── Helpers ───────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const HELLO_USER = "user-1";

interface RequestEventLike {
	request: Request;
	locals: Record<string, unknown>;
	params: { id: string };
}

function makeGetEvent(): RequestEventLike {
	return {
		request: new Request("http://localhost/api/extensions/ext-1/expired-grants"),
		locals: { user: { id: HELLO_USER, role: "member" } },
		params: { id: "ext-1" },
	};
}

function makePostEvent(body: unknown): RequestEventLike {
	return {
		request: new Request("http://localhost/api/extensions/ext-1/reapprove", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: { user: { id: HELLO_USER, role: "member" } },
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
	settingCalls.length = 0;
	settingStore.clear();
});

// ── Read-on-mount ──────────────────────────────────────────────────

describe("sticky last-pick — read-on-mount enrichment on /expired-grants", () => {
	test("each row gets stickyTtlMs from per-kind KV (or null when absent)", async () => {
		// Seed ONE of the two kinds; leave the other absent so the
		// null-fallback path is exercised in the same response.
		settingStore.set(`user:${HELLO_USER}:reapprove:lastTtl:shell`, 7 * DAY_MS);

		const res = await expectThrownOrResponse(() => GET(makeGetEvent() as never));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			grants: Array<{ capabilityKind?: string; stickyTtlMs?: number | null }>;
		};

		// The route MUST have queried getSetting for each row's kind.
		const getKeys = settingCalls
			.filter((c) => c.op === "get")
			.map((c) => c.key);
		expect(getKeys).toContain(`user:${HELLO_USER}:reapprove:lastTtl:shell`);
		expect(getKeys).toContain(
			`user:${HELLO_USER}:reapprove:lastTtl:filesystem-write`,
		);

		// Response shape: each row carries `stickyTtlMs` — 7d for the
		// seeded row, null for the absent one.
		const shellRow = body.grants.find((r) => r.capabilityKind === "shell");
		const fsRow = body.grants.find(
			(r) => r.capabilityKind === "filesystem-write",
		);
		expect(shellRow?.stickyTtlMs).toBe(7 * DAY_MS);
		expect(fsRow?.stickyTtlMs).toBe(null);
	});
});

// ── Write-on-submit (positive) ─────────────────────────────────────

describe("sticky last-pick — write-on-submit (positive ttlOverrideMs)", () => {
	test("POST reapprove with ttlOverrideMs: 7d writes user:<id>:reapprove:lastTtl:shell = 7d exactly once", async () => {
		// Plan 56-03 wires this write into the reapprove POST success
		// path. The settings store starts empty; after the request, the
		// per-kind KV row is written.
		const res = await expectThrownOrResponse(() =>
			reapprovePOST(
				makePostEvent({
					capability: "shell",
					scope: "conversation",
					ttlOverrideMs: 7 * DAY_MS,
				}) as never,
			),
		);
		expect(res.status).toBe(200);

		const writes = settingCalls.filter(
			(c) =>
				c.op === "upsert" &&
				c.key === `user:${HELLO_USER}:reapprove:lastTtl:shell`,
		);
		expect(writes).toHaveLength(1);
		expect(writes[0]?.value).toBe(7 * DAY_MS);
	});
});

// ── Never-suppression ──────────────────────────────────────────────

describe("sticky last-pick — Never suppresses the write (CONTEXT.md decision)", () => {
	test("POST reapprove with ttlOverrideMs: null does NOT write the lastTtl key", async () => {
		// CONTEXT.md locked decision: "Never is NOT sticky — when a user
		// picks Never, the last-pick record is *not* updated — next
		// time the same kind expires, the default returns to the
		// previous sticky value (or 30d first-use fallback). Never is
		// an explicit escape hatch, not a habit."
		const res = await expectThrownOrResponse(() =>
			reapprovePOST(
				makePostEvent({
					capability: "shell",
					scope: "conversation",
					ttlOverrideMs: null,
				}) as never,
			),
		);
		expect(res.status).toBe(200);

		const writes = settingCalls.filter(
			(c) =>
				c.op === "upsert" &&
				c.key === `user:${HELLO_USER}:reapprove:lastTtl:shell`,
		);
		expect(writes).toHaveLength(0);
	});
});

// ── Chat-side surface parity (cross-plan contract) ─────────────────
//
// The chat-side `handleToolPermission` (in `src/routes/tool-permission.ts`)
// implements the same sticky-pick write contract. Plan 56-03 will land
// the write here too; today it does nothing — this case is RED until
// then.
//
// Importing the handler is from `src/routes/...` not `web/src/...`, so
// we use the `$server` alias which `vitest.config.ts` maps to `../src`.

describe("sticky last-pick — chat-side handleToolPermission writes the same key shape", () => {
	test("approved request with ttlOverrideMs: 30d writes user:<id>:reapprove:lastTtl:<kind> = 30d", async () => {
		// `handleToolPermission`'s exact module path is
		// `$server/routes/tool-permission` per `vitest.config.ts:30`.
		// Plan 56-02 widens the body schema with ttlOverrideMs (covered
		// by `src/__tests__/tool-permission-handler.test.ts`); Plan
		// 56-03 will additionally wire the sticky write here.

		// Note: the handler does NOT receive a `capabilityKind` directly
		// — it derives the kind from the resolved tool call. For RED
		// purposes we assert ANY write to the lastTtl key namespace
		// occurs, leaving the per-kind suffix to Plan 56-03's
		// implementation choice. The contract: SOME `upsertSetting`
		// call on the `user:<id>:reapprove:lastTtl:` prefix with value
		// = 30d MUST happen.

		// Stub `$server/db/queries/conversations.getConversation` so the
		// chat-side handler's ownership check passes.
		vi.doMock("$server/db/queries/conversations", () => ({
			getConversation: async () => ({ id: "conv-1", userId: HELLO_USER }),
		}));

		// Stub `$server/runtime/tools/permissions` so resolvePermission
		// is a no-op and getPendingApprovalConversation returns the
		// test conversation. Phase 56-03 wiring also queries
		// `getPendingExtensionGate(toolCallId)` to derive the sticky-
		// write's per-kind suffix; mock that to return a `shell` gate so
		// the contract's "ANY upsert on the lastTtl:<kind> prefix"
		// assertion lands on `user:<id>:reapprove:lastTtl:shell`.
		vi.doMock("$server/runtime/tools/permissions", () => ({
			resolvePermission: () => {},
			getPendingApprovalConversation: () => "conv-1",
			getPendingExtensionGate: () => ({
				extensionId: "ext-1",
				userId: HELLO_USER,
				capabilityKind: "shell" as const,
				resolveDetailed: () => {},
			}),
		}));

		const { handleToolPermission } = await import(
			"$server/routes/tool-permission"
		);

		const req = new Request("http://localhost/api/tool-calls/tc-1/permission", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				approved: true,
				scope: "conversation",
				ttlOverrideMs: 30 * DAY_MS,
			}),
		});

		const res = await handleToolPermission(req, "tc-1", {
			id: HELLO_USER,
			email: "u@x",
			name: "u",
			role: "member",
		});
		expect(res.status).toBe(200);

		// Any upsert hitting the lastTtl key prefix with value 30d.
		const stickyWrites = settingCalls.filter(
			(c) =>
				c.op === "upsert" &&
				c.key.startsWith(`user:${HELLO_USER}:reapprove:lastTtl:`) &&
				c.value === 30 * DAY_MS,
		);
		expect(stickyWrites.length).toBeGreaterThanOrEqual(1);
	});
});
