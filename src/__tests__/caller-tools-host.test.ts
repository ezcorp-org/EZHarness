/**
 * Caller-executed tools: the per-turn wire (`runtime/caller-tools-host.ts`)
 * and the security posture that is the point of the feature.
 *
 * THE CENTRAL CLAIM, and why it takes four tests rather than one: a caller
 * tool opens a permission gate under EVERY permission mode, including
 * `yolo` — which is `DEFAULT_PERMISSION_MODE` and is also client-supplied on
 * the message-send body, threaded verbatim into the top-precedence slot. The
 * declaring key could otherwise hand itself silent execution on the owner's
 * conversation by naming its own mode. Two independent mechanisms hold that
 * line and both are asserted here:
 *
 *   1. `caller` is in no `AUTO_APPROVE` set, so `needsApproval` says yes.
 *   2. `withPermissionGate` short-circuits on the category and NEVER RESOLVES
 *      THE MODE AT ALL — asserted by showing `getPermissionMode` was not
 *      called, because an assertion on the outcome alone would pass just as
 *      well against a wrapper that resolved `ask` and gated on that.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  CALLER_TOOL_GATE_TIMEOUT_MS,
  CALLER_TOOL_MAX_RESULT_BYTES,
  CALLER_TOOL_UNTRUSTED_NOTE,
  buildCallerToolDef,
  wireCallerToolsForTurn,
} from "../runtime/caller-tools-host";
import { DEFAULT_CALLER_TOOL_TIMEOUT_MS } from "../runtime/caller-tool-declarations";
import {
  getPendingRemoteTool,
  resolveRemoteTool,
  _resetPendingRemoteToolsForTests,
} from "../runtime/remote-tool-registry";
import { remoteToolWatchdogBudgetMs } from "../runtime/tools/remote-tool";
import { withPermissionGate } from "../runtime/tools/permission-wrap";
import {
  beginNonInteractiveScope,
  needsApproval,
  resolvePermission,
  type PermissionMode,
} from "../runtime/tools/permissions";
import type { BuiltinToolDef } from "../runtime/tools/types";
import { makeTestPermissionDeps, type TestPermissionDeps } from "./helpers/permission-wrap-deps";
import { expectDetails, expectText } from "./helpers/expect-tool-result";

afterEach(() => {
  _resetPendingRemoteToolsForTests();
});

const OPEN_APP = {
  name: "open_app",
  description: "Open a native application on the user's machine",
  parameters: { type: "object", properties: { app: { type: "string" } }, required: ["app"] },
};

interface Turn {
  agentTools: AgentTool[];
  builtinToolDefsMap: Map<string, BuiltinToolDef>;
  bus: EventBus<AgentEvents>;
  perms: TestPermissionDeps;
  events: AgentEvents["caller:tool-call"][];
  requests: Array<{ toolCallId: string; toolName: string; category?: string }>;
  wired: string[];
}

function wire(opts: {
  tools?: unknown;
  userId?: string | null;
  mode?: PermissionMode;
  requestedMode?: PermissionMode;
  runSignal?: AbortSignal;
  withBus?: boolean;
} = {}): Turn {
  const bus = new EventBus<AgentEvents>();
  const perms = makeTestPermissionDeps({
    bus,
    runId: "run-1",
    conversationId: "conv-1",
    storedMode: opts.mode ?? "yolo",
    requestedMode: opts.requestedMode,
  });
  const events: AgentEvents["caller:tool-call"][] = [];
  bus.on("caller:tool-call", (e) => events.push(e));
  const requests: Array<{ toolCallId: string; toolName: string; category?: string }> = [];
  bus.on("tool:permission_request", (e) =>
    requests.push({ toolCallId: e.toolCallId, toolName: e.toolName, category: e.category }),
  );

  const turn: Turn = {
    agentTools: [],
    builtinToolDefsMap: new Map(),
    bus,
    perms,
    events,
    requests,
    wired: [],
  };
  turn.wired = wireCallerToolsForTurn({
    agentTools: turn.agentTools,
    builtinToolDefsMap: turn.builtinToolDefsMap,
    conversationId: "conv-1",
    runId: "run-1",
    userId: "userId" in opts ? opts.userId : "user-1",
    metadata: { callerTools: opts.tools ?? [OPEN_APP] },
    permissionDeps: perms.deps,
    ...(opts.withBus === false ? {} : { bus }),
    ...(opts.runSignal ? { runSignal: opts.runSignal } : {}),
  });
  return turn;
}

/** Wait for a value to appear, driving only microtasks + the macrotask queue.
 *  Never asserts on elapsed time — it polls for a state change. */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) {
    await new Promise<void>((r) => setTimeout(r, 1));
  }
}

