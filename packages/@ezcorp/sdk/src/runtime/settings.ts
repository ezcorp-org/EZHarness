// ── settings — Phase B SDK helpers for per-extension user/global config ──
//
// Tool handlers receive the resolved settings map on the per-invocation
// `ToolHandlerContext.invocationMetadata.settings` channel (set by the host
// in `src/extensions/tool-executor.ts`). These free functions read from
// that location with no additional channel chatter — by the time a value
// reaches the handler, the host has already clamped it against the
// manifest's declared schema, so the handler can trust the shape.

import type { ToolHandlerContext } from "./rpc";

/** Read a single resolved setting value from the current invocation. Returns
 *  `undefined` when the host did not attach a settings map (extension
 *  declares no `settings` block) or the key is absent. The runtime ALWAYS
 *  validates user inputs against the manifest schema server-side — by the
 *  time a value reaches a handler, it has already been clamped to the
 *  declared field type. */
export function getSetting<T = unknown>(
  ctx: ToolHandlerContext | undefined,
  key: string,
): T | undefined {
  const settings = ctx?.invocationMetadata?.settings as
    | Record<string, unknown>
    | undefined;
  if (!settings) return undefined;
  return settings[key] as T | undefined;
}

/** Return the full resolved settings map for the current invocation, or an
 *  empty object when none was attached. Callers may treat the returned
 *  object as read-only — mutating it has no host-side effect. */
export function getAllSettings(
  ctx: ToolHandlerContext | undefined,
): Record<string, unknown> {
  const settings = ctx?.invocationMetadata?.settings as
    | Record<string, unknown>
    | undefined;
  return settings ?? {};
}
