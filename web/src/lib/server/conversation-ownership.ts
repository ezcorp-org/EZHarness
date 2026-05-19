/**
 * Shared root-conversation ownership resolution.
 *
 * # Why this exists
 *
 * Sub-conversations (agent runs, team members) carry `userId = null` —
 * they are not owned by anyone directly. The user's actual ownership
 * lives on the ROOT conversation at the top of the `parentConversationId`
 * chain. Three per-message endpoints plus `agent-chat` all need the same
 * "walk to root, then check ownership there" logic; before this module
 * each had its own copy (or, in the per-message case, an over-strict
 * `conv.userId !== user.id` check that locked sub-conv owners out of
 * Copy / Retry / Regenerate / Edit on their own sub-chats).
 *
 * This is the single extraction of the bounded parent-walk that
 * previously lived inline in
 * `web/src/routes/api/conversations/[id]/agent-chat/+server.ts`
 * (≈ lines 86–107). `agent-chat` is its first caller and its existing
 * test suites pin that the behaviour is byte-identical after the
 * extraction (no behaviour change in Phase 1).
 *
 * ## Reach equivalence with the legacy agent-chat walk
 *
 * The legacy inline walk seeded its loop at the sub-conv's DIRECT
 * PARENT (`rootConv = directParent`, already one hop above the
 * sub-conv) and then took up to 8 more hops (`depth < 8`). So when
 * called for a sub-conversation it could reach an ancestor up to
 * **9 levels** above that sub-conv.
 *
 * This helper instead seeds the walk at the conversation ITSELF
 * (`root = conv`, hop 0) so it works uniformly for top-level and
 * sub-conversations. To reach the SAME ancestor the legacy
 * directParent-seeded walk did, a self-seeded walk needs one extra
 * iteration — the hop that lands on the direct parent — hence the
 * bound is `LEGACY_PARENT_WALK_HOPS + 1` (see `MAX_PARENT_DEPTH`).
 * With that bound the reachable root is provably identical to the
 * pre-extraction code for every chain up to the legacy bound (Phase
 * 1's stated goal: no behaviour change).
 *
 * # Return contract — `{ conv, root }`
 *
 * `conv` is the requested conversation itself (self). `root` is the
 * top-of-chain conversation whose `userId` gates access.
 *
 * For a PARENTLESS (top-level) conversation `root === conv` — identical
 * to the pre-existing direct `conv.userId` check, so top-level callers
 * (the bulk of `/messages` traffic) behave EXACTLY as before. This
 * property is what makes the Phase-2 adoption safe and is pinned by
 * `messages-ownership-baseline-api.test.ts` (green pre- and post-Phase-2,
 * unchanged).
 *
 * `null` return ⇒ the caller MUST respond `404 "Not found"` (sec-H3
 * fail-closed: missing rows, missing parents, and unowned-by-non-admin
 * all collapse to an indistinguishable 404 so existence isn't leaked).
 *
 * # agent-chat's dual use of the result (open-question resolution)
 *
 * `agent-chat` has subtle, intentional asymmetry that this helper
 * PRESERVES by returning BOTH ends of the chain:
 *
 *   - It uses the **direct parent** (closer scope) for model / provider /
 *     projectId fallbacks — NOT the root. The helper does not compute the
 *     direct parent; agent-chat keeps its own `getConversation(subConv.
 *     parentConversationId)` lookup for that and for its distinct
 *     "Parent not found" 404 message. The helper owns ONLY the
 *     ownership-root walk + the auth decision.
 *   - It uses the **root** (`root.id`) for the `agent:spawn` /
 *     `agent:complete` `parentConversationId` so the main chat page's
 *     convId-keyed listener actually matches.
 *
 * So agent-chat continues to read `conv`/its-own-direct-parent for the
 * model fallbacks and `root` for ownership + the complete-event id. The
 * helper never collapses those two — that is the whole point of
 * returning the pair rather than a single conversation.
 *
 * # Bounded walk
 *
 * The parent walk is capped at `MAX_PARENT_DEPTH` hops (= the legacy
 * direct-parent-seeded reach, see the equivalence note above) so a
 * corrupt `parentConversationId` cycle can't infinite-loop the
 * request. On a cycle the walk gives up and the ownership check runs
 * against whatever conversation it reached — same fail-closed posture
 * as the original inline code (a cycle that never reaches a user-owned
 * root yields a 404 for non-admins).
 */