// ── Registration ───────────────────────────────────────────────────────

describe("registration", () => {
  test("wires the declaration under its namespaced name, in both maps", () => {
    const turn = wire();
    expect(turn.wired).toEqual(["_caller__open_app"]);
    expect(turn.agentTools.map((t) => t.name)).toEqual(["_caller__open_app"]);
    // The defs map is load-bearing, not bookkeeping: subscribe-bridge reads
    // `callTimeoutMs` out of it to size the watchdog's in-flight deferral, so
    // a tool missing from it silently gets the 90s default and its turn is
    // killed while the client is still legitimately working.
    const def = turn.builtinToolDefsMap.get("_caller__open_app")!;
    expect(def.category).toBe("caller");
    expect(def.cardType).toBe("default");
    expect(def.label).toBe("open_app");
  });

  test("every description carries the untrusted-input warning", () => {
    const def = wire().builtinToolDefsMap.get("_caller__open_app")!;
    expect(def.description).toContain(OPEN_APP.description);
    expect(def.description).toContain(CALLER_TOOL_UNTRUSTED_NOTE);
    expect(CALLER_TOOL_UNTRUSTED_NOTE).toContain("untrusted input");
  });

  test("the watchdog budget is derived from the declaration's own timeout", () => {
    expect(wire().builtinToolDefsMap.get("_caller__open_app")!.callTimeoutMs).toBe(
      remoteToolWatchdogBudgetMs(DEFAULT_CALLER_TOOL_TIMEOUT_MS),
    );
    const custom = wire({ tools: [{ ...OPEN_APP, timeoutMs: 300_000 }] });
    expect(custom.builtinToolDefsMap.get("_caller__open_app")!.callTimeoutMs).toBe(
      remoteToolWatchdogBudgetMs(300_000),
    );
  });

  test("the declared schema reaches the tool the model sees", () => {
    const tool = wire().agentTools[0]!;
    expect(tool.parameters).toMatchObject(OPEN_APP.parameters);
  });

  test("a conversation with no declarations wires nothing", () => {
    // This is also why a SUB-conversation inherits none: declarations live on
    // the conversation row, and a spawned child has its own empty bag.
    expect(wire({ tools: [] }).wired).toEqual([]);
    const turn = wireCallerToolsForTurn({
      agentTools: [],
      builtinToolDefsMap: new Map(),
      conversationId: "conv-child",
      runId: "run-1",
      userId: "user-1",
      metadata: { spawnDepth: 1 },
      permissionDeps: makeTestPermissionDeps().deps,
    });
    expect(turn).toEqual([]);
  });

  test("an ownerless conversation wires nothing — there is nobody to ask", () => {
    // The event is narrowed to the owner's SSE connections and the result
    // POST is authorized against the same id, so a null owner means the call
    // could be neither delivered nor answered.
    expect(wire({ userId: null }).wired).toEqual([]);
    expect(wire({ userId: undefined }).wired).toEqual([]);
  });

  test("a malformed declaration in the bag yields nothing, not a broken tool", () => {
    expect(wire({ tools: [{ ...OPEN_APP, name: "invoke_agent" }] }).wired).toEqual([]);
  });

  test("re-wiring the same turn does not double-register", () => {
    const turn = wire();
    const again = wireCallerToolsForTurn({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "conv-1",
      runId: "run-1",
      userId: "user-1",
      metadata: { callerTools: [OPEN_APP] },
      permissionDeps: turn.perms.deps,
      bus: turn.bus,
    });
    expect(again).toEqual([]);
    expect(turn.agentTools).toHaveLength(1);
  });

  test("two declarations wire as two independent tools", () => {
    const turn = wire({
      tools: [OPEN_APP, { ...OPEN_APP, name: "close_app", description: "Close it" }],
    });
    expect(turn.wired).toEqual(["_caller__open_app", "_caller__close_app"]);
  });
});

