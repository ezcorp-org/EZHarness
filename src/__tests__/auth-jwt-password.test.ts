/**
 * Unit tests for src/auth/jwt.ts (signJWT / verifyJWT) and src/auth/password.ts.
 *
 * Pure crypto, no DB. The getJwtSecret() path that hits settings is
 * exercised separately via security/c1b-jwtsecret-encryption.test.ts.
 */

import { test, expect, describe } from "bun:test";
import { signJWT, verifyJWT } from "../auth/jwt";
import { hashPassword, verifyPassword } from "../auth/password";
import type { AuthUser } from "../auth/types";

const SECRET = "test-secret-please-do-not-use-in-prod-aaaaaaaa";

const SAMPLE_USER: AuthUser = {
	id: "u-1",
	email: "u@test.com",
	name: "Tester",
	role: "member",
};

describe("signJWT / verifyJWT round-trip", () => {
	test("verify recovers the same payload signJWT signed", async () => {
		const token = await signJWT(SAMPLE_USER, SECRET);
		const decoded = await verifyJWT(token, SECRET);
		expect(decoded).not.toBeNull();
		expect(decoded!.id).toBe(SAMPLE_USER.id);
		expect(decoded!.email).toBe(SAMPLE_USER.email);
		expect(decoded!.name).toBe(SAMPLE_USER.name);
		expect(decoded!.role).toBe(SAMPLE_USER.role);
		expect(typeof decoded!.iat).toBe("number");
		expect(typeof decoded!.exp).toBe("number");
		expect(decoded!.exp).toBeGreaterThan(decoded!.iat);
	});

	test("verify with the wrong secret returns null", async () => {
		const token = await signJWT(SAMPLE_USER, SECRET);
		expect(await verifyJWT(token, SECRET + "wrong")).toBeNull();
	});

	test("verify with a tampered payload returns null", async () => {
		const token = await signJWT(SAMPLE_USER, SECRET);
		const parts = token.split(".");
		const tampered = `${parts[0]}.${parts[1]}aaa.${parts[2]}`;
		expect(await verifyJWT(tampered, SECRET)).toBeNull();
	});

	test("verify with a tampered signature returns null", async () => {
		const token = await signJWT(SAMPLE_USER, SECRET);
		const parts = token.split(".");
		const tampered = `${parts[0]}.${parts[1]}.${parts[2]}aaa`;
		expect(await verifyJWT(tampered, SECRET)).toBeNull();
	});

	test("verify rejects malformed tokens", async () => {
		expect(await verifyJWT("not-a-token", SECRET)).toBeNull();
		expect(await verifyJWT("", SECRET)).toBeNull();
		expect(await verifyJWT("only.two.dots.toomany", SECRET)).toBeNull();
		expect(await verifyJWT("only.two", SECRET)).toBeNull();
	});

	test("verify rejects expired tokens", async () => {
		// Sign with -1s expiry so it's already expired by the time we verify.
		const token = await signJWT(SAMPLE_USER, SECRET, -1);
		expect(await verifyJWT(token, SECRET)).toBeNull();
	});

	test("custom expiry sets exp accordingly", async () => {
		const token = await signJWT(SAMPLE_USER, SECRET, 60);
		const decoded = await verifyJWT(token, SECRET);
		expect(decoded).not.toBeNull();
		// exp - iat should equal the requested expiry window (60s).
		expect(decoded!.exp - decoded!.iat).toBe(60);
	});

	test("two same-second signs produce different tokens (jti collision avoidance)", async () => {
		// Regression guard: before the jti claim, signJWT(SAMPLE_USER, SECRET)
		// twice within the same second produced byte-identical tokens
		// (same iat, same payload), and the sessions.token_hash UNIQUE
		// constraint then rejected the second insert. With jti present,
		// each call must produce a distinct token.
		const t1 = await signJWT(SAMPLE_USER, SECRET);
		const t2 = await signJWT(SAMPLE_USER, SECRET);
		expect(t1).not.toBe(t2);
		const d1 = await verifyJWT(t1, SECRET);
		const d2 = await verifyJWT(t2, SECRET);
		expect(d1?.jti).toBeString();
		expect(d2?.jti).toBeString();
		expect(d1?.jti).not.toBe(d2?.jti);
	});
});

describe("hashPassword / verifyPassword round-trip", () => {
	test("verify returns true for the original password", async () => {
		const hash = await hashPassword("CorrectHorse-Battery-Staple-1");
		expect(await verifyPassword("CorrectHorse-Battery-Staple-1", hash)).toBe(true);
	});

	test("verify returns false for a different password", async () => {
		const hash = await hashPassword("CorrectHorse-Battery-Staple-1");
		expect(await verifyPassword("wrong-password", hash)).toBe(false);
	});

	test("hashing the same password twice produces different hashes (salting)", async () => {
		const a = await hashPassword("repeat");
		const b = await hashPassword("repeat");
		expect(a).not.toBe(b);
		// Both still verify against the original.
		expect(await verifyPassword("repeat", a)).toBe(true);
		expect(await verifyPassword("repeat", b)).toBe(true);
	});

	test("verify against a corrupted hash returns false (or throws — both acceptable)", async () => {
		const hash = await hashPassword("anything");
		const tampered = hash.slice(0, -3) + "xxx";
		const result = await verifyPassword("anything", tampered).catch(() => false);
		expect(result).toBe(false);
	});

	test("hashing an empty string is rejected by Bun.password", async () => {
		// Documents Bun's contract: argon2id refuses an empty password.
		// Callers must validate non-empty before reaching this layer
		// (login/setup schemas already do, via Zod min(1)).
		expect(hashPassword("")).rejects.toThrow();
	});
});
