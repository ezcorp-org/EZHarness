/**
 * Unit tests for /(auth)/onboarding/+page.server.ts load().
 *
 * Covers:
 *   - Unauthenticated → throws redirect(302, "/login") (defensive)
 *   - Authenticated, locals.onboardedAt=null → returns { user, hasProvider }
 *   - Authenticated, locals.onboardedAt set → throws redirect(302, "/")
 *   - hasProvider mirrors hasAnyProvider() output
 *   - load reads locals.onboardedAt (stashed by hooks) — does NOT
 *     re-query getUserById, locking the no-duplicate-DB-call contract
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/users", () => ({
	getUserById: vi.fn(),
}));
vi.mock("$server/db/queries/quickstart", () => ({
	hasAnyProvider: vi.fn(),
}));

const { getUserById } = await import("$server/db/queries/users");
const { hasAnyProvider } = await import("$server/db/queries/quickstart");
const { load } = await import("../routes/(auth)/onboarding/+page.server");

function isRedirect(err: unknown): err is { status: number; location: string } {
	return (
		typeof err === "object" &&
		err !== null &&
		typeof (err as any).status === "number" &&
		typeof (err as any).location === "string"
	);
}

function makeEvent(locals: Record<string, unknown> = {}) {
	return {
		url: new URL("http://localhost/onboarding"),
		locals,
		cookies: { get: () => undefined, set: () => undefined, delete: () => undefined },
		request: new Request("http://localhost/onboarding"),
		params: {},
		route: { id: "/(auth)/onboarding" },
		fetch: vi.fn(),
		setHeaders: vi.fn(),
		isDataRequest: false,
		isSubRequest: false,
	} as any;
}

describe("/(auth)/onboarding/+page.server load()", () => {
	beforeEach(() => {
		vi.mocked(getUserById).mockReset();
		vi.mocked(hasAnyProvider).mockReset();
	});

	test("unauthenticated → 302 /login (defensive branch)", async () => {
		const event = makeEvent({});

		let thrown: unknown;
		try {
			await load(event);
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeDefined();
		if (!isRedirect(thrown)) throw thrown;
		expect(thrown.status).toBe(302);
		expect(thrown.location).toBe("/login");
		expect(vi.mocked(getUserById)).not.toHaveBeenCalled();
		expect(vi.mocked(hasAnyProvider)).not.toHaveBeenCalled();
	});

	test("authenticated, locals.onboardedAt=null → returns { user, hasProvider:false }", async () => {
		vi.mocked(hasAnyProvider).mockResolvedValue(false);

		const event = makeEvent({
			user: { id: "u-1", email: "u@test.com", name: "U", role: "member" },
			onboardedAt: null,
		});
		const data = (await load(event)) as { user: unknown; hasProvider: boolean };
		expect(data).toEqual({
			user: { id: "u-1", name: "U", email: "u@test.com" },
			hasProvider: false,
		});
		// Critical: load must NOT re-query the user row — the hook stashed it on locals.
		expect(vi.mocked(getUserById)).not.toHaveBeenCalled();
	});

	test("authenticated, locals.onboardedAt=null, provider exists → hasProvider=true", async () => {
		vi.mocked(hasAnyProvider).mockResolvedValue(true);
		const event = makeEvent({
			user: { id: "u-2", email: "u2@test.com", name: "U2", role: "member" },
			onboardedAt: null,
		});
		const data = (await load(event)) as { user: unknown; hasProvider: boolean };
		expect(data.hasProvider).toBe(true);
	});

	test("authenticated, locals.onboardedAt set → 302 /", async () => {
		const event = makeEvent({
			user: { id: "u-3", email: "u3@test.com", name: "U3", role: "member" },
			onboardedAt: new Date(),
		});

		let thrown: unknown;
		try {
			await load(event);
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeDefined();
		if (!isRedirect(thrown)) throw thrown;
		expect(thrown.status).toBe(302);
		expect(thrown.location).toBe("/");
		// hasAnyProvider must NOT be called when we redirect — wasted work otherwise.
		expect(vi.mocked(hasAnyProvider)).not.toHaveBeenCalled();
		expect(vi.mocked(getUserById)).not.toHaveBeenCalled();
	});
});
