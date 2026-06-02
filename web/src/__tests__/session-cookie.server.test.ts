/**
 * Direct unit tests for `web/src/lib/server/auth/session-cookie.ts`.
 *
 * The session-cookie helpers pin the cookie name, attributes, and the
 * env-derived lifetime config used by the auth login / refresh paths.
 * Before this file they were only covered transitively via hooks-server
 * tests, which never exercised the env-fallback ladder in `loadConfig`
 * (invalid / zero / negative env values) or the `FORCE_SECURE_COOKIES`
 * fork in `setSessionCookie`. This locks those branches at the unit
 * layer.
 *
 * Runs under the vitest leg (`.server.test.ts`) — `vi.resetModules()` +
 * dynamic import gives each env permutation a fresh module-level
 * `_config` cache, which the in-process singleton would otherwise pin to
 * the first call.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { Cookies } from "@sveltejs/kit";

const ENV_KEYS = [
	"EZCORP_SESSION_LIFETIME_DAYS",
	"EZCORP_SESSION_REFRESH_AFTER_DAYS",
	"EZCORP_SESSION_PREVIOUS_TOKEN_GRACE_SECONDS",
	"FORCE_SECURE_COOKIES",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const k of ENV_KEYS) saved[k] = process.env[k];
	for (const k of ENV_KEYS) delete process.env[k];
	vi.resetModules();
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

/** Minimal Cookies stub recording the last `set(name, value, opts)`. */
function makeCookies(): { cookies: Cookies; calls: Array<[string, string, Record<string, unknown>]> } {
	const calls: Array<[string, string, Record<string, unknown>]> = [];
	const cookies = {
		set: (name: string, value: string, opts: Record<string, unknown>) => {
			calls.push([name, value, opts]);
		},
	} as unknown as Cookies;
	return { cookies, calls };
}

async function load() {
	return await import("$lib/server/auth/session-cookie");
}

describe("getSessionConfig — env-fallback ladder", () => {
	test("defaults when no env set (90d / 7d / 60s)", async () => {
		const { getSessionConfig } = await load();
		const cfg = getSessionConfig();
		expect(cfg.lifetimeSeconds).toBe(90 * 24 * 3600);
		expect(cfg.refreshAfterSeconds).toBe(7 * 24 * 3600);
		expect(cfg.previousTokenGraceSeconds).toBe(60);
	});

	test("valid positive env overrides are honoured", async () => {
		process.env.EZCORP_SESSION_LIFETIME_DAYS = "30";
		process.env.EZCORP_SESSION_REFRESH_AFTER_DAYS = "3";
		process.env.EZCORP_SESSION_PREVIOUS_TOKEN_GRACE_SECONDS = "120";
		const { getSessionConfig } = await load();
		const cfg = getSessionConfig();
		expect(cfg.lifetimeSeconds).toBe(30 * 24 * 3600);
		expect(cfg.refreshAfterSeconds).toBe(3 * 24 * 3600);
		expect(cfg.previousTokenGraceSeconds).toBe(120);
	});

	test("non-numeric / zero / negative env values fall back to defaults", async () => {
		process.env.EZCORP_SESSION_LIFETIME_DAYS = "not-a-number";
		process.env.EZCORP_SESSION_REFRESH_AFTER_DAYS = "0";
		process.env.EZCORP_SESSION_PREVIOUS_TOKEN_GRACE_SECONDS = "-5";
		const { getSessionConfig } = await load();
		const cfg = getSessionConfig();
		expect(cfg.lifetimeSeconds).toBe(90 * 24 * 3600);
		expect(cfg.refreshAfterSeconds).toBe(7 * 24 * 3600);
		expect(cfg.previousTokenGraceSeconds).toBe(60);
	});

	test("config is memoized — second call returns the same object", async () => {
		const { getSessionConfig } = await load();
		expect(getSessionConfig()).toBe(getSessionConfig());
	});
});

describe("getSessionCookieName", () => {
	test("returns the stable cookie name", async () => {
		const { getSessionCookieName } = await load();
		expect(getSessionCookieName()).toBe("ezcorp_session");
	});
});

describe("setSessionCookie", () => {
	test("sets the standard attributes with config-derived maxAge", async () => {
		const { setSessionCookie, getSessionCookieName } = await load();
		const { cookies, calls } = makeCookies();
		setSessionCookie(cookies, "tok123");
		expect(calls).toHaveLength(1);
		const [name, value, opts] = calls[0]!;
		expect(name).toBe(getSessionCookieName());
		expect(value).toBe("tok123");
		expect(opts.path).toBe("/");
		expect(opts.httpOnly).toBe(true);
		expect(opts.sameSite).toBe("lax");
		expect(opts.maxAge).toBe(90 * 24 * 3600);
		expect(opts.secure).toBe(false);
	});

	test("explicit maxAgeSeconds overrides the config lifetime", async () => {
		const { setSessionCookie } = await load();
		const { cookies, calls } = makeCookies();
		setSessionCookie(cookies, "tok", { maxAgeSeconds: 42 });
		expect(calls[0]![2].maxAge).toBe(42);
	});

	test("FORCE_SECURE_COOKIES=true flips the secure flag", async () => {
		process.env.FORCE_SECURE_COOKIES = "true";
		const { setSessionCookie } = await load();
		const { cookies, calls } = makeCookies();
		setSessionCookie(cookies, "tok");
		expect(calls[0]![2].secure).toBe(true);
	});
});

describe("__overrideSessionConfig — test hook", () => {
	test("partial override merges over env-derived defaults", async () => {
		const { __overrideSessionConfig, getSessionConfig } = await load();
		__overrideSessionConfig({ lifetimeSeconds: 5 });
		const cfg = getSessionConfig();
		expect(cfg.lifetimeSeconds).toBe(5);
		// untouched fields keep their env-derived defaults
		expect(cfg.refreshAfterSeconds).toBe(7 * 24 * 3600);
	});

	test("null reverts to env-derived defaults", async () => {
		const { __overrideSessionConfig, getSessionConfig } = await load();
		__overrideSessionConfig({ lifetimeSeconds: 5 });
		__overrideSessionConfig(null);
		expect(getSessionConfig().lifetimeSeconds).toBe(90 * 24 * 3600);
	});
});

describe("clearSessionCookie", () => {
	test("writes an empty value with maxAge 0 to expire the cookie", async () => {
		const { clearSessionCookie, getSessionCookieName } = await load();
		const { cookies, calls } = makeCookies();
		clearSessionCookie(cookies);
		const [name, value, opts] = calls[0]!;
		expect(name).toBe(getSessionCookieName());
		expect(value).toBe("");
		expect(opts.maxAge).toBe(0);
		expect(opts.httpOnly).toBe(true);
	});
});
