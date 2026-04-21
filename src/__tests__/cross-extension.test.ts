import { test, expect, describe, mock, beforeEach } from "bun:test";
import { JsonRpcTransport } from "../extensions/json-rpc";
import { ExtensionProcess } from "../extensions/subprocess";
import { ExtensionRegistry, type RegisteredTool } from "../extensions/registry";
import { ToolExecutor } from "../extensions/tool-executor";
import { parseArgs } from "../cli";
import type { JsonRpcRequest, JsonRpcResponse, ExtensionManifestV2, DependencySpec } from "../extensions/types";

// ── Helpers ──────────────────────────────────────────────────────────

function makeManifest(
  name: string,
  version: string,
  opts?: {
    deps?: Record<string, DependencySpec>;
    tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
    entrypoint?: string;
  },
): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name,
    version,
    description: `${name} extension`,
    author: { name: "test" },
    permissions: {},
    entrypoint: opts?.entrypoint ?? "./index.ts",
    tools: opts?.tools ?? [{ name: "doStuff", description: "does stuff", inputSchema: { type: "object" } }],
    ...(opts?.deps ? { dependencies: opts.deps } : {}),
  };
}

// ── JsonRpcTransport: request detection ─────────────────────────────

describe("JsonRpcTransport request detection", () => {
  test("detects incoming request (has method + id) and calls onRequest", async () => {
    // Create a transport with mock stdin/stdout
    const written: string[] = [];
    const mockStdin = {
      write(data: string | Uint8Array) {
        written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
        return typeof data === "string" ? data.length : data.length;
      },
    };

    // Create a readable stream that emits a JSON-RPC request
    const request: JsonRpcRequest = { jsonrpc: "2.0", id: 1, method: "ezcorp/invoke", params: { tool: "dep.doStuff" } };
    const encoded = JSON.stringify(request) + "\n";

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(encoded));
        controller.close();
      },
    });

    const transport = new JsonRpcTransport(mockStdin, stream);

    const receivedRequests: JsonRpcRequest[] = [];
    transport.onRequest = (req) => receivedRequests.push(req);
    transport.startReading();

    // Wait for stream processing
    await new Promise((r) => setTimeout(r, 50));

    expect(receivedRequests.length).toBe(1);
    expect(receivedRequests[0]!.method).toBe("ezcorp/invoke");
    expect(receivedRequests[0]!.id).toBe(1);
  });

  test("still routes responses (has id, no method) to responseCallbacks", async () => {
    const mockStdin = {
      write(data: string | Uint8Array) {
        return typeof data === "string" ? data.length : data.length;
      },
    };

    const response: JsonRpcResponse = { jsonrpc: "2.0", id: 42, result: { ok: true } };
    const encoded = JSON.stringify(response) + "\n";

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Delay to let send() register the callback first
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(encoded));
          controller.close();
        }, 10);
      },
    });

    const transport = new JsonRpcTransport(mockStdin, stream);
    transport.startReading();

    // Create a request with id=42 so its callback gets fired
    const resultPromise = transport.send({ jsonrpc: "2.0", id: 42, method: "test", params: {} });

    const result = await resultPromise;
    expect(result.result).toEqual({ ok: true });
  });

  test("distinguishes requests from responses in mixed stream", async () => {
    const mockStdin = {
      write(data: string | Uint8Array) {
        return typeof data === "string" ? data.length : data.length;
      },
    };

    const incomingRequest: JsonRpcRequest = { jsonrpc: "2.0", id: 100, method: "ezcorp/invoke", params: {} };
    const incomingResponse: JsonRpcResponse = { jsonrpc: "2.0", id: 99, result: "hello" };
    const encoded = JSON.stringify(incomingRequest) + "\n" + JSON.stringify(incomingResponse) + "\n";

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(encoded));
          controller.close();
        }, 10);
      },
    });

    const transport = new JsonRpcTransport(mockStdin, stream);
    const receivedRequests: JsonRpcRequest[] = [];
    transport.onRequest = (req) => receivedRequests.push(req);
    transport.startReading();

    // Register a pending response callback for id 99
    const responsePromise = transport.send({ jsonrpc: "2.0", id: 99, method: "test", params: {} });

    const response = await responsePromise;
    expect(response.result).toBe("hello");
    expect(receivedRequests.length).toBe(1);
    expect(receivedRequests[0]!.method).toBe("ezcorp/invoke");
  });
});

