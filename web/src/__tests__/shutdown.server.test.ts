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
	DRAIN_TIMEOUT_MS,
	HARD_TIMEOUT_MS,
	TEARDOWN_TIMEOUT_MS,
} from "$lib/server/shutdown";

/** The shutdown logger's error lines, parsed from stderr. */
function captureShutdownErrors(): Array<Record<string, unknown>> {
	const lines: Array<Record<string, unknown>> = [];
	vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
		for (const line of String(chunk).split("\n").filter(Boolean)) {
			try {
				const parsed = JSON.parse(line) as Record<string, unknown>;
				if (parsed.subsystem === "shutdown") lines.push(parsed);
			} catch {
				// not a logger line
			}
		}
		return true;
	}) as never);
	return lines;
}

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

	test("stops decision producers, drains permission audits, then closes the database", async () => {
		const order: string[] = [];
		registerTeardown("pglite-close", () => {
			order.push("db");
		});
		registerTeardown("permission-audit-coalescer", async () => {
			await Promise.resolve();
			order.push("audit");
		});
		registerTeardown("decision-producer", () => {
			order.push("producer");
		});

		await shutdown("test");
		expect(order).toEqual(["producer", "audit", "db"]);
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

describe("per-teardown deadline", () => {
	test("a teardown that hangs past its deadline is named, and the later teardowns still run", async () => {
		vi.useFakeTimers();
		const errors = captureShutdownErrors();
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		const ran: string[] = [];
		registerTeardown("pglite-close", () => {
			ran.push("pglite-close");
		});
		registerTeardown("factory-runtime", () => new Promise<void>(() => {}));

		const p = shutdown("deadline-test");
		await vi.advanceTimersByTimeAsync(TEARDOWN_TIMEOUT_MS);
		await p;

		expect(ran).toEqual(["pglite-close"]);
		expect(errors.find((line) => line.msg === "teardown timed out; continuing")).toMatchObject({
			name: "factory-runtime",
			timeoutMs: TEARDOWN_TIMEOUT_MS,
		});
		expect(exitSpy).not.toHaveBeenCalled();
	});

	test("the request drain plus one timed-out teardown stays under the hard timeout", () => {
		expect(DRAIN_TIMEOUT_MS + TEARDOWN_TIMEOUT_MS).toBeLessThan(HARD_TIMEOUT_MS);
	});
});

describe("hard-timeout force-exit", () => {
	test("force-exits with code 1 if teardown exceeds the hard timeout, naming every unfinished teardown", async () => {
		vi.useFakeTimers();
		const errors = captureShutdownErrors();
		const exitSpy = vi
			.spyOn(process, "exit")
			.mockImplementation((() => undefined) as never);

		// Enough hung teardowns that their deadlines add up past the hard timeout.
		const hung = Array.from({ length: Math.ceil(HARD_TIMEOUT_MS / TEARDOWN_TIMEOUT_MS) }, (_, index) => `hang-${index}`);
		const releases: Array<() => void> = [];
		registerTeardown("done-first", () => {});
		for (const name of hung) registerTeardown(name, () => new Promise<void>((r) => releases.push(r)));

		const p = shutdown("timeout-test");
		// Advance past the hard timeout while the teardowns are still pending.
		await vi.advanceTimersByTimeAsync(HARD_TIMEOUT_MS + 1);
		expect(exitSpy).toHaveBeenCalledWith(1);
		const forced = errors.find((line) => line.msg === "forced-exit — shutdown teardown exceeded hard timeout");
		expect(forced?.pending).toEqual([...hung].reverse().concat("done-first"));

		// Let the hung teardowns finish so the promise settles cleanly.
		for (const release of releases) release();
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
			([sig]) => ["SIGTERM", "SIGINT"].includes(sig),
		).length;
		const firstOnceCount = onceSpy.mock.calls.filter(
			([ev]) => ["sveltekit:shutdown"].includes(ev),
		).length;
		expect(firstOnCount).toBe(2);
		expect(firstOnceCount).toBe(1);

		// Second call is a no-op (installed guard).
		installShutdownHandlers();
		const secondOnCount = onSpy.mock.calls.filter(
			([sig]) => ["SIGTERM", "SIGINT"].includes(sig),
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
