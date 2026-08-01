#!/usr/bin/env bun
/**
 * Retroactive tier-threshold sweep — manual operator CLI invocation (WS7).
 *
 * `FAST_MAX_TOKENS = 500` and `POWERFUL_MIN_TOKENS = 8000` were never fitted to
 * traffic; they are guesses. This script answers "what would other guesses have
 * cost?" by REPLAYING the `usage.routingSignals` already stamped on every routed
 * turn (WS5) against candidate thresholds. No traffic is re-sent and no model is
 * called — the stored signals are the complete input the classifier saw.
 *
 * ── Why the metric is COST AT A FIXED ESCALATION RATE, not accuracy ──
 * Accuracy against the observed labels is a trap here. Most turns produce no
 * escalation at all, so the degenerate policy "keep whatever tier we already
 * chose" scores extremely well on accuracy while saving exactly nothing. The
 * number an operator actually decides on is: for a given willingness to route
 * turns up (the escalation rate), which thresholds cost least? So every
 * candidate reports its own escalation rate and its projected spend, and the
 * recommendation is the cheapest candidate whose escalation rate is at or below
 * the target.
 *
 * ── Why the comparison is honest ──
 * The replay calls the REAL `classifyTierVerdict` with a `thresholds` override
 * (see `src/runtime/tier-classifier.ts`), not a reimplementation of it. Today's
 * values are therefore always one of the candidate points, and the sweep
 * verifies that replaying them reproduces the tier stored on every turn — a
 * mismatch would mean the replay is not modelling production, and it is
 * reported rather than hidden (`baselineMismatches`).
 *
 * ── What the projected cost is, and is not ──
 * Per-tier dollar rates are derived from the deployment's OWN observed spend
 * (total USD ÷ total tokens over turns actually served at that tier), so no
 * model-choice guess is baked in. Turns served by an UNPRICED model (a
 * subscription plan is rate-limited, not billed per token) are excluded from
 * both the rates and the projection and reported separately — never counted as
 * $0.00. A tier with no priced observations cannot be projected, and the turns
 * that would land there are reported as `unprojectable` instead of being
 * silently priced at zero.
 *
 * Usage:
 *   bun run scripts/routing-sweep.ts
 *   bun run scripts/routing-sweep.ts --days 90
 *   bun run scripts/routing-sweep.ts --fast 250,500,1000 --powerful 4000,8000,16000
 *   bun run scripts/routing-sweep.ts --target-escalation-rate 0.25
 *
 * Exit codes:
 *   0 — swept
 *   2 — invocation error (unknown flag, bad numeric arg)
 */

import { sql } from "drizzle-orm";
import { initDb, getDb } from "../src/db/connection";
import { messages } from "../src/db/schema";
import { nowMinusInterval } from "../src/db/queries/sql-interval";
import { modelPrices } from "../src/providers/registry";
import { priceSegment } from "../src/runtime/usage/cache-stats";
import {
  DEFAULT_TIER_THRESHOLDS,
  VALID_TIERS,
  type RoutingTier,
  type TierThresholds,
} from "../src/runtime/tier-classifier";
import { THRESHOLD_IMMUNE_REASONS, replayWithThresholds } from "../src/runtime/routing/shadow";
import type { StoredRoutingSignals } from "../src/runtime/routing/labels";

/** Candidate grids default to a spread around today's values (halved, today,
 *  doubled) so the baseline is always bracketed rather than sitting at an edge. */
export const DEFAULT_FAST_CANDIDATES: readonly number[] = [250, 500, 1000, 2000];
export const DEFAULT_POWERFUL_CANDIDATES: readonly number[] = [4000, 8000, 16000, 32000];
const DEFAULT_DAYS = 30;

export interface ParsedSweepArgs {
  days: number;
  fast: number[];
  powerful: number[];
  /** Escalation rate the recommendation is priced at. Absent ⇒ the rate the
   *  BASELINE thresholds produce, i.e. "what we pay today, but cheaper". */
  targetEscalationRate?: number;
}

