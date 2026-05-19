/**
 * Phase 6 (M3) — `MAX_TOOL_CALLS_PER_TURN` enforcement.
 *
 * Pre-Phase-6: the constant was declared but never checked. A
 * misbehaving / compromised LLM could fan out 1000+ tool calls per turn
 * before the run loop noticed.
 *
 * The cap default was later raised from 10 → 100 (10 killed legitimate
 * multi-step agentic turns) and made env-overridable via
 * `EZCORP_MAX_TOOL_CALLS_PER_TURN` (pure parser
 * `parseMaxToolCallsPerTurn`). Enforcement tests below are
 * limit-relative — they drive loops by the exported constant rather
 * than a hardcoded `10`, so they stay correct if the default moves.
 *
 * Phase 6 wires:
 *   - Per-conversation per-turn counter (process-singleton Map).
 *   - The call past the cap throws `MaxToolCallsExceededError`.
 *   - Counter resets on `run:complete` (and `run:cancel` / `run:error`).
 *   - Two parallel conversations don't share a counter.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
	ToolExecutor,
	MAX_TOOL_CALLS_PER_TURN,
	parseMaxToolCallsPerTurn,
	MaxToolCallsExceededError,
	_resetToolCallsCounterForTests,
	_getToolCallsThisTurnForTests,
} from "../extensions/tool-executor";
import { ExtensionRegistry } from "../extensions/registry";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";
import type { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";

interface BusEntry {
	type: keyof AgentEvents;
	listener: (data: unknown) => void;
}

function makeBus(): { bus: EventBus<AgentEvents>; emit: (type: keyof AgentEvents, data: unknown) => void } {
	const listeners: BusEntry[] = [];
	const bus = {
		emit: (type: keyof AgentEvents, data: unknown) => {
			for (const l of listeners) {
				if (l.type === type) l.listener(data);
			}
		},
		on: (type: keyof AgentEvents, listener: (data: unknown) => void) => {
			listeners.push({ type, listener });
			return () => {
				const idx = listeners.findIndex((e) => e.type === type && e.listener === listener);
				if (idx >= 0) listeners.splice(idx, 1);
			};
		},
	} as unknown as EventBus<AgentEvents>;
	return {
		bus,
		// `keyof AgentEvents` on TS widens to `string | symbol | number`
		// when used as the variadic param of `bus.emit`; cast to string
		// to keep the call-site shape narrow.
		emit: (type, data) => bus.emit(type as string, data as never),
	};
}

beforeEach(() => {
	ExtensionRegistry.resetInstance();
	_resetToolCallsCounterForTests();
});

function makeRegistry() {
	const registry = ExtensionRegistry.getInstance();
	registry.registerToolForTest("ext-mtc__do", {
		name: "ext-mtc__do",
		originalName: "do",
		description: "test",
		inputSchema: { type: "object" },
		extensionId: "ext-mtc",
		extensionName: "ext-mtc",
	});
	return registry;
}

describe("MAX_TOOL_CALLS_PER_TURN enforcement (M3)", () => {
	test("default constant equals 100 (spec lock-in)", () => {
		expect(MAX_TOOL_CALLS_PER_TURN).toBe(100);
	});

	test("first MAX calls in a single conversation succeed; the next throws", async () => {
		const registry = makeRegistry();
		const engine = createStubPermissionEngine();
		const { bus } = makeBus();
		const executor = new ToolExecutor(registry, engine, { bus });
		// Stub out the actual dispatch — only counter behavior matters.
		executor.executeToolCall = ((origExecute) => {
			return async (toolName: string, _input: Record<string, unknown>, conversationId: string) => {
				// Replicate the counter check in the real implementation
				// without invoking the rest of the dispatch — the test
				// verifies the public contract (throws on 11th).
				if (conversationId && conversationId !== "cross-ext") {
					const next = (_getToolCallsThisTurnForTests(conversationId) ?? 0) + 1;
					if (next > MAX_TOOL_CALLS_PER_TURN) {
						throw new MaxToolCallsExceededError(conversationId, next);
					}
					// Bump via the real path so the singleton state
					// matches production. Calling the original
					// executeToolCall would require an end-to-end stub
					// of the dispatch, the registry tool, and the
					// authorize chain — too heavy. Instead, emulate the
					// increment via a one-off call to the counter peek.
					// The counter is updated inside the real method, so
					// invoke through a private setter shim:
					// (We rely on the increment-on-entry contract.)
				}
				return origExecute.call(executor, toolName, _input, conversationId, "msg");
			};
		})(executor.executeToolCall);
		// We need the real counter to advance. Easiest: directly call
		// the real `executeToolCall` and trap the dispatch through the
		// stub allow-all engine — we achieve this by not overriding
		// executeToolCall at all and instead stubbing the registered
		// tool's process to a no-op.
		//
		// Reset and re-run with the production path:
		_resetToolCallsCounterForTests();
		ExtensionRegistry.resetInstance();
		const realRegistry = ExtensionRegistry.getInstance();
		realRegistry.registerToolForTest("ext-mtc2__do", {
			name: "ext-mtc2__do",
			originalName: "do",
			description: "test",
			inputSchema: { type: "object" },
			extensionId: "ext-mtc2",
			extensionName: "ext-mtc2",
		});
		// Mock the registry's `getProcess`/`getManifest` so the
		// dispatch short-circuits — the tool doesn't exist on disk.
		const fakeProc = {
			callTool: async () => ({ content: [{ type: "text" as const, text: "ok" }], isError: false }),
			setNotificationHandler: () => {},
			setRequestHandler: () => {},
		};
		realRegistry.getProcess = (async () => fakeProc) as never;
		realRegistry.getManifest = (() => ({
			schemaVersion: 3,
			name: "ext-mtc2",
			version: "1.0.0",
			description: "t",
			author: { name: "t" },
			permissions: {},
			entrypoint: "./i.ts",
			tools: [{ name: "do", description: "t", inputSchema: { type: "object" }, capabilities: {} }],
		} as unknown as ReturnType<typeof realRegistry.getManifest>)) as never;
		realRegistry.getGrantedPermissions = (() => ({ grantedAt: {} })) as never;

		const exec2 = new ToolExecutor(realRegistry, engine, { bus });

		for (let i = 0; i < MAX_TOOL_CALLS_PER_TURN; i++) {
			const result = await exec2.executeToolCall("ext-mtc2__do", {}, "conv-mtc-1", `msg-${i}`);
			expect(result.isError).toBe(false);
		}
		expect(_getToolCallsThisTurnForTests("conv-mtc-1")).toBe(MAX_TOOL_CALLS_PER_TURN);

		// The call past the cap throws.
		await expect(
			exec2.executeToolCall("ext-mtc2__do", {}, "conv-mtc-1", "msg-overflow"),
		).rejects.toBeInstanceOf(MaxToolCallsExceededError);
	});

	test("counter resets on run:complete", async () => {
		ExtensionRegistry.resetInstance();
		const registry = ExtensionRegistry.getInstance();
		registry.registerToolForTest("ext-mtc3__do", {
			name: "ext-mtc3__do",
			originalName: "do",
			description: "test",
			inputSchema: { type: "object" },
			extensionId: "ext-mtc3",
			extensionName: "ext-mtc3",
		});
		const fakeProc = {
			callTool: async () => ({ content: [{ type: "text" as const, text: "ok" }], isError: false }),
			setNotificationHandler: () => {},
			setRequestHandler: () => {},
		};
		registry.getProcess = (async () => fakeProc) as never;
		registry.getManifest = (() => ({
			schemaVersion: 3,
			name: "ext-mtc3",
			version: "1.0.0",
			description: "t",
			author: { name: "t" },
			permissions: {},
			entrypoint: "./i.ts",
			tools: [{ name: "do", description: "t", inputSchema: { type: "object" }, capabilities: {} }],
		} as unknown as ReturnType<typeof registry.getManifest>)) as never;
		registry.getGrantedPermissions = (() => ({ grantedAt: {} })) as never;

		const engine = createStubPermissionEngine();
		const { bus, emit } = makeBus();
		const executor = new ToolExecutor(registry, engine, { bus });

		for (let i = 0; i < 10; i++) {
			await executor.executeToolCall("ext-mtc3__do", {}, "conv-mtc-3", `msg-${i}`);
		}
		expect(_getToolCallsThisTurnForTests("conv-mtc-3")).toBe(10);
		// run:complete clears the counter.
		emit("run:complete", { conversationId: "conv-mtc-3", runId: "r1" });
		expect(_getToolCallsThisTurnForTests("conv-mtc-3")).toBe(0);

		// Next 10 calls succeed.
		for (let i = 0; i < 10; i++) {
			await executor.executeToolCall("ext-mtc3__do", {}, "conv-mtc-3", `msg-${i + 100}`);
		}
		expect(_getToolCallsThisTurnForTests("conv-mtc-3")).toBe(10);
	});

	test("counter resets on run:cancel", async () => {
		ExtensionRegistry.resetInstance();
		const registry = ExtensionRegistry.getInstance();
		registry.registerToolForTest("ext-mtc-cancel__do", {
			name: "ext-mtc-cancel__do",
			originalName: "do",
			description: "test",
			inputSchema: { type: "object" },
			extensionId: "ext-mtc-cancel",
			extensionName: "ext-mtc-cancel",
		});
		const fakeProc = {
			callTool: async () => ({ content: [{ type: "text" as const, text: "ok" }], isError: false }),
			setNotificationHandler: () => {},
			setRequestHandler: () => {},
		};
		registry.getProcess = (async () => fakeProc) as never;
		registry.getManifest = (() => ({
			schemaVersion: 3,
			name: "ext-mtc-cancel",
			version: "1.0.0",
			description: "t",
			author: { name: "t" },
			permissions: {},
			entrypoint: "./i.ts",
			tools: [{ name: "do", description: "t", inputSchema: { type: "object" }, capabilities: {} }],
		} as unknown as ReturnType<typeof registry.getManifest>)) as never;
		registry.getGrantedPermissions = (() => ({ grantedAt: {} })) as never;

		const engine = createStubPermissionEngine();
		const { bus, emit } = makeBus();
		const executor = new ToolExecutor(registry, engine, { bus });

		for (let i = 0; i < 10; i++) {
			await executor.executeToolCall("ext-mtc-cancel__do", {}, "conv-mtc-cancel", `msg-${i}`);
		}
		expect(_getToolCallsThisTurnForTests("conv-mtc-cancel")).toBe(10);

		// run:cancel clears the counter — a turn aborted mid-flight
		// must not tie up the next turn's budget.
		emit("run:cancel", { conversationId: "conv-mtc-cancel", runId: "r-cancel" });
		expect(_getToolCallsThisTurnForTests("conv-mtc-cancel")).toBe(0);

		// Next 10 succeed.
		for (let i = 0; i < 10; i++) {
			await executor.executeToolCall("ext-mtc-cancel__do", {}, "conv-mtc-cancel", `msg-${i + 100}`);
		}
		expect(_getToolCallsThisTurnForTests("conv-mtc-cancel")).toBe(10);
	});

	test("counter resets on run:error", async () => {
		ExtensionRegistry.resetInstance();
		const registry = ExtensionRegistry.getInstance();
		registry.registerToolForTest("ext-mtc-err__do", {
			name: "ext-mtc-err__do",
			originalName: "do",
			description: "test",
			inputSchema: { type: "object" },
			extensionId: "ext-mtc-err",
			extensionName: "ext-mtc-err",
		});
		const fakeProc = {
			callTool: async () => ({ content: [{ type: "text" as const, text: "ok" }], isError: false }),
			setNotificationHandler: () => {},
			setRequestHandler: () => {},
		};
		registry.getProcess = (async () => fakeProc) as never;
		registry.getManifest = (() => ({
			schemaVersion: 3,
			name: "ext-mtc-err",
			version: "1.0.0",
			description: "t",
			author: { name: "t" },
			permissions: {},
			entrypoint: "./i.ts",
			tools: [{ name: "do", description: "t", inputSchema: { type: "object" }, capabilities: {} }],
		} as unknown as ReturnType<typeof registry.getManifest>)) as never;
		registry.getGrantedPermissions = (() => ({ grantedAt: {} })) as never;

		const engine = createStubPermissionEngine();
		const { bus, emit } = makeBus();
		const executor = new ToolExecutor(registry, engine, { bus });

		for (let i = 0; i < 10; i++) {
			await executor.executeToolCall("ext-mtc-err__do", {}, "conv-mtc-err", `msg-${i}`);
		}
		expect(_getToolCallsThisTurnForTests("conv-mtc-err")).toBe(10);

		// run:error also clears — same tradeoff as cancel.
		emit("run:error", { conversationId: "conv-mtc-err", runId: "r-err", error: "boom" });
		expect(_getToolCallsThisTurnForTests("conv-mtc-err")).toBe(0);

		for (let i = 0; i < 10; i++) {
			await executor.executeToolCall("ext-mtc-err__do", {}, "conv-mtc-err", `msg-${i + 100}`);
		}
		expect(_getToolCallsThisTurnForTests("conv-mtc-err")).toBe(10);
	});

	test("two parallel conversations don't share counters", async () => {
		ExtensionRegistry.resetInstance();
		const registry = ExtensionRegistry.getInstance();
		registry.registerToolForTest("ext-mtc4__do", {
			name: "ext-mtc4__do",
			originalName: "do",
			description: "test",
			inputSchema: { type: "object" },
			extensionId: "ext-mtc4",
			extensionName: "ext-mtc4",
		});
		const fakeProc = {
			callTool: async () => ({ content: [{ type: "text" as const, text: "ok" }], isError: false }),
			setNotificationHandler: () => {},
			setRequestHandler: () => {},
		};
		registry.getProcess = (async () => fakeProc) as never;
		registry.getManifest = (() => ({
			schemaVersion: 3,
			name: "ext-mtc4",
			version: "1.0.0",
			description: "t",
			author: { name: "t" },
			permissions: {},
			entrypoint: "./i.ts",
			tools: [{ name: "do", description: "t", inputSchema: { type: "object" }, capabilities: {} }],
		} as unknown as ReturnType<typeof registry.getManifest>)) as never;
		registry.getGrantedPermissions = (() => ({ grantedAt: {} })) as never;

		const engine = createStubPermissionEngine();
		const { bus } = makeBus();
		const executor = new ToolExecutor(registry, engine, { bus });

		for (let i = 0; i < MAX_TOOL_CALLS_PER_TURN; i++) {
			await executor.executeToolCall("ext-mtc4__do", {}, "conv-A", `msg-${i}`);
		}
		// conv-B has its own budget.
		for (let i = 0; i < MAX_TOOL_CALLS_PER_TURN; i++) {
			await executor.executeToolCall("ext-mtc4__do", {}, "conv-B", `msg-${i}`);
		}
		expect(_getToolCallsThisTurnForTests("conv-A")).toBe(MAX_TOOL_CALLS_PER_TURN);
		expect(_getToolCallsThisTurnForTests("conv-B")).toBe(MAX_TOOL_CALLS_PER_TURN);

		await expect(
			executor.executeToolCall("ext-mtc4__do", {}, "conv-A", "msg-X"),
		).rejects.toBeInstanceOf(MaxToolCallsExceededError);
		// conv-B is still at the cap, not over it; it's at its limit but
		// the next call hasn't been made.
		expect(_getToolCallsThisTurnForTests("conv-B")).toBe(MAX_TOOL_CALLS_PER_TURN);
	});

	test("MaxToolCallsExceededError names the conversationId + count", async () => {
		const err = new MaxToolCallsExceededError("conv-named", 11);
		expect(err.message).toContain("conv-named");
		expect(err.message).toContain("11");
		expect(err.conversationId).toBe("conv-named");
		expect(err.count).toBe(11);
	});
});

describe("parseMaxToolCallsPerTurn (pure env-parser)", () => {
	test("undefined (env unset) → 100 default", () => {
		expect(parseMaxToolCallsPerTurn(undefined)).toBe(100);
	});

	test("valid positive integer string → that value", () => {
		expect(parseMaxToolCallsPerTurn("250")).toBe(250);
	});

	test("valid positive float → Math.floor of it", () => {
		expect(parseMaxToolCallsPerTurn("150.9")).toBe(150);
	});

	test("NaN / non-numeric garbage → default", () => {
		expect(parseMaxToolCallsPerTurn("not-a-number")).toBe(100);
		expect(parseMaxToolCallsPerTurn("")).toBe(100);
		expect(parseMaxToolCallsPerTurn("12abc")).toBe(100);
	});

	test("zero → default (non-positive rejected)", () => {
		expect(parseMaxToolCallsPerTurn("0")).toBe(100);
	});

	test("negative → default (non-positive rejected)", () => {
		expect(parseMaxToolCallsPerTurn("-5")).toBe(100);
	});

	test("Infinity → default (not finite)", () => {
		expect(parseMaxToolCallsPerTurn("Infinity")).toBe(100);
	});
});
