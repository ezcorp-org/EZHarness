import { test, expect, describe, mock, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// ── Mock setup ──────────────────────────────────────────────────────
// oauth.ts imports from "$lib/api.js" which is a SvelteKit alias.
// We must mock both the alias and the relative path that Bun may resolve.

const mockInitiateOAuth = mock(async (provider: string) => ({
	url: `https://auth.example.com/authorize?provider=${provider}`,
	state: "test-state-123",
	codeVerifier: "test-verifier-456",
	redirectUri: "http://localhost:1455/auth/callback",
}));

const mockCompleteOAuth = mock(async () => {});

const apiMock = () => ({
	initiateOAuth: mockInitiateOAuth,
	completeOAuth: mockCompleteOAuth,
});

mock.module("$lib/api.js", apiMock);
mock.module("$lib/api", apiMock);
mock.module("../../web/src/lib/api", apiMock);

// BroadcastChannel may not exist in the test environment
if (typeof globalThis.BroadcastChannel === "undefined") {
	(globalThis as any).BroadcastChannel = class {
		postMessage() {}
		close() {}
		addEventListener() {}
		removeEventListener() {}
	};
}

import {
	startOAuthFlow,
	completeOAuthWithCode,
	isLoginCommand,
	type OAuthPending,
} from "../../web/src/lib/oauth";

// ── Helpers ─────────────────────────────────────────────────────────

function makePending(overrides: Partial<OAuthPending> = {}): OAuthPending {
	return {
		authUrl: "https://auth.example.com/authorize?provider=openai",
		codeVerifier: "test-verifier-456",
		state: "test-state-123",
		provider: "openai",
		redirectUri: "http://localhost:1455/auth/callback",
		...overrides,
	};
}

// ── Tests ───────────────────────────────────────────────────────────

describe("startOAuthFlow", () => {
	beforeEach(() => {
		mockInitiateOAuth.mockClear();
		mockCompleteOAuth.mockClear();
	});

	test("returns correct OAuthPending shape", async () => {
		const result = await startOAuthFlow("openai");

		expect(result).toEqual({
			authUrl: "https://auth.example.com/authorize?provider=openai",
			codeVerifier: "test-verifier-456",
			state: "test-state-123",
			provider: "openai",
			redirectUri: "http://localhost:1455/auth/callback",
		});
		expect(mockInitiateOAuth).toHaveBeenCalledWith("openai");
	});

	test("passes provider through to initiateOAuth", async () => {
		const result = await startOAuthFlow("google");

		expect(result.provider).toBe("google");
		expect(result.authUrl).toContain("provider=google");
		expect(mockInitiateOAuth).toHaveBeenCalledWith("google");
	});

	test("propagates errors from initiateOAuth", async () => {
		mockInitiateOAuth.mockRejectedValueOnce(new Error("Network error"));

		expect(startOAuthFlow("openai")).rejects.toThrow("Network error");
	});
});

describe("completeOAuthWithCode", () => {
	beforeEach(() => {
		mockInitiateOAuth.mockClear();
		mockCompleteOAuth.mockClear();
		mockCompleteOAuth.mockResolvedValue(undefined);
	});

	test("succeeds with full callback URL", async () => {
		const pending = makePending();
		const input = "http://localhost:1455/auth/callback?code=abc123&state=test-state-123";
		const result = await completeOAuthWithCode(pending, input);

		expect(result).toEqual({ provider: "openai", success: true });
		expect(mockCompleteOAuth).toHaveBeenCalledWith(
			"openai",
			"abc123",
			"test-verifier-456",
			"http://localhost:1455/auth/callback",
			"test-state-123",
		);
	});

	test("succeeds with bare code input", async () => {
		const pending = makePending();
		const result = await completeOAuthWithCode(pending, "abc123");

		expect(result).toEqual({ provider: "openai", success: true });
		expect(mockCompleteOAuth).toHaveBeenCalledWith(
			"openai",
			"abc123",
			"test-verifier-456",
			"http://localhost:1455/auth/callback",
			"test-state-123",
		);
	});

	test("succeeds with query string format", async () => {
		const pending = makePending();
		const result = await completeOAuthWithCode(pending, "code=abc123&state=test-state-123");

		expect(result).toEqual({ provider: "openai", success: true });
		expect(mockCompleteOAuth).toHaveBeenCalledWith(
			"openai",
			"abc123",
			"test-verifier-456",
			"http://localhost:1455/auth/callback",
			"test-state-123",
		);
	});

	test("returns error for empty input", async () => {
		const pending = makePending();
		const result = await completeOAuthWithCode(pending, "");

		expect(result).toEqual({
			provider: "openai",
			success: false,
			error: "Could not find authorization code in input",
		});
		expect(mockCompleteOAuth).not.toHaveBeenCalled();
	});

	test("returns error for whitespace-only input", async () => {
		const pending = makePending();
		const result = await completeOAuthWithCode(pending, "   ");

		expect(result).toEqual({
			provider: "openai",
			success: false,
			error: "Could not find authorization code in input",
		});
	});

	test("returns error on state mismatch", async () => {
		const pending = makePending();
		const input = "http://localhost:1455/auth/callback?code=abc123&state=wrong-state";
		const result = await completeOAuthWithCode(pending, input);

		expect(result).toEqual({
			provider: "openai",
			success: false,
			error: "State mismatch -- possible CSRF attack",
		});
		expect(mockCompleteOAuth).not.toHaveBeenCalled();
	});

	test("returns error when completeOAuth throws", async () => {
		mockCompleteOAuth.mockRejectedValueOnce(new Error("Token exchange failed on server"));
		const pending = makePending();
		const result = await completeOAuthWithCode(pending, "abc123");

		expect(result).toEqual({
			provider: "openai",
			success: false,
			error: "Token exchange failed on server",
		});
	});

	test("returns generic error when completeOAuth throws non-Error", async () => {
		mockCompleteOAuth.mockRejectedValueOnce("raw string error");
		const pending = makePending();
		const result = await completeOAuthWithCode(pending, "abc123");

		expect(result).toEqual({
			provider: "openai",
			success: false,
			error: "Token exchange failed",
		});
	});

	test("accepts URL without state param and still succeeds", async () => {
		const pending = makePending();
		const input = "http://localhost:1455/auth/callback?code=only-code";
		const result = await completeOAuthWithCode(pending, input);

		expect(result).toEqual({ provider: "openai", success: true });
	});
});

describe("isLoginCommand", () => {
	test("/login openai returns { provider: 'openai' }", () => {
		expect(isLoginCommand("/login openai")).toEqual({ provider: "openai" });
	});

	test("/login google returns { provider: 'google' }", () => {
		expect(isLoginCommand("/login google")).toEqual({ provider: "google" });
	});

	test("/login anthropic returns { provider: 'anthropic' }", () => {
		expect(isLoginCommand("/login anthropic")).toEqual({ provider: "anthropic" });
	});

	test("/login with no args returns { provider: '' }", () => {
		expect(isLoginCommand("/login")).toEqual({ provider: "" });
		expect(isLoginCommand("/login ")).toEqual({ provider: "" });
	});

	test("/login unknown returns { provider: 'unknown' }", () => {
		expect(isLoginCommand("/login unknown")).toEqual({ provider: "unknown" });
	});

	test("not a login command returns null", () => {
		expect(isLoginCommand("not a login command")).toBeNull();
		expect(isLoginCommand("hello /login openai")).toBeNull();
		expect(isLoginCommand("")).toBeNull();
	});

	test("case insensitive matching", () => {
		expect(isLoginCommand("/Login OpenAI")).toEqual({ provider: "openai" });
		expect(isLoginCommand("/LOGIN GOOGLE")).toEqual({ provider: "google" });
		expect(isLoginCommand("/LOGIN Anthropic")).toEqual({ provider: "anthropic" });
	});

	test("trims whitespace", () => {
		expect(isLoginCommand("  /login openai  ")).toEqual({ provider: "openai" });
	});
});