// ── ExtensionProcess: setRequestHandler ─────────────────────────────

describe("ExtensionProcess.setRequestHandler", () => {
  test("setRequestHandler exists on ExtensionProcess", () => {
    const proc = new ExtensionProcess("test-ext", "/tmp/ext/index.ts", {}, { callTimeoutMs: 1000 });
    expect(typeof proc.setRequestHandler).toBe("function");
    proc.kill();
  });
});

// ── Registry: resolveDepTool & buildDepRoutes ──────────────────────

describe("Registry dependency routing", () => {
  test("resolveDepTool returns correct tool for declared dependency", () => {
    const registry = ExtensionRegistry.getInstance();

    // Manually set up the dep routes for testing
    // (In real code, buildDepRoutes does this from DB data)
    registry.setDepRoutes(new Map([
      ["caller-ext", new Map([["dep-pkg", "dep-ext-id"]])],
    ]));

    // Manually register a tool for dep-ext-id
    registry.registerToolForTest("dep-pkg__doStuff", {
      name: "dep-pkg__doStuff",
      originalName: "doStuff",
      description: "does stuff",
      inputSchema: { type: "object" },
      extensionId: "dep-ext-id",
      extensionName: "dep-pkg",
    });

    const result = registry.resolveDepTool("caller-ext", "dep-pkg__doStuff");
    expect(result).not.toBeNull();
    expect(result!.extensionId).toBe("dep-ext-id");
    expect(result!.originalName).toBe("doStuff");

    ExtensionRegistry.resetInstance();
  });

  test("resolveDepTool returns null for undeclared dependency", () => {
    const registry = ExtensionRegistry.getInstance();

    // Caller has no declared deps
    registry.setDepRoutes(new Map());

    const result = registry.resolveDepTool("caller-ext", "unknown-pkg__doStuff");
    expect(result).toBeNull();

    ExtensionRegistry.resetInstance();
  });

  test("buildDepRoutes populates routes from manifests", () => {
    const registry = ExtensionRegistry.getInstance();

    // Set up manifests and tools manually for testing buildDepRoutes
    const callerManifest = makeManifest("caller", "1.0.0", {
      deps: { "dep-pkg": { source: "github:test/dep", version: "^1.0.0" } },
    });
    const depManifest = makeManifest("dep-pkg", "1.2.0");

    registry.setManifestForTest("caller-id", callerManifest);
    registry.setManifestForTest("dep-id", depManifest);
    registry.registerToolForTest("dep-pkg__doStuff", {
      name: "dep-pkg__doStuff",
      originalName: "doStuff",
      description: "does stuff",
      inputSchema: { type: "object" },
      extensionId: "dep-id",
      extensionName: "dep-pkg",
    });

    registry.buildDepRoutes();

    const result = registry.resolveDepTool("caller-id", "dep-pkg__doStuff");
    expect(result).not.toBeNull();
    expect(result!.extensionId).toBe("dep-id");

    ExtensionRegistry.resetInstance();
  });
});

// ── ToolExecutor: handlePiInvoke ────────────────────────────────────

