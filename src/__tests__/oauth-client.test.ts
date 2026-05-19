import { test, expect, describe, beforeEach, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// ── Mock api.ts OAuth functions ────────────────────────────────────────

const mockInitiateOAuth = mock(() =>
	Promise.resolve({
		url: "https://auth.openai.com/authorize?state=abc",
		state: "abc",
		codeVerifier: "verifier123",
		redirectUri: "http://localhost:1455/auth/callback",
	}),
);
const mockCompleteOAuth = mock(() => Promise.resolve());

mock.module("../../web/src/lib/api.js", () => ({
	initiateOAuth: mockInitiateOAuth,
	completeOAuth: mockCompleteOAuth,
}));

// ── Mock BroadcastChannel ──────────────────────────────────────────────

class MockBroadcastChannel {
	name: string;
	listeners = new Map<string, ((...args: unknown[]) => unknown)[]>();
	closed = false;
	lastMessage: unknown = null;

	constructor(name: string) {
		this.name = name;
	}
	addEventListener(event: string, fn: (...args: unknown[]) => unknown) {
		const list = this.listeners.get(event) ?? [];
		list.push(fn);
		this.listeners.set(event, list);
	}
	removeEventListener(event: string, fn: (...args: unknown[]) => unknown) {
		const list = this.listeners.get(event) ?? [];
		this.listeners.set(event, list.filter((f) => f !== fn));
	}
	postMessage(data: unknown) {
		this.lastMessage = data;
	}
	close() {
		this.closed = true;
	}
}

let lastBroadcastChannel: MockBroadcastChannel | null = null;
(globalThis as any).BroadcastChannel = class extends MockBroadcastChannel {
	constructor(name: string) {
		super(name);
		lastBroadcastChannel = this;
	}
};

// ── Import after mocks ─────────────────────────────────────────────────

const {
	startOAuthFlow,
	completeOAuthWithCode,
	listenForOAuthResult,
	isLoginCommand,
} = await import("../../web/src/lib/oauth.js");

// ── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
	mockInitiateOAuth.mockClear();
	mockCompleteOAuth.mockClear();
	lastBroadcastChannel = null;
});

// ── isLoginCommand ─────────────────────────────────────────────────────

describe("isLoginCommand", () => {
	test('"/login openai" returns { provider: "openai" }', () => {
		expect(isLoginCommand("/login openai")).toEqual({ provider: "openai" });
	});

	test('"/login google" returns { provider: "google" }', () => {
		expect(isLoginCommand("/login google")).toEqual({ provider: "google" });
	});

	test('"/login anthropic" returns { provider: "anthropic" }', () => {
		expect(isLoginCommand("/login anthropic")).toEqual({ provider: "anthropic" });
	});

	test('bare "/login" returns { provider: "" }', () => {
		expect(isLoginCommand("/login")).toEqual({ provider: "" });
		expect(isLoginCommand("/login ")).toEqual({ provider: "" });
	});

	test('"/login unknownprovider" still returns the provider', () => {
		const result = isLoginCommand("/login unknownprovider");
		expect(result).toEqual({ provider: "unknownprovider" });
	});

	test('"hello world" returns null', () => {
		expect(isLoginCommand("hello world")).toBeNull();
	});

	test('"/LOGIN openai" is case-insensitive', () => {
		expect(isLoginCommand("/LOGIN openai")).toEqual({ provider: "openai" });
		expect(isLoginCommand("/Login OPENAI")).toEqual({ provider: "openai" });
	});

	test("empty string returns null", () => {
		expect(isLoginCommand("")).toBeNull();
	});

	test("other slash commands return null", () => {
		expect(isLoginCommand("/help")).toBeNull();
		expect(isLoginCommand("/model gpt-4")).toBeNull();
	});
});

// ── startOAuthFlow ─────────────────────────────────────────────────────

describe("startOAuthFlow", () => {
	test("calls initiateOAuth and returns pending state", async () => {
		const result = await startOAuthFlow("openai");

		expect(mockInitiateOAuth).toHaveBeenCalledWith("openai");
		expect(result).toEqual({
			authUrl: "https://auth.openai.com/authorize?state=abc",
			codeVerifier: "verifier123",
			state: "abc",
			provider: "openai",
			redirectUri: "http://localhost:1455/auth/callback",
		});
	});

	test("propagates errors from initiateOAuth", async () => {
		mockInitiateOAuth.mockRejectedValueOnce(new Error("network error"));
		await expect(startOAuthFlow("openai")).rejects.toThrow("network error");
	});
});

