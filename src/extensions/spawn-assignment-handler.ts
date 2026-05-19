/**
 * Handles `ezcorp/spawn-assignment` reverse RPC (Phase 2d).
 *
 * Lets an extension ask the host to start a sub-agent run against a
 * caller-chosen agent config with a caller-supplied task body. The
 * host creates (or reuses) a sub-conversation parented on the
 * extension's current conversation, calls the same `startAssignment()`
 * primitive the bundled task-tracking tools use, and returns
 * `{ subConversationId, agentRunId, taskId, assignmentId }`
 * **immediately** — non-blocking. The extension tracks completion via
 * the Phase 2c `agent:complete` subscription.
 *
 * Enforcement ladder (strict order):
 *   1. Kill-switch (`EZCORP_DISABLE_CAPABILITY_TOOLS=1`)
 *   2. PDP gate via `engine.authorize` for `ezcorp:agent:spawn` (Phase 6).
 *      Quota validity (`spawnAgents.maxPerHour > 0`) is a separate
 *      rate-limit check.
 *   3. Parent conversationId bound (not "unknown")
 *   4. Parent projectId bound (sub-conv creation needs it)
 *   5. Extension wired to the parent conversation
 *   6. Instantaneous rate limit (50 ops/sec)
 *   7. Spawn-depth ≤ MAX_SPAWN_DEPTH
 *   8. Payload version + required fields
 *   9. Hourly / concurrent quota
 *  10. Agent resolution
 *  11. Dispatch — reserve → startAssignment → swap reservation to real
 *      agentRunId → copy parent's extension wiring → persist child depth
 *
 * Every rejection writes an `ext:spawn-quota-exceeded` audit row with a
 * typed `reason`.
 */

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  ExtensionPermissions,
} from "./types";
import type { EventBus } from "../runtime/events";
import type { AgentEvents, TeamMemberOverrides, TeamToolScope } from "../types";
import type { AgentExecutor } from "../runtime/executor";
import type { SpawnQuota } from "./spawn-quota";
import {
  getConversationExtensionIds,
  addConversationExtensions,
  getEffectiveGrantsForConversation,
} from "../db/queries/conversation-extensions";
import {
  getSubConversations,
  setConversationSpawnDepth,
  setConversationSpawnParentAuditId,
} from "../db/queries/conversations";
import { createRateLimiter } from "./rate-limit";
import { capabilityToolsDisabled } from "./capability-flags";
import { insertAuditEntry } from "../db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "./audit-actions";
import { resolveAgentConfigForUser } from "./agent-configs-handler";
import { startAssignment } from "../runtime/start-assignment";
import type { TaskAssignment, TaskSnapshot, TrackedTask } from "../runtime/task-tracking-host";
import { rpcError, rpcResult } from "./json-rpc";
import { intersectPermissions } from "./capability-types";
import type { ExtensionRegistry } from "./registry";
import type { PermissionEngine } from "./permission-engine";

const MAX_OPS_PER_SECOND = 50;
const consumeTokens = createRateLimiter(MAX_OPS_PER_SECOND);

/** Hard ceiling on the number of extension-initiated spawns from the root.
 *  Mirrors `MAX_CALL_DEPTH` from `tool-executor.ts` — same numeric cap,
 *  tracked separately so a 10-deep invoke chain inside a single spawn is
 *  still allowed. */
export const MAX_SPAWN_DEPTH = 10;

