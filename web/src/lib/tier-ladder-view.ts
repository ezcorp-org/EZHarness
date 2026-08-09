/**
 * Display + edit helpers for the Settings → Models tier-ladder editor
 * (`provider:tierModels`).
 *
 * The ladder SHAPE, its validation, and the built-in default all come from the
 * backend's pure module (`$server/runtime/routing/tier-ladder`) — imported
 * here rather than mirrored, so the editor can never disagree with the router
 * about what a valid ladder is or what the built-in rungs are. That module is
 * dependency-free (its only import is the tier vocabulary), so importing it
 * client-side pulls in no server runtime.
 *
 * What lives here is the part the backend has no opinion about: how to order
 * an ordered list in a UI, and what "the default you are overriding" looks
 * like on screen.
 */

import {
  DEFAULT_TIER_LADDER,
  isBuiltinRouterProvider,
  ladderModelFor,
  type TierLadder,
  type TierLadderEntry,
} from "$server/runtime/routing/tier-ladder";
import type { RoutingTier } from "$server/runtime/tier-classifier";

/** The `/api/models` row shape this editor reads. */
export interface TierLadderModelOption {
  provider: string;
  model: string;
  tier: string;
  displayName?: string;
  available?: boolean;
}

/** `provider/model`, the ladder's canonical one-line rendering. */
export function formatEntry(entry: TierLadderEntry): string {
  return `${entry.provider}/${entry.model}`;
}

/**
 * What routing picks for `tier` when the ladder names nothing — i.e. exactly
 * what a configured rung overrides, shown so the operator can see it.
 *
 * Mirrors `findModelForProviderInTier`'s two steps per provider (built-in rung,
 * else the first catalog model whose inferred tier matches), walked in the
 * deployment's provider preference order, and restricted to providers that are
 * actually reachable (`available`) — an unreachable provider's pick is not a
 * default anybody is overriding.
 */
export function heuristicTierDefaults(
  models: readonly TierLadderModelOption[],
  tier: RoutingTier,
  providerOrder: readonly string[],
): TierLadderEntry[] {
  const out: TierLadderEntry[] = [];
  for (const provider of providerOrder) {
    const reachable = models.filter((m) => m.provider === provider && m.available !== false);
    if (reachable.length === 0) continue;
    const builtin = isBuiltinRouterProvider(provider)
      ? ladderModelFor(DEFAULT_TIER_LADDER, tier, provider)
      : undefined;
    const model =
      (builtin && reachable.some((m) => m.model === builtin) ? builtin : undefined) ??
      reachable.find((m) => m.tier === tier)?.model;
    if (model) out.push({ provider, model });
  }
  return out;
}

/** The models an operator may add to `tier`, sorted so same-tier models come
 *  first (the common choice) without hiding a deliberate cross-tier pin. */
export function selectableModels(
  models: readonly TierLadderModelOption[],
  tier: RoutingTier,
): TierLadderModelOption[] {
  const reachable = models.filter((m) => m.available !== false);
  return [...reachable.filter((m) => m.tier === tier), ...reachable.filter((m) => m.tier !== tier)];
}

/** Move a rung by one slot. Returns `null` when the move is a no-op (either
 *  end), so the caller can skip a pointless save. */
export function moveRung(
  rungs: readonly TierLadderEntry[],
  index: number,
  direction: -1 | 1,
): TierLadderEntry[] | null {
  const target = index + direction;
  if (index < 0 || index >= rungs.length || target < 0 || target >= rungs.length) return null;
  const copy = [...rungs];
  const moved = copy[index]!;
  copy[index] = copy[target]!;
  copy[target] = moved;
  return copy;
}

/** Append a rung. Returns `null` when the exact provider+model pair is already
 *  on this tier — a duplicate rung can never change the outcome. */
export function addRung(
  rungs: readonly TierLadderEntry[],
  entry: TierLadderEntry,
): TierLadderEntry[] | null {
  if (rungs.some((r) => r.provider === entry.provider && r.model === entry.model)) return null;
  return [...rungs, entry];
}

/** Drop the rung at `index` (no-op for an out-of-range index). */
export function removeRung(
  rungs: readonly TierLadderEntry[],
  index: number,
): TierLadderEntry[] | null {
  if (index < 0 || index >= rungs.length) return null;
  return rungs.filter((_, i) => i !== index);
}

/** A copy of `ladder` with one tier replaced — the ladder is always written
 *  whole, so every save carries all three tiers. */
export function withTier(
  ladder: TierLadder,
  tier: RoutingTier,
  rungs: TierLadderEntry[],
): TierLadder {
  return { ...ladder, [tier]: rungs };
}
