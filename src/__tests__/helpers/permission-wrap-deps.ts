/**
 * A minimal, inspectable {@link PermissionWrapDeps} for tests.
 *
 * Every host wire now takes `permissionDeps` (that is the point of the fix —
 * a built-in cannot be registered ungated by omission), so a lot of wiring
 * tests need one object they do not otherwise care about. Building it here
 * once keeps ~30 call sites from each inventing their own `as unknown as`
 * cast, and gives the tests that DO care a handle on what the gate saw:
 * `bus`, `pendingPermissions`, `toolAbortControllers` and `refreshed`.
 */

import { EventBus } from "../../runtime/events";
import type { AgentEvents } from "../../types";
import type { StreamChatContext } from "../../runtime/stream-chat/context";
import type { PendingPermissionInfo, StreamChatHost } from "../../runtime/stream-chat/host";
import type { PermissionWrapDeps } from "../../runtime/tools/permission-wrap";
import type { PermissionMode } from "../../runtime/tools/permissions";

export interface TestPermissionDeps {
  deps: PermissionWrapDeps;
  bus: EventBus<AgentEvents>;
  /** `host.pendingPermissions` — the map the watchdog reads. */
  pendingPermissions: Map<string, PendingPermissionInfo>;
  /** `ctx.toolAbortControllers` — the map `tool:kill` cancels through. */
  toolAbortControllers: Map<string, AbortController>;
  /** `(runId, toolCallId)` pairs passed to `watchdog.refreshToolStart`. */
  refreshed: Array<{ runId: string; toolCallId: string }>;
  /**
   * Every `projectId` handed to `getPermissionMode`, in call order.
   *
   * A gate that must fire REGARDLESS of mode is only proven by showing the
   * mode was never asked for — an assertion on the outcome alone passes just
   * as well against a wrapper that resolved `ask` and gated on that.
   */
  modeLookups: string[];
  /** Reassign to drive mid-run permission-mode switching. */
  setBusOverrideMode(mode: PermissionMode | undefined): void;
}

export interface TestPermissionDepsOptions {
  runId?: string;
  conversationId?: string;
  /**
   * Conversation owner stamped on the `tool:permission_request` emit.
   *
   * Defaults to `null` — the ownerless shape — so the ~30 wiring tests that
   * only need SOME deps object keep emitting exactly the payload they always
   * did. The tests that care about the delivery key pass one explicitly.
   */
  userId?: string | null;
  projectId?: string | undefined;
  requestedMode?: PermissionMode | undefined;
  /** Stored project mode, i.e. what `getPermissionMode(projectId)` resolves. */
  storedMode?: PermissionMode;
  gateOptions?: PermissionWrapDeps["gateOptions"];
  bus?: EventBus<AgentEvents>;
}

export function makeTestPermissionDeps(
  opts: TestPermissionDepsOptions = {},
): TestPermissionDeps {
  const bus = opts.bus ?? new EventBus<AgentEvents>();
  const pendingPermissions = new Map<string, PendingPermissionInfo>();
  const toolAbortControllers = new Map<string, AbortController>();
  const refreshed: Array<{ runId: string; toolCallId: string }> = [];
  const modeLookups: string[] = [];
  let busOverrideMode: PermissionMode | undefined;

  const ctx = { toolAbortControllers } as unknown as StreamChatContext;
  const host = {
    bus,
    pendingPermissions,
    watchdog: {
      refreshToolStart: (runId: string, toolCallId: string) => {
        refreshed.push({ runId, toolCallId });
      },
    },
  } as unknown as StreamChatHost;

  const deps: PermissionWrapDeps = {
    ctx,
    host,
    runId: opts.runId ?? "run-test",
    conversationId: opts.conversationId ?? "conv-test",
    userId: opts.userId ?? null,
    projectId: "projectId" in opts ? opts.projectId : "proj-test",
    requestedMode: opts.requestedMode,
    getBusOverrideMode: () => busOverrideMode,
    getPermissionMode: async (projectId: string) => {
      modeLookups.push(projectId);
      return opts.storedMode ?? "yolo";
    },
    watchdog: host.watchdog,
    ...(opts.gateOptions ? { gateOptions: opts.gateOptions } : {}),
  };

  return {
    deps,
    bus,
    pendingPermissions,
    toolAbortControllers,
    refreshed,
    modeLookups,
    setBusOverrideMode: (mode) => {
      busOverrideMode = mode;
    },
  };
}
