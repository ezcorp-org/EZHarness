/**
 * WS3b — the mode → model/tier task binding.
 *
 * `modes` are EZCorp's "task type" concept: a mode already shapes a turn's
 * system-prompt instruction, its tool surface, its thinking level and its
 * temperature. It has ALSO carried `preferred_model` / `preferred_provider`
 * columns since modes existed — typed, validated, persisted, and read by
 * nothing. A mode that said "review code on Opus" got whatever the router
 * happened to pick. This module is the missing half: it turns those columns
 * (plus the new `preferred_tier`) into the model a turn actually calls.
 *
 * ── The whole precedence chain, in one pure function ──
 * {@link resolveTurnModelBinding} implements every level ABOVE the heuristic
 * classifier, most specific first:
 *
 *   1. per-turn UI pin  ─┐ both already folded into `pin.model` by the
 *   2. conversation pin ─┘ messages route — a set value means "honor this".
 *   3. mode `preferred_model` (+ `preferred_provider`)
 *   4. mode `preferred_tier`  → handed to the classifier as its tier HINT
 *   5. classifier heuristic   → not this module's business
 *
 * Levels 1–3 produce a MODEL; 4 produces only a tier hint. The caller's
 * contract is simple: a returned `model` means the turn is pinned and the
 * classifier must not run; a returned `tier` is the classifier's hint.
 * They are never both set.
 *
 * ── Why a mode preference is a PIN, not a per-turn re-route ──
 * The routing wiring only consults this at thread start, because a thread
 * that already has a model is never re-routed (Anthropic's cache is
 * prefix-matched; switching models mid-conversation is a guaranteed miss
 * plus a 25% cache-write surcharge — see
 * `docs/decisions/2026-07-08-compaction-cache-anchor.md` and the comment on
 * `resolveModelTierAndCredential`). So a mode preference behaves exactly
 * like a pin applied on turn 1 and inherited from then on.
 *
 * ── Availability, and why every field is validated independently ──
 * A mode is long-lived config; the model catalog is not. A mode naming a
 * retired snapshot id must DEGRADE to the next precedence level, never fail
 * the turn and never dial a synthesized endpoint (`resolveModelObject` will
 * happily invent a model object for an unknown id, so "does resolveModel
 * throw?" is not an availability test — it never throws). Each named field
 * is therefore checked against the models the deployment can actually run,
 * and applied only if it names something that exists. Same failure posture
 * as the tier ladder's `resolveLadderEntry`: a stale entry is skipped, not
 * an error.
 *
 * ── Purity (why this lives in src/runtime, not src/providers) ──
 * Identical reasoning to its sibling `./tier-ladder`: `src/providers/**` is
 * excluded from the coverage gate, and a routing decision this load-bearing
 * must be coverage-enforced. No DB, no registry, no pi-ai import — the mode
 * row and the available-model list are passed in. The tier vocabulary comes
 * from `../tier-classifier`, which stays the single source of tier truth.
 */

import { isRoutingTier, type RoutingTier } from "../tier-classifier";

/**
 * Structural view of the routing columns on a `modes` row — deliberately not
 * an import of `DbMode`, so this module stays dependency-free and a caller
 * can hand it any shape carrying these three fields.
 *
 * `preferredTier` is typed as a plain string because the column is plain
 * `TEXT` (no CHECK constraint — same "narrow at the TypeScript layer"
 * convention as every other enum-ish column in `schema.ts`). A row written
 * by hand, by an older build, or by a direct SQL edit can hold anything, so
 * it is validated here rather than trusted.
 */
export interface ModeRoutingPreference {
  preferredProvider?: string | null;
  preferredModel?: string | null;
  preferredTier?: string | null;
}

/** Minimal view of one model the deployment can run RIGHT NOW (the
 *  `/api/models` registry row, narrowed to the two fields availability
 *  needs). Structural so the caller passes its own list unchanged. */
export interface AvailableModel {
  id: string;
  provider: string;
}

