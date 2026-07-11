// Host-side helpers for the Phase 4 `orchestration` bundled extension.
//
// Phase 4 §5.1: the legacy built-in `invoke_agent` tool (deleted in
// commit 5) was migrated into a bundled extension at
// `docs/extensions/examples/orchestration/`. This module is the
// executor's entry point for wiring that extension on a per-turn
// basis — mirroring the Phase 3 `task-tracking-host.ts` pattern.
//
// Two exports:
//   • `ensureOrchestrationWired(conversationId)` — idempotent insert into
//     `conversation_extensions`. Wire-on-first-use (same contract as
//     `ensureTaskTrackingWired`).
//   • `wireOrchestrationToolsForTurn(params)` — per-turn tool wiring.
//     Resolves the extension's `invoke_agent` manifest, clones the input
//     schema, injects the current turn's `availableAgents` ids as an
//     `enum` on `agentConfigId`, threads per-turn invocation metadata
//     (parentMessageId / overrides / teamToolScope / orchestrationDepth)
//     through the 6-arg `extensionToAgentTool` seam, and appends the
//     resulting AgentTool to the turn's tool list.
//
// Commit 4 shipped this file + bundled the extension alongside the
// legacy built-in (dual-wired); commit 5 flipped the executor to call
// these helpers and deleted the legacy built-in — this file is now
// the sole host-side entry point for the invoke_agent tool.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { getDb } from "../db/connection";
import { conversationExtensions } from "../db/schema";
import { getExtensionByName } from "../db/queries/extensions";
import { getSetting } from "../db/queries/settings";
import type { ExtensionRegistry } from "../extensions/registry";
import { ToolExecutor, extensionToAgentTool } from "../extensions/tool-executor";
import { getPermissionEngine } from "../extensions/permission-engine";
import type { ExtensionStateMediator } from "../extensions/state-mediator";
import type { SpawnQuota } from "../extensions/spawn-quota";
import type { AgentExecutor } from "./executor";
import { logger } from "../logger";
const log = logger.child("orchestration-host");

// Default base give-up timeout the extension applies when the operator has
// not set `orchestration:invokeTimeoutMs`. Aligned with the host's own idle
// watchdog (90s / 300s / 900s) so `invoke_agent` no longer gives up BEFORE
// the platform considers a child idle. The extension re-derives its own
// fallback (see docs/extensions/examples/orchestration/index.ts) — this
// value is the host-side default threaded through `invocationMetadata`.
const DEFAULT_INVOKE_TIMEOUT_MS = 300_000;

/**
 * Resolve the operator-configured `invoke_agent` base timeout in ms from the
 * `orchestration:invokeTimeoutMs` setting. A positive finite number wins;
 * anything else (unset, malformed, non-positive) falls back to
 * {@link DEFAULT_INVOKE_TIMEOUT_MS}. A settings-read failure must NOT kill
 * the turn — it is logged and treated as "unset".
 */
async function resolveInvokeTimeoutMs(): Promise<number> {
  try {
    const v = await getSetting("orchestration:invokeTimeoutMs");
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  } catch (err) {
    log.warn("Failed to read orchestration:invokeTimeoutMs — using default", {
      error: String(err),
    });
  }
  return DEFAULT_INVOKE_TIMEOUT_MS;
}

// ── Extension-id resolution (cached) ────────────────────────────────

let cachedExtId: string | undefined;

/**
 * Resolve the installed `orchestration` extension's DB id. Cached
 * module-local after the first hit; resets on a fresh process only.
 * Returns `undefined` if the extension isn't installed — we bubble that
 * up as a non-throwing `ensureOrchestrationWired → false` so a
 * misconfigured boot skips orchestration for the turn rather than
 * killing the whole run.
 */
async function getOrchestrationExtensionId(): Promise<string | undefined> {
  if (cachedExtId) return cachedExtId;
  const row = await getExtensionByName("orchestration");
  if (!row) return undefined;
  cachedExtId = row.id;
  return cachedExtId;
}

/** Test-only: clear the cached extension id so mocks re-resolve. */
export function _resetOrchestrationExtensionIdCache(): void {
  cachedExtId = undefined;
}

// ── Wiring helper ───────────────────────────────────────────────────

/**
 * Ensure the orchestration extension is wired to the given conversation.
 * Idempotent via the existing `UNIQUE(conversation_id, extension_id)`
 * constraint on `conversation_extensions`.
 *
 * Returns `true` when the row exists after the call (fresh or already
 * wired) and `false` on catastrophic failure (extension missing from DB,
 * insert throws with something other than a unique-constraint collision).
 * Callers use the return value to decide whether to skip the extension
 * for the current turn.
 */
