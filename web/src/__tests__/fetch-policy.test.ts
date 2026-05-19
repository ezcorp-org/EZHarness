/**
 * Unit tests for web/src/lib/utils/fetch-policy.ts.
 *
 * The policy module gates chat-page fetches so flaky SSE connections or
 * over-eager reactive effects can't spam the server. These tests verify
 * the contract the rest of the code relies on:
 *   - background fetch is throttled per semantic key
 *   - in-flight calls dedupe (GET/HEAD only)
 *   - invalidate() lifts the cooldown
 *   - userFetch is always a pass-through
 */
import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import {
	backgroundFetch,
	userFetch,
	invalidate,
	__resetFetchPolicy_forTests,
	__getFetchStats_forTests,
} from "../lib/utils/fetch-policy";

// Replace global.fetch per-test so we can count calls and return canned bodies.
let fetchMock: ReturnType<typeof mock>;
let origFetch: typeof fetch;

beforeEach(() => {
	__resetFetchPolicy_forTests();
	origFetch = globalThis.fetch;
	fetchMock = mock(async (_url: RequestInfo | URL, _init?: RequestInit) =>
		new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
	);
	globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = origFetch;
});

describe("backgroundFetch", () => {
	test("first call to a key fires a real fetch and returns the response", async () => {
		const res = await backgroundFetch("k1", "/api/x", {}, { minIntervalMs: 1_000 });
		expect(res).not.toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("second call within minIntervalMs is throttled and returns null", async () => {
		await backgroundFetch("k1", "/api/x", {}, { minIntervalMs: 10_000 });
		const res2 = await backgroundFetch("k1", "/api/x", {}, { minIntervalMs: 10_000 });
		expect(res2).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const s = __getFetchStats_forTests();
		expect(s.issued["k1"]).toBe(1);
		expect(s.throttled["k1"]).toBe(1);
	});

	test("different keys do not share a throttle", async () => {
		await backgroundFetch("k1", "/api/x", {}, { minIntervalMs: 10_000 });
		await backgroundFetch("k2", "/api/y", {}, { minIntervalMs: 10_000 });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	test("concurrent GETs with same key dedupe to one in-flight promise", async () => {
		const resolvers: Array<() => void> = [];
		globalThis.fetch = mock(() => new Promise<Response>((resolve) => {
			resolvers.push(() => resolve(new Response("{}")));
		})) as unknown as typeof fetch;

		const p1 = backgroundFetch("k-inflight", "/api/x");
		const p2 = backgroundFetch("k-inflight", "/api/x");
		expect((globalThis.fetch as any).mock.calls.length).toBe(1);
		// Resolve ALL outstanding resolvers (belt + suspenders).
		for (const r of resolvers) r();
		const [r1, r2] = await Promise.all([p1, p2]);
		expect(r1).not.toBeNull();
		expect(r2).not.toBeNull();
		const s = __getFetchStats_forTests();
		expect(s.deduped["k-inflight"]).toBe(1);
	});

	test("POST is NOT deduped in-flight (mutations must all reach the server)", async () => {
		const resolvers: Array<() => void> = [];
		globalThis.fetch = mock(() => new Promise<Response>((resolve) => {
			resolvers.push(() => resolve(new Response("{}")));
		})) as unknown as typeof fetch;

		const p1 = backgroundFetch("k-mut", "/api/x", { method: "POST" });
		const p2 = backgroundFetch("k-mut", "/api/x", { method: "POST" }, { minIntervalMs: 0 });
		expect((globalThis.fetch as any).mock.calls.length).toBe(2);
		for (const r of resolvers) r();
		await Promise.all([p1, p2]);
	});

	test("after minIntervalMs the next call is allowed again", async () => {
		await backgroundFetch("k1", "/api/x", {}, { minIntervalMs: 50 });
		await new Promise((r) => setTimeout(r, 60));
		const res2 = await backgroundFetch("k1", "/api/x", {}, { minIntervalMs: 50 });
		expect(res2).not.toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	test("invalidate(prefix) lifts the cooldown for matching keys only", async () => {
		await backgroundFetch("messages:c1", "/api/x", {}, { minIntervalMs: 10_000 });
		await backgroundFetch("tasks:c1", "/api/y", {}, { minIntervalMs: 10_000 });
		invalidate("messages:");
		const res1 = await backgroundFetch("messages:c1", "/api/x", {}, { minIntervalMs: 10_000 });
		const res2 = await backgroundFetch("tasks:c1", "/api/y", {}, { minIntervalMs: 10_000 });
		expect(res1).not.toBeNull(); // cooldown lifted
		expect(res2).toBeNull();      // still throttled
	});

	test("dedupInFlight: false allows parallel GETs to both fire", async () => {
		const resolvers: Array<() => void> = [];
		globalThis.fetch = mock(() => new Promise<Response>((resolve) => {
			resolvers.push(() => resolve(new Response("{}")));
		})) as unknown as typeof fetch;

		const p1 = backgroundFetch("k-nodedup", "/api/x", {}, { dedupInFlight: false, minIntervalMs: 0 });
		const p2 = backgroundFetch("k-nodedup", "/api/x", {}, { dedupInFlight: false, minIntervalMs: 0 });
		expect((globalThis.fetch as any).mock.calls.length).toBe(2);
		for (const r of resolvers) r();
		await Promise.all([p1, p2]);
	});
});

describe("userFetch", () => {
	test("always calls fetch, never throttled, never deduped", async () => {
		await userFetch("/api/x");
		await userFetch("/api/x");
		await userFetch("/api/x");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	test("no stats are recorded for userFetch", async () => {
		await userFetch("/api/x");
		const s = __getFetchStats_forTests();
		expect(Object.keys(s.issued)).toHaveLength(0);
	});
});
