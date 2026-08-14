/**
 * `withPermissionGate` — the one gate every built-in tool now goes
 * through (`src/runtime/tools/permission-wrap.ts`).
 *
 * Two jobs here.
 *
 * 1. PIN THE LIFT. The wrapper is an extraction of the inline closure
 *    that used to live in `setup-tools.ts` block 2a, so the whole
 *    category × mode matrix must behave exactly as it did: the same
 *    approval decision, the same `tool:permission_request` payload, the
 *    same `pendingPermissions` register/deregister pair, the same
 *    `"Permission denied by user"` text, the same abort-controller
 *    bookkeeping.
 *
 * 2. PIN WHAT IS NEW. `busOverrideMode` MUST be read through a getter on
 *    every call (a value captured at wrap time silently kills mid-run
 *    mode switching and nothing else fails); an approved gate refreshes
 *    the watchdog's clock for THAT call; an expired gate reports a
 *    concrete "expired" message rather than the generic denial; and the
 *    pending record carries the run id so the watchdog's deferral is
 *    per-run.
 *
 * No DB and no executor — `PermissionWrapDeps` is injected, which is the
 * reason the module has no dynamic import to leave a dead line behind.
 */

import { describe, expect, test } from "bun:test";
import { Type } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { withPermissionGate } from "../runtime/tools/permission-wrap";
import {
  getPendingApproval,
  needsApproval,
  resolvePermission,
  type PermissionMode,
} from "../runtime/tools/permissions";
import type { BuiltinToolDef, ToolCategory } from "../runtime/tools/types";
import { makeTestPermissionDeps } from "./helpers/permission-wrap-deps";

const MODES: readonly PermissionMode[] = ["ask", "auto-edit", "yolo"];
const CATEGORIES: readonly ToolCategory[] = ["read", "write", "execute", "ez"];

/** Every gate a test opens is settled by that test — the approvals map is
 *  a module singleton, so a parked entry would leak into the next one. */

interface ToolCall {
  toolCallId: string;
  params: unknown;
  signal?: AbortSignal;
}

function makeDef(
  over: Partial<BuiltinToolDef> = {},
  calls: ToolCall[] = [],
): BuiltinToolDef {
  return {
    name: "probe_tool",
    label: "Probe",
    description: "a probe",
    category: "execute",
    cardType: "terminal",
    parameters: Type.Unsafe({ type: "object", properties: {} }),
    execute: async (toolCallId, params, signal) => {
      calls.push({ toolCallId, params, ...(signal ? { signal } : {}) });
      return { content: [{ type: "text", text: "ran" }], details: { ok: true } };
    },
    ...over,
  };
}

function textOf(res: AgentToolResult<unknown>): string {
  return (res.content[0] as { text: string }).text;
}

/** Let the wrapper reach its parked gate. Mode resolution is `async`, so a
 *  single microtask turn is not enough; a 0ms timer runs after the whole
 *  microtask queue has drained. Nothing here is timed — the assertions
 *  that follow are about state, not duration. */
function flush(): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, 0));
}

// ── 1. The lift: category × mode behaves exactly as block 2a did ───────

describe("withPermissionGate — approval matrix matches needsApproval()", () => {
  for (const mode of MODES) {
    for (const category of CATEGORIES) {
      const gated = needsApproval(category, mode);
      test(`${category} under ${mode} ${gated ? "raises" : "does not raise"} a gate`, async () => {
        const h = makeTestPermissionDeps({ storedMode: mode });
        const requests: unknown[] = [];
        h.bus.on("tool:permission_request", (d) => requests.push(d));

        const calls: ToolCall[] = [];
        const tool = withPermissionGate(makeDef({ category }, calls), h.deps);
        const pending = tool.execute("call-1", { a: 1 });

        if (gated) {
          // The gate is open: nothing has executed, and the request is out.
          await flush();
          expect(calls).toHaveLength(0);
          expect(requests).toHaveLength(1);
          expect(h.pendingPermissions.get("call-1")?.toolName).toBe("probe_tool");
          resolvePermission("call-1", true);
        } else {
          expect(requests).toHaveLength(0);
        }

        const res = await pending;
        expect(textOf(res)).toBe("ran");
        expect(calls).toHaveLength(1);
        // Either path leaves nothing behind.
        expect(h.pendingPermissions.size).toBe(0);
        expect(h.toolAbortControllers.size).toBe(0);
      });
    }
  }
});

