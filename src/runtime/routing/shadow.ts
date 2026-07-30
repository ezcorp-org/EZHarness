/**
 * WS7d — SHADOW MODE: evaluate a candidate routing policy on live traffic
 * without letting it touch a single turn.
 *
 * ── Why this exists ──
 * `scripts/routing-sweep.ts` proposes better thresholds OFFLINE, by replaying
 * logged `routingSignals`. But a replay can only score turns the current policy
 * produced; it cannot tell you how often a candidate would actually disagree
 * going forward, on traffic nobody has seen yet. Shadow mode closes that gap and
 * completes the loop:
 *
 *     sweep (offline proposal) → shadow (online validation) → promote
 *
 * The candidate runs on every routed turn, its verdict is stamped into
 * `usage.routingSignals.shadow`, and the ACTED tier is untouched. So the routing
 * panel can answer "how often would these thresholds have disagreed, and on
 * which turns" from real traffic, at zero risk and zero extra LLM cost.
 *
 * ── Why thresholds and not (only) a model ──
 * The seam a learned scorer will use ships unwired (`TierScorer`), so shadowing
 * "the model" would be shadowing nothing today. A candidate THRESHOLD pair is a
 * policy we can evaluate right now, is exactly what the sweep emits, and rides
 * the identical code path — {@link classifyTierVerdict} is already
 * threshold-parameterised, so the shadow verdict is the real classifier, not a
 * lookalike. When a scorer does land, `shadow.tier` carries its verdict instead
 * and nothing downstream changes.
 *
 * Pure: no DB, no settings read, no clock. The wiring supplies the parsed
 * config and the signals.
 */

import {
  type RoutingTier,
  type TierThresholds,
  classifyTierVerdict,
} from "../tier-classifier";

/** Admin-gated setting holding the candidate threshold pair. Absent ⇒ shadow
 *  mode is OFF and not one extra byte is written to `usage`. */
export const ROUTING_SHADOW_SETTING_KEY = "provider:routingShadow";

/**
 * Verdict reasons that thresholds CANNOT move, so shadowing them would invent a
 * disagreement that could never happen:
 *   - `declared` / `hint` bypass the heuristic entirely (a correctness
 *     requirement and explicit user intent respectively),
 *   - `scorer` is a model's call, not a threshold's.
 * Shared with `scripts/routing-sweep.ts` ON PURPOSE: shadow must agree with the
 * sweep turn-for-turn, or the online numbers would not validate the offline
 * proposal they exist to check.
 */
export const THRESHOLD_IMMUNE_REASONS: readonly string[] = ["declared", "hint", "scorer"];

/** What gets stamped onto `usage.routingSignals.shadow`. */
export interface ShadowVerdict {
  /** The tier the CANDIDATE policy would have chosen. Never served. */
  tier: RoutingTier;
  /** True when the candidate matched the tier we actually acted on. Stored
   *  explicitly (rather than derived at read time) so an analytics query can
   *  aggregate agreement without re-running the classifier over history. */
  agreed: boolean;
}

/**
 * Validate a `provider:routingShadow` setting value.
 * Tolerant by design — a malformed setting disables shadow mode rather than
 * breaking routing, because this is an observability feature and must never be
 * able to fail a turn.
 */
export function parseShadowThresholds(value: unknown): TierThresholds | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { fastMaxTokens, powerfulMinTokens } = value as Record<string, unknown>;
  if (!isPositiveInt(fastMaxTokens) || !isPositiveInt(powerfulMinTokens)) return undefined;
  // An inverted pair would make the middle band empty and silently classify
  // everything as powerful — a candidate nobody meant to propose.
  if (fastMaxTokens >= powerfulMinTokens) return undefined;
  return { fastMaxTokens, powerfulMinTokens };
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v > 0;
}

export type ShadowThresholdsValidation =
  | { ok: true; thresholds: TierThresholds }
  | { ok: false; error: string };

