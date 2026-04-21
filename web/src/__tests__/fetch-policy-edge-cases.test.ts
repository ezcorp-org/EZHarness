/**
 * Edge-case coverage for web/src/lib/utils/fetch-policy.ts that
 * complements the happy-path tests in fetch-policy.test.ts. Each case
 * here corresponds to a subtle contract the chat page depends on — if
 * any of these behaviors silently changes, the spam or the user-visible
 * symptoms regress even while the core tests still pass.
 */
import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import {
	backgroundFetch,
	userFetch,
	invalidate,
	__resetFetchPolicy_forTests,
	__getFetchStats_forTests,
} from "../lib/utils/fetch-policy";

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

describe("invalidate() edge cases", () => {
	test("invalidate with empty prefix would lift all cooldowns (caller must be specific)", async () => {
		// This is a documented gotcha of the implementation: `''`.startsWith('')
		// is always true, so invalidate('') clears every key. Test locks in
		// the behavior so a caller accidentally passing '' doesn't fail
		// silently — they'd get a free fetch burst on next poll instead.
		await backgroundFetch("a", "/1", {}, { minIntervalMs: 10_000 });
		await backgroundFetch("b", "/2", {}, { minIntervalMs: 10_000 });
		invalidate("");
		const a = await backgroundFetch("a", "/1", {}, { minIntervalMs: 10_000 });
		const b = await backgroundFetch("b", "/2", {}, { minIntervalMs: 10_000 });
		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
	});

	test("invalidate with a prefix that matches nothing is a no-op", async () => {
		await backgroundFetch("messages:c1", "/1", {}, { minIntervalMs: 10_000 });
		invalidate("nothing-matches:");
		const r = await backgroundFetch("messages:c1", "/1", {}, { minIntervalMs: 10_000 });
		expect(r).toBeNull(); // still throttled
	});

	test("invalidate does NOT clear in-flight promises — ongoing requests still dedupe", async () => {
		// Rationale: if a GET is already in flight when the user switches
		// conversations, we want its eventual response to still be reused
		// by any other caller that arrives before it resolves. Invalidate
		// only removes the cooldown *timestamp*.
		const resolvers: Array<() => void> = [];
		globalThis.fetch = mock(() => new Promise<Response>((r) => {
			resolvers.push(() => r(new Response("{}")));
		})) as unknown as typeof fetch;

		const p1 = backgroundFetch("messages:c1", "/x");
		invalidate("messages:");
		const p2 = backgroundFetch("messages:c1", "/x");
		// First call is in flight; second should either dedupe to it OR
		// fire a new request since cooldown was lifted. Our implementation
		// prefers dedup (returns the in-flight promise) — lock that in.
		expect((globalThis.fetch as any).mock.calls.length).toBe(1);
		for (const r of resolvers) r();
		await Promise.all([p1, p2]);
	});
});