export type SweepParseResult = ParsedSweepArgs | { error: string };

function parsePositiveList(raw: string | undefined, flag: string): number[] | string {
  if (!raw) return `${flag} needs a comma-separated list of numbers`;
  const out: number[] = [];
  for (const part of raw.split(",")) {
    const n = Number(part.trim());
    if (!Number.isFinite(n) || n <= 0) return `${flag} has a non-positive value "${part.trim()}"`;
    out.push(Math.floor(n));
  }
  return out;
}

export function parseSweepArgs(argv: readonly string[]): SweepParseResult {
  const parsed: ParsedSweepArgs = {
    days: DEFAULT_DAYS,
    fast: [...DEFAULT_FAST_CANDIDATES],
    powerful: [...DEFAULT_POWERFUL_CANDIDATES],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--days") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) return { error: "--days needs a positive number" };
      parsed.days = Math.floor(n);
    } else if (arg === "--fast") {
      const list = parsePositiveList(argv[i + 1], "--fast");
      i += 1;
      if (typeof list === "string") return { error: list };
      parsed.fast = list;
    } else if (arg === "--powerful") {
      const list = parsePositiveList(argv[i + 1], "--powerful");
      i += 1;
      if (typeof list === "string") return { error: list };
      parsed.powerful = list;
    } else if (arg === "--target-escalation-rate") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        return { error: "--target-escalation-rate needs a number in [0,1]" };
      }
      parsed.targetEscalationRate = n;
    } else {
      return { error: `unknown flag "${arg}"` };
    }
  }
  return parsed;
}

/** One replayable turn: the stamped classifier inputs plus what it actually
 *  cost. `usd === null` marks an unpriced (subscription) model. */
export interface SweepTurn {
  signals: StoredRoutingSignals;
  /** Tier that actually SERVED the turn (`usage.routedTier`, falling back to the
   *  classifier's own verdict for a row that predates that key). */
  servedTier: RoutingTier;
  totalTokens: number;
  usd: number | null;
}

/**
 * The tier a candidate would have chosen for this turn.
 *
 * Verdict reasons the thresholds cannot move — `declared`/`hint` bypass the
 * heuristic entirely and `scorer` is a model's call — are held FIXED and counted
 * (`fixedTurns`) rather than dropped: they are real spend under every candidate.
 *
 * Both `THRESHOLD_IMMUNE_REASONS` and `replayWithThresholds` come from
 * `routing/shadow.ts` rather than being redeclared here, so the OFFLINE sweep
 * and ONLINE shadow mode share one definition. If they diverged, shadow would
 * stop validating the proposal this script produced.
 */
export function replayTier(turn: SweepTurn, thresholds: TierThresholds): RoutingTier {
  if (THRESHOLD_IMMUNE_REASONS.includes(turn.signals.reason)) return turn.signals.tier;
  return replayWithThresholds(turn.signals, thresholds);
}

/** USD per token, per tier, derived from the deployment's own priced spend. A
 *  tier with no priced observations is ABSENT (not 0) so the projection can say
 *  "cannot price this" instead of pricing it free. */
export function observedTierRates(turns: readonly SweepTurn[]): Map<RoutingTier, number> {
  const usd = new Map<RoutingTier, number>();
  const tokens = new Map<RoutingTier, number>();
  for (const t of turns) {
    if (t.usd === null || t.totalTokens <= 0) continue;
    usd.set(t.servedTier, (usd.get(t.servedTier) ?? 0) + t.usd);
    tokens.set(t.servedTier, (tokens.get(t.servedTier) ?? 0) + t.totalTokens);
  }
  const rates = new Map<RoutingTier, number>();
  for (const tier of VALID_TIERS) {
    const tok = tokens.get(tier) ?? 0;
    if (tok > 0) rates.set(tier, (usd.get(tier) ?? 0) / tok);
  }
  return rates;
}