describe("ToolExecutor.handlePiInvoke", () => {
  beforeEach(() => {
    ExtensionRegistry.resetInstance();
  });

  test("routes cross-ext call through executeToolCall", async () => {
    const registry = ExtensionRegistry.getInstance();

    // Set up dep route
    registry.setDepRoutes(new Map([
      ["caller-ext", new Map([["dep-pkg", "dep-ext-id"]])],
    ]));

    registry.registerToolForTest("dep-pkg__doStuff", {
      name: "dep-pkg__doStuff",
      originalName: "doStuff",
      description: "does stuff",
      inputSchema: { type: "object" },
      extensionId: "dep-ext-id",
      extensionName: "dep-pkg",
    });

    // Mock the executor's internal executeToolCall to avoid subprocess
    const executor = new ToolExecutor(registry);
    const calls: Array<{ toolName: string; callerExtensionId?: string }> = [];

    // Override executeToolCall to capture calls
    const origExecute = executor.executeToolCall.bind(executor);
    executor.executeToolCall = async (toolName, input, conversationId, messageId, opts?) => {
      calls.push({ toolName, callerExtensionId: opts?.callerExtensionId });
      return { content: [{ type: "text" as const, text: "result" }], isError: false };
    };

    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "ezcorp/invoke",
      params: { tool: "dep-pkg__doStuff", arguments: { x: 1 } },
    };

    const response = await executor.handlePiInvoke("caller-ext", req);
    expect(response.result).toBeDefined();
    expect(calls.length).toBe(1);
    expect(calls[0]!.toolName).toBe("dep-pkg__doStuff");
    expect(calls[0]!.callerExtensionId).toBe("caller-ext");
  });

  test("rejects undeclared dependency call", async () => {
    const registry = ExtensionRegistry.getInstance();
    registry.setDepRoutes(new Map());

    const executor = new ToolExecutor(registry);

    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "ezcorp/invoke",
      params: { tool: "unknown-pkg__doStuff", arguments: {} },
    };

    const response = await executor.handlePiInvoke("caller-ext", req);
    expect(response.error).toBeDefined();
    expect(response.error!.message).toContain("Dependency not declared");
  });

  test("rejects call at depth >= 10", async () => {
    const registry = ExtensionRegistry.getInstance();
    registry.setDepRoutes(new Map([
      ["caller-ext", new Map([["dep-pkg", "dep-ext-id"]])],
    ]));
    registry.registerToolForTest("dep-pkg__doStuff", {
      name: "dep-pkg__doStuff",
      originalName: "doStuff",
      description: "does stuff",
      inputSchema: { type: "object" },
      extensionId: "dep-ext-id",
      extensionName: "dep-pkg",
    });

    const executor = new ToolExecutor(registry);

    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "ezcorp/invoke",
      params: { tool: "dep-pkg__doStuff", arguments: {}, _depth: 10 },
    };

    const response = await executor.handlePiInvoke("caller-ext", req);
    expect(response.error).toBeDefined();
    expect(response.error!.message).toContain("depth");
  });

  test("callerExtensionId is passed to executeToolCall", async () => {
    const registry = ExtensionRegistry.getInstance();
    registry.setDepRoutes(new Map([
      ["caller-ext", new Map([["dep-pkg", "dep-ext-id"]])],
    ]));
    registry.registerToolForTest("dep-pkg__doStuff", {
      name: "dep-pkg__doStuff",
      originalName: "doStuff",
      description: "does stuff",
      inputSchema: { type: "object" },
      extensionId: "dep-ext-id",
      extensionName: "dep-pkg",
    });

    const executor = new ToolExecutor(registry);
    let capturedOpts: any = null;
    executor.executeToolCall = async (_tn, _in, _cid, _mid, opts?) => {
      capturedOpts = opts;
      return { content: [{ type: "text" as const, text: "ok" }], isError: false };
    };

    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "ezcorp/invoke",
      params: { tool: "dep-pkg__doStuff", arguments: {} },
    };

    await executor.handlePiInvoke("caller-ext", req);
    expect(capturedOpts?.callerExtensionId).toBe("caller-ext");
  });
});

// ── Registry: resolveDepTool edge cases ─────────────────────────────

