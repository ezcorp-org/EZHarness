// ── Loop log — artifact mirror + opt-in dashboard ───────────────────
//
// Phase 2 ships the seam (wiring entry points used by `loop.ts`); Phase 3
// fills the bodies (host-mediated `fsWrite` artifact mirror under
// `.ezcorp/extension-data/<loop>/` + the generalized dashboard helper with
// content-free SSE invalidation via `pushPage`). Splitting the module out
// of `loop.ts` keeps `defineLoop` free of fs/page concerns and lets the
// log surface be tested in isolation.

import type { RegisteredLoop } from "./loop";
import type { LoopRunState } from "./loop-types";

/**
 * Wire a loop's `log` block at registration time: register the dashboard
 * page + its row-action handlers (Phase 3) and attach `reg.pushDashboard`.
 * A loop with no `log.dashboard` is a no-op.
 */
export function wireLog(_reg: RegisteredLoop): void {
  // Phase 3 body.
}

/**
 * After a terminal outcome: write the artifact mirror (fail-soft) + push
 * the dashboard. A loop with no `log` block is a no-op.
 */
export async function runTerminalLog(
  _reg: RegisteredLoop,
  _run: LoopRunState,
  _outcome: unknown,
): Promise<void> {
  // Phase 3 body.
}
