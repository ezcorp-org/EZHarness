/**
 * v1.4 — pure resolver for `!EZ:<extName>:<tool>` action names.
 *
 * Generalises the v1.3 single-purpose `name === "distill"` special-case
 * in `web/src/routes/api/ez-actions/[name]/+server.ts`. The route's
 * dispatch flow stays the same — auth, conversation-ownership gate,
 * registry lookup — but the forwarder is now reusable across every
 * bundled extension's tools.
 *
 * Design rules (locked in spec § Phase 3):
 *   - **Bundled-only**. User-installed (non-bundled) extensions DO NOT
 *     get `!EZ:` dispatch in v1.4. The chat-token surface is
 *     intentionally narrow because the result-card mapping is loose
 *     (see `forwardToBundled` in the route handler) and bundled-trust
 *     is the approval gate today. Wider dispatch is v1.5+ work.
 *   - **Pure**. No DB, no async — the resolver runs synchronously on
 *     every popover-search hit and every dispatch request, so it must
 *     stay cheap. Bundled-trust check is `isBundledExtensionName`
 *     (in-memory Set built from `BUNDLED_EXTENSIONS`).
 *   - **Legacy alias preserved**. `"distill"` resolves to
 *     `{extensionName: "lessons-distiller", toolName: "distill_now"}`.
 *     Persisted chat history carries `![EZ:distill]` tokens — these
 *     must keep working forever.
 *
 * Behavior:
 *   - `"distill"` → legacy alias for `lessons-distiller:distill_now`.
 *   - `"<ext>:<tool>"` → resolves iff `<ext>` is bundled. The
 *     resolver does NOT verify the tool exists in the registry — that
 *     check happens inside the route's forwarder, which can return
 *     a precise 404 card. The resolver's only job is the alias
 *     expansion + the bundled-trust gate.
 *   - Anything else (no colon, empty parts, `:`, `a:`, `:b`, `a::b`,
 *     `a:b:c`) → `null`. The route falls back to the registry lookup,
 *     which 404s for non-bundled, non-registered names.
 */
import { isBundledExtensionName } from "../../extensions/bundled";

export interface ResolvedEzAction {
  /** Manifest name of the bundled extension owning the tool. */
  extensionName: string;
  /** Tool name (without the `<ext>__` namespace prefix — the
   *  forwarder composes that for the registry lookup). */
  toolName: string;
  /** True when this resolution came from the legacy `"distill"`
   *  shorthand. The forwarder uses this to choose the
   *  `__ezDistillerOutcome` envelope mapping over the generic minimal
   *  card. */
  legacyAlias: boolean;
}

/** Legacy alias map — `"distill"` is the only entry. New aliases can
 *  land here with a one-line addition + a test case in
 *  `__tests__/resolve-bundled.test.ts`. */
const LEGACY_ALIASES: Readonly<Record<string, { extensionName: string; toolName: string }>> = {
  distill: { extensionName: "lessons-distiller", toolName: "distill_now" },
};

export function resolveBundledEzAction(actionName: string): ResolvedEzAction | null {
  if (typeof actionName !== "string") return null;
  const trimmed = actionName.trim();
  if (trimmed.length === 0) return null;

  // Legacy alias branch — short-circuit before parsing for the colon.
  const alias = LEGACY_ALIASES[trimmed];
  if (alias) {
    return {
      extensionName: alias.extensionName,
      toolName: alias.toolName,
      legacyAlias: true,
    };
  }

  // Generic `<ext>:<tool>` branch. Reject anything that isn't exactly
  // two non-empty colon-separated parts. `"a:b:c"` is rejected because
  // the underlying tool name in the registry is namespaced as
  // `<ext>__<tool>`; allowing extra colons would muddy the parsing.
  const parts = trimmed.split(":");
  if (parts.length !== 2) return null;
  const [extensionName, toolName] = parts;
  if (!extensionName || !toolName) return null;

  // Bundled-trust gate. User-installed extensions return null →
  // route falls back to the static EzActions registry which will
  // 404 since the registry only carries the legacy `distill`
  // metadata stub.
  if (!isBundledExtensionName(extensionName)) return null;

  return {
    extensionName,
    toolName,
    legacyAlias: false,
  };
}