// ── completeOAuthWithCode ──────────────────────────────────────────────

describe("completeOAuthWithCode", () => {
	const pending = {
		authUrl: "https://auth.openai.com/authorize?state=abc",
		codeVerifier: "verifier123",
		state: "abc",
		provider: "openai",
		redirectUri: "http://localhost:1455/auth/callback",
	};

	test("completes with a full callback URL", async () => {
		const result = await completeOAuthWithCode(
			pending,
			"http://localhost:1455/auth/callback?code=mycode&state=abc",
		);

		expect(result.success).toBe(true);
		expect(result.provider).toBe("openai");
		expect(mockCompleteOAuth).toHaveBeenCalledWith(
			"openai", "mycode", "verifier123",
			"http://localhost:1455/auth/callback", "abc",
		);
	});

	test("completes with a bare code string", async () => {
		const result = await completeOAuthWithCode(pending, "mybarecode");

		expect(result.success).toBe(true);
		expect(mockCompleteOAuth).toHaveBeenCalledWith(
			"openai", "mybarecode", "verifier123",
			"http://localhost:1455/auth/callback", "abc",
		);
	});

	test("completes with query string format (code=x&state=y)", async () => {
		const result = await completeOAuthWithCode(pending, "code=qscode&state=abc");

		expect(result.success).toBe(true);
		expect(mockCompleteOAuth).toHaveBeenCalledWith(
			"openai", "qscode", "verifier123",
			"http://localhost:1455/auth/callback", "abc",
		);
	});

	test("returns error when input is empty", async () => {
		const result = await completeOAuthWithCode(pending, "");

		expect(result.success).toBe(false);
		expect(result.error).toContain("Could not find authorization code");
	});

	test("returns error on state mismatch", async () => {
		const result = await completeOAuthWithCode(
			pending,
			"http://localhost:1455/auth/callback?code=mycode&state=WRONG",
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain("State mismatch");
	});

	test("returns error when completeOAuth throws", async () => {
		mockCompleteOAuth.mockRejectedValueOnce(new Error("token exchange failed"));
		const result = await completeOAuthWithCode(pending, "somecode");

		expect(result.success).toBe(false);
		expect(result.error).toBe("token exchange failed");
	});

	test("posts success via BroadcastChannel on success", async () => {
		await completeOAuthWithCode(pending, "mycode");

		expect(lastBroadcastChannel).not.toBeNull();
		expect(lastBroadcastChannel!.lastMessage).toEqual({
			type: "oauth-success",
			provider: "openai",
			error: undefined,
		});
		expect(lastBroadcastChannel!.closed).toBe(true);
	});
});

// ── listenForOAuthResult ───────────────────────────────────────────────

describe("listenForOAuthResult", () => {
	test("creates a BroadcastChannel and returns cleanup function", () => {
		const cb = mock(() => {});
		const cleanup = listenForOAuthResult(cb);

		expect(typeof cleanup).toBe("function");
		expect(lastBroadcastChannel).not.toBeNull();
		expect(lastBroadcastChannel!.name).toBe("ezcorp-oauth");
	});

	test("cleanup closes the channel", () => {
		const cb = mock(() => {});
		const cleanup = listenForOAuthResult(cb);

		expect(lastBroadcastChannel!.closed).toBe(false);
		cleanup();
		expect(lastBroadcastChannel!.closed).toBe(true);
	});

	test("dispatches oauth-success events to callback", () => {
		const cb = mock(() => {});
		listenForOAuthResult(cb);

		const listeners = lastBroadcastChannel!.listeners.get("message") ?? [];
		expect(listeners.length).toBe(1);

		// Simulate a message event
		listeners[0]!({ data: { type: "oauth-success", provider: "openai" } });
		expect(cb).toHaveBeenCalledWith({ provider: "openai", success: true });
	});

	test("dispatches oauth-error events to callback", () => {
		const cb = mock(() => {});
		listenForOAuthResult(cb);

		const listeners = lastBroadcastChannel!.listeners.get("message") ?? [];
		listeners[0]!({ data: { type: "oauth-error", provider: "google", error: "denied" } });
		expect(cb).toHaveBeenCalledWith({ provider: "google", success: false, error: "denied" });
	});

	test("ignores unknown message types", () => {
		const cb = mock(() => {});
		listenForOAuthResult(cb);

		const listeners = lastBroadcastChannel!.listeners.get("message") ?? [];
		listeners[0]!({ data: { type: "something-else" } });
		expect(cb).not.toHaveBeenCalled();
	});
});
