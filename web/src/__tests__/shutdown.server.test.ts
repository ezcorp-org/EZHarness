/**
 * Direct unit tests for `web/src/lib/server/shutdown.ts` — the graceful
 * shutdown orchestrator.
 *
 * The module ships explicit test hooks (`__resetForTests`, an exported
 * `shutdown()` "exposed so the regression test can drive shutdown without
 * sending real signals") but the regression test was never landed, so the
 * file sat at ~39% transitive coverage. This drives every documented
 * invariant directly:
 *   - LIFO teardown order (reverse boot order)
 *   - idempotent re-trigger (second `shutdown()` is a no-op)
 *   - failure isolation (a throwing teardown does not block the rest)
 *   - register replace-by-name (boot idempotency)
 *   - the SIGTERM/SIGINT + `sveltekit:shutdown` handler wiring
 *   - the hard-timeout force-exit path (mocked `process.exit`)
 *
 * Runs under the vitest leg (`.server.test.ts`): the module imports
 * `$server/logger`, which the vitest config aliases to the backend `src/`.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

import {
	registerTeardown,
	shutdown,
	isShuttingDown,
	getShutdownSignal,
	installShutdownHandlers,
	__resetForTests,
	HARD_TIMEOUT_MS,
} from "$lib/server/shutdown";

beforeEach(() => {
	__resetForTests();
});

afterEach(() => {
	__resetForTests();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("registerTeardown + shutdown ordering", () => {
	test("teardowns run last-registered-first (LIFO)", async () => {
		const order: string[] = [];
		registerTeardown("a", () => {
			order.push("a");
		});
		registerTeardown("b", () => {
			order.push("b");
		});
		registerTeardown("c", () => {
			order.push("c");
		});
		await shutdown("test");
		expect(order).toEqual(["c", "b", "a"]);
	});

	test("re-registering the same name replaces the earlier entry (no double teardown)", async () => {
		let firstCalls = 0;
		let secondCalls = 0;
		registerTeardown("dup", () => {
			firstCalls++;
		});
		registerTeardown("dup", () => {
			secondCalls++;
		});
		await shutdown("test");
		expect(firstCalls).toBe(0);
		expect(secondCalls).toBe(1);
	});

	test("awaits async teardowns", async () => {
		let done = false;
		registerTeardown("async", async () => {
			await new Promise((r) => setTimeout(r, 1));
			done = true;
		});
		await shutdown("test");
		expect(done).toBe(true);
	});
});

describe("shutdown state + signal", () => {
	test("isShuttingDown flips true once shutdown begins", async () => {
		expect(isShuttingDown()).toBe(false);
		let observed = false;
		registerTeardown("observe", () => {
			observed = isShuttingDown();
		});
		await shutdown("test");
		expect(observed).toBe(true);
		expect(isShuttingDown()).toBe(true);
	});

	test("getShutdownSignal aborts when shutdown runs", async () => {
		// NB: the AbortController is module-level and `__resetForTests` does
		// not (cannot) un-abort it, so we only assert the post-condition —
		// once any shutdown has run in this process the signal stays aborted.
		await shutdown("test");
		expect(getShutdownSignal().aborted).toBe(true);
	});

	test("re-triggering shutdown is a no-op (idempotent)", async () => {
		let calls = 0;
		registerTeardown("once", () => {
			calls++;
		});
		await shutdown("first");
		await shutdown("second");
		expect(calls).toBe(1);
	});
});

describe("failure isolation", () => {
	test("a throwing teardown does not block the remaining teardowns", async () => {
		const ran: string[] = [];
		registerTeardown("db", () => {
			ran.push("db");
		});
		registerTeardown("boom", () => {
			throw new Error("kaboom");
		});
		registerTeardown("late", () => {
			ran.push("late");
		});
		await shutdown("test");
		// "late" runs first (LIFO), "boom" throws but is swallowed, "db" still runs.
		expect(ran).toEqual(["late", "db"]);
	});

	test("an async-rejecting teardown is isolated too", async () => {
		const ran: string[] = [];
		registerTeardown("ok", () => {
			ran.push("ok");
		});
		registerTeardown("reject", async () => {
			throw new Error("async-fail");
		});
		await shutdown("test");
		expect(ran).toEqual(["ok"]);
	});
});

describe("hard-timeout force-exit", () => {
	test("force-exits with code 1 if teardown exceeds the hard timeout", async () => {
		vi.useFakeTimers();
		const exitSpy = vi
			.spyOn(process, "exit")
			.mockImplementation((() => undefined) as never);

		let release: () => void = () => {};
		registerTeardown("hang", () => new Promise<void>((r) => (release = r)));

		const p = shutdown("timeout-test");
		// Advance past the hard timeout while the teardown is still pending.
		await vi.advanceTimersByTimeAsync(HARD_TIMEOUT_MS + 1);
		expect(exitSpy).toHaveBeenCalledWith(1);

		// Let the hung teardown finish so the promise settles cleanly.
		release();
		await vi.runAllTimersAsync();
		await p;
	});
});

describe("installShutdownHandlers", () => {
	test("registers SIGTERM/SIGINT + sveltekit:shutdown listeners, idempotently", () => {
		const onSpy = vi.spyOn(process, "on");
		const onceSpy = vi.spyOn(process, "once");

		installShutdownHandlers();
		const firstOnCount = onSpy.mock.calls.filter(
			([sig]) => sig === "SIGTERM" || sig === "SIGINT",
		).length;
		const firstOnceCount = onceSpy.mock.calls.filter(
			([ev]) => ev === "sveltekit:shutdown",
		).length;
		expect(firstOnCount).toBe(2);
		expect(firstOnceCount).toBe(1);

		// Second call is a no-op (installed guard).
		installShutdownHandlers();
		const secondOnCount = onSpy.mock.calls.filter(
			([sig]) => sig === "SIGTERM" || sig === "SIGINT",
		).length;
		expect(secondOnCount).toBe(2);
	});

	test("a real SIGTERM drives teardown and exits 0", async () => {
		const exitSpy = vi
			.spyOn(process, "exit")
			.mockImplementation((() => undefined) as never);
		let torn = false;
		registerTeardown("t", () => {
			torn = true;
		});
		installShutdownHandlers();

		process.emit("SIGTERM");
		// Let the trigger's shutdown().then() chain settle.
		await new Promise((r) => setTimeout(r, 5));
		expect(torn).toBe(true);
		// The 0-tick deferral schedules process.exit(0); flush it.
		await new Promise((r) => setTimeout(r, 5));
		expect(exitSpy).toHaveBeenCalledWith(0);

		// Clean up the listeners this test attached.
		process.removeAllListeners("SIGTERM");
		process.removeAllListeners("SIGINT");
		process.removeAllListeners("sveltekit:shutdown");
	});

	test("the adapter's sveltekit:shutdown drives teardown WITHOUT self-exit", async () => {
		const exitSpy = vi
			.spyOn(process, "exit")
			.mockImplementation((() => undefined) as never);
		let torn = false;
		registerTeardown("t", () => {
			torn = true;
		});
		installShutdownHandlers();

		process.emit("sveltekit:shutdown", "deploy");
		await new Promise((r) => setTimeout(r, 5));
		expect(torn).toBe(true);
		expect(exitSpy).not.toHaveBeenCalled();

		process.removeAllListeners("SIGTERM");
		process.removeAllListeners("SIGINT");
		process.removeAllListeners("sveltekit:shutdown");
	});
});