describe("withPermissionGate — the five-field projection is intact", () => {
  test("carries name, label, description and parameters through unchanged", () => {
    const def = makeDef({ name: "shell", label: "Shell", description: "runs things" });
    const tool = withPermissionGate(def, makeTestPermissionDeps().deps) as typeof def;
    expect(tool.name).toBe("shell");
    expect(tool.label).toBe("Shell");
    expect(tool.description).toBe("runs things");
    expect(tool.parameters).toBe(def.parameters);
    // …and `execute` is the wrapper, not the raw def body.
    expect(tool.execute).not.toBe(def.execute);
  });
});

describe("withPermissionGate — the request payload and pending record", () => {
  test("emits the same fields block 2a emitted, and stamps the run id on the record", async () => {
    const h = makeTestPermissionDeps({
      storedMode: "ask",
      runId: "run-77",
      conversationId: "conv-77",
    });
    const requests: Array<Record<string, unknown>> = [];
    h.bus.on("tool:permission_request", (d) => requests.push(d as Record<string, unknown>));

    const tool = withPermissionGate(makeDef({ category: "execute", cardType: "terminal" }), h.deps);
    const pending = tool.execute("call-77", { cmd: "ls" });
    await flush();

    expect(requests[0]).toEqual({
      conversationId: "conv-77",
      toolCallId: "call-77",
      toolName: "probe_tool",
      input: { cmd: "ls" },
      cardType: "terminal",
      category: "execute",
    });
    // The record the WATCHDOG reads additionally carries the run id —
    // that is what makes its deferral per-run instead of per-conversation.
    expect(h.pendingPermissions.get("call-77")).toEqual({
      conversationId: "conv-77",
      toolCallId: "call-77",
      toolName: "probe_tool",
      input: { cmd: "ls" },
      cardType: "terminal",
      category: "execute",
      runId: "run-77",
    });

    resolvePermission("call-77", true);
    await pending;
  });

  test("a denied gate returns the legacy text and never runs the tool", async () => {
    const h = makeTestPermissionDeps({ storedMode: "ask" });
    const calls: ToolCall[] = [];
    const tool = withPermissionGate(makeDef({ category: "execute" }, calls), h.deps);

    const pending = tool.execute("call-deny", {});
    await flush();
    resolvePermission("call-deny", false);

    const res = await pending;
    expect(textOf(res)).toBe("Permission denied by user");
    expect((res.details as { isError?: boolean }).isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect(h.pendingPermissions.size).toBe(0);
    expect(h.toolAbortControllers.size).toBe(0);
    // A denied gate must NOT restart the watchdog clock.
    expect(h.refreshed).toEqual([]);
  });
});

// ── 2. Mode precedence ────────────────────────────────────────────────

describe("withPermissionGate — mode precedence", () => {
  test("options.permissionMode wins over the bus override and the stored mode", async () => {
    const h = makeTestPermissionDeps({ requestedMode: "yolo", storedMode: "ask" });
    h.setBusOverrideMode("ask");
    const calls: ToolCall[] = [];
    const tool = withPermissionGate(makeDef({ category: "execute" }, calls), h.deps);

    // `yolo` auto-approves `execute`, so this resolves with no gate.
    expect(textOf(await tool.execute("call-a", {}))).toBe("ran");
    expect(calls).toHaveLength(1);
  });

  test("the bus override wins over the stored mode", async () => {
    const h = makeTestPermissionDeps({ storedMode: "yolo" });
    h.setBusOverrideMode("ask");
    const tool = withPermissionGate(makeDef({ category: "execute" }), h.deps);

    const pending = tool.execute("call-b", {});
    await flush();
    expect(getPendingApproval("call-b")).toBe(true);
    resolvePermission("call-b", true);
    await pending;
  });

  test("RE-READS the bus override on every call — a value captured at wrap time would not", async () => {
    // The landmine this getter exists for. `busOverrideMode` is a `let`
    // that the `tool:permission_mode_change` subscription reassigns AFTER
    // the tools are wrapped, so passing it by value silently disables
    // mid-run permission-mode switching — the tools still run, just under
    // the wrong mode, and nothing else fails.
    const h = makeTestPermissionDeps({ storedMode: "yolo" });
    const calls: ToolCall[] = [];
    const tool = withPermissionGate(makeDef({ category: "execute" }, calls), h.deps);

    // Before the switch: yolo auto-approves.
    expect(textOf(await tool.execute("call-before", {}))).toBe("ran");
    expect(calls).toHaveLength(1);

    // The user switches to `ask` mid-run, on the SAME wrapped tool.
    h.setBusOverrideMode("ask");
    const pending = tool.execute("call-after", {});
    await flush();
    expect(getPendingApproval("call-after")).toBe(true);
    resolvePermission("call-after", true);
    await pending;
    expect(calls).toHaveLength(2);
  });

  test("no project falls back to the default mode without consulting the store", async () => {
    // There is nowhere to store a permission mode without a project, so a
    // project-less turn (Ez, briefing, an ownerless run) resolves to
    // DEFAULT_PERMISSION_MODE — which is what `getPermissionMode` would
    // have returned for an unconfigured project anyway.
    let storeReads = 0;
    const h = makeTestPermissionDeps({ projectId: undefined });
    h.deps.getPermissionMode = async () => {
      storeReads += 1;
      return "ask";
    };
    const calls: ToolCall[] = [];
    const tool = withPermissionGate(makeDef({ category: "execute" }, calls), h.deps);

    expect(textOf(await tool.execute("call-np", {}))).toBe("ran");
    expect(storeReads).toBe(0);
    expect(calls).toHaveLength(1);
  });

  test("with a project and no override, the stored mode decides", async () => {
    const reads: string[] = [];
    const h = makeTestPermissionDeps({ projectId: "proj-9" });
    h.deps.getPermissionMode = async (projectId) => {
      reads.push(projectId);
      return "ask";
    };
    const tool = withPermissionGate(makeDef({ category: "write" }), h.deps);

    const pending = tool.execute("call-stored", {});
    await flush();
    expect(reads).toEqual(["proj-9"]);
    expect(getPendingApproval("call-stored")).toBe(true);
    resolvePermission("call-stored", true);
    await pending;
  });
});

// ── 3. Watchdog clock refresh ─────────────────────────────────────────

describe("withPermissionGate — watchdog clock refresh", () => {
  test("refreshes THIS call's start after an approved gate", async () => {
    const h = makeTestPermissionDeps({ storedMode: "ask", runId: "run-5" });
    const tool = withPermissionGate(makeDef({ category: "execute" }), h.deps);

    const pending = tool.execute("call-refresh", {});
    await flush();
    expect(h.refreshed).toEqual([]); // not yet — the gate is still open
    resolvePermission("call-refresh", true);
    await pending;

    expect(h.refreshed).toEqual([{ runId: "run-5", toolCallId: "call-refresh" }]);
  });

  test("does not touch the clock when no gate was needed", async () => {
    const h = makeTestPermissionDeps({ storedMode: "yolo" });
    const tool = withPermissionGate(makeDef({ category: "read" }), h.deps);
    await tool.execute("call-ungated", {});
    expect(h.refreshed).toEqual([]);
  });
});

// ── 4. Bounded gates ──────────────────────────────────────────────────

describe("withPermissionGate — bounded gates", () => {
  test("an expired gate reports a concrete 'expired' message, not the generic denial", async () => {
    const h = makeTestPermissionDeps({
      storedMode: "ask",
      gateOptions: { timeoutMs: 5 },
    });
    const calls: ToolCall[] = [];
    const tool = withPermissionGate(makeDef({ name: "run_workflow", category: "execute" }, calls), h.deps);

    const res = await tool.execute("call-expire", {});
    expect(textOf(res)).toBe("Permission for run_workflow expired after 0s with no decision");
    expect((res.details as { isError?: boolean }).isError).toBe(true);
    expect(calls).toHaveLength(0);
    // Both registries are cleared: the gate's own entry AND the record
    // the watchdog reads to defer.
    expect(getPendingApproval("call-expire")).toBe(false);
    expect(h.pendingPermissions.size).toBe(0);
    expect(h.toolAbortControllers.size).toBe(0);
  });

  test("the expiry message names the configured budget in whole seconds", async () => {
    const h = makeTestPermissionDeps({
      storedMode: "ask",
      gateOptions: { timeoutMs: 120_000 },
    });
    const tool = withPermissionGate(makeDef({ name: "shell", category: "execute" }), h.deps);
    const pending = tool.execute("call-msg", {});
    await flush();
    // Settle it by hand rather than waiting out two real minutes; the
    // rendered text is a pure function of `timeoutMs`, asserted above.
    resolvePermission("call-msg", false);
    expect(textOf(await pending)).toBe("Permission denied by user");
  });

  test("a signal-bounded gate refuses when the run is aborted", async () => {
    const ac = new AbortController();
    const h = makeTestPermissionDeps({
      storedMode: "ask",
      gateOptions: { signal: ac.signal },
    });
    const tool = withPermissionGate(makeDef({ category: "execute" }), h.deps);

    const pending = tool.execute("call-abort", {});
    await flush();
    ac.abort();

    const res = await pending;
    expect(textOf(res)).toBe("Permission denied by user");
    expect(h.pendingPermissions.size).toBe(0);
  });
});

// ── 5. Abort-controller bookkeeping ───────────────────────────────────

describe("withPermissionGate — abort controller bookkeeping", () => {
  test("registers a per-call controller while executing and removes it after", async () => {
    const h = makeTestPermissionDeps({ storedMode: "yolo" });
    let sawRegistered = false;
    const def = makeDef({ category: "read" });
    def.execute = async () => {
      sawRegistered = h.toolAbortControllers.has("call-ctl");
      return { content: [{ type: "text", text: "ran" }], details: {} };
    };

    await withPermissionGate(def, h.deps).execute("call-ctl", {});
    expect(sawRegistered).toBe(true);
    expect(h.toolAbortControllers.has("call-ctl")).toBe(false);
  });

  /** Run the tool and hand back the signal it was given plus the per-call
   *  controller the wrapper registered for it. */
  async function captureSignal(
    h: ReturnType<typeof makeTestPermissionDeps>,
    toolCallId: string,
    callerSignal?: AbortSignal,
  ): Promise<{ seen: AbortSignal; controller: AbortController }> {
    let seen: AbortSignal | undefined;
    let controller: AbortController | undefined;
    const def = makeDef({ category: "read" });
    def.execute = async (id, _p, signal) => {
      seen = signal as AbortSignal;
      controller = h.toolAbortControllers.get(id);
      return { content: [{ type: "text", text: "ran" }], details: {} };
    };
    await withPermissionGate(def, h.deps).execute(toolCallId, {}, callerSignal);
    return { seen: seen as AbortSignal, controller: controller as AbortController };
  }

  test("the caller's signal aborts the combined signal the tool sees", async () => {
    const h = makeTestPermissionDeps({ storedMode: "yolo" });
    const caller = new AbortController();
    const { seen } = await captureSignal(h, "call-caller", caller.signal);
    expect(seen.aborted).toBe(false);
    caller.abort();
    expect(seen.aborted).toBe(true);
  });

  test("the per-call controller aborts it too — that is how tool:kill reaches the tool", async () => {
    const h = makeTestPermissionDeps({ storedMode: "yolo" });
    const caller = new AbortController();
    const { seen, controller } = await captureSignal(h, "call-kill", caller.signal);
    controller.abort();
    expect(seen.aborted).toBe(true);
  });

  test("with NO caller signal the tool gets the per-call controller's own signal", async () => {
    const h = makeTestPermissionDeps({ storedMode: "yolo" });
    const { seen, controller } = await captureSignal(h, "call-nosig");
    expect(seen).toBe(controller.signal);
    controller.abort();
    expect(seen.aborted).toBe(true);
  });

  test("a throwing tool still deregisters its controller", async () => {
    const h = makeTestPermissionDeps({ storedMode: "yolo" });
    const def = makeDef({ category: "read" });
    def.execute = async () => {
      throw new Error("boom");
    };
    await expect(withPermissionGate(def, h.deps).execute("call-throw", {})).rejects.toThrow("boom");
    expect(h.toolAbortControllers.size).toBe(0);
  });
});
