// ── cancelRun — Phase 4 SDK wrapper (§5.3) ─────────────────────────
//
// Thin type-safe wrapper over the `ezcorp/cancel-run` reverse RPC.
// The host (src/extensions/cancel-run-handler.ts) cancels a sub-run
// the calling extension previously originated via `spawnAssignment`
// and — critically — releases the concurrent-quota slot immediately,
// so the very next `spawnAssignment` under a fan-out-under-timeout
// load succeeds instead of blocking on a stale reservation.
//
// Permission: reuses `spawnAgents` — an extension that can spawn can
// cancel its own spawns. Cross-extension cancel attempts resolve to
// `{ cancelled: false, reason: "not-owned" }` rather than throwing,
// mirroring the "orchestrator silently forgets" semantics the legacy
// `invoke-agent.ts` timeout path uses.
//
// Error codes the host can raise (propagated as `JsonRpcError` with
// `.code`, `.message`, and `.data` preserved):
//   -32001  spawnAgents permission not granted
//   -32602  Invalid params (missing / non-string agentRunId)
//   -32603  Cancel path unavailable (executor not wired)
//
// Non-error results:
//   { v: 1, cancelled: true }                               — run was cancelled
//   { v: 1, cancelled: false, reason: "not-owned" }         — caller didn't spawn it
//   { v: 1, cancelled: false, reason: "missing-run" }       — already completed

import { getChannel } from "./channel";

export interface CancelRunResult {
  /** True iff the executor actually cancelled a live run. False for
   *  ownership violations and already-completed runs (see `reason`). */
  cancelled: boolean;
  /** Only present when `cancelled === false`. `"not-owned"` = the
   *  agentRunId is not one this extension spawned. `"missing-run"` =
   *  the executor had no record of the run (already finished / never
   *  existed). */
  reason?: "not-owned" | "missing-run";
}

/**
 * Cancel a sub-run this extension previously originated via
 * `spawnAssignment`. Resolves with `{ cancelled: true }` on success;
 * resolves with `{ cancelled: false, reason }` for ownership violations
 * and already-terminated runs. Protocol-level failures (permission,
 * malformed input) throw `JsonRpcError`.
 *
 * On a successful cancel the host immediately releases the concurrent
 * quota slot, so a subsequent `spawnAssignment` against the same
 * extension succeeds right away without waiting for the async
 * `run:cancel` bus round-trip.
 */
export async function cancelRun(agentRunId: string): Promise<CancelRunResult> {
  if (typeof agentRunId !== "string" || !agentRunId.trim()) {
    throw new Error("cancelRun: 'agentRunId' must be a non-empty string");
  }
  const result = await getChannel().request<{
    v: 1;
    cancelled: boolean;
    reason?: "not-owned" | "missing-run";
  }>("ezcorp/cancel-run", {
    v: 1,
    agentRunId,
  });
  return {
    cancelled: result.cancelled,
    ...(result.reason ? { reason: result.reason } : {}),
  };
}
