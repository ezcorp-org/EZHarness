import { test, expect, describe, beforeEach, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());
import type { ToolDefinition, } from "../extensions/types";
import { ExtensionRegistry, type RegisteredTool } from "../extensions/registry";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";

// ── Mock DB layer (registry.loadFromDb calls listExtensions) ─────
mock.module("../db/queries/extensions", () => ({
	listExtensions: async () => [],
}));
mock.module("../db/connection", () => ({
	getDb: () => ({ insert: () => ({ values: async () => {} }) }),
}));

// ── Helpers ──────────────────────────────────────────────────────

function makeRegisteredTool(overrides: Partial<RegisteredTool> = {}): RegisteredTool {
	return {
		name: "task-stack.list-tasks",
		description: "List tasks",
		inputSchema: { type: "object", properties: {} },
		extensionId: "ext-1",
		extensionName: "task-stack",
		originalName: "list-tasks",
		...overrides,
	};
}

// ── Tests ────────────────────────────────────────────────────────

describe("ToolDefinition cardType field", () => {
	test("accepts cardType as optional field", () => {
		const tool: ToolDefinition = {
			name: "list-tasks",
			description: "List tasks",
			inputSchema: { type: "object" },
			cardType: "task-list",
		};
		expect(tool.cardType).toBe("task-list");
	});

	test("cardType is optional and defaults to undefined", () => {
		const tool: ToolDefinition = {
			name: "update-task",
			description: "Update a task",
			inputSchema: { type: "object" },
		};
		expect(tool.cardType).toBeUndefined();
	});
});

describe("ExtensionRegistry preserves cardType", () => {
	let registry: ExtensionRegistry;

	beforeEach(() => {
		ExtensionRegistry.resetInstance();
		registry = ExtensionRegistry.getInstance();
	});

	test("registerToolForTest stores cardType in toolMap", () => {
		const tool = makeRegisteredTool({ cardType: "task-list" });
		registry.registerToolForTest(tool.name, tool);

		const retrieved = registry.getRegisteredTool(tool.name);
		expect(retrieved).not.toBeNull();
		expect(retrieved!.cardType).toBe("task-list");
	});

	test("getRegisteredTool returns cardType for task-detail tool", () => {
		const tool = makeRegisteredTool({
			name: "task-stack.get-active-task",
			originalName: "get-active-task",
			cardType: "task-detail",
		});
		registry.registerToolForTest(tool.name, tool);

		const retrieved = registry.getRegisteredTool("task-stack.get-active-task");
		expect(retrieved!.cardType).toBe("task-detail");
	});

	test("getRegisteredTool returns undefined cardType when not set", () => {
		const tool = makeRegisteredTool({
			name: "task-stack.update-task",
			originalName: "update-task",
		});
		registry.registerToolForTest(tool.name, tool);

		const retrieved = registry.getRegisteredTool("task-stack.update-task");
		expect(retrieved!.cardType).toBeUndefined();
	});

	test("getAllTools includes cardType in returned definitions", () => {
		registry.registerToolForTest("task-stack.list-tasks", makeRegisteredTool({ cardType: "task-list" }));
		registry.registerToolForTest("task-stack.add-task", makeRegisteredTool({
			name: "task-stack.add-task",
			originalName: "add-task",
			cardType: "task-detail",
		}));
		registry.registerToolForTest("task-stack.update-task", makeRegisteredTool({
			name: "task-stack.update-task",
			originalName: "update-task",
		}));

		const tools = registry.getAllTools();
		const listTool = tools.find(t => t.name === "task-stack.list-tasks");
		const addTool = tools.find(t => t.name === "task-stack.add-task");
		const updateTool = tools.find(t => t.name === "task-stack.update-task");

		expect(listTool!.cardType).toBe("task-list");
		expect(addTool!.cardType).toBe("task-detail");
		expect(updateTool!.cardType).toBeUndefined();
	});
});

