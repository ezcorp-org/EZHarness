/**
 * Vitest server-handler tests for PATCH /api/memories/[id]/+server.ts.
 *
 * v1.4 — Memory injection-eligibility admin UI. Coverage targets each
 * branch of the handler:
 *   - 403 (API-key scope missing 'read')
 *   - 401 (unauthenticated cookie + no api key)
 *   - 404 (memory id not found)
 *   - 404 (cross-user access — sec-H3 collapse, no enumeration leak)
 *   - 400 (malformed body / unknown keys / wrong type)
 *   - 200 idempotent same-value (no audit row, no DB write)
 *   - 200 actual flip (DB write + audit row with full metadata)
 *   - 200 reverse direction flip (audit row carries the right
 *     old/new values; the audit-action key matches the enum)
 *
 * Mock pattern mirrors `api-lessons-id.server.test.ts` — the query
 * module + audit-log helper + audit-actions enum are stubbed at module
 * scope, then the handler is dynamically imported. Each test resets
 * the mocks via `beforeEach` so call-count assertions are
 * deterministic.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

const mockGetMemoryById = vi.fn();
const mockUpdateInjectionEligibility = vi.fn();
const mockGetMemoryProjectIds = vi.fn();
// Other query exports the route imports — provide stubs so the
// `vi.mock` factory replaces the whole module without breaking
// unrelated handlers (GET/PUT/DELETE) that share the file.
const mockUpdateMemory = vi.fn();
const mockUpdateMemoryStatus = vi.fn();
const mockDeleteMemory = vi.fn();
const mockSetMemoryProjects = vi.fn();
vi.mock("$server/db/queries/memories", () => ({
	getMemoryById: mockGetMemoryById,
	updateMemory: mockUpdateMemory,
	updateMemoryStatus: mockUpdateMemoryStatus,
	deleteMemory: mockDeleteMemory,
	getMemoryProjectIds: mockGetMemoryProjectIds,
	setMemoryProjects: mockSetMemoryProjects,
	updateMemoryInjectionEligibility: mockUpdateInjectionEligibility,
}));

const mockInsertAuditEntry = vi.fn();
vi.mock("$server/db/queries/audit-log", () => ({
	insertAuditEntry: mockInsertAuditEntry,
}));

const { PATCH } = await import("../routes/api/memories/[id]/+server");
const { EXT_AUDIT_ACTIONS } = await import("$server/extensions/audit-actions");

function makePatchEvent(opts: {
	id?: string;
	locals?: Record<string, unknown>;
	body?: unknown;
	rawBody?: string;
}) {
	const id = opts.id ?? "mem-1";
	const init: RequestInit = { method: "PATCH" };
	if (opts.rawBody !== undefined) {
		init.body = opts.rawBody;
		init.headers = { "Content-Type": "application/json" };
	} else if (opts.body !== undefined) {
		init.body = JSON.stringify(opts.body);
		init.headers = { "Content-Type": "application/json" };
	}
	return {
		url: new URL(`http://localhost/api/memories/${id}`),
		locals: opts.locals ?? {},
		params: { id },
		request: new Request(`http://localhost/api/memories/${id}`, init),
	} as any;
}

async function expectThrownResponse(
	fn: () => Promise<Response> | Response,
	status: number,
): Promise<Response> {
	let res: Response | undefined;
	try {
		res = await fn();
	} catch (thrown) {
		expect(thrown).toBeInstanceOf(Response);
		res = thrown as Response;
	}
	expect(res!.status).toBe(status);
	return res!;
}

const USER = { id: "u1", email: "u@x", name: "u", role: "user" };
const ADMIN = { id: "admin-1", email: "a@x", name: "a", role: "admin" };

function makeMemory(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		id: "mem-1",
		content: "user prefers dark mode",
		category: "preferences",
		confidence: "high",
		status: "active",
		projectId: null,
		conversationId: null,
		messageIds: null,
		provenance: null,
		lastAccessedAt: new Date("2026-05-01T00:00:00.000Z"),
		injectionEligible: true,
		userId: "u1",
		createdAt: new Date("2026-04-01T00:00:00.000Z"),
		updatedAt: new Date("2026-04-15T00:00:00.000Z"),
		...overrides,
	};
}

beforeEach(() => {
	mockGetMemoryById.mockReset();
	mockUpdateInjectionEligibility.mockReset();
	mockGetMemoryProjectIds.mockReset();
	mockUpdateMemory.mockReset();
	mockUpdateMemoryStatus.mockReset();
	mockDeleteMemory.mockReset();
	mockSetMemoryProjects.mockReset();
	mockInsertAuditEntry.mockReset();
});

describe("PATCH /api/memories/[id] — auth gates", () => {
	test("returns 403 when API-key scope missing 'read'", async () => {
		const res = await PATCH(
			makePatchEvent({
				locals: { user: USER, apiKeyScopes: ["chat"] },
				body: { injectionEligible: false },
			}),
		);
		expect(res.status).toBe(403);
		expect(mockGetMemoryById).not.toHaveBeenCalled();
		expect(mockUpdateInjectionEligibility).not.toHaveBeenCalled();
		expect(mockInsertAuditEntry).not.toHaveBeenCalled();
	});

	test("throws 401 when unauthenticated", async () => {
		await expectThrownResponse(
			() =>
				PATCH(
					makePatchEvent({
						locals: {},
						body: { injectionEligible: false },
					}),
				),
			401,
		);
		expect(mockGetMemoryById).not.toHaveBeenCalled();
		expect(mockUpdateInjectionEligibility).not.toHaveBeenCalled();
		expect(mockInsertAuditEntry).not.toHaveBeenCalled();
	});
});

describe("PATCH /api/memories/[id] — ownership gates", () => {
	test("returns 404 when memory id does not exist", async () => {
		mockGetMemoryById.mockResolvedValue(undefined);
		const res = await PATCH(
			makePatchEvent({
				locals: { user: USER },
				body: { injectionEligible: false },
			}),
		);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Memory not found");
		expect(mockUpdateInjectionEligibility).not.toHaveBeenCalled();
		expect(mockInsertAuditEntry).not.toHaveBeenCalled();
	});

	test("returns 404 when memory is owned by a different user (no enumeration leak)", async () => {
		// Headline cross-project / cross-user gate: the row exists but
		// belongs to someone else. The handler MUST collapse this to a
		// 404 with the SAME body as the not-found case so an attacker
		// can't probe for valid ids.
		mockGetMemoryById.mockResolvedValue(makeMemory({ userId: "u-other" }));
		const res = await PATCH(
			makePatchEvent({
				locals: { user: USER },
				body: { injectionEligible: false },
			}),
		);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Memory not found");
		expect(mockUpdateInjectionEligibility).not.toHaveBeenCalled();
		expect(mockInsertAuditEntry).not.toHaveBeenCalled();
	});

	test("admin users CAN flip another user's memory (admin override)", async () => {
		mockGetMemoryById.mockResolvedValue(
			makeMemory({ userId: "u-other", injectionEligible: true }),
		);
		mockUpdateInjectionEligibility.mockResolvedValue(
			makeMemory({ userId: "u-other", injectionEligible: false }),
		);
		mockGetMemoryProjectIds.mockResolvedValue([]);
		const res = await PATCH(
			makePatchEvent({
				locals: { user: ADMIN },
				body: { injectionEligible: false },
			}),
		);
		expect(res.status).toBe(200);
		expect(mockUpdateInjectionEligibility).toHaveBeenCalledWith("mem-1", false);
		// Audit row carries the admin's id as actor — NOT the row owner.
		expect(mockInsertAuditEntry).toHaveBeenCalledTimes(1);
		const [actorArg, , , metaArg] = mockInsertAuditEntry.mock.calls[0]!;
		expect(actorArg).toBe(ADMIN.id);
		expect((metaArg as Record<string, unknown>).actor).toBe(ADMIN.id);
	});

	test("returns 404 for unowned (userId === null) rows when caller is not admin", async () => {
		// sec-H3 fail-closed: rows whose userId is null can only be
		// touched by admins. The 404 keeps the message identical for
		// non-admin callers.
		mockGetMemoryById.mockResolvedValue(makeMemory({ userId: null }));
		const res = await PATCH(
			makePatchEvent({
				locals: { user: USER },
				body: { injectionEligible: false },
			}),
		);
		expect(res.status).toBe(404);
		expect(mockUpdateInjectionEligibility).not.toHaveBeenCalled();
		expect(mockInsertAuditEntry).not.toHaveBeenCalled();
	});
});

describe("PATCH /api/memories/[id] — body validation", () => {
	test("returns 400 when body is missing the field", async () => {
		mockGetMemoryById.mockResolvedValue(makeMemory());
		const res = await PATCH(
			makePatchEvent({ locals: { user: USER }, body: {} }),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Invalid request body");
		expect(mockUpdateInjectionEligibility).not.toHaveBeenCalled();
		expect(mockInsertAuditEntry).not.toHaveBeenCalled();
	});

	test("returns 400 when injectionEligible is not a boolean", async () => {
		mockGetMemoryById.mockResolvedValue(makeMemory());
		const res = await PATCH(
			makePatchEvent({
				locals: { user: USER },
				body: { injectionEligible: "false" }, // string, not boolean
			}),
		);
		expect(res.status).toBe(400);
		expect(mockUpdateInjectionEligibility).not.toHaveBeenCalled();
		expect(mockInsertAuditEntry).not.toHaveBeenCalled();
	});

	test("returns 400 on unknown keys (strict schema)", async () => {
		// Defense in depth: a typo'd or malicious extra field would
		// otherwise silently no-op. Strict schema rejects up-front so
		// the contract stays honest.
		mockGetMemoryById.mockResolvedValue(makeMemory());
		const res = await PATCH(
			makePatchEvent({
				locals: { user: USER },
				body: { injectionEligible: false, content: "sneaky overwrite" },
			}),
		);
		expect(res.status).toBe(400);
		expect(mockUpdateInjectionEligibility).not.toHaveBeenCalled();
		expect(mockInsertAuditEntry).not.toHaveBeenCalled();
	});

	test("returns 400 on malformed JSON body", async () => {
		mockGetMemoryById.mockResolvedValue(makeMemory());
		const res = await PATCH(
			makePatchEvent({
				locals: { user: USER },
				rawBody: "not-json{",
			}),
		);
		expect(res.status).toBe(400);
		expect(mockUpdateInjectionEligibility).not.toHaveBeenCalled();
		expect(mockInsertAuditEntry).not.toHaveBeenCalled();
	});
});

describe("PATCH /api/memories/[id] — idempotent same-value", () => {
	test("returns 200 with the unchanged row when value already matches (no DB write, no audit)", async () => {
		mockGetMemoryById.mockResolvedValue(makeMemory({ injectionEligible: true }));
		mockGetMemoryProjectIds.mockResolvedValue(["proj-a"]);
		const res = await PATCH(
			makePatchEvent({
				locals: { user: USER },
				body: { injectionEligible: true }, // same as current
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string; injectionEligible: boolean; projectIds: string[] };
		expect(body.id).toBe("mem-1");
		expect(body.injectionEligible).toBe(true);
		expect(body.projectIds).toEqual(["proj-a"]);
		// Critical: idempotent path must NOT touch the DB or write an
		// audit row. Privacy-relevant audits only fire on real flips.
		expect(mockUpdateInjectionEligibility).not.toHaveBeenCalled();
		expect(mockInsertAuditEntry).not.toHaveBeenCalled();
	});

	test("idempotent path returns the existing row body, not a fabricated one", async () => {
		const existing = makeMemory({
			injectionEligible: false,
			content: "biographical detail",
			category: "biographical",
		});
		mockGetMemoryById.mockResolvedValue(existing);
		mockGetMemoryProjectIds.mockResolvedValue([]);
		const res = await PATCH(
			makePatchEvent({
				locals: { user: USER },
				body: { injectionEligible: false }, // same as current
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.content).toBe("biographical detail");
		expect(body.category).toBe("biographical");
		expect(body.injectionEligible).toBe(false);
	});
});

describe("PATCH /api/memories/[id] — successful flip", () => {
	test("flipping true -> false writes audit row with the right shape", async () => {
		mockGetMemoryById.mockResolvedValue(makeMemory({ injectionEligible: true }));
		mockUpdateInjectionEligibility.mockResolvedValue(
			makeMemory({ injectionEligible: false }),
		);
		mockGetMemoryProjectIds.mockResolvedValue(["proj-a", "proj-b"]);
		const res = await PATCH(
			makePatchEvent({
				locals: { user: USER },
				body: { injectionEligible: false },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string; injectionEligible: boolean };
		expect(body.id).toBe("mem-1");
		expect(body.injectionEligible).toBe(false);
		expect(mockUpdateInjectionEligibility).toHaveBeenCalledWith("mem-1", false);
		expect(mockInsertAuditEntry).toHaveBeenCalledTimes(1);
		const [actor, action, target, meta] = mockInsertAuditEntry.mock.calls[0]!;
		expect(actor).toBe("u1");
		expect(action).toBe(EXT_AUDIT_ACTIONS.MEMORY_INJECTION_ELIGIBILITY_CHANGED);
		expect(target).toBe("mem-1");
		expect(meta).toMatchObject({
			memoryId: "mem-1",
			oldValue: true,
			newValue: false,
			actor: "u1",
			projectIds: ["proj-a", "proj-b"],
		});
		// v1.4 — `projectIds` is the privacy-relevant fan-out field that
		// downstream governance dashboards filter audits by. `toMatchObject`
		// above only checks containment; this `toEqual` pins the exact
		// array shape (string[]) so a future refactor that swaps the
		// helper for one that returns `[{id: "..."}]` or stringifies the
		// array breaks here loudly.
		const meta_ = meta as Record<string, unknown>;
		expect(Array.isArray(meta_.projectIds)).toBe(true);
		expect(meta_.projectIds).toEqual(["proj-a", "proj-b"]);
	});

	test("flipping false -> true writes audit row with reversed old/new (re-include)", async () => {
		mockGetMemoryById.mockResolvedValue(makeMemory({ injectionEligible: false }));
		mockUpdateInjectionEligibility.mockResolvedValue(
			makeMemory({ injectionEligible: true }),
		);
		mockGetMemoryProjectIds.mockResolvedValue(["proj-c"]);
		const res = await PATCH(
			makePatchEvent({
				locals: { user: USER },
				body: { injectionEligible: true },
			}),
		);
		expect(res.status).toBe(200);
		const [, action, , meta] = mockInsertAuditEntry.mock.calls[0]!;
		expect(action).toBe(EXT_AUDIT_ACTIONS.MEMORY_INJECTION_ELIGIBILITY_CHANGED);
		expect(meta).toMatchObject({
			memoryId: "mem-1",
			oldValue: false,
			newValue: true,
			projectIds: ["proj-c"],
		});
	});

	test("audit-action wire string matches the enum value (regression guard)", async () => {
		// If a future refactor ever renames the audit-action key the
		// wire-string contract must stay stable — every persisted row
		// + every governance dashboard query keys on it. This test
		// pins the literal so a value change breaks here loudly.
		expect(EXT_AUDIT_ACTIONS.MEMORY_INJECTION_ELIGIBILITY_CHANGED).toBe(
			"ext:memory.injection-eligibility.changed",
		);
	});

	test("response shape includes projectIds (full row, no second round-trip)", async () => {
		mockGetMemoryById.mockResolvedValue(makeMemory({ injectionEligible: true }));
		mockUpdateInjectionEligibility.mockResolvedValue(
			makeMemory({ injectionEligible: false }),
		);
		mockGetMemoryProjectIds.mockResolvedValue(["proj-a", "proj-b"]);
		const res = await PATCH(
			makePatchEvent({
				locals: { user: USER },
				body: { injectionEligible: false },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { projectIds: string[] };
		expect(body.projectIds).toEqual(["proj-a", "proj-b"]);
	});

	test("returns 404 when the row vanishes between read and write (race)", async () => {
		// Defensive branch: if a concurrent DELETE wipes the row
		// between the ownership read and the update, the helper
		// returns undefined. Handler must surface 404 instead of
		// silently 200ing.
		mockGetMemoryById.mockResolvedValue(makeMemory({ injectionEligible: true }));
		mockUpdateInjectionEligibility.mockResolvedValue(undefined);
		const res = await PATCH(
			makePatchEvent({
				locals: { user: USER },
				body: { injectionEligible: false },
			}),
		);
		expect(res.status).toBe(404);
		// Audit was not written: the flip never happened.
		expect(mockInsertAuditEntry).not.toHaveBeenCalled();
	});
});