// ── Security posture (§1) ──────────────────────────────────────────────

describe("a caller tool ALWAYS opens a gate", () => {
  test("the permission matrix says so for all three modes", () => {
    for (const mode of ["ask", "auto-edit", "yolo"] as const) {
      expect(needsApproval("caller", mode)).toBe(true);
    }
  });

  const MODES: Array<[label: string, opts: Parameters<typeof wire>[0]]> = [
    ["stored mode ask", { mode: "ask" }],
    ["stored mode auto-edit", { mode: "auto-edit" }],
    ["stored mode yolo", { mode: "yolo" }],
    // The one that actually matters: `permissionMode` arrives on the
    // message-send body (client-supplied) and is threaded verbatim into the
    // TOP-precedence slot, above both the bus override and the stored mode.
    ["a body-supplied yolo", { requestedMode: "yolo", mode: "ask" }],
  ];

  for (const [label, opts] of MODES) {
    test(`${label}: the call parks on a gate and the mode is never consulted`, async () => {
      const turn = wire(opts);
      const call = turn.agentTools[0]!.execute("tc-1", { app: "Mail" });
      await until(() => turn.requests.length > 0);

      expect(turn.requests).toEqual([
        { toolCallId: "tc-1", toolName: "_caller__open_app", category: "caller" },
      ]);
      expect(turn.perms.pendingPermissions.get("tc-1")).toMatchObject({
        conversationId: "conv-1",
        runId: "run-1",
        category: "caller",
      });
      // The short-circuit, proven: no mode was resolved, so no mode could
      // have turned the gate off.
      expect(turn.perms.modeLookups).toEqual([]);
      // And nothing went out to the client while the gate stood.
      expect(turn.events).toEqual([]);

      resolvePermission("tc-1", false);
      expectText(await call, "Permission denied by user");
      expect(turn.perms.pendingPermissions.has("tc-1")).toBe(false);
    });
  }

  test("approval releases the call, refreshes the watchdog clock, and emits", async () => {
    const turn = wire();
    const call = turn.agentTools[0]!.execute("tc-approve", { app: "Mail" });
    await until(() => turn.requests.length > 0);
    expect(turn.events).toEqual([]);

    resolvePermission("tc-approve", true);
    await until(() => turn.events.length > 0);

    // The human's deliberation must not come out of the tool's execution
    // budget — the watchdog started this call's clock at
    // `tool_execution_start`, BEFORE the gate.
    expect(turn.perms.refreshed).toEqual([{ runId: "run-1", toolCallId: "tc-approve" }]);
    expect(turn.events).toEqual([
      {
        conversationId: "conv-1",
        runId: "run-1",
        toolCallId: "tc-approve",
        // BARE name: the client registered its handler under what it declared.
        toolName: "open_app",
        input: { app: "Mail" },
        userId: "user-1",
      },
    ]);

    resolveRemoteTool("tc-approve", { ok: true, detail: { launched: "Mail" } });
    const result = await call;
    expectText(result, '"launched": "Mail"');
    expect(expectDetails<{ callerSide?: boolean }>(result).callerSide).toBe(true);
  });
});

