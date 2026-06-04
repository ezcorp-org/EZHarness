/**
 * preview-bus-registry.ts — a tiny indirection so the backend preview
 * watcher (src/startup/background-timers.ts) can reach the LIVE conversation
 * SSE bus that lives in the web layer ($lib/server/context's getBus()).
 *
 * The import direction forbids the backend from importing the web bus
 * directly, so the web layer REGISTERS its bus here at init, and the
 * watcher's onDetected handler reads it back. When nothing has registered
 * (a backend-only boot, or before web init), `getRegisteredPreviewBus()`
 * returns null and the detection bridge degrades to a logged no-op
 * (fail-safe) — never a crash.
 *
 * This is the documented wiring point for "push the consent card onto the
 * live conversation stream": web init calls `registerPreviewBus(getBus())`.
 */

import type { EventBus } from "../events";
import type { AgentEvents } from "../../types";

let registeredBus: EventBus<AgentEvents> | null = null;

/**
 * Register the live conversation SSE bus. Called once by the web layer's
 * `ensureInitialized()` after the bus is constructed. Idempotent.
 */
export function registerPreviewBus(bus: EventBus<AgentEvents>): void {
  registeredBus = bus;
}

/** Read the registered bus, or null when none is registered yet. */
export function getRegisteredPreviewBus(): EventBus<AgentEvents> | null {
  return registeredBus;
}

/** Test-only: clear the registration. */
export function _resetPreviewBusForTests(): void {
  registeredBus = null;
}