/**
 * The model pin the turn ARRIVED with. `model` already folds in both the
 * per-turn UI picker and the conversation's established model, so a set
 * value is levels 1–2 of the chain collapsed into one field.
 */
export interface TurnModelPin {
  provider?: string;
  model?: string;
}

/** Which precedence level decided the model. Provenance only — the routing
 *  decision is the `{provider, model, tier}` triple — but naming it is what
 *  makes "my mode's model did nothing" a one-log-line diagnosis instead of
 *  the silent no-op this module exists to fix. */
export type ModelBindingSource = "turn-pin" | "mode-model" | "mode-tier" | "classifier";

/**
 * The binding to route on. `model` and `tier` are mutually exclusive by
 * construction: a pinned turn has nothing left to classify, and an
 * unpinned turn has no model yet.
 */
export interface ModelBinding {
  /** Provider to hand `resolveModel`. */
  provider?: string;
  /** Model to hand `resolveModel`. Set ⇒ the turn is PINNED and the
   *  classifier must not run. */
  model?: string;
  /** Tier hint to hand the classifier. Only ever set when `model` is not. */
  tier?: RoutingTier;
  source: ModelBindingSource;
}

/** A stored preference, trimmed, with blank/whitespace treated as unset —
 *  an empty string in a nullable TEXT column means "no preference", not
 *  "pin the model named ''". */
function preference(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Resolve the full model/tier precedence chain for one turn.
 *
 * Pure + total — always returns a binding, never throws. `availableModels`
 * is only consulted to validate what the MODE named; an empty list simply
 * means no mode-named model or provider can be honored this turn (which is
 * why the caller can safely skip the catalog read on a mode that names
 * neither).
 */
export function resolveTurnModelBinding(
  pin: TurnModelPin,
  mode: ModeRoutingPreference | null | undefined,
  availableModels: readonly AvailableModel[],
): ModelBinding {
  // Levels 1–2. The turn arrived with a model, so it is already routed:
  // return the pin verbatim and don't read the mode at all. This is the
  // cache anchor — an established thread is never re-routed, not even by a
  // mode preference, and not even to a "better" model.
  if (pin.model) return { provider: pin.provider, model: pin.model, source: "turn-pin" };

  // Level 4, hoisted: from here down the mode's tier is the classifier's
  // hint, whatever happens to the model.
  const rawTier = mode?.preferredTier;
  const tier = isRoutingTier(rawTier) ? rawTier : undefined;
  const hintOnly = (provider: string | undefined): ModelBinding => ({
    provider,
    tier,
    source: tier ? "mode-tier" : "classifier",
  });

  // A caller that chose a PROVIDER is more specific than the mode's own
  // provider/model pair, so it wins outright. Returning here also keeps the
  // pair atomic: we never hand `resolveModel` a caller's provider paired
  // with a model the mode named for a different one.
  if (pin.provider) return hintOnly(pin.provider);

  const modeProvider = preference(mode?.preferredProvider);
  const modeModel = preference(mode?.preferredModel);

  // Level 3. The mode's model — honored only if the deployment still serves
  // it, and only on the provider the mode named (when it named one). The
  // provider comes back from the MATCHED entry rather than from the column,
  // because `resolveModel` ignores a model id passed without a provider
  // (its Level-1 passthrough needs both) — a model-only pin would silently
  // route by tier instead, which is the same dead config this module fixes.
  const matched = modeModel
    ? availableModels.find(
        (m) => m.id === modeModel && (modeProvider === undefined || m.provider === modeProvider),
      )
    : undefined;
  if (matched) return { provider: matched.provider, model: matched.id, source: "mode-model" };

  // Levels 4–5. No model to pin — either the mode named none, or the one it
  // named is gone. A provider the deployment actually serves still applies
  // (`resolveModel` will pick that provider's model for the routed tier);
  // an unrecognized one is dropped like any other stale preference.
  const provider =
    modeProvider !== undefined && availableModels.some((m) => m.provider === modeProvider)
      ? modeProvider
      : undefined;
  return hintOnly(provider);
}