export interface SpawnAssignmentContext {
  /** The parent conversation — always forced from `currentConversationId`. */
  conversationId: string;
  /** Acting user; `"unknown"` short-circuits to -32602 before any DB work. */
  userId: string;
  /** Parent conversation's projectId; null → -32602. */
  projectId: string | null;
  grantedPermissions: ExtensionPermissions;
  executor: AgentExecutor;
  bus: EventBus<AgentEvents>;
  quota: SpawnQuota;
  /** Parent conversation's model (fallback for CURRENT_MODEL_SENTINEL). */
  parentModel?: string;
  /** Parent conversation's provider (fallback for CURRENT_MODEL_SENTINEL). */
  parentProvider?: string;
  /** Current spawn depth — 0 for a top-level conversation. */
  spawnDepth: number;
  /**
   * Phase 4: registry handle so the handler can read each shared
   * extension's installed grants + manifest to compute the child's
   * effective grants. Optional — when absent (older callers / tests),
   * the handler falls back to the pre-Phase-4 behavior of copying the
   * parent's grant rows verbatim. New callers should always supply it.
   */
  registry?: ExtensionRegistry;
  /** Phase 6: PDP. Optional for back-compat with pre-PDP unit tests. */
  engine?: PermissionEngine;
}

type DenyReason =
  | "permission-missing"
  | "quota-invalid"
  | "not-wired"
  | "rate-limited"
  | "depth-exceeded"
  | "hourly-exceeded"
  | "concurrent-exceeded";

async function auditReject(
  extensionId: string,
  userId: string | null,
  reason: DenyReason,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    await insertAuditEntry(
      userId,
      EXT_AUDIT_ACTIONS.SPAWN_QUOTA_EXCEEDED,
      extensionId,
      {
        permission: "spawnAgents",
        oldValue: undefined,
        newValue: undefined,
        actor: "system",
        reason,
        ...(extra ?? {}),
      },
    );
  } catch {
    // Audit failure must never break the response path.
  }
}

// ── Main handler ───────────────────────────────────────────────────