describe("resolveDepTool edge cases", () => {
  beforeEach(() => {
    ExtensionRegistry.resetInstance();
  });

  test("non-namespaced tool name (no dot) returns null", () => {
    const registry = ExtensionRegistry.getInstance();
    registry.setDepRoutes(new Map([
      ["caller-ext", new Map([["dep-pkg", "dep-ext-id"]])],
    ]));

    const result = registry.resolveDepTool("caller-ext", "noDotsHere");
    expect(result).toBeNull();
  });

  test("buildDepRoutes with no dependencies in any manifest produces empty routes", () => {
    const registry = ExtensionRegistry.getInstance();

    // Two manifests, neither has dependencies
    registry.setManifestForTest("ext-a", makeManifest("ext-a", "1.0.0"));
    registry.setManifestForTest("ext-b", makeManifest("ext-b", "2.0.0"));

    registry.buildDepRoutes();

    // Neither should have dep routes
    const resultA = registry.resolveDepTool("ext-a", "ext-b__doStuff");
    expect(resultA).toBeNull();
    const resultB = registry.resolveDepTool("ext-b", "ext-a__doStuff");
    expect(resultB).toBeNull();
  });
});

// ── ToolExecutor.handlePiInvoke edge cases ──────────────────────────

describe("ToolExecutor.handlePiInvoke edge cases", () => {
  beforeEach(() => {
    ExtensionRegistry.resetInstance();
  });

  test("executeToolCall throws returns JSON-RPC error", async () => {
    const registry = ExtensionRegistry.getInstance();

    registry.setDepRoutes(new Map([
      ["caller-ext", new Map([["dep-pkg", "dep-ext-id"]])],
    ]));
    registry.registerToolForTest("dep-pkg__doStuff", {
      name: "dep-pkg__doStuff",
      originalName: "doStuff",
      description: "does stuff",
      inputSchema: { type: "object" },
      extensionId: "dep-ext-id",
      extensionName: "dep-pkg",
    });

    const executor = new ToolExecutor(registry);
    executor.executeToolCall = async () => {
      throw new Error("Subprocess crashed");
    };

    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "ezcorp/invoke",
      params: { tool: "dep-pkg__doStuff", arguments: { x: 1 } },
    };

    const response = await executor.handlePiInvoke("caller-ext", req);
    expect(response.error).toBeDefined();
    expect(response.error!.message).toContain("Subprocess crashed");
    expect(response.error!.code).toBe(-32000);
    expect(response.result).toBeUndefined();
  });

  test("missing tool parameter in params throws TypeError", async () => {
    const registry = ExtensionRegistry.getInstance();
    registry.setDepRoutes(new Map());

    const executor = new ToolExecutor(registry);

    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "ezcorp/invoke",
      params: { arguments: { x: 1 } }, // no `tool` key
    };

    // tool is undefined → resolveDepTool receives undefined → throws TypeError
    await expect(executor.handlePiInvoke("caller-ext", req)).rejects.toThrow(TypeError);
  });

  test("missing arguments parameter defaults to empty object", async () => {
    const registry = ExtensionRegistry.getInstance();

    registry.setDepRoutes(new Map([
      ["caller-ext", new Map([["dep-pkg", "dep-ext-id"]])],
    ]));
    registry.registerToolForTest("dep-pkg__doStuff", {
      name: "dep-pkg__doStuff",
      originalName: "doStuff",
      description: "does stuff",
      inputSchema: { type: "object" },
      extensionId: "dep-ext-id",
      extensionName: "dep-pkg",
    });

    const executor = new ToolExecutor(registry);
    let capturedInput: Record<string, unknown> = {};
    executor.executeToolCall = async (_tn, input, _cid, _mid, _opts?) => {
      capturedInput = input;
      return { content: [{ type: "text" as const, text: "ok" }], isError: false };
    };

    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "ezcorp/invoke",
      params: { tool: "dep-pkg__doStuff" }, // no `arguments` key
    };

    const response = await executor.handlePiInvoke("caller-ext", req);
    expect(response.result).toBeDefined();
    expect(capturedInput).toEqual({});
  });

  test("depth just below limit (depth=9) succeeds", async () => {
    const registry = ExtensionRegistry.getInstance();

    registry.setDepRoutes(new Map([
      ["caller-ext", new Map([["dep-pkg", "dep-ext-id"]])],
    ]));
    registry.registerToolForTest("dep-pkg__doStuff", {
      name: "dep-pkg__doStuff",
      originalName: "doStuff",
      description: "does stuff",
      inputSchema: { type: "object" },
      extensionId: "dep-ext-id",
      extensionName: "dep-pkg",
    });

    const executor = new ToolExecutor(registry);
    executor.executeToolCall = async () => {
      return { content: [{ type: "text" as const, text: "ok" }], isError: false };
    };

    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "ezcorp/invoke",
      params: { tool: "dep-pkg__doStuff", arguments: {}, _depth: 9 },
    };

    // depth=9 < MAX_CALL_DEPTH(10), so it should succeed
    const response = await executor.handlePiInvoke("caller-ext", req);
    expect(response.result).toBeDefined();
    expect(response.error).toBeUndefined();
  });
});

