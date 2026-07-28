/**
 * Vitest coverage leg for `$lib/utils/fetch-policy` — the in-flight dedup
 * body-ownership contract.
 *
 * Lives here (not only in the bun-leg `fetch-policy.test.ts`) because the
 * merged lcov the patch-coverage gate reads is produced by the node-vitest
 * leg; the web bun-leg's coverage is not merged. Same contract, measured.
 *
 * Regression: dedup used to hand every caller the SAME `Response`. A body can
 * only be read once, so the second caller's `.json()` threw "body stream
 * already read" — which silently killed the chat stuck-run watchdog (its 10s
 * staleness poll and 30s zombie check share one fetch key, and the watchdog
 * swallows errors and never re-arms, so the skeleton loader spun forever).
 */
import { test, expect, describe, beforeEach, afterEach, vi } from "vitest";
import {
	backgroundFetch,
	userFetch,
	invalidate,
	__resetFetchPolicy_forTests,
	__getFetchStats_forTests,
} from "$lib/utils/fetch-policy";

let origFetch: typeof fetch;

function jsonBody(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

beforeEach(() => {
	__resetFetchPolicy_forTests();
	origFetch = globalThis.fetch;
});
afterEach(() => {
	globalThis.fetch = origFetch;
});

describe("backgroundFetch — response body ownership", () => {
	test("every deduped caller can read the body independently", async () => {
		const resolvers: Array<() => void> = [];
		globalThis.fetch = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					resolvers.push(() => resolve(jsonBody({ runId: "run-1" })));
				}),
		) as unknown as typeof fetch;

		const p1 = backgroundFetch("k-body", "/api/active-run");
		const p2 = backgroundFetch("k-body", "/api/active-run");
		const p3 = backgroundFetch("k-body", "/api/active-run");
		// One network call serves all three.
		expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
		for (const r of resolvers) r();
		const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

		// None of these throws "body stream already read".
		expect(await r1!.json()).toEqual({ runId: "run-1" });
		expect(await r2!.json()).toEqual({ runId: "run-1" });
		expect(await r3!.json()).toEqual({ runId: "run-1" });
		expect(__getFetchStats_forTests().deduped["k-body"]).toBe(2);
	});

	test("the first (non-deduped) caller also owns a readable body", async () => {
		globalThis.fetch = vi.fn(async () => jsonBody({ ok: true })) as unknown as typeof fetch;
		const res = await backgroundFetch("k-solo", "/api/x", {}, { minIntervalMs: 0 });
		expect(await res!.json()).toEqual({ ok: true });
	});

	test("a throttled call still returns null", async () => {
		globalThis.fetch = vi.fn(async () => jsonBody({ ok: true })) as unknown as typeof fetch;
		await backgroundFetch("k-throttle", "/api/x", {}, { minIntervalMs: 10_000 });
		const second = await backgroundFetch("k-throttle", "/api/x", {}, { minIntervalMs: 10_000 });
		expect(second).toBeNull();
		expect(__getFetchStats_forTests().throttled["k-throttle"]).toBe(1);
	});

	test("dedupInFlight:false issues its own request with its own body", async () => {
		globalThis.fetch = vi.fn(async () => jsonBody({ n: 1 })) as unknown as typeof fetch;
		const [a, b] = await Promise.all([
			backgroundFetch("k-nodedup", "/api/x", {}, { dedupInFlight: false, minIntervalMs: 0 }),
			backgroundFetch("k-nodedup", "/api/x", {}, { dedupInFlight: false, minIntervalMs: 0 }),
		]);
		expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2);
		expect(await a!.json()).toEqual({ n: 1 });
		expect(await b!.json()).toEqual({ n: 1 });
	});

	test("POST is never deduped in flight", async () => {
		globalThis.fetch = vi.fn(async () => jsonBody({ ok: true })) as unknown as typeof fetch;
		await Promise.all([
			backgroundFetch("k-post", "/api/x", { method: "POST" }),
			backgroundFetch("k-post", "/api/x", { method: "POST" }, { minIntervalMs: 0 }),
		]);
		expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2);
	});

	test("invalidate(prefix) lifts the cooldown for matching keys only", async () => {
		globalThis.fetch = vi.fn(async () => jsonBody({ ok: true })) as unknown as typeof fetch;
		await backgroundFetch("messages:c1", "/api/x", {}, { minIntervalMs: 10_000 });
		await backgroundFetch("tasks:c1", "/api/y", {}, { minIntervalMs: 10_000 });
		invalidate("messages:");
		expect(await backgroundFetch("messages:c1", "/api/x", {}, { minIntervalMs: 10_000 })).not.toBeNull();
		expect(await backgroundFetch("tasks:c1", "/api/y", {}, { minIntervalMs: 10_000 })).toBeNull();
	});

	test("userFetch is a pass-through and records no stats", async () => {
		globalThis.fetch = vi.fn(async () => jsonBody({ ok: true })) as unknown as typeof fetch;
		await userFetch("/api/x");
		await userFetch("/api/x");
		expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2);
		expect(Object.keys(__getFetchStats_forTests().issued)).toHaveLength(0);
	});
});