export interface CandidateResult extends TierThresholds {
  /** Turns landing on each tier under this candidate. */
  tierMix: Record<RoutingTier, number>;
  /** powerful / turns — how often this candidate pays up. */
  escalationRate: number;
  /** Projected spend over the priced, projectable turns. */
  projectedUsd: number;
  /** Turns whose counterfactual tier has no observed rate to price it with. */
  unprojectable: number;
  /** True for the candidate that equals today's shipped thresholds. */
  isBaseline: boolean;
  /** Baseline only: turns whose replayed tier ≠ the tier stored on the row.
   *  Non-zero means the replay is not modelling production. */
  baselineMismatches?: number;
}

export interface SweepReport {
  days: number;
  turns: number;
  /** Turns held fixed because a declared tier / hint / scorer decided them. */
  fixedTurns: number;
  /** Turns served by an unpriced model — excluded from every dollar figure. */
  unpricedTurns: number;
  /** Per-tier USD/token the projection used. */
  observedRates: Record<string, number>;
  candidates: CandidateResult[];
  /** The escalation rate the recommendation was priced at. */
  targetEscalationRate: number;
  /** Cheapest candidate at or under the target rate, or null when none is. */
  recommended: CandidateResult | null;
  /** recommended.projectedUsd − baseline.projectedUsd (negative = a saving). */
  deltaVsBaselineUsd: number | null;
}

function emptyMix(): Record<RoutingTier, number> {
  return { fast: 0, balanced: 0, powerful: 0 };
}

/** Evaluate one candidate over every turn. */
export function evaluateCandidate(
  turns: readonly SweepTurn[],
  thresholds: TierThresholds,
  rates: Map<RoutingTier, number>,
): CandidateResult {
  const isBaseline =
    thresholds.fastMaxTokens === DEFAULT_TIER_THRESHOLDS.fastMaxTokens &&
    thresholds.powerfulMinTokens === DEFAULT_TIER_THRESHOLDS.powerfulMinTokens;
  const tierMix = emptyMix();
  let projectedUsd = 0;
  let unprojectable = 0;
  let baselineMismatches = 0;
  for (const turn of turns) {
    const tier = replayTier(turn, thresholds);
    tierMix[tier] += 1;
    if (isBaseline && tier !== turn.signals.tier) baselineMismatches += 1;
    if (turn.usd === null) continue;
    const rate = rates.get(tier);
    if (rate === undefined) {
      unprojectable += 1;
      continue;
    }
    projectedUsd += rate * turn.totalTokens;
  }
  return {
    ...thresholds,
    tierMix,
    escalationRate: turns.length > 0 ? tierMix.powerful / turns.length : 0,
    projectedUsd,
    unprojectable,
    isBaseline,
    ...(isBaseline ? { baselineMismatches } : {}),
  };
}

