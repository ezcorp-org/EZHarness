// ── RBAC — typed client for the ezcorp/rbac-check reverse RPC ────
//
// `ctx.rbac.check(scope)` asks the HOST whether the acting user holds
// `scope` for THIS extension in the calling conversation's project.
// Everything identity-shaped is resolved host-side from the call's
// provenance token (mirrors `ctx.search` / `ctx.llm` keeping secrets
// and identity host-side):
//   - the USER is the provenance `onBehalfOf` (host-issued, never wire),
//   - the EXTENSION is registry-resolved from the subprocess identity
//     (a wire param claiming another extension is ignored),
//   - the PROJECT is derived from the calling conversation (background
//     fires with no conversation check at the "all projects" (null)
//     coordinate — only NULL-project grants match there).
//
// `scope` must be a core verb (use / configure / secrets / approve-runs
// / manage — always checkable) or a custom scope this extension DECLARED
// in `permissions.rbacScopes`. An unknown scope is a hard JSON-RPC error
// (-32602, naming the valid scopes) — that is an authoring bug, not a
// deny. A missing grant is NOT an error: it resolves `false`
// (deny-by-default; admins resolve `true` for everything).

import { getChannel } from "./channel";

/** Wire result of `ezcorp/rbac-check`. */
export interface RbacCheckResult {
  granted: boolean;
}

export class Rbac {
  /**
   * True iff the acting user holds `scope` for this extension at the
   * calling conversation's project. Deny-by-default: `false` means "no
   * grant", never throws for it. Throws the transport error as-is for
   * protocol failures (unknown scope → JsonRpcError -32602 naming the
   * valid scopes; unresolved provenance; ownerless background fire).
   */
  async check(scope: string): Promise<boolean> {
    const result = await getChannel().request<RbacCheckResult>("ezcorp/rbac-check", { scope });
    // Fail-closed on a malformed host reply: only a literal `true` grants.
    return result?.granted === true;
  }
}