import * as convQueries from "$server/db/queries/conversations";
import type { AuthUser } from "$server/auth/types";

/**
 * The shape `getConversation` returns (drizzle `$inferSelect`). Derived
 * from the query's own return type so this module never drifts from the
 * schema.
 */
export type OwnershipConversation = NonNullable<
  Awaited<ReturnType<typeof convQueries.getConversation>>
>;

export interface ResolvedOwnership {
  /** The requested conversation itself (self). */
  conv: OwnershipConversation;
  /**
   * The root of the `parentConversationId` chain whose `userId` gates
   * access. Equals `conv` for a parentless (top-level) conversation.
   */
  root: OwnershipConversation;
}

/**
 * The legacy inline agent-chat walk allowed up to this many hops
 * ABOVE the sub-conv's direct parent (`for (depth = 0; depth < 8 …)`).
 */
const LEGACY_PARENT_WALK_HOPS = 8;

/**
 * Bound the parent walk so a corrupt cycle can't infinite-loop a
 * request.
 *
 * The legacy agent-chat walk was seeded at the sub-conv's DIRECT
 * PARENT (one hop up) and then took up to `LEGACY_PARENT_WALK_HOPS`
 * more hops. This helper seeds the walk at the conversation itself
 * (hop 0), so to reach the SAME ancestor the legacy code did it needs
 * exactly one additional iteration — the hop onto the direct parent.
 * Therefore the self-seeded bound is `LEGACY_PARENT_WALK_HOPS + 1`,
 * which makes walk-from-self provably equivalent to the old
 * walk-from-directParent for every chain up to the legacy bound (no
 * behaviour change — Phase 1's contract).
 */
export const MAX_PARENT_DEPTH = LEGACY_PARENT_WALK_HOPS + 1;

/**
 * Resolve the ownership-bearing root for a conversation and authorize
 * `user` against it.
 *
 * @returns `{ conv, root }` when the conversation exists AND `user`
 *   either owns the root (`root.userId === user.id`) or is an admin.
 *   `null` in every fail-closed case: conversation missing, a referenced
 *   parent missing, or the root not owned by a non-admin caller. Callers
 *   translate `null` to `404 "Not found"`.
 */
export async function resolveRootConversationForOwnership(
  id: string,
  user: AuthUser,
): Promise<ResolvedOwnership | null> {
  const conv = await convQueries.getConversation(id);
  if (!conv) return null;

  // Walk up the parent chain to the ROOT. A parentless conversation is
  // its own root (root === self) — identical to the legacy direct
  // `conv.userId` check, which is what keeps top-level callers
  // unchanged.
  let root = conv;
  for (
    let depth = 0;
    depth < MAX_PARENT_DEPTH && root.parentConversationId;
    depth++
  ) {
    const next = await convQueries.getConversation(root.parentConversationId);
    // A dangling parent ref is fail-closed: stop walking and authorize
    // against the furthest resolvable ancestor. For a sub-conv whose
    // immediate parent is missing this means `root` is still the
    // (unowned, userId=null) sub-conv → non-admins get 404, which is
    // the same posture as the original inline "Parent not found" path
    // from the caller's perspective (no access leaked).
    if (!next) break;
    root = next;
  }

  // sec-H3: fail-closed — unowned rows (null userId) are admin-only.
  if (root.userId !== user.id && user.role !== "admin") {
    return null;
  }

  return { conv, root };
}
