/**
 * WS7 — bounded routing EXPLORATION.
 *
 * ── What this is for ──
 * Every label the training substrate can derive from ordinary traffic is
 * CONFOUNDED: the classifier picked the model, so the only turns we ever
 * observe a cheap model on are the turns the classifier already thought were
 * cheap. A router trained on that data learns to reproduce the heuristic's
 * blind spots, because it never sees what a cheap model would have done on a
 * turn the heuristic routed up.
 *
 * Exploration fixes exactly that, and nothing else: with probability `rate`,
 * route one rung BELOW the tier the classifier chose and record that we did
 * (`usage.routingSignals.exploration`). The classifier's own verdict is still
 * stamped in `routingSignals.tier`, so each explored turn is a labelled
 * counterfactual — "the heuristic wanted `powerful`, `balanced` served it, and
 * here is whether the user escalated afterwards".
 *
 * ── The honest cost ──
 * This trades a little answer quality for unbiased data. On an explored turn
 * the user gets a weaker model than the heuristic asked for, and some of those
 * turns will be worse. That is a real cost paid by real users, so it is the
 * OPERATOR's call, not ours: the setting is admin-gated, defaults to `0`
 * (fully off — no deployment changes behaviour by upgrading), and every
 * explored turn is surfaced in the admin routing panel rather than being
 * silently absorbed. An out-of-range value is treated as OFF rather than
 * clamped, so a fat-fingered `100` (meaning "percent") cannot turn into
 * "explore every single turn".
 *
 * ── What it must never do ──
 * Exploration may only ever override a GUESS. A `declaredTier` (an extension
 * or EZ-action that needs a tier) is a correctness requirement and a `tierHint`
 * is explicit user intent — downgrading either would be a bug, not an
 * experiment. Both are recognised through the verdict's own `reason`, so this
 * module never re-derives the precedence that `../tier-classifier` owns.
 *
 * Pure by construction (no DB, no registry, randomness injected), like its
 * siblings `./tier-ladder` and `../tier-classifier`.
 */

import { type RoutingTier, type TierReason, tierBelow } from "../tier-classifier";

/** Settings key holding the operator-configured exploration probability. */
export const EXPLORATION_RATE_SETTING_KEY = "provider:explorationRate";

/** Exploration is OFF unless an operator turns it on. */
export const DEFAULT_EXPLORATION_RATE = 0;

/**
 * Verdict reasons exploration must NEVER override. `declared` is a
 * correctness requirement; `hint` is explicit user/caller intent. Everything
 * else — the heuristic predicates and a future learned `scorer` — is a guess,
 * and a guess is precisely what there is something to learn about.
 */
const PROTECTED_REASONS: readonly TierReason[] = ["declared", "hint"];

/**
 * Tolerant read of the stored rate → a probability in [0, 1].
 *
 * Anything that is not a finite number inside that range yields
 * {@link DEFAULT_EXPLORATION_RATE} (off). Out-of-range values are rejected
 * rather than clamped on purpose: `1.5` and `100` are far more likely to be a
 * unit mistake than a request to explore every turn, and the fail-safe
 * direction for a quality-costing knob is OFF.
 */
export function parseExplorationRate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_EXPLORATION_RATE;
  if (value < 0 || value > 1) return DEFAULT_EXPLORATION_RATE;
  return value;
}

/** {@link validateExplorationRate}'s result: the accepted probability, or the
 *  reason the submitted value is not one. */
export type ExplorationRateValidation = { ok: true; rate: number } | { ok: false; error: string };

/**
 * WRITE-time validation for the settings PUT route.
 *
 * The read path ({@link parseExplorationRate}) is deliberately tolerant — a bad
 * row must never fail a turn — which is exactly why the write must be strict:
 * without this, an operator who typed `100` meaning "one percent" would get a
 * silent no-op and conclude exploration is broken. Same reasoning as the tier
 * ladder's write-time gate.
 */
export function validateExplorationRate(value: unknown): ExplorationRateValidation {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, error: "must be a number between 0 and 1 (0 disables exploration)" };
  }
  if (value < 0 || value > 1) {
    return { ok: false, error: `${value} is not a probability — use a fraction between 0 and 1` };
  }
  return { ok: true, rate: value };
}

/** What {@link applyExploration} decided: the tier to route on, and whether
 *  that tier is an exploration rather than the classifier's pick. */
export interface ExplorationDecision {
  tier: RoutingTier;
  /** True ONLY when `tier` is one rung below the verdict's tier. */
  exploration: boolean;
}

/** The subset of a tier verdict exploration reads. */
export interface ExplorableVerdict {
  tier: RoutingTier;
  reason: TierReason;
}

/**
 * Decide whether THIS turn explores.
 *
 * Returns the verdict's own tier untouched — with `exploration: false` — in
 * every case except a rolled-and-won exploration, so a caller can treat a
 * false decision as "nothing happened". Total: never throws.
 *
 * `random` is injected (defaulting to `Math.random`) so tests pin the outcome
 * rather than sampling it; a stubbed `() => 0` always explores and
 * `() => 0.999…` never does at any sane rate.
 */
export function applyExploration(args: {
  verdict: ExplorableVerdict;
  rate: number;
  random?: () => number;
}): ExplorationDecision {
  const { verdict, rate } = args;
  const keep: ExplorationDecision = { tier: verdict.tier, exploration: false };
  // Off (the default, and every malformed setting) — cheapest exit first, so
  // an unconfigured deployment spends no randomness and no ladder walk.
  if (rate <= 0) return keep;
  // A declared tier need / explicit hint is not ours to experiment on.
  if (PROTECTED_REASONS.includes(verdict.reason)) return keep;
  // Bottom of the ladder: there is no cheaper rung to try.
  const below = tierBelow(verdict.tier);
  if (!below) return keep;
  // `< rate` (not `<=`) so rate 0 could not fire even if it reached here.
  if ((args.random ?? Math.random)() < rate) return { tier: below, exploration: true };
  return keep;
}
