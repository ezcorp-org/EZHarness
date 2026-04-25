/**
 * Server-handler unit tests for /api/account/+server.ts.
 *
 * Re-added after the vitest+Zod inline fix in vitest.config.ts —
 * this handler imports validationError from $lib/server/security/validation,
 * which uses Zod at module top-level.
 *
 * Covers GET 401, GET happy-path body shape, GET 404, PUT auth gate,
 * PUT validation, PUT email-change-requires-password branches,
 * and PUT name-change happy path with audit-log side-effect.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/users", () => ({
	getUserById: vi.fn(),
	updateUserName: vi.fn(),
	updateUserEmail: vi.fn(),
}));

vi.mock("$server/auth/password", () => ({
	verifyPassword: vi.fn(),
}));

vi.mock("$server/db/queries/audit-log", () => ({
	insertAuditEntry: vi.fn(async () => undefined),
}));

const { getUserById, updateUserName, updateUserEmail } = await import(
	"$server/db/queries/users"
);
const { verifyPassword } = await import("$server/auth/password");
const { insertAuditEntry } = await import("$server/db/queries/audit-log");
const { GET, PUT } = await import("../routes/api/account/+server");

function makeEvent(init: {
	href?: string;
	locals?: Record<string, unknown>;
	body?: unknown;
}) {
	return {
		url: new URL(init.href ?? "http://localhost/api/account"),
		locals: init.locals ?? {},
		request: new Request("http://localhost/api/account", {
			method: "POST",
			body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
		}),
	} as any;
}

async function expectThrownResponse(
	fn: () => Promise<Response> | Response,
	status: number,
): Promise<Response> {
	let res: Response | undefined;
	try {
		const out = await fn();
		res = out;
	} catch (thrown) {
		expect(thrown).toBeInstanceOf(Response);
		res = thrown as Response;
	}
	expect(res).toBeInstanceOf(Response);
	expect(res!.status).toBe(status);
	return res!;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };
const dbUser = {
	id: "u1",
	email: "u@x",
	name: "u",
	role: "user",
	passwordHash: "$argon2id$hash",
	createdAt: new Date("2024-01-01T00:00:00Z"),
};

describe("GET /api/account", () => {
	beforeEach(() => {
		vi.mocked(getUserById).mockReset();
	});

	test("rejects 401 when locals.user is missing", async () => {
		const res = await expectThrownResponse(
			() => GET(makeEvent({ locals: {} })),
			401,
		);
		const body = (await res.json()) as { error?: string };
		expect(typeof body.error).toBe("string");
	});

	test("happy path: returns user profile (no passwordHash leak)", async () => {
		vi.mocked(getUserById).mockResolvedValue(dbUser as any);
		const res = await GET(makeEvent({ locals: { user } }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toEqual({
			id: "u1",
			email: "u@x",
			name: "u",
			role: "user",
			createdAt: "2024-01-01T00:00:00.000Z",
		});
		// Critical: passwordHash must not be returned.
		expect(body.passwordHash).toBeUndefined();
		expect(vi.mocked(getUserById)).toHaveBeenCalledWith(user.id);
	});

	test("returns 404 when user row missing (deleted between auth and lookup)", async () => {
		vi.mocked(getUserById).mockResolvedValue(undefined as any);
		const res = await GET(makeEvent({ locals: { user } }));
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("User not found");
	});
});

describe("PUT /api/account", () => {
	beforeEach(() => {
		vi.mocked(getUserById).mockReset();
		vi.mocked(updateUserName).mockReset();
		vi.mocked(updateUserEmail).mockReset();
		vi.mocked(verifyPassword).mockReset();
		vi.mocked(insertAuditEntry).mockReset();
	});

	test("rejects 401 when locals.user is missing", async () => {
		const res = await expectThrownResponse(
			() => PUT(makeEvent({ locals: {}, body: { name: "X" } })),
			401,
		);
		const body = (await res.json()) as { error?: string };
		expect(typeof body.error).toBe("string");
	});

	test("returns 403 when API-key scope missing 'admin'", async () => {
		const res = await PUT(
			makeEvent({
				locals: { user, apiKeyScopes: ["read"] },
				body: { name: "X" },
			}),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string; required?: string };
		expect(body.error).toBe("Insufficient scope");
		expect(body.required).toBe("admin");
	});

	test("returns 400 when neither name nor email provided", async () => {
		const res = await PUT(
			makeEvent({
				locals: { user },
				body: {},
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Nothing to update");
	});

	test("email change without currentPassword returns 400", async () => {
		const res = await PUT(
			makeEvent({
				locals: { user },
				body: { email: "new@x.com" },
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Current password is required to change email");
	});

	test("email change with wrong currentPassword returns 400", async () => {
		vi.mocked(getUserById).mockResolvedValue(dbUser as any);
		vi.mocked(verifyPassword).mockResolvedValue(false);
		const res = await PUT(
			makeEvent({
				locals: { user },
				body: { email: "new@x.com", currentPassword: "wrong" },
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Current password is incorrect");
		expect(vi.mocked(updateUserEmail)).not.toHaveBeenCalled();
	});

	test("happy path: name change updates name + writes audit entry", async () => {
		vi.mocked(updateUserName).mockResolvedValue(true as any);
		// First call from email branch is skipped (no email); second is the
		// final getUserById before the response. Wire one return value.
		vi.mocked(getUserById).mockResolvedValue({
			...dbUser,
			name: "NewName",
		} as any);

		const res = await PUT(
			makeEvent({
				locals: { user },
				body: { name: "NewName" },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { name: string };
		expect(body.name).toBe("NewName");
		expect(vi.mocked(updateUserName)).toHaveBeenCalledWith(user.id, "NewName");
		expect(vi.mocked(insertAuditEntry)).toHaveBeenCalledWith(
			user.id,
			"auth:name_changed",
		);
		expect(vi.mocked(updateUserEmail)).not.toHaveBeenCalled();
	});

	test("happy path: email change verifies password, updates email, writes audit", async () => {
		// First call: pre-update lookup returns old email ("u@x"); second call
		// (post-update for response): returns new email.
		vi.mocked(getUserById)
			.mockResolvedValueOnce(dbUser as any)
			.mockResolvedValueOnce({ ...dbUser, email: "new@x.com" } as any);
		vi.mocked(verifyPassword).mockResolvedValue(true);
		vi.mocked(updateUserEmail).mockResolvedValue(true as any);

		const res = await PUT(
			makeEvent({
				locals: { user },
				body: { email: "new@x.com", currentPassword: "good" },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { email: string };
		expect(body.email).toBe("new@x.com");
		expect(vi.mocked(updateUserEmail)).toHaveBeenCalledWith(
			user.id,
			"new@x.com",
		);
		// Audit entry includes oldEmail/newEmail
		expect(vi.mocked(insertAuditEntry)).toHaveBeenCalledWith(
			user.id,
			"auth:email_changed",
			undefined,
			{ oldEmail: "u@x", newEmail: "new@x.com" },
		);
	});

	test("returns 404 when user row vanishes during email change", async () => {
		vi.mocked(getUserById).mockResolvedValue(undefined as any);
		const res = await PUT(
			makeEvent({
				locals: { user },
				body: { email: "new@x.com", currentPassword: "good" },
			}),
		);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("User not found");
	});
});
