import { test, expect, describe, beforeEach, afterAll } from "bun:test";

import {
	fetchProviders,
	saveProviderKey,
	testProviderConnection,
	deleteProviderKey,
	initiateOAuth,
	completeOAuth,
	disconnectOAuth,
	sendMessage,
	exportConversation,
	type ProviderStatus,
} from "../../web/src/lib/api";

// ── Mock fetch ──────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof createMockFetch>;

function createMockFetch(status: number, body: unknown, statusText = "") {
	const fn = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			fn.calls.push({ input: String(input), init });
			return new Response(JSON.stringify(body), {
				status,
				statusText: statusText || (status === 200 ? "OK" : "Error"),
				headers: { "content-type": "application/json" },
			});
		},
		{ calls: [] as Array<{ input: string; init?: RequestInit }> },
	);
	return fn;
}

beforeEach(() => {
	mockFetch = createMockFetch(200, []);
	globalThis.fetch = mockFetch as any;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
});

// ── fetchProviders ──────────────────────────────────────────────────

describe("fetchProviders", () => {
	test("returns parsed array on 200", async () => {
		const providers: ProviderStatus[] = [
			{
				provider: "openai",
				hasKey: true,
				source: "byok",
				oauthConnected: false,
				oauthExpired: false,
				oauthSupported: true,
				expiresAt: null,
			},
		];
		globalThis.fetch = createMockFetch(200, providers) as any;

		const result = await fetchProviders();
		expect(result).toEqual(providers);
	});

	test("throws on non-ok response", async () => {
		globalThis.fetch = createMockFetch(500, {}, "Internal Server Error") as any;

		await expect(fetchProviders()).rejects.toThrow("500 Internal Server Error");
	});

	test("fetches from /api/providers", async () => {
		await fetchProviders();

		expect(mockFetch.calls).toHaveLength(1);
		expect(mockFetch.calls[0]!.input).toBe("/api/providers");
	});
});

// ── saveProviderKey ─────────────────────────────────────────────────

describe("saveProviderKey", () => {
	test("sends POST with correct body", async () => {
		globalThis.fetch = createMockFetch(200, {}) as any;
		const mf = globalThis.fetch as unknown as typeof mockFetch;

		await saveProviderKey("openai", "sk-test-key");

		expect(mf.calls).toHaveLength(1);
		expect(mf.calls[0]!.input).toBe("/api/providers");
		expect(mf.calls[0]!.init?.method).toBe("POST");

		const body = JSON.parse(mf.calls[0]!.init?.body as string);
		expect(body).toEqual({ provider: "openai", apiKey: "sk-test-key" });
	});

	test("sends content-type header", async () => {
		globalThis.fetch = createMockFetch(200, {}) as any;
		const mf = globalThis.fetch as unknown as typeof mockFetch;

		await saveProviderKey("google", "key-123");

		const headers = mf.calls[0]!.init?.headers as Record<string, string>;
		expect(headers["content-type"]).toBe("application/json");
	});

	test("throws on non-ok response", async () => {
		globalThis.fetch = createMockFetch(400, {}, "Bad Request") as any;

		await expect(saveProviderKey("openai", "bad-key")).rejects.toThrow("400 Bad Request");
	});
});

// ── testProviderConnection ──────────────────────────────────────────

describe("testProviderConnection", () => {
	test("sends POST to correct URL", async () => {
		const responseBody = { success: true };
		globalThis.fetch = createMockFetch(200, responseBody) as any;
		const mf = globalThis.fetch as unknown as typeof mockFetch;

		const result = await testProviderConnection("openai");

		expect(mf.calls).toHaveLength(1);
		expect(mf.calls[0]!.input).toBe("/api/providers/openai/test");
		expect(mf.calls[0]!.init?.method).toBe("POST");
		expect(result).toEqual({ success: true });
	});

	test("returns error result from server", async () => {
		const responseBody = { success: false, error: "Invalid API key" };
		globalThis.fetch = createMockFetch(200, responseBody) as any;

		const result = await testProviderConnection("openai");
		expect(result).toEqual({ success: false, error: "Invalid API key" });
	});

	test("encodes provider in URL path", async () => {
		globalThis.fetch = createMockFetch(200, { success: true }) as any;
		const mf = globalThis.fetch as unknown as typeof mockFetch;

		await testProviderConnection("google");
		expect(mf.calls[0]!.input).toBe("/api/providers/google/test");
	});
});

// ── deleteProviderKey ───────────────────────────────────────────────

