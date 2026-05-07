/**
 * Static registry of EZ actions. Code-defined; NOT user-extensible
 * in v1 — adding a new action means: add a handler file in this
 * directory, import it here, append it to `REGISTRY`, write tests.
 * An extension API for user-authored actions is v2.
 *
 * The registry is read by:
 *   - `/api/mentions/search?type=EZ` (popover listing)
 *   - `/api/ez-actions/[name]` (dispatch endpoint)
 *   - `src/runtime/mention-wiring.ts::stripEzActionTokens` (LLM
 *     prompt strip — every registered action's name resolves; unknown
 *     names get silently stripped too, matching the literal-strip
 *     discipline used for `/[cmd:…]` and `$[feature:…]`)
 *
 * Empty list in Phase 1 — Phase 2 wires the `distill` handler.
 */
import type { EzAction } from "./types";

// Phase 1 ships an empty registry — the popover shows "No matches
// found" until Phase 2 lands the `distill` handler. Adding new
// actions in v1 = append to this array (after writing the handler
// file + its tests).
const REGISTRY: readonly EzAction[] = [];

/**
 * Public listing for the popover. `handler` is intentionally NOT
 * surfaced — the search route returns plain `{name, description}`
 * objects so the wire format never carries a function reference
 * (which would be a serialization bug, but defense-in-depth keeps
 * the boundary explicit).
 */
export function listEzActions(): readonly Pick<EzAction, "name" | "description">[] {
  return REGISTRY.map(({ name, description }) => ({ name, description }));
}

/**
 * Lookup helper for the dispatch endpoint. Returns the full action
 * (including `handler`) or `null` if no such action exists.
 *
 * Caller MUST treat `null` as "404 / silent strip" — never a server
 * error. Unknown action names in user prompts are equivalent to
 * unknown slash commands or unknown feature names: they pass through
 * harmlessly.
 */
export function getEzAction(name: string): EzAction | null {
  return REGISTRY.find((a) => a.name === name) ?? null;
}
