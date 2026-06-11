/**
 * Unit tests for requireAdmin (locked decision 1) — all four branches:
 * admin user returned; null for member role / non-ok response / fetch
 * throw / empty body.
 */
import { describe, test, expect, vi, afterEach } from "vitest";
import { requireAdmin, type CurrentUser } from "./admin-guard";

const admin: CurrentUser = { id: "u1", email: "boss@corp.io", name: "Boss", role: "admin" };
const member: CurrentUser = { id: "u2", email: "pleb@corp.io", name: "Pleb", role: "member" };

afterEach(() => vi.unstubAllGlobals());

describe("requireAdmin", () => {
	test("returns the user when they are an admin", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => Response.json({ user: admin })));
		await expect(requireAdmin()).resolves.toEqual(admin);
		expect(fetch).toHaveBeenCalledWith("/api/auth/me");
	});

	test("returns null for a member user", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => Response.json({ user: member })));
		await expect(requireAdmin()).resolves.toBeNull();
	});

	test("returns null on a non-ok response", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => Response.json({ user: admin }, { status: 401 })));
		await expect(requireAdmin()).resolves.toBeNull();
	});

	test("returns null when fetch throws", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => {
			throw new Error("network down");
		}));
		await expect(requireAdmin()).resolves.toBeNull();
	});

	test("returns null on an empty / userless body", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
		await expect(requireAdmin()).resolves.toBeNull();

		// Truly empty body — res.json() rejects, caught by the guard.
		vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));
		await expect(requireAdmin()).resolves.toBeNull();
	});
});
