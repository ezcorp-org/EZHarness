// Shared types for the claude-design extension.
//
// Kept narrow — extension-internal types should not leak into the
// extension-data files. The `DesignSystem` shape IS persisted to
// design-system.json, so changing its structure is a migration; bump
// `schemaVersion` and add a reader for the old shape.

/** Source of truth for the extracted tokens. */
export type DesignSystemSource =
  | "tokens.json"
  | "tailwind"
  | "css-vars"
  | "theme.ts"
  | "greenfield";

export interface ColorRamp {
  primary: string;
  secondary?: string;
  /** Neutral ramp from darkest to lightest. Length is fixture-dependent. */
  neutral: string[];
  /** Optional named accents the project declares. */
  accents?: Record<string, string>;
}

export interface TypographyScale {
  display: string;
  body: string;
  mono?: string;
  /** Pixel sizes in ascending order. */
  scale: number[];
}

export interface SpacingScale {
  /** Base unit in pixels (8px is the most common default). */
  unit: number;
  /** Pixel sizes in ascending order — multiples of `unit`. */
  scale: number[];
}

export interface ComponentEntry {
  name: string;
  path: string;
}

export interface DesignSystem {
  schemaVersion: 1;
  colors: ColorRamp;
  typography: TypographyScale;
  spacing: SpacingScale;
  components: ComponentEntry[];
  source: DesignSystemSource;
}

/** Adaptive sidebar control descriptor. The agent declares one of these
 *  per knob it wants exposed in the canvas card; the canvas reads them
 *  and renders a matching input by `kind`. The descriptor's `var`
 *  determines which CSS variable in the token block is rewritten when
 *  the user changes the value. */
export interface KnobDescriptor {
  /** Logical id, e.g. `"accentColor"`. Used as the key in `knobValues`. */
  key: string;
  /** User-facing label rendered next to the input. */
  label: string;
  /** Input kind: drives the rendered control + how the value is applied. */
  kind: "color" | "range" | "select" | "text";
  /** CSS variable to rewrite. Defaults to `--${kebab(key)}` when absent. */
  var?: string;
  /** Pseudo-knob behavior — `"scale-spacing"` rescales every `--space-*`
   *  via the existing `scaleSpacing()` math (no var write). */
  behavior?: "scale-spacing";
  /** For `kind: "select"` — list of option strings. */
  options?: string[];
  /** For `kind: "range"` — slider min. */
  min?: number;
  /** For `kind: "range"` — slider max. */
  max?: number;
  /** For `kind: "range"` — slider step. */
  step?: number;
  /** For `kind: "range"` — unit appended to the formatted output. */
  unit?: "px" | "rem" | "em" | "%" | "";
  /** Initial value rendered in the card. Surfaced as `knobValues[key]`. */
  current?: string;
}

export interface DraftMeta {
  schemaVersion: 1 | 2;
  draftId: string;
  parentDraftId?: string;
  prompt: string;
  kind: "page" | "slide" | "one-pager" | "component";
  /** v1 only — knob hops from parent to this draft. Single-step (not
   *  full lineage). On v2, this field is omitted; use `knobValues`
   *  instead. Kept in the type for back-compat reads. */
  knobs?: KnobDescriptor[] | Record<string, string>;
  /** v2 — sidebar header (e.g. "Hero & feature grid knobs"). */
  knobsTitle?: string;
  /** v2 — most-recent applied values by knob `key`. */
  knobValues?: Record<string, string>;
  /** v2 — verbatim copy of the `<style id="design-tokens">` block as it
   *  was when the draft was first generated. Tweaks restore this block
   *  in the HTML before applying knobs so successive applies operate on
   *  the original baseline, not on already-scaled values (the source of
   *  the prior compounding-zoom bug). */
  originalTokensBlock?: string;
  /** v2 — CSS variables that the most-recent apply rewrote relative to
   *  the baseline. Persisted so `list-revisions` can report the diff
   *  without re-running knob math. */
  changedVars?: string[];
  createdAt: string;
}

/** A single revision in a draft's history. The "head" of the chain is
 *  the parent draft itself (`isOriginal: true`); subsequent entries are
 *  the `<parent>__r*` revision files, newest-first by `createdAt`. */
