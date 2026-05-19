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
 * Phase 53 Stage 2: the legacy `distillAction` import + handler have
 * been deleted. The `distill` slot lives on as a metadata-only entry
 * — it's there so the popover surfacing (`!EZ:` mentions) keeps
 * showing `distill` to users, but the actual dispatch is handled by
 * the route forwarder at `/api/ez-actions/[name]/+server.ts`, which
 * special-cases `name === "distill"` and bypasses the registry's
 * handler entirely. The stub handler below is a defense-in-depth
 * throw: if the forwarder branch is ever broken, the dispatch path
 * fails loudly instead of silently producing wrong-shaped results.
 *
 * Future EZ actions register as full `EzAction` entries (with real
 * handlers) — the `distill` placeholder stays unique to the
 * forwarder pattern.
 */
import type { EzAction } from "./types";

const distillForwarderEntry: EzAction = {
  name: "distill",
  description: "Force-trigger lesson distillation on this conversation.",
  handler: async () => {
    // Defense-in-depth — the route forwarder handles `name === "distill"`
    // before reaching the registry handler. If this throws, the dispatch
    // route's special-case branch has regressed; surface loudly.
    throw new Error(
      "EZ action 'distill' must be served by the forwarder in /api/ez-actions/[name]/+server.ts (see Phase 53 Stage 2). The registry handler is a stub.",
    );
  },
};

const REGISTRY: readonly EzAction[] = [distillForwarderEntry];

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
