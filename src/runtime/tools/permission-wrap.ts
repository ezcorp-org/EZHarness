/**
 * The permission gate for built-in tools, as a reusable projection.
 *
 * `builtinToAgentTool` hands pi-agent-core `def.execute` RAW. For a long
 * time the only gate was an inline closure in `stream-chat/setup-tools.ts`
 * that ran solely under `options.projectId` → `project?.path`, so every
 * HOST-WIRED family — Ez, briefing, briefing-chat, `run_workflow` —
 * executed ungated in every mode and their `category` was dead metadata.
 * `run_workflow` is `category: "execute"` and the three briefing-chat
 * writers are `category: "write"`: under `ask` those are exactly the calls
 * a user expects to be asked about.
 *
 * This module is that gate, lifted out of the closure so there is ONE
 * implementation and every wire routes through it. It also owns the three
 * things the closure owned and callers kept having to remember:
 *   - the `ctx.toolAbortControllers` set/delete pair (so `tool:kill` can
 *     reach an in-flight call),
 *   - the `AbortSignal.any([signal, toolController.signal])` combination,
 *   - the `host.pendingPermissions` register/deregister pair that makes the
 *     wait visible to the run watchdog as a user-wait rather than a hang.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { WatchdogManager } from "../executor-watchdog";
import type { StreamChatContext } from "../stream-chat/context";
import type { PendingPermissionInfo, StreamChatHost } from "../stream-chat/host";
import { builtinToAgentTool } from "./agent-tool";
import {
  DEFAULT_PERMISSION_MODE,
  PermissionGateTimeoutError,
  createPermissionGate,
  needsApproval,
  type PermissionGateOptions,
  type PermissionMode,
} from "./permissions";
import type { BuiltinToolDef } from "./types";

/**
 * Everything {@link withPermissionGate} needs from the turn. Built ONCE per
 * turn in `setup-tools.ts` and shared by every wire, so a new host-wired
 * family gets the gate by passing this object rather than by re-deriving
 * mode precedence.
 */
export interface PermissionWrapDeps {
  /** Owns `toolAbortControllers` — the map `tool:kill` cancels through. */
  ctx: StreamChatContext;
  /** Owns `pendingPermissions` and the bus the request card rides. */
  host: StreamChatHost;
  /** Stamped on {@link PendingPermissionInfo.runId} so the watchdog defers
   *  THIS run rather than every run in the conversation. */
  runId: string;
  conversationId: string;
  /** Absent for turns with no project (Ez, briefing, an ownerless run).
   *  There is nowhere to store a mode without a project, so such a turn
   *  falls back to {@link DEFAULT_PERMISSION_MODE} — the same value
   *  `getPermissionMode` returns for a project that never configured one. */
  projectId: string | undefined;
  /**
   * The turn's `options.permissionMode`. TOP precedence, matching the
   * pre-existing
   * `options.permissionMode ?? busOverrideMode ?? getPermissionMode(...)`
   * chain this wrapper replaces.
   */
  requestedMode: PermissionMode | undefined;
  /**
   * MUST BE A GETTER, NEVER A VALUE. The bus override is a `let` that a
   * `tool:permission_mode_change` subscription reassigns AFTER the tools
   * are wrapped — that is the whole point of it. Capturing the value at
   * wrap time silently disables mid-run permission-mode switching and
   * nothing fails: the tools still run, just under the mode that was in
   * effect when the turn started. Pinned by
   * `permission-wrap.test.ts` ("re-reads the bus override on every call").
   */
  getBusOverrideMode: () => PermissionMode | undefined;
  /** Injected rather than imported so the wrapper has no dead line for a
   *  dynamic import, and so a test can drive mode resolution directly. */
  getPermissionMode: (projectId: string) => Promise<PermissionMode>;
  watchdog: WatchdogManager;
  /**
   * Bounds applied to every gate this wrapper opens. Omitted for the
   * built-in families, which keep the historical unbounded "wait for the
   * human" gate; a family whose answerer is a program rather than a person
   * passes `{timeoutMs, signal, nonInteractiveGuard}`.
   */
  gateOptions?: PermissionGateOptions;
}