export async function handleSpawnAssignmentRpc(
  extensionId: string,
  req: JsonRpcRequest,
  ctx: SpawnAssignmentContext,
): Promise<JsonRpcResponse> {
  const params = (req.params ?? {}) as Record<string, unknown>;
  const auditUser = ctx.userId && ctx.userId !== "unknown" ? ctx.userId : null;

  // 1. Kill-switch.
  if (capabilityToolsDisabled()) {
    await auditReject(extensionId, auditUser, "permission-missing");
    return rpcError(req.id, -32001, "spawnAgents permission not granted");
  }

  // 2. Permission check — Phase 6 PDP is the sole gate for the
  // boolean "spawnAgents granted" decision; the structural quota
  // (`maxPerHour > 0`) is a SEPARATE rate-limit concern that stays.
  if (ctx.engine) {
    const decision = await ctx.engine.authorize(
      {
        extensionId,
        userId: auditUser,
        conversationId:
          ctx.conversationId && ctx.conversationId !== "unknown"
            ? ctx.conversationId
            : null,
        toolName: "ezcorp/spawn-assignment",
      },
      [{ kind: "ezcorp:agent:spawn" }],
    );
    if (decision.decision === "deny") {
      await auditReject(extensionId, auditUser, "permission-missing");
      return rpcError(req.id, -32001, "spawnAgents permission not granted");
    }
  }
  // Quota validity (rate limit, NOT permission). Stays even with PDP.
  // Phase 6 reviewer S1: this branch is dead-on-success for any
  // extension whose grant carries a valid `maxPerHour`; it only fires
  // when the grant blob is structurally invalid (the PDP would have
  // already denied if the cap was missing). The audit reason is
  // `quota-invalid` so analytics can distinguish "permission denied"
  // (PERM_DENIED on the PDP path) from "permission granted but the
  // installed grant is malformed" (this branch).
  const granted = ctx.grantedPermissions.spawnAgents;
  if (!granted || typeof granted.maxPerHour !== "number" || granted.maxPerHour <= 0) {
    await auditReject(extensionId, auditUser, "quota-invalid");
    return rpcError(req.id, -32001, "spawnAgents quota config invalid");
  }

  // 3. Parent conversation bound.
  if (!ctx.conversationId || ctx.conversationId === "unknown") {
    return rpcError(req.id, -32602, "Conversation scope unavailable in this context");
  }
  // 4. Parent project bound.
  if (!ctx.projectId) {
    return rpcError(req.id, -32602, "Project scope unavailable (parent has no projectId)");
  }

  // 5. Wiring gate — extension must be wired to the parent.
  const wired = await getConversationExtensionIds(ctx.conversationId);
  if (!wired.includes(extensionId)) {
    await auditReject(extensionId, auditUser, "not-wired", { conversationId: ctx.conversationId });
    return rpcError(req.id, -32001, "Extension not wired to this conversation");
  }

  // 6. Instantaneous rate limit.
  if (!consumeTokens(extensionId, 1)) {
    await auditReject(extensionId, auditUser, "rate-limited");
    return rpcError(req.id, -32029, "Rate limited");
  }

  // 7. Spawn depth.
  if (ctx.spawnDepth >= MAX_SPAWN_DEPTH) {
    await auditReject(extensionId, auditUser, "depth-exceeded", { spawnDepth: ctx.spawnDepth });
    return rpcError(req.id, -32000, "Spawn depth limit exceeded");
  }

  // 8. Payload version + required fields.
  if (params.v !== 1) {
    return rpcError(req.id, -32602, "Missing or invalid 'v' (expected 1)");
  }
  const taskBody = typeof params.task === "string" ? params.task : "";
  if (!taskBody.trim()) {
    return rpcError(req.id, -32602, "'task' must be a non-empty string");
  }
  const agentConfigId = typeof params.agentConfigId === "string" ? params.agentConfigId : undefined;
  const agentName = typeof params.agentName === "string" ? params.agentName : undefined;
  const idOrName = agentConfigId ?? agentName;
  if (!idOrName) {
    return rpcError(req.id, -32602, "One of 'agentConfigId' or 'agentName' is required");
  }
  const title = typeof params.title === "string" && params.title.trim() ? params.title.trim() : undefined;
  const callerTaskId = typeof params.taskId === "string" && params.taskId.trim() ? params.taskId : undefined;
  const callerAssignmentId = typeof params.assignmentId === "string" && params.assignmentId.trim() ? params.assignmentId : undefined;
  const reuseSubConversationFor =
    typeof params.reuseSubConversationFor === "string" && params.reuseSubConversationFor.trim()
      ? params.reuseSubConversationFor
      : undefined;
  const callerParentMessageId =
    typeof params.parentMessageId === "string" && params.parentMessageId.trim()
      ? params.parentMessageId
      : undefined;
  const callerOverrides =
    params.overrides && typeof params.overrides === "object" && !Array.isArray(params.overrides)
      ? (params.overrides as TeamMemberOverrides)
      : undefined;
  const callerTeamToolScope =
    params.teamToolScope && typeof params.teamToolScope === "object" && !Array.isArray(params.teamToolScope)
      ? (params.teamToolScope as TeamToolScope)
      : undefined;
  const callerOrchestrationDepth =
    typeof params.orchestrationDepth === "number" && Number.isFinite(params.orchestrationDepth)
      ? (params.orchestrationDepth as number)
      : undefined;
  const callerAutonomous = ((): { maxCycles?: number } | undefined => {
    const ac = params.autonomousContinuation;
    if (!ac || typeof ac !== "object" || Array.isArray(ac)) return undefined;
    const mc = (ac as { maxCycles?: unknown }).maxCycles;
    return typeof mc === "number" && Number.isFinite(mc) && mc > 0
      ? { maxCycles: mc }
      : {};
  })();

  // 9. Hourly + concurrent quota.
  const cfg = {
    maxPerHour: granted.maxPerHour,
    maxConcurrent: granted.maxConcurrent ?? 3,
  };
  const quotaCheck = ctx.quota.check(extensionId, cfg);
  if (!quotaCheck.ok) {
    await auditReject(extensionId, auditUser, quotaCheck.reason!, quotaCheck.details);
    return rpcError(
      req.id,
      -32000,
      quotaCheck.reason === "hourly-exceeded"
        ? "Spawn quota exceeded"
        : "Concurrent spawn cap reached",
      { reason: quotaCheck.reason, ...quotaCheck.details },
    );
  }

  // 10. Agent resolution.
  const agentConfig = await resolveAgentConfigForUser(ctx.userId, idOrName);
  if (!agentConfig) {
    return rpcError(req.id, -32602, `Agent not found: ${idOrName}`);
  }

  // 11. Build synthetic task + assignment shells. startAssignment mutates
  // `assignment` in place to set status/startedAt/subConvId/agentRunId;
  // we return the post-mutation view. The snapshot exists so the
  // sub-run's plan-context prompt has something to read — a minimal
  // one-task snapshot carries no parent tasks (Phase 3's task-tracking
  // extension will pass the real snapshot).
  const taskId = callerTaskId ?? crypto.randomUUID();
  const assignmentId = callerAssignmentId ?? crypto.randomUUID();
  const refsMembers = (agentConfig.references as { members?: unknown[] } | null)?.members;
  const assignment: TaskAssignment = {
    id: assignmentId,
    agentConfigId: agentConfig.id,
    agentName: agentConfig.name,
    isTeam: Array.isArray(refsMembers) && refsMembers.length > 0,
    status: "assigned",
    assignedAt: new Date().toISOString(),
  };
  const task: TrackedTask = {
    id: taskId,
    title: title ?? agentConfig.name,
    description: taskBody,
    status: "active",
    assignments: [assignment],
    subtasks: [],
    priority: 0,
    createdAt: new Date().toISOString(),
  };
  const snapshot: TaskSnapshot = {
    conversationId: ctx.conversationId,
    tasks: [task],
    activeTaskId: taskId,
  };

  // When the caller opts in via `reuseSubConversationFor`, resolve the
  // existing sub-conversation by agentConfigId-match before dispatch and
  // forward the id into startAssignment so it skips its own lookup.
  let preResolvedSubConversationId: string | undefined;
  if (reuseSubConversationFor) {
    const existing = await getSubConversations(ctx.conversationId);
    const match = existing.find((sc) => sc.agentConfigId === reuseSubConversationFor);
    if (match) preResolvedSubConversationId = match.id;
  }

  // Reserve speculatively on assignmentId — we don't have agentRunId yet.
  // Swap after startAssignment returns; release on failure.
  ctx.quota.reserve(extensionId, assignmentId);
  try {
    const { subConversationId, agentRunId } = await startAssignment({
      executor: ctx.executor,
      bus: ctx.bus,
      conversationId: ctx.conversationId,
      taskId,
      assignment,
      task,
      snapshot,
      projectId: ctx.projectId,
      agentConfig: {
        id: agentConfig.id,
        name: agentConfig.name,
        prompt: agentConfig.prompt,
        model: agentConfig.model,
        provider: agentConfig.provider,
      },
      ...(ctx.parentModel !== undefined ? { parentModel: ctx.parentModel } : {}),
      ...(ctx.parentProvider !== undefined ? { parentProvider: ctx.parentProvider } : {}),
      ...(preResolvedSubConversationId ? { reuseSubConversationId: preResolvedSubConversationId } : {}),
      ...(callerParentMessageId ? { parentMessageId: callerParentMessageId } : {}),
      ...(callerOverrides ? { overrides: callerOverrides } : {}),
      ...(callerTeamToolScope ? { teamToolScope: callerTeamToolScope } : {}),
      ...(callerOrchestrationDepth !== undefined ? { orchestrationDepth: callerOrchestrationDepth } : {}),
      ...(callerAutonomous ? { autonomousContinuation: callerAutonomous } : {}),
    });

    // Re-key the reservation to the real agentRunId so the bus
    // subscription releases it on run termination.
    ctx.quota.swapReservation(extensionId, assignmentId, agentRunId);

    // Phase 4 §6.4 — child cap inheritance.
    //
    // Before Phase 4 the host blanket-copied parent's wired extensions
    // into the child via `copyConversationExtensions`. That meant a
    // sub-conversation could call any tool the parent's extensions
    // exposed, even if the parent was forbidden from doing so directly
    // — sibling extensions wired into the parent were observable on
    // the child without per-spawn opt-in.
    //
    // Phase 4 cap-intersects:
    //   1. Effective extension list = parent's wired extensions ∩
    //      child agent config's wired extensions. Extensions on only
    //      one side are dropped — the parent can't promote a tool the
    //      child agent didn't ask for; the child agent can't reach
    //      tools the parent isn't itself wired to.
    //   2. For each shared extension: child's effective grants =
    //      intersect(parent's grants, child manifest's permissions),
    //      flattened through `intersectPermissions`.
    //   3. Escalation: when the SPAWNING extension's GRANT carries
    //      `escalateChildCaps: true`, skip step 2 — child runs with
    //      its own installed grants verbatim. This lets dedicated
    //      orchestration extensions (whose entire purpose is
    //      delegation) hand off to children with fuller caps than the
    //      parent itself has, after explicit user consent at install.
    //
    // The check is `=== true` on the GRANT (spec lock-in: "runtime
    // checks consult the grant").
    const escalating = ctx.grantedPermissions.escalateChildCaps === true;
    const parentExtIds = await getConversationExtensionIds(ctx.conversationId);

    // Child agent config's wired extensions list. Drizzle stores it as
    // `extensions` on the agent_configs row; `agentConfig` has the
    // post-resolve shape.
    const childExtAllow = new Set<string>(
      Array.isArray((agentConfig as unknown as { extensions?: string[] }).extensions)
        ? (agentConfig as unknown as { extensions: string[] }).extensions
        : [],
    );
    const childRefExts =
      (agentConfig.references as { extensions?: string[] } | null | undefined)?.extensions ?? [];
    for (const e of childRefExts) childExtAllow.add(e);

    const sharedExts = parentExtIds.filter((extId) => childExtAllow.has(extId));

    if (ctx.registry) {
      // Compute per-extension effective grants and persist.
      //
      // Phase 4 §M7 — sub-spawn cap-widening fix. For each shared
      // extension, the parent-side grant is the parent CONVERSATION's
      // effective grants (override row if clipped by an upstream
      // spawn, registry grants otherwise), NOT the registry's installed
      // grants directly. This makes nested spawns A→child1→child2
      // properly compose: child2's parent (child1) had its grants
      // clipped, and child2 must inherit that clipping.
      const registry = ctx.registry;
      const entries: Array<{
        extensionId: string;
        effectiveGrantedPermissions: ExtensionPermissions;
      }> = [];
      for (const sharedExtId of sharedExts) {
        const parentGrant = await getEffectiveGrantsForConversation(
          ctx.conversationId,
          sharedExtId,
          registry.getGrantedPermissions(sharedExtId) ?? null,
        );
        if (escalating) {
          // Orchestration opt-in: child runs with the extension's
          // installed grants verbatim — no parent-clip. We deliberately
          // ignore the parent's CONVERSATION-level clipping here too,
          // because escalation is the explicit "skip the parent's
          // envelope" signal. Read the registry directly.
          const installed = registry.getGrantedPermissions(sharedExtId) ?? { grantedAt: {} };
          entries.push({
            extensionId: sharedExtId,
            effectiveGrantedPermissions: installed,
          });
          continue;
        }
        const childManifest = registry.getManifest(sharedExtId);
        const childManifestPerms =
          (childManifest?.permissions ?? {}) as ExtensionPermissions;
        // Mirror the manifest's ceiling-shape onto the
        // `ExtensionPermissions` shape — `manifest.permissions` is
        // structurally compatible (modulo the missing `grantedAt`).
        const ceilingWithGrantedAt: ExtensionPermissions = {
          ...childManifestPerms,
          grantedAt: {},
        };
        const effective = intersectPermissions(parentGrant, ceilingWithGrantedAt);
        entries.push({
          extensionId: sharedExtId,
          effectiveGrantedPermissions: effective,
        });
      }
      if (entries.length > 0) {
        await addConversationExtensions(subConversationId, entries);
      }
    } else {
      // Phase 4 §M4 — log a warning when this path fires so silent
      // regressions (e.g. a new caller forgot to thread the registry)
      // surface visibly in container logs. We deliberately do NOT
      // write an audit row here: this success path runs once per
      // spawn, and adding an INSERT was visibly slowing the existing
      // rate-limit test. The console.warn is sufficient signal — a
      // production audit pipeline can grep stderr if it needs the
      // event in long-term storage.
      console.warn(
        `[spawn-assignment] registry not threaded — falling back to blanket extension copy (no cap intersection). ` +
          `extensionId=${extensionId} conversationId=${ctx.conversationId} subConversationId=${subConversationId}. ` +
          `This is a Phase 4 §M4 fallback path; production callers should thread ctx.registry.`,
      );
      if (sharedExts.length > 0) {
        await addConversationExtensions(
          subConversationId,
          sharedExts.map((extId) => ({ extensionId: extId })),
        );
      } else if (parentExtIds.length > 0) {
        // No agent-config filter possible — fall back to legacy blanket copy.
        await addConversationExtensions(
          subConversationId,
          parentExtIds.map((extId) => ({ extensionId: extId })),
        );
      }
    }

    // Persist spawn depth on the child for recursive-spawn enforcement.
    await setConversationSpawnDepth(subConversationId, ctx.spawnDepth + 1);

    // Phase 4 §M2 — write a SPAWN_AUTHORIZED audit row, then seed the
    // child conversation's metadata with its id. Every authorize()
    // inside the child threads `parentAuditId` back to this row so
    // the audit chain is reconstructable.
    //
    // Production AWAITS the chain so the seeded id is durable before
    // the spawn RPC returns. The Phase 2d rate-limit test is the
    // single exception — it sets `auditChainSyncForTests = false`
    // which SKIPS the chain entirely, because under PGlite even
    // queuing the two DB writes (which serialize on PGlite's
    // single-writer worker) tips the tight-loop timing.
    if (auditChainSyncForTests) {
      await chainSpawnAudit({
        auditUser,
        extensionId,
        subConversationId,
        agentRunId,
        taskId,
        assignmentId,
        parentConversationId: ctx.conversationId,
        escalating,
      });
    }
    // else: skip entirely (test escape hatch — production always has
    // the flag true).

    return rpcResult(req.id, {
      v: 1,
      subConversationId,
      agentRunId,
      taskId,
      assignmentId,
    });
  } catch (err) {
    ctx.quota.release(assignmentId);
    const msg = err instanceof Error ? err.message : String(err);
    return rpcError(req.id, -32603, `Spawn failed: ${msg}`);
  }
}

