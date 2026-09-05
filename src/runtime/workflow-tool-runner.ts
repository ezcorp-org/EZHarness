/**
 * Dispatch surface for workflow `kind: "tool"` steps.
 *
 * A tool step runs a real extension tool through the host's ONE tool
 * dispatch path (`ToolExecutor.executeToolCall`) so it goes through the
 * identical PDP authorization, capability gate, audit row and provenance
 * plumbing a chat-driven tool call does. This module exists purely to
 * (a) name the narrow slice of `ToolExecutor` a workflow needs, so
 * `workflow-executor.ts` can be unit-tested against a fake, and (b) own
 * the cold-start construction of the real one in a single place.
 */
import { ExtensionRegistry } from "../extensions/registry";
import { getPermissionEngine } from "../extensions/permission-engine";
import { ToolExecutor } from "../extensions/tool-executor";
import type { ToolCallResult } from "../extensions/types";
import type { EventBus } from "./events";
import type { AgentEvents } from "../types";
import type { PendingPermissionInfo } from "./stream-chat/host";
import type { InvocationGuard } from "../extensions/runtime-locks";

/**
 * The slice of `ToolExecutor` a workflow tool step uses. Structural, so
 * the real `ToolExecutor` satisfies it without an `implements` clause
 * and tests can supply a two-method fake.
 */
export interface WorkflowToolRunner {
  /**
   * Bind the acting principal for this dispatch. Load-bearing, not
   * cosmetic: without it `registerCallProvenance` marks the call
   * `ownerless`, every reverse-RPC the tool makes soft-fails -32106, and
   * user-scoped extension storage resolves to no bucket at all.
   */
  setCurrentUserId(userId: string): void;
  /**
   * Pin the conversation coordinate a nested reverse-RPC will inherit.
   * Optional so a minimal test double need not implement it, but the
   * real `ToolExecutor` does: `handlePiInvoke` reads
   * `host.currentConversationId` and falls back to a synthetic
   * `cross-ext-<reqId>` when it is unset. That synthetic is a key no
   * non-interactive scope claims, so a gate raised against it used to
   * park — hanging the workflow that was awaiting the outer call.
   */
  setCurrentConversationId?(conversationId: string): void;
  executeToolCall(
    toolName: string,
    input: Record<string, unknown>,
    conversationId: string,
    messageId: string | null,
    options?: { signal?: AbortSignal; invocationGuard?: InvocationGuard },
  ): Promise<ToolCallResult>;
}

/**
 * The executor's `pendingPermissions` map, as two plain functions.
 *
 * ONLY meaningful for an INTERACTIVE run (one started from a chat turn by
 * the `run_workflow` tool). While a sensitive step's consent card is up,
 * the surrounding turn's tool call is still "in flight", so the run
 * watchdog's `deferralReason` must be able to see the gate and defer
 * indefinitely — it reads `host.pendingPermissions` and nothing else. A
 * workflow gate that never registers there is invisible to it, and the
 * watchdog kills the run at the `callTimeoutMs` ceiling, tearing the
 * prompt down before the user can answer it (the "stuck chat" defect —
 * see `wireHostPendingPermissions` in stream-chat/setup-tools.ts).
 *
 * A NON-interactive run never needs it: its gates are refused
 * synchronously and never park, so there is no wait to explain.
 */
export interface PendingPermissionGate {
  register: (key: string, info: PendingPermissionInfo) => void;
  deregister: (key: string) => void;
}

/** Factory shape the executor injects; see `WorkflowExecutorOptions`.
 *  The gate is per-RUN (it names the surrounding chat turn's host), so it
 *  arrives as an argument rather than being baked into the factory. */
export type WorkflowToolRunnerFactory = (
  pendingPermissions?: PendingPermissionGate,
) => WorkflowToolRunner;

/**
 * Build the production runner: the process-wide extension registry + the
 * PDP singleton + a fresh `ToolExecutor` bound to the workflow bus.
 *
 * Deps are passed to `getPermissionEngine` so a workflow fired before any
 * chat turn (the cold-start case — a scheduled or CLI run) initialises
 * the singleton instead of throwing "not initialized". If another path
 * already built it, the deps are ignored and the existing instance is
 * returned; the factory has no race-sensitive state. Same pattern as the
 * EZ-action forwarder (`web/src/routes/api/ez-actions/[name]/+server.ts`).
 */
export function createWorkflowToolRunner(
  bus: EventBus<AgentEvents>,
  pendingPermissions?: PendingPermissionGate,
): WorkflowToolRunner {
  const registry = ExtensionRegistry.getInstance();
  const engine = getPermissionEngine({
    registry,
    bus,
    db: { _token: "workflow-tool-step" },
  });
  const executor = new ToolExecutor(registry, engine, { bus });
  if (pendingPermissions) {
    executor.setPendingPermissionGate(
      pendingPermissions.register,
      pendingPermissions.deregister,
    );
  }
  return executor;
}