// ── CLI: parseArgs lifecycle flags ──────────────────────────────────

describe("CLI parseArgs dependency flags", () => {
  test("ext:remove parses --force flag", () => {
    const parsed = parseArgs(["ext", "remove", "my-ext", "--force"]);
    expect(parsed.command).toBe("ext:remove");
    expect(parsed.extName).toBe("my-ext");
    expect(parsed.force).toBe(true);
  });

  test("ext:remove without --force defaults to false", () => {
    const parsed = parseArgs(["ext", "remove", "my-ext"]);
    expect(parsed.command).toBe("ext:remove");
    expect(parsed.force).toBe(false);
  });

  test("ext:install parses --yes flag", () => {
    const parsed = parseArgs(["ext", "install", "github:user/repo", "--yes"]);
    expect(parsed.command).toBe("ext:install");
    expect(parsed.source).toBe("github:user/repo");
    expect(parsed.autoApprove).toBe(true);
  });
});

// ── CLI: dependency-aware behavior (unit tests for logic) ───────────

describe("CLI dependency lifecycle logic", () => {
  test("dependent detection finds extensions with declared dependencies", () => {
    // This tests the logic pattern used in ext:remove
    const allExts = [
      {
        name: "consumer",
        manifest: makeManifest("consumer", "1.0.0", {
          deps: { "provider": { source: "github:test/provider", version: "^1.0.0" } },
        }),
      },
      {
        name: "standalone",
        manifest: makeManifest("standalone", "1.0.0"),
      },
    ];

    const targetName = "provider";
    const dependents: string[] = [];
    for (const other of allExts) {
      const otherManifest = other.manifest as ExtensionManifestV2;
      if (otherManifest.dependencies && targetName in otherManifest.dependencies) {
        dependents.push(other.name);
      }
    }

    expect(dependents).toEqual(["consumer"]);
  });

  test("no dependents found for extension not depended on", () => {
    const allExts = [
      {
        name: "standalone-a",
        manifest: makeManifest("standalone-a", "1.0.0"),
      },
      {
        name: "standalone-b",
        manifest: makeManifest("standalone-b", "1.0.0"),
      },
    ];

    const targetName = "standalone-a";
    const dependents: string[] = [];
    for (const other of allExts) {
      const otherManifest = other.manifest as ExtensionManifestV2;
      if (otherManifest.dependencies && targetName in otherManifest.dependencies) {
        dependents.push(other.name);
      }
    }

    expect(dependents).toEqual([]);
  });

  test("ext:list Deps column shows dependency count", () => {
    const manifest = makeManifest("my-ext", "1.0.0", {
      deps: {
        "dep-a": { source: "github:test/a", version: "^1.0.0" },
        "dep-b": { source: "github:test/b", version: "^2.0.0" },
      },
    });
    const depCount = manifest.dependencies ? Object.keys(manifest.dependencies).length : 0;
    expect(depCount).toBe(2);
  });

  test("ext:info dependency satisfaction check", () => {
    // satisfiesRange is tested thoroughly in dependency-resolver.test.ts
    // This just verifies the integration pattern
    const { satisfiesRange } = require("../extensions/manifest");

    expect(satisfiesRange("1.2.0", "^1.0.0")).toBe(true);
    expect(satisfiesRange("2.0.0", "^1.0.0")).toBe(false);
    expect(satisfiesRange("1.0.0", "1.0.0")).toBe(true);
  });
});
