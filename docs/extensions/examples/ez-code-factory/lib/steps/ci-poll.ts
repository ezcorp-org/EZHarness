// ── CI poll helpers — pure port of ci_checks.go + ci_fix.go outcomes ──
//
// The deterministic building blocks of the CI monitor: the adaptive poll
// schedule, the failing/pending check predicates, the "already-attempted" dedup
// key + its CI-re-run detection, and the three park outcomes (failure /
// mergeability / monitoring timeout). All pure — the CIStep drives them with an
// injected clock so tests never sleep (spec §11 determinism).

import { deserializeFindings, serializeFindings } from "../runs";
import { checkFailing, checkPending, type Check } from "../github";
import type { StepOutcome } from "./common";

// ── Timing constants (ci.go) ────────────────────────────────────────

const MINUTE_MS = 60 * 1000;
/** Min wait before trusting an empty check set. Verbatim defaultChecksGracePeriod. */
export const DEFAULT_CHECKS_GRACE_MS = 60 * 1000;
/** Window to resolve the base-branch tip each poll. Verbatim defaultBaseBranchTipResolveWindow. */
export const BASE_BRANCH_TIP_RESOLVE_MS = 30 * 1000;

/**
 * Poll interval by elapsed time since monitoring started: 30s for the first
 * 5min, 60s for 5–15min, 120s after. Verbatim pollInterval.
 */
export function pollInterval(elapsedMs: number): number {
  if (elapsedMs < 5 * MINUTE_MS) return 30 * 1000;
  if (elapsedMs < 15 * MINUTE_MS) return 60 * 1000;
  return 120 * 1000;
}

// ── Check predicates (ci_checks.go) ─────────────────────────────────

/** Any check still running/queued. Verbatim hasPendingChecks. */
export function hasPendingChecks(checks: Check[]): boolean {
  return checks.some(checkPending);
}

/** Any check in the fail bucket. Verbatim hasFailingChecks. */
export function hasFailingChecks(checks: Check[]): boolean {
  return checks.some(checkFailing);
}

/** Names of failing checks, SORTED (stable dedup key). Verbatim failingCheckNames + sort. */
export function failingCheckNames(checks: Check[]): string[] {
  return checks.filter(checkFailing).map((c) => c.name).sort();
}

/** A check's completion time in epoch-ms, or 0 when unknown/unparseable. */
function completedAtMs(c: Check): number {
  if (c.completedAt === "") return 0;
  const t = Date.parse(c.completedAt);
  return Number.isNaN(t) ? 0 : t;
}

/** Latest completion time (epoch-ms) per failing check name. Empty when none.
 *  Verbatim failingCheckCompletionTimes. */
export function failingCheckCompletionTimes(checks: Check[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of checks) {
    if (!checkFailing(c)) continue;
    const t = completedAtMs(c);
    if (t === 0) continue;
    const prev = out[c.name];
    if (prev === undefined || t > prev) out[c.name] = t;
  }
  return out;
}

/** True when a failing check completed AFTER the recorded time — CI re-ran since
 *  our last fix push. Verbatim failingCheckCompletedAfter. */
export function failingCheckCompletedAfter(checks: Check[], after: Record<string, number>): boolean {
  if (Object.keys(after).length === 0) return false;
  for (const c of checks) {
    if (!checkFailing(c)) continue;
    const t = completedAtMs(c);
    if (t === 0) continue;
    const prev = after[c.name];
    if (prev !== undefined && t > prev) return true;
  }
  return false;
}

/** True when a currently-PENDING check matches an issue we already attempted to
 *  fix (so we can clear the stale "attempted" marker). Verbatim pendingCheckMatchesLastFixed. */
export function pendingCheckMatchesLastFixed(checks: Check[], lastFixedChecks: string): boolean {
  const issues = decodeLastFixedChecks(lastFixedChecks);
  if (issues === null) return false;
  const failed = new Set(issues.checks.filter((n) => n !== ""));
  if (failed.size === 0) return issues.mergeConflict && hasPendingChecks(checks);
  return checks.some((c) => checkPending(c) && failed.has(c.name));
}

// ── "Already-attempted" dedup key (ci_fix.go) ───────────────────────

interface LastFixedIssues {
  checks: string[];
  mergeConflict: boolean;
}

/** Encode the failing checks + merge-conflict flag into a stable dedup key
 *  ("" when there is nothing to fix). Verbatim encodeLastFixedChecks. */
export function encodeLastFixedChecks(failing: string[], mergeConflict: boolean): string {
  if (failing.length === 0 && !mergeConflict) return "";
  return JSON.stringify({ checks: failing, mergeConflict });
}

/** Decode a dedup key, or null when empty/malformed/no-issue. Verbatim decodeLastFixedChecks. */
export function decodeLastFixedChecks(raw: string): LastFixedIssues | null {
  if (raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const checks = Array.isArray(o.checks) ? o.checks.filter((x): x is string => typeof x === "string") : [];
  const mergeConflict = o.mergeConflict === true;
  if (checks.length === 0 && !mergeConflict) return null;
  return { checks, mergeConflict };
}

// ── Park outcomes (ci_fix.go) ───────────────────────────────────────

/** A gate-parking outcome from failing CI checks / a merge conflict. Verbatim
 *  ciFailureOutcome — items carry NO action (deserialize → ask-user → blocks). */
export function ciFailureOutcome(failing: string[], mergeConflict: boolean, summary: string): StepOutcome {
  const items: Array<Record<string, unknown>> = failing.map((name) => ({
    severity: "warning",
    description: `CI check failing: ${name}`,
  }));
  if (mergeConflict) {
    items.push({ severity: "warning", description: "PR has merge conflicts with the base branch" });
  }
  return { needsApproval: true, findings: serializeFindings(deserializeFindings({ findings: items, summary })) };
}

/** A mergeability-timeout park outcome. Verbatim ciMergeabilityOutcome. */
export function ciMergeabilityOutcome(summary: string, description: string): StepOutcome {
  const findings = deserializeFindings({
    findings: [{ severity: "warning", description, action: "ask-user" }],
    summary,
  });
  return { needsApproval: true, findings: serializeFindings(findings) };
}

/** A monitoring-timeout park outcome (PR still open). Verbatim ciMonitoringTimeoutOutcome. */
export function ciMonitoringTimeoutOutcome(): StepOutcome {
  const findings = deserializeFindings({
    findings: [{ severity: "warning", description: "PR was still open when CI monitoring timed out", action: "ask-user" }],
    summary: "CI monitoring timed out before PR was merged or closed",
  });
  return { needsApproval: true, findings: serializeFindings(findings) };
}
