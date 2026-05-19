import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";
import { searchMentions, type MentionResult } from "../lib/api";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
	originalFetch = globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function mockFetch(handler: (url: string) => Response | Promise<Response>) {
	globalThis.fetch = mock(async (url: string | URL | Request) => {
		const urlStr = typeof url === "string" ? url : url.toString();
		return handler(urlStr);
	}) as any;
}

describe("searchMentions", () => {
	test("calls correct URL with query", async () => {
		const mockResults: MentionResult[] = [
			{ name: "Code Assistant", description: "Helps with code", kind: "agent" },
		];
		mockFetch((url) => {
			expect(url).toContain("/api/mentions/search");
			expect(url).toContain("q=code");
			return new Response(JSON.stringify(mockResults), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const results = await searchMentions("code");
		expect(results).toHaveLength(1);
		expect(results[0].kind).toBe("agent");
		expect(results[0].name).toBe("Code Assistant");
	});

	test("passes type=ext filter param", async () => {
		mockFetch((url) => {
			expect(url).toContain("type=ext");
			expect(url).toContain("q=proj");
			return new Response(JSON.stringify([]), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const results = await searchMentions("proj", "ext");
		expect(results).toEqual([]);
	});

	test("passes type=agent filter param", async () => {
		mockFetch((url) => {
			expect(url).toContain("type=agent");
			return new Response(JSON.stringify([]), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		await searchMentions("test", "agent");
	});

	test("omits type param when not specified", async () => {
		mockFetch((url) => {
			expect(url).not.toContain("type=");
			return new Response(JSON.stringify([]), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		await searchMentions("test");
	});

	test("handles empty query", async () => {
		mockFetch((url) => {
			expect(url).toContain("q=");
			return new Response(JSON.stringify([
				{ name: "Agent1", description: "desc", kind: "agent" },
				{ name: "Ext1", description: "desc", kind: "extension" },
			]), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const results = await searchMentions("");
		expect(results).toHaveLength(2);
	});

	test("handles multiple results with mixed kinds", async () => {
		const mixed: MentionResult[] = [
			{ name: "Agent A", description: "d1", kind: "agent" },
			{ name: "Ext B", description: "d2", kind: "extension" },
			{ name: "Agent C", description: "d3", kind: "agent" },
		];
		mockFetch(() => new Response(JSON.stringify(mixed), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}));

		const results = await searchMentions("test");
		expect(results).toHaveLength(3);
		expect(results.filter((r) => r.kind === "agent")).toHaveLength(2);
		expect(results.filter((r) => r.kind === "extension")).toHaveLength(1);
	});

	test("throws on server error (500)", async () => {
		mockFetch(() => new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" }));

		expect(searchMentions("test")).rejects.toThrow("500");
	});

	test("throws on 404", async () => {
		mockFetch(() => new Response("Not Found", { status: 404, statusText: "Not Found" }));

		expect(searchMentions("test")).rejects.toThrow("404");
	});

	test("encodes special characters in query", async () => {
		mockFetch((url) => {
			// URLSearchParams encodes spaces as +
			expect(url).toContain("q=hello+world");
			return new Response(JSON.stringify([]), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		await searchMentions("hello world");
	});

	test("passes type=team filter param", async () => {
		mockFetch((url) => {
			expect(url).toContain("type=team");
			expect(url).toContain("q=");
			return new Response(JSON.stringify([]), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const results = await searchMentions("", "team");
		expect(results).toEqual([]);
	});

	test("response with kind team is correctly typed", async () => {
		const teamResults: MentionResult[] = [
			{ name: "DevOps Team", description: "Handles deployments", kind: "team" },
		];
		mockFetch(() => new Response(JSON.stringify(teamResults), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}));

		const results = await searchMentions("dev", "team");
		expect(results).toHaveLength(1);
		expect(results[0].kind).toBe("team");
		expect(results[0].name).toBe("DevOps Team");
	});

	test("passes type=path filter param and projectId", async () => {
		mockFetch((url) => {
			expect(url).toContain("type=path");
			expect(url).toContain("projectId=proj-123");
			expect(url).toContain("q=src");
			return new Response(JSON.stringify([]), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const results = await searchMentions("src", "path", "proj-123");
		expect(results).toEqual([]);
	});

	test("omits projectId param when not provided", async () => {
		mockFetch((url) => {
			expect(url).not.toContain("projectId=");
			return new Response(JSON.stringify([]), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		await searchMentions("foo", "path");
	});

	test("response with kind file is correctly typed", async () => {
		const fileResults: MentionResult[] = [
			{ name: "src/app.ts", description: "/proj/src/app.ts", kind: "file" },
		];
		mockFetch(() => new Response(JSON.stringify(fileResults), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}));

		const results = await searchMentions("app", "path", "proj-123");
		expect(results).toHaveLength(1);
		expect(results[0].kind).toBe("file");
		expect(results[0].name).toBe("src/app.ts");
	});

	test("response with kind dir is correctly typed", async () => {
		const dirResults: MentionResult[] = [
			{ name: "src", description: "/proj/src", kind: "dir" },
		];
		mockFetch(() => new Response(JSON.stringify(dirResults), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}));

		const results = await searchMentions("sr", "path", "proj-123");
		expect(results).toHaveLength(1);
		expect(results[0].kind).toBe("dir");
		expect(results[0].name).toBe("src");
	});
});