export async function ensureOrchestrationWired(
  conversationId: string,
): Promise<boolean> {
  let extId: string | undefined;
  try {
    extId = await getOrchestrationExtensionId();
  } catch (err) {
    log.warn("Failed to resolve orchestration extension id", {
      error: String(err),
    });
    return false;
  }
  if (!extId) {
    log.warn("Orchestration extension not installed — did ensureBundledExtensions() run?");
    return false;
  }

  try {
    const db = getDb();
    await db
      .insert(conversationExtensions)
      .values({ conversationId, extensionId: extId })
      .onConflictDoNothing();
    return true;
  } catch (err) {
    // Unique-constraint collisions from concurrent first-use should
    // already be absorbed by `onConflictDoNothing()` above, but some DB
    // drivers surface unique errors as thrown exceptions anyway. Treat
    // any thrown error whose message mentions the unique constraint as
    // a success (the row exists because someone else just inserted it).
    const msg = String(err instanceof Error ? err.message : err);
    if (/unique|duplicate/i.test(msg)) return true;
    log.warn("Failed to insert conversation_extensions row for orchestration", {
      conversationId,
      error: msg,
    });
    return false;
  }
}

// ── Per-turn tool wiring ────────────────────────────────────────────

/** Subset of the agent-config shape the executor hands us per-turn. */
export interface AgentInfo {
  id: string;
  name: string;
  description: string;
}

export interface WireOrchestrationToolsParams {
  agentTools: AgentTool[];
  conversationId: string;
  runId: string;
  /** Agents mentioned/available this turn. Empty = no tool wired. */
  availableAgents: AgentInfo[];
  parentModel?: string;
  parentProvider?: string;
  parentMessageId?: string;
  /** Current orchestration depth (0 = top-level). */
  depth: number;
  memberOverrides?: Record<string, unknown>;
  /** Opaque forward-compat param preserved to match current executor signature. */
  subAgentMembers?: unknown[];
  teamToolScope?: { allowedTools?: string[]; deniedTools?: string[] };
  registry: ExtensionRegistry;
  executor: AgentExecutor;
  stateMediator?: ExtensionStateMediator;
  spawnQuota?: SpawnQuota;
  userId?: string;
}

/**
 * Build the per-turn `invoke_agent` AgentTool wrapper for the
 * orchestration extension and append it to `params.agentTools`.
 *
 * Steps:
 *   1. Resolve the orchestration extension's installed id + find the
 *      `invoke_agent` RegisteredTool via the registry. Missing either
 *      → log + return without appending (skip for this turn).
 *   2. Empty `availableAgents` → log warn + return. The LLM would get
 *      an `enum: []` schema it can't satisfy; wiring the tool at all
 *      just invites hallucinated ids.
 *   3. Clone the manifest inputSchema and inject
 *      `properties.agentConfigId.enum = [...availableAgents.map(a => a.id)]`
 *      (duplicates filtered). This is the §5.1 "per-turn schema
 *      override" — handed to `extensionToAgentTool` via its optional
 *      `schemaOverride` arg.
 *   4. Build the invocation metadata object: include a field only when
 *      its source value is defined. `orchestrationDepth` is always
 *      present because `depth` is required.
 *   5. Spin up a ToolExecutor configured with the registry + the
 *      executor's state mediator, spawn quota, user id, and the parent
 *      conversation's model/provider. Same wiring the scratchpad auto-
 *      wire block does in executor.ts.
 *   6. Call the 6-arg `extensionToAgentTool` and push the result into
 *      `agentTools`. The wrapped tool's LLM-visible name is the
 *      unnamespaced `invoke_agent` (from `RegisteredTool.originalName`)
 *      — this preserves the `executor.ts:1079/1099` event-suppression
 *      special-case and the `agentTools.find(t => t.name === "invoke_agent")`
 *      auto-spin-up lookup at executor.ts:899.
 */
