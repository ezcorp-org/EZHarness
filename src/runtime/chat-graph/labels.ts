/**
 * Chat-graph label truncation.
 *
 * Every `GraphNode.label` is produced HERE. The wire contract
 * (`types.ts`) states the renderer receives labels ALREADY truncated and
 * must not re-truncate, so this module is the single budget authority for
 * both builders.
 *
 * Runtime values only — `types.ts` is type-only on purpose (it is imported
 * by browser code), so the constant lives next to its consumers instead.
 */

/**
 * Max characters in a `GraphNode.label`, ellipsis INCLUDED.
 *
 * Sized for a graph node box, not a transcript: long enough that a typical
 * one-line prompt survives intact, short enough that a 200-turn
 * conversation's payload stays small.
 */
export const LABEL_MAX = 60;

/** Single-character ellipsis so the clamp costs one slot, not three. */
const ELLIPSIS = "…";

/**
 * The label half of a `GraphNode`. `fullLabel` is present ONLY when it
 * differs from `label` — the contract says it is omitted when equal.
 */
export interface GraphLabel {
  label: string;
  fullLabel?: string;
}

/**
 * Collapse whitespace, then clamp to {@link LABEL_MAX}.
 *
 * Whitespace collapsing is part of the budget, not cosmetics: a prompt is
 * arbitrary multi-line text and a node box renders one line, so a raw
 * newline would otherwise eat the whole budget with invisible characters.
 *
 * `fullLabel` is set whenever the result differs from the input for ANY
 * reason (clamped OR merely re-flowed), so the detail pane can always
 * recover the original text; when nothing changed it is omitted and the
 * payload carries one string instead of two.
 */
export function truncateLabel(raw: string): GraphLabel {
  const flat = raw.replace(/\s+/g, " ").trim();
  const label = flat.length > LABEL_MAX ? flat.slice(0, LABEL_MAX - 1) + ELLIPSIS : flat;
  return label === raw ? { label } : { label, fullLabel: raw };
}
