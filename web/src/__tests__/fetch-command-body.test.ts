import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { fetchCommandBody, _resetCommandBodyCache } from "../lib/api";

/**
 * Unit tests for `fetchCommandBody` — the lazy fetch + cache that powers
 * the chat-history `/cmd` chip's hover popover. These tests stub
 * `fetch` so we can assert:
 *   - projectId flows into the search URL (project-scoped commands
 *     only resolve when the active project is forwarded)
 *   - successful results are cached per (projectId, name)
 *   - null results are NOT cached, so a missing command retries
 *   - concurrent hovers coalesce into one request
 */

type FetchCall = { url: string; init?: RequestInit };

function stubFetch(
	handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
): { calls: FetchCall[]; restore: () => void } {
	const calls: FetchCall[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: any, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.url;
		calls.push({ url, init });
		return handler(url, init);
	}) as any;
	return { calls, restore: () => { globalThis.fetch = original; } };
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("fetchCommandBody", () => {
	beforeEach(() => {
		_resetCommandBodyCache();
	});

	test("forwards projectId to the mentions/search endpoint", async () => {
		const stub = stubFetch(() =>
			jsonResponse([
				{ name: "review", description: "", kind: "command", body: "REVIEW BODY" },
			]),
		);
		try {
			const body = await fetchCommandBody("review", "proj-42");
			expect(body).toBe("REVIEW BODY");
			expect(stub.calls).toHaveLength(1);
			expect(stub.calls[0]!.url).toContain("type=cmd");
			expect(stub.calls[0]!.url).toContain("projectId=proj-42");
			expect(stub.calls[0]!.url).toContain("q=review");
		} finally {
			stub.restore();
		}
	});

	test("omits projectId when not supplied", async () => {
		const stub = stubFetch(() =>
			jsonResponse([
				{ name: "commit", description: "", kind: "command", body: "COMMIT BODY" },
			]),
		);
		try {
			await fetchCommandBody("commit");
			expect(stub.calls).toHaveLength(1);
			expect(stub.calls[0]!.url).not.toContain("projectId=");
		} finally {
			stub.restore();
		}
	});

	test("caches successful resolutions by (projectId, name)", async () => {
		const stub = stubFetch(() =>
			jsonResponse([
				{ name: "review", description: "", kind: "command", body: "REVIEW BODY" },
			]),
		);
		try {
			const first = await fetchCommandBody("review", "proj-1");
			const second = await fetchCommandBody("review", "proj-1");
			expect(first).toBe("REVIEW BODY");
			expect(second).toBe("REVIEW BODY");
			expect(stub.calls).toHaveLength(1); // second call served from cache
		} finally {
			stub.restore();
		}
	});

	test("cache is scoped per project — same name different project refetches", async () => {
		let callCount = 0;
		const stub = stubFetch(() => {
			callCount++;
			return jsonResponse([
				{
					name: "review",
					description: "",
					kind: "command",
					body: `BODY ${callCount}`,
				},
			]);
		});
		try {
			const a = await fetchCommandBody("review", "proj-1");
			const b = await fetchCommandBody("review", "proj-2");
			expect(a).toBe("BODY 1");
			expect(b).toBe("BODY 2");
			expect(stub.calls).toHaveLength(2);
		} finally {
			stub.restore();
		}
	});

	test("does NOT cache null results — retries on next call", async () => {
		let callCount = 0;
		const stub = stubFetch(() => {
			callCount++;
			if (callCount === 1) return jsonResponse([]); // command not found
			return jsonResponse([
				{ name: "later", description: "", kind: "command", body: "LATER BODY" },
			]);
		});
		try {
			const first = await fetchCommandBody("later");
			const second = await fetchCommandBody("later");
			expect(first).toBeNull();
			expect(second).toBe("LATER BODY");
			expect(stub.calls).toHaveLength(2);
		} finally {
			stub.restore();
		}
	});

	test("returns null on fetch error without throwing", async () => {
		const stub = stubFetch(async () => {
			throw new Error("network down");
		});
		try {
			const body = await fetchCommandBody("anything");
			expect(body).toBeNull();
		} finally {
			stub.restore();
		}
	});

	test("coalesces concurrent calls for the same (projectId, name) into one request", async () => {
		let resolveFetch: (r: Response) => void;
		const pending = new Promise<Response>((r) => { resolveFetch = r; });
		const stub = stubFetch(() => pending);
		try {
			const a = fetchCommandBody("concurrent", "proj-1");
			const b = fetchCommandBody("concurrent", "proj-1");
			// One fetch shared by both callers (coalesced).
			expect(stub.calls).toHaveLength(1);
			resolveFetch!(jsonResponse([
				{ name: "concurrent", description: "", kind: "command", body: "SHARED" },
			]));
			const [resA, resB] = await Promise.all([a, b]);
			expect(resA).toBe("SHARED");
			expect(resB).toBe("SHARED");
		} finally {
			stub.restore();
		}
	});

	test("returns null when API response omits body for matching name", async () => {
		const stub = stubFetch(() =>
			jsonResponse([
				// Older server (or empty command) — no `body` field.
				{ name: "bodyless", description: "", kind: "command" },
			]),
		);
		try {
			const body = await fetchCommandBody("bodyless");
			expect(body).toBeNull();
		} finally {
			stub.restore();
		}
	});

	test("returns null when API returns a different command name", async () => {
		const stub = stubFetch(() =>
			jsonResponse([
				{ name: "review", description: "", kind: "command", body: "WRONG" },
			]),
		);
		try {
			const body = await fetchCommandBody("commit");
			expect(body).toBeNull();
		} finally {
			stub.restore();
		}
	});

	afterEach(() => {
		_resetCommandBodyCache();
	});
});
