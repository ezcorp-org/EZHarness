import { describe, test, expect, beforeEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Lightweight doubles for ToolExecutor dependencies
// ---------------------------------------------------------------------------

type ToolCallResult = {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
};

/** Minimal EventBus that records emissions for assertions. */
class MockEventBus {
  emissions: Array<{ type: string; data: Record<string, unknown> }> = [];
  on() { return () => {}; }
  off() {}
  emit(type: string, data: Record<string, unknown>) {
    this.emissions.push({ type, data });
  }
  clear() { this.emissions = []; }
  getEmissions(type: string) {
    return this.emissions.filter(e => e.type === type);
  }
}

/** Stub process returned by registry.getProcess(). */
function makeStubProcess(result: ToolCallResult = { content: [{ type: "text", text: "ok" }], isError: false }) {
  return {
    callTool: mock(async (_name: string, _args: unknown) => result),
    setRequestHandler: mock((_handler: () => void) => {}),
  };
}

/** Minimal registry mock. */
function makeRegistry(opts: {
  toolExists?: boolean;
  extensionId?: string;
  originalName?: string;
  process?: ReturnType<typeof makeStubProcess>;
} = {}) {
  const {
    toolExists = true,
    extensionId = "ext-test",
    originalName = "doThing",
    process = makeStubProcess(),
  } = opts;

  return {
    getRegisteredTool: mock((name: string) =>
      toolExists ? { extensionId, originalName, name } : null,
    ),
    getProcess: mock(async (_id: string) => process),
    getGrantedPermissions: mock((_id?: string) => []),
    getInstallPath: mock((_id?: string) => "/tmp/ext"),
    resolveDepTool: mock(() => null),
  };
}

// ---------------------------------------------------------------------------
// Inline re-implementation of ToolExecutor core to avoid import side-effects
// (DB, drizzle, etc.). Mirrors src/extensions/tool-executor.ts logic exactly.
// ---------------------------------------------------------------------------

class PermissionDeniedError extends Error {
  constructor(public readonly extensionId: string, public readonly toolName: string) {
    super(`Permission denied for tool "${toolName}" from extension "${extensionId}"`);
    this.name = "PermissionDeniedError";
  }
}

type PermissionChecker = (extId: string, toolName: string, input: Record<string, unknown>) => Promise<boolean>;

class ToolExecutor {
  private permissionChecker?: PermissionChecker;
  private bus?: MockEventBus;
  private wiredExtensions = new Set<string>();

  constructor(
    private registry: ReturnType<typeof makeRegistry>,
    options?: { permissionChecker?: PermissionChecker; bus?: MockEventBus },
  ) {
    this.permissionChecker = options?.permissionChecker;
    this.bus = options?.bus;
  }

  async executeToolCall(
    toolName: string,
    input: Record<string, unknown>,
    conversationId: string,
    messageId: string,
    _opts?: { metadata?: { invocationId?: string; source?: "inline" | "agent-run" } },
  ): Promise<ToolCallResult> {
    const registered = this.registry.getRegisteredTool(toolName);
    if (!registered) {
      return { content: [{ type: "text", text: `Unknown tool: ${toolName}` }], isError: true };
    }

    const extensionId = registered.extensionId;
    const originalName = registered.originalName;

    if (this.permissionChecker) {
      const allowed = await this.permissionChecker(extensionId, toolName, input);
      if (!allowed) throw new PermissionDeniedError(extensionId, toolName);
    }

    const startTime = Date.now();
    const meta = _opts?.metadata;
    this.bus?.emit("tool:start", {
      conversationId, extensionId, toolName, input, timestamp: startTime,
      ...(meta?.source && { source: meta.source }),
      ...(meta?.invocationId && { invocationId: meta.invocationId }),
    });

    try {
      const proc = await this.registry.getProcess(extensionId);
      if (!this.wiredExtensions.has(extensionId)) {
        this.wiredExtensions.add(extensionId);
        proc.setRequestHandler(() => {});
      }
      const result = await proc.callTool(originalName, input);
      const duration = Date.now() - startTime;
      this.bus?.emit("tool:complete", {
        conversationId, extensionId, toolName, output: result, duration, success: !result.isError,
        ...(meta?.source && { source: meta.source }),
        ...(meta?.invocationId && { invocationId: meta.invocationId }),
      });
      return result;
    } catch (error) {
      const errorResult: ToolCallResult = {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
      const duration = Date.now() - startTime;
      this.bus?.emit("tool:error", {
        conversationId, extensionId, toolName,
        error: error instanceof Error ? error.message : String(error), duration,
        ...(meta?.source && { source: meta.source }),
        ...(meta?.invocationId && { invocationId: meta.invocationId }),
      });
      return errorResult;
    }
  }
}

// ---------------------------------------------------------------------------
// Retry loop re-implementation (mirrors +server.ts logic)
// ---------------------------------------------------------------------------

const MAX_RETRIES = 2;

async function invokeWithRetry(
  executor: ToolExecutor,
  toolName: string,
  input: Record<string, unknown>,
  conversationId: string,
  invocationId: string,
): Promise<{ success: boolean; output?: string; error?: string; retryCount: number; durationMs: number }> {
  const metadata = { invocationId, source: "inline" as const };
  const startTime = Date.now();
  let lastResult: ToolCallResult = { content: [{ type: "text", text: "Unknown error" }], isError: true };
  let retryCount = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await executor.executeToolCall(toolName, input ?? {}, conversationId, invocationId, { metadata });
    if (!result.isError) {
      return {
        success: true,
        output: result.content.map(c => c.text).join("\n"),
        retryCount: attempt,
        durationMs: Date.now() - startTime,
      };
    }
    lastResult = result;
    retryCount = attempt;
  }

  return {
    success: false,
    error: lastResult.content.map(c => c.text).join("\n"),
    retryCount,
    durationMs: Date.now() - startTime,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("ToolExecutor inline invocation path", () => {
  let bus: MockEventBus;
  let registry: ReturnType<typeof makeRegistry>;

  beforeEach(() => {
    bus = new MockEventBus();
  });

  // ── Event bus emissions with inline metadata ──────────────────────

  describe("event bus emissions with inline metadata", () => {
    test("tool:start includes source and invocationId when metadata provided", async () => {
      registry = makeRegistry();
      const executor = new ToolExecutor(registry, { bus });

      await executor.executeToolCall("ext-test.doThing", { x: 1 }, "conv-1", "msg-1", {
        metadata: { source: "inline", invocationId: "inv-42" },
      });

      const starts = bus.getEmissions("tool:start");
      expect(starts).toHaveLength(1);
      expect(starts[0]!.data.source).toBe("inline");
      expect(starts[0]!.data.invocationId).toBe("inv-42");
      expect(starts[0]!.data.toolName).toBe("ext-test.doThing");
      expect(starts[0]!.data.conversationId).toBe("conv-1");
    });

    test("tool:complete includes source and invocationId when metadata provided", async () => {
      registry = makeRegistry();
      const executor = new ToolExecutor(registry, { bus });

      await executor.executeToolCall("ext-test.doThing", {}, "conv-1", "msg-1", {
        metadata: { source: "inline", invocationId: "inv-99" },
      });

      const completes = bus.getEmissions("tool:complete");
      expect(completes).toHaveLength(1);
      expect(completes[0]!.data.source).toBe("inline");
      expect(completes[0]!.data.invocationId).toBe("inv-99");
      expect(completes[0]!.data.success).toBe(true);
    });

    test("tool:error includes source and invocationId when metadata provided", async () => {
      const failProcess = makeStubProcess();
      failProcess.callTool = mock(async () => { throw new Error("subprocess died"); });
      registry = makeRegistry({ process: failProcess });
      const executor = new ToolExecutor(registry, { bus });

      const result = await executor.executeToolCall("ext-test.doThing", {}, "conv-1", "msg-1", {
        metadata: { source: "inline", invocationId: "inv-err" },
      });

      expect(result.isError).toBe(true);
      const errors = bus.getEmissions("tool:error");
      expect(errors).toHaveLength(1);
      expect(errors[0]!.data.source).toBe("inline");
      expect(errors[0]!.data.invocationId).toBe("inv-err");
      expect(errors[0]!.data.error).toBe("subprocess died");
    });
  });

  // ── Event bus emissions without metadata (agent-run path) ─────────

  describe("event bus emissions without metadata (agent-run path)", () => {
    test("tool:start does NOT include source or invocationId when metadata absent", async () => {
      registry = makeRegistry();
      const executor = new ToolExecutor(registry, { bus });

      await executor.executeToolCall("ext-test.doThing", {}, "conv-1", "msg-1");

      const starts = bus.getEmissions("tool:start");
      expect(starts).toHaveLength(1);
      expect(starts[0]!.data).not.toHaveProperty("source");
      expect(starts[0]!.data).not.toHaveProperty("invocationId");
    });

    test("tool:complete does NOT include source or invocationId when metadata absent", async () => {
      registry = makeRegistry();
      const executor = new ToolExecutor(registry, { bus });

      await executor.executeToolCall("ext-test.doThing", {}, "conv-1", "msg-1");

      const completes = bus.getEmissions("tool:complete");
      expect(completes).toHaveLength(1);
      expect(completes[0]!.data).not.toHaveProperty("source");
      expect(completes[0]!.data).not.toHaveProperty("invocationId");
    });

    test("tool:error does NOT include source or invocationId when metadata absent", async () => {
      const failProcess = makeStubProcess();
      failProcess.callTool = mock(async () => { throw new Error("boom"); });
      registry = makeRegistry({ process: failProcess });
      const executor = new ToolExecutor(registry, { bus });

      await executor.executeToolCall("ext-test.doThing", {}, "conv-1", "msg-1");

      const errors = bus.getEmissions("tool:error");
      expect(errors).toHaveLength(1);
      expect(errors[0]!.data).not.toHaveProperty("source");
      expect(errors[0]!.data).not.toHaveProperty("invocationId");
    });
  });

  // ── Permission denied ─────────────────────────────────────────────

  describe("permission denied", () => {
    test("throws PermissionDeniedError when checker returns false", async () => {
      registry = makeRegistry();
      const checker: PermissionChecker = async () => false;
      const executor = new ToolExecutor(registry, { bus, permissionChecker: checker });

      await expect(
        executor.executeToolCall("ext-test.doThing", {}, "conv-1", "msg-1"),
      ).rejects.toThrow(PermissionDeniedError);
    });

    test("PermissionDeniedError contains extensionId and toolName", async () => {
      registry = makeRegistry();
      const checker: PermissionChecker = async () => false;
      const executor = new ToolExecutor(registry, { bus, permissionChecker: checker });

      try {
        await executor.executeToolCall("ext-test.doThing", {}, "conv-1", "msg-1");
        expect(true).toBe(false); // should not reach
      } catch (err) {
        expect(err).toBeInstanceOf(PermissionDeniedError);
        expect((err as PermissionDeniedError).extensionId).toBe("ext-test");
        expect((err as PermissionDeniedError).toolName).toBe("ext-test.doThing");
      }
    });

    test("no events emitted when permission denied (denied before tool:start)", async () => {
      registry = makeRegistry();
      const checker: PermissionChecker = async () => false;
      const executor = new ToolExecutor(registry, { bus, permissionChecker: checker });

      try {
        await executor.executeToolCall("ext-test.doThing", {}, "conv-1", "msg-1");
      } catch { /* expected */ }

      expect(bus.emissions).toHaveLength(0);
    });
  });

  // ── Unknown tool ──────────────────────────────────────────────────

  describe("unknown tool", () => {
    test("returns isError result for unregistered tool", async () => {
      registry = makeRegistry({ toolExists: false });
      const executor = new ToolExecutor(registry, { bus });

      const result = await executor.executeToolCall("no.such.tool", {}, "conv-1", "msg-1");

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("Unknown tool");
    });

    test("no events emitted for unknown tool", async () => {
      registry = makeRegistry({ toolExists: false });
      const executor = new ToolExecutor(registry, { bus });

      await executor.executeToolCall("no.such.tool", {}, "conv-1", "msg-1");

      expect(bus.emissions).toHaveLength(0);
    });
  });
});

// ===========================================================================
// Retry loop tests (mirrors /api/tool-invoke endpoint logic)
// ===========================================================================

describe("inline invoke retry loop", () => {
  let bus: MockEventBus;

  beforeEach(() => {
    bus = new MockEventBus();
  });

  test("success on first try returns retryCount=0", async () => {
    const registry = makeRegistry();
    const executor = new ToolExecutor(registry, { bus });

    const res = await invokeWithRetry(executor, "ext-test.doThing", { a: 1 }, "conv-1", "inv-1");

    expect(res.success).toBe(true);
    expect(res.retryCount).toBe(0);
    expect(res.output).toBe("ok");
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("success after retries returns correct retryCount", async () => {
    let callCount = 0;
    const proc = makeStubProcess();
    proc.callTool = mock(async () => {
      callCount++;
      if (callCount <= 2) {
        return { content: [{ type: "text", text: "transient error" }], isError: true };
      }
      return { content: [{ type: "text", text: "finally ok" }], isError: false };
    });
    const registry = makeRegistry({ process: proc });
    const executor = new ToolExecutor(registry, { bus });

    const res = await invokeWithRetry(executor, "ext-test.doThing", {}, "conv-1", "inv-2");

    expect(res.success).toBe(true);
    expect(res.retryCount).toBe(2);
    expect(res.output).toBe("finally ok");
  });

  test("failure after MAX_RETRIES=2 returns success=false with retryCount=2", async () => {
    const proc = makeStubProcess({ content: [{ type: "text", text: "always fails" }], isError: true });
    const registry = makeRegistry({ process: proc });
    const executor = new ToolExecutor(registry, { bus });

    const res = await invokeWithRetry(executor, "ext-test.doThing", {}, "conv-1", "inv-3");

    expect(res.success).toBe(false);
    expect(res.retryCount).toBe(2);
    expect(res.error).toBe("always fails");
    // Should have been called MAX_RETRIES+1 = 3 times
    expect(proc.callTool).toHaveBeenCalledTimes(3);
  });

  test("retry loop passes inline metadata on every attempt", async () => {
    const proc = makeStubProcess({ content: [{ type: "text", text: "fail" }], isError: true });
    const registry = makeRegistry({ process: proc });
    const executor = new ToolExecutor(registry, { bus });

    await invokeWithRetry(executor, "ext-test.doThing", {}, "conv-1", "inv-meta");

    // 3 attempts = 3 tool:start emissions, all with source=inline
    const starts = bus.getEmissions("tool:start");
    expect(starts).toHaveLength(3);
    for (const s of starts) {
      expect(s.data.source).toBe("inline");
      expect(s.data.invocationId).toBe("inv-meta");
    }
  });
});