/**
 * The user-visible tool result for a gate that did not resolve approved.
 * A timeout is called out concretely — "denied" and "nobody answered in
 * time" are different facts, and only the second one is worth retrying.
 */
function refusalText(toolName: string, err: unknown): string {
  if (err instanceof PermissionGateTimeoutError) {
    const seconds = Math.round(err.timeoutMs / 1000);
    return `Permission for ${toolName} expired after ${seconds}s with no decision`;
  }
  return "Permission denied by user";
}

/** Resolve the mode for one call, at the moment of the call. */
async function resolveMode(deps: PermissionWrapDeps): Promise<PermissionMode> {
  const requested = deps.requestedMode ?? deps.getBusOverrideMode();
  if (requested) return requested;
  if (deps.projectId === undefined) return DEFAULT_PERMISSION_MODE;
  return await deps.getPermissionMode(deps.projectId);
}

/**
 * Does this call open a gate?
 *
 * `caller` short-circuits: the mode is never resolved, so no mode — stored,
 * bus-pushed, or supplied verbatim in the request body that started the run —
 * can turn the gate off. `needsApproval` already answers `true` for `caller`
 * under all three modes because the category is in no `AUTO_APPROVE` set; this
 * is the second, independent reason, and it is here because the FIRST one is a
 * table an edit could quietly widen. A caller tool is code the key holder
 * wrote, running on the key holder's machine, admitted to the owner's
 * conversation — the per-call, deniable, recorded decision is the whole
 * product, so it must not be one table entry away from disappearing.
 */
async function opensGate(def: BuiltinToolDef, deps: PermissionWrapDeps): Promise<boolean> {
  if (def.category === "caller") return true;
  return needsApproval(def.category, await resolveMode(deps));
}

/**
 * Project a host-side {@link BuiltinToolDef} onto the `AgentTool` shape
 * pi-agent-core consumes, with its `execute` behind the permission gate.
 *
 * Returns the whole five-field tool (via `builtinToAgentTool`, still the
 * one place the projection lives), so a wire calls this INSTEAD of the raw
 * projection and cannot register an ungated built-in by omission.
 */
export function withPermissionGate(
  def: BuiltinToolDef,
  deps: PermissionWrapDeps,
): AgentTool {
  return {
    ...builtinToAgentTool(def),
    execute: async (toolCallId, params, signal, onUpdate) => {
      const { ctx, host, conversationId } = deps;
      const toolController = new AbortController();
      ctx.toolAbortControllers.set(toolCallId, toolController);
      const combinedSignal = signal
        ? AbortSignal.any([signal, toolController.signal])
        : toolController.signal;
      try {
        if (await opensGate(def, deps)) {
          const permInfo: PendingPermissionInfo = {
            conversationId, toolCallId, toolName: def.name,
            input: params, cardType: def.cardType, category: def.category,
            runId: deps.runId,
          };
          host.pendingPermissions.set(toolCallId, permInfo);
          host.bus.emit("tool:permission_request", {
            conversationId, toolCallId, toolName: def.name,
            input: params, cardType: def.cardType, category: def.category,
          });
          try {
            await createPermissionGate(toolCallId, conversationId, deps.gateOptions);
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: refusalText(def.name, err) }],
              details: { isError: true },
            };
          } finally {
            host.pendingPermissions.delete(toolCallId);
          }
          // Approved. The watchdog started this call's clock at
          // `tool_execution_start`, BEFORE the gate — restart it so the
          // human's deliberation does not come out of the tool's
          // execution budget and get the run killed on first contact.
          deps.watchdog.refreshToolStart(deps.runId, toolCallId);
        }
        return await def.execute(toolCallId, params, combinedSignal, onUpdate);
      } finally {
        ctx.toolAbortControllers.delete(toolCallId);
      }
    },
  };
}
