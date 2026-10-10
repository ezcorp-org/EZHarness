import { canonicalJson } from "@ezcorp/extension-contract";
import type { InvocationContext, JsonValue } from "@ezcorp/extension-contract";

/** The only reverse capability an isolated factory guest may name. */
export const FACTORY_GUEST_BROKER_METHOD = "factory.broker";
/** The single-tool adapter's reverse capability. */
export const FACTORY_GUEST_TOOL_METHOD = "factory.tool";

export class FactoryGuestFrameError extends Error {
  constructor(readonly code: "frame_method_denied" | "frame_invalid" | "frame_unbound", message: string) {
    super(message);
    this.name = "FactoryGuestFrameError";
  }
}

/**
 * Accepts one reverse control frame only when it names the allowed method and
 * carries the exact invocation context the host started.  That context holds
 * the worker and invocation identities, both derived from the attempt, so a
 * frame from another attempt, another invocation of the same attempt, or a
 * replayed older generation is denied rather than answered.
 *
 * Losing the controlling attachment therefore cannot authorize an effect: a
 * later attachment mints a different context and its frames no longer match.
 */
export function factoryGuestFrameInput(method: string, raw: unknown, expected: InvocationContext, allowed: string = FACTORY_GUEST_BROKER_METHOD): JsonValue {
  if (method !== allowed) throw new FactoryGuestFrameError("frame_method_denied", "Factory guest reverse capability is denied.");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new FactoryGuestFrameError("frame_invalid", "Factory guest control frame is invalid.");
  const frame = raw as { context?: unknown; input?: unknown };
  if (!Object.hasOwn(frame, "input") || frame.input === undefined) throw new FactoryGuestFrameError("frame_invalid", "Factory guest control frame has no input.");
  let bound = false;
  try { bound = canonicalJson(frame.context ?? null) === canonicalJson(expected); } catch { bound = false; }
  if (!bound) throw new FactoryGuestFrameError("frame_unbound", "Factory guest control frame does not match its worker, invocation, and attempt.");
  return frame.input as JsonValue;
}
