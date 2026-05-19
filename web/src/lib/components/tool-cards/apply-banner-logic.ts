// Pure helpers for DesignCanvasCard's "tweak-design apply" feedback UI.
//
// These functions translate the new wire-shape from the `tweak-design`
// tool into human-readable banner text, dirty-state booleans, revision
// dropdown labels, and a unified-diff string for the tokens drawer. They
// are kept here (vs. inline in the Svelte component) so they can be
// unit-tested without rendering and reused by any future canvas-style
// extension that wants the same banner / diff UX.
//
// Backwards-compat note: every input field on the response is treated as
// optional. Legacy drafts that predate the new fields produce sensible
// fallbacks ("no CSS variables changed", empty diff, etc.) so the UI
// keeps working without a runtime check at every call site.
//
// The dirty-state logic reuses `encodeKnobValue` from the existing
// `design-canvas-knob-logic` module so the canvas card never has two
// definitions of "wire shape" drifting apart.

import { encodeKnobValue, type KnobBodyDescriptor } from "./design-canvas-knob-logic";

/** A single revision entry returned by the backend. Newest-first when
 *  delivered as part of `revisions`. The `knobValues` map is in WIRE
 *  format (already encoded — `"+30%"`, `"#ff0066"`, etc.). */
export interface Revision {
  revisionId: string;
  parentDraftId: string;
  knobValues: Record<string, string>;
  changedVars?: string[];
  createdAt: string;
  isOriginal: boolean;
}

// ── summarizeChangedVars ──────────────────────────────────────────
//
// Collapse a `changedVars` array into a short banner phrase. The goal is
// readability when the user changed the spacing scale (which mutates a
// dozen --space-* tokens at once): instead of dumping the full list, we
// group `--space-*` and `--radius-*` together when there are 3+ of
// either kind. Single tokens get listed verbatim so users can tell what
// changed at a glance.

const SPACE_PREFIX = "--space";
const RADIUS_PREFIX = "--radius";
const GROUP_THRESHOLD = 3;

/** Turn an array of CSS variable names into a banner-friendly summary.
 *  Empty input → `"no CSS variables changed"`. */
export function summarizeChangedVars(vars: string[]): string {
  if (!Array.isArray(vars) || vars.length === 0) {
    return "no CSS variables changed";
  }

  const spaceVars: string[] = [];
  const radiusVars: string[] = [];
  const otherVars: string[] = [];
  for (const v of vars) {
    if (v.startsWith(SPACE_PREFIX)) spaceVars.push(v);
    else if (v.startsWith(RADIUS_PREFIX)) radiusVars.push(v);
    else otherVars.push(v);
  }

  const parts: string[] = [];
  // Other vars come first so a "primaryColor + lots of spacing" change
  // surfaces the more interesting var by name.
  for (const v of otherVars) parts.push(v);

  // Once EITHER kind reaches the grouping threshold, we group BOTH kinds.
  // This keeps the banner uniform — mixing "3 spacing tokens, --radius-base,
  // --radius-lg" with the verbatim list reads worse than the symmetric
  // "3 spacing tokens, 2 radius tokens".
  const shouldGroup =
    spaceVars.length >= GROUP_THRESHOLD || radiusVars.length >= GROUP_THRESHOLD;

  if (spaceVars.length > 0) {
    if (shouldGroup) {
      parts.push(
        `${spaceVars.length} spacing token${spaceVars.length === 1 ? "" : "s"}`,
      );
    } else {
      for (const v of spaceVars) parts.push(v);
    }
  }

  if (radiusVars.length > 0) {
    if (shouldGroup) {
      parts.push(
        `${radiusVars.length} radius token${radiusVars.length === 1 ? "" : "s"}`,
      );
    } else {
      for (const v of radiusVars) parts.push(v);
    }
  }

  return `updated ${parts.join(", ")}`;
}

// ── isKnobDirty ────────────────────────────────────────────────────
//
// "Dirty" means: the form value would produce a different wire string
// than what the backend last reported as applied. Reuses
// `encodeKnobValue` so empty/whitespace + meaningful-zero handling stays
// in lockstep with the POST-body builder.

/** Returns true when the encoded form value differs from the last
 *  applied wire value. Empty form + undefined applied → false (not
 *  dirty). When the descriptor encodes the form to `null` (skip), the
 *  knob is dirty only if `appliedValue` is a non-empty string — i.e.
 *  the user cleared a previously-applied value. */
export function isKnobDirty(
  descriptor: KnobBodyDescriptor,
  formValue: string | number | null | undefined,
  appliedValue: string | undefined,
): boolean {
  const encoded = encodeKnobValue(descriptor, formValue);
  if (encoded === null) {
    // Form is empty/blank. Dirty only if the backend has an applied
    // override that the user just cleared.
    return appliedValue != null && appliedValue !== "";
  }
  return encoded !== (appliedValue ?? "");
}

// ── formatRevisionLabel ────────────────────────────────────────────
//
// Compact, dropdown-friendly label per revision. Keeps the time stamp
// at the front (always 8 chars) and a few key=value pairs after a
// long-dash separator. Truncates each value past 12 chars with an
// ellipsis and caps at 3 keys with a "(+N more)" suffix.

const MAX_KEYS = 3;
const MAX_VAL_LEN = 12;

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  // -1 for the ellipsis so the resulting string is at most `max` chars.
  return value.slice(0, max - 1) + "…";
}

function timePart(createdAt: string): string {
  // ISO timestamp like "2026-04-27T12:43:08.123Z" → "12:43:08". When
  // the input doesn't parse, return it verbatim so the dropdown still
  // renders something distinguishing.
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return createdAt;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/** Build a dropdown label for a revision. Example:
 *  `"12:43:08 — primaryColor=#ff0066, spacing=+15%"`. */
export function formatRevisionLabel(rev: Revision): string {
  const time = timePart(rev.createdAt);
  if (rev.isOriginal) return `${time} — original`;

  const entries = Object.entries(rev.knobValues ?? {});
  if (entries.length === 0) return `${time} — no overrides`;

  const head = entries.slice(0, MAX_KEYS);
  const rest = entries.length - head.length;

  const formatted = head
    .map(([k, v]) => `${k}=${truncate(String(v), MAX_VAL_LEN)}`)
    .join(", ");
  const suffix = rest > 0 ? ` (+${rest} more)` : "";
  return `${time} — ${formatted}${suffix}`;
}

// ── buildTokensDiffText ────────────────────────────────────────────
//
// Produce a unified-diff string compatible with `Diff2Html.parse`. We
// reuse the same shape `utils.ts` `generateDiffText` builds for the
// regular DiffCard — header lines + a single hunk header followed by
// minus-then-plus lines. This is good enough for diff2html to render a
// readable side-by-side view of the tokens block.

const SYNTHETIC_FILENAME = "design-tokens";

/** Synthesize a unified diff between two `<style id="design-tokens">`
 *  inner blocks. Returns `""` when baseline equals current (so callers
 *  can hide the drawer cleanly). */
export function buildTokensDiffText(baseline: string, current: string): string {
  if (baseline === current) return "";
  const oldLines = baseline.split("\n");
  const newLines = current.split("\n");
  let diff = `--- a/${SYNTHETIC_FILENAME}\n+++ b/${SYNTHETIC_FILENAME}\n`;
  diff += `@@ -1,${oldLines.length} +1,${newLines.length} @@\n`;
  for (const line of oldLines) diff += `-${line}\n`;
  for (const line of newLines) diff += `+${line}\n`;
  return diff;
}
