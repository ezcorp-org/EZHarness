/**
 * Resolved-attachment payload redaction at the emit + persist boundaries.
 *
 * The args resolver substitutes `ez-attachment://` handles with real
 * `data:<mime>;base64,…` URIs BEFORE dispatch. This suite locks the fix
 * for the multi-MB leak that followed:
 *
 *   - the `tool:start` bus event carries the REDACTED input
 *     (`[data:<mime>;<n> bytes]` marker, never the base64 bulk),
 *   - the persisted `tool_calls.input` row is REDACTED the same way
 *     (single write site: `persistToolCall`),
 *   - the subprocess still receives the REAL resolved data URI
 *     (execution is never redacted),
 *   - small / non-data inputs pass through both boundaries untouched.
 *
 * `persistToolCall` is observed via mock.module BEFORE the tool-executor
 * import (materialization-order pattern shared with
 * dispatcher-provenance.test.ts).
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";
import type { ExtensionRegistry, RegisteredTool } from "../extensions/registry";
import type { ExtensionManifestV2, ToolCallResult } from "../extensions/types";
import type { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";

interface PersistedRow {
  input: Record<string, unknown>;
  toolName: string;
  extensionId: string;
}

const persisted: PersistedRow[] = [];
mock.module("../db/queries/tool-calls", () => ({
  persistToolCall: async (row: PersistedRow) => {
    persisted.push(row);
  },
  listToolCallOutputsForMessages: async () => [],
  listToolCallsByConversation: async () => [],
  getToolCallConversationById: async () => null,
}));

const { ToolExecutor } = await import("../extensions/tool-executor");

// ── In-memory harness (mirrors ext-registry-executor.test.ts) ────────

const EXT_ID = "redact-ext";
const TOOL = "redact-ext__echo";

function makeManifest(): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: EXT_ID,
    version: "1.0.0",
    description: "t",
    author: { name: "t" },
    entrypoint: "./index.ts",
    permissions: {},
    tools: [{ name: "echo", description: "echo", inputSchema: { type: "object" } }],
  } as unknown as ExtensionManifestV2;
}

function makeTool(): RegisteredTool {
  return {
    name: TOOL,
    description: "echo",
    inputSchema: { type: "object" },
    extensionId: EXT_ID,
    extensionName: EXT_ID,
    originalName: "echo",
  } as unknown as RegisteredTool;
}

function makeProc(calls: Array<Record<string, unknown>>) {
  const result: ToolCallResult = { content: [{ type: "text", text: "ok" }], isError: false };
  return {
    callTool: async (_name: string, args: Record<string, unknown>) => {
      calls.push(args);
      return result;
    },
    setRequestHandler: () => {},
    setNotificationHandler: () => {},
    isRunning: true,
  };
}

function makeRegistry(proc: ReturnType<typeof makeProc>): ExtensionRegistry {
  const tool = makeTool();
  const manifest = makeManifest();
  return {
    getRegisteredTool: (name: string) => (name === TOOL ? tool : null),
    getProcess: async () => proc,
    getGrantedPermissions: () => ({ grantedAt: {} }),
    getInstallPath: () => "/tmp/redact-ext",
    getManifest: () => manifest,
    isBundled: () => false,
  } as unknown as ExtensionRegistry;
}

function makeBus(): { bus: EventBus<AgentEvents>; events: Array<{ event: string; payload: Record<string, unknown> }> } {
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const bus = {
    emit: (event: string, payload: Record<string, unknown>) => {
      events.push({ event, payload });
    },
    on: () => () => {},
    off: () => {},
  } as unknown as EventBus<AgentEvents>;
  return { bus, events };
}

const BIG_B64 = "A".repeat(4096); // decodes to 3072 bytes
const BIG_DATA_URI = `data:image/png;base64,${BIG_B64}`;
const MARKER = "[data:image/png;3072 bytes]";

afterAll(() => {
  restoreModuleMocks();
});

describe("executeToolCall — resolved data-URI redaction boundaries", () => {
  beforeEach(() => {
    persisted.length = 0;
  });

  test("tool:start emits REDACTED input; subprocess receives the REAL data URI; persist row is REDACTED", async () => {
    const subprocessCalls: Array<Record<string, unknown>> = [];
    const proc = makeProc(subprocessCalls);
    const { bus, events } = makeBus();
    const executor = new ToolExecutor(makeRegistry(proc), createStubPermissionEngine(), { bus });
    executor.setArgsResolver(async (input) => {
      const out = { ...input };
      if (out.image === "ez-attachment://abc") out.image = BIG_DATA_URI;
      return out;
    });

    const result = await executor.executeToolCall(
      TOOL,
      { prompt: "describe", image: "ez-attachment://abc" },
      "conv-r1",
      "msg-r1",
    );
    expect(result.isError).toBe(false);

    // 1. Execution saw the REAL resolved data URI.
    expect(subprocessCalls).toHaveLength(1);
    expect(subprocessCalls[0]!.image).toBe(BIG_DATA_URI);
    expect(subprocessCalls[0]!.prompt).toBe("describe");

    // 2. tool:start carried the redacted marker, never the base64 bulk.
    const start = events.find((e) => e.event === "tool:start");
    expect(start).toBeDefined();
    const emittedInput = start!.payload.input as Record<string, unknown>;
    expect(emittedInput.image).toBe(MARKER);
    expect(emittedInput.prompt).toBe("describe");
    expect(JSON.stringify(start!.payload).includes(BIG_B64)).toBe(false);

    // 3. Persisted input is redacted the same way (recordToolCall is the
    //    chokepoint — the mocked persistToolCall observes its output).
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.input.image).toBe(MARKER);
    expect(persisted[0]!.input.prompt).toBe("describe");
    expect(JSON.stringify(persisted[0]!.input).includes(BIG_B64)).toBe(false);
  });

  test("small non-data inputs pass through emit + persist untouched", async () => {
    const subprocessCalls: Array<Record<string, unknown>> = [];
    const proc = makeProc(subprocessCalls);
    const { bus, events } = makeBus();
    const executor = new ToolExecutor(makeRegistry(proc), createStubPermissionEngine(), { bus });

    await executor.executeToolCall(TOOL, { key: "val", n: 7 }, "conv-r2", "msg-r2");

    const start = events.find((e) => e.event === "tool:start");
    expect(start!.payload.input).toEqual({ key: "val", n: 7 });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.input).toEqual({ key: "val", n: 7 });
    expect(subprocessCalls[0]).toEqual({ key: "val", n: 7 });
  });
});