describe("error response handling", () => {
	test("5xx response still counts as 'last fetched' — doesn't thundering-herd the server", async () => {
		// When the server is struggling, we do NOT want clients bypassing
		// the cooldown by retrying every tick. A 500 response still updates
		// lastFetchedAt so the throttle holds for minIntervalMs.
		globalThis.fetch = mock(async () => new Response("bad", { status: 500 })) as unknown as typeof fetch;
		const r1 = await backgroundFetch("k", "/x", {}, { minIntervalMs: 10_000 });
		const r2 = await backgroundFetch("k", "/x", {}, { minIntervalMs: 10_000 });
		expect(r1).not.toBeNull();
		expect(r1!.ok).toBe(false);
		expect(r2).toBeNull(); // throttled
	});

	test("network errors don't leave stale in-flight entries blocking future calls", async () => {
		// Rejected fetches must clean up `inFlight` so a subsequent caller
		// doesn't attach to a dead promise. Force an error, swallow it,
		// then verify the next call fires fresh.
		globalThis.fetch = mock(async () => { throw new Error("network down"); }) as unknown as typeof fetch;
		let caught: unknown = null;
		try {
			await backgroundFetch("k", "/x", {}, { minIntervalMs: 0 });
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(Error);

		// Replace fetch with a success; the next call must go through and
		// NOT hang waiting on the rejected promise still in the in-flight map.
		globalThis.fetch = mock(async () => new Response("ok")) as unknown as typeof fetch;
		const r = await backgroundFetch("k", "/x", {}, { minIntervalMs: 0 });
		expect(r).not.toBeNull();
		expect(await r!.text()).toBe("ok");
	});
});

describe("minIntervalMs = 0", () => {
	test("minIntervalMs: 0 disables throttle but keeps in-flight dedup", async () => {
		const resolvers: Array<() => void> = [];
		globalThis.fetch = mock(() => new Promise<Response>((r) => {
			resolvers.push(() => r(new Response("{}")));
		})) as unknown as typeof fetch;

		const p1 = backgroundFetch("k", "/x", {}, { minIntervalMs: 0 });
		const p2 = backgroundFetch("k", "/x", {}, { minIntervalMs: 0 });
		// With dedupInFlight default true, identical-key concurrent GETs
		// still share the in-flight promise — minIntervalMs: 0 only
		// disables the cooldown, not the dedup.
		expect((globalThis.fetch as any).mock.calls.length).toBe(1);
		for (const r of resolvers) r();
		await Promise.all([p1, p2]);

		// Sequential call with cleared in-flight map: must fire a FRESH
		// fetch because there's no cooldown and the previous in-flight
		// promise already resolved.
		const p3 = backgroundFetch("k", "/x", {}, { minIntervalMs: 0 });
		// Give microtasks a tick to let the p3 promise pump.
		await Promise.resolve();
		expect((globalThis.fetch as any).mock.calls.length).toBe(2);
		// Resolve p3 so the test doesn't leak a dangling promise.
		for (const r of resolvers) r();
		await p3;
	});
});

describe("stats accounting contract", () => {
	test("issued count increments only when the fetch actually fires", async () => {
		await backgroundFetch("k", "/x", {}, { minIntervalMs: 10_000 });
		await backgroundFetch("k", "/x", {}, { minIntervalMs: 10_000 }); // throttled
		await backgroundFetch("k", "/x", {}, { minIntervalMs: 10_000 }); // throttled
		const s = __getFetchStats_forTests();
		expect(s.issued["k"]).toBe(1);
		expect(s.throttled["k"]).toBe(2);
	});

	test("deduped count increments once per in-flight reuse", async () => {
		const resolvers: Array<() => void> = [];
		globalThis.fetch = mock(() => new Promise<Response>((r) => {
			resolvers.push(() => r(new Response("{}")));
		})) as unknown as typeof fetch;

		const p1 = backgroundFetch("k", "/x");
		const p2 = backgroundFetch("k", "/x");
		const p3 = backgroundFetch("k", "/x");
		const s = __getFetchStats_forTests();
		expect(s.deduped["k"]).toBe(2); // p2, p3 shared p1's promise
		for (const r of resolvers) r();
		await Promise.all([p1, p2, p3]);
	});
});

describe("method-sensitivity", () => {
	test("HEAD is treated like GET (idempotent: throttled and in-flight deduped)", async () => {
		const resolvers: Array<() => void> = [];
		globalThis.fetch = mock(() => new Promise<Response>((r) => {
			resolvers.push(() => r(new Response("{}")));
		})) as unknown as typeof fetch;

		const p1 = backgroundFetch("k", "/x", { method: "HEAD" });
		const p2 = backgroundFetch("k", "/x", { method: "HEAD" });
		expect((globalThis.fetch as any).mock.calls.length).toBe(1);
		for (const r of resolvers) r();
		await Promise.all([p1, p2]);
	});

	test("lowercase method still treated correctly (normalization)", async () => {
		const resolvers: Array<() => void> = [];
		globalThis.fetch = mock(() => new Promise<Response>((r) => {
			resolvers.push(() => r(new Response("{}")));
		})) as unknown as typeof fetch;

		// lowercase 'post' must NOT be deduped — mutations always reach server.
		const p1 = backgroundFetch("k", "/x", { method: "post" }, { minIntervalMs: 0 });
		const p2 = backgroundFetch("k", "/x", { method: "post" }, { minIntervalMs: 0 });
		expect((globalThis.fetch as any).mock.calls.length).toBe(2);
		for (const r of resolvers) r();
		await Promise.all([p1, p2]);
	});
});

describe("conversation-switch flow (invalidate contract)", () => {
	test("cooldown lifted on convId change does NOT leak to unrelated conversations", async () => {
		// Scenario: user has two tabs/chats A and B. Navigating within A
		// must NOT drop B's throttle — otherwise B's next poll hits the
		// server early. The prefix-based invalidate handles this because
		// keys are scoped per-conversation.
		await backgroundFetch("messages-all:A", "/a", {}, { minIntervalMs: 10_000 });
		await backgroundFetch("messages-all:B", "/b", {}, { minIntervalMs: 10_000 });
		invalidate("messages-all:A"); // specific to A
		const a = await backgroundFetch("messages-all:A", "/a", {}, { minIntervalMs: 10_000 });
		const b = await backgroundFetch("messages-all:B", "/b", {}, { minIntervalMs: 10_000 });
		expect(a).not.toBeNull();
		expect(b).toBeNull();
	});

	test("prefix invalidate clears only matching keys (real-world call: invalidate('messages-all:'))", async () => {
		// Mirrors the convId-change $effect in +page.svelte:
		//   invalidateFetchPolicy('messages-all:'); invalidateFetchPolicy('conv:'); ...
		await backgroundFetch("messages-all:A", "/a1", {}, { minIntervalMs: 10_000 });
		await backgroundFetch("messages-all:B", "/a2", {}, { minIntervalMs: 10_000 });
		await backgroundFetch("tasks:A", "/t1", {}, { minIntervalMs: 10_000 });
		await backgroundFetch("tasks:B", "/t2", {}, { minIntervalMs: 10_000 });
		invalidate("messages-all:");
		const m1 = await backgroundFetch("messages-all:A", "/a1", {}, { minIntervalMs: 10_000 });
		const m2 = await backgroundFetch("messages-all:B", "/a2", {}, { minIntervalMs: 10_000 });
		const t1 = await backgroundFetch("tasks:A", "/t1", {}, { minIntervalMs: 10_000 });
		expect(m1).not.toBeNull();
		expect(m2).not.toBeNull();
		expect(t1).toBeNull(); // tasks keys untouched
	});
});

describe("userFetch independence from policy state", () => {
	test("userFetch is not affected by backgroundFetch cooldowns for the same URL", async () => {
		await backgroundFetch("k", "/x", {}, { minIntervalMs: 10_000 });
		// User clicks a button that sends to the same URL — must go through
		// even though the background throttle is still cold.
		await userFetch("/x");
		await userFetch("/x");
		expect(fetchMock).toHaveBeenCalledTimes(3); // 1 bg + 2 user
	});

	test("userFetch does not populate in-flight cache (user clicks are distinct intents)", async () => {
		const resolvers: Array<() => void> = [];
		globalThis.fetch = mock(() => new Promise<Response>((r) => {
			resolvers.push(() => r(new Response("{}")));
		})) as unknown as typeof fetch;

		const u1 = userFetch("/x");
		const u2 = userFetch("/x");
		// Two distinct user actions = two distinct fetches.
		expect((globalThis.fetch as any).mock.calls.length).toBe(2);
		for (const r of resolvers) r();
		await Promise.all([u1, u2]);
	});
});