describe("ToolExecutor includes cardType in events", () => {
	let registry: ExtensionRegistry;

	beforeEach(() => {
		ExtensionRegistry.resetInstance();
		registry = ExtensionRegistry.getInstance();
	});

	test("tool:start event includes cardType from registered tool", async () => {
		const events: Array<{ name: string; data: any }> = [];
		const bus = {
			emit: (name: string, data: any) => events.push({ name, data }),
			on: () => () => {},
		};

		// Dynamic import to ensure mocks are applied
		const { ToolExecutor } = await import("../extensions/tool-executor");
		const executor = new ToolExecutor(registry, createStubPermissionEngine(), { bus: bus as any });

		// Register tool with cardType
		registry.registerToolForTest("task-stack.list-tasks", makeRegisteredTool({
			cardType: "task-list",
		}));

		// Set up manifest + install path so getProcess works (it will fail, but tool:start fires first)
		registry.setManifestForTest("ext-1", {
			schemaVersion: 2,
			name: "task-stack",
			version: "1.0.0",
			description: "test",
			author: { name: "test" },
			entrypoint: "./index.ts",
			permissions: {},
		});
		registry.setInstallPathForTest("ext-1", "/tmp/fake");
		registry.setGrantedPermsForTest("ext-1", { grantedAt: {} });

		// Execute will fail at getProcess (no real subprocess) but should still emit tool:start
		try {
			await executor.executeToolCall("task-stack.list-tasks", {}, "conv-1", "msg-1");
		} catch {
			// expected - no subprocess
		}

		const startEvent = events.find(e => e.name === "tool:start");
		expect(startEvent).toBeDefined();
		expect(startEvent!.data.cardType).toBe("task-list");
	});

	test("tool:start event omits cardType when not set on tool", async () => {
		const events: Array<{ name: string; data: any }> = [];
		const bus = {
			emit: (name: string, data: any) => events.push({ name, data }),
			on: () => () => {},
		};

		const { ToolExecutor } = await import("../extensions/tool-executor");
		const executor = new ToolExecutor(registry, createStubPermissionEngine(), { bus: bus as any });

		registry.registerToolForTest("task-stack.update-task", makeRegisteredTool({
			name: "task-stack.update-task",
			originalName: "update-task",
			// no cardType
		}));

		registry.setManifestForTest("ext-1", {
			schemaVersion: 2,
			name: "task-stack",
			version: "1.0.0",
			description: "test",
			author: { name: "test" },
			entrypoint: "./index.ts",
			permissions: {},
		});
		registry.setInstallPathForTest("ext-1", "/tmp/fake");
		registry.setGrantedPermsForTest("ext-1", { grantedAt: {} });

		try {
			await executor.executeToolCall("task-stack.update-task", {}, "conv-1", "msg-1");
		} catch {
			// expected
		}

		const startEvent = events.find(e => e.name === "tool:start");
		expect(startEvent).toBeDefined();
		expect(startEvent!.data.cardType).toBeUndefined();
	});
});

describe("task-stack ezcorp.config cardType declarations", () => {
	test("tools declare correct cardTypes", async () => {
		const config = (await import("../../docs/extensions/examples/task-stack/ezcorp.config")).default;
		const tools = config.tools as ToolDefinition[];

		const toolCardTypes: Record<string, string | undefined> = {};
		for (const t of tools) {
			toolCardTypes[t.name] = t.cardType;
		}

		// Tools that should have task-list cardType
		expect(toolCardTypes["list-stacks"]).toBe("task-list");
		expect(toolCardTypes["list-tasks"]).toBe("task-list");

		// Tools that should have task-detail cardType
		expect(toolCardTypes["get-top-task"]).toBe("task-detail");
		expect(toolCardTypes["add-task"]).toBe("task-detail");
		expect(toolCardTypes["get-active-task"]).toBe("task-detail");
		expect(toolCardTypes["finish-task"]).toBe("task-detail");

		// Tools that should NOT have a cardType (use default)
		expect(toolCardTypes["update-task"]).toBeUndefined();
		expect(toolCardTypes["move-task"]).toBeUndefined();
		expect(toolCardTypes["add-dependency"]).toBeUndefined();
		expect(toolCardTypes["add-subtask"]).toBeUndefined();
	});
});

