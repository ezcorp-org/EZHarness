// ── Extension-RBAC on the triage actions (M6, spec §2 / §13) ────────
//
// The gate triage verbs (approve/fix/skip/abort via `respond`, and the `yolo`
// autopilot) mutate a run every authenticated user could otherwise drive. M6
// gates them behind two custom `permissions.rbacScopes` (declared in
// ezcorp.config.ts) + `extension_rbac_grants` — the github-projects
// `write-tickets` pattern:
//
//   - `respond-gate` — answer a parked gate (approve / fix / skip / abort),
//     from the chat `code_factory_respond` tool AND the Hub respond action.
//   - `yolo`        — the yolo autopilot (bulk fix-once-then-approve). Its OWN
//     scope: it is strictly broader than a single approve (it clears every
//     remaining gate of a run), so a grant can hand out `respond-gate` without
//     `yolo`, per the M2 review's RBAC-priority note.
//
// Enforcement is host-mediated: the SDK `ctx.rbac.check(scope)` resolves the
// acting user from the call's provenance token (a Hub click mints
// `onBehalfOf = the clicking user`), the project from the conversation, and the
// grant from `extension_rbac_grants` (admins hold every scope). The chat
// `code_factory_respond` tool ALSO declares `rbacScope: "respond-gate"` in its
// manifest entry so the HOST denies it pre-dispatch — defence in depth, so a
// denied action can't run even if this in-code guard were bypassed.
//
// This module is PURE + I/O-free: `check` is an injected seam (production wires
// `new Rbac().check`), so both allow + deny paths are unit-tested with a fake.

/** The scope answering a parked gate (respond: approve/fix/skip/abort). */
export const RESPOND_SCOPE = "respond-gate";
/** The scope for the yolo autopilot — broader than a single approve. */
export const YOLO_SCOPE = "yolo";

/** The scope-check seam: true iff the acting user holds `scope` for this
 *  extension in the calling context. Production: `new Rbac().check`. */
export type RbacCheck = (scope: string) => Promise<boolean>;

/** Outcome of a scope guard: allowed, or refused with a clear 403-style
 *  message (never a 500 — a denied action is a refusal, not an error). */
export type ScopeGuard = { ok: true } | { ok: false; error: string };

/**
 * Fail-closed scope guard: resolve `scope` via `check`; on `false` OR on a
 * transport throw (unresolved provenance, ownerless fire, host blip) return a
 * clear 403-style refusal naming the scope + the grant path. A THROW is treated
 * as a DENY — an unresolvable identity can never satisfy a grant. `actionLabel`
 * is the human phrase for the refused action ("respond to a gate", "run the
 * yolo autopilot").
 */
export async function guardScope(
  check: RbacCheck,
  scope: string,
  actionLabel: string,
): Promise<ScopeGuard> {
  let granted: boolean;
  try {
    granted = await check(scope);
  } catch {
    // An unresolved/ownerless provenance (or a host error) is a DENY, never a
    // silent allow: the acting identity could not be established.
    granted = false;
  }
  if (granted) return { ok: true };
  return {
    ok: false,
    error:
      `refused: you need the '${scope}' permission to ${actionLabel} on this ` +
      `code-factory extension. Ask an admin to grant it (extension RBAC → ` +
      `${scope}), then retry.`,
  };
}
