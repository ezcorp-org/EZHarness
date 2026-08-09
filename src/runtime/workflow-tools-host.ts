/**
 * Host-side wiring for the `run_workflow` built-in.
 *
 * Mirrors `ez-tools-host.ts`: the `setup-tools.ts` call site is a one-liner
 * and the per-turn factory context is assembled here.
 *
 * Why a dedicated host rather than `getBuiltinToolDefs()`:
 *   - `run_workflow` needs no project root, and DOES need per-user, per-turn
 *     coordinates (`userId`, `conversationId`, `projectId`) that would leak
 *     across a project switch if they were cached with the project-rooted
 *     built-ins. Exactly the Ez-tool situation.
 *   - It must reach `ctx.agentTools` BEFORE the executor's allowlist filter
 *     runs (`applyToolFilters`, executor.ts) — an allowlist mode otherwise
 *     sees an empty intersection and strips the whole toolset. Centralizing
 *     the wire makes that ordering invariant auditable in one place.
 *   - Recording the def in `builtinToolDefsMap` is LOAD-BEARING, not
 *     bookkeeping: subscribe-bridge resolves `callTimeoutMs` out of that map
 *     to size the watchdog's in-flight deferral. Miss it and `run_workflow`
 *     silently falls back to the 90s default, and any workflow longer than
 *     that gets its surrounding turn killed mid-run.
 *
 * Thread-safety: nothing async-shared. Each call is per-turn and mutates
 * only the supplied `agentTools` array and defs map in place.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BuiltinToolDef } from "./tools/types";
import type { PendingPermissionInfo } from "./stream-chat/host";
import { builtinToAgentTool } from "./tools/agent-tool";
import { createRunWorkflowTool, RUN_WORKFLOW_TOOL_NAME } from "./tools/run-workflow";
import { logger } from "../logger";

const log = logger.child("workflow-tools-host");

export interface WireRunWorkflowForTurnParams {
  /** Per-turn agentTools array (mutated in place). */
  agentTools: AgentTool[];
  /** Per-turn `BuiltinToolDef` map keyed by name. See the module doc — the
   *  watchdog reads `callTimeoutMs` from here. */
  builtinToolDefsMap: Map<string, BuiltinToolDef>;
  conversationId: string;
  /** Conversation OWNER — never anything the LLM can influence. Required:
   *  it is the principal `canRunWorkflow` authorizes and the delivery key
   *  for the run's `workflow:*` events. */
  userId: string;
  /** Derived server-side from the conversation, for the same reason. */
  projectId?: string;
  /** The executor's live pending-permission map. Forwarded so a workflow
   *  step's consent card is visible to the run watchdog as a legitimate
   *  user-wait instead of a hung tool. */
  pendingPermissions?: Map<string, PendingPermissionInfo>;
}

/**
 * Wire `run_workflow` into the per-turn `agentTools` array.
 *
 * Idempotent guard: a pre-existing tool of the same name wins and the wire
 * is a no-op — defensive against a future refactor that double-invokes us,
 * mirroring ez-tools-host's dedup posture.
 */
export function wireRunWorkflowForTurn(params: WireRunWorkflowForTurnParams): void {
  const { agentTools, builtinToolDefsMap, conversationId, userId, projectId, pendingPermissions } =
    params;

  if (agentTools.some((t) => t.name === RUN_WORKFLOW_TOOL_NAME)) return;

  const def = createRunWorkflowTool({
    userId,
    conversationId,
    ...(projectId ? { projectId } : {}),
    ...(pendingPermissions
      ? {
          pendingPermissions: {
            register: (key: string, info: PendingPermissionInfo) =>
              pendingPermissions.set(key, info),
            deregister: (key: string) => {
              pendingPermissions.delete(key);
            },
          },
        }
      : {}),
  });

  builtinToolDefsMap.set(def.name, def);
  agentTools.push(builtinToAgentTool(def));

  log.info("run_workflow wired for turn", { conversationId, userId, projectId });
}