describe("ToolExecutor setStateMediator wiring", () => {
	let registry: ExtensionRegistry;

	beforeEach(() => {
		ExtensionRegistry.resetInstance();
		registry = ExtensionRegistry.getInstance();
	});

	test("setStateMediator wires notification handler that calls mediator.handleNotification", async () => {
		const events: Array<{ name: string; data: any }> = [];
		const bus = {
			emit: (name: string, data: any) => events.push({ name, data }),
			on: () => () => {},
		};

		const { ToolExecutor } = await import("../extensions/tool-executor");
		const { ExtensionStateMediator } = await import("../extensions/state-mediator");

		const mediator = new ExtensionStateMediator(bus as any, (extId) => ({
			name: "test-ext",
			panel: { stateSchema: {} },
		}));

		const executor = new ToolExecutor(registry, createStubPermissionEngine(), { bus: bus as any });
		executor.setStateMediator(mediator);

		// Register a tool
		registry.registerToolForTest("test-ext.my-tool", makeRegisteredTool({
			name: "test-ext.my-tool",
			extensionId: "ext-mediator",
			extensionName: "test-ext",
			originalName: "my-tool",
		}));

		// Mock process that captures the notification handler
		let capturedNotifHandler: ((n: any) => void) | null = null;
		const fakeProc = {
			extensionId: "ext-mediator",
			isRunning: true,
			setNotificationHandler(handler: (n: any) => void) {
				capturedNotifHandler = handler;
			},
			setRequestHandler() {},
			callTool: async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
		};

		// Mock getProcess on registry
		registry.setManifestForTest("ext-mediator", {
			schemaVersion: 2,
			name: "test-ext",
			version: "1.0.0",
			description: "test",
			author: { name: "test" },
			entrypoint: "./index.ts",
			permissions: {},
			panel: { position: "bottom" as const, stateSchema: {} },
		});
		registry.setInstallPathForTest("ext-mediator", "/tmp/fake");
		registry.setGrantedPermsForTest("ext-mediator", { grantedAt: {} });

		// Override getProcess to return our fake
		const originalGetProcess = registry.getProcess.bind(registry);
		registry.getProcess = async () => fakeProc as any;

		try {
			await executor.executeToolCall("test-ext.my-tool", {}, "conv-1", "msg-1");

			// The notification handler should have been wired
			expect(capturedNotifHandler).not.toBeNull();

			// Simulate a notification from the extension
			capturedNotifHandler!({
				jsonrpc: "2.0",
				method: "ezcorp/state",
				params: { count: 42 },
			});

			// The mediator should have routed it to the bus as ext:state
			const stateEvent = events.find(e => e.name === "ext:state");
			expect(stateEvent).toBeDefined();
			expect(stateEvent!.data.extensionId).toBe("ext-mediator");
			expect(stateEvent!.data.state).toEqual({ count: 42 });
		} finally {
			registry.getProcess = originalGetProcess;
		}
	});

	test("setStateMediator can be called after construction (deferred wiring)", async () => {
		const { ToolExecutor } = await import("../extensions/tool-executor");
		const { ExtensionStateMediator } = await import("../extensions/state-mediator");

		const bus = {
			emit: () => {},
			on: () => () => {},
		};

		const executor = new ToolExecutor(registry, createStubPermissionEngine(), { bus: bus as any });

		// setStateMediator should not throw when called after construction
		const mediator = new ExtensionStateMediator(bus as any, () => undefined);
		expect(() => executor.setStateMediator(mediator)).not.toThrow();
	});
});
