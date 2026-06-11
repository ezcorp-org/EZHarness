/**
 * briefing/runtime-registry.ts — the indirection that lets backend
 * briefing code (BriefingDaemon in src/startup/background-timers.ts,
 * the run pipeline) reach the LIVE AgentExecutor + conversation SSE
 * bus that are constructed in the web layer ($lib/server/context's
 * ensureInitialized()).
 *
 * The import direction forbids src/ from importing the web bus or
 * executor directly, so the web layer REGISTERS them here at init —
 * the exact pattern established by preview-bus-registry.ts. When
 * nothing has registered (backend-only boot, or before web init),
 * `getBriefingRuntime()` returns null and the daemon's tick degrades
 * to a logged no-op (fail-safe) — never a crash, and crucially never a
 * consecutive-errors increment for a boot-ordering race.
 */
import type { EventBus } from "../events";
import type { AgentEvents } from "../../types";
import type { AgentExecutor } from "../executor";

/** The slice of AgentExecutor the briefing pipeline consumes. Narrowed
 *  so tests can stub it without standing up the full executor. */
export type BriefingExecutor = Pick<AgentExecutor, "streamChat" | "cancelRun">;

export interface BriefingRuntime {
  executor: BriefingExecutor;
  bus: EventBus<AgentEvents>;
}

let registered: BriefingRuntime | null = null;

/** Register the live executor + bus. Called once by the web layer's
 *  `ensureInitialized()` after both are constructed. Idempotent. */
export function registerBriefingRuntime(runtime: BriefingRuntime): void {
  registered = runtime;
}

/** Read the registered runtime, or null when none is registered yet. */
export function getBriefingRuntime(): BriefingRuntime | null {
  return registered;
}

/** Test-only: clear the registration. */
export function _resetBriefingRuntimeForTests(): void {
  registered = null;
}