describe("the gate is BOUNDED", () => {
  test("its deadline is two minutes", () => {
    expect(CALLER_TOOL_GATE_TIMEOUT_MS).toBe(120_000);
  });

  test("expiry says EXPIRED, not denied, and leaves nothing behind", async () => {
    // Same def the host wires; only the deadline is shortened, because the
    // assertion is about WHICH message and WHAT cleanup, never about how long
    // the wait was.
    const perms = makeTestPermissionDeps({
      conversationId: "conv-1",
      runId: "run-1",
      gateOptions: { timeoutMs: 5, nonInteractiveGuard: "caller-tool" },
    });
    const def = buildCallerToolDef(OPEN_APP, {
      conversationId: "conv-1",
      runId: "run-1",
      userId: "user-1",
      bus: perms.bus,
    });
    const result = await withPermissionGate(def, perms.deps).execute("tc-expire", { app: "Mail" });

    // "Nobody answered in time" and "the user said no" are different facts,
    // and only the first one is worth retrying.
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/Permission for _caller__open_app expired after \d+s with no decision/);
    expect(text).not.toContain("denied by user");
    expect(perms.pendingPermissions.has("tc-expire")).toBe(false);
    expect(getPendingRemoteTool("tc-expire")).toBeUndefined();
  });

  test("a non-interactive scope refuses the gate instead of parking it", async () => {
    // A workflow step or a briefing has no human watching the conversation,
    // so a caller gate raised there could never be answered. Fail fast.
    const turn = wire();
    const scope = beginNonInteractiveScope("conv-1");
    try {
      const result = await turn.agentTools[0]!.execute("tc-noninteractive", { app: "Mail" });
      expect(expectDetails<{ isError?: boolean }>(result).isError).toBe(true);
      expect(scope.takeDenial()).toBe("caller-tool");
      expect(turn.perms.pendingPermissions.has("tc-noninteractive")).toBe(false);
      expect(turn.events).toEqual([]);
    } finally {
      scope.end();
    }
  });

  test("the run's abort signal tears a standing gate down", async () => {
    const controller = new AbortController();
    const turn = wire({ runSignal: controller.signal });
    const call = turn.agentTools[0]!.execute("tc-abort", { app: "Mail" });
    await until(() => turn.requests.length > 0);

    controller.abort();
    const result = await call;
    expect(expectDetails<{ isError?: boolean }>(result).isError).toBe(true);
    expect(turn.perms.pendingPermissions.has("tc-abort")).toBe(false);
    expect(turn.events).toEqual([]);
  });
});

// ── Result handling ────────────────────────────────────────────────────

describe("results", () => {
  test("are capped at 64 KiB of LLM-visible text", async () => {
    expect(CALLER_TOOL_MAX_RESULT_BYTES).toBe(65_536);
    const turn = wire();
    const call = turn.agentTools[0]!.execute("tc-big", { app: "Mail" });
    await until(() => turn.requests.length > 0);
    resolvePermission("tc-big", true);
    await until(() => turn.events.length > 0);

    resolveRemoteTool("tc-big", { ok: true, detail: { blob: "x".repeat(200_000) } });
    const text = (await call).content[0] as { text: string };
    expect(text.text).toContain("[output truncated");
    expect(new TextEncoder().encode(text.text).byteLength).toBeLessThan(200_000);
  });

  test("with no bus the call fails concretely rather than parking", async () => {
    const turn = wire({ withBus: false });
    const call = turn.agentTools[0]!.execute("tc-nobus", { app: "Mail" });
    // The gate still opens — the missing bus is discovered by the tool body,
    // after approval, not instead of it.
    await until(() => turn.perms.pendingPermissions.has("tc-nobus"));
    resolvePermission("tc-nobus", true);
    const result = await call;
    expectText(result, "caller-tool bus not wired");
    expect(expectDetails<{ isError?: boolean }>(result).isError).toBe(true);
    expect(getPendingRemoteTool("tc-nobus")).toBeUndefined();
  });

  test("N parallel calls of one turn settle independently", async () => {
    const turn = wire({
      tools: [OPEN_APP, { ...OPEN_APP, name: "close_app", description: "Close it" }],
    });
    const open = turn.agentTools[0]!.execute("par-1", { app: "Mail" });
    const close = turn.agentTools[1]!.execute("par-2", { app: "Mail" });
    await until(() => turn.requests.length === 2);

    resolvePermission("par-1", true);
    resolvePermission("par-2", true);
    await until(() => turn.events.length === 2);
    expect(turn.events.map((e) => e.toolName).sort()).toEqual(["close_app", "open_app"]);

    resolveRemoteTool("par-2", { ok: false, error: "no such app" });
    expectText(await close, "no such app");
    // The sibling is untouched by its neighbour's failure.
    expect(getPendingRemoteTool("par-1")).toMatchObject({ runId: "run-1", origin: "caller" });
    resolveRemoteTool("par-1", { ok: true, detail: { launched: true } });
    expectText(await open, "open_app completed.");
  });
});