export interface Revision {
  revisionId: string;
  parentDraftId: string;
  knobValues: Record<string, string>;
  changedVars?: string[];
  createdAt: string;
  isOriginal: boolean;
}

/** Result returned by the `tweak-design` tool. Carries enough state for
 *  the canvas card to (a) reload the iframe, (b) render the changed-vars
 *  diff banner, (c) refresh the revision dropdown without a second
 *  round-trip. */
export interface ApplyKnobsResult {
  draftId: string;
  parentDraftId: string;
  htmlPath: string;
  iframeSrc: string;
  changedVars: string[];
  knobValues: Record<string, string>;
  /** Inner contents of the new `<style id="design-tokens">` block. */
  tokensBlock: string;
  /** Refreshed revision list, newest-first. */
  revisions: Revision[];
}

/** Result returned by the `open-canvas` tool. */
export interface OpenCanvasResult {
  draftId: string;
  iframeSrc: string;
  knobs: KnobDescriptor[];
  knobsTitle: string;
  knobValues: Record<string, string>;
  /** Omitted for legacy drafts that pre-date the snapshot. */
  originalTokensBlock?: string;
  revisions: Revision[];
}

export interface Knobs {
  primaryColor?: string;
  secondaryColor?: string;
  /** "+10%" / "-5%" / "150%" / "1.2" — parsed by tweak. */
  spacingScale?: string;
  /** px value (e.g. "0", "4", "8"). */
  borderRadius?: string;
  density?: "compact" | "cozy" | "spacious";
}

/**
 * Migrate a raw meta object (read from disk) to the v2 shape.
 *
 * Detection: `schemaVersion` defaults to 1 when missing. v1 stored
 * `knobs` as `Record<string, string>`; v2 stores it as
 * `KnobDescriptor[]`. When the input's `knobs` is an object (v1 form),
 * rename it to `knobValues` and clear `knobs` so the canvas falls back
 * to `LEGACY_DESCRIPTORS`.
 *
 * Pure: no I/O. Returns a new object — does not mutate the input.
 */
export function migrateMeta(meta: unknown): DraftMeta {
  const m = (meta ?? {}) as Record<string, unknown>;
  const schemaVersion = (m.schemaVersion === 2 ? 2 : 1) as 1 | 2;

  // Normalize the rest of the fields into a typed shape.
  const out: DraftMeta = {
    schemaVersion: 2,
    draftId: typeof m.draftId === "string" ? m.draftId : "",
    parentDraftId: typeof m.parentDraftId === "string" ? m.parentDraftId : undefined,
    prompt: typeof m.prompt === "string" ? m.prompt : "",
    kind: (typeof m.kind === "string" ? m.kind : "page") as DraftMeta["kind"],
    createdAt: typeof m.createdAt === "string" ? m.createdAt : new Date(0).toISOString(),
  };

  if (typeof m.knobsTitle === "string") out.knobsTitle = m.knobsTitle;
  if (typeof m.originalTokensBlock === "string") {
    out.originalTokensBlock = m.originalTokensBlock;
  }
  if (Array.isArray(m.changedVars)) {
    const arr = m.changedVars.filter((v): v is string => typeof v === "string");
    if (arr.length > 0) out.changedVars = arr;
  }

  // Inspect the `knobs` field to decide v1 vs v2 shape.
  const rawKnobs = m.knobs;
  if (Array.isArray(rawKnobs)) {
    // v2 — descriptor array.
    out.knobs = rawKnobs as KnobDescriptor[];
    if (m.knobValues && typeof m.knobValues === "object") {
      out.knobValues = m.knobValues as Record<string, string>;
    }
  } else if (rawKnobs && typeof rawKnobs === "object") {
    // v1 — legacy object form. Move it into `knobValues` and leave
    // `knobs` undefined so consumers fall back to `LEGACY_DESCRIPTORS`.
    out.knobValues = rawKnobs as Record<string, string>;
  } else {
    // Knobs absent. Preserve any `knobValues` the v2 caller may have
    // already supplied separately.
    if (m.knobValues && typeof m.knobValues === "object") {
      out.knobValues = m.knobValues as Record<string, string>;
    }
  }

  // Tag the output with the original schema version when it was
  // already v2 — otherwise treat the migration as producing v2.
  void schemaVersion;
  return out;
}