export async function wireOrchestrationToolsForTurn(
  params: WireOrchestrationToolsParams,
): Promise<void> {
  const {
    agentTools,
    conversationId,
    runId,
    availableAgents,
    parentModel,
    parentProvider,
    parentMessageId,
    depth,
    memberOverrides,
    teamToolScope,
    registry,
    executor,
    stateMediator,
    spawnQuota,
    userId,
  } = params;

  if (availableAgents.length === 0) {
    log.warn(
      "wireOrchestrationToolsForTurn called with no availableAgents — tool not appended",
      { conversationId, runId },
    );
    return;
  }

  const extId = await getOrchestrationExtensionId();
  if (!extId) {
    log.warn(
      "Orchestration extension not installed — skipping invoke_agent wiring for turn",
      { conversationId, runId },
    );
    return;
  }

  const registeredTools = registry.getToolsForExtension(extId);
  const invokeAgentTool = registeredTools.find(
    (t) => t.originalName === "invoke_agent",
  );
  if (!invokeAgentTool) {
    log.warn(
      "Orchestration extension has no invoke_agent tool registered — registry not loaded?",
      { conversationId, runId, extId },
    );
    return;
  }

  // 1. Per-turn schema override — clone the manifest inputSchema and
  //    inject the `enum` onto `agentConfigId`. Structured clone keeps the
  //    cached RegisteredTool.inputSchema pristine for other turns /
  //    conversations.
  const uniqueAgentIds = Array.from(new Set(availableAgents.map((a) => a.id)));
  const schemaOverride = structuredClone(
    invokeAgentTool.inputSchema as Record<string, unknown>,
  );
  const props = schemaOverride.properties as Record<string, Record<string, unknown>> | undefined;
  if (props?.agentConfigId) {
    props.agentConfigId = {
      ...props.agentConfigId,
      enum: uniqueAgentIds,
    };
  }

  // 2. Per-turn invocation metadata for `invoke_agent`. Only include
  //    defined sources. `orchestrationDepth`, `parentRunId`, and
  //    `invokeTimeoutMs` are always set. `parentRunId` is THIS turn's
  //    orchestrator run id: the handler threads it into the spawn so the
  //    child registers under it and a Stop on the orchestrator cascades to
  //    the child (P1 cascade cancel). `invokeTimeoutMs` is the resolved
  //    operator base give-up timeout — the handler uses it as the base for
  //    its activity-aware wait (a valid per-call `timeoutSeconds` overrides).
  const invokeTimeoutMs = await resolveInvokeTimeoutMs();
  const invocationMetadata: Record<string, unknown> = {
    orchestrationDepth: depth,
    parentRunId: runId,
    invokeTimeoutMs,
  };
  if (parentMessageId !== undefined) invocationMetadata.parentMessageId = parentMessageId;
  if (memberOverrides !== undefined) invocationMetadata.overrides = memberOverrides;
  if (teamToolScope !== undefined) invocationMetadata.teamToolScope = teamToolScope;

  // 3. ToolExecutor wiring — same set of wires the scratchpad auto-wire
  //    block builds at executor.ts:828-835 so the extension's reverse-
  //    RPC handlers (storage / agent-configs / spawn-assignment /
  //    cancel-run) are all routable. Phase 1: every ToolExecutor site
  //    requires the PDP — `getPermissionEngine()` returns the
  //    singleton initialized at executor boot. We pass NO deps here:
  //    the executor boot in runtime/executor.ts is the canonical
  //    initializer (it has the real bus + registry refs); a stale
  //    placeholder bus/db here would silently lose if this caller
  //    won the init race. Phase 6 will tighten this further when the
  //    engine starts reading from `bus`/`db` directly. The factory
  //    throws with a clear message if the singleton isn't pre-init,
  //    making any boot-order regression loud.
  const engine = getPermissionEngine();
  const toolExec = new ToolExecutor(registry, engine);
  if (stateMediator) toolExec.setStateMediator(stateMediator);
  toolExec.setExecutor(executor);
  if (spawnQuota) toolExec.setSpawnQuota(spawnQuota);
  if (userId) toolExec.setCurrentUserId(userId);
  toolExec.setCurrentModel(parentModel);
  toolExec.setCurrentProvider(parentProvider);

  // 4. Wrap `invoke_agent` via the 6-arg extensionToAgentTool. `name`
  //    uses the unnamespaced `originalName` so executor.ts's special-
  //    cases keep working.
  const invokeAgentAgentTool = extensionToAgentTool(
    {
      name: invokeAgentTool.originalName,
      description: invokeAgentTool.description,
      inputSchema: invokeAgentTool.inputSchema as Record<string, unknown>,
    },
    toolExec,
    conversationId,
    runId,
    schemaOverride,
    invocationMetadata,
  );
  agentTools.push(invokeAgentAgentTool);
}