/**
 * WRITE-time validation for `provider:routingShadow`.
 *
 * The read path ({@link parseShadowThresholds}) is deliberately tolerant — it
 * must never be able to fail a turn — which means a typo would otherwise land
 * silently and simply look like "shadow mode isn't working". So the write is
 * strict and SAYS WHY, which is the only place an operator can be told their
 * edit was wrong. Same convention `provider:tierModels` and
 * `provider:explorationRate` follow.
 */
export function validateShadowThresholds(value: unknown): ShadowThresholdsValidation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "expected an object { fastMaxTokens, powerfulMinTokens }" };
  }
  const { fastMaxTokens, powerfulMinTokens } = value as Record<string, unknown>;
  if (!isPositiveInt(fastMaxTokens)) {
    return { ok: false, error: "fastMaxTokens must be a positive whole number of tokens" };
  }
  if (!isPositiveInt(powerfulMinTokens)) {
    return { ok: false, error: "powerfulMinTokens must be a positive whole number of tokens" };
  }
  if (fastMaxTokens >= powerfulMinTokens) {
    return {
      ok: false,
      error:
        `fastMaxTokens (${fastMaxTokens}) must be BELOW powerfulMinTokens ` +
        `(${powerfulMinTokens}) — an inverted pair leaves no balanced band and ` +
        "would classify almost everything as powerful",
    };
  }
  return { ok: true, thresholds: { fastMaxTokens, powerfulMinTokens } };
}

/**
 * The heuristic inputs, as they appear on a stamped `routingSignals` row.
 * Structural on purpose: the ONLINE path holds a live `RoutingSignals` and the
 * OFFLINE sweep holds a row parsed back out of `usage` jsonb — both satisfy
 * this, so one replay serves both.
 */
export interface ThresholdReplayInput {
  promptChars: number;
  historyChars?: number;
  historyMessageCount?: number;
  hasToolMessages?: boolean;
  systemChars?: number;
  attachmentCount?: number;
  toolCount?: number;
  hasComplexTools?: boolean;
}

/**
 * The tier a candidate threshold pair would have chosen for these signals.
 *
 * Deliberately omits `tierHint`/`declaredTier`: callers hold those turns fixed
 * via {@link THRESHOLD_IMMUNE_REASONS}, so everything reaching here is a
 * heuristic turn. Runs the REAL classifier, so a disagreement is a genuine
 * policy difference rather than drift between two lookalike implementations.
 */
export function replayWithThresholds(
  signals: ThresholdReplayInput,
  thresholds: TierThresholds,
): RoutingTier {
  return classifyTierVerdict({
    promptChars: signals.promptChars,
    historyChars: signals.historyChars,
    historyMessageCount: signals.historyMessageCount,
    hasToolMessages: signals.hasToolMessages,
    systemChars: signals.systemChars,
    attachmentCount: signals.attachmentCount,
    toolCount: signals.toolCount,
    hasComplexTools: signals.hasComplexTools,
    thresholds,
  }).tier;
}

/**
 * Run the candidate policy against the SAME signals the live verdict used.
 *
 * Returns `undefined` — meaning "write nothing" — when shadow mode is off or
 * the turn's reason is threshold-immune. Absent is deliberately distinct from
 * `agreed: true`: a turn the candidate could never have moved is not evidence
 * that the candidate agrees, and counting it as such would flatter every
 * candidate you ever shadow.
 *
 * `actedTier` is the CLASSIFIER's verdict, not the served tier — bounded
 * exploration may serve one rung lower on purpose, and scoring the candidate
 * against a deliberate deviation would manufacture disagreements.
 */
export function evaluateShadow(
  signals: ThresholdReplayInput & { tier: RoutingTier; reason: string },
  thresholds: TierThresholds | undefined,
): ShadowVerdict | undefined {
  if (!thresholds) return undefined;
  if (THRESHOLD_IMMUNE_REASONS.includes(signals.reason)) return undefined;
  const tier = replayWithThresholds(signals, thresholds);
  return { tier, agreed: tier === signals.tier };
}