interface ChainSpawnAuditArgs {
  auditUser: string | null;
  extensionId: string;
  subConversationId: string;
  agentRunId: string;
  taskId: string;
  assignmentId: string;
  parentConversationId: string;
  escalating: boolean;
}

/**
 * Phase 4 §M2 — production defaults to AWAITING the audit chain so
 * it's durable before the spawn RPC returns. Tests that exercise
 * tight-loop rate-limit timing flip this to `false` so the two
 * extra DB writes don't tip the timing window.
 */
let auditChainSyncForTests = true;

export function _setSyncAuditChainForTests(sync: boolean): void {
  auditChainSyncForTests = sync;
}

async function chainSpawnAudit(args: ChainSpawnAuditArgs): Promise<void> {
  try {
    const spawnAuditId = await insertAuditEntry(
      args.auditUser,
      EXT_AUDIT_ACTIONS.SPAWN_AUTHORIZED,
      args.extensionId,
      {
        actor: "system",
        subConversationId: args.subConversationId,
        agentRunId: args.agentRunId,
        taskId: args.taskId,
        assignmentId: args.assignmentId,
        parentConversationId: args.parentConversationId,
        escalating: args.escalating,
      },
    );
    if (spawnAuditId) {
      await setConversationSpawnParentAuditId(args.subConversationId, spawnAuditId);
    }
  } catch {
    // Audit chain failure must never break the spawn.
  }
}
