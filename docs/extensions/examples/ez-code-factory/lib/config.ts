// ── Pipeline config — auto-fix caps + step order (settings v0) ───────
//
// The fixed 9-step pipeline order and its default per-step auto-fix caps, ported
// from internal/pipeline/steps/common.go (AllSteps) + the upstream config
// defaults (review cap = 0, everything else 3). M1 implements intent/rebase/
// review/push; the remaining steps are registered but auto-skip until M3/M4.
//
// Everything is pure. The extension page's settings feed `resolvePipelineConfig`
// (validated + clamped here); index.ts owns the actual settings read.

import { GATE_REMOTE } from "./gate";

/** The fixed pipeline sequence (order is NOT configurable — spec §1). */
export const PIPELINE_STEPS = [
  "intent",
  "rebase",
  "review",
  "test",
  "document",
  "lint",
  "push",
  "pr",
  "ci",
] as const;

export type PipelineStep = (typeof PIPELINE_STEPS)[number];

/** Steps executed for real. M1 shipped intent/rebase/review/push; M3 adds
 *  test/document/lint. Only pr/ci remain registered-but-auto-skipped (M4). */
export const IMPLEMENTED_STEPS: ReadonlySet<PipelineStep> = new Set<PipelineStep>([
  "intent",
  "rebase",
  "review",
  "test",
  "document",
  "lint",
  "push",
]);

/**
 * Default per-step auto-fix caps. Review is 0 — it ALWAYS parks for a human
 * (the review gate is never auto-resolved). Steps that don't run an auto-fix
 * loop (intent/push/pr) are 0. The rest default to 3. Verbatim from upstream's
 * config defaults.
 */
export const DEFAULT_AUTO_FIX_LIMITS: Record<PipelineStep, number> = {
  intent: 0,
  rebase: 3,
  review: 0,
  test: 3,
  document: 3,
  lint: 3,
  push: 0,
  pr: 0,
  ci: 3,
};

/** Resolved, validated pipeline configuration. */
export interface PipelineConfig {
  /** Per-step auto-fix cap (>= 0). */
  autoFixLimits: Record<PipelineStep, number>;
  /** Cosmetic git remote name (`git push <gateRemote> <branch>`). */
  gateRemote: string;
  /** Review ignore globs — files matching these are excluded from review. */
  ignorePatterns: string[];
  /** Default branch the pipeline rebases onto / diffs against. */
  defaultBranch: string;
}

/** The all-defaults config (no settings applied). */
export function defaultPipelineConfig(): PipelineConfig {
  return {
    autoFixLimits: { ...DEFAULT_AUTO_FIX_LIMITS },
    gateRemote: GATE_REMOTE,
    ignorePatterns: [],
    defaultBranch: "main",
  };
}

/** The effective auto-fix cap for a step. Verbatim config.AutoFixLimit. */
export function autoFixLimit(config: PipelineConfig, step: PipelineStep): number {
  return config.autoFixLimits[step];
}

/** The auto-fixing steps the single flat `autofixCap` UI knob controls (review
 *  has its own knob; intent/push/pr never run an auto-fix loop). */
const OTHER_AUTOFIX_STEPS = ["rebase", "test", "document", "lint", "ci"] as const satisfies readonly PipelineStep[];

/** Clamp an unknown to a non-negative integer, or fall back to `fallback`. A
 *  negative / non-finite / non-number value is rejected (fail-safe: a bad
 *  setting never widens a cap into nonsense). */
function toNonNegativeInt(v: unknown, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return fallback;
  return Math.floor(v);
}

/**
 * Build a PipelineConfig from raw extension settings, validating + clamping
 * every field. Unknown / malformed settings fall back to the default — a
 * settings blob can never crash the pipeline or produce an invalid cap.
 *
 * Recognized keys — both the structured form (programmatic callers / tests) and
 * the flat scalar form the extension page's settings UI declares (SettingsField
 * has no array/object type, so the page can only emit scalars — see
 * ezcorp.config.ts). Every declared settings key is consumed here, so none is a
 * silently-dead knob; index.ts wires the live read in M2.
 *   - `autoFix.<step>`   : number   per-step cap override (>= 0) — structured
 *   - `reviewAutofixCap` : number   flat review cap (0 = always ask a human)
 *   - `autofixCap`       : number   flat cap for rebase/test/document/lint/ci
 *   - `gateRemote`       : string   non-empty remote name
 *   - `ignorePatterns`   : string[] OR comma-separated string of review globs
 *   - `defaultBranch`    : string   non-empty branch name
 */
export function resolvePipelineConfig(settings: unknown): PipelineConfig {
  const cfg = defaultPipelineConfig();
  if (!settings || typeof settings !== "object") return cfg;
  const s = settings as Record<string, unknown>;

  const autoFix = s.autoFix;
  if (autoFix && typeof autoFix === "object") {
    const overrides = autoFix as Record<string, unknown>;
    for (const step of PIPELINE_STEPS) {
      if (step in overrides) {
        cfg.autoFixLimits[step] = toNonNegativeInt(overrides[step], cfg.autoFixLimits[step]);
      }
    }
  }
  // Flat cap knobs from the settings UI (a sentinel < 0 means "leave default").
  const reviewCap = toNonNegativeInt(s.reviewAutofixCap, -1);
  if (reviewCap >= 0) cfg.autoFixLimits.review = reviewCap;
  const otherCap = toNonNegativeInt(s.autofixCap, -1);
  if (otherCap >= 0) for (const step of OTHER_AUTOFIX_STEPS) cfg.autoFixLimits[step] = otherCap;

  if (typeof s.gateRemote === "string" && s.gateRemote.trim() !== "") {
    cfg.gateRemote = s.gateRemote.trim();
  }
  if (Array.isArray(s.ignorePatterns)) {
    cfg.ignorePatterns = s.ignorePatterns.filter((x): x is string => typeof x === "string");
  } else if (typeof s.ignorePatterns === "string") {
    // Comma-separated text field (the UI form): split, trim, drop empties.
    cfg.ignorePatterns = s.ignorePatterns.split(",").map((p) => p.trim()).filter((p) => p !== "");
  }
  if (typeof s.defaultBranch === "string" && s.defaultBranch.trim() !== "") {
    cfg.defaultBranch = s.defaultBranch.trim();
  }
  return cfg;
}