describe("deleteProviderKey", () => {
	test("sends DELETE with correct body", async () => {
		globalThis.fetch = createMockFetch(200, {}) as any;
		const mf = globalThis.fetch as unknown as typeof mockFetch;

		await deleteProviderKey("openai");

		expect(mf.calls).toHaveLength(1);
		expect(mf.calls[0]!.input).toBe("/api/providers");
		expect(mf.calls[0]!.init?.method).toBe("DELETE");

		const body = JSON.parse(mf.calls[0]!.init?.body as string);
		expect(body).toEqual({ provider: "openai" });
	});

	test("sends content-type header", async () => {
		globalThis.fetch = createMockFetch(200, {}) as any;
		const mf = globalThis.fetch as unknown as typeof mockFetch;

		await deleteProviderKey("anthropic");

		const headers = mf.calls[0]!.init?.headers as Record<string, string>;
		expect(headers["content-type"]).toBe("application/json");
	});

	test("throws on non-ok response", async () => {
		globalThis.fetch = createMockFetch(404, {}, "Not Found") as any;

		await expect(deleteProviderKey("missing")).rejects.toThrow("404 Not Found");
	});
});

// ── initiateOAuth ───────────────────────────────────────────────────

describe("initiateOAuth", () => {
	// initiateOAuth reads window.location.origin -- provide it for the test env
	const origWindow = globalThis.window;
	beforeEach(() => {
		(globalThis as any).window = { location: { origin: "http://localhost:5173" } };
	});
	afterAll(() => {
		if (origWindow === undefined) delete (globalThis as any).window;
		else globalThis.window = origWindow;
	});

	test("fetches with provider and app_origin params", async () => {
		const responseBody = {
			url: "https://accounts.google.com/o/oauth2/auth",
			state: "random-state",
			codeVerifier: "pkce-verifier",
			redirectUri: "http://localhost:1455/auth/callback",
		};
		globalThis.fetch = createMockFetch(200, responseBody) as any;
		const mf = globalThis.fetch as unknown as typeof mockFetch;

		const result = await initiateOAuth("google");

		expect(mf.calls).toHaveLength(1);
		expect(mf.calls[0]!.input).toContain("/api/auth/oauth");
		expect(mf.calls[0]!.input).toContain("provider=google");
		expect(mf.calls[0]!.input).toContain("app_origin=");
		expect(result).toEqual(responseBody);
	});

	test("throws with error message from server on failure", async () => {
		const errorResponse = { error: "Provider not supported" };
		globalThis.fetch = Object.assign(
			async () =>
				new Response(JSON.stringify(errorResponse), {
					status: 400,
					statusText: "Bad Request",
					headers: { "content-type": "application/json" },
				}),
			{ calls: [] },
		) as any;

		await expect(initiateOAuth("badprovider")).rejects.toThrow("Provider not supported");
	});
});

// ── completeOAuth ───────────────────────────────────────────────────

describe("completeOAuth", () => {
	test("sends POST with all required fields", async () => {
		globalThis.fetch = createMockFetch(200, {}) as any;
		const mf = globalThis.fetch as unknown as typeof mockFetch;

		await completeOAuth("openai", "auth-code", "verifier", "http://localhost/cb", "state-xyz");

		expect(mf.calls).toHaveLength(1);
		expect(mf.calls[0]!.input).toBe("/api/auth/oauth/callback");
		expect(mf.calls[0]!.init?.method).toBe("POST");

		const body = JSON.parse(mf.calls[0]!.init?.body as string);
		expect(body).toEqual({
			provider: "openai",
			code: "auth-code",
			codeVerifier: "verifier",
			redirectUri: "http://localhost/cb",
			state: "state-xyz",
		});
	});

	test("throws with server error message on failure", async () => {
		const errorResponse = { error: "Invalid code" };
		globalThis.fetch = Object.assign(
			async () =>
				new Response(JSON.stringify(errorResponse), {
					status: 400,
					statusText: "Bad Request",
					headers: { "content-type": "application/json" },
				}),
			{ calls: [] },
		) as any;

		await expect(
			completeOAuth("openai", "bad-code", "verifier", "http://localhost/cb"),
		).rejects.toThrow("Invalid code");
	});
});

// ── disconnectOAuth ─────────────────────────────────────────────────