/** The candidate grid, with today's thresholds guaranteed present. */
export function candidateGrid(fast: readonly number[], powerful: readonly number[]): TierThresholds[] {
  const seen = new Set<string>();
  const out: TierThresholds[] = [];
  const push = (fastMaxTokens: number, powerfulMinTokens: number) => {
    // A candidate whose "fast" ceiling is at or above its "powerful" floor is
    // not a ladder — the powerful check fires first, so `fast` would be
    // unreachable. Dropped rather than reported as a real (and misleadingly
    // cheap-looking) point.
    if (fastMaxTokens >= powerfulMinTokens) return;
    const key = `${fastMaxTokens}:${powerfulMinTokens}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ fastMaxTokens, powerfulMinTokens });
  };
  // Today's point FIRST, so the honest comparison can never be crowded out of a
  // truncated grid — and so it is present even when the operator passes a grid
  // that omits it.
  push(DEFAULT_TIER_THRESHOLDS.fastMaxTokens, DEFAULT_TIER_THRESHOLDS.powerfulMinTokens);
  for (const f of fast) for (const p of powerful) push(f, p);
  return out;
}

/**
 * Run the whole sweep over already-loaded turns. Pure — no I/O — so the metric
 * is unit-testable against synthetic traffic.
 */
export function sweep(args: ParsedSweepArgs, turns: readonly SweepTurn[]): SweepReport {
  const rates = observedTierRates(turns);
  const candidates = candidateGrid(args.fast, args.powerful).map((t) =>
    evaluateCandidate(turns, t, rates),
  );
  const baseline = candidates.find((c) => c.isBaseline) ?? null;
  const target = args.targetEscalationRate ?? baseline?.escalationRate ?? 0;
  // Cheapest at or under the target rate. Ties break toward the LOWER
  // escalation rate: same money, fewer turns routed up.
  let recommended: CandidateResult | null = null;
  for (const c of candidates) {
    if (c.escalationRate > target) continue;
    if (
      !recommended ||
      c.projectedUsd < recommended.projectedUsd ||
      (c.projectedUsd === recommended.projectedUsd && c.escalationRate < recommended.escalationRate)
    ) {
      recommended = c;
    }
  }
  const observedRates: Record<string, number> = {};
  for (const [tier, rate] of rates) observedRates[tier] = rate;
  return {
    days: args.days,
    turns: turns.length,
    fixedTurns: turns.filter((t) => THRESHOLD_IMMUNE_REASONS.includes(t.signals.reason)).length,
    unpricedTurns: turns.filter((t) => t.usd === null).length,
    observedRates,
    candidates,
    targetEscalationRate: target,
    recommended,
    deltaVsBaselineUsd:
      recommended && baseline ? recommended.projectedUsd - baseline.projectedUsd : null,
  };
}

/**
 * Load every ROUTED turn in the window that carries stamped signals. Pinned and
 * legacy rows are skipped by the `routingSignals` existence check — they have no
 * classifier inputs to replay.
 */
export async function loadSweepTurns(days: number): Promise<SweepTurn[]> {
  const res = await getDb().execute(sql`
    SELECT
      ${messages.provider} AS provider,
      ${messages.model} AS model,
      ${messages.usage} AS usage
    FROM ${messages}
    WHERE ${messages.role} = 'assistant'
      AND ${messages.createdAt} >= ${nowMinusInterval(days, "days")}
      AND jsonb_exists(${messages.usage}, 'routingSignals')
    ORDER BY ${messages.createdAt}, ${messages.id}
  `);
  const turns: SweepTurn[] = [];
  for (const row of res.rows as Record<string, unknown>[]) {
    const usage = row.usage as
      | {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
          cacheWrite1hTokens?: number;
          routedTier?: RoutingTier;
          routingSignals?: StoredRoutingSignals;
        }
      | null;
    const signals = usage?.routingSignals;
    if (!signals) continue;
    const provider = String(row.provider ?? "");
    const model = String(row.model ?? "");
    const tokens = {
      input: usage?.inputTokens ?? 0,
      output: usage?.outputTokens ?? 0,
      cacheRead: usage?.cacheReadTokens ?? 0,
      cacheWrite: usage?.cacheWriteTokens ?? 0,
      cacheWrite1h: usage?.cacheWrite1hTokens ?? 0,
    };
    // WS1 owns every pricing decision, including "is this priced at all?" —
    // `priceSegment` returns null for the all-zero rate table an OAuth
    // subscription model arrives with.
    const cost = priceSegment(tokens, modelPrices(provider, model));
    turns.push({
      signals,
      servedTier: usage?.routedTier ?? signals.tier,
      // cacheWrite1h is a SUBSET of cacheWrite — never summed in.
      totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
      usd: cost === null ? null : cost.total,
    });
  }
  return turns;
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseSweepArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }
  await initDb();
  const report = sweep(parsed, await loadSweepTurns(parsed.days));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

// Single-line guard so it is covered on import; the body only runs when the
// script is invoked directly, never in-process.
if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
