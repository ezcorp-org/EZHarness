import type { AgentEvents, AgentRun } from "../../types";
import type { EventBus } from "../events";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { ExtensionStateMediator } from "../../extensions/state-mediator";
import type { SpawnQuota } from "../../extensions/spawn-quota";
import type { PermissionEngine } from "../../extensions/permission-engine";
import type { WatchdogManager } from "../executor-watchdog";
import type { AgentExecutor } from "../executor";

/**
 * Per-conversation pending tool permission record. Stored on the executor's
 * pendingPermissions map, read by both the watchdog (to suppress idle
 * cancellation while waiting for user approval) and the streamChat
 * permission gate (to surface metadata to the UI).
 */
export interface PendingPermissionInfo {
  conversationId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  cardType?: string;
  cardLayout?: string;
  category?: string;
}

/**
 * Composition seam for `streamChat` phase modules. Mirrors the
 * `WatchdogHost` pattern in `executor-watchdog.ts`: the executor builds a
 * single `StreamChatHost` view of itself once at the top of `streamChat`
 * and threads it to each phase function. The phases never see the
 * executor class shape — they read/write only the surface declared here.
 *
 * All maps are passed by reference; the host does NOT own state.
 *
 * The `executor: AgentExecutor` field is intentionally exposed because
 * a small number of call sites need to thread the executor itself
 * through to `ToolExecutor.setExecutor` (so `ezcorp/spawn-assignment`
 * can re-enter `streamChat`). That is composition over inheritance —
 * the phases don't subclass or invoke methods on the executor; they
 * just hand the reference to a downstream sink.
 */
export interface StreamChatHost {
  readonly bus: EventBus<AgentEvents>;
  readonly persist: boolean;
  readonly pendingPermissions: Map<string, PendingPermissionInfo>;
  readonly controllers: Map<string, AbortController>;
  readonly runConversations: Map<string, string>;
  readonly activeAgents: Map<string, Agent>;
  readonly runs: Map<string, AgentRun>;
  readonly watchdog: WatchdogManager;
  /**
   * Per-run "an assistant error message has been persisted" guard,
   * shared with the watchdog trip branch
   * ({@link WatchdogManager}). The first writer for a runId claims it;
   * later writers skip. Ensures exactly one visible error bubble per
   * run when both the watchdog kill AND the unblocked await's
   * `finalizeError` would otherwise call `persistErrorMessage`.
   */
  readonly errorMessagePersisted: Set<string>;
  readonly stateMediator: ExtensionStateMediator | undefined;
  readonly spawnQuota: SpawnQuota;
  readonly executor: AgentExecutor;
  /**
   * Phase 1 PDP — required at every `new ToolExecutor(...)` site. Wired
   * once at executor boot via `getPermissionEngine({registry, bus})`
   * and threaded through here so the per-turn ToolExecutor instances
   * spawned by `setup-tools.ts` share one cache.
   */
  readonly permissionEngine: PermissionEngine;
}
