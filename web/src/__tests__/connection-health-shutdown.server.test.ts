/**
 * Regression for "Shutdown closes the DB concurrently with in-flight HTTP
 * requests, not after them".
 *
 * `shutdown()` aborted SSE streams but nothing tracked ordinary request
 * handlers, so `closeDb()` (the last teardown) could run while a POST was
 * still mid query-sequence — 500-ing the client and leaving a partial write.
 * The fix adds an in-flight request drain barrier: `beginRequest()` brackets a
 * request, and `shutdown()` awaits `drainInFlightRequests()` BEFORE the
 * teardown loop so the DB stays up until live requests finish (or a bounded
 * timeout elapses).
 *
 * Runs under the vitest leg (`.server.test.ts`) — the module imports
 * `$server/logger`.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

import {
	registerTeardown,
	shutdown,
	__resetForTests,
	beginRequest,
	inFlightRequestCount,
	drainInFlightRequests,
	DRAIN_TIMEOUT_MS,
} from "$lib/server/shutdown";

beforeEach(() => {
	__resetForTests();
});

afterEach(() => {
	__resetForTests();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("in-flight request tracking", () => {
	test("beginRequest increments the count; done() decrements it", () => {
		expect(inFlightRequestCount()).toBe(0);
		const done1 = beginRequest();
		const done2 = beginRequest();
		expect(inFlightRequestCount()).toBe(2);
		done1();
		expect(inFlightRequestCount()).toBe(1);
		done2();
		expect(inFlightRequestCount()).toBe(0);
	});

	test("done() is idempotent — extra calls do not over-decrement", () => {
		const done = beginRequest();
		expect(inFlightRequestCount()).toBe(1);
		done();
		done();
		done();
		expect(inFlightRequestCount()).toBe(0);
	});
});

describe("drainInFlightRequests", () => {
	test("resolves immediately when nothing is in flight", async () => {
		await expect(drainInFlightRequests(1000)).resolves.toBeUndefined();
	});

	test("waits until the last in-flight request completes", async () => {
		const done = beginRequest();
		let drained = false;
		const p = drainInFlightRequests(5000).then(() => {
			drained = true;
		});
		// Still in flight → not drained yet.
		await Promise.resolve();
		expect(drained).toBe(false);
		done();
		await p;
		expect(drained).toBe(true);
	});

	test("gives up after the timeout when a request never completes", async () => {
		vi.useFakeTimers();
		beginRequest(); // never call done()
		let drained = false;
		const p = drainInFlightRequests(DRAIN_TIMEOUT_MS).then(() => {
			drained = true;
		});
		await vi.advanceTimersByTimeAsync(DRAIN_TIMEOUT_MS + 1);
		await p;
		expect(drained).toBe(true);
	});
});

describe("shutdown ordering", () => {
	test("teardowns do NOT run until in-flight requests drain", async () => {
		const order: string[] = [];
		const done = beginRequest();
		registerTeardown("db", () => {
			order.push("db-teardown");
		});

		const p = shutdown("drain-test");
		// Drain is pending (request still in flight) → no teardown yet.
		await Promise.resolve();
		await Promise.resolve();
		expect(order).toEqual([]);

		// Completing the request lets the drain resolve and teardown proceed.
		done();
		await p;
		expect(order).toEqual(["db-teardown"]);
	});

	test("shutdown still completes if a request wedges past the drain timeout", async () => {
		vi.useFakeTimers();
		const order: string[] = [];
		beginRequest(); // wedged request, never completes
		registerTeardown("db", () => {
			order.push("db-teardown");
		});

		const p = shutdown("wedged-test");
		// Advance past the drain window; teardown then runs.
		await vi.advanceTimersByTimeAsync(DRAIN_TIMEOUT_MS + 1);
		await p;
		expect(order).toEqual(["db-teardown"]);
	});
});