describe("disconnectOAuth", () => {
	test("sends DELETE to callback endpoint", async () => {
		globalThis.fetch = createMockFetch(200, {}) as any;
		const mf = globalThis.fetch as unknown as typeof mockFetch;

		await disconnectOAuth("google");

		expect(mf.calls).toHaveLength(1);
		expect(mf.calls[0]!.input).toBe("/api/auth/oauth/callback");
		expect(mf.calls[0]!.init?.method).toBe("DELETE");

		const body = JSON.parse(mf.calls[0]!.init?.body as string);
		expect(body).toEqual({ provider: "google" });
	});

	test("throws on non-ok response", async () => {
		globalThis.fetch = createMockFetch(500, {}, "Internal Server Error") as any;

		await expect(disconnectOAuth("google")).rejects.toThrow("500 Internal Server Error");
	});
});

// ── sendMessage with attachments ────────────────────────────────────

describe("sendMessage", () => {
	test("with attachments, posts multipart form data carrying every set field", async () => {
		mockFetch = createMockFetch(200, { userMessage: { id: "u1" }, runId: "r1" });
		globalThis.fetch = mockFetch as any;
		const file = new File(["png"], "shot.png", { type: "image/png" });

		const result = await sendMessage("c1", {
			content: "what is this?",
			provider: "openai",
			model: "gpt-4o",
			parentMessageId: "p1",
			editOf: "e1",
			permissionMode: "plan",
			thinkingLevel: "high",
			attachments: [file],
		});

		expect(result.runId).toBe("r1");
		const { input, init } = mockFetch.calls[0]!;
		expect(input).toBe("/api/conversations/c1/messages");
		const form = init!.body as FormData;
		expect(form).toBeInstanceOf(FormData);
		expect(Object.fromEntries([...form.entries()].filter(([k]) => k !== "files"))).toEqual({
			content: "what is this?",
			provider: "openai",
			model: "gpt-4o",
			parentMessageId: "p1",
			editOf: "e1",
			permissionMode: "plan",
			thinkingLevel: "high",
		});
		expect((form.getAll("files")[0] as File).name).toBe("shot.png");
	});

	test("with attachments, leaves unset optional fields out of the form", async () => {
		const file = new File(["x"], "a.txt", { type: "text/plain" });
		await sendMessage("c1", { content: "hi", attachments: [file] });
		const form = mockFetch.calls[0]!.init!.body as FormData;
		expect([...form.keys()]).toEqual(["content", "files"]);
	});
});

// ── exportConversation ──────────────────────────────────────────────

describe("exportConversation", () => {
	function captureDownload() {
		const anchor = { href: "", download: "", click: () => { anchor.clicked = true; }, clicked: false };
		const g = globalThis as any;
		const saved = { document: g.document, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
		const revoked: string[] = [];
		g.document = { createElement: () => anchor };
		URL.createObjectURL = () => "blob:export";
		URL.revokeObjectURL = (u: string) => { revoked.push(u); };
		const restore = () => {
			g.document = saved.document;
			URL.createObjectURL = saved.create;
			URL.revokeObjectURL = saved.revoke;
		};
		return { anchor, revoked, restore };
	}

	test("downloads under the server's filename and scopes to the leaf", async () => {
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL) => {
				mockFetch.calls.push({ input: String(input) });
				return new Response("# chat", { headers: { "Content-Disposition": 'attachment; filename="My chat.md"' } });
			},
		) as any;
		const dl = captureDownload();
		try {
			await exportConversation("c1", "markdown", "leaf-9");
		} finally {
			dl.restore();
		}
		expect(mockFetch.calls[0]!.input).toBe("/api/conversations/c1/export?format=markdown&leafMessageId=leaf-9");
		expect(dl.anchor).toMatchObject({ href: "blob:export", download: "My chat.md", clicked: true });
		expect(dl.revoked).toEqual(["blob:export"]);
	});

	test("falls back to a format-based filename without a Content-Disposition", async () => {
		globalThis.fetch = (async () => new Response("{}")) as any;
		const dl = captureDownload();
		try {
			await exportConversation("c1", "json");
		} finally {
			dl.restore();
		}
		expect(dl.anchor.download).toBe("conversation.json");
	});

	test("throws the server's error and starts no download", async () => {
		globalThis.fetch = createMockFetch(404, { error: "Conversation not found" }) as any;
		const dl = captureDownload();
		try {
			await expect(exportConversation("c1", "markdown")).rejects.toThrow("Conversation not found");
		} finally {
			dl.restore();
		}
		expect(dl.anchor.clicked).toBe(false);
	});
});
